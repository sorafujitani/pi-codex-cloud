import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CodexCloudClient,
  errorMessage,
  parseAttempts,
  parseTaskAndAttempt,
} from "../src/codex-cloud.js";

const CODEX_CLOUD_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal("delegate"),
    Type.Literal("list"),
    Type.Literal("status"),
    Type.Literal("diff"),
  ]),
  prompt: Type.Optional(Type.String({ description: "Task prompt for delegate" })),
  environment_id: Type.Optional(Type.String({ description: "Codex Cloud environment ID" })),
  task_id: Type.Optional(Type.String({ description: "Codex Cloud task ID" })),
  branch: Type.Optional(Type.String({ description: "Remote Git branch to delegate from" })),
  attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
  attempt: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
  allow_dirty: Type.Optional(
    Type.Boolean({ description: "Ignore local-only dirty files; they are not uploaded to Codex Cloud" }),
  ),
});

function sendResult(pi: ExtensionAPI, title: string, output: string): void {
  pi.sendMessage({
    customType: "pi-codex-cloud",
    content: `**${title}**\n\n\`\`\`text\n${output || "(no output)"}\n\`\`\``,
    display: true,
    details: { title },
  });
}

async function runCommand(
  ctx: ExtensionCommandContext,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
  }
}

export default function piCodexCloud(pi: ExtensionAPI): void {
  const client = new CodexCloudClient(
    (command, args, options) => pi.exec(command, args, options),
    process.env.PI_CODEX_CLOUD_CODEX_BIN?.trim() || "codex",
  );
  let environmentId = process.env.PI_CODEX_CLOUD_ENV_ID?.trim() || undefined;

  const attempts = (): number => parseAttempts(process.env.PI_CODEX_CLOUD_ATTEMPTS);

  pi.registerTool({
    name: "codex_cloud",
    label: "Codex Cloud",
    description: "Delegate work to Codex Cloud or inspect cloud tasks without leaving Pi",
    promptSnippet: "Delegate repository work to Codex Cloud and inspect task status or diffs",
    promptGuidelines: [
      "Use codex_cloud only when the user asks to delegate work to Codex Cloud or inspect an existing Codex Cloud task.",
      "Before using codex_cloud delegate, summarize the goal, constraints, and verification criteria in the prompt.",
      "codex_cloud never uploads uncommitted files; tell the user when local-only changes affect the requested task.",
    ],
    parameters: CODEX_CLOUD_PARAMETERS,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        onUpdate?.({
          content: [{ type: "text", text: `Running Codex Cloud ${params.action}...` }],
          details: { action: params.action },
        });
        const targetEnvironment = params.environment_id?.trim() || environmentId;

        if (params.action === "delegate") {
          if (!targetEnvironment) {
            throw new Error(
              "Environment ID is required. Set PI_CODEX_CLOUD_ENV_ID or pass environment_id.",
            );
          }
          const result = await client.delegate({
            cwd: ctx.cwd,
            environmentId: targetEnvironment,
            prompt: params.prompt ?? "",
            ...(params.branch ? { branch: params.branch } : {}),
            attempts: params.attempts ?? attempts(),
            allowDirty: params.allow_dirty ?? false,
            signal,
          });
          environmentId = targetEnvironment;
          return {
            content: [
              {
                type: "text",
                text: `Delegated branch ${result.git.branch} to Codex Cloud.\n${result.output}`,
              },
            ],
            details: { action: params.action, branch: result.git.branch, output: result.output },
          };
        }

        if (params.action === "list") {
          const output = await client.list(ctx.cwd, targetEnvironment, signal);
          return {
            content: [{ type: "text", text: output }],
            details: { action: params.action, output },
          };
        }

        if (!params.task_id) throw new Error(`task_id is required for ${params.action}.`);
        const output =
          params.action === "status"
            ? await client.status(ctx.cwd, params.task_id, signal)
            : await client.diff({
                cwd: ctx.cwd,
                taskId: params.task_id,
                ...(params.attempt === undefined ? {} : { attempt: params.attempt }),
                signal,
              });
        return {
          content: [{ type: "text", text: output }],
          details: { action: params.action, output },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Codex Cloud ${params.action} failed: ${errorMessage(error)}` }],
          details: { action: params.action, error: errorMessage(error) },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("cloud:setup", {
    description: "Check Codex Cloud CLI availability",
    handler: async (_args, ctx) => {
      await runCommand(ctx, async () => {
        const version = await client.check(ctx.cwd);
        ctx.ui.notify(
          `${version}; environment: ${environmentId ?? "not set (use /cloud:env <id>)"}`,
          "info",
        );
      });
    },
  });

  pi.registerCommand("cloud:env", {
    description: "Show or set the Codex Cloud environment ID for this Pi session",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested) {
        ctx.ui.notify(environmentId ? `Environment: ${environmentId}` : "Environment is not set.", "info");
        return;
      }
      if (requested.startsWith("-")) {
        ctx.ui.notify("Environment ID must not start with '-'.", "error");
        return;
      }
      environmentId = requested;
      ctx.ui.notify(`Environment set for this session: ${environmentId}`, "info");
    },
  });

  pi.registerCommand("cloud:delegate", {
    description: "Delegate a task to Codex Cloud: /cloud:delegate <task prompt>",
    handler: async (args, ctx) => {
      await runCommand(ctx, async () => {
        const prompt = args.trim();
        if (!prompt) throw new Error("Usage: /cloud:delegate <task prompt>");
        if (!environmentId) {
          if (!ctx.hasUI) {
            throw new Error("Set PI_CODEX_CLOUD_ENV_ID before using non-interactive mode.");
          }
          environmentId = (await ctx.ui.input("Codex Cloud environment ID"))?.trim() || undefined;
        }
        if (!environmentId) throw new Error("Codex Cloud environment ID is required.");
        ctx.ui.setStatus("pi-codex-cloud", "delegating");
        try {
          const result = await client.delegate({
            cwd: ctx.cwd,
            environmentId,
            prompt,
            attempts: attempts(),
          });
          sendResult(pi, `Codex Cloud task submitted from ${result.git.branch}`, result.output);
        } finally {
          ctx.ui.setStatus("pi-codex-cloud", undefined);
        }
      });
    },
  });

  pi.registerCommand("cloud:list", {
    description: "List recent Codex Cloud tasks",
    handler: async (_args, ctx) => {
      await runCommand(ctx, async () => {
        sendResult(pi, "Recent Codex Cloud tasks", await client.list(ctx.cwd, environmentId));
      });
    },
  });

  pi.registerCommand("cloud:status", {
    description: "Show a Codex Cloud task: /cloud:status <task-id>",
    handler: async (args, ctx) => {
      await runCommand(ctx, async () => {
        const { taskId } = parseTaskAndAttempt(args);
        sendResult(pi, `Codex Cloud task ${taskId}`, await client.status(ctx.cwd, taskId));
      });
    },
  });

  pi.registerCommand("cloud:diff", {
    description: "Show a Codex Cloud diff: /cloud:diff <task-id> [attempt]",
    handler: async (args, ctx) => {
      await runCommand(ctx, async () => {
        const parsed = parseTaskAndAttempt(args);
        sendResult(
          pi,
          `Codex Cloud diff ${parsed.taskId}`,
          await client.diff({ cwd: ctx.cwd, ...parsed }),
        );
      });
    },
  });

  pi.registerCommand("cloud:apply", {
    description: "Apply a Codex Cloud diff locally: /cloud:apply <task-id> [attempt]",
    handler: async (args, ctx) => {
      await runCommand(ctx, async () => {
        if (!ctx.hasUI) throw new Error("/cloud:apply requires interactive confirmation.");
        const parsed = parseTaskAndAttempt(args);
        const confirmed = await ctx.ui.confirm(
          "Apply Codex Cloud diff?",
          `Task ${parsed.taskId} will modify the local working tree.`,
        );
        if (!confirmed) {
          ctx.ui.notify("Apply cancelled.", "info");
          return;
        }
        sendResult(
          pi,
          `Applied Codex Cloud task ${parsed.taskId}`,
          await client.apply({ cwd: ctx.cwd, ...parsed }),
        );
      });
    },
  });
}
