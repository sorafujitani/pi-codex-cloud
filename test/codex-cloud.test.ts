import { describe, expect, it } from "vitest";
import {
  assertCloudReady,
  CodexCloudClient,
  CommandError,
  type Exec,
  type ExecResult,
  inspectGitState,
  parseAttempts,
  parseEnvironmentDiscovery,
  parseEnvironmentId,
  parseTaskAndAttempt,
  resolveCodexBinary,
  summarizeEnvironmentDiscovery,
  wrapMarkdownFence,
} from "../src/codex-cloud.js";

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false };
}

describe("parsers", () => {
  it("accepts valid attempts", () => {
    expect(parseAttempts(undefined)).toBe(1);
    expect(parseAttempts("")).toBe(1);
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

  it("rejects null as an environment ID", () => {
    expect(() => parseEnvironmentId("null")).toThrow("is not a usable Environment ID");
    expect(parseEnvironmentId(" env_123 ")).toBe("env_123");
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
  it("checks the CLI version, login, and cloud command", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: Exec = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "--version") return ok("codex-cli 1.2.3\n");
      if (args[0] === "login") return ok("Logged in using ChatGPT\n");
      return ok();
    };
    const client = new CodexCloudClient(exec);

    await expect(client.check("/repo")).resolves.toBe("codex-cli 1.2.3; Logged in using ChatGPT");
    expect(calls).toEqual([
      { command: "codex", args: ["--version"] },
      { command: "codex", args: ["login", "status"] },
      { command: "codex", args: ["cloud", "--help"] },
    ]);
  });

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
        return {
          stdout: "",
          stderr: "fatal: no upstream configured for branch 'feature/test'\n",
          code: 128,
          killed: false,
        };
      }
      return ok();
    };
    const client = new CodexCloudClient(exec);

    await expect(
      client.delegate({ cwd: "/repo", environmentId: "env_123", prompt: "Fix auth" }),
    ).rejects.toThrow("has no upstream");
    expect(calls.some((call) => call.command === "codex")).toBe(false);
  });

  it("does not submit when the working tree is dirty", async () => {
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
      if (command === "git" && args[0] === "status") return ok(" M src/codex-cloud.ts\n");
      return ok();
    };
    const client = new CodexCloudClient(exec);

    await expect(
      client.delegate({ cwd: "/repo", environmentId: "env_123", prompt: "Fix auth" }),
    ).rejects.toThrow("uncommitted");
    expect(calls.some((call) => call.command === "codex")).toBe(false);
  });

  it("uses a requested branch instead of HEAD", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: Exec = async (command, args) => {
      calls.push({ command, args });
      if (
        command === "git" &&
        args[0] === "rev-parse" &&
        args.some((arg) => arg.endsWith("@{upstream}"))
      ) {
        return ok("origin/release/1\n");
      }
      if (command === "git" && args[0] === "rev-list") return ok("0\t0\n");
      return ok();
    };
    const client = new CodexCloudClient(exec);

    const result = await client.delegate({
      cwd: "/repo",
      environmentId: "env_123",
      prompt: "Fix auth",
      branch: "release/1",
    });

    expect(result.git.branch).toBe("release/1");
    expect(calls.some((call) => call.args[0] === "branch")).toBe(false);
    expect(calls.at(-1)?.args).toContain("release/1");
  });

  it("passes task id and attempt as separate arguments", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: Exec = async (command, args) => {
      calls.push({ command, args });
      return ok("ok\n");
    };
    const client = new CodexCloudClient(exec);

    await client.status("/repo", "task_123");
    await client.diff({ cwd: "/repo", taskId: "task_123", attempt: 2 });
    await client.apply({ cwd: "/repo", taskId: "task_123", attempt: 3 });

    expect(calls).toEqual([
      { command: "codex", args: ["cloud", "status", "task_123"] },
      { command: "codex", args: ["cloud", "diff", "task_123", "--attempt", "2"] },
      { command: "codex", args: ["cloud", "apply", "task_123", "--attempt", "3"] },
    ]);
  });

  it("uses a custom Codex binary name", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: Exec = async (command, args) => {
      calls.push({ command, args });
      return ok("ok\n");
    };
    const client = new CodexCloudClient(exec, "mycodex");

    await client.status("/repo", "task_123");
    expect(calls).toEqual([{ command: "mycodex", args: ["cloud", "status", "task_123"] }]);
  });

  it("rejects option values that start with '-'", async () => {
    const exec: Exec = async () => ok();
    const client = new CodexCloudClient(exec);

    await expect(
      client.delegate({ cwd: "/repo", environmentId: "-env", prompt: "Fix auth" }),
    ).rejects.toThrow("must not start with '-'");
    await expect(
      client.delegate({ cwd: "/repo", environmentId: "env_123", prompt: "-Fix" }),
    ).rejects.toThrow("must not start with '-'");
    await expect(
      client.delegate({
        cwd: "/repo",
        environmentId: "env_123",
        prompt: "Fix auth",
        branch: "-main",
      }),
    ).rejects.toThrow("must not start with '-'");
    await expect(client.status("/repo", "-task")).rejects.toThrow("must not start with '-'");
  });

  it("reports apply timeouts and possible partial working tree", async () => {
    const exec: Exec = async (_command, _args, options) => {
      expect(options?.timeout).toBe(120_000);
      return { stdout: "", stderr: "", code: 1, killed: true };
    };
    const client = new CodexCloudClient(exec);

    await expect(client.apply({ cwd: "/repo", taskId: "task_123" })).rejects.toThrow(
      /timed out or was aborted.*partial state/s,
    );
  });
});

