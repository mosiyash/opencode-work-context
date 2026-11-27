import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ERROR_CODES, WorkContext } from "../src/index.js";

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "work-context-execution-test-"));
const removeRoot = (root) => fs.rmSync(root, { recursive: true, force: true });
const state = (overrides = {}) => ({
  scope: [],
  completed: [],
  remaining: [],
  decisions: [],
  blockers: [],
  verification: [],
  ...overrides,
});

test("stage execution state round-trips through replacement and atomic updates", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test", sessionId: "planning" });
    context.createWorkspace("Execution workspace", { workspace: "999940", sessionId: "planning" });

    const created = context.replaceStageExecution("999940", "01", "planning", 0, state({
      scope: ["  Implement durable execution state  ", "Implement durable execution state"],
      remaining: ["Implement storage", "Add tests"],
      decisions: ["Use canonical JSON"],
      blockers: ["Confirm command names"],
      verification: ["Run the full test suite"],
    }));
    assert.equal(created.data.revision, 1);
    assert.deepEqual(created.data.scope, ["Implement durable execution state"]);

    const updated = context.updateStageExecution("999940", "01", "planning", 1, {
      add: { completed: ["Implement storage"], scope: ["Document the format"] },
      remove: { remaining: ["Implement storage"], blockers: ["Confirm command names"] },
    });
    assert.equal(updated.data.revision, 2);
    assert.deepEqual(updated.data.completed, ["Implement storage"]);
    assert.deepEqual(updated.data.remaining, ["Add tests"]);
    assert.deepEqual(updated.data.scope, ["Implement durable execution state", "Document the format"]);
    assert.deepEqual(updated.data.blockers, []);
    assert.deepEqual(context.readStageExecution("999940", "01").data, updated.data);
    assert.equal(context.replaceStageExecution("999940", "01", "planning", 2, state({
      scope: updated.data.scope,
      completed: updated.data.completed,
      remaining: updated.data.remaining,
      decisions: updated.data.decisions,
      blockers: updated.data.blockers,
      verification: updated.data.verification,
    })).changed.length, 0);
  } finally { removeRoot(root); }
});

test("execution state survives handoff and restart without changing prompt, knowledge, or session history", () => {
  const root = makeRoot();
  try {
    let context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Resume execution", { workspace: "999941", sessionId: "planning" });
    const originalPrompt = context.storage.readStage("999941", "01").data.prompt;
    context.addKnowledge("999941", { title: "Shared fact", text: "This belongs to every stage." });
    context.replaceStageExecution("999941", "01", "planning", 0, state({ remaining: ["Continue implementation", "Run verification"] }));
    context.renameSession("999941", "01", "planning", "Storage is implemented; tests remain.");
    context.handoff("999941", "01", "planning");

    context = WorkContext.open(root, { actor: "test-after-restart" });
    const resumed = context.startSession("999941", "01", { sessionId: "resumed" });
    assert.equal(resumed.data.resume.context.execution_state.revision, 1);
    assert.deepEqual(resumed.data.resume.context.execution_state.remaining, ["Continue implementation", "Run verification"]);
    assert.equal(resumed.data.resume.context.execution_state.current.text, "Continue implementation");
    assert.deepEqual(resumed.data.resume.presentation.execution_state.queued.map((item) => item.text), ["Run verification"]);
    assert.equal(resumed.data.resume.context.workspace_knowledge.length, 1);
    assert.equal(resumed.data.resume.context.previous, "Storage is implemented; tests remain.");
    assert.match(resumed.data.resume.instruction, /Current stage execution state/);
    assert.match(resumed.data.resume.instruction, /Current checklist item: Continue implementation/);
    assert.match(resumed.data.resume.instruction, /Queued checklist items: Run verification/);
    assert.match(resumed.data.resume.instruction, /Work only on the Current checklist item by default/);
    assert.match(resumed.data.resume.instruction, /Do not combine Queued items into the same change set unless the user explicitly asks/);
    assert.equal(context.storage.readStage("999941", "01").data.prompt, originalPrompt);

    context.handoff("999941", "01", "resumed");
    context.addStage("999941", "Unrelated stage", { prompt: "Do unrelated work." });
    const unrelated = context.startSession("999941", "02", { sessionId: "unrelated" });
    assert.equal(unrelated.data.resume.context.execution_state, undefined);
    assert.equal(unrelated.data.resume.presentation.execution_state, undefined);
  } finally { removeRoot(root); }
});

