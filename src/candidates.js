import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "./storage.js";
import { ERROR_CODES, fail } from "./errors.js";
import { normalizeStageId, normalizeWorkspaceId } from "./identifiers.js";
import { capturePatch, capturePaths, commitPatch, inspectCommitAll, previewPatch, repositoryState } from "./git-candidates.js";

const candidatePattern = /^CC-(\d{6})$/;
const statuses = new Set(["draft", "ready", "discarded", "committed"]);
const strategies = new Set(["exact", "shared_foundation", "integration"]);
const projectionCandidateLimit = 10;
const projectionTitleLimit = 120;
const deliveryCandidateLimit = 20;
const timestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const metadataKeys = ["schema", "candidate", "workspace", "title", "message", "base_head", "status", "created_at", "updated_at", "selected_paths", "patch_file"];
const optionalMetadataKeys = ["strategy", "related_stages"];

function validateCandidate(data, expectedId = null) {
  const valid = data && typeof data === "object" && !Array.isArray(data)
    && metadataKeys.every((key) => Object.hasOwn(data, key))
    && Object.keys(data).every((key) => metadataKeys.includes(key) || optionalMetadataKeys.includes(key) || ["commit_hash", "committed_at"].includes(key))
    && data.schema === 1 && candidatePattern.test(data.candidate) && (!expectedId || data.candidate === expectedId)
    && /^\d{6}$/.test(data.workspace) && typeof data.title === "string" && data.title.trim()
    && typeof data.message === "string" && data.message.trim() && /^[0-9a-f]{40,64}$/.test(data.base_head)
    && statuses.has(data.status) && timestamp(data.created_at) && timestamp(data.updated_at)
    && Date.parse(data.updated_at) >= Date.parse(data.created_at)
    && Array.isArray(data.selected_paths) && data.selected_paths.every((item) => typeof item === "string" && item && !path.isAbsolute(item) && !item.split("/").includes(".."))
    && new Set(data.selected_paths).size === data.selected_paths.length
    && data.patch_file === `${data.candidate}.patch`
    && (Object.hasOwn(data, "strategy") === Object.hasOwn(data, "related_stages"))
    && (!Object.hasOwn(data, "strategy") || (strategies.has(data.strategy)
      && Array.isArray(data.related_stages) && data.related_stages.every((stage) => /^\d{2}$/.test(stage) && stage !== "00")
      && new Set(data.related_stages).size === data.related_stages.length))
    && (data.status === "committed"
      ? /^[0-9a-f]{40,64}$/.test(data.commit_hash) && timestamp(data.committed_at)
      : !Object.hasOwn(data, "commit_hash") && !Object.hasOwn(data, "committed_at"));
  if (!valid) fail(ERROR_CODES.STORAGE_ERROR, "Invalid commit candidate metadata");
  return data;
}

export class CandidateStore {
  constructor(context) {
    this.context = context;
    this.directory = path.join(context.storage.personalRoot, "candidates");
  }

  assertStartup(workspace) {
    this.context.storage.assertNoSymlinks();
    workspace = normalizeWorkspaceId(workspace);
    const record = this.context.storage.readWorkspace(workspace);
    if ((record.data.mode || "standard") !== "startup") fail(ERROR_CODES.CANDIDATE_MODE_REQUIRED, "Commit candidates require startup workflow mode", { workspace });
    return workspace;
  }

  assertWorkspace(workspace) {
    this.context.storage.assertNoSymlinks();
    workspace = normalizeWorkspaceId(workspace);
    this.context.storage.readWorkspace(workspace);
    return workspace;
  }

  metadataFile(id) { return path.join(this.directory, `${id}.json`); }
  patchFile(id) { return path.join(this.directory, `${id}.patch`); }

  nextId() {
    if (!fs.existsSync(this.directory)) return "CC-000001";
    const numbers = fs.readdirSync(this.directory).map((file) => file.match(/^CC-(\d{6})\.(?:json|patch)$/)?.[1]).filter(Boolean).map(Number);
    const next = Math.max(0, ...numbers) + 1;
    if (next > 999999) fail(ERROR_CODES.INVALID_STATE, "Commit candidate ID space is exhausted");
    return `CC-${String(next).padStart(6, "0")}`;
  }

