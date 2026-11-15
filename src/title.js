const trackerLinkText = (link) => {
  const identifier = link.key || link.iid;
  if ((link.provider || "gitlab") === "gitlab") return `GL#${identifier}`;
  if (link.provider === "github") return `GH#${identifier}`;
  return `JIRA ${identifier}`;
};

export function renderTitle({ workspace, stageTitle, stage, ordinal, state = "active", trackerLinks = [], stageTrackerLinks = [], issuePrefix = "short" }) {
  const link = trackerLinks[0]; let prefix = "";
  if (link && issuePrefix !== "none") {
    const identifier = link.key || link.iid;
    const short = trackerLinkText(link);
    prefix = issuePrefix === "full" ? `${link.project}#${identifier} | ` : `${short} | `;
  }
  const suffix = state === "active" ? "" : ` (${state})`;
  const description = (stageTitle || stage).replace(/[\r\n|]+/g, " ").trim().slice(0, 80);
  const taskLinks = [...new Map(stageTrackerLinks.map((item) => [item.url, item])).values()];
  const tasks = taskLinks.length ? `\nTasks: ${taskLinks.map(trackerLinkText).join(", ")}` : "";
  return `${description}\n${prefix}${workspace} ${stage}/${String(ordinal).padStart(2, "0")}${suffix}${tasks}`;
}
