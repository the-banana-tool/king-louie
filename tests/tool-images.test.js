// tests/tool-images.test.js
// A browser screenshot through ToolExecutor (browser-runner spec §8.4, §11
// "Detachment"): the image rides the result's symbol to the agent loop, and
// what postExecute listeners (chat storage, audit, the renderer) and the
// stored row see has no `_images`, only `image.shown_to_model`.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ToolExecutor = require('../src/execution/tool-executor');
const { takeImages } = require('../src/execution/tool-images');
const { toolRegistry, initializeTools } = require('../src/tools');
const { setBrowser, removeBrowser } = require('../src/tools/builtin/browser-registry');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
initializeTools();

describe('browser screenshot images through ToolExecutor', () => {
  let browser;
  let page;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    // A call outside any take is decided for the default browser.
    setBrowser('default', { isRunning: true, page, context, stop: async () => {} });
  });

  after(async () => {
    removeBrowser('default');
    if (browser) await browser.close();
  });

  for (const toolName of ['Browser', 'BrowserPage']) {
    it(`${toolName} screenshot: the loop gets the image, the stored row never does`, async () => {
      assert.equal(toolRegistry.get(toolName).emitsImages, true);
      await page.setContent('<title>Row</title><p>hello</p>');
      const ex = new ToolExecutor({ requireApproval: false });
      const seen = [];
      ex.on('postExecute', (e) => seen.push(e));
      const result = await ex.execute(toolName, { action: 'screenshot' }, {});
      assert.equal(result.ok, true);
      assert.equal(Object.hasOwn(result, '_images'), false);
      const images = takeImages(result);
      assert.equal(images.length, 1);
      assert.equal(images[0].mimeType, 'image/jpeg');
      assert.match(images[0].id, /^browser-\d+$/);

      assert.equal(seen.length, 1);
      const row = JSON.parse(JSON.stringify(seen[0].result));
      assert.equal(row._images, undefined);
      assert.deepEqual(row.image, { width: 1280, height: 720, scale: 1, shown_to_model: true });
      assert.equal(row.page.title, 'Row');
      assert.ok(!JSON.stringify(row).includes(images[0].base64.slice(0, 64)), 'no pixels in the row');
    });
  }

  it('the to_file form carries no image to the loop', async () => {
    const ex = new ToolExecutor({ requireApproval: false });
    const result = await ex.execute('BrowserPage', { action: 'screenshot', to_file: true }, {});
    assert.equal(typeof result.savedTo, 'string');
    assert.deepEqual(takeImages(result), []);
    assert.equal(result.image, undefined);
    fs.rmSync(result.savedTo, { force: true });
  });
});

describe('the renderer', () => {
  // getToolResultSummary is a pure function; evaluate its source alone.
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function getToolResultSummary(');
  const end = src.indexOf('\n}\n', start);
  // eslint-disable-next-line no-new-func
  const getToolResultSummary = new Function(`${src.slice(start, end + 2)}; return getToolResultSummary;`)();

  it('labels a result whose image went to the model, by text only', () => {
    const row = { ok: true, image: { width: 1280, height: 720, scale: 1, shown_to_model: true }, page: { title: 't', url: 'u' } };
    for (const name of ['Browser', 'BrowserPage', 'BrowserSession', 'BrowserExtract']) {
      assert.equal(getToolResultSummary(name, row), 'screenshot (image shown to the model)');
    }
    assert.equal(getToolResultSummary('BrowserPage', { ok: true, savedTo: 'x.png' }), '');
  });

  it('draws the note with textContent, never innerHTML', () => {
    const i = src.indexOf('screenshot (image shown to the model)', end);
    assert.ok(i > 0, 'the payload view names it too');
    const block = src.slice(src.lastIndexOf('if (isResult && payload && payload.image', i), i + 80);
    assert.match(block, /textContent/);
    assert.doesNotMatch(block, /innerHTML/);
  });
});
