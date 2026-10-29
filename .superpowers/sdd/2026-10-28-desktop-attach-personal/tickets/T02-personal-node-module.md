---
id: T02
title: src/desktop-bridge/personal-node.js (detect, task, pidfile, CLI, log)
status: open
blocked_by: [T01]
---
## Goal
A new Electron-free module with injected runners answering §7.1's four questions and
running the CLI as §6.3 says:
- `detectPersonalNode()` (§5.2: D, Y, A owned by `me`, no link, Y says personal; reuse
  T01's exported rule helper; returns `{ personal, name, dataDir, configDir }`, name
  through `shown`). Also a form the controller can use to answer both the bridge-file
  read and this question with one inspector call (C-1).
- `queryTask()`: `schtasks /Query /TN "KingLouie Node" /XML ONE`; principal UserId must
  be `me`; `<Enabled>false</Enabled>` is disabled; non-zero exit is missing. Result
  `registered | disabled | missing | other-account | unknown`.
- `nodeRunning()`: pidfile `<A>\service.pid` names a live pid whose command line passes
  `isServiceCommandLine` (src/service/commands/stop.js).
- `runTask()`: `schtasks /Run /TN "KingLouie Node"`.
- `restartNode()`: the CLI `stop --data-dir A`, then `/Run`; never `/End`.
- `runCli(args, { timeoutMs })`: `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, the
  app's own `bin/king-louie-service.js`, every other env var passed as it is, stdin
  ignored, args as an array, no shell; returns `{ code, stdout, stderr, json }` where
  `json` is the last stdout line parsed when it is JSON.
- `startFailureSince(time)`: tail of `<A>\logs\service.log`, the newest `service failed
  to start` line written after `time`, through `shown`.

## Spec sections
§4 (constraints), §5.2, §6.3, §7.1, §12 (the programs it runs), C-9, C-10, C-11.

## Files
- src/desktop-bridge/personal-node.js (new)
- tests/desktop-personal-node.test.js (new)
- tests/fixtures/desktop-personal-node/*.xml (new, invented SIDs)

## Acceptance
§14 second bullet. Injected: execFile, spawn, readFile, now, inspectOwners,
readPidfile, isRunning, commandLineOf. `node --test tests/desktop-personal-node.test.js`
and `node --test tests/electron-boundary.test.js` pass.

## Notes
schtasks by absolute path (find what personal-install.js uses). Whether `/XML ONE` is
what Windows 11 Home accepts is unconfirmed (§15): already in the ledger.
