import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

// In read-files fallback mode the full diff is read once (with generous
// headroom over the inline budget) and split into per-file sections, instead
// of spawning one git diff per changed file.
const FALLBACK_DIFF_READ_MULTIPLIER = 8;

function readGitOutputCapped(cwd, args, capBytes) {
  const result = git(cwd, args, { maxBuffer: capBytes });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return { text: String(result.stdout ?? ""), truncated: true };
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return { text: result.stdout, truncated: false };
}

function parseDiffHeaderPath(header) {
  const rest = header.slice("diff --git ".length);
  const quoted = rest.match(/ "b\/(.+)"$/);
  if (quoted) {
    return quoted[1];
  }
  const plain = rest.match(/ b\/(.+)$/);
  return plain ? plain[1] : null;
}

function splitDiffByFile(read) {
  const sections = new Map();
  const text = read.text;
  if (!text.trim()) {
    return sections;
  }

  const chunks = `\n${text}`.split(/\n(?=diff --git )/).filter((chunk) => chunk.trim());
  for (const chunk of chunks) {
    const newlineIndex = chunk.indexOf("\n");
    const header = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    if (!header.startsWith("diff --git ")) {
      continue;
    }
    const file = parseDiffHeaderPath(header.trimEnd());
    if (!file) {
      continue;
    }
    const existing = sections.get(file);
    sections.set(file, existing ? `${existing}\n${chunk.trimEnd()}` : chunk.trimEnd());
  }

  // A truncated read may end mid-section; drop the final (possibly partial)
  // section so no file is shown with a cut-off diff.
  if (read.truncated && sections.size > 0) {
    const lastFile = [...sections.keys()].at(-1);
    sections.delete(lastFile);
  }

  return sections;
}

function readFallbackDiffSections(cwd, argSets, maxInlineDiffBytes) {
  const capBytes = Math.max(maxInlineDiffBytes * FALLBACK_DIFF_READ_MULTIPLIER, maxInlineDiffBytes + 1);
  return argSets.map((args) => splitDiffByFile(readGitOutputCapped(cwd, args, capBytes)));
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectFileDiffsFromSections(files, sectionMaps, maxBytes) {
  const sections = [];
  const omitted = [];
  let remainingBytes = maxBytes;

  for (const file of files) {
    const parts = sectionMaps.map((sectionMap) => sectionMap.get(file)).filter(Boolean);
    if (parts.length === 0) {
      omitted.push(file);
      continue;
    }
    const combined = parts.join("\n").trimEnd();
    if (!combined) {
      continue;
    }
    const combinedBytes = Buffer.byteLength(combined, "utf8");
    if (combinedBytes > remainingBytes) {
      omitted.push(file);
      continue;
    }
    remainingBytes -= combinedBytes;
    sections.push(`### ${file}\n${combined}`);
  }

  if (omitted.length > 0) {
    sections.push(
      `(diffs omitted for ${omitted.length} file(s) to stay within the inline budget: ${omitted.join(", ")})`
    );
  }

  return sections.join("\n\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--stat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--stat"]).stdout.trim();
    const trackedFiles = listUniqueFiles(state.staged, state.unstaged);
    const sectionMaps = readFallbackDiffSections(
      cwd,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    const fileDiffs = collectFileDiffsFromSections(trackedFiles, sectionMaps, maxInlineDiffBytes);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("File Diffs", fileDiffs),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  let content;
  if (includeDiff) {
    content = [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection(
        "Branch Diff",
        gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
      )
    ].join("\n");
  } else {
    const nameStatus = gitChecked(cwd, ["diff", "--name-status", comparison.commitRange]).stdout.trim();
    const sectionMaps = readFallbackDiffSections(
      cwd,
      [["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]],
      maxInlineDiffBytes
    );
    const fileDiffs = collectFileDiffsFromSections(changedFiles, sectionMaps, maxInlineDiffBytes);
    content = [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Changed Files", nameStatus),
      formatSection("File Diffs", fileDiffs)
    ].join("\n");
  }

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content,
    changedFiles,
    comparison
  };
}

function buildCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "The full diff is included below. You may also use your file read tool to open surrounding context in the current working tree.";
  }

  return "This run cannot execute shell commands. Use your file read tool to open and inspect the changed files listed below in the current working tree; the diff summary shows what changed in each.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? diffBytes <= maxInlineDiffBytes;
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff, maxInlineDiffBytes });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? diffBytes <= maxInlineDiffBytes;
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison, maxInlineDiffBytes });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "read-files",
    collectionGuidance: buildCollectionGuidance({ includeDiff }),
    ...details
  };
}
