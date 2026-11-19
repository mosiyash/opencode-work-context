import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "./storage.js";
import { ERROR_CODES, fail } from "./errors.js";
import { normalizeWorkspaceId } from "./identifiers.js";
import { inspectCommitRange, isCommitAncestor, repositoryState } from "./git-candidates.js";
import { inspectDetailedCommitRange } from "./delivery-git.js";
import { DELIVERY_DIAGNOSTIC_LIMITS, DELIVERY_EXPLAIN_CONTRACT_VERSION, DELIVERY_EXPLAIN_OPERATION, deliveryDiagnosticComplete, validateDeliveryExplainEnvelope, validateDeliveryFindings } from "./delivery-contracts.js";
import { createDeliveryPathRedactor } from "./delivery-redaction.js";
import { recommendDeliverySlices } from "./delivery-slices.js";

const environmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const hashPattern = /^[0-9a-f]{40,64}$/;
const candidatePattern = /^CC-\d{6}$/;
const timestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const maxEnvironments = 20;
const maxCandidates = 10000;
const diagnosticCandidateLimit = DELIVERY_DIAGNOSTIC_LIMITS.commits;
const diagnosticCandidatePathLimit = DELIVERY_DIAGNOSTIC_LIMITS.paths;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const checkpointIntegrity = (checkpoint) => createHash("sha256").update(JSON.stringify({
  deployed_head: checkpoint.deployed_head,
  deployed_at: checkpoint.deployed_at,
  deployed_candidates: checkpoint.deployed_candidates,
})).digest("hex");

const normalizeEnvironment = (value) => {
  if (typeof value !== "string" || !environmentPattern.test(value)) fail(ERROR_CODES.INVALID_ARGUMENT, "Environment must use 1-64 letters, digits, dots, underscores or hyphens");
  return value;
};

