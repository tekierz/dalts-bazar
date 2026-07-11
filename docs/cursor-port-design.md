# Cursor plugin port — design document

Goal: a `plugins/cursor` Claude Code plugin exposing `/cursor:*` commands that delegate work to the
local **Cursor CLI** (`cursor-agent`), living alongside the untouched `plugins/codex` plugin in this
repo. It mirrors the codex plugin's UX (review / adversarial-review / rescue / transfer / status /
result / cancel / setup, background jobs, optional stop-time review gate) on top of a much simpler
runtime: one-shot headless `cursor-agent` processes instead of a persistent app-server + broker.

Everything in this document is **pinned**: implementers must follow names, flags, and strings
exactly. Ground truth was verified against `cursor-agent 2026.07.01-41b2de7` on 2026-07-04.

---

## 1. Verified cursor-agent ground truth

- Headless run: `cursor-agent -p --output-format stream-json --trust [flags]` with the **prompt
  piped via stdin** (verified working; avoids argv size limits on all platforms).
- `--mode plan` and `--mode ask` are read-only. **Both reject ALL shell commands headlessly**
  (verified: `shellToolCall` → `result.rejected`, even for `git log`). File reads
  (`readToolCall`) work fine in plan mode. Default `-p` (no `--mode`) is write-capable;
  `-f/--force` force-allows commands unless explicitly denied.
- stream-json events (NDJSON, one per line; `session_id` on every event):
  - `{"type":"system","subtype":"init","apiKeySource":"login","cwd":...,"session_id":"<uuid>","model":"<display name>","permissionMode":"default"}`
  - `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},...}`
  - `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"session_id":...}` (repeats; may carry `model_call_id`, `timestamp_ms`)
  - `{"type":"tool_call","subtype":"started"|"completed","call_id":"...","tool_call":{"<name>ToolCall":{"args":{...},"result":{"success":{...}}|{"rejected":{...}}}},...}`
    — tool key is camelCase: `readToolCall`, `shellToolCall`, `writeToolCall`, etc.
  - `{"type":"result","subtype":"success","duration_ms":N,"duration_api_ms":N,"is_error":false,"result":"<full assistant text>","session_id":"<uuid>","request_id":"...","usage":{"inputTokens":N,"outputTokens":N,"cacheReadTokens":N,"cacheWriteTokens":N}}`
    — terminal event; `result` is the concatenation of all assistant text in the turn.
- Resume: `cursor-agent --resume <chatId> -p ...` continues a session with context (verified).
  `--continue` = resume latest. `cursor-agent ls`/`resume` are **TTY-only TUIs** — never shell out
  to them headlessly (they crash without a TTY).
- `cursor-agent create-chat` prints a bare chat UUID on stdout, exit 0 (verified).
- Auth probe: `cursor-agent status --format json` → `{"status":"authenticated","isAuthenticated":true,...,"userInfo":{"email":...}}`, exit 0 when authed. `cursor-agent login` / `logout`; `CURSOR_API_KEY` env or `--api-key` for API-key auth.
- `cursor-agent --version` prints e.g. `2026.07.01-41b2de7`.
- Models: `cursor-agent models` lists `id - Display Name` lines (ANSI-colored, `(current)`
  marker). Model ids encode effort variants (e.g. `gpt-5.6-sol-high`, `composer-2.5-fast`);
  parameterized models accept bracket overrides: `--model 'claude-opus-4-8[effort=high]'`.
  **There is no `--effort` flag.** When `--model` is omitted, the account default is used.
- Sessions on disk: `~/.cursor/chats/<md5-of-abs-cwd>/<chat-uuid>/` (meta.json, store.db). We do
  NOT enumerate these; job tracking is our source of truth for resumable chats.
- Install: `curl https://cursor.com/install -fsS | bash`. No npm package.
- Failure mode: on hard failure the CLI exits non-zero with stderr text and may emit **no**
  well-formed JSON at all.

## 2. What is ported, dropped, and new (vs `plugins/codex`)

**Dropped entirely** (no equivalent needed — cursor-agent has no persistent server):
`scripts/app-server-broker.mjs`, `lib/app-server.mjs`, `lib/broker-endpoint.mjs`,
`lib/broker-lifecycle.mjs`, `lib/app-server-protocol.d.ts`, the `.generated` types, and the
`prebuild`/`build` TypeScript steps (cursor plugin has no build step).

