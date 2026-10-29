const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { createLogger } = require('../logging');
const { CHROME_FLAGS, IGNORED_DEFAULT_ARGS } = require('./chrome-flags');
const log = createLogger('playwright-browser');

/**
 * Write (or merge) a Chromium Preferences file into the profile dir that
 * disables the built-in password manager. King-Louie's vault is the single
 * source of truth for web credentials, so Chromium's own save-password
 * prompts just get in the way.
 *
 * Safe to call repeatedly; leaves unrelated prefs untouched.
 */
function disableChromiumPasswordManager(userDataPath) {
  try {
    const defaultDir = path.join(userDataPath, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });
    const prefsPath = path.join(defaultDir, 'Preferences');
    let prefs = {};
    if (fs.existsSync(prefsPath)) {
      try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch { prefs = {}; }
    }
    prefs.credentials_enable_service = false;
    prefs.profile = prefs.profile || {};
    prefs.profile.password_manager_enabled = false;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (err) {
    // Non-fatal: if we can't write prefs, the launch args below are still in effect.
    log.warn(`could not disable Chromium password manager: ${err.message}`);
  }
}


// ─── Snapshot refs (spec 2026-10-28 browser runner, §7) ─────────────────────
// Refs are Playwright's own (`page._snapshotForAI()`, the `aria-ref=` engine;
// C-5). A ref is a counter per document, so King Louie keeps a record per
// page only to say when one is stale: written by every snapshot, made stale
// by a main-frame navigation (same-document ones included).

const REF_ID = /^(?:f\d+)?e\d+$/;
// "aria-ref" anywhere in a selector, chained ("form >> aria-ref=e5") or not.
const RAW_ARIA_REF = /aria-ref\s*=/i;

/** A ref refusal: `code` is ref_stale, ref_not_found, ref_changed or invalid_params. */
class BrowserRefError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserRefError';
    this.code = code;
  }
}

// Reads one quoted JSON-style string starting at s[i] === '"'.
// → { value, end } (end is the index after the closing quote), or null.
function readQuoted(s, i) {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '"') {
      try { return { value: JSON.parse(s.slice(i, j + 1)), end: j + 1 }; } catch { return null; }
    }
    j += 1;
  }
  return null;
}

/**
 * Parse one line of an AI snapshot: `- role "name" [attr] [ref=eN]…`, the
 * key YAML single-quoted when it holds a special character. → `{ ref, role,
 * name, label }` (`label` is `role "name"`, or the role alone when the node
 * has no name), or null for a line it does not understand (no label; a ref
 * on such a line resolves to ref_not_found). The ref is read only after the
 * name, so a name that spells "[ref=e1]" is not taken for one.
 */
function parseSnapshotLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(/^\s*- (.*)$/);
  if (!m) return null;
  let rest = m[1];
  if (rest.startsWith("'")) {
    // A YAML single-quoted scalar: '' is a quote; the key ends at a lone '.
    let out = '';
    let i = 1;
    for (;;) {
      if (i >= rest.length) return null;
      if (rest[i] === "'") {
        if (rest[i + 1] === "'") { out += "'"; i += 2; continue; }
        break;
      }
      out += rest[i]; i += 1;
    }
    rest = out;
  }
  const roleMatch = rest.match(/^([a-z][a-zA-Z]*)/);
  if (!roleMatch) return null;
  const role = roleMatch[1];
  let i = role.length;
  let name = '';
  if (rest.startsWith(' "', i)) {
    const q = readQuoted(rest, i + 1);
    if (!q) return null;
    name = q.value;
    i = q.end;
  }
  // After the name: attributes in brackets, then an optional ":" and value.
  let ref = null;
  while (rest.startsWith(' [', i)) {
    const close = rest.indexOf(']', i + 2);
    if (close < 0) return null;
    const attr = rest.slice(i + 2, close);
    const r = attr.match(/^ref=(.+)$/);
    if (r && REF_ID.test(r[1])) ref = r[1];
    i = close + 1;
  }
  if (i < rest.length && rest[i] !== ':') return null;
  if (!ref) return null;
  return { ref, role, name, label: name ? `${role} "${name}"` : role };
}

