import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "cursor");
const CODEX_PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Cursor's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /allowed-tools:\s*Read, Glob, Grep, Bash\(node:\*\), Bash\(git:\*\), AskUserQuestion/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Cursor review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
  assert.match(source, /read-only via Cursor's plan mode/i);
  assert.match(source, /\/cursor:status/);
  assert.doesNotMatch(source, /Codex/);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Cursor's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /allowed-tools:\s*Read, Glob, Grep, Bash\(node:\*\), Bash\(git:\*\), AskUserQuestion/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Cursor adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/cursor:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
  assert.match(source, /read-only via Cursor's plan mode/i);
  assert.match(source, /\/cursor:status/);
  assert.doesNotMatch(source, /Codex/);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/cursor-rescue.md");
  const runtimeSkill = read("skills/cursor-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Cursor's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Same regression guard as codex #234: the rescue routing must name the
  // Agent-tool transport explicitly and must not run under `context: fork`,
  // otherwise `Skill(cursor:rescue)` can recurse into this command.
  assert.match(rescue, /subagent_type: "cursor:cursor-rescue"/);
  assert.match(rescue, /do not call `Skill\(cursor:cursor-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs" task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Cursor chat/);
  assert.match(rescue, /Start a new Cursor chat/);
  assert.match(rescue, /run the `cursor:cursor-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /There is no `--effort` flag/i);
  assert.match(rescue, /Never pass `--effort`/i);
  assert.match(rescue, /claude-opus-4-8\[effort=high\]/);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new chat, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Cursor companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(rescue, /\/cursor:setup/);

  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Cursor running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs" task/);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Never pass `--effort`/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for a concrete model name such as `composer-2\.5-fast`, pass it through with `--model` verbatim/i);
  assert.match(agent, /claude-opus-4-8\[effort=high\]/);
  assert.match(agent, /`--resume` means add `--resume-last`/i);
  assert.match(agent, /`--fresh` means do not add `--resume-last`/i);
  assert.match(agent, /Return the stdout of the `cursor-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Cursor cannot be invoked, return nothing/i);
  assert.match(agent, /cursor-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Cursor prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);

  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `transfer`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `cursor-prompting` skill to rewrite the user's request into a tighter Cursor prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Never pass `--effort`\. Cursor has no `--effort` flag and the helper rejects it/i);
  assert.match(runtimeSkill, /use bracket syntax in `--model`/i);
  assert.match(runtimeSkill, /claude-opus-4-8\[effort=high\]/);
  assert.match(runtimeSkill, /choose the matching model-id variant only when one obviously exists/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or the Cursor agent cannot be invoked, return nothing/i);
});

test("rescue agent frontmatter pins the runtime wiring", () => {
  const agent = read("agents/cursor-rescue.md");
  assert.match(agent, /^name: cursor-rescue$/m);
  assert.match(agent, /^model: sonnet$/m);
  assert.match(agent, /^tools: Bash$/m);
  assert.match(agent, /^skills:\n {2}- cursor-cli-runtime\n {2}- cursor-prompting$/m);
});

test("cursor surface has no spark alias and no --effort flag", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/cursor-rescue.md");
  const runtimeSkill = read("skills/cursor-cli-runtime/SKILL.md");

  assert.match(rescue, /argument-hint: "\[--background\|--wait\] \[--resume\|--fresh\] \[--model <model>\] \[what Cursor should investigate, solve, or continue\]"/);
  assert.doesNotMatch(rescue, /\[--effort/);
  assert.doesNotMatch(rescue, /\bspark\b/i);
  assert.doesNotMatch(agent, /\bspark\b/i);
  assert.doesNotMatch(runtimeSkill, /\bspark\b/i);
  assert.doesNotMatch(runtimeSkill, /pass `--effort`(?! flag)? to `task`/i);
});

test("transfer, result, cancel, and status commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const status = read("commands/status.md");
  const resultHandling = read("skills/cursor-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs" transfer "\$ARGUMENTS"`/);
  assert.match(transfer, /Cursor chat ID/);
  assert.match(transfer, /cursor-agent --resume <chat-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs" result "\$ARGUMENTS"`/);
  assert.match(result, /Do not summarize or condense it/i);
  assert.match(result, /\/cursor:status <id>/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs" cancel "\$ARGUMENTS"`/);
  assert.match(status, /disable-model-invocation:\s*true/);
  assert.match(status, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs" status "\$ARGUMENTS"`/);
  assert.match(status, /argument-hint:\s*'\[job-id\] \[--wait\] \[--timeout-ms <ms>\] \[--all\]'/);
  assert.match(resultHandling, /do not turn a failed or incomplete Cursor run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if the Cursor agent was never successfully invoked, do not generate a substitute answer at all/i);
  assert.match(resultHandling, /After presenting review findings, STOP/);
  assert.match(resultHandling, /Auto-applying fixes from a review is strictly forbidden/i);
  assert.match(resultHandling, /cursor-agent --resume <chat-id>/);
  assert.match(resultHandling, /\/cursor:setup/);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/cursor-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/cursor-prompting/SKILL.md");
  const promptRecipes = read("skills/cursor-prompting/references/prompt-recipes.md");

  assert.match(runtimeSkill, /cursor-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Cursor Prompt Recipes/i);
  assert.match(promptRecipes, /Use these as starting templates for Cursor agent task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("internal skills are not user-invocable", () => {
  for (const relativePath of [
    "skills/cursor-cli-runtime/SKILL.md",
    "skills/cursor-result-handling/SKILL.md",
    "skills/cursor-prompting/SKILL.md"
  ]) {
    assert.match(read(relativePath), /user-invocable:\s*false/, relativePath);
  }
  assert.match(read("skills/cursor-cli-runtime/SKILL.md"), /^name: cursor-cli-runtime$/m);
  assert.match(read("skills/cursor-result-handling/SKILL.md"), /^name: cursor-result-handling$/m);
  assert.match(read("skills/cursor-prompting/SKILL.md"), /^name: cursor-prompting$/m);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);

  const hooks = JSON.parse(source).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["SessionEnd", "SessionStart", "Stop"]);
  assert.equal(
    hooks.SessionStart[0].hooks[0].command,
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionStart'
  );
  assert.equal(hooks.SessionStart[0].hooks[0].timeout, 5);
  assert.equal(
    hooks.SessionEnd[0].hooks[0].command,
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionEnd'
  );
  assert.equal(hooks.SessionEnd[0].hooks[0].timeout, 5);
  assert.equal(
    hooks.Stop[0].hooks[0].command,
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs"'
  );
  assert.equal(hooks.Stop[0].hooks[0].timeout, 900);
});

test("setup command surfaces the curl installer without auto-installing", () => {
  const setup = read("commands/setup.md");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /cursor-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(setup, /Do not install it yourself/i);
  assert.match(setup, /!curl https:\/\/cursor\.com\/install -fsS \| bash/);
  assert.match(setup, /!cursor-agent login/);
  assert.match(setup, /CURSOR_API_KEY/);
  assert.doesNotMatch(setup, /npm/i);
  assert.doesNotMatch(setup, /Codex/);
});

test("review prompts embed the output schema and read-only collection placeholders", () => {
  const review = read("prompts/review.md");
  const adversarial = read("prompts/adversarial-review.md");

  for (const prompt of [review, adversarial]) {
    assert.match(prompt, /\{\{OUTPUT_SCHEMA\}\}/);
    assert.match(prompt, /\{\{TARGET_LABEL\}\}/);
    assert.match(prompt, /\{\{REVIEW_COLLECTION_GUIDANCE\}\}/);
    assert.match(prompt, /\{\{REVIEW_INPUT\}\}/);
    assert.match(prompt, /Output exactly one JSON object conforming to this JSON Schema, no prose before or after/);
    assert.doesNotMatch(prompt, /Codex/);
  }
  assert.match(review, /senior software reviewer/i);
  assert.match(adversarial, /You are an adversarial reviewing agent/);
  assert.match(adversarial, /\{\{USER_FOCUS\}\}/);
  assert.doesNotMatch(review, /\{\{USER_FOCUS\}\}/);
});

test("stop gate and transfer prompts carry the pinned placeholders", async () => {
  const stopGate = read("prompts/stop-review-gate.md");
  const handoff = read("prompts/transfer-handoff.md");

  // The stop-gate marker is a cross-process protocol constant: the template
  // must embed exactly the sentence the companion detects.
  const { STOP_REVIEW_TASK_MARKER } = await import("../plugins/cursor/scripts/lib/tracked-jobs.mjs");
  assert.equal(stopGate.includes(STOP_REVIEW_TASK_MARKER), true);

  assert.match(stopGate, /Run a stop-gate review of the previous Claude turn\./);
  assert.match(stopGate, /\{\{CLAUDE_RESPONSE_BLOCK\}\}/);
  assert.match(stopGate, /\{\{WORKING_TREE_CONTEXT\}\}/);
  assert.match(stopGate, /ALLOW: <short reason>/);
  assert.match(stopGate, /BLOCK: <short reason>/);
  assert.match(stopGate, /\/cursor:setup or \/cursor:status/);
  assert.match(stopGate, /you cannot run shell commands/i);

  assert.match(handoff, /\{\{TRANSCRIPT_DIGEST\}\}/);
  assert.match(handoff, /at most 5 sentences/i);
  assert.match(handoff, /Do not start working until asked/i);
});

test("review output schema is byte-identical to the codex schema", () => {
  const cursorSchema = read("schemas/review-output.schema.json");
  const codexSchema = fs.readFileSync(
    path.join(CODEX_PLUGIN_ROOT, "schemas", "review-output.schema.json"),
    "utf8"
  );
  assert.equal(cursorSchema, codexSchema);
});
