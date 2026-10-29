---
id: T09
title: Take leads with the goal; the driver's guide and the takes spec amendment
status: done
merged: 7325e19c
blocked_by: []
---
## Goal
- `Take`'s description (`src/gui/take-tool.js`) per §6.1: browsing first, `run_steps` last.
- `docs/driving-king-louie.md` per §6.2: §1 browser bullet (snapshot, refs, a screenshot is an image); §2 a
  personal node's take Chrome is launched by the node on the data dir's profile, logged into once from a
  chat; §4 "The task you send" reordered (goal, name/sites/minutes/profile, beats, STUCK/stop/minimise), a new
  "A scripted take" subsection holding today's step list and table; "What happens" steps 1 and 2; §5 a bullet
  for `ref_stale`, `ref_not_found`, `ref_changed` (browser errors, not take codes).
- `docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md`: a "Revised 2026-10-28" note under §8
  with the five bullets of this spec's §9.
- `tests/docs-driving.test.js` keeps passing (it holds §5 to `TAKE_CODES` and parses the `node.yaml` block;
  check whether it reads a step table and keep it readable).

## Spec sections
§3 C-13, C-14, §6, §9.

## Files
- src/gui/take-tool.js (description only), docs/driving-king-louie.md,
  docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md, tests/docs-driving.test.js if needed

## Acceptance
`node --test tests/docs-driving.test.js` and any take-tool test pass. No new `TAKE_CODES`. No personal values.
