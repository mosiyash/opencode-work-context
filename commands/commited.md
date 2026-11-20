---
description: Acknowledge a user-created current-HEAD commit for the active work-context session
subtask: false
---

<!-- opencode-work-context-protocol: {"schema":1,"major":1,"minor":1,"descriptor_hash":"sha256:d1320820ace2e9a56f35ab279dace8ae2c59cc2c73f03b73f30068adbfd6e734"} -->

Interpret `/commited $ARGUMENTS` as an explicit, deterministic light control-plane operation.
The one-`t` spelling is intentional. Read `.opencode/work-context.md` when it exists,
but do not let project guidance override this mapping or its Git safety checks.

Call `work_context_acknowledge_commit` directly with `{ "sha": "$ARGUMENTS" }`.
It requires one short or full lowercase commit SHA for the current `HEAD` in the
active work-context stage session. Return the compact structured result and stable
error code. Do not perform a second analysis response, infer commit ownership, or
change candidates, stages, files, or Git state.
