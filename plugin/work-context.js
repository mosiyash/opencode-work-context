import tools from "../src/tool-definitions.js";
import { contextFor, titleFor } from "../src/opencode-adapter.js";

export default async ({ client, directory, worktree }) => ({
  tool: tools,
  event: async ({ event }) => {
    if (event.type !== "session.updated") return;
    const info = event.properties?.info;
    const sessionId = info?.id || event.properties?.sessionID;
    const eventDirectory = info?.directory || directory;
    const context = contextFor(worktree || eventDirectory, sessionId);
    const session = context.sessionById(sessionId);
    if (!session) return;
    const title = titleFor(context, session.workspace, session.stage, sessionId, session);
    if (title) {
      const current = await client.session.get({ path: { id: sessionId }, query: { directory: eventDirectory } });
      const session = current.data ?? current;
      if (session.title !== title) await client.session.update({ path: { id: sessionId }, query: { directory: eventDirectory }, body: { title } });
    }
  },
});
