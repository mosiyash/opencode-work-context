import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { WorkContext, readStagesSnapshot, readWorkContextSnapshot, renderStagesPanel } from "../src/index.js";
import tuiModule, { createStagesTuiController, renderStagesElement, sessionIdForSlot } from "../plugin/stages-tui.js";
import realTuiLoader from "../.opencode/tui-plugins/work-context-stages.js";
import { appendPromptCommand, buildWorkContextActionCommand, createWorkContextActionFlow, createWorkContextModalController, filterWorkspaces, insertPromptCommand, prepareWorkContextCommand, renderWorkContextModal, WORK_CONTEXT_ACTIONS } from "../plugin/work-context-modal.js";

const makeRoot = () => fs.mkdtempSync(path.join("/tmp/opencode", "stages-tui-test-"));
const removeRoot = (root) => fs.rmSync(root, { recursive: true, force: true });
const packageManifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tuiSmokeEnabled = process.env.OPENCODE_TUI_SMOKE === "1";

test("snapshot is read-only when storage is absent", () => {
  const root = makeRoot();
  try {
    const result = readStagesSnapshot({ projectRoot: root, sessionId: "missing" });
    assert.equal(result.ok, true);
    assert.equal(result.data.workspace, null);
    assert.equal(fs.existsSync(path.join(root, ".work-context")), false);
  } finally { removeRoot(root); }
});

test("work-context snapshot lists every workspace without initializing absent storage", () => {
  const root = makeRoot();
  try {
    const result = readWorkContextSnapshot({ projectRoot: root, sessionId: "missing" });
    assert.deepEqual(result.data.workspaces, []);
    assert.equal(fs.existsSync(path.join(root, ".work-context")), false);
  } finally { removeRoot(root); }
});

test("work-context snapshot includes stages and session metadata for all workspaces", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("First workspace", { workspace: "999970", sessionId: "oc-first" });
    context.createWorkspace("Second workspace", { workspace: "999971", sessionId: "oc-second" });
    context.addStage("999970", "Implementation", { goal: "Build the read model" });
    const result = readWorkContextSnapshot({ projectRoot: root, sessionId: "oc-first" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.workspaces.map((workspace) => workspace.id), ["999970", "999971"]);
    assert.equal(result.data.currentWorkspace, "999970");
    assert.equal(result.data.workspaces[0].currentStage, "01");
    assert.equal(result.data.workspaces[0].activeSession.session_id, "oc-first");
    assert.equal(result.data.workspaces[0].stages[1].description, "Build the read model");
  } finally { removeRoot(root); }
});

test("snapshot selects workspace and current stage by OpenCode session ID", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Panel workspace", { workspace: "999987", sessionId: "oc-1" });
    context.handoff("999987", "01", "oc-1");
    context.addStage("999987", "Implementation", { goal: "Build the panel" });
    context.startSession("999987", "02", { sessionId: "oc-2" });

    const result = readStagesSnapshot({ projectRoot: root, sessionId: "oc-2" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.workspace, { id: "999987", title: "Panel workspace", status: "in_progress" });
    assert.equal(result.data.currentStage, "02");
    assert.deepEqual(result.data.stages, [
      { id: "01", title: "Planning", status: "in_progress", description: "Clarify the work goal and constraints", current: false },
      { id: "02", title: "Implementation", status: "in_progress", description: "Build the panel", current: true },
    ]);
    assert.equal(typeof result.data.generatedAt, "string");
  } finally { removeRoot(root); }
});

test("snapshot falls back to the single active workspace when session mapping is unavailable", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Fallback workspace", { workspace: "999982", sessionId: "work-context-session" });
    context.handoff("999982", "01", "work-context-session");
    context.addStage("999982", "Fallback stage");
    context.startSession("999982", "02", { sessionId: "work-context-session-2" });

    const result = readStagesSnapshot({ projectRoot: root, sessionId: "unmapped-opencode-session" });
    assert.equal(result.data.workspace.id, "999982");
    assert.equal(result.data.currentStage, "02");
  } finally { removeRoot(root); }
});

test("snapshot resolves a session stored with its OpenCode session ID", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Mapped workspace", { workspace: "999983", sessionId: "work-context-session" });
    context.handoff("999983", "01", "work-context-session");
    context.addStage("999983", "A stage");
    context.startSession("999983", "02", { sessionId: "work-context-session-2", opencodeSessionId: "oc-current" });

    const result = readStagesSnapshot({ projectRoot: root, sessionId: "oc-current" });
    assert.equal(result.ok, true);
    assert.equal(result.data.workspace.id, "999983");
    assert.equal(result.data.currentStage, "02");
  } finally { removeRoot(root); }
});

