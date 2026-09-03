import { ERROR_CODES, fail } from "./errors.js";

const normalizeIdentifier = (value, { name, digits }) => {
  const input = typeof value === "string" ? value : "";
  if (!new RegExp(`^\\d{1,${digits}}$`).test(input) || Number(input) === 0) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${name} ID must be an integer from 1 to ${"9".repeat(digits)}`);
  }
  return input.padStart(digits, "0");
};

export const normalizeWorkspaceId = (value) => normalizeIdentifier(value, { name: "Workspace", digits: 6 });
export const normalizeStageId = (value) => normalizeIdentifier(value, { name: "Stage", digits: 2 });
