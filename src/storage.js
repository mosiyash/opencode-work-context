import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkContextError, ERROR_CODES, fail } from "./errors.js";
import { parseFrontmatter, renderMarkdown } from "./markdown.js";

const now = () => new Date().toISOString();
const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });
const validTimestamp = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === normalized;
};
const requiredString = (data, key) => typeof data[key] === "string" && data[key].trim().length > 0;
const validTrackerLinks = (links) => links.every((link) => {
  if (!link || typeof link !== "object" || Object.keys(link).some((key) => !["url", "provider", "project", "iid"].includes(key)) || typeof link.url !== "string" || typeof link.provider !== "string" || typeof link.project !== "string" || !Number.isInteger(link.iid)) return false;
  try {
    const url = new URL(link.url);
    const marker = url.pathname.lastIndexOf("/-/issues/");
    const project = marker > 1 ? url.pathname.slice(1, marker) : "";
    const iid = marker > 1 ? Number(url.pathname.slice(marker + "/-/issues/".length).replace(/\/$/, "")) : NaN;
    return link.provider === "gitlab" && (url.protocol === "http:" || url.protocol === "https:") && project === link.project && iid === link.iid;
  } catch { return false; }
});
const validEvents = new Set(["session.started", "session.renamed", "session.handed_off", "session.closed", "session.abandoned"]);
const validateEvent = (item) => {
  if (!item || item.schema !== 1 || Object.keys(item).some((key) => !["schema", "event_id", "event", "occurred_at", "session_id", "workspace", "stage", "ordinal", "actor", "data"].includes(key)) || !validEvents.has(item.event) || typeof item.event_id !== "string" || !item.event_id.trim() || !validTimestamp(item.occurred_at) || typeof item.session_id !== "string" || !item.session_id.trim() || !/^\d{6}$/.test(item.workspace) || !/^\d{2}$/.test(item.stage) || !Number.isInteger(item.ordinal) || item.ordinal < 1 || typeof item.actor !== "string" || !item.actor.trim() || !item.data || typeof item.data !== "object" || Array.isArray(item.data)) fail(ERROR_CODES.STORAGE_ERROR, "Invalid session event");
  const keys = Object.keys(item.data);
  const allowed = item.event === "session.started" ? ["summary", "opencode_session_id", "branch"] : item.event === "session.renamed" ? ["summary"] : ["reason"];
  if (keys.some((key) => !allowed.includes(key)) || (item.event === "session.started" && (typeof item.data.summary !== "string" || !item.data.summary.trim() || (item.data.opencode_session_id !== null && item.data.opencode_session_id !== undefined && typeof item.data.opencode_session_id !== "string") || (item.data.branch !== null && item.data.branch !== undefined && typeof item.data.branch !== "string"))) || (item.event === "session.renamed" && (typeof item.data.summary !== "string" || !item.data.summary.trim())) || (item.event !== "session.started" && (typeof item.data.reason !== "string" || !item.data.reason.trim()))) fail(ERROR_CODES.STORAGE_ERROR, "Invalid session event data");
};
const validateEventStream = (events) => {
  const ids = new Set();
  const sessions = new Map();
  const stages = new Map();
  let previousTimestamp = null;
  for (const item of events) {
    validateEvent(item);
    if (previousTimestamp && Date.parse(item.occurred_at) < Date.parse(previousTimestamp)) fail(ERROR_CODES.STORAGE_ERROR, "Session event timestamps are not ordered");
    previousTimestamp = item.occurred_at;
    if (ids.has(item.event_id)) fail(ERROR_CODES.STORAGE_ERROR, "Duplicate session event ID");
    ids.add(item.event_id);
    const current = sessions.get(item.session_id);
    if (item.event === "session.started") {
      if (current || typeof item.data.summary !== "string" || !item.data.summary.trim()) fail(ERROR_CODES.STORAGE_ERROR, "Invalid session start event");
      const stageKey = `${item.workspace}:${item.stage}`;
      const stageState = stages.get(stageKey) || { active: false, maxOrdinal: 0 };
      if (stageState.active || item.ordinal !== stageState.maxOrdinal + 1) fail(ERROR_CODES.STORAGE_ERROR, "Invalid session ordinal or active session stream");
      stageState.active = true; stageState.maxOrdinal = item.ordinal; stages.set(stageKey, stageState);
      sessions.set(item.session_id, { ...item, state: "active" });
      continue;
    }
    if (!current || current.workspace !== item.workspace || current.stage !== item.stage || current.ordinal !== item.ordinal || current.state !== "active") fail(ERROR_CODES.STORAGE_ERROR, "Invalid session event transition");
    if (item.event === "session.renamed" && (typeof item.data.summary !== "string" || !item.data.summary.trim())) fail(ERROR_CODES.STORAGE_ERROR, "Invalid session rename event");
    if (["session.handed_off", "session.closed", "session.abandoned"].includes(item.event)) {
      current.state = item.event.slice("session.".length);
      stages.get(`${item.workspace}:${item.stage}`).active = false;
    }
  }
};
function validateMetadata(data, kind, workspace, stage = null) {
  const allowed = kind === "workspace" ? ["schema", "workspace", "title", "status", "created_at", "updated_at", "tracker_links"] : ["schema", "workspace", "stage", "title", "status", "goal", "depends_on", "owner", "created_at", "updated_at", "tracker_links"];
  if (Object.keys(data).some((key) => !allowed.includes(key)) || data.schema !== 1 || !requiredString(data, "workspace") || !/^\d{6}$/.test(data.workspace) || data.workspace !== workspace) fail(ERROR_CODES.STORAGE_ERROR, `Invalid ${kind} metadata`);
  if (!requiredString(data, "title") || !validTimestamp(data.created_at) || !validTimestamp(data.updated_at) || Date.parse(data.updated_at) < Date.parse(data.created_at) || !Array.isArray(data.tracker_links)) fail(ERROR_CODES.STORAGE_ERROR, `Invalid ${kind} metadata`);
  if (!validTrackerLinks(data.tracker_links) || data.tracker_links.some((link) => !link.provider.trim() || !link.project.trim() || !Number.isInteger(link.iid) || link.iid < 1)) fail(ERROR_CODES.STORAGE_ERROR, `Invalid ${kind} tracker links`);
  const statuses = kind === "workspace" ? ["in_progress", "completed", "cancelled"] : ["planned", "in_progress", "completed", "cancelled"];
  if (!statuses.includes(data.status)) fail(ERROR_CODES.STORAGE_ERROR, `Invalid ${kind} status`);
  if (kind === "stage" && (data.stage !== stage || !/^\d{2}$/.test(data.stage) || !requiredString(data, "goal") || !requiredString(data, "owner") || !Array.isArray(data.depends_on) || new Set(data.depends_on).size !== data.depends_on.length || data.depends_on.includes(data.stage) || data.depends_on.some((item) => typeof item !== "string" || !/^\d{2}$/.test(item)))) fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage metadata");
}
export function atomicWrite(file, content) {
  ensure(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try { fs.writeFileSync(temp, content, { encoding: "utf8", flag: "wx" }); fs.renameSync(temp, file); }
  catch (error) { try { fs.rmSync(temp, { force: true }); } catch {} throw new WorkContextError(ERROR_CODES.STORAGE_ERROR, `Cannot write ${file}`, { cause: error.message }); }
}
export function withLock(lockPath, fn, { owner = "work-context", session = null, staleAfterMs = 86400000 } = {}) {
  ensure(path.dirname(lockPath));
  try { fs.mkdirSync(lockPath, { recursive: false }); }
  catch (error) {
    if (error.code !== "EEXIST") throw new WorkContextError(ERROR_CODES.STORAGE_ERROR, "Cannot create lock", { cause: error.message });
    let metadata = {};
    try { metadata = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")); } catch {}
    const ageMs = metadata.created_at ? Date.now() - Date.parse(metadata.created_at) : null;
    if (ageMs !== null && ageMs > staleAfterMs) fail(ERROR_CODES.STALE_LOCK, "Stale lock requires explicit removal", { lockPath, metadata, ageMs });
    fail(ERROR_CODES.LOCKED, "Work context is locked", { lockPath, metadata, ageMs });
  }
  const token = randomUUID();
  try { atomicWrite(path.join(lockPath, "owner.json"), JSON.stringify({ owner, session, pid: process.pid, token, created_at: now() }, null, 2) + "\n"); return fn(); }
  finally {
    try { const current = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")); if (current.token === token) fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
  }
}

export class FileStorage {
  constructor(projectRoot, config = {}) {
    this.projectRoot = projectRoot;
    const storage = config.storage || {};
    this.config = { mode: "hybrid", root: ".work-context", personal_root: ".work-context/local", title: { issue_prefix: "short" }, tracker: { provider: null }, ...config, ...storage, title: { issue_prefix: "short", ...(config.title || {}) }, tracker: { provider: null, ...(config.tracker || {}) } };
    this.root = path.resolve(projectRoot, this.config.root);
    this.personalRoot = path.resolve(projectRoot, this.config.personal_root);
    const project = path.resolve(projectRoot);
    const insideProject = (target) => { const relative = path.relative(project, target); return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
    if (!insideProject(this.root) || !insideProject(this.personalRoot)) fail(ERROR_CODES.INVALID_ARGUMENT, "Storage roots must be non-root paths inside the project");
    const personalContainsRoot = this.root.startsWith(`${this.personalRoot}${path.sep}`);
    if (this.root === this.personalRoot || personalContainsRoot) fail(ERROR_CODES.INVALID_ARGUMENT, "Storage roots overlap unsafely");
    if (this.personalRoot === path.join(this.root, ".locks") || this.personalRoot.startsWith(`${path.join(this.root, ".locks")}${path.sep}`)) fail(ERROR_CODES.INVALID_ARGUMENT, "Personal root cannot overlap the lock directory");
  }
  configure(create = true) { this.assertSafeRoots(); if (create) { ensure(this.root); ensure(this.personalRoot); } return this; }
  workspaceDir(id) { return path.join(this.root, id); }
  workspaceFile(id) { return path.join(this.workspaceDir(id), "workspace.md"); }
  knowledgeFile(id) { return path.join(this.workspaceDir(id), "KNOWLEDGE.md"); }
  stageFile(id, stage) { return path.join(this.workspaceDir(id), "stages", `${stage}.md`); }
  sessionFile() { return path.join(this.personalRoot, "sessions.jsonl"); }
  lockPath(name = "write") { return path.join(this.root, ".locks", `${name}.lock`); }
  readWorkspace(id) { const record = this.readCanonical(this.workspaceFile(id)); validateMetadata(record.data, "workspace", id); return record; }
  readStage(id, stage) { const record = this.readCanonical(this.stageFile(id, stage)); validateMetadata(record.data, "stage", id, stage); return record; }
  readKnowledge(id) { try { return fs.readFileSync(this.knowledgeFile(id), "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
  transactionFile() { return path.join(this.root, ".locks", "transaction.json"); }
  writeTransaction(snapshot) { atomicWrite(this.transactionFile(), JSON.stringify({ schema: 1, files: snapshot.files.map((item) => ({ file: item.file, content: item.content.toString("base64") })), externalRoots: snapshot.externalRoots }) + "\n"); }
  clearTransaction() { fs.rmSync(this.transactionFile(), { force: true }); }
  recoverTransaction() {
    if (!fs.existsSync(this.transactionFile())) return;
    const journalStat = fs.lstatSync(this.transactionFile());
    if (journalStat.isSymbolicLink() || !journalStat.isFile()) fail(ERROR_CODES.STORAGE_ERROR, "Invalid transaction journal path");
    let journal;
    try { journal = JSON.parse(fs.readFileSync(this.transactionFile(), "utf8")); } catch { fail(ERROR_CODES.STORAGE_ERROR, "Invalid transaction journal"); }
    if (!journal || journal.schema !== 1 || !Array.isArray(journal.files) || !Array.isArray(journal.externalRoots) || journal.files.some((item) => !item || Object.keys(item).some((key) => !["file", "content"].includes(key)) || typeof item.file !== "string" || typeof item.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content)) || new Set(journal.files.map((item) => item.file)).size !== journal.files.length) fail(ERROR_CODES.STORAGE_ERROR, "Invalid transaction journal");
    const rootPrefix = `${this.root}${path.sep}`;
    const personalPrefix = `${this.personalRoot}${path.sep}`;
    for (const item of journal.files) {
      const resolved = path.resolve(item.file);
      if ((!resolved.startsWith(rootPrefix) && !resolved.startsWith(personalPrefix)) || resolved === path.join(this.root, ".locks") || resolved.startsWith(`${this.root}${path.sep}.locks${path.sep}`) || (fs.existsSync(resolved) && !fs.lstatSync(resolved).isFile())) fail(ERROR_CODES.STORAGE_ERROR, "Transaction journal path is outside storage roots");
    }
    const externalRoots = this.personalRoot.startsWith(rootPrefix) ? [] : [this.personalRoot];
    this.assertNoSymlinks();
    this.restore({ files: journal.files.map((item) => ({ file: item.file, content: Buffer.from(item.content, "base64") })), externalRoots });
    this.clearTransaction();
  }
  snapshot() {
    const files = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (dir === this.root && entry.name === ".locks") continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) files.push({ file, content: fs.readFileSync(file) });
      }
    };
    walk(this.root);
    const rootPrefix = `${this.root}${path.sep}`;
    const externalPersonalRoot = !this.personalRoot.startsWith(rootPrefix) && this.personalRoot !== this.root;
    if (externalPersonalRoot) walk(this.personalRoot);
    return { files, externalRoots: externalPersonalRoot ? [this.personalRoot] : [] };
  }
  assertSafeRoots() {
    const check = (target) => {
      const parsed = path.parse(target);
      let current = parsed.root;
      for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {
          if (fs.lstatSync(current).isSymbolicLink()) fail(ERROR_CODES.STORAGE_ERROR, `Symlink path component is not supported: ${current}`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          break;
        }
      }
    };
    check(this.root);
    check(this.personalRoot);
    const locks = path.join(this.root, ".locks");
    try {
      const stat = fs.lstatSync(locks);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail(ERROR_CODES.STORAGE_ERROR, `Invalid lock directory: ${locks}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  assertNoSymlinks() {
    this.assertSafeRoots();
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (dir === this.root && entry.name === ".locks") {
          if (entry.isSymbolicLink() || !entry.isDirectory()) fail(ERROR_CODES.STORAGE_ERROR, `Invalid lock directory: ${path.join(dir, entry.name)}`);
          continue;
        }
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) fail(ERROR_CODES.STORAGE_ERROR, `Symlinks are not supported in work-context storage: ${file}`);
        if (entry.isDirectory()) walk(file);
      }
    };
    walk(this.root);
    if (this.personalRoot !== this.root && !this.personalRoot.startsWith(`${this.root}${path.sep}`)) walk(this.personalRoot);
  }
  restore(snapshot) {
    const keep = path.join(this.root, ".locks");
    if (fs.existsSync(this.root)) {
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (path.join(this.root, entry.name) !== keep) fs.rmSync(path.join(this.root, entry.name), { recursive: true, force: true });
      }
    }
    const existing = new Set(snapshot.files.map((item) => item.file));
    for (const root of snapshot.externalRoots) {
      if (!fs.existsSync(root)) continue;
      const removeNew = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) removeNew(file);
          else if (entry.isFile() && !existing.has(file)) fs.rmSync(file, { force: true });
        }
      };
      removeNew(root);
    }
    for (const item of snapshot.files) {
      ensure(path.dirname(item.file));
      fs.writeFileSync(item.file, item.content);
    }
  }
  readCanonical(file) { try { return parseFrontmatter(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") fail(ERROR_CODES.NOT_FOUND, `Missing ${file}`); throw error; } }
  writeMarkdown(file, data, body) { atomicWrite(file, renderMarkdown(data, body)); }
  appendEvents(events) {
    ensure(path.dirname(this.sessionFile()));
    const current = fs.existsSync(this.sessionFile()) ? fs.readFileSync(this.sessionFile(), "utf8") : "";
    atomicWrite(this.sessionFile(), current + events.map((item) => JSON.stringify(item)).join("\n") + "\n");
  }
  readEvents() {
    this.assertNoSymlinks();
    try {
      const events = fs.readFileSync(this.sessionFile(), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      validateEventStream(events);
      return events;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      if (error.code === ERROR_CODES.STORAGE_ERROR) throw error;
      fail(ERROR_CODES.STORAGE_ERROR, "Invalid session event log", { cause: error.message });
    }
  }
}

export function loadConfig(projectRoot, configFile = path.resolve(projectRoot, ".work-context", "config.yaml")) {
  if (!fs.existsSync(configFile)) return {};
  const data = Object.assign(Object.create(null), { storage: Object.create(null), title: Object.create(null), tracker: Object.create(null) });
  let section = null;
  for (const line of fs.readFileSync(configFile, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^(\s*)([\w-]+):\s*(.*)$/); if (!match) fail(ERROR_CODES.STORAGE_ERROR, "Invalid config syntax");
    if (!match[1]) { section = match[3] ? null : match[2]; if (match[3]) data[match[2]] = scalarConfig(match[3]); else if (!data[match[2]] || typeof data[match[2]] !== "object") data[match[2]] = Object.create(null); continue; }
    if (section && data[section] && typeof data[section] === "object") data[section][match[2]] = scalarConfig(match[3]);
  }
  if (Object.keys(data).some((key) => !["schema", "storage", "title", "tracker"].includes(key)) || Object.keys(data.storage).some((key) => !["mode", "root", "personal_root"].includes(key)) || Object.keys(data.title).some((key) => key !== "issue_prefix") || Object.keys(data.tracker).some((key) => key !== "provider") || data.schema !== 1 || !data.storage || !["personal", "shared-git", "hybrid"].includes(data.storage.mode) || typeof data.storage.root !== "string" || typeof data.storage.personal_root !== "string" || !data.title || !["none", "short", "full"].includes(data.title.issue_prefix) || !data.tracker || (data.tracker.provider !== null && typeof data.tracker.provider !== "string")) fail(ERROR_CODES.STORAGE_ERROR, "Invalid work-context config");
  return data;
}
const scalarConfig = (value) => value === "null" ? null : value === "[]" ? [] : value === "{}" ? {} : /^(true|false)$/.test(value) ? value === "true" : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
export const defaultConfig = () => `schema: 1\nstorage:\n  mode: hybrid\n  root: .work-context\n  personal_root: .work-context/local\ntitle:\n  issue_prefix: short\ntracker:\n  provider: null\n`;