**New:**
- `scripts/lib/cursor.mjs` — the cursor-agent integration (replaces `lib/codex.mjs`).
- `scripts/lib/cursor-session-transfer.mjs` — transcript resolution **plus** a mechanical
  transcript distiller (transfer has no importer API; see §7).
- `prompts/review.md` — `/cursor:review` is prompt-driven (no native reviewer exists).
- `prompts/transfer-handoff.md`.

**Ported with renames** (see pin tables): companion entry point, state/job tracking, git review
targeting (with a read-only-context twist, §6), render, args/fs/process/prompts/workspace libs,
all 8 commands, rescue agent, 3 skills, 2 hook scripts + hooks.json, review-output schema
(copied byte-identical), tests (new fixture + suites).

## 3. Naming and namespace pins

| Concept | codex plugin | cursor plugin (PINNED) |
|---|---|---|
| Plugin dir / name | `plugins/codex`, `codex` | `plugins/cursor`, `cursor` |
| Commands | `/codex:*` | `/cursor:*` |
| Companion script | `scripts/codex-companion.mjs` | `scripts/cursor-companion.mjs` |
| Rescue agent | `agents/codex-rescue.md`, `codex:codex-rescue` | `agents/cursor-rescue.md`, `cursor:cursor-rescue` |
| Skills | `codex-cli-runtime`, `codex-result-handling`, `gpt-5-4-prompting` | `cursor-cli-runtime`, `cursor-result-handling`, `cursor-prompting` |
| Session env | `CODEX_COMPANION_SESSION_ID` | `CURSOR_COMPANION_SESSION_ID` |
| Transcript env | `CODEX_COMPANION_TRANSCRIPT_PATH` | `CURSOR_COMPANION_TRANSCRIPT_PATH` |
| Broker env vars | `CODEX_COMPANION_APP_SERVER_*` | (none — no broker) |
| State fallback root | `os.tmpdir()/codex-companion` | `os.tmpdir()/cursor-companion` |
| Temp dir prefix (`fs.mjs`) | `codex-plugin-` | `cursor-plugin-` |
| Progress stderr prefix | `[codex]` | `[cursor]` |
| Job titles | `Codex Review`, `Codex Task`, `Codex Resume`, `Codex Stop Gate Review`, `Codex Adversarial Review` | `Cursor Review`, `Cursor Task`, `Cursor Resume`, `Cursor Stop Gate Review`, `Cursor Adversarial Review` |
| Resume hint | `Codex session ID: X` / `codex resume X` | `Cursor chat ID: X` / `cursor-agent --resume X` |
| Install hint | `npm install -g @openai/codex` | `curl https://cursor.com/install -fsS \| bash` |
| Login hint | `!codex login` | `!cursor-agent login` |
| Binary | `codex` | `cursor-agent` |
| Job record field for the remote thread | `threadId` | `threadId` (KEPT — stores the cursor chat UUID; render labels call it a chat) |
| Stop-gate marker | `Run a stop-gate review of the previous Claude turn.` | same text (KEPT) |
| `DEFAULT_CONTINUE_PROMPT` | keep the codex text verbatim | same |

Internal job schema, state.json layout, job id format (`task-…`, `review-…`), and the
`state.mjs`/`tracked-jobs.mjs`/`job-control.mjs` APIs are kept **identical** apart from the pins
above (state is already isolated per plugin via `CLAUDE_PLUGIN_DATA`).

## 4. `lib/cursor.mjs` — pinned API

```js
export const DEFAULT_CONTINUE_PROMPT = /* same text as codex.mjs */;
export function getCursorAvailability(cwd)        // {available, version|null, detail?} via `cursor-agent --version`
export async function getCursorAuthStatus(cwd)    // {loggedIn, email|null, detail} via `cursor-agent status --format json`
export async function runCursorAgentTurn(cwd, {
  prompt,            // string; ALWAYS piped via stdin
  resumeChatId,      // optional chat uuid → argv --resume <id>
  model,             // optional → argv --model <m> (verbatim passthrough, brackets allowed)
  write,             // boolean: true → argv --force ; false → argv --mode plan
  onProgress,        // (event) => void  — same event contract as codex progress reporter
}) // → {status, chatId, finalMessage, stderr, usage|null, durationMs|null, rejectedToolCalls: string[]}
export function createCursorChat(cwd)             // → chat uuid string (validates /^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
export function parseStructuredOutput(text, {status, failureMessage}) // {parsed, rawOutput, parseError}
export function readOutputSchema(schemaPath)      // same as codex.mjs
```