export function validateDeliveryRecord(data, workspace) {
  const valid = data && typeof data === "object" && !Array.isArray(data)
    && Object.keys(data).every((key) => ["schema", "workspace", "updated_at", "environments"].includes(key))
    && data.schema === 1 && data.workspace === workspace && /^\d{6}$/.test(data.workspace)
    && timestamp(data.updated_at) && data.environments && typeof data.environments === "object" && !Array.isArray(data.environments)
    && Object.keys(data.environments).length <= maxEnvironments
    && Object.entries(data.environments).every(([name, item]) => environmentPattern.test(name)
      && item && typeof item === "object" && !Array.isArray(item)
      && Object.keys(item).every((key) => ["deployed_head", "deployed_at", "deployed_candidates", "integrity"].includes(key))
      && hashPattern.test(item.deployed_head) && timestamp(item.deployed_at)
      && Array.isArray(item.deployed_candidates) && item.deployed_candidates.length <= maxCandidates
      && item.deployed_candidates.every((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && Object.keys(candidate).length === 2 && candidatePattern.test(candidate.candidate) && hashPattern.test(candidate.commit_hash))
      && new Set(item.deployed_candidates.map((candidate) => candidate.candidate)).size === item.deployed_candidates.length
      && item.deployed_candidates.every((candidate, index) => index === 0 || item.deployed_candidates[index - 1].candidate < candidate.candidate)
      && typeof item.integrity === "string" && /^[0-9a-f]{64}$/.test(item.integrity)
      && item.integrity === checkpointIntegrity(item));
  if (!valid) fail(ERROR_CODES.STORAGE_ERROR, "Invalid delivery checkpoint metadata");
  return data;
}

export class DeliveryStore {
  constructor(context) {
    this.context = context;
    this.directory = path.join(context.storage.personalRoot, "delivery");
  }

  file(workspace) { return path.join(this.directory, `${workspace}.json`); }

  assertWorkspace(workspace) {
    workspace = normalizeWorkspaceId(workspace);
    this.context.storage.readWorkspace(workspace);
    return workspace;
  }

  read(workspace) {
    workspace = this.assertWorkspace(workspace);
    try { return validateDeliveryRecord(JSON.parse(fs.readFileSync(this.file(workspace), "utf8")), workspace); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      if (error.code === ERROR_CODES.STORAGE_ERROR) throw error;
      fail(ERROR_CODES.STORAGE_ERROR, "Invalid delivery checkpoint metadata", { cause: error.message });
    }
  }

  projection(workspace) {
    workspace = this.assertWorkspace(workspace);
    let record;
    try { record = this.read(workspace); } catch {
      return { committed: this.context.candidates().committedProjection(workspace), plan_needed: false, environments: [], unavailable: true };
    }
    const candidateStore = this.context.candidates();
    const committedRecords = candidateStore.projectionRecords(workspace).filter((candidate) => candidate.status === "committed");
    const committed = candidateStore.committedProjection(workspace);
    const committedById = new Map(committedRecords.map((candidate) => [candidate.candidate, candidate]));
    const invalidCheckpoint = Object.values(record?.environments || {}).some((checkpoint) => checkpoint.deployed_candidates.some((candidate) => {
      const metadata = committedById.get(candidate.candidate);
      return !metadata || metadata.commit_hash !== candidate.commit_hash;
    }));
    if (invalidCheckpoint) return { committed, plan_needed: false, environments: [], unavailable: true };
    const environments = Object.entries(record?.environments || {}).sort(([left], [right]) => left.localeCompare(right)).map(([environment, checkpoint]) => {
      const delivered = new Set(checkpoint.deployed_candidates.map((candidate) => candidate.candidate));
      return {
        environment,
        deployed_at: checkpoint.deployed_at,
        pending: committedRecords.filter((candidate) => !delivered.has(candidate.candidate)).length,
      };
    });
    return {
      committed,
      plan_needed: committed.count > 0 && environments.length === 0,
      environments,
    };
  }

  readContext(workspace, options = {}) {
    workspace = this.assertWorkspace(workspace);
    const projection = this.projection(workspace);
    const record = this.read(workspace);
    const environment = options.environment === undefined ? null : normalizeEnvironment(options.environment);
    const checkpoint = environment ? record?.environments?.[environment] || null : null;
    const hasFrom = options.from !== undefined;
    const hasTo = options.to !== undefined;
    if (hasFrom !== hasTo) fail(ERROR_CODES.INVALID_ARGUMENT, "Delivery range requires both from and to commit hashes");
    const range = hasFrom ? inspectCommitRange(this.context.storage.projectRoot, options.from, options.to) : null;
    return { workspace, environment, checkpoint, ...projection, ...(range ? { range } : {}) };
  }

  explain(workspace, options = {}) {
    workspace = this.assertWorkspace(workspace);
    const findings = validateDeliveryFindings(options.findings).map((finding) => {
      const affectedPaths = finding.affected_paths.map((item) => {
        const normalized = item.replace(/^(?:\.\/)+/u, "");
        if (path.posix.isAbsolute(normalized) || normalized.includes("\\") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
          fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Affected paths must be repository-relative normalized paths", { id: finding.id });
        }
        return normalized;
      });
      if (new Set(affectedPaths).size !== affectedPaths.length) fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Affected paths must remain unique after normalization", { id: finding.id });
      return { ...finding, affected_paths: affectedPaths.sort(compareText) };
    });
    const evidence = inspectDetailedCommitRange(this.context.storage.projectRoot, options.from, options.to);
    const workspaceMode = this.context.storage.readWorkspace(workspace).data.mode || "standard";
    const commitSet = new Set(evidence.commits.map(({ commit }) => commit));
    const finalPathSet = new Set(evidence.paths.map(({ path: file }) => file));
    const traceability = workspaceMode === "startup"
      ? this.candidateTraceability(workspace, commitSet)
      : { capability: "unavailable", candidates: [], direct_commits: [] };
    const allPaths = [
      ...evidence.paths.map(({ path: file }) => file),
      ...evidence.lineage.flatMap(({ from_path: fromPath, to_path: toPath }) => [fromPath, toPath]),
      ...findings.flatMap((finding) => finding.affected_paths),
      ...traceability.candidates.flatMap((candidate) => candidate.paths),
    ];
    const redactor = createDeliveryPathRedactor(this.context.storage.config.delivery.secret_path_patterns, allPaths);
    const limits = {
      commits: { count: evidence.commit_count, limit: DELIVERY_DIAGNOSTIC_LIMITS.commits, truncated: evidence.commits_truncated },
      paths: { count: evidence.path_count, limit: DELIVERY_DIAGNOSTIC_LIMITS.paths, truncated: evidence.paths_truncated },
      provenance: { limit_per_path: DELIVERY_DIAGNOSTIC_LIMITS.provenance_commits_per_path, truncated: evidence.paths.some((item) => item.provenance_truncated) },
      candidate_traceability: {
        candidates_limit: diagnosticCandidateLimit,
        paths_limit: diagnosticCandidatePathLimit,
        candidates_truncated: traceability.candidates_truncated || evidence.commits_truncated || false,
        paths_truncated: traceability.paths_truncated || false,
      },
      git_output: { bytes: evidence.git_output_bytes, limit: DELIVERY_DIAGNOSTIC_LIMITS.git_output_bytes, truncated: false },
    };
    const complete = deliveryDiagnosticComplete(limits);
    const normalizedFindings = findings.map((finding) => {
      const matchedPaths = finding.affected_paths.filter((file) => finalPathSet.has(file));
      const unmatchedPaths = finding.affected_paths.filter((file) => !finalPathSet.has(file));
      const normalized = {
        ...finding,
        summary: redactor.text(finding.summary),
        affected_paths: finding.affected_paths.map(redactor.path),
        ...(evidence.paths_truncated ? {} : {
          matched_paths: matchedPaths.map(redactor.path),
          unmatched_paths: unmatchedPaths.map(redactor.path),
        }),
        ...(finding.recommendation === undefined || !complete ? {} : { recommendation: redactor.text(finding.recommendation) }),
      };
      if (!complete) delete normalized.recommendation;
      return normalized;
    });
    const candidates = traceability.candidates.map((candidate) => ({ ...candidate, paths: candidate.paths.map(redactor.path) }));
    const redactedPaths = evidence.paths.map((item) => ({ ...item, path: redactor.path(item.path) }));
    const candidateTraceability = { ...traceability, candidates };
    const candidateSlice = complete ? recommendDeliverySlices({
      findings: normalizedFindings,
      paths: redactedPaths,
      candidate_traceability: candidateTraceability,
    }) : [];
    const severity = { info: 0, warning: 0, error: 0 };
    for (const finding of normalizedFindings) severity[finding.severity] += 1;
    return validateDeliveryExplainEnvelope({
      contract_version: DELIVERY_EXPLAIN_CONTRACT_VERSION,
      operation: DELIVERY_EXPLAIN_OPERATION,
      immutable_range: evidence.immutable_range,
      limits,
      summary: {
        commits: evidence.commit_count,
        paths: evidence.path_count,
        findings: normalizedFindings.length,
        severity,
        candidate_attributed_commits: traceability.capability === "available" ? new Set(candidates.flatMap((candidate) => candidate.commits)).size : null,
        direct_commits: traceability.capability === "available" ? traceability.direct_commits.length : null,
      },
      paths: redactedPaths,
      lineage: evidence.lineage.map((item) => ({ ...item, from_path: redactor.path(item.from_path), to_path: redactor.path(item.to_path) })),
      findings: normalizedFindings,
      candidate_traceability: candidateTraceability,
      candidate_slice: candidateSlice,
      redactions: redactor.summary,
      complete,
    });
  }

  candidateTraceability(workspace, commitSet) {
    const records = this.context.candidates().projectionRecords(workspace)
      .filter((candidate) => candidate.status === "committed" && commitSet.has(candidate.commit_hash))
      .sort((left, right) => left.candidate.localeCompare(right.candidate));
    const included = records.slice(0, diagnosticCandidateLimit);
    let remainingPaths = diagnosticCandidatePathLimit;
    let pathsTruncated = false;
    const candidates = included.map((candidate) => {
      const selectedPaths = [...candidate.selected_paths].sort(compareText);
      const paths = selectedPaths.slice(0, remainingPaths);
      remainingPaths -= paths.length;
      if (paths.length < selectedPaths.length) pathsTruncated = true;
      return {
        candidate: candidate.candidate,
        strategy: candidate.strategy || "exact",
        related_stages: candidate.related_stages || [],
        commits: [candidate.commit_hash],
        paths,
      };
    });
    const attributed = new Set(records.map((candidate) => candidate.commit_hash));
    return {
      capability: "available",
      candidates,
      direct_commits: [...commitSet].filter((commit) => !attributed.has(commit)),
      candidates_truncated: records.length > included.length,
      paths_truncated: pathsTruncated,
    };
  }

  mark(workspace, environment, commit, confirmation) {
    workspace = this.assertWorkspace(workspace);
    environment = normalizeEnvironment(environment);
    if (confirmation !== "DELIVERY_CONFIRMED") fail(ERROR_CODES.CONFIRMATION_REQUIRED, "Marking delivery requires DELIVERY_CONFIRMED confirmation");
    if (typeof commit !== "string" || !hashPattern.test(commit)) fail(ERROR_CODES.INVALID_ARGUMENT, "Delivery commit must be a full commit hash");
    const repository = repositoryState(this.context.storage.projectRoot);
    if (!isCommitAncestor(repository.root, commit, repository.head)) fail(ERROR_CODES.DELIVERY_INVALID_RANGE, "Delivery commit must be available and reachable from current HEAD", { commit, currentHead: repository.head });
    const committed = this.context.candidates().projectionRecords(workspace).filter((candidate) => candidate.status === "committed");
    const deployedCandidates = committed.filter((candidate) => isCommitAncestor(repository.root, candidate.commit_hash, commit))
      .map((candidate) => ({ candidate: candidate.candidate, commit_hash: candidate.commit_hash }))
      .sort((left, right) => left.candidate.localeCompare(right.candidate));
    const now = new Date().toISOString();
    const record = this.read(workspace) || { schema: 1, workspace, updated_at: now, environments: {} };
    record.updated_at = now;
    const checkpoint = { deployed_head: commit, deployed_at: now, deployed_candidates: deployedCandidates };
    checkpoint.integrity = checkpointIntegrity(checkpoint);
    record.environments[environment] = checkpoint;
    validateDeliveryRecord(record, workspace);
    atomicWrite(this.file(workspace), `${JSON.stringify(record, null, 2)}\n`);
    return { workspace, environment, checkpoint: record.environments[environment] };
  }
}
