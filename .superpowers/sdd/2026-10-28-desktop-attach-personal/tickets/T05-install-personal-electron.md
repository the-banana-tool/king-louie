---
id: T05
title: install --personal under Electron as Node, and no second start
status: done
merged: 105d0f99
blocked_by: []
---
## Goal
`renderPersonalTaskXml` takes `runAsNode: true` (set when `process.versions.electron`
is present, injectable) and the action sets `$env:ELECTRON_RUN_AS_NODE='1'` before the
`& '<binary>' '<entry>' run --data-dir '<A>'` call; the consent text names the binary
and says the node then runs the desktop app's version and stops starting if the app is
removed. Run from node.exe, nothing changes. The `/Run` step is left out, with
`King Louie Node is already running (pid N); the task starts it at your next logon.`,
when `runningServicePid(dataDir)` names a live node.

## Spec sections
§8 (the two changes in personal-install.js), C-9, C-11.

## Files
- src/service/personal-install.js
- tests/service-cli-install-personal.test.js

## Acceptance
§14 install bullet. `node --test tests/service-cli-install-personal.test.js`.
