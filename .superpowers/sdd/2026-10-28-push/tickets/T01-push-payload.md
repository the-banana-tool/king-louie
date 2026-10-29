---
id: T01
title: Push payload, kinds and the FCM sender
status: done
merged: 96ea2586
blocked_by: []
---
## Goal
The FCM message carries the new kinds and `c`, `ttl` per kind, and drops a token on `SENDER_ID_MISMATCH`; APNs is byte for byte unchanged.

## Spec sections
§6.5, §7.1, §7.3 last paragraph (drop on rejection, C-11), C-2, C-7.

## Files
- `src/frontdoor/push/text.js` (KINDS gains `session_ended`, `session_paused`, `test` with titles "Session ended", "Session paused", "Test"; an `FCM_ONLY_KINDS` list)
- `src/frontdoor/push/fcm.js` (`c` when the payload has a count 2..999; ttl: seconds to `expires_at`, else 3600 for `session_ended`, else 300; `403` + `SENDER_ID_MISMATCH` -> `dropToken`; `400` never drops)
- `src/frontdoor/push/index.js` only as needed to pass `count` through `notify` and to refuse the new kinds for non-fcm devices (keep it small: T02 rewrites the pusher next)
- `src/frontdoor/node-methods.js`: `message.submit`'s kind check uses its own list (today's kinds), not `KINDS`
- `tests/frontdoor-push.test.js`

## Acceptance
- New kinds and `c` in the FCM data against the local FCM server; ttl per kind; `SENDER_ID_MISMATCH` drops, `400` does not.
- An `apns` device's push for today's kinds is byte for byte today's; a new kind for an `apns` device is not sent.
- `message.submit` with `push.kind: 'session_ended'` is still `bad_push`.
- No token in any log line (capture the logger).
- `node --test tests/frontdoor-push.test.js tests/frontdoor-relay.test.js` pass.

## Notes
`c` and the new kinds reach `fcm` devices only (C-2).
