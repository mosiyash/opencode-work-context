import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FileStorage, atomicWrite, withLock, defaultConfig, loadConfig } from "./storage.js";
import { ERROR_CODES, fail } from "./errors.js";
import { event, reduceSessions, activeSession, assertActive } from "./sessions.js";
import { generateProjections, renderSessions } from "./projections.js";
import { nextKnowledgeId, parseKnowledge, renderKnowledge, validateKnowledgeInput, validateKnowledgeRecords } from "./knowledge.js";

const id = (value, digits) => {
  const normalized = String(value);
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) fail(ERROR_CODES.INVALID_ARGUMENT, `Expected ${digits}-digit identifier`);
  return normalized;
};
const stageId = (value) => id(String(value).padStart(2, "0"), 2);
const actor = (options) => options.actor || "OpenCode";
const body = (title, goal = "") => `# ${title}\n\n${goal ? `## Goal\n\n${goal}\n` : ""}`;
const assertNoSymlinkPath = (file) => { let current = path.parse(file).root; for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); try { if (fs.lstatSync(current).isSymbolicLink()) fail(ERROR_CODES.STORAGE_ERROR, `Symlink path component is not supported: ${current}`); } catch (error) { if (error.code !== "ENOENT") throw error; break; } } };

function parseIssue(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/([^/]+)\/-\/issues\/(\d+)\/?$/);
    if (!/^https?:$/.test(parsed.protocol) || !match) fail(ERROR_CODES.INVALID_ISSUE_URL, "Expected a GitLab issue URL");
    return { url: parsed.toString(), provider: "gitlab", project: parsed.pathname.split("/-/issues/")[0].replace(/^\//, ""), iid: Number(match[2]) };
  } catch (error) {
    if (error.code === ERROR_CODES.INVALID_ISSUE_URL) throw error;
    fail(ERROR_CODES.INVALID_ISSUE_URL, "Invalid issue URL");
  }
}

export class WorkContext {
  constructor(storage, options = {}) {
    this.storage = storage.configure(options.initialize !== false);
    this.options = options;
  }

