import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = 1;
const EVENT_TTL_MS = 5 * 60 * 1000;
const LEASE_STALE_MS = 30 * 1000;
const CLAIM_STALE_MS = 10 * 1000;
const MAX_FILE_SIZE = 8192;
const MAX_EVENTS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASONS = new Set(["idle", "question", "permission", "error"]);

const safeText = (value, limit = 80) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);

const ownedDirectory = (directory, uid) => {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && (uid === undefined || stat.uid === uid);
  } catch { return false; }
};

const ensurePrivateDirectory = (directory, uid) => {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!ownedDirectory(directory, uid)) return false;
    fs.chmodSync(directory, 0o700);
    return true;
  } catch { return false; }
};

export const defaultGlobalAttentionRoot = ({ env = process.env, uid = process.getuid?.() } = {}) => {
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime || !path.isAbsolute(runtime) || !ownedDirectory(runtime, uid)) return null;
  try {
    const mode = fs.statSync(runtime).mode & 0o777;
    if ((mode & 0o077) !== 0) return null;
  } catch { return null; }
  return path.join(runtime, "opencode-work-context", "attention-v1");
};

const atomicWrite = (file, value) => {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    return false;
  }
};

const readRecord = (file, uid) => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_SIZE || (uid !== undefined && stat.uid !== uid)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
};

const validLease = (value) => value
  && value.schema === SCHEMA
  && Object.keys(value).every((key) => ["schema", "instanceId", "heartbeatAt", "activeAt"].includes(key))
  && UUID.test(value.instanceId)
  && Number.isFinite(value.heartbeatAt)
  && Number.isFinite(value.activeAt);

const validEvent = (value) => value
  && value.schema === SCHEMA
  && Object.keys(value).every((key) => ["schema", "id", "sourceInstanceId", "dedupeKey", "createdAt", "expiresAt", "reason", "projectTitle", "workspaceTitle", "stageTitle"].includes(key))
  && UUID.test(value.id)
  && UUID.test(value.sourceInstanceId)
  && /^[0-9a-f]{24}$/.test(value.dedupeKey)
  && Number.isFinite(value.createdAt)
  && Number.isFinite(value.expiresAt)
  && value.expiresAt >= value.createdAt
  && REASONS.has(value.reason)
  && [value.projectTitle, value.workspaceTitle, value.stageTitle].every((item) => typeof item === "string" && item === safeText(item));