test("snapshot hides archived stages without renumbering the remaining stages", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Archived panel workspace", { workspace: "999977", sessionId: "oc-archive" });
    context.handoff("999977", "01", "oc-archive");
    context.addStage("999977", "Visible stage");
    context.addStage("999977", "Archived stage");
    context.archiveStage("999977", "03");
    const result = readStagesSnapshot({ projectRoot: root, sessionId: "oc-archive" });
    assert.deepEqual(result.data.stages.map((stage) => stage.id), ["01", "02"]);
    assert.equal(result.data.stages.some((stage) => stage.status === "archived"), false);
  } finally { removeRoot(root); }
});

test("snapshot switches workspace data by the active OpenCode session mapping", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("First workspace", { workspace: "999980", sessionId: "oc-first" });
    context.createWorkspace("Second workspace", { workspace: "999981", sessionId: "oc-second" });

    const first = readStagesSnapshot({ projectRoot: root, sessionId: "oc-first" });
    const second = readStagesSnapshot({ projectRoot: root, sessionId: "oc-second" });
    assert.equal(first.data.workspace.id, "999980");
    assert.equal(first.data.currentStage, "01");
    assert.equal(second.data.workspace.id, "999981");
    assert.equal(second.data.currentStage, "01");
  } finally { removeRoot(root); }
});

test("renderer includes compact status rows and a non-color current marker", () => {
  const output = renderStagesPanel({ ok: true, data: {
    workspace: { id: "000001", title: "Demo", status: "in_progress" },
    stages: [{ id: "01", title: "Plan", status: "planned", description: "Define scope", current: true }],
  } });
  assert.match(output, /\[ \] 01\. Plan/);
  assert.doesNotMatch(output, /Define scope/);
  assert.match(output, /Stages · in_progress/);
});

test("renderer uses todo-style markers for stage statuses", () => {
  const output = renderStagesPanel({ ok: true, data: {
    workspace: { id: "000001", title: "Demo", status: "in_progress" },
    stages: [
      { id: "01", title: "Planned", status: "planned", current: false },
      { id: "02", title: "Active", status: "in_progress", current: true },
      { id: "03", title: "Completed", status: "completed", current: false },
      { id: "04", title: "Cancelled", status: "cancelled", current: false },
      { id: "05", title: "Archived", status: "archived", current: false },
    ],
  } });
  assert.match(output, /\[ \] 01\. Planned/);
  assert.match(output, /\[•\] 02\. Active/);
  assert.match(output, /\[✓\] 03\. Completed/);
  assert.match(output, /\[!] 04\. Cancelled/);
  assert.match(output, /\[-\] 05\. Archived/);
});

test("mounted stages panel updates without remount", { skip: !tuiSmokeEnabled }, async () => {
  const stages = (last) => Array.from({ length: last }, (_, index) => ({
    id: String(index + 1).padStart(2, "0"),
    title: `Test stages ${index + 1}`,
    status: "planned",
    current: false,
  }));
  const [result, setResult] = createSignal({
    ok: true,
    data: { workspace: { id: "000001", status: "in_progress" }, stages: stages(13), currentStage: null },
  });
  const setup = await testRender(
    () => renderStagesElement(result, {}),
    { width: 60, height: 24 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("13. Test stages 13"));
    assert.doesNotMatch(setup.captureCharFrame(), /14\. Test stages 14/);
    setResult({
      ok: true,
      data: { ...result().data, stages: stages(14) },
    });
    await setup.waitForFrame((frame) => frame.includes("14. Test stages 14"));
  } finally {
    setup.renderer.destroy();
  }
});

test("real TUI loader mounts a live storage update without remount", { skip: !tuiSmokeEnabled }, async () => {
  const root = makeRoot();
  const context = WorkContext.open(root, { actor: "tui-smoke" });
  context.createWorkspace("Live workspace", { workspace: "999978", sessionId: "oc-live" });
  context.addStage("999978", "Initial stage");
  let slot;
  let dispose;
  const api = {
    state: { path: { worktree: root } },
    route: { current: { name: "session", params: { sessionID: "oc-live" } } },
     slots: { register: (plugin) => { slot = plugin.slots.sidebar_content; return () => {}; } },
    event: { on: () => () => {} },
    lifecycle: { onDispose: (callback) => { dispose = callback; return () => {}; } },
  };
  try {
    await realTuiLoader.tui(api, { pollMs: 10, debounceMs: 1 });
    const setup = await testRender(() => slot({}, { session_id: "oc-live" }), { width: 60, height: 12 });
    try {
      await setup.waitForFrame((frame) => frame.includes("02. Initial stage"));
      context.addStage("999978", "Added after mount");
      await setup.waitForFrame((frame) => frame.includes("03. Added after mount"));
    } finally { setup.renderer.destroy(); }
  } finally {
    dispose?.();
    removeRoot(root);
  }
});

test("renderer keeps long stage text for the TUI to wrap without duplicating workspace title", () => {
  const output = renderStagesPanel({ ok: true, data: {
    workspace: { id: "000001", title: "A workspace title that is deliberately much too long" },
    stages: [{ id: "01", title: "A stage title that is deliberately much too long", status: "planned", description: "A description that is deliberately much too long for the compact sidebar panel", current: false }],
  } });
  assert.doesNotMatch(output, /A workspace title/);
  assert.match(output, /\[ \] 01\. A stage title that is deliberately much too long/);
  assert.doesNotMatch(output, /A description that is deliberately/);
});

