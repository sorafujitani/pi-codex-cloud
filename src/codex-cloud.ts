export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface GitState {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export interface DelegateOptions {
  cwd: string;
  environmentId: string;
  prompt: string;
  branch?: string;
  attempts?: number;
  allowDirty?: boolean;
  signal?: AbortSignal;
}

export interface InspectOptions {
  cwd: string;
  taskId: string;
  attempt?: number;
  signal?: AbortSignal;
}

export interface CloudEnvironment {
  id: string;
  label?: string;
}

export interface EnvironmentDiscovery {
  environments: CloudEnvironment[];
  labelsWithoutId: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DELEGATE_TIMEOUT_MS = 60_000;
const APPLY_TIMEOUT_MS = 120_000;
export const ENVIRONMENT_SETTINGS_URL = "https://chatgpt.com/codex/settings/environments";

export class CommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly args: string[],
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

function outputOf(result: ExecResult): string {
  return result.stdout.trim() || result.stderr.trim();
}

async function checkedExec(
  exec: Exec,
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const result = await exec(command, args, options);
  if (result.killed) {
    throw new CommandError(`${command} timed out or was aborted`, command, args, result);
  }
  if (result.code !== 0) {
    const detail = outputOf(result);
    throw new CommandError(
      detail ? `${command} failed: ${detail}` : `${command} exited with code ${result.code}`,
      command,
      args,
      result,
    );
  }
  return result;
}

function requireValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  if (trimmed.startsWith("-")) throw new Error(`${label} must not start with '-'.`);
  return trimmed;
}

export function resolveCodexBinary(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "codex";
  return requireValue(value, "Codex binary");
}

export function parseEnvironmentId(value: string): string {
  const environmentId = requireValue(value, "Environment ID");
  if (environmentId.toLowerCase() === "null") {
    throw new Error(
      "'null' is not a usable Environment ID. Create a saved Codex Cloud environment or use /cxcloud:env auto.",
    );
  }
  return environmentId;
}

export function wrapMarkdownFence(body: string, language = "text"): string {
  const content = body || "(no output)";
  const runs = content.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseEnvironmentDiscovery(output: string): EnvironmentDiscovery {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("Could not parse Codex Cloud task list as JSON.");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("tasks" in payload) ||
    !Array.isArray(payload.tasks)
  ) {
    throw new Error("Codex Cloud task list does not contain a tasks array.");
  }

  const environments = new Map<string, CloudEnvironment>();
  const labelsWithoutId = new Set<string>();
  for (const task of payload.tasks) {
    if (typeof task !== "object" || task === null) continue;
    const id = "environment_id" in task ? nonEmptyString(task.environment_id) : undefined;
    const label = "environment_label" in task ? nonEmptyString(task.environment_label) : undefined;
    if (id) {
      const existing = environments.get(id);
      if (!existing) environments.set(id, label ? { id, label } : { id });
      else if (!existing.label && label) environments.set(id, { id, label });
    } else if (label) {
      labelsWithoutId.add(label);
    }
  }

  for (const environment of environments.values()) {
    if (environment.label) labelsWithoutId.delete(environment.label);
  }
  return {
    environments: [...environments.values()],
    labelsWithoutId: [...labelsWithoutId],
  };
}

export function summarizeEnvironmentDiscovery(discovery: EnvironmentDiscovery): string {
  const lines: string[] = [];
  if (discovery.environments.length > 0) {
    lines.push("Reusable environments from recent tasks:");
    for (const environment of discovery.environments) {
      lines.push(`- ${environment.label ? `${environment.label}: ` : ""}${environment.id}`);
    }
  } else {
    lines.push("No reusable Environment ID was found in recent Codex Cloud tasks.");
  }
  if (discovery.labelsWithoutId.length > 0) {
    lines.push("Recent task labels without a reusable ID:");
    for (const label of discovery.labelsWithoutId) {
      lines.push(`- ${label} (environment_id is null)`);
    }
  }
  if (discovery.environments.length === 0) {
    lines.push(
      `Create a saved environment at ${ENVIRONMENT_SETTINGS_URL}, run one task from it, then retry /cxcloud:env.`,
    );
  }
  return lines.join("\n");
}

export function parseAttempts(value: string | number | undefined): number {
  if (value === undefined || value === "") return 1;
  const attempts = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) {
    throw new Error("Attempts must be an integer from 1 to 4.");
  }
  return attempts;
}

