# ADR-0006: Startup commit candidate workflow

- Status: Accepted
- Date: 2026-11-16
- Deciders: OpenCode

## Context

High-throughput development may run several stages concurrently on one branch
and working tree. Git records repository-wide state but does not preserve which
stage or session produced each file or hunk. Reconstructing that provenance at
commit time is ambiguous, especially after overlapping edits, and incorrectly
encourages stages to claim file ownership.

Ready work must still be publishable while unrelated work remains unfinished.
Per-stage branches and worktrees would provide isolation but add coordination
cost that the startup workflow deliberately avoids.

## Decision

Provide an explicit workspace-level `startup` mode. It is opt-in; existing and
new workspaces otherwise use `standard` mode. Associated OpenCode sessions in a
startup workspace receive a concise policy on resume:

- shared dirty state and concurrent stages are expected;
- stages do not own files or commits;
- ready work is captured promptly into an explicit commit candidate;
- mixed-stage provenance is not itself a blocker;
- concrete overlapping or stale candidate patches stop publication with a
  stable conflict.

An unassociated core session does not receive agent policy, and standard mode
retains its conservative behavior.

A commit candidate stores an explicitly selected patch and metadata under
`.work-context/local/`. Capture, preview, and publication use temporary Git
indexes rather than the ordinary index. Publication reapplies the patch to the
current attached branch when possible, creates a commit, and updates the branch
with compare-and-swap semantics. Candidate/Git operations are serialized.
Hooks and signing are deliberately bypassed because publication uses
`git commit-tree`.

Read-only snapshots expose only pending and ready candidate counts. The stages
sidebar may render those counts when nonzero. Renderers do not read Git state,
candidate patches, selected paths, or candidate metadata files directly. A
ready count represents lifecycle state, not current applicability.

## Consequences

- A ready subset can be committed while unrelated working-tree WIP continues.
- Agents no longer need to infer retrospective stage ownership before forming a
  commit.
- Candidate conflicts are concrete patch/application failures instead of
  provenance guesses.
- Candidate payloads remain local and may differ between machines.
- Startup mode accepts weaker isolation than standard mode and must be selected
  deliberately.
- Candidate publication bypasses repository hooks and commit signing, which is
  explicit in the command and documentation contract.

## Alternatives considered

### Infer ownership from session history and the current diff

Rejected. Session history does not record mutation-time provenance and cannot
reliably attribute shared files or hunks after the fact.

### Give every stage a branch or worktree

Rejected for startup mode because integration and coordination overhead defeats
the intended shared-branch workflow. Projects needing stronger isolation should
retain standard practices outside this mode.

### Let the sidebar inspect Git freshness

Rejected. It would make rendering depend on repository state, increase refresh
cost, and violate the read-only snapshot boundary established by ADR-0002.
