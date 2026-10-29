const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CHROME_FLAGS, IGNORED_DEFAULT_ARGS } = require('../src/browser/chrome-flags');
const PlaywrightBrowser = require('../src/browser/playwright-browser');

// A chromium stand-in that records every launch and hands back just enough
// of a context and page for PlaywrightBrowser#start to finish.
function stubChromium({ failLaunch } = {}) {
  const calls = [];
  const page = { on() {}, url: () => 'about:blank' };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    close: async () => {},
  };
  const record = (kind, opts, extra = {}) => {
    calls.push({ kind, opts, ...extra });
    if (failLaunch && failLaunch(kind, opts)) throw new Error('launch failed');
  };
  return {
    calls,
    async launchPersistentContext(dir, opts) {
      record('persistent', opts, { dir });
      return context;
    },
    async launch(opts) {
      record('launch', opts);
      return {
        isConnected: () => true,
        newContext: async (ctxOpts) => { calls.push({ kind: 'newContext', opts: ctxOpts }); return context; },
        close: async () => {},
      };
    },
  };
}

describe('chrome-flags', () => {
  it('lists the seven switches and drops only --enable-automation', () => {
    assert.deepStrictEqual([...CHROME_FLAGS], [
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,PasswordManager',
      '--disable-blink-features=AutomationControlled',
    ]);
    assert.deepStrictEqual([...IGNORED_DEFAULT_ARGS], ['--enable-automation']);
    assert.ok(Object.isFrozen(CHROME_FLAGS));
    assert.ok(Object.isFrozen(IGNORED_DEFAULT_ARGS));
  });

  it('has no requires', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'browser', 'chrome-flags.js'), 'utf8');
    assert.ok(!/\brequire\s*\(/.test(src));
  });
});

describe('PlaywrightBrowser launch options', () => {
  it('the non-persistent path passes the flags, the ignored default and extraArgs', async () => {
    const chromium = stubChromium();
    const b = new PlaywrightBrowser({ chromium });
    await b.start({ headless: true, extraArgs: ['--start-maximized'] });
    const launch = chromium.calls.find((c) => c.kind === 'launch');
    assert.deepStrictEqual(launch.opts.ignoreDefaultArgs, ['--enable-automation']);
    assert.deepStrictEqual(launch.opts.args, [...CHROME_FLAGS, '--start-maximized']);
    const ctx = chromium.calls.find((c) => c.kind === 'newContext');
    assert.deepStrictEqual(ctx.opts.viewport, { width: 1280, height: 720 });
  });

  it('the persistent path passes the flags, the ignored default, extraArgs and viewport null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-flags-'));
    try {
      const chromium = stubChromium();
      const b = new PlaywrightBrowser({ chromium });
      await b.start({ headless: true, userDataPath: dir, viewport: null, extraArgs: ['--start-maximized'] });
      const launch = chromium.calls.find((c) => c.kind === 'persistent');
      assert.strictEqual(launch.dir, dir);
      assert.deepStrictEqual(launch.opts.ignoreDefaultArgs, ['--enable-automation']);
      assert.deepStrictEqual(launch.opts.args, [...CHROME_FLAGS, '--start-maximized']);
      assert.ok('viewport' in launch.opts);
      assert.strictEqual(launch.opts.viewport, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('viewport null reaches newContext on the non-persistent path', async () => {
    const chromium = stubChromium();
    const b = new PlaywrightBrowser({ chromium });
    await b.start({ headless: true, viewport: null });
    const ctx = chromium.calls.find((c) => c.kind === 'newContext');
    assert.ok('viewport' in ctx.opts);
    assert.strictEqual(ctx.opts.viewport, null);
  });

  it('without extraArgs the args are exactly CHROME_FLAGS', async () => {
    const chromium = stubChromium();
    await new PlaywrightBrowser({ chromium }).start({ headless: true });
    assert.deepStrictEqual(chromium.calls[0].opts.args, [...CHROME_FLAGS]);
  });

  it('executablePath replaces channel', async () => {
    const chromium = stubChromium();
    await new PlaywrightBrowser({ chromium }).start({ headless: true, executablePath: '/opt/chrome/chrome' });
    const launches = chromium.calls.filter((c) => c.kind === 'launch');
    assert.strictEqual(launches.length, 1);
    assert.strictEqual(launches[0].opts.executablePath, '/opt/chrome/chrome');
    assert.ok(!('channel' in launches[0].opts));
  });

  it('a failing executablePath launch does not fall back to the bundled Chromium', async () => {
    const chromium = stubChromium({ failLaunch: () => true });
    const b = new PlaywrightBrowser({ chromium });
    await assert.rejects(b.start({ headless: true, executablePath: '/opt/chrome/chrome' }), /launch failed/);
    assert.strictEqual(chromium.calls.length, 1);
    assert.strictEqual(b.isRunning, false);
  });

  it('a failing executablePath persistent launch does not fall back either', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-flags-'));
    try {
      const chromium = stubChromium({ failLaunch: () => true });
      const b = new PlaywrightBrowser({ chromium });
      await assert.rejects(b.start({ headless: true, userDataPath: dir, executablePath: '/opt/chrome/chrome' }));
      assert.strictEqual(chromium.calls.length, 1);
      assert.strictEqual(b.isRunning, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without executablePath it tries channel chrome, then the bundled Chromium, both with the flags', async () => {
    const chromium = stubChromium({ failLaunch: (kind, opts) => opts.channel === 'chrome' });
    await new PlaywrightBrowser({ chromium }).start({ headless: true });
    const launches = chromium.calls.filter((c) => c.kind === 'launch');
    assert.strictEqual(launches.length, 2);
    assert.strictEqual(launches[0].opts.channel, 'chrome');
    assert.ok(!('channel' in launches[1].opts));
    for (const l of launches) {
      assert.deepStrictEqual(l.opts.ignoreDefaultArgs, ['--enable-automation']);
      assert.deepStrictEqual(l.opts.args, [...CHROME_FLAGS]);
    }
  });
});

describe('PlaywrightBrowser against real headless Chromium', () => {
  it('navigator.webdriver is false after start', async () => {
    const { chromium } = require('playwright');
    const b = new PlaywrightBrowser();
    try {
      await b.start({ headless: true, executablePath: chromium.executablePath() });
      assert.strictEqual(await b.page.evaluate(() => navigator.webdriver), false);
    } finally {
      await b.stop();
    }
  });
});
