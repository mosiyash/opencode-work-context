const statusMarker = (status) => ({
  planned: "[ ]",
  in_progress: "[•]",
  completed: "[✓]",
  cancelled: "[!]",
  archived: "[-]",
}[status] || "[?]");

const compareStageIds = (left, right) => Number(left.id) - Number(right.id);
const candidateSummary = (stage) => {
  const projection = stage.candidates;
  if (!projection || !(projection.draft || projection.ready)) return null;
  if (projection.draft + projection.ready > 1) return `Pending: ${projection.draft} draft · ${projection.ready} ready`;
  const [candidate] = projection.items;
  const others = candidate.related_stages.filter((related) => related !== stage.id);
  return `Pending: ${candidate.status} · ${candidate.strategy}${others.length ? ` · also ${others.join(", ")}` : ""}`;
};
const deliverySummary = (delivery) => {
  if (!delivery) return null;
  if (delivery.unavailable) return "Delivery · unavailable";
  if (delivery.plan_needed) return `Delivery · ${delivery.committed} commits · plan needed`;
  if (delivery.environments.length === 1) {
    const [environment] = delivery.environments;
    return `Delivery · ${environment.environment} · ${environment.pending} tracked pending`;
  }
  const pending = delivery.environments.reduce((total, environment) => total + environment.pending, 0);
  return `Delivery · ${delivery.environments.length} environments · ${pending} tracked pending`;
};
const profileSummary = (stage) => {
  const profiles = [stage.execution_profile && `execution ${stage.execution_profile}`, stage.review_profile && `review ${stage.review_profile}`].filter(Boolean);
  return profiles.length ? `Profiles: ${profiles.join(" · ")}` : null;
};

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
    `Workflow · ${snapshot.workspace.mode || "standard"}`,
  ];
  const candidates = snapshot.workspace.candidates;
  if (candidates && (candidates.pending || candidates.ready)) lines.push(`Candidates · ${candidates.pending} draft · ${candidates.ready} ready`);
  const delivery = deliverySummary(snapshot.workspace.delivery);
  if (delivery) lines.push(delivery);
  lines.push("", `Stages · ${snapshot.workspace.status}`);
  for (const stage of snapshot.stages) {
    const pending = candidateSummary(stage);
    const profiles = profileSummary(stage);
    lines.push(`${statusMarker(stage.status)} ${stage.id}. ${stage.title}${profiles ? `\n${profiles}` : ""}${stage.depends_on?.length ? `\nDeps: ${stage.depends_on.join(", ")}` : ""}${pending ? `\n${pending}` : ""}`);
  }
  if (result.stale) lines.push(`! stale: ${result.error?.code || "STORAGE_ERROR"}`);
  return lines.join("\n");
}
