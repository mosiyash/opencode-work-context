import fs from "node:fs";
import path from "node:path";

export const CAPABILITY_PROFILES = Object.freeze(["routine", "implementation", "architecture", "security", "review"]);
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
  for (const [profile, target] of Object.entries(input.mappings)) {
    const safeProfile = profile.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 40);
    if (!CAPABILITY_PROFILES.includes(profile)) addWarning(`Ignoring unknown capability mapping: ${safeProfile}.`);
    else if (!validTarget(target)) addWarning(`Ignoring invalid target for capability mapping: ${profile}.`);
    else mappings[profile] = target;
  }
  return { mappings, warnings };
}

export function capabilityRecommendations(storage, stage) {
  if (capabilityProfileMode(storage) === "off") return null;
  const declared = [
    ["execution", stage.execution_profile],
    ["review", stage.review_profile],
  ].filter(([, profile]) => profile);
  if (!declared.length) return null;
  const { mappings, warnings } = readCapabilityMappings(storage);
  const recommendations = Object.fromEntries(declared.map(([kind, profile]) => {
    const target = mappings[profile];
    return [kind, target
      ? { profile, source: "mapping", target }
      : { profile, source: "current", message: "No mapping configured; continuing with the current model." }];
  }));
  return { mode: "advisory", ...recommendations, ...(warnings.length ? { warnings } : {}) };
}

export const stageCapabilityProfiles = (storage, stage) => capabilityProfileMode(storage) === "advisory"
  ? {
      ...(stage.execution_profile ? { execution_profile: stage.execution_profile } : {}),
      ...(stage.review_profile ? { review_profile: stage.review_profile } : {}),
    }
  : {};