export function parseTaskAndAttempt(args: string): { taskId: string; attempt?: number } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const taskId = requireValue(parts[0] ?? "", "Task ID");
  if (parts.length > 2) throw new Error("Expected: <task-id> [attempt].");
  const attempt = parts[1] === undefined ? undefined : parseAttempts(parts[1]);
  return attempt === undefined ? { taskId } : { taskId, attempt };
}

export async function inspectGitState(
  exec: Exec,
  cwd: string,
  requestedBranch?: string,
  signal?: AbortSignal,
): Promise<GitState> {
  await checkedExec(exec, "git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    signal,
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const branch = requestedBranch
    ? requireValue(requestedBranch, "Branch")
    : outputOf(
        await checkedExec(exec, "git", ["branch", "--show-current"], {
          cwd,
          signal,
          timeout: DEFAULT_TIMEOUT_MS,
        }),
      );

  if (!branch) {
    throw new Error("The repository is in detached HEAD state. Specify a branch explicitly.");
  }

  await checkedExec(exec, "git", ["check-ref-format", "--branch", branch], {
    cwd,
    signal,
    timeout: DEFAULT_TIMEOUT_MS,
  });

  const upstreamArgs = [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  ];
  const upstreamResult = await exec("git", upstreamArgs, {
    cwd,
    signal,
    timeout: DEFAULT_TIMEOUT_MS,
  });
  if (upstreamResult.killed) {
    throw new Error(
      `Could not resolve upstream for branch '${branch}': git timed out or was aborted.`,
    );
  }
  if (upstreamResult.code !== 0) {
    const detail = outputOf(upstreamResult);
    if (/no upstream configured/i.test(`${upstreamResult.stderr}\n${upstreamResult.stdout}`)) {
      throw new Error(
        `Branch '${branch}' has no upstream. Push it before delegating so Codex Cloud can check it out.`,
      );
    }
    throw new CommandError(
      detail ? `git failed: ${detail}` : `git exited with code ${upstreamResult.code}`,
      "git",
      upstreamArgs,
      upstreamResult,
    );
  }
  const upstream = upstreamResult.stdout.trim();
  if (!upstream) {
    throw new Error(`Could not resolve upstream for branch '${branch}'.`);
  }

  const divergence = outputOf(
    await checkedExec(
      exec,
      "git",
      ["rev-list", "--left-right", "--count", `${upstream}...${branch}`],
      {
        cwd,
        signal,
        timeout: DEFAULT_TIMEOUT_MS,
      },
    ),
  );
  const [behindText, aheadText] = divergence.split(/\s+/);
  const behind = Number(behindText);
  const ahead = Number(aheadText);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
    throw new Error(`Could not parse Git divergence: ${divergence}`);
  }

  const status = await checkedExec(
    exec,
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    {
      cwd,
      signal,
      timeout: DEFAULT_TIMEOUT_MS,
    },
  );

  return {
    branch,
    upstream,
    ahead,
    behind,
    dirty: status.stdout.trim().length > 0,
  };
}

export function assertCloudReady(state: GitState, allowDirty = false): void {
  if (state.ahead !== 0 || state.behind !== 0) {
    throw new Error(
      `Branch '${state.branch}' differs from '${state.upstream}' (ahead ${state.ahead}, behind ${state.behind}). Push or synchronize it before delegating.`,
    );
  }
  if (state.dirty && !allowDirty) {
    throw new Error(
      "The working tree has uncommitted changes. Commit and push them, or explicitly set allow_dirty when the remote branch is intentionally sufficient.",
    );
  }
}

