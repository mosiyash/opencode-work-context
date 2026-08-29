export function renderTitle({ workspace, workspaceTitle, stage, ordinal, state = "active", trackerLinks = [], issuePrefix = "short" }) {
  const link = trackerLinks[0]; let prefix = "";
  if (link && issuePrefix !== "none") {
    const identifier = link.key || link.iid;
    const short = (link.provider || "gitlab") === "gitlab" ? `GL#${identifier}` : link.provider === "github" ? `GH#${identifier}` : `JIRA ${identifier}`;
    prefix = issuePrefix === "full" ? `${link.project}#${identifier} | ` : `${short} | `;
  }
  const suffix = state === "active" ? "" : ` (${state})`;
  return `${prefix}${workspace} ${stage}/${String(ordinal).padStart(2, "0")}${suffix}\n${(workspaceTitle || workspace).replace(/[\r\n|]+/g, " ").trim().slice(0, 80)}`;
}
