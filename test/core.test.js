import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkContext } from "../src/index.js";
import { ERROR_CODES, WorkContextError } from "../src/errors.js";
import { renderTitle } from "../src/title.js";

const makeRoot = () => fs.mkdtempSync(path.join("/tmp/opencode", "work-context-test-"));
const removeRoot = (root) => fs.rmSync(root, { recursive: true, force: true });

test("create writes canonical metadata, events and projections", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test", sessionId: "session-1" });
    const result = context.createWorkspace("Test workspace", { workspace: "999997", sessionId: "session-1" });

    assert.equal(result.ok, true);
    assert.equal(result.data.ordinal, "01/01");
    assert.equal(context.storage.readWorkspace("999997").data.status, "in_progress");
    assert.match(fs.readFileSync(path.join(root, ".work-context", "INDEX.md"), "utf8"), /999997/);
    assert.equal(context.storage.readEvents().length, 1);
  } finally {
    removeRoot(root);
  }
});

test("only one active session is allowed and terminal stages cannot resume", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Invariant workspace", { workspace: "999996", sessionId: "session-1" });

    assert.throws(
      () => context.startSession("999996", "01", { sessionId: "session-2" }),
      (error) => error instanceof WorkContextError && error.code === ERROR_CODES.ACTIVE_SESSION_EXISTS,
    );

    context.handoff("999996", "01", "session-1");
    context.startSession("999996", "01", { sessionId: "session-2" });
    context.finish("999996", "01", "session-2", { knowledgeReview: "none" });
    assert.equal(context.finish("999996", "01", "session-2").data.status, "completed");

    assert.throws(
      () => context.startSession("999996", "01", { sessionId: "session-3" }),
      (error) => error instanceof WorkContextError && error.code === ERROR_CODES.INVALID_STATE,
    );
  } finally {
    removeRoot(root);
  }
});

test("knowledge is a canonical workspace ledger with structured operations", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Knowledge workspace", { workspace: "999995", sessionId: "session-1" });
    const added = context.addKnowledge("999995", { title: "A decision", kind: "decision", text: "Keep the ledger in Markdown.", sources: ["ADR-0021"] });
    assert.equal(added.data.id, "KC-0001");
    assert.equal(context.listKnowledge("999995").data[0].status, "active");
    context.updateKnowledge("999995", "KC-0001", { text: "Keep the canonical ledger in Markdown." });
    context.addKnowledge("999995", { title: "Replacement decision", kind: "decision", text: "Keep the canonical ledger in Markdown.", sources: ["ADR-0021"] });
    context.supersedeKnowledge("999995", "KC-0001", "KC-0002");
    assert.equal(context.listKnowledge("999995").data[0].status, "superseded");
    assert.match(fs.readFileSync(path.join(root, ".work-context", "999995", "KNOWLEDGE.md"), "utf8"), /KC-0001/);
  } finally {
    removeRoot(root);
  }
});

test("session IDs are unique across workspaces", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("First", { workspace: "999994", sessionId: "session-1" });
    assert.throws(() => context.createWorkspace("Second", { workspace: "999993", sessionId: "session-1" }), (error) => error.code === ERROR_CODES.CONFLICT);
    assert.equal(context.listWorkspaces().data.length, 1);
  } finally {
    removeRoot(root);
  }
});

test("knowledge rejects nonexistent workspaces and non-canonical ledgers", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    assert.throws(() => context.addKnowledge("999992", { title: "Invalid", text: "No workspace" }), (error) => error.code === ERROR_CODES.NOT_FOUND);
    context.createWorkspace("Ledger", { workspace: "999991", sessionId: "session-1" });
    fs.writeFileSync(path.join(root, ".work-context", "999991", "KNOWLEDGE.md"), "# Durable Knowledge\n\n## KC-0001: Broken\n\n- Kind: fact\n- Status: active\n- Created: yesterday\n- Updated: yesterday\n- Sources: not-json\n\nBody\n");
    assert.throws(() => context.listKnowledge("999991"), (error) => error.code === ERROR_CODES.STORAGE_ERROR);
  } finally {
    removeRoot(root);
  }
});

test("read-only adapter discovery does not create storage", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.openExisting(root, { actor: "test" });
    assert.deepEqual(context.listWorkspaces().data, []);
    assert.equal(fs.existsSync(path.join(root, ".work-context")), false);
  } finally {
    removeRoot(root);
  }
});

test("title renderer applies tracker prefix and inactive suffix", () => {
  assert.equal(
    renderTitle({
      workspace: "000005",
      stage: "02",
      ordinal: 3,
      summary: "handoff",
      state: "closed",
      trackerLinks: [{ project: "group/project", iid: 42 }],
    }),
    "GL#42 | 000005 02/03 (closed): handoff",
  );
});
