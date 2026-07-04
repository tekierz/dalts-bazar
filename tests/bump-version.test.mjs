import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeVersionFixture() {
  const root = makeTempDir();

  writeJson(path.join(root, "package.json"), {
    name: "@openai/codex-plugin-cc",
    version: "1.0.2"
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "@openai/codex-plugin-cc",
    version: "1.0.2",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "@openai/codex-plugin-cc",
        version: "1.0.2"
      }
    }
  });
  writeJson(path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json"), {
    name: "codex",
    version: "1.0.2"
  });
  writeJson(path.join(root, "plugins", "cursor", ".claude-plugin", "plugin.json"), {
    name: "cursor",
    version: "1.0.2"
  });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    metadata: {
      version: "1.0.2"
    },
    plugins: [
      {
        name: "codex",
        version: "1.0.2",
        source: "./plugins/codex"
      },
      {
        name: "cursor",
        version: "1.0.2",
        source: "./plugins/cursor"
      }
    ]
  });

  return root;
}

function addThirdPlugin(root, version = "1.0.2") {
  writeJson(path.join(root, "plugins", "gemini", ".claude-plugin", "plugin.json"), {
    name: "gemini",
    version
  });
  const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");
  const marketplace = readJson(marketplacePath);
  marketplace.plugins.push({
    name: "gemini",
    version,
    source: "./plugins/gemini"
  });
  writeJson(marketplacePath, marketplace);
}

test("bump-version updates every release manifest", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).packages[""].version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "cursor", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).metadata.version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[0].version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[1].version, "1.2.3");
});

test("bump-version derives plugin manifests from marketplace sources", () => {
  const root = makeVersionFixture();
  addThirdPlugin(root);

  const bump = run("node", [SCRIPT, "--root", root, "2.0.0"], {
    cwd: ROOT
  });
  assert.equal(bump.status, 0, bump.stderr);
  assert.equal(readJson(path.join(root, "plugins", "gemini", ".claude-plugin", "plugin.json")).version, "2.0.0");

  // A plugin added to the marketplace but left stale must fail --check.
  writeJson(path.join(root, "plugins", "gemini", ".claude-plugin", "plugin.json"), {
    name: "gemini",
    version: "1.0.2"
  });
  const check = run("node", [SCRIPT, "--root", root, "--check"], {
    cwd: ROOT
  });
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /plugins\/gemini\/\.claude-plugin\/plugin\.json version/);
});

test("bump-version fails loudly when a marketplace plugin has no source", () => {
  const root = makeVersionFixture();
  const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");
  const marketplace = readJson(marketplacePath);
  delete marketplace.plugins[1].source;
  writeJson(marketplacePath, marketplace);

  const result = run("node", [SCRIPT, "--root", root, "--check"], {
    cwd: ROOT
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\[cursor\]\.source/);
});

test("bump-version check mode reports stale metadata", () => {
  const root = makeVersionFixture();
  writeJson(path.join(root, "package.json"), {
    name: "@openai/codex-plugin-cc",
    version: "1.0.3"
  });

  const result = run("node", [SCRIPT, "--root", root, "--check"], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\/codex\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /plugins\/cursor\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json plugins\[codex\]\.version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json plugins\[cursor\]\.version/);
});
