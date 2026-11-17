import { Buffer } from "node:buffer";
import { ERROR_CODES, fail } from "./errors.js";

export const EXECUTION_SECTIONS = Object.freeze([
  "scope",
  "completed",
  "remaining",
  "decisions",
  "blockers",
  "verification",
]);

export const EXECUTION_LIMITS = Object.freeze({
  itemsPerSection: 50,
  totalItems: 200,
  itemLength: 500,
  bytes: 32768,
});

const exactKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const validTimestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

const normalizeItems = (items, section) => {
  if (!Array.isArray(items)) fail(ERROR_CODES.INVALID_ARGUMENT, `${section} must be an array of strings`);
  if (items.length > EXECUTION_LIMITS.itemsPerSection) fail(ERROR_CODES.EXECUTION_LIMIT_EXCEEDED, `${section} cannot contain more than ${EXECUTION_LIMITS.itemsPerSection} items`);
  const normalized = [];
  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, `${section} must contain non-empty strings`);
    const value = item.trim();
    if (value.length > EXECUTION_LIMITS.itemLength) fail(ERROR_CODES.EXECUTION_LIMIT_EXCEEDED, `Execution items cannot exceed ${EXECUTION_LIMITS.itemLength} characters`);
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
};

export function normalizeExecutionState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !exactKeys(input, EXECUTION_SECTIONS)) fail(ERROR_CODES.INVALID_ARGUMENT, "Execution state contains unsupported fields");
  const state = Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, normalizeItems(input[section] ?? [], section)]));
  const total = EXECUTION_SECTIONS.reduce((count, section) => count + state[section].length, 0);
  if (total > EXECUTION_LIMITS.totalItems) fail(ERROR_CODES.EXECUTION_LIMIT_EXCEEDED, `Execution state cannot contain more than ${EXECUTION_LIMITS.totalItems} items`);
  const remaining = new Set(state.remaining);
  const overlap = state.completed.find((item) => remaining.has(item));
  if (overlap) fail(ERROR_CODES.INVALID_ARGUMENT, "An item cannot be both completed and remaining", { item: overlap });
  return state;
}

export function applyExecutionPatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !exactKeys(patch, ["add", "remove"]) || (!patch.add && !patch.remove)) fail(ERROR_CODES.INVALID_ARGUMENT, "Execution update requires add or remove changes");
  const validateChanges = (changes, operation) => {
    if (changes === undefined) return {};
    if (!changes || typeof changes !== "object" || Array.isArray(changes) || !exactKeys(changes, EXECUTION_SECTIONS)) fail(ERROR_CODES.INVALID_ARGUMENT, `Execution ${operation} changes contain unsupported fields`);
    return Object.fromEntries(Object.entries(changes).map(([section, items]) => [section, normalizeItems(items, section)]));
  };
  const add = validateChanges(patch.add, "add");
  const remove = validateChanges(patch.remove, "remove");
  const next = {};
  for (const section of EXECUTION_SECTIONS) {
    const removed = new Set(remove[section] || []);
    next[section] = [...current[section].filter((item) => !removed.has(item)), ...(add[section] || [])];
  }
  return normalizeExecutionState(next);
}

export function validateExecutionRecord(record, workspace, stage) {
  const allowed = ["schema", "workspace", "stage", "revision", "created_at", "updated_at", "updated_by", ...EXECUTION_SECTIONS];
  if (!record || typeof record !== "object" || Array.isArray(record) || !exactKeys(record, allowed)
    || record.schema !== 1 || record.workspace !== workspace || record.stage !== stage
    || !Number.isInteger(record.revision) || record.revision < 1
    || !validTimestamp(record.created_at) || !validTimestamp(record.updated_at)
    || Date.parse(record.updated_at) < Date.parse(record.created_at)
    || typeof record.updated_by !== "string" || !record.updated_by.trim()) {
    fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage execution state");
  }
  let state;
  try { state = normalizeExecutionState(Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, record[section]]))); }
  catch (error) { fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage execution state", { cause: error.message }); }
  if (EXECUTION_SECTIONS.some((section) => JSON.stringify(state[section]) !== JSON.stringify(record[section]))) fail(ERROR_CODES.STORAGE_ERROR, "Stage execution state is not normalized");
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > EXECUTION_LIMITS.bytes) fail(ERROR_CODES.STORAGE_ERROR, "Stage execution state exceeds its storage limit");
  return record;
}

export function executionState(record) {
  return Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, record[section]]));
}

export function assertExecutionSize(record) {
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > EXECUTION_LIMITS.bytes) fail(ERROR_CODES.EXECUTION_LIMIT_EXCEEDED, `Execution state cannot exceed ${EXECUTION_LIMITS.bytes} bytes`);
}
