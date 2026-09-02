# Repository Guidelines

## Repository Language

All content committed to this public repository must be written in English.

This includes source-code comments, documentation, UI text, error messages,
test descriptions, examples, release notes, and commit messages. Conversation
with the user may be in Russian, but repository artifacts must remain in
English.

The `.work-context/` directory may contain Russian content while work is in
progress, but all of its tracked projections must be translated to English
before a public release. Content under `.work-context/local/` is local-only,
is not published, and may remain in any language. Fixtures that intentionally
verify Unicode or localization behavior require an explicit, narrowly scoped
exception.

Translate work-context content through the matching structured
`work_context_*` operations. Never edit work-context Markdown, JSONL, INDEX,
or SESSIONS projections directly. If no operation supports a required change,
stop and add or request the necessary supported operation instead of modifying
a projection by hand.

Before publishing a release, run `npm run check:language` and inspect all
changed files for accidental non-English content.

## npm Releases

Publish this package only through `.github/workflows/release.yml` using npm
Trusted Publishing with GitHub Actions OIDC. Never create, store, or request an
npm publish token, and never run `npm publish` locally. The npm package trusts
the `release.yml` workflow for the `npm publish` action.

Before a release, run the test suites, language check, package dry run, and
working-tree checks. Bump the version with `npm version patch`, `minor`, or
`major` as appropriate, push the release commit to `main`, and then push the
matching `v<version>` tag. Monitor the GitHub Actions workflow and verify the
published version and `latest` dist-tag directly in the npm registry.

The Git tag must exactly match the version in `package.json`. Never reuse or
move a tag that has already been pushed or published.
