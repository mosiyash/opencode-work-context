import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./storage.js";
export function renderIndex(workspaces) {
  const rows = workspaces.map(({ data }) => `| ${data.workspace} | ${data.title} | ${data.status} | ${data.updated_at} |`).join("\n");
  return `# Work Context\n\n| Workspace | Title | Status | Updated |\n|---|---|---|---|\n${rows || "| - | No workspaces | - | - |"}\n`;
}
export function renderSessions(sessions) {
  const rows = sessions.map((s) => `| ${s.ordinal} | ${s.stage} | ${s.summary || ""} | ${s.state} | ${s.updated_at || ""} |`).join("\n");
  return `# Sessions\n\n| # | Stage | Summary | State | Updated |\n|---:|---:|---|---|---|\n${rows || "| - | - | No sessions | - | - |"}\n`;
}
export function generateProjections(storage) {
  const dirs = fs.existsSync(storage.root) ? fs.readdirSync(storage.root, { withFileTypes: true }).filter((item) => item.isDirectory() && /^\d{6}$/.test(item.name)) : [];
  const workspaces = dirs.map((item) => storage.readWorkspace(item.name));
  atomicWrite(path.join(storage.root, "INDEX.md"), renderIndex(workspaces));
  atomicWrite(path.join(storage.personalRoot, "SESSIONS.md"), renderSessions(sessionsFor(storage)));
}
export const sessionsFor = (storage) => {
  const byId = new Map();
  for (const event of storage.readEvents()) {
    const current = byId.get(event.session_id) || { session_id: event.session_id, stage: event.stage, ordinal: event.ordinal, summary: "", state: "" };
    if (event.event === "session.started") Object.assign(current, event.data, { state: "active" });
    if (event.event === "session.renamed") current.summary = event.data.summary;
    if (event.event === "session.handed_off") current.state = "handed_off";
    if (event.event === "session.closed") current.state = "closed";
    if (event.event === "session.abandoned") current.state = "abandoned";
    current.updated_at = event.occurred_at; byId.set(event.session_id, current);
  }
  return [...byId.values()];
};