  static open(projectRoot, options = {}) {
    const root = path.resolve(projectRoot);
    const configDir = path.join(root, ".work-context");
    assertNoSymlinkPath(configDir);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, "config.yaml");
    assertNoSymlinkPath(configFile);
    if (!fs.existsSync(configFile)) atomicWrite(configFile, defaultConfig());
    return new WorkContext(new FileStorage(root, { ...loadConfig(root), ...(options.config || {}) }), options);
  }

  static openExisting(projectRoot, options = {}) {
    const root = path.resolve(projectRoot);
    assertNoSymlinkPath(path.join(root, ".work-context"));
    assertNoSymlinkPath(path.join(root, ".work-context", "config.yaml"));
    return new WorkContext(new FileStorage(root, { ...loadConfig(root), ...(options.config || {}) }), { ...options, initialize: false });
  }

  writeEvents(events) {
    this.storage.appendEvents(events);
    atomicWrite(path.join(this.storage.personalRoot, "SESSIONS.md"), renderSessions(reduceSessions(this.storage.readEvents())));
  }

  transact(name, fn) {
    // Все mutating operations меняют общий sessions.jsonl, поэтому нужен единый lock.
    this.storage.assertSafeRoots();
    return withLock(this.storage.lockPath("write"), () => {
      this.storage.assertNoSymlinks();
      this.storage.recoverTransaction();
      this.storage.assertNoSymlinks();
      const snapshot = this.storage.snapshot();
      this.storage.writeTransaction(snapshot);
      try { const result = fn(); this.storage.clearTransaction(); return result; }
      catch (error) { this.storage.restore(snapshot); this.storage.clearTransaction(); throw error; }
    }, { session: this.options.sessionId, owner: actor(this.options) });
  }

  listWorkspaces() {
    this.storage.assertNoSymlinks();
    if (!fs.existsSync(this.storage.root)) return { ok: true, data: [] };
    const data = fs.readdirSync(this.storage.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{6}$/.test(entry.name))
      .map((entry) => this.storage.readWorkspace(entry.name).data);
    return { ok: true, data };
  }

  listStages(workspace) {
    this.storage.assertNoSymlinks();
    id(workspace, 6);
    const dir = path.join(this.storage.workspaceDir(workspace), "stages");
    if (!fs.existsSync(dir)) fail(ERROR_CODES.NOT_FOUND, "Workspace not found");
    const stages = fs.readdirSync(dir).filter((file) => /^\d{2}\.md$/.test(file)).map((file) => {
      const stage = this.storage.readStage(workspace, file.slice(0, 2)).data;
      return { ...stage, description: stage.goal };
    });
    const ids = new Set(stages.map((item) => item.stage));
    const visiting = new Set();
    const visited = new Set();
    const visit = (stage) => {
      if (visiting.has(stage)) fail(ERROR_CODES.STORAGE_ERROR, "Stage dependency cycle detected");
      if (visited.has(stage)) return;
      visiting.add(stage);
      for (const dependency of stages.find((item) => item.stage === stage).depends_on) {
        if (!ids.has(dependency)) fail(ERROR_CODES.STORAGE_ERROR, `Missing stage dependency: ${dependency}`);
        visit(dependency);
      }
      visiting.delete(stage); visited.add(stage);
    };
    for (const stage of ids) visit(stage);
    return { ok: true, data: { workspace, stages, sessions: reduceSessions(this.storage.readEvents()).filter((session) => session.workspace === workspace) } };
  }

  finishWorkspace(workspace) {
    id(workspace, 6);
    return this.transact(`workspace-${workspace}`, () => {
      const record = this.storage.readWorkspace(workspace);
      const stages = this.listStages(workspace).data.stages;
      if (record.data.status === "cancelled") fail(ERROR_CODES.INVALID_STATE, "Cancelled workspace cannot be finished", { workspace, status: record.data.status });
       const incompleteStages = stages.filter((stage) => stage.status !== "completed" && stage.status !== "archived");
      if (incompleteStages.length) fail(ERROR_CODES.INVALID_STATE, "All workspace stages must be completed before finishing", {
        workspace,
        incompleteStages: incompleteStages.map(({ stage, title, description, status }) => ({ stage, title, description, status })),
      });
      if (record.data.status === "completed") return this.result({ workspace, status: "completed", stages }, []);
      record.data.status = "completed";
      record.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.workspaceFile(workspace), record.data, record.body);
      generateProjections(this.storage);
      return this.result({ workspace, status: "completed", stages }, [workspace]);
    });
  }

  sessionById(sessionId) {
    return reduceSessions(this.storage.readEvents()).find((session) => session.session_id === sessionId) || null;
  }

  assertDependenciesCompleted(workspace, stageRecord) {
    const stages = this.listStages(workspace).data.stages;
    for (const dependency of stageRecord.data.depends_on) {
      const record = stages.find((item) => item.stage === dependency);
      if (!record || record.status !== "completed") fail(ERROR_CODES.INVALID_STATE, `Stage dependency is not completed: ${dependency}`);
    }
  }

  createWorkspace(title, options = {}) {
    if (!title?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Title is required");
    const requestedWorkspace = options.workspace;
    return this.transact("workspace-create", () => {
      const workspace = requestedWorkspace || this.nextWorkspace();
      id(workspace, 6);
      const now = new Date().toISOString();
      if (fs.existsSync(this.storage.workspaceDir(workspace))) fail(ERROR_CODES.CONFLICT, "Workspace already exists");
      fs.mkdirSync(path.join(this.storage.workspaceDir(workspace), "stages"), { recursive: true });
      this.storage.writeMarkdown(this.storage.workspaceFile(workspace), { schema: 1, workspace, title: title.trim(), status: "in_progress", created_at: now, updated_at: now, tracker_links: [] }, body(title));
      this.storage.writeMarkdown(this.storage.stageFile(workspace, "01"), { schema: 1, workspace, stage: "01", title: "Планирование", status: "in_progress", goal: "Уточнить цель и ограничения работы", depends_on: [], owner: actor(this.options), created_at: now, updated_at: now, tracker_links: [] }, body("Планирование", "Уточнить цель и ограничения работы"));
      const sessionId = options.sessionId || randomUUID();
      if (this.storage.readEvents().some((item) => item.session_id === sessionId)) fail(ERROR_CODES.CONFLICT, "Session ID already exists");
      this.writeEvents([event("session.started", workspace, "01", 1, sessionId, actor(this.options), { summary: `планирование ${title.trim()}`, opencode_session_id: options.opencodeSessionId || null, branch: options.branch || null })]);
      generateProjections(this.storage);
      return this.result({ workspace, stage: "01", session_id: sessionId, ordinal: "01/01" }, [workspace, "01"]);
    });
  }

  nextWorkspace() {
    const ids = this.listWorkspaces().data.map((workspace) => Number(workspace.workspace));
    return String(Math.max(0, ...ids) + 1).padStart(6, "0");
  }

  startSession(workspace, stage, options = {}) {
    id(workspace, 6);
    stage = stageId(stage);
    const sessionId = options.sessionId || randomUUID();
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const stageRecord = this.storage.readStage(workspace, stage);
      this.assertDependenciesCompleted(workspace, stageRecord);
      const events = this.storage.readEvents();
      if (activeSession(events, workspace, stage)) fail(ERROR_CODES.ACTIVE_SESSION_EXISTS, "Stage already has an active session");
      if (["completed", "cancelled", "archived"].includes(stageRecord.data.status)) fail(ERROR_CODES.INVALID_STATE, "Cannot start a session for a terminal stage");
      if (reduceSessions(events).some((session) => session.session_id === sessionId)) fail(ERROR_CODES.CONFLICT, "Session ID already exists");
      const previous = reduceSessions(events).filter((session) => session.workspace === workspace && session.stage === stage);
      const ordinal = previous.length + 1;
      if (stageRecord.data.status === "planned") {
        stageRecord.data.status = "in_progress";
        stageRecord.data.updated_at = new Date().toISOString();
        this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), stageRecord.data, stageRecord.body);
      }
      this.writeEvents([event("session.started", workspace, stage, ordinal, sessionId, actor(this.options), { summary: options.summary || "продолжение работы", opencode_session_id: options.opencodeSessionId || null, branch: options.branch || null })]);
      generateProjections(this.storage);
      return this.result({ workspace, stage, session_id: sessionId, ordinal: `${stage}/${String(ordinal).padStart(2, "0")}` }, [workspace, stage]);
    });
  }

  addStage(workspace, title, options = {}) {
    id(workspace, 6);
    if (!title?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Title is required");
    const dependsOn = options.dependsOn || [];
    if (!Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length || dependsOn.some((item) => typeof item !== "string" || !/^\d{2}$/.test(item))) fail(ERROR_CODES.INVALID_ARGUMENT, "dependsOn must contain unique two-digit stage IDs");
    return this.transact(`workspace-${workspace}`, () => {
      const stages = this.listStages(workspace).data.stages;
      if (stages.length >= 99) fail(ERROR_CODES.INVALID_STATE, "A workspace cannot contain more than 99 stages");
      const stage = String(Math.max(0, ...stages.map((item) => Number(item.stage))) + 1).padStart(2, "0");
      if (dependsOn.includes(stage)) fail(ERROR_CODES.INVALID_ARGUMENT, "A stage cannot depend on itself");
      if (dependsOn.some((dependency) => !stages.some((item) => item.stage === dependency))) fail(ERROR_CODES.INVALID_ARGUMENT, "dependsOn must reference existing stages");
      const now = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), { schema: 1, workspace, stage, title: title.trim(), status: "planned", goal: options.goal || title.trim(), depends_on: dependsOn, owner: options.owner || actor(this.options), created_at: now, updated_at: now, tracker_links: [] }, body(title, options.goal || title));
      generateProjections(this.storage);
      return this.result({ workspace, stage }, [stage]);
    });
  }

  renameStage(workspace, stage, title) {
    id(workspace, 6);
    stage = stageId(stage);
    if (!title?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Title is required");
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const record = this.storage.readStage(workspace, stage);
      const nextTitle = title.trim();
      if (record.data.title === nextTitle) return this.result({ workspace, stage, title: nextTitle }, []);
      record.data.title = nextTitle;
      record.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), record.data, body(nextTitle, record.data.goal));
      generateProjections(this.storage);
      return this.result({ workspace, stage, title: nextTitle }, [workspace, stage]);
    });
  }

  archiveStage(workspace, stage) {
    id(workspace, 6);
    stage = stageId(stage);
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const record = this.storage.readStage(workspace, stage);
      if (record.data.status === "archived") return this.result({ workspace, stage, status: "archived" }, []);
      if (activeSession(this.storage.readEvents(), workspace, stage)) fail(ERROR_CODES.ACTIVE_SESSION_EXISTS, "Cannot archive a stage with an active session");
      record.data.status = "archived";
      record.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), record.data, record.body);
      generateProjections(this.storage);
      return this.result({ workspace, stage, status: "archived" }, [workspace, stage]);
    });
  }

  listKnowledge(workspace) {
    id(workspace, 6);
    this.storage.assertNoSymlinks();
    this.storage.readWorkspace(workspace);
    const text = this.storage.readKnowledge(workspace);
    return { ok: true, data: text ? parseKnowledge(text) : [] };
  }

  addKnowledge(workspace, input) {
    id(workspace, 6);
    validateKnowledgeInput(input);
    return this.transact(`workspace-${workspace}`, () => {
      const records = this.listKnowledge(workspace).data;
      const timestamp = new Date().toISOString();
      const record = { id: nextKnowledgeId(records), title: input.title.trim(), kind: input.kind || "fact", status: "active", created: timestamp, updated: timestamp, sources: input.sources || [], text: input.text.trim() };
      atomicWrite(this.storage.knowledgeFile(workspace), renderKnowledge([...records, record]));
      return this.result(record, [this.storage.knowledgeFile(workspace)]);
    });
  }

  updateKnowledge(workspace, knowledgeId, input) {
    id(workspace, 6);
    validateKnowledgeInput(input, true);
    return this.transact(`workspace-${workspace}`, () => {
      const records = this.listKnowledge(workspace).data;
      const record = records.find((item) => item.id === knowledgeId);
      if (!record) fail(ERROR_CODES.NOT_FOUND, `Knowledge entry not found: ${knowledgeId}`);
      Object.assign(record, input.title === undefined ? {} : { title: input.title.trim() }, input.kind === undefined ? {} : { kind: input.kind }, input.status === undefined ? {} : { status: input.status, ...(input.status === "active" ? { replacement: null } : {}) }, input.text === undefined ? {} : { text: input.text.trim() }, input.sources === undefined ? {} : { sources: input.sources }, input.replacement === undefined ? {} : { replacement: input.replacement }, { updated: new Date().toISOString() });
      validateKnowledgeRecords(records);
      const rendered = renderKnowledge(records);
      parseKnowledge(rendered);
      atomicWrite(this.storage.knowledgeFile(workspace), rendered);
      return this.result(record, [this.storage.knowledgeFile(workspace)]);
    });
  }

  supersedeKnowledge(workspace, knowledgeId, replacement = null) {
    if (replacement === knowledgeId) fail(ERROR_CODES.INVALID_ARGUMENT, "Knowledge cannot supersede itself");
    return this.updateKnowledge(workspace, knowledgeId, { status: "superseded", ...(replacement ? { replacement } : {}) });
  }

  linkIssue(workspace, url, stage = null) {
    const normalizedWorkspace = id(workspace, 6);
    const normalizedStage = stage ? stageId(stage) : null;
    const parsed = parseIssue(url);
    return this.transact(`link-${workspace}-${stage || "workspace"}`, () => {
      const file = normalizedStage ? this.storage.stageFile(normalizedWorkspace, normalizedStage) : this.storage.workspaceFile(normalizedWorkspace);
      const current = normalizedStage ? this.storage.readStage(normalizedWorkspace, normalizedStage) : this.storage.readWorkspace(normalizedWorkspace);
      const links = current.data.tracker_links || [];
      if (links.some((link) => link.url === parsed.url)) return this.result({ workspace: normalizedWorkspace, stage: normalizedStage, issue: parsed }, []);
      links.push(parsed);
      current.data.tracker_links = links;
      current.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(file, current.data, current.body);
      generateProjections(this.storage);
      return this.result({ workspace: normalizedWorkspace, stage: normalizedStage, issue: parsed }, [file]);
    });
  }

  renameSession(workspace, stage, sessionId, summary) {
    if (!summary?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Summary is required");
    stage = stageId(stage);
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const session = assertActive(this.storage.readEvents(), workspace, stage, sessionId);
      if (session.summary === summary.trim()) return this.result({ session_id: sessionId, summary: summary.trim() }, []);
      this.writeEvents([event("session.renamed", workspace, stage, session.ordinal, sessionId, actor(this.options), { summary: summary.trim() })]);
      return this.result({ session_id: sessionId, summary: summary.trim() }, []);
    });
  }

  closeSession(workspace, stage, sessionId, reason = "closed", state = "closed") {
    stage = stageId(stage);
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const session = assertActive(this.storage.readEvents(), workspace, stage, sessionId);
      this.writeEvents([event(`session.${state}`, workspace, stage, session.ordinal, sessionId, actor(this.options), { reason })]);
      return this.result({ session_id: sessionId, state }, []);
    });
  }

  handoff(workspace, stage, sessionId, options = {}) {
    stage = stageId(stage);
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const session = assertActive(this.storage.readEvents(), workspace, stage, sessionId);
      this.writeEvents([event("session.handed_off", workspace, stage, session.ordinal, sessionId, actor(this.options), { reason: options.reason || "handoff" })]);
      generateProjections(this.storage);
      return this.result({ session_id: sessionId, state: "handed_off" }, []);
    });
  }

  abandon(workspace, stage, sessionId, reason = "abandoned") {
    return this.closeSession(workspace, stage, sessionId, reason, "abandoned");
  }

  finish(workspace, stage, sessionId, options = {}) {
    stage = stageId(stage);
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const events = this.storage.readEvents();
      const current = this.storage.readStage(workspace, stage);
      this.assertDependenciesCompleted(workspace, current);
      const known = reduceSessions(events).find((item) => item.session_id === sessionId && item.workspace === workspace && item.stage === stage);
      if (current.data.status === "completed") {
        if (known?.state === "closed") return this.result({ session_id: sessionId, workspace, stage, state: "closed", status: "completed" }, []);
        fail(ERROR_CODES.SESSION_NOT_ACTIVE, "Session did not complete this stage");
      }
      const knowledgeReview = options.knowledgeReview || "auto";
      if (!['auto', 'added', 'none'].includes(knowledgeReview)) fail(ERROR_CODES.INVALID_ARGUMENT, "Knowledge review must be 'auto', 'added' or 'none'");
      const knowledgeEntries = knowledgeReview === "auto" ? this.listKnowledge(workspace).data : null;
      const active = activeSession(events, workspace, stage);
      if (!active || active.session_id !== sessionId) fail(active ? ERROR_CODES.ACTIVE_SESSION_EXISTS : ERROR_CODES.SESSION_NOT_ACTIVE, active ? "Another active session owns this stage" : "Session is not active");
      this.writeEvents([event("session.closed", workspace, stage, active.ordinal, sessionId, actor(this.options), { reason: "stage_completed" })]);
      current.data.status = "completed";
      current.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), current.data, `${current.body}\n\n## Result\n\n${options.result || "Stage completed."}`);
      generateProjections(this.storage);
      return this.result({ session_id: sessionId, workspace, stage, state: "closed", status: "completed", knowledge_review: knowledgeReview, ...(knowledgeEntries ? { knowledge_entries: knowledgeEntries.length } : {}) }, [workspace, stage]);
    });
  }

  help(command = "") {
     return this.result({ command, syntax: "/wc [create|list|workspace list|workspace finish|resume|stage add|stage rename|stage archive|stage handoff|stage abandon|stage finish|link-issue|session rename|knowledge list|knowledge add|knowledge update|knowledge supersede|help]", note: "workspace is optional for stage add/rename/archive when the current session identifies one workspace; workspace finish requires all non-archived stages to be completed; archived stages retain their IDs and history and are hidden from the TUI by default; stage finish reviews Knowledge Base automatically by default (knowledgeReview=auto); mutating commands call structured tools; only explicit lifecycle operations change storage." }, []);
  }

  result(data, changed) {
    return { ok: true, data, changed, next: null };
  }
}
