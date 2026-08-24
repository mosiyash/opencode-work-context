export function renderTitle({ workspace, stage, ordinal, summary, state = "active", trackerLinks = [], issuePrefix = "short" }) {
  const link = trackerLinks[0]; let prefix = "";
  if (link && issuePrefix !== "none") prefix = issuePrefix === "full" ? `${link.project}#${link.iid} | ` : `GL#${link.iid} | `;
  const suffix = state === "active" ? "" : ` (${state})`;
  return `${prefix}${workspace} ${stage}/${String(ordinal).padStart(2, "0")}${suffix}: ${(summary || "продолжение работы").replace(/[\r\n|]+/g, " ").trim().slice(0, 80)}`;
}
