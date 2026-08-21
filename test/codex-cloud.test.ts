import { describe, expect, it } from "vitest";
import {
  assertCloudReady,
  CodexCloudClient,
  type Exec,
  type ExecResult,
  parseAttempts,
  parseTaskAndAttempt,
} from "../src/codex-cloud.js";

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false };
}

describe("parsers", () => {
  it("accepts valid attempts", () => {
    expect(parseAttempts(undefined)).toBe(1);
    expect(parseAttempts("4")).toBe(4);
  });

  it("rejects invalid attempts", () => {
    expect(() => parseAttempts("0")).toThrow("1 to 4");
    expect(() => parseAttempts("1.5")).toThrow("1 to 4");
  });

  it("parses a task and optional attempt", () => {
    expect(parseTaskAndAttempt("task_123 2")).toEqual({ taskId: "task_123", attempt: 2 });
    expect(parseTaskAndAttempt("task_123")).toEqual({ taskId: "task_123" });
  });
});

describe("cloud readiness", () => {
  const cleanState = {
    branch: "feature/test",
    upstream: "origin/feature/test",
    ahead: 0,
    behind: 0,
    dirty: false,
  };

  it("blocks uncommitted local changes by default", () => {
    expect(() => assertCloudReady({ ...cleanState, dirty: true })).toThrow("uncommitted");
  });

  it("allows an explicit dirty-tree opt-in", () => {
    expect(() => assertCloudReady({ ...cleanState, dirty: true }, true)).not.toThrow();
  });

  it("blocks branches that differ from upstream", () => {
    expect(() => assertCloudReady({ ...cleanState, ahead: 1 })).toThrow("ahead 1");
    expect(() => assertCloudReady({ ...cleanState, behind: 1 })).toThrow("behind 1");
  });
});

describe("CodexCloudClient", () => {
  it("passes every user value as a separate process argument", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: Exec = async (command, args) => {
      calls.push({ command, args });
      if (command === "git" && args[0] === "branch") return ok("feature/test\n");
      if (
        command === "git" &&
        args[0] === "rev-parse" &&
        args.some((arg) => arg.endsWith("@{upstream}"))
      ) {
        return ok("origin/feature/test\n");
      }
      if (command === "git" && args[0] === "rev-list") return ok("0\t0\n");
      if (command === "codex") return ok("https://chatgpt.com/codex/tasks/task_123\n");
      return ok();
    };
    const client = new CodexCloudClient(exec);

    const result = await client.delegate({
      cwd: "/repo",
      environmentId: "env_123",
      prompt: "Fix auth; echo $(whoami)",
    });

    expect(result.output).toContain("task_123");
    expect(calls.at(-1)).toEqual({
      command: "codex",
      args: [
        "cloud",
        "exec",
        "--env",
        "env_123",
        "--branch",
        "feature/test",
        "--attempts",
        "1",
        "Fix auth; echo $(whoami)",
      ],
    });
  });

  it("does not submit when the branch has no upstream", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: Exec = async (command, args) => {
      calls.push({ command, args });
      if (command === "git" && args[0] === "branch") return ok("feature/test\n");
      if (
        command === "git" &&
        args[0] === "rev-parse" &&
        args.some((arg) => arg.endsWith("@{upstream}"))
      ) {
        return { stdout: "", stderr: "no upstream", code: 128, killed: false };
      }
      return ok();
    };
    const client = new CodexCloudClient(exec);

    await expect(
      client.delegate({ cwd: "/repo", environmentId: "env_123", prompt: "Fix auth" }),
    ).rejects.toThrow("has no upstream");
    expect(calls.some((call) => call.command === "codex")).toBe(false);
  });
});
