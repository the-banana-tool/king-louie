// tests/browser-failure-images.test.js
// An image and a snapshot after a failed acting action, three per run
// (browser runner spec §8.2, §8.3, C-10). Playwright's bundled Chromium,
// headless, page.setContent only; a navigation is aborted by a route, so
// nothing reaches the network.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const browserTool = require('../src/tools/builtin/browser-tool');
const browserPageTool = require('../src/tools/builtin/browser-page-tool');
const { toolRegistry } = require('../src/tools');
const ToolExecutor = require('../src/execution/tool-executor');
const { takeImages } = require('../src/execution/tool-images');
const { createTakePolicy } = require('../src/gui/take-policy');
const { createTakeHolder } = require('../src/gui/take-holder');
const { createAutoImageBudget } = require('../src/tools/browser-auto-images');
const { getBrowser, setBrowser, removeBrowser } = require('../src/tools/builtin/browser-registry');

const FORM_PAGE = `<!DOCTYPE html><html><head><title>Form page</title></head><body>
<h1>Listing</h1>
<label>Your email <input id="email"></label>
<button type="button" id="send">Contact seller</button>
<a href="#listings">Listings</a>
</body></html>`;

function executor(options = {}) {
  return new ToolExecutor({ requireApproval: true, approvalRequester: async () => true, ...options });
}

const missingClick = { action: 'click', selector: '#nope', timeout: 200 };

function assertFailureView(result) {
  assert.equal(result.ok, false);
  assert.match(result.error, /Timeout|nope/);
  assert.deepEqual(Object.keys(result.image).sort(), ['height', 'scale', 'shown_to_model', 'width']);
  assert.equal(result.image.shown_to_model, true);
  assert.equal(result.image_omitted, undefined);
  assert.equal(typeof result.snapshot, 'string');
  assert.ok(result.snapshot.length <= 4000);
  assert.match(result.snapshot, /button "Contact seller" \[ref=e\d+\]/);
  for (const line of result.snapshot.split(/\r?\n/)) assert.match(line, /\[ref=(?:f\d+)?e\d+\]/, 'the interactive form keeps only lines with a ref');
}

function assertNoImage(result) {
  assert.equal(result.image, undefined);
  assert.equal(result.image_omitted, undefined);
  assert.equal(result.snapshot, undefined);
  assert.equal(result._images, undefined);
  assert.deepEqual(takeImages(result), []);
}

