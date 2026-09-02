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
- `stage force-close <workspace> <stage> <sessionId> "reason" FORCE_CLOSE` -> `work_context_force_close_session`
- `stage add [<workspace>] ...` -> `work_context_add_stage` (optional `prompt`; a detailed local prompt is expected for stages created from planning, while shared context belongs in workspace knowledge)
- `stage rename [<workspace>] [<stage>] "title"` -> `work_context_rename_stage`
- `stage update [<workspace>] [<stage>] "description"` -> `work_context_update_stage`
- `stage update-prompt [<workspace>] [<stage>] "prompt"` -> `work_context_update_stage_prompt`
- `stage update-result [<workspace>] [<stage>] "result"` -> `work_context_update_stage_result`
- `stage archive [<workspace>] [<stage>]` -> `work_context_archive_stage`
- `stage handoff [<workspace>] [<stage>]` -> `work_context_handoff_stage`
- `stage abandon [<workspace>] [<stage>]` -> `work_context_abandon_stage`
- `stage finish [<workspace>] [<stage>]` -> `work_context_finish_stage`

Supported syntax:

- `help [command]`
- `create "title"`
- `list` or `<workspace> list`
- `workspace list <workspace>`
- `workspace rename <workspace> "title"`
- `workspace finish <workspace>`
- `resume <workspace> <stage>`
- `stage force-close <workspace> <stage> <sessionId> "reason" FORCE_CLOSE`
- `stage add [<workspace>] "title" ["prompt"]`
- `stage rename [<workspace>] [<stage>] "title"`
- `stage update [<workspace>] [<stage>] "description"`
- `stage update-prompt [<workspace>] [<stage>] "prompt"`
- `stage update-result [<workspace>] [<stage>] "result"`
- `stage archive [<workspace>] [<stage>]`
- `stage handoff [<workspace>] [<stage>]`
- `stage abandon [<workspace>] [<stage>]`
- `stage finish [<workspace>] [<stage>]`
- `<workspace> [<stage>] link-issue <URL>`
- `session rename "summary"`
- `stage handoff [<workspace>] <stage>`
- `stage abandon [<workspace>] <stage>`
- `stage finish [<workspace>] <stage>` automatically reviews the Knowledge Base (`auto` by default)
- stage lifecycle commands may omit stage, using the current OpenCode session; with one numeric identifier, six digits mean workspace and one or two digits mean stage
- `stage update-result` replaces an existing result and does not create a result for an unfinished stage
- `resume` returns `resume.context` with the stage essence, the previous session's result/stopping point, and the current plan; report this concise context to the user before doing any work
- `resume.context.workspace_knowledge` contains every active durable knowledge entry for the workspace; treat it as established shared context, and do not repeat earlier analysis unless an entry is incomplete, contradicted, or needs verification
- on every subsequent resume, report the context and wait for explicit user confirmation; do not automatically continue implementation
- when `resume.next_action` is `await_confirmation`, do not inspect or modify application code until the user confirms
- `create` enters the new workspace's Planning stage in the current OpenCode session only when that session is not yet in a workspace; otherwise it only creates the workspace and its planning session
- `stage add` enters the newly created stage and returns its actionable `resume` context when the current OpenCode session is not yet in a workspace; otherwise it only creates the planned stage
- `resume` returns `resume.next_action` and `resume.instruction`; begin or continue implementation only when the stage prompt is non-empty and, after reviewing it, there are no unanswered questions
- when `resume.next_action` is `ask_questions`, do not inspect or modify application code and ask the user focused questions needed to make the prompt actionable
- before `stage finish`, review durable findings: add new knowledge, update changed knowledge, supersede obsolete knowledge, or explicitly use `knowledgeReview=none` when the stage produced no durable findings; use `knowledgeReview=added` after ledger changes
- `stage finish` always validates the Knowledge Base and returns total and active entry counts plus downstream unfinished stages whose prompts should be reviewed after new findings
- `knowledge list|add|update|supersede <workspace> ...`

Arguments: $ARGUMENTS
