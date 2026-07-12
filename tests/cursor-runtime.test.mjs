import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildEnv,
  FAKE_CREATE_CHAT_ID,
  FAKE_CURSOR_VERSION,
  FAKE_RUN_CHAT_ID,
  installFakeCursorAgent,
  readFakeCursorState
} from "./fake-cursor-agent-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/cursor/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "cursor");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "cursor-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

const BASE_RUN_ARGV = ["-p", "--output-format", "stream-json", "--trust"];

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function lastCursorRun(binDir) {
  const runs = readFakeCursorState(binDir).invocations.filter((invocation) => invocation.argv.includes("-p"));
  return runs.at(-1) ?? null;
}

function makeRepoWithCommit() {
  const repo = makeTempDir("cursor-plugin-test-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function makeDirtyReviewRepo() {
  const repo = makeTempDir("cursor-plugin-test-");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  return repo;
}

test("setup reports ready when the fake cursor-agent is installed and authenticated", () => {
  const binDir = makeTempDir("cursor-plugin-test-");
  const workspace = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.cursor.available, true);
  assert.equal(payload.cursor.version, FAKE_CURSOR_VERSION);
  assert.match(payload.cursor.detail, /cursor-agent 2026\.07\.01-fake/);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.email, "test@example.com");
  assert.equal("npm" in payload, false);
  assert.equal("sessionRuntime" in payload, false);
});

test("setup reports logged-out auth with login next steps", () => {
  const binDir = makeTempDir("cursor-plugin-test-");
  const workspace = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "logged-out");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.cursor.available, true);
  assert.equal(payload.auth.loggedIn, false);
  const nextSteps = payload.nextSteps.join("\n");
  assert.match(nextSteps, /!cursor-agent login/);
  assert.match(nextSteps, /CURSOR_API_KEY/);
});

test("setup reports the curl install hint when cursor-agent is missing", () => {
  const binDir = makeTempDir("cursor-plugin-test-");
  const workspace = makeTempDir("cursor-plugin-test-");
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.node.available, true);
  assert.equal(payload.cursor.available, false);
  assert.match(payload.nextSteps.join("\n"), /curl https:\/\/cursor\.com\/install -fsS \| bash/);
});

test("review renders structured findings from a read-only plan-mode run", () => {
  const repo = makeDirtyReviewRepo();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "review-ok");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Cursor Review/);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /\[high\] Missing empty-state guard \(src\/app\.js:4-6\)/);
  assert.match(result.stdout, /Recommendation: Handle empty collections before indexing\./);
  assert.match(result.stdout, /Next steps:/);
  assert.match(result.stdout, /Add an empty-state test\./);

  const invocation = lastCursorRun(binDir);
  assert.deepEqual(invocation.argv, [...BASE_RUN_ARGV, "--mode", "plan"]);
  assert.match(invocation.stdinPrompt, /Output exactly one JSON object/);
  assert.match(invocation.stdinPrompt, /"\$schema"/);
  assert.match(invocation.stdinPrompt, /The full diff is included below/);
  assert.match(invocation.stdinPrompt, /export const value = 2;/);
});

test("review --json returns the structured payload with chat id and usage", () => {
  const repo = makeDirtyReviewRepo();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "review-ok");

  const result = run("node", [SCRIPT, "review", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Review");
  assert.equal(payload.threadId, FAKE_RUN_CHAT_ID);
  assert.equal(payload.cursor.status, 0);
  assert.equal(payload.result.verdict, "needs-attention");
  assert.equal(payload.result.findings.length, 1);
  assert.equal(payload.result.findings[0].title, "Missing empty-state guard");
  assert.equal(payload.parseError, null);
  assert.equal(payload.usage.inputTokens, 128);
  assert.equal(payload.durationMs, 42);
});

test("review rejects custom focus text and points at adversarial review", () => {
  const repo = makeDirtyReviewRepo();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "review-ok");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /`\/cursor:review` does not support custom focus text\./);
  assert.match(result.stderr, /Retry with `\/cursor:adversarial-review focus on auth` for focused review instructions\./);
  assert.equal(lastCursorRun(binDir), null);
});

