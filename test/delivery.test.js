import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { WorkContext, defaultConfig, loadConfig, readStagesSnapshot, renderStagesPanel } from "../src/index.js";
import { ERROR_CODES } from "../src/errors.js";
import tools from "../src/tool-definitions.js";
import explainDeliveryTool from "../tools/work_context_explain_delivery.js";

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const gitInput = (root, args, input) => execFileSync("git", args, { cwd: root, encoding: "utf8", input }).trim();
const makeRepository = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-context-delivery-test-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Delivery Test"]);
  git(root, ["config", "user.email", "delivery@example.test"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".work-context/local/*\n!.work-context/local/.gitignore\n");
  fs.writeFileSync(path.join(root, "app.txt"), "initial\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
};
const commitCandidate = (context, root, title, content) => {
  fs.writeFileSync(path.join(root, "app.txt"), `${content}\n`);
  const candidate = context.createCandidate("999901", title, null, { relatedStages: ["01"] }).data;
  context.captureCandidate("999901", candidate.candidate, { paths: ["app.txt"] });
  context.readyCandidate("999901", candidate.candidate);
  return context.commitCandidate("999901", candidate.candidate).data;
};
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

test("delivery context aggregates committed candidates and inspects only an explicit Git range", () => {
  const root = makeRepository();
  try {
    const initial = git(root, ["rev-parse", "HEAD"]);
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Delivery workspace", { workspace: "999901", sessionId: "planning", mode: "startup" });
    const first = commitCandidate(context, root, "First delivery change", "first");
    const second = commitCandidate(context, root, "Second delivery change", "second");

    const metadata = context.readDelivery("999901").data;
    assert.equal(metadata.committed.count, 2);
    assert.equal(metadata.plan_needed, true);
    assert.equal(metadata.range, undefined);
    const inspected = context.readDelivery("999901", { from: initial, to: second.commit_hash }).data;
    assert.equal(inspected.range.commit_count, 2);
    assert.deepEqual(inspected.range.commits, [first.commit_hash, second.commit_hash]);
    assert.deepEqual(inspected.range.changed_paths, ["app.txt"]);
    assert.throws(() => context.readDelivery("999901", { from: initial }), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
    assert.throws(() => context.readDelivery("999901", { from: second.commit_hash, to: initial }), (error) => error.code === ERROR_CODES.DELIVERY_INVALID_RANGE);

    const snapshot = readStagesSnapshot({ projectRoot: root, sessionId: "planning" });
    assert.deepEqual(snapshot.data.workspace.delivery, { committed: 2, plan_needed: true, environments: [] });
    assert.match(renderStagesPanel(snapshot), /Delivery 2 commits · ! plan/);
    assert.doesNotMatch(JSON.stringify(snapshot), /commit_hash|changed_paths/);
  } finally { cleanup(root); }
});

test("delivery explain is exposed through core, structured tools, and its package wrapper", async () => {
  const root = makeRepository();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Explain workspace", { workspace: "999901", sessionId: "planning", mode: "standard" });
    const from = git(root, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(root, "app.txt"), "explained\n");
    git(root, ["add", "app.txt"]);
    git(root, ["commit", "-qm", "explain change"]);
    const to = git(root, ["rev-parse", "HEAD"]);
    const findings = [{ id: "missing-test", severity: "warning", summary: "Add a test", affected_paths: ["./app.txt"], remediation_ids: ["add-test"], recommendation: "Add coverage" }];

    const core = context.explainDelivery("999901", from, to, findings);
    assert.equal(core.ok, true);
    assert.equal(core.data.operation, "delivery.explain");
    assert.equal(core.data.findings[0].matched_paths[0], "app.txt");

    const toolContext = { directory: root, worktree: root, sessionID: "planning", metadata: async () => {} };
    const structured = JSON.parse((await tools.work_context_explain_delivery.execute({ workspace: "999901", from, to, findings }, toolContext)).output);
    assert.deepEqual(structured, core);
    const wrapped = JSON.parse((await explainDeliveryTool.execute({ workspace: "999901", from, to }, toolContext)).output);
    assert.equal(wrapped.data.operation, "delivery.explain");
    assert.equal(tools.work_context_explain_delivery.args.findings.safeParse([{ id: "x", severity: "info", summary: "ok", unsupported: true }]).success, false);
  } finally { cleanup(root); }
});

test("confirmed delivery checkpoints track each environment without executing deployment", () => {
  const root = makeRepository();
  try {
    const context = WorkContext.open(root, { actor: "delivery-agent" });
    context.createWorkspace("Delivery workspace", { workspace: "999901", sessionId: "planning", mode: "startup" });
    const first = commitCandidate(context, root, "First delivery change", "first");
    const second = commitCandidate(context, root, "Second delivery change", "second");
    assert.throws(() => context.markDelivery("999901", "production", first.commit_hash, "yes"), (error) => error.code === ERROR_CODES.CONFIRMATION_REQUIRED);
    assert.equal(fs.existsSync(path.join(root, ".work-context", "local", "delivery", "999901.json")), false);

    const markedFirst = context.markDelivery("999901", "production", first.commit_hash, "DELIVERY_CONFIRMED").data;
    assert.deepEqual(markedFirst.checkpoint.deployed_candidates, [{ candidate: "CC-000001", commit_hash: first.commit_hash }]);
    let projection = context.deliveries().projection("999901");
    assert.equal(projection.environments[0].pending, 1);
    assert.match(renderStagesPanel(readStagesSnapshot({ projectRoot: root, sessionId: "planning" })), /Delivery production · 1 tracked pending/);

    context.markDelivery("999901", "production", second.commit_hash, "DELIVERY_CONFIRMED");
    projection = context.deliveries().projection("999901");
    assert.equal(projection.environments[0].pending, 0);
    assert.throws(() => context.markDelivery("999901", "production/secret", second.commit_hash, "DELIVERY_CONFIRMED"), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
    const stored = JSON.parse(fs.readFileSync(path.join(root, ".work-context", "local", "delivery", "999901.json"), "utf8"));
    assert.deepEqual(Object.keys(stored.environments.production).sort(), ["deployed_at", "deployed_candidates", "deployed_head", "integrity"]);
  } finally { cleanup(root); }
});

test("Planning resume receives delivery context and structured tools preserve explicit confirmation", async () => {
  const root = makeRepository();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Delivery workspace", { workspace: "999901", sessionId: "planning", mode: "startup" });
    const committed = commitCandidate(context, root, "Delivery change", "changed");
    context.handoff("999901", "01", "planning");
    const resumed = context.startSession("999901", "01", { sessionId: "planning-resumed", opencodeSessionId: "oc-planning" });
    assert.equal(resumed.data.resume.context.delivery_context.committed.count, 1);
    assert.match(resumed.data.resume.instruction, /repository's own deployment documentation/);
    assert.match(resumed.data.resume.instruction, /Never persist secret values/);

    const toolContext = { directory: root, worktree: root, sessionID: "oc-planning", metadata: async () => {} };
    const read = JSON.parse((await tools.work_context_read_delivery.execute({ workspace: "999901" }, toolContext)).output);
    assert.equal(read.data.committed.count, 1);
    const rejected = JSON.parse((await tools.work_context_mark_delivery.execute({ workspace: "999901", environment: "production", commit: committed.commit_hash, confirmation: "no" }, toolContext)).output);
    assert.equal(rejected.error.code, ERROR_CODES.CONFIRMATION_REQUIRED);
    const marked = JSON.parse((await tools.work_context_mark_delivery.execute({ workspace: "999901", environment: "production", commit: committed.commit_hash, confirmation: "DELIVERY_CONFIRMED" }, toolContext)).output);
    assert.equal(marked.data.environment, "production");
  } finally { cleanup(root); }
});

test("delivery checkpoints are mode-neutral while implementation stages omit Planning delivery context", () => {
  const root = makeRepository();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Standard delivery", { workspace: "999901", sessionId: "planning" });
    context.addStage("999901", "Implementation", { prompt: "Implement without delivery context." });
    const head = git(root, ["rev-parse", "HEAD"]);
    context.markDelivery("999901", "staging", head, "DELIVERY_CONFIRMED");
    const projection = context.deliveries().projection("999901");
    assert.deepEqual(projection.environments.map(({ environment, pending }) => ({ environment, pending })), [{ environment: "staging", pending: 0 }]);
    const started = context.startSession("999901", "02", { sessionId: "implementation", opencodeSessionId: "oc-implementation" });
    assert.equal(started.data.resume.context.delivery_context, undefined);
    assert.equal(started.data.resume.context.workflow_policy, undefined);
  } finally { cleanup(root); }
});

test("startup candidate checkpoints remain correct after switching the workspace to standard mode", () => {
  const root = makeRepository();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Mode transition", { workspace: "999901", sessionId: "planning", mode: "startup" });
    const committed = commitCandidate(context, root, "Committed before mode change", "changed");
    context.setWorkspaceMode("999901", "standard");
    const marked = context.markDelivery("999901", "production", committed.commit_hash, "DELIVERY_CONFIRMED").data;
    assert.deepEqual(marked.checkpoint.deployed_candidates, [{ candidate: "CC-000001", commit_hash: committed.commit_hash }]);
    assert.equal(context.deliveries().projection("999901").environments[0].pending, 0);
  } finally { cleanup(root); }
});

