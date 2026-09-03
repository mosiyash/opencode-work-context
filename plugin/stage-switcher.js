import fs from "node:fs";
import path from "node:path";
import { contextFor } from "../src/opencode-adapter.js";
import { atomicWrite } from "../src/storage.js";

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "archived"]);
const SESSION_STATE_RANK = { active: 0, handed_off: 1, abandoned: 2, closed: 3 };
const RECENT_STAGE_LIMIT = 5;
const RECENT_STATE_FILE = path.join(".work-context", "local", "tui-state.json");
const recentStagesByApi = new WeakMap();

const errorResult = (code, message, details = {}) => ({ ok: false, error: { code, message, details } });
const currentSessionId = (api) => api?.route?.current?.params?.sessionID || api?.route?.current?.params?.sessionId;
const projectRoot = (api) => api?.state?.path?.worktree || api?.state?.path?.directory;

const readRecentState = (root) => {
  if (!root) return {};
  try {
    const file = path.join(root, RECENT_STATE_FILE);
    if (!fs.lstatSync(file).isFile()) return {};
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!state || state.schema !== 1 || !state.recent_stages || typeof state.recent_stages !== "object") return {};
    return Object.fromEntries(Object.entries(state.recent_stages).map(([workspace, stages]) => [
      workspace,
      Array.isArray(stages) ? stages.filter((stage) => /^\d{2}$/.test(stage)).slice(0, RECENT_STAGE_LIMIT) : [],
    ]));
  } catch { return {}; }
};

const persistRecentState = (root, store) => {
  if (!root) return;
  try {
    atomicWrite(path.join(root, RECENT_STATE_FILE), `${JSON.stringify({ schema: 1, recent_stages: Object.fromEntries(store) }, null, 2)}\n`);
  } catch {}
};

const recentStageStore = (api) => {
  let store = recentStagesByApi.get(api);
  if (!store) {
    store = new Map(Object.entries(readRecentState(projectRoot(api))));
    recentStagesByApi.set(api, store);
  }
  return store;
};

/** Keep navigation history in the plugin session; work-context storage stays unchanged. */
export const rememberRecentStage = (api, workspace, stage) => {
  if (!api || !workspace || !stage) return;
  const store = recentStageStore(api);
  const recent = store.get(workspace) || [];
  store.set(workspace, [stage, ...recent.filter((id) => id !== stage)].slice(0, RECENT_STAGE_LIMIT));
  persistRecentState(projectRoot(api), store);
};

export const recentStageIds = (api, workspace) => [...(recentStageStore(api).get(workspace) || [])];

export const selectStageSession = (sessions = []) => sessions
  .filter((session) => session.opencode_session_id)
  .sort((left, right) => (SESSION_STATE_RANK[left.state] ?? 9) - (SESSION_STATE_RANK[right.state] ?? 9)
    || String(right.updated_at || right.started_at || "").localeCompare(String(left.updated_at || left.started_at || ""))
    || Number(right.ordinal || 0) - Number(left.ordinal || 0))[0] || null;

/** Read the current workspace, including terminal stages omitted from the overview modal. */
export const readStageSwitcherSnapshot = ({ projectRoot: root, sessionId } = {}) => {
  try {
    const context = contextFor(root, sessionId, "OpenCode TUI");
    const current = context.sessionByOpenCodeId(sessionId, null, null, null) || context.sessionById(sessionId);
    if (!current) return errorResult("STAGE_CONTEXT_REQUIRED", "The current OpenCode session is not associated with a work-context stage");
    const listed = context.listStages(current.workspace).data;
    const workspace = context.listWorkspaces().data.find((item) => item.workspace === current.workspace);
    if (!workspace) return errorResult("NOT_FOUND", "The current work-context workspace no longer exists");
    const completed = new Set(listed.stages.filter((stage) => stage.status === "completed").map((stage) => stage.stage));
    return {
      ok: true,
      data: {
        workspace: { id: current.workspace, title: workspace.title, status: workspace.status },
        currentStage: current.stage,
        stages: listed.stages.map((stage) => {
          const sessions = listed.sessions.filter((session) => session.stage === stage.stage);
          const blockers = (stage.depends_on || []).filter((dependency) => !completed.has(dependency));
          return {
            id: stage.stage,
            title: stage.title,
            description: stage.description,
            status: stage.status,
            current: stage.stage === current.stage,
            blockers,
            blocked: blockers.length > 0,
            sessions,
            selectedSession: selectStageSession(sessions),
          };
        }),
      },
    };
  } catch (error) {
    return errorResult(error.code || "STORAGE_ERROR", error.message || "Cannot read work-context storage", error.details || {});
  }
};

const navigateToSession = (api, sessionID) => {
  if (typeof api?.route?.navigate !== "function") return errorResult("SESSION_SWITCH_UNAVAILABLE", "This OpenCode host cannot switch sessions from a TUI plugin");
  try {
    api.ui?.dialog?.clear?.();
    api.route.navigate("session", { sessionID });
    return { ok: true, data: { opencode_session_id: sessionID, created: false } };
  } catch (error) {
    return errorResult(error.code || "SESSION_SWITCH_ERROR", error.message || "OpenCode could not open the selected session");
  }
};

