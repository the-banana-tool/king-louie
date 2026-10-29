---
id: T04
title: import --from (whole profile) unelevated under hosting personal
status: open
blocked_by: []
---
## Goal
`runImportCommand` reads node.yaml for every import (C-14). `hosting: personal`: no
administrator requirement, and an elevated run is refused with or without --case
(§9.1 wording, exit 1). Otherwise unchanged (root/Administrator).

## Spec sections
§9.1, C-2, C-14.

## Files
- src/service/commands/import.js
- tests/service-cli-import-personal.test.js (new)
- tests/service-cli-import-case.test.js (only if an existing expectation changes)

## Acceptance
§14 import bullet: a whole import under personal runs unelevated; elevated under
personal refused with and without --case; a fleet node.yaml still needs an
administrator; a second import's plan from the same install marks the first one's
items `skip-present`.
