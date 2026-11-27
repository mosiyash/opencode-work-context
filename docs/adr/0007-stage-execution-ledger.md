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
six sections: `scope`, `completed`, `remaining`, `decisions`, `blockers`, and
`verification`. Metadata records the workspace, stage, revision, timestamps, and
last actor. Existing stages without this file remain valid and are never
migrated or rewritten merely by reading or resuming.

Schema 1 records retain those string arrays. Schema 2 records store each section
as stable `{ id, text }` items and present compatible string arrays to existing
consumers alongside structured `items`, `current`, and `queued` read data.
Legacy identifiers are derived deterministically for reads and are persisted as
stable schema 2 identifiers only after a mutation. This avoids an eager
migration while allowing agents to identify the Current item without relying on
its text.

Structured replacements and updates address items by ID. They can retain an ID
while rewording text and can represent duplicate text safely. Compatibility
string updates retain schema 1 normalization and exact-text behavior; they are
rejected when duplicate text makes identity ambiguous. A schema 1 mutation that
cannot fit after adding identity metadata fails with `EXECUTION_LIMIT_EXCEEDED`
without changing the legacy record.

Expose separate structured read, replace, and incremental update operations.
Replace supplies the complete logical state. Incremental update atomically adds
and removes exact text items for compatibility. `complete_current` atomically
moves only the first remaining item to completed and promotes the next queued
item without an intermediate invalid state. Mutations require ownership of the
active stage session and the revision returned by the latest read.
Compare-and-swap failures return a stable conflict instead of discarding newer
state. Existing storage locks, transaction journals, snapshots, and atomic
writes protect the canonical file.

Item text is trimmed. Compatibility strings are deduplicated and cannot overlap
between Completed and Remaining. Structured items may share text but have
globally unique IDs. Each section is limited to 50 items, the complete state to
200 items and 32,768 serialized bytes, and each item text to 500 characters.
These bounds keep resume context concise and prevent append-only growth.
Replacement is the explicit compaction mechanism.

Resume injects an existing ledger only into that stage's presentation and
context and instructs the agent to treat it as the current operational
checkpoint. Updates are expected after meaningful scope changes, important
decisions, substantial work units, blocker discovery, verification changes, and
before handoff, not after trivial edits.

The first Remaining item is Current and later Remaining items are Queued. Resume
names both categories explicitly. Agents work only on Current by default and do
not combine Queued items into the same change set unless the user explicitly
requests batching. Read-only checklist consumers render those structured fields
and use stable item IDs for option identity, rather than deriving identity from
item text.

Checklist state does not control lifecycle. Stage finish remains explicit and
returns warnings for remaining work, blockers, and pending verification. It
preserves the final ledger as a read-only historical record. Reopening the stage
makes the same record mutable again under a new active session and revisioned
updates.

The read-only TUI presents a concise progress summary and an optional checklist
dialog. The dialog separates Current, Queued, Completed, Blockers, Verification,
Scope, and Decisions without implying that completing a checklist controls the
stage lifecycle.

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
