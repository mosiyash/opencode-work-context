import path from "node:path";
import { DELIVERY_DIAGNOSTIC_LIMITS } from "./delivery-contracts.js";
import { ERROR_CODES, fail } from "./errors.js";

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const invalidGlobCharacters = /[\u0000-\u001f\u007f\\\[\]{}?!]/u;

export function validateSecretPathPatterns(value = []) {
  if (!Array.isArray(value) || value.length > DELIVERY_DIAGNOSTIC_LIMITS.secret_path_patterns) {
    fail(ERROR_CODES.STORAGE_ERROR, "Invalid work-context config");
  }
  const patterns = value.map((pattern) => {
    if (typeof pattern !== "string" || !pattern || pattern.length > DELIVERY_DIAGNOSTIC_LIMITS.secret_path_pattern_characters
      || path.posix.isAbsolute(pattern) || invalidGlobCharacters.test(pattern)) {
      fail(ERROR_CODES.STORAGE_ERROR, "Invalid work-context config");
    }
    const segments = pattern.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || (segment.includes("**") && segment !== "**"))) {
      fail(ERROR_CODES.STORAGE_ERROR, "Invalid work-context config");
    }
    return pattern;
  });
  if (new Set(patterns).size !== patterns.length) fail(ERROR_CODES.STORAGE_ERROR, "Invalid work-context config");
  return patterns;
}

const segmentMatches = (pattern, value) => {
  const source = pattern.split("*").map((part) => part.replace(/[.+^$()|]/gu, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "u").test(value);
};
const pathMatches = (pattern, value) => {
  const patterns = pattern.split("/");
  const segments = value.split("/");
  const memo = new Map();
  const visit = (patternIndex, segmentIndex) => {
    const key = `${patternIndex}:${segmentIndex}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (patternIndex === patterns.length) return segmentIndex === segments.length;
    if (patterns[patternIndex] === "**") {
      result = visit(patternIndex + 1, segmentIndex) || (segmentIndex < segments.length && visit(patternIndex, segmentIndex + 1));
    } else {
      result = segmentIndex < segments.length && segmentMatches(patterns[patternIndex], segments[segmentIndex]) && visit(patternIndex + 1, segmentIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
};

export function createDeliveryPathRedactor(patterns, paths) {
  const validatedPatterns = validateSecretPathPatterns(patterns);
  const redactedPaths = [...new Set(paths.filter((value) => typeof value === "string" && validatedPatterns.some((pattern) => pathMatches(pattern, value))))].sort(compareText);
  const tokens = new Map(redactedPaths.map((value, index) => [value, `<redacted:path-${String(index + 1).padStart(4, "0")}>`]));
  const textPaths = [...redactedPaths].sort((left, right) => right.length - left.length || compareText(left, right));
  return {
    path(value) { return tokens.get(value) || value; },
    text(value) {
      if (typeof value !== "string") return value;
      return textPaths.reduce((text, secretPath) => text.split(secretPath).join(tokens.get(secretPath)), value);
    },
    summary: {
      applied: tokens.size > 0,
      path_count: tokens.size,
      tokens: [...tokens.values()],
    },
  };
}
