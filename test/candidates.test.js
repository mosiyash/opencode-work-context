import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { WorkContext, readStagesSnapshot, readWorkContextSnapshot, renderStagesPanel } from "../src/index.js";
import { ERROR_CODES } from "../src/errors.js";
import tools from "../src/tool-definitions.js";

const git = (root, args, options = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", ...options });
const makeRepository = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-context-candidate-test-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Candidate Test"]);
  git(root, ["config", "user.email", "candidate@example.test"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".work-context/local/*\n!.work-context/local/.gitignore\n");
  fs.writeFileSync(path.join(root, "app.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(root, "delete.txt"), "remove me\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
};
const openStartup = (root, workspace = "999901") => {
  const context = WorkContext.open(root, { actor: "test" });
  context.createWorkspace("Candidate workspace", { workspace, sessionId: `session-${workspace}`, mode: "startup" });
  return context;
};
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const prepareCandidate = (context, root, title, paths, message = title) => {
  const candidate = context.createCandidate("999901", title, message).data;
  context.captureCandidate("999901", candidate.candidate, { paths });
  context.readyCandidate("999901", candidate.candidate);
  return candidate.candidate;
};

test("path capture snapshots tracked, deleted, and untracked files without changing the ordinary index", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "app.txt"), "one\nchanged\nthree\n");
    fs.rmSync(path.join(root, "delete.txt"));
    fs.writeFileSync(path.join(root, "new.txt"), "new file\n");
    fs.writeFileSync(path.join(root, "indexed.txt"), "ordinary index\n");
    git(root, ["add", "indexed.txt"]);
    const indexBefore = fs.readFileSync(path.join(root, ".git", "index"));

    const created = context.createCandidate("999901", "Ready subset", "Ship selected files").data;
    assert.equal(created.candidate, "CC-000001");
    assert.equal(created.status, "draft");
    const captured = context.captureCandidate("999901", created.candidate, { paths: ["app.txt", "delete.txt", "new.txt"] }).data;

    assert.deepEqual(captured.selected_paths, ["app.txt", "delete.txt", "new.txt"]);
    assert.match(captured.patch, /diff --git a\/app\.txt b\/app\.txt/);
    assert.match(captured.patch, /deleted file mode/);
    assert.match(captured.patch, /new file mode/);
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), indexBefore);
    assert.equal(fs.readFileSync(path.join(root, "app.txt"), "utf8"), "one\nchanged\nthree\n");

    const preview = context.previewCandidate("999901", created.candidate).data;
    assert.equal(preview.preview.stale, false);
    assert.match(preview.preview.stat, /3 files changed/);
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), indexBefore);
    assert.equal(context.readyCandidate("999901", created.candidate).data.status, "ready");
    assert.equal(context.listCandidates("999901").data[0].status, "ready");
    assert.equal(context.showCandidate("999901", created.candidate).data.patch, captured.patch);
    assert.equal(context.discardCandidate("999901", created.candidate).data.status, "discarded");
  } finally { cleanup(root); }
});

test("exact patch capture can select one hunk while unrelated work remains", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "app.txt"), "ONE\ntwo\nTHREE\n");
    const patch = [
      "diff --git a/app.txt b/app.txt",
      "--- a/app.txt",
      "+++ b/app.txt",
      "@@ -1,2 +1,2 @@",
      "-one",
      "+ONE",
      " two",
      "",
    ].join("\n");
    const candidate = context.createCandidate("999901", "First hunk").data;
    const captured = context.captureCandidate("999901", candidate.candidate, { patch }).data;

    assert.deepEqual(captured.selected_paths, ["app.txt"]);
    assert.match(captured.patch, /\+ONE/);
    assert.doesNotMatch(captured.patch, /THREE/);
    assert.equal(fs.readFileSync(path.join(root, "app.txt"), "utf8"), "ONE\ntwo\nTHREE\n");
  } finally { cleanup(root); }
});