test("legacy stages remain unchanged when no execution state exists", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Legacy workspace", { workspace: "999942", sessionId: "planning" });
    const read = context.readStageExecution("999942", "01").data;
    assert.equal(read.exists, false);
    assert.equal(read.revision, 0);
    assert.equal(fs.existsSync(context.storage.stageExecutionFile("999942", "01")), false);
    context.handoff("999942", "01", "planning");
    const resumed = context.startSession("999942", "01", { sessionId: "resumed" });
    assert.equal(resumed.data.resume.context.execution_state, undefined);
    assert.doesNotMatch(resumed.data.resume.instruction, /Current stage execution state/);
    assert.equal(fs.existsSync(context.storage.stageExecutionFile("999942", "01")), false);
  } finally { removeRoot(root); }
});

test("stale execution updates fail without losing newer state", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Revision workspace", { workspace: "999943", sessionId: "planning" });
    context.replaceStageExecution("999943", "01", "planning", 0, state({ remaining: ["First"] }));
    context.updateStageExecution("999943", "01", "planning", 1, { add: { remaining: ["Second"] } });

    assert.throws(
      () => context.updateStageExecution("999943", "01", "planning", 1, { add: { remaining: ["Stale"] } }),
      (error) => error.code === ERROR_CODES.EXECUTION_REVISION_CONFLICT
        && error.details.expectedRevision === 1
        && error.details.actualRevision === 2,
    );
    assert.deepEqual(context.readStageExecution("999943", "01").data.remaining, ["First", "Second"]);
    assert.throws(
      () => context.replaceStageExecution("999943", "01", "other-session", 2, state()),
      (error) => error.code === ERROR_CODES.SESSION_NOT_ACTIVE,
    );
  } finally { removeRoot(root); }
});

test("legacy execution records expose deterministic Current and Queued item identities without migration", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test", sessionId: "planning" });
    context.createWorkspace("Legacy execution", { workspace: "999946", sessionId: "planning" });
    const timestamp = new Date().toISOString();
    const file = context.storage.stageExecutionFile("999946", "01");
    fs.writeFileSync(file, `${JSON.stringify({
      schema: 1, workspace: "999946", stage: "01", revision: 1, created_at: timestamp, updated_at: timestamp, updated_by: "test",
      ...state({ remaining: ["First", "Second"] }),
    })}\n`);

    const first = context.readStageExecution("999946", "01").data;
    const second = context.readStageExecution("999946", "01").data;
    assert.equal(first.schema, 1);
    assert.deepEqual(first.remaining, ["First", "Second"]);
    assert.deepEqual(first.current, { id: first.current.id, text: "First" });
    assert.match(first.current.id, /^legacy-/);
    assert.deepEqual(first.queued, [{ id: first.queued[0].id, text: "Second" }]);
    assert.deepEqual(second.current, first.current);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schema, 1);
    const advanced = context.completeCurrentExecution("999946", "01", "planning", 1);
    assert.equal(advanced.data.schema, 2);
    assert.equal(advanced.data.items.completed[0].id, first.current.id);
    assert.equal(advanced.data.current.id, first.queued[0].id);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schema, 2);
  } finally { removeRoot(root); }
});

test("complete Current is atomic, revision-safe, and promotes queued work in order", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test", sessionId: "planning" });
    context.createWorkspace("Current execution", { workspace: "999947", sessionId: "planning" });
    const created = context.replaceStageExecution("999947", "01", "planning", 0, state({ remaining: ["Same text", "Next", "Final"] }));
    assert.equal(created.data.schema, 2);
    assert.equal(created.data.current.text, "Same text");
    assert.equal(created.data.current.id, created.data.items.remaining[0].id);
    assert.throws(
      () => context.completeCurrentExecution("999947", "01", "other-session", 1),
      (error) => error.code === ERROR_CODES.SESSION_NOT_ACTIVE,
    );

    const advanced = context.completeCurrentExecution("999947", "01", "planning", 1);
    assert.equal(advanced.data.revision, 2);
    assert.deepEqual(advanced.data.completed, ["Same text"]);
    assert.equal(advanced.data.items.completed[0].id, created.data.current.id);
    assert.equal(advanced.data.current.text, "Next");
    assert.deepEqual(advanced.data.queued.map((item) => item.text), ["Final"]);
    assert.equal(advanced.data.current.id, created.data.items.remaining[1].id);
    assert.throws(
      () => context.completeCurrentExecution("999947", "01", "planning", 1),
      (error) => error.code === ERROR_CODES.EXECUTION_REVISION_CONFLICT,
    );
    context.completeCurrentExecution("999947", "01", "planning", 2);
    const final = context.completeCurrentExecution("999947", "01", "planning", 3);
    assert.equal(final.data.current, null);
    assert.deepEqual(final.data.queued, []);
    assert.throws(
      () => context.completeCurrentExecution("999947", "01", "planning", 4),
      (error) => error.code === ERROR_CODES.INVALID_STATE,
    );
  } finally { removeRoot(root); }
});

