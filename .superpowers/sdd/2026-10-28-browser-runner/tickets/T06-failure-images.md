---
id: T06
title: An image and a snapshot after a failed acting action, three per run
status: open
blocked_by: [T03, T05]
---
## Goal
- In `browserTool.execute`'s catch: when `params.action` is in `ACTING_ACTIONS`
  (`src/tools/browser-acting.js`), the handler threw a Playwright error (timeout, strict mode, not found,
  detached, not visible, covered), the browser is running, and `context.browserAutoImages` allows, the error
  result gets `image` + `_images` (T05's capture) and `snapshot` (the interactive form, cut at 4000 chars).
  Past the budget: `image_omitted: 'budget'`, the snapshot still. A capture that fails is dropped and never
  hides the action's own error.
- Never after a parameter refusal, a `ref_*` refusal (T03's codes), a policy refusal or an approval denial.
- Unknown page state, same budget: a `navigate` landing on `chrome-error://`; a `snapshot` with no ref and
  under 200 characters of text.
- `ToolExecutor` (`src/execution/tool-executor.js`) holds a per-run budget of 3 and passes it in the execute
  context as `browserAutoImages` (for example an object with `take()` -> boolean), set from its own field
  after any caller-supplied context, as `checkDenied` is, so no option can reset it. An on-demand screenshot
  is never counted or refused.
- `run_steps` calls handlers directly, so a step gets no image (check nothing changes there).

## Spec sections
§3 C-10, §8.2, §8.3, §11 "Images after failure".

## Files
- src/tools/builtin/browser-tool.js (execute catch, navigate, snapshot), src/execution/tool-executor.js
- tests/browser-failure-images.test.js (new), the executor's test

## Acceptance
§11 "Images after failure": a click on a missing selector with a short timeout returns an image and an
interactive snapshot; a parameter refusal and a take-policy refusal return none; the fourth failure in one
run says `image_omitted: 'budget'`; an on-demand screenshot after that still returns an image; a
`chrome-error://` landing gets one. An executor test shows the counter is per executor and not overridable.
