import { readWorkContextSnapshot } from "../src/work-context-snapshot.js";

const SESSION_STATE_RANK = { active: 0, handed_off: 1, abandoned: 2, closed: 3 };

const errorResult = (code, message, details = {}) => ({ ok: false, error: { code, message, details } });
const currentSessionId = (api) => api?.route?.current?.params?.sessionID || api?.route?.current?.params?.sessionId;
const projectRoot = (api) => api?.state?.path?.worktree || api?.state?.path?.directory;
const sessionTime = (session) => String(session.updated_at || session.started_at || "");

const compareSessions = (left, right, currentId) => {
  const leftCurrent = left.opencode_session_id === currentId;
  const rightCurrent = right.opencode_session_id === currentId;
  if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
  return (SESSION_STATE_RANK[left.state] ?? 9) - (SESSION_STATE_RANK[right.state] ?? 9)
    || sessionTime(right).localeCompare(sessionTime(left))
    || Number(right.ordinal || 0) - Number(left.ordinal || 0)
    || String(left.workspace || "").localeCompare(String(right.workspace || ""))
    || String(left.stage || "").localeCompare(String(right.stage || ""));
};

/** Return one deterministic work-context record for each native OpenCode session. */
export const sortSessionSwitcherEntries = (entries = [], currentId = null) => {
  const selected = new Map();
  for (const entry of entries) {
    const id = entry.session?.opencode_session_id;
    if (!id || selected.has(id) && compareSessions(selected.get(id).session, entry.session, currentId) <= 0) continue;
    selected.set(id, entry);
  }
  return [...selected.values()].sort((left, right) => compareSessions(left.session, right.session, currentId));
};

export const selectSession = (entries = [], currentId = null) => sortSessionSwitcherEntries(entries, currentId)[0]?.session || null;

export const switchToSession = (api, session) => {
  const sessionID = session?.opencode_session_id;
  if (!sessionID) return errorResult("SESSION_OPENCODE_ID_MISSING", "This work-context session has no OpenCode session ID", { session_id: session?.session_id });
  if (typeof api?.route?.navigate !== "function") return errorResult("SESSION_SWITCH_UNAVAILABLE", "This OpenCode host cannot switch sessions from a TUI plugin");
  try {
    api.ui?.dialog?.clear?.();
    api.route.navigate("session", { sessionID });
    return { ok: true, data: { opencode_session_id: sessionID, created: false, navigated: true } };
  } catch (error) {
    return errorResult(error.code || "SESSION_SWITCH_ERROR", error.message || "OpenCode could not open the selected session", { opencode_session_id: sessionID });
  }
};

export const createSessionSwitcherFlow = (api, { read = readWorkContextSnapshot } = {}) => {
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
    const entries = (data.workspaces || []).flatMap((workspace) => (workspace.sessions || []).map((session) => ({ workspace, session })));
    if (!entries.length) { toast("No sessions found"); return result; }
    const currentId = currentSessionId(api);
    const available = sortSessionSwitcherEntries(entries, currentId);
    const unavailable = entries.filter(({ session }) => !session.opencode_session_id);
    const labels = { active: "Active", handed_off: "Handed off", abandoned: "Abandoned", closed: "Closed" };
    api.ui.dialog.setSize?.("medium");
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: "Switch session",
      placeholder: "Search sessions",
      options: [
        ...available.map(({ workspace, session }) => ({
          title: `${workspace.id} ${session.stage || "-"}/${String(session.ordinal || 0).padStart(2, "0")}  ${session.summary || "Work session"} · ${workspace.title}`,
          description: `${session.state || "unknown"} · ${session.session_id || "unknown"}`,
          footer: session.opencode_session_id,
          category: session.opencode_session_id === currentId ? "Current" : labels[session.state] || session.state || "Unknown",
          value: session,
        })),
        ...unavailable.map(({ workspace, session }) => ({
          title: `${workspace.id} ${session.stage || "-"}/${String(session.ordinal || 0).padStart(2, "0")}  ${session.summary || "Work session"} · ${workspace.title}`,
          description: `${session.state || "unknown"} · no OpenCode session available`,
          category: "Unavailable",
          disabled: true,
          value: session,
        })),
      ],
      onSelect: (option) => {
        const switched = switchToSession(api, option.value);
        if (!switched.ok) toast(`${switched.error.code}: ${switched.error.message}`, "error");
        else toast("Session opened", "success");
      },
    }));
    return result;
  };
  return { open };
};

export const openSessionSwitcher = (api, options = {}) => {
  if (typeof api?.ui?.DialogSelect !== "function" || typeof api?.ui?.dialog?.replace !== "function") return false;
  void createSessionSwitcherFlow(api, options).open();
  return true;
};