test("structured execution items distinguish duplicate text and preserve identity when reworded", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test", sessionId: "planning" });
    context.createWorkspace("Structured execution", { workspace: "999948", sessionId: "planning" });
    const created = context.replaceStageExecution("999948", "01", "planning", 0, state({
      remaining: [{ text: "Repeated" }, { text: "Repeated" }, { text: "Later" }],
    }));
    const [first, second] = created.data.items.remaining;
    assert.notEqual(first.id, second.id);
    assert.deepEqual(created.data.remaining, ["Repeated", "Repeated", "Later"]);
    const unrelated = context.updateStageExecution("999948", "01", "planning", 1, { add: { decisions: ["Keep duplicate identity"] } });
    assert.equal(unrelated.data.revision, 2);
    assert.deepEqual(unrelated.data.items.remaining, created.data.items.remaining);
    assert.throws(
      () => context.updateStageExecution("999948", "01", "planning", 2, { remove: { remaining: ["Repeated"] } }),
      (error) => error.code === ERROR_CODES.INVALID_ARGUMENT,
    );

    const edited = context.updateStageExecution("999948", "01", "planning", 2, {
      edit: { remaining: [{ id: first.id, text: "Reworded" }] },
    });
    assert.deepEqual(edited.data.remaining, ["Reworded", "Repeated", "Later"]);
    assert.equal(edited.data.current.id, first.id);
    assert.equal(edited.data.queued[0].id, second.id);

    const completed = context.completeCurrentExecution("999948", "01", "planning", 3);
    assert.equal(completed.data.items.completed[0].id, first.id);
    assert.equal(completed.data.current.id, second.id);
  } finally { removeRoot(root); }
});