const LINE_REF = /\[ref=((?:f\d+)?e\d+)\]/g;

/**
 * The ref a snapshot line carries: the parser's where it parses the line, else
 * the last `[ref=…]` on it (such a ref has no label, so it is listed and
 * counted but cannot be approved: ref_not_found). → the ref, or null.
 */
function snapshotLineRef(line) {
  const p = parseSnapshotLine(line);
  if (p) return p.ref;
  if (typeof line !== 'string') return null;
  const all = [...line.matchAll(LINE_REF)];
  return all.length ? all[all.length - 1][1] : null;
}

/** `ref=e5` → `e5`; anything else (a CSS selector, a raw aria-ref=) → null. */
function parseRefSelector(sel) {
  return typeof sel === 'string' && sel.startsWith('ref=') ? sel.slice(4) : null;
}

/** The *_in_frame actions, which take no ref. */
function isFrameAction(action) {
  return /_in_frame$/.test(String(action));
}

// page → { seq, labels: Map(ref → 'role "name"'), stale }
const refRecords = new WeakMap();
const watchedPages = new WeakSet();
// page → the PlaywrightBrowser driving it, so a selector resolved against a
// page can ask its browser about refs (set for every page it drives).
const pageOwners = new WeakMap();
let snapshotSeq = 0;

let installPromise = null;

function installChromium(onProgress) {
  if (installPromise) return installPromise;
  installPromise = new Promise((resolve, reject) => {
    const cliPath = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf) => { if (onProgress) onProgress(buf.toString()); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      installPromise = null;
      if (code === 0) resolve();
      else reject(new Error(`playwright install exited with code ${code}`));
    });
  });
  return installPromise;
}

function isMissingBrowserError(err) {
  const msg = err && err.message ? err.message : '';
  return msg.includes("Executable doesn't exist") || msg.includes('playwright install');
}

/**
 * Playwright-based browser manager.
 * Manages a single browser instance with context and page lifecycle.
 */
class PlaywrightBrowser {
  /**
   * @param {object} [opts]
   * @param {object} [opts.chromium] Playwright's chromium (injectable for tests)
   */
  constructor({ chromium } = {}) {
    this._chromium = chromium || require('playwright').chromium;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.consoleMessages = [];
    this._persistent = false; // Whether using persistent context
    this._attached = false; // Whether attached over CDP to a Chrome another process launched
    this._dialogAction = 'dismiss'; // 'accept', 'dismiss', or 'prompt:text'
    this._routes = [];
  }

  get isRunning() {
    if (this._persistent) return this.context !== null;
    return this.browser !== null && this.browser.isConnected();
  }

  async start(options = {}) {
    if (this.isRunning) return;

    const headless = options.headless !== false;
    // `viewport: null` lets the page take the window's own size.
    const viewport = options.viewport === undefined ? { width: 1280, height: 720 } : options.viewport;
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    const chromium = this._chromium;

    const launch = async ({ channel, executablePath } = {}) => {
      const base = {
        headless,
        args: [...CHROME_FLAGS, ...extraArgs],
        ignoreDefaultArgs: [...IGNORED_DEFAULT_ARGS],
      };
      if (executablePath) base.executablePath = executablePath;
      else if (channel) base.channel = channel;
      if (options.userDataPath) {
        disableChromiumPasswordManager(options.userDataPath);
        this._persistent = true;
        try {
          this.context = await chromium.launchPersistentContext(options.userDataPath, {
            ...base,
            viewport,
          });
        } catch (err) {
          this._persistent = false;
          throw err;
        }
        this.browser = null;
        this.page = this.context.pages()[0] || await this.context.newPage();
      } else {
        this._persistent = false;
        this.browser = await chromium.launch(base);
        this.context = await this.browser.newContext({ viewport });
        this.page = await this.context.newPage();
      }
    };

    if (options.executablePath) {
      // The caller named the binary: use it or fail. No bundled fallback and
      // no download.
      await launch({ executablePath: options.executablePath });
    } else {
      try {
        // Prefer the user's installed Chrome — avoids the ~280MB playwright download.
        await launch({ channel: 'chrome' });
      } catch (chromeErr) {
        try {
          await launch();
        } catch (bundledErr) {
          if (!isMissingBrowserError(bundledErr)) throw bundledErr;
          if (options.onInstallProgress) options.onInstallProgress('Downloading Chromium for browser automation…');
          await installChromium(options.onInstallProgress);
          await launch();
        }
      }
    }

    this._attachPageListeners(this.page);
  }

