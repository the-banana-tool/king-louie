---
id: T03
title: The snapshot action, ref= selectors, the per-page record, the Playwright pin
status: done
merged: 1b0bfe24
blocked_by: [T01]
---
## Goal
- A `snapshot` action `{ interactive?, ref?, max_chars? }` returning `{ ok, untrusted_output: true, url,
  title, snapshot, refs, truncated }` from `page._snapshotForAI()` (read its 1.58.2 signature and return
  shape in node_modules/playwright-core). `interactive` keeps only the lines with a ref (indented as in the
  tree); `ref` returns that node and its subtree; `max_chars` default 20000, at most 60000, cut at a line end.
- `PlaywrightBrowser` keeps a `WeakMap` page -> `{ seq, labels: Map(ref -> 'role "name"'), stale }`, written
  by every snapshot; a main-frame `framenavigated` (same-document included) sets `stale`. Expose helpers the
  tool and T07 can use (for example `refRecord(page)`, `refLabel(page, ref)`).
- `resolveLocator` gains `ref=<id>` (`^(f\d+)?e\d+$`) first -> `page.locator('aria-ref=<id>')`, only on the
  current page whose record holds it while not stale; otherwise `ref_stale` (navigated, or another tab is
  current) or `ref_not_found` (no snapshot on this page has that ref, or the element is gone). The tool's
  result is `{ ok: false, error, code }` (a typed error that `execute`'s catch maps to `code`).
- Refused in `fill_in_frame`, `click_in_frame`, `type_in_frame`, `evaluate_in_frame` with "use the ref with
  click or fill directly".
- `snapshot` offered on `BrowserPage`, `BrowserExtract` and the legacy `Browser`; the selector descriptions
  mention `ref=eN`. `snapshot` is NOT added to `ACTING_ACTIONS`.
- `package.json` pins `playwright` to exactly `1.58.2` (and the lockfile's root `packages[""]` entry); no npm
  install, no network. A contract test fails if `page._snapshotForAI` or the `aria-ref=` engine is gone.

## Spec sections
§3 C-5, C-6, C-7 (not run_steps: that is T04), §7.1 to §7.4, §11 "Snapshot and refs", §15 bullet 2.

## Files
- src/browser/playwright-browser.js, src/tools/builtin/browser-tool.js, browser-page-tool.js,
  browser-extract-tool.js, package.json, package-lock.json
- tests/browser-snapshot.test.js (new)

## Acceptance
§11 "Snapshot and refs" except the run_steps refusal: a page with a form, a link and an iframe; refs listed;
`interactive`; subtree; `max_chars`; `click ref=eN` clicks the right element; a frame ref fills a field inside
the iframe; after `navigate` and after `history.pushState` -> `ref_stale`; another tab -> `ref_stale`; an
element removed from the DOM -> `ref_not_found`; a ref in `click_in_frame` refused; the contract test.
Headless Chromium, `setContent` or `data:` URLs only.

## Notes
The label parser tolerates lines it does not understand and gives them no label. `getPageInfo` is unchanged.
