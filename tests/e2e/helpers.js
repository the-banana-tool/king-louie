/**
 * E2E test harness for King Louie.
 *
 * Launches the real Electron app as a child process with a test bridge
 * injected in main.js. The bridge starts an HTTP server on a random port
 * and prints the port to stdout. Tests use HTTP to evaluate JS in the renderer.
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const APP_PATH = path.resolve(__dirname, '..', '..');

/**
 * Launch King Louie with the test bridge enabled.
 * Returns a context object used by all other helpers.
 */
async function launchApp() {
  const electronPath = require('electron');
  const bridgeScript = path.join(__dirname, '_bridge.js');

  const child = spawn(electronPath, [APP_PATH], {
    env: {
      ...process.env,
      KL_TEST_BRIDGE_PORT: '1', // truthy — bridge picks its own port via port 0
      KL_TEST_BRIDGE_SCRIPT: bridgeScript,
      KL_TEST_MODE: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // Read the port from stdout (bridge prints KL_BRIDGE_PORT=NNNNN)
  const bridgePort = await new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Bridge did not report port in time. stderr: ${stderr.slice(0, 500)}`));
    }, 25000);

    child.stdout.on('data', (d) => {
      buf += d.toString();
      const match = buf.match(/KL_BRIDGE_PORT=(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(parseInt(match[1], 10));
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`App exited with code ${code} before bridge ready. stderr: ${stderr.slice(0, 500)}`));
    });
  });

  // Verify the bridge is responsive
  await waitForBridge(bridgePort, 10000);

  return { child, bridgePort, closed: false };
}

/**
 * Close the Electron app cleanly.
 */
async function closeApp(ctx) {
  if (!ctx || ctx.closed) return;
  ctx.closed = true;
  try {
    await bridgeRequest(ctx.bridgePort, '/quit');
  } catch { /* Bridge may already be down */ }
  // Give it a moment, then force kill
  await new Promise((r) => setTimeout(r, 500));
  try { ctx.child.kill(); } catch { /* Already dead */ }
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * Evaluate JavaScript in the renderer process and return the result.
 */
async function evaluate(ctx, code) {
  const res = await bridgeRequest(ctx.bridgePort, '/eval', { code });
  if (res.error) throw new Error(res.error);
  return res.result;
}

/**
 * Wait for a condition (evaluated in the renderer) to become truthy.
 */
async function waitFor(ctx, code, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await evaluate(ctx, code);
      if (result) return result;
    } catch { /* May fail during load */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${code}`);
}

/**
 * Click an element by selector.
 */
async function click(ctx, selector) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector}');
      el.click();
      return true;
    })()
  `);
}

/**
 * Fill an input by selector.
 */
async function fill(ctx, selector, value) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector}');
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
}

/**
 * Get text content of an element.
 */
async function getText(ctx, selector) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.textContent : null;
    })()
  `);
}

/**
 * Get input value.
 */
async function getValue(ctx, selector) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.value : null;
    })()
  `);
}

/**
 * Check if an element is visible.
 */
async function isVisible(ctx, selector) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const style = getComputedStyle(el);
      return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden';
    })()
  `);
}

/**
 * Count elements matching a selector.
 */
async function count(ctx, selector) {
  return evaluate(ctx, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
}

// --- Internal helpers ---

async function waitForBridge(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await bridgeRequest(port, '/ping');
      if (res.ok) return true;
    } catch { /* Not ready yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Bridge timeout');
}

function bridgeRequest(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 10000
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Bridge request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

module.exports = {
  launchApp,
  closeApp,
  evaluate,
  waitFor,
  click,
  fill,
  getText,
  getValue,
  isVisible,
  count,
  APP_PATH
};
