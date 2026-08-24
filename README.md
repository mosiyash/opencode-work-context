# opencode-work-context

Filesystem work-context core and OpenCode adapter for standalone projects. The
package is ESM and has no dependency on Mezzio or PHP.

## Install

Run from the root of a standalone OpenCode project:

```sh
npx opencode-work-context init
```

`init` installs `opencode-work-context@0.1.0` as an exact devDependency using
standard `npm`, preserving normal lifecycle behavior for the host project. It
creates `package.json` when absent and writes the integration files below.
It does not create a workspace. Start one explicitly with `/wc create "Title"`.

Use `--force` to replace a conflicting package-owned generated file. Without it,
existing files are never silently overwritten. Re-running with unchanged files is
safe and idempotent.

Generated files:

- `.work-context/config.yaml` for filesystem configuration;
- `.opencode/commands/wc.md` for the `/wc` command contract;
- `.opencode/plugins/work-context.js` as a thin loader from the installed package;
- `.work-context/local/` in `.gitignore` for personal session events.
- `<workspace>/KNOWLEDGE.md` is the canonical durable knowledge ledger and is
  created on the first explicit knowledge operation.

Tools are registered by the installed plugin and are not copied into the project.
Knowledge operations are explicit: list, add, update, and supersede. Finishing a
stage requires declaring whether its knowledge review was `added` or `none`.

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
