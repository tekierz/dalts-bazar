# tikiLabMarket

tekierz's Claude Code plugin & skill marketplace — a home for plugins and skills worth sharing:
CLI delegation, design languages, and whatever comes next.

Add the marketplace once and every plugin here is an install away:

```bash
/plugin marketplace add tekierz/tikiLabMarket
```

## Plugins

| Plugin | What it does | Install |
|--------|--------------|---------|
| **cursor** | Use the Cursor CLI (`cursor-agent`) from Claude Code for reviews and task delegation ([docs below](#the-cursor-plugin)) | `/plugin install cursor@tikiLabMarket` |
| **codex** | Use Codex from Claude Code for reviews and task delegation ([docs below](#the-codex-plugin)) | `/plugin install codex@tikiLabMarket` |
| **cyber-deck-ui** | Cyber-deck design language skill — cyberpunk / retro-future / CRT / EVA instrument-panel UI ([repo](https://github.com/tekierz/cyber-deck-ui)) | `/plugin install cyber-deck-ui@tikiLabMarket` |

After installing any plugin, reload:

```bash
/reload-plugins
```

---

# The Cursor Plugin

Use the Cursor CLI (`cursor-agent`) from inside Claude Code for code reviews or to delegate tasks
to the Cursor agent.

This plugin is for Claude Code users who want an easy way to hand work to Cursor from the workflow
they already have. It is a port of OpenAI's [Codex plugin](https://github.com/openai/codex-plugin-cc)
adapted to the Cursor CLI; this marketplace ships both plugins, so `/codex:*` stays available here
too (see [The Codex Plugin](#the-codex-plugin)).

## What You Get

- `/cursor:review` for a normal read-only Cursor review
- `/cursor:adversarial-review` for a steerable challenge review
- `/cursor:rescue`, `/cursor:transfer`, `/cursor:status`, `/cursor:result`, and `/cursor:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **Cursor subscription or Cursor API key.**
  - Usage will contribute to your Cursor usage limits.
- **Node.js 18.18 or later**
- **The Cursor CLI (`cursor-agent`)** installed on your machine:

  ```bash
  curl https://cursor.com/install -fsS | bash
  ```

## Install

Add the marketplace in Claude Code (if you haven't already):

```bash
/plugin marketplace add tekierz/tikiLabMarket
```

Install the plugin:

```bash
/plugin install cursor@tikiLabMarket
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/cursor:setup
```

`/cursor:setup` will tell you whether the Cursor CLI is ready. It does not install anything for
you; if `cursor-agent` is missing, it prints the curl one-liner above so you can run it yourself.

If the Cursor CLI is installed but not logged in yet, run:

```bash
!cursor-agent login
```

or set `CURSOR_API_KEY` in your environment.

After install, you should see:

- the slash commands listed below
- the `cursor:cursor-rescue` subagent in `/agents`

One simple first run is:

```bash
/cursor:review --background
/cursor:status
/cursor:result
```

## Usage

### `/cursor:review`

Runs a normal Cursor review on your current work.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/cursor:adversarial-review`](#cursoradversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/cursor:review
/cursor:review --base main
/cursor:review --background
```

This command is read-only and will not perform any changes: it runs in Cursor's plan mode, which
cannot execute shell commands, so the plugin collects the diff itself and the reviewer works from
that plus file reads. When run in the background you can use [`/cursor:status`](#cursorstatus) to
check on the progress and [`/cursor:cancel`](#cursorcancel) to cancel the ongoing task.

### `/cursor:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/cursor:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/cursor:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/cursor:adversarial-review
/cursor:adversarial-review --base main challenge whether this was the right caching and retry design
/cursor:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/cursor:rescue`

Hands a task to the Cursor agent through the `cursor:cursor-rescue` subagent.

Use it when you want Cursor to:

- investigate a bug
- try a fix
- continue a previous Cursor task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue chat for this repo.

Examples:

```bash
/cursor:rescue investigate why the tests started failing
/cursor:rescue fix the failing test with the smallest safe patch
/cursor:rescue --resume apply the top fix from the last run
/cursor:rescue --model gpt-5.6-sol-high investigate the flaky integration test
/cursor:rescue --model 'claude-opus-4-8[effort=high]' redesign the retry logic
/cursor:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Cursor:

```text
Ask Cursor to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model`, your Cursor account's default model is used.
- there is no `--effort` flag. Effort is encoded in the model id (e.g. `gpt-5.6-sol-high`) or in bracket parameters (e.g. `--model 'claude-opus-4-8[effort=high]'`). Run `cursor-agent models` to see what's available.
- the gpt-5.6 series comes in three flavors — `gpt-5.6-sol-*`, `gpt-5.6-terra-*`, `gpt-5.6-luna-*` — each with effort tiers `none`/`low`/`medium`/`high`/`xhigh`/`max` and `-fast` variants (e.g. `gpt-5.6-luna-max`, `gpt-5.6-terra-xhigh-fast`).
- some models are gated behind Cursor's **Max Mode** (currently the gpt-5.6/gpt-5.5/gpt-5.4 families, grok-4.5, and the claude-* tiers). Without Max Mode those runs fail at turn start with `Max Mode Required` — the plugin appends a hint when this happens. `cursor-agent models` lists gated models without marking them; models that run everywhere include `gpt-5.3-codex-*`, `gpt-5.2-codex-*`, `gpt-5.1-codex-max-*`, and `composer-2.5*`.
- follow-up rescue requests can continue the latest Cursor chat in the repo

### `/cursor:transfer`

Creates a new Cursor chat primed with the current Claude Code session and prints a `cursor-agent --resume <chat-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in the Cursor CLI.

Examples:

```bash
/cursor:transfer
/cursor:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override, and the source must be under `~/.claude/projects`. Cursor has no session importer, so the plugin distills your Claude transcript into a compact handoff digest, creates a fresh chat, and primes it with that digest in one read-only turn. The Cursor agent acknowledges the current state and open threads, then waits for you in `cursor-agent --resume <chat-id>`.

### `/cursor:status`

Shows running and recent Cursor jobs for the current repository.

Examples:

```bash
/cursor:status
/cursor:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/cursor:result`

Shows the final stored Cursor output for a finished job.
When available, it also includes the Cursor chat ID so you can reopen that run directly in the Cursor CLI with `cursor-agent --resume <chat-id>`.

Examples:

```bash
/cursor:result
/cursor:result task-abc123
```

### `/cursor:cancel`

Cancels an active background Cursor job by terminating its `cursor-agent` process.

Examples:

```bash
/cursor:cancel
/cursor:cancel task-abc123
```

### `/cursor:setup`

Checks whether the Cursor CLI is installed and authenticated.
It does not auto-install; if `cursor-agent` is missing it prints the install one-liner, and if you are logged out it suggests `!cursor-agent login` (or `CURSOR_API_KEY`).

You can also use `/cursor:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/cursor:setup --enable-review-gate
/cursor:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Cursor review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Cursor loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/cursor:review
```

### Hand A Problem To Cursor

```bash
/cursor:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/cursor:adversarial-review --background
/cursor:rescue --background investigate the flaky test
```

Then check in with:

```bash
/cursor:status
/cursor:result
```

## Differences From The Codex Plugin

If you are coming from `/codex:*`, the surface is the same but the runtime is simpler — one-shot
headless `cursor-agent` processes instead of a persistent app server. The differences that matter:

- **Read-only means plan mode.** Reviews and other read-only runs use Cursor's plan mode, which rejects all shell commands. The plugin gathers the git diff itself and hands it to the reviewer, which can still read files in your working tree.
- **No `--effort` flag.** The Cursor CLI encodes effort in model ids (`gpt-5.6-sol-high`) or bracket parameters (`--model 'claude-opus-4-8[effort=high]'`). Passing `--effort` to `/cursor:rescue` is an error that tells you exactly this. There is also no `spark` model alias.
- **Transfer is create + prime.** Cursor has no external-session importer, so `/cursor:transfer` creates a new chat and primes it with a distilled transcript digest rather than importing turns natively.
- **Cancel kills the process.** There is no turn-interrupt API; `/cursor:cancel` terminates the job's `cursor-agent` process tree.

## Cursor Integration

The plugin delegates through the local `cursor-agent` binary — the same install, authentication
state, repository checkout, and configuration you would use running the Cursor CLI directly.

### Common Configurations

- **User-level CLI config** lives in `~/.cursor/cli-config.json` (default model and other CLI settings).
- **Project permissions** live in `.cursor/cli.json`, where you can allow or deny specific tools and commands for agent runs in that project.
- **Rules and context**: `cursor-agent` reads `.cursor/rules`, `AGENTS.md`, and `CLAUDE.md` from your project, so the instructions you already maintain apply to delegated runs too.

Check out the [Cursor CLI docs](https://cursor.com/docs/cli) for more configuration options.

### Moving The Work Over To Cursor

Delegated tasks and any [stop gate](#enabling-review-gate) run can be resumed inside the Cursor CLI by running `cursor-agent --resume <chat-id>` with the chat ID you received from `/cursor:result` or `/cursor:status`.

This way you can review the Cursor work or continue the work there.

## The Codex Plugin

The original Codex plugin remains available, unchanged, in two places:

- from this marketplace: `/plugin install codex@tikiLabMarket`
- from upstream: `/plugin marketplace add openai/codex-plugin-cc`

Its source lives in [`plugins/codex`](./plugins/codex) and is fully documented in the
[upstream README](https://github.com/openai/codex-plugin-cc). The short version:

### `/codex:review`

Runs a normal Codex review on your current work through Codex's built-in reviewer. Use
`--base <ref>` for branch review; it also supports `--wait` and `--background`. It is not
steerable and does not take custom focus text.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.
It uses the same review target selection as `/codex:review`, including `--base <ref>`,
and can take extra focus text after the flags:

```bash
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
```

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent — investigate a bug, try a fix, or
continue a previous Codex task. It supports `--background`, `--wait`, `--resume`, and `--fresh`:

```bash
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a
`codex resume <session-id>` command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

### `/codex:result`

Shows the final stored Codex output for a finished job, including the Codex session ID.

### `/codex:cancel`

Cancels an active background Codex job.

### `/codex:setup`

Checks whether Codex is installed and authenticated. If Codex is missing and npm is available, it
can offer to install Codex for you; if Codex is installed but not logged in, run `!codex login`.
It also manages Codex's optional stop-time review gate:

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

## FAQ

### Do I need a separate Cursor account for this plugin?

If you are already signed into the Cursor CLI on this machine, that account works immediately here too. This plugin uses your local `cursor-agent` authentication — sign in with `cursor-agent login`, or set `CURSOR_API_KEY` for API-key auth. Run `/cursor:setup` to check whether Cursor is ready.

### Does the plugin use a separate Cursor runtime?

No. This plugin runs your local `cursor-agent` binary headlessly on the same machine.

That means:

- it uses the same Cursor CLI install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Cursor config I already have?

Yes. The plugin picks up your `~/.cursor/cli-config.json`, your project's `.cursor/cli.json` permissions, and the `.cursor/rules`, `AGENTS.md`, and `CLAUDE.md` files `cursor-agent` already reads.

### Can I keep using both plugins side by side?

Yes. The commands live in separate namespaces (`/cursor:*` and `/codex:*`) and track their jobs separately, so installing both from this marketplace is fine.