test("delivery projections surface corrupt or inconsistent local checkpoints as unavailable", () => {
  const root = makeRepository();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Corrupt delivery", { workspace: "999901", sessionId: "planning", mode: "startup" });
    const committed = commitCandidate(context, root, "Delivery change", "changed");
    const later = commitCandidate(context, root, "Later delivery change", "later");
    context.markDelivery("999901", "production", committed.commit_hash, "DELIVERY_CONFIRMED");
    const file = path.join(root, ".work-context", "local", "delivery", "999901.json");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.environments.production.deployed_candidates.push({ candidate: "CC-000002", commit_hash: later.commit_hash });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    assert.equal(context.deliveries().projection("999901").unavailable, true);
    assert.match(renderStagesPanel(readStagesSnapshot({ projectRoot: root, sessionId: "planning" })), /Delivery ! unavailable/);

    fs.writeFileSync(file, "{invalid\n");
    assert.equal(context.deliveries().projection("999901").unavailable, true);
    assert.throws(() => context.readDelivery("999901"), (error) => error.code === ERROR_CODES.STORAGE_ERROR);
  } finally { cleanup(root); }
});

test("bounded delivery ranges retain the earliest commits after the baseline", () => {
  const root = makeRepository();
  try {
    const from = git(root, ["rev-parse", "HEAD"]);
    const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
    const commits = [];
    let parent = from;
    for (let index = 0; index < 505; index += 1) {
      parent = gitInput(root, ["commit-tree", tree, "-p", parent], `delivery commit ${index}\n`);
      commits.push(parent);
    }
    git(root, ["update-ref", "HEAD", parent, from]);
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Long delivery range", { workspace: "999901", sessionId: "planning" });
    const range = context.readDelivery("999901", { from, to: parent }).data.range;
    assert.equal(range.commit_count, 505);
    assert.equal(range.commits.length, 500);
    assert.equal(range.commits[0], commits[0]);
    assert.equal(range.commits.at(-1), commits[499]);
    assert.equal(range.commits_truncated, true);
  } finally { cleanup(root); }
});

