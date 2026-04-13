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
        enum: ['start', 'stop', 'status', 'tabs', 'open_tab', 'close_tab', 'navigate', 'screenshot', 'pdf', 'evaluate', 'click', 'type', 'wait_for', 'console', 'login', 'signup', 'fill_payment', 'frames', 'type_in_frame', 'click_in_frame', 'evaluate_in_frame'],
        description: 'Action to perform. Use "login" for sign-in, "signup" for registration forms, "fill_payment" for credit card/payment forms (supports Stripe/Braintree iframes), "frames" to list all iframes, "type_in_frame"/"click_in_frame"/"evaluate_in_frame" for direct iframe interaction.'
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
      headless: { type: 'boolean', description: 'Whether to run headless (default true). Set to false to see the browser window.' },
      // Signup action params
      name: { type: 'string', description: 'Full name for signup action' },
      email: { type: 'string', description: 'Email for signup action' },
      confirmPassword: { type: 'string', description: 'Confirm password value (defaults to password if not provided)' },
      nameSelector: { type: 'string', description: 'CSS selector for the name input (signup action). Auto-detected if not provided.' },
      emailSelector: { type: 'string', description: 'CSS selector for the email input (signup action). Auto-detected if not provided.' },
      confirmPasswordSelector: { type: 'string', description: 'CSS selector for the confirm password input (signup action). Auto-detected if not provided.' },
      // Fill payment action params
      cardNumber: { type: 'string', description: 'Credit card number for fill_payment action' },
      cardExpiry: { type: 'string', description: 'Card expiry (MM/YY) for fill_payment action' },
      cardCvc: { type: 'string', description: 'Card CVC/CVV for fill_payment action' },
      cardName: { type: 'string', description: 'Name on card for fill_payment action' },
      cardZip: { type: 'string', description: 'Billing zip/postal code for fill_payment action' },
      couponCode: { type: 'string', description: 'Coupon/promo code to apply before payment' },
      cardNumberSelector: { type: 'string', description: 'CSS selector for card number input. Auto-detected if not provided.' },
      cardExpirySelector: { type: 'string', description: 'CSS selector for card expiry input. Auto-detected if not provided.' },
      cardCvcSelector: { type: 'string', description: 'CSS selector for card CVC input. Auto-detected if not provided.' },
      cardNameSelector: { type: 'string', description: 'CSS selector for cardholder name input. Auto-detected if not provided.' },
      cardZipSelector: { type: 'string', description: 'CSS selector for billing zip input. Auto-detected if not provided.' },
      couponSelector: { type: 'string', description: 'CSS selector for coupon/promo code input. Auto-detected if not provided.' },
      couponSubmitSelector: { type: 'string', description: 'CSS selector for the apply coupon button. Auto-detected if not provided.' },
      // Iframe interaction params
      frameId: { type: 'string', description: 'Frame ID for type_in_frame, click_in_frame, evaluate_in_frame actions. Get frame IDs from the "frames" action.' }
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

          // Save to file instead of returning raw base64 (which bloats LLM context)
          const fs = require('fs');
          const os = require('os');
          const path = require('path');
          const screenshotDir = path.join(os.tmpdir(), 'king-louie-screenshots');
          if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
          const screenshotPath = path.join(screenshotDir, `screenshot-${Date.now()}.png`);
          fs.writeFileSync(screenshotPath, Buffer.from(data, 'base64'));

          // Extract visible page content so the agent can "see" what's on screen
          const pageInfo = await cdpClient.evaluate(`
            (() => {
              const url = window.location.href;
              const title = document.title;
              const bodyText = document.body ? document.body.innerText.substring(0, 3000) : '(empty)';
              const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 20).map(a => ({ text: a.textContent.trim().substring(0, 80), href: a.href })).filter(l => l.text);
              const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"]')).slice(0, 20).map(b => (b.textContent || b.value || '').trim().substring(0, 80)).filter(Boolean);
              const inputs = Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 20).map(i => ({ type: i.type || i.tagName.toLowerCase(), name: i.name || i.id || '', placeholder: i.placeholder || '' }));
              return { url, title, bodyText, links, buttons, inputs };
            })()
          `);

          return {
            ok: true,
            message: `Screenshot saved to ${screenshotPath}`,
            savedTo: screenshotPath,
            page: pageInfo
          };
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

        case 'signup': {
          if (!url) return { ok: false, error: 'url parameter is required for signup action' };
          await validateUrl(url);

          await cdpClient.navigate(url);
          await waitForPageReady(cdpClient, timeout || 15000);

          const fillField = async (sel, value) => {
            await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(sel)}'); if (el) { el.value = ''; el.focus(); } })()`);
            await cdpClient.type(sel, value);
            await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(sel)}'); if (el) { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } })()`);
          };

          const results = {};

          // Name field (optional — not all signup forms have it)
          if (params.name) {
            const nSel = params.nameSelector || await pollForSelector(cdpClient, [
              'input[name="name"]', 'input[name="full_name"]', 'input[name="fullName"]',
              'input[id="name"]', 'input[id="full-name"]', 'input[autocomplete="name"]',
              'input[name="first_name"]', 'input[placeholder*="name" i]'
            ], 8000);
            if (nSel) { await fillField(nSel, params.name); results.nameSelector = nSel; }
          }

          // Email field
          if (params.email || params.username) {
            const eSel = params.emailSelector || await pollForSelector(cdpClient, [
              'input[type="email"]', 'input[name="email"]', 'input[id="email"]',
              'input[autocomplete="email"]', 'input[name="username"]', 'input[id="username"]',
              'input[autocomplete="username"]', 'input[type="text"]'
            ], timeout || 15000);
            if (!eSel) return { ok: false, error: 'Could not find email/username input. Provide emailSelector.' };
            await fillField(eSel, params.email || params.username);
            results.emailSelector = eSel;
          }

          // Password field
          if (params.password) {
            const pSel = params.passwordSelector || await pollForSelector(cdpClient, [
              'input[type="password"]', 'input[name="password"]',
              'input[autocomplete="new-password"]'
            ], timeout || 15000);
            if (!pSel) return { ok: false, error: 'Could not find password input. Provide passwordSelector.' };
            await fillField(pSel, params.password);
            results.passwordSelector = pSel;

            // Confirm password (optional — only if a second password field exists)
            const cpSel = params.confirmPasswordSelector || await cdpClient.evaluate(`
              (() => {
                const pwFields = document.querySelectorAll('input[type="password"]');
                if (pwFields.length >= 2) {
                  const second = pwFields[1];
                  second.id = second.id || '__kl_confirm_pw_' + Math.random().toString(36).slice(2, 6);
                  return '#' + second.id;
                }
                // Also check for explicit confirm fields
                const confirmSels = [
                  'input[name="password_confirmation"]', 'input[name="confirmPassword"]',
                  'input[name="confirm_password"]', 'input[name="password2"]',
                  'input[autocomplete="new-password"]:nth-of-type(2)'
                ];
                for (const sel of confirmSels) {
                  const el = document.querySelector(sel);
                  if (el) return sel;
                }
                return null;
              })()
            `);
            if (cpSel) {
              await fillField(cpSel, params.confirmPassword || params.password);
              results.confirmPasswordSelector = cpSel;
            }
          }

          // Find and click submit
          const sSel = params.submitSelector || await cdpClient.evaluate(`
            (() => {
              const candidates = ['button[type="submit"]', 'input[type="submit"]', 'form button'];
              for (const sel of candidates) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) return sel;
              }
              const buttons = document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"]');
              for (const btn of buttons) {
                const txt = (btn.textContent || btn.value || '').toLowerCase();
                if (txt.includes('sign up') || txt.includes('signup') || txt.includes('register') || txt.includes('create account') || txt.includes('get started') || txt.includes('submit') || txt.includes('continue')) {
                  btn.id = btn.id || '__kl_signup_btn_' + Math.random().toString(36).slice(2, 6);
                  return '#' + btn.id;
                }
              }
              return null;
            })()
          `);

          if (sSel) {
            await cdpClient.click(sSel);
            results.submitSelector = sSel;
          }

          await waitForPageReady(cdpClient, 10000);
          const finalUrl = await cdpClient.evaluate('window.location.href');

          return { ok: true, message: `Signup attempted at ${url}`, currentUrl: finalUrl, ...results };
        }

        case 'fill_payment': {
          // Apply coupon first if provided
          if (params.couponCode) {
            const couponSel = params.couponSelector || await pollForSelector(cdpClient, [
              'input[name="coupon"]', 'input[name="coupon_code"]', 'input[name="couponCode"]',
              'input[name="promo"]', 'input[name="promo_code"]', 'input[name="promoCode"]',
              'input[name="discount"]', 'input[name="discount_code"]',
              'input[id="coupon"]', 'input[id="promo"]', 'input[id="coupon-code"]',
              'input[id="promo-code"]', 'input[id="discount-code"]',
              'input[placeholder*="coupon" i]', 'input[placeholder*="promo" i]',
              'input[placeholder*="discount" i]', 'input[name="code"]'
            ], 5000);

            if (couponSel) {
              await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(couponSel)}'); if (el) { el.value = ''; el.focus(); } })()`);
              await cdpClient.type(couponSel, params.couponCode);
              await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(couponSel)}'); if (el) { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } })()`);

              // Click apply button
              const applySel = params.couponSubmitSelector || await cdpClient.evaluate(`
                (() => {
                  const buttons = document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"]');
                  for (const btn of buttons) {
                    const txt = (btn.textContent || btn.value || '').toLowerCase();
                    if (txt.includes('apply') || txt.includes('redeem')) {
                      btn.id = btn.id || '__kl_apply_btn_' + Math.random().toString(36).slice(2, 6);
                      return '#' + btn.id;
                    }
                  }
                  return null;
                })()
              `);
              if (applySel) {
                await cdpClient.click(applySel);
                await new Promise((r) => setTimeout(r, 2000)); // wait for coupon validation
              }
            }
          }

          // Detect if payment fields are in an iframe (Stripe, Braintree, etc.)
          const paymentFrameInfo = await cdpClient.evaluate(`
            (() => {
              const iframes = document.querySelectorAll('iframe');
              for (const iframe of iframes) {
                const src = iframe.src || '';
                const name = iframe.name || '';
                if (src.includes('stripe.com') || src.includes('braintree') || src.includes('recurly') ||
                    src.includes('chargebee') || src.includes('paddle') ||
                    name.includes('__privateStripeFrame') || name.includes('braintree') ||
                    src.includes('checkout') || src.includes('payment')) {
                  return { isIframe: true, src, name, id: iframe.id || '' };
                }
              }
              // Check if card inputs exist in main frame
              const cardInput = document.querySelector('input[name="cardnumber"], input[name="card_number"], input[name="cc-number"], input[autocomplete="cc-number"], input[data-stripe="number"]');
              return { isIframe: false, hasMainFrameInputs: !!cardInput };
            })()
          `);

          const results = { paymentFrameDetected: paymentFrameInfo };

          if (paymentFrameInfo.isIframe) {
            // Payment form is in an iframe — find the frame IDs
            const frames = await cdpClient.getFrames();
            const paymentFrames = frames.filter((f) =>
              f.url.includes('stripe.com') || f.url.includes('braintree') ||
              f.url.includes('recurly') || f.url.includes('chargebee') ||
              f.url.includes('paddle') || f.url.includes('checkout') ||
              f.url.includes('payment') || f.name.includes('privateStripeFrame')
            );

            if (paymentFrames.length === 0) {
              return { ok: false, error: 'Detected payment iframe but could not find frame ID. Use "frames" action to list all frames and try type_in_frame manually.', paymentFrameInfo };
            }

            // Stripe uses separate iframes for each field — try to match them
            const fieldAttempts = [];

            for (const frame of paymentFrames) {
              const frameName = frame.name.toLowerCase();
              const frameUrl = frame.url.toLowerCase();

              try {
                if ((frameName.includes('number') || frameUrl.includes('number') || paymentFrames.length === 1) && params.cardNumber) {
                  const numSel = await cdpClient.evaluateInFrame(frame.frameId, `
                    (() => {
                      const el = document.querySelector('input[name="cardnumber"], input[name="card-number"], input[autocomplete="cc-number"], input[name="number"], input[type="tel"], input');
                      return el ? (el.name || el.id || 'input') : null;
                    })()
                  `);
                  if (numSel) {
                    const sel = numSel === 'input' ? 'input' : `input[name="${numSel}"], input[id="${numSel}"], input`;
                    await cdpClient.typeInFrame(frame.frameId, sel, params.cardNumber);
                    fieldAttempts.push({ field: 'cardNumber', frameId: frame.frameId, status: 'filled' });
                  }
                }

                if ((frameName.includes('expir') || frameUrl.includes('expir')) && params.cardExpiry) {
                  await cdpClient.typeInFrame(frame.frameId, 'input', params.cardExpiry);
                  fieldAttempts.push({ field: 'cardExpiry', frameId: frame.frameId, status: 'filled' });
                }

                if ((frameName.includes('cvc') || frameName.includes('cvv') || frameUrl.includes('cvc') || frameUrl.includes('cvv')) && params.cardCvc) {
                  await cdpClient.typeInFrame(frame.frameId, 'input', params.cardCvc);
                  fieldAttempts.push({ field: 'cardCvc', frameId: frame.frameId, status: 'filled' });
                }

                if ((frameName.includes('postal') || frameName.includes('zip') || frameUrl.includes('postal') || frameUrl.includes('zip')) && params.cardZip) {
                  await cdpClient.typeInFrame(frame.frameId, 'input', params.cardZip);
                  fieldAttempts.push({ field: 'cardZip', frameId: frame.frameId, status: 'filled' });
                }
              } catch (frameErr) {
                fieldAttempts.push({ field: 'unknown', frameId: frame.frameId, status: 'error', error: frameErr.message });
              }
            }

            // Handle cardholder name in main frame (Stripe puts this outside the iframe)
            if (params.cardName) {
              const nameSel = params.cardNameSelector || await pollForSelector(cdpClient, [
                'input[name="name"]', 'input[name="cardholder"]', 'input[name="cardholder-name"]',
                'input[name="card-name"]', 'input[autocomplete="cc-name"]',
                'input[id="cardholder-name"]', 'input[placeholder*="name on card" i]',
                'input[placeholder*="cardholder" i]'
              ], 3000);
              if (nameSel) {
                await cdpClient.type(nameSel, params.cardName);
                fieldAttempts.push({ field: 'cardName', location: 'main_frame', status: 'filled' });
              }
            }

            results.iframeFields = fieldAttempts;
            results.paymentFrames = paymentFrames.map((f) => ({ frameId: f.frameId, name: f.name, url: f.url }));
          } else {
            // Payment fields are in the main frame — fill directly
            const fillField = async (sel, value) => {
              await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(sel)}'); if (el) { el.value = ''; el.focus(); } })()`);
              await cdpClient.type(sel, value);
              await cdpClient.evaluate(`(() => { const el = document.querySelector('${escapeSel(sel)}'); if (el) { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } })()`);
            };

            if (params.cardNumber) {
              const sel = params.cardNumberSelector || await pollForSelector(cdpClient, [
                'input[name="cardnumber"]', 'input[name="card_number"]', 'input[name="cc-number"]',
                'input[autocomplete="cc-number"]', 'input[data-stripe="number"]',
                'input[id="card-number"]', 'input[placeholder*="card number" i]'
              ], 8000);
              if (sel) { await fillField(sel, params.cardNumber); results.cardNumberSelector = sel; }
            }

            if (params.cardExpiry) {
              const sel = params.cardExpirySelector || await pollForSelector(cdpClient, [
                'input[name="exp-date"]', 'input[name="expiry"]', 'input[name="cc-exp"]',
                'input[autocomplete="cc-exp"]', 'input[data-stripe="exp"]',
                'input[placeholder*="MM" i]', 'input[name="expiration"]'
              ], 5000);
              if (sel) { await fillField(sel, params.cardExpiry); results.cardExpirySelector = sel; }
            }

            if (params.cardCvc) {
              const sel = params.cardCvcSelector || await pollForSelector(cdpClient, [
                'input[name="cvc"]', 'input[name="cvv"]', 'input[name="cc-csc"]',
                'input[autocomplete="cc-csc"]', 'input[data-stripe="cvc"]',
                'input[placeholder*="CVC" i]', 'input[placeholder*="CVV" i]'
              ], 5000);
              if (sel) { await fillField(sel, params.cardCvc); results.cardCvcSelector = sel; }
            }

            if (params.cardName) {
              const sel = params.cardNameSelector || await pollForSelector(cdpClient, [
                'input[name="ccname"]', 'input[name="cc-name"]', 'input[autocomplete="cc-name"]',
                'input[name="cardholder"]', 'input[placeholder*="name on card" i]'
              ], 3000);
              if (sel) { await fillField(sel, params.cardName); results.cardNameSelector = sel; }
            }

            if (params.cardZip) {
              const sel = params.cardZipSelector || await pollForSelector(cdpClient, [
                'input[name="postal"]', 'input[name="zip"]', 'input[name="billing_zip"]',
                'input[autocomplete="postal-code"]', 'input[placeholder*="zip" i]',
                'input[placeholder*="postal" i]'
              ], 3000);
              if (sel) { await fillField(sel, params.cardZip); results.cardZipSelector = sel; }
            }
          }

          return { ok: true, message: 'Payment form filled', ...results };
        }

        case 'frames': {
          const frames = await cdpClient.getFrames();
          return { ok: true, frames };
        }

        case 'type_in_frame': {
          if (!params.frameId) return { ok: false, error: 'frameId parameter is required for type_in_frame action' };
          if (!selector) return { ok: false, error: 'selector parameter is required for type_in_frame action' };
          if (text === undefined) return { ok: false, error: 'text parameter is required for type_in_frame action' };
          await cdpClient.typeInFrame(params.frameId, selector, text);
          return { ok: true, message: `Typed text into ${selector} in frame ${params.frameId}` };
        }

        case 'click_in_frame': {
          if (!params.frameId) return { ok: false, error: 'frameId parameter is required for click_in_frame action' };
          if (!selector) return { ok: false, error: 'selector parameter is required for click_in_frame action' };
          await cdpClient.clickInFrame(params.frameId, selector);
          return { ok: true, message: `Clicked ${selector} in frame ${params.frameId}` };
        }

        case 'evaluate_in_frame': {
          if (!params.frameId) return { ok: false, error: 'frameId parameter is required for evaluate_in_frame action' };
          if (!expression) return { ok: false, error: 'expression parameter is required for evaluate_in_frame action' };
          const result = await cdpClient.evaluateInFrame(params.frameId, expression);
          return { ok: true, result };
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
