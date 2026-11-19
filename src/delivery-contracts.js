import { Buffer } from "node:buffer";
import { ERROR_CODES, fail } from "./errors.js";
import { validateDeliverySlices } from "./delivery-slices.js";

export const DELIVERY_EXPLAIN_CONTRACT_VERSION = "1.0";
export const DELIVERY_EXPLAIN_OPERATION = "delivery.explain";
export const DELIVERY_STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const DELIVERY_DIAGNOSTIC_LIMITS = Object.freeze({
  findings: 200,
  affected_paths_per_finding: 100,
  remediation_ids_per_finding: 20,
  stable_id_characters: 128,
  input_path_bytes: 4096,
  commit_subject_bytes: 200,
  secret_path_patterns: 100,
  secret_path_pattern_characters: 256,
  findings_bytes: 1024 * 1024,
  diagnostic_bytes: 4 * 1024 * 1024,
  commits: 500,
  paths: 500,
  provenance_commits_per_path: 50,
  git_output_bytes: 4 * 1024 * 1024,
});

const findingKeys = ["id", "severity", "summary", "affected_paths", "remediation_ids", "recommendation"];
const severities = new Set(["info", "warning", "error"]);
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateDeliveryStableId(value, label = "Stable ID") {
  if (typeof value !== "string" || value.length > DELIVERY_DIAGNOSTIC_LIMITS.stable_id_characters || !DELIVERY_STABLE_ID_PATTERN.test(value)) {
    fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, `${label} is invalid`);
  }
  return value;
}

const validatePath = (value) => {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > DELIVERY_DIAGNOSTIC_LIMITS.input_path_bytes) {
    fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Finding paths must be non-empty bounded strings");
  }
  return value;
};

const validateUniqueList = (value, limit, itemValidator, label) => {
  if (!Array.isArray(value) || value.length > limit) fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, `${label} exceeds its supported limit`);
  const normalized = value.map(itemValidator);
  if (new Set(normalized).size !== normalized.length) fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, `${label} must not contain duplicates`);
  return normalized;
};

export function validateDeliveryFindings(findings = []) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(findings), "utf8"); }
  catch { fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Findings must be JSON-serializable"); }
  if (bytes > DELIVERY_DIAGNOSTIC_LIMITS.findings_bytes) fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Findings exceed the supported 1 MiB limit");
  if (!Array.isArray(findings) || findings.length > DELIVERY_DIAGNOSTIC_LIMITS.findings) fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Findings must be a bounded array");
  const ids = new Set();
  const normalized = findings.map((finding) => {
    if (!plainObject(finding) || !Object.keys(finding).every((key) => findingKeys.includes(key))) fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Finding contains unsupported fields");
    const id = validateDeliveryStableId(finding.id, "Finding ID");
    if (ids.has(id)) fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Finding IDs must be unique", { id });
    ids.add(id);
    if (!severities.has(finding.severity)) fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Finding severity must be info, warning, or error", { id });
    if (typeof finding.summary !== "string" || !finding.summary.trim()) fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Finding summary must be a non-empty string", { id });
    if (finding.recommendation !== undefined && (typeof finding.recommendation !== "string" || !finding.recommendation.trim())) {
      fail(ERROR_CODES.DELIVERY_INVALID_FINDINGS, "Finding recommendation must be a non-empty string", { id });
    }
    return {
      id,
      severity: finding.severity,
      summary: finding.summary.trim(),
      affected_paths: validateUniqueList(finding.affected_paths ?? [], DELIVERY_DIAGNOSTIC_LIMITS.affected_paths_per_finding, validatePath, "Affected paths"),
      remediation_ids: validateUniqueList(finding.remediation_ids ?? [], DELIVERY_DIAGNOSTIC_LIMITS.remediation_ids_per_finding, (value) => validateDeliveryStableId(value, "Remediation ID"), "Remediation IDs"),
      ...(finding.recommendation === undefined ? {} : { recommendation: finding.recommendation.trim() }),
    };
  });
  return normalized;
}

export function deliveryDiagnosticComplete(limits) {
  if (!plainObject(limits)) return false;
  const truncated = (value, key = "") => {
    if ((key === "truncated" || key.endsWith("_truncated")) && value === true) return true;
    return plainObject(value) && Object.entries(value).some(([childKey, child]) => truncated(child, childKey));
  };
  return !Object.entries(limits).some(([key, value]) => truncated(value, key));
}

export function validateDeliveryExplainEnvelope(envelope) {
  const required = ["contract_version", "operation", "immutable_range", "limits", "summary", "paths", "findings", "candidate_traceability", "candidate_slice", "redactions", "complete"];
  if (!plainObject(envelope) || required.some((key) => !(key in envelope))
    || envelope.contract_version !== DELIVERY_EXPLAIN_CONTRACT_VERSION || envelope.operation !== DELIVERY_EXPLAIN_OPERATION
    || typeof envelope.complete !== "boolean" || !plainObject(envelope.immutable_range) || !plainObject(envelope.limits)
    || !plainObject(envelope.summary) || !Array.isArray(envelope.paths) || !Array.isArray(envelope.findings)
    || !plainObject(envelope.candidate_traceability) || !Array.isArray(envelope.candidate_slice) || !plainObject(envelope.redactions)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, "Invalid delivery diagnostic output envelope");
  }
  if (!envelope.complete && envelope.findings.some((finding) => plainObject(finding) && "recommendation" in finding)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, "Incomplete diagnostics cannot contain recommendations");
  }
  if (!envelope.complete && envelope.candidate_slice.length) fail(ERROR_CODES.INVALID_ARGUMENT, "Incomplete diagnostics cannot contain candidate-slice recommendations");
  validateDeliverySlices(envelope.candidate_slice);
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8"); }
  catch { fail(ERROR_CODES.INVALID_ARGUMENT, "Delivery diagnostic output must be JSON-serializable"); }
  if (bytes > DELIVERY_DIAGNOSTIC_LIMITS.diagnostic_bytes) fail(ERROR_CODES.DELIVERY_DIAGNOSTIC_TOO_LARGE, "Delivery diagnostic output exceeds the supported 4 MiB limit");
  return envelope;
}