`runCursorAgentTurn` argv (exact order):
`["-p", "--output-format", "stream-json", "--trust", ...(write ? ["--force"] : ["--mode", "plan"]), ...(model ? ["--model", model] : []), ...(resumeChatId ? ["--resume", resumeChatId] : [])]`
spawned as `cursor-agent` with `{cwd, env}`, prompt written to stdin then stdin ended. Parse
stdout line-buffered; ignore unparseable lines; collect stderr. Progress mapping:
- `system/init` → phase `starting` (include model display name in message)
- `assistant` text → phase message updates (shortened snippet)
- `tool_call started`: key `readToolCall`/`grepToolCall`/`globToolCall`/`lsToolCall` → phase
  `investigating`; `shellToolCall` → `running`; `writeToolCall`/`editToolCall`/`applyPatchToolCall`
  → `editing`; `todoToolCall` → `planning`; anything else → `running`.
- `tool_call completed` with `result.rejected` → log line `Tool call rejected: <toolKey>` and push
  the tool key onto `rejectedToolCalls`.
- `result` → terminal: `finalMessage = event.result ?? ""`, `chatId = event.session_id`,
  `usage`, `durationMs = duration_ms`; `status = (is_error || child exit != 0) ? 1 : 0`.
- Child exit without a `result` event → `status = exit code || 1`, `finalMessage = ""` and
  `stderr` carries diagnostics.

`parseStructuredOutput` (more lenient than codex since there is no server-side schema
enforcement): trim; candidates are evaluated **lazily** in order — the whole text, then each
fenced ```…``` / ```json…``` block, then balanced `{…}` regions scanned **linearly** (after a
captured region the scan continues past its end; nested braces are not rescanned). A candidate
only wins if it parses to a **non-empty** object, so a stray `{}` in prose cannot shadow real
JSON later in the text; if nothing qualifies return
`{parsed:null, rawOutput:text, parseError:"..."}` (non-zero status short-circuits to
failureMessage like codex does).

Additional runtime pins: the win32 spawn uses `shell: process.platform === "win32"` (never
`$SHELL`); while a turn is in flight the runtime installs `SIGTERM`/`SIGINT` handlers that
`terminateProcessTree` the cursor-agent child so a killed companion cannot orphan a running
agent; `getCursorAuthStatus` probes `cursor-agent status --format json` directly and maps
`ENOENT` to not-installed (no extra `--version` spawn).

No interrupt API exists: **cancel = `terminateProcessTree(job.pid)` only** (companion `cancel`
drops the `interruptAppServerTurn` step and its log lines). No thread naming / `thread/list`
fallback exists: resume-last resolution uses tracked jobs only, and when nothing is tracked it
throws `No previous Cursor task chat was found for this repository.`

## 5. Companion surface — `scripts/cursor-companion.mjs`

Same subcommands, flags, `{payload, rendered}`/`--json` convention, alias `C→cwd`, single-string
`"$ARGUMENTS"` tokenization, background `task-worker` spawn, `status --wait` polling — all as
codex. Differences (pinned):

- `setup`: checks `node`, cursor availability (`--version`), auth (`status --format json`),
  review-gate config. **No npm check.** `ready = node && cursor.available && auth.loggedIn`.
  nextSteps: install via curl one-liner; `!cursor-agent login` (mention `CURSOR_API_KEY` as an
  alternative); optional `/cursor:setup --enable-review-gate`. No `sessionRuntime` field
  (broker concept removed everywhere, including render).
- `review`: **prompt-driven** (no native reviewer): `collectReviewContext` → interpolate
  `prompts/review.md` → `runCursorAgentTurn` with `write:false` + schema embedded in the prompt
  (§6) → `parseStructuredOutput` → `renderReviewResult`. Focus text is still rejected with:
  `` `/cursor:review` does not support custom focus text. Retry with `/cursor:adversarial-review <text>` for focused review instructions. ``
  `--scope`/`--base` semantics unchanged.
