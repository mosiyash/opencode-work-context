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
