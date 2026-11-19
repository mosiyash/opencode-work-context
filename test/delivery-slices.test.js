import assert from "node:assert/strict";
import test from "node:test";
import { recommendDeliverySlices, validateDeliverySlices } from "../src/delivery-slices.js";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const finding = (id, paths, unmatched = []) => ({
  id,
  affected_paths: [...paths, ...unmatched],
  matched_paths: paths,
  unmatched_paths: unmatched,
});
const pathEvidence = (path, provenance) => ({ path, provenance });

test("delivery slices classify exact, shared-foundation, and integration evidence deterministically", () => {
  const input = {
    findings: [
      finding("release.integration-a", ["overlap.txt"]),
      finding("release.exact", ["exact.txt"]),
      finding("release.shared-b", ["shared-b.txt"]),
      finding("release.integration-b", ["overlap.txt"]),
      finding("release.shared-a", ["shared-a.txt"]),
    ],
    paths: [
      pathEvidence("shared-b.txt", [commitA]),
      pathEvidence("overlap.txt", [commitB]),
      pathEvidence("exact.txt", [commitB]),
      pathEvidence("shared-a.txt", [commitA]),
    ],
    candidate_traceability: {
      candidates: [{ candidate: "CC-000002", strategy: "integration", paths: ["exact.txt"], commits: [commitB] }],
      direct_commits: [commitA],
    },
  };
  const first = recommendDeliverySlices(input);
  const second = recommendDeliverySlices({ ...input, findings: [...input.findings].reverse(), paths: [...input.paths].reverse() });

  assert.deepEqual(second, first);
  assert.deepEqual(first.map(({ strategy, confidence, finding_references }) => ({ strategy, confidence, finding_references })), [
    { strategy: "exact", confidence: 1, finding_references: ["release.exact"] },
    { strategy: "shared_foundation", confidence: 0.8, finding_references: ["release.shared-a", "release.shared-b"] },
    { strategy: "integration", confidence: 0.6, finding_references: ["release.integration-a", "release.integration-b"] },
  ]);
  assert.deepEqual(first[0].candidate_references, ["CC-000002"]);
  assert.equal(first[0].strategy, "exact");
  assert.deepEqual(first[1].commit_references, [commitA]);
  assert.equal(first.every((slice) => slice.requires_user_decision), true);
  assert.equal(first.some((slice) => slice.candidate_references.includes("CC-000001")), false);
  validateDeliverySlices(first);
});

test("delivery slices omit unmatched and ambiguous evidence without blocking independent matches", () => {
  const slices = recommendDeliverySlices({
    findings: [
      finding("release.ambiguous", ["blocked.txt"], ["missing.txt"]),
      finding("release.blocked", ["blocked.txt"]),
      finding("release.independent", ["independent.txt"]),
      finding("release.weak", []),
    ],
    paths: [pathEvidence("blocked.txt", [commitA]), pathEvidence("independent.txt", [commitB])],
  });
  assert.deepEqual(slices.map((slice) => slice.finding_references), [["release.independent"]]);
});

test("delivery slice references preserve opaque redacted paths", () => {
  const token = "<redacted:path-0001>";
  const slices = recommendDeliverySlices({
    findings: [finding("release.redacted", [token])],
    paths: [pathEvidence(token, [commitA])],
  });
  assert.deepEqual(slices[0].path_references, [token]);
  assert.doesNotMatch(JSON.stringify(slices), /secret\/private\.txt/u);
});
