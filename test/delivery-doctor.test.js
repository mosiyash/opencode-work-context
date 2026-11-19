import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ERROR_CODES,
  WORK_CONTEXT_PROTOCOL,
  WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH,
  WORK_CONTEXT_PROTOCOL_MARKER,
  WorkContext,
  doctorDelivery,
} from "../src/index.js";
import { createToolDefinitions } from "../src/tool-definitions.js";
import doctorTool from "../tools/work_context_doctor_delivery.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "work-context-doctor-test-"));
const write = (root, relative, content) => {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const loadedEvidence = (overrides = {}) => ({
  evidence_kind: "self_reported",
  package_name: "opencode-work-context",
  package_version: VERSION,
  module_origin: "package_source",
  protocol: {
    ...WORK_CONTEXT_PROTOCOL,
    descriptor_hash: WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH,
  },
  ...overrides,
});
const marker = (overrides = {}) => `<!-- opencode-work-context-protocol: ${JSON.stringify({
  ...WORK_CONTEXT_PROTOCOL,
  descriptor_hash: `sha256:${WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH}`,
  ...overrides,
})} -->`;
const writeCommand = (root, value = WORK_CONTEXT_PROTOCOL_MARKER) => write(root, ".opencode/commands/wc.md", `${value}\ncommand body\n`);
const findingIds = (result) => result.findings.map((finding) => finding.id);
const snapshot = (root, relative = "") => fs.readdirSync(path.join(root, relative), { withFileTypes: true })
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) return [child, "symlink", fs.readlinkSync(path.join(root, child))];
    if (entry.isDirectory()) return [child, "directory", snapshot(root, child)];
    return [child, "file", fs.readFileSync(path.join(root, child), "base64")];
  });

