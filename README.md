# OpenCode Work Context

Keep the context of a task between OpenCode sessions.

Create one workspace for one task, split it into stages, and return to the
exact stage where you stopped. The optional sidebar and modal show the current
task and its progress at a glance.

![OpenCode Work Context stages sidebar](docs/assets/opencode-work-context.png)

> Example: one workspace for one task, linked to Jira issue `AN-142`, with
> three completed stages and the current work highlighted at stage 04.
>
> The sidebar is an optional read-only TUI panel. The core workflow works
> through `/wc` commands and OpenCode tools without it.

## How It Works

```text
Workspace: Add CSV export to analytics report
├── ✓ 01. Planning
├── ✓ 02. Update the export endpoint
├── ✓ 03. Add the download action
├── • 04. Handle export edge cases   <- current stage
└──   05. Verify the export flow
```

- **Workspace** is one concrete task, such as adding CSV export.
- **Stage** is one step in that task.
- **Planning** is normally the first stage.
- **Resume** starts a new session at a selected stage.
- **Handoff** preserves the context when moving work to another session.

## Quick Start

Run this from the root of a standalone OpenCode project:

```sh
npx opencode-work-context init
```

Then create a task and its first stage in OpenCode:

```text
/wc create "Add CSV export to analytics report"
/wc stage rename 000001 01 "Planning"
/wc stage add 000001 "Update the export endpoint" "Inspect the current endpoint, implement CSV export, add regression tests, and verify the result."
/wc resume 000001 02
```

When you return later, continue from the active stage. A stage must have a
non-empty prompt before implementation begins; if the prompt is missing or
ambiguous, `/wc resume` instructs the agent to ask focused questions first.
Before working, the agent reports the stage essence, the previous session's
result or stopping point, and what it will do now. On subsequent resumes, it
only reports that context and waits for explicit confirmation before continuing:

```text
/wc resume 000001 02
```

Useful commands:

```text
/wc list
/wc workspace list 000001
/wc stage handoff 000001 02
/wc stage finish 000001 02
```

Workspace IDs are exactly six digits. Stage IDs are one or two digits and are
normalized to two digits by the command contract. Canonical examples are:

```text
/wc workspace list 000004
/wc resume 000004 02
/wc stage handoff 000004 02
/wc stage finish 000004 02
```

## Install

Run from the root of a standalone OpenCode project:

```sh
npx opencode-work-context init
```

`init` installs the current package version as an exact devDependency using
standard `npm`, preserving normal lifecycle behavior for the host project. The
dependency root is the project root when it has `package.json`, otherwise
`.opencode` when `.opencode/package.json` exists, and finally the project root
with a new `package.json` when neither exists. Package files, lockfiles, and
`node_modules` are changed only in that dependency root; integration files and
`.gitignore` always belong to the project root.

The installer ensures that the dependency-root package uses `"type": "module"`
and generates ESM server and TUI loaders. OpenCode loads local plugins as JavaScript
modules; keeping the generated `.js` integration path ESM avoids a CommonJS
interop failure before custom tools are registered.
It does not create a workspace. Start one explicitly with `/wc create "Title"`.

Use `--force` to replace a conflicting package-owned generated file or package
version. Without it, existing files are never silently overwritten. Re-running
with unchanged files is safe and idempotent.

## Update

Run the update from the root of the OpenCode project that has the plugin
installed:

```sh
npx --yes opencode-work-context@latest init --force
```

This installs the latest package version as an exact devDependency and refreshes
the package-owned server and TUI loaders. It preserves the project's
`.work-context` data. Check the installed version with:

```sh
npm ls opencode-work-context --depth=0
```

Restart OpenCode after updating so it reloads the new server plugin, TUI loader,
keymap, and modal code. A restart is required after changing package code or
`.opencode/tui.json`; lifecycle data changes are picked up by the existing
refresh mechanisms.
Use a specific version instead of `latest` when you need a pinned upgrade, for
example `npx --yes opencode-work-context@0.1.10 init --force`.

Generated files:

- `.work-context/config.yaml` for filesystem configuration;
- `.opencode/commands/wc.md` for the `/wc` command contract;
- `.opencode/plugins/work-context.js` as a thin loader from the installed package;
- `.opencode/tui-plugins/work-context-stages.js` as the reactive stages-panel loader;
- `.work-context/local/` in `.gitignore` for personal session events.
- `<workspace>/KNOWLEDGE.md` is the canonical durable knowledge ledger and is
  created on the first explicit knowledge operation.