test("candidate operations enforce startup mode, repository boundaries, and supported patches", () => {
  const root = makeRepository();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Standard workspace", { workspace: "999902", sessionId: "standard" });
    assert.throws(() => context.createCandidate("999902", "Not allowed"), (error) => error.code === ERROR_CODES.CANDIDATE_MODE_REQUIRED);

    context.setWorkspaceMode("999902", "startup");
    const candidate = context.createCandidate("999902", "Validation").data;
    assert.throws(() => context.captureCandidate("999902", candidate.candidate, { paths: ["../outside.txt"] }), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
    assert.throws(() => context.captureCandidate("999902", candidate.candidate, { paths: [".work-context/local/candidates"] }), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
    assert.throws(() => context.captureCandidate("999902", candidate.candidate, { patch: "not a patch" }), (error) => error.code === ERROR_CODES.CANDIDATE_INVALID_PATCH);
    assert.throws(() => context.captureCandidate("999902", candidate.candidate, { patch: "diff --git a/a b/a\nGIT binary patch\n" }), (error) => error.code === ERROR_CODES.CANDIDATE_UNSUPPORTED);
    assert.throws(() => context.captureCandidate("999902", candidate.candidate, { patch: "diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-one\n+not-in-the-worktree\n" }), (error) => error.code === ERROR_CODES.CANDIDATE_INVALID_PATCH);
    assert.throws(() => context.captureCandidate("999902", candidate.candidate, { patch: "diff --git a/submodule b/submodule\nnew file mode 160000\nindex 0000000..1234567\n--- /dev/null\n+++ b/submodule\n@@ -0,0 +1 @@\n+Subproject commit 1234567890123456789012345678901234567890\n" }), (error) => error.code === ERROR_CODES.CANDIDATE_UNSUPPORTED);
    assert.throws(() => context.readyCandidate("999902", candidate.candidate), (error) => error.code === ERROR_CODES.INVALID_STATE);
  } finally { cleanup(root); }
});

test("binary path capture and malformed or stale candidate data fail with stable errors", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    const binary = context.createCandidate("999901", "Binary").data;
    assert.throws(() => context.captureCandidate("999901", binary.candidate, { paths: ["binary.dat"] }), (error) => error.code === ERROR_CODES.CANDIDATE_UNSUPPORTED);

    fs.writeFileSync(path.join(root, "app.txt"), "changed\n");
    const stale = context.createCandidate("999901", "Stale").data;
    context.captureCandidate("999901", stale.candidate, { paths: ["app.txt"] });
    const file = path.join(root, ".work-context", "local", "candidates", `${stale.candidate}.json`);
    const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
    metadata.base_head = "0".repeat(40);
    fs.writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
    assert.throws(() => context.previewCandidate("999901", stale.candidate), (error) => error.code === ERROR_CODES.CANDIDATE_STALE_BASE);

    metadata.schema = 2;
    fs.writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
    assert.throws(() => context.showCandidate("999901", stale.candidate), (error) => error.code === ERROR_CODES.STORAGE_ERROR);
  } finally { cleanup(root); }
});

