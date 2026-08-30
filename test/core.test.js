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

test("multiple workspaces can share an OpenCode session ID", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("First workspace", { workspace: "999992", sessionId: "internal-1", opencodeSessionId: "oc-shared" });
    context.createWorkspace("Second workspace", { workspace: "999993", sessionId: "internal-2", opencodeSessionId: "oc-shared" });

    assert.equal(context.sessionByOpenCodeId("oc-shared", "999993", "01").session_id, "internal-2");
    assert.equal(context.sessionByOpenCodeId("oc-shared").workspace, "999993");
  } finally {
    removeRoot(root);
  }
});

test("workspace list includes stage descriptions", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Described workspace", { workspace: "999990", sessionId: "session-1" });

    const stage = context.listStages("999990").data.stages[0];
    assert.equal(stage.title, "Планирование");
    assert.equal(stage.description, stage.goal);
    assert.equal(stage.description, "Уточнить цель и ограничения работы");
  } finally {
    removeRoot(root);
  }
});

test("workspace finish requires all stages to be completed", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Incomplete workspace", { workspace: "999989", sessionId: "session-1" });

    assert.throws(
      () => context.finishWorkspace("999989"),
      (error) => error instanceof WorkContextError
        && error.code === ERROR_CODES.INVALID_STATE
        && error.details.incompleteStages[0].stage === "01",
    );
    assert.equal(context.storage.readWorkspace("999989").data.status, "in_progress");
  } finally {
    removeRoot(root);
  }
});

test("workspace rename updates the canonical title and index", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Old workspace", { workspace: "999983", sessionId: "session-1" });

    const result = context.renameWorkspace("999983", "English workspace");
    assert.deepEqual(result.data, { workspace: "999983", title: "English workspace" });
    assert.equal(context.storage.readWorkspace("999983").data.title, "English workspace");
    assert.match(fs.readFileSync(path.join(root, ".work-context", "INDEX.md"), "utf8"), /\| 999983 \| English workspace \|/);
  } finally { removeRoot(root); }
});

test("workspace finish marks a workspace completed after all stages", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Complete workspace", { workspace: "999988", sessionId: "session-1" });
    context.finish("999988", "01", "session-1", { knowledgeReview: "none" });
    context.addStage("999988", "Implementation", { goal: "Implement the change" });
    context.startSession("999988", "02", { sessionId: "session-2" });
    context.finish("999988", "02", "session-2", { knowledgeReview: "none" });

    const result = context.finishWorkspace("999988");
    assert.equal(result.data.status, "completed");
    assert.equal(context.storage.readWorkspace("999988").data.status, "completed");
    assert.match(fs.readFileSync(path.join(root, ".work-context", "INDEX.md"), "utf8"), /\| 999988 \| Complete workspace \| completed \|/);
  } finally {
    removeRoot(root);
  }
});

test("stage finish automatically reviews the knowledge ledger by default", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Automatic review workspace", { workspace: "999987", sessionId: "session-1" });

    const result = context.finish("999987", "01", "session-1");
    assert.equal(result.data.knowledge_review, "auto");
    assert.equal(result.data.knowledge_entries, 0);
    assert.deepEqual(result.next, {
      action: "workspace_finish",
      workspace: "999987",
      command: "/wc workspace finish 999987",
      reason: "All workspace stages are completed",
    });
    assert.equal(context.storage.readStage("999987", "01").data.status, "completed");
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

test("a new OpenCode session takes over an active stage session", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Takeover workspace", { workspace: "999995", sessionId: "internal-1", opencodeSessionId: "oc-old" });

    const result = context.startSession("999995", "01", { sessionId: "internal-2", opencodeSessionId: "oc-new", takeover: true });

    assert.equal(result.data.session_id, "internal-2");
    assert.equal(context.sessionById("internal-1").state, "handed_off");
    assert.equal(context.sessionById("internal-2").state, "active");
  } finally {
    removeRoot(root);
  }
});

test("abandoning a stage session preserves the stage as resumable", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Abandon workspace", { workspace: "999984", sessionId: "session-1" });

    const result = context.abandon("999984", "01", "session-1");
    assert.deepEqual(result.data, { session_id: "session-1", state: "abandoned" });
    assert.equal(context.sessionById("session-1").state, "abandoned");
    assert.equal(context.startSession("999984", "01", { sessionId: "session-2" }).data.ordinal, "01/02");
  } finally { removeRoot(root); }
});

test("help exposes stage lifecycle commands without internal session or duplicate commands", () => {
  const root = makeRoot();
  try {
    const syntax = WorkContext.open(root).help().data.syntax;
    assert.match(syntax, /stage handoff/);
    assert.match(syntax, /stage abandon/);
    assert.match(syntax, /workspace rename/);
    assert.match(syntax, /stage update/);
    assert.doesNotMatch(syntax, /session close|handoff\|knowledge/);
  } finally { removeRoot(root); }
});