  read(id, workspace = null, includePatch = false) {
    if (typeof id !== "string" || !candidatePattern.test(id)) fail(ERROR_CODES.INVALID_ARGUMENT, "Invalid commit candidate ID");
    let data;
    try { data = JSON.parse(fs.readFileSync(this.metadataFile(id), "utf8")); }
    catch (error) { if (error.code === "ENOENT") fail(ERROR_CODES.NOT_FOUND, "Commit candidate not found", { candidate: id }); fail(ERROR_CODES.STORAGE_ERROR, "Invalid commit candidate metadata", { cause: error.message }); }
    validateCandidate(data, id);
    if (workspace && data.workspace !== normalizeWorkspaceId(workspace)) fail(ERROR_CODES.NOT_FOUND, "Commit candidate is not associated with this workspace", { candidate: id });
    if (!includePatch) return data;
    let patch;
    try { patch = fs.readFileSync(this.patchFile(id), "utf8"); }
    catch (error) { fail(ERROR_CODES.STORAGE_ERROR, "Commit candidate patch is unavailable", { cause: error.message }); }
    return { ...data, patch };
  }

  write(data, patch = null) {
    validateCandidate(data, data.candidate);
    atomicWrite(this.metadataFile(data.candidate), `${JSON.stringify(data, null, 2)}\n`);
    if (patch !== null) atomicWrite(this.patchFile(data.candidate), patch);
  }