test("delivery explain attributes exact-range candidates and preserves direct commits", () => {
  const root = makeRepository();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Explain startup", { workspace: "999901", sessionId: "planning", mode: "startup" });
    const outside = commitCandidate(context, root, "Outside range", "outside");
    git(root, ["reset", "-q", "HEAD"]);
    const initial = outside.commit_hash;
    const candidate = commitCandidate(context, root, "Candidate change", "candidate");
    git(root, ["reset", "-q", "HEAD"]);
    fs.writeFileSync(path.join(root, "direct.txt"), "direct\n");
    git(root, ["add", "direct.txt"]);
    git(root, ["commit", "-qm", "direct change"]);
    const direct = git(root, ["rev-parse", "HEAD"]);
    const statusBefore = git(root, ["status", "--porcelain=v1"]);

    const explained = context.deliveries().explain("999901", {
      from: initial,
      to: direct,
      findings: [{
        id: "release.review",
        severity: "warning",
        summary: "Review affected paths",
        affected_paths: ["././app.txt", "missing.txt"],
        remediation_ids: ["release.verify"],
        recommendation: "Verify before delivery",
      }],
    });
    assert.equal(explained.complete, true);
    assert.equal(explained.candidate_traceability.capability, "available");
    assert.deepEqual(explained.candidate_traceability.candidates, [{
      candidate: "CC-000002",
      strategy: "exact",
      related_stages: ["01"],
      commits: [candidate.commit_hash],
      paths: ["app.txt"],
    }]);
    assert.deepEqual(explained.candidate_traceability.direct_commits, [direct]);
    assert.deepEqual(explained.findings[0].matched_paths, ["app.txt"]);
    assert.deepEqual(explained.findings[0].unmatched_paths, ["missing.txt"]);
    assert.equal(explained.findings[0].recommendation, "Verify before delivery");
    assert.deepEqual(explained.candidate_slice, []);
    assert.equal(git(root, ["status", "--porcelain=v1"]), statusBefore);
    assert.equal(fs.existsSync(path.join(root, ".work-context", "local", "delivery", "999901.json")), false);

    context.setWorkspaceMode("999901", "standard");
    const standard = context.deliveries().explain("999901", { from: initial, to: direct });
    assert.deepEqual(standard.candidate_traceability, { capability: "unavailable", candidates: [], direct_commits: [] });
  } finally { cleanup(root); }
});