test("adversarial review passes focus text through to the prompt", () => {
  const repo = makeDirtyReviewRepo();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "review-ok");

  const result = run("node", [SCRIPT, "adversarial-review", "focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Cursor Adversarial Review/);
  assert.match(result.stdout, /Missing empty-state guard/);

  const invocation = lastCursorRun(binDir);
  assert.deepEqual(invocation.argv, [...BASE_RUN_ARGV, "--mode", "plan"]);
  assert.match(invocation.stdinPrompt, /adversarial software review/);
  assert.match(invocation.stdinPrompt, /User focus: focus on auth/);
  assert.match(invocation.stdinPrompt, /"\$schema"/);
});

test("adversarial review renders a clean approval when no findings surface", () => {
  const repo = makeDirtyReviewRepo();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "adversarial-clean");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material findings\./);
});

test("task --write runs cursor-agent with --force and pipes the prompt via stdin", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "--write", "--model", "gpt-5.6-sol-high", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");

  const invocation = lastCursorRun(binDir);
  assert.deepEqual(invocation.argv, [...BASE_RUN_ARGV, "--force", "--model", "gpt-5.6-sol-high"]);
  assert.equal(invocation.stdinPrompt, "fix the failing test");
});

test("task defaults to a read-only plan-mode run", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "investigate the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");

  const invocation = lastCursorRun(binDir);
  assert.deepEqual(invocation.argv, [...BASE_RUN_ARGV, "--mode", "plan"]);
  assert.equal(invocation.stdinPrompt, "investigate the flaky test");
});

test("task rejects --effort with model-id guidance", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr.includes(
      "Cursor has no --effort flag. Effort is encoded in the model id (e.g. gpt-5.6-sol-high) or bracket parameters (e.g. --model 'claude-opus-4-8[effort=high]')."
    ),
    true,
    result.stderr
  );
  assert.equal(lastCursorRun(binDir), null);
});

test("task --resume-last resumes the tracked cursor chat", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");

  const invocation = lastCursorRun(binDir);
  assert.deepEqual(invocation.argv, [...BASE_RUN_ARGV, "--mode", "plan", "--resume", FAKE_RUN_CHAT_ID]);
  assert.equal(invocation.stdinPrompt, "follow up");
});

test("task --resume-last fails when no task chat is tracked for the repository", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No previous Cursor task chat was found for this repository\./);
  assert.equal(lastCursorRun(binDir), null);
});

test("task rejects --resume-last combined with --fresh", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "--resume-last", "--fresh", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes("Choose either --resume/--resume-last or --fresh."), true, result.stderr);
  assert.equal(lastCursorRun(binDir), null);
});

test("task reports a failed run when cursor-agent returns an error result", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "run-fails");

  const result = run("node", [SCRIPT, "task", "--json", "break something"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 1);
  assert.match(payload.rawOutput, /The run failed before completing the task\./);
});

test("task appends an actionable hint when the model requires Max Mode", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "max-mode-required");

  const result = run("node", [SCRIPT, "task", "--model", "gpt-5.6-sol-high", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ActionRequiredError: Max Mode Required/);
  assert.match(result.stdout, /this Cursor account does not have Max Mode enabled/);
  assert.match(result.stdout, /gpt-5\.3-codex-high or composer-2\.5/);

  const jsonResult = run("node", [SCRIPT, "task", "--json", "--model", "gpt-5.6-sol-high", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(jsonResult.status, 1);
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.maxModeRequired, true);
});

test("task surfaces stderr when cursor-agent exits without a result event", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "no-result-event");

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /fake cursor-agent crashed before returning a result/);
});

test("task --background enqueues a worker and completes via status --wait and result", async () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");
  assert.equal(waitedPayload.waitTimedOut, false);

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.equal(resultPayload.storedJob.threadId, FAKE_RUN_CHAT_ID);
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);

  const rendered = run("node", [SCRIPT, "result", launchPayload.jobId], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(
    rendered.stdout,
    `Handled the requested task.\nTask prompt accepted.\n\nCursor chat ID: ${FAKE_RUN_CHAT_ID}\nResume in Cursor: cursor-agent --resume ${FAKE_RUN_CHAT_ID}\n`
  );
});

