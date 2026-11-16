import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./storage.js";
import { ERROR_CODES, fail } from "./errors.js";
import { normalizeWorkspaceId } from "./identifiers.js";
import { capturePatch, capturePaths, commitPatch, previewPatch, repositoryState } from "./git-candidates.js";

const candidatePattern = /^CC-(\d{6})$/;
const statuses = new Set(["draft", "ready", "discarded", "committed"]);
const timestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const metadataKeys = ["schema", "candidate", "workspace", "title", "message", "base_head", "status", "created_at", "updated_at", "selected_paths", "patch_file"];

function validateCandidate(data, expectedId = null) {
  const valid = data && typeof data === "object" && !Array.isArray(data)
    && metadataKeys.every((key) => Object.hasOwn(data, key))
    && Object.keys(data).every((key) => metadataKeys.includes(key) || ["commit_hash", "committed_at"].includes(key))
    && data.schema === 1 && candidatePattern.test(data.candidate) && (!expectedId || data.candidate === expectedId)
    && /^\d{6}$/.test(data.workspace) && typeof data.title === "string" && data.title.trim()
    && typeof data.message === "string" && data.message.trim() && /^[0-9a-f]{40,64}$/.test(data.base_head)
    && statuses.has(data.status) && timestamp(data.created_at) && timestamp(data.updated_at)
    && Date.parse(data.updated_at) >= Date.parse(data.created_at)
    && Array.isArray(data.selected_paths) && data.selected_paths.every((item) => typeof item === "string" && item && !path.isAbsolute(item) && !item.split("/").includes(".."))
    && new Set(data.selected_paths).size === data.selected_paths.length
    && data.patch_file === `${data.candidate}.patch`
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

  create(workspace, title, message = null) {
    workspace = this.assertStartup(workspace);
    if (!title?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Candidate title is required");
    const repository = repositoryState(this.context.storage.projectRoot);
    const id = this.nextId();
    const now = new Date().toISOString();
    const data = { schema: 1, candidate: id, workspace, title: title.trim(), message: message?.trim() || title.trim(), base_head: repository.head, status: "draft", created_at: now, updated_at: now, selected_paths: [], patch_file: `${id}.patch` };
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
    return this.list(workspace).reduce((summary, candidate) => {
      if (candidate.status === "draft") summary.pending += 1;
      if (candidate.status === "ready") summary.ready += 1;
      return summary;
    }, { pending: 0, ready: 0 });
  }

  capture(workspace, id, input) {
    workspace = this.assertStartup(workspace);
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

  preview(workspace, id) {
    workspace = this.assertStartup(workspace);
    const data = this.read(id, workspace, true);
    if (!data.patch) fail(ERROR_CODES.INVALID_STATE, "Commit candidate has not captured a patch");
    return { candidate: data, preview: previewPatch(this.context.storage.projectRoot, data.base_head, data.patch) };
  }

  setStatus(workspace, id, status) {
    workspace = this.assertStartup(workspace);
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
    workspace = this.assertStartup(workspace);
    const data = this.read(id, workspace, true);
    if (data.status !== "ready") fail(ERROR_CODES.INVALID_STATE, "Only ready candidates can be committed", { status: data.status });
    if (message !== undefined && (typeof message !== "string" || !message.trim())) fail(ERROR_CODES.INVALID_ARGUMENT, "Commit message must be a non-empty string");
    const commitMessage = message === undefined ? data.message : message.trim();
    let metadata;
    const published = commitPatch(this.context.storage.projectRoot, data.base_head, data.patch, commitMessage, {
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
    });
    return { ...metadata, branch: published.branch, previous_head: published.previous_head, stale: published.stale };
  }
}