test("missing workspace and storage errors become safe panel states", () => {
  const root = makeRoot();
  try {
    const missing = readStagesSnapshot({ projectRoot: root, sessionId: "unknown" });
    assert.match(renderStagesPanel(missing), /no workspace/);

    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Missing", { workspace: "999985", sessionId: "oc-missing" });
    fs.rmSync(path.join(root, ".work-context", "999985"), { recursive: true, force: true });
    assert.match(renderStagesPanel(readStagesSnapshot({ projectRoot: root, sessionId: "oc-missing" })), /no workspace/);
    context.createWorkspace("Broken", { workspace: "999986", sessionId: "oc-broken" });
    fs.writeFileSync(path.join(root, ".work-context", "999986", "workspace.md"), "broken\n");
    const broken = readStagesSnapshot({ projectRoot: root, sessionId: "oc-broken" });
    assert.equal(broken.ok, false);
    assert.match(renderStagesPanel(broken), /STORAGE_ERROR/);
  } finally { removeRoot(root); }
});

test("TUI module satisfies the available OpenCode plugin contract", async () => {
  assert.equal(typeof tuiModule.tui, "function");
  assert.equal(await tuiModule.tui({}), undefined);
  let slot;
  let dispose;
  let unsubscribed = false;
  let unregistered = false;
  const api = {
    state: { path: { worktree: makeRoot() } },
     slots: { register: (value) => { slot = value.slots.sidebar_content; return () => { unregistered = true; }; } },
    event: { on: () => () => { unsubscribed = true; } },
    lifecycle: { onDispose: (fn) => { dispose = fn; return () => {}; } },
  };
   try {
     await tuiModule.tui(api);
     assert.equal(typeof slot, "function");
     assert.equal(typeof api.slots.register, "function");
     assert.equal(typeof dispose, "function");
   } finally {
     dispose?.();
     assert.equal(unsubscribed, true);
     assert.equal(unregistered, true);
     removeRoot(api.state.path.worktree);
   }
});

test("stages use the native sidebar content slot", async () => {
  let registered;
  const root = makeRoot();
  const api = {
    state: { path: { worktree: root } },
    slots: { register: (plugin) => { registered = plugin; return () => {}; } },
    lifecycle: { onDispose: () => () => {} },
  };
  try {
    await tuiModule.tui(api);
    assert.equal(typeof registered.slots.sidebar_content, "function");
  } finally { removeRoot(root); }
});

test("stages panel does not claim the whole sidebar height", () => {
  const runtime = { jsx: (type, props) => ({ type, props }) };
  const element = renderStagesElement({ ok: true, data: { workspace: { id: "000001", status: "in_progress" }, stages: [] } }, {}, runtime);
  assert.equal(element.type, "box");
  assert.equal(element.props.flexGrow, undefined);
  assert.equal(element.props.minHeight, undefined);
  assert.equal(element.props.maxHeight, undefined);
});

test("TUI performs an initial load and refreshes after session.updated with debounce", async () => {
  const calls = [];
  const handlers = new Map();
  const api = {
    state: { path: { worktree: makeRoot() } },
    route: { current: { name: "session", params: { sessionID: "oc-1" } } },
    slots: { register: () => () => {} },
    event: { on: (name, callback) => { handlers.set(name, callback); return () => {}; } },
    lifecycle: { onDispose: () => () => {} },
    stagesSnapshotProvider: async ({ sessionId }) => {
      calls.push(sessionId);
      return { ok: true, data: { workspace: { id: "000001", title: "Demo", status: "in_progress" }, stages: [], currentStage: null } };
    },
  };
  try {
    await tuiModule.tui(api);
    assert.deepEqual(calls, ["oc-1"]);
    handlers.get("session.updated")({ sessionID: "oc-1" });
    handlers.get("session.updated")({ properties: { info: { id: "oc-1" } } });
    handlers.get("session.updated")({ type: "session.updated", data: { sessionID: "oc-1" } });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(calls, ["oc-1", "oc-1"]);
  } finally { removeRoot(api.state.path.worktree); }
});

test("TUI refreshes immediately after a work-context tool completes", async () => {
  const calls = [];
  const handlers = new Map();
  const api = {
    state: { path: { worktree: makeRoot() } },
    route: { current: { name: "session", params: { sessionID: "oc-1" } } },
    slots: { register: () => () => {} },
    event: { on: (name, callback) => { handlers.set(name, callback); return () => {}; } },
    lifecycle: { onDispose: () => () => {} },
    stagesSnapshotProvider: async ({ sessionId }) => {
      calls.push(sessionId);
      return { ok: true, data: { workspace: { id: "000001" }, stages: [], currentStage: null } };
    },
  };
  try {
    await tuiModule.tui(api, { pollMs: 0 });
    handlers.get("message.part.updated")({ type: "message.part.updated", properties: { part: {
      type: "tool", tool: "work_context_add_stage", sessionID: "oc-1", state: { status: "completed" },
    } } });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(calls, ["oc-1", "oc-1"]);
  } finally { removeRoot(api.state.path.worktree); }
});