test("delivery explain redacts final, lineage, finding, and traceability paths deterministically", () => {
  const root = makeRepository();
  try {
    const initial = git(root, ["rev-parse", "HEAD"]);
    const context = WorkContext.open(root, { actor: "test", config: { delivery: { secret_path_patterns: ["secret/**"] } } });
    context.createWorkspace("Explain redaction", { workspace: "999901", sessionId: "planning", mode: "startup" });
    fs.mkdirSync(path.join(root, "secret"));
    fs.writeFileSync(path.join(root, "secret", "old.txt"), "secret\n");
    let candidate = context.createCandidate("999901", "Secret addition", null, { relatedStages: ["01"] }).data;
    context.captureCandidate("999901", candidate.candidate, { paths: ["secret/old.txt"] });
    context.readyCandidate("999901", candidate.candidate);
    context.commitCandidate("999901", candidate.candidate);
    fs.renameSync(path.join(root, "secret", "old.txt"), path.join(root, "secret", "new.txt"));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "rename secret path"]);
    const to = git(root, ["rev-parse", "HEAD"]);

    const explained = context.deliveries().explain("999901", {
      from: initial,
      to,
      findings: [{ id: "release.secret", severity: "error", summary: "Review secret/new.txt", affected_paths: ["secret/new.txt"], remediation_ids: [] }],
    });
    const serialized = JSON.stringify(explained);
    assert.doesNotMatch(serialized, /secret\/(?:old|new)\.txt/u);
    assert.deepEqual(explained.redactions, {
      applied: true,
      path_count: 2,
      tokens: ["<redacted:path-0001>", "<redacted:path-0002>"],
    });
    assert.equal(explained.paths.find((item) => item.path === "<redacted:path-0001>")?.path, "<redacted:path-0001>");
    assert.equal(explained.lineage[0].from_path, "<redacted:path-0002>");
    assert.equal(explained.lineage[0].to_path, "<redacted:path-0001>");
    assert.deepEqual(explained.candidate_traceability.candidates[0].paths, ["<redacted:path-0002>"]);
    assert.equal(explained.findings[0].summary, "Review <redacted:path-0001>");
    assert.deepEqual(explained.findings[0].affected_paths, ["<redacted:path-0001>"]);
    assert.deepEqual(explained.candidate_slice[0].path_references, ["<redacted:path-0001>"]);
    assert.deepEqual(explained.candidate_slice[0].finding_references, ["release.secret"]);
    assert.equal(explained.candidate_slice[0].requires_user_decision, true);
  } finally { cleanup(root); }
});

test("delivery secret path config is additive and rejects unsupported glob syntax", () => {
  const root = makeRepository();
  try {
    const configFile = path.join(root, ".work-context", "config.yaml");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, defaultConfig());
    assert.deepEqual(loadConfig(root).delivery.secret_path_patterns, []);
    fs.writeFileSync(configFile, `${defaultConfig()}delivery:\n  secret_path_patterns: ["secret/**", "*.env"]\n`);
    assert.deepEqual(loadConfig(root).delivery.secret_path_patterns, ["secret/**", "*.env"]);
    for (const pattern of ["/absolute", "a/**b", "a/../b", "a\\b", "!secret", "a/[b]"]) {
      fs.writeFileSync(configFile, `${defaultConfig()}delivery:\n  secret_path_patterns: ${JSON.stringify([pattern])}\n`);
      assert.throws(() => loadConfig(root), (error) => error.code === ERROR_CODES.STORAGE_ERROR);
    }
    fs.writeFileSync(configFile, `${defaultConfig()}delivery:\n  secret_path_patterns: ${JSON.stringify(Array.from({ length: 101 }, (_, index) => `secret-${index}`))}\n`);
    assert.throws(() => loadConfig(root), (error) => error.code === ERROR_CODES.STORAGE_ERROR);
    fs.writeFileSync(configFile, `${defaultConfig()}delivery:\n  secret_path_patterns: ${JSON.stringify(["x".repeat(257)])}\n`);
    assert.throws(() => loadConfig(root), (error) => error.code === ERROR_CODES.STORAGE_ERROR);
  } finally { cleanup(root); }
});

test("delivery explain fails closed when path evidence is truncated", () => {
  const root = makeRepository();
  try {
    const from = git(root, ["rev-parse", "HEAD"]);
    for (let index = 0; index <= 500; index += 1) fs.writeFileSync(path.join(root, `path-${String(index).padStart(3, "0")}.txt`), `${index}\n`);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "many paths"]);
    const to = git(root, ["rev-parse", "HEAD"]);
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Explain truncation", { workspace: "999901", sessionId: "planning" });
    const explained = context.deliveries().explain("999901", {
      from,
      to,
      findings: [{ id: "release.large", severity: "warning", summary: "Large change", affected_paths: ["path-500.txt"], remediation_ids: [], recommendation: "Split it" }],
    });
    assert.equal(explained.complete, false);
    assert.equal(explained.limits.paths.truncated, true);
    assert.equal("recommendation" in explained.findings[0], false);
    assert.equal("matched_paths" in explained.findings[0], false);
    assert.equal("unmatched_paths" in explained.findings[0], false);
    assert.deepEqual(explained.candidate_slice, []);
  } finally { cleanup(root); }
});
