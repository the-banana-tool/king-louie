const { Tool } = require('../tool-schema');
const { validateUrl } = require('./web-fetch-utils');
const PlaywrightBrowser = require('../../browser/playwright-browser');

// Singleton browser instance reused across tool calls
let pw = null;

function getPw() {
  if (!pw) pw = new PlaywrightBrowser();
  return pw;
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

  async start(params) {
    const b = getPw();
    if (b.isRunning) return { ok: true, message: 'Browser already running' };
    const opts = {};
    if (params.userDataPath) opts.userDataPath = params.userDataPath;
    if (params.headless !== undefined) opts.headless = params.headless;
    await b.start(opts);
    return { ok: true, message: 'Browser started (Playwright)' };
  },

  async stop() {
    const b = getPw();
    await b.stop();
    return { ok: true, message: 'Browser stopped' };
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
    const opts = {};
    if (params.button) opts.button = params.button; // 'left', 'right', 'middle'
    if (params.click_count) opts.clickCount = params.click_count;
    if (params.modifiers) opts.modifiers = params.modifiers; // ['Shift', 'Control', etc.]
    if (params.timeout) opts.timeout = params.timeout;
    await loc.click(opts);
    return { ok: true, message: `Clicked ${params.selector}` };
  },

  async dblclick(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.dblclick({ timeout: params.timeout || 5000 });
    return { ok: true, message: `Double-clicked ${params.selector}` };
  },

  async fill(params) {
    const b = requireRunning();
    if (params.text === undefined) return { ok: false, error: 'text parameter is required' };
    const loc = resolveLocator(b.page, params.selector);
    await loc.fill(params.text, { timeout: params.timeout || 5000 });
    return { ok: true, message: `Filled ${params.selector}` };
  },

  async type(params) {
    const b = requireRunning();
    if (params.text === undefined) return { ok: false, error: 'text parameter is required' };
    const loc = resolveLocator(b.page, params.selector);
    await loc.pressSequentially(params.text, {
      delay: params.delay || 50,
      timeout: params.timeout || 10000,
    });
    return { ok: true, message: `Typed into ${params.selector}` };
  },

  async press(params) {
    const b = requireRunning();
    if (!params.key) return { ok: false, error: 'key parameter is required (e.g. "Enter", "Tab", "Control+a")' };
    if (params.selector) {
      const loc = resolveLocator(b.page, params.selector);
      await loc.press(params.key, { timeout: params.timeout || 5000 });
    } else {
      await b.page.keyboard.press(params.key);
    }
    return { ok: true, message: `Pressed ${params.key}` };
  },

  async clear(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.clear({ timeout: params.timeout || 5000 });
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
    const selected = await loc.selectOption(selectArg, { timeout: params.timeout || 5000 });
    return { ok: true, selected };
  },

  async check(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.check({ timeout: params.timeout || 5000 });
    return { ok: true, message: `Checked ${params.selector}` };
  },

  async uncheck(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.uncheck({ timeout: params.timeout || 5000 });
    return { ok: true, message: `Unchecked ${params.selector}` };
  },

  async hover(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.hover({ timeout: params.timeout || 5000 });
    return { ok: true, message: `Hovered over ${params.selector}` };
  },

  async focus(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    await loc.focus({ timeout: params.timeout || 5000 });
    return { ok: true, message: `Focused ${params.selector}` };
  },

  async drag_and_drop(params) {
    const b = requireRunning();
    if (!params.target_selector) return { ok: false, error: 'target_selector parameter is required' };
    const source = resolveLocator(b.page, params.selector);
    const target = resolveLocator(b.page, params.target_selector);
    await source.dragTo(target, { timeout: params.timeout || 10000 });
    return { ok: true, message: `Dragged ${params.selector} to ${params.target_selector}` };
  },

  async set_input_files(params) {
    const b = requireRunning();
    if (!params.files) return { ok: false, error: 'files parameter is required (path string or array of paths)' };
    const loc = resolveLocator(b.page, params.selector);
    await loc.setInputFiles(params.files, { timeout: params.timeout || 5000 });
    return { ok: true, message: `Set files on ${params.selector}` };
  },

  async scroll(params) {
    const b = requireRunning();
    if (params.selector) {
      const loc = resolveLocator(b.page, params.selector);
      await loc.scrollIntoViewIfNeeded({ timeout: params.timeout || 5000 });
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
    const text = await loc.innerText({ timeout: params.timeout || 5000 });
    return { ok: true, text };
  },

  async get_attribute(params) {
    const b = requireRunning();
    if (!params.attribute) return { ok: false, error: 'attribute parameter is required' };
    const loc = resolveLocator(b.page, params.selector);
    const value = await loc.getAttribute(params.attribute, { timeout: params.timeout || 5000 });
    return { ok: true, value };
  },

  async get_value(params) {
    const b = requireRunning();
    const loc = resolveLocator(b.page, params.selector);
    const value = await loc.inputValue({ timeout: params.timeout || 5000 });
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
    const box = await loc.boundingBox({ timeout: params.timeout || 5000 });
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

  // ── Auth & state ───────────────────────────────────────────────────────────

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

// ─── Build the action enum from the handlers ─────────────────────────────────
const actionNames = Object.keys(actions);

const browserTool = new Tool({
  name: 'Browser',
  description: `Control a Playwright-powered headless browser. Start the browser first, then perform actions.

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
Use "login" to automatically fill credentials and sign in to websites.`,
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

      // Start options
      userDataPath: { type: 'string', description: 'Chrome user data directory (start action). Reuses saved logins/cookies.' },
      headless: { type: 'boolean', description: 'Run headless (default true). Set false to see the browser window.' },
    },
    required: ['action'],
  },
  requiresApproval: true,
  execute: async (params) => {
    const handler = actions[params.action];
    if (!handler) {
      return { ok: false, error: `Unknown action: ${params.action}. Valid actions: ${actionNames.join(', ')}` };
    }
    try {
      return await handler(params);
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

module.exports = browserTool;
