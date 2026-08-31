#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../src/storage.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const projectRoot = process.cwd();
const dependencyRoot = fs.existsSync(path.join(projectRoot, "package.json"))
  ? projectRoot
  : fs.existsSync(path.join(projectRoot, ".opencode", "package.json"))
    ? path.join(projectRoot, ".opencode")
    : projectRoot;
const dependencyManifestFile = path.join(dependencyRoot, "package.json");
let dependencyManifest = {};
try { dependencyManifest = JSON.parse(fs.readFileSync(dependencyManifestFile, "utf8")); } catch {}
const pluginLoader = `export { default } from "${packageManifest.name}/plugin";\n`;
const tuiLoader = `export { default } from "${packageManifest.name}/tui";\n`;
const tuiConfig = JSON.stringify({
  $schema: "https://opencode.ai/tui.json",
  plugin: ["./tui-plugins/work-context-stages.js"],
}, null, 2) + "\n";
const command = fs.readFileSync(path.join(packageRoot, "commands", "wc.md"), "utf8");
const generated = new Map([
  [path.join(".work-context", "config.yaml"), defaultConfig()],
  [path.join(".opencode", "commands", "wc.md"), command],
  [path.join(".opencode", "plugins", "work-context.js"), `// Thin project integration; tools remain in the installed npm package.
${pluginLoader}`],
  [path.join(".opencode", "tui-plugins", "work-context-stages.js"), tuiLoader],
  [path.join(".opencode", "tui.json"), tuiConfig],
]);

const fail = (message) => {
  console.error(`opencode-work-context: ${message}`);
  process.exitCode = 1;
};
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const writeAtomic = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(temp, content, { flag: "wx" }); fs.renameSync(temp, file); }
  catch (error) { fs.rmSync(temp, { force: true }); throw error; }
};
const hasSymlinkParent = (file) => {
  let current = path.dirname(file);
  while (current.startsWith(projectRoot) && current !== projectRoot) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    current = path.dirname(current);
  }
  return false;
};

function parseArgs(args) {
  if (args[0] !== "init") return fail("usage: opencode-work-context init [--force]");
  const unknown = args.slice(1).filter((arg) => arg !== "--force");
  if (unknown.length) return fail(`unknown option: ${unknown[0]}`);
  return { force: args.includes("--force") };
}

