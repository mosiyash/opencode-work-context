import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CAPABILITY_DEPTHS, CAPABILITY_PROFILES, WorkContext, defaultConfig, loadConfig, readStagesSnapshot, readWorkContextSnapshot, renderStagesPanel } from "../src/index.js";
import tools, { work_context_configure_capability_profiles, work_context_refresh_stage_profiles, work_context_reset_capability_profiles, work_context_set_stage_profiles, work_context_show_capability_profiles } from "../src/tool-definitions.js";

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "work-context-capabilities-"));
const removeRoot = (root) => fs.rmSync(root, { recursive: true, force: true });
const configFile = (root) => path.join(root, ".work-context", "config.yaml");
const mappingFile = (context) => path.join(context.storage.personalRoot, "capability-profiles.json");
const createStage = (context, options = {}) => {
  context.createWorkspace("Capability workspace", { workspace: "900001", sessionId: "planning" });
  context.handoff("900001", "01", "planning");
  return context.addStage("900001", "Implementation", { prompt: "Implement and verify the change.", ...options });
};

test("capability profile configuration defaults to advisory and validates strictly", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    assert.equal(context.storage.config.capability_profiles.mode, "advisory");
    assert.equal(loadConfig(root).capability_profiles.mode, "advisory");
    fs.writeFileSync(configFile(root), `${defaultConfig()}capability_profiles:\n  mode: off\n`);
    assert.equal(loadConfig(root).capability_profiles.mode, "off");
    fs.writeFileSync(configFile(root), `${defaultConfig()}capability_profiles:\n  mode: automatic\n`);
    assert.throws(() => loadConfig(root), /Invalid work-context config/);
    fs.writeFileSync(configFile(root), `${defaultConfig()}capability_profiles:\n  mode: advisory\n  provider: forbidden\n`);
    assert.throws(() => loadConfig(root), /Invalid work-context config/);
  } finally { removeRoot(root); }
});

test("stage classifications validate every capability and depth exactly", () => {
  for (const [index, profile] of CAPABILITY_PROFILES.entries()) {
    const root = makeRoot();
    try {
      const context = WorkContext.open(root);
      const depth = CAPABILITY_DEPTHS[index % CAPABILITY_DEPTHS.length];
      createStage(context, { executionProfile: profile, executionDepth: depth, classification: "inferred", reviewProfile: profile });
      const stage = context.storage.readStage("900001", "02").data;
      assert.equal(stage.execution_profile, profile);
      assert.equal(stage.execution_depth, depth);
      assert.equal(stage.execution_classification, "inferred");
      assert.equal(stage.review_profile, profile);
      assert.throws(() => context.addStage("900001", `Invalid ${index}`, { executionProfile: profile.toUpperCase(), executionDepth: depth }), (error) => error.code === "INVALID_ARGUMENT");
      assert.throws(() => context.addStage("900001", `Missing ${index}`, { executionProfile: profile }), (error) => error.code === "INVALID_ARGUMENT");
    } finally { removeRoot(root); }
  }
});

test("canonical storage reads legacy profile-only metadata but rejects ambiguous partial tuples", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    createStage(context, { executionProfile: "implementation", executionDepth: "standard" });
    const record = context.storage.readStage("900001", "02");
    delete record.data.execution_depth;
    delete record.data.execution_classification;
    context.storage.writeMarkdown(context.storage.stageFile("900001", "02"), record.data, record.body);
    assert.equal(context.storage.readStage("900001", "02").data.execution_profile, "implementation");
    record.data.execution_depth = "standard";
    context.storage.writeMarkdown(context.storage.stageFile("900001", "02"), record.data, record.body);
    assert.throws(() => context.storage.readStage("900001", "02"), (error) => error.code === "STORAGE_ERROR");
  } finally { removeRoot(root); }
});

test("explicit stage classification supports partial updates and paired clear", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    const created = createStage(context, { executionProfile: "implementation", executionDepth: "standard", classification: "inferred", reviewProfile: "review" });
    assert.deepEqual(created.data.capability_profiles, { mode: "advisory", execution_profile: "implementation", execution_depth: "standard", execution_classification: "inferred", review_profile: "review" });
    const updated = context.setStageProfiles("900001", "02", { executionDepth: "deep" });
    assert.deepEqual(updated.data.capability_profiles, { mode: "advisory", execution_profile: "implementation", execution_depth: "deep", execution_classification: "explicit", review_profile: "review" });
    assert.throws(() => context.setStageProfiles("900001", "02", { executionProfile: null }), (error) => error.code === "INVALID_ARGUMENT");
    const cleared = context.setStageProfiles("900001", "02", { executionProfile: null, executionDepth: null });
    assert.deepEqual(cleared.data.capability_profiles, { mode: "advisory", review_profile: "review" });
  } finally { removeRoot(root); }
});

