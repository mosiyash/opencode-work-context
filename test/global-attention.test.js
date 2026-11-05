import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGlobalAttentionChannel, defaultGlobalAttentionRoot } from "../plugin/global-attention.js";

const INSTANCE_A = "00000000-0000-4000-8000-000000000001";
const INSTANCE_B = "00000000-0000-4000-8000-000000000002";
const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "global-attention-test-"));
const removeRoot = (root) => fs.rmSync(root, { recursive: true, force: true });
const options = (root, instanceId, clock) => ({
  root: path.join(root, "channel"),
  instanceId,
  now: () => clock.value,
  pollMs: 0,
  heartbeatMs: 0,
  activityThrottleMs: 0,
});

test("default runtime root requires a private absolute XDG directory", () => {
  const root = makeRoot();
  try {
    fs.chmodSync(root, 0o700);
    assert.equal(defaultGlobalAttentionRoot({ env: { XDG_RUNTIME_DIR: root }, uid: process.getuid?.() }), path.join(root, "opencode-work-context", "attention-v1"));
    fs.chmodSync(root, 0o755);
    assert.equal(defaultGlobalAttentionRoot({ env: { XDG_RUNTIME_DIR: root }, uid: process.getuid?.() }), null);
    assert.equal(defaultGlobalAttentionRoot({ env: { XDG_RUNTIME_DIR: "relative" }, uid: process.getuid?.() }), null);
  } finally { removeRoot(root); }
});

test("the newest live instance owns delivery and stale leases are removed", () => {
  const root = makeRoot();
  const clock = { value: 1000 };
  const first = createGlobalAttentionChannel({ ...options(root, INSTANCE_A, clock), leaseStaleMs: 100 });
  const second = createGlobalAttentionChannel({ ...options(root, INSTANCE_B, clock), leaseStaleMs: 100 });
  try {
    first.start(() => true);
    assert.equal(first.hasActiveInstance(), false);
    assert.equal(first.isActive(), false);
    first.activity();
    assert.equal(first.isActive(), true);
    clock.value = 1050;
    second.start(() => true);
    assert.equal(first.isActive(), true);
    assert.equal(second.isActive(), false);
    second.activity();
    assert.equal(first.isActive(), false);
    assert.equal(second.isActive(), true);
    clock.value = 1200;
    second.activity();
    assert.equal(second.isActive(), true);
    assert.equal(fs.existsSync(path.join(root, "channel", "leases", `${INSTANCE_A}.json`)), false);
  } finally { first.dispose(); second.dispose(); removeRoot(root); }
});

test("a blurred instance relinquishes ownership until new activity", () => {
  const root = makeRoot();
  const clock = { value: 1000 };
  const channel = createGlobalAttentionChannel(options(root, INSTANCE_A, clock));
  try {
    channel.start(() => true);
    channel.activity();
    assert.equal(channel.isActive(), true);
    channel.deactivate();
    assert.equal(channel.hasActiveInstance(), false);
    assert.equal(channel.isActive(), false);
    clock.value += 1;
    channel.activity();
    assert.equal(channel.isActive(), true);
  } finally { channel.dispose(); removeRoot(root); }
});

test("the active instance consumes bounded sanitized events once per dedupe key", () => {
  const root = makeRoot();
  const clock = { value: 1000 };
  const delivered = [];
  const publisher = createGlobalAttentionChannel(options(root, INSTANCE_A, clock));
  const consumer = createGlobalAttentionChannel(options(root, INSTANCE_B, clock));
  try {
    publisher.start(() => true);
    publisher.activity();
    clock.value = 1100;
    consumer.start((event) => { delivered.push(event); return true; });
    consumer.activity();
    const event = {
      dedupeKey: "same-event",
      reason: "question",
      projectTitle: "project\nname",
      workspaceTitle: "w".repeat(100),
      stageTitle: "stage",
    };
    assert.equal(publisher.publish(event), true);
    assert.equal(publisher.publish(event), true);
    assert.equal(consumer.scan(), 1);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].projectTitle, "project name");
    assert.equal(delivered[0].workspaceTitle.length, 80);
    assert.equal(fs.readdirSync(path.join(root, "channel", "events")).length, 0);
  } finally { publisher.dispose(); consumer.dispose(); removeRoot(root); }
});

test("the active instance delivers attention published by its own background session", () => {
  const root = makeRoot();
  const clock = { value: 1000 };
  const delivered = [];
  const channel = createGlobalAttentionChannel(options(root, INSTANCE_A, clock));
  try {
    channel.start((event) => { delivered.push(event); return true; });
    channel.activity();
    assert.equal(channel.publish({ dedupeKey: "local-background", reason: "permission", projectTitle: "p", workspaceTitle: "w", stageTitle: "s" }), true);
    assert.equal(channel.scan(), 1);
    assert.equal(delivered[0].reason, "permission");
  } finally { channel.dispose(); removeRoot(root); }
});

