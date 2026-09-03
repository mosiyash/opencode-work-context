import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FileStorage, atomicWrite, withLock, defaultConfig, loadConfig } from "./storage.js";
import { ERROR_CODES, fail } from "./errors.js";
import { event, reduceSessions, activeSession, assertActive } from "./sessions.js";
import { generateProjections, renderSessions } from "./projections.js";
import { nextKnowledgeId, parseKnowledge, renderKnowledge, validateKnowledgeInput, validateKnowledgeRecords } from "./knowledge.js";
import { normalizeStageId, normalizeWorkspaceId } from "./identifiers.js";

const actor = (options) => options.actor || "OpenCode";
const activeKnowledge = (records) => records
  .filter((record) => record.status === "active")
  .map(({ id: knowledgeId, title, kind, text, sources }) => ({ id: knowledgeId, title, kind, text, sources }));
const body = (title, goal = "", prompt = "") => `# ${title}\n\n${goal ? `## Goal\n\n${goal}\n` : ""}${prompt ? `\n## Prompt\n\n${prompt}\n` : ""}`;
const stageBody = (record, title, goal, prompt = record.data.prompt || "") => {
  const result = record.body.match(/\n## Result[\s\S]*$/)?.[0] || "";
  return `${body(title, goal, prompt).trimEnd()}${result}`;
};
const stageResult = (record) => record.body.match(/\n## Result\s*\n([\s\S]*)$/)?.[1]?.trim() ?? null;
const assertNoSymlinkPath = (file) => { let current = path.parse(file).root; for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); try { if (fs.lstatSync(current).isSymbolicLink()) fail(ERROR_CODES.STORAGE_ERROR, `Symlink path component is not supported: ${current}`); } catch (error) { if (error.code !== "ENOENT") throw error; break; } } };

