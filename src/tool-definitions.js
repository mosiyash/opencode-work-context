import { tool } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { contextFor, titleFor } from "../src/opencode-adapter.js";
import { fail, ERROR_CODES } from "../src/errors.js";

const run = (fn) => async (args, context) => {
  try {
    const result = await fn(contextFor(context.worktree || context.directory, context.sessionID), args, context);
    try { await context.metadata({ title: "work-context", metadata: { result } }); } catch {}
    return { output: JSON.stringify(result), metadata: result };
  } catch (error) {
    return { output: JSON.stringify({ ok: false, error: { code: error.code || "STORAGE_ERROR", message: error.message, details: error.details || {} } }), metadata: { code: error.code || "STORAGE_ERROR" } };
  }
};
const common = { workspace: tool.schema.string().regex(/^\d{6}$/), stage: tool.schema.string().regex(/^\d{1,2}$/) };
const contextualStage = { workspace: tool.schema.string().regex(/^\d{6}$/).optional(), stage: tool.schema.string().regex(/^\d{1,2}$/).optional() };
const sessionFromContext = (ctx, workspace) => ctx.sessionByOpenCodeId(ctx.options.sessionId, workspace || null, null, null)
  || (!workspace ? ctx.sessionById(ctx.options.sessionId) : null);
const workspaceFromSession = (ctx, workspace) => {
  if (workspace) return workspace;
  const session = sessionFromContext(ctx);
  if (!session) fail(ERROR_CODES.INVALID_ARGUMENT, "Workspace is required when the current session is not associated with a workspace");
  return session.workspace;
};
const stageFromSession = (ctx, workspace, stage) => {
  if (stage) return stage;
  const session = sessionFromContext(ctx, workspace);
  if (!session) fail(ERROR_CODES.STAGE_CONTEXT_REQUIRED, "Stage is required when the current session is not associated with a stage");
  return session.stage;
};
const sessionFor = (ctx, oc, workspace, stage) => ctx.sessionById(oc.sessionID)?.workspace === workspace
  && ctx.sessionById(oc.sessionID)?.stage === stage
  ? oc.sessionID
  : ctx.sessionByOpenCodeId(oc.sessionID, workspace, stage)?.session_id || oc.sessionID;
