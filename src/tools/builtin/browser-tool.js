const { Tool } = require('../tool-schema');
const { validateUrl } = require('./web-fetch-utils');
const PlaywrightBrowser = require('../../browser/playwright-browser');
const fs = require('fs');
const path = require('path');

// Maximum timeout the LLM can request for any browser action (15 seconds).
// This prevents wasting iterations on long waits for invisible/missing elements.
const MAX_ACTION_TIMEOUT = 15000;

function clampTimeout(requested, fallback) {
  const t = requested || fallback;
  return Math.min(t, MAX_ACTION_TIMEOUT);
}

// Singleton browser instance reused across tool calls
let pw = null;
// Name of the profile backing the currently-running browser, if any.
let activeProfile = null;

function getPw() {
  if (!pw) pw = new PlaywrightBrowser();
  return pw;
}

const VAULT_CRED_PREFIX = 'browser_cred:';

function profilesRoot(context) {
  if (!context || !context.userDataPath) {
    throw new Error('Profile actions require userDataPath in tool context (are you running inside Electron?).');
  }
  return path.join(context.userDataPath, 'browser-profiles');
}

function validProfileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

function resolveProfileDir(context, name) {
  if (!validProfileName(name)) {
    throw new Error(`Invalid profile name "${name}". Use 1–64 chars of [A-Za-z0-9_-].`);
  }
  return path.join(profilesRoot(context), name);
}

function vaultKeyFor(profile, host) {
  return `${VAULT_CRED_PREFIX}${profile}:${host}`;
}

