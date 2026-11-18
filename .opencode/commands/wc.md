---
description: Explicit work-context lifecycle commands backed by structured tools
subtask: false
---

Interpret `/wc $ARGUMENTS` as an explicit work-context operation. Use the matching
`work_context_*` custom tool registered by the installed package plugin with structured arguments. Never edit work-context
Markdown, JSONL, INDEX, or SESSIONS projections directly. For mutating operations
other than `resume`, report the structured result and stable error code. For
`resume`, follow its human-oriented presentation rules instead. Use `work_context_help` when
the syntax is missing or ambiguous.

`.opencode/commands/wc.md` is package-managed and may be replaced during install,
activation, or `sync-command`. Never store project-specific workflow logic in this
file or generated plugin loaders. Keep additive project instructions in
`.opencode/work-context.md`; when that file exists, read it before dispatching the
operation and merge its guidance into this command context. Project guidance may
specialize local workflow, but it must not override this tool mapping, structured
arguments, storage safety, or explicit lifecycle requirements.

For `workspace list <workspace>` (or `<workspace> list`), report the workspace
status and workflow mode, then every stage as
`stage - status - title - description`.

Use these exact tool mappings; do not invent shortened tool names:

- `create` -> `work_context_create_workspace`
- `list` -> `work_context_list_workspaces`
- `workspace list <workspace>` or `<workspace> list` -> `work_context_workspace_list`
- `workspace rename <workspace> "title"` -> `work_context_rename_workspace`
- `workspace mode <workspace> <standard|startup>` -> `work_context_set_workspace_mode`
- `candidate create <workspace> "title" ["message"] [strategy <exact|shared_foundation|integration>] [stages <stage>...]` -> `work_context_create_candidate`
- `candidate capture <workspace> <candidateId> paths <path>...` or `candidate capture <workspace> <candidateId> patch "patch"` -> `work_context_capture_candidate`
- `candidate preview <workspace> <candidateId>` -> `work_context_preview_candidate`
- `candidate show <workspace> <candidateId>` -> `work_context_show_candidate`
- `candidate list <workspace>` -> `work_context_list_candidates`
- `candidate ready <workspace> <candidateId>` -> `work_context_ready_candidate`
- `candidate commit <workspace> <candidateId> ["message"]` -> `work_context_commit_candidate`
- `candidate discard <workspace> <candidateId>` -> `work_context_discard_candidate`
- `delivery read <workspace> [<environment>] [range <from> <to>]` -> `work_context_read_delivery`
- `delivery mark <workspace> <environment> <commit> DELIVERY_CONFIRMED` -> `work_context_mark_delivery`
- `workspace finish <workspace>` -> `work_context_workspace_finish`
- `workspace reopen <workspace> "reason"` -> `work_context_reopen_workspace`
- `resume <workspace> <stage>` -> `work_context_start_session`
- `stage force-close <workspace> <stage> <sessionId> "reason" FORCE_CLOSE` -> `work_context_force_close_session`
- `stage add [<workspace>] ...` -> `work_context_add_stage` (optional `prompt`; a detailed local prompt is expected for stages created from planning, while shared context belongs in workspace knowledge)
- `stage profiles [<workspace>] [<stage>] [execution <routine|implementation|architecture|security|review|clear>] [review <routine|implementation|architecture|security|review|clear>]` -> `work_context_set_stage_profiles`
- `stage reopen <workspace> <stage> "reason"` -> `work_context_reopen_stage`
- `stage restore <workspace> <stage> "reason"` -> `work_context_restore_stage`
- `stage rename [<workspace>] [<stage>] "title"` -> `work_context_rename_stage`
- `stage update [<workspace>] [<stage>] "description"` -> `work_context_update_stage`
- `stage update-prompt [<workspace>] [<stage>] "prompt"` -> `work_context_update_stage_prompt`
- `stage update-result [<workspace>] [<stage>] "result"` -> `work_context_update_stage_result`
- `stage execution read [<workspace>] [<stage>]` -> `work_context_read_stage_execution`
- `stage execution replace [<workspace>] [<stage>] <expectedRevision> "state JSON"` -> `work_context_replace_stage_execution`
- `stage execution update [<workspace>] [<stage>] <expectedRevision> "changes JSON"` -> `work_context_update_stage_execution`
- `stage archive [<workspace>] [<stage>]` -> `work_context_archive_stage`
- `stage handoff [<workspace>] [<stage>]` -> `work_context_handoff_stage`
- `stage abandon [<workspace>] [<stage>]` -> `work_context_abandon_stage`
- `stage finish [<workspace>] [<stage>]` -> `work_context_finish_stage`
- `<workspace> [<stage>] unlink-issue <URL>` -> `work_context_unlink_issue`

Supported syntax:

