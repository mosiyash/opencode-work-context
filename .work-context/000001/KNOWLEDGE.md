# Durable Knowledge

## KC-0001: Stage 01 result: research on TUI stages panel

- Kind: decision
- Status: active
- Created: 2026-08-27T09:12:17.535Z
- Updated: 2026-08-29T04:06:22.131Z
- Sources: ["https://opencode.ai/docs/plugins/","https://opencode.ai/docs/tui/"]

OpenCode 1.18.23 loads a project-local plugin; the TUI API provides sidebar_content slots and an event bus. The recommended MVP is a separate TUI plugin with a stages block in the right sidebar. A dedicated work-context.updated domain event is unavailable; updates require a bridge or refreshes from OpenCode/file events. No code or ADR was created.

## KC-0002: Stage 02 decision: read-only stages TUI panel

- Kind: decision
- Status: active
- Created: 2026-08-27T09:21:57.548Z
- Updated: 2026-08-29T04:06:27.779Z
- Sources: ["docs/adr/0002-read-only-stages-tui-panel.md"]

Proposed a separate optional TUI adapter over a read-only snapshot provider. The provider uses WorkContext.openExisting, returns schema 1 with workspace, stages, currentStage, and generatedAt, does not change storage, and does not call mutating tools. The MVP is placed in sidebar_content and refreshed on initial load and with debounce on supported OpenCode session/file events; when the TUI API is unavailable, the server plugin continues to work. Keyboard mutations are deferred to a separate ADR.

## KC-0003: Question: meaningful default TUI session title

- Kind: risk
- Status: active
- Created: 2026-08-27T09:23:51.814Z
- Updated: 2026-08-29T04:06:33.843Z
- Sources: ["user-report: TUI screenshot and /wc resume 000001 02"]

When `/wc resume 000001 02` starts a new session, it receives the default summary `continued work`, so the TUI displays `000001 02/01 (closed): continued work`. This loses the meaning of the planned stage and remains after completion. Decide how to initialize the summary: derive it from the stage title/goal, ask the user for a meaningful title during resume, or use another explicit fallback. The decision must preserve the explicit lifecycle flow and update the session title through the existing adapter.

## KC-0004: OpenCode 1.18.25 TUI Solid runtime compatibility

- Kind: decision
- Status: active
- Created: 2026-08-29T02:36:24.688Z
- Updated: 2026-08-29T02:36:24.688Z
- Sources: ["https://github.com/anomalyco/opencode/tree/v1.18.25/packages/opencode/src/plugin/tui","https://github.com/anomalyco/opencode/tree/v1.18.25/packages/tui"]

OpenCode 1.18.25 uses Bun and Solid from the solid-js entrypoint. Importing solid-js/dist/solid.js creates a separate reactive graph, so slot UI may not rerender after asynchronous data updates. TUI plugins must use the same solid-js entrypoint as the host runtime.