export class CodexCloudClient {
  constructor(
    private readonly exec: Exec,
    private readonly codexBinary = "codex",
  ) {}

  async check(cwd: string, signal?: AbortSignal): Promise<string> {
    const version = outputOf(
      await checkedExec(this.exec, this.codexBinary, ["--version"], {
        cwd,
        signal,
        timeout: DEFAULT_TIMEOUT_MS,
      }),
    );
    const login = outputOf(
      await checkedExec(this.exec, this.codexBinary, ["login", "status"], {
        cwd,
        signal,
        timeout: DEFAULT_TIMEOUT_MS,
      }),
    );
    await checkedExec(this.exec, this.codexBinary, ["cloud", "--help"], {
      cwd,
      signal,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    return [version, login].filter(Boolean).join("; ");
  }

  async delegate(options: DelegateOptions): Promise<{ output: string; git: GitState }> {
    const environmentId = parseEnvironmentId(options.environmentId);
    const prompt = requireValue(options.prompt, "Task prompt");
    const attempts = parseAttempts(options.attempts);
    const git = await inspectGitState(this.exec, options.cwd, options.branch, options.signal);
    assertCloudReady(git, options.allowDirty);

    const result = await checkedExec(
      this.exec,
      this.codexBinary,
      [
        "cloud",
        "exec",
        "--env",
        environmentId,
        "--branch",
        git.branch,
        "--attempts",
        String(attempts),
        prompt,
      ],
      {
        cwd: options.cwd,
        signal: options.signal,
        timeout: DELEGATE_TIMEOUT_MS,
      },
    );
    return { output: outputOf(result), git };
  }

  async list(cwd: string, environmentId?: string, signal?: AbortSignal): Promise<string> {
    const args = ["cloud", "list", "--json"];
    if (environmentId?.trim()) args.push("--env", parseEnvironmentId(environmentId));
    return outputOf(
      await checkedExec(this.exec, this.codexBinary, args, {
        cwd,
        signal,
        timeout: DEFAULT_TIMEOUT_MS,
      }),
    );
  }

  async discoverEnvironments(cwd: string, signal?: AbortSignal): Promise<EnvironmentDiscovery> {
    return parseEnvironmentDiscovery(await this.list(cwd, undefined, signal));
  }

  async status(cwd: string, taskId: string, signal?: AbortSignal): Promise<string> {
    return outputOf(
      await checkedExec(
        this.exec,
        this.codexBinary,
        ["cloud", "status", requireValue(taskId, "Task ID")],
        { cwd, signal, timeout: DEFAULT_TIMEOUT_MS },
      ),
    );
  }

  async diff(options: InspectOptions): Promise<string> {
    const args = ["cloud", "diff", requireValue(options.taskId, "Task ID")];
    if (options.attempt !== undefined)
      args.push("--attempt", String(parseAttempts(options.attempt)));
    return outputOf(
      await checkedExec(this.exec, this.codexBinary, args, {
        cwd: options.cwd,
        signal: options.signal,
        timeout: DEFAULT_TIMEOUT_MS,
      }),
    );
  }

  async apply(options: InspectOptions): Promise<string> {
    const args = ["cloud", "apply", requireValue(options.taskId, "Task ID")];
    if (options.attempt !== undefined)
      args.push("--attempt", String(parseAttempts(options.attempt)));
    try {
      return outputOf(
        await checkedExec(this.exec, this.codexBinary, args, {
          cwd: options.cwd,
          signal: options.signal,
          timeout: APPLY_TIMEOUT_MS,
        }),
      );
    } catch (error) {
      if (error instanceof CommandError && error.result.killed) {
        throw new CommandError(
          `${error.command} timed out or was aborted while applying. The working tree may be left in a partial state.`,
          error.command,
          error.args,
          error.result,
        );
      }
      throw error;
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
