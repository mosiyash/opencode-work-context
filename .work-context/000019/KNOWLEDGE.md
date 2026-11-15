# Durable Knowledge

## KC-0001: GitLab work item links require native URL support

- Kind: fact
- Status: active
- Created: 2026-11-15T06:37:59.015Z
- Updated: 2026-11-15T06:37:59.015Z
- Sources: ["src/core.js","src/storage.js","test/core.test.js","README.md"]

The linkIssue parser in src/core.js accepts GitLab URLs only in /-/issues/<iid> form. src/storage.js independently validates persisted GitLab links with the same path restriction, so both layers must be updated together. Preserve /-/work_items/<iid> URLs rather than rewriting them to issue URLs; these resources are compatible with issue-like identifiers for the existing title renderer.

## KC-0002: GitLab work-item support scope

- Kind: decision
- Status: active
- Created: 2026-11-15T06:40:59.515Z
- Updated: 2026-11-15T06:40:59.515Z
- Sources: ["GitLab Work Items documentation","GitLab Tasks documentation","src/core.js","src/storage.js","src/title.js"]

Support only project-scoped GitLab URLs in the form /<project>/-/work_items/<iid>, treating them as the existing GitLab tracker identity. This covers canonical URLs for Issue, Incident, Task, Ticket, Objective, Key Result, and configurable project work-item types without a schema change. Defer group-scoped work items and epics because the current project/iid model cannot distinguish a group scope, and do not accept merge requests, test cases, or other distinct resources as tracker issues. Existing URL-only deduplication may retain both issue and work-item aliases for one resource; address that separately only if needed.
