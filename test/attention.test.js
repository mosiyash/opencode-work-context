import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attentionForSession, createAttentionEngine, createAttentionTuiController, globalAttentionToast, normalizeAttentionEvent, tui } from "../plugin/attention.js";
import { createGlobalAttentionChannel } from "../plugin/global-attention.js";
import { createTuiFocusTracker } from "../plugin/tui-focus.js";
import { readTuiState, updateTuiState } from "../plugin/tui-state.js";

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "attention-test-"));
const removeRoot = (root) => fs.rmSync(root, { recursive: true, force: true });
const status = (sessionID, type, id = `${sessionID}-${type}`) => ({ id, type: "session.status", properties: { sessionID, status: { type } } });
const idle = (sessionID, id = `${sessionID}-idle`) => ({ id, type: "session.idle", properties: { sessionID } });
const request = (type, sessionID, id = `${sessionID}-${type}`) => ({ id: `event-${id}`, type, properties: { id, sessionID } });
const snapshot = (...sessionIds) => ({ ok: true, data: { workspaces: [{ sessions: sessionIds.map((opencode_session_id) => ({ opencode_session_id })) }] } });

test("busy-to-idle creates attention but startup idle does not", () => {
  const engine = createAttentionEngine();
  assert.equal(engine.apply(idle("oc-1")).changed, false);
  engine.apply(status("oc-1", "busy"));
  const result = engine.apply(idle("oc-1", "idle-after-work"));
  assert.equal(result.changed, true);
  assert.equal(result.attention.reason, "idle");
  assert.equal(engine.attentionFor("oc-1").eventKey, "session.idle:idle-after-work");
});

test("status idle and retry participate in busy-to-idle transitions", () => {
  const engine = createAttentionEngine();
  engine.apply(status("oc-1", "retry", "retry-1"));
  assert.equal(engine.apply(status("oc-1", "idle", "status-idle-1")).attention.reason, "idle");
  engine.acknowledge("oc-1");
  engine.apply(status("oc-1", "busy", "busy-2"));
  assert.equal(engine.apply(status("oc-1", "idle", "status-idle-2")).changed, true);
});

test("question, permission, and error create and upgrade explicit attention", () => {
  const engine = createAttentionEngine();
  engine.apply(status("oc-1", "busy"));
  engine.apply(idle("oc-1"));
  assert.equal(engine.apply(request("question.asked", "oc-1", "q-1")).upgraded, true);
  assert.equal(engine.apply(request("permission.asked", "oc-1", "p-1")).upgraded, true);
  const error = engine.apply({ id: "error-1", type: "session.error", properties: { sessionID: "oc-1", error: { name: "ApiError" } } });
  assert.equal(error.upgraded, true);
  assert.equal(engine.attentionFor("oc-1").reason, "error");
});

test("compatible v2 request variants normalize without treating session.updated as completion", () => {
  assert.equal(normalizeAttentionEvent(request("question.v2.asked", "oc-1", "q-v2")).kind, "question");
  assert.equal(normalizeAttentionEvent(request("permission.v2.asked", "oc-1", "p-v2")).kind, "permission");
  assert.equal(normalizeAttentionEvent({ type: "session.updated", properties: { info: { id: "oc-1" } } }), null);
  assert.equal(normalizeAttentionEvent({ id: "q-data", type: "question.asked", data: { id: "request-data", sessionID: "oc-data" } }).sessionId, "oc-data");
});

test("duplicate delivery and lower-priority signals do not replace attention", () => {
  const engine = createAttentionEngine();
  const event = request("permission.asked", "oc-1", "p-1");
  assert.equal(engine.apply(event).changed, true);
  assert.equal(engine.apply(event).duplicate, true);
  const key = engine.attentionFor("oc-1").eventKey;
  assert.equal(engine.apply(request("question.asked", "oc-1", "q-1")).changed, false);
  assert.equal(engine.attentionFor("oc-1").eventKey, key);
});

test("fallback completion keys distinguish later observed work cycles", () => {
  const engine = createAttentionEngine();
  engine.apply({ type: "session.status", properties: { sessionID: "oc-1", status: { type: "busy" } } });
  engine.apply({ type: "session.idle", properties: { sessionID: "oc-1" } });
  const first = engine.attentionFor("oc-1").eventKey;
  engine.acknowledge("oc-1");
  engine.apply({ type: "session.status", properties: { sessionID: "oc-1", status: { type: "busy" } } });
  engine.apply({ type: "session.idle", properties: { sessionID: "oc-1" } });
  assert.notEqual(engine.attentionFor("oc-1").eventKey, first);
});

