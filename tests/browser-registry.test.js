const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PlaywrightBrowser = require('../src/browser/playwright-browser');
const {
  browserKeyOf, getBrowser, setBrowser, removeBrowser, activeProfileOf, setActiveProfile, reset,
} = require('../src/tools/builtin/browser-registry');

// Launch Playwright's bundled Chromium with a debugging port, the way the
// session helper will launch a take's Chrome, and read the port it chose.
async function launchDebuggableChromium() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cdp-'));
  const child = spawn(chromium.executablePath(), [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run', `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' });
  const file = path.join(dir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  for (;;) {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* not yet */ }
    if (lines.length >= 2) return { child, dir, port: Number(lines[0]) };
    if (Date.now() > deadline) { child.kill(); throw new Error('Chromium wrote no DevToolsActivePort'); }
    // A ref'd timer keeps the event loop alive across the wait.
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function killChromium(proc) {
  if (!proc) return;
  if (proc.child.exitCode === null && proc.child.signalCode === null) {
    const exited = new Promise((r) => proc.child.once('exit', r));
    proc.child.kill();
    await exited;
  }
  try { fs.rmSync(proc.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

describe('browser registry', () => {
  afterEach(() => reset());

  it('the key is the take policy\'s browserKey, else default', () => {
    assert.equal(browserKeyOf(undefined), 'default');
    assert.equal(browserKeyOf({}), 'default');
    assert.equal(browserKeyOf({ takePolicy: {} }), 'default');
    assert.equal(browserKeyOf({ takePolicy: { current: { browserKey: 'take:7' } } }), 'take:7');
  });

  it('two contexts resolve two browsers; the default is shared', () => {
    const a = getBrowser({});
    const b = getBrowser({ takePolicy: { current: { browserKey: 'take:1' } } });
    assert.notEqual(a, b);
    assert.equal(getBrowser({}), a);
    assert.ok(a instanceof PlaywrightBrowser);
  });

  it('setBrowser and removeBrowser place and drop a key\'s browser', () => {
    const ctx = { takePolicy: { current: { browserKey: 'take:2' } } };
    const mine = new PlaywrightBrowser();
    setBrowser('take:2', mine);
    assert.equal(getBrowser(ctx), mine);
    removeBrowser('take:2');
    assert.notEqual(getBrowser(ctx), mine);
  });

  it('the active profile is per key', () => {
    setActiveProfile('default', 'work');
    setActiveProfile('take:3', 'demo');
    assert.equal(activeProfileOf('default'), 'work');
    assert.equal(activeProfileOf('take:3'), 'demo');
    assert.equal(activeProfileOf('take:4'), null);
  });
});

describe('PlaywrightBrowser#attach', () => {
  let proc = null;
  before(async () => { proc = await launchDebuggableChromium(); });
  after(async () => { await killChromium(proc); });

  it('attach drives a Chromium launched with a debugging port', async () => {
    const b = new PlaywrightBrowser();
    await b.attach({ cdpUrl: `http://127.0.0.1:${proc.port}` });
    assert.equal(b.isRunning, true);
    await b.page.goto('about:blank');
    assert.equal((await b.getPages()).length, 1);
    await b.page.evaluate(() => console.log('attached hello'));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(b.drainConsole().some((m) => m.text === 'attached hello'), 'console handler installed');
    await b.stop();
    assert.equal(b.isRunning, false);
    assert.equal(proc.child.exitCode, null, 'the process is still alive');
  });
});
