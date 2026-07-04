import { spawn } from "node:child_process";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, formatCommandFailure, runCommand, terminateProcessTree } from "./process.mjs";

const CURSOR_BINARY = "cursor-agent";
const CHAT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const MAX_BALANCED_SCAN_STARTS = 100;

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

const TOOL_CALL_PHASES = new Map([
  ["readToolCall", "investigating"],
  ["grepToolCall", "investigating"],
  ["globToolCall", "investigating"],
  ["lsToolCall", "investigating"],
  ["shellToolCall", "running"],
  ["writeToolCall", "editing"],
  ["editToolCall", "editing"],
  ["applyPatchToolCall", "editing"],
  ["todoToolCall", "planning"]
]);

function cursorNotInstalledError() {
  return new Error(
    "Cursor CLI is not installed or could not be executed. Install it with `curl https://cursor.com/install -fsS | bash`, then rerun `/cursor:setup`."
  );
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function phaseForToolKey(toolKey) {
  return TOOL_CALL_PHASES.get(toolKey) ?? "running";
}

function extractToolKey(toolCall) {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
    return null;
  }
  return Object.keys(toolCall)[0] ?? null;
}

function isRejectedToolCall(toolCall, toolKey) {
  const body = toolCall?.[toolKey];
  const result = body && typeof body === "object" ? body.result : null;
  return Boolean(result && typeof result === "object" && "rejected" in result);
}

