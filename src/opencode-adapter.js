import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkContext } from "./core.js";
import { renderTitle } from "./title.js";
export { readStagesSnapshot } from "./stages-snapshot.js";

export function contextFor(directory, sessionId, actor = "OpenCode") {
  return WorkContext.openExisting(directory, { sessionId, actor });
}
export function titleFor(context, workspace, stage, sessionId, knownSession = null, includeStageTrackerLinks = false) {
  const current = knownSession || context.sessionById(sessionId);
  if (!current) return null;
  const meta = context.storage.readWorkspace(workspace).data;
  const stageMeta = context.storage.readStage(workspace, stage).data;
  const workspaceLinks = meta.tracker_links || [];
  const primaryTrackerLinks = stageMeta.tracker_links?.length ? stageMeta.tracker_links : workspaceLinks;
  const stageTrackerLinks = includeStageTrackerLinks
    ? context.listStages(workspace).data.stages.flatMap((item) => item.tracker_links || []).filter((link) => !workspaceLinks.some((workspaceLink) => workspaceLink.url === link.url) && !primaryTrackerLinks.some((primaryLink) => primaryLink.url === link.url))
    : [];
  return renderTitle({ workspace, stageTitle: stageMeta.title, stage, ordinal: current.ordinal, state: current.state, trackerLinks: primaryTrackerLinks, stageTrackerLinks, issuePrefix: context.storage.config.title?.issue_prefix || "short" });
}
export const packageRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
