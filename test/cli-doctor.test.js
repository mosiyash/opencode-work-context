import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WORK_CONTEXT_PROTOCOL_MARKER } from "../src/protocol.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const cli = path.join(packageRoot, "bin", "opencode-work-context.js");
const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "work-context-cli-doctor-test-"));
const removeRoot = (root) => fs.rmSync(root, { recursive: true, force: true });
const write = (root, relative, content) => {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const run = (root, args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });

test("standalone doctor emits the package-owned envelope for an explicit project", () => {
  const root = makeRoot();
  const elsewhere = makeRoot();
  try {
    write(root, ".opencode/commands/wc.md", `${WORK_CONTEXT_PROTOCOL_MARKER}\n`);
    write(root, ".opencode/opencode.json", `${JSON.stringify({ plugin: [`opencode-work-context@${manifest.version}`] })}\n`);

    const result = run(elsewhere, ["doctor", "--json", "--project", root]);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(envelope), ["schema", "component", "package_version", "status", "project", "diagnostic", "complete"]);
    assert.equal(envelope.schema, 1);
    assert.equal(envelope.component, "opencode-work-context");
    assert.equal(envelope.package_version, manifest.version);
    assert.equal(envelope.project, fs.realpathSync(root));
    assert.equal(envelope.status, "error");
    assert.equal(envelope.complete, true);
    assert.equal(envelope.diagnostic.operation, "delivery.doctor");
    assert.equal(envelope.diagnostic.evidence.command.status, "available");
    assert.equal(envelope.diagnostic.evidence.loaded_plugin.evidence_kind, "unavailable");
    assert.equal(envelope.diagnostic.evidence.host_attestation.evidence_kind, "unavailable");
    assert.deepEqual(envelope.diagnostic.evidence.declarations.filter((item) => item.status === "declared"), [{
      source: "opencode", path: ".opencode/opencode.json", field: "plugin", status: "declared",
      package: "opencode-work-context", version: manifest.version, model: "managed",
    }]);
    assert.ok(envelope.diagnostic.findings.some((finding) => finding.id === "runtime.protocol_major_unknown" && finding.severity === "error"));

    const reordered = run(elsewhere, ["doctor", "--project", root, "--json"]);
    assert.equal(reordered.status, 1);
    assert.equal(reordered.stderr, "");
    assert.deepEqual(JSON.parse(reordered.stdout), envelope);
  } finally { removeRoot(root); removeRoot(elsewhere); }
});

test("standalone doctor defaults to cwd and rejects invalid invocations", () => {
  const root = makeRoot();
  try {
    const defaultProject = run(root, ["doctor", "--json"]);
    assert.equal(defaultProject.status, 1);
    assert.equal(defaultProject.stderr, "");
    assert.equal(JSON.parse(defaultProject.stdout).project, fs.realpathSync(root));

    for (const args of [["doctor"], ["doctor", "--json", "--json"], ["doctor", "--json", "--project", path.join(root, "missing")]]) {
      const result = run(root, args);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^opencode-work-context: /);
    }

    const existingCommand = run(root, ["help"]);
    assert.equal(existingCommand.status, 1);
    assert.equal(existingCommand.stdout, "");
    assert.equal(existingCommand.stderr, "opencode-work-context: usage: opencode-work-context init [--force] | activate [--force] | deactivate [--force] | sync-command | doctor --json [--project <path>]\n");
  } finally { removeRoot(root); }
});
