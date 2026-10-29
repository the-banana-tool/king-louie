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
