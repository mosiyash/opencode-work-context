import { readStagesSnapshot } from "../src/stages-snapshot.js";
import { renderStagesPanel } from "../src/stages-renderer.js";
import { jsx } from "@opentui/solid/jsx-runtime";

const DEBOUNCE_MS = 150;
const statusMarker = (status) => ({
  planned: "[ ]",
  in_progress: "[•]",
  completed: "[✓]",
  cancelled: "[!]",
}[status] || "[?]");

export { readStagesSnapshot, renderStagesPanel };

export const renderStagesElement = (result, theme) => jsx("box", {
  flexDirection: "column",
  children: !result?.ok || !result.data?.workspace
    ? [
      jsx("text", { children: jsx("b", { children: "Stages" }) }),
      ...renderStagesPanel(result).split("\n").slice(1).map((line) => jsx("text", { children: line })),
    ]
    : [
      jsx("box", {
        flexDirection: "row",
        children: [
          jsx("text", { children: jsx("b", { children: "Stages" }) }),
          jsx("text", { fg: theme?.current?.textMuted, children: ` · ${result.data.workspace.status}` }),
        ],
      }),
      ...result.data.stages.map((stage) => jsx("box", {
        flexDirection: "row",
        children: [
          jsx("text", { flexShrink: 0, marginRight: 1, fg: stage.current || stage.id === result.data.currentStage ? theme?.current?.warning : theme?.current?.textMuted, children: statusMarker(stage.status) }),
          jsx("text", { flexGrow: 1, flexShrink: 1, wrapMode: "word", fg: stage.current || stage.id === result.data.currentStage ? theme?.current?.warning : theme?.current?.textMuted, children: `${stage.id}. ${stage.title}` }),
        ],
      })),
    ],
});

const sessionIdFromEvent = (event) => event?.properties?.info?.id
  || event?.properties?.sessionID
  || event?.sessionID
  || event?.sessionId
  || event?.data?.info?.id
  || event?.data?.sessionID;
const disposeRegistration = (registration) => {
  if (typeof registration === "function") registration();
  else registration?.dispose?.();
};

export const createStagesTuiController = ({ projectRoot, read = readStagesSnapshot, debounceMs = DEBOUNCE_MS } = {}) => {
  const snapshots = new Map();
  const generations = new Map();
  const timers = new Map();
  let disposed = false;

  const readSnapshot = async (sessionId) => {
    if (disposed || !sessionId) return;
    const currentGeneration = (generations.get(sessionId) || 0) + 1;
    generations.set(sessionId, currentGeneration);
    const entry = snapshots.get(sessionId) || { result: null, successful: null };
    snapshots.set(sessionId, entry);
    try {
      const result = await read({ projectRoot, sessionId });
      if (disposed || currentGeneration !== generations.get(sessionId)) return;
      if (result?.ok) {
        entry.successful = result;
        entry.result = result;
      } else {
        entry.result = entry.successful
          ? { ...entry.successful, stale: true, error: result?.error || { code: "STORAGE_ERROR" } }
          : result;
      }
    } catch (error) {
      if (disposed || currentGeneration !== generations.get(sessionId)) return;
      entry.result = entry.successful
        ? { ...entry.successful, stale: true, error: { code: error.code || "STORAGE_ERROR", message: error.message } }
        : { ok: false, error: { code: error.code || "STORAGE_ERROR", message: error.message } };
    }
    snapshots.set(sessionId, entry);
  };

  const scheduleRefresh = (sessionId) => {
    if (disposed || !sessionId) return;
    const previous = timers.get(sessionId);
    if (previous) clearTimeout(previous);
    timers.set(sessionId, setTimeout(() => {
      timers.delete(sessionId);
      void readSnapshot(sessionId);
    }, debounceMs));
  };

  const resultFor = (sessionId) => {
    const entry = snapshots.get(sessionId);
    if (!entry) {
      void readSnapshot(sessionId);
      return { ok: true, data: { schema: 1, workspace: null, stages: [], currentStage: null }, loading: true };
    }
    return entry.result || { ok: true, data: { schema: 1, workspace: null, stages: [], currentStage: null }, loading: true };
  };

  return {
    load: readSnapshot,
    scheduleRefresh,
    resultFor,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generations.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      snapshots.clear();
    },
  };
};

// Optional TUI entry point. It is deliberately not imported by the server plugin.
export const tui = async (api) => {
  // The same module can be loaded by the server plugin loader, where TUI APIs
  // are unavailable. Return an empty hook set instead of undefined.
  if (!api?.slots?.register || !api?.state?.path?.worktree) return {};

  const projectRoot = api.state.path.worktree;
  const initialSessionId = api.route?.current?.name === "session"
    ? api.route.current.params?.sessionID
    : undefined;
  const controller = createStagesTuiController({ projectRoot, read: api.stagesSnapshotProvider || readStagesSnapshot });
  await controller.load(initialSessionId);

  const unregisterSlot = api.slots.register({
    slots: {
      sidebar_content: (_context, { session_id: sessionId } = {}) => {
        return renderStagesElement(controller.resultFor(sessionId), api.theme);
      },
    },
  });
  const unsubscribe = api.event?.on?.("session.updated", (event) => {
    controller.scheduleRefresh(sessionIdFromEvent(event));
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    controller.dispose();
    disposeRegistration(unsubscribe);
    disposeRegistration(unregisterSlot);
  };
  api.lifecycle?.onDispose?.(cleanup);

  // Hosts without a lifecycle API can still explicitly release the adapter.
  return { dispose: cleanup };
};

export default { id: "work-context-stages", tui };
