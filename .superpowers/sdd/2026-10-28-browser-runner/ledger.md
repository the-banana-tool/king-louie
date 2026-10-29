# Ledger: browser-runner (spec docs/superpowers/specs/2026-10-28-browser-runner-design.md)

Integration branch `feat/browser-runner` at `C:\Users\sblac\Programming\king-louie-wt\browser-runner`, from
`main` at 6af6a003. Tickets in `tickets/`.

## Task graph
- Wave 1 (no blockers): T01 chrome-flags, T02 default-profile, T04 guards-snapshot, T05 screenshot-image,
  T09 take-docs.
- Wave 2: T03 snapshot-refs (T01), T08 personal-take-browser (T01).
- Wave 3: T06 failure-images (T03, T05), T07 ref-label (T03), T10 e2e (T08).
- Last: T11 CLAUDE.md, then code review, then `npm test` once.

## Decisions
- The `mattpocock-skills:implement-spec` skill named by the orchestrator brief cannot be invoked by a model
  (disable-model-invocation); the brief's own process (tickets, worktrees, implementers, mergers) is followed.
- `playwright` 1.58.2 is installed and is in the lockfile; the pin to exactly `1.58.2` is a package.json and
  lockfile-root edit only (T03), no install.

## Not confirmable here (spec §13), recorded unconfirmed
- An "unsupported command-line flag" bar on the owner's Chrome for any `CHROME_FLAGS` switch.
- Whether a second `--disable-features=` replaces or merges with Playwright's own.
- CDP `clip.scale` arithmetic on a display scaled above 100 %.
- Whether a headed persistent context with `viewport: null` and `--start-maximized` fills the window.
- `navigator.webdriver` in a helper-launched Chrome without the flag set.
- The token figures of §8.5.

## Landed
- T01 (merge 3e392f7b): `src/browser/chrome-flags.js` holds the one Chrome flag set; `PlaywrightBrowser` drops
  `--enable-automation` and takes `executablePath`, `viewport` and `extraArgs`.
- T02 (merge 636c2eb2): `start` with no profile opens the persistent `king-louie` profile; `ephemeral: true`
  asks for a throwaway context.
- T03 (merge 1b0bfe24): the `snapshot` action reads `page._snapshotForAI().full`; `ref=` resolves through
  `aria-ref=` with a per-page ref record in `PlaywrightBrowser`; `BrowserRefError` codes `ref_stale`,
  `ref_not_found`, `invalid_params`; a raw `aria-ref=` selector is refused; the `*_in_frame` actions refuse
  refs; `playwright` pinned to 1.58.2.
- T04 (merge f622a652): `snapshot` joins the case guard's and the take policy's lists; `run_steps` refuses a
  `ref=` selector.
- T05 (merge 32f2a56a): `screenshot` returns the viewport image to the model (`to_file` keeps the file form);
  the four browser tools are `emitsImages`; take steps ask for `to_file`.
- T08 (merge dc2bf0b4): a personal node's take launches Chrome through `launchPersonalBrowser` /
  `PlaywrightBrowser`; the fleet passes `CHROME_FLAGS` to the helper launch; `activeProfiles()` in the
  browser registry; kept windows are held in `TakeManager#kept` and closed by `stopAll`; `cdp: false` on
  personal.
- T09 (merge 7325e19c): the take leads with the goal; `docs/driving-king-louie.md` and the takes spec
  amendment.
- T06 (merge 8f384d55): `src/tools/browser-auto-images.js` (`AUTO_IMAGES_PER_RUN` 3); `ToolExecutor` hands
  `executeContext.browserAutoImages`; a failed acting action gets an image and an interactive snapshot when
  `isPageError` (a TimeoutError or a Playwright call-prefixed message); navigate waits up to 1 s for
  chrome-error://.
- T07 (merge 29f734ef): `Tool#prepareParams`; `src/tools/builtin/browser-ref-label.js` sets `ref_label` and
  `target_ref_label` before anyone is asked; the run-time check reads a fresh `_snapshotForAI`
  (`PlaywrightBrowser#currentRefLabel`) and refuses `ref_changed`; the renderer's approval dialog shows a
  `browserRefSummary` line.
- T10 (merge cf062f70): opt-in personal-hosting case in `tests/e2e/demo-take.test.js` (`KL_E2E_TAKE=1`);
  NOT run here.

## Deviations
- Implementer branches are named `feat/browser-runner-T<NN>`: git refuses `feat/browser-runner/T<NN>` beside
  an existing `feat/browser-runner`.
- T02: `start` with no profile and no `userDataPath` in the tool context returns ok:false telling to pass
  `ephemeral: true`; `ephemeral` with `profile`/`userDataPath` is refused.
- T04: `snapshot` also joins the case guard's `PAGE` list (C-6 offers it on BrowserPage).
- T05: renderer.js labels image results "screenshot (image shown to the model)"; the DPI path divides by
  devicePixelRatio (unconfirmed above 100 %).