test("candidate strategy and related stages are normalized, validated, and preserve legacy records", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    context.addStage("999901", "Second stage", { prompt: "Continue the shared change." });
    const shared = context.createCandidate("999901", "Shared foundation", null, { strategy: "shared_foundation", relatedStages: ["1", "02"] }).data;
    assert.equal(shared.strategy, "shared_foundation");
    assert.deepEqual(shared.related_stages, ["01", "02"]);
    assert.deepEqual(context.listCandidates("999901").data[0].related_stages, ["01", "02"]);

    assert.throws(() => context.createCandidate("999901", "Invalid strategy", null, { strategy: "shared" }), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
    assert.throws(() => context.createCandidate("999901", "Duplicate stages", null, { relatedStages: ["1", "01"] }), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);
    assert.throws(() => context.createCandidate("999901", "Malformed stage", null, { relatedStages: ["stage-1"] }), (error) => error.code === ERROR_CODES.INVALID_ARGUMENT);

    const foreign = WorkContext.open(root, { actor: "test" });
    foreign.createWorkspace("Foreign workspace", { workspace: "999902", sessionId: "foreign", mode: "startup" });
    foreign.addStage("999902", "Foreign second stage", { prompt: "Foreign work." });
    foreign.addStage("999902", "Foreign third stage", { prompt: "Foreign work." });
    assert.throws(() => context.createCandidate("999901", "Foreign stage", null, { relatedStages: ["03"] }), (error) => error.code === ERROR_CODES.NOT_FOUND);

    const file = path.join(root, ".work-context", "local", "candidates", `${shared.candidate}.json`);
    const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
    delete legacy.strategy;
    delete legacy.related_stages;
    fs.writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`);
    assert.equal(context.showCandidate("999901", shared.candidate).data.strategy, undefined);
  } finally { cleanup(root); }
});

test("path capture supports renames and preview reports a changed HEAD", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.renameSync(path.join(root, "app.txt"), path.join(root, "renamed.txt"));
    const candidate = context.createCandidate("999901", "Rename").data;
    const captured = context.captureCandidate("999901", candidate.candidate, { paths: ["app.txt", "renamed.txt"] }).data;
    assert.match(captured.patch, /similarity index 100%/);
    assert.match(captured.patch, /rename from app\.txt/);
    assert.match(captured.patch, /rename to renamed\.txt/);

    fs.writeFileSync(path.join(root, "head-change.txt"), "advance HEAD\n");
    git(root, ["add", "head-change.txt"]);
    git(root, ["commit", "-qm", "advance"]);
    const preview = context.previewCandidate("999901", candidate.candidate).data.preview;
    assert.equal(preview.stale, true);
    assert.notEqual(preview.current_head, candidate.base_head);
  } finally { cleanup(root); }
});

test("candidate creation reports repositories without Git or HEAD", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-context-no-git-test-"));
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("No Git", { workspace: "999903", sessionId: "no-git", mode: "startup" });
    assert.throws(() => context.createCandidate("999903", "No repository"), (error) => error.code === ERROR_CODES.NOT_GIT_REPOSITORY);

    git(root, ["init", "-q"]);
    assert.throws(() => context.createCandidate("999903", "No HEAD"), (error) => error.code === ERROR_CODES.CANDIDATE_STALE_BASE);
  } finally { cleanup(root); }
});

test("structured candidate tools expose strategy and stage traceability through the local lifecycle", async () => {
  const root = makeRepository();
  try {
    openStartup(root);
    const context = WorkContext.open(root, { actor: "test" });
    context.addStage("999901", "Tool stage", { prompt: "Test candidate traceability." });
    fs.writeFileSync(path.join(root, "app.txt"), "tool capture\n");
    const toolContext = { directory: root, worktree: root, sessionID: "tool-session", metadata: async () => {} };
    const created = JSON.parse((await tools.work_context_create_candidate.execute({ workspace: "999901", title: "Tool candidate", strategy: "integration", relatedStages: ["1", "2"] }, toolContext)).output);
    const captured = JSON.parse((await tools.work_context_capture_candidate.execute({ workspace: "999901", candidateId: created.data.candidate, paths: ["app.txt"] }, toolContext)).output);
    const ready = JSON.parse((await tools.work_context_ready_candidate.execute({ workspace: "999901", candidateId: created.data.candidate }, toolContext)).output);

    assert.equal(created.ok, true);
    assert.equal(created.data.strategy, "integration");
    assert.deepEqual(created.data.related_stages, ["01", "02"]);
    assert.match(captured.data.patch, /tool capture/);
    assert.equal(ready.data.status, "ready");
    assert.equal(JSON.parse((await tools.work_context_preview_candidate.execute({ workspace: "999901", candidateId: created.data.candidate }, toolContext)).output).data.candidate.strategy, "integration");
    assert.equal(JSON.parse((await tools.work_context_show_candidate.execute({ workspace: "999901", candidateId: created.data.candidate }, toolContext)).output).data.strategy, "integration");
    assert.equal(JSON.parse((await tools.work_context_list_candidates.execute({ workspace: "999901" }, toolContext)).output).data[0].strategy, "integration");
  } finally { cleanup(root); }
});

test("read-only snapshots expose active candidate counts and explicit stage relations", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    context.addStage("999901", "Related stage", { prompt: "Continue related work." });
    fs.writeFileSync(path.join(root, "app.txt"), "snapshot candidate\n");
    const pending = context.createCandidate("999901", "Pending candidate", null, { strategy: "integration", relatedStages: ["01", "02"] }).data;
    const ready = context.createCandidate("999901", "Ready candidate", null, { strategy: "exact", relatedStages: ["02"] }).data;
    context.captureCandidate("999901", ready.candidate, { paths: ["app.txt"] });
    context.readyCandidate("999901", ready.candidate);
    const discarded = context.createCandidate("999901", "Discarded candidate").data;
    context.discardCandidate("999901", discarded.candidate);
    fs.writeFileSync(path.join(root, ".work-context", "local", "candidates", "CC-999999.json"), "{invalid\n");

    const stages = readStagesSnapshot({ projectRoot: root, sessionId: "session-999901" });
    const workContext = readWorkContextSnapshot({ projectRoot: root, sessionId: "session-999901" });
    assert.deepEqual(stages.data.workspace.candidates, { pending: 1, ready: 1 });
    assert.deepEqual(workContext.data.workspaces[0].candidates, { pending: 1, ready: 1 });
    assert.deepEqual(stages.data.stages[0].candidates, { draft: 1, ready: 0, items: [{ candidate: pending.candidate, title: "Pending candidate", status: "draft", strategy: "integration", related_stages: ["01", "02"] }] });
    assert.deepEqual(stages.data.stages[1].candidates.items.map(({ status, strategy }) => ({ status, strategy })), [
      { status: "draft", strategy: "integration" },
      { status: "ready", strategy: "exact" },
    ]);
    assert.deepEqual({ draft: stages.data.stages[1].candidates.draft, ready: stages.data.stages[1].candidates.ready }, { draft: 1, ready: 1 });
    assert.deepEqual(workContext.data.workspaces[0].stages[0].candidates, stages.data.stages[0].candidates);
    assert.match(renderStagesPanel(stages), /Candidates …1 ✓1/);
    assert.match(renderStagesPanel(stages), /Pending: draft · integration · also 02/);
    assert.match(renderStagesPanel(stages), /Pending: 1 draft · 1 ready/);
    assert.doesNotMatch(JSON.stringify(stages), /CC-000001\.patch|base_head|selected_paths|snapshot candidate/);
    context.handoff("999901", "01", "session-999901");
    const resumed = context.startSession("999901", "01", { sessionId: "resumed", opencodeSessionId: "oc-resumed" });
    assert.deepEqual(resumed.data.resume.context.pending_candidates, stages.data.stages[0].candidates);
    assert.match(resumed.data.resume.instruction, /before switching stages or handing off/);
    assert.equal(pending.status, "draft");
  } finally { cleanup(root); }
});

test("related candidate projections bound resume metadata without limiting lifecycle counts", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    for (let index = 0; index < 12; index += 1) {
      context.createCandidate("999901", `${index}-${"x".repeat(200)}`, null, { relatedStages: ["01"] });
    }
    const snapshot = readStagesSnapshot({ projectRoot: root, sessionId: "session-999901" });
    assert.deepEqual(snapshot.data.workspace.candidates, { pending: 12, ready: 0 });
    assert.equal(snapshot.data.stages[0].candidates.draft, 12);
    assert.equal(snapshot.data.stages[0].candidates.items.length, 10);
    assert.equal(snapshot.data.stages[0].candidates.items[0].title.length, 120);
    context.handoff("999901", "01", "session-999901");
    const resumed = context.startSession("999901", "01", { sessionId: "bounded", opencodeSessionId: "oc-bounded" });
    assert.deepEqual(resumed.data.resume.context.pending_candidates, snapshot.data.stages[0].candidates);
  } finally { cleanup(root); }
});

test("candidate A commits while unrelated B work continues as WIP", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "app.txt"), "one\nready\nthree\n");
    fs.writeFileSync(path.join(root, "wip.txt"), "B started\n");
    fs.writeFileSync(path.join(root, "indexed.txt"), "ordinary index\n");
    git(root, ["add", "indexed.txt"]);
    const candidate = prepareCandidate(context, root, "Ready change", ["app.txt"], "Stored message");
    fs.writeFileSync(path.join(root, "wip.txt"), "B continued after A capture\n");
    const indexBefore = fs.readFileSync(path.join(root, ".git", "index"));
    const worktreeBefore = fs.readFileSync(path.join(root, "app.txt"));
    const hookMarker = path.join(root, "hook-ran");
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${hookMarker}"\n`);
    fs.chmodSync(hook, 0o755);
    git(root, ["config", "commit.gpgSign", "true"]);

    const result = context.commitCandidate("999901", candidate, "Override message").data;

    assert.equal(result.status, "committed");
    assert.equal(result.message, "Override message");
    assert.equal(result.commit_hash, git(root, ["rev-parse", "HEAD"]).trim());
    assert.equal(git(root, ["log", "-1", "--format=%s"]).trim(), "Override message");
    assert.equal(git(root, ["show", "HEAD:app.txt"]), "one\nready\nthree\n");
    assert.equal(git(root, ["ls-tree", "--name-only", "HEAD", "--", "wip.txt"]), "");
    assert.equal(git(root, ["diff", "HEAD", "--", "app.txt"]), "");
    assert.match(git(root, ["status", "--short", "--", "wip.txt"]), /^\?\? wip\.txt/);
    assert.equal(fs.readFileSync(path.join(root, "wip.txt"), "utf8"), "B continued after A capture\n");
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), indexBefore);
    assert.deepEqual(fs.readFileSync(path.join(root, "app.txt")), worktreeBefore);
    assert.equal(fs.existsSync(hookMarker), false);
    assert.equal(git(root, ["log", "-1", "--format=%G?"]).trim(), "N");
    assert.throws(() => context.discardCandidate("999901", candidate), (error) => error.code === ERROR_CODES.INVALID_STATE);
  } finally { cleanup(root); }
});

