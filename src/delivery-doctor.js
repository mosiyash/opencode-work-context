import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { ERROR_CODES, fail } from "./errors.js";
import {
  WORK_CONTEXT_PROTOCOL,
  WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH,
  parseWorkContextProtocolMarker,
} from "./protocol.js";

export const DELIVERY_DOCTOR_CONTRACT_VERSION = "1.0";
export const DELIVERY_DOCTOR_OPERATION = "delivery.doctor";
export const DELIVERY_DOCTOR_EVIDENCE_KINDS = Object.freeze(["self_reported", "host_attested", "unavailable"]);

const PACKAGE_NAME = "opencode-work-context";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_VALUE_CHARACTERS = 256;
const SAFE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const relativeFiles = Object.freeze({
  command: ".opencode/commands/wc.md",
  opencode: ".opencode/opencode.json",
  tui: ".opencode/tui.json",
  rootManifest: "package.json",
  opencodeManifest: ".opencode/package.json",
  rootInstalled: `node_modules/${PACKAGE_NAME}/package.json`,
  opencodeInstalled: `.opencode/node_modules/${PACKAGE_NAME}/package.json`,
  localLoader: ".opencode/plugins/work-context.js",
});

const cleanValue = (value) => typeof value === "string"
  && value.length > 0
  && value.length <= MAX_VALUE_CHARACTERS
  && /^[A-Za-z0-9._+-]+$/.test(value)
  ? value
  : null;
const cleanVersion = (value) => typeof value === "string" && value.length <= 128 && SAFE_VERSION_PATTERN.test(value) ? value : null;

const safeFile = (projectRoot, relative, parseJson = false) => {
  const file = path.join(projectRoot, ...relative.split("/"));
  let current = projectRoot;
  try {
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return { status: "unsafe", path: relative };
      if (current !== file && !stat.isDirectory()) return { status: "unsafe", path: relative };
      if (current === file && !stat.isFile()) return { status: "unsafe", path: relative };
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let content;
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile()) return { status: "unsafe", path: relative };
      if (opened.size > MAX_FILE_BYTES) return { status: "oversized", path: relative };
      content = fs.readFileSync(descriptor, "utf8");
      const after = fs.lstatSync(file);
      if (after.isSymbolicLink() || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) return { status: "unsafe", path: relative };
    } finally {
      fs.closeSync(descriptor);
    }
    if (!parseJson) return { status: "available", path: relative, content };
    try {
      const value = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "malformed", path: relative };
      return { status: "available", path: relative, value };
    } catch {
      return { status: "malformed", path: relative };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", path: relative };
    return { status: "unavailable", path: relative };
  }
};

const packageSpec = (value) => {
  if (typeof value !== "string") return null;
  if (value === PACKAGE_NAME) return { package: PACKAGE_NAME, version: null };
  if (!value.startsWith(`${PACKAGE_NAME}@`)) return null;
  const version = cleanVersion(value.slice(PACKAGE_NAME.length + 1));
  return version ? { package: PACKAGE_NAME, version } : null;
};

const dependencySpec = (value) => {
  if (typeof value !== "string") return null;
  const version = value.startsWith("=") ? value.slice(1) : value;
  const normalized = cleanVersion(version);
  return normalized ? { package: PACKAGE_NAME, version: normalized } : null;
};

const collectDeclarations = (projectRoot) => {
  const observations = [];
  for (const [source, relative] of [["opencode", relativeFiles.opencode], ["tui", relativeFiles.tui]]) {
    const file = safeFile(projectRoot, relative, true);
    if (file.status !== "available") {
      observations.push({ source, path: relative, status: file.status });
      continue;
    }
    const fields = source === "opencode" ? ["plugin", "plugins"] : ["plugin"];
    let supported = true;
    for (const field of fields) {
      if (file.value[field] !== undefined && !Array.isArray(file.value[field])) supported = false;
      for (const value of Array.isArray(file.value[field]) ? file.value[field] : []) {
        const parsed = packageSpec(value);
        if (parsed) observations.push({ source, path: relative, field, status: "declared", ...parsed, model: "managed" });
        else if (typeof value === "string" && value.startsWith(PACKAGE_NAME)) observations.push({ source, path: relative, field, status: "malformed" });
      }
    }
    if (!supported) observations.push({ source, path: relative, status: "unsupported" });
  }
  for (const [source, relative] of [["root_manifest", relativeFiles.rootManifest], ["opencode_manifest", relativeFiles.opencodeManifest]]) {
    const file = safeFile(projectRoot, relative, true);
    if (file.status !== "available") {
      observations.push({ source, path: relative, status: file.status });
      continue;
    }
    for (const field of ["dependencies", "devDependencies"]) {
      const container = file.value[field];
      if (container !== undefined && (!container || typeof container !== "object" || Array.isArray(container))) {
        observations.push({ source, path: relative, status: "unsupported" });
        continue;
      }
      if (!Object.hasOwn(container || {}, PACKAGE_NAME)) continue;
      const parsed = dependencySpec(container[PACKAGE_NAME]);
      observations.push(parsed
        ? { source, path: relative, field, status: "declared", ...parsed, model: "pinned_local" }
        : { source, path: relative, field, status: "malformed" });
    }
  }
  return observations;
};

