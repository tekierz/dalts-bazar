import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath, truncateUtf8Bytes } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "CURSOR_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_DIGEST_MAX_BYTES = 49152;
const TRUNCATION_NOTICE = "> (earlier conversation truncated)";
const TURN_SEPARATOR = "\n\n";
const NOISE_PREFIX_PATTERN = /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)\b/;

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Cursor can import Claude sessions only from ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item.trim()) {
        parts.push(item.trim());
      }
      continue;
    }
    // Keep only plain text items; skip tool_use, tool_result, thinking, images, etc.
    if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text.trim());
    }
  }
  return parts.join("\n\n").trim();
}

function isTranscriptNoise(text) {
  return NOISE_PREFIX_PATTERN.test(text);
}

function collectTranscriptTurns(sourcePath) {
  const raw = fs.readFileSync(sourcePath, "utf8");
  const turns = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") {
      continue;
    }
    // Skip hook/skill-injected noise and subagent sidechains.
    if (entry.isMeta === true || entry.isSidechain === true) {
      continue;
    }

    const message = entry.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const role = message.role === "user" || message.role === "assistant" ? message.role : entry.type;

    const text = extractMessageText(message.content);
    if (!text || isTranscriptNoise(text)) {
      continue;
    }

    const previous = turns[turns.length - 1];
    if (previous && previous.role === role) {
      previous.text = `${previous.text}\n\n${text}`;
    } else {
      turns.push({ role, text });
    }
  }

  return turns;
}

function renderTurn(turn) {
  const heading = turn.role === "user" ? "## User:" : "## Assistant:";
  return `${heading}\n\n${turn.text}`;
}

function renderDigest(turns, maxBytes) {
  const rendered = turns.map(renderTurn);
  const separatorBytes = Buffer.byteLength(TURN_SEPARATOR, "utf8");

  let totalBytes = 0;
  for (let index = 0; index < rendered.length; index += 1) {
    totalBytes += Buffer.byteLength(rendered[index], "utf8") + (index > 0 ? separatorBytes : 0);
  }
  if (totalBytes <= maxBytes) {
    return rendered.join(TURN_SEPARATOR);
  }

  // Over budget: drop oldest turns first, keeping the newest turns that fit.
  const noticePrefix = `${TRUNCATION_NOTICE}${TURN_SEPARATOR}`;
  const budget = maxBytes - Buffer.byteLength(noticePrefix, "utf8");
  const kept = [];
  let usedBytes = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const partBytes = Buffer.byteLength(rendered[index], "utf8") + (kept.length > 0 ? separatorBytes : 0);
    if (usedBytes + partBytes > budget) {
      break;
    }
    kept.unshift(rendered[index]);
    usedBytes += partBytes;
  }

  if (kept.length === 0) {
    // Even the newest turn alone exceeds the budget; keep its head.
    const newest = rendered[rendered.length - 1];
    return `${noticePrefix}${truncateUtf8Bytes(newest, Math.max(0, budget)).text}`;
  }

  return `${noticePrefix}${kept.join(TURN_SEPARATOR)}`;
}

function normalizeMaxBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DIGEST_MAX_BYTES;
  }
  return Math.floor(parsed);
}

export function distillClaudeTranscript(sourcePath, options = {}) {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const turns = collectTranscriptTurns(sourcePath);
  if (turns.length === 0) {
    throw new Error(`No user or assistant messages were found in the Claude transcript: ${sourcePath}`);
  }
  return renderDigest(turns, maxBytes);
}