  /**
   * Attach over CDP to a Chromium someone else launched with a debugging
   * port (a take's Chrome, launched on the owner's screen by the session
   * helper). Drives its first context and first page.
   */
  async attach({ cdpUrl } = {}) {
    if (this.isRunning) return;
    if (!cdpUrl) throw new Error('attach requires cdpUrl');
    this.browser = await this._chromium.connectOverCDP(cdpUrl);
    this._persistent = false;
    this._attached = true;
    this.context = this.browser.contexts()[0];
    // A Chrome that has just started may not list its first tab yet: wait up
    // to 2 s for it (a ref'd timer) before opening a page of our own.
    const deadline = Date.now() + 2000;
    while (this.context.pages().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.page = this.context.pages()[0] || await this.context.newPage();
    this._attachPageListeners(this.page);
  }

  async stop() {
    // When attached, browser.close() disconnects Playwright only; the Chrome
    // process belongs to whoever launched it and keeps running.
    try {
      if (this._persistent && this.context) {
        await this.context.close();
      } else if (this.browser) {
        await this.browser.close();
      }
    } catch {
      // Browser may already be closed
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.consoleMessages = [];
    this._persistent = false;
    this._attached = false;
    this._routes = [];
  }

  _attachPageListeners(page) {
    pageOwners.set(page, this);
    page.on('console', (msg) => {
      this.consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
    });

    page.on('dialog', async (dialog) => {
      try {
        if (this._dialogAction === 'accept') {
          await dialog.accept();
        } else if (this._dialogAction.startsWith('prompt:')) {
          await dialog.accept(this._dialogAction.slice(7));
        } else {
          await dialog.dismiss();
        }
      } catch {
        // Dialog may have been handled already
      }
    });
  }

  /**
   * Get all pages/tabs in the current context.
   */
  async getPages() {
    const pages = this.context.pages();
    const result = [];
    for (let i = 0; i < pages.length; i++) {
      result.push({
        index: i,
        url: pages[i].url(),
        title: await pages[i].title().catch(() => ''),
        isCurrent: pages[i] === this.page,
      });
    }
    return result;
  }

  /**
   * Switch to a different page/tab by index.
   */
  switchToPage(index) {
    const pages = this.context.pages();
    if (index < 0 || index >= pages.length) {
      throw new Error(`Invalid tab index ${index}. Open tabs: ${pages.length}`);
    }
    this.page = pages[index];
    this._attachPageListeners(this.page);
    return true;
  }

  /**
   * Open a new tab and switch to it.
   */
  async newPage(url) {
    const page = await this.context.newPage();
    this._attachPageListeners(page);
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
    this.page = page;
    return page;
  }

  /**
   * Close a tab by index. Switches to the previous tab if closing current.
   */
  async closePage(index) {
    const pages = this.context.pages();
    if (index < 0 || index >= pages.length) {
      throw new Error(`Invalid tab index ${index}. Open tabs: ${pages.length}`);
    }
    const target = pages[index];
    const wasCurrent = target === this.page;
    await target.close();

    if (wasCurrent) {
      const remaining = this.context.pages();
      this.page = remaining.length > 0 ? remaining[Math.max(0, index - 1)] : null;
    }
  }

  // ── Snapshot refs ──────────────────────────────────────────────────────────

  /**
   * Take the current page's AI snapshot and record its refs (replacing the
   * page's record). → the full snapshot text.
   */
  async snapshot() {
    const page = this.page;
    const { full } = await page._snapshotForAI();
    const text = typeof full === 'string' ? full : '';
    const labels = new Map();
    for (const line of text.split('\n')) {
      const p = parseSnapshotLine(line);
      if (p) labels.set(p.ref, p.label);
    }
    snapshotSeq += 1;
    refRecords.set(page, { seq: snapshotSeq, labels, stale: false });
    if (!watchedPages.has(page)) {
      watchedPages.add(page);
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        const rec = refRecords.get(page);
        if (rec) rec.stale = true;
      });
    }
    return text;
  }

