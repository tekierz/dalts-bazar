---
description: Check whether the local Cursor CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup --json $ARGUMENTS
```

If the result says the Cursor CLI (`cursor-agent`) is unavailable:
- Do not install it yourself, and do not run the installer on the user's behalf.
- Surface the install one-liner and suggest the user run it as:

```
!curl https://cursor.com/install -fsS | bash
```

If the Cursor CLI is already installed:
- Do not mention installation.

Output rules:
- Present the final setup output to the user.
- If the Cursor CLI is installed but not authenticated, preserve the guidance to run `!cursor-agent login`, and mention that setting the `CURSOR_API_KEY` environment variable is an alternative.
