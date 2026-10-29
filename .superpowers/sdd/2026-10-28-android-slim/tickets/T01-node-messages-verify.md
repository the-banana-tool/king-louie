---
id: T01
title: Node messages and the shared device check accept a read key
status: open
blocked_by: []
---
## Goal
The message layer knows the read key: `device.read_key` in enrollments, the
`kl.device.read_key` statement, the `KL-PHONE-READ-V1` auth string, and the
`allowReadKey` option on the one shared device-envelope check.

## Spec sections
§8.1 (fingerprint rule `r-…`), §8.2 (the `device` member and its shape rules),
§8.3 (the read string), §8.6, §8.7 (statement shape), §8.9 bullets 1 and 3.

## Files
- `src/approvals/messages.js`: `isDevice` accepts exactly the four keys of
  today or exactly those five (`read_key` a P-256 JWK on the curve whose point
  differs from `public_key`'s); `VALIDATORS['kl.device.read_key']` (exact keys,
  `expires_at` <= `created_at` + 7 days, nonce b64url of 32 bytes);
  `phoneAuthString(..., { key })` giving `KL-PHONE-READ-V1` for `read` and
  `KL-PHONE-V1` otherwise; a `readKeyFingerprint(jwk)` helper (`r-` plus the
  first 16 base32 characters of SHA-256 over 0x04||x||y, groups of four, the
  device-id rule with another prefix).
- `src/approvals/verify-device.js`: `allowReadKey` (default false); step 6
  tries `public_key`, then `read_key` only when allowed and present; the result
  carries `key: 'device' | 'read'`.
- Tests: `tests/approvals-messages.test.js`, `tests/approvals-protocol.test.js`
  or a new `tests/approvals-read-key.test.js`.

## Acceptance
- `device` with and without `read_key`; equal keys, off-curve points, extra
  keys are `malformed`.
- `kl.device.read_key` shape and its 7-day window.
- `phoneAuthString` for both kinds; the prefixes differ.
- `verifyDeviceEnvelope`: a read-key signature is `bad_signature` by default,
  accepted with `allowReadKey` when the record has `read_key`, refused when it
  has none; a revoked device's read key is `revoked_device`; the result's `key`.
- `node --test tests/approvals-*.test.js` passes.

## Notes
Additive only: records and enrollments without `read_key` (iOS) behave as before.