test("TUI live update reads a newly added stage from the real tool event shape", async () => {
  const root = makeRoot();
  const context = WorkContext.open(root, { actor: "test" });
  context.createWorkspace("Event workspace", { workspace: "999977", sessionId: "oc-1" });
  const handlers = new Map();
  const snapshots = [];
  const api = {
    state: { path: { worktree: root } },
    route: { current: { name: "session", params: { sessionID: "oc-1" } } },
    slots: { register: () => "work-context-stages" },
    event: { on: (name, callback) => { handlers.set(name, callback); return () => {}; } },
    lifecycle: { onDispose: () => () => {} },
    stagesSnapshotProvider: async (input) => {
      const result = readStagesSnapshot(input);
      snapshots.push(result);
      return result;
    },
  };
  try {
    await tuiModule.tui(api, { pollMs: 0, debounceMs: 1 });
    context.addStage("999977", "Added by tool");
    handlers.get("message.part.updated")({
      type: "message.part.updated",
      properties: {
        sessionID: "oc-1",
        part: { type: "tool", tool: "work_context_add_stage", state: { status: "completed" } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(snapshots.at(-1).data.stages.at(-1).title, "Added by tool");
  } finally { removeRoot(root); }
});

test("TUI refreshes when canonical work-context storage changes", async () => {
  const root = makeRoot();
  const context = WorkContext.open(root, { actor: "test" });
  context.createWorkspace("Watched workspace", { workspace: "999979", sessionId: "oc-1" });
  let reads = 0;
  const api = {
    state: { path: { worktree: root } },
    route: { current: { name: "session", params: { sessionID: "oc-1" } } },
    slots: { register: () => () => {} },
    event: { on: () => () => {} },
    lifecycle: { onDispose: () => () => {} },
    stagesSnapshotProvider: async () => {
      reads += 1;
      return { ok: true, data: { workspace: { id: "999979" }, stages: [], currentStage: null } };
    },
  };
  try {
    await tuiModule.tui(api, { pollMs: 0 });
    context.addStage("999979", "Watched stage");
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(reads >= 2, true);
  } finally { removeRoot(root); }
});

test("sidebar content resolves the session ID from host slot props or route", () => {
  const api = { route: { current: { params: { sessionID: "oc-route" } } } };
  assert.equal(sessionIdForSlot(api, "oc-initial", {}, { session_id: "oc-slot" }), "oc-slot");
  assert.equal(sessionIdForSlot(api, "oc-initial", { sessionID: "oc-context" }), "oc-context");
  assert.equal(sessionIdForSlot(api, "oc-initial"), "oc-route");
});

test("TUI waits for a late worktree path and does not initialize storage before it exists", async () => {
  const root = makeRoot();
  let dispose;
  let slot;
  let worktree = "";
  const api = {
    state: { ready: false, path: { worktree } },
    client: { location: { get: async () => ({ data: { directory: root } }) } },
    lifecycle: { signal: new AbortController().signal, onDispose: (fn) => { dispose = fn; } },
     slots: { register: (plugin) => { slot = plugin.slots.sidebar_content; return () => {}; } },
    stagesSnapshotProvider: async () => ({ ok: true, data: { workspace: null, stages: [] } }),
  };
  try {
    await tuiModule.tui(api, { timeoutMs: 100, pollMs: 1 });
    assert.equal(typeof slot, "function");
    assert.equal(dispose instanceof Function, true);
  } finally { dispose?.(); removeRoot(root); }
});

test("sidebar content is mounted under a host-owned root", async () => {
  const root = makeRoot();
  let slot;
  const api = {
    state: { path: { worktree: root } },
     slots: { register: (plugin) => { slot = plugin.slots.sidebar_content; return () => {}; } },
    lifecycle: { onDispose: () => () => {} },
    stagesSnapshotProvider: async () => ({ ok: true, data: { workspace: { id: "000001", status: "in_progress" }, stages: [], currentStage: null } }),
  };
  try {
    await tuiModule.tui(api);
    assert.match(slot.toString(), /renderStagesSlot/);
  } finally { removeRoot(root); }
});

test("controller invalidates reactive slot reads after an asynchronous refresh", async () => {
  let resolve;
  const controller = createStagesTuiController({
    projectRoot: "/tmp/project",
    read: async () => new Promise((done) => { resolve = done; }),
  });
  const first = controller.load("oc-1");
  assert.equal(controller.resultFor("oc-1").loading, true);
  resolve({ ok: true, data: { workspace: { id: "000001" }, stages: [] } });
  await first;
  assert.equal(controller.resultFor("oc-1").data.workspace.id, "000001");
  controller.dispose();
});

test("package exports preserve server and TUI plugin entry points", async () => {
  const server = await import("opencode-work-context/plugin");
  const serverEntry = await import("opencode-work-context/server");
  const tui = await import("opencode-work-context/tui");
  const adapter = await import("opencode-work-context/adapter");
  assert.equal(typeof server.default, "function");
  assert.equal(typeof serverEntry.default.server, "function");
  assert.equal(typeof tui.default.tui, "function");
  assert.equal(typeof adapter.contextFor, "function");
  assert.equal(typeof adapter.readStagesSnapshot, "function");
  assert.equal(packageManifest.exports["./plugin"], "./plugin/work-context.js");
  assert.equal(packageManifest.exports["./server"], "./plugin/server.js");
  assert.equal(packageManifest.exports["./tui"], "./plugin/tui.js");
  assert.equal(fs.readFileSync(new URL("../plugin/stages-tui.js", import.meta.url), "utf8").includes("work_context_"), false);
});

test("TUI loader is outside the server plugin autoscan path", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../.opencode/tui.json", import.meta.url), "utf8"));
  assert.deepEqual(config.plugin, ["./tui-plugins/work-context-stages.js"]);
  assert.equal(fs.existsSync(new URL("../.opencode/tui-plugins/work-context-stages.js", import.meta.url)), true);
  assert.equal(fs.existsSync(new URL("../.opencode/plugins/work-context-stages.js", import.meta.url)), false);
  assert.match(fs.readFileSync(new URL("../.opencode/tui-plugins/work-context-stages.js", import.meta.url), "utf8"), /plugin\/tui\.js/);
});

test("server plugin remains usable without TUI APIs", async () => {
  const server = (await import("../plugin/work-context.js")).default;
  const hooks = await server({ client: { session: { get: async () => ({ data: {} }) } }, directory: "/tmp/project", worktree: "/tmp/project" });
  assert.deepEqual(Object.keys(hooks).sort(), ["event", "tool", "tool.execute.after"]);
});

test("debounce keeps refreshes for different sessions independent", async () => {
  const calls = [];
  const controller = createStagesTuiController({
    projectRoot: "/tmp/project",
    debounceMs: 100,
    read: async ({ sessionId }) => { calls.push(sessionId); return { ok: true, data: { workspace: null, stages: [] } }; },
  });
  controller.scheduleRefresh("oc-1");
  controller.scheduleRefresh("oc-2");
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.deepEqual(calls.sort(), ["oc-1", "oc-2"]);
  controller.dispose();
});

test("controller ignores stale reads and keeps the last successful snapshot on error", async () => {
  const pending = [];
  const controller = createStagesTuiController({
    projectRoot: "/tmp/project",
    read: async () => new Promise((resolve) => pending.push(resolve)),
  });
  const first = controller.load("oc-1");
  const second = controller.load("oc-1");
  pending[0]({ ok: true, data: { workspace: { id: "old" }, stages: [] } });
  await first;
  assert.equal(controller.resultFor("oc-1").loading, true);
  pending[1]({ ok: true, data: { workspace: { id: "new" }, stages: [] } });
  await second;
  assert.equal(controller.resultFor("oc-1").data.workspace.id, "new");

  const failing = createStagesTuiController({
    projectRoot: "/tmp/project",
    read: async () => ({ ok: false, error: { code: "STORAGE_ERROR" } }),
  });
  await failing.load("oc-1");
  assert.equal(failing.resultFor("oc-1").ok, false);
  failing.dispose();
  controller.dispose();
});

test("controller exposes stale marker after a failed refresh and disposes timers", async () => {
  let attempt = 0;
  let reads = 0;
  const controller = createStagesTuiController({
    projectRoot: "/tmp/project",
    read: async () => {
      reads += 1;
      attempt += 1;
      return attempt === 1
        ? { ok: true, data: { workspace: { id: "000001", title: "Demo", status: "in_progress" }, stages: [] } }
        : { ok: false, error: { code: "STORAGE_ERROR" } };
    },
  });
  await controller.load("oc-1");
  controller.scheduleRefresh("oc-1");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.match(renderStagesPanel(controller.resultFor("oc-1")), /stale: STORAGE_ERROR/);
  controller.scheduleRefresh("oc-1");
  controller.dispose();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(reads, 2);
});

test("controller polls stage storage when a lifecycle mutation emits no session event", async () => {
  let snapshot = { ok: true, data: { workspace: { id: "000001" }, stages: [{ id: "08" }], currentStage: "08" } };
  const controller = createStagesTuiController({
    projectRoot: "/tmp/project",
    pollMs: 10,
    debounceMs: 1,
    read: async () => snapshot,
  });
  try {
    await controller.load("oc-1");
    assert.equal(controller.resultFor("oc-1").data.stages.length, 1);
    snapshot = { ...snapshot, data: { ...snapshot.data, stages: [{ id: "08" }, { id: "09" }] } };
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(controller.resultFor("oc-1").data.stages.length, 2);
  } finally { controller.dispose(); }
});

test("TUI cleanup releases subscriptions and slot registration once", async () => {
  let dispose;
  let unsubscribed = 0;
  let unregistered = 0;
  const api = {
    state: { path: { worktree: makeRoot() } },
    slots: { register: () => () => { unregistered += 1; } },
    event: { on: () => ({ dispose: () => { unsubscribed += 1; } }) },
    lifecycle: { onDispose: (callback) => { dispose = callback; } },
    stagesSnapshotProvider: async () => ({ ok: true, data: { workspace: null, stages: [] } }),
  };
  try {
    await tuiModule.tui(api);
    dispose();
    dispose();
    assert.equal(unsubscribed, 2);
    assert.equal(unregistered, 1);
  } finally { removeRoot(api.state.path.worktree); }
});

test("reinitializing the TUI on one host does not duplicate the stages slot", async () => {
  let registrations = 0;
  const root = makeRoot();
  const api = {
    state: { path: { worktree: root } },
    slots: { register: () => { registrations += 1; return "stages-slot"; } },
    lifecycle: { onDispose: () => () => {} },
    stagesSnapshotProvider: async () => ({ ok: true, data: { workspace: null, stages: [] } }),
  };
  try {
    await tuiModule.tui(api, { pollMs: 0 });
    await tuiModule.tui(api, { pollMs: 0 });
    assert.equal(registrations, 1);
  } finally { removeRoot(root); }
});

test("nested TUI loaders keep one stages slot through the stable plugin ID", async () => {
  const registrations = [];
  const root = makeRoot();
  const api = {
    state: { path: { worktree: root } },
    slots: { register: (plugin) => { registrations.push(plugin.slots.sidebar_content); return () => {}; } },
    lifecycle: { onDispose: () => () => {} },
    stagesSnapshotProvider: async () => ({ ok: true, data: { workspace: null, stages: [] } }),
  };
  try {
    // OpenCode 1.18.25 walks nested .opencode/tui.json files and keeps the
    // first module for a plugin ID. The local aggregate is discovered first.
    const loadedById = new Map();
    for (const plugin of [realTuiLoader, tuiModule]) {
      if (!loadedById.has(plugin.id)) loadedById.set(plugin.id, plugin);
    }
    assert.equal(realTuiLoader.id, "work-context-stages");
    assert.equal(loadedById.size, 1);
    for (const plugin of loadedById.values()) await plugin.tui(api, { pollMs: 0 });
    assert.equal(registrations.length, 1);
  } finally { removeRoot(root); }
});

test("work-context modal filtering keeps matching stages and workspaces", () => {
  const filtered = filterWorkspaces([
    { id: "000001", title: "Alpha", status: "in_progress", stages: [{ id: "01", title: "Build", description: "Read model" }] },
    { id: "000002", title: "Beta", status: "planned", stages: [{ id: "01", title: "Plan", description: "Scope" }] },
  ], "read model");
  assert.deepEqual(filtered.map((workspace) => workspace.id), ["000001"]);
  assert.deepEqual(filtered[0].stages.map((stage) => stage.id), ["01"]);
});

test("work-context modal controller bounds workspace and stage navigation", async () => {
  let closed = 0;
  const controller = createWorkContextModalController({
    projectRoot: "/tmp/project",
    read: async () => ({ ok: true, data: { schema: 1, currentWorkspace: "000001", workspaces: [
      { id: "000001", title: "First", status: "in_progress", stages: [{ id: "01", title: "One" }], sessions: [] },
      { id: "000002", title: "Second", status: "planned", stages: [{ id: "01", title: "Two" }], sessions: [] },
    ] } }),
    onClose: () => { closed += 1; },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.handleKey({ key: "ArrowUp" });
    assert.equal(controller.selectedWorkspace().id, "000001");
    controller.handleKey({ key: "ArrowDown" });
    controller.handleKey({ key: "ArrowDown" });
    assert.equal(controller.selectedWorkspace().id, "000002");
    controller.handleKey({ key: "ArrowRight" });
    assert.equal(controller.selectedStage().id, "01");
    controller.handleKey({ name: "escape" });
    assert.equal(closed, 1);
  } finally { controller.dispose(); }
});

test("work-context modal renderer exposes empty, filter, and navigation state", async () => {
  const controller = createWorkContextModalController({ read: async () => ({ ok: true, data: { workspaces: [], currentWorkspace: null } }) });
  const runtime = { jsx: (type, props) => ({ type, props }) };
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const element = renderWorkContextModal(controller, {}, runtime);
    const children = element.props.children();
    assert.equal(children.some((item) => item.props?.children === "No workspaces found."), true);
    assert.equal(children.some((item) => item.props?.children?.some?.((child) => String(child.props?.children).includes("type to filter"))), true);
  } finally { controller.dispose(); }
});

test("work-context modal constrains workspace and stage lists independently", async () => {
  const controller = createWorkContextModalController({ read: async () => ({ ok: true, data: { workspaces: [
    { id: "000001", title: "Long workspace title", status: "in_progress", stages: [{ id: "01", title: "Planning" }], sessions: [] },
  ], currentWorkspace: "000001" } }) });
  const runtime = { jsx: (type, props) => ({ type, props }) };
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const children = renderWorkContextModal(controller, {}, runtime, { maxListHeight: 18 }).props.children();
    const columns = children.find((item) => item.props?.children?.some?.((child) => child.props?.children?.[0]?.props?.children === "Workspaces"));
    const [workspaceColumn, stageColumn] = columns.props.children;
    assert.equal(workspaceColumn.props.width, "40%");
    assert.equal(workspaceColumn.props.children[1].type, "scrollbox");
    assert.equal(workspaceColumn.props.children[1].props.maxHeight, 18);
    assert.equal(stageColumn.props.children[1].type, "scrollbox");
    assert.equal(stageColumn.props.children[1].props.maxHeight, 18);
  } finally { controller.dispose(); }
});

test("modal prepares canonical commands and normalizes stage identifiers", () => {
  assert.deepEqual(prepareWorkContextCommand("list", "000004"), { ok: true, command: "/wc workspace list 000004" });
  assert.deepEqual(prepareWorkContextCommand("resume", "000004", "7"), { ok: true, command: "/wc resume 000004 07" });
  assert.deepEqual(prepareWorkContextCommand("handoff", "000004", "02"), { ok: true, command: "/wc stage handoff 000004 02" });
  assert.deepEqual(prepareWorkContextCommand("finish", "000004", "02"), { ok: true, command: "/wc stage finish 000004 02" });
  assert.equal(prepareWorkContextCommand("resume", "4", "2").error.code, "INVALID_ARGUMENT");
  assert.equal(prepareWorkContextCommand("finish", "000004", "0").error.code, "INVALID_ARGUMENT");
});

test("action modal builds canonical commands and safely quotes user input", () => {
  assert.deepEqual(buildWorkContextActionCommand("create", { value: "New workspace" }), { ok: true, command: "/wc create \"New workspace\"" });
  assert.deepEqual(buildWorkContextActionCommand("stage.add", { workspace: "000004", value: "Build", prompt: "Implement \"carefully\"" }), { ok: true, command: "/wc stage add 000004 \"Build\" \"Implement \\\"carefully\\\"\"" });
  assert.deepEqual(buildWorkContextActionCommand("stage.finish", { workspace: "000004", stage: "2" }), { ok: true, command: "/wc stage finish 000004 02" });
  assert.deepEqual(buildWorkContextActionCommand("stage.update-result", { workspace: "000004", stage: "2", value: "Translated result" }), { ok: true, command: "/wc stage update-result 000004 02 \"Translated result\"" });
  assert.equal(buildWorkContextActionCommand("stage.rename", { workspace: "000004", stage: "02" }).error.code, "INVALID_ARGUMENT");
});

test("action modal appends through the public TUI endpoint without submitting", async () => {
  const calls = [];
  const api = { state: { path: { directory: "/tmp/project" } }, client: { tui: { appendPrompt: async (...args) => calls.push(args) } } };
  assert.deepEqual(await appendPromptCommand(api, "/wc list"), { ok: true, command: "/wc list", submitted: false });
  assert.deepEqual(calls, [[{ directory: "/tmp/project", text: "/wc list" }, { throwOnError: true }]]);
});

test("action modal uses native dialogs to prepare an add-stage command", async () => {
  let current;
  let cleared = 0;
  const appended = [];
  const api = {
    state: { path: { worktree: "/tmp/project" } },
    ui: {
      DialogSelect: (props) => ({ type: "select", props }),
      DialogPrompt: (props) => ({ type: "prompt", props }),
      dialog: { replace: (render) => { current = render(); }, clear: () => { cleared += 1; }, setSize: () => {} },
      toast: () => {},
    },
    client: { tui: { appendPrompt: async ({ text }) => appended.push(text) } },
  };
  const flow = createWorkContextActionFlow(api, { read: async () => ({ ok: true, data: { workspaces: [
    { id: "000004", title: "Demo", status: "in_progress", stages: [] },
  ] } }) });
  flow.open();
  assert.equal(current.type, "select");
  assert.equal(current.props.options, WORK_CONTEXT_ACTIONS);
  current.props.onSelect(current.props.options.find((option) => option.value === "stage.add"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  current.props.onSelect(current.props.options[0]);
  current.props.onConfirm("Build UI");
  current.props.onConfirm("Use native dialogs");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(appended, ["/wc stage add 000004 \"Build UI\" \"Use native dialogs\""]);
  assert.equal(cleared, 1);
});

test("browse workspaces opens a searchable read-only stage list before actions", async () => {
  let current;
  const appended = [];
  const api = {
    state: { path: { worktree: "/tmp/project" } },
    ui: {
      DialogSelect: (props) => ({ type: "select", props }),
      DialogPrompt: (props) => ({ type: "prompt", props }),
      dialog: { replace: (render) => { current = render(); }, clear: () => {}, setSize: () => {} },
      toast: () => {},
    },
    client: { tui: { appendPrompt: async ({ text }) => appended.push(text) } },
  };
  const flow = createWorkContextActionFlow(api, { read: async () => ({ ok: true, data: {
    currentWorkspace: "000006",
    workspaces: [
      { id: "000001", title: "Completed research", status: "completed", stages: [{ id: "01", title: "Plan", status: "completed" }] },
      { id: "000006", title: "Modal", status: "in_progress", stages: [{ id: "12", title: "Manual verification", status: "in_progress", current: true }] },
    ],
  } }) });
  flow.open();
  current.props.onSelect(current.props.options.find((option) => option.value === "list"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(current.props.title, "Workspaces");
  assert.match(current.props.options[0].category, /^000006/);
  assert.equal(current.props.options.some((option) => option.title.includes("Manual verification") && option.category.includes("Modal")), true);
  assert.deepEqual(appended, []);
  current.props.onSelect(current.props.options.find((option) => option.value.type === "stage" && option.value.stage.id === "12"));
  assert.match(current.props.title, /^000006\/12/);
  current.props.onSelect(current.props.options.find((option) => option.value === "stage.finish"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(appended, ["/wc stage finish 000006 12"]);
});

test("stage and session browsers provide searchable read-only projections", async () => {
  let current;
  const appended = [];
  const api = {
    state: { path: { worktree: "/tmp/project" } },
    ui: {
      DialogSelect: (props) => ({ type: "select", props }),
      DialogPrompt: (props) => ({ type: "prompt", props }),
      dialog: { replace: (render) => { current = render(); }, clear: () => {}, setSize: () => {} },
      toast: () => {},
    },
    client: { tui: { appendPrompt: async ({ text }) => appended.push(text) } },
  };
  const snapshot = { ok: true, data: { currentWorkspace: "000006", workspaces: [{
    id: "000006",
    title: "Modal",
    status: "in_progress",
    stages: [
      { id: "01", title: "Planning", status: "completed" },
      { id: "12", title: "Manual verification", status: "in_progress", current: true },
    ],
    sessions: [
      { workspace: "000006", stage: "12", ordinal: 1, session_id: "internal-active", opencode_session_id: "oc-current", summary: "Testing modal", state: "active", updated_at: "2026-09-01T12:00:00.000Z" },
      { workspace: "000006", stage: "01", ordinal: 1, session_id: "internal-closed", summary: "Planned work", state: "closed", updated_at: "2026-08-31T12:00:00.000Z" },
    ],
  }] } };
  const flow = createWorkContextActionFlow(api, { sessionId: "oc-current", read: async () => snapshot });

  flow.selectAction("browse.stages");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(current.props.title, "Stages");
  assert.equal(current.props.options[0].category, "Current");
  assert.match(current.props.options[0].title, /000006\/12.*Manual verification.*Modal/);
  current.props.onSelect(current.props.options[0]);
  assert.match(current.props.title, /^000006\/12/);
  assert.equal(current.props.options[0].title, "Back to stages");

  flow.selectAction("browse.sessions");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(current.props.title, "Sessions");
  assert.equal(current.props.options[0].category, "Current");
  assert.match(current.props.options[0].title, /000006 12\/01.*Testing modal/);
  current.props.onSelect(current.props.options.find((option) => option.value.session.state === "closed"));
  assert.equal(current.props.title, "000006 01/01");
  assert.equal(current.props.options.some((option) => option.title.includes("internal-closed") && option.disabled), true);
  assert.deepEqual(appended, []);
});

test("prompt insertion is explicit, never submits, and has a safe fallback", () => {
  const calls = [];
  const host = { ui: { prompt: { append: (command) => calls.push(command) } } };
  assert.deepEqual(insertPromptCommand(host, "/wc resume 000004 07"), { ok: true, command: "/wc resume 000004 07", submitted: false });
  assert.deepEqual(calls, ["/wc resume 000004 07"]);
  assert.equal(insertPromptCommand({}, "/wc stage finish 000004 02").error.code, "PROMPT_INSERT_UNAVAILABLE");
});

test("modal command actions only prepare and append visible prompt text", async () => {
  const root = makeRoot();
  const appended = [];
  try {
    const controller = createWorkContextModalController({
      projectRoot: root,
      read: async () => ({ ok: true, data: { workspaces: [{ id: "000004", title: "Demo", status: "in_progress", stages: [{ id: "02", title: "Build" }], sessions: [] }], currentWorkspace: "000004" } }),
      onCommand: (command) => appended.push(command),
      pollMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.handleKey({ key: "r" });
    assert.deepEqual(appended, ["/wc resume 000004 02"]);
    assert.equal(fs.existsSync(path.join(root, ".work-context")), false);
    controller.dispose();
  } finally { removeRoot(root); }
});
