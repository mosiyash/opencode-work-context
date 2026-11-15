# Durable Knowledge

## KC-0001: Global worktree root fallback

- Kind: fact
- Status: active
- Created: 2026-11-14T10:48:44.012Z
- Updated: 2026-11-14T10:48:44.012Z
- Sources: ["src/tool-definitions.js","test/integration/plugins.test.js"]

When OpenCode runs outside a Git repository, it can report worktree as "/" while directory remains the actual project directory. Tool definitions must use directory when worktree is "/"; otherwise storage would be resolved at the filesystem root.

## KC-0002: Plugin upgrades require restart

- Kind: procedure
- Status: active
- Created: 2026-11-15T06:35:31.232Z
- Updated: 2026-11-15T06:35:31.232Z
- Sources: ["~/.opencode/opencode.json","~/.cache/opencode/packages/opencode-work-context@0.4.15"]

OpenCode resolves external plugins into its package cache and loads them at startup. After installing or upgrading opencode-work-context, restart OpenCode before validating a runtime fix; the current session continues using its already-loaded plugin version.