describe("inspectGitState", () => {
  it("rejects detached HEAD", async () => {
    const exec: Exec = async (command, args) => {
      if (command === "git" && args[0] === "branch") return ok("");
      return ok();
    };

    await expect(inspectGitState(exec, "/repo")).rejects.toThrow("detached HEAD");
  });

  it("does not treat a killed upstream lookup as missing upstream", async () => {
    const exec: Exec = async (command, args) => {
      if (command === "git" && args[0] === "branch") return ok("feature/test\n");
      if (
        command === "git" &&
        args[0] === "rev-parse" &&
        args.some((arg) => arg.endsWith("@{upstream}"))
      ) {
        return { stdout: "", stderr: "", code: 1, killed: true };
      }
      return ok();
    };

    const error = await inspectGitState(exec, "/repo").catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out or was aborted/);
    expect((error as Error).message).not.toContain("has no upstream");
  });

  it("does not treat other git failures as a missing upstream", async () => {
    const exec: Exec = async (command, args) => {
      if (command === "git" && args[0] === "branch") return ok("feature/test\n");
      if (
        command === "git" &&
        args[0] === "rev-parse" &&
        args.some((arg) => arg.endsWith("@{upstream}"))
      ) {
        return { stdout: "", stderr: "fatal: bad revision\n", code: 128, killed: false };
      }
      return ok();
    };

    const error = await inspectGitState(exec, "/repo").catch((caught) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as Error).message).toContain("fatal: bad revision");
    expect((error as Error).message).not.toContain("has no upstream");
  });

  it("does not treat an empty successful upstream lookup as missing upstream", async () => {
    const exec: Exec = async (command, args) => {
      if (command === "git" && args[0] === "branch") return ok("feature/test\n");
      if (
        command === "git" &&
        args[0] === "rev-parse" &&
        args.some((arg) => arg.endsWith("@{upstream}"))
      ) {
        return { stdout: "\n", stderr: "", code: 0, killed: false };
      }
      return ok();
    };

    const error = await inspectGitState(exec, "/repo").catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Could not resolve upstream");
    expect((error as Error).message).not.toContain("has no upstream");
  });
});

describe("resolveCodexBinary", () => {
  it("defaults empty values to codex", () => {
    expect(resolveCodexBinary(undefined)).toBe("codex");
    expect(resolveCodexBinary("")).toBe("codex");
    expect(resolveCodexBinary("  ")).toBe("codex");
  });

  it("rejects names that start with '-'", () => {
    expect(() => resolveCodexBinary("-codex")).toThrow("must not start with '-'");
  });
});

describe("wrapMarkdownFence", () => {
  it("lengthens the fence when the body contains backticks", () => {
    const body = "example:\n```\ncode\n```";
    const fenced = wrapMarkdownFence(body);
    expect(fenced.startsWith("````text\n")).toBe(true);
    expect(fenced.endsWith("\n````")).toBe(true);
    expect(fenced).toContain(body);
  });
});

describe("environment discovery", () => {
  it("collects and deduplicates reusable environment IDs", () => {
    const discovery = parseEnvironmentDiscovery(
      JSON.stringify({
        tasks: [
          { environment_id: "env_graphnote", environment_label: "sorafujitani/graphnote" },
          { environment_id: "env_graphnote", environment_label: "sorafujitani/graphnote" },
          { environment_id: "env_other", environment_label: "sorafujitani/other" },
        ],
        cursor: null,
      }),
    );

    expect(discovery).toEqual({
      environments: [
        { id: "env_graphnote", label: "sorafujitani/graphnote" },
        { id: "env_other", label: "sorafujitani/other" },
      ],
      labelsWithoutId: [],
    });
  });

  it("reports task labels whose environment ID is null", () => {
    const discovery = parseEnvironmentDiscovery(
      JSON.stringify({
        tasks: [
          {
            id: "task_e_6a881035084c8330a004aaa4db7628bb",
            environment_id: null,
            environment_label: "sorafujitani/graphnote",
          },
        ],
        cursor: null,
      }),
    );

    expect(discovery).toEqual({
      environments: [],
      labelsWithoutId: ["sorafujitani/graphnote"],
    });
    expect(summarizeEnvironmentDiscovery(discovery)).toContain(
      "sorafujitani/graphnote (environment_id is null)",
    );
    expect(summarizeEnvironmentDiscovery(discovery)).toContain(
      "https://chatgpt.com/codex/settings/environments",
    );
  });

  it("rejects malformed cloud task JSON", () => {
    expect(() => parseEnvironmentDiscovery("not json")).toThrow(
      "Could not parse Codex Cloud task list",
    );
    expect(() => parseEnvironmentDiscovery('{"tasks":{}}')).toThrow(
      "does not contain a tasks array",
    );
  });

  it("discovers environments through the unfiltered task list", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: Exec = async (command, args) => {
      calls.push({ command, args });
      return ok(
        JSON.stringify({
          tasks: [{ environment_id: "env_graphnote", environment_label: "graphnote" }],
        }),
      );
    };
    const client = new CodexCloudClient(exec);

    await expect(client.discoverEnvironments("/repo")).resolves.toEqual({
      environments: [{ id: "env_graphnote", label: "graphnote" }],
      labelsWithoutId: [],
    });
    expect(calls).toEqual([{ command: "codex", args: ["cloud", "list", "--json"] }]);
  });
});