test("integration candidate commits coherent overlapping-stage work without lifecycle or index changes", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    context.addStage("999901", "Concurrent stage", { prompt: "Continue the integrated change." });
    const stageStatuses = context.listStages("999901").data.stages.map(({ stage, status }) => ({ stage, status }));
    fs.writeFileSync(path.join(root, "app.txt"), "stage one\nshared result\nstage two\n");
    fs.writeFileSync(path.join(root, "shared.txt"), "coherent foundation\n");
    fs.writeFileSync(path.join(root, "wip.txt"), "unrelated work\n");
    fs.writeFileSync(path.join(root, "indexed.txt"), "ordinary index\n");
    git(root, ["add", "indexed.txt"]);
    const indexBefore = fs.readFileSync(path.join(root, ".git", "index"));

    const candidate = context.createCandidate("999901", "Integrated result", null, { strategy: "integration", relatedStages: ["01", "02"] }).data;
    context.captureCandidate("999901", candidate.candidate, { paths: ["app.txt", "shared.txt"] });
    context.readyCandidate("999901", candidate.candidate);
    const committed = context.commitCandidate("999901", candidate.candidate).data;

    assert.equal(committed.strategy, "integration");
    assert.deepEqual(committed.related_stages, ["01", "02"]);
    assert.equal(git(root, ["show", "HEAD:app.txt"]), "stage one\nshared result\nstage two\n");
    assert.equal(git(root, ["show", "HEAD:shared.txt"]), "coherent foundation\n");
    assert.match(git(root, ["status", "--short", "--", "wip.txt"]), /^\?\? wip\.txt/);
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), indexBefore);
    assert.deepEqual(context.listStages("999901").data.stages.map(({ stage, status }) => ({ stage, status })), stageStatuses);
  } finally { cleanup(root); }
});

test("competing candidates reapply cleanly to a changed HEAD", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "first.txt"), "first\n");
    fs.writeFileSync(path.join(root, "second.txt"), "second\n");
    const first = prepareCandidate(context, root, "First", ["first.txt"]);
    const second = prepareCandidate(context, root, "Second", ["second.txt"]);

    assert.equal(context.commitCandidate("999901", first).data.stale, false);
    const secondResult = context.commitCandidate("999901", second).data;

    assert.equal(secondResult.stale, true);
    assert.equal(git(root, ["rev-list", "--count", "HEAD"]).trim(), "3");
    assert.equal(git(root, ["show", "HEAD:first.txt"]), "first\n");
    assert.equal(git(root, ["show", "HEAD:second.txt"]), "second\n");
  } finally { cleanup(root); }
});