const collectInstallations = (projectRoot) => [["root", relativeFiles.rootInstalled], ["opencode", relativeFiles.opencodeInstalled]].map(([source, relative]) => {
  const file = safeFile(projectRoot, relative, true);
  if (file.status !== "available") return { source, path: relative, status: file.status };
  const name = file.value.name === PACKAGE_NAME ? PACKAGE_NAME : null;
  const version = cleanVersion(file.value.version);
  if (name !== PACKAGE_NAME || !version) return { source, path: relative, status: "malformed" };
  return { source, path: relative, status: "installed", package: name, version };
});

const normalizeRuntimeEvidence = (evidence, kind) => {
  if (!evidence || evidence.evidence_kind === "unavailable") return {
    evidence_kind: "unavailable",
    reason: kind === "host_attested" ? "authoritative runtime evidence is not provided by the host" : "loaded-plugin self-report is unavailable",
  };
  const packageName = evidence.package_name === PACKAGE_NAME ? PACKAGE_NAME : null;
  const packageVersion = cleanVersion(evidence.package_version);
  const origin = ["project_local", "managed_cache", "package_source", "unknown"].includes(evidence.module_origin) ? evidence.module_origin : "unknown";
  const protocol = evidence.protocol;
  if (packageName !== PACKAGE_NAME || !packageVersion || !protocol
    || !Number.isInteger(protocol.schema) || !Number.isInteger(protocol.major) || !Number.isInteger(protocol.minor)
    || typeof protocol.descriptor_hash !== "string" || !/^[a-f0-9]{64}$/.test(protocol.descriptor_hash)) {
    return { evidence_kind: "unavailable", reason: `${kind} runtime evidence is malformed` };
  }
  return {
    evidence_kind: kind,
    package_name: packageName,
    package_version: packageVersion,
    module_origin: origin,
    protocol: {
      schema: protocol.schema,
      major: protocol.major,
      minor: protocol.minor,
      descriptor_hash: protocol.descriptor_hash,
    },
  };
};

const repairFor = (model, version, commandChanged) => {
  const target = cleanVersion(version);
  if (!target || !["managed", "pinned_local"].includes(model)) return {
    model: "unknown",
    steps: ["Resolve the installation model and exact loaded package version, then rerun delivery doctor."],
    restart_required: false,
  };
  if (model === "managed") return {
    model: "managed",
    steps: [
      `opencode plugin ${PACKAGE_NAME}@${target} --force`,
      ...(commandChanged ? [`npx --yes ${PACKAGE_NAME}@${target} activate --force`] : []),
      "Restart OpenCode.",
    ],
    restart_required: true,
  };
  return {
    model: "pinned_local",
    steps: [`npx --yes ${PACKAGE_NAME}@${target} init --force`, "Restart OpenCode."],
    restart_required: true,
  };
};

const addFinding = (findings, id, severity, summary, repair) => {
  if (!findings.some((finding) => finding.id === id)) findings.push({ id, severity, summary, ...(repair ? { repair } : {}) });
};

