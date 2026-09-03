import { readWorkContextSnapshot } from "../src/work-context-snapshot.js";

const SESSION_STATE_RANK = { active: 0, handed_off: 1, abandoned: 2, closed: 3 };
const WORKSPACE_STATUS_RANK = { in_progress: 0, planned: 1, completed: 2, cancelled: 3 };

const errorResult = (code, message, details = {}) => ({ ok: false, error: { code, message, details } });
const currentSessionId = (api) => api?.route?.current?.params?.sessionID || api?.route?.current?.params?.sessionId;
const projectRoot = (api) => api?.state?.path?.worktree || api?.state?.path?.directory;

/** Select the best existing OpenCode session without changing work-context state. */
export const selectWorkspaceSession = (sessions = []) => sessions
  .filter((session) => session.opencode_session_id)
  .sort((left, right) => (SESSION_STATE_RANK[left.state] ?? 9) - (SESSION_STATE_RANK[right.state] ?? 9)
    || String(right.updated_at || right.started_at || "").localeCompare(String(left.updated_at || left.started_at || ""))
    || Number(right.ordinal || 0) - Number(left.ordinal || 0))[0] || null;

export const sortWorkspaceSwitcherEntries = (workspaces = [], currentWorkspace = null) => [...workspaces].sort((left, right) => {
  if (left.id === currentWorkspace) return -1;
  if (right.id === currentWorkspace) return 1;
  return (WORKSPACE_STATUS_RANK[left.status] ?? 9) - (WORKSPACE_STATUS_RANK[right.status] ?? 9)
    || left.id.localeCompare(right.id);
});

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

export const switchToWorkspace = (api, workspace) => {
  const session = workspace.selectedSession || selectWorkspaceSession(workspace.sessions);
  if (!session) return errorResult("WORKSPACE_SESSION_UNAVAILABLE", "This workspace has no OpenCode-backed session to open", { workspace: workspace.id });
  return navigateToSession(api, session.opencode_session_id);
};

export const createWorkspaceSwitcherFlow = (api, { read = readWorkContextSnapshot } = {}) => {
  const toast = (message, variant = "warning") => api?.ui?.toast?.({ message, variant });
  const open = async () => {
    let result;
    try { result = await read({ projectRoot: projectRoot(api), sessionId: currentSessionId(api) }); }
    catch (error) { result = errorResult(error.code || "STORAGE_ERROR", error.message || "Cannot read work-context storage"); }
    if (!result?.ok) {
      toast(`${result?.error?.code || "STORAGE_ERROR"}: ${result?.error?.message || "Cannot read work-context storage"}`, "error");
      return result;
    }
    const data = result.data || {};
    const workspaces = sortWorkspaceSwitcherEntries(data.workspaces || [], data.currentWorkspace)
      .map((workspace) => ({ ...workspace, selectedSession: selectWorkspaceSession(workspace.sessions) }));
    if (!workspaces.length) {
      toast("No workspaces found");
      return result;
    }
    api.ui.dialog.setSize?.("medium");
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: "Switch workspace",
      placeholder: "Search workspaces",
      options: workspaces.map((workspace) => ({
        title: `${workspace.id}  ${workspace.title}${workspace.id === data.currentWorkspace ? " · current" : ""}`,
        description: workspace.selectedSession
          ? `${workspace.status} · ${workspace.selectedSession.state || "unknown"} session`
          : `${workspace.status} · no OpenCode session available`,
        footer: workspace.selectedSession?.opencode_session_id,
        category: workspace.id === data.currentWorkspace ? "Current" : workspace.status,
        disabled: !workspace.selectedSession,
        value: workspace,
      })),
      onSelect: (option) => {
        const switched = switchToWorkspace(api, option.value);
        if (!switched.ok) toast(`${switched.error.code}: ${switched.error.message}`, "error");
        else toast("Workspace session opened", "success");
      },
    }));
    return result;
  };
  return { open };
};

export const openWorkspaceSwitcher = (api, options = {}) => {
  if (typeof api?.ui?.DialogSelect !== "function" || typeof api?.ui?.dialog?.replace !== "function") return false;
  void createWorkspaceSwitcherFlow(api, options).open();
  return true;
};
