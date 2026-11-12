# Durable Knowledge

## KC-0001: Dependency visualization direction

- Kind: decision
- Status: active
- Created: 2026-11-12T03:41:08.938Z
- Updated: 2026-11-12T03:41:08.938Z
- Sources: []

Use a compact sidebar with direct prerequisite IDs and a separate deterministic ASCII dependency-tree view. Build both from canonical stage depends_on data; do not rely on an AI-generated tree. The TUI snapshot must expose dependencies because it currently maps them out.

## KC-0002: TUI snapshot dependency contract

- Kind: decision
- Status: active
- Created: 2026-11-12T03:58:15.086Z
- Updated: 2026-11-12T03:58:15.086Z
- Sources: ["src/stages-snapshot.js","src/work-context-snapshot.js","test/stages-tui.test.js"]

Both TUI snapshot readers expose each visible stage's canonical `depends_on` array. The array is present and empty for stages without dependencies; archived stages remain filtered.

## KC-0003: Dependency tree TUI access

- Kind: decision
- Status: active
- Created: 2026-11-12T08:40:52.812Z
- Updated: 2026-11-12T08:40:52.812Z
- Sources: []

The full deterministic dependency tree is available through the native TUI dialog using the `work_context.show_dependency_tree` command, bound to `<leader>t`. The compact sidebar remains separate and can show direct dependency IDs through its existing toggle. The dialog uses ASCII branches and truncates titles on terminals narrower than 50 columns.
