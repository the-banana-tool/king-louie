---
id: T04
title: snapshot in the case guard and the take policy; run_steps refuses ref=
status: done
merged: f622a652
blocked_by: []
---
## Goal
- Case guard (`src/cases/executors/case-guard.js`): `snapshot` joins `EXTRACT` (and the page list if that is
  where look-only page actions live) and the legacy `Browser` list. Nothing else is added. A wake-up may
  `snapshot`; `click ref=eN` in a wake-up is `wakeup_browser_acting`; `fill ref=eN` in a case turn is refused
  as any fill.
- Take policy (`src/gui/take-policy.js`): `snapshot` joins the `extract` column and `LOOK_ONLY_ACTIONS`; it
  runs on any host; a ref click on a host outside the sites is `take_site_not_allowed`; a take whose `browser`
  list leaves out `snapshot` is refused it.
- `validateSteps` (`src/gui/take-steps.js`): a step whose `selector` (or any selector-bearing field) starts
  `ref=` is refused `invalid_params`, naming the index and the field.
- Confirm that `src/gui/lease-protocol.js` and the phones validate a take's browser list as strings only
  (spec §7.5: no protocol or vector change) and say so in your report.

## Spec sections
§3 C-7 (run_steps), C-12, §7.5 (case guard, take policy), §11 "Case guard", "Take policy".

## Files
- src/cases/executors/case-guard.js, src/gui/take-policy.js, src/gui/take-steps.js
- tests/cases-case-guard.test.js, tests/take-policy.test.js, tests/take-steps.test.js

## Acceptance
The §11 tests for the case guard and the take policy, and a run_steps ref refusal test. `# fail 0`.
