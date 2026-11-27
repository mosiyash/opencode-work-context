import path from "node:path";
import {
  CAPABILITY_DEPTHS,
  CONFIG_FILE_NAME,
  assertValidMappings,
  configureGlobal,
  configureProject,
  globalConfigPath,
  projectConfigPath,
  readConfigFile,
  readProfiles,
  resetConfigFile,
  resetGlobal,
  resetProject,
  resolveDepth,
  writeConfigFile,
} from "opencode-capability-profiles";

export const CAPABILITY_PROFILES = Object.freeze(["routine", "implementation", "architecture", "security", "review"]);
export { CAPABILITY_DEPTHS };
export const CAPABILITY_CLASSIFICATIONS = Object.freeze(["inferred", "explicit"]);
export const CAPABILITY_PROFILE_MODES = Object.freeze(["advisory", "off"]);
export const CAPABILITY_MAPPINGS_FILE = CONFIG_FILE_NAME;

export const capabilityProfileMode = (storage) => storage.config.capability_profiles?.mode || "advisory";

const legacyWarning = (file) => ({
  code: "LEGACY_CAPABILITY_MAPPING",
  message: `Legacy capability mappings detected at ${file}; migrate them to the shared global or project configuration.`,
  path: file,
});

export function readCapabilityMappings(storage, options = {}) {
  const profiles = readProfiles({
    projectRoot: storage.projectRoot,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  const legacyFile = path.join(storage.personalRoot, CAPABILITY_MAPPINGS_FILE);
  const legacy = readConfigFile(legacyFile);
  return {
    mappings: { ...legacy.mappings, ...profiles.global.mappings, ...(profiles.project?.mappings || {}) },
    warnings: [
      ...profiles.warnings,
      ...legacy.warnings,
      ...(legacy.exists && legacy.warnings.length === 0 ? [legacyWarning(legacyFile)] : []),
    ],
    global: profiles.global,
    project: profiles.project,
    legacy,
  };
}

export function capabilityRecommendations(storage, stage, localMappings) {
  if (capabilityProfileMode(storage) === "off") return null;
  if (!stage.execution_profile || !stage.execution_depth) return null;
  const loaded = localMappings || readCapabilityMappings(storage);
  const resolution = resolveDepth({ depth: stage.execution_depth, projectMappings: loaded.mappings });
  return {
    mode: "advisory",
    execution: resolution.target
      ? { profile: stage.execution_profile, depth: stage.execution_depth, classification: stage.execution_classification || "explicit", source: "mapping", target: resolution.target }
      : { profile: stage.execution_profile, depth: stage.execution_depth, classification: stage.execution_classification || "explicit", source: "current", message: "No mapping configured; continuing with the current model." },
    ...(stage.review_profile ? { review: { profile: stage.review_profile } } : {}),
    ...(loaded.warnings.length ? { warnings: loaded.warnings } : {}),
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
  try {
    assertValidMappings(mappings);
    return true;
  } catch {
    return false;
  }
}

export function configureCapabilityMappings(storage, mappings, options = {}) {
  if (options.scope === "global") {
    configureGlobal(mappings, options.homeDir ? { homeDir: options.homeDir } : {});
    return globalConfigPath(options.homeDir);
  }
  if (options.scope === "project") {
    configureProject(storage.projectRoot, mappings);
    return projectConfigPath(storage.projectRoot);
  }
  const legacyFile = path.join(storage.personalRoot, CAPABILITY_MAPPINGS_FILE);
  writeConfigFile(legacyFile, mappings, { mode: 0o600 });
  return legacyFile;
}

export function resetCapabilityMappings(storage, options = {}) {
  if (options.scope === "global") {
    return { removed: resetGlobal(options.homeDir ? { homeDir: options.homeDir } : {}), file: globalConfigPath(options.homeDir) };
  }
  if (options.scope === "project") return { removed: resetProject(storage.projectRoot), file: projectConfigPath(storage.projectRoot) };
  const legacyFile = path.join(storage.personalRoot, CAPABILITY_MAPPINGS_FILE);
  return { removed: resetConfigFile(legacyFile), file: legacyFile };
}
