# Durable Knowledge

## KC-0001: Sequential checklist semantics

- Kind: decision
- Status: active
- Created: 2026-11-22T06:52:55.614Z
- Updated: 2026-11-22T06:52:55.614Z
- Sources: ["User feedback from the mailer project","plugin/stages-tui.js","src/stage-execution.js"]

The stage execution checklist is sequential. The first remaining item is Current and is the only item an agent should include in the default change set. Later remaining items are Queued and must not be combined with Current unless the user explicitly requests batching. Completing Current atomically moves it to Completed and promotes the next queued item.

## KC-0002: Execution ledger compatibility boundary

- Kind: contract
- Status: active
- Created: 2026-11-22T06:53:09.074Z
- Updated: 2026-11-23T03:24:45.543Z
- Sources: ["docs/adr/0007-stage-execution-ledger.md","src/stage-execution.js","src/core.js","src/tool-definitions.js","test/stage-execution.test.js","test/integration/plugins.test.js"]

Stage execution schema 1 remains readable as six normalized string-array sections and is never migrated by read or resume. Schema 2 stores stable globally unique item IDs, while read results retain compatibility string arrays and add structured items, Current, and Queued fields. Text-only mutations retain legacy semantics; structured mutations use IDs for duplicate or reworded text. Completing Current atomically preserves its ID, moves it to Completed, and promotes the next queued item under the revision and active-session guards.

## KC-0003: Shared capability resolver boundary

- Kind: decision
- Status: active
- Created: 2026-11-23T03:32:21.183Z
- Updated: 2026-11-23T03:32:21.183Z
- Sources: ["Planning discussion for workspace Plugin updates","src/capability-profiles.js","README.md capability profiles section"]

Stage capability metadata remains owned by opencode-work-context, while user-level depth-to-model mappings and resolution are extracted into a neutral shared component for opencode-work-context, project-agent-relay, and future OpenCode tools. The shared component owns the global schema, configuration path, project override precedence, validation, atomic writes, and resolution API; it does not own stage inference, workflow lifecycle, relay dispatch, or automatic model switching.

## KC-0004: Repository-local commit-all boundary

- Kind: decision
- Status: active
- Created: 2026-11-23T13:11:13.401Z
- Updated: 2026-11-23T13:11:13.401Z
- Sources: ["Planning discussion for workspace Plugin updates","Startup candidate workflow contract"]

A commit-all workflow may integrate changes from several work-context stages, but its publication boundary is exactly the current Git repository. Changes made by any stage in external repositories or separate nested Git repositories are excluded and must be committed independently in their own repositories. Stage relationships provide traceability and commit-message context, not file ownership.

## KC-0005: Two-phase repository-local commit-all contract

- Kind: contract
- Status: active
- Created: 2026-11-23T14:02:10.095Z
- Updated: 2026-11-23T14:02:10.095Z
- Sources: ["src/candidates.js","src/git-candidates.js","docs/adr/0010-repository-local-commit-all.md","test/candidates.test.js"]

Repository-local commit-all is a mode-neutral two-phase operation built on integration candidates. Read-only inspection returns the exact repository-root boundary, included and excluded paths, traceability-only stage references, an exact patch verification summary, a proposed or user-supplied message, and a deterministic SHA-256 fingerprint. Publication requires the same arguments, fingerprint, and exact COMMIT_ALL_CONFIRMED token; it re-inspects under the Git lock and rejects stale HEAD, patch, selection, attribution, or message state. Nested and external repositories, submodules, local operational state, suspicious generated paths, probable secrets, unresolved index conflicts, active Git operations, and unsupported binary boundaries are never included. Publication preserves candidate audit metadata across ref and compensation races, and stage references never imply file ownership.

## KC-0006: Capability profiles proceed independently of opencode-kit

- Kind: decision
- Status: active
- Created: 2026-11-26T16:30:53.306Z
- Updated: 2026-11-26T16:30:53.306Z
- Sources: ["project-agent-relay report for tsn workspace 1 stage 76, run d111fc27-df36-40f2-8717-5e313b66fa06","opencode-work-context workspace 000027 stage 04 scope"]

The opencode-capability-profiles extraction does not depend on TSN workspace 1 stage 76 and should proceed now. Stage 76 does not own capability-depth mappings, resolver behavior, or the capability-profiles installer. The shared package must establish its API and installation contract first; opencode-kit may later consume it as an external dependency for version and health diagnostics without duplicating installation behavior.
