# ADR-0005: Background attention notifications

- Status: Accepted
- Date: 2026-11-04
- Deciders: OpenCode

## Context

Linked OpenCode sessions can continue working after the user navigates away.
Persistent TUI attention markers make missed work discoverable, but they do not
alert a user who is focused elsewhere. Desktop delivery must not expose model or
tool content and must never make TUI event handling depend on an OS facility.

## Decision

The TUI attention controller owns notification delivery because it can identify
the foreground native session and already emits deduplicated changes only for
new background attention. Restored state, duplicate host events, and foreground
events do not request delivery.

A dependency-free notifier boundary supports platform adapters. The first
adapter supports Linux by invoking the fixed `notify-send` executable with an
argument array, no shell, and a short timeout. Desktop notifications are enabled
by default and may be disabled only with the validated boolean
`notifications.desktop` setting. There is no arbitrary executable or command
configuration.

The notifier receives an approved data object rather than a host event or raw
snapshot. It can render only workspace ID/title, stage ID/title, and a controlled
attention reason. Text is stripped of control characters and bounded before it
is passed to the operating system.

## Consequences

Linux systems need `notify-send` and a working desktop DBus session for desktop
delivery. Unsupported platforms, a missing binary, process or DBus failures,
nonzero exits, and timeouts silently retain the in-app attention marker. This
release does not support notification click-to-open behavior. Later macOS and
Windows adapters can implement the same notifier boundary without changing the
attention model.
