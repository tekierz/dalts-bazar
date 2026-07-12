# Changelog

## 1.0.6

- Harden git invocations to never pass repository-derived arguments through a shell (`shell: false`), matching codex 1.0.6.
- Refresh model examples to the current cursor-agent catalog with the gpt-5.6 series (sol/terra/luna flavors, effort tiers `none` through `max`) as flagship.
- Detect `Max Mode Required` failures and append an actionable hint (plus a `maxModeRequired` flag in `--json` payloads); document which model families are Max-Mode-gated.
- Persist the plugin data dir as `CURSOR_COMPANION_PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, so the codex and cursor session hooks can no longer hijack each other's job state via the shared session env file.

## 1.0.5

- Initial Cursor port of the codex plugin
