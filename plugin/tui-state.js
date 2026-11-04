import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../src/storage.js";

export const TUI_STATE_FILE = path.join(".work-context", "local", "tui-state.json");

export const readTuiState = (root) => {
  if (!root) return { schema: 1 };
  try {
    const file = path.join(root, TUI_STATE_FILE);
    if (!fs.lstatSync(file).isFile()) return { schema: 1 };
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && value.schema === 1 && typeof value === "object" && !Array.isArray(value)
      ? value
      : { schema: 1 };
  } catch {
    return { schema: 1 };
  }
};

export const updateTuiState = (root, update) => {
  if (!root) return false;
  try {
    const current = readTuiState(root);
    const next = update(current);
    atomicWrite(path.join(root, TUI_STATE_FILE), `${JSON.stringify({ ...next, schema: 1 }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
};
