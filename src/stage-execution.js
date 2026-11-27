import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
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

const ITEM_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|legacy-[0-9a-f]{24})$/;
const exactKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const validTimestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const legacyItemId = (section, index, text) => `legacy-${createHash("sha256").update(`${section}\u0000${index}\u0000${text}`).digest("hex").slice(0, 24)}`;

const normalizeText = (text, section, code = ERROR_CODES.INVALID_ARGUMENT) => {
  if (typeof text !== "string" || !text.trim()) fail(code, `${section} must contain non-empty item text`);
  const value = text.trim();
  if (value.length > EXECUTION_LIMITS.itemLength) fail(code === ERROR_CODES.STORAGE_ERROR ? code : ERROR_CODES.EXECUTION_LIMIT_EXCEEDED, `Execution items cannot exceed ${EXECUTION_LIMITS.itemLength} characters`);
  return value;
};

const normalizeItems = (items, section) => {
  if (!Array.isArray(items)) fail(ERROR_CODES.INVALID_ARGUMENT, `${section} must be an array of strings`);
  if (items.length > EXECUTION_LIMITS.itemsPerSection) fail(ERROR_CODES.EXECUTION_LIMIT_EXCEEDED, `${section} cannot contain more than ${EXECUTION_LIMITS.itemsPerSection} items`);
  const normalized = [];
  for (const item of items) {
    if (typeof item !== "string") fail(ERROR_CODES.INVALID_ARGUMENT, `${section} must contain strings`);
    const value = normalizeText(item, section);
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
};

const assertItemCounts = (items, code = ERROR_CODES.EXECUTION_LIMIT_EXCEEDED) => {
  for (const section of EXECUTION_SECTIONS) {
    if (items[section].length > EXECUTION_LIMITS.itemsPerSection) fail(code, `${section} cannot contain more than ${EXECUTION_LIMITS.itemsPerSection} items`);
  }
  const total = EXECUTION_SECTIONS.reduce((count, section) => count + items[section].length, 0);
  if (total > EXECUTION_LIMITS.totalItems) fail(code, `Execution state cannot contain more than ${EXECUTION_LIMITS.totalItems} items`);
};

const assertUniqueIds = (items, code = ERROR_CODES.INVALID_ARGUMENT) => {
  const ids = EXECUTION_SECTIONS.flatMap((section) => items[section].map((item) => item.id));
  if (new Set(ids).size !== ids.length) fail(code, "Execution item IDs must be unique");
};

export function normalizeExecutionState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !exactKeys(input, EXECUTION_SECTIONS)) fail(ERROR_CODES.INVALID_ARGUMENT, "Execution state contains unsupported fields");
  const state = Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, normalizeItems(input[section] ?? [], section)]));
  assertItemCounts(Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, state[section].map((text) => ({ text }))])));
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

const validateId = (id, code = ERROR_CODES.INVALID_ARGUMENT) => {
  if (typeof id !== "string" || !ITEM_ID.test(id)) fail(code, "Execution item ID is invalid");
  return id;
};

const normalizeStoredItems = (items) => {
  if (!items || typeof items !== "object" || Array.isArray(items) || !exactKeys(items, EXECUTION_SECTIONS)) fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage execution state");
  const normalized = {};
  for (const section of EXECUTION_SECTIONS) {
    if (!Array.isArray(items[section])) fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage execution state");
    normalized[section] = items[section].map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || !exactKeys(item, ["id", "text"])) fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage execution state");
      const text = normalizeText(item.text, section, ERROR_CODES.STORAGE_ERROR);
      if (text !== item.text) fail(ERROR_CODES.STORAGE_ERROR, "Stage execution state is not normalized");
      return { id: validateId(item.id, ERROR_CODES.STORAGE_ERROR), text };
    });
  }
  assertItemCounts(normalized, ERROR_CODES.STORAGE_ERROR);
  assertUniqueIds(normalized, ERROR_CODES.STORAGE_ERROR);
  return normalized;
};

export function executionItems(record) {
  if (record.schema === 2) return Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, record.items[section].map((item) => ({ ...item }))]));
  return Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, record[section].map((text, index) => ({ id: legacyItemId(section, index, text), text }))]));
}

export function executionReadModel(record) {
  const items = executionItems(record);
  return {
    schema: record.schema,
    workspace: record.workspace,
    stage: record.stage,
    revision: record.revision,
    created_at: record.created_at,
    updated_at: record.updated_at,
    updated_by: record.updated_by,
    ...Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, items[section].map((item) => item.text)])),
    items,
    current: items.remaining[0] || null,
    queued: items.remaining.slice(1),
  };
}

export function executionState(record) {
  return Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, executionItems(record)[section].map((item) => item.text)]));
}

