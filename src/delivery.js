import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "./storage.js";
import { ERROR_CODES, fail } from "./errors.js";
import { normalizeWorkspaceId } from "./identifiers.js";
import { inspectCommitRange, isCommitAncestor, repositoryState } from "./git-candidates.js";

const environmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const hashPattern = /^[0-9a-f]{40,64}$/;
const candidatePattern = /^CC-\d{6}$/;
const timestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const maxEnvironments = 20;
const maxCandidates = 10000;
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
