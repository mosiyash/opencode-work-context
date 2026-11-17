# ADR-0008: Workspace delivery context

- Status: Accepted
- Date: 2026-11-17
- Deciders: Maintainers

## Context

One release may aggregate committed work from several stages. A successful commit,
push, or CI run does not establish that an environment was updated: project-specific
delivery can require infrastructure automation, migrations, containers,
configuration, secret names, ordered rollout, verification, or rollback steps.
Stage ownership and a universal deployment command would both misrepresent this
workflow.

## Decision

Delivery is workspace-level local operational state, independent of stage and
candidate boundaries. The package records explicit checkpoints per environment
under `.work-context/local/delivery/`. A checkpoint contains only the environment
name, deployed commit, confirmation timestamp, and committed candidate ID/hash
pairs included by that commit. It contains no commands, output, hosts, URLs,
credentials, tokens, secret values, or stack-specific fields.
Each checkpoint has a SHA-256 integrity checksum over its head, timestamp, and
candidate pairs. Invalid or inconsistent records fail closed as unavailable.

Delivery operations are mode-neutral. Candidate creation and publication remain
startup-only, but standard workspaces may record checkpoints for existing commits.
Planning-stage resume receives bounded committed-candidate and checkpoint metadata;
implementation-stage resume does not. This context coordinates a release and does
not assign commit or file ownership to Planning or any related stage.

`delivery read` without a range reads local metadata only. Git inspection requires
explicit full immutable `from` and `to` commit hashes in ancestor order. It returns
at most 500 commit hashes and 500 changed paths, with complete counts and truncation
flags. Changed-path output is subprocess-bounded to 4 MiB and returns
`DELIVERY_RANGE_TOO_LARGE` when exceeded. Sidebar snapshots never invoke Git and
expose no hashes or paths.
Consequently, sidebar pending counts describe tracked candidate metadata rather
than live Git reachability. They render `unavailable` for malformed or inconsistent
checkpoint records and never claim that an environment is currently at `HEAD`.

`delivery mark` requires the exact `DELIVERY_CONFIRMED` token after the user confirms
successful delivery. The commit must exist and be reachable from current `HEAD`.
Marking records the checkpoint atomically and never executes a deployment command.
Candidate/Git locking precedes the ordinary work-context write lock.

When the user asks how to deploy, the Planning agent inspects the exact range and
the repository's own deployment documentation, scripts, infrastructure,
migrations, container definitions, configuration examples, and CI. It produces
ordered prerequisites, deployment, verification, rollback, and blockers, asks a
focused question when environment or baseline is ambiguous, and mentions required
secret names without persisting values.

## Consequences

- Planning can reconstruct delivery implications after several stages commit in
  parallel without relying on conversation memory.
- Environments advance independently and only through explicit confirmation.
- Projects retain complete control over stack-specific deployment behavior.
- Direct commits remain visible in an explicitly inspected Git range even when no
  candidate metadata exists.
- Before the first environment checkpoint, candidate metadata can identify known
  committed work, but an exact baseline may still require one focused question.
- Local checkpoints are not shared automatically across machines.

## Rejected alternatives

### Treat the last active stage as the deployment owner

Rejected because delivery aggregates repository changes across stages.

### Infer successful delivery from push or CI

Rejected because infrastructure and environment changes may happen outside that
pipeline and success does not prove rollout completion.

### Persist generated deployment commands or secret values

Rejected because commands are project-specific and operational output or secrets
must not become durable plugin state.

### Read Git from sidebar rendering

Rejected to preserve the metadata-only, read-only TUI boundary and predictable
rendering cost.