export function executionItemsFromState(state, previous = null) {
  const previousItems = previous ? executionItems(previous) : Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, []]));
  const used = new Set();
  const take = (section, text) => previousItems[section].find((item) => item.text === text && !used.has(item.id))
    || EXECUTION_SECTIONS.flatMap((name) => previousItems[name]).find((item) => item.text === text && !used.has(item.id));
  const items = Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, state[section].map((text) => {
    const previousItem = take(section, text);
    if (previousItem) used.add(previousItem.id);
    return previousItem || { id: randomUUID(), text };
  })]));
  assertUniqueIds(items);
  return items;
}

export function executionInputUsesItems(input) {
  return EXECUTION_SECTIONS.some((section) => Array.isArray(input?.[section]) && input[section].some((item) => typeof item !== "string"));
}

export function executionPatchUsesItems(patch) {
  return Boolean(patch?.edit) || [patch?.add, patch?.remove].some((changes) => EXECUTION_SECTIONS.some((section) => Array.isArray(changes?.[section]) && changes[section].some((item) => typeof item !== "string")));
}

export function applyExecutionTextPatchItems(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !exactKeys(patch, ["add", "remove"]) || (!patch.add && !patch.remove)) fail(ERROR_CODES.INVALID_ARGUMENT, "Execution update requires add or remove changes");
  const validateChanges = (changes, operation) => {
    if (changes === undefined) return {};
    if (!changes || typeof changes !== "object" || Array.isArray(changes) || !exactKeys(changes, EXECUTION_SECTIONS)) fail(ERROR_CODES.INVALID_ARGUMENT, `Execution ${operation} changes contain unsupported fields`);
    return Object.fromEntries(Object.entries(changes).map(([section, values]) => [section, normalizeItems(values, section)]));
  };
  const add = validateChanges(patch.add, "add");
  const remove = validateChanges(patch.remove, "remove");
  const items = executionItems(current);
  const previousOverlap = new Set(items.completed.map((item) => item.text).filter((text) => items.remaining.some((item) => item.text === text)));
  const removedByText = new Map();
  for (const section of EXECUTION_SECTIONS) {
    for (const text of remove[section] || []) {
      const matches = items[section].filter((item) => item.text === text);
      if (matches.length > 1) fail(ERROR_CODES.INVALID_ARGUMENT, "Text-only execution removal is ambiguous; use an item ID", { text, matches: matches.length });
      if (matches[0]) removedByText.set(text, [...(removedByText.get(text) || []), matches[0]]);
      items[section] = items[section].filter((item) => item.text !== text);
    }
  }
  for (const section of EXECUTION_SECTIONS) {
    for (const text of add[section] || []) {
      if (items[section].some((item) => item.text === text)) continue;
      const removed = removedByText.get(text) || [];
      if (removed.length > 1) fail(ERROR_CODES.INVALID_ARGUMENT, "Text-only execution movement is ambiguous; use item IDs", { text, matches: removed.length });
      items[section].push(removed.shift() || { id: randomUUID(), text });
    }
  }
  const overlap = items.completed.map((item) => item.text).find((text) => items.remaining.some((item) => item.text === text) && !previousOverlap.has(text));
  if (overlap) fail(ERROR_CODES.INVALID_ARGUMENT, "An item cannot be both completed and remaining", { item: overlap });
  assertItemCounts(items);
  assertUniqueIds(items);
  return items;
}

export function normalizeExecutionItemState(input, previous = null) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !exactKeys(input, EXECUTION_SECTIONS)) fail(ERROR_CODES.INVALID_ARGUMENT, "Execution state contains unsupported fields");
  const previousItems = previous ? executionItems(previous) : Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, []]));
  const used = new Set();
  const items = {};
  for (const section of EXECUTION_SECTIONS) {
    const sectionItems = input[section] ?? [];
    if (!Array.isArray(sectionItems)) fail(ERROR_CODES.INVALID_ARGUMENT, `${section} must be an array`);
    items[section] = sectionItems.map((item) => {
      if (typeof item === "string") {
        const text = normalizeText(item, section);
        const previousItem = previousItems[section].find((candidate) => candidate.text === text && !used.has(candidate.id));
        if (previousItem) used.add(previousItem.id);
        return previousItem || { id: randomUUID(), text };
      }
      if (!item || typeof item !== "object" || Array.isArray(item) || !exactKeys(item, ["id", "text"]) || item.text === undefined) fail(ERROR_CODES.INVALID_ARGUMENT, `${section} contains an invalid execution item`);
      const id = item.id === undefined ? randomUUID() : validateId(item.id);
      used.add(id);
      return { id, text: normalizeText(item.text, section) };
    });
  }
  assertItemCounts(items);
  assertUniqueIds(items);
  return items;
}

