import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { WorkContext } from "../src/index.js";
import { ERROR_CODES } from "../src/errors.js";
import tools from "../src/tool-definitions.js";

const git = (root, args, options = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", ...options });
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const makeRepository = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-context-acknowledgement-test-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Acknowledgement Test"]);
  git(root, ["config", "user.email", "acknowledgement@example.test"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".work-context/local/\n");
  fs.writeFileSync(path.join(root, "app.txt"), "initial\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
};
const activeContext = (root, sessionId = "session-1") => {
  const context = WorkContext.open(root, { actor: "test" });
  context.createWorkspace("Acknowledgement", { workspace: "990001", sessionId, opencodeSessionId: `oc-${sessionId}` });
  return context;
};
const commit = (root, message = "advance") => {
  fs.writeFileSync(path.join(root, "app.txt"), `${message}\n`);
  git(root, ["add", "app.txt"]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
};

test("acknowledges short and full current-HEAD commit hashes without changing canonical state", () => {
  const root = makeRepository();
  try {
    const context = activeContext(root);
    const before = fs.readFileSync(path.join(root, ".work-context", "990001", "workspace.md"));
    const first = commit(root, "first");
    assert.deepEqual(context.acknowledgeCommit("990001", "01", "session-1", first.slice(0, 7)).data, { acknowledged: true, commit: first });
    const second = commit(root, "second");
    assert.deepEqual(context.acknowledgeCommit("990001", "01", "session-1", second).data, { acknowledged: true, commit: second });
    assert.deepEqual(fs.readFileSync(path.join(root, ".work-context", "990001", "workspace.md")), before);
    assert.equal(fs.existsSync(path.join(root, ".work-context", "local", "candidates")), false);
  } finally { cleanup(root); }
});

test("rejects invalid, missing, and non-HEAD commit hashes", () => {
  const root = makeRepository();
  try {
    const context = activeContext(root);
    const initial = git(root, ["rev-parse", "HEAD"]).trim();
    const current = commit(root);
    for (const value of ["not-a-hash", "dead", "0".repeat(40)]) {
      assert.throws(() => context.acknowledgeCommit("990001", "01", "session-1", value), (error) => error.code === ERROR_CODES.GIT_ACKNOWLEDGEMENT_INVALID_SHA);
    }
    assert.throws(() => context.acknowledgeCommit("990001", "01", "session-1", initial), (error) => error.code === ERROR_CODES.GIT_ACKNOWLEDGEMENT_NOT_HEAD);
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), current);
  } finally { cleanup(root); }
});

test("rejects changed branches, rewritten history, detached HEAD, and active Git operations", () => {
  const root = makeRepository();
  try {
    let context = activeContext(root);
    const head = commit(root, "branch change");
    git(root, ["checkout", "-qb", "other"]);
    assert.throws(() => context.acknowledgeCommit("990001", "01", "session-1", head), (error) => error.code === ERROR_CODES.GIT_ACKNOWLEDGEMENT_REF_CHANGED);

    const branch = git(root, ["symbolic-ref", "--short", "HEAD"]).trim();
    git(root, ["checkout", "-q", branch]);
    context.startSession("990001", "01", { sessionId: "session-2", takeover: true });
    const advanced = commit(root, "rewritten");
    git(root, ["reset", "--hard", "HEAD~2"]);
    const rewritten = commit(root, "replacement");
    assert.throws(() => context.acknowledgeCommit("990001", "01", "session-2", rewritten), (error) => error.code === ERROR_CODES.GIT_ACKNOWLEDGEMENT_NON_FAST_FORWARD);
    assert.notEqual(advanced, rewritten);

    context.startSession("990001", "01", { sessionId: "session-3", takeover: true });
    const detached = commit(root, "detached");
    git(root, ["checkout", "--detach", "-q"]);
    assert.throws(() => context.acknowledgeCommit("990001", "01", "session-3", detached), (error) => error.code === ERROR_CODES.GIT_ACKNOWLEDGEMENT_DETACHED_HEAD);

    git(root, ["checkout", "-q", branch]);
    context.startSession("990001", "01", { sessionId: "session-4", takeover: true });
    const operation = commit(root, "operation");
    fs.writeFileSync(path.join(root, ".git", "MERGE_HEAD"), operation + "\n");
    assert.throws(() => context.acknowledgeCommit("990001", "01", "session-4", operation), (error) => error.code === ERROR_CODES.GIT_ACKNOWLEDGEMENT_GIT_OPERATION);
  } finally { cleanup(root); }
});

test("checkpoints are isolated per concurrent active session and the structured tool uses the active OpenCode session", async () => {
  const root = makeRepository();
  try {
    const context = activeContext(root, "first");
    context.addStage("990001", "Concurrent stage", { prompt: "Continue independently." });
    context.startSession("990001", "02", { sessionId: "second", opencodeSessionId: "oc-second" });
    const head = commit(root, "shared commit");
    assert.deepEqual(context.acknowledgeCommit("990001", "02", "second", head.slice(0, 7)).data, { acknowledged: true, commit: head });
    assert.deepEqual(context.acknowledgeCommit("990001", "01", "first", head).data, { acknowledged: true, commit: head });

    const toolResult = JSON.parse((await tools.work_context_acknowledge_commit.execute({ sha: head }, {
      directory: root, worktree: root, sessionID: "oc-second", metadata: async () => {},
    })).output);
    assert.equal(toolResult.ok, true);
    assert.equal(toolResult.data.commit, head);
  } finally { cleanup(root); }
});

test("non-Git sessions remain usable and acknowledgement requires their missing checkpoint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-context-acknowledgement-no-git-"));
  try {
    const context = activeContext(root);
    assert.throws(() => context.acknowledgeCommit("990001", "01", "session-1", "abcd"), (error) => error.code === ERROR_CODES.GIT_ACKNOWLEDGEMENT_CHECKPOINT_MISSING);
  } finally { cleanup(root); }
});
