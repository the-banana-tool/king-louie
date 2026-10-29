---
id: T03
title: Relay link method push.notify
status: open
blocked_by: [T01]
---
## Goal
The relay accepts `push.notify` from a pinned node and pushes `session_ended` / `session_paused` to that node's active fcm devices, narrowed by `to_device` / `except_device`.

## Spec sections
§6.2 (relay side), §17 first item (where it lives: decided by `tests/service-profile-graph.test.js`).

## Files
- `src/frontdoor/node-methods.js` (register `push.notify` beside `message.submit`)
- new `tests/frontdoor-push-notify.test.js`

## Acceptance
- `bad_push` for: a kind other than the two; an `id` not a UUID v4; a device id not matching the registry's `DEVICE_ID_RE`; both `to_device` and `except_device` set; `expires_at` not `isTimestamp`.
- Targets: devices active on that node only, `to_device` narrows, `except_device` excludes, only `fcm` platform devices.
- Nothing is put in the mailbox; answers `{ ok: true }`.
- `node --test tests/frontdoor-push-notify.test.js tests/service-profile-graph.test.js tests/frontdoor-relay.test.js` pass.

## Notes
The node-side client allowlist (`src/approvals/relay-client.js` `F3_METHODS`) is T08's.