- T03: a raw `aria-ref=` selector is refused (added from T04's review, not in the spec: it would bypass the
  ref record and the C-8 label).
- T03: `max_chars` outside 1..60000 is refused rather than clamped.
- T03: `refs` counts the ref lines in the returned text.
- T08: the profile-in-use rule is also checked before the phone is asked; kept windows are covered.
- T09: the model-driven STUCK wording is `STUCK: what I see, what I tried, what I need`.
- T06: a direct `execute` without `browserAutoImages` attaches nothing; a failed capture still spends the
  budget.
- T07: a drag target gets its own `target_ref_label`; a hidden name shows as
  `<role> (name hidden: not one plain line)`; `prepareParams` runs before a hook's confirm prompt too; the
  run-time check's fresh snapshot replaces Playwright's ref map, so a ref to an element renamed since is
  `ref_not_found` on next use.
- Merge T07: conflict in `browserTool.execute` resolved as `checkRefSelectors`, `checkRefLabels`, then
  `result = await handler(...)`; a `BrowserRefError` (`ref_changed` included) returns early with no image;
  the `ref_changed` test asserts no image.

## Open items (for the review fix)
- A kept personal window the owner closes by hand stays in `TakeManager#kept` until `stopAll`, so a later
  take on that profile is refused until the service restarts; drop the entry on the context's `close` event.
- A ref in the login/signup/payment selector fields gets no label and no run-time check.
- Each approved ref action costs one extra snapshot.

- T11 (merge 948819bf): CLAUDE.md "Browser" section and the §14 amendments. Deviation: also amended the
  Demo takes endings bullet (personal close is `PlaywrightBrowser#stop`).

## Left
Code review (and its fix agent), then `npm test` once.
Review-fix inputs found so far: the unknown-page-state snapshot trigger checks only the snapshot's length,
not "no ref and under 200 characters of text" (spec §8.2); the kept-window item above.

## Review fixes (T12, branch feat/browser-runner-T12)
1. Unknown page state: the snapshot handler judges the whole page (no ref line and under 200 characters)
   before `interactive`/`ref`/`max_chars`, and marks the result in a WeakSet that `execute` reads; an
   interactive snapshot of an ordinary page, or a short page with a ref, spends nothing.
2. `snapshotLineRef` (playwright-browser.js): the parser's ref where it parses, else the last `[ref=…]`;
   `interactive`, the failure snapshot and `refs` use it. The `ref` subtree lookup stays on the parser
   (the node must be one the page's record knows).
3. `otherSelectorRefRefusal` (browser-ref-label.js): a `ref=` or raw `aria-ref=` in any `*Selector` field
   other than `selector`/`target_selector` is `invalid_params`, in `prepareParams` (before anyone is asked)
   and in `execute` (direct calls). Done as one check over the params rather than in `resolveLocator`,
   because the signup/payment/login helpers also pass those fields to `page.locator` directly, where a raw
   `aria-ref=` would have resolved.
4. `TakeManager#_keep` drops a kept browser on its context's `close`; `_assertProfileFree` also drops a
   kept browser that no longer `isRunning`. Tested with headless Chromium.
5. `checkRefLabels` refuses `ref_not_found` (BrowserRefError) when no browser is running.
6. The executor's `prepareParams` refusal is `{ success: false, ok: false, error, code }`.
7. The exact-label store is keyed by `[ref, shown label]` (a bounded Map of Sets, 512 keys), not by the
   params object, so a copy still compares exactly; tested with a spread copy.
8. tool-executor.js comments put back above `_liveTake`, `_prepareContext` has its own.
9. `SNAPSHOT_PARAMS` and `TO_FILE_PARAM` exported from browser-tool.js and used by BrowserPage and
   BrowserExtract; `snapshot` validates `ref` with `REF_ID`.
10. `parseRefSelector`, `isFrameAction` and `RAW_ARIA_REF` in playwright-browser.js, used by browser-tool.js and
    browser-ref-label.js; renderer.js keeps its copy with a comment naming the source (no require in the
    renderer). take-steps.js keeps its `/^\s*ref=/` refusal (broader: it also refuses a leading space).
11. `src/browser/profile-dirs.js` (`profilesRoot`, `resolveProfileDir`, `validProfileName`) used by
    browser-tool.js and takes.js.
12. `waitForErrorPage` and `attachFailureView` log a debug line (`createLogger('browser-tool')`) for each
    dropped wait or capture.
13. The take launcher gets a per-hosting argument: personal `{ exe, profile, userDataPath }`, fleet
    `{ exe, profile, ctx, setPid, checkEnded }`.
CLAUDE.md (Browser actions, Browser, Personal node) and docs/driving-king-louie.md (kept window) updated.
