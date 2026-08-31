import assert from "node:assert/strict";
import test from "node:test";
import { readStagesSnapshot, renderStagesPanel } from "../../src/index.js";
import serverPlugin from "../../plugin/work-context.js";
import tools from "../../src/tool-definitions.js";
import { createFixture, createSessionHost } from "../helpers/integration.js";

test("new OpenCode session resumes a stage and updates its session title", async () => {
  const fixture = createFixture();
  try {
    const { context, root } = fixture;
    context.createWorkspace("Integration workspace", { workspace: "999900", sessionId: "oc-create" });
    context.finish("999900", "01", "oc-create", { knowledgeReview: "none" });
    context.addStage("999900", "Integration stage", { goal: "Exercise both plugin boundaries" });

    const host = createSessionHost(root, "oc-resume");
    const hooks = await serverPlugin(host);
    const result = context.startSession("999900", "02", { sessionId: "oc-resume" });
    assert.equal(result.data.ordinal, "02/01");

    await hooks["tool.execute.after"]({ tool: "work_context_start_session", sessionID: "oc-resume" });
    assert.equal(host.title, "999900 02/01\nIntegration workspace");

    const snapshot = readStagesSnapshot({ projectRoot: root, sessionId: "oc-resume" });
    assert.equal(snapshot.data.workspace.id, "999900");
    assert.equal(snapshot.data.currentStage, "02");
    assert.match(renderStagesPanel(snapshot), /\[•\] 02\. Integration stage/);
  } finally {
    fixture.cleanup();
  }
});

test("resume tool exposes the stage prompt to the OpenCode agent", async () => {
  const fixture = createFixture();
  try {
    const { context } = fixture;
    context.createWorkspace("Prompt integration workspace", { workspace: "999902", sessionId: "oc-create" });
    context.handoff("999902", "01", "oc-create");
    context.addStage("999902", "Prompted stage", { prompt: "Start by inspecting the existing tests, then implement the change." });

    const executeContext = {
      directory: fixture.root,
      worktree: fixture.root,
      sessionID: "oc-resume",
      metadata: async () => {},
    };
    const result = JSON.parse((await tools.work_context_start_session.execute({ workspace: "999902", stage: "02" }, executeContext)).output);
    assert.equal(result.ok, true);
    assert.equal(result.data.prompt, "Start by inspecting the existing tests, then implement the change.");
    assert.equal(result.data.resume.first, true);
    assert.equal(result.data.resume.next_action, "start_work");
    assert.equal(result.data.resume.instruction, result.data.prompt);
  } finally {
    fixture.cleanup();
  }
});

test("force-close tool returns a stable confirmation error and closes a stale session", async () => {
  const fixture = createFixture();
  try {
    const { context } = fixture;
    context.createWorkspace("Force tool workspace", { workspace: "999904", sessionId: "oc-create" });
    context.handoff("999904", "01", "oc-create");
    context.addStage("999904", "Stale stage");
    const session = context.startSession("999904", "02", { sessionId: "stale-session" });
    const executeContext = { directory: fixture.root, worktree: fixture.root, sessionID: "oc-force", metadata: async () => {} };

    const missingConfirmation = JSON.parse((await tools.work_context_force_close_session.execute({
      workspace: "999904", stage: "02", sessionId: session.data.session_id, reason: "stale OpenCode session", confirmation: "no",
    }, executeContext)).output);
    assert.equal(missingConfirmation.ok, false);
    assert.equal(missingConfirmation.error.code, "CONFIRMATION_REQUIRED");

    const closed = JSON.parse((await tools.work_context_force_close_session.execute({
      workspace: "999904", stage: "02", sessionId: session.data.session_id, reason: "stale OpenCode session", confirmation: "FORCE_CLOSE",
    }, executeContext)).output);
    assert.equal(closed.ok, true);
    assert.equal(closed.data.forced, true);
  } finally {
    fixture.cleanup();
  }
});

test("finishing a stage refreshes the OpenCode title with its terminal state", async () => {
  const fixture = createFixture();
  try {
    const { context, root } = fixture;
    context.createWorkspace("Finished workspace", { workspace: "999903", sessionId: "oc-create" });
    context.finish("999903", "01", "oc-create", { knowledgeReview: "none" });
    context.addStage("999903", "Finished stage");
    const session = context.startSession("999903", "02", { sessionId: "internal-2", opencodeSessionId: "oc-finish" });

    const host = createSessionHost(root, "oc-finish");
    const hooks = await serverPlugin(host);
    await hooks["tool.execute.after"]({ tool: "work_context_start_session", sessionID: "oc-finish" });
    assert.equal(host.title, "999903 02/01\nFinished workspace");

    context.finish("999903", "02", session.data.session_id, { knowledgeReview: "none" });
    await hooks["tool.execute.after"]({ tool: "work_context_finish_stage", sessionID: "oc-finish" });
    assert.equal(host.title, "999903 02/01 (closed)\nFinished workspace");
  } finally {
    fixture.cleanup();
  }
});