test("cancel kills a slow background task and marks it cancelled", async (t) => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "slow-task");

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the slow path"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.pid) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  t.after(() => {
    try {
      process.kill(-runningJob.pid, "SIGTERM");
    } catch {
      try {
        process.kill(runningJob.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.jobId, jobId);
  assert.equal(cancelPayload.status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(runningJob.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);
  assert.match(fs.readFileSync(cancelled.logFile, "utf8"), /Cancelled by user\./);
});

test("transfer creates a cursor chat and primes it with the distilled transcript", () => {
  const home = makeTempDir("cursor-plugin-test-");
  const repo = path.join(home, "repo");
  const binDir = makeTempDir("cursor-plugin-test-");
  const sessionId = "sess-cursor-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCursorAgent(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/cursor:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    HOME: home,
    CURSOR_COMPANION_TRANSCRIPT_PATH: sourcePath
  };

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.threadId, FAKE_CREATE_CHAT_ID);
  assert.equal(payload.resumeCommand, `cursor-agent --resume ${FAKE_CREATE_CHAT_ID}`);
  assert.equal(payload.sourcePath, fs.realpathSync(sourcePath));
  assert.equal(payload.sessionId, sessionId);
  assert.match(payload.acknowledgment, /Handoff acknowledged/);

  const fakeState = readFakeCursorState(binDir);
  assert.equal(fakeState.invocations.some((invocation) => invocation.argv[0] === "create-chat"), true);
  const invocation = lastCursorRun(binDir);
  assert.deepEqual(invocation.argv, [...BASE_RUN_ARGV, "--mode", "plan", "--resume", FAKE_CREATE_CHAT_ID]);
  assert.match(invocation.stdinPrompt, /<handoff_digest>/);
  assert.match(invocation.stdinPrompt, /## User:\n\nInitial request/);
  assert.match(invocation.stdinPrompt, /## Assistant:\n\nInitial answer/);

  const rendered = run("node", [SCRIPT, "transfer"], {
    cwd: repo,
    env
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(
    rendered.stdout,
    `Transferred the Claude session into a Cursor chat.\nCursor chat ID: ${FAKE_CREATE_CHAT_ID}\nResume in Cursor: cursor-agent --resume ${FAKE_CREATE_CHAT_ID}\n`
  );
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir("cursor-plugin-test-");
  const repo = path.join(home, "repo");
  const binDir = makeTempDir("cursor-plugin-test-");
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCursorAgent(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
  assert.equal(lastCursorRun(binDir), null);
});

test("stop hook blocks on findings when the review gate is enabled", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).reviewGateEnabled, true);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Cursor stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const invocation = lastCursorRun(binDir);
  assert.deepEqual(invocation.argv, [...BASE_RUN_ARGV, "--mode", "plan"]);
  assert.match(invocation.stdinPrompt, /<task>/);
  assert.match(invocation.stdinPrompt, /Only review the work from the previous Claude turn/);
  assert.match(invocation.stdinPrompt, /I completed the refactor and updated the retry logic\./);
  assert.match(invocation.stdinPrompt, /<working_tree_context>/);
  assert.match(invocation.stdinPrompt, /Working tree status \(git status --short --untracked-files=all\):/);
  assert.match(invocation.stdinPrompt, /README\.md/);
  assert.match(invocation.stdinPrompt, /<compact_output_contract>/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CURSOR_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Cursor Stop Gate Review/);
});

test("stop hook allows the stop when the stop-gate review is clean", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "stop-gate-allow");

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop-gate reviews are excluded from resume-last and the resume candidate", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);
  const sessionId = "sess-gate-resume";

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: sessionId, last_assistant_message: "Refactor done." })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");

  const sessionEnv = { ...buildEnv(binDir), CURSOR_COMPANION_SESSION_ID: sessionId };
  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: sessionEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "continue"], {
    cwd: repo,
    env: sessionEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Cursor task chat was found for this repository\./);
});

