import { randomUUID } from "node:crypto";
import { ERROR_CODES, fail } from "./errors.js";

export const SESSION_STATES = ["active", "handed_off", "closed", "abandoned"];
export function reduceSessions(events) {
  const sessions = new Map();
  for (const event of events) {
    let state = sessions.get(event.session_id) ?? { session_id: event.session_id, workspace: event.workspace, stage: event.stage, ordinal: event.ordinal, actor: event.actor, summary: "", state: null, started_at: event.occurred_at };
    if (event.event === "session.started") { state = { ...state, ...event.data, state: "active", started_at: event.occurred_at }; }
    if (event.event === "session.renamed") state.summary = event.data.summary;
    if (event.event === "session.handed_off") state.state = "handed_off";
    if (event.event === "session.closed") state.state = "closed";
    if (event.event === "session.abandoned") state.state = "abandoned";
    state.updated_at = event.occurred_at; sessions.set(event.session_id, state);
  }
  return [...sessions.values()];
}
export const activeSession = (events, workspace, stage) => reduceSessions(events).find((item) => item.workspace === workspace && item.stage === stage && item.state === "active");
export function event(event, workspace, stage, ordinal, sessionId, actor, data = {}) { return { schema: 1, event_id: randomUUID(), event, occurred_at: new Date().toISOString(), session_id: sessionId, workspace, stage, ordinal, actor, data }; }
export function assertActive(events, workspace, stage, sessionId) { const session = reduceSessions(events).find((item) => item.session_id === sessionId && item.workspace === workspace && item.stage === stage); if (!session || session.state !== "active") fail(ERROR_CODES.SESSION_NOT_ACTIVE, "Session is not active"); return session; }
