import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contextFor, runtimeSelfReport, titleFor } from "../src/opencode-adapter.js";
import { WorkContext } from "../src/core.js";
import { fail, ERROR_CODES } from "../src/errors.js";
import { normalizeStageId, normalizeWorkspaceId } from "../src/identifiers.js";

// OpenCode tool definitions are plain descriptors with Zod schemas.
const tool = Object.assign((definition) => definition, { schema: z });

const run = (fn) => async (args, context) => {
  try {
    const projectRoot = context.worktree === "/" ? context.directory : (context.worktree || context.directory);
    const result = await fn(contextFor(projectRoot, context.sessionID), args, context);
    try { await context.metadata({ title: "work-context", metadata: { result } }); } catch {}
    return { output: JSON.stringify(result), metadata: result };
  } catch (error) {
    return { output: JSON.stringify({ ok: false, error: { code: error.code || "STORAGE_ERROR", message: error.message, details: error.details || {} } }), metadata: { code: error.code || "STORAGE_ERROR" } };
  }
};
const runProject = (fn, { metadata = true, redactErrors = false } = {}) => async (args, context) => {
  try {
    const projectRoot = context.worktree === "/" ? context.directory : (context.worktree || context.directory);
    const result = await fn(projectRoot, args, context);
    if (metadata) try { await context.metadata({ title: "work-context", metadata: { result } }); } catch {}
    return { output: JSON.stringify(result), metadata: result };
  } catch (error) {
    const stable = Object.values(ERROR_CODES).includes(error.code) ? error.code : ERROR_CODES.STORAGE_ERROR;
    const result = { ok: false, error: {
      code: stable,
      message: redactErrors && stable !== ERROR_CODES.DELIVERY_COMMAND_PROTOCOL_MISMATCH ? "Delivery doctor could not complete safely" : error.message,
      details: redactErrors && stable !== ERROR_CODES.DELIVERY_COMMAND_PROTOCOL_MISMATCH ? {} : (error.details || {}),
    } };
    return { output: JSON.stringify(result), metadata: { code: result.error.code } };
  }
};
const common = { workspace: tool.schema.string(), stage: tool.schema.string() };
const contextualStage = { workspace: tool.schema.string().optional(), stage: tool.schema.string().optional() };
const capabilityProfile = tool.schema.enum(["routine", "implementation", "architecture", "security", "review"]);
const capabilityDepth = tool.schema.enum(["light", "standard", "deep"]);
const deliveryFinding = tool.schema.object({
  id: tool.schema.string(),
  severity: tool.schema.enum(["info", "warning", "error"]),
  summary: tool.schema.string(),
  affected_paths: tool.schema.array(tool.schema.string()).optional(),
  remediation_ids: tool.schema.array(tool.schema.string()).optional(),
  recommendation: tool.schema.string().optional(),
}).strict();
const executionItem = tool.schema.union([tool.schema.string(), tool.schema.object({ id: tool.schema.string().optional(), text: tool.schema.string() }).strict()]);
const executionRemoval = tool.schema.union([tool.schema.string(), tool.schema.object({ id: tool.schema.string() }).strict()]);
const executionEdit = tool.schema.object({ id: tool.schema.string(), text: tool.schema.string() }).strict();
const executionSections = Object.fromEntries(["scope", "completed", "remaining", "decisions", "blockers", "verification"].map((section) => [section, tool.schema.array(executionItem).optional()]));
const executionRemovalSections = Object.fromEntries(["scope", "completed", "remaining", "decisions", "blockers", "verification"].map((section) => [section, tool.schema.array(executionRemoval).optional()]));
const executionEditSections = Object.fromEntries(["scope", "completed", "remaining", "decisions", "blockers", "verification"].map((section) => [section, tool.schema.array(executionEdit).optional()]));
const sessionFromContext = (ctx, workspace) => ctx.sessionByOpenCodeId(ctx.options.sessionId, workspace || null, null, null)
  || (!workspace ? ctx.sessionById(ctx.options.sessionId) : null);
