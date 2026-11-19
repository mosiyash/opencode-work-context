import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  DELIVERY_DIAGNOSTIC_LIMITS,
  DELIVERY_EXPLAIN_CONTRACT_VERSION,
  createDeliveryPathRedactor,
  deliveryDiagnosticComplete,
  inspectDetailedCommitRange,
  sanitizeDeliveryCommitSubject,
  validateDeliveryExplainEnvelope,
  validateDeliveryFindings,
  validateDeliveryStableId,
} from "../src/index.js";
import { ERROR_CODES } from "../src/errors.js";

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = (root, subject) => git(root, ["commit", "-qam", subject]);
const makeRepository = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-context-delivery-contracts-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Delivery Contracts Test"]);
  git(root, ["config", "user.email", "delivery-contracts@example.test"]);
  fs.writeFileSync(path.join(root, "old.txt"), "one\n");
  fs.writeFileSync(path.join(root, "delete.txt"), "delete\n");
  fs.writeFileSync(path.join(root, "modify.txt"), "before\n");
  fs.writeFileSync(path.join(root, "copy-source.txt"), "copy source\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
};

test("delivery finding contracts normalize valid input and reject malformed structures", () => {
  const findings = validateDeliveryFindings([{
    id: "release.config-check",
    severity: "warning",
    summary: "  Review the configuration change.  ",
    affected_paths: ["config/app.json"],
    remediation_ids: ["deploy.review-config"],
    recommendation: "  Verify the target environment.  ",
  }]);
  assert.deepEqual(findings, [{
    id: "release.config-check",
    severity: "warning",
    summary: "Review the configuration change.",
    affected_paths: ["config/app.json"],
    remediation_ids: ["deploy.review-config"],
    recommendation: "Verify the target environment.",
  }]);
  assert.equal(validateDeliveryStableId("release.valid-id_2"), "release.valid-id_2");
  assert.throws(() => validateDeliveryStableId("Release.Invalid"), (error) => error.code === ERROR_CODES.DELIVERY_INVALID_FINDINGS);
  assert.throws(() => validateDeliveryFindings([{ ...findings[0], unknown: true }]), (error) => error.code === ERROR_CODES.DELIVERY_INVALID_FINDINGS);
  assert.throws(() => validateDeliveryFindings([{ ...findings[0], affected_paths: ["same", "same"] }]), (error) => error.code === ERROR_CODES.DELIVERY_INVALID_FINDINGS);
  assert.throws(() => validateDeliveryFindings(Array.from({ length: DELIVERY_DIAGNOSTIC_LIMITS.findings + 1 }, () => ({}))), (error) => error.code === ERROR_CODES.DELIVERY_INVALID_FINDINGS);
});

