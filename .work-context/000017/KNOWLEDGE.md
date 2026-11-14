# Durable Knowledge

## KC-0001: Global worktree root fallback

- Kind: fact
- Status: active
- Created: 2026-11-14T10:48:44.012Z
- Updated: 2026-11-14T10:48:44.012Z
- Sources: ["src/tool-definitions.js","test/integration/plugins.test.js"]

When OpenCode runs outside a Git repository, it can report worktree as "/" while directory remains the actual project directory. Tool definitions must use directory when worktree is "/"; otherwise storage would be resolved at the filesystem root.
