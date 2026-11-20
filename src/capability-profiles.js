import fs from "node:fs";
import path from "node:path";

export const CAPABILITY_PROFILES = Object.freeze(["routine", "implementation", "architecture", "security", "review"]);
export const CAPABILITY_DEPTHS = Object.freeze(["light", "standard", "deep"]);
export const CAPABILITY_CLASSIFICATIONS = Object.freeze(["inferred", "explicit"]);
export const CAPABILITY_PROFILE_MODES = Object.freeze(["advisory", "off"]);
export const CAPABILITY_MAPPINGS_FILE = "capability-profiles.json";
const MAX_MAPPING_BYTES = 16 * 1024;
const MAX_WARNINGS = 5;

export const capabilityProfileMode = (storage) => storage.config.capability_profiles?.mode || "advisory";

const warning = (message) => ({ code: "INVALID_CAPABILITY_MAPPING", message });
const validTarget = (value) => typeof value === "string"
  && value.length <= 200
  && value.trim() === value
  && value.length > 0
  && !/[\u0000-\u001f\u007f]/.test(value);

export function readCapabilityMappings(storage) {
  const file = path.join(storage.personalRoot, CAPABILITY_MAPPINGS_FILE);
  if (!fs.existsSync(file)) return { mappings: {}, warnings: [] };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_MAPPING_BYTES) return { mappings: {}, warnings: [warning(`Ignoring ${CAPABILITY_MAPPINGS_FILE}; expected a regular file no larger than ${MAX_MAPPING_BYTES} bytes.`)] };
  } catch { return { mappings: {}, warnings: [warning(`Cannot inspect ${CAPABILITY_MAPPINGS_FILE}; continuing without local mappings.`)] }; }
  let input;
  try { input = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { mappings: {}, warnings: [warning(`Invalid ${CAPABILITY_MAPPINGS_FILE}; expected JSON with schema and mappings.`)] }; }

  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema !== 1 || !input.mappings || typeof input.mappings !== "object" || Array.isArray(input.mappings)) {
    return { mappings: {}, warnings: [warning(`Invalid ${CAPABILITY_MAPPINGS_FILE}; expected { "schema": 1, "mappings": { ... } }.`)] };
  }
  const warnings = [];
  const addWarning = (message) => { if (warnings.length < MAX_WARNINGS) warnings.push(warning(message)); };
  if (Object.keys(input).some((key) => !["schema", "mappings"].includes(key))) addWarning(`Ignoring unknown top-level keys in ${CAPABILITY_MAPPINGS_FILE}.`);
  const mappings = {};
  for (const [depth, target] of Object.entries(input.mappings)) {
    const safeDepth = depth.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 40);
    if (!CAPABILITY_DEPTHS.includes(depth)) addWarning(`Ignoring unknown capability depth mapping: ${safeDepth}.`);
    else if (!validTarget(target)) addWarning(`Ignoring invalid target for capability depth mapping: ${depth}.`);
    else mappings[depth] = target;
  }
  return { mappings, warnings };
}

export function capabilityRecommendations(storage, stage, localMappings) {
  if (capabilityProfileMode(storage) === "off") return null;
  if (!stage.execution_profile || !stage.execution_depth) return null;
  const { mappings, warnings } = localMappings || readCapabilityMappings(storage);
  const target = mappings[stage.execution_depth];
  return {
    mode: "advisory",
    execution: target
      ? { profile: stage.execution_profile, depth: stage.execution_depth, classification: stage.execution_classification || "explicit", source: "mapping", target }
      : { profile: stage.execution_profile, depth: stage.execution_depth, classification: stage.execution_classification || "explicit", source: "current", message: "No mapping configured; continuing with the current model." },
    ...(stage.review_profile ? { review: { profile: stage.review_profile } } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export const stageCapabilityProfiles = (storage, stage, localMappings) => {
  if (capabilityProfileMode(storage) !== "advisory") return {};
  const recommendation = capabilityRecommendations(storage, stage, localMappings)?.execution;
  return {
    ...(stage.execution_profile ? { execution_profile: stage.execution_profile } : {}),
    ...(stage.execution_depth ? { execution_depth: stage.execution_depth } : {}),
    ...(stage.execution_classification ? { execution_classification: stage.execution_classification } : {}),
    ...(stage.review_profile ? { review_profile: stage.review_profile } : {}),
    ...(recommendation?.target ? { recommended_model: recommendation.target } : {}),
  };
};

export function validateCapabilityMappings(mappings) {
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings) || Object.keys(mappings).some((key) => !CAPABILITY_DEPTHS.includes(key))) return false;
  return Object.values(mappings).every(validTarget);
}