test("acknowledgement only clears the event that was observed", () => {
  const engine = createAttentionEngine();
  engine.apply(request("question.asked", "oc-1", "q-1"));
  const observed = engine.attentionFor("oc-1").eventKey;
  engine.apply(request("question.asked", "oc-1", "q-2"));
  assert.equal(engine.acknowledge("oc-1", observed), false);
  const current = engine.attentionFor("oc-1").eventKey;
  assert.equal(engine.acknowledge("oc-1", current), true);
  assert.equal(engine.attentionFor("oc-1"), null);
});

test("foreground events are suppressed while unknown identity retains attention", () => {
  const foreground = createAttentionEngine();
  assert.equal(foreground.apply(request("question.asked", "oc-1"), { foreground: "oc-1" }).suppressed, true);
  assert.equal(foreground.attentionFor("oc-1"), null);
  const unknown = createAttentionEngine();
  assert.equal(unknown.apply(request("question.asked", "oc-1"), { foreground: undefined }).changed, true);
});

test("persistence restores attention and deduplication state", () => {
  const first = createAttentionEngine();
  const event = request("question.asked", "oc-1", "q-1");
  first.apply(event);
  const second = createAttentionEngine({ persisted: first.serialize() });
  assert.equal(second.attentionFor("oc-1").reason, "question");
  assert.equal(second.apply(event).duplicate, true);
});

test("persistence prunes stale deduplication entries and bounds sessions", () => {
  const current = Date.parse("2026-11-04T12:00:00.000Z");
  const stale = current - 31 * 24 * 60 * 60 * 1000;
  const sessions = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`oc-${index}`, { busy: false, cycle: 0, attention: null, updatedAt: current - index }]));
  const engine = createAttentionEngine({ persisted: { schema: 1, sessions, seen: [["stale", stale], ["fresh", current]] }, now: () => current });
  const serialized = engine.serialize();
  assert.equal(Object.keys(serialized.sessions).length, 100);
  assert.deepEqual(serialized.seen, [["fresh", current]]);
});

test("TUI state tolerates malformed files and preserves unrelated fields", () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, ".work-context", "local"), { recursive: true });
    fs.writeFileSync(path.join(root, ".work-context", "local", "tui-state.json"), "not json");
    assert.deepEqual(readTuiState(root), { schema: 1 });
    updateTuiState(root, (state) => ({ ...state, recent_stages: { "000001": ["02"] } }));
    updateTuiState(root, (state) => ({ ...state, attention: { schema: 1, sessions: {}, seen: [] } }));
    assert.deepEqual(readTuiState(root).recent_stages, { "000001": ["02"] });
  } finally { removeRoot(root); }
});

test("controller tracks a shared native session once and preserves it when foreground identity is unavailable", async () => {
  const root = makeRoot();
  let notifications = 0;
  const api = { route: { current: { name: "home" } } };
  const controller = createAttentionTuiController({
    api,
    projectRoot: root,
    read: async () => ({ ok: true, data: { workspaces: [{ sessions: [{ opencode_session_id: "oc-shared" }] }, { sessions: [{ opencode_session_id: "oc-shared" }] }] } }),
    onAttention: () => { notifications += 1; },
  });
  try {
    await controller.handle(request("question.asked", "oc-shared", "q-1"));
    assert.equal(controller.list().length, 1);
    assert.equal(notifications, 1);
  } finally { controller.dispose(); removeRoot(root); }
});

test("controller aggregates one native session across every linked stage and workspace without double counting", async () => {
  const root = makeRoot();
  const api = { route: { current: { name: "home" } } };
  const controller = createAttentionTuiController({
    api,
    projectRoot: root,
    read: async () => ({ ok: true, data: { workspaces: [
      { id: "000001", sessions: [{ stage: "01", opencode_session_id: "oc-shared" }, { stage: "01", opencode_session_id: "oc-shared" }] },
      { id: "000002", sessions: [{ stage: "02", opencode_session_id: "oc-shared" }] },
    ] } }),
  });
  try {
    await controller.handle(request("permission.asked", "oc-shared", "p-1"));
    assert.deepEqual(controller.attentionForStage("000001", "01"), {
      count: 1,
      reason: "permission",
      items: [controller.list()[0]],
    });
    assert.equal(controller.attentionForWorkspace("000002").count, 1);
    assert.equal(controller.attentionForStage("000001", "02"), null);
  } finally { controller.dispose(); removeRoot(root); }
});

