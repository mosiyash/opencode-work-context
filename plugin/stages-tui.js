import fs from "node:fs";
import path from "node:path";
import { readStagesSnapshot } from "../src/stages-snapshot.js";
import { renderStagesPanel } from "../src/stages-renderer.js";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal } from "solid-js";

const DEBOUNCE_MS = 150;
const POLL_MS = 1000;
const PATH_TIMEOUT_MS = 5000;
const PATH_POLL_MS = 25;
const WORK_CONTEXT_PREFIX = "work" + "_" + "context_";
const activeTuiInstances = new WeakMap();
const ACTIVE_TUI_KEY = Symbol.for("opencode-work-context.stages-tui");
const statusMarker = (status) => ({
  planned: "[ ]",
  in_progress: "[•]",
  completed: "[✓]",
  cancelled: "[!]",
  archived: "[-]",
}[status] || "[?]");

export { readStagesSnapshot, renderStagesPanel };

const defaultRuntime = { jsx };

const renderStagesContent = (result, theme, runtime = defaultRuntime) => !result?.ok || !result.data?.workspace
  ? [
    runtime.jsx("text", { children: runtime.jsx("b", { children: "Stages" }) }),
    ...renderStagesPanel(result).split("\n").slice(1).map((line) => runtime.jsx("text", { children: line })),
  ]
  : [
    runtime.jsx("box", {
      marginBottom: 1,
      children: runtime.jsx("text", { wrapMode: "word", children: runtime.jsx("b", { children: result.data.workspace.title }) }),
    }),
    runtime.jsx("box", {
      flexDirection: "row",
      children: [
        runtime.jsx("text", { children: runtime.jsx("b", { children: "Stages" }) }),
        runtime.jsx("text", { fg: theme?.current?.textMuted, children: ` · ${result.data.workspace.status}` }),
      ],
    }),
    ...result.data.stages.map((stage) => runtime.jsx("box", {
      flexDirection: "row",
      children: [
        runtime.jsx("text", { flexShrink: 0, marginRight: 1, fg: stage.current || stage.id === result.data.currentStage ? theme?.current?.warning : theme?.current?.textMuted, children: statusMarker(stage.status) }),
        runtime.jsx("text", { flexGrow: 1, flexShrink: 1, wrapMode: "word", fg: stage.current || stage.id === result.data.currentStage ? theme?.current?.warning : theme?.current?.textMuted, children: `${stage.id}. ${stage.title}` }),
      ],
    })),
  ];

export const renderStagesElement = (result, theme, runtime = defaultRuntime) => {
  return runtime.jsx("box", {
  flexDirection: "column",
  children: () => renderStagesContent(typeof result === "function" ? result() : result, theme, runtime),
  });
};

const sessionIdFromEvent = (event) => event?.properties?.info?.id
  || event?.properties?.sessionID
  || event?.sessionID
  || event?.sessionId
  || event?.data?.info?.id
  || event?.data?.sessionID
  || event?.properties?.part?.sessionID;
const isCompletedWorkContextTool = (event) => {
  const part = event?.properties?.part;
  return event?.type === "message.part.updated"
    && part?.type === "tool"
    && part.tool?.startsWith(WORK_CONTEXT_PREFIX)
    && ["completed", "error"].includes(part.state?.status);
};
export const sessionIdForSlot = (api, initialSessionId, slotContext = {}, slotState = {}) => slotState.session_id
  || slotState.sessionID
  || slotState.sessionId
  || slotState.session
  || slotContext.session_id
  || slotContext.sessionID
  || slotContext.sessionId
  || slotContext.session
  || api.route?.current?.params?.sessionID
  || api.route?.current?.params?.sessionId
  || api.route?.current?.params?.session_id
  || api.route?.current?.params?.session
  || initialSessionId;
const disposeRegistration = (registration) => {
  if (typeof registration === "function") registration();
  else registration?.dispose?.();
};

