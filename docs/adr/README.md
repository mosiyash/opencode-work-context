# Architecture Decisions

This directory records the package and OpenCode integration decisions.

- [ADR-0002: Read-only stages panel](0002-read-only-stages-tui-panel.md)
- [ADR-0003: Fast read-only Work Context TUI modal](0003-fast-read-only-work-context-tui-modal.md)

The filesystem core and storage implementation remain the package source of
truth. Server and TUI integrations import package exports, and projects do not
copy `src/` or `tools/`. Generated Markdown, JSONL, `INDEX.md`, and
`SESSIONS.md` files are projections and must not be edited manually.
