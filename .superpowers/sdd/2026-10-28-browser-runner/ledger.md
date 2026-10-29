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
(none yet)

## Left
All tickets.
