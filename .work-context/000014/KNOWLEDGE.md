# Durable Knowledge

## KC-0001: Sidebar navigation implementation approach

- Kind: decision
- Status: active
- Created: 2026-11-12T10:12:53.244Z
- Updated: 2026-11-12T11:57:57.785Z
- Sources: ["plugin/stages-tui.js","plugin/stage-switcher.js","test/stages-tui.test.js"]

The stages sidebar in plugin/stages-tui.js now attaches an OpenTUI onMouseDown handler to every visible row and delegates selection to createStageSwitcherFlow().select(stage.id). The shared stage-switcher flow reads the full switcher snapshot, selects an existing OpenCode session or creates and resumes a new one, and preserves terminal-stage and dependency checks, dialog closing, attention acknowledgement, recent-stage history, and toast behavior. Focused tests in test/stages-tui.test.js cover row handlers, successful click navigation, and navigation failure feedback.
