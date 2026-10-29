---
id: T10
title: Opt-in e2e, a personal-hosting take launched through PlaywrightBrowser
status: done
merged: cf062f70
blocked_by: [T08]
---
## Goal
`tests/e2e/demo-take.test.js` gains a personal-hosting case (Windows, `KL_E2E_TAKE=1` only): Playwright's
Chromium launched through `PlaywrightBrowser` headed (the path T08's personal `launchTakeBrowser` uses),
recorded five seconds, checked with `ffprobe`; skipped without the variable, and without ffmpeg, as now.

## Spec sections
§11 last bullet.

## Files
- tests/e2e/demo-take.test.js

## Acceptance
Without `KL_E2E_TAKE`, `node --test tests/e2e/demo-take.test.js` reports the new case skipped. Never set
`KL_E2E_TAKE` (it opens a window on the owner's screen); report that the opt-in run was not executed.
