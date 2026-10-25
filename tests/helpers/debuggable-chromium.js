// tests/helpers/debuggable-chromium.js
// Launches Playwright's bundled Chromium headless with a debugging port, as
// a take's Chrome is launched by another process, so a test can attach to it
// over CDP. Resolves to { child, port, cdpUrl, close() }; close() kills the
// process and removes its temporary profile. Never the network.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

// Whether Chromium's loopback /json/list names a page target yet.
function hasPage(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).some((t) => t.type === 'page')); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

// `waitForPage: false` returns as soon as the port is known, before
// Chromium lists its first tab (to test that attach() waits for it).
async function launchDebuggableChromium({ timeoutMs = 20000, waitForPage = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cdp-'));
  const child = spawn(chromium.executablePath(), [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run', `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' });

  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  }

  // DevToolsActivePort holds two lines: the port, then /devtools/browser/<uuid>.
  const file = path.join(dir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* not yet */ }
    // Wait for the about:blank tab too: attaching before Chromium lists it
    // would make attach() open a second page.
    if (lines.length >= 2 && (!waitForPage || await hasPage(Number(lines[0])))) {
      const port = Number(lines[0]);
      return { child, port, cdpUrl: `http://127.0.0.1:${port}`, close };
    }
    if (Date.now() > deadline) {
      await close();
      throw new Error('Chromium wrote no DevToolsActivePort');
    }
    // A ref'd timer keeps the event loop alive across the wait.
    await new Promise((r) => setTimeout(r, 100));
  }
}

module.exports = { launchDebuggableChromium };