- `help [command]`
- `create "title"`
- `list` or `<workspace> list`
- `workspace list <workspace>`
- `workspace rename <workspace> "title"`
- `workspace mode <workspace> <standard|startup>`
- `candidate create <workspace> "title" ["message"] [strategy <exact|shared_foundation|integration>] [stages <stage>...]`
- `candidate capture <workspace> <candidateId> paths <path>...`
- `candidate capture <workspace> <candidateId> patch "patch"`
- `candidate preview <workspace> <candidateId>`
- `candidate show <workspace> <candidateId>`
- `candidate list <workspace>`
- `candidate ready <workspace> <candidateId>`
- `candidate commit <workspace> <candidateId> ["message"]`
- `candidate discard <workspace> <candidateId>`
- `delivery read <workspace> [<environment>] [range <from> <to>]`
- `delivery mark <workspace> <environment> <commit> DELIVERY_CONFIRMED`
- `workspace finish <workspace>`
- `workspace reopen <workspace> "reason"`
- `resume <workspace> <stage>`
- `stage force-close <workspace> <stage> <sessionId> "reason" FORCE_CLOSE`
- `stage add [<workspace>] "title" ["prompt"] [execution <routine|implementation|architecture|security|review>] [review <routine|implementation|architecture|security|review>]`
- `stage profiles [<workspace>] [<stage>] [execution <routine|implementation|architecture|security|review|clear>] [review <routine|implementation|architecture|security|review|clear>]`
- `stage reopen <workspace> <stage> "reason"`
- `stage restore <workspace> <stage> "reason"`
- `stage rename [<workspace>] [<stage>] "title"`
- `stage update [<workspace>] [<stage>] "description"`
- `stage update-prompt [<workspace>] [<stage>] "prompt"`
- `stage update-result [<workspace>] [<stage>] "result"`
- `stage execution read [<workspace>] [<stage>]`
- `stage execution replace [<workspace>] [<stage>] <expectedRevision> "state JSON"`
- `stage execution update [<workspace>] [<stage>] <expectedRevision> "changes JSON"`
- `stage archive [<workspace>] [<stage>]`
- `stage handoff [<workspace>] [<stage>]`
- `stage abandon [<workspace>] [<stage>]`
- `stage finish [<workspace>] [<stage>]`
- `<workspace> [<stage>] link-issue <URL>`
- `<workspace> [<stage>] unlink-issue <URL>`
- `session rename "summary"`
- `stage handoff [<workspace>] <stage>`
- `stage abandon [<workspace>] <stage>`
- `stage finish [<workspace>] <stage>` automatically reviews the Knowledge Base (`auto` by default)
- stage lifecycle commands may omit stage, using the current OpenCode session; with one numeric identifier, six digits mean workspace and one or two digits mean stage
- explicit workspace and stage positions accept canonical padded IDs or unpadded positive integers (`1..999999` and `1..99`); results and generated commands remain padded
- zero, signs, decimals, whitespace, overlong values, and other non-digit identifier forms are invalid; a lone unpadded workspace ID is not reinterpreted under the one-identifier rule
- `stage update-result` replaces an existing result and does not create a result for an unfinished stage
- capability profiles are portable stage intent only; `stage profiles` must provide execution, review, or both, omitted fields remain unchanged, and `clear` removes that field
- `capability_profiles.mode` in `.work-context/config.yaml` is `advisory` by default or `off`; off mode preserves metadata but omits profile presentation, resolution, and mapping warnings
- advisory mappings are read only from `.work-context/local/capability-profiles.json` as `{ "schema": 1, "mappings": { "implementation": "opaque-user-target" } }`; invalid entries are ignored with bounded warnings and missing mappings report `No mapping configured; continuing with the current model.`
- capability recommendations never select a model or agent, create a replacement session, block resume, or persist mapping targets in tracked workspace data
- stage execution state has `scope`, `completed`, `remaining`, `decisions`, `blockers`, and `verification` string-array sections; `replace` accepts the complete state object, while `update` accepts an object with `add` and/or `remove` section objects
- read stage execution state first and pass its revision as `expectedRevision`; absent legacy state has revision `0`, and a stale mutation returns `EXECUTION_REVISION_CONFLICT` without changing newer state
- execution mutations require the active stage session, trim and deduplicate items, reject overlap between `completed` and `remaining`, and enforce bounded item counts, lengths, and serialized size
- update execution state after meaningful scope changes, decisions, substantial work, blockers, or verification changes and before handoff; do not update it for every trivial edit or tool call
- `resume` returns `resume.presentation` and `resume.context`; before doing any work, report a concise human-oriented summary in the user's language with the stage title, a plain-language Goal, previous progress when useful, and the immediate next action
- when the saved prompt contains several clear deliverables, add `In this stage we will` with 2-5 short outcome-oriented bullets derived only from the prompt, previous result, and workspace knowledge; do not invent scope, and omit this block for a small stage
- do not expose raw workspace/stage/session identifiers, ordinals, `ok` flags, or absent error codes in the user-facing resume summary
- `resume.context.workspace_knowledge` contains every active durable knowledge entry for the workspace; treat it as established shared context, and do not repeat earlier analysis unless an entry is incomplete, contradicted, or needs verification
- when stage execution state exists, `resume.context.execution_state` is the current stage-local operational checkpoint; continue from it without rewriting the original prompt, and never copy it automatically into workspace knowledge or unrelated stages
- Planning-stage resume may include `resume.context.delivery_context`, a bounded workspace-level summary of committed candidates and environment checkpoints; it is release coordination context, not stage ownership
- when the user asks how to deploy from Planning, inspect the exact commit range and the repository's own deployment documentation, scripts, infrastructure, migrations, container definitions, configuration examples, and CI; produce ordered prerequisites, deployment, verification, rollback, and unresolved blockers instead of assuming that push or one generic command is sufficient
- delivery planning must never persist secret values; mention only required secret or configuration names, ask one focused question when environment or baseline is ambiguous, and never mark delivery merely because commit, push, or CI succeeded
- an associated OpenCode session resumed in a `startup` workspace receives `resume.context.workflow_policy`; follow it as active agent policy: a shared dirty worktree and concurrent stages are expected, stages do not own files or commits, and ready work should be captured promptly into an explicit candidate; once a coherent commit intent exists, create or refresh its draft candidate before switching stages or handing off; on resume inspect `resume.context.pending_candidates` before creating a duplicate or another commit boundary; prefer an `exact` candidate when safely separable, use `shared_foundation` when several stages use one coherent change, and use `integration` when intertwined changes form one reviewable and testable result; mixed provenance and complete files containing unrelated stage work are not reasons to require prior commits or stop; stop only for a concrete patch conflict, an incoherent candidate boundary, or failed required verification
- standard-mode and unassociated core sessions do not receive startup policy; retain the existing conservative worktree behavior there
- after presenting the summary, continue work immediately when `resume.next_action` is `start_work`; do not ask for generic confirmation
- a stage may require confirmation only with an exact standalone `RESUME_CONFIRMATION: required` line in its saved prompt; when `resume.next_action` is `await_confirmation`, present the summary and wait before inspecting or modifying application code
- `create` enters the new workspace's Planning stage in the current OpenCode session only when that session is not yet in a workspace; otherwise it only creates the workspace and its planning session
- `stage add` creates a stage; when the current OpenCode session is not associated with a workspace, it also enters the new stage in that session
- when `stage add` is invoked from an associated session, it only creates a planned stage and leaves the current stage unchanged; enter it later with an explicit `resume <workspace> <stage>` in a separate OpenCode session
- `resume` returns `resume.next_action` and `resume.instruction`; begin or continue implementation when the stage prompt is non-empty unless it explicitly requires confirmation or contains an unresolved decision that genuinely blocks progress
- when `resume.next_action` is `ask_questions`, do not inspect or modify application code and ask the user focused questions needed to make the prompt actionable
- before `stage finish`, review durable findings: add new knowledge, update changed knowledge, supersede obsolete knowledge, or explicitly use `knowledgeReview=none` when the stage produced no durable findings; use `knowledgeReview=added` after ledger changes
- invoke `stage finish` only when the user explicitly requests that lifecycle command; do not infer the request from completed work, tests, or a final report
- automatic completion is allowed only when the current workspace's Planning-stage prompt contains an exact standalone line `AUTO_STAGE_FINISH: allowed`; otherwise leave the stage in progress and report that the work is ready for the user's lifecycle decision
- `stage finish` closes and completes only the current stage session; it never starts, resumes, or binds the same OpenCode session to a downstream stage
- `stage finish` always validates the Knowledge Base and returns total and active entry counts plus downstream unfinished stages for informational prompt review; do not begin a downstream stage until the user explicitly resumes it in a separate OpenCode session
- execution checklist state never finishes a stage; explicit `stage finish` reports remaining items, blockers, and pending verification as warnings and preserves the final execution record for history
- `stage reopen <workspace> <stage> "reason"` applies only to a completed stage, preserves its result and completion history, records the reason, changes it to `in_progress`, and does not start a session or affect downstream stages; use an explicit separate-session `resume` to work on it again
- `stage restore <workspace> <stage> "reason"` applies only to an archived stage and restores its saved pre-archive status. New archives preserve that status; legacy archives restore to `in_progress`. It records the reason, preserves stage content and results, does not start a session, and requires explicit separate-session `resume` when restored to `planned` or `in_progress`.
- `workspace reopen <workspace> "reason"` applies only to a completed workspace, changes it to `in_progress`, and records durable recovery history. Cancelled workspaces cannot be reopened.
- candidate operations require `startup` workflow mode and store metadata and patch payloads only under `.work-context/local/`; create accepts an optional strategy and related stages, which are normalized references for traceability only and never ownership or lifecycle; active candidates explicitly related to the resumed stage appear as bounded metadata in `resume.context.pending_candidates` and in expanded sidebar details; capture requires exactly one explicit list of complete paths or one Git unified patch and never infers stage ownership; commit requires a ready candidate, uses its stored message unless a non-empty override is supplied, serializes Git publication, bypasses hooks and signing, and never uses the ordinary Git index
- delivery operations are mode-neutral local operational state and never execute deployment; `delivery read` without a range returns metadata only, exact Git inspection requires both immutable `from` and `to` hashes, and `delivery mark` requires the exact `DELIVERY_CONFIRMED` token only after the user confirms successful delivery to that environment
- `knowledge list|add|update|supersede <workspace> ...`

Arguments: $ARGUMENTS
