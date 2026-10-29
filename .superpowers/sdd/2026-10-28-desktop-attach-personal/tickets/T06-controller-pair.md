---
id: T06
title: Controller one-click pairing, personal unpair, node status
status: done
merged: 192fe4cb16b424e4f5e885d56de4c913ea3b3344
blocked_by: [T01, T02]
---
## Goal
In `createDesktopController` (new dep `nodeRunner`, defaulting to T02's module):
- `status()` adds `node` (§11; null for a fleet pairing) and, in `pendingPair`,
  `personal`, `stage` (`command`, `starting`, `restart-needed`, `confirming`) and
  `error`; the unpaired view makes one inspector call that answers both the bridge
  read and "is there a personal node here" (C-1).
- `pairStart` runs §6.2 when the local read says personal: key + pending pair as now;
  CLI `desktop pair <request> --yes --json --data-dir A` (120 s); a refusal ends with
  its code and message, the pending pair kept; trusted read with hosting personal and
  the CLI's nodeId else PAIR_SERVICE_CHANGED; bring the bridge up (no node → run the
  task; node up and `bridgeTurnedOn` → stage `restart-needed`, nothing restarted; node
  up and bridge already on → nothing); wait for the bridge (the §7.3 wait; share code
  with T07 by putting the wait in a helper T07 reuses); then the existing
  `pairConfirm({ nodeId })` unchanged. New `pairRestartConfirm({ confirmed: true })`.
- The pairing record gains `service.hosting` ('personal' or absent) and `service.dataDir`.
- `unpair` under personal runs `desktop unpair <id> --data-dir A` after forgetting the
  pairing; `pendingServiceCommand` kept only when that fails.
- `desktop:statusChanged` (notify) on each stage change. Fleet flow unchanged.

## Spec sections
§6.2, §6.4, §11 (status, pairStart, pairConfirm, unpair, statusChanged), C-5 to C-8.

## Files
- src/ipc/desktop-controller.js
- tests/desktop-controller.test.js

## Acceptance
§14 controller bullet, the pairing half: one-click pair end to end (CLI JSON → trusted
read → /Run → handshake → paired, `service.hosting` stored); CLI refusal kept on the
pending pair; nodeId mismatch → PAIR_SERVICE_CHANGED; node running with bridgeTurnedOn
→ restart-needed and nothing restarted before pairRestartConfirm; bridge already on →
no restart; Unpair runs `desktop unpair`; a fleet pairing never touches the runner.
