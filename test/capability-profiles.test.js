import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CAPABILITY_PROFILES, WorkContext, defaultConfig, loadConfig, readStagesSnapshot, readWorkContextSnapshot, renderStagesPanel } from "../src/index.js";
import tools, { work_context_set_stage_profiles } from "../src/tool-definitions.js";

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

test("stage profiles accept the portable vocabulary and reject case variants", () => {
  for (const [index, profile] of CAPABILITY_PROFILES.entries()) {
    const root = makeRoot();
    try {
      const context = WorkContext.open(root);
      createStage(context, { executionProfile: profile, reviewProfile: profile });
      const stage = context.storage.readStage("900001", "02").data;
      assert.equal(stage.execution_profile, profile);
      assert.equal(stage.review_profile, profile);
      assert.throws(() => context.addStage("900001", `Invalid ${index}`, { executionProfile: profile.toUpperCase() }), (error) => error.code === "INVALID_ARGUMENT");
    } finally { removeRoot(root); }
  }
});

test("stage profiles support partial updates and explicit clears", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    const created = createStage(context, { executionProfile: "implementation", reviewProfile: "review" });
    assert.deepEqual(created.data.capability_profiles, { mode: "advisory", execution_profile: "implementation", review_profile: "review" });

    const updated = context.setStageProfiles("900001", "02", { executionProfile: "architecture" });
    assert.deepEqual(updated.data.capability_profiles, { mode: "advisory", execution_profile: "architecture", review_profile: "review" });
    const cleared = context.setStageProfiles("900001", "02", { reviewProfile: null });
    assert.deepEqual(cleared.data.capability_profiles, { mode: "advisory", execution_profile: "architecture" });
    assert.throws(() => context.setStageProfiles("900001", "02", {}), (error) => error.code === "INVALID_ARGUMENT");
    assert.equal(context.storage.readStage("900001", "02").data.review_profile, undefined);
  } finally { removeRoot(root); }
});

test("advisory resume resolves local mappings and falls back to the current model", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    createStage(context, { executionProfile: "implementation", reviewProfile: "review" });
    fs.writeFileSync(mappingFile(context), `${JSON.stringify({ schema: 1, mappings: { implementation: "local-coding-target" } }, null, 2)}\n`);

    const resumed = context.startSession("900001", "02", { sessionId: "implementation" });
    const profiles = resumed.data.resume.context.capability_profiles;
    assert.deepEqual(profiles.execution, { profile: "implementation", source: "mapping", target: "local-coding-target" });
    assert.deepEqual(profiles.review, { profile: "review", source: "current", message: "No mapping configured; continuing with the current model." });
    assert.deepEqual(resumed.data.resume.presentation.capability_profiles, profiles);
    assert.equal(context.storage.readEvents().at(-1).data.target, undefined);
    assert.doesNotMatch(fs.readFileSync(context.storage.stageFile("900001", "02"), "utf8"), /local-coding-target/);
  } finally { removeRoot(root); }
});

test("invalid local mappings are bounded warnings and never block resume", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    createStage(context, { executionProfile: "security" });
    fs.writeFileSync(mappingFile(context), JSON.stringify({ schema: 1, extra: true, mappings: { security: "", unknown: "target" } }));
    const profiles = context.startSession("900001", "02", { sessionId: "security" }).data.resume.context.capability_profiles;
    assert.equal(profiles.execution.source, "current");
    assert.ok(profiles.warnings.length <= 5);
    assert.match(profiles.warnings[0].message, /Ignoring/);
  } finally { removeRoot(root); }
});

