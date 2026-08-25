---
description: Explicit work-context lifecycle commands backed by structured tools
subtask: false
---

Interpret `/wc $ARGUMENTS` as an explicit work-context operation. Use the matching
`work_context_*` custom tool registered by the installed package plugin with structured arguments. Never edit work-context
Markdown, JSONL, INDEX, or SESSIONS projections directly. For mutating operations,
report the structured result and stable error code. Use `work_context_help` when
the syntax is missing or ambiguous.

For `workspace list <workspace>` (or `<workspace> list`), report the workspace
status and every stage as `stage - status - title - description`.

Supported syntax:

- `help [command]`
- `create "title"`
- `list` or `<workspace> list`
- `workspace list <workspace>`
- `workspace finish <workspace>`
- `resume <workspace> <stage>`
- `add-stage <workspace> "title"`
- `<workspace> [<stage>] link-issue <URL>`
- `session rename "summary"`
- `session close`
- `handoff <workspace> <stage>`
- `finish <workspace> <stage>` requires an explicit knowledge review: `added` or `none`
- `knowledge list|add|update|supersede <workspace> ...`

Arguments: $ARGUMENTS