test("batch refresh updates inferred classifications and preserves explicit ones", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    createStage(context, { executionProfile: "implementation", executionDepth: "standard", classification: "inferred" });
    context.addStage("900001", "Explicit", { prompt: "Review security.", executionProfile: "security", executionDepth: "deep", classification: "explicit" });
    context.addStage("900001", "Missing", { prompt: "Wire exports." });
    context.addStage("900001", "Archived", { prompt: "Old work." });
    context.archiveStage("900001", "05");
    context.addStage("900001", "Cancelled", { prompt: "Cancelled work." });
    const cancelled = context.storage.readStage("900001", "06");
    cancelled.data.status = "cancelled";
    context.storage.writeMarkdown(context.storage.stageFile("900001", "06"), cancelled.data, cancelled.body);
    const refreshed = context.refreshStageProfiles("900001", [
      { stage: "02", executionProfile: "architecture", executionDepth: "deep" },
      { stage: "03", executionProfile: "review", executionDepth: "standard" },
      { stage: "04", executionProfile: "routine", executionDepth: "light" },
      { stage: "05", executionProfile: "routine", executionDepth: "light" },
      { stage: "06", executionProfile: "routine", executionDepth: "light" },
    ]);
    assert.deepEqual(refreshed.data.updated.map((item) => item.stage), ["02", "04"]);
    assert.deepEqual(refreshed.data.skipped, [{ stage: "03", reason: "explicit" }, { stage: "05", reason: "terminal" }, { stage: "06", reason: "terminal" }]);
    assert.equal(context.storage.readStage("900001", "02").data.execution_classification, "inferred");
    assert.equal(context.storage.readStage("900001", "04").data.execution_depth, "light");
    assert.equal(context.storage.readStage("900001", "03").data.execution_profile, "security");

    const forced = context.refreshStageProfiles("900001", [{ stage: "03", executionProfile: "review", executionDepth: "standard" }], { includeExplicit: true });
    assert.equal(forced.data.updated[0].after.classification, "inferred");
    assert.throws(() => context.refreshStageProfiles("900001", [{ stage: "04", executionProfile: "routine", executionDepth: "deep" }, { stage: "99", executionProfile: "routine", executionDepth: "light" }]), (error) => error.code === "NOT_FOUND");
    assert.equal(context.storage.readStage("900001", "04").data.execution_depth, "light");
  } finally { removeRoot(root); }
});

test("advisory resume resolves depth mappings and review never resolves a model", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    createStage(context, { executionProfile: "implementation", executionDepth: "deep", classification: "inferred", reviewProfile: "security" });
    fs.writeFileSync(mappingFile(context), `${JSON.stringify({ schema: 1, mappings: { light: "Luna", standard: "Terra", deep: "Sol" } }, null, 2)}\n`);
    const resumed = context.startSession("900001", "02", { sessionId: "implementation" });
    const profiles = resumed.data.resume.context.capability_profiles;
    assert.deepEqual(profiles.execution, { profile: "implementation", depth: "deep", classification: "inferred", source: "mapping", target: "Sol" });
    assert.deepEqual(profiles.review, { profile: "security" });
    assert.equal(context.storage.readEvents().at(-1).data.target, undefined);
    assert.doesNotMatch(fs.readFileSync(context.storage.stageFile("900001", "02"), "utf8"), /Sol/);
  } finally { removeRoot(root); }
});

test("missing, malformed, non-regular, and oversized mappings never block resume", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    createStage(context, { executionProfile: "security", executionDepth: "deep" });
    let profiles = context.startSession("900001", "02", { sessionId: "missing" }).data.resume.context.capability_profiles;
    assert.deepEqual(profiles.execution, { profile: "security", depth: "deep", classification: "explicit", source: "current", message: "No mapping configured; continuing with the current model." });
    context.handoff("900001", "02", "missing");

    const localMapping = mappingFile(context);
    fs.mkdirSync(localMapping);
    profiles = context.startSession("900001", "02", { sessionId: "non-regular" }).data.resume.context.capability_profiles;
    assert.match(profiles.warnings[0].message, /regular file/);
    context.handoff("900001", "02", "non-regular");
    fs.rmSync(localMapping, { recursive: true });
    fs.writeFileSync(localMapping, " ".repeat(16 * 1024 + 1));
    profiles = context.startSession("900001", "02", { sessionId: "oversized" }).data.resume.context.capability_profiles;
    assert.match(profiles.warnings[0].message, /16384 bytes/);
  } finally { removeRoot(root); }
});

