---
id: T04
title: Push-token routes - DELETE, GET, no-op PUT
status: open
blocked_by: []
---
## Goal
`PUT /v1/push-token` writes only when changed; new `DELETE` (204, `setPush(id, null)`) and `GET` (`{ registered, sender }`, never the token), all `auth: 'read'`.

## Spec sections
§7.3 (relay routes), C-9. Ledger R1: spec 2 already put PUT on `read`.

## Files
- `src/frontdoor/routes.js` (the header comment's §8.4 exceptions list gains DELETE)
- `src/frontdoor/device-registry.js` (`setPush` returns whether it wrote; no write when unchanged)
- `tests/frontdoor-phone-routes.test.js` (`ROUTE_AUTH` gains the two routes), `tests/frontdoor-relay.test.js` if registry tests live there
- `tests/mobile-android-slim.test.js` / `tests/mobile-android-relay-keys.test.js` only if they enumerate `ROUTE_AUTH` and need the new rows

## Acceptance
- PUT with the read key and the device key; unchanged PUT does not rewrite `devices.json`.
- DELETE with either key -> 204 and the token gone.
- GET with and without a sender for the token's platform (`relay.pusher.senders`); `registered: false` when none; token never in the body.
- Covering tests pass.