function parseIssue(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) fail(ERROR_CODES.INVALID_ISSUE_URL, "Expected a supported tracker issue URL");
    let match = parsed.pathname.match(/^\/(.+)\/-\/issues\/(\d+)\/?$/);
    if (match) return { url: parsed.toString(), provider: "gitlab", project: match[1], iid: Number(match[2]) };
    match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/);
    if (match) return { url: parsed.toString(), provider: "github", project: match[1], iid: Number(match[2]) };
    match = parsed.pathname.match(/^\/browse\/([A-Za-z][A-Za-z0-9]+-\d+)\/?$/);
    if (match) return { url: parsed.toString(), provider: "jira", project: match[1].split("-")[0], key: match[1] };
    fail(ERROR_CODES.INVALID_ISSUE_URL, "Expected a supported tracker issue URL");
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
    // All mutating operations update the shared sessions.jsonl, so they need one lock.
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
    workspace = normalizeWorkspaceId(workspace);
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
    workspace = normalizeWorkspaceId(workspace);
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

  sessionByOpenCodeId(opencodeSessionId, workspace = null, stage = null, state = "active") {
    return reduceSessions(this.storage.readEvents()).filter((session) => session.opencode_session_id === opencodeSessionId
      && (!workspace || session.workspace === workspace)
      && (!stage || session.stage === stage)
      && (!state || session.state === state)).at(-1) || null;
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
      const workspace = requestedWorkspace === undefined ? this.nextWorkspace() : normalizeWorkspaceId(requestedWorkspace);
      const now = new Date().toISOString();
      if (fs.existsSync(this.storage.workspaceDir(workspace))) fail(ERROR_CODES.CONFLICT, "Workspace already exists");
      fs.mkdirSync(path.join(this.storage.workspaceDir(workspace), "stages"), { recursive: true });
      this.storage.writeMarkdown(this.storage.workspaceFile(workspace), { schema: 1, workspace, title: title.trim(), status: "in_progress", created_at: now, updated_at: now, tracker_links: [] }, body(title));
      const planningGoal = "Clarify the work goal and constraints";
      const planningPrompt = "Diagnose and plan the task without functional changes. Discuss possible solutions, record durable workspace-wide facts, decisions, constraints, important files, and risks through explicit knowledge operations, and decompose the work into the following stages. For each new implementation stage, write a separate detailed prompt with local context, concrete actions, constraints, completion criteria, and the expected result; do not duplicate shared knowledge that every stage receives in resume.context.workspace_knowledge. Ask clarifying questions only when genuinely blocked.";
      this.storage.writeMarkdown(this.storage.stageFile(workspace, "01"), { schema: 1, workspace, stage: "01", title: "Planning", status: "in_progress", goal: planningGoal, prompt: planningPrompt, depends_on: [], owner: actor(this.options), created_at: now, updated_at: now, tracker_links: [] }, body("Planning", planningGoal, planningPrompt));
      const sessionId = options.sessionId || randomUUID();
      if (this.storage.readEvents().some((item) => item.session_id === sessionId)) fail(ERROR_CODES.CONFLICT, "Session ID already exists");
      this.writeEvents([event("session.started", workspace, "01", 1, sessionId, actor(this.options), { summary: `planning ${title.trim()}`, opencode_session_id: options.opencodeSessionId || null, branch: options.branch || null })]);
      generateProjections(this.storage);
      return this.result({
        workspace,
        stage: "01",
        session_id: sessionId,
        ordinal: "01/01",
        title: "Planning",
        description: planningGoal,
        prompt: planningPrompt,
        resume: {
          first: true,
          summary: "Starting work on stage 01: Planning.",
          last_session_summary: null,
          context: {
            essence: planningGoal,
            previous: "The previous session did not save a result; the stopping point needs to be clarified.",
            now: planningPrompt,
            workspace_knowledge: [],
          },
          next_action: "start_work",
          instruction: planningPrompt,
        },
      }, [workspace, "01"]);
    });
  }

  renameWorkspace(workspace, title) {
    workspace = normalizeWorkspaceId(workspace);
    if (!title?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Title is required");
    return this.transact(`workspace-${workspace}`, () => {
      const record = this.storage.readWorkspace(workspace);
      const nextTitle = title.trim();
      if (record.data.title === nextTitle) return this.result({ workspace, title: nextTitle }, []);
      record.data.title = nextTitle;
      record.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.workspaceFile(workspace), record.data, body(nextTitle));
      generateProjections(this.storage);
      return this.result({ workspace, title: nextTitle }, [workspace]);
    });
  }

  nextWorkspace() {
    const ids = this.listWorkspaces().data.map((workspace) => Number(workspace.workspace));
    return String(Math.max(0, ...ids) + 1).padStart(6, "0");
  }

  startSession(workspace, stage, options = {}) {
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
    const sessionId = options.sessionId || randomUUID();
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const stageRecord = this.storage.readStage(workspace, stage);
      this.assertDependenciesCompleted(workspace, stageRecord);
      const events = this.storage.readEvents();
      const current = activeSession(events, workspace, stage);
      if (current) {
        const canTakeOver = options.takeover
          && current.session_id !== sessionId
          && current.opencode_session_id !== options.opencodeSessionId;
        if (!canTakeOver) fail(ERROR_CODES.ACTIVE_SESSION_EXISTS, "Stage already has an active session");
        this.writeEvents([event("session.handed_off", workspace, stage, current.ordinal, current.session_id, actor(this.options), { reason: "resumed in a new OpenCode session" })]);
      }
      if (["completed", "cancelled", "archived"].includes(stageRecord.data.status)) fail(ERROR_CODES.INVALID_STATE, "Cannot start a session for a terminal stage");
      if (reduceSessions(events).some((session) => session.session_id === sessionId)) fail(ERROR_CODES.CONFLICT, "Session ID already exists");
      const previous = reduceSessions(events).filter((session) => session.workspace === workspace && session.stage === stage);
      const ordinal = previous.length + 1;
      if (stageRecord.data.status === "planned") {
        stageRecord.data.status = "in_progress";
        stageRecord.data.updated_at = new Date().toISOString();
        this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), stageRecord.data, stageRecord.body);
      }
       this.writeEvents([event("session.started", workspace, stage, ordinal, sessionId, actor(this.options), { summary: options.summary || "continued work", opencode_session_id: options.opencodeSessionId || null, branch: options.branch || null })]);
      generateProjections(this.storage);
      const previousSession = previous.at(-1) || null;
      const firstResume = previous.length === 0;
      const hasPrompt = Boolean(stageRecord.data.prompt?.trim());
      const workspaceKnowledge = activeKnowledge(this.listKnowledge(workspace).data);
      return this.result({
        workspace,
        stage,
        session_id: sessionId,
        ordinal: `${stage}/${String(ordinal).padStart(2, "0")}`,
        title: stageRecord.data.title,
        description: stageRecord.data.goal,
        prompt: stageRecord.data.prompt || null,
        resume: {
          first: firstResume,
          summary: firstResume
             ? `Starting work on stage ${stage}: ${stageRecord.data.title}.`
             : `Continuing work on stage ${stage}: ${stageRecord.data.title}. Last recorded summary: ${previousSession?.summary || "no saved report"}.`,
          last_session_summary: previousSession?.summary || null,
          context: {
            essence: stageRecord.data.goal || stageRecord.data.title,
            previous: previousSession?.summary || "The previous session did not save a result; the stopping point needs to be clarified.",
            now: hasPrompt ? stageRecord.data.prompt : "First clarify the task and work plan with the user.",
            workspace_knowledge: workspaceKnowledge,
          },
          next_action: hasPrompt ? (firstResume ? "start_work" : "await_confirmation") : "ask_questions",
          instruction: hasPrompt
            ? firstResume
              ? stageRecord.data.prompt
                || `Review stage ${stage}: ${stageRecord.data.title} and begin work only after confirming there are no unanswered questions.`
              : `Stage ${stage}: ${stageRecord.data.title} was resumed before. Report the context and wait for the user's confirmation before continuing work.`
            : `Stage ${stage}: ${stageRecord.data.title} has no non-empty prompt. Do not start implementation; ask the user the questions needed to define the work.`,
        },
      }, [workspace, stage]);
    });
  }

  addStage(workspace, title, options = {}) {
    workspace = normalizeWorkspaceId(workspace);
    if (!title?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Title is required");
    if (!Array.isArray(options.dependsOn || [])) fail(ERROR_CODES.INVALID_ARGUMENT, "dependsOn must contain unique stage IDs");
    const dependsOn = (options.dependsOn || []).map(normalizeStageId);
    if (new Set(dependsOn).size !== dependsOn.length) fail(ERROR_CODES.INVALID_ARGUMENT, "dependsOn must contain unique stage IDs");
    return this.transact(`workspace-${workspace}`, () => {
      const stages = this.listStages(workspace).data.stages;
      if (stages.length >= 99) fail(ERROR_CODES.INVALID_STATE, "A workspace cannot contain more than 99 stages");
      const stage = String(Math.max(0, ...stages.map((item) => Number(item.stage))) + 1).padStart(2, "0");
      if (dependsOn.includes(stage)) fail(ERROR_CODES.INVALID_ARGUMENT, "A stage cannot depend on itself");
      if (dependsOn.some((dependency) => !stages.some((item) => item.stage === dependency))) fail(ERROR_CODES.INVALID_ARGUMENT, "dependsOn must reference existing stages");
      const now = new Date().toISOString();
      const prompt = options.prompt?.trim() || undefined;
      const metadata = { schema: 1, workspace, stage, title: title.trim(), status: "planned", goal: options.goal || title.trim(), ...(prompt ? { prompt } : {}), depends_on: dependsOn, owner: options.owner || actor(this.options), created_at: now, updated_at: now, tracker_links: [] };
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), metadata, body(title, options.goal || title, prompt));
      generateProjections(this.storage);
      return this.result({ workspace, stage, status: "planned", session_started: false, resume_required: true }, [stage]);
    });
  }

  renameStage(workspace, stage, title) {
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
    if (!title?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Title is required");
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const record = this.storage.readStage(workspace, stage);
      const nextTitle = title.trim();
      if (record.data.title === nextTitle) return this.result({ workspace, stage, title: nextTitle }, []);
      record.data.title = nextTitle;
      record.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), record.data, stageBody(record, nextTitle, record.data.goal));
      generateProjections(this.storage);
      return this.result({ workspace, stage, title: nextTitle }, [workspace, stage]);
    });
  }

  updateStage(workspace, stage, description) {
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
    if (!description?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Description is required");
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const record = this.storage.readStage(workspace, stage);
      const nextDescription = description.trim();
      if (record.data.goal === nextDescription) return this.result({ workspace, stage, description: nextDescription }, []);
      record.data.goal = nextDescription;
      record.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), record.data, stageBody(record, record.data.title, nextDescription));
      generateProjections(this.storage);
      return this.result({ workspace, stage, description: nextDescription }, [workspace, stage]);
    });
  }

  updateStagePrompt(workspace, stage, prompt) {
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
    if (!prompt?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Prompt is required");
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const record = this.storage.readStage(workspace, stage);
      const nextPrompt = prompt.trim();
      if (record.data.prompt === nextPrompt) return this.result({ workspace, stage, prompt: nextPrompt }, []);
      record.data.prompt = nextPrompt;
      record.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), record.data, stageBody(record, record.data.title, record.data.goal, nextPrompt));
      generateProjections(this.storage);
      return this.result({ workspace, stage, prompt: nextPrompt }, [workspace, stage]);
    });
  }

  updateStageResult(workspace, stage, result) {
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
    if (!result?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Result is required");
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const record = this.storage.readStage(workspace, stage);
      const currentResult = stageResult(record);
      if (currentResult === null) fail(ERROR_CODES.INVALID_STATE, "Stage has no result to update");
      const nextResult = result.trim();
      if (currentResult === nextResult) return this.result({ workspace, stage, result: nextResult }, []);
      record.data.updated_at = new Date().toISOString();
      const nextBody = `${body(record.data.title, record.data.goal, record.data.prompt).trimEnd()}\n\n## Result\n\n${nextResult}`;
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), record.data, nextBody);
      generateProjections(this.storage);
      return this.result({ workspace, stage, result: nextResult }, [workspace, stage]);
    });
  }

  archiveStage(workspace, stage) {
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
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
    workspace = normalizeWorkspaceId(workspace);
    this.storage.assertNoSymlinks();
    this.storage.readWorkspace(workspace);
    const text = this.storage.readKnowledge(workspace);
    return { ok: true, data: text ? parseKnowledge(text) : [] };
  }

  addKnowledge(workspace, input) {
    workspace = normalizeWorkspaceId(workspace);
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
    workspace = normalizeWorkspaceId(workspace);
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
    const normalizedWorkspace = normalizeWorkspaceId(workspace);
    const normalizedStage = stage === null || stage === undefined ? null : normalizeStageId(stage);
    const parsed = parseIssue(url);
    return this.transact(`link-${normalizedWorkspace}-${normalizedStage || "workspace"}`, () => {
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
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const session = assertActive(this.storage.readEvents(), workspace, stage, sessionId);
      if (session.summary === summary.trim()) return this.result({ session_id: sessionId, summary: summary.trim() }, []);
      this.writeEvents([event("session.renamed", workspace, stage, session.ordinal, sessionId, actor(this.options), { summary: summary.trim() })]);
      return this.result({ session_id: sessionId, summary: summary.trim() }, []);
    });
  }

  closeSession(workspace, stage, sessionId, reason = "closed", state = "closed") {
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const session = assertActive(this.storage.readEvents(), workspace, stage, sessionId);
      this.writeEvents([event(`session.${state}`, workspace, stage, session.ordinal, sessionId, actor(this.options), { reason })]);
      return this.result({ session_id: sessionId, state }, []);
    });
  }

  forceCloseSession(workspace, stage, sessionId, reason, confirmation) {
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
    if (!sessionId?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Session ID is required");
    if (!reason?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Force-close reason is required");
    if (confirmation !== "FORCE_CLOSE") fail(ERROR_CODES.CONFIRMATION_REQUIRED, "Force close requires confirmation FORCE_CLOSE", { expected: "FORCE_CLOSE" });
    return this.transact(`stage-${workspace}-${stage}`, () => {
      const session = this.storage.readEvents().length
        ? this.sessionById(sessionId)
        : null;
      if (!session || session.workspace !== workspace || session.stage !== stage) fail(ERROR_CODES.NOT_FOUND, "Session not found", { session_id: sessionId, workspace, stage });
      if (session.state === "closed") return this.result({ session_id: sessionId, state: "closed", idempotent: true }, []);
      if (session.state !== "active") fail(ERROR_CODES.SESSION_NOT_ACTIVE, "Session is not active", { session_id: sessionId, state: session.state });
      this.writeEvents([event("session.closed", workspace, stage, session.ordinal, sessionId, actor(this.options), { reason: reason.trim(), forced: true })]);
      generateProjections(this.storage);
      return this.result({ session_id: sessionId, state: "closed", forced: true, reason: reason.trim() }, []);
    });
  }

  handoff(workspace, stage, sessionId, options = {}) {
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
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
    workspace = normalizeWorkspaceId(workspace);
    stage = normalizeStageId(stage);
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
      const knowledgeEntries = this.listKnowledge(workspace).data;
      const active = activeSession(events, workspace, stage);
      if (!active || active.session_id !== sessionId) fail(active ? ERROR_CODES.ACTIVE_SESSION_EXISTS : ERROR_CODES.SESSION_NOT_ACTIVE, active ? "Another active session owns this stage" : "Session is not active");
      this.writeEvents([event("session.closed", workspace, stage, active.ordinal, sessionId, actor(this.options), { reason: "stage_completed" })]);
      current.data.status = "completed";
      current.data.updated_at = new Date().toISOString();
      this.storage.writeMarkdown(this.storage.stageFile(workspace, stage), current.data, `${current.body}\n\n## Result\n\n${options.result || "Stage completed."}`);
      generateProjections(this.storage);
      const promptReview = this.listStages(workspace).data.stages
        .filter((item) => Number(item.stage) > Number(stage) && !["completed", "archived"].includes(item.status))
        .map(({ stage: id, title, description, prompt, status }) => ({ stage: id, title, description, prompt: prompt || null, status }));
      const data = { session_id: sessionId, workspace, stage, state: "closed", status: "completed", next_stage_started: false, knowledge_review: knowledgeReview, knowledge_entries: knowledgeEntries.length, active_knowledge_entries: activeKnowledge(knowledgeEntries).length, prompt_review: promptReview };
      const incompleteStages = this.listStages(workspace).data.stages.filter((item) => !["completed", "archived"].includes(item.status));
      const next = incompleteStages.length ? null : {
        action: "workspace_finish",
        workspace,
        command: `/wc workspace finish ${workspace}`,
        reason: "All workspace stages are completed",
      };
      return this.result(data, [workspace, stage], next);
    });
  }

  help(command = "") {
     return this.result({ command, syntax: "/wc [create|list|workspace list|workspace rename|workspace finish|resume|stage add|stage rename|stage update|stage update-prompt|stage update-result|stage force-close|stage archive|stage handoff|stage abandon|stage finish|link-issue|session rename|knowledge list|knowledge add|knowledge update|knowledge supersede|help]", note: "workspace and stage are optional for stage rename/update/update-prompt/update-result/archive/handoff/abandon/finish and session rename/close when the current session identifies them; explicit workspace and stage positions accept padded or unpadded positive integer IDs and structured results remain canonical; zero, signs, decimals, whitespace, and overlong identifiers are invalid; stage update-result requires an existing stage result; finish <stage> is a shortcut for stage finish <stage>; when only one numeric identifier is supplied, six digits mean workspace and one or two digits mean stage; stage add accepts an optional local prompt and only creates a planned stage; entering any added stage requires an explicit resume in a new OpenCode session; resume returns resume.next_action, resume.instruction, and active shared entries in resume.context.workspace_knowledge; implementation may begin only with a non-empty prompt and no unanswered questions; ask focused questions and do not modify application code when next_action is ask_questions; force-close requires a session ID, reason, and exact confirmation FORCE_CLOSE; before stage finish, add, update, or supersede durable findings, or explicitly declare none; stage finish closes only the current stage session and returns downstream stages for informational prompt review without starting one; workspace finish requires all non-archived stages to be completed; archived stages retain their IDs and history and are hidden from the TUI by default; mutating commands call structured tools; only explicit lifecycle operations change storage." }, []);
  }

  result(data, changed, next = null) {
    return { ok: true, data, changed, next };
  }
}
