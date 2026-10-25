'use strict';

// The take policy (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md,
// §7.1 and §7.2): inside a take, a tool call within what the owner approved runs, and one
// outside it fails at once with a code the model can read. Never an approval, never a wait.
// Pure: no requires beyond node:url.

const { URL } = require('node:url');

// §7.1, first column: inside every take with `browser: true`.
const BROWSER_ACTIONS = Object.freeze({
  page: Object.freeze([
    'navigate', 'go_back', 'go_forward', 'reload',
    'click', 'dblclick', 'fill', 'type', 'press', 'clear',
    'select_option', 'check', 'uncheck', 'hover', 'focus',
    'drag_and_drop', 'scroll', 'screenshot',
    'keyboard_type', 'keyboard_down', 'keyboard_up',
    'mouse_click', 'mouse_move', 'mouse_wheel',
    'wait_for', 'wait_for_url', 'wait_for_load_state', 'wait_for_response',
  ]),
  session: Object.freeze([
    'status', 'tabs', 'open_tab', 'close_tab', 'switch_tab', 'handle_dialog', 'set_viewport',
  ]),
  extract: Object.freeze([
    'content', 'title', 'get_text', 'get_attribute', 'get_value', 'is_visible', 'count',
    'bounding_box', 'console', 'frames', 'fill_in_frame', 'click_in_frame', 'type_in_frame',
  ]),
});

// §7.1, second column: only with `credentials: true` (BrowserSession).
const CREDENTIAL_ACTIONS = Object.freeze([
  'fill_credentials', 'login', 'signup', 'save_credentials', 'set_http_auth',
]);

// §7.1, third column: never inside a take.
const NEVER_ACTIONS = Object.freeze([
  // BrowserPage
  'evaluate', 'pdf', 'set_input_files',
  // BrowserSession
  'fill_payment', 'get_cookies', 'clear_cookies', 'save_storage_state', 'load_storage_state',
  'start', 'stop', 'profile_list', 'profile_create', 'profile_delete', 'profile_current',
  // BrowserExtract
  'evaluate_in_frame', 'route_block', 'route_fulfill', 'unroute',
]);

// The part of the third column that is the take's own browser: `take_browser_managed`.
const MANAGED_ACTIONS = Object.freeze([
  'start', 'stop', 'save_storage_state', 'load_storage_state',
]);

// Run wherever the page is: the model needs to see where it is and shut what it did not open.
const LOOK_ONLY_ACTIONS = Object.freeze([
  'status', 'tabs', 'close_tab', 'switch_tab', 'screenshot', 'content', 'title', 'get_text',
  'get_attribute', 'get_value', 'is_visible', 'count', 'bounding_box', 'console', 'frames',
  'wait_for', 'wait_for_url', 'wait_for_load_state', 'wait_for_response',
  'go_back', 'go_forward', 'reload',
]);

// Act on where they go, not on the current page: only the target (params.url) is checked.
// Every other acting action that carries a params.url has it checked as well as the current
// page (login, signup). wait_for_url is look-only: it acts on nothing and its url may be a
// pattern.
const TARGET_URL_ACTIONS = Object.freeze(['navigate', 'open_tab']);

// Act on params.host when it is given (checked against the sites), not on the current page.
// Every other action with params.host (fill_credentials) is checked on both.
const HOST_TARGET_ACTIONS = Object.freeze(['set_http_auth', 'save_credentials']);

// `Bash` is the only shell tool under src/tools/builtin/ today; `PowerShell` is named for
// any host that registers one.
const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);

// The legacy `Browser` tool's actions are the union of the three split tools', so the same
// columns apply by action name.
const BROWSER_TOOLS = Object.freeze(['Browser', 'BrowserSession', 'BrowserPage', 'BrowserExtract']);

const TAKE_CODES = Object.freeze([
  'take_tool_not_allowed',
  'take_app_not_allowed',
  'take_action_not_allowed',
  'take_browser_managed',
  'take_site_not_allowed',
  'take_no_mid_take_approval',
  'take_requires_local_origin',
  'take_busy',
  'recorder_missing',
  'recorder_failed',
  'browser_launch_failed',
]);

const FIRST_COLUMN = Object.freeze([
  ...BROWSER_ACTIONS.page, ...BROWSER_ACTIONS.session, ...BROWSER_ACTIONS.extract,
]);

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/\.+$/, '');
}

