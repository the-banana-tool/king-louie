'use strict';

/**
 * The one set of Chrome switches King Louie launches with (browser-runner
 * spec C-1). Every launch path passes CHROME_FLAGS as `args` and drops
 * Playwright's `--enable-automation` default with IGNORED_DEFAULT_ARGS, which
 * removes the "controlled by automated test software" banner. Playwright's
 * other default switches stay. No requires: other modules (a take's helper
 * launch) read the same list.
 */
const CHROME_FLAGS = Object.freeze([
  '--disable-session-crashed-bubble',
  '--disable-infobars',
  '--hide-crash-restore-bubble',
  '--no-first-run',
  '--no-default-browser-check',
  // Suppress Chromium's built-in password manager / autofill prompts —
  // king-louie's vault is the source of truth.
  '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,PasswordManager',
  // Without this, every page sees navigator.webdriver === true and the
  // bot walls on sites like Zillow (PerimeterX "Press & Hold") refuse even
  // the owner pressing the button by hand in the headed window.
  '--disable-blink-features=AutomationControlled',
]);

const IGNORED_DEFAULT_ARGS = Object.freeze(['--enable-automation']);

module.exports = { CHROME_FLAGS, IGNORED_DEFAULT_ARGS };
