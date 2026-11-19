# Durable Knowledge

## KC-0001: Delivery diagnostic trust and safety boundary

- Kind: contract
- Status: active
- Created: 2026-11-17T19:15:48.258Z
- Updated: 2026-11-17T19:15:48.258Z
- Sources: ["docs/adr/0008-workspace-delivery-context.md","src/delivery.js","src/candidates.js","user-approved architecture"]

`delivery.explain` and `delivery.doctor` are read-only versioned diagnostic contracts. The package does not define or interpret project-specific release policy: an external repository planner supplies findings, while Work Context validates their shape and enriches them with immutable Git evidence and Work Context traceability. Neither operation executes remediation, deployment, candidate mutation, or diagnostic persistence. Inputs and outputs must exclude raw patches, file contents, environment values, commands, credentials, tokens, and secret values. Candidate IDs and related stages are traceability only, never ownership; direct commits are valid and must be represented explicitly. Standard-mode workspaces receive Git evidence but report candidate metadata capability as unavailable.

## KC-0002: Explain contract, limits, and completeness

- Kind: decision
- Status: active
- Created: 2026-11-17T19:15:59.866Z
- Updated: 2026-11-17T19:15:59.866Z
- Sources: ["src/git-candidates.js","src/errors.js","test/delivery.test.js","user-approved contract"]

The initial explain response is `contract_version: "1.0"`, `operation: "delivery.explain"`; v1 uses producer-selected versioning with strict major compatibility and additive minor evolution, so consumers reject unknown majors and tolerate known-major additive fields. Preserve full lowercase 40-64 hex commit hashes and existing Git/range errors. Defaults are 500 commits, 500 final paths, 4 MiB aggregate bounded Git output, and 50 provenance commits per path. Planning limits for implementation are: 200 findings, 100 affected paths per finding, 20 remediation IDs per finding, 128 ASCII characters per stable ID, 4096 UTF-8 bytes per input path, 200 UTF-8 bytes per sanitized commit subject, 100 secret path patterns of 256 characters each, 1 MiB serialized findings input, and 4 MiB serialized diagnostic output. Stable IDs use lowercase ASCII segments matching `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`. Count-limit truncation sets `complete=false`; every recommendation field is then absent. A hard byte-cap violation returns `DELIVERY_DIAGNOSTIC_TOO_LARGE`; malformed findings return `DELIVERY_INVALID_FINDINGS`. The minimal success envelope contains immutable_range, limits, summary, paths, findings, candidate_traceability, candidate_slice, and redactions.

## KC-0003: Deterministic provenance and path redaction

- Kind: decision
- Status: active
- Created: 2026-11-17T19:16:09.499Z
- Updated: 2026-11-17T19:16:09.499Z
- Sources: ["src/git-candidates.js","src/storage.js","user planning requirements"]

Detailed Git inspection must use the explicit immutable ancestor range only, with literal path handling and deterministic flags disabling external diff/text conversion/color. Rename and copy detection use explicit 50% similarity (`--find-renames=50%`, `--find-copies=50%`) without `--find-copies-harder`; each commit is compared deterministically to its first parent, and final-path provenance is distinct from rename lineage. Subjects are single-line UTF-8 text with controls and line separators replaced, whitespace collapsed, and byte-bounded without splitting a code point. Optional `delivery.secret_path_patterns` is a strict additive config field, not a policy DSL: repository-relative slash-separated glob patterns, `*` within one segment and `**` only as a whole segment; reject absolute paths, empty/dot/dot-dot segments, backslashes, NUL, negation, character classes, braces, and unsupported escapes. Redacted paths use response-local opaque tokens such as `<redacted:path-0001>` assigned in canonical sorted order; tokens are correlatable only within one response and reveal neither path hashes nor path content.

## KC-0004: Runtime doctor evidence and protocol scope

- Kind: decision
- Status: active
- Created: 2026-11-17T19:16:32.869Z
- Updated: 2026-11-17T19:16:32.869Z
- Sources: ["plugin/work-context.js","plugin/server.js","bin/opencode-work-context.js","commands/wc.md","OpenCode v1.19.5 plugin/index.ts and plugin/loader.ts","@opencode-ai/plugin PluginInput 1.14.19"]

