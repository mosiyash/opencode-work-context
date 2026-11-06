import { createHash } from "node:crypto";
import path from "node:path";
import { loadConfig } from "../src/storage.js";
import { readWorkContextSnapshot } from "../src/work-context-snapshot.js";
import { createGlobalAttentionChannel } from "./global-attention.js";
import { createAttentionActivator } from "./attention-activation.js";
import { createDesktopNotifier } from "./notifier.js";
import { createTuiFocusTracker } from "./tui-focus.js";
import { readTuiState, updateTuiState } from "./tui-state.js";

const ATTENTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SEEN_EVENTS = 500;
const MAX_SESSIONS = 100;
const ACTIVE_ATTENTION_KEY = Symbol.for("opencode-work-context.attention");
const activeControllers = new WeakMap();
const PRIORITY = { idle: 1, question: 2, permission: 3, error: 4 };
const REASON_TEXT = { idle: "response complete", question: "question", permission: "permission", error: "error" };
const EVENT_TYPES = [
  "session.status",
  "session.idle",
  "question.asked",
  "question.v2.asked",
  "permission.asked",
  "permission.v2.asked",
  "session.error",
];

const stableHash = (parts) => createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\0")).digest("hex").slice(0, 24);
const eventBody = (event) => event?.properties || event?.data || {};
const eventSessionId = (event) => {
  const body = eventBody(event);
  return body.sessionID || body.sessionId || body.session_id || event?.sessionID || event?.sessionId || event?.session_id;
};
const eventKey = (event, kind, cycle) => {
  const body = eventBody(event);
  const hostId = body.id || body.requestID || event?.id;
  if (hostId) return `${event.type}:${hostId}`;
  const tool = body.tool || {};
  const error = body.error || {};
  return `${event.type}:fallback:${stableHash([
    eventSessionId(event),
    kind,
    cycle,
    event?.durable?.aggregateID,
    event?.durable?.seq,
    tool.messageID,
    tool.callID,
    error.name,
    error.code,
  ])}`;
};

export const normalizeAttentionEvent = (event, cycle = 0) => {
  const sessionId = eventSessionId(event);
  if (!sessionId || !EVENT_TYPES.includes(event?.type)) return null;
  const body = eventBody(event);
  if (event.type === "session.status") {
    const status = typeof body.status === "string" ? body.status : body.status?.type;
    if (!status || !["busy", "retry", "idle"].includes(status)) return null;
    return { sessionId, kind: "status", status, key: eventKey(event, `status:${status}`, cycle) };
  }
  const kind = event.type === "session.idle"
    ? "idle"
    : event.type.startsWith("question.")
      ? "question"
      : event.type.startsWith("permission.")
        ? "permission"
        : "error";
  return { sessionId, kind, key: eventKey(event, kind, cycle) };
};

export const attentionReasonText = (reason) => REASON_TEXT[reason] || "attention";
export const globalAttentionToast = (event) => {
  const context = [event?.projectTitle, event?.workspaceTitle, event?.stageTitle].filter(Boolean).join(" / ");
  return {
    title: "Work Context",
    message: `${context || "Background session"}: ${attentionReasonText(event?.reason)}`,
    variant: event?.reason === "error" ? "error" : ["permission", "question"].includes(event?.reason) ? "warning" : "info",
    duration: 5000,
  };
};
export const attentionForSession = (api, sessionId) => sessionId === currentSessionId(api)
  ? null
  : api?.workContextAttention?.attentionFor?.(sessionId) || null;
export const acknowledgeNavigation = (api, sessionId, observedEventKey) => {
  if (!sessionId || !observedEventKey) return false;
  return api?.workContextAttention?.acknowledge?.(sessionId, observedEventKey) === true;
};

const validAttention = (value) => value
  && typeof value === "object"
  && typeof value.eventKey === "string"
  && Object.hasOwn(PRIORITY, value.reason)
  && Number.isFinite(value.revision)
  && typeof value.createdAt === "string"
  && typeof value.updatedAt === "string";

