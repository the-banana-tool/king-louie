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

## Open items (for the review fix)
- A kept personal window the owner closes by hand stays in `TakeManager#kept` until `stopAll`, so a later
  take on that profile is refused until the service restarts; drop the entry on the context's `close` event.

## Left
T06, T07, T10, T11, review, npm test.
