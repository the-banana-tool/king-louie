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
- T04 (merge f622a652): `snapshot` joins the case guard's and the take policy's lists; `run_steps` refuses a
  `ref=` selector.
- T05 (merge 32f2a56a): `screenshot` returns the viewport image to the model (`to_file` keeps the file form);
  the four browser tools are `emitsImages`; take steps ask for `to_file`.
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
- T09: the model-driven STUCK wording is `STUCK: what I see, what I tried, what I need`.

## Left
T03, T06, T07, T08, T10, T11, then code review and `npm test` once.
