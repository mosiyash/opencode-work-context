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

Use these exact tool mappings; do not invent shortened tool names:

- `create` -> `work_context_create_workspace`
- `list` -> `work_context_list_workspaces`
- `workspace list <workspace>` or `<workspace> list` -> `work_context_workspace_list`
- `workspace rename <workspace> "title"` -> `work_context_rename_workspace`
- `workspace finish <workspace>` -> `work_context_workspace_finish`
- `resume <workspace> <stage>` -> `work_context_start_session`
- `stage add [<workspace>] ...` -> `work_context_add_stage` (optional `prompt`; detailed prompt is expected for stages created from planning)
- `stage rename [<workspace>] <stage> "title"` -> `work_context_rename_stage`
- `stage update [<workspace>] <stage> "description"` -> `work_context_update_stage`
- `stage archive [<workspace>] <stage>` -> `work_context_archive_stage`
- `stage handoff <workspace> <stage>` -> `work_context_handoff_stage`
- `stage abandon <workspace> <stage>` -> `work_context_abandon_stage`
- `stage finish <workspace> <stage>` -> `work_context_finish_stage`

Supported syntax:

- `help [command]`
- `create "title"`
- `list` or `<workspace> list`
- `workspace list <workspace>`
- `workspace rename <workspace> "title"`
- `workspace finish <workspace>`
- `resume <workspace> <stage>`
- `stage add [<workspace>] "title" ["prompt"]`
- `stage rename [<workspace>] <stage> "title"`
- `stage update [<workspace>] <stage> "description"`
- `stage archive [<workspace>] <stage>`
- `stage finish <workspace> <stage>`
- `<workspace> [<stage>] link-issue <URL>`
- `session rename "summary"`
- `stage handoff <workspace> <stage>`
- `stage abandon <workspace> <stage>`
- `stage finish <workspace> <stage>` automatically reviews the Knowledge Base (`auto` by default)
- `knowledge list|add|update|supersede <workspace> ...`

Arguments: $ARGUMENTS
