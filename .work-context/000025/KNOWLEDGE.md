# Durable Knowledge

## KC-0001: User-acknowledged Git commit coordination

- Kind: decision
- Status: active
- Created: 2026-11-20T06:58:24.529Z
- Updated: 2026-11-20T10:01:09.869Z
- Sources: ["docs/adr/0006-startup-commit-candidate-workflow.md","docs/adr/0007-stage-execution-ledger.md","src/core.js","src/git-acknowledgement.js","src/tool-definitions.js"]

Git cannot establish that a HEAD movement is the user's commit of the active stage: commit authors, paths, diffs, and session history are not reliable ownership evidence. Add an explicit user acknowledgement directive `/commited <short-or-full-SHA>` (the spelling is intentional). The user copies the abbreviated hash already printed by `git commit`; no follow-up Git command is required. Resolve the input to one full commit hash, require that it equals current HEAD, that the session checkpoint's head is its ancestor, that the attached branch/ref is unchanged, and that no Git operation is in progress. On success, advance only that active session's local Git checkpoint and continue without provenance reconstruction or repeated broad Git inspection. Store checkpoints locally, outside tracked workspace projections and workspace knowledge; no migration is needed. The acknowledgement does not assign commit, file, hunk, candidate, or stage ownership, and it must not alter candidate lifecycle. A changed ref, detached HEAD, non-fast-forward movement, active Git operation, ambiguous/nonexistent hash, acknowledgement not at HEAD, or unknown changes overlapping the next intended edit requires a stop-and-ask response. Disjoint changes can continue after a bounded changed-path check. The protocol applies to both modes; startup candidate capture/publication semantics remain unchanged. Treat the directive as a deterministic light control-plane operation, not a binding to a named model. OpenCode exposes no package API for per-slash-command model routing, so command metadata documents the light intent without claiming to force a local mapping. It must not invoke deep or standard reasoning, and its result should be a compact direct acknowledgement rather than an analysis returned to the primary agent.

## KC-0002: Planning stage must remain non-blocking

- Kind: fact
- Status: active
- Created: 2026-11-20T10:00:34.997Z
- Updated: 2026-11-20T10:00:34.997Z
- Sources: ["Explicit user workflow decision during Planning"]

Never add dependencies from implementation, research, review, or other working stages to Planning stage 01. Planning is a continuously available workspace coordination surface while work is underway, not a prerequisite gate. Add dependencies only between working stages when their deliverables genuinely require ordering. Existing accidental dependencies on Planning should be removed through supported structured operations when that capability becomes available; never edit work-context projections directly.

## KC-0003: Checklist UI derives from canonical execution state

- Kind: decision
- Status: active
- Created: 2026-11-20T10:09:43.659Z
- Updated: 2026-11-20T10:09:43.659Z
- Sources: ["src/stages-snapshot.js","plugin/stages-tui.js","commands/wc.md","test/stages-tui.test.js"]

The TUI checklist has no parallel Todo store. The read-only stages snapshot attaches canonical execution state only to the current stage. With sidebar details enabled, the sidebar derives a compact Todo summary from completed, remaining, and blocker items. Ctrl+X 2 opens a read-only dialog where the first remaining item is current, later remaining items are queued, and completed, blockers, verification, scope, and decisions remain separately grouped. Agents advance meaningful work by reading the latest execution revision and atomically moving the exact item from remaining to completed.
