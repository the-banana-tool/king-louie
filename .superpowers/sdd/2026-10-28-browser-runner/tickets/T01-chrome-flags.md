---
id: T01
title: One Chrome flag set and PlaywrightBrowser launch options
status: done
merged: 3e392f7b
blocked_by: []
---
## Goal
`src/browser/chrome-flags.js` (no requires, frozen) exports `CHROME_FLAGS` (today's seven switches from
`playwright-browser.js` `start`) and `IGNORED_DEFAULT_ARGS = ['--enable-automation']`. `PlaywrightBrowser`
passes `ignoreDefaultArgs: IGNORED_DEFAULT_ARGS` and `args: [...CHROME_FLAGS, ...extraArgs]` on both launch
paths (persistent and non-persistent). New `start` options: `executablePath` (used instead of
`channel: 'chrome'`, no bundled fallback, no download), `viewport` (`null` = the window's own size; default
1280x720), `extraArgs`. The constructor takes `{ chromium }` (default `require('playwright').chromium`).

## Spec sections
§3 C-1, §4.1, §4.2, §11 "Flags" (the PlaywrightBrowser half; the TakeManager half is T08), §13 (record the
unconfirmed items in the ledger; do not try to confirm them on a headed Chrome).

## Files
- src/browser/chrome-flags.js (new)
- src/browser/playwright-browser.js
- tests/browser-chrome-flags.test.js (new)

## Acceptance
- A stub `chromium` records the options of both paths: `ignoreDefaultArgs` deep-equals
  `['--enable-automation']`; `args` start with `CHROME_FLAGS`; `extraArgs` appended; `executablePath` set and
  no `channel`; a failing `executablePath` launch does NOT fall back to the bundled Chromium; `viewport: null`
  reaches `launchPersistentContext` / `newContext`.
- Real headless bundled Chromium: `navigator.webdriver === false` after `start`. Headless only.
- `node --test tests/browser-chrome-flags.test.js tests/browser-tool.test.js` pass.
