---
id: T02
title: Relay pusher - dedupe, 10 s coalescing, hourly cap, push-status.json
status: open
blocked_by: [T01]
---
## Goal
Per fcm device: dedupe by `(node_id, kind, id)` with per-kind windows, a 10 s coalescing window carrying `c`, at most 60 pushes per device per hour, and a small `push-status.json`.

## Spec sections
§6.3, §6.4, §8 (the `push-status.json` part), §17 (timer unref'd; `stop()` sends or drops what a window holds, the code says which; status written at most once a minute), C-5, C-6, C-14.

## Files
- `src/frontdoor/push/index.js` (createPusher gains `now`/`timers` injection, `node_id` in the payload for the dedupe key, a `stop()`), maybe a new `src/frontdoor/push/gate.js` for the dedupe/coalesce/cap state
- `src/frontdoor/relay.js` (pass node ids, a status file path `<dataDir>/relay/push-status.json`, call `pusher.stop()` on relay stop)
- `src/frontdoor/node-methods.js` (pass `node_id` with each push), `src/frontdoor/notify.js` if it calls the pusher
- `tests/frontdoor-push.test.js`

## Acceptance
- Dedupe windows per kind on a fake clock (24 h session_ended, 2 min session_paused, 10 min the approval kinds); capped at 2,048 keys, oldest out.
- Coalescing: first at once, the rest after 10 s as one with `c` = number held and the newest held item's `k`, `rid`, `n`; a new window opens.
- Hourly cap 60 per device; one `warn` per device per hour past it.
- `apns` devices bypass dedupe/coalesce/cap entirely (today's behaviour).
- `push-status.json`: time and HTTP status of the last send and last failure, no token, no device id; written at most once a minute; written atomically.
- `node --test tests/frontdoor-push.test.js tests/frontdoor-relay.test.js tests/frontdoor-relay-external.test.js` pass.
