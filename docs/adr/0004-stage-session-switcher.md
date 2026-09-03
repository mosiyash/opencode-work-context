# ADR-0004: Stage session switcher

- Status: Accepted
- Date: 2026-09-02
- Deciders: OpenCode

## Context

The read-only Work Context modal can inspect stage and session state, but moving
between stages still requires reconstructing a session from the native session
picker or preparing `/wc resume`. A stage switch must preserve the current
OpenCode conversation and must not reinterpret navigation as permission to
continue work automatically.

The public TUI API exposes the required host boundaries:
`api.keymap.registerLayer`, `api.ui.DialogSelect`, `api.client.session.create`,
`api.client.session.command`, and
`api.route.navigate("session", { sessionID })`. The `/wc resume` command already
maps to the canonical `work_context_start_session` operation.

## Decision

`work_context.open`, bound to `Ctrl+Alt+W`, opens a searchable selector for all
stages in the current session's workspace. The action modal remains available
from the command palette as `work_context.actions`.

For a selected stage, choose an existing session by this deterministic rule:

1. Consider only sessions with an `opencode_session_id` because only those can
   be opened by the host.
2. Prefer an active work-context session.
3. Otherwise prefer states in this order: handed off, abandoned, closed.
4. Within one state, prefer the latest `updated_at` or `started_at`, then the
   highest ordinal.

Opening an existing session is navigation only. It does not reactivate a
handed-off, abandoned, or closed lifecycle session.

When no OpenCode-backed session exists, the switcher creates and opens a
separate native session, then calls the public structured session-command
endpoint with command `wc` and arguments `resume <workspace> <stage>`. The
destination agent therefore receives and executes the normal `/wc resume`
contract, including `resume.instruction`; the TUI does not duplicate lifecycle
logic or insert text into either prompt. If navigation fails before command
execution, it attempts to delete the unbound native session. If command
execution fails after navigation, the native session remains visible so the
user can inspect the error or retry explicitly.

## Stage behavior

- Active and planned stages create a session only when no OpenCode-backed
  session exists.
- Dependency-blocked stages show their blockers. They can open an existing
  session but cannot create one.
- Completed, cancelled, and archived stages remain visible. They can open an
  existing session but cannot create one.
- Multiple sessions follow the deterministic selection rule above.
- Selecting the current stage may navigate to its selected session but does not
  mutate lifecycle state.
- Cancelling the dialog has no effect.
- Switching does not submit prompts, stop in-flight work, close the current
  session, or start agent work in the destination session.

## Consequences

The switcher requires public session creation, command execution, and route
navigation APIs from the OpenCode host. Unsupported operations produce a
visible error and do not fall back to internal APIs or prompt-text simulation. The host owns
shortcut precedence; users must resolve a conflicting `Ctrl+Alt+W` binding or
disable the optional TUI loader.

The session being left remains intact, including unsaved prompt text and
in-flight work as supported by OpenCode's native session navigation. Interactive
host behavior still requires runtime verification because package declarations
and fake-host tests cannot prove terminal shortcut delivery or route rendering.
