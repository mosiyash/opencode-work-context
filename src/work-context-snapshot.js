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
  return {
    id: record.workspace,
    title: record.title,
    status: record.status,
    stages: listed.stages
      .filter((stage) => stage.status !== "archived")
      .sort((left, right) => Number(left.stage) - Number(right.stage))
      .map((stage) => ({
        id: stage.stage,
        title: stage.title,
        status: stage.status,
        description: stage.description,
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