test("schema 1 mutation fails atomically when stable identity metadata exceeds the byte limit", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test", sessionId: "planning" });
    context.createWorkspace("Legacy size boundary", { workspace: "999949", sessionId: "planning" });
    const timestamp = new Date().toISOString();
    const padded = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${index}-${"x".repeat(105)}`);
    const record = {
      schema: 1, workspace: "999949", stage: "01", revision: 1, created_at: timestamp, updated_at: timestamp, updated_by: "test",
      ...state({ scope: padded("scope", 50), remaining: ["Current"], decisions: padded("decision", 50), blockers: padded("blocker", 49), verification: padded("verify", 49) }),
    };
    const file = context.storage.stageExecutionFile("999949", "01");
    const original = `${JSON.stringify(record)}\n`;
    assert.ok(Buffer.byteLength(original, "utf8") < 32768);
    fs.writeFileSync(file, original);

    assert.throws(
      () => context.completeCurrentExecution("999949", "01", "planning", 1),
      (error) => error.code === ERROR_CODES.EXECUTION_LIMIT_EXCEEDED,
    );
    assert.equal(fs.readFileSync(file, "utf8"), original);
  } finally { removeRoot(root); }
});

test("execution validation enforces item, count, byte, and canonical-storage limits", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Limit workspace", { workspace: "999944", sessionId: "planning" });
    assert.throws(
      () => context.replaceStageExecution("999944", "01", "planning", 0, state({ remaining: {} })),
      (error) => error.code === ERROR_CODES.INVALID_ARGUMENT,
    );
    assert.throws(
      () => context.updateStageExecution("999944", "01", "planning", 0, { add: { remaining: {} } }),
      (error) => error.code === ERROR_CODES.INVALID_ARGUMENT,
    );
    const tooMany = Array.from({ length: 51 }, (_, index) => `Item ${index}`);
    assert.throws(
      () => context.replaceStageExecution("999944", "01", "planning", 0, state({ scope: tooMany })),
      (error) => error.code === ERROR_CODES.EXECUTION_LIMIT_EXCEEDED,
    );
    assert.throws(
      () => context.replaceStageExecution("999944", "01", "planning", 0, state({ scope: ["x".repeat(501)] })),
      (error) => error.code === ERROR_CODES.EXECUTION_LIMIT_EXCEEDED,
    );
    const fifty = (prefix) => Array.from({ length: 50 }, (_, index) => `${prefix} ${index}`);
    assert.throws(
      () => context.replaceStageExecution("999944", "01", "planning", 0, state({ scope: fifty("scope"), decisions: fifty("decision"), blockers: fifty("blocker"), verification: fifty("verification"), remaining: ["Item 201"] })),
      (error) => error.code === ERROR_CODES.EXECUTION_LIMIT_EXCEEDED,
    );
    const large = Array.from({ length: 50 }, (_, index) => `${index}-${"x".repeat(190)}`);
    assert.throws(
      () => context.replaceStageExecution("999944", "01", "planning", 0, state({ scope: large, decisions: large.map((item) => `d-${item}`), blockers: large.map((item) => `b-${item}`), verification: large.map((item) => `v-${item}`) })),
      (error) => error.code === ERROR_CODES.EXECUTION_LIMIT_EXCEEDED,
    );
    assert.equal(fs.existsSync(context.storage.stageExecutionFile("999944", "01")), false);

    fs.writeFileSync(context.storage.stageExecutionFile("999944", "01"), "{\"schema\":1}\n");
    assert.throws(() => context.readStageExecution("999944", "01"), (error) => error.code === ERROR_CODES.STORAGE_ERROR);
    const timestamp = new Date().toISOString();
    fs.writeFileSync(context.storage.stageExecutionFile("999944", "01"), `${JSON.stringify({
      schema: 2, workspace: "999944", stage: "01", revision: 1, created_at: timestamp, updated_at: timestamp, updated_by: "test",
      items: { scope: [], completed: [], remaining: [{ id: "not-stable", text: "Invalid ID" }], decisions: [], blockers: [], verification: [] },
    })}\n`);
    assert.throws(() => context.readStageExecution("999944", "01"), (error) => error.code === ERROR_CODES.STORAGE_ERROR);
    fs.writeFileSync(context.storage.stageExecutionFile("999944", "01"), `${JSON.stringify({
      schema: 2, workspace: "999944", stage: "01", revision: 1, created_at: timestamp, updated_at: timestamp, updated_by: "test",
      items: { scope: [], completed: [], remaining: [{ id: "00000000-0000-4000-8000-000000000000", text: " Not canonical " }], decisions: [], blockers: [], verification: [] },
    })}\n`);
    assert.throws(() => context.readStageExecution("999944", "01"), (error) => error.code === ERROR_CODES.STORAGE_ERROR);
  } finally { removeRoot(root); }
});

test("explicit stage finish reports remaining execution work and preserves the final ledger", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    context.createWorkspace("Finish execution", { workspace: "999945", sessionId: "planning" });
    context.replaceStageExecution("999945", "01", "planning", 0, state({
      completed: ["Implementation"],
      remaining: ["Optional cleanup"],
      blockers: ["External decision"],
      verification: ["Manual smoke test"],
    }));

    const finished = context.finish("999945", "01", "planning", { result: "Explicitly completed.", knowledgeReview: "none" });
    assert.deepEqual(finished.data.execution_warnings, ["1 remaining item(s)", "1 blocker(s) or open question(s)", "1 pending verification item(s)"]);
    assert.equal(finished.data.execution_state.revision, 1);
    assert.equal(context.readStageExecution("999945", "01").data.revision, 1);
    assert.throws(
      () => context.replaceStageExecution("999945", "01", "planning", 1, state()),
      (error) => error.code === ERROR_CODES.INVALID_STATE,
    );
  } finally { removeRoot(root); }
});

test("help exposes all stage execution operations", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root, { actor: "test" });
    const help = context.help().data;
    assert.match(help.syntax, /stage execution read/);
    assert.match(help.syntax, /stage execution replace/);
    assert.match(help.syntax, /stage execution update/);
    assert.match(help.syntax, /stage execution complete-current/);
    assert.match(help.note, /bounded stage-local operational checkpoint/);
  } finally { removeRoot(root); }
});