  /** The record of `page` (default: the current page), or null. */
  refRecord(page = this.page) {
    return (page && refRecords.get(page)) || null;
  }

  /** The label ('role "name"') the current page's live record holds for `ref`, or null. */
  refLabel(ref, page = this.page) {
    const rec = this.refRecord(page);
    if (!rec || rec.stale) return null;
    return rec.labels.get(ref) || null;
  }

  /**
   * The locator for `ref` on the current page, after the record's checks
   * (synchronous; throws BrowserRefError ref_stale / ref_not_found).
   */
  refLocator(ref) {
    if (!REF_ID.test(String(ref))) {
      throw new BrowserRefError('ref_not_found', `"${ref}" is not a ref. Refs look like e5 or f1e3 and come from a snapshot.`);
    }
    const page = this.page;
    const rec = page ? refRecords.get(page) : null;
    if (rec && rec.labels.has(ref)) {
      if (rec.stale) {
        throw new BrowserRefError('ref_stale', `ref=${ref} is stale: the page navigated since the snapshot. Take a new snapshot.`);
      }
      return page.locator(`aria-ref=${ref}`);
    }
    const pages = this.context ? this.context.pages() : [];
    if (pages.some((p) => p !== page && (refRecords.get(p)?.labels.has(ref)))) {
      throw new BrowserRefError('ref_stale', `ref=${ref} is from a snapshot of another tab. Switch back to that tab or take a new snapshot here.`);
    }
    throw new BrowserRefError('ref_not_found', `ref=${ref} is not in this page's last snapshot. Take a new snapshot.`);
  }

  /**
   * The label ('role "name"') `ref` has on the current page now, from a fresh
   * AI snapshot (the same computation the record's labels came from), or null
   * when the fresh snapshot has no such ref. Playwright keeps an element's
   * ref while its role and name stay the same and gives it a new one when
   * either changes, so a renamed element reads null or another label. The
   * record is left as it is: only the snapshot action writes it.
   */
  async currentRefLabel(ref) {
    const { full } = await this.page._snapshotForAI();
    for (const line of (typeof full === 'string' ? full : '').split('\n')) {
      const p = parseSnapshotLine(line);
      if (p && p.ref === ref) return p.label;
    }
    return null;
  }

  /**
   * Like refLocator, and also refuses ref_not_found when the element is no
   * longer in the page (the aria-ref engine finds nothing for it), so a
   * call does not wait out its timeout on an element that is gone.
   */
  async assertRefUsable(ref) {
    const loc = this.refLocator(ref);
    if (await loc.count() === 0) {
      throw new BrowserRefError('ref_not_found', `The element at ref=${ref} is gone from the page. Take a new snapshot.`);
    }
    return loc;
  }

  /**
   * Drain and return captured console messages.
   */
  drainConsole() {
    const msgs = [...this.consoleMessages];
    this.consoleMessages = [];
    return msgs;
  }
}

module.exports = PlaywrightBrowser;
module.exports.ownerOfPage = (page) => (page && pageOwners.get(page)) || null;
module.exports.BrowserRefError = BrowserRefError;
module.exports.parseSnapshotLine = parseSnapshotLine;
module.exports.REF_ID = REF_ID;
module.exports.RAW_ARIA_REF = RAW_ARIA_REF;
module.exports.snapshotLineRef = snapshotLineRef;
module.exports.parseRefSelector = parseRefSelector;
module.exports.isFrameAction = isFrameAction;