function ensurePackageJson() {
  const file = path.join(dependencyRoot, "package.json");
  if (fs.existsSync(file)) return;
  const name = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "opencode-project";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ name, version: "1.0.0", private: true, type: "module" }, null, 2)}\n`);
}

function ensureModuleScope() {
  const file = path.join(dependencyRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.type === "module") return;
  manifest.type = "module";
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function checkConflicts(force) {
  const conflicts = ["package.json", "package-lock.json", "npm-shrinkwrap.json"].flatMap((relative) => {
    const file = path.join(dependencyRoot, relative);
    if (!exists(file)) return [];
    if (hasSymlinkParent(file)) return [path.relative(projectRoot, file)];
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? [] : [path.relative(projectRoot, file)];
  });
  conflicts.push(...[...generated].flatMap(([relative, content]) => {
    const file = path.join(projectRoot, relative);
    if (hasSymlinkParent(file)) return [relative];
    if (!exists(file)) return [];
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return [relative];
    return !force && fs.readFileSync(file, "utf8") !== content ? [relative] : [];
  }));
  const gitignore = path.join(projectRoot, ".gitignore");
  if (exists(gitignore) && (!fs.lstatSync(gitignore).isFile() || fs.lstatSync(gitignore).isSymbolicLink())) conflicts.push(".gitignore");
  if (conflicts.length) fail(`refusing to overwrite existing files: ${conflicts.join(", ")}; rerun with --force`);
  return conflicts.length === 0;
}

function checkPackageConflict(force) {
  const file = path.join(dependencyRoot, "package.json");
  if (!exists(file)) return true;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return true; }
  const existing = manifest.devDependencies?.[packageManifest.name] ?? manifest.dependencies?.[packageManifest.name];
  if (existing && existing !== packageManifest.version && existing !== `=${packageManifest.version}` && !force) {
    fail(`refusing to replace ${packageManifest.name}@${existing}; rerun with --force`);
    return false;
  }
  return true;
}

function snapshotFiles() {
  return [
    ...["package.json", "package-lock.json", "npm-shrinkwrap.json"].map((relative) => path.join(dependencyRoot, relative)),
    ...[...generated.keys()].map((relative) => path.join(projectRoot, relative)),
    path.join(projectRoot, ".gitignore"),
  ].map((file) => {
    return { file, exists: exists(file), content: exists(file) ? fs.readFileSync(file) : null };
  });
}

function restoreFiles(snapshot) {
  for (const item of snapshot) {
    if (item.exists) fs.writeFileSync(item.file, item.content);
    else {
      fs.rmSync(item.file, { force: true });
      let parent = path.dirname(item.file);
      while (parent !== projectRoot) {
        if (!fs.existsSync(parent) || fs.readdirSync(parent).length) break;
        fs.rmdirSync(parent);
        parent = path.dirname(parent);
      }
    }
  }
}

function acquireInitLock() {
  const lock = path.join(projectRoot, ".opencode-work-context-init.lock");
  let tombstone = null;
  if (exists(lock)) {
    let owner = {};
    try { owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch {}
    if (!owner.pid && Date.now() - fs.statSync(lock).mtimeMs < 60000) { fail("another init is acquiring the lock"); return { lock, failed: true }; }
    let active = false;
    if (Number.isInteger(owner.pid)) { try { process.kill(owner.pid, 0); active = true; } catch (error) { if (error.code === "EPERM") active = true; } }
    if (active || (owner.pid && !owner.token)) { fail("another init is already running or has an incomplete lock"); return { lock, failed: true }; }
    tombstone = `${lock}.reclaim-${randomUUID()}`;
    try { fs.renameSync(lock, tombstone); } catch { fail("another init is reclaiming the stale lock"); return { lock, failed: true }; }
    try { fs.mkdirSync(lock); }
    catch { try { fs.renameSync(tombstone, lock); } catch {} fail("cannot reclaim stale init lock"); return { lock, failed: true }; }
  } else {
    try { fs.mkdirSync(lock); } catch { fail("cannot acquire init lock"); return { lock, failed: true }; }
  }
  const token = randomUUID();
  try { writeAtomic(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token }) + "\n"); }
  catch { fs.rmSync(lock, { recursive: true, force: true }); if (tombstone) try { fs.renameSync(tombstone, lock); } catch {} fail("cannot write init lock owner"); return { lock, failed: true }; }
  if (tombstone) try { fs.rmSync(tombstone, { recursive: true, force: true }); } catch {}
  return { lock, token };
}

function prepareNodeModules(initLock) {
  const target = path.join(dependencyRoot, "node_modules");
  const backup = path.join(dependencyRoot, ".opencode-work-context-node_modules.backup");
  const journal = path.join(dependencyRoot, ".opencode-work-context-node_modules.recovery.json");
  const result = { target, backup, journal, lock: initLock.lock, token: initLock.token, hadNodeModules: false };
  if (recoverNodeModules(result) === false) return { ...result, failed: true };
  if (exists(backup)) { fail("previous node_modules recovery is incomplete"); return { ...result, failed: true }; }
  if (!exists(target)) { writeAtomic(journal, JSON.stringify({ target, backup, hadNodeModules: false, phase: "prepared" }) + "\n"); return result; }
  if (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isDirectory()) { fail("refusing to replace non-regular node_modules"); return { ...result, failed: true }; }
  writeAtomic(journal, JSON.stringify({ target, backup, hadNodeModules: true, phase: "prepared" }) + "\n");
  fs.renameSync(target, backup);
  result.hadNodeModules = true;
  return result;
}

function recoverNodeModules({ target, backup, journal }) {
  if (!exists(journal)) return;
  let state;
  if (fs.lstatSync(journal).isSymbolicLink() || !fs.lstatSync(journal).isFile()) { fail("invalid node_modules recovery journal path"); return false; }
  try { state = JSON.parse(fs.readFileSync(journal, "utf8")); } catch { fail("cannot read node_modules recovery journal"); return false; }
  if (!state || typeof state !== "object" || Object.keys(state).some((key) => !["target", "backup", "hadNodeModules", "phase"].includes(key)) || typeof state.target !== "string" || typeof state.backup !== "string" || !["prepared", "installed", "committed"].includes(state.phase) || state.target !== target || state.backup !== backup || typeof state.hadNodeModules !== "boolean") { fail("invalid node_modules recovery journal"); return false; }
  if (exists(backup) && fs.lstatSync(backup).isSymbolicLink()) { fail("invalid node_modules recovery backup"); return false; }
  if (state.phase !== "committed" && state.hadNodeModules && !exists(backup)) {
    fail("node_modules recovery backup is missing; refusing to continue");
    return false;
  }
  try {
    if (state.phase === "committed") {
      if (!exists(target) && exists(backup)) fs.renameSync(backup, target);
      else if (!exists(target)) { fail("committed node_modules recovery has no target or backup"); return false; }
      else if (exists(backup)) fs.rmSync(backup, { recursive: true, force: true });
    } else if (exists(backup)) {
      if (exists(target)) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(backup, target);
    } else if (!state.hadNodeModules && exists(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(journal, { force: true });
  } catch (error) {
    fail(`node_modules recovery failed: ${error.message}`);
    return false;
  }
  return true;
}

function restoreNodeModules(snapshot) {
  if (snapshot.committed) { releaseInitLock(snapshot); return; }
  if (snapshot.failed) { releaseInitLock(snapshot); return; }
  fs.rmSync(snapshot.target, { recursive: true, force: true });
  if (snapshot.backup && exists(snapshot.backup)) fs.renameSync(snapshot.backup, snapshot.target);
  if (snapshot.journal) fs.rmSync(snapshot.journal, { force: true });
  releaseInitLock(snapshot);
}

function commitNodeModules(snapshot) {
  if (snapshot.journal) writeAtomic(snapshot.journal, JSON.stringify({ target: snapshot.target, backup: snapshot.backup, hadNodeModules: snapshot.hadNodeModules, phase: "committed" }) + "\n");
  snapshot.committed = true;
  try { if (snapshot.backup) fs.rmSync(snapshot.backup, { recursive: true, force: true }); }
  catch (error) { console.error(`opencode-work-context: committed; backup cleanup deferred: ${error.message}`); }
  try { if (snapshot.journal) fs.rmSync(snapshot.journal, { force: true }); }
  catch (error) { console.error(`opencode-work-context: committed; recovery journal cleanup deferred: ${error.message}`); }
  releaseInitLock(snapshot);
}

function releaseInitLock(snapshot) {
  if (!snapshot.lock || !snapshot.token || !exists(snapshot.lock)) return;
  try { const owner = JSON.parse(fs.readFileSync(path.join(snapshot.lock, "owner.json"), "utf8")); if (owner.token === snapshot.token) fs.rmSync(snapshot.lock, { recursive: true, force: true }); } catch {}
}

function markNodeModulesInstalled(snapshot) {
  if (snapshot.journal) writeAtomic(snapshot.journal, JSON.stringify({ target: snapshot.target, backup: snapshot.backup, hadNodeModules: snapshot.hadNodeModules, phase: "installed" }) + "\n");
}

function installPackage(snapshot) {
  const spec = `${packageManifest.name}@${packageManifest.version}`;
  const result = spawnSync("npm", ["install", "--save-dev", "--save-exact", spec], { cwd: dependencyRoot, stdio: "inherit" });
  if (result.error) { restoreFiles(snapshot); fail(`npm install failed: ${result.error.message}`); }
  else if (result.status !== 0) { restoreFiles(snapshot); fail(`npm install exited with status ${result.status}`); }
  return result.status === 0;
}

function writeGenerated() {
  for (const [relative, content] of generated) {
    const file = path.join(projectRoot, relative);
    if (!exists(file) || fs.readFileSync(file, "utf8") !== content) writeAtomic(file, content);
  }
  const gitignore = path.join(projectRoot, ".gitignore");
  const line = ".work-context/local/";
  const current = exists(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  if (!current.split(/\r?\n/).includes(line)) writeAtomic(gitignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options) {
  const initLock = acquireInitLock();
  if (initLock.failed) process.exitCode = 1;
  else if (checkConflicts(options.force) && checkPackageConflict(options.force)) {
    const snapshot = snapshotFiles();
    const nodeModules = prepareNodeModules(initLock);
    if (nodeModules.failed) process.exitCode = 1;
    try {
      if (!nodeModules.failed) ensurePackageJson();
      if (!nodeModules.failed) ensureModuleScope();
      if (!nodeModules.failed) {
        if (installPackage(snapshot)) {
          markNodeModulesInstalled(nodeModules);
          writeGenerated();
          commitNodeModules(nodeModules);
          console.log("Initialized opencode-work-context. No workspace was created; use /wc create.");
        } else restoreNodeModules(nodeModules);
      }
    } catch (error) {
      restoreFiles(snapshot);
      restoreNodeModules(nodeModules);
      fail(`init failed: ${error.message}`);
    }
    if (nodeModules.failed) restoreNodeModules(nodeModules);
  } else releaseInitLock(initLock);
}
