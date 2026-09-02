# Durable Knowledge

## KC-0001: Architecture and runtime audit baseline

- Kind: fact
- Status: active
- Created: 2026-09-01T12:09:54.510Z
- Updated: 2026-09-01T12:09:54.510Z
- Sources: ["README.md","package.json","bin/opencode-work-context.js","plugin/stages-tui.js","plugin/server.js","src/core.js","src/stages-snapshot.js","node_modules/@opencode-ai/plugin/dist/tui.d.ts","node_modules/@opencode-ai/plugin/package.json"]

Audit baseline for workspace 000006. Repository package is opencode-work-context 0.1.10, ESM, Node >=20. Exports: ./plugin -> plugin/work-context.js (server function), ./server -> plugin/server.js wrapper, ./tui -> plugin/stages-tui.js (separate TUI entry), ./adapter, ./tools/*, and root core. package.json files include bin, commands, plugin, src, tools, README, LICENSE. Installer generates .opencode/plugins/work-context.js for server, .opencode/tui-plugins/work-context-stages.js for TUI, and .opencode/tui.json; it does not copy src/tools. Existing stages TUI uses sidebar_content, host Solid/JSX runtime wrapper, WorkContext.openExisting through readStagesSnapshot, debounce/poll/fs.watch, stale snapshot retention, and lifecycle cleanup. Server plugin remains independent and registers tools/title hooks.

Factually confirmed on 2026-09-01: `opencode --version` => 1.18.25. Local npm tree: @opencode-ai/plugin 1.18.21, @opentui/solid 0.4.5, solid-js 1.9.12. @opencode-ai/plugin/dist/tui.d.ts publicly types TuiPluginApi with keymap, ui.Dialog/DialogSelect/DialogPrompt/DialogPrompt/Prompt/toast/dialog, slots, event, lifecycle, state, client; it marks legacy api.command deprecated and recommends api.keymap.registerLayer/dispatchCommand. The package runtime export only exposes createBindingLookup from its TUI subpath; host runtime methods are not implemented by this package. The OpenCode executable is a bundled ELF at /home/nikita/.opencode/bin/opencode, so host loader internals are not a package API. Existing local TUI and server module imports succeed statically via direct Node import, but no modal/shortcut has been implemented or runtime-loaded yet. Compatibility for actual interactive loader, key registration, dialog open/close remains unconfirmed and must not be inferred from declarations.

## KC-0002: TUI modal compatibility spike result

- Kind: fact
- Status: active
- Created: 2026-09-01T12:12:23.001Z
- Updated: 2026-09-01T12:12:23.001Z
- Sources: ["plugin/work-context-modal.js","node_modules/@opencode-ai/plugin/dist/tui.d.ts","opencode --version"]

Compatibility spike result on 2026-09-01. Added isolated plugin/work-context-modal.js using only public-shaped api.keymap.registerLayer, api.ui.dialog, api.ui.Dialog, and api.lifecycle.onDispose. Fake host confirmed command name work_context.open, binding key ctrl+alt+w, command run dispatching the public dialog stack, public Dialog onClose clearing the dialog, and registration disposal exactly once. A first probe without a host renderer failed with `Error: No renderer found` from @opentui/solid/jsx-runtime; this is an expected host-runtime boundary, not a compatibility confirmation. The spike was corrected to require an injected runtime.jsx and return safely when it is absent. A fake host with injected jsx completed open/close successfully. Actual interactive OpenCode loader discovery and keyboard/dialog behavior remain unverified; the final loader must inject OpenCode-owned Solid/JSX runtime as the existing stages loader does. No internal registry, server tool, lifecycle mutation, or storage write was used.

## KC-0003: External prior-work context from mezzio

- Kind: fact
- Status: active
- Created: 2026-09-01T12:13:42.930Z
- Updated: 2026-09-01T12:13:42.930Z
- Sources: ["/home/nikita/projects/mssh/mezzio/.work-context/000004/KNOWLEDGE.md","https://github.com/anomalyco/opencode/blob/v1.18.25/packages/plugin/src/tui.ts","https://github.com/anomalyco/opencode/blob/v1.18.25/packages/tui/src/component/command-palette.tsx","package.json","plugin/stages-tui.js","plugin/server.js"]

Mandatory external context read in full from /home/nikita/projects/mssh/mezzio/.work-context/000004/KNOWLEDGE.md on 2026-09-01. KC-0001 confirms from OpenCode v1.18.25 upstream/docs: Ctrl+P opens command.palette.show; custom .opencode commands are prompt templates, not direct tools; server custom tools do not automatically enter palette; modern TUI registration uses api.keymap.registerLayer({ commands, bindings }) with command fields name/title/desc/category/namespace/run; Ctrl+Alt+W can bind work_context.open; tui.command.execute only dispatches registered TUI commands; tui.prompt.append only inserts prompt text; no stable public invokeTool/executeTool exists; internal registries are forbidden; recommended architecture is core/service -> server tools plus separate TUI plugin; MVP is read-only cached workspace/stage/session browser with explicit /wc insertion; existing stages-tui building block should be reused; actual runtime and loader must be checked before implementation. KC-0002 states implementation belongs exclusively in ~/projects/mssh/opencode-work-context; mezzio only installs and integration-tests the published package/loader, and is not the implementation source of truth.

Comparison with current repository: all architectural constraints are consistent. Current repo already has .opencode/commands/wc.md, unlike the historical mezzio snapshot described by external KC-0001; it also already has separate server and stages TUI loaders, so the missing items are modal, shortcut, richer read model, and explicit insertion. Current runtime facts are opencode 1.18.25, local @opencode-ai/plugin 1.18.21, @opentui/solid 0.4.5, solid-js 1.9.12; package.json declares @opencode-ai/plugin ^1.14.50. External KC-0001 mentions historical version divergence (1.14.50/1.18.25 caches), which reinforces the compatibility gate. Upstream source claims registerLayer and dialog APIs, while local package declarations expose the TUI API shape but the bundled runtime loader and interactive modal behavior remain unverified. Preserve: separate repo/package source of truth, server/TUI boundary, canonical core/storage, explicit lifecycle, no direct tools/internal registries, and visible prompt-only mutations.

## KC-0004: Stage 05 implementation handoff

- Kind: fact
- Status: active
- Created: 2026-09-01T12:16:23.975Z
- Updated: 2026-09-01T12:16:23.975Z
- Sources: ["docs/adr/0003-fast-read-only-work-context-tui-modal.md","plugin/work-context-modal.js","plugin/tui.js","src/work-context-snapshot.js","src/stages-snapshot.js","plugin/stages-tui.js","package.json","bin/opencode-work-context.js","test/stages-tui.test.js","/home/nikita/projects/mssh/mezzio/.work-context/000004/KNOWLEDGE.md"]

Implementation handoff after stages 01-05, before modal UX stage 06. Workspace 000006 is the implementation source of truth; external mezzio KC-0001/KC-0002 was read and reconciled as KC-0003.

Completed repository changes:
- docs/adr/0003-fast-read-only-work-context-tui-modal.md: Proposed ADR covering Ctrl+Alt+W, work_context.open, separate TUI entry, read-only modal, canonical read model, explicit /wc insertion, rejection of direct tool invocation and internal APIs, alternatives, consequences, and compatibility gate.
- plugin/work-context-modal.js: minimal public-API spike/foundation. It uses api.keymap.registerLayer with command {name,title,desc,category,namespace,run}, binding {key:"ctrl+alt+w",cmd:"work_context.open",desc}, api.ui.dialog.replace, api.ui.Dialog, api.ui.dialog.clear, and api.lifecycle.onDispose. It safely no-ops when keymap/dialog/host runtime.jsx is absent. Do not reintroduce api.command.register or api.ui.dialog.show: upstream v1.18.25 command shim and local declarations confirm replace/clear and cmd binding shape.
- plugin/tui.js: separate aggregator composing existing stages.tui and modal.tui. Server plugin remains plugin/work-context.js and plugin/server.js unchanged.
- package.json: ./tui now points to ./plugin/tui.js. Existing generated loader imports the package /tui export and injects host-owned createSignal and jsx.
- src/work-context-snapshot.js: readWorkContextSnapshot({projectRoot,sessionId}) uses WorkContext.openExisting; lists all workspaces via core, stages and reduced sessions via listStages, filters archived stages, marks current workspace/stage from sessionById/sessionByOpenCodeId, exposes activeSession and session metadata, sorts workspace/stage IDs deterministically, and returns structured {ok:false,error,data:emptySnapshot()} on failures. It never initializes storage or writes any projection/state.
- src/index.js exports the new read model.
- test/stages-tui.test.js has unexecuted focused tests for absent storage and all-workspace/session metadata.

Compatibility facts:
- opencode --version returned 1.18.25.
- Local dependencies are @opencode-ai/plugin 1.18.21, @opentui/solid 0.4.5, solid-js 1.9.12; package declares @opencode-ai/plugin ^1.14.50.
- Upstream v1.18.25 source confirms TuiPluginApi, registerLayer command fields, and TUI smoke plugin uses api.ui.dialog.replace and api.keymap.registerLayer. Local package declarations expose the same public TUI shape but runtime methods belong to OpenCode host.
- Fake host probe confirmed command registration, Ctrl+Alt+W binding, dialog replace/render/clear, and disposal. A probe using JSX without a host renderer failed exactly with `Error: No renderer found`; the loader must inject OpenCode-owned JSX, as current stages loader does.
- Actual OpenCode project-local TUI loader discovery, keyboard dispatch, and interactive dialog behavior remain unverified. Do not call compatibility fully confirmed.

Next stage requirements:
- Replace the placeholder compatibility dialog with a useful read-only modal using readWorkContextSnapshot and the existing controller stale-snapshot pattern.
- Keep the modal native through api.ui.dialog.replace(() => <Dialog ...>) or equivalent host runtime JSX; use public Dialog/DialogSelect/DialogPrompt/Prompt APIs only.
- Support workspace selection, stages, current markers, active/current session metadata, statuses, search/filter, bounded keyboard navigation, details, empty/error/stale states, and clean close.
- Keep all actions read-only. No direct tool calls, no lifecycle mutation, no projection edits, no prompt insertion yet until stage 07, no LLM invocation, and no implicit parsing.
- Ensure refreshes do not create storage and failed refreshes retain the last successful snapshot with visible stale/error state.
- Preserve existing sidebar panel and server plugin behavior. Do not manually edit .work-context projections.
- Add focused tests but do not run package/integration/interactive verification until the developer explicitly authorizes it. Review package export expectation tests later because ./tui changed from plugin/stages-tui.js to plugin/tui.js.

## KC-0005: Stage 06 modal implementation

- Kind: fact
- Status: active
- Created: 2026-09-01T12:20:47.010Z
- Updated: 2026-09-01T12:20:47.010Z
- Sources: ["plugin/work-context-modal.js","test/stages-tui.test.js"]

Implemented plugin/work-context-modal.js as a native read-only Dialog using host-injected runtime.jsx. The modal reads exclusively through readWorkContextSnapshot, maintains stale last-successful data on refresh errors, polls and watches .work-context, supports bounded workspace/stage navigation, typing/backspace filtering, details view, current markers, session metadata, empty and error states, and preserves work_context.open plus Ctrl+Alt+W via api.keymap.registerLayer. Added focused tests for filtering, bounded navigation, and fake-runtime rendering in test/stages-tui.test.js. Package, integration, and interactive TUI verification remain unexecuted per stage instruction. Risks: host Dialog key event prop behavior and native rendering semantics were not validated in a live OpenCode TUI; filtering narrows stage lists while a query is active.

## KC-0006: Stage 09 verification matrix results

- Kind: fact
- Status: active
- Created: 2026-09-01T15:12:51.864Z
- Updated: 2026-09-01T15:12:51.864Z
- Sources: ["package.json","test/stages-tui.test.js","test/integration/plugins.test.js","plugin/work-context-modal.js","plugin/tui.js","plugin/server.js","bin/opencode-work-context.js",".opencode/tui-plugins/work-context-stages.js","README.md"]

Verification authorized explicitly by the developer on 2026-09-01. Environment: Node v26.3.0, Bun v1.4.0, OpenCode 1.18.25, package @opencode-ai/plugin local 1.18.21. Results: `npm test` PASS, 83 tests total, 81 passed, 0 failed, 2 skipped (live TUI update scenarios); `npm run test:integration` PASS, 9/9; `npm run test:tui` PASS, 39/39; direct public imports of src/index.js, plugin/work-context.js, plugin/server.js, plugin/tui.js, and plugin/work-context-modal.js PASS; generated server/TUI loader imports and export-shape checks PASS; server plugin hook smoke check PASS; `opencode --version` PASS (1.18.25); `opencode --help` PASS; `npm pack --dry-run` PASS with 43 files; `git diff --check` PASS. Existing tests cover empty/absent storage, malformed/error states, stale snapshot retention, refresh/poll/watch behavior, navigation, filtering, prompt insertion fallback, command registration, modal open/close, no-hidden-mutation behavior, package exports, installer paths, and server regression. Residual gap: actual interactive OpenCode TUI loader/keyboard/dialog runtime was not exercised in a live TTY; only fake-host/render smoke and generated-loader imports passed. An initial ad-hoc server probe incorrectly requested a nonexistent named export and failed with a Node SyntaxError; the correct default server export probe subsequently passed, so this is a probe mistake, not a product failure. Worktree contains expected implementation/documentation changes and canonical .work-context stage projections; no projections were manually edited.

## KC-0007: Nested TUI loaders require a stable plugin ID

- Kind: fact
- Status: active
- Created: 2026-09-01T16:26:23.318Z
- Updated: 2026-09-01T16:26:23.318Z
- Sources: ["plugin/tui.js","plugin/stages-tui.js",".opencode/tui.json",".opencode/tui-plugins/work-context-stages.js","test/stages-tui.test.js","https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/config/tui.ts","https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/plugin/tui/runtime.ts","https://github.com/anomalyco/opencode/blob/v1.18.25/packages/tui/src/plugin/slots.tsx"]

OpenCode 1.18.25 loads tui.json files from nested .opencode directories. In this repository it discovered the current project loader before /home/nikita/projects/mssh/.opencode/tui-plugins/work-context-stages.js. The parent installed package 0.1.10 exported id work-context-stages, while the new local aggregate plugin/tui.js exported id work-context, so both entries survived OpenCode runtime plugins_by_id and each called api.slots.register, producing two identical Stages panels. Config spec deduplication cannot remove them because the file URLs differ, and a WeakMap keyed by the scoped plugin api cannot deduplicate separate plugin entries. The fix keeps the aggregate entrypoint ID equal to stages.id (work-context-stages). OpenCode accepts the nearest local aggregate first and rejects the parent loader as a duplicate ID before tui() and slots.register run. Session routing, event/fs.watch/poll refresh, modal composition, and lifecycle cleanup remain unchanged. Regression test nested TUI loaders keep one stages slot through the stable plugin ID covers the two-loader case. Verification on 2026-09-01: npm test 87 passed, 0 failed, 2 skipped; npm run test:tui 45 passed; live OpenCode 1.18.25 tmux capture showed exactly one Stages block with current workspace/stages.

## KC-0008: Active workspace knowledge is injected into every stage resume

- Kind: contract
- Status: active
- Created: 2026-09-01T16:47:51.937Z
- Updated: 2026-09-01T16:47:51.937Z
- Sources: ["src/core.js","commands/wc.md","test/core.test.js"]

Every stage start/resume exposes all active Durable Knowledge entries in resume.context.workspace_knowledge. Agents treat these entries as established workspace-wide context and avoid repeating analysis unless an entry is incomplete, contradicted, or requires verification. Superseded entries and full stage results are not injected.

## KC-0009: Stage finish validates reviewed workspace knowledge

- Kind: procedure
- Status: active
- Created: 2026-09-01T16:48:01.076Z
- Updated: 2026-09-01T16:48:01.076Z
- Sources: ["src/core.js","src/tool-definitions.js","commands/wc.md","test/core.test.js"]

Before finishing a stage, persist new durable findings, update changed entries, supersede obsolete entries, or explicitly declare that no durable findings were produced. Stage finish validates the ledger in every review mode and reports total and active knowledge counts; knowledgeReview=added records ledger changes and knowledgeReview=none records an explicit no-findings review.

## KC-0010: Public repository language policy

- Kind: contract
- Status: active
- Created: 2026-09-01T17:06:27.793Z
- Updated: 2026-09-01T17:06:57.900Z
- Sources: ["AGENTS.md","scripts/check-repository-language.js","package.json"]

All public repository artifacts must be English. Russian may be used during development in tracked .work-context projections, but those projections must be translated before a public release. .work-context/local is local-only and may use any language. Translate work-context content only through matching structured work_context_* operations; never edit Markdown, JSONL, INDEX, or SESSIONS projections directly. If no operation supports a required translation, add or request that operation rather than editing a projection. `npm run check:language` scans tracked and non-ignored untracked repository files for Cyrillic, excludes only .work-context/local, and runs automatically through prepublishOnly.

## KC-0011: Stage results have a structured update operation

- Kind: contract
- Status: active
- Created: 2026-09-02T03:00:18.178Z
- Updated: 2026-09-02T03:00:18.178Z
- Sources: ["src/core.js","src/tool-definitions.js","commands/wc.md","plugin/work-context-modal.js","tools/work_context_update_stage_result.js","test/core.test.js","test/integration/plugins.test.js","test/stages-tui.test.js"]

The package now supports WorkContext.updateStageResult and the `work_context_update_stage_result` tool, mapped to `/wc stage update-result [<workspace>] [<stage>] "result"`. It updates only an existing non-empty `## Result` section, preserves stage metadata and status, regenerates projections transactionally, supports contextual workspace/stage resolution, and is idempotent. It rejects empty input with INVALID_ARGUMENT and stages without a result with INVALID_STATE. The TUI action modal can prepare the command. Full `npm test` verification passed 93 tests with 0 failures and 2 skips.

## KC-0012: npm releases use GitHub Trusted Publishing

- Kind: procedure
- Status: active
- Created: 2026-09-02T03:42:29.786Z
- Updated: 2026-09-02T03:42:29.786Z
- Sources: [".github/workflows/release.yml","AGENTS.md","README.md","package.json","https://registry.npmjs.org/opencode-work-context/0.1.11","https://github.com/mosiyash/opencode-work-context/actions/runs/33587819131"]

Release 0.1.11 was published successfully through .github/workflows/release.yml using npm Trusted Publishing with GitHub Actions OIDC. The workflow runs on matching v* tags, requires the tag to equal package.json version, uses Node 24, npm 11, and Bun 1.4.0, runs the full Node and TUI suites plus the repository language check, and publishes with automatic provenance. Local npm publish and long-lived publish tokens are no longer part of the release process. Future releases should run local release checks, use npm version patch/minor/major, push main, then push the matching tag, monitor GitHub Actions, and verify the registry version and latest dist-tag. Release 0.1.11 is registry latest and its successful workflow run is https://github.com/mosiyash/opencode-work-context/actions/runs/33587819131.
