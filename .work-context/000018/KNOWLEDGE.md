# Durable Knowledge

## KC-0001: Archived-stage attention should be excluded from workspace markers

- Kind: decision
- Status: active
- Created: 2026-11-13T19:54:50.096Z
- Updated: 2026-11-13T19:54:50.096Z
- Sources: ["src/stages-snapshot.js","src/work-context-snapshot.js","plugin/attention.js","plugin/stages-tui.js"]

The stages sidebar intentionally excludes archived stages from its visible list. However, the work-context snapshot retains all session records, and attention aggregation currently evaluates every linked session. A session belonging only to an archived stage can therefore set the workspace-level [ATTN] marker even though no visible stage explains it. Treat archived-stage attention as irrelevant to visible workspace and stage markers; retain archival history and restore behavior unchanged.
