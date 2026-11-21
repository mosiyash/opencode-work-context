# Durable Knowledge

## KC-0001: Planning is not a dependency gate

- Kind: contract
- Status: active
- Created: 2026-11-21T16:52:16.193Z
- Updated: 2026-11-21T16:52:16.193Z
- Sources: ["Established project rule in workspace 000025 knowledge","Planning discussion for workspace 000026"]

Never add dependencies from implementation, research, review, or other working stages to Planning stage 01. Planning remains a continuously available workspace coordination surface while work is underway, not a prerequisite gate. Add dependencies only between working stages when their deliverables genuinely require ordering. Existing accidental dependencies must be corrected only through supported structured operations; never edit work-context projections directly.

## KC-0002: Planning is not a dependency gate

- Kind: decision
- Status: active
- Created: 2026-11-21T19:03:25.110Z
- Updated: 2026-11-21T19:03:25.110Z
- Sources: ["src/core.js","src/errors.js","commands/wc.md","README.md"]

Planning stage 01 is a continuously available coordination surface. Core stage creation rejects dependencies on it with PLANNING_DEPENDENCY_FORBIDDEN; only working stages may depend on one another when ordering is necessary.
