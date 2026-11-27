# ADR-0010: Repository-local commit-all integration

- Status: Accepted
- Date: 2026-11-23
- Deciders: OpenCode

## Context

Planning and integration sessions sometimes need one reviewable commit containing
coherent work produced by several stages. Manually partitioning that work by
stage is slow and misleading because Git does not preserve stage ownership for
files or lines. Blindly committing every filesystem change is also unsafe in a
shared tree that may contain unrelated work, generated output, secrets, nested
repositories, or submodules.

## Decision

Provide a mode-neutral, repository-local `commit all` operation on top of the
existing integration-candidate machinery. Ordinary candidate lifecycle commands
remain available only in startup mode; commit-all may create its internal
integration candidate in either workspace mode.

The operation has two explicit phases. Read-only inspection captures the current
Git-root patch in a temporary index, classifies exclusions, records optional
user-selected stage references, proposes a diff-derived message using recent
subject style, previews the exact patch, and returns a deterministic SHA-256
fingerprint. Publication requires both that fingerprint and the exact
`COMMIT_ALL_CONFIRMED` token. It re-runs inspection under the candidate Git lock
and rejects any mismatch before creating or changing a candidate.

The fingerprint binds the workspace, `HEAD`, exact patch, included and excluded
paths, related stages, and commit message. The caller repeats optional message,
stage, and exclusion arguments during confirmation. Inspection never persists a
plan, so abandoned plans require no cleanup.

Selected stages and exact matching candidate relations are traceability only.
They never imply ownership. Without defensible evidence, included paths remain
explicitly unattributed and publication is still allowed.

The current Git root is the publication boundary. Sibling and external
repositories are invisible to the operation. Separate nested repositories,
submodules, package caches, common generated paths, work-context local state,
probable secret paths or contents, and user-selected unrelated paths are excluded
and reported. Active Git operations and unsupported binary boundaries fail with
stable errors.

After confirmation, the implementation reuses an active integration candidate
only when its stored patch fingerprint exactly matches the inspected patch.
Otherwise it creates and captures a new integration candidate. Preview must
reproduce the fingerprint before readiness and publication. Existing temporary
index, transaction rollback, commit-tree, and compare-and-swap ref guards remain
authoritative.

## Consequences

- A user can review and confirm one repository-wide commit without assigning
  shared changes to stages.
- Confirmation cannot authorize changes that appeared after inspection.
- Explicit path exclusions provide a fast boundary for known unrelated WIP.
- Work in other repositories always needs independent publication.
- Generated-message quality is deterministic and bounded; callers can provide an
  explicit message when richer intent is required.
- Candidate payloads remain local, hooks and signing remain bypassed, and the
  ordinary Git index is not used for capture or publication.

## Alternatives considered

### Commit the ordinary index

Rejected because existing staged work may be unrelated and the operation must not
rewrite or consume the user's index.

### Infer file ownership from stage sessions

Rejected because session timing and stage history do not prove mutation
provenance.

### Persist confirmation plans

Rejected because a deterministic fingerprint can bind the complete plan without
adding another local lifecycle or stale-plan cleanup requirement.