export const createGlobalAttentionChannel = ({
  root = defaultGlobalAttentionRoot(),
  instanceId = randomUUID(),
  now = () => Date.now(),
  pollMs = 750,
  heartbeatMs = 5000,
  activityThrottleMs = 250,
  leaseStaleMs = LEASE_STALE_MS,
  claimStaleMs = CLAIM_STALE_MS,
  eventTtlMs = EVENT_TTL_MS,
  uid = process.getuid?.(),
} = {}) => {
  const leasesDirectory = root && path.join(root, "leases");
  const eventsDirectory = root && path.join(root, "events");
  const leaseFile = leasesDirectory && path.join(leasesDirectory, `${instanceId}.json`);
  const seen = new Set();
  let activeAt = 0;
  let onEvent;
  let pollTimer;
  let heartbeatTimer;
  let activityTimer;
  let lastActivityWrite = 0;
  let started = false;

  const available = Boolean(root && UUID.test(instanceId)
    && ensurePrivateDirectory(root, uid)
    && ensurePrivateDirectory(leasesDirectory, uid)
    && ensurePrivateDirectory(eventsDirectory, uid));

  const writeLease = (activity = false) => {
    if (!available) return false;
    const timestamp = now();
    if (activity) {
      activeAt = Math.max(timestamp, activeAt + 1);
      lastActivityWrite = timestamp;
    }
    return atomicWrite(leaseFile, { schema: SCHEMA, instanceId, heartbeatAt: timestamp, activeAt });
  };

  const leases = () => {
    if (!available) return [];
    const timestamp = now();
    const result = [];
    let names = [];
    try { names = fs.readdirSync(leasesDirectory); } catch { return result; }
    for (const name of names) {
      if (!UUID.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
      const file = path.join(leasesDirectory, name);
      const lease = readRecord(file, uid);
      if (!validLease(lease) || lease.heartbeatAt > timestamp + leaseStaleMs || timestamp - lease.heartbeatAt > leaseStaleMs) {
        try { fs.rmSync(file, { force: true }); } catch {}
        continue;
      }
      result.push(lease);
    }
    return result;
  };

  const activeOwner = () => {
    const active = leases().filter((lease) => lease.activeAt > 0)
      .sort((left, right) => right.activeAt - left.activeAt || right.instanceId.localeCompare(left.instanceId))[0];
    return active?.instanceId || null;
  };
  const hasActiveInstance = () => activeOwner() !== null;
  const isActive = () => available && activeOwner() === instanceId;
  const remember = (key) => {
    seen.add(key);
    while (seen.size > MAX_EVENTS * 2) seen.delete(seen.values().next().value);
  };

  const activity = () => {
    if (!available) return false;
    const timestamp = now();
    const remaining = activityThrottleMs - (timestamp - lastActivityWrite);
    if (activityThrottleMs <= 0 || remaining <= 0) return writeLease(true);
    if (!activityTimer) {
      activityTimer = setTimeout(() => {
        activityTimer = undefined;
        writeLease(true);
      }, Math.max(1, Math.min(activityThrottleMs, remaining)));
      activityTimer.unref?.();
    }
    return true;
  };

  const deactivate = () => {
    if (!available) return false;
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = undefined;
    activeAt = 0;
    return writeLease(false);
  };

  const recoverClaims = (timestamp) => {
    let claims = [];
    try { claims = fs.readdirSync(eventsDirectory).filter((name) => /^claim-[0-9a-f-]+-[0-9a-f-]+\.json$/i.test(name)); } catch { return; }
    for (const name of claims) {
      const claimed = path.join(eventsDirectory, name);
      try {
        const stat = fs.lstatSync(claimed);
        if (!stat.isFile() || stat.isSymbolicLink() || timestamp - stat.mtimeMs < claimStaleMs) continue;
        const event = readRecord(claimed, uid);
        if (!validEvent(event) || event.expiresAt <= timestamp) {
          fs.rmSync(claimed, { force: true });
          continue;
        }
        const target = path.join(eventsDirectory, `event-${event.id}.json`);
        if (fs.existsSync(target)) fs.rmSync(claimed, { force: true });
        else fs.renameSync(claimed, target);
      } catch {}
    }
  };

  const scan = () => {
    if (!available || !isActive()) return 0;
    const timestamp = now();
    recoverClaims(timestamp);
    let files = [];
    try { files = fs.readdirSync(eventsDirectory).filter((name) => /^event-[0-9a-f-]+\.json$/i.test(name)); } catch { return 0; }
    const events = [];
    for (const name of files) {
      const file = path.join(eventsDirectory, name);
      const event = readRecord(file, uid);
      if (!validEvent(event) || event.expiresAt <= timestamp) {
        try { fs.rmSync(file, { force: true }); } catch {}
        continue;
      }
      events.push({ event, file });
    }
    events.sort((left, right) => left.event.createdAt - right.event.createdAt || left.event.id.localeCompare(right.event.id));
    const overflow = events.splice(0, Math.max(0, events.length - MAX_EVENTS));
    for (const item of overflow) try { fs.rmSync(item.file, { force: true }); } catch {}
    let delivered = 0;
    for (const { event, file } of events) {
      if (seen.has(event.id) || seen.has(event.dedupeKey)) {
        try { fs.rmSync(file, { force: true }); } catch {}
        continue;
      }
      const claim = path.join(eventsDirectory, `claim-${event.id}-${instanceId}.json`);
      try { fs.renameSync(file, claim); } catch { continue; }
      if (!isActive()) {
        try { fs.renameSync(claim, file); } catch {}
        continue;
      }
      try {
        if (typeof onEvent !== "function" || onEvent(event) === false) {
          try { fs.renameSync(claim, file); } catch {}
          continue;
        }
        remember(event.id);
        remember(event.dedupeKey);
        try { fs.rmSync(claim, { force: true }); } catch {}
        delivered += 1;
      } catch {
        try { fs.renameSync(claim, file); } catch {}
      }
    }
    return delivered;
  };

  const publish = ({ dedupeKey, reason, projectTitle, workspaceTitle, stageTitle } = {}) => {
    if (!available || !REASONS.has(reason)) return false;
    const timestamp = now();
    const id = randomUUID();
    const normalizedKey = createHash("sha256").update(String(dedupeKey ?? "")).digest("hex").slice(0, 24);
    return atomicWrite(path.join(eventsDirectory, `event-${id}.json`), {
      schema: SCHEMA,
      id,
      sourceInstanceId: instanceId,
      dedupeKey: normalizedKey,
      createdAt: timestamp,
      expiresAt: timestamp + eventTtlMs,
      reason,
      projectTitle: safeText(projectTitle),
      workspaceTitle: safeText(workspaceTitle),
      stageTitle: safeText(stageTitle),
    });
  };

  const start = (handler) => {
    if (!available || started) return available;
    started = true;
    onEvent = handler;
    writeLease(false);
    scan();
    if (pollMs > 0) { pollTimer = setInterval(scan, pollMs); pollTimer.unref?.(); }
    if (heartbeatMs > 0) { heartbeatTimer = setInterval(() => writeLease(false), heartbeatMs); heartbeatTimer.unref?.(); }
    return true;
  };

  const dispose = () => {
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (activityTimer) clearTimeout(activityTimer);
    pollTimer = undefined;
    heartbeatTimer = undefined;
    activityTimer = undefined;
    started = false;
    if (available) {
      const current = readRecord(leaseFile, uid);
      if (current?.instanceId === instanceId) try { fs.rmSync(leaseFile, { force: true }); } catch {}
    }
  };

  return {
    available,
    instanceId,
    start,
    activity,
    deactivate,
    hasActiveInstance,
    isActive,
    publish,
    scan,
    dispose,
  };
};
