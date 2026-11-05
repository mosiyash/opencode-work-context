# ADR-0005: Background attention notifications

- Status: Accepted
- Date: 2026-11-04
- Updated: 2026-11-05
- Deciders: OpenCode

## Context

Linked OpenCode sessions can continue working after the user navigates away or
opens another project in an independent OpenCode process. Persistent project-local
attention markers make missed work discoverable, but the active process cannot
observe another project's host event or local TUI state. Delivery must not expose
model or tool content or depend on a terminal multiplexer or OS notification
facility.

## Decision

The TUI attention controller owns publication because it already emits
deduplicated changes only for new background attention. Independent instances
coordinate through a dependency-free channel under a validated private
`XDG_RUNTIME_DIR`. Each instance writes only its own atomic lease containing a
heartbeat and last activity time. OpenTUI focus and keyboard activity select the
newest live instance; no terminal-specific inspection is used.

Publishers write one immutable, bounded event file per attention change. Only
the active instance consumes events and displays them through the public
`api.ui.toast` API. Events use a strict versioned schema, controlled reasons,
bounded sanitized project/workspace/stage titles, short expiry, deduplication,
and capped retention. Files and directories are private to the current user and
are checked for ownership, type, symlinks, and size before reading. A process
crash leaves either no final event or one complete event that another active
instance can consume.

Project-local attention and acknowledgement remain authoritative. A toast in B
does not copy A's state, acknowledge A's marker, or attempt navigation to A's
server. Restored state and duplicate host events do not publish new events. If
the channel is unavailable, foreground detection falls back to renderer state.

A dependency-free notifier boundary remains as fallback when global publication
or the in-TUI toast API is unavailable. The Linux adapter invokes the fixed
`notify-send` executable with an argument array, no shell, and a short timeout.
Desktop fallback is enabled by default and may be disabled only with the
validated boolean `notifications.desktop` setting. There is no arbitrary
executable or command configuration.

The notifier receives an approved data object rather than a host event or raw
snapshot. It can render only workspace ID/title, stage ID/title, and a controlled
attention reason. Text is stripped of control characters and bounded before it
is passed to the operating system.

## Consequences

All participating OpenCode processes must load the TUI integration and share a
valid per-user runtime directory. Delivery is transient and at-least-once until
the active instance confirms the event; stale events expire after a bounded
interval. Unsupported runtime environments, malformed channel data, filesystem
failures, or missing toast APIs silently retain project-local attention and may
use desktop fallback. Linux systems need `notify-send` and a working desktop
DBus session only for that fallback. Cross-server navigation and notification
click-to-open remain unsupported.
