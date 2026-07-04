#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCursorAuthStatus, getCursorAvailability } from "./lib/cursor.mjs";
import { truncateUtf8Bytes } from "./lib/fs.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { runCommand } from "./lib/process.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const WORKING_TREE_CONTEXT_MAX_BYTES = 48 * 1024;
// Only 48KiB of context survives truncation; cap git's output just above that
// so oversized diffs terminate early via ENOBUFS instead of buffering megabytes.
const GIT_OUTPUT_MAX_BUFFER = WORKING_TREE_CONTEXT_MAX_BYTES + 16 * 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const WORKING_TREE_CONTEXT_UNAVAILABLE = "(working tree context unavailable)";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function readGitOutput(cwd, args) {
  const result = runCommand("git", args, { cwd, maxBuffer: GIT_OUTPUT_MAX_BUFFER });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return { text: result.stdout ?? "", truncated: true };
  }
  if (result.error || result.status !== 0) {
    return null;
  }
  return { text: result.stdout, truncated: false };
}

function collectWorkingTreeContext(cwd) {
  let status;
  let diff;
  try {
    status = readGitOutput(cwd, ["status", "--short", "--untracked-files=all"]);
    diff = readGitOutput(cwd, ["diff", "HEAD"]);
  } catch {
    return WORKING_TREE_CONTEXT_UNAVAILABLE;
  }
  if (!status || !diff) {
    return WORKING_TREE_CONTEXT_UNAVAILABLE;
  }

  const combined = [
    "Working tree status (git status --short --untracked-files=all):",
    status.text.trimEnd() || "(clean)",
    "",
    "Diff against HEAD (git diff HEAD):",
    diff.text.trimEnd() || "(no diff)"
  ].join("\n");
  const capped = truncateUtf8Bytes(combined, WORKING_TREE_CONTEXT_MAX_BYTES);
  if (capped.truncated || status.truncated || diff.truncated) {
    return `${capped.text}\n\n(working tree context truncated at 48 KiB)`;
  }
  return capped.text;
}

function buildStopReviewPrompt(cwd, input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock,
    WORKING_TREE_CONTEXT: collectWorkingTreeContext(cwd)
  });
}

async function buildSetupNote(cwd) {
  const availability = getCursorAvailability(cwd);
  if (!availability.available) {
    const detail = availability.detail ? ` ${availability.detail}.` : "";
    return `Cursor is not set up for the review gate.${detail} Run /cursor:setup.`;
  }

  const auth = await getCursorAuthStatus(cwd);
  if (!auth.loggedIn) {
    const detail = auth.detail ? ` (${auth.detail})` : "";
    return `Cursor is not logged in, so the review gate was skipped${detail}. Run \`!cursor-agent login\` or /cursor:setup.`;
  }

  return null;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      blockVerdict: false,
      reason:
        "The stop-time Cursor review task returned no final output. Run /cursor:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, blockVerdict: false, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      blockVerdict: true,
      reason: `Cursor stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    blockVerdict: false,
    reason:
      "The stop-time Cursor review task returned an unexpected answer. Run /cursor:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "cursor-companion.mjs");
  const prompt = buildStopReviewPrompt(cwd, input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  // The prompt embeds up to 48KiB of working-tree context; pipe it via stdin
  // (the companion falls back to piped stdin when no positional prompt is
  // given) so large diffs cannot exceed OS argv limits.
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json"], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    input: prompt,
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      blockVerdict: false,
      reason:
        "The stop-time Cursor review task timed out after 15 minutes. Run /cursor:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      blockVerdict: false,
      reason: detail
        ? `The stop-time Cursor review task failed: ${detail}`
        : "The stop-time Cursor review task failed. Run /cursor:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      blockVerdict: false,
      reason:
        "The stop-time Cursor review task returned invalid JSON. Run /cursor:review --wait manually or bypass the gate."
    };
  }
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const stopHookActive = Boolean(input.stop_hook_active);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Cursor task ${runningJob.id} is still running. Check /cursor:status and use /cursor:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = await buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    // A genuine BLOCK verdict keeps blocking (the iterative review loop is
    // intended), but when the gate itself failed to produce a verdict, do not
    // block a stop that a previous stop hook already blocked — that would
    // loop the session forever on a broken gate.
    if (!review.blockVerdict && stopHookActive) {
      logNote(`Stop-gate review could not produce a verdict; not blocking again. ${review.reason}`);
      logNote(runningTaskNote);
      return;
    }
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
