---
id: T07
title: Start the node at attached launch, Start/Restart, Install from the pane
status: open
blocked_by: [T06]
---
## Goal
- `controller.startAttached()` (§7.2): once per launch; when the pairing says personal,
  `detectPersonalNode()` agrees for the recorded data dir and no node runs, query the
  task and run it when registered, enabled and the owner's; then connect as now. Fleet
  (or personal where step 1 does not apply) connects exactly as today.
- The §7.3 wait: up to 60 s, `retryNow()` every 3 s, early stop on connect, on a
  `service failed to start` log line after the run (NODE_START_FAILED), on a fatal
  bridge code; at 60 s NODE_START_TIMEOUT and view `attached-disconnected`. The 60 s
  timer is ref'd only while a start is pending, cleared on connect and on
  shutdown/dispose. The client's own backoff carries on underneath (no second loop).
- View `attached-starting`; `node.startError`; the task state for the §7.4 rows.
- `nodeStart({ restart })` (on a press only), `nodeInstallPreview()` (CLI `install
  --personal --dry-run --data-dir A`, returns lines through `shown`), `nodeInstall({
  confirmed: true })` (refuses without it; `install --personal --yes --data-dir A`).
- A drop after connect never runs the task (C-13).
- `startAttachedHost`'s `start()` calls `controller.startAttached()`.

## Spec sections
§7.2, §7.3, §7.4 (codes; wording is T09), §8 (desktop side), §11 new methods, C-12, C-13.

## Files
- src/ipc/desktop-controller.js
- src/ipc/attached-host.js
- tests/desktop-controller.test.js
- tests/attached-host.test.js

## Acceptance
§14 controller bullet, the start half, and the attached-host bullet. Fake clock, and a
ref'd timer kept alive across awaits (CLAUDE.md Testing).
