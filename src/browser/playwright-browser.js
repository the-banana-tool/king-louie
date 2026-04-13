const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

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
    ];

    if (options.userDataPath) {
      // Persistent context: preserves cookies, localStorage, login sessions
      this._persistent = true;
      this.context = await chromium.launchPersistentContext(options.userDataPath, {
        headless,
        viewport,
        args: launchArgs,
      });
      this.browser = null;
      this.page = this.context.pages()[0] || await this.context.newPage();
    } else {
      this._persistent = false;
      this.browser = await chromium.launch({ headless, args: launchArgs });
      this.context = await this.browser.newContext({ viewport });
      this.page = await this.context.newPage();
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
