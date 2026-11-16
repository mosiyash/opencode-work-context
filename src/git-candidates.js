import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ERROR_CODES, fail } from "./errors.js";

const git = (root, args, options = {}) => {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: options.encoding === null ? null : "utf8",
    env: { ...process.env, ...options.env },
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") fail(ERROR_CODES.GIT_UNAVAILABLE, "Git executable is unavailable");
  if (result.error) fail(ERROR_CODES.GIT_UNAVAILABLE, "Cannot execute Git", { cause: result.error.message });
  if (result.status !== 0 && !options.allowFailure) {
    fail(options.code || ERROR_CODES.CANDIDATE_INVALID_PATCH, options.message || "Git operation failed", {
      stderr: String(result.stderr || "").trim(),
    });
  }
  return result;
};

export function repositoryState(projectRoot) {
  const rootResult = git(projectRoot, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (rootResult.status !== 0) fail(ERROR_CODES.NOT_GIT_REPOSITORY, "Work context is not at a Git repository root");
  const root = fs.realpathSync(rootResult.stdout.trim());
  if (root !== fs.realpathSync(projectRoot)) fail(ERROR_CODES.NOT_GIT_REPOSITORY, "Work context must be at the Git repository root", { repositoryRoot: root });
  const head = git(root, ["rev-parse", "--verify", "HEAD"], {
    allowFailure: true,
  });
  if (head.status !== 0) fail(ERROR_CODES.CANDIDATE_STALE_BASE, "Git repository has no valid HEAD");
  return { root, head: head.stdout.trim() };
}

function withTemporaryIndex(root, base, fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "work-context-candidate-"));
  const index = path.join(directory, "index");
  const env = { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
  try {
    const baseCheck = git(root, ["cat-file", "-e", `${base}^{commit}`], { allowFailure: true });
    if (baseCheck.status !== 0) fail(ERROR_CODES.CANDIDATE_STALE_BASE, "Candidate base commit is unavailable", { base });
    git(root, ["read-tree", base], { env, code: ERROR_CODES.CANDIDATE_STALE_BASE, message: "Cannot populate the candidate index" });
    return fn(env);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const currentBranch = (root) => {
  const result = git(root, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
  const branch = result.stdout.trim();
  if (result.status !== 0 || !branch.startsWith("refs/heads/")) {
    fail(ERROR_CODES.CANDIDATE_DETACHED_HEAD, "Candidate commits require an attached local branch");
  }
  return branch;
};

const rejectUnsupportedPatch = (patchText) => {
  if (typeof patchText !== "string" || !patchText.trim()) fail(ERROR_CODES.CANDIDATE_INVALID_PATCH, "A non-empty unified patch is required");
  if (patchText.includes("\0") || /^(?:GIT binary patch|Binary files .* differ)$/m.test(patchText)) {
    fail(ERROR_CODES.CANDIDATE_UNSUPPORTED, "Binary candidate patches are not supported");
  }
  if (/^(?:(?:old|new|new file|deleted file) mode 160000|index [0-9a-f]+\.\.[0-9a-f]+ 160000)$/m.test(patchText)) {
    fail(ERROR_CODES.CANDIDATE_UNSUPPORTED, "Gitlink and submodule candidate patches are not supported");
  }
  if (!/^diff --git a\/.+ b\/.+/m.test(patchText)) fail(ERROR_CODES.CANDIDATE_INVALID_PATCH, "Expected a Git unified patch");
};

const patchFromIndex = (root, base, env) => {
  const result = git(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "--find-renames", base, "--"], { env });
  rejectUnsupportedPatch(result.stdout);
  return result.stdout;
};

export function normalizeCandidatePaths(root, personalRoot, values) {
  if (!Array.isArray(values) || !values.length) fail(ERROR_CODES.INVALID_ARGUMENT, "At least one path is required");
  const personal = fs.existsSync(personalRoot) ? fs.realpathSync(personalRoot) : path.resolve(personalRoot);
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail(ERROR_CODES.INVALID_ARGUMENT, "Candidate paths must be non-empty strings");
    const absolute = path.resolve(root, value);
    const relative = path.relative(root, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(ERROR_CODES.INVALID_ARGUMENT, "Candidate path must be inside the repository", { path: value });
    if (absolute === personal || absolute.startsWith(`${personal}${path.sep}`)) fail(ERROR_CODES.INVALID_ARGUMENT, "Candidate storage cannot be captured", { path: value });
    return relative.split(path.sep).join("/");
  });
  return [...new Set(normalized)].sort();
}

export function capturePaths(root, personalRoot, base, values) {
  const paths = normalizeCandidatePaths(root, personalRoot, values);
  return withTemporaryIndex(root, base, (env) => {
    const result = git(root, ["add", "-A", "--", ...paths], { env, allowFailure: true });
    if (result.status !== 0) fail(ERROR_CODES.CANDIDATE_UNSUPPORTED, "Cannot capture one or more candidate paths", { stderr: result.stderr.trim() });
    return { patch: patchFromIndex(root, base, env), paths };
  });
}

export function capturePatch(root, personalRoot, base, patchText) {
  rejectUnsupportedPatch(patchText);
  const worktreeCheck = git(root, ["apply", "--check", "--reverse", "--whitespace=nowarn", "-"], { input: patchText, allowFailure: true });
  if (worktreeCheck.status !== 0) fail(ERROR_CODES.CANDIDATE_INVALID_PATCH, "Patch does not match the current working tree", { stderr: worktreeCheck.stderr.trim() });
  return withTemporaryIndex(root, base, (env) => {
    const check = git(root, ["apply", "--cached", "--check", "--whitespace=nowarn", "-"], { env, input: patchText, allowFailure: true });
    if (check.status !== 0) fail(ERROR_CODES.CANDIDATE_INVALID_PATCH, "Patch does not apply safely to the candidate base", { stderr: check.stderr.trim() });
    git(root, ["apply", "--cached", "--whitespace=nowarn", "-"], { env, input: patchText });
    const patch = patchFromIndex(root, base, env);
    const names = git(root, ["diff", "--cached", "--name-only", "-z", base, "--"], { env, encoding: null }).stdout;
    return { patch, paths: normalizeCandidatePaths(root, personalRoot, names.toString("utf8").split("\0").filter(Boolean)) };
  });
}

export function previewPatch(root, base, patchText) {
  rejectUnsupportedPatch(patchText);
  return withTemporaryIndex(root, base, (env) => {
    const applied = git(root, ["apply", "--cached", "--check", "--whitespace=nowarn", "-"], { env, input: patchText, allowFailure: true });
    if (applied.status !== 0) fail(ERROR_CODES.CANDIDATE_INVALID_PATCH, "Stored candidate patch is invalid", { stderr: applied.stderr.trim() });
    git(root, ["apply", "--cached", "--whitespace=nowarn", "-"], { env, input: patchText });
    const patch = patchFromIndex(root, base, env);
    const stat = git(root, ["diff", "--cached", "--stat", "--no-color", base, "--"], { env }).stdout.trimEnd();
    const currentHead = repositoryState(root).head;
    return { patch, stat, stale: currentHead !== base, current_head: currentHead };
  });
}

export function commitPatch(root, base, patchText, message, options = {}) {
  rejectUnsupportedPatch(patchText);
  if (typeof message !== "string" || !message.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Commit message is required");
  const repository = repositoryState(root);
  const branch = currentBranch(repository.root);
  const baseCheck = git(repository.root, ["cat-file", "-e", `${base}^{commit}`], { allowFailure: true });
  if (baseCheck.status !== 0) fail(ERROR_CODES.CANDIDATE_STALE_BASE, "Candidate base commit is unavailable", { base });

  return withTemporaryIndex(repository.root, repository.head, (env) => {
    const applied = git(repository.root, ["apply", "--cached", "--check", "--whitespace=nowarn", "-"], { env, input: patchText, allowFailure: true });
    if (applied.status !== 0) {
      const stale = repository.head !== base;
      fail(stale ? ERROR_CODES.CANDIDATE_CONFLICT : ERROR_CODES.CANDIDATE_INVALID_PATCH,
        stale ? "Candidate overlaps changes made since its base" : "Stored candidate patch is invalid",
        { base, currentHead: repository.head, stderr: applied.stderr.trim() });
    }
    git(repository.root, ["apply", "--cached", "--whitespace=nowarn", "-"], { env, input: patchText });
    const tree = git(repository.root, ["write-tree"], { env, code: ERROR_CODES.CANDIDATE_COMMIT_FAILED, message: "Cannot write candidate tree" }).stdout.trim();
    const commitResult = git(repository.root, ["commit-tree", tree, "-p", repository.head], {
      env,
      input: `${message.trim()}\n`,
      allowFailure: true,
    });
    if (commitResult.status !== 0) fail(ERROR_CODES.CANDIDATE_COMMIT_FAILED, "Cannot create candidate commit", { stderr: commitResult.stderr.trim() });
    const commit = commitResult.stdout.trim();
    options.beforeUpdateRef?.({ branch, commit, head: repository.head });
    const updated = git(repository.root, ["update-ref", branch, commit, repository.head], { allowFailure: true });
    if (updated.status !== 0) fail(ERROR_CODES.CANDIDATE_REF_RACE, "Branch changed while publishing the candidate", {
      branch,
      expectedHead: repository.head,
      stderr: updated.stderr.trim(),
    });
    return { branch, previous_head: repository.head, commit, stale: repository.head !== base };
  });
}
