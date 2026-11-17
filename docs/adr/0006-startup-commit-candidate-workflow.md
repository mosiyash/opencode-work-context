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
- exact candidates are preferred when a patch is safely separable, shared
  foundation candidates represent one change used by several stages, and
  integration candidates represent intertwined but coherent changes;
- mixed-stage provenance and complete files containing unrelated stage work do
  not require prior commits and are not themselves blockers;
- concrete patch conflicts, incoherent candidate boundaries, and failed required
  verification stop publication.

An unassociated core session does not receive agent policy, and standard mode
retains its conservative behavior.

A commit candidate stores an explicitly selected patch and metadata under
`.work-context/local/`. Capture, preview, and publication use temporary Git
indexes rather than the ordinary index. Publication reapplies the patch to the
current attached branch when possible, creates a commit, and updates the branch
with compare-and-swap semantics. Candidate/Git operations are serialized.
Hooks and signing are deliberately bypassed because publication uses
`git commit-tree`.

New candidates record a strategy of `exact`, `shared_foundation`, or
`integration` and may reference multiple stages in the same workspace. Stage
references are normalized and validated, but are traceability only. They do not
assign ownership, alter lifecycle or dependency checks, or affect patch capture
and publication. Relations are never inferred from Git history, session history,
touched files, or diffs. Candidate metadata written before these fields existed
remains readable without migration.

Read-only snapshots expose draft and ready candidate counts plus bounded metadata
for active candidates explicitly related to each stage. The stages sidebar
renders workspace counts when nonzero and per-stage pending metadata only in its
expanded details mode. Resume includes the same related candidate metadata so an
agent can continue an existing commit intent before creating another boundary.
Agents create or refresh a draft candidate once a coherent commit intent exists
and before switching stages or handing off. Renderers do not read Git state,
candidate patches, selected paths, or candidate metadata files directly. A
ready count represents lifecycle state, not current applicability, and no
candidate relation implies stage ownership. Per-stage counts are complete, while
projected item details are bounded to 10 candidates with titles limited to 120
characters. Projection is best-effort: malformed local records remain strict
errors for direct candidate operations but cannot block sidebar rendering or an
otherwise valid stage resume.

## Consequences

- A ready subset can be committed while unrelated working-tree WIP continues.
- Agents no longer need to infer retrospective stage ownership before forming a
  commit.
- Shared foundations and coherent integration changes can be named explicitly
  and traced to several related stages without coupling commit and stage
  boundaries.
- Candidate conflicts are concrete patch/application failures instead of
  provenance guesses.
- Candidate payloads remain local and may differ between machines.
- Startup mode accepts weaker isolation than standard mode and must be selected
  deliberately.
- Candidate publication bypasses repository hooks and commit signing, which is
  explicit in the command and documentation contract.
- Edits to identical lines cannot be retrospectively separated by stage. An
  integration candidate must include the coherent combined result, or
  publication must wait for a safe boundary.

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