describe('images after a failed browser action (headless Chromium)', () => {
  before(async () => {
    if (!toolRegistry.get('BrowserPage')) toolRegistry.register(browserPageTool);
    await browserTool._cleanup();
    const r = await browserTool.execute({ action: 'start', headless: true, ephemeral: true });
    assert.equal(r.ok, true, r.error);
  });
  after(async () => { await browserTool._cleanup(); });
  beforeEach(async () => {
    const b = getBrowser();
    await b.context.unrouteAll({ behavior: 'ignoreErrors' });
    await b.page.setContent(FORM_PAGE);
  });

  it('a click on a missing selector returns an image and an interactive snapshot', async () => {
    const result = await executor().execute('BrowserPage', missingClick);
    assertFailureView(result);
    const images = takeImages(result);
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, 'image/jpeg');
    assert.equal(result._images, undefined, 'the stored row never carries the pixels');
  });

  it('a parameter refusal returns none', async () => {
    const ex = executor();
    assertNoImage(await ex.execute('BrowserPage', { action: 'click', selector: 'aria-ref=e1' }));
    assertNoImage(await ex.execute('BrowserPage', { action: 'click', selector: 'ref=e999' }));
    // Nothing was spent: three images are still to come.
    for (let i = 0; i < 3; i++) assert.ok((await ex.execute('BrowserPage', missingClick)).image);
  });

  it('a take-policy refusal returns none', async () => {
    const holder = createTakeHolder();
    holder.set(createTakePolicy(
      { sites: ['a.example.com'], browser: true, apps: [], credentials: false },
      { currentUrl: async () => 'https://b.example.com' },
    ));
    const result = await executor({ takePolicy: holder }).execute('BrowserPage', missingClick);
    assert.equal(result.success, false);
    assert.match(result.code, /^take_/);
    assertNoImage(result);
  });

  it('an approval denial returns none', async () => {
    const result = await executor({ approvalRequester: async () => false }).execute('BrowserPage', missingClick);
    assertNoImage(result);
  });

  it('the fourth failure in one run says image_omitted: budget and keeps the snapshot; an on-demand screenshot still comes', async () => {
    const ex = executor();
    for (let i = 0; i < 3; i++) assertFailureView(await ex.execute('BrowserPage', missingClick));
    const fourth = await ex.execute('BrowserPage', missingClick);
    assert.equal(fourth.ok, false);
    assert.equal(fourth.image, undefined);
    assert.equal(fourth.image_omitted, 'budget');
    assert.match(fourth.snapshot, /\[ref=e\d+\]/);
    assert.deepEqual(takeImages(fourth), []);

    const shot = await ex.execute('BrowserPage', { action: 'screenshot' });
    assert.equal(shot.ok, true);
    assert.equal(shot.image.shown_to_model, true);
    assert.equal(takeImages(shot).length, 1);

    // A new run (a new executor) has its three again.
    assertFailureView(await executor().execute('BrowserPage', missingClick));
  });

  it('a navigate that lands on chrome-error:// gets an image', async () => {
    const b = getBrowser();
    await b.context.route('**/*', (route) => route.abort('connectionrefused'));
    const result = await executor().execute('BrowserPage', { action: 'navigate', url: 'http://203.0.113.10/', timeout: 5000 });
    assert.match(b.page.url(), /^chrome-error:\/\//, JSON.stringify({ ...result, _images: undefined }));
    assert.equal(result.ok, false);
    assert.equal(result.image.shown_to_model, true);
    assert.equal(typeof result.snapshot, 'string');
    assert.equal(takeImages(result).length, 1);
  });

  it('a snapshot of a near-empty page gets an image; a full one does not', async () => {
    const ex = executor();
    await getBrowser().page.setContent('<canvas width="400" height="300"></canvas>');
    const thin = await ex.execute('BrowserPage', { action: 'snapshot' });
    assert.equal(thin.ok, true);
    assert.ok(thin.snapshot.length < 200);
    assert.equal(thin.image.shown_to_model, true);
    assert.equal(takeImages(thin).length, 1);

    await getBrowser().page.setContent(`${FORM_PAGE}<p>${'Plenty of text on this page. '.repeat(20)}</p>`);
    const full = await ex.execute('BrowserPage', { action: 'snapshot' });
    assert.equal(full.ok, true);
    assert.equal(full.image, undefined);
    assert.deepEqual(takeImages(full), []);
  });

  it('an interactive snapshot of an ordinary page spends nothing', async () => {
    const ex = executor();
    await getBrowser().page.setContent(`Plain text ${'words '.repeat(50)}<button>Go</button>`);
    const r = await ex.execute('BrowserPage', { action: 'snapshot', interactive: true });
    assert.equal(r.ok, true);
    assert.ok(r.snapshot.length < 200, 'short once filtered');
    assert.equal(r.image, undefined);
    assert.deepEqual(takeImages(r), []);
  });

  it('a short page that has a ref is not an unknown state', async () => {
    await getBrowser().page.setContent('<button>Go</button>');
    const r = await executor().execute('BrowserPage', { action: 'snapshot' });
    assert.equal(r.ok, true);
    assert.ok(r.snapshot.length < 200);
    assert.equal(r.image, undefined);
  });

  it('a snapshot of one ref never gets an image', async () => {
    const ex = executor();
    const all = await ex.execute('BrowserPage', { action: 'snapshot', interactive: true });
    const ref = all.snapshot.match(/button "Contact seller" \[ref=(e\d+)\]/)[1];
    const one = await ex.execute('BrowserPage', { action: 'snapshot', ref });
    assert.equal(one.ok, true);
    assert.ok(one.snapshot.length < 200);
    assert.equal(one.image, undefined);
  });

  it('a look-only action that fails gets no image', async () => {
    const result = await executor().execute('BrowserPage', { action: 'wait_for', selector: '#nope', timeout: 200 });
    assert.equal(result.ok, false);
    assertNoImage(result);
  });
});

describe('a failure capture that fails', () => {
  const KEY = 'failure-capture-broken';
  const ctx = { browserKey: KEY };

  before(() => {
    const timeout = Object.assign(new Error('locator.click: Timeout 200ms exceeded.'), { name: 'TimeoutError' });
    const page = {
      url: () => 'https://a.example.com/',
      locator: () => ({ click: async () => { throw timeout; } }),
      evaluate: async () => { throw new Error('page.evaluate: Target crashed'); },
      screenshot: async () => { throw new Error('page.screenshot: Target crashed'); },
      title: async () => '',
    };
    setBrowser(KEY, {
      isRunning: true,
      page,
      snapshot: async () => { throw new Error('snapshot failed'); },
    });
  });
  after(() => removeBrowser(KEY));

  it('is dropped and never hides the action\'s own error', async () => {
    const result = await browserTool.execute({ action: 'click', selector: '#go' }, { ...ctx, browserAutoImages: createAutoImageBudget() });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'locator.click: Timeout 200ms exceeded.');
    assert.equal(result.image, undefined);
    assert.equal(result._images, undefined);
    assert.equal(result.snapshot, undefined);
  });

  it('without a budget in the context, no image is attempted', async () => {
    const result = await browserTool.execute({ action: 'click', selector: '#go' }, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.image, undefined);
  });
});
