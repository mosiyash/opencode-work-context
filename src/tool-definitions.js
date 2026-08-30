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
const workspaceFromSession = (ctx, workspace) => {
  if (workspace) return workspace;
  const session = ctx.sessionByOpenCodeId(ctx.options.sessionId) || ctx.sessionById(ctx.options.sessionId);
  if (!session) fail(ERROR_CODES.INVALID_ARGUMENT, "Workspace is required when the current session is not associated with a workspace");
  return session.workspace;
};
const sessionFor = (ctx, oc, workspace, stage) => ctx.sessionById(oc.sessionID)?.workspace === workspace
  && ctx.sessionById(oc.sessionID)?.stage === stage
  ? oc.sessionID
  : ctx.sessionByOpenCodeId(oc.sessionID, workspace, stage)?.session_id || oc.sessionID;
export const work_context_list_workspaces = tool({ description: "List work-context workspaces.", args: {}, execute: run((ctx) => ctx.listWorkspaces()) });
export const work_context_workspace_list = tool({ description: "List a workspace with stage descriptions and sessions.", args: { workspace: tool.schema.string().regex(/^\d{6}$/) }, execute: run((ctx, a) => ctx.listStages(a.workspace)) });
export const work_context_rename_workspace = tool({ description: "Rename a workspace.", args: { workspace: tool.schema.string().regex(/^\d{6}$/), title: tool.schema.string() }, execute: run((ctx, a) => ctx.renameWorkspace(a.workspace, a.title)) });
export const work_context_workspace_finish = tool({ description: "Finish a workspace after all stages are completed.", args: { workspace: tool.schema.string().regex(/^\d{6}$/) }, execute: run((ctx, a) => ctx.finishWorkspace(a.workspace)) });
export const work_context_create_workspace = tool({ description: "Create workspace, stage 01, and active session.", args: { title: tool.schema.string() }, execute: run((ctx, a, oc) => ctx.createWorkspace(a.title, { sessionId: randomUUID(), opencodeSessionId: oc.sessionID })) });
export const work_context_start_session = tool({ description: "Start a new active session for a stage.", args: { ...common, summary: tool.schema.string().optional() }, execute: run((ctx, a, oc) => ctx.startSession(a.workspace, a.stage, { sessionId: randomUUID(), opencodeSessionId: oc.sessionID, summary: a.summary, takeover: true })) });
export const work_context_add_stage = tool({ description: "Add a planned stage. Prompt is optional for manually created stages and should be detailed when the stage comes from planning.", args: { workspace: tool.schema.string().regex(/^\d{6}$/).optional(), title: tool.schema.string(), goal: tool.schema.string().optional(), prompt: tool.schema.string().optional(), dependsOn: tool.schema.array(tool.schema.string()).optional() }, execute: run((ctx, a) => ctx.addStage(workspaceFromSession(ctx, a.workspace), a.title, { goal: a.goal, prompt: a.prompt, dependsOn: a.dependsOn })) });
export const work_context_rename_stage = tool({ description: "Rename a stage while preserving its ID and history.", args: { workspace: tool.schema.string().regex(/^\d{6}$/).optional(), stage: tool.schema.string().regex(/^\d{1,2}$/), title: tool.schema.string() }, execute: run((ctx, a) => ctx.renameStage(workspaceFromSession(ctx, a.workspace), a.stage, a.title)) });
export const work_context_update_stage = tool({ description: "Update an existing stage description.", args: { workspace: tool.schema.string().regex(/^\d{6}$/).optional(), stage: tool.schema.string().regex(/^\d{1,2}$/), description: tool.schema.string() }, execute: run((ctx, a) => ctx.updateStage(workspaceFromSession(ctx, a.workspace), a.stage, a.description)) });
export const work_context_archive_stage = tool({ description: "Archive a stage while preserving its ID and history.", args: { workspace: tool.schema.string().regex(/^\d{6}$/), stage: tool.schema.string().regex(/^\d{1,2}$/) }, execute: run((ctx, a) => ctx.archiveStage(a.workspace, a.stage)) });
export const work_context_link_issue = tool({ description: "Link a GitLab issue URL to workspace or stage.", args: { workspace: tool.schema.string(), url: tool.schema.string(), stage: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.linkIssue(a.workspace, a.url, a.stage)) });
export const work_context_rename_session = tool({ description: "Rename the current active session summary.", args: { ...common, summary: tool.schema.string() }, execute: run((ctx, a, oc) => ctx.renameSession(a.workspace, a.stage, sessionFor(ctx, oc, a.workspace, a.stage), a.summary)) });
export const work_context_close_session = tool({ description: "Close the current session without finishing its stage.", args: { ...common }, execute: run((ctx, a, oc) => ctx.closeSession(a.workspace, a.stage, sessionFor(ctx, oc, a.workspace, a.stage))) });
export const work_context_handoff_stage = tool({ description: "Hand off the current stage by closing the current session.", args: { ...common }, execute: run((ctx, a, oc) => ctx.handoff(a.workspace, a.stage, sessionFor(ctx, oc, a.workspace, a.stage))) });
export const work_context_abandon_stage = tool({ description: "Abandon the current stage session without completing the stage.", args: { ...common }, execute: run((ctx, a, oc) => ctx.abandon(a.workspace, a.stage, sessionFor(ctx, oc, a.workspace, a.stage))) });
export const work_context_finish_stage = tool({ description: "Finish a stage and automatically validate the Knowledge Base by default.", args: { ...common, result: tool.schema.string().optional(), knowledgeReview: tool.schema.string().optional() }, execute: run((ctx, a, oc) => ctx.finish(a.workspace, a.stage, sessionFor(ctx, oc, a.workspace, a.stage), { result: a.result, knowledgeReview: a.knowledgeReview })) });
export const work_context_help = tool({ description: "Show work-context command help.", args: { command: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.help(a.command)) });
export const work_context_list_knowledge = tool({ description: "List durable knowledge entries for a workspace.", args: { workspace: tool.schema.string() }, execute: run((ctx, a) => ctx.listKnowledge(a.workspace)) });
export const work_context_add_knowledge = tool({ description: "Add a durable knowledge entry.", args: { workspace: tool.schema.string(), title: tool.schema.string(), kind: tool.schema.string().optional(), text: tool.schema.string(), sources: tool.schema.array(tool.schema.string()).optional() }, execute: run((ctx, a) => ctx.addKnowledge(a.workspace, a)) });
export const work_context_update_knowledge = tool({ description: "Update a durable knowledge entry.", args: { workspace: tool.schema.string(), knowledgeId: tool.schema.string(), title: tool.schema.string().optional(), kind: tool.schema.string().optional(), status: tool.schema.string().optional(), text: tool.schema.string().optional(), sources: tool.schema.array(tool.schema.string()).optional(), replacement: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.updateKnowledge(a.workspace, a.knowledgeId, a)) });
export const work_context_supersede_knowledge = tool({ description: "Supersede a durable knowledge entry.", args: { workspace: tool.schema.string(), knowledgeId: tool.schema.string(), replacement: tool.schema.string() }, execute: run((ctx, a) => ctx.supersedeKnowledge(a.workspace, a.knowledgeId, a.replacement) ) });

export default { work_context_list_workspaces, work_context_workspace_list, work_context_rename_workspace, work_context_workspace_finish, work_context_create_workspace, work_context_start_session, work_context_add_stage, work_context_rename_stage, work_context_update_stage, work_context_archive_stage, work_context_link_issue, work_context_rename_session, work_context_close_session, work_context_handoff_stage, work_context_abandon_stage, work_context_finish_stage, work_context_help, work_context_list_knowledge, work_context_add_knowledge, work_context_update_knowledge, work_context_supersede_knowledge };