test("stop hook does not re-block a failing gate when stop_hook_active is set", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "no-result-event");

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const firstStop = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-gate-loop" })
  });
  assert.equal(firstStop.status, 0, firstStop.stderr);
  assert.equal(JSON.parse(firstStop.stdout).decision, "block");

  const secondStop = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-gate-loop", stop_hook_active: true })
  });
  assert.equal(secondStop.status, 0, secondStop.stderr);
  assert.equal(secondStop.stdout.trim(), "");
  assert.match(secondStop.stderr, /could not produce a verdict; not blocking again/i);
});

test("stop hook skips the gate when cursor-agent is logged out", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "logged-out");

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /not logged in, so the review gate was skipped/i);
});

test("result and cancel give status-specific guidance for known job ids", async (t) => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "slow-task");

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the slow path"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.pid ? job : null;
  }, { timeoutMs: 15000 });

  t.after(() => {
    try {
      process.kill(-runningJob.pid, "SIGTERM");
    } catch {
      try {
        process.kill(runningJob.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const stillRunning = run("node", [SCRIPT, "result", jobId], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.notEqual(stillRunning.status, 0);
  assert.match(stillRunning.stderr, new RegExp(`Job ${jobId} is still (queued|running)\\.`));

  const unknown = run("node", [SCRIPT, "result", "task-does-not-exist"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /No job found for "task-does-not-exist"\./);

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);

  const cancelAgain = run("node", [SCRIPT, "cancel", jobId], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.notEqual(cancelAgain.status, 0);
  assert.match(cancelAgain.stderr, new RegExp(`No active job found for "${jobId}"\\.`));
});

test("parseStructuredOutput skips empty junk objects and finds the real JSON", async () => {
  const { parseStructuredOutput } = await import("../plugins/cursor/scripts/lib/cursor.mjs");

  const shadowed = parseStructuredOutput(
    'I validated the config {} against the schema.\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}'
  );
  assert.equal(shadowed.parseError, null);
  assert.equal(shadowed.parsed?.verdict, "approve");

  const none = parseStructuredOutput("just prose with {} empty braces");
  assert.equal(none.parsed, null);
  assert.match(none.parseError, /Could not find a JSON object/);
});

test("stop hook does not block when cursor-agent is unavailable even with the gate enabled", () => {
  const repo = makeRepoWithCommit();

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    }
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).reviewGateEnabled, true);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Cursor is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/cursor:setup/i);
});

test("session start hook exports the session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir("cursor-plugin-test-");
  const envFile = path.join(makeTempDir("cursor-plugin-test-"), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir("cursor-plugin-test-");
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CURSOR_COMPANION_SESSION_ID='sess-current'\nexport CURSOR_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CURSOR_COMPANION_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("state dir prefers CURSOR_COMPANION_PLUGIN_DATA over a foreign CLAUDE_PLUGIN_DATA", () => {
  const repo = makeRepoWithCommit();
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir);
  const cursorDataDir = makeTempDir("cursor-plugin-test-");
  const foreignDataDir = makeTempDir("cursor-plugin-test-");

  const result = run("node", [SCRIPT, "task", "--json", "fix the failing test"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CURSOR_COMPANION_PLUGIN_DATA: cursorDataDir,
      CLAUDE_PLUGIN_DATA: foreignDataDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const cursorStateEntries = fs.readdirSync(path.join(cursorDataDir, "state"));
  assert.equal(cursorStateEntries.length, 1);
  assert.equal(fs.existsSync(path.join(foreignDataDir, "state")), false);
});

test("session end cleans up jobs for the ending session only", async (t) => {
  const repo = makeRepoWithCommit();

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "task-completed.json");
  const runningJobFile = path.join(jobsDir, "task-running.json");
  const otherJobFile = path.join(jobsDir, "task-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "task-completed" }, null, 2), "utf8");
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "task-running" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "task-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-completed",
            status: "completed",
            title: "Cursor Task",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "task-running",
            status: "running",
            title: "Cursor Task",
            sessionId: "sess-current",
            pid: sleeper.pid,
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "task-other",
            status: "completed",
            title: "Cursor Task",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CURSOR_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    [path.basename(otherJobFile), path.basename(otherSessionLog)].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["task-other"]);
});
