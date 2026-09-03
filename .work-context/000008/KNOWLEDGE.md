# Durable Knowledge

## KC-0001: Stage transitions require explicit resume

- Kind: contract
- Status: active
- Created: 2026-09-02T05:58:09.989Z
- Updated: 2026-09-02T05:58:09.989Z
- Sources: ["src/tool-definitions.js","src/core.js","commands/wc.md","README.md","test/core.test.js","test/integration/plugins.test.js"]

Adding a stage is creation-only: it returns a planned stage with session_started=false and resume_required=true and never binds the current OpenCode session. Finishing a stage closes only that stage session, returns downstream prompt_review as informational data with next_stage_started=false, and never starts a downstream stage. Entering any added stage requires an explicit work_context_start_session operation in a separate OpenCode session; multiple sessions for one non-terminal stage remain supported through explicit resume and handoff.

## KC-0002: OpenCode session title display contract

- Kind: contract
- Status: active
- Created: 2026-09-02T09:04:35.108Z
- Updated: 2026-09-02T09:31:27.129Z
- Sources: ["src/title.js","src/opencode-adapter.js","plugin/work-context.js","plugin/stages-tui.js","src/stages-renderer.js","test/integration/plugins.test.js","test/stages-tui.test.js","docs/adr/0002-read-only-stages-tui-panel.md"]

OpenCode's sidebar header and Ctrl+X L session picker render the same native session.title field, so the plugin cannot give those views different native titles. Work-context therefore renders the stage title on the first line and `[issue | ]<workspace> <stage>/<session ordinal> [(inactive state)]` on the second line. The optional TUI sidebar reads the workspace title independently and renders it as a separate block before the Stages panel. OpenCode persists existing session titles and plugin startup alone does not recalculate them; a work-context tool completion or a supported session.updated event triggers the server hook and refreshes the title. Newly handled sessions receive the new format through the same hook. The plugin-owned work-context modal is outside this contract.

## KC-0003: Stage switcher uses native session navigation

- Kind: contract
- Status: active
- Created: 2026-09-02T09:49:20.843Z
- Updated: 2026-09-02T14:23:20.243Z
- Sources: ["plugin/stage-switcher.js","plugin/work-context-modal.js","docs/adr/0004-stage-session-switcher.md","README.md","test/stages-tui.test.js"]

The TUI command work_context.open is bound to Ctrl+Alt+W and opens a current-workspace stage selector. Existing sessions are selected deterministically: OpenCode-backed active first, then handed_off, abandoned, and closed, with newest timestamp and highest ordinal as tie-breakers. Existing-session selection only navigates and never changes lifecycle state. When no OpenCode-backed session exists, the plugin creates and opens a separate native OpenCode session, then invokes the public structured session-command endpoint with command wc and arguments resume <workspace> <stage>. This runs the normal /wc contract and work_context_start_session in the destination session, so its agent receives resume.instruction without rebinding the session being left. Navigation failure attempts to delete the still-unbound native session; command failure after navigation leaves it visible for inspection or retry. Terminal and dependency-blocked stages can open existing sessions but cannot create new ones. The prior command-preparation modal remains available as work_context.actions.

## KC-0004: Identifier normalization contract

- Kind: contract
- Status: active
- Created: 2026-09-02T17:54:38.277Z
- Updated: 2026-09-02T17:54:38.277Z
- Sources: ["src/identifiers.js","src/core.js","src/tool-definitions.js","plugin/work-context-modal.js","test/core.test.js","test/integration/plugins.test.js","test/stages-tui.test.js","README.md","commands/wc.md"]

Explicit workspace and stage positions accept digit-only string identifiers in ranges 1..999999 and 1..99, respectively. Inputs may be canonical or unpadded, but core operations, structured results, storage, session events, UI, transaction labels, and generated commands always use six-digit workspace IDs and two-digit stage IDs. Zero, signs, decimals, surrounding whitespace, overlong forms, and non-string values are INVALID_ARGUMENT; canonical missing identifiers are NOT_FOUND. The command grammar retains its lone-identifier disambiguation rule, so an unpadded workspace ID must be supplied in an explicit workspace position. Stage dependency IDs use the same stage normalizer.

## KC-0005: Switcher UX may differ by entity

- Kind: contract
- Status: active
- Created: 2026-09-03T03:46:38.245Z
- Updated: 2026-09-03T03:46:38.245Z
- Sources: ["plugin/stage-switcher.js","plugin/work-context-modal.js","test/stages-tui.test.js"]

Switcher implementations share navigation principles but are not required to share identical UX. Workspace, stage, and session switching may differ in filtering, lifecycle rules, session creation, selection priority, and navigation behavior. Reuse only proven mechanics; do not force all switchers into one abstraction prematurely. Keyboard shortcuts are temporary defaults until a later dedicated configuration stage makes them user-configurable.

## KC-0006: Workspace switcher behavior

- Kind: decision
- Status: active
- Created: 2026-09-03T03:49:40.021Z
- Updated: 2026-09-03T04:54:04.321Z
- Sources: ["plugin/workspace-switcher.js","plugin/work-context-modal.js","test/stages-tui.test.js"]

The workspace switcher is read-only navigation. It lists all workspaces from the snapshot, selects an existing OpenCode-backed session using active, handed_off, abandoned, then closed priority with newest timestamp and highest ordinal tie-breakers, and navigates through the native session route. Workspaces without a mapped OpenCode session remain visible but disabled and return WORKSPACE_SESSION_UNAVAILABLE if selected. It never creates sessions or changes work-context lifecycle state. The command center exposes Switch workspace and the host keymap binds it to Ctrl+Alt+O, because OpenCode reserves Ctrl+Alt+D for messages_half_page_down.

## KC-0007: Session switcher is read-only and deduplicates native sessions

- Kind: decision
- Status: active
- Created: 2026-09-03T04:59:51.022Z
- Updated: 2026-09-03T04:59:51.022Z
- Sources: ["plugin/session-switcher.js","plugin/work-context-modal.js","test/stages-tui.test.js"]

Stage 09 adds a dedicated session switcher separate from the existing session browser. It flattens sessions across all workspaces, ranks the current OpenCode session first, then active, handed_off, abandoned, and closed sessions using updated/started time, ordinal, and stable location tie-breakers. Duplicate OpenCode IDs collapse to the best record; records without OpenCode IDs remain visible but disabled. Selecting an available record only clears the dialog and navigates through the native OpenCode session route; it never changes work-context lifecycle state or creates/resumes sessions. The command center exposes Switch session without a new keyboard binding because the host keymap does not provide a conflict-detection contract.
