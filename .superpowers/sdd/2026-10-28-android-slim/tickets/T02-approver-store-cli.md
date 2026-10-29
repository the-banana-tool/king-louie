---
id: T02
title: Approver records keep a read key; kl.device.read_key staged and applied; node method device.read_key
status: done (merge 8814398e)
blocked_by: [T01]
---
## Goal
The node stores a device's read key, accepts the device-signed statement that
adds one, and the administrator's commands show the read key's fingerprint
before they ask.

## Spec sections
§8.2 (approver records, `checkApproverRecord`, test keys), §8.7 (node side:
checks, `read-key-pending-apply`, `device apply`, `stale`, `from_the_future`),
§8.9 bullets 2, 4 and the `src/service/commands/` bullet.

## Files
- `src/approvals/approver-store.js` (and `approver-admin.js` where staging
  lives): `read_key` in records; the test-key refusal applies to it unless the
  store allows test keys; console and signed enrollments keep `device.read_key`;
  staging (`read-key-pending-apply`) and applying `kl.device.read_key`.
- `src/approvals/relay-client.js`, `src/approvals/service-wiring.js`: the
  `device.read_key` node method beside `device.enroll` (checked like a relayed
  revoke: shape, signer an active approver whose `public_key` verifies it,
  `device_id` equals signer, `from_the_future` beyond 5 minutes, expiry, `stale`;
  staged; answers a state).
- `src/service/commands/` (`enroll-device`, `device apply`, `device list`):
  "with a read key r-abcd efgh ijkl mnop" beside the device fingerprint before
  asking; `device apply` shows a staged read-key statement and asks `[y/N]`.
- Tests: the approver-store tests, `tests/service-cli-devices.test.js`, the
  relay-client tests.

## Acceptance
- Records with and without `read_key`; malformed or equal to `public_key`
  refused; a published test key as read key refused unless allowed.
- Statement checks as above; `stale` when older than the record's current read
  key; `device apply` writes it after `y`, nothing after `n`.
- Enrollments carrying `read_key` keep it.
- CLI output names the read key's fingerprint and still asks.