Keep the public operation delivery-scoped as `delivery.doctor`, because its fail-fast gate protects the generated `/wc delivery` protocol and the explain/doctor tool contract; its evidence may diagnose package-wide installation facts without becoming a general system doctor. OpenCode 1.19.5 resolves a concrete plugin target, entry URL, and package manifest internally, but the public PluginInput and tool execution context do not expose the loaded module URL or version to the plugin. Therefore current runtime origin/version evidence from `import.meta.url` and the package's own manifest is `self_reported`; declared project plugin specs and installed manifests are separate evidence; `host_attested` is explicitly `unavailable` until the host provides an authoritative value. Never infer loaded identity from config alone. The generated command carries a literal protocol major/minor/schema marker and a SHA-256 hash of a canonical non-self-referential protocol descriptor. Init, activate, and sync-command must project identical marker/hash bytes. Command-vs-loaded protocol-major mismatch fails with `DELIVERY_COMMAND_PROTOCOL_MISMATCH`; all other hash/version/origin mismatches are actionable findings and doctor never repairs automatically. Repair guidance distinguishes pinned local installs (`npx --yes opencode-work-context@<version> init --force`) from managed activation (`opencode plugin opencode-work-context@<version> --force`, plus per-project `activate --force` when the command contract changed) and requires restart.

## KC-0005: Conservative candidate-slice recommendations

- Kind: decision
- Status: active
- Created: 2026-11-17T19:16:41.515Z
- Updated: 2026-11-18T15:20:55.514Z
- Sources: ["src/delivery-slices.js","src/delivery.js","src/delivery-contracts.js","test/delivery-slices.test.js","test/delivery.test.js"]

Candidate-slice output is advisory only and is generated only for a complete diagnostic after path redaction. Every slice contains a strategy (`exact`, `shared_foundation`, or `integration`), deterministic confidence, bounded path/finding/rationale/candidate/commit references, and `requires_user_decision: true`. The implemented structural rules classify an isolated fully matched finding as `exact` with confidence 1, disjoint findings connected by shared bounded Git provenance as `shared_foundation` with confidence 0.8, and findings sharing matched paths as `integration` with confidence 0.6. Ambiguous, unmatched, weak, truncated, or incomplete evidence yields no speculative slice; an ambiguous finding also blocks recommendations for its matched paths. Candidate IDs are optional traceability references only: candidate strategy and related stages do not determine the recommendation or imply ownership. Direct commits remain explicit in candidate traceability and never create synthetic candidates. Ordering and references are canonical and deterministic, and redacted paths remain opaque in every slice.

## KC-0006: Sidebar attention count invariant

- Kind: contract
- Status: active
- Created: 2026-11-18T06:36:44.020Z
- Updated: 2026-11-18T06:36:44.020Z
- Sources: ["plugin/attention.js","plugin/stages-tui.js","src/stages-snapshot.js","test/stages-tui.test.js","user screenshot and report"]

The sidebar workspace Attention summary must equal the union of unique unread session attention represented by the currently visible, non-archived stage rows in the same rendered snapshot. Archived, cancelled/hidden where applicable, stale/unmapped, duplicate, and non-navigable session records must not inflate the header. Multiple unread sessions mapped to one visible stage may contribute multiple grouped signals, but the stage row and workspace header must derive from the same filtered evidence and agree. The `ready` wording in the reported symptom refers to the attention response-complete signal (`✓`), not commit-candidate ready status.

## KC-0007: Automatic capability and depth recommendations

- Kind: contract
- Status: active
- Created: 2026-11-18T06:46:21.403Z
- Updated: 2026-11-18T07:26:25.993Z
- Sources: ["user-approved capability recommendation design","src/capability-profiles.js","src/core.js","plugin/stages-tui.js","commands/wc.md"]

Stages carry an execution capability (`routine`, `implementation`, `architecture`, `security`, or `review`) separately from an execution depth (`light`, `standard`, or `deep`). User-local mappings resolve depth to an advisory model label, initially light -> Luna, standard -> Terra, and deep -> Sol; tracked workspace data never stores model/provider identity. When values are not explicitly supplied, the Planning agent must infer capability and depth from the stage title, description, prompt, dependencies, active workspace knowledge, and current execution state before persisting the stage. Persist whether classification is `inferred` or `explicit`; explicit assignments are never overwritten by ordinary refresh. `/wc stage profiles refresh <workspace> [<stage>]` refreshes missing and inferred recommendations for actionable stages, with an explicit include-explicit override, and applies validated classifications as one batch without starting stages or switching models. `/wc profiles setup|show|reset` provides question-driven local configuration so users need not edit YAML or JSON manually; setup can optionally refresh unfinished stages. Resume and read-only UI never infer or mutate. In advisory mode, expanded stage details show one compact line `<capability> · <depth> · <resolved model>` or `current model` when unmapped; off mode and unclassified stages omit it. Review profile metadata may remain optional but does not resolve or display a model and never controls separately configured subagents. Recommendations never automatically switch a model/agent, invoke a reviewer, start a session, or block lifecycle operations.