- `adversarial-review`: as codex but through `prompts/adversarial-review.md` (cursor variant)
  with the schema embedded.
- `task`: flags `[--background] [--write] [--resume-last|--resume|--fresh] [--model <m>]
  [--prompt-file <p>] [--json] [--cwd <d>]` + positional/stdin prompt. **`--effort` is a
  defined valueOption that always throws**:
  `Cursor has no --effort flag. Effort is encoded in the model id (e.g. gpt-5.6-sol-high) or bracket parameters (e.g. --model 'claude-opus-4-8[effort=high]').`
  `MODEL_ALIASES` is empty (no spark). `--write` → `write:true`. Fresh runs have no thread
  naming step. Stop-gate runs (detected via the shared `STOP_REVIEW_TASK_MARKER` exported from
  `lib/tracked-jobs.mjs`) get job `kind: "stop-gate-review"` (label `stop-gate`) and are
  **excluded** from `--resume-last` / `task-resume-candidate`.
- `transfer`: see §7.
- `cancel`: kill process tree + mark cancelled (no turn interrupt).
- `task-resume-candidate`, `status`, `result`, `task-worker`: unchanged logic, except `result`
  and `cancel` distinguish a known-but-wrong-status job id (`Job <id> is still <status>…` /
  `No active job found for "<ref>".`) from a truly unknown reference (`No job found for "<ref>"…`).
- Availability pre-probes: foreground run paths rely on the real spawn's `ENOENT` mapping; only
  the `--background` enqueue path pre-checks `getCursorAvailability` (fail fast instead of
  queuing a doomed job). The queued job record is persisted **before** the detached worker is
  spawned (the worker reads it at startup).

Usage header strings say `cursor-companion.mjs` and omit `--effort`, include no
`adversarial-review` changes otherwise.

## 6. Read-only review context (git.mjs twist)

`resolveReviewTarget` is unchanged. `collectReviewContext` differs because read-only cursor runs
**cannot execute shell commands** (verified) but **can read files**:

- Inline the unified diff whenever total collected content ≤ 256 KiB (drop codex's "≤2 files"
  extra condition — inline is now preferred aggressively). Untracked text files inline up to
  24 KiB each, as codex.
- Over budget → `inputMode: "read-files"`: `content` = `git diff --stat` output + a per-file
  changed-list (status letters + paths) + as many per-file diffs as fit the budget;
  `collectionGuidance` (pinned text): `This run cannot execute shell commands. Use your file read tool to open and inspect the changed files listed below in the current working tree; the diff summary shows what changed in each.`
- Inline mode guidance: `The full diff is included below. You may also use your file read tool to open surrounding context in the current working tree.`

**Schema embedding**: both review prompts gain a `{{OUTPUT_SCHEMA}}` placeholder interpolated
with the raw JSON text of `schemas/review-output.schema.json` (copied unchanged from codex). The
output contract paragraph requires: exactly one JSON object conforming to the schema, no prose
before/after (fences tolerated by the parser). `prompts/review.md` is a straight, thorough
senior-reviewer framing (correctness, security, data-loss, concurrency, tests; findings must be
grounded in the diff); `prompts/adversarial-review.md` keeps the codex adversarial structure with
"Codex" wording neutralized ("You are an adversarial reviewing agent…").

## 7. `/cursor:transfer` — handoff without an importer

Cursor has no external-session import API, so transfer = **create + prime**:

1. `resolveClaudeSessionPath(cwd, {source})` — identical containment rules
   (`~/.claude/projects` realpath check), env `CURSOR_COMPANION_TRANSCRIPT_PATH`.
2. `distillClaudeTranscript(sourcePath)` (in `cursor-session-transfer.mjs`; 48 KiB default
   budget owned by the lib) — mechanical, no model: stream the JSONL, keep `user` and
   `assistant` message text (skip tool calls/results, system, thinking, hook noise), render
   chronological `## User:` / `## Assistant:` markdown; when over budget drop oldest turns first
   and prepend `> (earlier conversation truncated)`.
