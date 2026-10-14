const DEPENDENCY_SATISFIED_STATUSES = new Set(["completed", "archived"]);

export const isDependencySatisfied = (stage) => DEPENDENCY_SATISFIED_STATUSES.has(stage?.status);