const workspaceFromSession = (ctx, workspace) => {
  if (workspace !== undefined) return normalizeWorkspaceId(workspace);
  const session = sessionFromContext(ctx);
  if (!session) fail(ERROR_CODES.INVALID_ARGUMENT, "Workspace is required when the current session is not associated with a workspace");
  return session.workspace;
};
const stageFromSession = (ctx, workspace, stage) => {
  if (stage !== undefined) return normalizeStageId(stage);
  const session = sessionFromContext(ctx, workspace);
  if (!session) fail(ERROR_CODES.STAGE_CONTEXT_REQUIRED, "Stage is required when the current session is not associated with a stage");
  return session.stage;
};
const sessionFor = (ctx, oc, workspace, stage) => ctx.sessionById(oc.sessionID)?.workspace === workspace
  && ctx.sessionById(oc.sessionID)?.stage === stage
  ? oc.sessionID
  : ctx.sessionByOpenCodeId(oc.sessionID, workspace, stage)?.session_id || oc.sessionID;
const addStageFromTool = (ctx, args, oc) => {
  const currentSession = sessionFromContext(ctx);
  const workspace = workspaceFromSession(ctx, args.workspace);
  const created = ctx.addStage(workspace, args.title, { goal: args.goal, prompt: args.prompt, dependsOn: args.dependsOn, executionProfile: args.executionProfile, executionDepth: args.executionDepth, classification: args.classification, reviewProfile: args.reviewProfile });
  if (currentSession) return created;

  const started = ctx.startSession(workspace, created.data.stage, {
    sessionId: randomUUID(),
    opencodeSessionId: oc.sessionID,
    summary: `started ${args.title.trim()}`,
  });
  return {
    ...started,
    data: { ...started.data, status: "in_progress", session_started: true, resume_required: false },
  };
};
export const work_context_list_workspaces = tool({ description: "List work-context workspaces.", args: {}, execute: run((ctx) => ctx.listWorkspaces()) });
export const work_context_workspace_list = tool({ description: "List a workspace with stage descriptions and sessions.", args: { workspace: tool.schema.string() }, execute: run((ctx, a) => ctx.listStages(a.workspace)) });
export const work_context_rename_workspace = tool({ description: "Rename a workspace.", args: { workspace: tool.schema.string(), title: tool.schema.string() }, execute: run((ctx, a) => ctx.renameWorkspace(a.workspace, a.title)) });
export const work_context_set_workspace_mode = tool({ description: "Set a workspace workflow mode.", args: { workspace: tool.schema.string(), mode: tool.schema.enum(["standard", "startup"]) }, execute: run((ctx, a) => ctx.setWorkspaceMode(a.workspace, a.mode)) });
export const work_context_create_candidate = tool({ description: "Create an exact, shared-foundation, or integration draft candidate. Related stages are optional traceability and never ownership.", args: { workspace: tool.schema.string(), title: tool.schema.string(), message: tool.schema.string().optional(), strategy: tool.schema.enum(["exact", "shared_foundation", "integration"]).optional(), relatedStages: tool.schema.array(tool.schema.string()).optional() }, execute: run((ctx, a) => ctx.createCandidate(a.workspace, a.title, a.message, { strategy: a.strategy, relatedStages: a.relatedStages })) });
export const work_context_capture_candidate = tool({ description: "Capture explicit complete paths or an exact unified patch into a draft commit candidate.", args: { workspace: tool.schema.string(), candidateId: tool.schema.string(), paths: tool.schema.array(tool.schema.string()).optional(), patch: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.captureCandidate(a.workspace, a.candidateId, { paths: a.paths, patch: a.patch })) });
export const work_context_preview_candidate = tool({ description: "Preview a candidate using an isolated temporary Git index.", args: { workspace: tool.schema.string(), candidateId: tool.schema.string() }, execute: run((ctx, a) => ctx.previewCandidate(a.workspace, a.candidateId)) });
export const work_context_show_candidate = tool({ description: "Show local candidate metadata and its exact captured patch.", args: { workspace: tool.schema.string(), candidateId: tool.schema.string() }, execute: run((ctx, a) => ctx.showCandidate(a.workspace, a.candidateId)) });
export const work_context_list_candidates = tool({ description: "List local commit candidates associated with a startup-mode workspace.", args: { workspace: tool.schema.string() }, execute: run((ctx, a) => ctx.listCandidates(a.workspace)) });
export const work_context_ready_candidate = tool({ description: "Mark a captured draft candidate ready for a later explicit commit operation.", args: { workspace: tool.schema.string(), candidateId: tool.schema.string() }, execute: run((ctx, a) => ctx.readyCandidate(a.workspace, a.candidateId)) });
export const work_context_commit_candidate = tool({ description: "Commit a ready candidate atomically without using the ordinary Git index. Uses its stored message unless message is provided.", args: { workspace: tool.schema.string(), candidateId: tool.schema.string(), message: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.commitCandidate(a.workspace, a.candidateId, a.message)) });
export const work_context_inspect_commit_all = tool({ description: "Inspect a repository-local integration boundary and return a confirmation fingerprint without changing Git or candidate state.", args: { workspace: tool.schema.string(), relatedStages: tool.schema.array(tool.schema.string()).optional(), excludePaths: tool.schema.array(tool.schema.string()).optional(), message: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.inspectCommitAll(a.workspace, { relatedStages: a.relatedStages, excludePaths: a.excludePaths, message: a.message })) });
export const work_context_commit_all = tool({ description: "Reproduce and atomically publish a previously inspected repository-local integration plan after exact explicit confirmation.", args: { workspace: tool.schema.string(), expectedFingerprint: tool.schema.string(), confirmation: tool.schema.string(), relatedStages: tool.schema.array(tool.schema.string()).optional(), excludePaths: tool.schema.array(tool.schema.string()).optional(), message: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.commitAll(a.workspace, a.expectedFingerprint, a.confirmation, { relatedStages: a.relatedStages, excludePaths: a.excludePaths, message: a.message })) });
export const work_context_discard_candidate = tool({ description: "Discard a local commit candidate without changing Git state.", args: { workspace: tool.schema.string(), candidateId: tool.schema.string() }, execute: run((ctx, a) => ctx.discardCandidate(a.workspace, a.candidateId)) });
export const work_context_read_delivery = tool({ description: "Read workspace-level delivery context. Exact Git inspection runs only when both immutable from and to commit hashes are provided.", args: { workspace: tool.schema.string(), environment: tool.schema.string().optional(), from: tool.schema.string().optional(), to: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.readDelivery(a.workspace, { environment: a.environment, from: a.from, to: a.to })) });
export const work_context_explain_delivery = tool({ description: "Explain a bounded immutable delivery range with read-only Git evidence, findings, and traceability.", args: { workspace: tool.schema.string(), from: tool.schema.string(), to: tool.schema.string(), findings: tool.schema.array(deliveryFinding).optional() }, execute: run((ctx, a) => ctx.explainDelivery(a.workspace, a.from, a.to, a.findings) ) });
const createDoctorDeliveryTool = ({ runtimeEvidence = runtimeSelfReport } = {}) => tool({
  description: "Diagnose project delivery command, installation, and loaded-plugin protocol evidence without making changes.",
  args: {},
  execute: runProject((projectRoot) => WorkContext.doctorDelivery(projectRoot, {
    loadedPlugin: typeof runtimeEvidence === "function" ? runtimeEvidence(projectRoot) : runtimeEvidence,
  }), { metadata: false, redactErrors: true }),
});
export const work_context_doctor_delivery = createDoctorDeliveryTool();
export const work_context_mark_delivery = tool({ description: "Record a confirmed environment delivery checkpoint without executing deployment. Requires DELIVERY_CONFIRMED.", args: { workspace: tool.schema.string(), environment: tool.schema.string(), commit: tool.schema.string(), confirmation: tool.schema.string() }, execute: run((ctx, a) => ctx.markDelivery(a.workspace, a.environment, a.commit, a.confirmation)) });
export const work_context_workspace_finish = tool({ description: "Finish a workspace after all stages are completed.", args: { workspace: tool.schema.string() }, execute: run((ctx, a) => ctx.finishWorkspace(a.workspace)) });
export const work_context_reopen_workspace = tool({ description: "Reopen a completed workspace with a required reason and durable history.", args: { workspace: tool.schema.string(), reason: tool.schema.string() }, execute: run((ctx, a) => ctx.reopenWorkspace(a.workspace, a.reason)) });
export const work_context_create_workspace = tool({ description: "Create a workspace; enter its planning stage only when the current OpenCode session is not associated with a workspace.", args: { title: tool.schema.string(), mode: tool.schema.enum(["standard", "startup"]).optional() }, execute: run((ctx, a, oc) => {
  const currentSession = ctx.sessionByOpenCodeId(oc.sessionID);
  return ctx.createWorkspace(a.title, { sessionId: randomUUID(), mode: a.mode, ...(currentSession ? {} : { opencodeSessionId: oc.sessionID }) });
}) });
export const work_context_start_session = tool({ description: "Start a new active session for a stage and return its human-oriented presentation, prompt, active workspace knowledge, and startup policy when applicable.", args: { ...common, summary: tool.schema.string().optional() }, execute: run((ctx, a, oc) => ctx.startSession(a.workspace, a.stage, { sessionId: randomUUID(), opencodeSessionId: oc.sessionID, summary: a.summary, takeover: true })) });
export const work_context_acknowledge_commit = tool({ description: "Acknowledge a user-created current-HEAD commit for the active session using a short or full commit hash. This is a deterministic light control-plane operation and does not infer ownership.", args: { sha: tool.schema.string() }, execute: run((ctx, a) => {
  const session = sessionFromContext(ctx);
  if (!session) fail(ERROR_CODES.STAGE_CONTEXT_REQUIRED, "An active work-context stage is required to acknowledge a commit");
  return ctx.acknowledgeCommit(session.workspace, session.stage, session.session_id, a.sha);
}) });
export const work_context_add_stage = tool({ description: "Add a stage with an optional execution capability and depth. When the user did not specify them, infer both from the prompt and pass classification: inferred. Explicit user choices use classification: explicit.", args: { workspace: tool.schema.string().optional(), title: tool.schema.string(), goal: tool.schema.string().optional(), prompt: tool.schema.string().optional(), dependsOn: tool.schema.array(tool.schema.string()).optional(), executionProfile: capabilityProfile.optional(), executionDepth: capabilityDepth.optional(), classification: tool.schema.enum(["inferred", "explicit"]).optional(), reviewProfile: capabilityProfile.optional() }, execute: run(addStageFromTool) });
export const work_context_set_stage_profiles = tool({ description: "Explicitly set or clear a stage execution capability and depth. Omitted fields are unchanged; pass null for both execution fields to clear them. Review profile remains optional metadata.", args: { ...contextualStage, executionProfile: capabilityProfile.nullable().optional(), executionDepth: capabilityDepth.nullable().optional(), reviewProfile: capabilityProfile.nullable().optional() }, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.setStageProfiles(workspace, stageFromSession(ctx, workspace, a.stage), { ...(Object.hasOwn(a, "executionProfile") ? { executionProfile: a.executionProfile } : {}), ...(Object.hasOwn(a, "executionDepth") ? { executionDepth: a.executionDepth } : {}), ...(Object.hasOwn(a, "reviewProfile") ? { reviewProfile: a.reviewProfile } : {}) }); }) });
export const work_context_refresh_stage_profiles = tool({ description: "Atomically apply agent-inferred execution capability and depth recommendations. Ordinary refresh preserves explicit classifications; includeExplicit permits an explicitly requested override.", args: { workspace: tool.schema.string(), recommendations: tool.schema.array(tool.schema.object({ stage: tool.schema.string(), executionProfile: capabilityProfile, executionDepth: capabilityDepth })), includeExplicit: tool.schema.boolean().optional() }, execute: run((ctx, a) => ctx.refreshStageProfiles(a.workspace, a.recommendations, { includeExplicit: a.includeExplicit })) });
export const work_context_show_capability_profiles = tool({ description: "Show capability recommendation mode and validated user-local depth mappings.", args: {}, execute: run((ctx) => ctx.showCapabilityProfiles()) });
export const work_context_configure_capability_profiles = tool({ description: "Atomically configure either capability recommendation mode or global/project light, standard, and deep advisory labels. Interactive setup calls it separately for mode and mappings after gathering preferences.", args: { mode: tool.schema.enum(["advisory", "off"]).optional(), mappings: tool.schema.object({ light: tool.schema.string().optional(), standard: tool.schema.string().optional(), deep: tool.schema.string().optional() }).strict().optional(), scope: tool.schema.enum(["global", "project"]).optional() }, execute: run((ctx, a) => ctx.configureCapabilityProfiles(a)) });
export const work_context_reset_capability_profiles = tool({ description: "Remove global or project advisory mappings after explicit RESET_PROFILES confirmation. Stage classifications and project mode remain unchanged.", args: { confirmation: tool.schema.string(), scope: tool.schema.enum(["global", "project"]).optional() }, execute: run((ctx, a) => ctx.resetCapabilityProfiles(a.confirmation, { scope: a.scope })) });
export const work_context_rename_stage = tool({ description: "Rename a stage while preserving its ID and history; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, title: tool.schema.string() }, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.renameStage(workspace, stageFromSession(ctx, workspace, a.stage), a.title); }) });
export const work_context_update_stage = tool({ description: "Update an existing stage description; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, description: tool.schema.string() }, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.updateStage(workspace, stageFromSession(ctx, workspace, a.stage), a.description); }) });
export const work_context_update_stage_prompt = tool({ description: "Update the optional working prompt of an existing stage; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, prompt: tool.schema.string() }, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.updateStagePrompt(workspace, stageFromSession(ctx, workspace, a.stage), a.prompt); }) });
export const work_context_update_stage_result = tool({ description: "Update an existing stage result; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, result: tool.schema.string() }, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.updateStageResult(workspace, stageFromSession(ctx, workspace, a.stage), a.result); }) });
export const work_context_read_stage_execution = tool({ description: "Read the bounded stage-local execution state; workspace and stage can be omitted in the current OpenCode session.", args: contextualStage, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.readStageExecution(workspace, stageFromSession(ctx, workspace, a.stage)); }) });
export const work_context_replace_stage_execution = tool({ description: "Replace all stage-local execution sections using an optimistic revision guard. Requires the active stage session.", args: { ...contextualStage, expectedRevision: tool.schema.number().int().nonnegative(), state: tool.schema.object(executionSections) }, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.replaceStageExecution(workspace, stage, sessionFor(ctx, oc, workspace, stage), a.expectedRevision, a.state); }) });
export const work_context_update_stage_execution = tool({ description: "Atomically add, remove, or edit stage-local execution items using an optimistic revision guard. String changes retain compatibility; structured changes use stable item IDs. Requires the active stage session.", args: { ...contextualStage, expectedRevision: tool.schema.number().int().nonnegative(), add: tool.schema.object(executionSections).optional(), remove: tool.schema.object(executionRemovalSections).optional(), edit: tool.schema.object(executionEditSections).optional() }, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.updateStageExecution(workspace, stage, sessionFor(ctx, oc, workspace, stage), a.expectedRevision, { ...(a.add ? { add: a.add } : {}), ...(a.remove ? { remove: a.remove } : {}), ...(a.edit ? { edit: a.edit } : {}) }); }) });
export const work_context_complete_current = tool({ description: "Atomically complete the current stage execution item using an optimistic revision guard. Requires the active stage session.", args: { ...contextualStage, expectedRevision: tool.schema.number().int().nonnegative() }, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.completeCurrentExecution(workspace, stage, sessionFor(ctx, oc, workspace, stage), a.expectedRevision); }) });
export const work_context_archive_stage = tool({ description: "Archive a stage while preserving its ID and history; workspace and stage can be omitted in the current OpenCode session.", args: contextualStage, execute: run((ctx, a) => { const workspace = workspaceFromSession(ctx, a.workspace); return ctx.archiveStage(workspace, stageFromSession(ctx, workspace, a.stage)); }) });
export const work_context_reopen_stage = tool({ description: "Reopen a completed stage with a reason. This preserves completion history and requires explicit resume in a separate OpenCode session.", args: { ...common, reason: tool.schema.string() }, execute: run((ctx, a) => ctx.reopenStage(a.workspace, a.stage, a.reason)) });
export const work_context_restore_stage = tool({ description: "Restore an archived stage to its saved pre-archive status with a required reason. Actionable stages require explicit resume in a separate OpenCode session.", args: { ...common, reason: tool.schema.string() }, execute: run((ctx, a) => ctx.restoreStage(a.workspace, a.stage, a.reason)) });
export const work_context_link_issue = tool({ description: "Link a GitLab issue URL to workspace or stage.", args: { workspace: tool.schema.string(), url: tool.schema.string(), stage: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.linkIssue(a.workspace, a.url, a.stage)) });
export const work_context_unlink_issue = tool({ description: "Remove a tracker issue URL from a workspace or stage.", args: { workspace: tool.schema.string(), url: tool.schema.string(), stage: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.unlinkIssue(a.workspace, a.url, a.stage)) });
export const work_context_rename_session = tool({ description: "Rename the current active session summary; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage, summary: tool.schema.string() }, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.renameSession(workspace, stage, sessionFor(ctx, oc, workspace, stage), a.summary); }) });
export const work_context_close_session = tool({ description: "Close the current session without finishing its stage; workspace and stage can be omitted in the current OpenCode session.", args: { ...contextualStage }, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.closeSession(workspace, stage, sessionFor(ctx, oc, workspace, stage)); }) });
export const work_context_force_close_session = tool({ description: "Force close a stale active session with an explicit reason and confirmation.", args: { workspace: tool.schema.string(), stage: tool.schema.string(), sessionId: tool.schema.string(), reason: tool.schema.string(), confirmation: tool.schema.string() }, execute: run((ctx, a) => ctx.forceCloseSession(a.workspace, a.stage, a.sessionId, a.reason, a.confirmation)) });
export const work_context_handoff_stage = tool({ description: "Hand off the current stage by closing the current session; workspace and stage can be omitted in the current OpenCode session.", args: contextualStage, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.handoff(workspace, stage, sessionFor(ctx, oc, workspace, stage)); }) });
export const work_context_abandon_stage = tool({ description: "Abandon the current stage session without completing the stage; workspace and stage can be omitted in the current OpenCode session.", args: contextualStage, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.abandon(workspace, stage, sessionFor(ctx, oc, workspace, stage)); }) });
export const work_context_finish_stage = tool({ description: "Finish a stage only for an explicit user lifecycle request, unless the Planning-stage prompt explicitly permits automatic completion. Review durable workspace knowledge; use knowledgeReview=added after changes or none when no durable findings exist.", args: { ...contextualStage, result: tool.schema.string().optional(), knowledgeReview: tool.schema.string().optional() }, execute: run((ctx, a, oc) => { const workspace = workspaceFromSession(ctx, a.workspace); const stage = stageFromSession(ctx, workspace, a.stage); return ctx.finish(workspace, stage, sessionFor(ctx, oc, workspace, stage), { result: a.result, knowledgeReview: a.knowledgeReview }); }) });
export const work_context_help = tool({ description: "Show work-context command help.", args: { command: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.help(a.command)) });
export const work_context_list_knowledge = tool({ description: "List durable knowledge entries for a workspace.", args: { workspace: tool.schema.string() }, execute: run((ctx, a) => ctx.listKnowledge(a.workspace)) });
export const work_context_add_knowledge = tool({ description: "Add a durable knowledge entry.", args: { workspace: tool.schema.string(), title: tool.schema.string(), kind: tool.schema.string().optional(), text: tool.schema.string(), sources: tool.schema.array(tool.schema.string()).optional() }, execute: run((ctx, a) => ctx.addKnowledge(a.workspace, a)) });
export const work_context_update_knowledge = tool({ description: "Update a durable knowledge entry.", args: { workspace: tool.schema.string(), knowledgeId: tool.schema.string(), title: tool.schema.string().optional(), kind: tool.schema.string().optional(), status: tool.schema.string().optional(), text: tool.schema.string().optional(), sources: tool.schema.array(tool.schema.string()).optional(), replacement: tool.schema.string().optional() }, execute: run((ctx, a) => ctx.updateKnowledge(a.workspace, a.knowledgeId, a)) });
export const work_context_supersede_knowledge = tool({ description: "Supersede a durable knowledge entry.", args: { workspace: tool.schema.string(), knowledgeId: tool.schema.string(), replacement: tool.schema.string() }, execute: run((ctx, a) => ctx.supersedeKnowledge(a.workspace, a.knowledgeId, a.replacement) ) });

