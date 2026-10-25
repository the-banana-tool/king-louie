const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const PlaywrightBrowser = require('../src/browser/playwright-browser');
const {
  browserKeyOf, getBrowser, setBrowser, removeBrowser, activeProfileOf, setActiveProfile, reset,
} = require('../src/tools/builtin/browser-registry');
const { launchDebuggableChromium } = require('./helpers/debuggable-chromium');

describe('browser registry', () => {
  afterEach(() => reset());

  it('the key is the take policy\'s browserKey, else default', () => {
    assert.equal(browserKeyOf(undefined), 'default');
    assert.equal(browserKeyOf({}), 'default');
    assert.equal(browserKeyOf({ takePolicy: {} }), 'default');
    assert.equal(browserKeyOf({ takePolicy: { current: { browserKey: 'take:7' } } }), 'take:7');
  });

  it('two contexts resolve two browsers; the default is shared', () => {
    const takeBrowser = new PlaywrightBrowser();
    setBrowser('take:1', takeBrowser);
    const a = getBrowser({});
    assert.ok(a instanceof PlaywrightBrowser);
    assert.notEqual(a, takeBrowser);
    assert.equal(getBrowser({ takePolicy: { current: { browserKey: 'take:1' } } }), takeBrowser);
    assert.equal(getBrowser({}), a);
    assert.equal(getBrowser({ takePolicy: { current: { browserKey: 'take:9' } } }), a,
      'a take key with no browser registered resolves to the default');
  });

  it('removeBrowser drops a key\'s browser back to the default', () => {
    const ctx = { takePolicy: { current: { browserKey: 'take:2' } } };
    const mine = new PlaywrightBrowser();
    setBrowser('take:2', mine);
    assert.equal(getBrowser(ctx), mine);
    removeBrowser('take:2');
    assert.equal(getBrowser(ctx), getBrowser({}));
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
  let chrome = null;
  before(async () => { chrome = await launchDebuggableChromium(); });
  after(async () => { if (chrome) await chrome.close(); });

  it('attach drives a Chromium launched with a debugging port', async () => {
    const b = new PlaywrightBrowser();
    await b.attach({ cdpUrl: `http://127.0.0.1:${chrome.port}` });
    assert.equal(b.isRunning, true);
    await b.page.goto('about:blank');
    assert.equal((await b.getPages()).length, 1);
    await b.page.evaluate(() => console.log('attached hello'));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(b.drainConsole().some((m) => m.text === 'attached hello'), 'console handler installed');
    await b.stop();
    assert.equal(b.isRunning, false);
    assert.equal(chrome.child.exitCode, null, 'the process is still alive');
  });

  it('attach to a Chromium that has just started waits for its first tab', async () => {
    const fresh = await launchDebuggableChromium({ waitForPage: false });
    const b = new PlaywrightBrowser();
    try {
      await b.attach({ cdpUrl: fresh.cdpUrl });
      assert.equal((await b.getPages()).length, 1, 'no second page opened');
    } finally {
      await b.stop();
      await fresh.close();
    }
  });
});