test("overlapping stale candidates fail without changing repository or candidate state", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "app.txt"), "candidate\ntwo\nthree\n");
    const candidate = prepareCandidate(context, root, "Overlap", ["app.txt"]);
    fs.writeFileSync(path.join(root, "app.txt"), "new head\ntwo\nthree\n");
    git(root, ["add", "app.txt"]);
    git(root, ["commit", "-qm", "overlap"]);
    const metadataFile = path.join(root, ".work-context", "local", "candidates", `${candidate}.json`);
    const before = {
      head: git(root, ["rev-parse", "HEAD"]),
      index: fs.readFileSync(path.join(root, ".git", "index")),
      metadata: fs.readFileSync(metadataFile),
      worktree: fs.readFileSync(path.join(root, "app.txt")),
    };

    assert.throws(() => context.commitCandidate("999901", candidate), (error) => error.code === ERROR_CODES.CANDIDATE_CONFLICT);
    assert.equal(git(root, ["rev-parse", "HEAD"]), before.head);
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), before.index);
    assert.deepEqual(fs.readFileSync(metadataFile), before.metadata);
    assert.deepEqual(fs.readFileSync(path.join(root, "app.txt")), before.worktree);
  } finally { cleanup(root); }
});

test("candidate commit rejects detached HEAD and always releases its Git lock", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "app.txt"), "detached\n");
    const candidate = prepareCandidate(context, root, "Detached", ["app.txt"]);
    git(root, ["checkout", "--detach", "-q"]);

    assert.throws(() => context.commitCandidate("999901", candidate), (error) => error.code === ERROR_CODES.CANDIDATE_DETACHED_HEAD);
    assert.equal(fs.existsSync(path.join(root, ".work-context", ".locks", "candidate-git.lock")), false);
    assert.equal(context.showCandidate("999901", candidate).data.status, "ready");
  } finally { cleanup(root); }
});

test("candidate Git lock reports contention and stale owners", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "app.txt"), "locked\n");
    const candidate = prepareCandidate(context, root, "Locked", ["app.txt"]);
    const lock = path.join(root, ".work-context", ".locks", "candidate-git.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ created_at: new Date().toISOString() }));
    assert.throws(() => context.commitCandidate("999901", candidate), (error) => error.code === ERROR_CODES.LOCKED);

    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ created_at: new Date(0).toISOString() }));
    assert.throws(() => context.commitCandidate("999901", candidate), (error) => error.code === ERROR_CODES.STALE_LOCK);
    assert.equal(context.showCandidate("999901", candidate).data.status, "ready");
  } finally { cleanup(root); }
});

test("branch ref races roll candidate metadata back to ready", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "app.txt"), "race\n");
    const candidate = prepareCandidate(context, root, "Race", ["app.txt"]);
    const metadataFile = path.join(root, ".work-context", "local", "candidates", `${candidate}.json`);
    const metadataBefore = fs.readFileSync(metadataFile);
    const originalHead = git(root, ["rev-parse", "HEAD"]).trim();
    let racedHead;

    assert.throws(() => context.commitCandidate("999901", candidate, undefined, {
      beforeUpdateRef: ({ branch, head }) => {
        const tree = git(root, ["rev-parse", `${head}^{tree}`]).trim();
        racedHead = git(root, ["commit-tree", tree, "-p", head], { input: "racer\n" }).trim();
        git(root, ["update-ref", branch, racedHead, head]);
      },
    }), (error) => error.code === ERROR_CODES.CANDIDATE_REF_RACE);

    assert.notEqual(racedHead, originalHead);
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), racedHead);
    assert.deepEqual(fs.readFileSync(metadataFile), metadataBefore);
    assert.equal(context.showCandidate("999901", candidate).data.status, "ready");
  } finally { cleanup(root); }
});

test("commit creation failures leave refs, metadata, index, and worktree unchanged", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "app.txt"), "commit failure\n");
    const candidate = prepareCandidate(context, root, "Failure", ["app.txt"]);
    const metadataFile = path.join(root, ".work-context", "local", "candidates", `${candidate}.json`);
    const before = {
      head: git(root, ["rev-parse", "HEAD"]),
      metadata: fs.readFileSync(metadataFile),
      index: fs.readFileSync(path.join(root, ".git", "index")),
      worktree: fs.readFileSync(path.join(root, "app.txt")),
    };
    git(root, ["config", "user.name", ""]);

    assert.throws(() => context.commitCandidate("999901", candidate), (error) => error.code === ERROR_CODES.CANDIDATE_COMMIT_FAILED);
    assert.equal(git(root, ["rev-parse", "HEAD"]), before.head);
    assert.deepEqual(fs.readFileSync(metadataFile), before.metadata);
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), before.index);
    assert.deepEqual(fs.readFileSync(path.join(root, "app.txt")), before.worktree);
    assert.equal(fs.existsSync(path.join(root, ".work-context", ".locks", "candidate-git.lock")), false);
  } finally { cleanup(root); }
});

