# ADR-0007: Stage-local execution ledger

- Status: Accepted
- Date: 2026-11-17
- Deciders: OpenCode

## Context

Long-running stages accumulate scope changes, completed work, decisions,
blockers, and verification obligations across context compaction, process
termination, handoff, and resume. The original stage prompt is the durable work
contract, but rewriting it would erase that contract. Session summaries record
historical stopping points, final results describe completed work, and workspace
knowledge is intentionally shared with every stage.

None of those stores is a suitable mutable operational checkpoint for one
stage. Reconstructing such state from conversation history or background LLM
summaries is nondeterministic and cannot provide safe concurrent updates.

## Decision

Store optional canonical JSON at
`.work-context/<workspace>/stages/<stage>.execution.json`. Its bounded schema has
six normalized string-array sections: `scope`, `completed`, `remaining`,
`decisions`, `blockers`, and `verification`. Metadata records the workspace,
stage, revision, timestamps, and last actor. Existing stages without this file
remain valid and are never migrated or rewritten merely by reading or resuming.

Expose separate structured read, replace, and incremental update operations.
Replace supplies the complete logical state. Incremental update atomically adds
and removes exact items, which supports moving an item from `remaining` to
`completed` without an intermediate invalid state. Mutations require ownership
of the active stage session and the revision returned by the latest read.
Compare-and-swap failures return a stable conflict instead of discarding newer
state. Existing storage locks, transaction journals, snapshots, and atomic
writes protect the canonical file.

Items are trimmed and deduplicated. Completed and remaining items cannot
overlap. Each section is limited to 50 items, the complete state to 200 items
and 32,768 serialized bytes, and each item to 500 characters. These bounds keep
resume context concise and prevent append-only growth. Replacement is the
explicit compaction mechanism.

Resume injects an existing ledger only into that stage's presentation and
context and instructs the agent to treat it as the current operational
checkpoint. Updates are expected after meaningful scope changes, important
decisions, substantial work units, blocker discovery, verification changes, and
before handoff, not after trivial edits.

Checklist state does not control lifecycle. Stage finish remains explicit and
returns warnings for remaining work, blockers, and pending verification. It
preserves the final ledger as a read-only historical record. Reopening the stage
makes the same record mutable again under a new active session and revisioned
updates.

The TUI does not expose an execution progress indicator initially. Full ledger
content would be noisy, and a count can imply completion semantics that the
ledger deliberately does not own. A future read-only indicator may be added
through the snapshot boundary without changing this storage model.

## Consequences

- Operational progress survives restart, compaction, handoff, and resume.
- Original prompts, workspace knowledge, session summaries, and results retain
  distinct meanings.
- Stale writers cannot silently overwrite newer state.
- Legacy workspaces remain compatible without migration.
- Explicit replacement is required to compact stale completed items.
- The JSON record is canonical state owned by structured operations, not a
  user-editable projection.

## Alternatives considered

### Put execution state in workspace knowledge

Rejected because knowledge is durable cross-stage context and is injected into
every stage.

### Rewrite the stage prompt or result

Rejected because the prompt is the original contract and the result is a
completion record, not mutable work-in-progress state.

### Append execution details to session events

Rejected because session summaries are historical and append-only replay would
grow without a clear bounded current-state representation.

### Infer state from conversation history

Rejected because history may be compacted or unavailable and free-form
summarization cannot provide deterministic validation or concurrency control.
