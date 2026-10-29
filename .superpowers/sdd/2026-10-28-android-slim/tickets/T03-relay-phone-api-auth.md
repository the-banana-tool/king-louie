---
id: T03
title: Relay authenticates read-signed requests
status: in-progress
blocked_by: [T01]
---
## Goal
`phone-api.js` verifies `X-KL-Key: read` requests against the device's
`read_jwk`; routes declare `auth: 'read'` or `'device'`; handlers get `ctx.key`.

## Spec sections
§8.3, §8.2 (relay device record `read_jwk`), §8.9 (phone-api and
device-registry bullets).

## Files
- `src/frontdoor/phone-api.js`: `X-KL-Key` (`read`, `device`, or absent =
  device), the read string through `phoneAuthString`, the `read` auth kind,
  `ctx.key`, refusals `403 read_key_not_allowed` (a read signature on a
  `device` route), `401 unknown_read_key` (no `read_jwk`), `401 bad_signature`.
  One replay cache and one rate bucket across both keys.
- `src/frontdoor/device-registry.js`: `read_jwk` on device records,
  `setReadKey(deviceId, jwk, createdAt)` (a newer `created_at` replaces an
  older one, an older is ignored), persisted.
- Tests: `tests/frontdoor-phone-api.test.js`, the device-registry tests.

## Acceptance
§16's first bullet: read string and header; a read request accepted on a
`read` route; 403 on a `device` route; 401 `unknown_read_key`; 401
`bad_signature` for a read signature checked against the device key and the
reverse; one replay cache and one rate bucket across both keys.

## Notes
Do not change route declarations in other files (T04). A `device` route keeps
accepting a device-key request exactly as today.