test("structured commit-candidate tool uses the stored candidate message", async () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    fs.writeFileSync(path.join(root, "app.txt"), "tool commit\n");
    const candidate = prepareCandidate(context, root, "Tool commit", ["app.txt"], "Stored tool message");
    const toolContext = { directory: root, worktree: root, sessionID: "tool-session", metadata: async () => {} };

    const committed = JSON.parse((await tools.work_context_commit_candidate.execute({ workspace: "999901", candidateId: candidate }, toolContext)).output);

    assert.equal(committed.ok, true);
    assert.equal(committed.data.status, "committed");
    assert.equal(git(root, ["log", "-1", "--format=%s"]).trim(), "Stored tool message");
  } finally { cleanup(root); }
});

test("commit all inspects exclusions and commits one verified repository-local integration", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    context.addStage("999901", "Related stage", { prompt: "Contribute to integration." });
    git(root, ["add", ".work-context"]);
    git(root, ["commit", "-qm", "record work context"]);
    fs.writeFileSync(path.join(root, "app.txt"), "one\nintegrated\nthree\n");
    fs.writeFileSync(path.join(root, "feature.txt"), "ready\n");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=unsafe\n");
    fs.writeFileSync(path.join(root, "indexed.txt"), "ordinary index\n");
    git(root, ["add", "indexed.txt"]);

    const inspection = context.inspectCommitAll("999901", { relatedStages: ["02"], excludePaths: ["indexed.txt"] }).data;
    const indexBefore = git(root, ["ls-files", "--stage"]);
    assert.deepEqual(inspection.included_paths, ["app.txt", "feature.txt"]);
    assert.deepEqual(inspection.excluded_paths, [{ path: ".env", reason: "potential_secret" }, { path: "indexed.txt", reason: "user_excluded" }]);
    assert.deepEqual(inspection.contributing_stages, [{ stage: "02", title: "Related stage", evidence: "user_selected" }]);
    assert.match(inspection.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(inspection.message, "Integrate repository changes");
    assert.throws(() => context.commitAll("999901", inspection.fingerprint, "confirmed", { relatedStages: ["02"], excludePaths: ["indexed.txt"] }), (error) => error.code === ERROR_CODES.COMMIT_ALL_CONFIRMATION_REQUIRED);

    const committed = context.commitAll("999901", inspection.fingerprint, "COMMIT_ALL_CONFIRMED", { relatedStages: ["02"], excludePaths: ["indexed.txt"] }).data;
    assert.equal(committed.strategy, "integration");
    assert.deepEqual(committed.included_paths, ["app.txt", "feature.txt"]);
    assert.deepEqual(committed.excluded_paths, [{ path: ".env", reason: "potential_secret" }, { path: "indexed.txt", reason: "user_excluded" }]);
    assert.equal(committed.attribution.basis, "user_selected");
    assert.match(committed.commit.sha, /^[a-f0-9]{40}$/);
    assert.equal(git(root, ["show", "HEAD:app.txt"]), "one\nintegrated\nthree\n");
    assert.equal(git(root, ["show", "HEAD:feature.txt"]), "ready\n");
    assert.equal(git(root, ["ls-tree", "--name-only", "HEAD", "--", ".env"]), "");
    assert.equal(git(root, ["ls-files", "--stage"]), indexBefore);
  } finally { cleanup(root); }
});

test("commit all excludes nested and external repositories and rejects stale plans", () => {
  const root = makeRepository();
  const external = makeRepository();
  const nested = path.join(root, "nested");
  try {
    const context = openStartup(root);
    git(root, ["add", ".work-context"]);
    git(root, ["commit", "-qm", "record work context"]);
    fs.mkdirSync(nested);
    git(nested, ["init", "-q"]);
    git(nested, ["config", "user.name", "Nested"]);
    git(nested, ["config", "user.email", "nested@example.test"]);
    fs.writeFileSync(path.join(nested, "nested.txt"), "separate\n");
    git(nested, ["add", "."]);
    git(nested, ["commit", "-qm", "nested"]);
    fs.writeFileSync(path.join(nested, "nested.txt"), "changed separately\n");
    fs.writeFileSync(path.join(external, "app.txt"), "external change\n");
    fs.writeFileSync(path.join(root, "app.txt"), "one\nroot\nthree\n");

    const inspection = context.inspectCommitAll("999901").data;
    assert.deepEqual(inspection.included_paths, ["app.txt"]);
    assert.deepEqual(inspection.excluded_paths, [{ path: "nested", reason: "nested_repository" }]);
    fs.writeFileSync(path.join(root, "app.txt"), "one\nchanged after inspection\nthree\n");
    assert.throws(() => context.commitAll("999901", inspection.fingerprint, "COMMIT_ALL_CONFIRMED"), (error) => error.code === ERROR_CODES.COMMIT_ALL_STALE_PLAN);
    assert.equal(git(external, ["status", "--short"]), " M app.txt\n");
  } finally { cleanup(root); cleanup(external); }
});

