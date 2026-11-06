import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopNotificationsEnabled } from "../plugin/attention.js";
import { createDesktopNotifier, buildNotification, notifySendArguments, sanitizeNotificationText } from "../plugin/notifier.js";
import { defaultConfig, loadConfig } from "../src/storage.js";

const context = {
  workspaceId: "000012",
  workspaceTitle: "Desktop notifications",
  stageId: "04",
  stageTitle: "Deliver safely",
  reason: "question",
};

const child = () => {
  const process = new EventEmitter();
  process.kill = () => { process.killed = true; };
  return process;
};

test("notification content is constructed only from bounded controlled fields", () => {
  const notification = buildNotification({
    ...context,
    workspaceTitle: `<Workspace & team>\n${"x".repeat(200)}`,
    stageTitle: `Stage\u0000${"y".repeat(300)}`,
  });
  assert.equal(notification.title.length <= 120, true);
  assert.equal(notification.body.length <= 240, true);
  assert.doesNotMatch(`${notification.title}${notification.body}`, /[\u0000-\u001f]/);
  assert.match(notification.title, /&lt;Workspace &amp; team&gt;/);
  assert.equal(buildNotification({ ...context, reason: "raw provider error" }), null);
  assert.equal(buildNotification({ ...context, workspaceId: "../../tmp" }), null);
  assert.equal(sanitizeNotificationText(" a\n b ", 20), "a b");
});

test("notify-send uses a fixed executable and argument array without a shell", async () => {
  const calls = [];
  const process = child();
  const notifier = createDesktopNotifier({ spawn: (...args) => { calls.push(args); queueMicrotask(() => process.emit("exit", 0)); return process; } });
  assert.equal(await notifier.notify(context), true);
  assert.equal(calls[0][0], "notify-send");
  assert.deepEqual(calls[0][1], notifySendArguments(buildNotification(context)));
  assert.equal(calls[0][2].shell, false);
});

test("notification action invokes only the approved open callback", async () => {
  const calls = [];
  const process = child();
  process.stdout = new EventEmitter();
  let opened = 0;
  const notifier = createDesktopNotifier({
    spawn: (...args) => {
      calls.push(args);
      queueMicrotask(() => {
        process.stdout.emit("data", "default\n");
        process.emit("exit", 0);
      });
      return process;
    },
  });
  assert.equal(await notifier.notify(context, { onOpen: () => { opened += 1; } }), true);
  assert.equal(opened, 1);
  assert.deepEqual(calls[0][1], notifySendArguments(buildNotification(context), true, 5 * 60 * 1000));
  assert.match(calls[0][1].join(" "), /--action=default=Open session/);
  assert.deepEqual(calls[0][2].stdio, ["ignore", "pipe", "ignore"]);
});

test("unknown notification actions do not invoke the open callback", async () => {
  const process = child();
  process.stdout = new EventEmitter();
  let opened = 0;
  const notifier = createDesktopNotifier({ spawn: () => {
    queueMicrotask(() => {
      process.stdout.emit("data", "unexpected\n");
      process.emit("exit", 0);
    });
    return process;
  } });
  assert.equal(await notifier.notify(context, { onOpen: () => { opened += 1; } }), true);
  assert.equal(opened, 0);
});

test("an unsupported action retries once as a plain notification", async () => {
  const calls = [];
  const notifier = createDesktopNotifier({ spawn: (...args) => {
    calls.push(args);
    const process = child();
    if (calls.length === 1) process.stdout = new EventEmitter();
    queueMicrotask(() => process.emit("exit", calls.length === 1 ? 1 : 0));
    return process;
  } });
  assert.equal(await notifier.notify(context, { onOpen: () => {} }), true);
  assert.equal(calls.length, 2);
  assert.match(calls[0][1].join(" "), /--action=/);
  assert.doesNotMatch(calls[1][1].join(" "), /--action=/);
  assert.equal(calls[1][2].stdio, "ignore");
});

test("disposing the notifier terminates pending actionable notifications", async () => {
  const process = child();
  process.stdout = new EventEmitter();
  const notifier = createDesktopNotifier({ spawn: () => process });
  const pending = notifier.notify(context, { onOpen: () => {} });
  notifier.dispose();
  assert.equal(process.killed, true);
  assert.equal(await pending, false);
  assert.equal(await notifier.notify(context), false);
});

test("unsupported platforms and disabled notifications do not spawn", async () => {
  let spawns = 0;
  const spawn = () => { spawns += 1; return child(); };
  assert.equal(await createDesktopNotifier({ platform: "darwin", spawn }).notify(context), false);
  assert.equal(await createDesktopNotifier({ enabled: false, spawn }).notify(context), false);
  assert.equal(spawns, 0);
});

test("missing executable, nonzero exit, spawn failure, and timeout degrade silently", async () => {
  const missing = child();
  const failed = child();
  const hanging = child();
  hanging.stdout = new EventEmitter();
  const missingResult = createDesktopNotifier({ spawn: () => { queueMicrotask(() => missing.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))); return missing; } }).notify(context);
  const failedResult = createDesktopNotifier({ spawn: () => { queueMicrotask(() => failed.emit("exit", 1)); return failed; } }).notify(context);
  assert.equal(await missingResult, false);
  assert.equal(await failedResult, false);
  assert.equal(await createDesktopNotifier({ spawn: () => { throw new Error("spawn failed"); } }).notify(context), false);
  assert.equal(await createDesktopNotifier({ spawn: () => hanging, timeoutMs: 5 }).notify(context), false);
  assert.equal(hanging.killed, true);
  const actionHanging = child();
  actionHanging.stdout = new EventEmitter();
  assert.equal(await createDesktopNotifier({ spawn: () => actionHanging, actionTimeoutMs: 5 }).notify(context, { onOpen: () => {} }), false);
  assert.equal(actionHanging.killed, true);
});

test("desktop notifications default on and accept only a boolean opt-out", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notifier-config-"));
  try {
    assert.equal(desktopNotificationsEnabled(root), true);
    fs.mkdirSync(path.join(root, ".work-context"), { recursive: true });
    fs.writeFileSync(path.join(root, ".work-context", "config.yaml"), defaultConfig());
    assert.equal(loadConfig(root).notifications.desktop, true);
    assert.equal(desktopNotificationsEnabled(root), true);
    fs.writeFileSync(path.join(root, ".work-context", "config.yaml"), defaultConfig().replace("desktop: true", "desktop: false"));
    assert.equal(loadConfig(root).notifications.desktop, false);
    assert.equal(desktopNotificationsEnabled(root), false);
    fs.writeFileSync(path.join(root, ".work-context", "config.yaml"), defaultConfig().replace("desktop: true", "desktop: notify-send --unsafe"));
    assert.throws(() => loadConfig(root), /Invalid work-context config/);
    assert.equal(desktopNotificationsEnabled(root), false);
    fs.writeFileSync(path.join(root, ".work-context", "config.yaml"), defaultConfig().replace("notifications:\n  desktop: true", "notifications: false"));
    assert.throws(() => loadConfig(root), /Invalid work-context config/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
