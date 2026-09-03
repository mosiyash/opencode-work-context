# ADR-0002: Read-only stages panel for the OpenCode TUI

- Status: Accepted
- Date: 2026-08-27
- Deciders: OpenCode

## Context

Work-context has a filesystem-backed canonical model. Workspace and stage
metadata are Markdown files, session state is an append-only JSONL event stream,
and the generated `INDEX.md` and `SESSIONS.md` files are projections. The
existing OpenCode plugin is a server plugin: it registers the structured
`work_context_*` tools and updates the OpenCode session title on
`session.updated`.

The stages panel must expose progress in the TUI without introducing a second
source of truth or allowing accidental lifecycle mutations. OpenCode versions
without the TUI extension must continue to load the server plugin normally.

## Decision

Implement the panel as a separate, optional TUI adapter over a read-only
snapshot provider. The provider is the only boundary that reads work-context
storage. The panel never edits Markdown, JSONL, `INDEX.md`, or `SESSIONS.md`,
and it never calls a mutating `work_context_*` tool.

The provider contract is:

```js
readStagesSnapshot({ projectRoot, sessionId })
  => {
    ok: true,
    data: {
      schema: 1,
      workspace: { id, title, status },
      stages: [{ id, title, status, description, current }],
      currentStage: id | null,
      generatedAt: ISO_TIMESTAMP
    }
  }
```

`projectRoot` is resolved from the OpenCode worktree. The provider uses
`WorkContext.openExisting`, so a missing `.work-context` directory is an empty
state rather than a reason to create storage. `sessionId` identifies the
current OpenCode session; its reduced session record selects the workspace and
stage. If there is no matching session, the provider returns an empty state.
Stage order is deterministic stage-identifier order. Dependency validation
remains the core adapter's responsibility; it is not repeated by the renderer.
`current` is true only for `currentStage`.

Provider failures use the existing stable error codes. `NOT_FOUND` and an
unavailable TUI integration render an empty or unavailable panel; malformed
storage (`STORAGE_ERROR`) renders an error indicator and is not repaired by the
panel. No error path writes to storage.

## TUI lifecycle and refresh

1. On plugin initialization, resolve the worktree and perform one snapshot
   read. Do not create directories or register a mutating command.
2. Register the panel in the supported `sidebar_content` slot. The panel is
   compact and grouped before OpenCode's built-in sidebar blocks.
3. Subscribe to OpenCode events available to the host. Re-read the snapshot on
   `session.updated`; a filesystem watcher or bridge event may be added when
   the host exposes one. There is no assumed `work-context.updated` event.
4. Coalesce refresh requests with a short debounce (100-250 ms) and discard a
   stale read if a newer refresh started. A failed refresh keeps the last good
   snapshot and shows a non-blocking stale/error marker.
5. Dispose subscriptions and watchers when the plugin is disposed. The MVP
   creates no persistent watcher if the host does not provide a lifecycle-safe
   event API.

The current server plugin's title update remains independent of the panel. A
missing TUI API must not prevent tool registration or session-title updates.
The OpenCode session title uses the stage title as its first, descriptive line
and `<workspace> <stage>/<session ordinal>` as its second, identifying line.
An optional issue reference prefixes the identifying line, and inactive session
state follows it. OpenCode uses this same title in the sidebar header and its
session picker.

## Layout and interaction

The panel displays the workspace title as a separate context block before the
stage list:

```text
<workspace title>

Stages · <workspace status>
<status marker> <stage id>. <stage title>
...
```

The current stage receives a visual marker and remains visible when its status
is `in_progress`. Status is text, not color alone, so the panel remains usable
in monochrome terminals. Long titles and descriptions are truncated by the
TUI renderer rather than by the provider.

The MVP is read-only. It does not bind Enter, mutation keys, or lifecycle
shortcuts. Future actions must dispatch the same structured tools as `/wc` and
must not write storage directly; adding such actions requires a follow-up ADR.

## Alternatives considered

### Read Markdown projections directly in the TUI

Rejected. Projections can be stale and this would duplicate parsing and
validation rules. The provider must read canonical metadata and reduce the
event stream through the existing core.

### Let the TUI call lifecycle tools

Rejected for the MVP. It expands the interaction surface and makes keyboard
focus a mutation boundary. `/wc` remains the explicit lifecycle interface.

### Add a custom work-context event immediately

Rejected until the host exposes a supported event bridge. The current event
hook can refresh on OpenCode session changes, while future file/bridge events
can use the same provider and debounce path.

## Consequences

- The panel has a small, testable read model and no storage mutation authority.
- The current server plugin remains compatible with hosts that have no TUI API.
- Changes made by external processes may not appear until a supported refresh
  event is received; a manual refresh mechanism can be added in a later ADR.
- The provider and rendering contract need contract tests before implementation
  is released.

## Release compatibility

The release targets the current v1 OpenCode plugin contract and the TUI contract
provided by `@opencode-ai/plugin` 1.18.x: the server entry point remains the
default function at `opencode-work-context/plugin`, while the optional TUI entry
point is the `tui` module at `opencode-work-context/tui`. The panel registers the
supported `sidebar_content` slot and listens to the public `session.updated`
event bus. It accepts the current event payload (`data.sessionID`) and legacy
session fields used by older hosts.

The package installer generates a server loader and, separately, a TUI loader
and configuration entry. The server loader imports the explicit `server` export;
the TUI loader imports the combined `tui` export, which preserves the existing
stages panel while adding optional TUI features. Contract tests cover both
exports, installer loading, no-TUI server loading, read-only storage discovery,
and TUI lifecycle cleanup. No mutating tools or new dependencies are part of
this release.