test("delivery doctor reports matching managed evidence without mutating the project", () => {
  const root = makeRoot();
  try {
    writeCommand(root);
    write(root, ".opencode/opencode.json", json({ plugin: [`opencode-work-context@${VERSION}`] }));
    write(root, ".opencode/tui.json", json({ plugin: [`opencode-work-context@${VERSION}`] }));
    write(root, "secret.txt", "must not be exposed\n");
    const before = snapshot(root);

    const result = doctorDelivery(root, { loadedPlugin: loadedEvidence({ module_origin: "managed_cache" }) });

    assert.equal(result.operation, "delivery.doctor");
    assert.equal(result.evidence.command.status, "available");
    assert.equal(result.evidence.loaded_plugin.evidence_kind, "self_reported");
    assert.equal(result.evidence.host_attestation.evidence_kind, "unavailable");
    assert.deepEqual(findingIds(result), ["runtime.host_attestation_unavailable"]);
    assert.deepEqual(snapshot(root), before);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(JSON.stringify(result), /must not be exposed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("delivery doctor distinguishes a matching pinned declaration and installed manifest", () => {
  const root = makeRoot();
  try {
    writeCommand(root);
    write(root, "package.json", json({ devDependencies: { "opencode-work-context": `=${VERSION}` } }));
    write(root, "node_modules/opencode-work-context/package.json", json({ name: "opencode-work-context", version: VERSION, privateData: "ignored" }));
    write(root, ".opencode/plugins/work-context.js", "export default {};\n");

    const result = WorkContext.doctorDelivery(root, { loadedPlugin: loadedEvidence({ module_origin: "project_local" }) });

    assert.equal(result.ok, true);
    assert.equal(result.data.evidence.installations[0].status, "installed");
    assert.equal(result.data.evidence.installations[0].version, VERSION);
    assert.deepEqual(findingIds(result.data), ["runtime.host_attestation_unavailable"]);
    assert.doesNotMatch(JSON.stringify(result), /privateData|ignored/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("delivery doctor gives major mismatch precedence and reports same-major drift as findings", () => {
  const root = makeRoot();
  try {
    write(root, ".opencode/opencode.json", json({ plugin: [`opencode-work-context@${VERSION}`] }));
    writeCommand(root, marker({ major: WORK_CONTEXT_PROTOCOL.major + 1, descriptor_hash: `sha256:${"0".repeat(64)}` }));
    assert.throws(
      () => doctorDelivery(root, { loadedPlugin: loadedEvidence({ module_origin: "managed_cache" }) }),
      (error) => error.code === ERROR_CODES.DELIVERY_COMMAND_PROTOCOL_MISMATCH
        && error.details.command_major === WORK_CONTEXT_PROTOCOL.major + 1,
    );

    writeCommand(root, marker({ minor: WORK_CONTEXT_PROTOCOL.minor + 1, descriptor_hash: `sha256:${"0".repeat(64)}` }));
    const result = doctorDelivery(root, { loadedPlugin: loadedEvidence({ module_origin: "managed_cache" }) });
    assert.deepEqual(findingIds(result), [
      "command.descriptor_hash_mismatch",
      "command.protocol_minor_drift",
      "runtime.host_attestation_unavailable",
    ]);
    assert.match(result.findings.find((item) => item.id === "command.protocol_minor_drift").summary, /loaded plugin is older/);
    const repair = result.findings.find((item) => item.id === "command.descriptor_hash_mismatch").repair;
    assert.deepEqual(repair.steps, [
      `opencode plugin opencode-work-context@${VERSION} --force`,
      `npx --yes opencode-work-context@${VERSION} activate --force`,
      "Restart OpenCode.",
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("delivery doctor bounds unsafe and malformed observations without reading them", () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    write(outside, "command.md", `${WORK_CONTEXT_PROTOCOL_MARKER}\nsecret outside content\n`);
    fs.mkdirSync(path.join(root, ".opencode", "commands"), { recursive: true });
    fs.symlinkSync(path.join(outside, "command.md"), path.join(root, ".opencode", "commands", "wc.md"));
    write(root, ".opencode/opencode.json", "{invalid\n");
    write(root, "package.json", json({ devDependencies: { "opencode-work-context": VERSION, secret: "not returned" } }));

    const result = doctorDelivery(root, { loadedPlugin: loadedEvidence() });

    assert.equal(result.evidence.command.status, "unsafe");
    assert.equal(result.evidence.declarations.find((item) => item.source === "opencode").status, "malformed");
    assert.ok(findingIds(result).includes("command.unsafe"));
    assert.ok(findingIds(result).includes("declaration.opencode.malformed"));
    assert.doesNotMatch(JSON.stringify(result), /secret outside content|not returned/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("delivery doctor never returns credential-like declaration or manifest values", () => {
  const root = makeRoot();
  try {
    const credential = "git+https://token-value@example.test/package.git";
    writeCommand(root);
    write(root, ".opencode/opencode.json", json({ plugin: [`opencode-work-context@${credential}`] }));
    write(root, "package.json", json({ devDependencies: { "opencode-work-context": credential } }));
    write(root, "node_modules/opencode-work-context/package.json", json({ name: "opencode-work-context", version: credential }));

    const result = doctorDelivery(root, { loadedPlugin: loadedEvidence() });
    const serialized = JSON.stringify(result);

    assert.doesNotMatch(serialized, /token-value|example\.test|package\.git/);
    assert.ok(findingIds(result).includes("declaration.opencode.malformed"));
    assert.ok(findingIds(result).includes("installation.root.malformed"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("delivery doctor reports unknown loaded protocol and compares complete host evidence", () => {
  const root = makeRoot();
  try {
    writeCommand(root);
    write(root, ".opencode/opencode.json", json({ plugin: [`opencode-work-context@${VERSION}`] }));
    const unavailable = doctorDelivery(root, { loadedPlugin: { evidence_kind: "unavailable" } });
    assert.ok(findingIds(unavailable).includes("runtime.protocol_major_unknown"));

    const report = loadedEvidence({ module_origin: "managed_cache" });
    const attested = loadedEvidence({
      evidence_kind: "host_attested",
      package_version: "9.9.9",
      module_origin: "project_local",
      protocol: { ...report.protocol, minor: report.protocol.minor + 1, descriptor_hash: "0".repeat(64) },
    });
    const compared = doctorDelivery(root, { loadedPlugin: report, hostAttestation: attested });
    assert.ok(findingIds(compared).includes("runtime.host_protocol_minor_mismatch"));
    assert.ok(findingIds(compared).includes("runtime.host_hash_mismatch"));
    assert.ok(findingIds(compared).includes("runtime.host_version_mismatch"));
    assert.ok(findingIds(compared).includes("runtime.host_origin_mismatch"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("delivery doctor preserves typed synthetic host attestation", () => {
  const root = makeRoot();
  try {
    writeCommand(root);
    write(root, ".opencode/opencode.json", json({ plugin: [`opencode-work-context@${VERSION}`] }));
    const report = loadedEvidence({ module_origin: "managed_cache" });
    const result = doctorDelivery(root, { loadedPlugin: report, hostAttestation: { ...report, evidence_kind: "host_attested" } });
    assert.equal(result.evidence.host_attestation.evidence_kind, "host_attested");
    assert.equal(findingIds(result).includes("runtime.host_attestation_unavailable"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("delivery doctor tool factory works before a workspace exists and package wrapper remains exposed", async () => {
  const root = makeRoot();
  try {
    writeCommand(root);
    write(root, ".opencode/opencode.json", json({ plugin: [`opencode-work-context@${VERSION}`] }));
    const tools = createToolDefinitions({ runtimeEvidence: loadedEvidence({ module_origin: "managed_cache" }) });
    let metadataCalls = 0;
    const context = { directory: root, worktree: "/", sessionID: "doctor", metadata: async () => { metadataCalls += 1; } };

    const result = JSON.parse((await tools.work_context_doctor_delivery.execute({}, context)).output);

    assert.equal(result.ok, true);
    assert.equal(result.data.operation, "delivery.doctor");
    assert.equal(typeof doctorTool.execute, "function");
    assert.deepEqual(Object.keys(tools.work_context_doctor_delivery.args), []);
    assert.equal(metadataCalls, 0);

    const unsafeTools = createToolDefinitions({ runtimeEvidence: () => { throw new Error(`secret at ${root}`); } });
    const failed = JSON.parse((await unsafeTools.work_context_doctor_delivery.execute({}, context)).output);
    assert.equal(failed.error.code, ERROR_CODES.STORAGE_ERROR);
    assert.equal(failed.error.message, "Delivery doctor could not complete safely");
    assert.deepEqual(failed.error.details, {});
    assert.doesNotMatch(JSON.stringify(failed), /secret|work-context-doctor-test/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
