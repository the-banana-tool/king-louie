// The snapshot action, ref= selectors and the per-page ref record
// (spec 2026-10-28 browser runner, §7, C-5 to C-7). Headless bundled
// Chromium on pages set with setContent or data: URLs; no network.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const browserTool = require('../src/tools/builtin/browser-tool');
const browserPageTool = require('../src/tools/builtin/browser-page-tool');
const browserExtractTool = require('../src/tools/builtin/browser-extract-tool');
const PlaywrightBrowser = require('../src/browser/playwright-browser');
const { ACTING_ACTIONS } = require('../src/tools/browser-acting');
const { getBrowser } = require('../src/tools/builtin/browser-registry');

const run = (params) => browserTool.execute(params);

const FORM_PAGE = `<!DOCTYPE html><html><head><title>Form page</title></head><body>
<h1>Listing</h1>
<form>
  <label>Your email <input id="email"></label>
  <button type="button" id="send" onclick="document.getElementById('out').textContent='sent'">Contact seller</button>
  <button type="button" id="other" onclick="document.getElementById('out').textContent='other'">Other</button>
</form>
<a href="/listings">Listings</a>
<p id="out">idle</p>
<iframe srcdoc="<input id='inner' placeholder='Inner field'>"></iframe>
</body></html>`;

async function setContent(html) {
  const page = getBrowser().page;
  await page.setContent(html);
  // The srcdoc iframe loads after setContent resolves.
  await page.waitForFunction(() => {
    const f = document.querySelector('iframe');
    return !f || (f.contentDocument && f.contentDocument.getElementById('inner'));
  });
}

function refOf(snapshot, pattern) {
  const line = snapshot.split('\n').find((l) => pattern.test(l));
  assert.ok(line, `no line matches ${pattern} in:\n${snapshot}`);
  const m = line.match(/\[ref=((?:f\d+)?e\d+)\]/);
  assert.ok(m, `no ref on ${line}`);
  return m[1];
}

describe('snapshot line parser', () => {
  const { parseSnapshotLine } = PlaywrightBrowser;

  it('reads role, name and ref, and gives the label role "name"', () => {
    assert.deepStrictEqual(parseSnapshotLine('  - button "Contact seller" [ref=e15] [cursor=pointer]'),
      { ref: 'e15', role: 'button', name: 'Contact seller', label: 'button "Contact seller"' });
  });

  it('reads a YAML-quoted key and an escaped name', () => {
    assert.deepStrictEqual(parseSnapshotLine(`  - 'button "a: b ''q''" [ref=e2]'`),
      { ref: 'e2', role: 'button', name: "a: b 'q'", label: `button "a: b 'q'"` });
    assert.deepStrictEqual(parseSnapshotLine('- button "Send \\"it\\"" [ref=e6]'),
      { ref: 'e6', role: 'button', name: 'Send "it"', label: 'button "Send "it""' });
  });

  it('a node with no name is labelled by its role; a frame ref is read', () => {
    assert.deepStrictEqual(parseSnapshotLine('    - textbox [ref=f1e2]'),
      { ref: 'f1e2', role: 'textbox', name: '', label: 'textbox' });
  });

  it('a ref spelled inside a name is not the node\'s ref', () => {
    const p = parseSnapshotLine('- link "go [ref=e1]" [ref=e9]');
    assert.strictEqual(p.ref, 'e9');
  });

  it('tolerates lines it does not understand and gives them no label', () => {
    for (const l of ['- text: Email', '    - /url: /x', '', 'garbage [ref=e3]', '- "unterminated [ref=e4]']) {
      const p = parseSnapshotLine(l);
      assert.ok(p === null || p.label === null || p.ref === null, l);
    }
  });
});