export function validateDeliveryDoctorEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || envelope.contract_version !== DELIVERY_DOCTOR_CONTRACT_VERSION
    || envelope.operation !== DELIVERY_DOCTOR_OPERATION
    || !envelope.protocol || typeof envelope.protocol !== "object" || Array.isArray(envelope.protocol)
    || !envelope.evidence || typeof envelope.evidence !== "object" || Array.isArray(envelope.evidence)
    || !DELIVERY_DOCTOR_EVIDENCE_KINDS.includes(envelope.evidence.loaded_plugin?.evidence_kind)
    || !DELIVERY_DOCTOR_EVIDENCE_KINDS.includes(envelope.evidence.host_attestation?.evidence_kind)
    || !Array.isArray(envelope.evidence.declarations) || !Array.isArray(envelope.evidence.installations)
    || !Array.isArray(envelope.findings)
    || envelope.findings.length > 100) fail(ERROR_CODES.INVALID_ARGUMENT, "Invalid delivery doctor output envelope");
  for (const finding of envelope.findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)
      || typeof finding.id !== "string" || !/^[a-z][a-z0-9_.-]*$/.test(finding.id)
      || !["info", "warning", "error"].includes(finding.severity)
      || typeof finding.summary !== "string" || !finding.summary) fail(ERROR_CODES.INVALID_ARGUMENT, "Invalid delivery doctor finding");
  }
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) fail(ERROR_CODES.DELIVERY_DIAGNOSTIC_TOO_LARGE, "Delivery doctor output exceeds the supported 1 MiB limit");
  return envelope;
}