test("commit all works in standard mode and reuses only an exact integration candidate", () => {
  const root = makeRepository();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Standard integration", { workspace: "999904", sessionId: "standard" });
    git(root, ["add", ".work-context"]);
    git(root, ["commit", "-qm", "record work context"]);
    fs.writeFileSync(path.join(root, "app.txt"), "standard mode\n");
    const inspection = context.inspectCommitAll("999904", { message: "Integrate standard-mode work" }).data;

    const committed = context.commitAll("999904", inspection.fingerprint, "COMMIT_ALL_CONFIRMED", { message: "Integrate standard-mode work" }).data;
    assert.equal(committed.message_source, "user");
    assert.equal(git(root, ["log", "-1", "--format=%s"]).trim(), "Integrate standard-mode work");
    assert.throws(() => context.listCandidates("999904"), (error) => error.code === ERROR_CODES.CANDIDATE_MODE_REQUIRED);
  } finally { cleanup(root); }
});

test("commit all reports no eligible changes and reuses an exact startup candidate", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    git(root, ["add", ".work-context"]);
    git(root, ["commit", "-qm", "record work context"]);
    assert.throws(() => context.inspectCommitAll("999901"), (error) => error.code === ERROR_CODES.COMMIT_ALL_NO_CHANGES);
    fs.writeFileSync(path.join(root, "app.txt"), "candidate reuse\n");
    const inspection = context.inspectCommitAll("999901").data;
    const candidate = context.createCandidate("999901", inspection.message, inspection.message, { strategy: "integration" }).data;
    context.captureCandidate("999901", candidate.candidate, { paths: ["app.txt"] });

    const committed = context.commitAll("999901", inspection.fingerprint, "COMMIT_ALL_CONFIRMED").data;
    assert.equal(committed.candidate, candidate.candidate);
    assert.equal(committed.candidate_reused, true);
  } finally { cleanup(root); }
});

test("commit all captures renames, deletions, and untracked files while excluding submodules", () => {
  const root = makeRepository();
  const source = makeRepository();
  try {
    const context = openStartup(root);
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module"]);
    git(root, ["add", ".work-context", ".gitmodules", "module"]);
    git(root, ["commit", "-qm", "record context and submodule"]);
    fs.renameSync(path.join(root, "app.txt"), path.join(root, "renamed.txt"));
    fs.rmSync(path.join(root, "delete.txt"));
    fs.writeFileSync(path.join(root, "new.txt"), "new\n");
    fs.writeFileSync(path.join(root, "module", "app.txt"), "dirty submodule\n");

    const inspection = context.inspectCommitAll("999901").data;
    assert.deepEqual(inspection.included_paths, ["app.txt", "delete.txt", "new.txt", "renamed.txt"]);
    assert.deepEqual(inspection.excluded_paths, [{ path: "module", reason: "submodule" }]);
    assert.match(inspection.verification.stat, /3 files changed|4 files changed/);
  } finally { cleanup(root); cleanup(source); }
});

test("commit all rejects active Git operations, binary boundaries, and probable secret content", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    git(root, ["add", ".work-context"]);
    git(root, ["commit", "-qm", "record work context"]);
    fs.writeFileSync(path.join(root, "config.txt"), "api_key=abcdefghijklmnop\n");
    fs.writeFileSync(path.join(root, "app.txt"), "safe change\n");
    const inspected = context.inspectCommitAll("999901").data;
    assert.deepEqual(inspected.excluded_paths, [{ path: "config.txt", reason: "potential_secret" }]);

    fs.writeFileSync(path.join(root, ".git", "MERGE_HEAD"), "0".repeat(40) + "\n");
    assert.throws(() => context.inspectCommitAll("999901"), (error) => error.code === ERROR_CODES.COMMIT_ALL_UNSAFE_STATE);
    fs.rmSync(path.join(root, ".git", "MERGE_HEAD"));
    fs.rmSync(path.join(root, "config.txt"));
    fs.writeFileSync(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    assert.throws(() => context.inspectCommitAll("999901"), (error) => error.code === ERROR_CODES.COMMIT_ALL_INCOHERENT_BOUNDARY);
  } finally { cleanup(root); }
});

test("structured commit-all tools and standalone wrappers preserve the two-phase contract", async () => {
  const root = makeRepository();
  try {
    openStartup(root);
    git(root, ["add", ".work-context"]);
    git(root, ["commit", "-qm", "record work context"]);
    fs.writeFileSync(path.join(root, "app.txt"), "structured commit all\n");
    const toolContext = { directory: root, worktree: root, sessionID: "tool-session", metadata: async () => {} };
    const inspectTool = (await import("../tools/work_context_inspect_commit_all.js")).default;
    const commitTool = (await import("../tools/work_context_commit_all.js")).default;
    assert.equal(inspectTool, tools.work_context_inspect_commit_all);
    assert.equal(commitTool, tools.work_context_commit_all);
    const inspection = JSON.parse((await inspectTool.execute({ workspace: "999901" }, toolContext)).output);
    assert.equal(inspection.ok, true);
    const rejected = JSON.parse((await commitTool.execute({ workspace: "999901", expectedFingerprint: inspection.data.fingerprint, confirmation: "no" }, toolContext)).output);
    assert.equal(rejected.error.code, ERROR_CODES.COMMIT_ALL_CONFIRMATION_REQUIRED);

    const committed = JSON.parse((await commitTool.execute({ workspace: "999901", expectedFingerprint: inspection.data.fingerprint, confirmation: "COMMIT_ALL_CONFIRMED" }, toolContext)).output);
    assert.equal(committed.ok, true);
    assert.equal(committed.data.commit.sha, git(root, ["rev-parse", "HEAD"]).trim());
  } finally { cleanup(root); }
});

