# Durable Knowledge

## KC-0001: Commit boundaries are independent of stage boundaries

- Kind: decision
- Status: active
- Created: 2026-11-16T17:38:59.671Z
- Updated: 2026-11-16T17:38:59.671Z
- Sources: ["docs/adr/0006-startup-commit-candidate-workflow.md","src/core.js","src/candidates.js","src/git-candidates.js"]

In startup mode, a commit represents a coherent repository change rather than the output of exactly one stage. Stages, commit candidates, and commits have a many-to-many relationship. Mixed provenance is not a blocker. Prefer, in order: an exact candidate for a separable patch; a shared foundation candidate used by several stages; an integration candidate when already-intertwined changes cannot be split safely. Related stage metadata is traceability only and must never imply file or hunk ownership. Publication must stop only for a concrete patch conflict, an incoherent candidate, or failed required verification.

## KC-0002: Long stages need a durable execution ledger

- Kind: decision
- Status: active
- Created: 2026-11-17T04:27:26.611Z
- Updated: 2026-11-17T04:40:46.064Z
- Sources: ["docs/adr/0007-stage-execution-ledger.md","src/stage-execution.js","src/core.js","src/storage.js"]

Long-running stages can accumulate substantial scope through repeated user follow-ups. This operational state must survive context compaction, process termination, handoff, and resume. Workspace knowledge is not the right primary store because it is shared with every stage and should contain only durable cross-stage facts. The implemented design uses an optional canonical stage-local JSON ledger with scope, completed, remaining, decisions, blockers, and verification sections. The ledger is bounded and normalized, uses monotonic revisions with compare-and-swap replacement or atomic add/remove updates, and requires active-session ownership for mutations. Resume injects it only into the matching stage. Explicit stage finish reports unfinished ledger entries as warnings and preserves the final record; checklist state never controls lifecycle. The original stage prompt remains the contract, workspace knowledge remains shared context, session summaries remain handoff history, and the final result remains the completion record.

## KC-0003: Non-Git projects resolve inconsistent roots

- Kind: fact
- Status: active
- Created: 2026-11-17T05:07:38.767Z
- Updated: 2026-11-17T05:07:38.767Z
- Sources: ["src/tool-definitions.js","plugin/stages-tui.js","test/stages-tui.test.js"]

In a non-Git project OpenCode may expose api.state.path.worktree as the sentinel "/" while the actual project directory remains available separately. Server tools already normalize this case by using context.directory when context.worktree is "/", but the TUI resolveProjectRoot path currently accepts "/" directly. As a result, tools write <project>/.work-context while the sidebar reads /.work-context and permanently shows no workspace. The fix is to centralize or consistently apply the same sentinel fallback in TUI root resolution, with regression coverage for non-Git projects.
