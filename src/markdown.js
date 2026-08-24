import fs from "node:fs";
import { ERROR_CODES, fail } from "./errors.js";

const scalar = (value) => {
  const text = value.trim();
  if (text === "null") return null;
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (/^(true|false)$/.test(text)) return text === "true";
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('"') || text.endsWith('"')) { try { return JSON.parse(text); } catch { fail(ERROR_CODES.STORAGE_ERROR, "Invalid quoted Markdown scalar"); } }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith("[") || text.startsWith("{")) {
    try { return JSON.parse(text); } catch { fail(ERROR_CODES.STORAGE_ERROR, "Invalid JSON Markdown scalar"); }
  }
  return text;
};

export function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const closing = text.match(/\n---\n/);
  const end = closing?.index ?? -1;
  if (end < 0) return { data: {}, body: text };
  const data = Object.create(null);
  for (const line of text.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match || Object.hasOwn(data, match[1])) fail(ERROR_CODES.STORAGE_ERROR, "Invalid or duplicate Markdown metadata");
    data[match[1]] = scalar(match[2]);
  }
  return { data, body: text.slice(end + 4).replace(/^\n/, "") };
}

const yamlValue = (value) => Array.isArray(value) || (value && typeof value === "object") ? JSON.stringify(value) : value === null ? "null" : typeof value === "string" ? JSON.stringify(value) : String(value);
export function renderMarkdown(data, body = "") {
  return `---\n${Object.entries(data).map(([key, value]) => `${key}: ${yamlValue(value)}`).join("\n")}\n---\n\n${body.trimEnd()}\n`;
}
export const readMarkdown = (file) => parseFrontmatter(fs.readFileSync(file, "utf8"));