function hostAllowed(host, sites) {
  const h = normalizeHost(host);
  if (!h || !Array.isArray(sites)) return false;
  for (const site of sites) {
    const s = normalizeHost(site);
    if (s.startsWith('*.')) {
      const base = s.slice(2);
      if (base && (h === base || h.endsWith(`.${base}`))) return true;
    } else if (s && h === s) {
      return true;
    }
  }
  return false;
}

function hostOf(url) {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

function refuse(code, error, extra) {
  return { allow: false, code, error, ...(extra || {}) };
}

function siteRefusal(host) {
  return refuse('take_site_not_allowed', `${host} is not one of this take's sites`);
}

function actionRefusal(action, extra) {
  return refuse('take_action_not_allowed', `${action} is outside what this take approved`, extra);
}

function createTakePolicy(grant, { currentUrl } = {}) {
  const sites = Array.isArray(grant && grant.sites) ? grant.sites : [];
  const apps = Array.isArray(grant && grant.apps) ? grant.apps : [];
  const credentials = grant && grant.credentials === true;
  // `true` is the whole first column; a list narrows it and can never widen it.
  const allowance = Object.freeze(grant && grant.browser === true
    ? [...FIRST_COLUMN]
    : (Array.isArray(grant && grant.browser) ? grant.browser.filter((a) => FIRST_COLUMN.includes(a)) : []));

  async function decide(toolName, params) {
    const p = params || {};

    if (SHELL_TOOLS.includes(toolName)) {
      return refuse('take_tool_not_allowed', `${toolName} is not allowed in a take; to wait, use wait_for`);
    }

    if (toolName === 'LaunchApp' && !apps.includes(p.app)) {
      return refuse('take_app_not_allowed', `${p.app} is not one of this take's apps`);
    }

    if (BROWSER_TOOLS.includes(toolName)) {
      const action = p.action;

      if (MANAGED_ACTIONS.includes(action) || (typeof action === 'string' && action.startsWith('profile_'))) {
        return refuse('take_browser_managed', 'the take owns its browser; use Take.start and Take.stop');
      }
      if (NEVER_ACTIONS.includes(action)) return actionRefusal(action);

      const isCredential = CREDENTIAL_ACTIONS.includes(action);
      if (isCredential && !credentials) return actionRefusal(action);
      if (!isCredential && !allowance.includes(action)) {
        return actionRefusal(action, { allowed: [...allowance] });
      }

      if (LOOK_ONLY_ACTIONS.includes(action)) return { allow: true };

      // Any acting action with a target URL: its host must be one of the take's sites.
      if (p.url !== undefined && p.url !== null && p.url !== '') {
        const host = hostOf(p.url);
        if (!host || !hostAllowed(host, sites)) return siteRefusal(host || '(invalid URL)');
      }

      // Any acting action naming a host (the credential actions pick their vault entry by it):
      // that host must be one of the take's sites.
      const hasHost = p.host !== undefined && p.host !== null && p.host !== '';
      if (hasHost && !hostAllowed(p.host, sites)) {
        return siteRefusal(normalizeHost(p.host) || '(invalid host)');
      }

      // navigate and open_tab go to their target (open_tab with no url is a blank tab).
      if (TARGET_URL_ACTIONS.includes(action)) return { allow: true };

      // set_http_auth and save_credentials with a host act on that host, not the page (the
      // tool's help says to set HTTP auth before navigating). Without one they fall back to
      // the page's host, so the page check below applies.
      if (hasHost && HOST_TARGET_ACTIONS.includes(action)) return { allow: true };

      // Every other acting action checks the page it acts on.
      const url = typeof currentUrl === 'function' ? await currentUrl() : null;
      if (url == null) return siteRefusal('(no page)');
      const host = hostOf(url);
      if (!host || !hostAllowed(host, sites)) return siteRefusal(host || '(invalid URL)');
      return { allow: true };
    }

    // The node's own rules decide.
    return { allow: true, passthrough: true };
  }

  return { grant, decide };
}

module.exports = {
  hostAllowed,
  createTakePolicy,
  BROWSER_ACTIONS,
  CREDENTIAL_ACTIONS,
  NEVER_ACTIONS,
  MANAGED_ACTIONS,
  LOOK_ONLY_ACTIONS,
  TARGET_URL_ACTIONS,
  HOST_TARGET_ACTIONS,
  SHELL_TOOLS,
  BROWSER_TOOLS,
  TAKE_CODES,
};
