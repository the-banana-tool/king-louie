---
id: T07
title: king-louie-service relay push-test
status: open
blocked_by: [T01, T05]
---
## Goal
`king-louie-service relay push-test [--device <device-id>]`: reads `relay.push` and `<dataDir>/relay/devices.json` read-only, sends one `test` push (random `rid`, `n` = the relay's node name) through `createFcmSender` to each device with an fcm token or the named one, prints id, name and `sent` or the HTTP status; never a token.

## Spec sections
§9, C-14, §14 last bullet (egress inventory only if its walk sees the new code).

## Files
- `src/service/commands/relay.js` (+ CLI usage/arg parsing in `src/service/cli.js` if subcommands are listed there)
- `tests/service-cli-relay.test.js`
- `tests/fixtures/egress-inventory.json` only if `tests/egress-inventory.test.js` fails

## Acceptance
- Against the local FCM server: all fcm devices; a named device; an unknown device id refused (non-zero exit); no push configured says so; no token printed (assert on captured output).
- Runs as root/admin only (follow how other relay subcommands check), with the service running or not.
- Covering tests pass, plus `tests/egress-inventory.test.js`.
