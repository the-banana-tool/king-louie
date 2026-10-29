---
id: T08
title: IPC channels and preload for the four new desktop methods
status: done
merged: 2c0c2474
blocked_by: []
---
## Goal
`desktop:nodeStart`, `desktop:nodeInstallPreview`, `desktop:nodeInstall`,
`desktop:pairRestartConfirm` in src/ipc/constants.js and DESKTOP_METHODS (methods
`nodeStart`, `nodeInstallPreview`, `nodeInstall`, `pairRestartConfirm`), exposed under
`window.electron.desktop` in preload.js: `nodeStart({ restart })` (boolean only),
`nodeInstallPreview()`, `nodeInstall(payload)` and `pairRestartConfirm(payload)`
sending `{ confirmed: true }` only when the caller passed `confirmed === true` (as
`detach` does). Add them to any channel inventory fixture the allowlist test keeps.
Local by LOCAL_PREFIXES; no proxied domain changes.

## Spec sections
§11 (channel table).

## Files
- src/ipc/constants.js, src/ipc/desktop-handlers.js, preload.js
- tests/desktop-bridge-allowlist.test.js, tests/preload-bridge.test.js
- any registered-channel inventory fixture those tests read

## Acceptance
§14 allowlist/preload bullet.