test("local mapping files and warnings are size bounded", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    createStage(context, { executionProfile: "security" });
    const localMapping = mappingFile(context);
    fs.mkdirSync(localMapping);
    let profiles = context.startSession("900001", "02", { sessionId: "non-regular" }).data.resume.context.capability_profiles;
    assert.equal(profiles.execution.source, "current");
    assert.match(profiles.warnings[0].message, /expected a regular file/);
    context.handoff("900001", "02", "non-regular");
    fs.rmSync(localMapping, { recursive: true });

    fs.writeFileSync(localMapping, " ".repeat(16 * 1024 + 1));
    profiles = context.startSession("900001", "02", { sessionId: "oversized" }).data.resume.context.capability_profiles;
    assert.equal(profiles.execution.source, "current");
    assert.match(profiles.warnings[0].message, /no larger than 16384 bytes/);
    context.handoff("900001", "02", "oversized");

    fs.writeFileSync(localMapping, JSON.stringify({ schema: 1, mappings: Object.fromEntries([
      ...Array.from({ length: 8 }, (_, index) => [`bad\n${"x".repeat(100)}${index}`, "target"]),
      ["security", "bounded-security-target"],
    ]) }));
    profiles = context.startSession("900001", "02", { sessionId: "bounded-warnings" }).data.resume.context.capability_profiles;
    assert.deepEqual(profiles.execution, { profile: "security", source: "mapping", target: "bounded-security-target" });
    assert.equal(profiles.warnings.length, 5);
    assert.ok(profiles.warnings.every((item) => item.message.length < 100 && !item.message.includes("\n")));
  } finally { removeRoot(root); }
});

test("off mode preserves profile metadata and omits advisory resume and UI fields", () => {
  const root = makeRoot();
  try {
    WorkContext.open(root);
    fs.writeFileSync(configFile(root), `${defaultConfig()}capability_profiles:\n  mode: off\n`);
    const context = WorkContext.openExisting(root);
    createStage(context, { executionProfile: "implementation", reviewProfile: "security" });
    fs.writeFileSync(mappingFile(context), "not json");
    const resumed = context.startSession("900001", "02", { sessionId: "off-mode" });
    assert.equal(resumed.data.resume.context.capability_profiles, undefined);
    assert.equal(resumed.data.resume.presentation.capability_profiles, undefined);
    assert.equal(context.storage.readStage("900001", "02").data.execution_profile, "implementation");

    const stages = readStagesSnapshot({ projectRoot: root, sessionId: "off-mode" });
    const workspace = readWorkContextSnapshot({ projectRoot: root, sessionId: "off-mode" });
    assert.equal(stages.data.stages[1].execution_profile, undefined);
    assert.equal(workspace.data.workspaces[0].stages[1].review_profile, undefined);
    assert.doesNotMatch(renderStagesPanel(stages), /Profiles:/);
  } finally { removeRoot(root); }
});

test("advisory snapshots expose compact profiles without changing lifecycle state", () => {
  const root = makeRoot();
  try {
    const context = WorkContext.open(root);
    createStage(context, { executionProfile: "architecture", reviewProfile: "security" });
    context.startSession("900001", "02", { sessionId: "advisory" });
    const snapshot = readStagesSnapshot({ projectRoot: root, sessionId: "advisory" });
    assert.equal(snapshot.data.stages[1].status, "in_progress");
    assert.match(renderStagesPanel(snapshot), /Profiles: execution architecture · review security/);
  } finally { removeRoot(root); }
});

test("structured stage profile tool is registered and packaged", () => {
  assert.equal(tools.work_context_set_stage_profiles, work_context_set_stage_profiles);
  assert.equal(typeof work_context_set_stage_profiles.execute, "function");
});

test("local mappings remain isolated between project instances", () => {
  const firstRoot = makeRoot();
  const secondRoot = makeRoot();
  try {
    const first = WorkContext.open(firstRoot);
    const second = WorkContext.open(secondRoot);
    createStage(first, { executionProfile: "implementation" });
    createStage(second, { executionProfile: "implementation" });
    fs.writeFileSync(mappingFile(first), JSON.stringify({ schema: 1, mappings: { implementation: "first-project-target" } }));

    const firstResume = first.startSession("900001", "02", { sessionId: "first" }).data.resume.context.capability_profiles.execution;
    const secondResume = second.startSession("900001", "02", { sessionId: "second" }).data.resume.context.capability_profiles.execution;
    assert.deepEqual(firstResume, { profile: "implementation", source: "mapping", target: "first-project-target" });
    assert.equal(secondResume.source, "current");
    assert.equal(secondResume.target, undefined);
  } finally {
    removeRoot(firstRoot);
    removeRoot(secondRoot);
  }
});
