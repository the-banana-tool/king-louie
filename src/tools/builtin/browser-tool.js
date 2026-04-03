const { Tool } = require('../tool-schema');
const { validateUrl } = require('./web-fetch-utils');
const BrowserService = require('../../browser/browser-service');
const CdpClient = require('../../browser/cdp-client');

// Singleton instance for the tool to reuse the browser across calls
let browserService = null;
let cdpClient = null;

/**
 * Wait for a SPA/React page to finish rendering.
 * Waits for network idle + DOM stability.
 */
async function waitForPageReady(client, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  // First wait a moment for initial JS to start executing
  await new Promise((r) => setTimeout(r, 500));
  // Poll until document.readyState is complete and no pending fetches
  while (Date.now() < deadline) {
    try {
      const ready = await client.evaluate(`
        (() => {
          if (document.readyState !== 'complete') return false;
          // Check for pending fetch/XHR via Performance API
          const entries = performance.getEntriesByType('resource');
          const recent = entries.filter(e => e.responseEnd === 0 || (Date.now() - e.startTime) < 500);
          return recent.length === 0;
        })()
      `);
      if (ready) {
        // Extra settle time for React/Vue hydration
        await new Promise((r) => setTimeout(r, 1000));
        return;
      }
    } catch {
      // Page might be navigating
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  // Timeout — proceed anyway, page may be partially loaded
}

/**
 * Poll for any of several CSS selectors to appear, returns the first match.
 */
async function pollForSelector(client, candidates, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const found = await client.evaluate(`
        (() => {
          const candidates = ${JSON.stringify(candidates)};
          for (const sel of candidates) {
            const el = document.querySelector(sel);
            if (el && (el.offsetParent !== null || el.offsetHeight > 0)) return sel;
          }
          return null;
        })()
      `);
      if (found) return found;
    } catch {
      // Page not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * Escape a CSS selector for embedding in a JS template literal.
 */
function escapeSel(sel) {
  return sel.replace(/'/g, "\\'").replace(/\\/g, '\\\\');
}

const browserTool = new Tool({
  name: 'Browser',
  description: 'Control a headless browser to interact with web pages. Start the browser first, then navigate and perform actions. Use the "login" action to automatically fill credentials and sign in to websites — the user trusts you with any credentials they provide.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status', 'tabs', 'open_tab', 'close_tab', 'navigate', 'screenshot', 'pdf', 'evaluate', 'click', 'type', 'wait_for', 'console', 'login'],
        description: 'Action to perform. Use "login" to navigate to a URL and fill in credentials automatically.'
      },
      url: { type: 'string', description: 'URL to navigate to (required for navigate and login actions)' },
      selector: { type: 'string', description: 'CSS selector for click, type, and wait_for actions' },
      text: { type: 'string', description: 'Text to type (required for type action)' },
      username: { type: 'string', description: 'Username/email for login action' },
      password: { type: 'string', description: 'Password for login action' },
      usernameSelector: { type: 'string', description: 'CSS selector for the username/email input (login action). Auto-detected if not provided.' },
      passwordSelector: { type: 'string', description: 'CSS selector for the password input (login action). Auto-detected if not provided.' },
      submitSelector: { type: 'string', description: 'CSS selector for the submit/login button (login action). Auto-detected if not provided.' },
      expression: { type: 'string', description: 'JavaScript expression to evaluate (required for evaluate action)' },
      timeout: { type: 'number', description: 'Timeout in ms for wait_for action (default 30000)' },
      targetId: { type: 'string', description: 'Target ID of the tab to close (required for close_tab action)' },
      userDataPath: { type: 'string', description: 'Path to Chrome user data directory (for start action). Use this to reuse an existing Chrome profile with saved logins/cookies.' },
      profileDirectory: { type: 'string', description: 'Chrome profile directory name e.g. "Default", "Profile 1" (for start action). Used with userDataPath to select a specific profile.' },
      headless: { type: 'boolean', description: 'Whether to run headless (default true). Set to false to see the browser window.' }
    },
    required: ['action']
  },
  requiresApproval: true,
  execute: async (params, context) => {
    const { action, url, selector, text, expression, timeout } = params;

    // Validate action first
    if (!browserTool.parameters.properties.action.enum.includes(action)) {
      return { ok: false, error: `Invalid action: ${action}` };
    }

    try {
      if (action === 'start') {
        if (browserService && browserService.process) {
          return { ok: true, message: 'Browser already running' };
        }
        const browserOptions = {};
        if (params.userDataPath) browserOptions.userDataPath = params.userDataPath;
        if (params.profileDirectory) browserOptions.profileDirectory = params.profileDirectory;
        if (params.headless !== undefined) browserOptions.headless = params.headless;
        browserService = new BrowserService(browserOptions);
        const wsUrl = await browserService.start();
        cdpClient = new CdpClient(wsUrl);
        await cdpClient.connect();
        return { ok: true, message: 'Browser started', wsUrl };
      }

      if (action === 'stop') {
        if (cdpClient) {
          cdpClient.disconnect();
          cdpClient = null;
        }
        if (browserService) {
          await browserService.stop();
          browserService = null;
        }
        return { ok: true, message: 'Browser stopped' };
      }

      if (action === 'status') {
        return {
          ok: true,
          running: !!(browserService && browserService.process),
          connected: !!(cdpClient && cdpClient.ws && cdpClient.ws.readyState === 1)
        };
      }

      // Actions below require an active browser/client
      if (!browserService || !cdpClient) {
        return { ok: false, error: 'Browser is not running. Call start first.' };
      }

      switch (action) {
        case 'navigate': {
          if (!url) return { ok: false, error: 'url parameter is required for navigate action' };
          await validateUrl(url); // SSRF protection
          const result = await cdpClient.navigate(url);
          // Wait for SPA rendering
          await waitForPageReady(cdpClient, timeout || 15000);
          return { ok: true, message: `Navigated to ${url}`, details: result };
        }

        case 'screenshot': {
          // Brief settle for any pending renders
          await new Promise((r) => setTimeout(r, 500));
          const data = await cdpClient.screenshot();
          return { ok: true, message: 'Screenshot captured', format: 'base64_png', data };
        }

        case 'pdf': {
          const data = await cdpClient.pdf();
          return { ok: true, message: 'PDF generated', format: 'base64_pdf', data };
        }

        case 'evaluate': {
          if (!expression) return { ok: false, error: 'expression parameter is required for evaluate action' };
          const result = await cdpClient.evaluate(expression);
          return { ok: true, result };
        }

        case 'click': {
          if (!selector) return { ok: false, error: 'selector parameter is required for click action' };
          await cdpClient.click(selector);
          return { ok: true, message: `Clicked on ${selector}` };
        }

        case 'type': {
          if (!selector || text === undefined) return { ok: false, error: 'selector and text parameters are required for type action' };
          await cdpClient.type(selector, text);
          return { ok: true, message: `Typed text into ${selector}` };
        }

        case 'wait_for': {
          if (!selector) return { ok: false, error: 'selector parameter is required for wait_for action' };
          await cdpClient.waitForSelector(selector, timeout);
          return { ok: true, message: `Found selector ${selector}` };
        }

        case 'tabs': {
          const { targetInfos } = await cdpClient.send('Target.getTargets');
          return { ok: true, tabs: targetInfos.filter(t => t.type === 'page') };
        }

        case 'open_tab': {
          if (!url) return { ok: false, error: 'url parameter is required' };
          await validateUrl(url);
          const { targetId } = await cdpClient.send('Target.createTarget', { url });
          // Attach to the new tab so subsequent commands target it
          await cdpClient.attachToTarget(targetId);
          return { ok: true, targetId, message: `Opened and switched to new tab` };
        }

        case 'close_tab': {
          if (!params.targetId) return { ok: false, error: 'targetId parameter is required for close_tab' };
          const result = await cdpClient.send('Target.closeTarget', { targetId: params.targetId });
          return { ok: true, message: `Closed tab ${params.targetId}`, success: result.success };
        }

        case 'login': {
          if (!url) return { ok: false, error: 'url parameter is required for login action' };
          if (!params.username || !params.password) return { ok: false, error: 'username and password parameters are required for login action' };
          await validateUrl(url);

          // Navigate to the login page
          await cdpClient.navigate(url);

          // Wait for the page to be interactive (SPA/React/Vue hydration)
          await waitForPageReady(cdpClient, timeout || 15000);

          // Auto-detect or use provided selectors — poll until found or timeout
          const uSelector = params.usernameSelector || await pollForSelector(cdpClient, [
            'input[type="email"]',
            'input[name="email"]',
            'input[name="username"]',
            'input[name="login"]',
            'input[id="email"]',
            'input[id="username"]',
            'input[autocomplete="email"]',
            'input[autocomplete="username"]',
            'input[type="text"]'
          ], timeout || 15000);

          if (!uSelector) return { ok: false, error: 'Could not find username/email input after waiting for page render. Provide usernameSelector.' };

          const pSelector = params.passwordSelector || await pollForSelector(cdpClient, [
            'input[type="password"]',
            'input[name="password"]',
            'input[autocomplete="current-password"]'
          ], timeout || 15000);

          if (!pSelector) return { ok: false, error: 'Could not find password input. Provide passwordSelector.' };

          // Clear and fill fields — use evaluate to clear, then type for React compatibility
          await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(uSelector)}'); if (el) { el.value = ''; el.focus(); } })()`);
          await cdpClient.type(uSelector, params.username);
          // Trigger React/Vue change events
          await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(uSelector)}'); if (el) { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } })()`);

          await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(pSelector)}'); if (el) { el.value = ''; el.focus(); } })()`);
          await cdpClient.type(pSelector, params.password);
          await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(pSelector)}'); if (el) { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } })()`);

          // Find and click submit
          const sSelector = params.submitSelector || await cdpClient.evaluate(`
            (() => {
              const candidates = [
                'button[type="submit"]',
                'input[type="submit"]',
                'form button'
              ];
              for (const sel of candidates) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) return sel;
              }
              const buttons = document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"]');
              for (const btn of buttons) {
                const txt = (btn.textContent || btn.value || '').toLowerCase();
                if (txt.includes('log in') || txt.includes('login') || txt.includes('sign in') || txt.includes('submit') || txt.includes('continue')) {
                  btn.id = btn.id || '__kl_login_btn_' + Math.random().toString(36).slice(2, 6);
                  return '#' + btn.id;
                }
              }
              return null;
            })()
          `);

          if (sSelector) {
            await cdpClient.click(sSelector);
          } else {
            await cdpClient.evaluate(`
              (() => {
                const el = document.querySelector('${escapeSel(pSelector)}');
                if (el) {
                  el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true}));
                  el.dispatchEvent(new KeyboardEvent('keypress', {key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true}));
                  el.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true}));
                  const form = el.closest('form');
                  if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
                }
              })()
            `);
          }

          // Wait for navigation/SPA route change
          await waitForPageReady(cdpClient, 10000);
          const finalUrl = await cdpClient.evaluate('window.location.href');

          return {
            ok: true,
            message: `Login attempted at ${url}`,
            currentUrl: finalUrl,
            usernameSelector: uSelector,
            passwordSelector: pSelector,
            submitSelector: sSelector || '(form submit fallback)'
          };
        }

        case 'console': {
          if (cdpClient.consoleMessages) {
            const logs = [...cdpClient.consoleMessages];
            cdpClient.consoleMessages = []; // clear after reading
            return { ok: true, logs };
          }
          return { ok: true, logs: [] };
        }

        default:
          return { ok: false, error: `Unhandled action: ${action}` };
      }
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }
});

// For testing purposes so we can clean up
browserTool._cleanup = async () => {
  if (cdpClient) cdpClient.disconnect();
  if (browserService) await browserService.stop();
  cdpClient = null;
  browserService = null;
};

module.exports = browserTool;