const normalizeItemChanges = (changes, operation) => {
  if (changes === undefined) return {};
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !exactKeys(changes, EXECUTION_SECTIONS)) fail(ERROR_CODES.INVALID_ARGUMENT, `Execution ${operation} changes contain unsupported fields`);
  const result = {};
  for (const [section, sectionItems] of Object.entries(changes)) {
    if (!Array.isArray(sectionItems)) fail(ERROR_CODES.INVALID_ARGUMENT, `Execution ${operation} ${section} changes must be an array`);
    result[section] = sectionItems.map((item) => {
      if (typeof item === "string") {
        if (operation === "edit") fail(ERROR_CODES.INVALID_ARGUMENT, "Structured execution edits require item IDs and text");
        const text = normalizeText(item, section);
        return operation === "add" ? { id: randomUUID(), text } : { text };
      }
      if (operation === "remove") {
        if (!item || typeof item !== "object" || Array.isArray(item) || !exactKeys(item, ["id"])) fail(ERROR_CODES.INVALID_ARGUMENT, "Structured execution removals require an item ID");
        return { id: validateId(item.id) };
      }
      if (!item || typeof item !== "object" || Array.isArray(item) || !exactKeys(item, ["id", "text"]) || item.text === undefined) fail(ERROR_CODES.INVALID_ARGUMENT, `Structured execution ${operation} changes require item IDs and text`);
      return { id: operation === "add" && item.id === undefined ? randomUUID() : validateId(item.id), text: normalizeText(item.text, section) };
    });
  }
  return result;
};

export function applyExecutionItemPatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !exactKeys(patch, ["add", "remove", "edit"]) || (!patch.add && !patch.remove && !patch.edit)) fail(ERROR_CODES.INVALID_ARGUMENT, "Execution update requires add, remove, or edit changes");
  const add = normalizeItemChanges(patch.add, "add");
  const remove = normalizeItemChanges(patch.remove, "remove");
  const edit = normalizeItemChanges(patch.edit, "edit");
  const items = executionItems(current);
  for (const section of EXECUTION_SECTIONS) {
    const known = new Set(items[section].map((item) => item.id));
    const removed = new Set((remove[section] || []).map((item) => {
      if (item.id) return item.id;
      const matches = items[section].filter((candidate) => candidate.text === item.text);
      if (matches.length !== 1) fail(ERROR_CODES.INVALID_ARGUMENT, "Text-only execution removal is ambiguous; use an item ID", { text: item.text, matches: matches.length });
      return matches[0].id;
    }));
    const edits = new Map((edit[section] || []).map((item) => [item.id, item.text]));
    for (const id of [...removed, ...edits.keys()]) if (!known.has(id)) fail(ERROR_CODES.INVALID_ARGUMENT, "Execution item ID was not found", { id });
    items[section] = items[section]
      .filter((item) => !removed.has(item.id))
      .map((item) => edits.has(item.id) ? { id: item.id, text: edits.get(item.id) } : item);
    items[section].push(...(add[section] || []));
  }
  assertItemCounts(items);
  assertUniqueIds(items);
  return items;
}

export function validateExecutionRecord(record, workspace, stage) {
  const legacyAllowed = ["schema", "workspace", "stage", "revision", "created_at", "updated_at", "updated_by", ...EXECUTION_SECTIONS];
  const currentAllowed = ["schema", "workspace", "stage", "revision", "created_at", "updated_at", "updated_by", "items"];
  if (!record || typeof record !== "object" || Array.isArray(record)
    || ![1, 2].includes(record.schema) || record.workspace !== workspace || record.stage !== stage
    || !Number.isInteger(record.revision) || record.revision < 1
    || !validTimestamp(record.created_at) || !validTimestamp(record.updated_at)
    || Date.parse(record.updated_at) < Date.parse(record.created_at)
    || typeof record.updated_by !== "string" || !record.updated_by.trim()) {
    fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage execution state");
  }
  try {
    if (record.schema === 1) {
      if (!exactKeys(record, legacyAllowed)) fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage execution state");
      const state = normalizeExecutionState(Object.fromEntries(EXECUTION_SECTIONS.map((section) => [section, record[section]])));
      if (EXECUTION_SECTIONS.some((section) => JSON.stringify(state[section]) !== JSON.stringify(record[section]))) fail(ERROR_CODES.STORAGE_ERROR, "Stage execution state is not normalized");
    } else {
      if (!exactKeys(record, currentAllowed)) fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage execution state");
      normalizeStoredItems(record.items);
    }
  } catch (error) {
    if (error.code === ERROR_CODES.STORAGE_ERROR) throw error;
    fail(ERROR_CODES.STORAGE_ERROR, "Invalid stage execution state", { cause: error.message });
  }
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > EXECUTION_LIMITS.bytes) fail(ERROR_CODES.STORAGE_ERROR, "Stage execution state exceeds its storage limit");
  return record;
}

export function assertExecutionSize(record) {
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > EXECUTION_LIMITS.bytes) fail(ERROR_CODES.EXECUTION_LIMIT_EXCEEDED, `Execution state cannot exceed ${EXECUTION_LIMITS.bytes} bytes`);
}
