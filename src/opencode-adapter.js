import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkContext } from "./core.js";
import { WORK_CONTEXT_PROTOCOL, WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH } from "./protocol.js";
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

export function runtimeSelfReport(projectRoot) {
  const root = packageRoot();
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); } catch {}
  const project = path.resolve(projectRoot);
  const localRoots = [path.join(project, "node_modules"), path.join(project, ".opencode", "node_modules")];
  const moduleOrigin = localRoots.some((candidate) => root === candidate || root.startsWith(`${candidate}${path.sep}`))
    ? "project_local"
    : root.endsWith(`${path.sep}opencode-work-context`) && root.includes(`${path.sep}.cache${path.sep}`)
      ? "managed_cache"
      : "package_source";
  return {
    evidence_kind: "self_reported",
    package_name: manifest.name,
    package_version: manifest.version,
    module_origin: moduleOrigin,
    protocol: {
      ...WORK_CONTEXT_PROTOCOL,
      descriptor_hash: WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH,
    },
  };
}
