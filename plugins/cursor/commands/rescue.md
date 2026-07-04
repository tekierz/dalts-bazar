---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Cursor rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [what Cursor should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `cursor:cursor-rescue` subagent via the `Agent` tool (`subagent_type: "cursor:cursor-rescue"`), forwarding the raw user request as the prompt.
`cursor:cursor-rescue` is a subagent, not a skill — do not call `Skill(cursor:cursor-rescue)` (no such skill) or `Skill(cursor:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Cursor's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `cursor:cursor-rescue` subagent in the background.
- If the request includes `--wait`, run the `cursor:cursor-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text.
- There is no `--effort` flag. If the user asks for a specific reasoning effort, do not invent one; the `cursor-cli-runtime` skill folds effort into the model id or `--model` bracket parameters (e.g. `--model 'claude-opus-4-8[effort=high]'`).
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Cursor, check for a resumable rescue chat from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Cursor chat or start a new one.
- The two choices must be:
  - `Continue current Cursor chat`
  - `Start a new Cursor chat`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Cursor chat (Recommended)` first.
- Otherwise put `Start a new Cursor chat (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new chat, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Cursor companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/cursor:status`, fetch `/cursor:result`, call `/cursor:cancel`, summarize output, or do follow-up work of its own.
- Never pass `--effort`. It does not exist in the Cursor runtime.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Cursor is missing or unauthenticated, stop and tell the user to run `/cursor:setup`.
- If the user did not supply a request, ask what Cursor should investigate or fix.
