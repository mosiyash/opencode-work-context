# Durable Knowledge

## KC-0001: Live stage activity must be ephemeral and fail closed

- Kind: decision
- Status: active
- Created: 2026-11-16T06:13:33.693Z
- Updated: 2026-11-16T06:13:33.693Z
- Sources: ["plugin/attention.js","plugin/stages-tui.js","src/stages-snapshot.js","src/work-context-snapshot.js","src/sessions.js","test/attention.test.js","test/stages-tui.test.js"]

A stage activity indicator must represent only currently observed OpenCode runtime work, not canonical stage status. Use session.status busy/retry as the start signal and session.status idle or session.idle as the stop signal; question, permission, and error also stop the working indicator. Aggregate by distinct native OpenCode session IDs linked to active work-context session records for the visible workspace/stage: one stage loader is shown when any linked active session is currently working. Do not infer activity from stage status, session.updated, snapshot fallback, unread attention, persisted busy state, or historical handed-off/closed sessions. Initialize runtime activity as unknown/non-working after startup and fail closed when mapping or events are unavailable.

## KC-0002: Attention reasons already have stable categories and precedence

- Kind: fact
- Status: active
- Created: 2026-11-16T06:13:33.717Z
- Updated: 2026-11-16T06:13:33.717Z
- Sources: ["plugin/attention.js","plugin/stages-tui.js","plugin/session-switcher.js","plugin/stage-switcher.js","plugin/workspace-switcher.js","plugin/notifier.js","docs/adr/0005-background-attention-notifications.md","test/attention.test.js","test/stages-tui.test.js"]

The existing attention model classifies unread events as idle (displayed as response complete), question, permission, or error with precedence response complete < question < permission < error. Attention is persisted and acknowledged by exact event key; stage/workspace summaries aggregate distinct native sessions and retain the highest-priority reason. Sidebar presentation should replace generic ATTN text with a compact reason-specific marker while retaining a textual label and xN count for accessibility. Recommended taxonomy: ? question, ! permission, x error, and checkmark complete, with ASCII-safe bracketed fallback where necessary. Live activity remains a separate ephemeral state and may coexist with unread attention.