export function doctorDelivery(projectRoot, options = {}) {
  projectRoot = fs.realpathSync(path.resolve(projectRoot));
  const loaded = normalizeRuntimeEvidence(options.loadedPlugin, "self_reported");
  const host = normalizeRuntimeEvidence(options.hostAttestation, "host_attested");
  const commandFile = safeFile(projectRoot, relativeFiles.command);
  const marker = commandFile.status === "available" ? parseWorkContextProtocolMarker(commandFile.content) : null;
  const command = {
    path: relativeFiles.command,
    status: commandFile.status === "available" ? (marker ? "available" : "malformed") : commandFile.status,
    ...(marker ? { marker } : {}),
  };
  const declarations = collectDeclarations(projectRoot);
  const installations = collectInstallations(projectRoot);
  const declared = declarations.filter((item) => item.status === "declared");
  const installed = installations.filter((item) => item.status === "installed");
  const models = [...new Set(declared.map((item) => item.model))];
  const model = models.length > 1 ? "conflict" : models[0] || (loaded.module_origin === "managed_cache" ? "managed" : "pinned_local");
  const version = loaded.package_version;
  const findings = [];

  if (marker && loaded.evidence_kind === "self_reported" && marker.major !== loaded.protocol.major) {
    fail(ERROR_CODES.DELIVERY_COMMAND_PROTOCOL_MISMATCH, "Generated command and loaded plugin use incompatible protocol majors", {
      command_major: marker.major,
      loaded_major: loaded.protocol.major,
    });
  }
  if (command.status !== "available") addFinding(findings, `command.${command.status}`, "error", `Generated command protocol marker is ${command.status}.`, repairFor(model, version, true));
  if (marker && loaded.evidence_kind === "self_reported") {
    if (marker.minor !== loaded.protocol.minor) {
      const direction = marker.minor < loaded.protocol.minor ? "generated command is older" : "loaded plugin is older";
      addFinding(findings, "command.protocol_minor_drift", "warning", `Protocol minors differ: ${direction}.`, repairFor(model, version, true));
    }
    if (marker.schema !== loaded.protocol.schema) addFinding(findings, "command.schema_mismatch", "warning", "Generated command protocol schema differs from the loaded plugin.", repairFor(model, version, true));
    if (marker.descriptor_hash !== `sha256:${loaded.protocol.descriptor_hash}`) addFinding(findings, "command.descriptor_hash_mismatch", "warning", "Generated command descriptor hash differs from the loaded plugin.", repairFor(model, version, true));
  }
  if (loaded.evidence_kind === "unavailable") {
    addFinding(findings, "runtime.protocol_major_unknown", "error", "Loaded-plugin protocol major is unknown, so compatibility cannot be established.", repairFor(model, version, false));
    addFinding(findings, "runtime.self_report_unavailable", "warning", "Loaded-plugin self-report is unavailable.", repairFor(model, version, false));
  } else {
    if (loaded.protocol.schema !== WORK_CONTEXT_PROTOCOL.schema) addFinding(findings, "runtime.self_report_schema_mismatch", "warning", "Loaded-plugin self-reported protocol schema differs from this package contract.", repairFor(model, version, false));
    if (loaded.protocol.descriptor_hash !== WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH) addFinding(findings, "runtime.self_report_hash_mismatch", "warning", "Loaded-plugin self-reported descriptor hash differs from this package contract.", repairFor(model, version, false));
  }
  if (host.evidence_kind === "unavailable") addFinding(findings, "runtime.host_attestation_unavailable", "info", "The host does not provide authoritative loaded-plugin attestation.");
  if (host.evidence_kind === "host_attested" && loaded.evidence_kind === "self_reported") {
    if (host.protocol.major !== loaded.protocol.major) addFinding(findings, "runtime.host_protocol_mismatch", "error", "Host-attested and self-reported protocol majors differ.", repairFor(model, version, false));
    if (host.protocol.minor !== loaded.protocol.minor) addFinding(findings, "runtime.host_protocol_minor_mismatch", "warning", "Host-attested and self-reported protocol minors differ.", repairFor(model, version, false));
    if (host.protocol.schema !== loaded.protocol.schema) addFinding(findings, "runtime.host_schema_mismatch", "warning", "Host-attested and self-reported protocol schemas differ.", repairFor(model, version, false));
    if (host.protocol.descriptor_hash !== loaded.protocol.descriptor_hash) addFinding(findings, "runtime.host_hash_mismatch", "warning", "Host-attested and self-reported descriptor hashes differ.", repairFor(model, version, false));
    if (host.package_version !== loaded.package_version) addFinding(findings, "runtime.host_version_mismatch", "warning", "Host-attested and self-reported package versions differ.", repairFor(model, version, false));
    if (host.module_origin !== "unknown" && host.module_origin !== loaded.module_origin) addFinding(findings, "runtime.host_origin_mismatch", "warning", "Host-attested and self-reported module origins differ.", repairFor(model, version, false));
  }
  for (const observation of declarations) {
    if (!["missing", "available", "declared"].includes(observation.status)) addFinding(findings, `declaration.${observation.source}.${observation.status}`, "warning", `${observation.path} declaration evidence is ${observation.status}.`, repairFor(model, version, false));
  }
  for (const observation of installations) {
    if (!["missing", "installed"].includes(observation.status)) addFinding(findings, `installation.${observation.source}.${observation.status}`, "warning", `${observation.path} installation evidence is ${observation.status}.`, repairFor(model, version, false));
  }
  if (!declared.length) addFinding(findings, "declaration.missing", "warning", "No supported project declaration for opencode-work-context was found.", repairFor(model, version, false));
  if (declared.some((item) => item.version === null)) addFinding(findings, "declaration.version_unpinned", "warning", "A managed package declaration does not identify an exact version.", repairFor(model, version, false));
  const declarationKeys = declared.map((item) => `${item.path}:${item.field}:${item.version || "unversioned"}`);
  if (new Set(declarationKeys).size !== declarationKeys.length) addFinding(findings, "declaration.duplicate", "warning", "A project configuration contains duplicate opencode-work-context declarations.", repairFor(model, version, false));
  if (models.length > 1) addFinding(findings, "declaration.installation_model_conflict", "error", "Managed and pinned-local declarations are both present.", repairFor(model, version, false));
  if (version && declared.some((item) => item.version && item.version !== version)) addFinding(findings, "declaration.version_mismatch", "warning", "A declared package version differs from the loaded package version.", repairFor(model, version, false));
  if (model === "pinned_local" && !installed.length) addFinding(findings, "installation.missing", "warning", "No safely discoverable pinned-local package manifest was found.", repairFor(model, version, false));
  if (version && installed.some((item) => item.version !== version)) addFinding(findings, "installation.version_mismatch", "warning", "An installed package version differs from the loaded package version.", repairFor(model, version, false));
  const localLoader = safeFile(projectRoot, relativeFiles.localLoader);
  if (model === "pinned_local" && localLoader.status !== "available") addFinding(findings, "origin.local_loader_missing", "warning", "Pinned-local declaration exists without a regular package-managed loader.", repairFor(model, version, false));
  if (loaded.evidence_kind === "self_reported"
    && ((model === "managed" && loaded.module_origin === "project_local") || (model === "pinned_local" && loaded.module_origin === "managed_cache"))) {
    addFinding(findings, "origin.installation_model_mismatch", "warning", "Loaded-plugin origin differs from the declared installation model.", repairFor(model, version, false));
  }

  findings.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return validateDeliveryDoctorEnvelope({
    contract_version: DELIVERY_DOCTOR_CONTRACT_VERSION,
    operation: DELIVERY_DOCTOR_OPERATION,
    protocol: {
      schema: WORK_CONTEXT_PROTOCOL.schema,
      major: WORK_CONTEXT_PROTOCOL.major,
      minor: WORK_CONTEXT_PROTOCOL.minor,
      descriptor_hash: WORK_CONTEXT_PROTOCOL_DESCRIPTOR_HASH,
    },
    evidence: { command, declarations, installations, loaded_plugin: loaded, host_attestation: host },
    findings,
    complete: true,
  });
}
