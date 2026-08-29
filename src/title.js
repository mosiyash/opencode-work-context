export function renderTitle({ workspace, workspaceTitle, stage, ordinal, state = "active", trackerLinks = [], issuePrefix = "short" }) {
  const link = trackerLinks[0]; let prefix = "";
  if (link && issuePrefix !== "none") prefix = issuePrefix === "full" ? `${link.project}#${link.iid} | ` : `GL#${link.iid} | `;
  const suffix = state === "active" ? "" : ` (${state})`;
  return `${prefix}${workspace} ${stage}/${String(ordinal).padStart(2, "0")}${suffix}: ${(workspaceTitle || workspace).replace(/[\r\n|]+/g, " ").trim().slice(0, 80)}`;
}
