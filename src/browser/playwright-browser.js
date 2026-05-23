const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { createLogger } = require('../logging');
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
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.consoleMessages = [];
    this._persistent = false; // Whether using persistent context
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
    const viewport = { width: 1280, height: 720 };
    const launchArgs = [
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--no-default-browser-check',
      // Suppress Chromium's built-in password manager / autofill prompts —
      // king-louie's vault is the source of truth.
      '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,PasswordManager',
    ];

    const launch = async (channel) => {
      const base = { headless, args: launchArgs };
      if (channel) base.channel = channel;
      if (options.userDataPath) {
        disableChromiumPasswordManager(options.userDataPath);
        this._persistent = true;
        this.context = await chromium.launchPersistentContext(options.userDataPath, {
          ...base,
          viewport,
        });
        this.browser = null;
        this.page = this.context.pages()[0] || await this.context.newPage();
      } else {
        this._persistent = false;
        this.browser = await chromium.launch(base);
        this.context = await this.browser.newContext({ viewport });
        this.page = await this.context.newPage();
      }
    };

    try {
      // Prefer the user's installed Chrome — avoids the ~280MB playwright download.
      await launch('chrome');
    } catch (chromeErr) {
      try {
        await launch(null);
      } catch (bundledErr) {
        if (!isMissingBrowserError(bundledErr)) throw bundledErr;
        if (options.onInstallProgress) options.onInstallProgress('Downloading Chromium for browser automation…');
        await installChromium(options.onInstallProgress);
        await launch(null);
      }
    }

    this._attachPageListeners(this.page);
  }

  async stop() {
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