test("controller restores unread attention after restart and acknowledges it when that native session is current", async () => {
  const root = makeRoot();
  const backgroundApi = { route: { current: { name: "home" } } };
  const read = async () => snapshot("oc-restored");
  const first = createAttentionTuiController({ api: backgroundApi, projectRoot: root, read });
  await first.handle(request("question.asked", "oc-restored", "q-restored"));
  first.dispose();
  const restarted = createAttentionTuiController({ api: backgroundApi, projectRoot: root, read });
  const foreground = createAttentionTuiController({ api: { route: { current: { name: "session", params: { sessionID: "oc-restored" } } } }, projectRoot: root, read });
  try {
    assert.equal(restarted.attentionFor("oc-restored").reason, "question");
    await foreground.refresh();
    assert.equal(foreground.attentionFor("oc-restored"), null);
  } finally { restarted.dispose(); foreground.dispose(); removeRoot(root); }
});

test("controller ignores unlinked sessions and acknowledges a visible linked session", async () => {
  const root = makeRoot();
  const api = { route: { current: { name: "home" } } };
  const controller = createAttentionTuiController({ api, projectRoot: root, read: async () => snapshot("oc-linked") });
  try {
    assert.equal((await controller.handle(request("question.asked", "oc-other"))).unlinked, true);
    await controller.handle(request("question.asked", "oc-linked", "q-1"));
    api.route.current = { name: "session", params: { sessionID: "oc-linked" } };
    await controller.handle(status("oc-linked", "busy"));
    assert.equal(controller.attentionFor("oc-linked"), null);
  } finally { controller.dispose(); removeRoot(root); }
});

test("terminal blur makes the current native session background until focus returns", async () => {
  const root = makeRoot();
  let focused = false;
  let notifications = 0;
  const api = { route: { current: { name: "session", params: { sessionID: "oc-linked" } } } };
  const controller = createAttentionTuiController({
    api,
    projectRoot: root,
    read: async () => ({ ok: true, data: { workspaces: [{
      id: "000001",
      sessions: [{ stage: "04", opencode_session_id: "oc-linked" }],
    }] } }),
    isFocused: () => focused,
    onAttention: () => { notifications += 1; },
  });
  try {
    await controller.handle(request("question.asked", "oc-linked", "q-blurred"));
    assert.equal(controller.attentionFor("oc-linked").reason, "question");
    api.workContextAttention = controller;
    assert.equal(attentionForSession(api, "oc-linked"), null);
    assert.equal(controller.attentionForStage("000001", "04"), null);
    assert.equal(controller.attentionForWorkspace("000001"), null);
    assert.equal(notifications, 1);
    focused = true;
    await controller.refresh();
    assert.equal(controller.attentionFor("oc-linked"), null);
    await controller.handle(request("permission.asked", "oc-linked", "p-focused"));
    assert.equal(notifications, 1);
  } finally { controller.dispose(); removeRoot(root); }
});

test("TUI focus tracker is fail-safe, observes blur and focus, and disposes listeners", () => {
  const renderer = new EventEmitter();
  renderer.keyInput = new EventEmitter();
  let focused = 0;
  let activity = 0;
  let blurred = 0;
  const tracker = createTuiFocusTracker({ renderer, onFocus: () => { focused += 1; }, onActivity: () => { activity += 1; }, onBlur: () => { blurred += 1; } });
  assert.equal(tracker.state(), "unknown");
  assert.equal(tracker.isFocused(), true);
  renderer.emit("blur");
  assert.equal(blurred, 1);
  assert.equal(tracker.state(), "blurred");
  assert.equal(tracker.isFocused(), false);
  renderer.emit("focus");
  assert.equal(tracker.state(), "focused");
  assert.equal(tracker.isFocused(), true);
  assert.equal(focused, 1);
  assert.equal(activity, 1);
  renderer.emit("blur");
  assert.equal(blurred, 2);
  renderer.keyInput.emit("keypress");
  assert.equal(tracker.state(), "focused");
  assert.equal(activity, 2);
  tracker.dispose();
  renderer.emit("blur");
  renderer.keyInput.emit("keypress");
  assert.equal(tracker.state(), "focused");
  assert.equal(activity, 2);
  assert.equal(blurred, 2);
});

