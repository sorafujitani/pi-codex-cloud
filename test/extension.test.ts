import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import piCodexCloud from "../extensions/index.js";
import type { ExecResult } from "../src/codex-cloud.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function createHarness(taskList: unknown) {
  const commands = new Map<string, CommandHandler>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const selections: string[][] = [];
  const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
    if (args[0] === "cloud" && args[1] === "list") {
      return {
        stdout: JSON.stringify(taskList),
        stderr: "",
        code: 0,
        killed: false,
      };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  const pi = {
    exec,
    registerTool() {},
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, ...(type ? { type } : {}) });
      },
      async select(_title: string, options: string[]) {
        selections.push(options);
        return options[0];
      },
    },
  } as unknown as ExtensionCommandContext;

  piCodexCloud(pi);
  return { commands, ctx, notifications, selections };
}

describe("cxcloud:env", () => {
  it("automatically selects the only reusable environment", async () => {
    const harness = createHarness({
      tasks: [{ environment_id: "env_graphnote", environment_label: "graphnote" }],
    });

    await harness.commands.get("cxcloud:env")?.("auto", harness.ctx);

    expect(harness.selections).toEqual([]);
    expect(harness.notifications).toContainEqual({
      message: "Environment set for this session: env_graphnote",
      type: "info",
    });
  });

  it("explains label-only tasks instead of treating null as an ID", async () => {
    const harness = createHarness({
      tasks: [{ environment_id: null, environment_label: "sorafujitani/graphnote" }],
    });

    await harness.commands.get("cxcloud:env")?.("auto", harness.ctx);

    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.type).toBe("error");
    expect(harness.notifications[0]?.message).toContain(
      "sorafujitani/graphnote (environment_id is null)",
    );
    expect(harness.notifications[0]?.message).toContain(
      "https://chatgpt.com/codex/settings/environments",
    );
  });

  it("opens a selector when multiple reusable environments exist", async () => {
    const harness = createHarness({
      tasks: [
        { environment_id: "env_graphnote", environment_label: "graphnote" },
        { environment_id: "env_other", environment_label: "other" },
      ],
    });

    await harness.commands.get("cxcloud:env")?.("auto", harness.ctx);

    expect(harness.selections).toEqual([["graphnote — env_graphnote", "other — env_other"]]);
    expect(harness.notifications.at(-1)?.message).toBe(
      "Environment set for this session: env_graphnote",
    );
  });
});