test("commit all rejects HEAD races and unresolved index conflicts", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    git(root, ["add", ".work-context"]);
    git(root, ["commit", "-qm", "record work context"]);
    fs.writeFileSync(path.join(root, "app.txt"), "confirmed patch\n");
    const inspection = context.inspectCommitAll("999901").data;
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const branch = git(root, ["symbolic-ref", "HEAD"]).trim();
    assert.throws(() => context.commitAll("999901", inspection.fingerprint, "COMMIT_ALL_CONFIRMED", {
      beforeCandidate: () => {
        const tree = git(root, ["rev-parse", `${head}^{tree}`]).trim();
        const raced = git(root, ["commit-tree", tree, "-p", head], { input: "external commit\n" }).trim();
        git(root, ["update-ref", branch, raced, head]);
      },
    }), (error) => error.code === ERROR_CODES.COMMIT_ALL_STALE_PLAN);

    git(root, ["reset", "--soft", head]);
    const base = git(root, ["rev-parse", "HEAD:app.txt"]).trim();
    const ours = git(root, ["hash-object", "-w", "--stdin"], { input: "ours\n" }).trim();
    const theirs = git(root, ["hash-object", "-w", "--stdin"], { input: "theirs\n" }).trim();
    git(root, ["update-index", "--index-info"], { input: `0 ${"0".repeat(40)}\tapp.txt\n100644 ${base} 1\tapp.txt\n100644 ${ours} 2\tapp.txt\n100644 ${theirs} 3\tapp.txt\n` });
    assert.throws(() => context.inspectCommitAll("999901"), (error) => error.code === ERROR_CODES.COMMIT_ALL_UNSAFE_STATE);
  } finally { cleanup(root); }
});

test("commit all rolls back candidate metadata and the branch after a post-ref failure", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    git(root, ["add", ".work-context"]);
    git(root, ["commit", "-qm", "record work context"]);
    fs.writeFileSync(path.join(root, "app.txt"), "rollback publication\n");
    const inspection = context.inspectCommitAll("999901").data;
    const head = git(root, ["rev-parse", "HEAD"]).trim();

    assert.throws(() => context.commitAll("999901", inspection.fingerprint, "COMMIT_ALL_CONFIRMED", {
      afterUpdateRef: () => { throw new Error("simulated storage failure"); },
    }), /simulated storage failure/);
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head);
    assert.deepEqual(context.listCandidates("999901").data, []);
    assert.equal(fs.readFileSync(path.join(root, "app.txt"), "utf8"), "rollback publication\n");
  } finally { cleanup(root); }
});

test("commit all preserves committed candidate audit when compensation loses a ref race", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    git(root, ["add", ".work-context"]);
    git(root, ["commit", "-qm", "record work context"]);
    fs.writeFileSync(path.join(root, "app.txt"), "audited race\n");
    const inspection = context.inspectCommitAll("999901").data;
    let published;

    assert.throws(() => context.commitAll("999901", inspection.fingerprint, "COMMIT_ALL_CONFIRMED", {
      afterUpdateRef: (publication) => {
        published = publication;
        const tree = git(root, ["rev-parse", `${publication.commit}^{tree}`]).trim();
        const raced = git(root, ["commit-tree", tree, "-p", publication.commit], { input: "external descendant\n" }).trim();
        git(root, ["update-ref", publication.branch, raced, publication.commit]);
        throw new Error("simulated post-ref failure");
      },
    }), (error) => error.code === ERROR_CODES.CANDIDATE_REF_RACE);
    const candidates = context.listCandidates("999901").data;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, "committed");
    assert.equal(candidates[0].commit_hash, published.commit);
    assert.equal(git(root, ["merge-base", "--is-ancestor", published.commit, "HEAD"], { stdio: "pipe" }), "");
  } finally { cleanup(root); }
});

test("commit all reports changed local operational state as excluded", () => {
  const root = makeRepository();
  try {
    const context = openStartup(root);
    const localFile = path.join(root, ".work-context", "local", "tracked-state.txt");
    fs.writeFileSync(localFile, "baseline\n");
    git(root, ["add", ".work-context"]);
    git(root, ["add", "-f", ".work-context/local/tracked-state.txt"]);
    git(root, ["commit", "-qm", "record work context"]);
    fs.writeFileSync(localFile, "local mutation\n");
    fs.writeFileSync(path.join(root, "app.txt"), "safe root change\n");

    const inspection = context.inspectCommitAll("999901").data;
    assert.deepEqual(inspection.excluded_paths, [{ path: ".work-context/local/tracked-state.txt", reason: "local_only" }]);
    assert.deepEqual(inspection.included_paths, ["app.txt"]);
  } finally { cleanup(root); }
});
