---
id: T12
title: Docs, CLAUDE.md, CONTEXT.md, PRIVACY.md; tracked-secrets test
status: done
merged: c050b5a0
blocked_by: [T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11]
---
## Goal
Every doc §14 lists, worded to what was built; and the C-15 test that fails when the Firebase app config, `local.properties` or any service-account key JSON is tracked.

## Spec sections
§10 (the runbook, into the install guide), §11 (PRIVACY.md lines), §14, C-15. Ledger R5, R7.

## Files
- `docs/protocol/approval-v1.md`, `docs/protocol/lease-v1.md`, `docs/fleet/front-door.md`, `docs/install-guide.md`, `mobile/android/local.properties.example`, `mobile/PRIVACY.md`, `CLAUDE.md` ("Approvals and relay" bullet), `CONTEXT.md` (Push entry)
- new `tests/tracked-secrets.test.js` over `git ls-files`
- `tests/docs-*.test.js` / `tests/examples.test.js` if any reads these docs

## Acceptance
- All values invented (`scanForPersonalValues` in `tests/helpers/example-denylist.js` on the new doc text passes).
- `node --test tests/tracked-secrets.test.js tests/examples.test.js` plus any doc test pass; vector checks still 49 and 55.
