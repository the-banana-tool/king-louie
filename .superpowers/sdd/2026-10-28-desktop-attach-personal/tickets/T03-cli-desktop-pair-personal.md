---
id: T03
title: desktop pair|unpair|list under hosting personal, and --json
status: open
blocked_by: []
---
## Goal
Under a `node.yaml` with `hosting: personal` (read with `loadNodeConfig` for the data
dir, injectable): refuse elevated (exit 1, §6.1 wording), require
`checkPersonalOwner({ dataDir, configDir })` (PERSONAL_NOT_OWNER with its problem line,
exit 1, nothing written), never call `applyWindowsAcls`, write the same three files.
`unpair` and `list` follow the same two rules there. A new flag `--json`, valid for
`desktop pair` only (cli.js refusal `Flag "--json" is only valid for "desktop pair"`),
ends the command with one JSON line on stdout: `{ ok: true, nodeId, port,
bridgeTurnedOn, hosting }` or `{ ok: false, code, message }` (codes include
PAIR_ELEVATED and PERSONAL_NOT_OWNER). Human lines still come first. Fleet path unchanged.

## Spec sections
§6.1, §6.4 (codes the CLI emits), C-2, C-3, C-4.

## Files
- src/service/commands/desktop.js
- src/service/cli.js (flag parsing, help line)
- tests/desktop-cli.test.js

## Acceptance
§14 `tests/desktop-cli.test.js` bullet. `node --test tests/desktop-cli.test.js` plus any
CLI test whose HELP/flag expectations change.
