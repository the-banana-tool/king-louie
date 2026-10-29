---
id: T01
title: Bridge-file trust rule for a personal node
status: done
merged: f5d66043
blocked_by: []
---
## Goal
`checkBridgeFileTrust` on Windows reads owners once over four paths (config dir D,
bridge file F, D\node.yaml Y, D\..\data A) and trusts either the unchanged fleet rule
(D, F owned by SYSTEM/Administrators) or the new personal rule (D, F, Y, A all owned by
`me`, none a link, Y loads with `loadNodeConfig({ adminConfigDir: D })` and says
`hosting: 'personal'`). `readTrustedBridgeFile` returns `{ ok, record, hosting }`.
Export a pure helper (e.g. `judgePersonalPaths`) that T02's `detectPersonalNode` reuses
for D, Y, A without F, so the rule lives in one place.

## Spec sections
§5.1, §5.2 (first paragraph), §12 (a fleet node is never read through the personal rule), C-1.

## Files
- src/desktop-bridge/pairing.js
- tests/desktop-pairing.test.js

## Acceptance
§14 first bullet: personal trusted; node.yaml missing / `hosting: service` / invalid
key → untrusted; data dir another SID → untrusted; a link at any of four → untrusted;
empty `me` → untrusted; Admin-owned D and F trusted with no node.yaml; short inspector
reply → untrusted; exactly one inspector call with four paths; `readTrustedBridgeFile`
returns `hosting`; POSIX unchanged; the KL_TEST_MODE override unchanged and never enters
the personal rule. Messages as §5.1 words them. `node --test tests/desktop-pairing.test.js`.

## Notes
`loadNodeConfig` is in src/service/node-config.js; check its signature accepts
`adminConfigDir` (or the nearest equivalent) and record any deviation in the ledger.
