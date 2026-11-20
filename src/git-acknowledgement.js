import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ERROR_CODES, fail } from "./errors.js";
import { atomicWrite } from "./storage.js";

const git = (root, args, options = {}) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024, ...options });
  if (result.error?.code === "ENOENT") fail(ERROR_CODES.GIT_UNAVAILABLE, "Git executable is unavailable");
  if (result.error) fail(ERROR_CODES.GIT_UNAVAILABLE, "Cannot execute Git");
  return result;
};

const repository = (projectRoot) => {
  const rootResult = git(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) fail(ERROR_CODES.NOT_GIT_REPOSITORY, "Work context is not at a Git repository root");
  const root = fs.realpathSync(rootResult.stdout.trim());
  if (root !== fs.realpathSync(projectRoot)) fail(ERROR_CODES.NOT_GIT_REPOSITORY, "Work context must be at the Git repository root");
  const headResult = git(root, ["rev-parse", "--verify", "HEAD"]);
  if (headResult.status !== 0) fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_CHECKPOINT_MISSING, "Git repository has no valid HEAD");
  const refResult = git(root, ["symbolic-ref", "--quiet", "HEAD"]);
  if (refResult.status !== 0 || !refResult.stdout.trim().startsWith("refs/heads/")) {
    fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_DETACHED_HEAD, "Commit acknowledgement requires an attached local branch");
  }
  return { root, head: headResult.stdout.trim(), ref: refResult.stdout.trim() };
};

const checkpointPath = (personalRoot, sessionId) => path.join(personalRoot, "git-checkpoints", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
const checkpointFor = (personalRoot, sessionId) => {
  const file = checkpointPath(personalRoot, sessionId);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || value.schema !== 1 || value.session_id !== sessionId || typeof value.head !== "string" || !/^[0-9a-f]{40,64}$/.test(value.head) || typeof value.ref !== "string" || !value.ref.startsWith("refs/heads/")) {
      fail(ERROR_CODES.STORAGE_ERROR, "Invalid Git acknowledgement checkpoint");
    }
    return { file, value };
  } catch (error) {
    if (error.code === "ENOENT") return { file, value: null };
    throw error;
  }
};

const gitOperationInProgress = (root) => {
  const gitDir = git(root, ["rev-parse", "--git-dir"]);
  if (gitDir.status !== 0) return true;
  const directory = path.resolve(root, gitDir.stdout.trim());
  return ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer"]
    .some((entry) => fs.existsSync(path.join(directory, entry)));
};

const assertAcknowledgementHash = (value) => {
  if (typeof value !== "string" || !/^[0-9a-f]{4,64}$/.test(value)) {
    fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_INVALID_SHA, "Commit acknowledgement requires a short or full lowercase commit hash");
  }
  return value;
};

const resolveCommit = (root, value) => {
  const result = git(root, ["rev-parse", "--verify", "--quiet", `${value}^{commit}`]);
  if (result.status !== 0) fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_INVALID_SHA, "Commit hash does not resolve to one commit");
  return result.stdout.trim();
};

const isAncestor = (root, ancestor, descendant) => git(root, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;

export function initializeGitCheckpoint(storage, { workspace, stage, sessionId }) {
  let state;
  try { state = repository(storage.projectRoot); } catch (error) {
    if ([ERROR_CODES.NOT_GIT_REPOSITORY, ERROR_CODES.GIT_ACKNOWLEDGEMENT_CHECKPOINT_MISSING, ERROR_CODES.GIT_ACKNOWLEDGEMENT_DETACHED_HEAD].includes(error.code)) return null;
    throw error;
  }
  const checkpoint = checkpointFor(storage.personalRoot, sessionId);
  if (checkpoint.value) return checkpoint.value;
  const now = new Date().toISOString();
  const value = { schema: 1, session_id: sessionId, workspace, stage, head: state.head, ref: state.ref, created_at: now, updated_at: now };
  atomicWrite(checkpoint.file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

export function acknowledgeGitCommit(storage, { workspace, stage, sessionId, sha }) {
  const input = assertAcknowledgementHash(sha);
  const checkpoint = checkpointFor(storage.personalRoot, sessionId);
  if (!checkpoint.value) fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_CHECKPOINT_MISSING, "No Git checkpoint exists for this active session");
  if (checkpoint.value.workspace !== workspace || checkpoint.value.stage !== stage) fail(ERROR_CODES.STORAGE_ERROR, "Git acknowledgement checkpoint does not match the active stage");
  const state = repository(storage.projectRoot);
  if (gitOperationInProgress(state.root)) fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_GIT_OPERATION, "Commit acknowledgement is unavailable while a Git operation is in progress");
  if (checkpoint.value.ref !== state.ref) fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_REF_CHANGED, "Attached Git branch changed since this session started");
  const commit = resolveCommit(state.root, input);
  if (commit !== state.head) fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_NOT_HEAD, "Acknowledged commit must be the current HEAD");
  if (!isAncestor(state.root, checkpoint.value.head, state.head)) fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_NON_FAST_FORWARD, "Git history no longer advances from this session checkpoint");
  const verified = repository(storage.projectRoot);
  if (verified.head !== state.head || verified.ref !== state.ref || gitOperationInProgress(verified.root)) {
    fail(ERROR_CODES.GIT_ACKNOWLEDGEMENT_REF_CHANGED, "Git state changed while acknowledging the commit");
  }
  const value = { ...checkpoint.value, head: state.head, updated_at: new Date().toISOString() };
  atomicWrite(checkpoint.file, `${JSON.stringify(value, null, 2)}\n`);
  return { acknowledged: true, commit: state.head };
}
