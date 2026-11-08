import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createAttentionActivator, parseActiveWindowId } from "../plugin/attention-activation.js";

const child = () => {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.kill = () => { process.killed = true; };
  return process;
};

const successfulSpawn = (calls, outputs = {}) => (...args) => {
  calls.push(args);
  const process = child();
  queueMicrotask(() => {
    if (outputs[args[0]]) process.stdout.emit("data", outputs[args[0]]);
    process.emit("exit", 0);
  });
  return process;
};

test("active X11 window IDs are parsed and normalized safely", () => {
  assert.equal(parseActiveWindowId("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x40002c3\n"), "0x40002c3");
  assert.equal(parseActiveWindowId("window id # 0x0"), null);
  assert.equal(parseActiveWindowId("unexpected"), null);
});

test("activation navigates the source TUI, selects its tmux pane, and focuses its X11 window", async () => {
  const calls = [];
  const navigations = [];
  const route = { current: { name: "session", params: { sessionID: "oc-old" } } };
  const activator = createAttentionActivator({
    api: { route: { ...route, navigate: async (...args) => {
      assert.deepEqual(calls.map((call) => call[0]), ["xprop", "tmux", "tmux", "wmctrl"]);
      navigations.push(args);
      route.current.params.sessionID = args[1].sessionID;
    } } },
    env: { TMUX: "/tmp/tmux", TMUX_PANE: "%20", DISPLAY: ":0" },
    spawn: successfulSpawn(calls, { xprop: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x40002c3\n" }),
    captureThrottleMs: 0,
    activationDelayMs: 0,
  });
  assert.equal(await activator.capture(), "0x40002c3");
  assert.deepEqual(await activator.activate("oc-target"), { ok: true, activated: true, navigated: true, verified: true });
  assert.deepEqual(navigations, [["session", { sessionID: "oc-target" }]]);
  assert.deepEqual(calls.map(([executable, args]) => [executable, args]), [
    ["xprop", ["-root", "_NET_ACTIVE_WINDOW"]],
    ["tmux", ["select-window", "-t", "%20"]],
    ["tmux", ["select-pane", "-t", "%20"]],
    ["wmctrl", ["-ia", "0x40002c3"]],
  ]);
  assert.equal(calls.every((call) => call[2].shell === false), true);
});

test("invalid pane and window values never reach external commands", async () => {
  const calls = [];
  const navigations = [];
  const current = { name: "session", params: { sessionID: "oc-old" } };
  const activator = createAttentionActivator({
    api: { route: { current, navigate: (...args) => { navigations.push(args); current.params.sessionID = args[1].sessionID; } } },
    env: { TMUX: "set", TMUX_PANE: "$(unsafe)", DISPLAY: ":0", WINDOWID: "0xdeadbeef" },
    spawn: successfulSpawn(calls, { xprop: "malformed" }),
  });
  await activator.capture();
  assert.equal((await activator.activate("oc-safe")).ok, true);
  assert.deepEqual(navigations, [["session", { sessionID: "oc-safe" }]]);
  assert.deepEqual(calls.map((call) => call[0]), ["xprop"]);
  assert.equal((await activator.activate("")).ok, false);
});

test("blur invalidates an in-flight X11 window capture", async () => {
  const process = child();
  const activator = createAttentionActivator({
    api: { route: { navigate: () => {} } },
    env: { DISPLAY: ":0" },
    spawn: () => process,
  });
  const pending = activator.capture();
  activator.blur();
  process.stdout.emit("data", "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x40002c3\n");
  process.emit("exit", 0);
  assert.equal(await pending, null);
  assert.equal(activator.target().windowId, null);
});

test("a navigation timeout reports failure after tmux activation", async () => {
  const calls = [];
  const activator = createAttentionActivator({
    api: { route: { navigate: () => new Promise(() => {}) } },
    env: { TMUX: "set", TMUX_PANE: "%20" },
    spawn: successfulSpawn(calls),
    navigationTimeoutMs: 5,
    activationDelayMs: 0,
  });
  assert.deepEqual(await activator.activate("oc-target"), { ok: false, activated: true, navigated: false, verified: false });
  assert.deepEqual(calls.map(([executable, args]) => [executable, args]), [
    ["tmux", ["select-window", "-t", "%20"]],
    ["tmux", ["select-pane", "-t", "%20"]],
  ]);
});

test("resolved navigation must reach the requested route", async () => {
  const activator = createAttentionActivator({
    api: {
      route: {
        current: { name: "session", params: { sessionID: "oc-old" } },
        navigate: async () => {},
      },
    },
    env: {},
    routeVerificationMs: 5,
  });
  assert.deepEqual(await activator.activate("oc-target"), { ok: false, activated: false, navigated: true, verified: false });
});

test("route verification requires an observable session route and supports session_id", async () => {
  const unavailable = createAttentionActivator({
    api: { route: { navigate: async () => {} } },
    env: {},
  });
  assert.equal((await unavailable.activate("oc-target")).verified, false);

  const wrongRoute = createAttentionActivator({
    api: {
      route: {
        current: { name: "home", params: { sessionID: "oc-target" } },
        navigate: async () => {},
      },
    },
    env: {},
    routeVerificationMs: 0,
  });
  assert.equal((await wrongRoute.activate("oc-target")).verified, false);

  const current = { name: "session", params: { session_id: "oc-old" } };
  const aliased = createAttentionActivator({
    api: { route: { current, navigate: async (_name, params) => { current.params.session_id = params.sessionID; } } },
    env: {},
  });
  assert.equal((await aliased.activate("oc-target")).verified, true);
});

test("dispose during the activation boundary prevents navigation", async () => {
  const calls = [];
  let navigated = false;
  const activator = createAttentionActivator({
    api: { route: { current: { name: "session", params: { sessionID: "oc-old" } }, navigate: () => { navigated = true; } } },
    env: { TMUX: "set", TMUX_PANE: "%20" },
    spawn: successfulSpawn(calls),
    activationDelayMs: 20,
  });
  const pending = activator.activate("oc-target");
  setTimeout(() => activator.dispose(), 5);
  assert.deepEqual(await pending, { ok: false, activated: true, navigated: false, verified: false });
  assert.equal(navigated, false);
});

test("dispose cancels an in-flight capture", async () => {
  const process = child();
  const activator = createAttentionActivator({
    api: { route: { navigate: () => {} } },
    env: { DISPLAY: ":0" },
    spawn: () => process,
  });
  const pending = activator.capture();
  activator.dispose();
  assert.equal(process.killed, true);
  assert.equal(await pending, null);
});

test("missing activation tools and timeouts degrade without rejecting", async () => {
  const hanging = child();
  const activator = createAttentionActivator({
    api: { route: { navigate: () => { throw new Error("failed"); } } },
    env: { TMUX: "set", TMUX_PANE: "%1" },
    spawn: () => hanging,
    timeoutMs: 5,
  });
  assert.equal((await activator.activate("oc-target")).ok, false);
  assert.equal(hanging.killed, true);
  activator.dispose();
  assert.equal((await activator.activate("oc-target")).ok, false);
});
