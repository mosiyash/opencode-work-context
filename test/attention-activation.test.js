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
  const activator = createAttentionActivator({
    api: { route: { navigate: async (...args) => { navigations.push(args); } } },
    env: { TMUX: "/tmp/tmux", TMUX_PANE: "%20", DISPLAY: ":0" },
    spawn: successfulSpawn(calls, { xprop: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x40002c3\n" }),
    captureThrottleMs: 0,
  });
  assert.equal(await activator.capture(), "0x40002c3");
  assert.equal(await activator.activate("oc-target"), true);
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
  const activator = createAttentionActivator({
    api: { route: { navigate: (...args) => { navigations.push(args); } } },
    env: { TMUX: "set", TMUX_PANE: "$(unsafe)", DISPLAY: ":0", WINDOWID: "0xdeadbeef" },
    spawn: successfulSpawn(calls, { xprop: "malformed" }),
  });
  await activator.capture();
  assert.equal(await activator.activate("oc-safe"), true);
  assert.deepEqual(navigations, [["session", { sessionID: "oc-safe" }]]);
  assert.deepEqual(calls.map((call) => call[0]), ["xprop"]);
  assert.equal(await activator.activate(""), false);
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

test("a navigation timeout does not block tmux activation", async () => {
  const calls = [];
  const activator = createAttentionActivator({
    api: { route: { navigate: () => new Promise(() => {}) } },
    env: { TMUX: "set", TMUX_PANE: "%20" },
    spawn: successfulSpawn(calls),
    navigationTimeoutMs: 5,
  });
  assert.equal(await activator.activate("oc-target"), true);
  assert.deepEqual(calls.map(([executable, args]) => [executable, args]), [
    ["tmux", ["select-window", "-t", "%20"]],
    ["tmux", ["select-pane", "-t", "%20"]],
  ]);
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
  assert.equal(await activator.activate("oc-target"), false);
  assert.equal(hanging.killed, true);
  activator.dispose();
  assert.equal(await activator.activate("oc-target"), false);
});
