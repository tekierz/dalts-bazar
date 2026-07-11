---
name: cursor-cli-runtime
description: Internal helper contract for calling the cursor-companion runtime from Claude Code
user-invocable: false
---

# Cursor Runtime

Use this skill only inside the `cursor:cursor-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `cursor-agent` CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `transfer`, `status`, `result`, or `cancel` from `cursor:cursor-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `cursor-prompting` skill to rewrite the user's request into a tighter Cursor prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, and pass the model id through verbatim (bracket parameters included).
- Default to a write-capable Cursor run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Effort rule:
- Never pass `--effort`. Cursor has no `--effort` flag and the helper rejects it.
- If the user explicitly requested an effort level and named a parameterized model, use bracket syntax in `--model` (for example `--model 'claude-opus-4-8[effort=high]'`).
- If the user requested an effort level without naming a model, choose the matching model-id variant only when one obviously exists (for example `gpt-5.6-sol-high`); otherwise omit `--model` entirely.
- The gpt-5.6 series ships three flavors (`gpt-5.6-sol-*`, `gpt-5.6-terra-*`, `gpt-5.6-luna-*`), each with effort tiers `none`/`low`/`medium`/`high`/`xhigh`/`max` and `-fast` variants (for example `gpt-5.6-terra-xhigh-fast`). Run `cursor-agent models` when unsure what the account offers.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task` verbatim.
- If the forwarded request includes `--effort`, strip that flag and its value from the task text and apply the effort rule above instead of passing it through.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Cursor work in `cursor:cursor-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or the Cursor agent cannot be invoked, return nothing.
