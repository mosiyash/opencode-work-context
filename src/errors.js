export const ERROR_CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND", INVALID_ARGUMENT: "INVALID_ARGUMENT", INVALID_STATE: "INVALID_STATE",
  ACTIVE_SESSION_EXISTS: "ACTIVE_SESSION_EXISTS", SESSION_NOT_ACTIVE: "SESSION_NOT_ACTIVE",
  LOCKED: "LOCKED", STALE_LOCK: "STALE_LOCK", CONFLICT: "CONFLICT", INVALID_ISSUE_URL: "INVALID_ISSUE_URL",
  ADAPTER_UNAVAILABLE: "ADAPTER_UNAVAILABLE", STORAGE_ERROR: "STORAGE_ERROR", CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
});

export class WorkContextError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "WorkContextError"; this.code = code; this.details = details; }
}
export const fail = (code, message, details) => { throw new WorkContextError(code, message, details); };
