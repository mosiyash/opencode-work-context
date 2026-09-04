# Durable Knowledge

## KC-0001: Leader key override causes Ctrl+X regression

- Kind: decision
- Status: active
- Created: 2026-09-03T11:33:16.901Z
- Updated: 2026-09-03T11:33:16.901Z
- Sources: ["bin/opencode-work-context.js","plugin/work-context-modal.js",".opencode/tui.json","test/installer.test.js","test/stages-tui.test.js","README.md"]

The generated .opencode/tui.json and the repository fixture currently set keybinds.leader to ctrl+alt+w. plugin/work-context-modal.js intentionally registers commands with <leader>w, <leader>s, <leader>o, and <leader>e, so overriding the global leader changes all of those bindings and disables OpenCode's default Ctrl+X leader behavior. Restore the default by omitting keybinds.leader from generated and fixture TUI configuration; keep plugin bindings expressed through <leader> tokens. Update README and tests to describe the default Ctrl+X prefix. Do not edit .work-context projections manually.
