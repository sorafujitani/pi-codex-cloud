---
name: cxcloud
description: Delegate repository work from Pi to Codex Cloud and inspect the resulting remote task. Use when the user asks to move suitable work to Codex Cloud or check a delegated task.
---

# cxcloud

Use the `cxcloud` tool to submit repository work to Codex Cloud or inspect existing tasks.

Before delegation:

- Confirm that the user wants the work delegated to Codex Cloud.
- Ensure the task can be completed from the pushed upstream branch. Uncommitted files are not uploaded.
- Write a self-contained prompt with the goal, scope, constraints, and verification criteria.
- When no environment is configured, use the `environments` action to discover reusable IDs from recent tasks. Never substitute an `environment_label` or null value for an ID.
- If discovery returns no ID, direct the user to create a saved environment at `https://chatgpt.com/codex/settings/environments` and run one task from it. Do not attempt delegation without an ID.

Use `list`, `status`, and `diff` to follow the task. Keep these states distinct: submitted, running, completed, diff reviewed, and diff applied locally.

Do not claim that a remote result is present locally until it has been applied. The tool intentionally cannot apply changes. When the user asks to apply a result, direct them to `/cxcloud:apply <task-id> [attempt]`; that command requires interactive confirmation.