test("configuration operations write, show, and reset local depth mappings", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    context.configureCapabilityProfiles({ mode: "off" });
    const configured = context.configureCapabilityProfiles({ mappings: { light: "Luna", standard: "Terra", deep: "Sol" } });
    assert.deepEqual(configured.data, { mode: "off", mappings: { light: "Luna", standard: "Terra", deep: "Sol" }, warnings: [] });
    assert.throws(() => context.configureCapabilityProfiles({ mode: "advisory", mappings: { deep: "Sol" } }), (error) => error.code === "INVALID_ARGUMENT");
    assert.equal(loadConfig(root).capability_profiles.mode, "off");
    assert.deepEqual(context.showCapabilityProfiles().data.mappings, { light: "Luna", standard: "Terra", deep: "Sol" });
    assert.throws(() => context.configureCapabilityProfiles({ mappings: { implementation: "Sol" } }), (error) => error.code === "INVALID_ARGUMENT");
    assert.throws(() => context.resetCapabilityProfiles("no"), (error) => error.code === "CONFIRMATION_REQUIRED");
    assert.deepEqual(context.resetCapabilityProfiles("RESET_PROFILES").data.mappings, {});
    assert.equal(fs.existsSync(mappingFile(context)), false);
    assert.equal(loadConfig(root).capability_profiles.mode, "off");
  } finally { removeRoot(root); }
});

test("configuration operations support custom storage roots without writing config into storage data", () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, ".work-context"));
    fs.writeFileSync(configFile(root), defaultConfig()
      .replace("root: .work-context", "root: .state/shared")
      .replace("personal_root: .work-context/local", "personal_root: .state/local"));
    const context = WorkContext.open(root);
    context.configureCapabilityProfiles({ mode: "off" });
    context.configureCapabilityProfiles({ mappings: { standard: "Terra" } });
    assert.equal(loadConfig(root).capability_profiles.mode, "off");
    assert.equal(fs.existsSync(path.join(root, ".work-context", "capability-profiles.json")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".state", "local", "capability-profiles.json"), "utf8")).mappings.standard, "Terra");
  } finally { removeRoot(root); }
});

test("off mode preserves classification and omits resume and UI recommendations", () => {
  const root = makeRoot();
  try {
    WorkContext.open(root);
    fs.writeFileSync(configFile(root), `${defaultConfig()}capability_profiles:\n  mode: off\n`);
    const context = WorkContext.openExisting(root);
    createStage(context, { executionProfile: "implementation", executionDepth: "standard", reviewProfile: "security" });
    const resumed = context.startSession("900001", "02", { sessionId: "off-mode" });
    assert.equal(resumed.data.resume.context.capability_profiles, undefined);
    assert.equal(context.storage.readStage("900001", "02").data.execution_depth, "standard");
    const stages = readStagesSnapshot({ projectRoot: root, sessionId: "off-mode" });
    const workspace = readWorkContextSnapshot({ projectRoot: root, sessionId: "off-mode" });
    assert.equal(stages.data.stages[1].execution_profile, undefined);
    assert.equal(workspace.data.workspaces[0].stages[1].review_profile, undefined);
    assert.doesNotMatch(renderStagesPanel(stages), /implementation/);
  } finally { removeRoot(root); }
});

test("advisory snapshots expose one compact resolved recommendation", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    createStage(context, { executionProfile: "architecture", executionDepth: "deep", reviewProfile: "security" });
    fs.writeFileSync(mappingFile(context), JSON.stringify({ schema: 1, mappings: { deep: "Sol" } }));
    context.startSession("900001", "02", { sessionId: "advisory" });
    const snapshot = readStagesSnapshot({ projectRoot: root, sessionId: "advisory" });
    assert.equal(snapshot.data.stages[1].recommended_model, "Sol");
    assert.match(renderStagesPanel(snapshot), /Architecture · Deep · Sol/);
    assert.doesNotMatch(renderStagesPanel(snapshot), /security/);
  } finally { removeRoot(root); }
});

test("capability tools are registered", () => {
  assert.equal(tools.work_context_set_stage_profiles, work_context_set_stage_profiles);
  assert.equal(tools.work_context_refresh_stage_profiles, work_context_refresh_stage_profiles);
  assert.equal(tools.work_context_show_capability_profiles, work_context_show_capability_profiles);
  assert.equal(tools.work_context_configure_capability_profiles, work_context_configure_capability_profiles);
  assert.equal(tools.work_context_reset_capability_profiles, work_context_reset_capability_profiles);
});

test("local mappings remain isolated between project instances", () => {
  const firstRoot = makeRoot();
  const secondRoot = makeRoot();
  try {
    const first = WorkContext.open(firstRoot);
    const second = WorkContext.open(secondRoot);
    createStage(first, { executionProfile: "implementation", executionDepth: "standard" });
    createStage(second, { executionProfile: "implementation", executionDepth: "standard" });
    first.configureCapabilityProfiles({ mappings: { standard: "Terra" } });
    assert.equal(first.startSession("900001", "02", { sessionId: "first" }).data.resume.context.capability_profiles.execution.target, "Terra");
    assert.equal(second.startSession("900001", "02", { sessionId: "second" }).data.resume.context.capability_profiles.execution.source, "current");
  } finally {
    removeRoot(firstRoot);
    removeRoot(secondRoot);
  }
});
