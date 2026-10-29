---
id: T05
title: Lease watches verify against either key; audit key; the refusal sweep
status: done (merge 68bb365f)
blocked_by: [T01, T02]
---
## Goal
Only `verifyLeaseWatch` passes `allowReadKey: true`; contact is otherwise
unchanged; the `lease.watch` audit entry adds `key`. A sweep test proves that
no other phone-signed message verifies with a read key.

## Spec sections
§4 (anti-goal), §8.5, §8.6, §16 (gui-leases bullet, refusal sweep).

## Files
`src/gui/lease-protocol.js`, `src/gui/leases.js`; tests
`tests/gui-leases.test.js` and a new `tests/read-key-refusal-sweep.test.js`
(every phone-signed type the node and front door accept: approval response,
lease grant, revoke, resume grant, question answer (`mobile-app-channel.js`),
signed executor approvals (`cases/executors/signed.js`), enroll and revoke
staging, `kl.device.read_key`, the front door's `verifyPhoneEnvelope`
client-grant messages: each `bad_signature`; the watch accepted).

## Acceptance
A read-signed watch from the granting device is contact; from another device,
frames only; a record without `read_key` gives `bad_signature`; read-signed
grant, revoke and resume grant refused; the audit entry's `key`.