export const createAttentionEngine = ({ persisted, now = () => Date.now(), onChange } = {}) => {
  const sessions = new Map();
  const seen = new Map();
  const listeners = new Set();
  let revision = 0;

  const notify = (change) => {
    onChange?.(serialize());
    for (const listener of listeners) listener(change);
  };
  const prune = () => {
    const cutoff = now() - ATTENTION_TTL_MS;
    for (const [key, timestamp] of seen) if (!Number.isFinite(timestamp) || timestamp < cutoff) seen.delete(key);
    for (const [id, state] of sessions) if (!Number.isFinite(state.updatedAt) || state.updatedAt < cutoff) sessions.delete(id);
    while (seen.size > MAX_SEEN_EVENTS) seen.delete(seen.keys().next().value);
    const ordered = [...sessions.entries()].sort((left, right) => (right[1].updatedAt || 0) - (left[1].updatedAt || 0));
    sessions.clear();
    for (const [id, state] of ordered.slice(0, MAX_SESSIONS)) sessions.set(id, state);
  };
  const restore = () => {
    if (!persisted || persisted.schema !== 1) return;
    if (Array.isArray(persisted.seen)) {
      for (const item of persisted.seen) {
        if (Array.isArray(item) && typeof item[0] === "string" && Number.isFinite(item[1])) seen.set(item[0], item[1]);
      }
    }
    if (persisted.sessions && typeof persisted.sessions === "object" && !Array.isArray(persisted.sessions)) {
      for (const [id, value] of Object.entries(persisted.sessions)) {
        if (!id || !value || typeof value !== "object") continue;
        const attention = validAttention(value.attention) ? { ...value.attention } : null;
        revision = Math.max(revision, attention?.revision || 0);
        sessions.set(id, {
          busy: value.busy === true,
          cycle: Number.isInteger(value.cycle) && value.cycle >= 0 ? value.cycle : 0,
          attention,
          updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : now(),
        });
      }
    }
    prune();
  };
  const serialize = () => {
    prune();
    return {
      schema: 1,
      sessions: Object.fromEntries([...sessions].map(([id, state]) => [id, state])),
      seen: [...seen],
    };
  };
  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { busy: false, cycle: 0, attention: null, updatedAt: now() };
      sessions.set(sessionId, state);
    }
    return state;
  };
  const applyAttention = (state, normalized, foreground) => {
    if (foreground === normalized.sessionId) return { changed: false, suppressed: true };
    const current = state.attention;
    if (current && PRIORITY[normalized.kind] < PRIORITY[current.reason]) return { changed: false, suppressed: false };
    const timestamp = new Date(now()).toISOString();
    revision += 1;
    state.attention = {
      eventKey: normalized.key,
      reason: normalized.kind,
      revision,
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    return { changed: true, suppressed: false, attention: { ...state.attention }, created: !current, upgraded: Boolean(current && PRIORITY[normalized.kind] > PRIORITY[current.reason]) };
  };

  restore();
  return {
    apply(event, { foreground } = {}) {
      const initial = normalizeAttentionEvent(event);
      if (!initial) return { changed: false, ignored: true };
      const state = stateFor(initial.sessionId);
      const normalized = normalizeAttentionEvent(event, state.cycle);
      if (seen.has(normalized.key)) return { changed: false, duplicate: true };
      seen.set(normalized.key, now());
      state.updatedAt = now();
      let result = { changed: false };
      if (normalized.kind === "status") {
        if (normalized.status === "busy" || normalized.status === "retry") {
          if (!state.busy) state.cycle += 1;
          state.busy = true;
        } else if (state.busy) {
          state.busy = false;
          result = applyAttention(state, { ...normalized, kind: "idle" }, foreground);
        }
      } else if (normalized.kind === "idle") {
        if (state.busy) {
          state.busy = false;
          result = applyAttention(state, normalized, foreground);
        }
      } else {
        result = applyAttention(state, normalized, foreground);
      }
      prune();
      notify({ sessionId: normalized.sessionId, ...result });
      return { sessionId: normalized.sessionId, ...result };
    },
    acknowledge(sessionId, observedEventKey) {
      const state = sessions.get(sessionId);
      if (!state?.attention) return false;
      if (observedEventKey && state.attention.eventKey !== observedEventKey) return false;
      const acknowledged = { ...state.attention };
      state.attention = null;
      state.updatedAt = now();
      notify({ sessionId, acknowledged });
      return true;
    },
    attentionFor(sessionId) {
      const attention = sessions.get(sessionId)?.attention;
      return attention ? { ...attention } : null;
    },
    list() {
      return [...sessions.entries()].flatMap(([sessionId, state]) => state.attention ? [{ sessionId, ...state.attention }] : []);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    serialize,
  };
};

const currentSessionId = (api) => api?.route?.current?.name === "session"
  ? api.route.current.params?.sessionID || api.route.current.params?.sessionId || api.route.current.params?.session_id
  : undefined;
const linkedSessionIds = (snapshot) => new Set((snapshot?.data?.workspaces || []).flatMap((workspace) =>
  (workspace.sessions || []).map((session) => session.opencode_session_id).filter(Boolean)));
const notificationContexts = (snapshot, sessionId, reason) => {
  const contexts = [];
  const seen = new Set();
  for (const workspace of snapshot?.workspaces || []) {
    for (const session of workspace.sessions || []) {
      if (session.opencode_session_id !== sessionId || !session.stage) continue;
      const key = `${workspace.id}:${session.stage}`;
      if (seen.has(key)) continue;
      const stage = (workspace.stages || []).find((item) => item.id === session.stage);
      if (!stage) continue;
      seen.add(key);
      contexts.push({
        workspaceId: workspace.id,
        workspaceTitle: workspace.title,
        stageId: stage.id,
        stageTitle: stage.title,
        reason,
      });
    }
  }
  return contexts;
};
const disposeRegistration = (registration) => {
  if (typeof registration === "function") registration();
  else registration?.dispose?.();
};

export const desktopNotificationsEnabled = (projectRoot) => {
  try { return loadConfig(projectRoot).notifications?.desktop !== false; } catch { return false; }
};

export const createAttentionTuiController = ({ api, projectRoot, read = readWorkContextSnapshot, onAttention, isFocused = () => true, now } = {}) => {
  const persisted = readTuiState(projectRoot).attention;
  const engine = createAttentionEngine({
    persisted,
    now,
    onChange: (attention) => updateTuiState(projectRoot, (state) => ({ ...state, attention })),
  });
  let linked = new Set();
  let snapshot = null;
  let disposed = false;
  let pending = Promise.resolve();
  const refresh = async () => {
    try {
      const result = await read({ projectRoot, sessionId: currentSessionId(api) });
      if (result?.ok) {
        linked = linkedSessionIds(result);
        snapshot = result.data;
        const current = currentSessionId(api);
        if (isFocused() !== false && current && linked.has(current)) engine.acknowledge(current);
      }
    } catch {}
    return linked;
  };
  const process = async (event) => {
    if (disposed) return { changed: false, ignored: true };
    const sessionId = eventSessionId(event);
    if (!sessionId) return { changed: false, ignored: true };
    await refresh();
    if (!linked.has(sessionId)) return { changed: false, unlinked: true };
    const foreground = isFocused() !== false ? currentSessionId(api) : undefined;
    if (foreground === sessionId) engine.acknowledge(sessionId);
    const result = engine.apply(event, { foreground });
    if (result.changed) onAttention?.({
      sessionId,
      attention: result.attention,
      created: result.created,
      upgraded: result.upgraded,
      contexts: notificationContexts(snapshot, sessionId, result.attention.reason),
    });
    return result;
  };
  const handle = (event) => {
    const result = pending.then(() => process(event));
    pending = result.catch(() => {});
    return result;
  };
  const acknowledge = (sessionId, observedEventKey) => engine.acknowledge(sessionId, observedEventKey);
  const aggregate = (matches) => {
    const bySession = new Map();
    const current = currentSessionId(api);
    for (const attention of engine.list()) {
      if (attention.sessionId === current) continue;
      const records = (snapshot?.workspaces || []).flatMap((workspace) => (workspace.sessions || [])
        .filter((session) => session.opencode_session_id === attention.sessionId)
        .map((session) => ({ workspace, session })));
      if (records.some(matches)) bySession.set(attention.sessionId, attention);
    }
    const items = [...bySession.values()];
    if (!items.length) return null;
    const mostImportant = items.reduce((best, item) => PRIORITY[item.reason] > PRIORITY[best.reason] ? item : best);
    return { count: items.length, reason: mostImportant.reason, items };
  };

  return {
    refresh,
    handle,
    acknowledge,
    attentionFor: engine.attentionFor,
    attentionForStage: (workspace, stage) => aggregate((record) => record.workspace.id === workspace && record.session.stage === stage),
    attentionForWorkspace: (workspace) => aggregate((record) => record.workspace.id === workspace),
    list: engine.list,
    subscribe: engine.subscribe,
    dispose: () => { disposed = true; },
  };
};

export const tui = async (api, options = {}) => {
  if (!api?.event?.on) return;
  if (activeControllers.has(api) || api[ACTIVE_ATTENTION_KEY]) return activeControllers.get(api) || api[ACTIVE_ATTENTION_KEY];
  const projectRoot = api.state?.path?.worktree || api.state?.path?.directory;
  if (!projectRoot) return;
  const ownsDesktopNotifier = !options.desktopNotifier;
  const desktopNotifier = options.desktopNotifier || createDesktopNotifier({ enabled: desktopNotificationsEnabled(projectRoot), ...options.notifierOptions });
  const activator = options.attentionActivator
    || (typeof api.route?.navigate === "function" ? createAttentionActivator({ api, ...options.activatorOptions }) : null);
  let controller;
  const globalChannel = options.globalAttentionChannel === false
    ? null
    : options.globalAttentionChannel || (typeof api.ui?.toast === "function" ? createGlobalAttentionChannel(options.globalAttentionOptions) : null);
  const globalDelivery = globalChannel?.available === true && globalChannel.start((event) => {
    api.ui.toast(globalAttentionToast(event));
    try { options.onGlobalAttention?.(event); } catch {}
    return true;
  });
  const focus = options.tuiFocus || createTuiFocusTracker({
    renderer: api.renderer,
    onFocus: () => { void controller?.refresh(); },
    onActivity: () => {
      globalChannel?.activity?.();
      void activator?.capture?.();
      const sessionId = currentSessionId(api);
      if (sessionId) controller?.acknowledge(sessionId);
    },
    onBlur: () => {
      globalChannel?.deactivate?.();
      activator?.blur?.();
    },
  });
  controller = createAttentionTuiController({
    api,
    projectRoot,
    read: api.attentionSnapshotProvider || readWorkContextSnapshot,
    isFocused: options.isTuiFocused || (globalDelivery
      ? () => globalChannel.hasActiveInstance() ? globalChannel.isActive() && focus.isFocused() : focus.isFocused()
      : () => focus.isFocused()),
    onAttention: (change) => {
      try { options.onAttention?.(change); } catch {}
      const context = change.contexts?.[0];
      if (!context) return;
      if (globalDelivery) globalChannel.publish({
        dedupeKey: `${projectRoot}\0${change.sessionId}\0${change.attention.eventKey}`,
        reason: context.reason,
        projectTitle: path.basename(projectRoot),
        workspaceTitle: context.workspaceTitle,
        stageTitle: context.stageTitle,
      });
      const onOpen = activator?.available ? () => activator.activate(change.sessionId) : undefined;
      void Promise.resolve(desktopNotifier.notify(context, { onOpen })).catch(() => {});
    },
    now: options.now,
  });
  await controller.refresh();
  const registrations = EVENT_TYPES.map((type) => api.event.on(type, (event) => { void controller.handle(event); }));
  registrations.push(api.event.on("tui.session.select", (event) => {
    queueMicrotask(() => {
      const sessionId = currentSessionId(api);
      if (sessionId) controller.acknowledge(sessionId);
    });
  }));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    controller.dispose();
    focus.dispose?.();
    activator?.dispose?.();
    if (ownsDesktopNotifier) desktopNotifier.dispose?.();
    globalChannel?.dispose?.();
    for (const registration of registrations) disposeRegistration(registration);
    if (activeControllers.get(api) === cleanup) activeControllers.delete(api);
    if (api[ACTIVE_ATTENTION_KEY] === cleanup) delete api[ACTIVE_ATTENTION_KEY];
    if (api.workContextAttention === controller) delete api.workContextAttention;
  };
  api.workContextAttention = controller;
  api[ACTIVE_ATTENTION_KEY] = cleanup;
  activeControllers.set(api, cleanup);
  api.lifecycle?.onDispose?.(cleanup);
  return cleanup;
};

export default { id: "work-context-attention", tui };
