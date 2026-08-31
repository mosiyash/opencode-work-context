# Durable Knowledge

## KC-0001: Stage 08 result and resume contract fix

- Kind: decision
- Status: active
- Created: 2026-08-31T07:02:46.689Z
- Updated: 2026-08-31T07:28:07.688Z
- Sources: ["stage 08","stage 09","commit e85e58b","commit 4454adf"]

Historical work-context record translated to English.

## KC-0002: English localization release 0.1.7

- Kind: fact
- Status: active
- Created: 2026-08-31T07:33:09.971Z
- Updated: 2026-08-31T07:33:09.971Z
- Sources: ["https://www.npmjs.com/package/opencode-work-context","https://registry.npmjs.org/opencode-work-context/-/opencode-work-context-0.1.7.tgz"]

Released opencode-work-context@0.1.7 publicly on npm with the latest dist tag. Package identifier: opencode-work-context. Registry tarball: https://registry.npmjs.org/opencode-work-context/-/opencode-work-context-0.1.7.tgz. Integrity: sha512-q3wSkz8GAv/G9OH1mp3j7yNHTgfYTyNhXlvOnt8H3n1EszFpikE/wzB1YRW6OM344l/TOJhvZiPz8ElAk5R/0A==. Verification: npm test passed (69 passed, 2 skipped); npm run test:integration passed (6 passed); npm pack --dry-run passed with 40 files; npm ls --depth=0 passed; git diff --check passed; registry npm view confirmed version 0.1.7 and latest publication; registry npm pack confirmed the published package contents. Local installer behavior is covered by the passing installer tests. User-facing application defaults, tool descriptions, /wc command contract, documentation, and relevant tests are English. Russian text intentionally retained only in historical .work-context workspace/stage metadata and session event summaries; canonical historical user data was not translated.
