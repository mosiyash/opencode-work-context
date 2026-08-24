import fs from "node:fs";
import { ERROR_CODES, fail } from "./errors.js";

const KINDS = new Set(["fact", "decision", "contract", "risk", "procedure"]);
const STATUSES = new Set(["active", "superseded"]);
const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const normalized = value.endsWith("Z") && !value.includes(".") ? value.replace("Z", ".000Z") : value;
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === normalized;
};

const parseList = (text) => {
  if (!text) fail(ERROR_CODES.STORAGE_ERROR, "Knowledge Sources metadata is required");
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail(ERROR_CODES.STORAGE_ERROR, "Knowledge Sources must be a JSON array"); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item.trim())) fail(ERROR_CODES.STORAGE_ERROR, "Knowledge Sources must be a non-empty string array");
  return parsed;
};

export function parseKnowledge(text) {
  if (!text.startsWith("# Durable Knowledge\n")) fail(ERROR_CODES.STORAGE_ERROR, "Invalid knowledge ledger header");
  const records = [];
  const sections = text.split(/^## (KC-\d{4}): (.+)$/m);
  if (sections[0] !== "# Durable Knowledge\n\n") fail(ERROR_CODES.STORAGE_ERROR, "Invalid knowledge ledger preamble");
  for (let index = 1; index < sections.length; index += 3) {
    const id = sections[index];
    const title = sections[index + 1];
    const section = sections[index + 2] || "";
    const lines = section.trim().split("\n");
    if (lines.some((line) => /^## KC-\d{4}:/.test(line))) fail(ERROR_CODES.STORAGE_ERROR, "Knowledge text contains an unescaped record heading");
    const bodyStart = lines.findIndex((line) => line === "") + 1;
    if (bodyStart < 1) fail(ERROR_CODES.STORAGE_ERROR, `Invalid knowledge metadata: ${id}`);
    const metadata = new Map();
    for (const line of lines.slice(0, bodyStart - 1)) {
      const match = line.match(/^- (Kind|Status|Created|Updated|Sources|Replacement):\s*(.*)$/);
      if (!match || metadata.has(match[1])) fail(ERROR_CODES.STORAGE_ERROR, `Invalid or duplicate knowledge metadata: ${id}`);
      metadata.set(match[1], match[2]);
    }
    for (const required of ["Kind", "Status", "Created", "Updated", "Sources"]) if (!metadata.has(required)) fail(ERROR_CODES.STORAGE_ERROR, `Missing knowledge metadata ${required}: ${id}`);
    const record = {
      id,
      title: title.trim(),
      kind: metadata.get("Kind"),
      status: metadata.get("Status"),
      created: metadata.get("Created"),
      updated: metadata.get("Updated"),
      sources: parseList(metadata.get("Sources")),
      replacement: metadata.get("Replacement") || null,
      text: "",
    };
    if (!record.kind || !KINDS.has(record.kind) || !record.status || !STATUSES.has(record.status) || !validDate(record.created) || !validDate(record.updated)) fail(ERROR_CODES.STORAGE_ERROR, `Invalid knowledge entry: ${id}`);
    if (!Array.isArray(record.sources)) fail(ERROR_CODES.STORAGE_ERROR, `Invalid knowledge sources: ${id}`);
    if (record.status === "superseded" && !record.replacement) fail(ERROR_CODES.STORAGE_ERROR, `Superseded knowledge requires replacement: ${id}`);
    if (record.status === "active" && record.replacement) fail(ERROR_CODES.STORAGE_ERROR, `Active knowledge cannot have replacement: ${id}`);
    if (validDate(record.created) && validDate(record.updated) && Date.parse(record.updated) < Date.parse(record.created)) fail(ERROR_CODES.STORAGE_ERROR, `Knowledge dates are out of order: ${id}`);
    record.text = (bodyStart ? lines.slice(bodyStart) : []).join("\n").trim();
    if (!record.title || !record.text) fail(ERROR_CODES.STORAGE_ERROR, `Knowledge entry is incomplete: ${id}`);
    records.push(record);
  }
  if (new Set(records.map((record) => record.id)).size !== records.length) fail(ERROR_CODES.STORAGE_ERROR, "Duplicate knowledge ID");
  validateKnowledgeRecords(records);
  return records;
}

export function validateKnowledgeRecords(records) {
  const ids = new Set(records.map((record) => record.id));
  for (const record of records) {
    if (record.status === "superseded") {
      if (!/^KC-\d{4}$/.test(record.replacement) || record.replacement === record.id || !ids.has(record.replacement)) fail(ERROR_CODES.STORAGE_ERROR, `Invalid knowledge replacement: ${record.id}`);
    }
  }
  for (const record of records) {
    const seen = new Set([record.id]);
    let next = record;
    while (next.status === "superseded") {
      if (seen.has(next.replacement)) fail(ERROR_CODES.STORAGE_ERROR, "Knowledge replacement cycle detected");
      seen.add(next.replacement);
      next = records.find((item) => item.id === next.replacement);
    }
  }
}

export function renderKnowledge(records) {
  const body = records.map((record) => [
    `## ${record.id}: ${record.title}`,
    "",
    `- Kind: ${record.kind}`,
    `- Status: ${record.status}`,
    `- Created: ${record.created}`,
    `- Updated: ${record.updated}`,
    `- Sources: ${JSON.stringify(record.sources || [])}`,
    ...(record.replacement ? [`- Replacement: ${record.replacement}`] : []),
    "",
    record.text.trim(),
  ].join("\n")).join("\n\n");
  return `# Durable Knowledge\n\n${body}${body ? "\n" : ""}`;
}

export function validateKnowledgeInput(input, partial = false) {
  if (!partial && !input.title?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Knowledge title is required");
  if (input.kind !== undefined && !KINDS.has(input.kind)) fail(ERROR_CODES.INVALID_ARGUMENT, "Invalid knowledge kind");
  if (input.status !== undefined && !STATUSES.has(input.status)) fail(ERROR_CODES.INVALID_ARGUMENT, "Invalid knowledge status");
  if (!partial && !input.text?.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, "Knowledge text is required");
  if (input.title !== undefined && /\r?\n/.test(input.title)) fail(ERROR_CODES.INVALID_ARGUMENT, "Knowledge title must be a single line");
  if (input.text !== undefined && /^## KC-\d{4}:/m.test(input.text)) fail(ERROR_CODES.INVALID_ARGUMENT, "Knowledge text cannot contain record headings");
  if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.some((source) => typeof source !== "string" || !source.trim()))) fail(ERROR_CODES.INVALID_ARGUMENT, "Knowledge sources must be a non-empty string array");
  if (input.status === "superseded" && partial && !input.replacement) fail(ERROR_CODES.INVALID_ARGUMENT, "Superseded knowledge requires replacement");
  if (input.replacement !== undefined && (!input.replacement.trim() || (input.id && input.replacement === input.id))) fail(ERROR_CODES.INVALID_ARGUMENT, "Invalid knowledge replacement");
  if (input.status === "active" && input.replacement !== undefined) fail(ERROR_CODES.INVALID_ARGUMENT, "Active knowledge cannot have replacement");
}

export const nextKnowledgeId = (records) => {
  const next = Math.max(0, ...records.map((record) => Number(record.id.slice(3)))) + 1;
  if (next > 9999) fail(ERROR_CODES.INVALID_STATE, "Knowledge ID limit reached");
  return `KC-${String(next).padStart(4, "0")}`;
};
