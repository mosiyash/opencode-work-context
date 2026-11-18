# ADR-0009: Vendor-neutral capability profiles

## Status

Accepted

## Decision

Stages may store optional `execution_profile` and `review_profile` values from a
fixed portable vocabulary: `routine`, `implementation`, `architecture`,
`security`, and `review`. Project configuration controls presentation through
`capability_profiles.mode`, which defaults to `advisory` and may be set to
`off`.

Provider and model targets are not project metadata. A project instance may
read opaque user targets from `.work-context/local/capability-profiles.json`.
This existing personal storage boundary is ignored by tracked projections,
preserved by installation flows, and isolated per project. Invalid entries are
ignored with bounded warnings rather than making canonical storage unreadable.

Resume returns a recommendation in advisory mode. A valid mapping has source
`mapping`; an absent or invalid mapping has source `current` and does not claim
an unknown model identity. Off mode omits recommendations, resolution, and
warnings while preserving stage metadata.

## Consequences

- Tracked artifacts express capability intent without naming a provider.
- Local targets cannot leak into stage history, knowledge, projections, or
  session events.
- Recommendations never switch a model or agent, create a session, or block
  lifecycle operations.
- Existing projects and stages require no migration writes.
