import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkContext } from "./core.js";
import { renderTitle } from "./title.js";
export { readStagesSnapshot } from "./stages-snapshot.js";

export function contextFor(directory, sessionId, actor = "OpenCode") {
  return WorkContext.openExisting(directory, { sessionId, actor });
}
export function titleFor(context, workspace, stage, sessionId, knownSession = null) {
  const current = knownSession || context.sessionById(sessionId);
  if (!current) return null;
  const meta = context.storage.readWorkspace(workspace).data;
  const stageMeta = context.storage.readStage(workspace, stage).data;
  return renderTitle({ workspace, workspaceTitle: meta.title, stage, ordinal: current.ordinal, state: current.state, trackerLinks: stageMeta.tracker_links?.length ? stageMeta.tracker_links : meta.tracker_links, issuePrefix: context.storage.config.title?.issue_prefix || "short" });
}
export const packageRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
