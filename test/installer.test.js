import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageRoot, "bin", "opencode-work-context.js");
const fixtureRoot = path.join(os.tmpdir(), "opencode");
fs.mkdirSync(fixtureRoot, { recursive: true });
const makeRoot = () => fs.mkdtempSync(path.join(fixtureRoot, "installer-test-"));
const removeRoot = (root) => fs.rmSync(root, { recursive: true, force: true });

const runInit = (root, extra = {}, args = ["init"]) => spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    PATH: `${extra.bin}:${process.env.PATH}`,
    OPENCODE_WORK_CONTEXT_SOURCE: packageRoot,
    OPENCODE_PLUGIN_SOURCE: path.join(packageRoot, "node_modules", "@opencode-ai", "plugin"),
  },
});

const installMock = (root, mode = "success") => {
  const bin = fs.mkdtempSync(path.join(fixtureRoot, "npm-bin-"));
  const npm = path.join(bin, "npm");
  fs.writeFileSync(npm, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (${JSON.stringify(mode === "fail")}) process.exit(17);
const source = process.env.OPENCODE_WORK_CONTEXT_SOURCE;
const pluginSource = process.env.OPENCODE_PLUGIN_SOURCE;
const manifestFile = path.join(process.cwd(), "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
manifest.devDependencies = { ...(manifest.devDependencies || {}), "opencode-work-context": "=0.1.1" };
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\\n");
fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), JSON.stringify({ name: manifest.name, lockfileVersion: 3 }) + "\\n");
const packageLink = path.join(process.cwd(), "node_modules", "opencode-work-context");
fs.mkdirSync(path.dirname(packageLink), { recursive: true });
fs.symlinkSync(source, packageLink, "dir");
const pluginLink = path.join(process.cwd(), "node_modules", "@opencode-ai", "plugin");
fs.mkdirSync(path.dirname(pluginLink), { recursive: true });
fs.symlinkSync(pluginSource, pluginLink, "dir");
if (${JSON.stringify(mode === "fail-after-mutation")}) process.exit(17);
`);
  fs.chmodSync(npm, 0o755);
  return bin;
};

const assertIntegration = (root) => {
  for (const relative of [".work-context/config.yaml", ".opencode/commands/wc.md", ".opencode/plugins/work-context.js"]) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, relative);
  }
};

test("installer keeps standalone npm files at project root", () => {
  const root = makeRoot();
  const bin = installMock(root);
  try {
    const result = runInit(root, { bin });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, "package.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".opencode", "package.json")), false);
    assertIntegration(root);
    assert.equal(
      fs.readFileSync(path.join(root, ".opencode", "commands", "wc.md"), "utf8"),
      fs.readFileSync(path.join(packageRoot, "commands", "wc.md"), "utf8"),
    );
  } finally { removeRoot(root); removeRoot(bin); }
});

test("installer uses root package and preserves ESM plugin scope", async () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "host", version: "1.0.0", type: "module" }) + "\n");
  const bin = installMock(root);
  try {
    assert.equal(runInit(root, { bin }).status, 0);
    assert.equal(fs.existsSync(path.join(root, ".opencode", "package.json")), false);
    const loaded = await import(path.join(root, ".opencode", "plugins", "work-context.js"));
    assert.equal(typeof loaded.default, "function");
  } finally { removeRoot(root); removeRoot(bin); }
});

test("installer uses .opencode package without creating root npm infrastructure", async () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, ".opencode"));
  fs.writeFileSync(path.join(root, ".opencode", "package.json"), JSON.stringify({ name: "opencode-host", version: "1.0.0" }) + "\n");
  const bin = installMock(root);
  try {
    assert.equal(runInit(root, { bin }).status, 0);
    assert.equal(fs.existsSync(path.join(root, "package.json")), false);
    assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(root, ".opencode", "node_modules")), true);
    const loaded = await import(path.join(root, ".opencode", "plugins", "work-context.js"));
    assert.equal(typeof loaded.default, "function");
  } finally { removeRoot(root); removeRoot(bin); }
});

test("repeated init is idempotent and conflicts require force", () => {
  const root = makeRoot();
  const bin = installMock(root);
  try {
    assert.equal(runInit(root, { bin }).status, 0);
    assert.equal(runInit(root, { bin }).status, 0);
    fs.writeFileSync(path.join(root, ".opencode", "commands", "wc.md"), "user file\n");
    const conflict = runInit(root, { bin });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /--force/);
    assert.equal(runInit(root, { bin }, ["init", "--force"]).status, 0);
  } finally { removeRoot(root); removeRoot(bin); }
});

test("npm failure rolls back dependency and integration files", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, ".opencode"));
  fs.writeFileSync(path.join(root, ".opencode", "package.json"), "{\"name\":\"host\"}\n");
  const original = fs.readFileSync(path.join(root, ".opencode", "package.json"));
  const bin = installMock(root, "fail-after-mutation");
  try {
    fs.mkdirSync(path.join(root, ".opencode", "node_modules"));
    fs.writeFileSync(path.join(root, ".opencode", "node_modules", "sentinel"), "original\n");
    assert.notEqual(runInit(root, { bin }).status, 0);
    assert.deepEqual(fs.readFileSync(path.join(root, ".opencode", "package.json")), original);
    assert.equal(fs.existsSync(path.join(root, ".work-context")), false);
    assert.equal(fs.readFileSync(path.join(root, ".opencode", "node_modules", "sentinel"), "utf8"), "original\n");
  } finally { removeRoot(root); removeRoot(bin); }
});