function extractAssistantText(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

export function getCursorAvailability(cwd) {
  const status = binaryAvailable(CURSOR_BINARY, ["--version"], { cwd });
  if (!status.available) {
    return { available: false, version: null, detail: status.detail };
  }
  return {
    available: true,
    version: status.detail,
    detail: `cursor-agent ${status.detail}`
  };
}

export async function getCursorAuthStatus(cwd) {
  const result = runCommand(CURSOR_BINARY, ["status", "--format", "json"], { cwd });
  if (result.error) {
    if (/** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
      return { loggedIn: false, email: null, detail: "cursor-agent not found" };
    }
    return { loggedIn: false, email: null, detail: result.error.message };
  }

  const stdout = String(result.stdout ?? "").trim();
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const loggedIn = parsed.isAuthenticated === true || parsed.status === "authenticated";
    const email =
      typeof parsed.userInfo?.email === "string" && parsed.userInfo.email.trim() ? parsed.userInfo.email.trim() : null;
    if (loggedIn) {
      return {
        loggedIn: true,
        email,
        detail: email ? `Logged in as ${email}` : "Logged in"
      };
    }
    return {
      loggedIn: false,
      email,
      detail:
        typeof parsed.status === "string" && parsed.status.trim() ? `not authenticated (${parsed.status.trim()})` : "not authenticated"
    };
  }

  const detail =
    String(result.stderr ?? "").trim() ||
    stdout ||
    (result.status !== 0 ? `cursor-agent status exited with code ${result.status}` : "not authenticated");
  return { loggedIn: false, email: null, detail };
}

export async function runCursorAgentTurn(cwd, options = {}) {
  const prompt = String(options.prompt ?? "").trim() ? String(options.prompt) : "";
  if (!prompt) {
    throw new Error("A prompt is required for this Cursor run.");
  }

  const write = Boolean(options.write);
  const model = options.model == null ? null : String(options.model).trim() || null;
  const resumeChatId = options.resumeChatId == null ? null : String(options.resumeChatId).trim() || null;
  const onProgress = options.onProgress ?? null;

  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    ...(write ? ["--force"] : ["--mode", "plan"]),
    ...(model ? ["--model", model] : []),
    ...(resumeChatId ? ["--resume", resumeChatId] : [])
  ];

  emitProgress(
    onProgress,
    resumeChatId ? `Resuming Cursor chat ${resumeChatId}.` : "Starting Cursor agent turn.",
    "starting",
    resumeChatId ? { threadId: resumeChatId } : {}
  );

  return new Promise((resolve, reject) => {
    const child = spawn(CURSOR_BINARY, argv, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true
    });

    // If the companion itself is terminated mid-turn (e.g. the stop-gate
    // hook's spawnSync timeout), take the cursor-agent child down with us so
    // the run settles and no orphaned agent keeps consuming tokens.
    const onTerminationSignal = () => {
      try {
        terminateProcessTree(child.pid ?? Number.NaN);
      } catch {
        // Best-effort cleanup only.
      }
    };
    process.once("SIGTERM", onTerminationSignal);
    process.once("SIGINT", onTerminationSignal);
    const removeSignalHandlers = () => {
      process.removeListener("SIGTERM", onTerminationSignal);
      process.removeListener("SIGINT", onTerminationSignal);
    };

    let stdoutRemainder = "";
    let stderrText = "";
    let chatId = resumeChatId;
    let finalMessage = "";
    let usage = null;
    let durationMs = null;
    let sawResult = false;
    let resultIsError = false;
    let settled = false;
    const rejectedToolCalls = [];

    const handleEvent = (event) => {
      if (!chatId && typeof event.session_id === "string" && event.session_id) {
        chatId = event.session_id;
      }

      switch (event.type) {
        case "system": {
          if (event.subtype === "init") {
            const modelName = typeof event.model === "string" && event.model.trim() ? event.model.trim() : null;
            emitProgress(
              onProgress,
              modelName ? `Cursor agent session started (model: ${modelName}).` : "Cursor agent session started.",
              "starting",
              typeof event.session_id === "string" && event.session_id ? { threadId: event.session_id } : {}
            );
          }
          break;
        }
        case "assistant": {
          const snippet = shorten(extractAssistantText(event.message), 96);
          if (snippet) {
            emitProgress(onProgress, `Assistant: ${snippet}`);
          }
          break;
        }
        case "tool_call": {
          const toolKey = extractToolKey(event.tool_call);
          if (!toolKey) {
            break;
          }
          if (event.subtype === "started") {
            emitProgress(onProgress, `Tool call started: ${toolKey}`, phaseForToolKey(toolKey));
          } else if (event.subtype === "completed") {
            if (isRejectedToolCall(event.tool_call, toolKey)) {
              rejectedToolCalls.push(toolKey);
              emitProgress(onProgress, `Tool call rejected: ${toolKey}`, phaseForToolKey(toolKey));
            } else {
              emitProgress(onProgress, `Tool call completed: ${toolKey}`, phaseForToolKey(toolKey));
            }
          }
          break;
        }
        case "result": {
          sawResult = true;
          resultIsError = Boolean(event.is_error);
          finalMessage = event.result ?? "";
          if (typeof event.session_id === "string" && event.session_id) {
            chatId = event.session_id;
          }
          usage = event.usage && typeof event.usage === "object" ? event.usage : null;
          durationMs = Number.isFinite(event.duration_ms) ? event.duration_ms : null;
          emitProgress(
            onProgress,
            resultIsError ? "Cursor run finished with an error result." : "Cursor run completed.",
            resultIsError ? "failed" : "finalizing",
            chatId ? { threadId: chatId } : {}
          );
          break;
        }
        default:
          break;
      }
    };

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        return;
      }
      handleEvent(event);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split("\n");
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrText += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalHandlers();
      if (error?.code === "ENOENT") {
        reject(cursorNotInstalledError());
        return;
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalHandlers();

      if (stdoutRemainder.trim()) {
        processLine(stdoutRemainder);
        stdoutRemainder = "";
      }

      const exitCode = typeof code === "number" ? code : 1;
      let status;
      if (sawResult) {
        status = resultIsError || exitCode !== 0 ? 1 : 0;
      } else {
        status = exitCode || 1;
        finalMessage = "";
        if (!stderrText.trim()) {
          stderrText = signal
            ? `cursor-agent terminated by signal ${signal} before emitting a result event.`
            : `cursor-agent exited with code ${exitCode} before emitting a result event.`;
        }
      }

      resolve({
        status,
        chatId,
        finalMessage,
        stderr: stderrText.trimEnd(),
        usage,
        durationMs,
        rejectedToolCalls
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function createCursorChat(cwd) {
  const result = runCommand(CURSOR_BINARY, ["create-chat"], { cwd });
  if (result.error) {
    if (/** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
      throw cursorNotInstalledError();
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }

  const stdout = String(result.stdout ?? "").trim();
  const candidate =
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  if (!CHAT_ID_PATTERN.test(candidate)) {
    throw new Error(`cursor-agent create-chat did not return a chat id: ${stdout || "(no output)"}`);
  }
  return candidate;
}

function tryParseObject(candidate) {
  const trimmed = String(candidate ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // fall through to the next candidate
  }
  return null;
}

function collectFencedBlocks(text) {
  const blocks = [];
  const pattern = /```[^\n`]*\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function findBalancedObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function* iterateBalancedObjectRegions(text) {
  let starts = 0;
  let start = text.indexOf("{");
  while (start !== -1) {
    starts += 1;
    if (starts > MAX_BALANCED_SCAN_STARTS) {
      return;
    }
    const end = findBalancedObjectEnd(text, start);
    if (end === -1) {
      // No balanced region begins here; try the next opening brace.
      start = text.indexOf("{", start + 1);
      continue;
    }
    yield text.slice(start, end + 1);
    // Skip past the captured region so nested braces are not rescanned.
    start = text.indexOf("{", end + 1);
  }
}

function* iterateCandidates(trimmed) {
  yield trimmed;
  yield* collectFencedBlocks(trimmed);
  yield* iterateBalancedObjectRegions(trimmed);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  const text = typeof rawOutput === "string" ? rawOutput : rawOutput == null ? "" : String(rawOutput);

  if (fallback.status) {
    return {
      parsed: null,
      parseError:
        String(fallback.failureMessage ?? "").trim() ||
        `Cursor exited with status ${fallback.status} before returning structured output.`,
      rawOutput: text,
      ...fallback
    };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return {
      parsed: null,
      parseError: String(fallback.failureMessage ?? "").trim() || "Cursor did not return a final structured message.",
      rawOutput: text,
      ...fallback
    };
  }

  // Candidates are evaluated lazily; an empty object (e.g. a stray `{}` in
  // prose) must not shadow real JSON that appears later in the text.
  for (const candidate of iterateCandidates(trimmed)) {
    const parsed = tryParseObject(candidate);
    if (parsed && Object.keys(parsed).length > 0) {
      return {
        parsed,
        parseError: null,
        rawOutput: text,
        ...fallback
      };
    }
  }

  return {
    parsed: null,
    parseError: "Could not find a JSON object in the Cursor output.",
    rawOutput: text,
    ...fallback
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}
