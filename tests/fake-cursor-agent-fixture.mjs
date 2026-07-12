import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export const FAKE_CURSOR_VERSION = "2026.07.01-fake";
export const FAKE_CREATE_CHAT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const FAKE_RUN_CHAT_ID = "11111111-2222-3333-4444-555555555555";

export function installFakeCursorAgent(binDir, behavior = "task-ok") {
  const statePath = path.join(binDir, "fake-cursor-state.json");
  const scriptPath = path.join(binDir, "cursor-agent");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const VERSION = ${JSON.stringify(FAKE_CURSOR_VERSION)};
const CREATE_CHAT_ID = ${JSON.stringify(FAKE_CREATE_CHAT_ID)};
const RUN_CHAT_ID = ${JSON.stringify(FAKE_RUN_CHAT_ID)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { invocations: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (parsed && Array.isArray(parsed.invocations)) {
      return parsed;
    }
  } catch {
    // Fall through to a fresh state.
  }
  return { invocations: [] };
}

function recordInvocation(argv, stdinPrompt) {
  const state = loadState();
  state.invocations.push({ argv, stdinPrompt });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function send(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

const args = process.argv.slice(2);

if (args[0] === "--version") {
  recordInvocation(args, null);
  console.log(VERSION);
  process.exit(0);
}

if (args[0] === "status") {
  recordInvocation(args, null);
  if (BEHAVIOR === "logged-out") {
    console.log(JSON.stringify({ status: "unauthenticated", isAuthenticated: false }));
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      status: "authenticated",
      isAuthenticated: true,
      userInfo: { email: "test@example.com" }
    })
  );
  process.exit(0);
}

if (args[0] === "create-chat") {
  recordInvocation(args, null);
  console.log(CREATE_CHAT_ID);
  process.exit(0);
}

if (!args.includes("-p")) {
  recordInvocation(args, null);
  process.stderr.write("fake cursor-agent: unsupported invocation: " + args.join(" ") + "\\n");
  process.exit(1);
}

const resumeIndex = args.indexOf("--resume");
const resumeChatId = resumeIndex === -1 ? null : args[resumeIndex + 1] || null;
const sessionId = resumeChatId || RUN_CHAT_ID;

function reviewFinding() {
  return {
    severity: "high",
    title: "Missing empty-state guard",
    body: "The change assumes data is always present.",
    file: "src/app.js",
    line_start: 4,
    line_end: 6,
    confidence: 0.87,
    recommendation: "Handle empty collections before indexing."
  };
}

function cleanReviewJson(summary) {
  return JSON.stringify({ verdict: "approve", summary, findings: [], next_steps: [] });
}

// Structured-review vs task output is dispatched on the explicit behavior
// flag the tests pass — never on prose sniffed from the real prompt templates.
const REVIEW_BEHAVIORS = new Set(["review-ok", "adversarial-clean"]);

// Cross-process protocol marker embedded by prompts/stop-review-gate.md; a
// stable contract (asserted by tests), unlike template prose.
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function structuredReviewPayload() {
  if (BEHAVIOR === "adversarial-clean") {
    return cleanReviewJson("No material issues found.");
  }
  return JSON.stringify({
    verdict: "needs-attention",
    summary: "One material issue surfaced.",
    findings: [reviewFinding()],
    next_steps: ["Add an empty-state test."]
  });
}

function taskPayload(prompt) {
  if (prompt.includes(STOP_REVIEW_TASK_MARKER)) {
    if (BEHAVIOR === "stop-gate-allow") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (prompt.includes("<handoff_digest>")) {
    return "Handoff acknowledged. The prior session state and open threads are understood.";
  }

  if (resumeChatId) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

function payloadFor(prompt) {
  if (REVIEW_BEHAVIORS.has(BEHAVIOR)) {
    return structuredReviewPayload();
  }
  return taskPayload(prompt);
}

function emitInit() {
  send({
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    cwd: process.cwd(),
    session_id: sessionId,
    model: "Fake Composer",
    permissionMode: "default"
  });
}

function emitToolCallPair() {
  send({
    type: "tool_call",
    subtype: "started",
    call_id: "call_1",
    tool_call: { readToolCall: { args: { path: "README.md" } } },
    session_id: sessionId
  });
  send({
    type: "tool_call",
    subtype: "completed",
    call_id: "call_1",
    tool_call: { readToolCall: { args: { path: "README.md" }, result: { success: {} } } },
    session_id: sessionId
  });
}

function emitResultTurn(payload, isError) {
  send({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: payload }] },
    session_id: sessionId
  });
  send({
    type: "result",
    subtype: isError ? "error" : "success",
    duration_ms: 42,
    duration_api_ms: 40,
    is_error: Boolean(isError),
    result: payload,
    session_id: sessionId,
    request_id: "req_fake_1",
    usage: { inputTokens: 128, outputTokens: 64, cacheReadTokens: 0, cacheWriteTokens: 0 }
  });
}

function runTurn(prompt) {
  emitInit();

  if (BEHAVIOR === "no-result-event") {
    process.stderr.write("fake cursor-agent crashed before returning a result\\n");
    process.exit(1);
  }

  if (BEHAVIOR === "slow-task") {
    // Keep the process alive until a cancel kills the process tree.
    setInterval(() => {}, 1000);
    return;
  }

  emitToolCallPair();

  if (BEHAVIOR === "run-fails") {
    process.stderr.write("fake cursor-agent run failed\\n");
    emitResultTurn("The run failed before completing the task.", true);
    process.exit(1);
  }

  if (BEHAVIOR === "max-mode-required") {
    emitResultTurn(
      'ActionRequiredError: Max Mode Required The model "gpt-5.6-sol-high" requires Max Mode to be enabled. Please enable Max Mode and try again.',
      true
    );
    process.exit(1);
  }

  emitResultTurn(payloadFor(prompt), false);
  process.exit(0);
}

let stdinPrompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinPrompt += chunk;
});
process.stdin.on("end", () => {
  recordInvocation(args, stdinPrompt);
  runTurn(stdinPrompt);
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, binaries are invoked via .cmd wrappers when spawned with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0cursor-agent" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "cursor-agent.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function readFakeCursorState(binDir) {
  const statePath = path.join(binDir, "fake-cursor-state.json");
  if (!fs.existsSync(statePath)) {
    return { invocations: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