3. Auth is verified first (`getCursorAuthStatus`; clear error when logged out), then
   `createCursorChat(cwd)` → chatId. If the priming turn fails after the chat exists, the error
   names the chat id and states the chat is unprimed and can be ignored.
4. `runCursorAgentTurn(cwd, {resumeChatId: chatId, write:false, prompt: interpolate(prompts/transfer-handoff.md, {TRANSCRIPT_DIGEST})})` —
   the template instructs: read the handoff, reply with a ≤5-sentence acknowledgment of current
   state and open threads, do not start working until asked.
5. Rendered output (pinned):
   ```
   Transferred the Claude session into a Cursor chat.
   Cursor chat ID: <chatId>
   Resume in Cursor: cursor-agent --resume <chatId>
   ```
   payload `{threadId: chatId, resumeCommand, sourcePath, sessionId, acknowledgment}`.

## 8. Hooks

`hooks/hooks.json`: same three events/timeouts, commands point at
`${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs` / `stop-review-gate-hook.mjs`.

- `session-lifecycle-hook.mjs`: SessionStart appends exports for
  `CURSOR_COMPANION_SESSION_ID`, `CURSOR_COMPANION_TRANSCRIPT_PATH`, `CLAUDE_PLUGIN_DATA` to
  `$CLAUDE_ENV_FILE`. SessionEnd = `cleanupSessionJobs` only (no broker teardown).
- `stop-review-gate-hook.mjs`: same gating on `getConfig().stopReviewGate`, same
  `ALLOW:`/`BLOCK:` first-line contract, same 15-min timeout, spawns
  `cursor-companion.mjs task --json` with the prompt piped via **stdin** (read-only run).
  **New:** because the gate runs read-only (no shell), the hook itself collects working-tree
  context before spawning: `git status --short --untracked-files=all` + `git diff HEAD`, capped
  at 48 KiB total (git buffered at 64 KiB; overflow ends the read early and counts as
  truncation), interpolated into a `{{WORKING_TREE_CONTEXT}}` placeholder added to
  `prompts/stop-review-gate.md` alongside `{{CLAUDE_RESPONSE_BLOCK}}`. If git fails, pass
  `(working tree context unavailable)`. Loop protection: the gate is skipped (stderr note, no
  block) when cursor-agent is missing **or logged out**, and when `input.stop_hook_active` is
  set a gate run that failed to produce an `ALLOW:`/`BLOCK:` verdict does not block again — only
  a genuine `BLOCK:` verdict re-blocks.

## 9. Markdown surface

