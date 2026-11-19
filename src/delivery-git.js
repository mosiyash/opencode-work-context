import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { ERROR_CODES, fail } from "./errors.js";
import { DELIVERY_DIAGNOSTIC_LIMITS } from "./delivery-contracts.js";
import { repositoryState } from "./git-candidates.js";

const hashPattern = /^[0-9a-f]{40,64}$/;
const gitFlags = ["--no-ext-diff", "--no-textconv", "--no-color"];
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const assertHash = (value, label) => {
  if (typeof value !== "string" || !hashPattern.test(value)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be a full lowercase commit hash`);
  return value;
};

const runGit = (root, args, budget, options = {}) => {
  const remaining = DELIVERY_DIAGNOSTIC_LIMITS.git_output_bytes - budget.bytes;
  if (remaining <= 0) fail(ERROR_CODES.DELIVERY_RANGE_TOO_LARGE, "Delivery Git evidence exceeds the supported 4 MiB limit");
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: null,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" },
    maxBuffer: remaining,
  });
  if (result.error?.code === "ENOENT") fail(ERROR_CODES.GIT_UNAVAILABLE, "Git executable is unavailable");
  if (result.error?.code === "ENOBUFS") fail(ERROR_CODES.DELIVERY_RANGE_TOO_LARGE, "Delivery Git evidence exceeds the supported 4 MiB limit");
  if (result.error) fail(ERROR_CODES.GIT_UNAVAILABLE, "Cannot execute Git");
  budget.bytes += (result.stdout?.length || 0) + (result.stderr?.length || 0);
  if (budget.bytes > DELIVERY_DIAGNOSTIC_LIMITS.git_output_bytes) fail(ERROR_CODES.DELIVERY_RANGE_TOO_LARGE, "Delivery Git evidence exceeds the supported 4 MiB limit");
  if (result.status !== 0 && !options.allowFailure) fail(options.code || ERROR_CODES.DELIVERY_INVALID_RANGE, options.message || "Cannot inspect delivery range");
  return result;
};

const sanitizeSubject = (value) => {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim();
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length <= DELIVERY_DIAGNOSTIC_LIMITS.commit_subject_bytes) return normalized;
  let end = DELIVERY_DIAGNOSTIC_LIMITS.commit_subject_bytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8").trimEnd();
};

const normalizePath = (value) => value.replace(/^\.\//u, "");

const parseNameStatus = (buffer) => {
  const tokens = buffer.toString("utf8").split("\0");
  const changes = [];
  for (let index = 0; index < tokens.length - 1;) {
    const code = tokens[index++];
    if (!code) continue;
    const kind = code[0];
    const source = normalizePath(tokens[index++]);
    if (kind === "R" || kind === "C") {
      const destination = normalizePath(tokens[index++]);
      changes.push({ code: kind, similarity: Number(code.slice(1)), source, path: destination });
    } else {
      changes.push({ code: kind, path: source });
    }
  }
  return changes;
};

const parseNumstat = (buffer) => {
  const tokens = buffer.toString("utf8").split("\0");
  const stats = new Map();
  for (let index = 0; index < tokens.length - 1;) {
    const token = tokens[index++];
    if (!token) continue;
    const firstTab = token.indexOf("\t");
    const secondTab = token.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    let file = token.slice(secondTab + 1);
    if (!file) {
      index += 1;
      file = tokens[index++] || "";
    }
    stats.set(normalizePath(file), {
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
      binary: added === "-" || deleted === "-",
    });
  }
  return stats;
};

const statusName = (code) => ({ A: "added", D: "deleted", R: "renamed", C: "copied" }[code] || "modified");

export function inspectDetailedCommitRange(projectRoot, from, to) {
  const repository = repositoryState(projectRoot);
  from = assertHash(from, "Range start");
  to = assertHash(to, "Range end");
  const budget = { bytes: 0 };
  const available = (commit) => runGit(repository.root, ["cat-file", "-e", `${commit}^{commit}`], budget, { allowFailure: true }).status === 0;
  if (!available(from) || !available(to)
    || runGit(repository.root, ["merge-base", "--is-ancestor", from, to], budget, { allowFailure: true }).status !== 0) {
    fail(ERROR_CODES.DELIVERY_INVALID_RANGE, "Delivery range must contain available commits in ancestor order", { from, to });
  }

  const count = Number(runGit(repository.root, ["rev-list", "--first-parent", "--count", `${from}..${to}`], budget).stdout.toString("utf8").trim());
  const hashes = runGit(repository.root, ["rev-list", "--first-parent", "--reverse", `--max-count=${DELIVERY_DIAGNOSTIC_LIMITS.commits}`, `${from}..${to}`], budget)
    .stdout.toString("utf8").trim().split("\n").filter(Boolean);
  const commits = [];
  const provenance = new Map();
  const lineage = [];

  for (const hash of hashes) {
    const subject = runGit(repository.root, ["show", "-s", "--format=%s", hash], budget).stdout.toString("utf8").replace(/\n$/u, "");
    commits.push({ commit: hash, subject: sanitizeSubject(subject) });
    const baseArgs = ["diff-tree", "-r", "-z", ...gitFlags, "--find-renames=50%", "--find-copies=50%", `${hash}^1`, hash, "--"];
    const changes = parseNameStatus(runGit(repository.root, [...baseArgs.slice(0, 3), "--name-status", ...baseArgs.slice(3)], budget).stdout);
    for (const change of changes) {
      let pathProvenance = provenance.get(change.path);
      if (!pathProvenance) {
        pathProvenance = { commits: [], truncated: false };
        provenance.set(change.path, pathProvenance);
      }
      if (pathProvenance.commits.length < DELIVERY_DIAGNOSTIC_LIMITS.provenance_commits_per_path) pathProvenance.commits.push(hash);
      else pathProvenance.truncated = true;
      if (change.code === "R" || change.code === "C") {
        lineage.push({ commit: hash, status: statusName(change.code), similarity: change.similarity, from_path: change.source, to_path: change.path });
      }
    }
  }

  const endpointArgs = ["diff", "-z", ...gitFlags, "--find-renames=50%", "--find-copies=50%", from, to, "--"];
  const finalChanges = parseNameStatus(runGit(repository.root, [...endpointArgs.slice(0, 2), "--name-status", ...endpointArgs.slice(2)], budget).stdout);
  const finalStats = parseNumstat(runGit(repository.root, [...endpointArgs.slice(0, 2), "--numstat", ...endpointArgs.slice(2)], budget).stdout);
  const allPaths = finalChanges.map((change) => {
    const stat = finalStats.get(change.path) || { additions: 0, deletions: 0, binary: false };
    const pathProvenance = provenance.get(change.path) || { commits: [], truncated: false };
    return {
      path: change.path,
      status: statusName(change.code),
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary,
      provenance: pathProvenance.commits,
      provenance_truncated: pathProvenance.truncated,
    };
  }).sort((left, right) => compareText(left.path, right.path));
  const commitOrder = new Map(hashes.map((hash, index) => [hash, index]));
  lineage.sort((left, right) => (commitOrder.get(left.commit) - commitOrder.get(right.commit))
    || compareText(left.to_path, right.to_path) || compareText(left.from_path, right.from_path));
  return {
    immutable_range: { from, to },
    commit_count: count,
    commits,
    commits_truncated: count > commits.length,
    path_count: allPaths.length,
    paths: allPaths.slice(0, DELIVERY_DIAGNOSTIC_LIMITS.paths),
    paths_truncated: allPaths.length > DELIVERY_DIAGNOSTIC_LIMITS.paths,
    lineage,
    git_output_bytes: budget.bytes,
  };
}

export { sanitizeSubject as sanitizeDeliveryCommitSubject };