  create(workspace, title, message = null, options = {}) {
    workspace = options.allowStandard ? this.assertWorkspace(workspace) : this.assertStartup(workspace);
    if (!title?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Candidate title is required");
    const strategy = options.strategy ?? "exact";
    if (!strategies.has(strategy)) fail(ERROR_CODES.INVALID_ARGUMENT, "Candidate strategy must be 'exact', 'shared_foundation' or 'integration'");
    if (options.relatedStages !== undefined && !Array.isArray(options.relatedStages)) fail(ERROR_CODES.INVALID_ARGUMENT, "Related stages must be an array");
    const relatedStages = (options.relatedStages || []).map(normalizeStageId);
    if (new Set(relatedStages).size !== relatedStages.length) fail(ERROR_CODES.INVALID_ARGUMENT, "Related stages must be unique");
    for (const stage of relatedStages) this.context.storage.readStage(workspace, stage);
    const repository = repositoryState(this.context.storage.projectRoot);
    const id = this.nextId();
    const now = new Date().toISOString();
    const data = { schema: 1, candidate: id, workspace, title: title.trim(), message: message?.trim() || title.trim(), strategy, related_stages: relatedStages, base_head: repository.head, status: "draft", created_at: now, updated_at: now, selected_paths: [], patch_file: `${id}.patch` };
    this.write(data, "");
    return data;
  }

  list(workspace) {
    workspace = this.assertStartup(workspace);
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter((file) => candidatePattern.test(file.slice(0, -5)) && file.endsWith(".json"))
      .map((file) => this.read(file.slice(0, -5))).filter((item) => item.workspace === workspace)
      .sort((a, b) => a.candidate.localeCompare(b.candidate));
  }

  summary(workspace) {
    return this.activeProjection(workspace).summary;
  }

  projectionRecords(workspace) {
    workspace = normalizeWorkspaceId(workspace);
    this.context.storage.readWorkspace(workspace);
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory)
      .filter((file) => candidatePattern.test(file.slice(0, -5)) && file.endsWith(".json"))
      .sort()
      .flatMap((file) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.directory, file), "utf8"));
          if (data?.workspace !== workspace) return [];
          return [validateCandidate(data, file.slice(0, -5))];
        } catch { return []; }
      });
  }

  activeProjection(workspace) {
    const projection = { summary: { pending: 0, ready: 0 }, by_stage: {} };
    workspace = this.assertStartup(workspace);
    for (const candidate of this.projectionRecords(workspace)) {
      if (!["draft", "ready"].includes(candidate.status)) continue;
      if (candidate.status === "draft") projection.summary.pending += 1;
      if (candidate.status === "ready") projection.summary.ready += 1;
      const related = {
        candidate: candidate.candidate,
        title: candidate.title.slice(0, projectionTitleLimit),
        status: candidate.status,
        strategy: candidate.strategy || "exact",
        related_stages: candidate.related_stages || [],
      };
      for (const stage of related.related_stages) {
        const stageProjection = projection.by_stage[stage] ||= { draft: 0, ready: 0, items: [] };
        stageProjection[candidate.status] += 1;
        if (stageProjection.items.length < projectionCandidateLimit) stageProjection.items.push(related);
      }
    }
    return projection;
  }

  committedProjection(workspace) {
    const records = this.projectionRecords(workspace)
      .filter((candidate) => candidate.status === "committed")
      .sort((left, right) => left.committed_at.localeCompare(right.committed_at) || left.candidate.localeCompare(right.candidate));
    return {
      count: records.length,
      items: records.slice(-deliveryCandidateLimit).map((candidate) => ({
        candidate: candidate.candidate,
        title: candidate.title.slice(0, projectionTitleLimit),
        strategy: candidate.strategy || "exact",
        related_stages: candidate.related_stages || [],
        commit_hash: candidate.commit_hash,
        committed_at: candidate.committed_at,
      })),
    };
  }

  capture(workspace, id, input, options = {}) {
    workspace = options.allowStandard ? this.assertWorkspace(workspace) : this.assertStartup(workspace);
    const data = this.read(id, workspace);
    if (data.status !== "draft") fail(ERROR_CODES.INVALID_STATE, "Only draft candidates can be captured", { status: data.status });
    const hasPaths = Array.isArray(input.paths);
    const hasPatch = input.patch !== undefined;
    if (hasPaths === hasPatch) fail(ERROR_CODES.INVALID_ARGUMENT, "Provide exactly one of paths or patch");
    const root = repositoryState(this.context.storage.projectRoot).root;
    const captured = hasPaths
      ? capturePaths(root, this.context.storage.personalRoot, data.base_head, input.paths)
      : capturePatch(root, this.context.storage.personalRoot, data.base_head, input.patch);
    data.selected_paths = captured.paths;
    data.updated_at = new Date().toISOString();
    this.write(data, captured.patch);
    return { ...data, patch: captured.patch };
  }

  preview(workspace, id, options = {}) {
    workspace = options.allowStandard ? this.assertWorkspace(workspace) : this.assertStartup(workspace);
    const data = this.read(id, workspace, true);
    if (!data.patch) fail(ERROR_CODES.INVALID_STATE, "Commit candidate has not captured a patch");
    return { candidate: data, preview: previewPatch(this.context.storage.projectRoot, data.base_head, data.patch) };
  }

  setStatus(workspace, id, status, options = {}) {
    workspace = options.allowStandard ? this.assertWorkspace(workspace) : this.assertStartup(workspace);
    const data = this.read(id, workspace, true);
    if (status === "ready" && data.status !== "draft") fail(ERROR_CODES.INVALID_STATE, "Only draft candidates can become ready", { status: data.status });
    if (status === "discarded" && data.status === "discarded") return data;
    if (status === "discarded" && data.status === "committed") fail(ERROR_CODES.INVALID_STATE, "Committed candidates cannot be discarded", { status: data.status });
    if (status === "ready" && !data.patch) fail(ERROR_CODES.INVALID_STATE, "Cannot ready a candidate without a captured patch");
    data.status = status;
    data.updated_at = new Date().toISOString();
    const { patch, ...metadata } = data;
    this.write(metadata);
    return metadata;
  }

  commit(workspace, id, message = undefined, options = {}) {
    workspace = options.allowStandard ? this.assertWorkspace(workspace) : this.assertStartup(workspace);
    const data = this.read(id, workspace, true);
    if (data.status !== "ready") fail(ERROR_CODES.INVALID_STATE, "Only ready candidates can be committed", { status: data.status });
    if (message !== undefined && (typeof message !== "string" || !message.trim())) fail(ERROR_CODES.INVALID_ARGUMENT, "Commit message must be a non-empty string");
    const commitMessage = message === undefined ? data.message : message.trim();
    let metadata;
    const published = commitPatch(this.context.storage.projectRoot, data.base_head, data.patch, commitMessage, {
      expectedHead: options.expectedHead,
      beforeUpdateRef: (pending) => {
        const committedAt = new Date().toISOString();
        data.message = commitMessage;
        data.status = "committed";
        data.commit_hash = pending.commit;
        data.committed_at = committedAt;
        data.updated_at = committedAt;
        const { patch, ...record } = data;
        metadata = record;
        this.write(metadata);
        options.beforeUpdateRef?.(pending);
      },
      afterUpdateRef: (publication) => options.afterUpdateRef?.({ ...publication, candidate_record: metadata, patch: data.patch }),
    });
    return { ...metadata, branch: published.branch, previous_head: published.previous_head, stale: published.stale };
  }

  normalizeRelatedStages(workspace, values = []) {
    if (!Array.isArray(values)) fail(ERROR_CODES.INVALID_ARGUMENT, "Related stages must be an array");
    const stages = values.map(normalizeStageId);
    if (new Set(stages).size !== stages.length) fail(ERROR_CODES.INVALID_ARGUMENT, "Related stages must be unique");
    return stages.map((stage) => {
      const record = this.context.storage.readStage(workspace, stage);
      return { stage, title: record.data.title };
    });
  }

  generatedMessage(audit, stages) {
    const paths = audit.included_paths;
    let subject;
    let conventionalType = "chore";
    if (paths.every((item) => /^(?:docs\/|README(?:\.|$)|[^/]+\.md$)/i.test(item))) { subject = "Update documentation"; conventionalType = "docs"; }
    else if (paths.every((item) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.test\.[^/]+$/.test(item))) { subject = "Expand test coverage"; conventionalType = "test"; }
    else if (paths.some((item) => /candidate|git-candidate/.test(item)) || (stages.length === 1 && /commit[- ]all/i.test(stages[0].title))) { subject = "Add repository-local commit-all flow"; conventionalType = "feat"; }
    else subject = paths.length === 1 ? `Update ${path.basename(paths[0])}` : "Integrate repository changes";
    const conventional = audit.recent_subjects.filter((item) => /^[a-z]+(?:\([^)]+\))?!?:\s/.test(item)).length > audit.recent_subjects.length / 2;
    return conventional ? `${conventionalType}: ${subject[0].toLowerCase()}${subject.slice(1)}` : subject;
  }

  inspectAll(workspace, options = {}) {
    workspace = this.assertWorkspace(workspace);
    if (options.message !== undefined && (typeof options.message !== "string" || !options.message.trim())) fail(ERROR_CODES.INVALID_ARGUMENT, "Commit message must be a non-empty string");
    const audit = inspectCommitAll(this.context.storage.projectRoot, this.context.storage.personalRoot, { excludePaths: options.excludePaths });
    if (!audit.included_paths.length) fail(ERROR_CODES.COMMIT_ALL_NO_CHANGES, "No eligible repository changes are available to commit", { excluded_paths: audit.excluded_paths });
    let relatedStages = options.relatedStages;
    let attributionBasis = relatedStages === undefined ? "workspace_integration" : "user_selected";
    if (relatedStages === undefined) {
      relatedStages = this.projectionRecords(workspace).filter((candidate) => ["draft", "ready"].includes(candidate.status) && candidate.strategy === "integration")
        .flatMap((candidate) => {
          try {
            const patch = this.read(candidate.candidate, workspace, true).patch;
            return createHash("sha256").update(patch).digest("hex") === audit.patch_fingerprint ? (candidate.related_stages || []) : [];
          } catch { return []; }
        });
      relatedStages = [...new Set(relatedStages)].sort();
      if (relatedStages.length) attributionBasis = "exact_candidate_relation";
    }
    const stages = this.normalizeRelatedStages(workspace, relatedStages).map((stage) => ({ ...stage, evidence: attributionBasis }));
    const message = options.message?.trim() || this.generatedMessage(audit, stages);
    const plan = {
      workspace,
      base_head: audit.base_head,
      patch_fingerprint: audit.patch_fingerprint,
      included_paths: audit.included_paths,
      excluded_paths: audit.excluded_paths,
      related_stages: stages.map((item) => item.stage),
      message,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const result = {
      workspace,
      repository_root: audit.repository_root,
      strategy: "integration",
      fingerprint,
      base_head: audit.base_head,
      included_paths: audit.included_paths,
      excluded_paths: audit.excluded_paths,
      unattributed_paths: audit.included_paths,
      contributing_stages: stages,
      attribution: { basis: attributionBasis, complete: false },
      message,
      message_source: options.message === undefined ? "generated" : "user",
      verification: { patch_fingerprint: audit.patch_fingerprint, stat: audit.stat, recent_subjects: audit.recent_subjects, included_path_count: audit.included_paths.length, excluded_path_count: audit.excluded_paths.length },
      policy_exclusions: [".work-context/local/**", ".work-context/.locks/**", ".work-context/.transactions/**"],
    };
    return options.includePatch ? { ...result, patch: audit.patch } : result;
  }

  commitAll(workspace, expectedFingerprint, confirmation, options = {}) {
    if (confirmation !== "COMMIT_ALL_CONFIRMED") fail(ERROR_CODES.COMMIT_ALL_CONFIRMATION_REQUIRED, "Commit all requires the exact COMMIT_ALL_CONFIRMED confirmation");
    if (typeof expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) fail(ERROR_CODES.INVALID_ARGUMENT, "Expected fingerprint must be a SHA-256 hash");
    const inspection = this.inspectAll(workspace, { ...options, includePatch: true });
    if (inspection.fingerprint !== expectedFingerprint) fail(ERROR_CODES.COMMIT_ALL_STALE_PLAN, "Repository changes no longer match the inspected commit-all plan", { expected_fingerprint: expectedFingerprint, actual_fingerprint: inspection.fingerprint });
    options.beforeCandidate?.(inspection);
    if (repositoryState(this.context.storage.projectRoot).head !== inspection.base_head) fail(ERROR_CODES.COMMIT_ALL_STALE_PLAN, "Git HEAD no longer matches the confirmed commit-all plan", { expected_head: inspection.base_head });
    const patchHash = (value) => createHash("sha256").update(value).digest("hex");
    const duplicate = this.projectionRecords(workspace).filter((candidate) => ["draft", "ready"].includes(candidate.status)
      && candidate.strategy === "integration" && candidate.base_head === inspection.base_head
      && candidate.message === inspection.message && JSON.stringify(candidate.related_stages || []) === JSON.stringify(inspection.contributing_stages.map((item) => item.stage)))
      .find((candidate) => {
        try { return patchHash(this.read(candidate.candidate, workspace, true).patch) === inspection.verification.patch_fingerprint; } catch { return false; }
      });
    const allowStandard = { allowStandard: true };
    let candidate = duplicate || this.create(workspace, inspection.message.split("\n", 1)[0], inspection.message, { ...allowStandard, strategy: "integration", relatedStages: inspection.contributing_stages.map((item) => item.stage) });
    if (candidate.base_head !== inspection.base_head) fail(ERROR_CODES.COMMIT_ALL_STALE_PLAN, "Git HEAD changed while constructing the confirmed commit-all candidate", { expected_head: inspection.base_head, actual_head: candidate.base_head });
    if (!duplicate) candidate = this.capture(workspace, candidate.candidate, { paths: inspection.included_paths }, allowStandard);
    const preview = this.preview(workspace, candidate.candidate, allowStandard).preview;
    if (patchHash(preview.patch) !== inspection.verification.patch_fingerprint) fail(ERROR_CODES.COMMIT_ALL_VERIFICATION_FAILED, "Candidate preview does not match the confirmed commit-all patch");
    if (candidate.status === "draft") candidate = this.setStatus(workspace, candidate.candidate, "ready", allowStandard);
    const committed = this.commit(workspace, candidate.candidate, undefined, { ...allowStandard, expectedHead: inspection.base_head, afterUpdateRef: options.afterUpdateRef });
    const { patch, ...audit } = inspection;
    return { ...audit, candidate: committed.candidate, candidate_reused: Boolean(duplicate), commit: { sha: committed.commit_hash, branch: committed.branch, previous_head: committed.previous_head } };
  }
}
