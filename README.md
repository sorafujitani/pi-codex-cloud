# pi-codex-cloud

Delegate work from [Pi](https://pi.dev/) to an isolated Codex Cloud environment, then inspect or apply the result without leaving Pi.

The extension is a thin, auditable wrapper around the official `codex cloud` CLI commands. It does not copy Pi's conversation or local files into the cloud. Codex Cloud checks out a branch from the remote repository, so delegation is blocked when the local branch is unpushed or diverged.

## Requirements

- Pi 0.84 or newer
- Codex CLI with `codex cloud` support
- A Codex Cloud environment connected to the repository
- A Git branch with an up-to-date upstream

Set up the repository and environment in Codex Cloud before using this extension. The same Codex CLI authentication is used.

## Install

```bash
pi install git:github.com/sorafujitani/pi-codex-cloud
```

For local development:

```bash
pi install /absolute/path/to/pi-codex-cloud
```

## Configure

Set the default Codex Cloud environment ID before starting Pi:

```bash
export PI_CXCLOUD_ENV_ID="your-environment-id"
pi
```

You can also set it for the current Pi session:

```text
/cxcloud:env your-environment-id
```

The optional `PI_CXCLOUD_ATTEMPTS` variable sets the default best-of-N attempt count from 1 to 4. The default is 1.

## Commands

```text
/cxcloud:setup
/cxcloud:env [environment-id]
/cxcloud:delegate <task prompt>
/cxcloud:list
/cxcloud:status <task-id>
/cxcloud:diff <task-id> [attempt]
/cxcloud:apply <task-id> [attempt]
```

`/cxcloud:apply` always asks for confirmation before changing the local working tree.

## Agent tool

The extension registers a `cxcloud` tool so Pi can delegate a task and inspect `list`, `status`, or `diff` results itself. Applying a diff is intentionally only available as the user-invoked `/cxcloud:apply` command.

The package also includes a `cxcloud` Agent Skill. Pi loads it on demand when a request is suitable for Codex Cloud delegation, or you can invoke it explicitly with `/skill:cxcloud`.

Example request to Pi:

```text
Delegate this implementation to Codex Cloud. Ask it to add tests and return the task URL.
```

## Safety model

Before delegation, the extension checks that:

- the working directory is a Git repository;
- the selected branch has an upstream;
- the local branch and upstream have not diverged;
- the working tree is clean, unless the caller explicitly opts into ignoring local-only changes.

Even with `allow_dirty`, uncommitted files are never sent to Codex Cloud. The remote task only sees the selected remote branch.

Commands are executed with an argument array through Pi's extension API. User input is never interpolated into a shell command.

## Development

```bash
vp install
vp check
vp test --run
```

## License

MIT
