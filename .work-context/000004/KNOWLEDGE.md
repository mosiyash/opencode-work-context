# Durable Knowledge

## KC-0001: Verify installation and TUI loader in OpenCode 1.18.25

- Kind: fact
- Status: active
- Created: 2026-08-31T09:03:05.045Z
- Updated: 2026-08-31T09:57:16.260Z
- Sources: ["package.json","bin/opencode-work-context.js","plugin/stages-tui.js","test/stages-tui.test.js","/tmp/opencode/lk2-real.f5eha9"]

Stage 02 verification completed on 2026-08-31. The lk2 project was not found in the available workspace, so an isolated external fixture /tmp/opencode/lk2-real.f5eha9 was used. Environment: opencode-work-context 0.1.9, OpenCode 1.18.25, Node v26.3.0, Bun unavailable. Running `npx --yes opencode-work-context@0.1.9 init --force` from the project root successfully installed the package: devDependencies and node_modules contain version 0.1.9; `.opencode/tui-plugins/work-context-stages.js` and `.opencode/tui.json` were created with plugin `./tui-plugins/work-context-stages.js`; running init --force again also succeeded, and the loader imported with id work-context-stages and a tui function. Node-based test/stages-tui.test.js: 29 passed, 2 skipped (real OpenTUI smoke tests require Bun). Verified initial snapshot load, session.updated debounce, completed work_context_* tool event, canonical storage fs.watch, polling, session routing, and cleanup; the lifecycle stage list updates without remount at the host-contract test level. Full npm test: 65 passed, 4 installer failures caused by the test fake npm using CommonJS require in an ESM package scope under Node 26, not by real npm installation; real installation succeeded. Actual npm audit warnings: 4 low vulnerabilities, deprecated glob, and pending msgpackr-extract script approval. Runbook: run init strictly from the project root; check package.json, node_modules/opencode-work-context/package.json, the loader, and tui.json; if stages disappear, check the TUI config path, import the loader, and restart OpenCode; perform interactive OpenTUI verification in an environment with Bun.