const addStageFromTool = (ctx, args, oc) => {
  const workspace = workspaceFromSession(ctx, args.workspace);
  const created = ctx.addStage(workspace, args.title, { goal: args.goal, prompt: args.prompt, dependsOn: args.dependsOn });
  const currentSession = ctx.sessionByOpenCodeId(oc.sessionID) || ctx.sessionById(oc.sessionID);
  if (args.workspace && currentSession) return created;
  const session = ctx.startSession(workspace, created.data.stage, {
    sessionId: randomUUID(),
    opencodeSessionId: oc.sessionID,
    summary: `started ${created.data.title}`,
    takeover: true,
  });
  return {
    ...session,
    data: { ...session.data, created: created.data },
    changed: [...new Set([...created.changed, ...session.changed])],
  };
};
export const work_context_list_workspaces = tool({ description: "List work-context workspaces.", args: {}, execute: run((ctx) => ctx.listWorkspaces()) });
export const work_context_workspace_list = tool({ description: "List a workspace with stage descriptions and sessions.", args: { workspace: tool.schema.string().regex(/^\d{6}$/) }, execute: run((ctx, a) => ctx.listStages(a.workspace)) });
export const work_context_rename_workspace = tool({ description: "Rename a workspace.", args: { workspace: tool.schema.string().regex(/^\d{6}$/), title: tool.schema.string() }, execute: run((ctx, a) => ctx.renameWorkspace(a.workspace, a.title)) });
export const work_context_workspace_finish = tool({ description: "Finish a workspace after all stages are completed.", args: { workspace: tool.schema.string().regex(/^\d{6}$/) }, execute: run((ctx, a) => ctx.finishWorkspace(a.workspace)) });
export const work_context_create_workspace = tool({ description: "Create workspace, enter its planning stage in the current OpenCode session, and return resume context.", args: { title: tool.schema.string() }, execute: run((ctx, a, oc) => ctx.createWorkspace(a.title, { sessionId: randomUUID(), opencodeSessionId: oc.sessionID })) });
export const work_context_start_session = tool({ description: "Start a new active session for a stage.", args: { ...common, summary: tool.schema.string().optional() }, execute: run((ctx, a, oc) => ctx.startSession(a.workspace, a.stage, { sessionId: randomUUID(), opencodeSessionId: oc.sessionID, summary: a.summary, takeover: true })) });
export const work_context_add_stage = tool({ description: "Add a stage; when workspace is omitted, enter the new stage in the current OpenCode session and return resume context.", args: { workspace: tool.schema.string().regex(/^\d{6}$/).optional(), title: tool.schema.string(), goal: tool.schema.string().optional(), prompt: tool.schema.string().optional(), dependsOn: tool.schema.array(tool.schema.string()).optional() }, execute: run(addStageFromTool) });
export const work_context_rename_stage = tool({ description: "Rename a stage while preserving its ID and history; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, title: tool.schema.string() }, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.renameStage(workspace, stageFromSession(ctx, workspace, a.stage), a.title); }) });
export const work_context_update_stage = tool({ description: "Update an existing stage description; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, description: tool.schema.string() }, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.updateStage(workspace, stageFromSession(ctx, workspace, a.stage), a.description); }) });
export const work_context_update_stage_prompt = tool({ description: "Update the optional working prompt of an existing stage; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, prompt: tool.schema.string() }, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.updateStagePrompt(workspace, stageFromSession(ctx, workspace, a.stage), a.prompt); }) });
export const work_context_archive_stage = tool({ description: "Archive a stage while preserving its ID and history; workspace and stage can be omitted in the current OpenCode session.", args: contextualStage, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.archiveStage(workspace, stageFromSession(ctx, workspace, a.stage)); }) });
export const work_context_link_issue = tool({ description: "Link a GitLab issue URL to workspace or stage.", args: { workspace: tool.schema.string(), url: tool.schema.string(), stage: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.linkIssue(a.workspace, a.url, a.stage)) });
export const work_context_rename_session = tool({ description: "Rename the current active session summary; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, summary: tool.schema.string() }, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.renameSession(workspace, stage, sessionFor(ctx, oc, workspace, stage), a.summary); }) });
export const work_context_close_session = tool({ description: "Close the current session without finishing its stage; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage }, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.closeSession(workspace, stage, sessionFor(ctx, oc, workspace, stage)); }) });
export const work_context_force_close_session = tool({ description: "Force close a stale active session with an explicit reason and confirmation.", args: { workspace: tool.schema.string().regex(/^\d{6}$/), stage: tool.schema.string().regex(/^\d{1,2}$/), sessionId: tool.schema.string(), reason: tool.schema.string(), confirmation: tool.schema.string() }, execute: run((ctx, a) => ctx.forceCloseSession(a.workspace, a.stage, a.sessionId, a.reason, a.confirmation)) });
export const work_context_handoff_stage = tool({ description: "Hand off the current stage by closing the current session; workspace and stage can be omitted in the current OpenCode session.", args: contextualStage, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.handoff(workspace, stage, sessionFor(ctx, oc, workspace, stage)); }) });
export const work_context_abandon_stage = tool({ description: "Abandon the current stage session without completing the stage; workspace and stage can be omitted in the current OpenCode session.", args: contextualStage, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.abandon(workspace, stage, sessionFor(ctx, oc, workspace, stage)); }) });
export const work_context_finish_stage = tool({ description: "Finish a stage and automatically validate the Knowledge Base by default; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, result: tool.schema.string().optional(), knowledgeReview: tool.schema.string().optional() }, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.finish(workspace, stage, sessionFor(ctx, oc, workspace, stage), { result: a.result, knowledgeReview: a.knowledgeReview }); }) });
export const work_context_help = tool({ description: "Show work-context command help.", args: { command: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.help(a.command)) });
export const work_context_list_knowledge = tool({ description: "List durable knowledge entries for a workspace.", args: { workspace: tool.schema.string() }, execute: run((ctx, a) => ctx.listKnowledge(a.workspace)) });
export const work_context_add_knowledge = tool({ description: "Add a durable knowledge entry.", args: { workspace: tool.schema.string(), title: tool.schema.string(), kind: tool.schema.string().optional(), text: tool.schema.string(), sources: tool.schema.array(tool.schema.string()).optional() }, execute: run((ctx, a) => ctx.addKnowledge(a.workspace, a)) });
export const work_context_update_knowledge = tool({ description: "Update a durable knowledge entry.", args: { workspace: tool.schema.string(), knowledgeId: tool.schema.string(), title: tool.schema.string().optional(), kind: tool.schema.string().optional(), status: tool.schema.string().optional(), text: tool.schema.string().optional(), sources: tool.schema.array(tool.schema.string()).optional(), replacement: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.updateKnowledge(a.workspace, a.knowledgeId, a)) });
export const work_context_supersede_knowledge = tool({ description: "Supersede a durable knowledge entry.", args: { workspace: tool.schema.string(), knowledgeId: tool.schema.string(), replacement: tool.schema.string() }, execute: run((ctx, a) => ctx.supersedeKnowledge(a.workspace, a.knowledgeId, a.replacement) ) });

export default { work_context_list_workspaces, work_context_workspace_list, work_context_rename_workspace, work_context_workspace_finish, work_context_create_workspace, work_context_start_session, work_context_add_stage, work_context_rename_stage, work_context_update_stage, work_context_update_stage_prompt, work_context_archive_stage, work_context_link_issue, work_context_rename_session, work_context_close_session, work_context_force_close_session, work_context_handoff_stage, work_context_abandon_stage, work_context_finish_stage, work_context_help, work_context_list_knowledge, work_context_add_knowledge, work_context_update_knowledge, work_context_supersede_knowledge };