test("delivery envelope validation enforces completeness and the serialized hard cap", () => {
  const envelope = {
    contract_version: DELIVERY_EXPLAIN_CONTRACT_VERSION,
    operation: "delivery.explain",
    immutable_range: { from: "a".repeat(40), to: "b".repeat(40) },
    limits: { commits_truncated: false, paths: { truncated: false } },
    summary: {},
    paths: [],
    findings: [],
    candidate_traceability: {},
    candidate_slice: [],
    redactions: {},
    complete: true,
  };
  assert.equal(validateDeliveryExplainEnvelope(envelope), envelope);
  assert.equal(deliveryDiagnosticComplete(envelope.limits), true);
  assert.equal(deliveryDiagnosticComplete({ paths: { truncated: true } }), false);
  assert.throws(() => validateDeliveryExplainEnvelope({ ...envelope, complete: false, findings: [{ recommendation: "Do it" }] }), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
  assert.throws(() => validateDeliveryExplainEnvelope({ ...envelope, complete: false, candidate_slice: [{}] }), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
  assert.throws(() => validateDeliveryExplainEnvelope({ ...envelope, candidate_slice: [{}] }), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
  assert.throws(() => validateDeliveryExplainEnvelope({ ...envelope, summary: { padding: "x".repeat(DELIVERY_DIAGNOSTIC_LIMITS.diagnostic_bytes) } }), (error) => error.code === ERROR_CODES.DELIVERY_DIAGNOSTIC_TOO_LARGE);
});

test("delivery path redaction implements segment globs and canonical opaque tokens", () => {
  const redactor = createDeliveryPathRedactor(["*.env", "secret/**", "config/**/private.*"], [
    "nested/app.env",
    "secret/z.txt",
    "config/private.json",
    ".env",
    "config/a/b/private.yaml",
    "secret/a.txt",
  ]);
  assert.equal(redactor.path("nested/app.env"), "nested/app.env");
  assert.equal(redactor.path(".env"), "<redacted:path-0001>");
  assert.equal(redactor.path("config/a/b/private.yaml"), "<redacted:path-0002>");
  assert.equal(redactor.path("config/private.json"), "<redacted:path-0003>");
  assert.equal(redactor.path("secret/a.txt"), "<redacted:path-0004>");
  assert.equal(redactor.path("secret/z.txt"), "<redacted:path-0005>");
  assert.equal(redactor.text("Review secret/z.txt"), "Review <redacted:path-0005>");
});

test("detailed Git evidence uses final paths, separate rename lineage, and deterministic provenance", () => {
  const root = makeRepository();
  try {
    const from = git(root, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(root, "old.txt"), "one\ntwo\n");
    commit(root, "modify old path");
    const modified = git(root, ["rev-parse", "HEAD"]);
    fs.renameSync(path.join(root, "old.txt"), path.join(root, "renamed.txt"));
    fs.rmSync(path.join(root, "delete.txt"));
    fs.writeFileSync(path.join(root, "added.txt"), "added\n");
    fs.writeFileSync(path.join(root, "modify.txt"), "after\n");
    fs.copyFileSync(path.join(root, "copy-source.txt"), path.join(root, "copied.txt"));
    fs.writeFileSync(path.join(root, "copy-source.txt"), "copy source changed\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "rename and update"]);
    const to = git(root, ["rev-parse", "HEAD"]);

    const first = inspectDetailedCommitRange(root, from, to);
    const second = inspectDetailedCommitRange(root, from, to);
    assert.deepEqual(second, first);
    assert.deepEqual(first.commits.map(({ commit: hash }) => hash), [modified, to]);
    assert.deepEqual(first.paths.map(({ path: file, status }) => [file, status]), [
      ["added.txt", "added"],
      ["copied.txt", "copied"],
      ["copy-source.txt", "modified"],
      ["delete.txt", "deleted"],
      ["modify.txt", "modified"],
      ["renamed.txt", "renamed"],
    ]);
    const renamed = first.paths.find(({ path: file }) => file === "renamed.txt");
    assert.deepEqual(renamed.provenance, [to]);
    assert.deepEqual(first.lineage, [
      { commit: to, status: "copied", similarity: 100, from_path: "copy-source.txt", to_path: "copied.txt" },
      { commit: to, status: "renamed", similarity: 100, from_path: "old.txt", to_path: "renamed.txt" },
    ]);
    assert.equal("patch" in first, false);
    assert.equal("stderr" in first, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("detailed Git evidence compares merges to the first parent and sanitizes subjects", () => {
  const root = makeRepository();
  try {
    const from = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-qb", "side"]);
    fs.writeFileSync(path.join(root, "side.txt"), "side\n");
    git(root, ["add", "side.txt"]);
    git(root, ["commit", "-qm", "side change"]);
    const side = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-q", "master"]);
    fs.writeFileSync(path.join(root, "main.txt"), "main\n");
    git(root, ["add", "main.txt"]);
    git(root, ["commit", "-qm", "main change"]);
    const main = git(root, ["rev-parse", "HEAD"]);
    git(root, ["merge", "--no-ff", "-qm", "merge side", "side"]);
    const merge = git(root, ["rev-parse", "HEAD"]);

    const evidence = inspectDetailedCommitRange(root, from, merge);
    assert.deepEqual(evidence.commits.map(({ commit: hash }) => hash), [main, merge]);
    assert.equal(evidence.commits.some(({ commit: hash }) => hash === side), false);
    assert.deepEqual(evidence.paths.find(({ path: file }) => file === "side.txt").provenance, [merge]);
    assert.equal(sanitizeDeliveryCommitSubject(" deploy\n\tsecret\u2028 now "), "deploy secret now");
    const bounded = sanitizeDeliveryCommitSubject("a".repeat(199) + "éé");
    assert.ok(Buffer.byteLength(bounded, "utf8") <= DELIVERY_DIAGNOSTIC_LIMITS.commit_subject_bytes);
    assert.equal(bounded.endsWith("�"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("detailed Git evidence rejects non-lowercase and non-ancestor endpoints", () => {
  const root = makeRepository();
  try {
    const from = git(root, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(root, "old.txt"), "changed\n");
    commit(root, "change");
    const to = git(root, ["rev-parse", "HEAD"]);
    assert.throws(() => inspectDetailedCommitRange(root, from.toUpperCase(), to), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
    assert.throws(() => inspectDetailedCommitRange(root, to, from), (error) => error.code === ERROR_CODES.DELIVERY_INVALID_RANGE);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("detailed Git evidence bounds final paths and per-path provenance", () => {
  const root = makeRepository();
  try {
    const from = git(root, ["rev-parse", "HEAD"]);
    for (let index = 0; index <= DELIVERY_DIAGNOSTIC_LIMITS.paths; index += 1) {
      fs.writeFileSync(path.join(root, `generated-${String(index).padStart(3, "0")}.txt`), `${index}\n`);
    }
    fs.writeFileSync(path.join(root, "000-hot.txt"), "0\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "add generated paths"]);
    for (let index = 1; index <= DELIVERY_DIAGNOSTIC_LIMITS.provenance_commits_per_path; index += 1) {
      fs.writeFileSync(path.join(root, "000-hot.txt"), `${index}\n`);
      commit(root, `update hot path ${index}`);
    }
    fs.writeFileSync(path.join(root, "000-hot.txt"), "overflow\n");
    commit(root, "overflow hot path provenance");
    const to = git(root, ["rev-parse", "HEAD"]);

    const evidence = inspectDetailedCommitRange(root, from, to);
    assert.equal(evidence.path_count, DELIVERY_DIAGNOSTIC_LIMITS.paths + 2);
    assert.equal(evidence.paths.length, DELIVERY_DIAGNOSTIC_LIMITS.paths);
    assert.equal(evidence.paths_truncated, true);
    const hot = evidence.paths.find(({ path: file }) => file === "000-hot.txt");
    assert.equal(hot.provenance.length, DELIVERY_DIAGNOSTIC_LIMITS.provenance_commits_per_path);
    assert.equal(hot.provenance_truncated, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
