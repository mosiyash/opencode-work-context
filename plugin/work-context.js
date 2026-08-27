import tools from "../src/tool-definitions.js";
import { contextFor, titleFor } from "../src/opencode-adapter.js";

export default async ({ client, directory, worktree }) => ({
  tool: tools,
  "tool.execute.after": async ({ tool, sessionID }) => {
    if (!tool?.startsWith("work_context_") || !sessionID) return;
    await updateSessionTitle(client, worktree || directory, directory, sessionID);
  },
  event: async ({ event }) => {
    if (event.type !== "session.updated") return;
    const info = event.properties?.info;
    const sessionId = info?.id || event.properties?.sessionID;
    const eventDirectory = info?.directory || directory;
    try {
      await updateSessionTitle(client, worktree || eventDirectory, eventDirectory, sessionId);
    } catch {
      // A malformed or unavailable work-context must not break the server hook.
    }
  },
});

async function updateSessionTitle(client, projectRoot, directory, sessionId) {
  try {
    const context = contextFor(projectRoot, sessionId);
    const session = context.sessionById(sessionId);
    if (!session) return;
    const title = titleFor(context, session.workspace, session.stage, sessionId, session);
    if (!title) return;
    const current = await client.session.get({ path: { id: sessionId }, query: { directory } });
    const currentSession = current.data ?? current;
    if (currentSession.title !== title) await client.session.update({ path: { id: sessionId }, query: { directory }, body: { title } });
  } catch {
    // Storage/API failures must not break tool execution or the server hook.
  }
}
