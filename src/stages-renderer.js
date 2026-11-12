const statusMarker = (status) => ({
  planned: "[ ]",
  in_progress: "[•]",
  completed: "[✓]",
  cancelled: "[!]",
  archived: "[-]",
}[status] || "[?]");

const compareStageIds = (left, right) => Number(left.id) - Number(right.id);

/**
 * Render normalized stages as a dependency-to-dependent forest. A stage may
 * appear more than once when multiple dependency paths reach the same join.
 */
export function renderDependencyTree(stages, { compact = false, maxTitleLength } = {}) {
  const sortedStages = [...stages].sort(compareStageIds);
  const byId = new Map(sortedStages.map((stage) => [stage.id, stage]));
  const dependents = new Map(sortedStages.map((stage) => [stage.id, []]));

  for (const stage of sortedStages) {
    for (const dependency of stage.depends_on || []) {
      dependents.get(dependency)?.push(stage);
    }
  }
  for (const children of dependents.values()) children.sort(compareStageIds);

  const roots = sortedStages.filter((stage) => !(stage.depends_on || []).some((dependency) => byId.has(dependency)));
  const lines = [];
  const branchCharacters = compact
    ? { tee: "+- ", last: "\\- ", vertical: "|  ", space: "   " }
    : { tee: "├─ ", last: "└─ ", vertical: "│  ", space: "   " };
  const stageTitle = (title) => maxTitleLength && title.length > maxTitleLength
    ? `${title.slice(0, Math.max(1, maxTitleLength - 3))}...`
    : title;
  const render = (stage, prefix, branch, ancestors) => {
    const cycle = ancestors.has(stage.id);
    lines.push(`${prefix}${branch}${statusMarker(stage.status)} ${stage.id}. ${stageTitle(stage.title)}${cycle ? " [cycle]" : ""}`);
    if (cycle) return;

    const children = dependents.get(stage.id) || [];
    const nextAncestors = new Set(ancestors).add(stage.id);
    children.forEach((child, index) => {
      const last = index === children.length - 1;
      render(child, `${prefix}${branch ? (branch === branchCharacters.last ? branchCharacters.space : branchCharacters.vertical) : ""}`, last ? branchCharacters.last : branchCharacters.tee, nextAncestors);
    });
  };

  for (const root of roots.length ? roots : sortedStages.slice(0, 1)) render(root, "", "", new Set());
  return lines.join("\n");
}

export function renderStagesPanel(result) {
  if (!result?.ok) return `work-context stages\n! unavailable: ${result?.error?.code || "STORAGE_ERROR"}`;
  const snapshot = result.data;
  if (!snapshot.workspace) return `work-context stages\n(no workspace for this session)${result.stale ? `\n! stale: ${result.error?.code || "STORAGE_ERROR"}` : ""}`;

  const lines = [
    snapshot.workspace.title,
    "",
    `Stages · ${snapshot.workspace.status}`,
  ];
  for (const stage of snapshot.stages) {
    lines.push(`${statusMarker(stage.status)} ${stage.id}. ${stage.title}${stage.depends_on?.length ? `\nDeps: ${stage.depends_on.join(", ")}` : ""}`);
  }
  if (result.stale) lines.push(`! stale: ${result.error?.code || "STORAGE_ERROR"}`);
  return lines.join("\n");
}
