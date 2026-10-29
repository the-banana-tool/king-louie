---
id: T08
title: Node - lease endings and contact pauses queue push.notify
status: done
merged: 3f35f05e
blocked_by: []
---
## Goal
`LeaseManager` queues `session_ended` (lease that ran, `except_device` = the device whose signed revoke or resume-deny ended it) and `session_paused` (active -> suspended `no_contact`, to the granting device, `expires_at`) and sends them as `push.notify` over the relay link through a small in-memory queue.

## Spec sections
§6.1, §6.2 (node side), §6.3 node half, C-1, C-3, C-4.

## Files
- `src/gui/leases.js` (`lease.endedBy`; queue on `_end` when `grantedBy` set, after the ended status; queue on the `suspend` transition only)
- new `src/gui/push-queue.js` (send at once when connected, else on `connected`; drop entries older than 1 h; max 32, oldest out; an unknown-method answer logged once at `debug` per link and the queue dropped until next `connected`; `drain({ timeoutMs })` for T09)
- `src/approvals/relay-client.js` (`push.notify` in `F3_METHODS`, and whatever lets the node call it)
- `tests/gui-leases.test.js` (fake relay recording link calls), and a `tests/gui-push-queue.test.js` if cleaner

## Acceptance (spec §16 gui-leases bullet)
- Expiry pushes `session_ended` once, no `except_device`; revoke from device B gives `except_device` B; a resume deny likewise.
- Expired request and first-request deny push nothing; replayed revoke and `lease.list` push nothing more.
- Contact lapse pushes `session_paused` to the granting device only, once per transition; a takeover by another reason does not; an unattended take never pushes it.
- Queue sends on `connected`, drops >1 h entries, holds 32; unknown-method logged once.
- `node --test tests/gui-leases.test.js` (+ new file) pass; `tests/service-profile-graph.test.js` passes.
