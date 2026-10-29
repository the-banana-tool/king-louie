---
id: T09
title: Pane model and attached banner for the personal views
status: done
merged: 2fc8e743
blocked_by: []
---
## Goal
`describeServicePane` renders from the §11 status shape (`status.node`, the
`pendingPair.personal/stage/error` fields, view `attached-starting`):
- the unpaired personal view (§6.2's two lines and Pair; the name through the status);
- the personal pairing stages: `command` error with Try again / Cancel (the §6.4 pane
  lines per code), `restart-needed` with the §6.2 step 4 text and Restart and pair /
  Cancel, `starting`, `confirming`;
- the paired/attached personal line `Running as you (<account>), in your session.` in
  place of `Tools will run as the service account, not as you.`;
- `attached-starting` (`Starting King Louie Node…`, no buttons);
- `attached-disconnected` for a personal pairing: §7.4's table (line and added button);
- Install… (§8) when `node.task === 'missing'` in unpaired, paired or attached views,
  and a model for its preview (lines in a `<pre>`) and the Install press.
A new pure `describeAttachedBanner(status)` gives renderer.js the banner line and
buttons, so `renderAttachedBanner` (renderer.js ~:14480) holds no copy of the rules.
renderer.js wires the actions to the preload names (`nodeStart`, `nodeInstallPreview`,
`nodeInstall`, `pairRestartConfirm`) and sets every node string with textContent.
A fleet status renders exactly as before.

## Spec sections
§6.2 (wording), §6.4 pane lines, §7.4, §8 (pane), §11 last paragraph.

## Files
- src/desktop-bridge/pane-model.js
- renderer.js (renderAttachedBanner and the Local service pane only)
- tests/desktop-pane.test.js

## Acceptance
§14 pane bullet: every new view, line and action; a fleet status renders as before.