describe('snapshot and refs (headless Chromium)', () => {
  before(async () => {
    await browserTool._cleanup();
    const r = await run({ action: 'start', headless: true, ephemeral: true });
    assert.strictEqual(r.ok, true, r.error);
  });
  after(async () => { await browserTool._cleanup(); });
  beforeEach(async () => {
    const b = getBrowser();
    // Back to the first tab with the form page on it.
    while (b.context.pages().length > 1) await b.closePage(b.context.pages().length - 1);
    b.switchToPage(0);
    await setContent(FORM_PAGE);
  });

  it('lists the page with refs, untrusted, with url and title', async () => {
    const r = await run({ action: 'snapshot' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.untrusted_output, true);
    assert.strictEqual(r.title, 'Form page');
    assert.strictEqual(typeof r.url, 'string');
    assert.strictEqual(r.truncated, false);
    assert.match(r.snapshot, /heading "Listing"/);
    assert.match(r.snapshot, /textbox "Your email" \[ref=e\d+\]/);
    assert.match(r.snapshot, /button "Contact seller" \[ref=e\d+\]/);
    assert.match(r.snapshot, /link "Listings" \[ref=e\d+\]/);
    assert.match(r.snapshot, /textbox "Inner field" \[ref=f\d+e\d+\]/);
    assert.strictEqual(r.refs, (r.snapshot.match(/\[ref=/g) || []).length);
    assert.ok(r.refs >= 6);
  });

  it('interactive keeps only the lines with a ref, indented as in the tree', async () => {
    const full = (await run({ action: 'snapshot' })).snapshot.split('\n');
    const r = await run({ action: 'snapshot', interactive: true });
    const lines = r.snapshot.split('\n');
    assert.ok(lines.length > 0);
    for (const l of lines) assert.match(l, /\[ref=(?:f\d+)?e\d+\]/);
    assert.deepStrictEqual(lines, full.filter((l) => /\[ref=/.test(l)));
    assert.ok(!lines.some((l) => /\/url:/.test(l)));
  });

  it('ref returns that node and its subtree only', async () => {
    const full = (await run({ action: 'snapshot' })).snapshot;
    const linkRef = refOf(full, /link "Listings"/);
    const r = await run({ action: 'snapshot', ref: linkRef });
    assert.strictEqual(r.ok, true, r.error);
    const lines = r.snapshot.split('\n');
    assert.match(lines[0], /^- link "Listings"/);
    assert.ok(lines.some((l) => /\/url: \/listings/.test(l)));
    assert.ok(!r.snapshot.includes('Contact seller'));
  });

  it('a subtree ref the page does not have is ref_not_found', async () => {
    const r = await run({ action: 'snapshot', ref: 'e999' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ref_not_found');
  });

  it('max_chars cuts at a line end and says truncated; it is bounded', async () => {
    const full = (await run({ action: 'snapshot' })).snapshot;
    const r = await run({ action: 'snapshot', max_chars: 60 });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.snapshot.length <= 60);
    assert.ok(full.startsWith(r.snapshot + '\n'), 'whole lines only');
    for (const bad of [0, -1, 60001, 1.5, 'x']) {
      const b = await run({ action: 'snapshot', max_chars: bad });
      assert.strictEqual(b.ok, false, String(bad));
    }
    const big = await run({ action: 'snapshot', max_chars: 60000 });
    assert.strictEqual(big.ok, true);
  });

  it('click ref=eN clicks the element the snapshot named', async () => {
    const snap = (await run({ action: 'snapshot' })).snapshot;
    const r = await run({ action: 'click', selector: `ref=${refOf(snap, /button "Contact seller"/)}` });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(await getBrowser().page.textContent('#out'), 'sent');
  });

  it('a frame ref fills the field inside the iframe', async () => {
    const snap = (await run({ action: 'snapshot' })).snapshot;
    const ref = refOf(snap, /textbox "Inner field"/);
    assert.match(ref, /^f\d+e\d+$/);
    const r = await run({ action: 'fill', selector: `ref=${ref}`, text: 'hello frame' });
    assert.strictEqual(r.ok, true, r.error);
    const frame = getBrowser().page.frames().find((f) => f !== getBrowser().page.mainFrame());
    assert.strictEqual(await frame.inputValue('#inner'), 'hello frame');
  });

  it('after a navigation the ref is ref_stale', async () => {
    const page = getBrowser().page;
    await page.goto('data:text/html,<title>one</title><button>Go</button>');
    const ref = refOf((await run({ action: 'snapshot' })).snapshot, /button "Go"/);
    await run({ action: 'reload' });
    const r = await run({ action: 'click', selector: `ref=${ref}`, timeout: 1000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ref_stale');
    assert.match(r.error, /snapshot/);
    // A new snapshot makes refs usable again.
    const ref2 = refOf((await run({ action: 'snapshot' })).snapshot, /button "Go"/);
    assert.strictEqual((await run({ action: 'click', selector: `ref=${ref2}`, timeout: 2000 })).ok, true);
  });

  it('after history.pushState the ref is ref_stale', async () => {
    const ref = refOf((await run({ action: 'snapshot' })).snapshot, /button "Contact seller"/);
    await run({ action: 'evaluate', expression: "history.pushState({}, '', '#route'); 1" });
    // framenavigated is delivered asynchronously.
    await getBrowser().page.waitForTimeout(100);
    const r = await run({ action: 'click', selector: `ref=${ref}`, timeout: 1000 });
    assert.strictEqual(r.code, 'ref_stale');
  });

  it('on another tab the ref is ref_stale, and usable again on its own tab', async () => {
    const ref = refOf((await run({ action: 'snapshot' })).snapshot, /button "Contact seller"/);
    await run({ action: 'open_tab' });
    const r = await run({ action: 'click', selector: `ref=${ref}`, timeout: 1000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ref_stale');
    await run({ action: 'switch_tab', tab_index: 0 });
    const back = await run({ action: 'click', selector: `ref=${ref}`, timeout: 2000 });
    assert.strictEqual(back.ok, true, back.error);
  });

  it('an element removed from the DOM is ref_not_found, without waiting out the timeout', async () => {
    const ref = refOf((await run({ action: 'snapshot' })).snapshot, /button "Contact seller"/);
    await getBrowser().page.evaluate(() => document.getElementById('send').remove());
    const t0 = Date.now();
    const r = await run({ action: 'click', selector: `ref=${ref}`, timeout: 5000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ref_not_found');
    assert.ok(Date.now() - t0 < 3000, 'refused before Playwright waited');
  });

  it('a ref no snapshot on this page had is ref_not_found', async () => {
    await run({ action: 'snapshot' });
    const r = await run({ action: 'click', selector: 'ref=e999', timeout: 1000 });
    assert.strictEqual(r.code, 'ref_not_found');
  });

  it('a ref in target_selector is checked like selector', async () => {
    const snap = (await run({ action: 'snapshot' })).snapshot;
    const r = await run({ action: 'drag_and_drop', selector: `ref=${refOf(snap, /button "Other"/)}`, target_selector: 'ref=e999', timeout: 1000 });
    assert.strictEqual(r.code, 'ref_not_found');
  });

  it('a raw aria-ref= selector is refused and points at ref=', async () => {
    const snap = (await run({ action: 'snapshot' })).snapshot;
    const ref = refOf(snap, /button "Contact seller"/);
    for (const selector of [`aria-ref=${ref}`, `form >> aria-ref=${ref}`, `ARIA-REF=${ref}`]) {
      const r = await run({ action: 'click', selector, timeout: 1000 });
      assert.strictEqual(r.ok, false, selector);
      assert.match(r.error, /ref=/, selector);
      assert.strictEqual(r.code, 'invalid_params', selector);
    }
    assert.strictEqual(await getBrowser().page.textContent('#out'), 'idle');
  });

  it('the *_in_frame actions refuse a ref and a raw aria-ref', async () => {
    const snap = (await run({ action: 'snapshot' })).snapshot;
    const ref = refOf(snap, /textbox "Inner field"/);
    for (const action of ['fill_in_frame', 'click_in_frame', 'type_in_frame']) {
      for (const selector of [`ref=${ref}`, `aria-ref=${ref}`]) {
        const r = await run({ action, selector, text: 'x', frame_index: 1, timeout: 1000 });
        assert.strictEqual(r.ok, false, `${action} ${selector}`);
        assert.match(r.error, /use the ref with click or fill directly/, `${action} ${selector}`);
      }
    }
  });
});

describe('snapshot on the tools', () => {
  it('BrowserPage, BrowserExtract and Browser offer snapshot; it is not acting', () => {
    for (const tool of [browserTool, browserPageTool, browserExtractTool]) {
      const schema = tool.parameters || tool.inputSchema;
      assert.ok(schema.properties.action.enum.includes('snapshot'), tool.name);
      assert.match(schema.properties.selector.description, /ref=eN/, tool.name);
      for (const p of ['interactive', 'ref', 'max_chars']) assert.ok(schema.properties[p], `${tool.name} ${p}`);
    }
    assert.ok(!ACTING_ACTIONS.has('snapshot'));
  });
});

describe('the Playwright pin and its private API (C-5)', () => {
  it('package.json pins playwright to exactly 1.58.2, and so does the lockfile root', () => {
    const root = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const pin = pkg.dependencies.playwright || pkg.devDependencies.playwright;
    assert.strictEqual(pin, '1.58.2');
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const rootEntry = lock.packages[''];
    assert.strictEqual((rootEntry.dependencies || {}).playwright || (rootEntry.devDependencies || {}).playwright, '1.58.2');
  });

  it('page._snapshotForAI and the aria-ref= engine still exist', async () => {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<button>Press</button>');
      assert.strictEqual(typeof page._snapshotForAI, 'function', 'page._snapshotForAI is gone');
      const snap = await page._snapshotForAI();
      assert.strictEqual(typeof snap.full, 'string');
      const ref = refOf(snap.full, /button "Press"/);
      assert.strictEqual(await page.locator(`aria-ref=${ref}`).count(), 1, 'the aria-ref= engine is gone');
      assert.strictEqual(await page.locator(`aria-ref=${ref}`).textContent(), 'Press');
    } finally {
      await browser.close();
    }
  });
});
