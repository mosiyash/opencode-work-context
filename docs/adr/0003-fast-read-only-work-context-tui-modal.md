# ADR-0003: Fast read-only Work Context TUI modal

- Status: Proposed
- Date: 2026-09-01
- Deciders: OpenCode

## Context

Work Context already has explicit `/wc` commands and structured server tools.
That interface is appropriate for lifecycle operations, but it is prompt-first:
the user must know or reconstruct workspace and stage identifiers before seeing
the current state. Prompt-only UX is not sufficient for quickly reviewing all
workspaces, finding the current stage, or checking active session state.

The existing stages sidebar is a useful compact projection, but it is not an
interactive overview. The requested UI must remain a read-only view over the
canonical filesystem model. Lifecycle operations must continue to be explicit
and visible to the user.

## Decision

Add a separate OpenCode TUI plugin entry point with command
`work_context.open`, bound to `Ctrl+Alt+W`. The command opens a native TUI
modal through the public TUI plugin API. The modal reads a structured read
model built on canonical storage and does not acquire mutation authority.

The existing server contract remains separate:

```text
opencode-work-context/plugin  server plugin
opencode-work-context/tui     TUI plugin
```

The TUI plugin must prefer `api.keymap.registerLayer({ commands, bindings })`.
The deprecated `api.command.register()` compatibility shim is not used. The
plugin must not import OpenCode internals or construct a parallel registry.

Mutating actions are deferred to explicit `/wc` commands. The modal may show a
canonical command and insert it into the prompt, but it must never execute the
command, call a custom tool, invoke an LLM, or perform implicit message parsing.

## MVP boundaries

The modal MVP includes:

- workspace list and workspace status;
- stages for a selected workspace;
- current stage highlighting;
- active/current session and available session metadata;
- stage and workspace titles, descriptions, and statuses;
- filtering and keyboard navigation;
- details for the selected item;
- explicit insertion of a canonical `/wc ...` command into the prompt.

The modal does not create, update, finish, hand off, resume, archive, or
otherwise mutate workspaces, stages, sessions, Markdown projections, JSONL
projections, `INDEX.md`, `SESSIONS.md`, or canonical state.

Missing, empty, malformed, and concurrently changing storage are represented as
safe read-model states. A failed refresh may retain the last successful
snapshot with a visible stale indicator.

## Relationship to existing decisions

ADR-0002 establishes the separate optional TUI adapter, canonical storage read
boundary, `WorkContext.openExisting`, stale refresh behavior, and independent
server plugin. This ADR extends that boundary from a sidebar panel to an
interactive read-only modal without changing the storage contract.

The explicit lifecycle command contract remains authoritative. `/wc resume`,
`/wc stage handoff`, `/wc stage finish`, and related operations are still
started only when the user submits the visible command through the existing
workflow. Canonical state and generated projections remain owned by core and
storage; the TUI does not edit projections directly.

## Why not call custom tools directly

No stable public TUI API for directly invoking `work_context_*` custom tools
has been established. A host-provided prompt append bridge, if available, only
prepares prompt text. The installed `@opencode-ai/plugin` 1.18.21 declarations
expose `TuiPromptRef/set`, but do not confirm a `prompt.append` API. Treating an
unverified bridge as a direct tool invocation would blur the explicit lifecycle
boundary and could make keyboard focus a hidden mutation boundary. The modal
therefore inserts a visible canonical command when a public bridge is available
and otherwise reports `PROMPT_INSERT_UNAVAILABLE`, leaving submission to the
user.

## Why not use internal OpenCode APIs

Internal command, tool, modal, or registry implementations are not a supported
plugin contract and can change without compatibility guarantees. Importing
them would couple this package to a bundled OpenCode implementation and could
also bypass server tool registration and lifecycle safeguards. Only public TUI
plugin APIs are allowed.

## Alternatives considered

### Command palette only

Rejected as the primary UX. It can expose `work_context.open`, but it does not
provide a persistent, browsable overview of workspace and stage state.

### Legacy `api.command.register`

Rejected for new code. The installed TUI declarations explicitly deprecate it
and recommend `api.keymap.registerLayer` and command dispatch through the public
keymap API.

### Direct custom-tool invocation

Rejected. The stable public bridge is unconfirmed, and direct invocation would
hide mutations behind modal controls.

### Mutation from the modal

Rejected for the MVP. Mutations remain explicit `/wc` commands with visible
confirmation and the existing server workflow.

### Separate external UI

Deferred. It would add another runtime, packaging path, and synchronization
surface when the OpenCode TUI can provide the needed read-only presentation.

## Consequences and risks

- The package depends on the public OpenCode TUI plugin API and OpenTUI runtime.
- Compatibility tests must cover command registration, bindings, and modal
  open/close against the actual supported host shape.
- The read-only boundary makes the MVP safer but requires users to submit
  inserted commands themselves.
- OpenCode may change TUI APIs between versions; unsupported hosts must keep
  loading the server plugin and should expose a documented unavailable state.
- The modal needs careful handling of stale snapshots and storage races so a
  transient read failure cannot crash the TUI or erase a useful last snapshot.

## Compatibility gate

Before enabling the full modal, verify on the target OpenCode runtime:

1. the local TUI loader is discovered from `.opencode/tui.json`;
2. `api.keymap.registerLayer` accepts the command and `ctrl+alt+w` binding;
3. `api.ui.dialog` opens a native dialog containing the public `Dialog`
   component;
4. the dialog closes through its public stack API and cleanup runs from
   `api.lifecycle.onDispose`.

If the runtime does not provide these APIs, do not use internal registries.
Keep the server plugin and stages panel compatible and defer the modal in favor
of the existing read-only sidebar or another public fallback.
