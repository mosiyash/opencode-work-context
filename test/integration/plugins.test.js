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