test("an atomic claim prevents duplicate delivery during an ownership transition", () => {
  const root = makeRoot();
  const clock = { value: 1000 };
  const delivered = [];
  let second;
  const first = createGlobalAttentionChannel(options(root, INSTANCE_A, clock));
  second = createGlobalAttentionChannel(options(root, INSTANCE_B, clock));
  try {
    first.start((event) => {
      delivered.push(`first:${event.reason}`);
      clock.value += 1;
      second.activity();
      second.scan();
      return true;
    });
    second.start((event) => { delivered.push(`second:${event.reason}`); return true; });
    first.activity();
    first.publish({ dedupeKey: "ownership-race", reason: "question", projectTitle: "p", workspaceTitle: "w", stageTitle: "s" });
    assert.equal(first.scan(), 1);
    assert.deepEqual(delivered, ["first:question"]);
  } finally { first.dispose(); second.dispose(); removeRoot(root); }
});

test("retention evicts the oldest event and delivers the newest bounded set", () => {
  const root = makeRoot();
  const clock = { value: 1000 };
  const delivered = [];
  const publisher = createGlobalAttentionChannel(options(root, INSTANCE_A, clock));
  const consumer = createGlobalAttentionChannel(options(root, INSTANCE_B, clock));
  try {
    publisher.start(() => true);
    consumer.start((event) => { delivered.push(event.projectTitle); return true; });
    consumer.activity();
    for (let index = 0; index < 101; index += 1) {
      clock.value += 1;
      publisher.publish({ dedupeKey: `event-${index}`, reason: "idle", projectTitle: String(index), workspaceTitle: "w", stageTitle: "s" });
    }
    assert.equal(consumer.scan(), 100);
    assert.equal(delivered.includes("0"), false);
    assert.equal(delivered.includes("100"), true);
  } finally { publisher.dispose(); consumer.dispose(); removeRoot(root); }
});

test("expired, malformed, oversized, and symbolic-link event files are never delivered", () => {
  const root = makeRoot();
  const clock = { value: 1000 };
  const delivered = [];
  const publisher = createGlobalAttentionChannel({ ...options(root, INSTANCE_A, clock), eventTtlMs: 10 });
  const consumer = createGlobalAttentionChannel(options(root, INSTANCE_B, clock));
  try {
    publisher.start(() => true);
    publisher.activity();
    clock.value = 1001;
    consumer.start((event) => { delivered.push(event); return true; });
    consumer.activity();
    publisher.publish({ dedupeKey: "expired", reason: "idle", projectTitle: "p", workspaceTitle: "w", stageTitle: "s" });
    const events = path.join(root, "channel", "events");
    fs.writeFileSync(path.join(events, "event-00000000-0000-4000-8000-000000000010.json"), "not json");
    fs.writeFileSync(path.join(events, "event-00000000-0000-4000-8000-000000000011.json"), "x".repeat(9000));
    fs.symlinkSync(path.join(events, "missing"), path.join(events, "event-00000000-0000-4000-8000-000000000012.json"));
    fs.writeFileSync(path.join(events, "event-00000000-0000-4000-8000-000000000013.json"), JSON.stringify({
      schema: 1,
      id: "00000000-0000-4000-8000-000000000013",
      sourceInstanceId: INSTANCE_A,
      dedupeKey: "000000000000000000000000",
      createdAt: 1001,
      expiresAt: 2000,
      reason: "idle",
      projectTitle: "unsafe\nproject",
      workspaceTitle: "workspace",
      stageTitle: "stage",
    }));
    clock.value = 1020;
    assert.equal(consumer.scan(), 0);
    assert.deepEqual(delivered, []);
    assert.equal(fs.readdirSync(events).length, 0);
  } finally { publisher.dispose(); consumer.dispose(); removeRoot(root); }
});

test("a backward clock adjustment does not discard a queued event", () => {
  const root = makeRoot();
  const clock = { value: 1_000_000 };
  const delivered = [];
  const publisher = createGlobalAttentionChannel(options(root, INSTANCE_A, clock));
  const consumer = createGlobalAttentionChannel({ ...options(root, INSTANCE_B, clock), leaseStaleMs: 1_000_000 });
  try {
    publisher.start(() => true);
    consumer.start((event) => { delivered.push(event); return true; });
    consumer.activity();
    publisher.publish({ dedupeKey: "clock-rollback", reason: "idle", projectTitle: "p", workspaceTitle: "w", stageTitle: "s" });
    clock.value = 1000;
    consumer.activity();
    assert.equal(consumer.scan(), 1);
    assert.equal(delivered.length, 1);
  } finally { publisher.dispose(); consumer.dispose(); removeRoot(root); }
});

test("an unavailable channel fails closed", () => {
  const root = makeRoot();
  try {
    const file = path.join(root, "not-a-directory");
    fs.writeFileSync(file, "x");
    const channel = createGlobalAttentionChannel({ root: file, instanceId: INSTANCE_A });
    assert.equal(channel.available, false);
    assert.equal(channel.start(() => true), false);
    assert.equal(channel.publish({ reason: "idle" }), false);
  } finally { removeRoot(root); }
});
