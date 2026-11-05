# Durable Knowledge

## KC-0001: Background attention product contract

- Kind: decision
- Status: active
- Created: 2026-11-03T19:17:38.629Z
- Updated: 2026-11-03T19:17:38.629Z
- Sources: ["Planning discussion for workspace 000012"]

Track every native OpenCode session linked to any Work Context workspace/stage. A linked background session becoming idle after work creates attention regardless of response duration. Questions, permission requests, and errors also create attention. Suppress OS notification for the currently visible session, but preserve background attention until that native session is opened. Never infer or change stage lifecycle from session attention. Deduplicate repeated events and do not expose prompts, tool output, secrets, or arbitrary response text in notifications.

## KC-0002: Attention architecture and OpenCode signals

- Kind: decision
- Status: active
- Created: 2026-11-03T19:17:58.202Z
- Updated: 2026-11-03T19:17:58.202Z
- Sources: ["@opencode-ai/plugin and SDK 1.18.21 public type inspection","plugin/stages-tui.js","plugin/stage-switcher.js","src/work-context-snapshot.js"]

Own attention tracking in the TUI plugin, not the server plugin, because TUI has api.route.current, navigation, indicators, toast, and lifecycle cleanup. Prefer session.idle as the whole-turn completion signal; use session.status for busy/idle/retry context and handle question.asked, permission.asked, session.error plus compatible v2 question/permission variants. Key attention by native OpenCode session ID and map it to all Work Context workspaces/stages through existing snapshots. Persist only bounded deduplication/acknowledgement data in .work-context/local/tui-state.json; do not modify canonical lifecycle metadata or sessions.jsonl.

## KC-0003: First-release notification scope

- Kind: decision
- Status: active
- Created: 2026-11-03T19:18:05.085Z
- Updated: 2026-11-03T19:18:05.085Z
- Sources: ["User decisions in workspace 000012 Planning"]

Implement Linux OS notifications first through notify-send, behind a portable dependency-free notifier boundary. Enable OS notifications by default when notify-send is available; absence or failure degrades silently to in-app attention indicators. Invoke fixed executables with argument arrays and no shell interpolation or arbitrary configured commands. Notification click-to-open is explicitly out of scope for the first release; attention sessions should instead be visibly marked and prioritized in Work Context switchers.

## KC-0004: Cross-project attention routing

- Kind: decision
- Status: active
- Created: 2026-11-05T16:07:14.836Z
- Updated: 2026-11-05T16:07:14.836Z
- Sources: ["plugin/global-attention.js","plugin/attention.js","docs/adr/0005-background-attention-notifications.md","test/global-attention.test.js"]

Independent OpenCode TUIs coordinate transient attention through a dependency-free per-user channel under a validated private XDG_RUNTIME_DIR. Each instance owns only its lease with heartbeat and last activity; OpenTUI focus and keyboard activity elect the active instance, while blur relinquishes ownership. Background attention is published as a bounded immutable versioned event file and atomically claimed by the active consumer, which displays api.ui.toast. Project-local attention remains authoritative and is not acknowledged or navigated from another server. Strict ownership/type/size/schema checks, sanitization, TTL/cap cleanup, stale lease/claim recovery, and desktop fallback isolate failures without tmux or daemon dependencies.