export const startStageSession = async (api, { workspace, stage, title }, { readContext = contextFor } = {}) => {
  const root = projectRoot(api);
  if (!root) return errorResult("PROJECT_ROOT_REQUIRED", "The OpenCode project root is unavailable");
  if (typeof api?.client?.session?.create !== "function") return errorResult("SESSION_CREATE_UNAVAILABLE", "This OpenCode host cannot create sessions from a TUI plugin");
  if (typeof api?.client?.session?.command !== "function") return errorResult("SESSION_COMMAND_UNAVAILABLE", "This OpenCode host cannot run the work-context resume command in a new session");
  let opencodeSessionId;
  try {
    const response = await api.client.session.create({
      directory: root,
      title,
      metadata: { work_context_workspace: workspace, work_context_stage: stage },
    }, { throwOnError: true });
    const created = response?.data || response;
    opencodeSessionId = created?.id;
    if (!opencodeSessionId) return errorResult("SESSION_CREATE_ERROR", "OpenCode did not return the created session ID");
    const switched = navigateToSession(api, opencodeSessionId);
    if (!switched.ok) throw Object.assign(new Error(switched.error.message), { code: switched.error.code });
    await api.client.session.command({
      sessionID: opencodeSessionId,
      directory: root,
      command: "wc",
      arguments: `resume ${workspace} ${stage}`,
    }, { throwOnError: true });
    const context = readContext(root, opencodeSessionId, "OpenCode TUI");
    const bound = context.sessionByOpenCodeId(opencodeSessionId, workspace, stage, null);
    if (!bound) return errorResult("SESSION_START_INCOMPLETE", "The resume command completed without binding the new OpenCode session", { opencode_session_id: opencodeSessionId });
    return { ok: true, data: { ...bound, opencode_session_id: opencodeSessionId, created: true, opened: true } };
  } catch (error) {
    const current = currentSessionId(api);
    if (opencodeSessionId && current !== opencodeSessionId && typeof api?.client?.session?.delete === "function") {
      try { await api.client.session.delete({ sessionID: opencodeSessionId, directory: root }, { throwOnError: true }); } catch {}
    }
    return errorResult(error.code || "SESSION_START_ERROR", error.message || "Could not start the work-context session", error.details || {});
  }
};

export const switchToStage = async (api, stage, options = {}) => {
  if (typeof api?.route?.navigate !== "function") return errorResult("SESSION_SWITCH_UNAVAILABLE", "This OpenCode host cannot switch sessions from a TUI plugin");
  const existing = stage.selectedSession || selectStageSession(stage.sessions);
  if (existing) {
    const switched = navigateToSession(api, existing.opencode_session_id);
    if (switched.ok) {
      rememberRecentStage(api, options.workspace, stage.id);
      rememberRecentStage(api, options.workspace, options.currentStage);
    }
    return switched;
  }
  if (TERMINAL_STATUSES.has(stage.status)) return errorResult("INVALID_STATE", `Cannot create a session for a ${stage.status} stage`);
  if (stage.blocked) return errorResult("INVALID_STATE", `Complete dependencies ${stage.blockers.join(", ")} before starting this stage`, { blockers: stage.blockers });
  const started = await (options.start || startStageSession)(api, { workspace: options.workspace, stage: stage.id, title: stage.title });
  if (!started.ok) return started;
  if (!started.data.opened) {
    const switched = navigateToSession(api, started.data.opencode_session_id);
    if (!switched.ok) return switched;
  }
  rememberRecentStage(api, options.workspace, stage.id);
  rememberRecentStage(api, options.workspace, options.currentStage);
  return { ok: true, data: { ...started.data, created: true } };
};

export const createStageSwitcherFlow = (api, { read = readStageSwitcherSnapshot, start = startStageSession } = {}) => {
  const toast = (message, variant = "warning") => api?.ui?.toast?.({ message, variant });
  const open = async () => {
    let result;
    try { result = await read({ projectRoot: projectRoot(api), sessionId: currentSessionId(api) }); }
    catch (error) { result = errorResult(error.code || "STORAGE_ERROR", error.message || "Cannot read work-context storage"); }
    if (!result?.ok) { toast(`${result?.error?.code || "STORAGE_ERROR"}: ${result?.error?.message || "Cannot read work-context storage"}`, "error"); return result; }
    const { workspace, stages } = result.data;
    rememberRecentStage(api, workspace.id, result.data.currentStage);
    const recent = recentStageIds(api, workspace.id)
      .map((id) => stages.find((stage) => stage.id === id))
      .filter((stage) => stage && !stage.current);
    const optionFor = (stage, category) => {
      const available = (stage.sessions || []).filter((session) => session.opencode_session_id).length;
      const state = stage.blocked ? `blocked by ${stage.blockers.join(", ")}` : stage.status;
      return {
        title: `${stage.current ? ">" : " "} ${stage.id}. ${stage.title}`,
        description: `${state} · ${available ? `${available} session${available === 1 ? "" : "s"}` : TERMINAL_STATUSES.has(stage.status) || stage.blocked ? "no session available" : "new session"}`,
        category,
        disabled: (TERMINAL_STATUSES.has(stage.status) || stage.blocked) && !available,
        value: stage,
      };
    };
    api.ui.dialog.setSize?.("medium");
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: `Switch stage · ${workspace.id}  ${workspace.title}`,
      placeholder: "Search stages",
      options: [
        ...recent.map((stage) => optionFor(stage, "Recent")),
        ...stages.map((stage) => optionFor(stage, stage.current ? "Current" : stage.status)),
      ],
      onSelect: (option) => void (async () => {
        const switched = await switchToStage(api, option.value, { workspace: workspace.id, currentStage: result.data.currentStage, start });
        if (!switched.ok) toast(`${switched.error.code}: ${switched.error.message}`, "error");
        else toast(switched.data.created ? "Stage session created" : "Stage session opened", "success");
      })(),
    }));
    return result;
  };
  return { open };
};

export const openStageSwitcher = (api, options = {}) => {
  if (typeof api?.ui?.DialogSelect !== "function" || typeof api?.ui?.dialog?.replace !== "function") return false;
  void createStageSwitcherFlow(api, options).open();
  return true;
};
