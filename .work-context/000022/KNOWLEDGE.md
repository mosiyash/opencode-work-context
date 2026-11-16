# Durable Knowledge

## KC-0001: Commit boundaries are independent of stage boundaries

- Kind: decision
- Status: active
- Created: 2026-11-16T17:38:59.671Z
- Updated: 2026-11-16T17:38:59.671Z
- Sources: ["docs/adr/0006-startup-commit-candidate-workflow.md","src/core.js","src/candidates.js","src/git-candidates.js"]

In startup mode, a commit represents a coherent repository change rather than the output of exactly one stage. Stages, commit candidates, and commits have a many-to-many relationship. Mixed provenance is not a blocker. Prefer, in order: an exact candidate for a separable patch; a shared foundation candidate used by several stages; an integration candidate when already-intertwined changes cannot be split safely. Related stage metadata is traceability only and must never imply file or hunk ownership. Publication must stop only for a concrete patch conflict, an incoherent candidate, or failed required verification.
