import { ERROR_CODES, fail } from "./errors.js";

const strategies = new Set(["exact", "shared_foundation", "integration"]);
const confidenceByStrategy = Object.freeze({ exact: 1, shared_foundation: 0.8, integration: 0.6 });
const strategyOrder = Object.freeze({ exact: 0, shared_foundation: 1, integration: 2 });
const stableIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const candidatePattern = /^CC-\d{6}$/;
const commitPattern = /^[0-9a-f]{40,64}$/;
const referenceLimits = Object.freeze({ paths: 500, findings: 200, rationale: 4, candidates: 500, commits: 500, slices: 200 });
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sortedUnique = (values) => [...new Set(values)].sort(compareText);
const intersects = (left, right) => left.some((value) => right.has(value));

function components(items, connected) {
  const parents = items.map((_, index) => index);
  const root = (index) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const union = (left, right) => {
    left = root(left);
    right = root(right);
    if (left !== right) parents[right] = left;
  };
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (connected(items[left], items[right])) union(left, right);
    }
  }
  const groups = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(items[index]);
  }
  return [...groups.values()];
}

function candidateReferences(paths, commits, traceability) {
  const pathSet = new Set(paths);
  const commitSet = new Set(commits);
  return sortedUnique((traceability?.candidates || [])
    .filter((candidate) => intersects(candidate.paths || [], pathSet) || intersects(candidate.commits || [], commitSet))
    .map((candidate) => candidate.candidate));
}

function recommendation(strategy, findings, pathEvidence, traceability, sharedCommits = []) {
  const pathReferences = sortedUnique(findings.flatMap((finding) => finding.matched_paths));
  const allCommits = sortedUnique(pathReferences.flatMap((path) => pathEvidence.get(path)?.provenance || []));
  const candidateRefs = candidateReferences(pathReferences, allCommits, traceability);
  const rationale = {
    exact: "delivery.slice.exact_path_match",
    shared_foundation: "delivery.slice.shared_commit_provenance",
    integration: "delivery.slice.overlapping_finding_paths",
  }[strategy];
  return {
    strategy,
    confidence: confidenceByStrategy[strategy],
    path_references: pathReferences,
    finding_references: findings.map((finding) => finding.id).sort(compareText),
    rationale_ids: [rationale, ...(candidateRefs.length ? ["delivery.slice.candidate_traceability"] : [])].sort(compareText),
    candidate_references: candidateRefs,
    commit_references: sortedUnique(sharedCommits),
    requires_user_decision: true,
  };
}

export function recommendDeliverySlices({ findings = [], paths = [], candidate_traceability: traceability = {} } = {}) {
  const pathEvidence = new Map(paths.map((item) => [item.path, item]));
  const ambiguousPaths = new Set(findings
    .filter((finding) => !Array.isArray(finding.matched_paths) || !Array.isArray(finding.unmatched_paths)
      || finding.unmatched_paths.length > 0 || finding.matched_paths.length !== finding.affected_paths?.length)
    .flatMap((finding) => finding.matched_paths || []));
  const eligible = findings.filter((finding) => Array.isArray(finding.matched_paths) && finding.matched_paths.length > 0
    && Array.isArray(finding.unmatched_paths) && finding.unmatched_paths.length === 0
    && finding.matched_paths.length === finding.affected_paths?.length
    && finding.matched_paths.every((item) => pathEvidence.has(item) && !ambiguousPaths.has(item)));

  const pathGroups = components(eligible, (left, right) => intersects(left.matched_paths, new Set(right.matched_paths)));
  const recommendations = pathGroups.filter((group) => group.length > 1)
    .map((group) => recommendation("integration", group, pathEvidence, traceability));
  const separable = pathGroups.filter((group) => group.length === 1).map(([finding]) => ({
    finding,
    commits: new Set(finding.matched_paths.flatMap((item) => pathEvidence.get(item).provenance || [])),
  }));
  const provenanceGroups = components(separable, (left, right) => intersects([...left.commits], right.commits));
  for (const group of provenanceGroups) {
    if (group.length === 1) {
      recommendations.push(recommendation("exact", [group[0].finding], pathEvidence, traceability));
      continue;
    }
    const commitCounts = new Map();
    for (const item of group) for (const commit of item.commits) commitCounts.set(commit, (commitCounts.get(commit) || 0) + 1);
    const sharedCommits = [...commitCounts].filter(([, count]) => count > 1).map(([commit]) => commit);
    recommendations.push(recommendation("shared_foundation", group.map((item) => item.finding), pathEvidence, traceability, sharedCommits));
  }
  return recommendations.sort((left, right) => strategyOrder[left.strategy] - strategyOrder[right.strategy]
    || compareText(left.finding_references[0], right.finding_references[0])
    || compareText(left.path_references[0], right.path_references[0]));
}

const validSortedUnique = (values, limit, validator) => Array.isArray(values) && values.length <= limit
  && values.every(validator) && new Set(values).size === values.length
  && values.every((value, index) => index === 0 || compareText(values[index - 1], value) < 0);

export function validateDeliverySlices(slices) {
  const keys = ["strategy", "confidence", "path_references", "finding_references", "rationale_ids", "candidate_references", "commit_references", "requires_user_decision"];
  const valid = Array.isArray(slices) && slices.length <= referenceLimits.slices && slices.every((slice) => slice && typeof slice === "object" && !Array.isArray(slice)
    && Object.keys(slice).length === keys.length && keys.every((key) => Object.hasOwn(slice, key))
    && strategies.has(slice.strategy) && slice.confidence === confidenceByStrategy[slice.strategy]
    && slice.requires_user_decision === true
    && validSortedUnique(slice.path_references, referenceLimits.paths, (value) => typeof value === "string" && value.length > 0)
    && slice.path_references.length > 0
    && validSortedUnique(slice.finding_references, referenceLimits.findings, (value) => typeof value === "string" && stableIdPattern.test(value))
    && slice.finding_references.length > 0
    && validSortedUnique(slice.rationale_ids, referenceLimits.rationale, (value) => typeof value === "string" && stableIdPattern.test(value))
    && slice.rationale_ids.length > 0
    && validSortedUnique(slice.candidate_references, referenceLimits.candidates, (value) => typeof value === "string" && candidatePattern.test(value))
    && validSortedUnique(slice.commit_references, referenceLimits.commits, (value) => typeof value === "string" && commitPattern.test(value)));
  if (!valid) fail(ERROR_CODES.INVALID_ARGUMENT, "Invalid delivery candidate-slice recommendations");
  return slices;
}