const defaultTools = { work_context_list_workspaces, work_context_workspace_list, work_context_rename_workspace, work_context_set_workspace_mode, work_context_create_candidate, work_context_capture_candidate, work_context_preview_candidate, work_context_show_candidate, work_context_list_candidates, work_context_ready_candidate, work_context_commit_candidate, work_context_inspect_commit_all, work_context_commit_all, work_context_discard_candidate, work_context_read_delivery, work_context_explain_delivery, work_context_doctor_delivery, work_context_mark_delivery, work_context_workspace_finish, work_context_reopen_workspace, work_context_create_workspace, work_context_start_session, work_context_acknowledge_commit, work_context_add_stage, work_context_set_stage_profiles, work_context_refresh_stage_profiles, work_context_show_capability_profiles, work_context_configure_capability_profiles, work_context_reset_capability_profiles, work_context_rename_stage, work_context_update_stage, work_context_update_stage_prompt, work_context_update_stage_result, work_context_read_stage_execution, work_context_replace_stage_execution, work_context_update_stage_execution, work_context_complete_current, work_context_archive_stage, work_context_reopen_stage, work_context_restore_stage, work_context_link_issue, work_context_unlink_issue, work_context_rename_session, work_context_close_session, work_context_force_close_session, work_context_handoff_stage, work_context_abandon_stage, work_context_finish_stage, work_context_help, work_context_list_knowledge, work_context_add_knowledge, work_context_update_knowledge, work_context_supersede_knowledge };

export function createToolDefinitions(options = {}) {
  return { ...defaultTools, work_context_doctor_delivery: createDoctorDeliveryTool(options) };
}

export default defaultTools;
