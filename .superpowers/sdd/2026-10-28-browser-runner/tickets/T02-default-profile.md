---
id: T02
title: A start without a profile opens the King Louie profile
status: open
blocked_by: []
---
## Goal
`start` (`browser-tool.js` `actions.start`) with no `profile` and no `userDataPath` opens the persistent
profile `king-louie` under `<userDataPath>/browser-profiles/` (through `resolveProfileDir`) and reports it as
the active profile. `ephemeral: true` keeps today's empty non-persistent context (active profile null). Add
`ephemeral` to the `Browser` and `BrowserSession` schemas with a description; fix the descriptions that say a
start without a profile is fresh.

## Spec sections
§3 C-2, §4.3, §11 "Default profile".

## Files
- src/tools/builtin/browser-tool.js (`start`, schema, description text)
- src/tools/builtin/browser-session-tool.js (schema)
- tests/browser-tool.test.js

## Acceptance
- `start` without `profile` uses `<dataDir>/browser-profiles/king-louie` and the result's `profile` is
  `king-louie` (headless, temp data dir).
- `ephemeral: true` uses no `userDataPath`; profile null.
- A case turn without `kl-cases` is still refused (find the existing check; the case rule is unchanged; keep
  or add a test that shows it).
- Covering tests `# fail 0`.
