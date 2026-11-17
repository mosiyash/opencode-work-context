import { WorkContext } from "./core.js";

const emptySnapshot = () => ({
  schema: 1,
  workspaces: [],
  currentWorkspace: null,
  currentStage: null,
  generatedAt: new Date().toISOString(),
});

const errorResult = (error) => ({
  ok: false,
  error: {
    code: error?.code || "STORAGE_ERROR",
    message: error?.message || "Cannot read work-context storage",
    details: error?.details || {},
  },
  data: emptySnapshot(),
});

const sessionFor = (context, sessionId) => {
  if (!sessionId) return null;
  return context.sessionById(sessionId)
    || context.sessionByOpenCodeId(sessionId, null, null, null);
};

const readWorkspace = (context, record, currentSession) => {
  const listed = context.listStages(record.workspace).data;
  const sessions = listed.sessions;
  const matchingSession = currentSession?.workspace === record.workspace
    ? currentSession
    : sessions.find((session) => session.session_id === currentSession?.session_id);
  const currentStage = matchingSession?.stage || null;
  const mode = record.mode || "standard";
  const candidateProjection = mode === "startup" ? context.candidates().activeProjection(record.workspace) : null;
  const deliveryProjection = context.deliveries().projection(record.workspace);
  const delivery = deliveryProjection.committed.count || deliveryProjection.environments.length || deliveryProjection.unavailable
    ? { committed: deliveryProjection.committed.count, plan_needed: deliveryProjection.plan_needed, environments: deliveryProjection.environments, ...(deliveryProjection.unavailable ? { unavailable: true } : {}) }
    : null;
  const visibleStages = listed.stages
    .filter((stage) => stage.status !== "archived")
    .sort((left, right) => Number(left.stage) - Number(right.stage));
  const visibleStageIds = new Set(visibleStages.map((stage) => stage.stage));
  return {
    id: record.workspace,
    title: record.title,
    status: record.status,
    mode,
    ...(candidateProjection ? { candidates: candidateProjection.summary } : {}),
    ...(delivery ? { delivery } : {}),
    stages: visibleStages
      .map((stage) => ({
        id: stage.stage,
        title: stage.title,
        status: stage.status,
        description: stage.description,
        depends_on: stage.depends_on.filter((dependency) => visibleStageIds.has(dependency)),
        tracker_links: stage.tracker_links || [],
        ...(candidateProjection?.by_stage[stage.stage] ? { candidates: candidateProjection.by_stage[stage.stage] } : {}),
        current: stage.stage === currentStage,
      })),
    currentStage,
    sessions,
    activeSession: sessions.find((session) => session.state === "active") || null,
  };
};

/** Read all canonical metadata without initializing or projecting storage. */
export function readWorkContextSnapshot({ projectRoot, sessionId } = {}) {
  try {
    const context = WorkContext.openExisting(projectRoot, { sessionId, actor: "OpenCode TUI" });
    const currentSession = sessionFor(context, sessionId);
    const workspaces = context.listWorkspaces().data
      .sort((left, right) => left.workspace.localeCompare(right.workspace))
      .map((record) => readWorkspace(context, record, currentSession));
    const currentWorkspace = currentSession?.workspace
      && workspaces.some((workspace) => workspace.id === currentSession.workspace)
      ? currentSession.workspace
      : null;
    return {
      ok: true,
      data: {
        schema: 1,
        workspaces,
        currentWorkspace,
        currentStage: currentWorkspace
          ? workspaces.find((workspace) => workspace.id === currentWorkspace)?.currentStage || null
          : null,
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return errorResult(error);
  }
}
