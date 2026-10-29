---
id: T04
title: Every relay route's auth per the table; POST /v1/devices/read-key; read_jwk from enrollments
status: open
blocked_by: [T02, T03]
---
## Goal
Each phone route declares the key it takes per §8.4; the relay learns read
keys from every enrollment path and from the new read-key route, and forwards
the statement to the nodes.

## Spec sections
§8.4 (the table), §8.2 (the relay keeps `read_jwk` from `POST
/v1/enroll/{code_id}` once the node reports it done, `POST /v1/devices/enroll`,
the invite claim), §8.7 (relay side of `POST /v1/devices/read-key`: device key
for the first send, read key after; verify against the registered `jwk`,
`device_id` is the caller, active on a node; store; forward `device.read_key`
to every node where active; answer `{ nodes: [{ node_id, state }] }`), §8.9.

## Files
`src/frontdoor/routes.js`, `phone-routes.js`, `question-routes.js`,
`oauth/grant-routes.js`, `src/gui/relay-extension.js` (lease routes incl. the
watch), node-hub forwarding as needed. Tests:
`tests/frontdoor-phone-routes.test.js`, `tests/frontdoor-relay.test.js` (one
table in the test, iterated against `phoneApi.routes()`).

## Acceptance
- The route-table test equals §8.4 exactly (T12 copies the table into the
  Android slim test).
- `read_jwk` set by each enrollment path; read-key route: wrong signer, caller
  mismatch, inactive device, forwarding, newer replaces, older does not; a
  second send with the read key accepted.