The optional read-only stages panel and modal are a separate TUI plugin. `init` installs a
project-local loader outside OpenCode's server-plugin autoscan at
`.opencode/tui-plugins/work-context-stages.js` and enables it in `.opencode/tui.json`:

```js
export { default } from "opencode-work-context/tui";
```

Enable that loader explicitly in `.opencode/tui.json`:

```json
{ "$schema": "https://opencode.ai/tui.json", "plugin": ["./tui-plugins/work-context-stages.js"] }
```

The package keeps the existing `opencode-work-context/plugin` server export and
also exposes the explicit server entry as `opencode-work-context/server`.
The combined read-only panel and modal are exposed only as
`opencode-work-context/tui`. Both TUI adapters read canonical storage via
`WorkContext.openExisting`; they do not create `.work-context`, call lifecycle
tools, or modify Markdown/JSONL projections. Hosts without the TUI plugin API
continue to load the server plugin and its tools normally.

The modal is opened with `Ctrl+Alt+W` when the host supports the public TUI
keymap and dialog APIs. Its `l`, `r`, `h`, and `f` actions only prepare visible
`/wc` commands. They never submit, invoke tools, dispatch commands, invoke an
LLM, or mutate storage. Prompt insertion is best effort: a host-provided public
append bridge may insert the command, otherwise the modal shows the exact
command and `PROMPT_INSERT_UNAVAILABLE` for manual submission. The installed
`@opencode-ai/plugin` 1.18.21 declarations expose `TuiPromptRef/set`, not a
confirmed `prompt.append` API, so runtime support must be verified rather than
assumed.

Tools are registered by the installed server export and are not copied into the
project. Core and storage remain in the installed package; projects should not
copy `src/` or `tools/`. `.work-context` Markdown, JSONL, `INDEX.md`, and
`SESSIONS.md` are generated projections and must never be edited manually.
Tracker links support GitLab issues (`/-/issues/<number>`), GitHub issues
(`/issues/<number>`), and Jira issues (`/browse/KEY-123`). They are URL-based
references only; the plugin does not call provider APIs or synchronize issue
metadata.
Knowledge operations are explicit: list, add, update, and supersede. Finishing a
stage always validates the Knowledge Base and reports its total and active entry
counts. Before finishing, persist new durable findings, update changed entries,
supersede obsolete entries, or explicitly use `knowledgeReview=none` when no
durable findings were produced. The default `knowledgeReview=auto` remains
accepted, and `knowledgeReview=added` records that the ledger was changed.
Every stage start/resume includes all active entries in
`resume.context.workspace_knowledge`. Agents should treat this as established
workspace-wide context and avoid repeating earlier analysis unless an entry is
incomplete, contradicted, or requires verification. Superseded entries and full
stage results are not injected into later stages.
Finish a workspace explicitly with `/wc workspace finish <workspace>`; it is
accepted only after every stage is `completed`. Use `/wc workspace list <workspace>`
to list stages with their descriptions. Workspace titles can be changed with
`/wc workspace rename <workspace> "title"`, and existing stage descriptions can
be changed with `/wc stage update <workspace> <stage> "description"`.

If the host `opencode.json` restricts `experimental.primary_tools`, add the
registered `work_context_*` tool names to that allowlist; the installer does not
rewrite project-specific agent policy.

## License

MIT. Copyright (c) 2026 Nikita Mosiyash.

## Manual fallback

For an offline or advanced setup, install the package as a devDependency and add
the equivalent plugin loader and `/wc` command from this repository. Keep the
plugin import pointed at `opencode-work-context/plugin`; do not copy `src/` or
individual tools into the project.

## Development

The package layout is intentionally small:

- `src/` contains the dependency-free core, storage, projections, and adapter;
- `plugin/` exposes the OpenCode plugin contract;
- `tools/` exposes individual tool contracts;
- `bin/` contains the `init` CLI;
- `commands/` contains the reusable `/wc` prompt;
- `test/` contains core contract tests.

Run `npm test` when explicitly verifying a checkout.

Run `npm run test:integration` for the reusable plugin-boundary scenarios. These
tests create isolated fixture projects, use a small fake OpenCode host, and
exercise a new session resume through the server title hook and read-only TUI
snapshot without requiring an interactive OpenCode process.