export const createStagesTuiController = ({ projectRoot, read = readStagesSnapshot, debounceMs = DEBOUNCE_MS, pollMs = POLL_MS, createSignal: makeSignal = createSignal } = {}) => {
  const snapshots = new Map();
  const generations = new Map();
  const timers = new Map();
  const pollers = new Map();
  const [version, setVersion] = makeSignal(0);
  let disposed = false;

  const readSnapshot = async (sessionId) => {
    if (disposed || !sessionId) return;
    const currentGeneration = (generations.get(sessionId) || 0) + 1;
    generations.set(sessionId, currentGeneration);
    const entry = snapshots.get(sessionId) || { result: null, successful: null };
    snapshots.set(sessionId, entry);
    setVersion((value) => value + 1);
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
    setVersion((value) => value + 1);
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

  const watch = (sessionId) => {
    if (disposed || !sessionId || pollers.has(sessionId) || !pollMs) return;
    pollers.set(sessionId, setInterval(() => scheduleRefresh(sessionId), pollMs));
  };

  const resultFor = (sessionId) => {
    version();
    watch(sessionId);
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
      for (const poller of pollers.values()) clearInterval(poller);
      pollers.clear();
      snapshots.clear();
    },
  };
};

const sleep = (milliseconds, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  const onAbort = () => { clearTimeout(timer); resolve(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal) setTimeout(() => signal.removeEventListener("abort", onAbort), milliseconds);
});

export const resolveProjectRoot = async (api, { timeoutMs = PATH_TIMEOUT_MS, pollMs = PATH_POLL_MS } = {}) => {
  if (!api?.slots?.register) return null;
  const signal = api.lifecycle?.signal;
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() <= deadline) {
    if (api.state?.path?.worktree) return api.state.path.worktree;
    try {
      const location = await api.client?.location?.get?.({});
      const directory = location?.data?.directory || location?.data?.project?.directory;
      if (directory) return directory;
    } catch {}
    await sleep(pollMs, signal);
  }
  return null;
};

const renderStagesSlot = (controller, theme, sessionId, runtime = defaultRuntime) => runtime.jsx("box", {
  flexDirection: "column",
  children: renderStagesElement(() => controller.resultFor(sessionId), theme, runtime),
});

const ACTIVE_WORKSPACE_SESSION = "__active_" + "work" + "_context_workspace__";

// Optional TUI entry point. It is deliberately not imported by the server plugin.
export const tui = async (api, options = {}) => {
  if (activeTuiInstances.has(api) || api?.[ACTIVE_TUI_KEY]) return activeTuiInstances.get(api) || api[ACTIVE_TUI_KEY];
  const projectRoot = await resolveProjectRoot(api, options);
  if (!projectRoot) return;

  const initialSessionId = api.route?.current?.name === "session"
    ? api.route.current.params?.sessionID
      || api.route.current.params?.sessionId
      || api.route.current.params?.session_id
    : undefined;
  const controller = createStagesTuiController({
    projectRoot,
    read: api.stagesSnapshotProvider || readStagesSnapshot,
    debounceMs: options.debounceMs,
    pollMs: options.pollMs,
    createSignal: options.runtime?.createSignal,
  });
  await controller.load(initialSessionId);
  let currentSessionId = initialSessionId;
  let storageWatcher;
  try {
    storageWatcher = fs.watch(path.join(projectRoot, ".work-context"), { recursive: true }, () => {
      controller.scheduleRefresh(currentSessionId);
    });
  } catch {
    // Missing storage is valid; the provider will continue to expose an empty state.
  }

  let cleanup = () => {};
  const unregisterSlot = api.slots.register({
      dispose: () => cleanup(),
      slots: {
      sidebar_content: (slotContext = {}, slotState = {}) => {
        const sessionId = sessionIdForSlot(api, initialSessionId, slotContext, slotState) || ACTIVE_WORKSPACE_SESSION;
        currentSessionId = sessionId;
        return renderStagesSlot(controller, api.theme, sessionId, options.runtime);
      },
    },
  });
  const unsubscribe = api.event?.on?.("session.updated", (event) => {
    controller.scheduleRefresh(sessionIdFromEvent(event));
  });
  const unsubscribeTool = api.event?.on?.("message.part.updated", (event) => {
    if (isCompletedWorkContextTool(event)) controller.scheduleRefresh(sessionIdFromEvent(event));
  });

  let cleaned = false;
  cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (activeTuiInstances.get(api) === cleanup) activeTuiInstances.delete(api);
    if (api?.[ACTIVE_TUI_KEY] === cleanup) delete api[ACTIVE_TUI_KEY];
    controller.dispose();
    storageWatcher?.close();
    disposeRegistration(unsubscribe);
    disposeRegistration(unsubscribeTool);
    disposeRegistration(unregisterSlot);
  };
  api[ACTIVE_TUI_KEY] = cleanup;
  activeTuiInstances.set(api, cleanup);
  api.lifecycle?.onDispose?.(cleanup);
  return cleanup;
};

export default { id: "work-context-stages", tui };
