const statusMarker = (status) => ({
  planned: "[ ]",
  in_progress: "[•]",
  completed: "[✓]",
  cancelled: "[!]",
  archived: "[-]",
}[status] || "[?]");

export function renderStagesPanel(result) {
  if (!result?.ok) return `work-context stages\n! unavailable: ${result?.error?.code || "STORAGE_ERROR"}`;
  const snapshot = result.data;
  if (!snapshot.workspace) return `work-context stages\n(no workspace for this session)${result.stale ? `\n! stale: ${result.error?.code || "STORAGE_ERROR"}` : ""}`;

  const lines = [
    `Stages · ${snapshot.workspace.status}`,
  ];
  for (const stage of snapshot.stages) {
    lines.push(`${statusMarker(stage.status)} ${stage.id}. ${stage.title}`);
  }
  if (result.stale) lines.push(`! stale: ${result.error?.code || "STORAGE_ERROR"}`);
  return lines.join("\n");
}
