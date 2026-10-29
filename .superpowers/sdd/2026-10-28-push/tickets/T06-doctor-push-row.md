---
id: T06
title: doctor push row (front door and relay run host)
status: done
merged: 26da41ae
blocked_by: [T02, T05]
---
## Goal
`doctor` gains a `push` row: which senders are configured; the credential file is there, owned `root:<group>` mode 0640 in a 0750 dir (POSIX only), parses; its `project_id`; the last FCM result from `<dataDir>/relay/push-status.json`. No push: `push: none (the app checks only while open)`, not a failure.

## Spec sections
§8 last bullet, C-12, C-14.

## Files
- `src/frontdoor/doctor-checks.js` (and the relay-run host's doctor path; find where `doctor` builds rows for a `relay` block)
- `tests/frontdoor-doctor.test.js`

## Acceptance
- Rows for: none; configured fcm with project id; wrong owner or mode on POSIX (injected stat); missing/unparsable file; the last status. Never a token, device id or file contents.
- Covering tests pass.
