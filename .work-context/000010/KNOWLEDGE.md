# Durable Knowledge

## KC-0001: Stage completion and reopen policy

- Kind: decision
- Status: active
- Created: 2026-09-21T04:44:06.748Z
- Updated: 2026-09-21T04:44:06.748Z
- Sources: ["stage:01"]

Stage completion must require an explicit user lifecycle command unless the current workspace Planning-stage prompt explicitly records an agreement allowing automatic completion. Reopening a completed stage must preserve its completion history and result, record a reason, avoid downstream mutations, and require an explicit separate-session resume rather than automatically starting work.

## KC-0002: Explicit completion and reopen lifecycle

- Kind: decision
- Status: active
- Created: 2026-09-21T05:47:21.704Z
- Updated: 2026-09-21T05:47:21.704Z
- Sources: ["stage:02"]

Stage finish is agent-guided only by an explicit user lifecycle request. Automatic completion is allowed only when the current workspace Planning-stage prompt has the exact standalone line AUTO_STAGE_FINISH: allowed; resume context exposes this as lifecycle.automatic_finish_allowed. Reopening is performed by work_context_reopen_stage with a reason only for completed stages. It preserves the prior result in immutable reopen history, records timestamp, reason and actor, moves the stage and any completed workspace back to in_progress, leaves downstream stages unchanged, and requires an explicit separate-session resume.