Commands (8 files, same frontmatter fields & structure as codex, renamed invocations
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" <sub> "$ARGUMENTS"`):
- `review.md` / `adversarial-review.md`: same wait/background/AskUserQuestion logic, description
  strings `Cursor review` / `Cursor adversarial review`, status hints `/cursor:status`. Note in
  body: reviews run read-only via Cursor's plan mode.
- `rescue.md`: Agent tool with `subagent_type: "cursor:cursor-rescue"`; resume detection via
  `task-resume-candidate --json`; `--model` passthrough; **no spark alias; no --effort** — if the
  user asks for a specific effort, fold it into the model id/bracket per the runtime skill.
- `setup.md`: runs `setup --json $ARGUMENTS`; if cursor missing, do NOT auto-install — print the
  curl one-liner and suggest running it via `!curl https://cursor.com/install -fsS | bash`; if
  logged out suggest `!cursor-agent login`.
- `status.md` / `result.md` / `cancel.md` / `transfer.md`: inline backtick execution, verbatim
  output rules, `cursor-agent --resume <chat-id>` preserved.

Agent `agents/cursor-rescue.md`: frontmatter `name: cursor-rescue`, `model: sonnet`,
`tools: Bash`, `skills: [cursor-cli-runtime, cursor-prompting]`; same thin-forwarder contract
(one `task` call, stdout verbatim, `--resume`→`--resume-last`, `--fresh`, `--write` default,
strip `--background`/`--wait`).

Skills (all `user-invocable: false`):
- `cursor-cli-runtime/SKILL.md`: task-only contract; effort rule: *never pass `--effort`; if the
  user explicitly requested an effort level and named a parameterized model, use bracket syntax
  in `--model`; if they requested effort without a model, choose the matching model-id variant
  only when one obviously exists, otherwise omit.*
- `cursor-result-handling/SKILL.md`: port with renames (STOP-after-findings rule intact).
- `cursor-prompting/SKILL.md` (+ `references/prompt-blocks.md`, `references/prompt-recipes.md`,
  `references/prompt-antipatterns.md`): port of gpt-5-4-prompting reframed for "the Cursor
  agent" (model-agnostic — Cursor routes to many models); keep the XML block library, recipes,
  and antipatterns; drop GPT-version-specific claims.

## 10. Manifests, versioning, docs

- `plugins/cursor/.claude-plugin/plugin.json`: `{"name":"cursor","version":"1.0.5","description":"Use Cursor Agent from Claude Code to review code or delegate tasks.","author":{"name":"tekierz"}}`
- `.claude-plugin/marketplace.json`: `name` → `cursor-cli`, `owner` → `{"name":"tekierz"}`,
  `metadata.description` → covers both plugins; `plugins` array keeps the codex entry unchanged
  and adds the cursor entry (`"source": "./plugins/cursor"`).
- root `package.json`: `name` → `cursor-cli-plugin-cc`, description updated; keep codex
  `prebuild`/`build` scripts untouched; `test` glob already covers new `tests/*.test.mjs` files.
- `scripts/bump-version.mjs`: generalize to sync `package.json`, `package-lock.json`, **both**
  plugin.jsons, and **all** marketplace plugin entries + `metadata.version` (replace the
  hardcoded `name === "codex"` lookup with a loop). Keep `--check`.
- `plugins/cursor/LICENSE` + `NOTICE`: Apache-2.0; NOTICE states the plugin is a derivative of
  OpenAI's codex-plugin-cc adapted for Cursor CLI.
- Root `README.md`: rewritten for the dual-plugin marketplace (install:
  `/plugin marketplace add tekierz/cursor-cli-plugin-cc`, `/plugin install cursor@cursor-cli`),
  full `/cursor:*` usage docs mirroring the codex sections, requirements (Cursor
  subscription/API key, Node ≥18.18, cursor-agent installed), a "differences from the codex
  plugin" section (read-only = plan mode, no --effort, transfer = create+prime, cancel kills the
  process), and a pointer that `/codex:*` remains available from `openai/codex-plugin-cc`.

## 11. Tests

- `tests/fake-cursor-agent-fixture.mjs`: `installFakeCursorAgent(binDir, behavior)` writes an
  executable `cursor-agent` Node script (+ `.cmd` shim on win32) implementing: `--version`;
  `status --format json` (authenticated vs `logged-out` behavior, exit codes); `create-chat`
  (fixed uuid `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`); `-p` runs that read the prompt from
  stdin and emit stream-json init/assistant/result lines. Behaviors: `task-ok` (default),
  `review-ok` (emits a schema-valid review JSON), `adversarial-clean`, `run-fails`
  (`is_error:true` + exit 1), `no-result-event` (exit 1, no result line), `slow-task`
  (sleeps in a loop so cancel tests can kill it), `logged-out`. Every invocation appends
  `{argv, stdinPrompt}` to `fake-cursor-state.json` in binDir so tests can assert flags
  (`--mode plan` vs `--force`, `--resume <id>`, `--model`, stdin content).
- `tests/cursor-runtime.test.mjs`: end-to-end through
  `plugins/cursor/scripts/cursor-companion.mjs` — setup ready/logged-out/missing-binary; review
  renders findings from structured JSON and rejects focus text; adversarial passes focus text;
  task foreground write vs read-only flag assertions; `--effort` error; resume-last uses tracked
  threadId; fresh vs resume conflict; background task → status --wait → result; cancel kills the
  slow task; transfer (create-chat then primed `--resume`, rendered chat id + resume command);
  stop-gate hook ALLOW/BLOCK/unavailable; session lifecycle env exports; `--json` payloads.
- `tests/cursor-commands.test.mjs`: pins the markdown/agent/skill/hook files (exact companion
  invocation strings, flag lists, verbatim-output rules, agent frontmatter, hooks.json wiring) —
  mirror of `commands.test.mjs`.
- Existing codex tests remain untouched and must stay green. CI workflow unchanged.