test("global attention toast uses only controlled context and reason text", () => {
  assert.deepEqual(globalAttentionToast({ projectTitle: "project-a", workspaceTitle: "Delivery", stageTitle: "Notify", reason: "permission" }), {
    title: "Work Context",
    message: "project-a / Delivery / Notify: permission",
    variant: "warning",
    duration: 5000,
  });
});

test("TUI attention subscriptions dispose once and duplicate loading is prevented", async () => {
  const root = makeRoot();
  const handlers = new Map();
  let subscriptions = 0;
  let disposals = 0;
  let lifecycleDispose;
  const api = {
    state: { path: { worktree: root } },
    route: { current: { name: "home" } },
    event: { on: (type, handler) => { subscriptions += 1; handlers.set(type, handler); return () => { disposals += 1; }; } },
    lifecycle: { onDispose: (callback) => { lifecycleDispose = callback; } },
    attentionSnapshotProvider: async () => snapshot("oc-1"),
  };
  try {
    const first = await tui(api, { desktopNotifier: { notify: async () => false } });
    const second = await tui(api);
    assert.equal(first, second);
    assert.equal(subscriptions, 8);
    handlers.get("question.asked")(request("question.asked", "oc-1", "q-1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(api.workContextAttention.attentionFor("oc-1").reason, "question");
    lifecycleDispose();
    lifecycleDispose();
    assert.equal(disposals, 8);
    assert.equal(api.workContextAttention, undefined);
  } finally { removeRoot(root); }
});

test("TUI notifies once for new background attention and never replays restored state", async () => {
  const root = makeRoot();
  const handlers = new Map();
  const delivered = [];
  const read = async () => ({ ok: true, data: { workspaces: [{
    id: "000012",
    title: "Desktop delivery",
    stages: [{ id: "04", title: "Notify safely" }],
    sessions: [{ stage: "04", opencode_session_id: "oc-background" }],
  }] } });
  const makeApi = () => ({
    state: { path: { worktree: root } },
    route: { current: { name: "home" } },
    event: { on: (type, handler) => { handlers.set(type, handler); return () => {}; } },
    attentionSnapshotProvider: read,
  });
  const notifier = { notify: async (value) => { delivered.push(value); return true; } };
  const firstApi = makeApi();
  const firstCleanup = await tui(firstApi, { desktopNotifier: notifier });
  try {
    handlers.get("question.asked")(request("question.asked", "oc-background", "q-once"));
    handlers.get("question.asked")(request("question.asked", "oc-background", "q-once"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(delivered, [{
      workspaceId: "000012",
      workspaceTitle: "Desktop delivery",
      stageId: "04",
      stageTitle: "Notify safely",
      reason: "question",
    }]);
  } finally { firstCleanup(); }

  const restartedApi = makeApi();
  const restartedCleanup = await tui(restartedApi, { desktopNotifier: notifier });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(delivered.length, 1);
    restartedApi.route.current = { name: "session", params: { sessionID: "oc-background" } };
    handlers.get("permission.asked")(request("permission.asked", "oc-background", "p-foreground"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(delivered.length, 1);
  } finally { restartedCleanup(); removeRoot(root); }
});

test("TUI renderer blur notifies for the current session across OpenCode processes", async () => {
  const root = makeRoot();
  const handlers = new Map();
  const renderer = new EventEmitter();
  const delivered = [];
  const api = {
    state: { path: { worktree: root } },
    route: { current: { name: "session", params: { sessionID: "oc-current" } } },
    renderer,
    event: { on: (type, handler) => { handlers.set(type, handler); return () => {}; } },
    attentionSnapshotProvider: async () => ({ ok: true, data: { workspaces: [{
      id: "000012",
      title: "Process focus",
      stages: [{ id: "05", title: "Track terminal blur" }],
      sessions: [{ stage: "05", opencode_session_id: "oc-current" }],
    }] } }),
  };
  const cleanup = await tui(api, { desktopNotifier: { notify: async (value) => { delivered.push(value); return true; } } });
  try {
    renderer.emit("blur");
    handlers.get("question.asked")(request("question.asked", "oc-current", "q-blurred-process"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(delivered.length, 1);
    assert.equal(api.workContextAttention.attentionFor("oc-current").reason, "question");
    renderer.emit("focus");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(api.workContextAttention.attentionFor("oc-current"), null);
  } finally {
    cleanup();
    assert.equal(renderer.listenerCount("focus"), 0);
    assert.equal(renderer.listenerCount("blur"), 0);
    removeRoot(root);
  }
});

test("attention from project A is shown as a toast in active project B", async () => {
  const runtime = makeRoot();
  const projectA = makeRoot();
  const projectB = makeRoot();
  const clock = { value: 1000 };
  const handlersA = new Map();
  const toastsA = [];
  const toastsB = [];
  const desktop = [];
  const activated = [];
  let openNotification;
  const channelOptions = (instanceId) => ({
    root: path.join(runtime, "channel"),
    instanceId,
    now: () => clock.value,
    pollMs: 0,
    heartbeatMs: 0,
    activityThrottleMs: 0,
  });
  const channelA = createGlobalAttentionChannel(channelOptions("00000000-0000-4000-8000-000000000001"));
  const channelB = createGlobalAttentionChannel(channelOptions("00000000-0000-4000-8000-000000000002"));
  const apiA = {
    state: { path: { worktree: projectA } },
    route: { current: { name: "session", params: { sessionID: "oc-a" } } },
    renderer: Object.assign(new EventEmitter(), { keyInput: new EventEmitter() }),
    ui: { toast: (value) => { toastsA.push(value); } },
    event: { on: (type, handler) => { handlersA.set(type, handler); return () => {}; } },
    attentionSnapshotProvider: async () => ({ ok: true, data: { workspaces: [{
      id: "000012",
      title: "Cross project",
      stages: [{ id: "05", title: "Route attention" }],
      sessions: [{ stage: "05", opencode_session_id: "oc-a" }],
    }] } }),
  };
  const apiB = {
    state: { path: { worktree: projectB } },
    route: { current: { name: "home" } },
    renderer: Object.assign(new EventEmitter(), { keyInput: new EventEmitter() }),
    ui: { toast: (value) => { toastsB.push(value); } },
    event: { on: () => () => {} },
    attentionSnapshotProvider: async () => snapshot(),
  };
  let cleanupA;
  let cleanupB;
  try {
    cleanupA = await tui(apiA, {
      globalAttentionChannel: channelA,
      attentionActivator: {
        available: true,
        capture: async () => null,
        activate: async (sessionId) => { activated.push(sessionId); return true; },
        dispose: () => {},
      },
      desktopNotifier: { notify: async (value, options) => { desktop.push(value); openNotification = options.onOpen; return true; } },
    });
    clock.value = 1100;
    cleanupB = await tui(apiB, { globalAttentionChannel: channelB, desktopNotifier: { notify: async () => true } });
    apiB.renderer.keyInput.emit("keypress");
    handlersA.get("question.asked")(request("question.asked", "oc-a", "q-cross-project"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(channelB.scan(), 1);
    assert.deepEqual(toastsA, []);
    assert.deepEqual(toastsB, [{
      title: "Work Context",
      message: `${path.basename(projectA)} / Cross project / Route attention: question`,
      variant: "warning",
      duration: 5000,
    }]);
    assert.deepEqual(desktop, [{
      workspaceId: "000012",
      workspaceTitle: "Cross project",
      stageId: "05",
      stageTitle: "Route attention",
      reason: "question",
    }]);
    assert.equal(typeof openNotification, "function");
    await openNotification();
    assert.deepEqual(activated, ["oc-a"]);
    assert.equal(apiA.workContextAttention.attentionFor("oc-a").reason, "question");
    apiB.renderer.emit("blur");
    assert.equal(channelB.hasActiveInstance(), false);
  } finally {
    cleanupB?.();
    cleanupA?.();
    removeRoot(projectB);
    removeRoot(projectA);
    removeRoot(runtime);
  }
});