function hostFromUrl(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

function requireRunning() {
  const b = getPw();
  if (!b.isRunning || !b.page) {
    throw new Error('Browser is not running. Call the start action first.');
  }
  return b;
}

/**
 * Resolve a Playwright locator from a selector string.
 *
 * Supports multiple selector strategies:
 *   - CSS:          "div.class"  (default)
 *   - Text:         "text=Login"
 *   - Role:         "role=button[name='Submit']"
 *   - Label:        "label=Email"
 *   - Placeholder:  "placeholder=Search..."
 *   - Test ID:      "testid=submit-btn"
 *   - XPath:        "xpath=//div[@id='app']"
 *   - Alt text:     "alt=Company logo"
 *   - Title:        "title=Close dialog"
 *
 * Playwright's built-in selector engines (text=, xpath=) are passed through.
 * The custom prefixes (role=, label=, etc.) map to Playwright's getBy* methods.
 */
function resolveLocator(page, selector) {
  if (!selector) throw new Error('selector parameter is required');

  // role=button[name="Submit"]
  const roleMatch = selector.match(/^role=(\w+)(?:\[name=["'](.+?)["']\])?$/);
  if (roleMatch) {
    const opts = roleMatch[2] ? { name: roleMatch[2] } : {};
    return page.getByRole(roleMatch[1], opts);
  }

  // label=Email
  if (selector.startsWith('label=')) {
    return page.getByLabel(selector.slice(6));
  }

  // placeholder=Search...
  if (selector.startsWith('placeholder=')) {
    return page.getByPlaceholder(selector.slice(12));
  }

  // testid=submit-btn
  if (selector.startsWith('testid=')) {
    return page.getByTestId(selector.slice(7));
  }

  // alt=Company logo
  if (selector.startsWith('alt=')) {
    return page.getByAltText(selector.slice(4));
  }

  // title=Close dialog
  if (selector.startsWith('title=')) {
    return page.getByTitle(selector.slice(6));
  }

  // Everything else: CSS, text=, xpath=, etc. — Playwright handles natively
  return page.locator(selector);
}

/**
 * Extract structured page info for the agent to understand what's on screen.
 */
async function getPageInfo(page) {
  return page.evaluate(() => {
    const url = window.location.href;
    const title = document.title;
    const bodyText = document.body ? document.body.innerText.substring(0, 3000) : '(empty)';
    const links = Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 20)
      .map(a => ({ text: a.textContent.trim().substring(0, 80), href: a.href }))
      .filter(l => l.text);
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"]'))
      .slice(0, 20)
      .map(b => (b.textContent || b.value || '').trim().substring(0, 80))
      .filter(Boolean);
    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      .slice(0, 20)
      .map(i => ({
        type: i.type || i.tagName.toLowerCase(),
        name: i.name || i.id || '',
        placeholder: i.placeholder || '',
        value: i.type === 'password' ? '***' : (i.value || '').substring(0, 100),
      }));
    return { url, title, bodyText, links, buttons, inputs };
  });
}

// ─── Action handlers ─────────────────────────────────────────────────────────
// Each returns a plain object result. Errors propagate to the catch in execute().

const actions = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(params, ctx) {
    const b = getPw();
    if (b.isRunning) {
      return { ok: true, message: 'Browser already running', profile: activeProfile };
    }
    const opts = {};
    if (params.profile) {
      const dir = resolveProfileDir(ctx, params.profile);
      fs.mkdirSync(dir, { recursive: true });
      opts.userDataPath = dir;
      activeProfile = params.profile;
    } else if (params.userDataPath) {
      opts.userDataPath = params.userDataPath;
      activeProfile = null;
    } else {
      activeProfile = null;
    }
    // v1 default: headed, so the user can watch the automation.
    opts.headless = params.headless === true;
    await b.start(opts);
    return {
      ok: true,
      message: `Browser started (Playwright, ${opts.headless ? 'headless' : 'headed'})`,
      profile: activeProfile,
    };
  },

  async stop() {
    const b = getPw();
    await b.stop();
    activeProfile = null;
    return { ok: true, message: 'Browser stopped' };
  },

  // ── Profile management ─────────────────────────────────────────────────────

  async profile_list(_params, ctx) {
    const root = profilesRoot(ctx);
    if (!fs.existsSync(root)) return { ok: true, profiles: [] };
    const names = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    return { ok: true, profiles: names, active: activeProfile };
  },

  async profile_create(params, ctx) {
    if (!params.profile) return { ok: false, error: '"profile" parameter is required.' };
    const dir = resolveProfileDir(ctx, params.profile);
    if (fs.existsSync(dir)) {
      return { ok: true, message: `Profile "${params.profile}" already exists.`, path: dir };
    }
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, message: `Profile "${params.profile}" created.`, path: dir };
  },

  async profile_delete(params, ctx) {
    if (!params.profile) return { ok: false, error: '"profile" parameter is required.' };
    if (activeProfile === params.profile && getPw().isRunning) {
      return { ok: false, error: `Profile "${params.profile}" is in use. Call stop first.` };
    }
    const dir = resolveProfileDir(ctx, params.profile);
    if (!fs.existsSync(dir)) {
      return { ok: false, error: `Profile "${params.profile}" does not exist.` };
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, message: `Profile "${params.profile}" deleted.` };
  },

  async profile_current() {
    return { ok: true, active: activeProfile, running: getPw().isRunning };
  },

  // ── Vault-backed credentials ───────────────────────────────────────────────

  async save_credentials(params, ctx) {
    const profile = params.profile || activeProfile;
    if (!profile) return { ok: false, error: 'No active profile. Pass "profile" or start the browser with one.' };
    const host = params.host || (getPw().page && hostFromUrl(getPw().page.url()));
    if (!host) return { ok: false, error: '"host" parameter is required when no page is loaded.' };
    if (!params.username || !params.password) {
      return { ok: false, error: '"username" and "password" parameters are required.' };
    }
    const { encryptToken } = ctx || {};
    if (!encryptToken) return { ok: false, error: 'Encryption unavailable (not running in Electron).' };
    const Store = require('electron-store').default || require('electron-store');
    const store = new Store();
    const encrypted = encryptToken(JSON.stringify({ username: params.username, password: params.password }));
    store.set(`__vault_${vaultKeyFor(profile, host)}`, encrypted);
    return { ok: true, message: `Credentials saved for ${profile}@${host}.` };
  },

  async set_http_auth(params, ctx) {
    const b = requireRunning();
    let username = params.username;
    let password = params.password;
    // If username/password aren't passed directly, pull from the vault using the
    // profile+host convention save_credentials uses.
    if (!username || !password) {
      const profile = params.profile || activeProfile;
      const host = params.host;
      if (!profile || !host) {
        return { ok: false, error: 'Provide either (username+password) or (profile+host) to look up vault creds.' };
      }
      const { decryptToken } = ctx || {};
      if (!decryptToken) return { ok: false, error: 'Decryption unavailable (not running in Electron).' };
      const Store = require('electron-store').default || require('electron-store');
      const store = new Store();
      const encrypted = store.get(`__vault_${vaultKeyFor(profile, host)}`);
      if (!encrypted) return { ok: false, error: `No credentials in vault for ${profile}@${host}.` };
      try {
        const creds = JSON.parse(decryptToken(encrypted));
        username = creds.username;
        password = creds.password;
      } catch (err) {
        return { ok: false, error: `Could not decode vault credentials: ${err.message}` };
      }
    }
    await b.context.setHTTPCredentials({ username, password });
    return { ok: true, message: 'HTTP Basic auth credentials set on browser context. Navigate (or reload) to apply.' };
  },

  async fill_credentials(params, ctx) {
    const b = requireRunning();
    const profile = params.profile || activeProfile;
    if (!profile) return { ok: false, error: 'No active profile. Start the browser with a profile first.' };
    const host = params.host || hostFromUrl(b.page.url());
    if (!host) return { ok: false, error: 'Cannot determine host from current URL.' };
    const { decryptToken } = ctx || {};
    if (!decryptToken) return { ok: false, error: 'Decryption unavailable (not running in Electron).' };
    const Store = require('electron-store').default || require('electron-store');
    const store = new Store();
    const encrypted = store.get(`__vault_${vaultKeyFor(profile, host)}`);
    if (!encrypted) {
      return { ok: false, error: `No credentials in vault for ${profile}@${host}. Use save_credentials first.` };
    }
    let creds;
    try { creds = JSON.parse(decryptToken(encrypted)); }
    catch (err) { return { ok: false, error: `Could not decode credentials: ${err.message}` }; }

    const userSel = params.usernameSelector || await autoDetectField(b.page, [
      'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
      'input[name="login"]', 'input[id="email"]', 'input[id="username"]',
      'input[autocomplete="email"]', 'input[autocomplete="username"]',
      'input[type="text"]',
    ]);
    const passSel = params.passwordSelector || await autoDetectField(b.page, [
      'input[type="password"]', 'input[name="password"]',
      'input[autocomplete="current-password"]',
    ]);
    if (!userSel || !passSel) {
      return { ok: false, error: 'Could not locate username/password fields. Pass usernameSelector/passwordSelector.' };
    }
    await resolveLocator(b.page, userSel).fill(creds.username, { timeout: clampTimeout(params.timeout, 5000) });
    await resolveLocator(b.page, passSel).fill(creds.password, { timeout: clampTimeout(params.timeout, 5000) });
    if (params.submit) {
      const submitSel = params.submitSelector || await autoDetectSubmit(b.page);
      if (submitSel) {
        await resolveLocator(b.page, submitSel).click({ timeout: clampTimeout(params.timeout, 5000) });
      } else {
        await resolveLocator(b.page, passSel).press('Enter');
      }
    }
    return { ok: true, message: `Filled credentials for ${profile}@${host}.`, host, profile };
  },

  async status() {
    const b = getPw();
    return { ok: true, running: b.isRunning, currentUrl: b.page ? b.page.url() : null };
  },

  // ── Navigation ─────────────────────────────────────────────────────────────

  async navigate(params) {
    const b = requireRunning();
    if (!params.url) return { ok: false, error: 'url parameter is required' };
    await validateUrl(params.url);
    const response = await b.page.goto(params.url, {
      waitUntil: 'domcontentloaded',
      timeout: params.timeout || 30000,
    });
    return {
      ok: true,
      message: `Navigated to ${params.url}`,
      status: response ? response.status() : null,
    };
  },

  async go_back() {
    const b = requireRunning();
    await b.page.goBack({ waitUntil: 'domcontentloaded' });
    return { ok: true, url: b.page.url() };
  },

  async go_forward() {
    const b = requireRunning();
    await b.page.goForward({ waitUntil: 'domcontentloaded' });
    return { ok: true, url: b.page.url() };
  },

  async reload() {
    const b = requireRunning();
    await b.page.reload({ waitUntil: 'domcontentloaded' });
    return { ok: true, url: b.page.url() };
  },

  // ── Element interaction ────────────────────────────────────────────────────

  async click(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    const opts = { timeout: clampTimeout(params.timeout, 10000) };
    if (params.button) opts.button = params.button; // 'left', 'right', 'middle'
    if (params.click_count) opts.clickCount = params.click_count;
    if (params.modifiers) opts.modifiers = params.modifiers; // ['Shift', 'Control', etc.]
    await loc.click(opts);
    return { ok: true, message: `Clicked ${params.selector}` };
  },

  async dblclick(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.dblclick({ timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, message: `Double-clicked ${params.selector}` };
  },

  async fill(params) {
    const b = requireRunning();
    if (params.text === undefined) return { ok: false, error: 'text parameter is required' };
    const loc = resolveLocator(b.page, params.selector);
    await loc.fill(params.text, { timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, message: `Filled ${params.selector}` };
  },

  async type(params) {
    const b = requireRunning();
    if (params.text === undefined) return { ok: false, error: 'text parameter is required' };
    const loc = resolveLocator(b.page, params.selector);
    await loc.pressSequentially(params.text, {
      delay: params.delay || 50,
      timeout: clampTimeout(params.timeout, 10000),
    });
    return { ok: true, message: `Typed into ${params.selector}` };
  },

  async press(params) {
    const b = requireRunning();
    if (!params.key) return { ok: false, error: 'key parameter is required (e.g. "Enter", "Tab", "Control+a")' };
    if (params.selector) {
      const loc = resolveLocator(b.page, params.selector);
      await loc.press(params.key, { timeout: clampTimeout(params.timeout, 5000) });
    } else {
      await b.page.keyboard.press(params.key);
    }
    return { ok: true, message: `Pressed ${params.key}` };
  },

  async clear(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.clear({ timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, message: `Cleared ${params.selector}` };
  },

  async select_option(params) {
    const b = requireRunning();
    if (params.value === undefined && !params.label && !params.index) {
      return { ok: false, error: 'Provide value, label, or index to select' };
    }
    const loc = resolveLocator(b.page, params.selector);
    const selectArg = params.label ? { label: params.label }
      : params.index !== undefined ? { index: params.index }
        : params.value;
    const selected = await loc.selectOption(selectArg, { timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, selected };
  },

  async check(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.check({ timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, message: `Checked ${params.selector}` };
  },

  async uncheck(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.uncheck({ timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, message: `Unchecked ${params.selector}` };
  },

  async hover(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.hover({ timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, message: `Hovered over ${params.selector}` };
  },

  async focus(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.focus({ timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, message: `Focused ${params.selector}` };
  },

  async drag_and_drop(params) {
    const b = requireRunning();
    if (!params.target_selector) return { ok: false, error: 'target_selector parameter is required' };
    const source = resolveLocator(b.page, params.selector);
    const target = resolveLocator(b.page, params.target_selector);
    await source.dragTo(target, { timeout: clampTimeout(params.timeout, 10000) });
    return { ok: true, message: `Dragged ${params.selector} to ${params.target_selector}` };
  },

  async set_input_files(params) {
    const b = requireRunning();
    if (!params.files) return { ok: false, error: 'files parameter is required (path string or array of paths)' };
    const loc = resolveLocator(b.page, params.selector);
    await loc.setInputFiles(params.files, { timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, message: `Set files on ${params.selector}` };
  },

  async scroll(params) {
    const b = requireRunning();
    if (params.selector) {
      const loc = resolveLocator(b.page, params.selector);
      await loc.scrollIntoViewIfNeeded({ timeout: clampTimeout(params.timeout, 5000) });
      return { ok: true, message: `Scrolled ${params.selector} into view` };
    }
    // Scroll page by delta
    const deltaX = params.delta_x || 0;
    const deltaY = params.delta_y || 500;
    await b.page.mouse.wheel(deltaX, deltaY);
    return { ok: true, message: `Scrolled page by (${deltaX}, ${deltaY})` };
  },

  // ── Page content / info ────────────────────────────────────────────────────

  async screenshot(params) {
    const b = requireRunning();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const screenshotDir = path.join(os.tmpdir(), 'king-louie-screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `screenshot-${Date.now()}.png`);

    const screenshotOpts = { path: screenshotPath, type: 'png' };
    if (params.full_page) screenshotOpts.fullPage = true;
    if (params.selector) {
      const loc = resolveLocator(b.page, params.selector);
      await loc.screenshot(screenshotOpts);
    } else {
      await b.page.screenshot(screenshotOpts);
    }

    const pageInfo = await getPageInfo(b.page);
    return {
      ok: true,
      message: `Screenshot saved to ${screenshotPath}`,
      savedTo: screenshotPath,
      page: pageInfo,
    };
  },

  async pdf(params) {
    const b = requireRunning();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const pdfDir = path.join(os.tmpdir(), 'king-louie-pdfs');
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    const pdfPath = path.join(pdfDir, `page-${Date.now()}.pdf`);

    await b.page.pdf({
      path: pdfPath,
      format: params.format || 'A4',
      printBackground: true,
    });
    return { ok: true, message: `PDF saved to ${pdfPath}`, savedTo: pdfPath };
  },

  async evaluate(params) {
    const b = requireRunning();
    if (!params.expression) return { ok: false, error: 'expression parameter is required' };
    const result = await b.page.evaluate(params.expression);
    return { ok: true, result };
  },

  async content() {
    const b = requireRunning();
    const html = await b.page.content();
    // Return truncated HTML to avoid context bloat
    return { ok: true, html: html.substring(0, 50000), truncated: html.length > 50000 };
  },

  async title() {
    const b = requireRunning();
    return { ok: true, title: await b.page.title(), url: b.page.url() };
  },

  async get_text(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    const text = await loc.innerText({ timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, text };
  },

  async get_attribute(params) {
    const b = requireRunning();
    if (!params.attribute) return { ok: false, error: 'attribute parameter is required' };
    const loc = resolveLocator(b.page, params.selector);
    const value = await loc.getAttribute(params.attribute, { timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, value };
  },

  async get_value(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    const value = await loc.inputValue({ timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, value };
  },

  async is_visible(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    const visible = await loc.isVisible();
    return { ok: true, visible };
  },

  async count(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    const count = await loc.count();
    return { ok: true, count };
  },

  async bounding_box(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    const box = await loc.boundingBox({ timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, box };
  },

  // ── Waiting ────────────────────────────────────────────────────────────────

  async wait_for(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    const state = params.state || 'visible'; // 'attached', 'detached', 'visible', 'hidden'
    await loc.waitFor({ state, timeout: params.timeout || 30000 });
    return { ok: true, message: `Selector ${params.selector} is ${state}` };
  },

  async wait_for_url(params) {
    const b = requireRunning();
    if (!params.url) return { ok: false, error: 'url parameter is required (string or regex pattern)' };
    await b.page.waitForURL(params.url, { timeout: params.timeout || 30000 });
    return { ok: true, url: b.page.url() };
  },

  async wait_for_load_state(params) {
    const b = requireRunning();
    const state = params.state || 'networkidle'; // 'load', 'domcontentloaded', 'networkidle'
    await b.page.waitForLoadState(state, { timeout: params.timeout || 30000 });
    return { ok: true, message: `Page reached ${state} state` };
  },

  async wait_for_response(params) {
    const b = requireRunning();
    if (!params.url) return { ok: false, error: 'url parameter is required (URL substring or pattern to match)' };
    const response = await b.page.waitForResponse(
      resp => resp.url().includes(params.url),
      { timeout: params.timeout || 30000 }
    );
    return {
      ok: true,
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
    };
  },

  // ── Tab / page management ──────────────────────────────────────────────────

  async tabs() {
    const b = requireRunning();
    const pages = await b.getPages();
    return { ok: true, tabs: pages };
  },

  async open_tab(params) {
    const b = requireRunning();
    if (params.url) await validateUrl(params.url);
    await b.newPage(params.url || null);
    return { ok: true, message: `Opened new tab${params.url ? ` at ${params.url}` : ''}` };
  },

  async close_tab(params) {
    const b = requireRunning();
    const index = params.tab_index !== undefined ? params.tab_index : -1;
    if (index < 0) return { ok: false, error: 'tab_index parameter is required' };
    await b.closePage(index);
    return { ok: true, message: `Closed tab ${index}` };
  },

  async switch_tab(params) {
    const b = requireRunning();
    if (params.tab_index === undefined) return { ok: false, error: 'tab_index parameter is required' };
    b.switchToPage(params.tab_index);
    return { ok: true, message: `Switched to tab ${params.tab_index}`, url: b.page.url() };
  },

  // ── Network ────────────────────────────────────────────────────────────────

  async route_block(params) {
    const b = requireRunning();
    if (!params.pattern) return { ok: false, error: 'pattern parameter is required (URL glob like "**/*.png" or "**google-analytics**")' };
    await b.page.route(params.pattern, route => route.abort());
    b._routes.push(params.pattern);
    return { ok: true, message: `Blocking requests matching: ${params.pattern}` };
  },

  async route_fulfill(params) {
    const b = requireRunning();
    if (!params.pattern) return { ok: false, error: 'pattern parameter is required' };
    const fulfillOpts = {};
    if (params.status) fulfillOpts.status = params.status;
    if (params.body) fulfillOpts.body = params.body;
    if (params.content_type) fulfillOpts.contentType = params.content_type;
    await b.page.route(params.pattern, route => route.fulfill(fulfillOpts));
    b._routes.push(params.pattern);
    return { ok: true, message: `Fulfilling requests matching: ${params.pattern}` };
  },

  async unroute(params) {
    const b = requireRunning();
    if (params.pattern) {
      await b.page.unroute(params.pattern);
      b._routes = b._routes.filter(r => r !== params.pattern);
      return { ok: true, message: `Removed route for ${params.pattern}` };
    }
    // Remove all routes
    for (const p of b._routes) {
      await b.page.unroute(p).catch(() => {});
    }
    b._routes = [];
    return { ok: true, message: 'Removed all routes' };
  },

  async console() {
    const b = requireRunning();
    const logs = b.drainConsole();
    return { ok: true, logs };
  },

  // ── Frames / iframes ───────────────────────────────────────────────────────

  async frames() {
    const b = requireRunning();
    const frames = b.page.frames().map((f, i) => ({
      index: i,
      name: f.name() || '',
      url: f.url(),
    }));
    return { ok: true, frames };
  },

  async fill_in_frame(params) {
    const f = resolveFrame(requireRunning().page, params);
    if (!params.selector) return { ok: false, error: 'selector parameter is required' };
    if (params.text === undefined) return { ok: false, error: 'text parameter is required' };
    await f.locator(params.selector).fill(params.text, { timeout: clampTimeout(params.timeout, 5000) });
    return { ok: true, message: `Filled ${params.selector} in frame ${params.frame_name || params.frame_url || '(index)'}` };
  },

  async click_in_frame(params) {
    const f = resolveFrame(requireRunning().page, params);
    if (!params.selector) return { ok: false, error: 'selector parameter is required' };
    await f.locator(params.selector).click({ timeout: clampTimeout(params.timeout, 10000) });
    return { ok: true, message: `Clicked ${params.selector} in frame ${params.frame_name || params.frame_url || '(index)'}` };
  },

  async type_in_frame(params) {
    const f = resolveFrame(requireRunning().page, params);
    if (!params.selector) return { ok: false, error: 'selector parameter is required' };
    if (params.text === undefined) return { ok: false, error: 'text parameter is required' };
    await f.locator(params.selector).pressSequentially(params.text, {
      delay: params.delay || 50,
      timeout: clampTimeout(params.timeout, 10000),
    });
    return { ok: true, message: `Typed into ${params.selector} in frame ${params.frame_name || params.frame_url || '(index)'}` };
  },

  async evaluate_in_frame(params) {
    const f = resolveFrame(requireRunning().page, params);
    if (!params.expression) return { ok: false, error: 'expression parameter is required' };
    const result = await f.evaluate(params.expression);
    return { ok: true, result };
  },

  // ── Auth & state ───────────────────────────────────────────────────────────

  async signup(params) {
    const b = requireRunning();
    if (!params.url) return { ok: false, error: 'url parameter is required' };
    await validateUrl(params.url);

    await b.page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: params.timeout || 30000 });
    await b.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const results = {};

    // Name field (optional — not all signup forms have it)
    if (params.name) {
      const nSel = params.nameSelector || await autoDetectField(b.page, [
        'input[name="name"]', 'input[name="full_name"]', 'input[name="fullName"]',
        'input[id="name"]', 'input[id="full-name"]', 'input[autocomplete="name"]',
        'input[name="first_name"]', 'input[placeholder*="name" i]',
      ]);
      if (nSel) { await b.page.locator(nSel).fill(params.name); results.nameSelector = nSel; }
    }

    // Email field
    if (params.email || params.username) {
      const eSel = params.emailSelector || await autoDetectField(b.page, [
        'input[type="email"]', 'input[name="email"]', 'input[id="email"]',
        'input[autocomplete="email"]', 'input[name="username"]', 'input[id="username"]',
        'input[autocomplete="username"]', 'input[type="text"]',
      ]);
      if (!eSel) return { ok: false, error: 'Could not find email/username input. Provide emailSelector.' };
      await b.page.locator(eSel).fill(params.email || params.username);
      results.emailSelector = eSel;
    }

    // Password field
    if (params.password) {
      const pSel = params.passwordSelector || await autoDetectField(b.page, [
        'input[type="password"]', 'input[name="password"]',
        'input[autocomplete="new-password"]',
      ]);
      if (!pSel) return { ok: false, error: 'Could not find password input. Provide passwordSelector.' };
      await b.page.locator(pSel).fill(params.password);
      results.passwordSelector = pSel;

      // Confirm password (optional — only if a second password field exists)
      const cpSel = params.confirmPasswordSelector || await autoDetectField(b.page, [
        'input[name="password_confirmation"]', 'input[name="confirmPassword"]',
        'input[name="confirm_password"]', 'input[name="password2"]',
      ]);
      if (cpSel) {
        await b.page.locator(cpSel).fill(params.confirmPassword || params.password);
        results.confirmPasswordSelector = cpSel;
      } else {
        // Check if there are multiple password fields (second one = confirm)
        const pwCount = await b.page.locator('input[type="password"]').count();
        if (pwCount >= 2) {
          await b.page.locator('input[type="password"]').nth(1).fill(params.confirmPassword || params.password);
          results.confirmPasswordSelector = 'input[type="password"]:nth(1)';
        }
      }
    }

    // Find and click submit
    const sSel = params.submitSelector || await autoDetectSignupSubmit(b.page);
    if (sSel) {
      await b.page.locator(sSel).click();
      results.submitSelector = sSel;
    } else {
      // Fallback: press Enter
      await b.page.keyboard.press('Enter');
      results.submitSelector = '(Enter key fallback)';
    }

    await b.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const finalUrl = b.page.url();

    return { ok: true, message: `Signup attempted at ${params.url}`, currentUrl: finalUrl, ...results };
  },

  async fill_payment(params) {
    const b = requireRunning();
    const results = {};

    // Apply coupon first if provided
    if (params.couponCode) {
      const couponSel = params.couponSelector || await autoDetectField(b.page, [
        'input[name="coupon"]', 'input[name="coupon_code"]', 'input[name="couponCode"]',
        'input[name="promo"]', 'input[name="promo_code"]', 'input[name="promoCode"]',
        'input[name="discount"]', 'input[name="discount_code"]',
        'input[id="coupon"]', 'input[id="promo"]', 'input[id="coupon-code"]',
        'input[id="promo-code"]', 'input[id="discount-code"]',
        'input[placeholder*="coupon" i]', 'input[placeholder*="promo" i]',
        'input[placeholder*="discount" i]', 'input[name="code"]',
      ]);

      if (couponSel) {
        await b.page.locator(couponSel).fill(params.couponCode);
        results.couponSelector = couponSel;

        // Click apply button
        const applySel = params.couponSubmitSelector || await autoDetectApplyCoupon(b.page);
        if (applySel) {
          await b.page.locator(applySel).click();
          await b.page.waitForTimeout(2000); // wait for coupon validation
          results.couponSubmitSelector = applySel;
        }
      }
    }

    // Detect if payment fields are in an iframe (Stripe, Braintree, etc.)
    const paymentFrames = b.page.frames().filter((f) => {
      const url = f.url();
      return url.includes('stripe.com') || url.includes('braintree') ||
        url.includes('recurly') || url.includes('chargebee') ||
        url.includes('paddle') || url.includes('checkout.stripe.com');
    });

    if (paymentFrames.length > 0) {
      results.paymentFrameDetected = true;
      const fieldAttempts = [];

      for (const frame of paymentFrames) {
        const frameName = (frame.name() || '').toLowerCase();
        const frameUrl = frame.url().toLowerCase();

        try {
          if ((frameName.includes('number') || frameUrl.includes('number') || paymentFrames.length === 1) && params.cardNumber) {
            const input = frame.locator('input[name="cardnumber"], input[name="card-number"], input[autocomplete="cc-number"], input[name="number"], input').first();
            if (await input.isVisible().catch(() => false)) {
              await input.fill(params.cardNumber);
              fieldAttempts.push({ field: 'cardNumber', frameName: frame.name(), status: 'filled' });
            }
          }

          if ((frameName.includes('expir') || frameUrl.includes('expir')) && params.cardExpiry) {
            await frame.locator('input').first().fill(params.cardExpiry);
            fieldAttempts.push({ field: 'cardExpiry', frameName: frame.name(), status: 'filled' });
          }

          if ((frameName.includes('cvc') || frameName.includes('cvv') || frameUrl.includes('cvc') || frameUrl.includes('cvv')) && params.cardCvc) {
            await frame.locator('input').first().fill(params.cardCvc);
            fieldAttempts.push({ field: 'cardCvc', frameName: frame.name(), status: 'filled' });
          }

          if ((frameName.includes('postal') || frameName.includes('zip') || frameUrl.includes('postal') || frameUrl.includes('zip')) && params.cardZip) {
            await frame.locator('input').first().fill(params.cardZip);
            fieldAttempts.push({ field: 'cardZip', frameName: frame.name(), status: 'filled' });
          }
        } catch (frameErr) {
          fieldAttempts.push({ field: 'unknown', frameName: frame.name(), status: 'error', error: frameErr.message });
        }
      }

      // Cardholder name is typically in the main frame
      if (params.cardName) {
        const nameSel = params.cardNameSelector || await autoDetectField(b.page, [
          'input[name="name"]', 'input[name="cardholder"]', 'input[name="cardholder-name"]',
          'input[name="card-name"]', 'input[autocomplete="cc-name"]',
          'input[id="cardholder-name"]', 'input[placeholder*="name on card" i]',
          'input[placeholder*="cardholder" i]',
        ]);
        if (nameSel) {
          await b.page.locator(nameSel).fill(params.cardName);
          fieldAttempts.push({ field: 'cardName', location: 'main_frame', status: 'filled' });
        }
      }

      results.iframeFields = fieldAttempts;
      results.paymentFrames = paymentFrames.map((f) => ({ name: f.name(), url: f.url() }));
    } else {
      // Payment fields in the main frame
      results.paymentFrameDetected = false;

      if (params.cardNumber) {
        const sel = params.cardNumberSelector || await autoDetectField(b.page, [
          'input[name="cardnumber"]', 'input[name="card_number"]', 'input[name="cc-number"]',
          'input[autocomplete="cc-number"]', 'input[data-stripe="number"]',
          'input[id="card-number"]', 'input[placeholder*="card number" i]',
        ]);
        if (sel) { await b.page.locator(sel).fill(params.cardNumber); results.cardNumberSelector = sel; }
      }

      if (params.cardExpiry) {
        const sel = params.cardExpirySelector || await autoDetectField(b.page, [
          'input[name="exp-date"]', 'input[name="expiry"]', 'input[name="cc-exp"]',
          'input[autocomplete="cc-exp"]', 'input[data-stripe="exp"]',
          'input[placeholder*="MM" i]', 'input[name="expiration"]',
        ]);
        if (sel) { await b.page.locator(sel).fill(params.cardExpiry); results.cardExpirySelector = sel; }
      }

      if (params.cardCvc) {
        const sel = params.cardCvcSelector || await autoDetectField(b.page, [
          'input[name="cvc"]', 'input[name="cvv"]', 'input[name="cc-csc"]',
          'input[autocomplete="cc-csc"]', 'input[data-stripe="cvc"]',
          'input[placeholder*="CVC" i]', 'input[placeholder*="CVV" i]',
        ]);
        if (sel) { await b.page.locator(sel).fill(params.cardCvc); results.cardCvcSelector = sel; }
      }

      if (params.cardName) {
        const sel = params.cardNameSelector || await autoDetectField(b.page, [
          'input[name="ccname"]', 'input[name="cc-name"]', 'input[autocomplete="cc-name"]',
          'input[name="cardholder"]', 'input[placeholder*="name on card" i]',
        ]);
        if (sel) { await b.page.locator(sel).fill(params.cardName); results.cardNameSelector = sel; }
      }

      if (params.cardZip) {
        const sel = params.cardZipSelector || await autoDetectField(b.page, [
          'input[name="postal"]', 'input[name="zip"]', 'input[name="billing_zip"]',
          'input[autocomplete="postal-code"]', 'input[placeholder*="zip" i]',
          'input[placeholder*="postal" i]',
        ]);
        if (sel) { await b.page.locator(sel).fill(params.cardZip); results.cardZipSelector = sel; }
      }
    }

    return { ok: true, message: 'Payment form filled', ...results };
  },

  async login(params) {
    const b = requireRunning();
    if (!params.url) return { ok: false, error: 'url parameter is required' };
    if (!params.username || !params.password) return { ok: false, error: 'username and password are required' };
    await validateUrl(params.url);

    await b.page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: params.timeout || 30000 });
    await b.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Resolve username field
    const uSelector = params.usernameSelector || await autoDetectField(b.page, [
      'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
      'input[name="login"]', 'input[id="email"]', 'input[id="username"]',
      'input[autocomplete="email"]', 'input[autocomplete="username"]',
      'input[type="text"]',
    ]);
    if (!uSelector) return { ok: false, error: 'Could not find username input. Provide usernameSelector.' };

    // Resolve password field
    const pSelector = params.passwordSelector || await autoDetectField(b.page, [
      'input[type="password"]', 'input[name="password"]',
      'input[autocomplete="current-password"]',
    ]);
    if (!pSelector) return { ok: false, error: 'Could not find password input. Provide passwordSelector.' };

    // Fill credentials using Playwright's native fill (handles React/Vue automatically)
    await b.page.locator(uSelector).fill(params.username);
    await b.page.locator(pSelector).fill(params.password);

    // Find and click submit button
    const sSelector = params.submitSelector || await autoDetectSubmit(b.page);
    if (sSelector) {
      await b.page.locator(sSelector).click();
    } else {
      // Fallback: press Enter in the password field
      await b.page.locator(pSelector).press('Enter');
    }

    // Wait for navigation
    await b.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const finalUrl = b.page.url();

    return {
      ok: true,
      message: `Login attempted at ${params.url}`,
      currentUrl: finalUrl,
      usernameSelector: uSelector,
      passwordSelector: pSelector,
      submitSelector: sSelector || '(Enter key fallback)',
    };
  },

  async save_storage_state(params) {
    const b = requireRunning();
    if (!params.path) return { ok: false, error: 'path parameter is required (file path to save state to)' };
    await b.context.storageState({ path: params.path });
    return { ok: true, message: `Storage state saved to ${params.path}` };
  },

  async load_storage_state(params) {
    const b = requireRunning();
    if (!params.path) return { ok: false, error: 'path parameter is required (file path to load state from)' };
    // Loading storage state requires creating a new context
    const fs = require('fs');
    if (!fs.existsSync(params.path)) return { ok: false, error: `File not found: ${params.path}` };
    const storageState = JSON.parse(fs.readFileSync(params.path, 'utf8'));

    // Add cookies and storage from the saved state
    if (storageState.cookies && storageState.cookies.length) {
      await b.context.addCookies(storageState.cookies);
    }
    return { ok: true, message: `Storage state loaded from ${params.path}` };
  },

  async get_cookies(params) {
    const b = requireRunning();
    const urls = params.url ? [params.url] : undefined;
    const cookies = await b.context.cookies(urls);
    return { ok: true, cookies };
  },

  async clear_cookies() {
    const b = requireRunning();
    await b.context.clearCookies();
    return { ok: true, message: 'Cookies cleared' };
  },

  // ── Dialog handling ────────────────────────────────────────────────────────

  async handle_dialog(params) {
    const b = requireRunning();
    if (!params.response) return { ok: false, error: 'response parameter is required: "accept", "dismiss", or "prompt:your text"' };
    b._dialogAction = params.response;
    return { ok: true, message: `Dialog handler set to: ${params.response}` };
  },

  // ── Viewport / emulation ───────────────────────────────────────────────────

  async set_viewport(params) {
    const b = requireRunning();
    if (!params.width || !params.height) return { ok: false, error: 'width and height are required' };
    await b.page.setViewportSize({ width: params.width, height: params.height });
    return { ok: true, message: `Viewport set to ${params.width}x${params.height}` };
  },

  // ── Keyboard ───────────────────────────────────────────────────────────────

  async keyboard_type(params) {
    const b = requireRunning();
    if (!params.text) return { ok: false, error: 'text parameter is required' };
    await b.page.keyboard.type(params.text, { delay: params.delay || 0 });
    return { ok: true, message: 'Typed text via keyboard' };
  },

  async keyboard_down(params) {
    const b = requireRunning();
    if (!params.key) return { ok: false, error: 'key parameter is required' };
    await b.page.keyboard.down(params.key);
    return { ok: true, message: `Key down: ${params.key}` };
  },

  async keyboard_up(params) {
    const b = requireRunning();
    if (!params.key) return { ok: false, error: 'key parameter is required' };
    await b.page.keyboard.up(params.key);
    return { ok: true, message: `Key up: ${params.key}` };
  },

  // ── Mouse ──────────────────────────────────────────────────────────────────

  async mouse_click(params) {
    const b = requireRunning();
    if (params.x === undefined || params.y === undefined) return { ok: false, error: 'x and y coordinates are required' };
    await b.page.mouse.click(params.x, params.y, {
      button: params.button || 'left',
      clickCount: params.click_count || 1,
    });
    return { ok: true, message: `Mouse clicked at (${params.x}, ${params.y})` };
  },

  async mouse_move(params) {
    const b = requireRunning();
    if (params.x === undefined || params.y === undefined) return { ok: false, error: 'x and y coordinates are required' };
    await b.page.mouse.move(params.x, params.y, { steps: params.steps || 1 });
    return { ok: true, message: `Mouse moved to (${params.x}, ${params.y})` };
  },

  async mouse_wheel(params) {
    const b = requireRunning();
    await b.page.mouse.wheel(params.delta_x || 0, params.delta_y || 0);
    return { ok: true, message: `Mouse wheel scrolled` };
  },
};

// ─── Frame resolution helper ────────────────────────────────────────────────

function resolveFrame(page, params) {
  if (params.frame_name) {
    const f = page.frame({ name: params.frame_name });
    if (!f) throw new Error(`No frame found with name "${params.frame_name}". Use the "frames" action to list available frames.`);
    return f;
  }
  if (params.frame_url) {
    const f = page.frame({ url: new RegExp(params.frame_url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    if (!f) throw new Error(`No frame found matching URL "${params.frame_url}". Use the "frames" action to list available frames.`);
    return f;
  }
  if (params.frame_index !== undefined) {
    const frames = page.frames();
    if (params.frame_index < 0 || params.frame_index >= frames.length) {
      throw new Error(`Invalid frame_index ${params.frame_index}. Available frames: ${frames.length}. Use the "frames" action to list them.`);
    }
    return frames[params.frame_index];
  }
  throw new Error('One of frame_name, frame_url, or frame_index is required for frame actions. Use "frames" to list available frames.');
}

// ─── Auto-detection helpers for login ────────────────────────────────────────

async function autoDetectField(page, candidates) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return sel;
  }
  return null;
}

async function autoDetectSubmit(page) {
  const candidates = ['button[type="submit"]', 'input[type="submit"]', 'form button'];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return sel;
  }
  // Try text-based detection
  const textPatterns = ['log in', 'login', 'sign in', 'submit', 'continue'];
  for (const text of textPatterns) {
    const loc = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
    if (await loc.isVisible().catch(() => false)) {
      return `role=button[name='${text}']`;
    }
  }
  return null;
}

async function autoDetectSignupSubmit(page) {
  const candidates = ['button[type="submit"]', 'input[type="submit"]', 'form button'];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return sel;
  }
  const textPatterns = ['sign up', 'signup', 'register', 'create account', 'get started', 'submit', 'continue'];
  for (const text of textPatterns) {
    const loc = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
    if (await loc.isVisible().catch(() => false)) {
      return `role=button[name='${text}']`;
    }
  }
  return null;
}

async function autoDetectApplyCoupon(page) {
  const textPatterns = ['apply', 'redeem'];
  for (const text of textPatterns) {
    const loc = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
    if (await loc.isVisible().catch(() => false)) {
      return `role=button[name='${text}']`;
    }
  }
  return null;
}

// ─── Build the action enum from the handlers ─────────────────────────────────
const actionNames = Object.keys(actions);

const browserTool = new Tool({
  name: 'Browser',
  description: `(LEGACY — prefer the split tools BrowserSession + BrowserPage + BrowserExtract for new work; they share the same singleton with smaller per-iteration schemas.) Control a Playwright-powered browser (visible by default). Start the browser first, then perform actions.

PROFILES — persistent logins and cookies across runs:
  - "profile_list" — list saved profiles.
  - "profile_create" / "profile_delete" — manage named profiles (params.profile). Stored under the app's userData dir.
  - "start" with params.profile="<name>" — launches Chromium with that profile attached. Cookies, localStorage, and service workers persist between sessions.
  - "profile_current" — report the active profile.

VAULT CREDENTIALS — King-Louie's vault is the source of truth for web logins. Chromium's own password manager is disabled.
  - "save_credentials" (params.profile?, params.host?, params.username, params.password) — encrypts and stores creds for a profile+host pair.
  - "fill_credentials" (params.profile?, params.host?, params.submit?) — retrieves and types creds into auto-detected (or explicit) username/password fields on the current page. Set submit:true to also click the submit button. Use this for FORM-BASED logins only.
  - "set_http_auth" (params.username+password OR params.profile+host to look up from vault) — for HTTP Basic auth (the native browser auth dialog, not a form). Call this BEFORE navigating. If the browser already popped the auth dialog and is showing a chrome-error page, call set_http_auth then reload or re-navigate. Signs: an OS-style popup appears instead of an HTML login form, or navigation lands on "chrome-error://chromewebdata/" with a 401.

PREFER high-level actions over manual "fill" + "click" sequences:
  - "login" — signs in with username + password. Auto-detects the username field (including type="text" with name="username", not just type="email"), password field, and submit button. Use this for ALL credentialed sign-ins instead of hand-rolling selectors like input[type='email'].
  - "signup" — registration forms (name + email + password + confirm).
  - "fill_payment" — credit card forms, including Stripe/Braintree iframes.
These handle selector variation across sites. Only fall back to manual fill/click when the high-level action fails or the flow is non-standard.

Selector strategies (pass as the "selector" parameter):
  - CSS:          "div.class" or "#id" (default)
  - Text:         "text=Login"
  - Role:         "role=button[name='Submit']"
  - Label:        "label=Email"
  - Placeholder:  "placeholder=Search..."
  - Test ID:      "testid=submit-btn"
  - XPath:        "xpath=//div[@id='app']"
  - Alt text:     "alt=Company logo"
  - Title:        "title=Close dialog"

All element actions auto-wait for the element to be actionable.
Use "frames" to list all iframes, "fill_in_frame"/"type_in_frame"/"click_in_frame"/"evaluate_in_frame" for direct iframe interaction.`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: actionNames,
        description: 'Action to perform.',
      },
      // Navigation
      url: { type: 'string', description: 'URL for navigate, login, open_tab, wait_for_url, get_cookies' },

      // Element selectors
      selector: { type: 'string', description: 'Element selector (CSS, text=, role=, label=, placeholder=, testid=, xpath=, alt=, title=)' },
      target_selector: { type: 'string', description: 'Target element selector for drag_and_drop' },

      // Text input
      text: { type: 'string', description: 'Text for fill, type, keyboard_type actions' },
      key: { type: 'string', description: 'Key for press, keyboard_down, keyboard_up (e.g. "Enter", "Tab", "Control+a", "Shift+ArrowDown")' },

      // Select options
      value: { type: 'string', description: 'Option value for select_option' },
      label: { type: 'string', description: 'Option label text for select_option' },
      index: { type: 'number', description: 'Option index for select_option' },

      // Element attributes
      attribute: { type: 'string', description: 'Attribute name for get_attribute' },

      // Mouse
      x: { type: 'number', description: 'X coordinate for mouse_click, mouse_move' },
      y: { type: 'number', description: 'Y coordinate for mouse_click, mouse_move' },
      button: { type: 'string', description: 'Mouse button: "left", "right", "middle"' },
      click_count: { type: 'number', description: 'Number of clicks (2 for double-click)' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Keyboard modifiers: ["Shift", "Control", "Alt", "Meta"]' },
      steps: { type: 'number', description: 'Steps for mouse_move interpolation' },
      delta_x: { type: 'number', description: 'Horizontal scroll delta for scroll/mouse_wheel' },
      delta_y: { type: 'number', description: 'Vertical scroll delta for scroll/mouse_wheel' },

      // Files
      files: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'File path(s) for set_input_files' },

      // JavaScript
      expression: { type: 'string', description: 'JavaScript expression for evaluate' },

      // Waiting
      state: { type: 'string', description: 'Wait state: "visible", "hidden", "attached", "detached" (wait_for) or "load", "domcontentloaded", "networkidle" (wait_for_load_state)' },
      timeout: { type: 'number', description: 'Timeout in ms (default varies by action)' },
      delay: { type: 'number', description: 'Typing delay in ms for type action (default 50)' },

      // Screenshot/PDF
      full_page: { type: 'boolean', description: 'Capture full scrollable page for screenshot (default false)' },
      format: { type: 'string', description: 'PDF paper format: "A4", "Letter", etc.' },

      // Tabs
      tab_index: { type: 'number', description: 'Tab index for switch_tab, close_tab' },

      // Network interception
      pattern: { type: 'string', description: 'URL pattern for route_block, route_fulfill, unroute (glob like "**/*.png")' },
      body: { type: 'string', description: 'Response body for route_fulfill' },
      status: { type: 'number', description: 'HTTP status code for route_fulfill' },
      content_type: { type: 'string', description: 'Content-Type header for route_fulfill' },

      // Login
      username: { type: 'string', description: 'Username/email for login' },
      password: { type: 'string', description: 'Password for login' },
      usernameSelector: { type: 'string', description: 'CSS selector for username input (auto-detected if omitted)' },
      passwordSelector: { type: 'string', description: 'CSS selector for password input (auto-detected if omitted)' },
      submitSelector: { type: 'string', description: 'CSS selector for submit button (auto-detected if omitted)' },

      // Storage state
      path: { type: 'string', description: 'File path for save_storage_state / load_storage_state' },

      // Dialog
      response: { type: 'string', description: 'Dialog response: "accept", "dismiss", or "prompt:your text"' },

      // Viewport
      width: { type: 'number', description: 'Viewport width for set_viewport' },
      height: { type: 'number', description: 'Viewport height for set_viewport' },

      // Signup params
      name: { type: 'string', description: 'Full name for signup action' },
      email: { type: 'string', description: 'Email for signup action' },
      confirmPassword: { type: 'string', description: 'Confirm password value (defaults to password if not provided)' },
      nameSelector: { type: 'string', description: 'CSS selector for name input (signup). Auto-detected if omitted.' },
      emailSelector: { type: 'string', description: 'CSS selector for email input (signup). Auto-detected if omitted.' },
      confirmPasswordSelector: { type: 'string', description: 'CSS selector for confirm password input (signup). Auto-detected if omitted.' },

      // Payment params
      cardNumber: { type: 'string', description: 'Credit card number for fill_payment' },
      cardExpiry: { type: 'string', description: 'Card expiry (MM/YY) for fill_payment' },
      cardCvc: { type: 'string', description: 'Card CVC/CVV for fill_payment' },
      cardName: { type: 'string', description: 'Name on card for fill_payment' },
      cardZip: { type: 'string', description: 'Billing zip/postal code for fill_payment' },
      couponCode: { type: 'string', description: 'Coupon/promo code to apply before payment' },
      cardNumberSelector: { type: 'string', description: 'CSS selector for card number input. Auto-detected if omitted.' },
      cardExpirySelector: { type: 'string', description: 'CSS selector for card expiry input. Auto-detected if omitted.' },
      cardCvcSelector: { type: 'string', description: 'CSS selector for card CVC input. Auto-detected if omitted.' },
      cardNameSelector: { type: 'string', description: 'CSS selector for cardholder name input. Auto-detected if omitted.' },
      cardZipSelector: { type: 'string', description: 'CSS selector for billing zip input. Auto-detected if omitted.' },
      couponSelector: { type: 'string', description: 'CSS selector for coupon input. Auto-detected if omitted.' },
      couponSubmitSelector: { type: 'string', description: 'CSS selector for apply coupon button. Auto-detected if omitted.' },

      // Frame params
      frame_name: { type: 'string', description: 'Frame name for *_in_frame actions. Use "frames" action to discover names.' },
      frame_url: { type: 'string', description: 'Frame URL substring for *_in_frame actions.' },
      frame_index: { type: 'number', description: 'Frame index for *_in_frame actions.' },

      // Start options
      userDataPath: { type: 'string', description: 'Raw Chrome user data directory (start action, advanced). Prefer "profile" — it resolves to a managed directory under the app\'s userData.' },
      profile: { type: 'string', description: 'Named persistent profile (used by start, profile_create, profile_delete, save_credentials, fill_credentials). Cookies/localStorage persist between runs. Allowed chars: [A-Za-z0-9_-], max 64.' },
      headless: { type: 'boolean', description: 'Run headless (default false — v1 defaults to visible so you can watch). Set true to hide the window.' },

      // Vault-backed credentials
      host: { type: 'string', description: 'Host to scope credentials to (save_credentials, fill_credentials). Defaults to the current page origin.' },
      submit: { type: 'boolean', description: 'After fill_credentials, click the submit button (or press Enter) to log in.' },
    },
    required: ['action'],
  },
  requiresApproval: true,
  execute: async (params, context) => {
    const handler = actions[params.action];
    if (!handler) {
      return { ok: false, error: `Unknown action: ${params.action}. Valid actions: ${actionNames.join(', ')}` };
    }
    try {
      return await handler(params, context);
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  },
});

// For testing — clean up singleton
browserTool._cleanup = async () => {
  if (pw) {
    await pw.stop();
    pw = null;
  }
};

// Exported so the split tools (BrowserSession/BrowserPage/BrowserExtract)
// can dispatch into the same action handlers + singleton without duplicating
// 1k lines of Playwright glue. The split tools narrow the schema (and thus
// per-iteration token cost) but route execution here.
module.exports = browserTool;
module.exports.actions = actions;
module.exports.actionNames = actionNames;