test("archiving preserves the stage ID, hides it from the TUI snapshot and ignores it when finishing a workspace", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Archive workspace", { workspace: "999979", sessionId: "session-1" });
    context.handoff("999979", "01", "session-1");
    context.addStage("999979", "Keep this stage");
    context.addStage("999979", "Archive this stage");

    const result = context.archiveStage("999979", "03");
    assert.deepEqual(result.data, { workspace: "999979", stage: "03", status: "archived" });
    assert.equal(context.storage.readStage("999979", "03").data.status, "archived");
    assert.deepEqual(context.listStages("999979").data.stages.map((stage) => stage.stage), ["01", "02", "03"]);
    assert.throws(() => context.startSession("999979", "03", { sessionId: "session-3" }), (error) => error.code === ERROR_CODES.INVALID_STATE);
  } finally { removeRoot(root); }
});

test("an active stage cannot be archived", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Active archive workspace", { workspace: "999978", sessionId: "session-1" });
    assert.throws(() => context.archiveStage("999978", "01"), (error) => error.code === ERROR_CODES.ACTIVE_SESSION_EXISTS);
  } finally { removeRoot(root); }
});

test("renaming a stage preserves its ID and goal", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Rename workspace", { workspace: "999976", sessionId: "session-1" });
    const result = context.renameStage("999976", "01", "Renamed stage");
    assert.deepEqual(result.data, { workspace: "999976", stage: "01", title: "Renamed stage" });
    const stage = context.storage.readStage("999976", "01").data;
    assert.equal(stage.stage, "01");
    assert.equal(stage.title, "Renamed stage");
    assert.equal(stage.goal, "Уточнить цель и ограничения работы");
  } finally { removeRoot(root); }
});

test("stage description can be updated without changing its ID or title", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Stage update workspace", { workspace: "999975", sessionId: "session-1" });

    const result = context.updateStage("999975", "01", "Clarify the project goal and constraints");
    assert.deepEqual(result.data, { workspace: "999975", stage: "01", description: "Clarify the project goal and constraints" });
    const stage = context.listStages("999975").data.stages[0];
    assert.equal(stage.stage, "01");
    assert.equal(stage.title, "Планирование");
    assert.equal(stage.goal, "Clarify the project goal and constraints");
    assert.equal(stage.description, "Clarify the project goal and constraints");
  } finally { removeRoot(root); }
});

test("stage updates preserve the result section", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Result workspace", { workspace: "999974", sessionId: "session-1" });
    context.finish("999974", "01", "session-1", { result: "The stage result", knowledgeReview: "none" });

    context.renameStage("999974", "01", "Renamed planning");
    context.updateStage("999974", "01", "Clarify the project goal");
    assert.match(context.storage.readStage("999974", "01").body, /## Result\n\nThe stage result/);
  } finally { removeRoot(root); }
});

test("session ordinal is scoped to the stage", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Ordinal workspace", { workspace: "999980", sessionId: "session-1" });
    context.handoff("999980", "01", "session-1");
    context.addStage("999980", "Second stage");
    const result = context.startSession("999980", "02", { sessionId: "session-2" });
    assert.equal(result.data.ordinal, "02/01");
  } finally { removeRoot(root); }
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
      workspaceTitle: "Workspace title",
      stage: "02",
      ordinal: 3,
      state: "closed",
      trackerLinks: [{ project: "group/project", iid: 42 }],
    }),
    "GL#42 | 000005 02/03 (closed)\nWorkspace title",
  );
});

test("tracker links support GitLab, GitHub and Jira issue URLs", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Tracker workspace", { workspace: "999975", sessionId: "session-1" });
    context.linkIssue("999975", "https://github.com/acme/project/issues/42");
    context.linkIssue("999975", "https://jira.example.com/browse/PROJ-123", "01");

    assert.deepEqual(context.storage.readWorkspace("999975").data.tracker_links[0], {
      url: "https://github.com/acme/project/issues/42",
      provider: "github",
      project: "acme/project",
      iid: 42,
    });
    assert.deepEqual(context.storage.readStage("999975", "01").data.tracker_links[0], {
      url: "https://jira.example.com/browse/PROJ-123",
      provider: "jira",
      project: "PROJ",
      key: "PROJ-123",
    });
    assert.throws(() => context.linkIssue("999975", "https://jira.example.com/browse/PROJ-abc"), (error) => error.code === ERROR_CODES.INVALID_ISSUE_URL);
  } finally { removeRoot(root); }
});
