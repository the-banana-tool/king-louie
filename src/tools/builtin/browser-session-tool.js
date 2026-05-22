const { Tool } = require('../tool-schema');
const browserTool = require('./browser-tool');

/**
 * BrowserSession — lifecycle, profiles, credentials, auth, tabs, cookies,
 * storage state, viewport, dialogs, and high-level credentialed flows
 * (login/signup/fill_payment).
 *
 * One of three split tools that share the underlying singleton with the
 * legacy `Browser` facade. Loading just BrowserSession + BrowserPage costs
 * roughly half the tokens of the all-in-one `Browser` schema, which
 * compounds across every agent-loop iteration.
 */

const SESSION_ACTIONS = [
  'start', 'stop', 'status',
  'profile_list', 'profile_create', 'profile_delete', 'profile_current',
  'save_credentials', 'fill_credentials', 'set_http_auth',
  'save_storage_state', 'load_storage_state',
  'get_cookies', 'clear_cookies',
  'set_viewport', 'handle_dialog',
  'login', 'signup', 'fill_payment',
  'tabs', 'open_tab', 'close_tab', 'switch_tab'
];

const browserSessionTool = new Tool({
  name: 'BrowserSession',
  description: `Browser lifecycle, persistent profiles, credential vault, auth, tabs, cookies, storage state, viewport, and high-level credentialed flows. Shares one singleton browser instance with BrowserPage and BrowserExtract.

Typical sequence: profile_list → start (with profile) → fill_credentials or login → use BrowserPage to interact.

PROFILES persist cookies/localStorage between runs:
  - profile_list / profile_create / profile_delete / profile_current
  - start with params.profile="<name>" attaches that profile.

VAULT CREDENTIALS (King-Louie's encrypted vault, not Chromium's):
  - save_credentials (profile?, host?, username, password) — stores creds.
  - fill_credentials (profile?, host?, submit?) — types stored creds into the current page's auto-detected username/password fields. Form-based logins only.
  - set_http_auth (username+password OR profile+host) — for HTTP Basic auth (the OS-style popup, not an HTML form). Call BEFORE navigating, or after a chrome-error://chromewebdata/ 401.

PREFER HIGH-LEVEL: login / signup / fill_payment auto-detect fields across sites — use these instead of hand-rolling fill+click sequences.`,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: SESSION_ACTIONS, description: 'Session action.' },

      // Lifecycle / profile
      profile: { type: 'string', description: 'Named persistent profile [A-Za-z0-9_-], max 64. Cookies/localStorage persist between runs.' },
      userDataPath: { type: 'string', description: 'Raw Chrome user data directory (advanced; prefer "profile").' },
      headless: { type: 'boolean', description: 'Run headless (default false — visible).' },

      // Credentials / auth
      host: { type: 'string', description: 'Host to scope credentials to. Defaults to current page origin.' },
      username: { type: 'string', description: 'Username/email for save_credentials, set_http_auth, login.' },
      password: { type: 'string', description: 'Password for save_credentials, set_http_auth, login.' },
      submit: { type: 'boolean', description: 'After fill_credentials, click submit (or press Enter) to log in.' },

      // login form selectors (auto-detected if omitted)
      url: { type: 'string', description: 'URL for login, open_tab, get_cookies.' },
      usernameSelector: { type: 'string', description: 'CSS selector for username input.' },
      passwordSelector: { type: 'string', description: 'CSS selector for password input.' },
      submitSelector: { type: 'string', description: 'CSS selector for submit button.' },

      // signup form
      name: { type: 'string', description: 'Full name for signup.' },
      email: { type: 'string', description: 'Email for signup.' },
      confirmPassword: { type: 'string', description: 'Confirm password (defaults to password).' },
      nameSelector: { type: 'string', description: 'CSS selector for name input (signup).' },
      emailSelector: { type: 'string', description: 'CSS selector for email input (signup).' },
      confirmPasswordSelector: { type: 'string', description: 'CSS selector for confirm password input.' },

      // payment form
      cardNumber: { type: 'string', description: 'Credit card number for fill_payment.' },
      cardExpiry: { type: 'string', description: 'Card expiry MM/YY for fill_payment.' },
      cardCvc: { type: 'string', description: 'Card CVC/CVV for fill_payment.' },
      cardName: { type: 'string', description: 'Name on card for fill_payment.' },
      cardZip: { type: 'string', description: 'Billing zip/postal code for fill_payment.' },
      couponCode: { type: 'string', description: 'Coupon/promo code to apply before payment.' },
      cardNumberSelector: { type: 'string', description: 'CSS selector for card number input.' },
      cardExpirySelector: { type: 'string', description: 'CSS selector for card expiry input.' },
      cardCvcSelector: { type: 'string', description: 'CSS selector for card CVC input.' },
      cardNameSelector: { type: 'string', description: 'CSS selector for cardholder name input.' },
      cardZipSelector: { type: 'string', description: 'CSS selector for billing zip input.' },
      couponSelector: { type: 'string', description: 'CSS selector for coupon input.' },
      couponSubmitSelector: { type: 'string', description: 'CSS selector for apply coupon button.' },

      // Storage / dialog / viewport / tabs
      path: { type: 'string', description: 'File path for save_storage_state / load_storage_state.' },
      response: { type: 'string', description: 'Dialog response: "accept", "dismiss", or "prompt:your text".' },
      width: { type: 'number', description: 'Viewport width.' },
      height: { type: 'number', description: 'Viewport height.' },
      tab_index: { type: 'number', description: 'Tab index for switch_tab, close_tab.' }
    },
    required: ['action']
  },
  requiresApproval: true,
  execute: async (params, context) => {
    if (!SESSION_ACTIONS.includes(params.action)) {
      return { ok: false, error: `BrowserSession does not support action "${params.action}". Use BrowserPage or BrowserExtract.` };
    }
    return browserTool.execute(params, context);
  }
});

module.exports = browserSessionTool;
