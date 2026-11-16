# Durable Knowledge

## KC-0001: Concurrent stages lack change provenance

- Kind: fact
- Status: active
- Created: 2026-11-15T14:43:43.924Z
- Updated: 2026-11-15T14:43:43.924Z
- Sources: ["User problem statement in Planning stage"]

Multiple stages may perform substantial development concurrently in the same Git working tree. Git records repository-wide file state, while Work Context currently does not provide authoritative provenance linking each file or hunk mutation to the stage/session that produced it. At commit time an agent therefore reconstructs ownership heuristically from session history and diffs, which creates ambiguity, excessive analysis, user prompts, and nonsensical scope conclusions. Overlapping edits to the same file cannot be attributed reliably after the fact without stronger isolation or mutation-time tracking.

## KC-0002: Development must remain on one shared branch

- Kind: fact
- Status: active
- Created: 2026-11-15T14:45:53.365Z
- Updated: 2026-11-15T14:45:53.365Z
- Sources: ["User clarification in Planning stage"]

The target workflow is startup-style development where many concerns are addressed quickly on one shared branch. Per-stage branches or Git worktrees are not acceptable because their integration and coordination overhead would slow development. The design must support multiple stages contributing to one working tree and must not assume that a stage exclusively owns files or commits.

## KC-0003: Commits must ship ready subsets while other work continues

- Kind: fact
- Status: active
- Created: 2026-11-15T14:46:35.447Z
- Updated: 2026-11-15T14:46:35.447Z
- Sources: ["User clarification in Planning stage"]

A commit must represent whichever result is ready to ship, while unrelated work may still be in progress in the same branch and working tree. Therefore neither an entire stage nor the entire workspace is always the commit boundary. The system needs an explicit ready-to-commit change set that can be committed without including concurrent unfinished work.

## KC-0004: Introduce an explicit startup workflow mode

- Kind: fact
- Status: active
- Created: 2026-11-15T14:48:59.739Z
- Updated: 2026-11-15T14:48:59.739Z
- Sources: ["User proposal and Planning-stage discussion"]

Work Context should support an explicit opt-in `startup` mode for high-throughput development on one shared branch and working tree. In this mode concurrent stages are expected, stages do not own files or commits, ready subsets are represented by commit candidates, unfinished work may remain in the tree, and Git commit operations are serialized. The mode is appropriate only when the workspace deliberately accepts these collaboration and isolation tradeoffs; it should not silently become the default behavior for every project.

## KC-0005: Workflow mode is persisted and visible

- Kind: fact
- Status: active
- Created: 2026-11-15T14:53:52.378Z
- Updated: 2026-11-15T14:53:52.378Z
- Sources: ["Planning decision after repository exploration","src/stages-snapshot.js","plugin/stages-tui.js","src/stages-renderer.js"]

Workflow mode is workspace-level metadata with allowed values `standard` and `startup`. Existing workspaces without the field resolve to `standard` without rewriting their files. The compact sidebar exposes the mode directly below the workspace title as `Workflow · <mode>` through the existing read-only snapshot boundary; it must not read or mutate metadata directly from the renderer.

## KC-0006: Commit candidates use isolated Git state

- Kind: fact
- Status: active
- Created: 2026-11-15T14:53:52.516Z
- Updated: 2026-11-16T04:22:43.730Z
- Sources: ["Planning decision after repository exploration","src/git-candidates.js","src/candidates.js","src/core.js","test/candidates.test.js"]

A startup-mode commit candidate snapshots an explicitly selected ready patch rather than inferred stage ownership. Candidate preview and commit operations use a temporary Git index and never stage through the user's ordinary index. Candidate commits are serialized by a repository-scoped candidate/Git lock acquired before the work-context write lock, validate their recorded base against the current attached branch, reapply cleanly to the latest HEAD when possible, and compare-and-swap the branch ref. They return concrete overlap, detached-HEAD, or ref-race errors instead of guessing, while transaction rollback preserves ready metadata on publication failure. Publication uses `git commit-tree`, deliberately bypassing hooks and signing; unrelated working-tree WIP remains untouched.

## KC-0007: Commit candidates are local operational state

- Kind: fact
- Status: active
- Created: 2026-11-15T14:54:06.437Z
- Updated: 2026-11-15T14:54:06.437Z
- Sources: ["Planning decision after repository exploration"]

Candidate metadata and patch payloads belong under `.work-context/local/` rather than tracked workspace projections. They are ephemeral repository operations, may contain source diffs or secrets, and must not create self-referential changes that themselves enter a candidate. Stable candidate tools may expose their state, but generated INDEX, SESSIONS, workspace Markdown, and knowledge projections are not candidate storage.

## KC-0008: Project extensions stay outside package-managed files

- Kind: decision
- Status: active
- Created: 2026-11-15T15:10:01.068Z
- Updated: 2026-11-15T15:10:01.068Z
- Sources: ["commands/wc.md","README.md","bin/opencode-work-context.js","test/installer.test.js"]

Package-managed command and loader files must remain replaceable during updates. Additive project workflow guidance belongs in `.opencode/work-context.md` and is merged into the `/wc` command context without overriding structured tool mappings, storage safety, or explicit lifecycle rules. Executable extensions belong in separate project plugin files. Installer updates preserve existing `.work-context/config.yaml` and merge the work-context entry into shared `.opencode/tui.json` instead of replacing project settings or other TUI plugin entries.

## KC-0009: Startup workflow is integrated end to end

- Kind: fact
- Status: active
- Created: 2026-11-16T04:37:18.323Z
- Updated: 2026-11-16T04:37:18.323Z
- Sources: ["src/core.js","src/stages-snapshot.js","src/work-context-snapshot.js","src/stages-renderer.js","plugin/stages-tui.js","docs/adr/0006-startup-commit-candidate-workflow.md","test/candidates.test.js","test/integration/plugins.test.js"]

Associated OpenCode sessions in startup-mode workspaces now receive explicit shared-worktree and commit-candidate policy during create/resume, while standard-mode and unassociated core sessions remain unchanged. Read-only workspace and stages snapshots expose only pending and ready candidate counts from local metadata; renderers never inspect Git, patches, paths, or freshness. The sidebar renders candidate counts only when nonzero. Documentation, ADR-0006, command help, integration coverage, and the candidate A/unrelated B publication scenario define the public workflow.