test("create tool can create multiple workspaces in one OpenCode session", async () => {
  const fixture = createFixture();
  try {
    const executeContext = {
      directory: fixture.root,
      worktree: fixture.root,
      sessionID: "oc-shared",
      metadata: async () => {},
    };

    const first = JSON.parse((await tools.work_context_create_workspace.execute({ title: "First" }, executeContext)).output);
    const second = JSON.parse((await tools.work_context_create_workspace.execute({ title: "Second" }, executeContext)).output);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.data.session_id, second.data.session_id);
    assert.equal(fixture.context.sessionByOpenCodeId("oc-shared", second.data.workspace, "01").session_id, second.data.session_id);
  } finally {
    fixture.cleanup();
  }
});

test("stage add without a workspace enters the new stage and returns resume context", async () => {
  const fixture = createFixture();
  try {
    const { context } = fixture;
    context.createWorkspace("Stage add workspace", { workspace: "999905", sessionId: "internal-create", opencodeSessionId: "oc-current" });
    const executeContext = {
      directory: fixture.root,
      worktree: fixture.root,
      sessionID: "oc-current",
      metadata: async () => {},
    };
    const result = JSON.parse((await tools.work_context_add_stage.execute({ title: "New current stage", prompt: "Implement the stage and verify it." }, executeContext)).output);

    assert.equal(result.ok, true);
    assert.equal(result.data.workspace, "999905");
    assert.equal(result.data.stage, "02");
    assert.equal(result.data.created.stage, "02");
    assert.equal(result.data.resume.next_action, "start_work");
    assert.equal(context.sessionByOpenCodeId("oc-current", "999905", "02").state, "active");
    const snapshot = readStagesSnapshot({ projectRoot: fixture.root, sessionId: "oc-current" });
    assert.equal(snapshot.data.currentStage, "02");
  } finally {
    fixture.cleanup();
  }
});

test("stage add with an explicit workspace enters it when the session is unassociated", async () => {
  const fixture = createFixture();
  try {
    const { context } = fixture;
    context.createWorkspace("Explicit stage workspace", { workspace: "999906", sessionId: "oc-create" });
    context.handoff("999906", "01", "oc-create");
    const executeContext = {
      directory: fixture.root,
      worktree: fixture.root,
      sessionID: "oc-unassociated",
      metadata: async () => {},
    };
    const result = JSON.parse((await tools.work_context_add_stage.execute({ workspace: "999906", title: "Entered explicit stage", prompt: "Implement and verify." }, executeContext)).output);

    assert.equal(result.ok, true);
    assert.equal(result.data.stage, "02");
    assert.equal(result.data.resume.next_action, "start_work");
    assert.equal(context.sessionByOpenCodeId("oc-unassociated", "999906", "02").state, "active");
    const host = createSessionHost(fixture.root, "oc-unassociated");
    const hooks = await serverPlugin(host);
    await hooks["tool.execute.after"]({ tool: "work_context_add_stage", sessionID: "oc-unassociated" });
    assert.equal(host.title, "999906 02/01\nExplicit stage workspace");
  } finally {
    fixture.cleanup();
  }
});

test("stage lifecycle tools can resolve workspace from the current OpenCode session", async () => {
  const fixture = createFixture();
  try {
    const { context } = fixture;
    context.createWorkspace("Contextual lifecycle workspace", { workspace: "999907", sessionId: "internal-create", opencodeSessionId: "oc-current" });
    const executeContext = {
      directory: fixture.root,
      worktree: fixture.root,
      sessionID: "oc-current",
      metadata: async () => {},
    };

    const renamed = JSON.parse((await tools.work_context_rename_stage.execute({ title: "Renamed current stage" }, executeContext)).output);
    assert.equal(renamed.ok, true);
    assert.deepEqual(renamed.data, { workspace: "999907", stage: "01", title: "Renamed current stage" });
    const finished = JSON.parse((await tools.work_context_finish_stage.execute({ stage: "01", knowledgeReview: "none" }, executeContext)).output);
    assert.equal(finished.ok, true);
    assert.equal(finished.data.workspace, "999907");

    context.addStage("999907", "Archive me");
    const archived = JSON.parse((await tools.work_context_archive_stage.execute({ stage: "02" }, executeContext)).output);
    assert.equal(archived.ok, true);
    assert.deepEqual(archived.data, { workspace: "999907", stage: "02", status: "archived" });
  } finally {
    fixture.cleanup();
  }
});

test("stage tracker link is preferred over workspace tracker link in the session title", async () => {
  const fixture = createFixture();
  try {
    const { context, root } = fixture;
    context.createWorkspace("Tracked workspace", { workspace: "999901", sessionId: "oc-create" });
    context.linkIssue("999901", "https://gitlab.example/group/project/-/issues/10");
    context.finish("999901", "01", "oc-create", { knowledgeReview: "none" });
    context.addStage("999901", "Tracked stage");
    context.linkIssue("999901", "https://gitlab.example/group/project/-/issues/11", "02");
    context.startSession("999901", "02", { sessionId: "oc-resume" });

    const host = createSessionHost(root, "oc-resume");
    const hooks = await serverPlugin(host);
    await hooks["tool.execute.after"]({ tool: "work_context_start_session", sessionID: "oc-resume" });
    assert.equal(host.title, "GL#11 | 999901 02/01\nTracked workspace");
  } finally {
    fixture.cleanup();
  }
});
