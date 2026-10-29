---
id: T08
title: A personal node's take launches Chrome through PlaywrightBrowser; the fleet passes CHROME_FLAGS
status: open
blocked_by: [T01]
---
## Goal
- `createGuiSubsystem` (`src/gui/index.js`) passes `hosting` and `dataDir` to `TakeManager`.
- `TakeManager#_start` step 2 becomes an injected `launchTakeBrowser`. Fleet: as now but
  `broker.launchBrowser({ exe, profile, args: CHROME_FLAGS })`. Personal: `new PlaywrightBrowser().start({
  userDataPath: <dataDir>/browser-profiles/<profile>, executablePath: gui.apps[gui.browser].path,
  headless: false, viewport: null, extraArgs: ['--start-maximized'] })`; no broker launch, no pid recorded, no
  debugging port.
- Before the launch (personal): a profile active under another registry key (`browser-registry.js`; add
  `activeProfiles()` if missing) is refused `browser_launch_failed` ("profile <name> is open in another
  browser"). A Playwright launch throw is `browser_launch_failed`.
- Endings (personal): close is `browser.stop()`; `keep_browser: true` removes the key from the registry as
  today and keeps the handle outside it; `stopAll` closes it. `Take.start` answers `browser: { profile,
  cdp: false }` on personal (`cdp: true` on the fleet, as now).
- The registry key `take:<id>`, the active profile, the recorder, the policy and every ending as now.

## Spec sections
§3 C-3, C-4, §5, §11 "Personal takes" and the TakeManager half of "Flags".

## Files
- src/gui/takes.js, src/gui/index.js, src/tools/builtin/browser-registry.js
- tests/gui-takes.test.js

## Acceptance
§11 "Personal takes": a TakeManager with `hosting: 'personal'` and an injected `launchTakeBrowser` that
starts headless bundled Chromium through `PlaywrightBrowser` on a temp data dir: no broker `launchBrowser`
call, no `--remote-debugging-port` in the launch args, registered under `take:<id>` with the profile active,
every ending closes it, `keep_browser` leaves it out of the registry and `stopAll` closes it, a profile open
under the default key is `browser_launch_failed` before any launch, `start` answers `cdp: false`. Fleet: the
broker's `launchBrowser` gets `args: CHROME_FLAGS`; existing tests pass. Never headed, never a real take.
