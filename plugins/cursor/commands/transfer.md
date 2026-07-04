---
description: Transfer the current Claude Code session into a resumable Cursor chat
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Cursor chat ID and the `cursor-agent --resume <chat-id>` command.
