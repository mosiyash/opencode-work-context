# ADR-0009: Vendor-neutral capability profiles

## Status

Accepted

## Decision

Stages may store an execution capability from the fixed portable vocabulary
`routine`, `implementation`, `architecture`, `security`, and `review`, plus an
independent execution depth of `light`, `standard`, or `deep`. Classifications
record whether they were agent-inferred or explicitly assigned. Optional review
profile metadata remains portable but does not select a model or subagent.

Planning agents infer omitted values from complete stage context before
creation. Core storage does not invoke a model or use semantic keyword rules.
Batch refresh applies agent-computed classifications atomically to missing and
inferred actionable stages, preserving explicit assignments by default. Resume
and read-only UI never infer or mutate classifications.

Provider and model targets are not project metadata. A project instance may
read bounded depth-to-model labels from
`.work-context/local/capability-profiles.json`.
This existing personal storage boundary is ignored by tracked projections,
preserved by installation flows, and isolated per project. Invalid entries are
ignored with bounded warnings rather than making canonical storage unreadable.

Resume returns the execution recommendation in advisory mode. A valid depth
mapping has source `mapping`; an absent or invalid mapping has source `current`
and does not claim an unknown model identity. Expanded stage details render the
capability, depth, and mapped label on one unlabeled line. Without a mapping,
the TUI may append the actual model name from the current OpenCode session;
non-current stages and hosts without session model data show only capability and
depth. The model identity remains host-owned and is never persisted by Work
Context. Off mode omits recommendations, resolution, and warnings while
preserving stage metadata.

Question-driven setup/show/reset commands own local mapping changes and project
mode updates, so users need not edit JSON or YAML. Setup may offer a subsequent
refresh but never performs it without the user's answer.

## Consequences

- Tracked artifacts express capability intent without naming a provider.
- Capability and required model depth remain independent rather than conflating
  work type with model strength.
- Local targets cannot leak into stage history, knowledge, projections, or
  session events.
- Recommendations never switch a model or agent, invoke a reviewer, create a
  session, or block lifecycle operations.
- Existing projects and stages require no migration writes.
