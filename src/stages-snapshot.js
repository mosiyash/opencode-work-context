import { WorkContext } from "./core.js";

const emptySnapshot = () => ({
  schema: 1,
  workspace: null,
  stages: [],
  currentStage: null,
  generatedAt: new Date().toISOString(),
});

/**
 * Build the TUI read model from canonical metadata and the event stream.
 * openExisting is intentional: this boundary must never initialize storage.
 */
export function readStagesSnapshot({ projectRoot, sessionId }) {
  try {
    const context = WorkContext.openExisting(projectRoot, { sessionId, actor: "OpenCode TUI" });
    let session = sessionId ? context.sessionById(sessionId) : null;
    if (!session && sessionId) {
      for (const workspace of context.listWorkspaces().data) {
        const candidate = context.listStages(workspace.workspace).data.sessions
          .find((item) => item.opencode_session_id === sessionId);
        if (candidate) { session = candidate; break; }
      }
    }
    if (!session) {
      const activeWorkspaces = context.listWorkspaces().data.filter((workspace) => workspace.status === "in_progress");
      if (activeWorkspaces.length === 1) {
        const workspaceStages = context.listStages(activeWorkspaces[0].workspace).data;
        session = workspaceStages.sessions.find((item) => item.state === "active") || null;
        if (!session) session = { workspace: activeWorkspaces[0].workspace, stage: null };
      }
    }
    if (!session) return { ok: true, data: emptySnapshot() };

    const workspace = context.storage.readWorkspace(session.workspace).data;
    const stages = context.listStages(session.workspace).data.stages
      .filter((stage) => stage.status !== "archived")
      .sort((left, right) => Number(left.stage) - Number(right.stage))
      .map((stage) => ({
        id: stage.stage,
        title: stage.title,
        status: stage.status,
        description: stage.description,
        current: stage.stage === session.stage,
      }));
    const currentStage = stages.some((stage) => stage.current) ? session.stage : null;

    return {
      ok: true,
      data: {
        schema: 1,
        workspace: { id: workspace.workspace, title: workspace.title, status: workspace.status },
        stages,
        currentStage,
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    if (error.code === "NOT_FOUND") return { ok: true, data: emptySnapshot() };
    return {
      ok: false,
      error: { code: error.code || "STORAGE_ERROR", message: error.message, details: error.details || {} },
      data: emptySnapshot(),
    };
  }
}
