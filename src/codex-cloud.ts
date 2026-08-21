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

export type Exec = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

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

const DEFAULT_TIMEOUT_MS = 30_000;
const DELEGATE_TIMEOUT_MS = 60_000;

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

  const upstreamResult = await exec(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
    { cwd, signal, timeout: DEFAULT_TIMEOUT_MS },
  );
  if (upstreamResult.code !== 0 || !upstreamResult.stdout.trim()) {
    throw new Error(
      `Branch '${branch}' has no upstream. Push it before delegating so Codex Cloud can check it out.`,
    );
  }
  const upstream = upstreamResult.stdout.trim();

  const divergence = outputOf(
    await checkedExec(exec, "git", ["rev-list", "--left-right", "--count", `${upstream}...${branch}`], {
      cwd,
      signal,
      timeout: DEFAULT_TIMEOUT_MS,
    }),
  );
  const [behindText, aheadText] = divergence.split(/\s+/);
  const behind = Number(behindText);
  const ahead = Number(aheadText);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
    throw new Error(`Could not parse Git divergence: ${divergence}`);
  }

  const status = await checkedExec(exec, "git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd,
    signal,
    timeout: DEFAULT_TIMEOUT_MS,
  });

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
    await checkedExec(this.exec, this.codexBinary, ["cloud", "--help"], {
      cwd,
      signal,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    return version;
  }

  async delegate(options: DelegateOptions): Promise<{ output: string; git: GitState }> {
    const environmentId = requireValue(options.environmentId, "Environment ID");
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
    if (environmentId?.trim()) args.push("--env", requireValue(environmentId, "Environment ID"));
    return outputOf(
      await checkedExec(this.exec, this.codexBinary, args, {
        cwd,
        signal,
        timeout: DEFAULT_TIMEOUT_MS,
      }),
    );
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
    if (options.attempt !== undefined) args.push("--attempt", String(parseAttempts(options.attempt)));
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
    if (options.attempt !== undefined) args.push("--attempt", String(parseAttempts(options.attempt)));
    return outputOf(
      await checkedExec(this.exec, this.codexBinary, args, {
        cwd: options.cwd,
        signal: options.signal,
        timeout: DEFAULT_TIMEOUT_MS,
      }),
    );
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
