// A browser action that changes something (fill, click, press, evaluate, a
// login or payment helper, ...) asks the owner even when the browser tool is
// on the "always approve" list or an agent's autoApproveTools: that list was
// how a model once filled and submitted a stranger's contact form unasked.
// Two explicit instructions lift it: a permission rule for the action
// (`allow Browser(click)`), or `ownerQuote`, words that appear verbatim in the
// owner's own message for this turn. Looking (navigate, screenshot, get_text)
// keeps following the always-approve list.
const { describe, it } = require('node:test');
const assert = require('node:assert');

require('../src/tools').initializeTools();
const ToolExecutor = require('../src/execution/tool-executor');
const { takeImages } = require('../src/execution/tool-images');
const { isActingBrowserCall, ownerQuoteInTurn } = require('../src/tools/browser-acting');

function executor(options = {}) {
  const prompts = [];
  const autoGranted = [];
  const ex = new ToolExecutor({
    requireApproval: true,
    approvalRequester: async (toolName, params) => { prompts.push({ toolName, params }); return false; },
    shouldAutoApprove: async () => true, // Browser is on the always-approve list
    ...options
  });
  ex.on('approvalAutoGranted', (evt) => autoGranted.push(evt.source));
  return { ex, prompts, autoGranted };
}

describe('browser actions that change something', () => {
  it('classifies acting and looking actions across the browser tools', () => {
    assert.strictEqual(isActingBrowserCall('Browser', { action: 'click' }), true);
    assert.strictEqual(isActingBrowserCall('BrowserPage', { action: 'fill' }), true);
    assert.strictEqual(isActingBrowserCall('BrowserExtract', { action: 'evaluate_in_frame' }), true);
    assert.strictEqual(isActingBrowserCall('BrowserSession', { action: 'fill_payment' }), true);
    assert.strictEqual(isActingBrowserCall('Browser', { action: 'navigate' }), false);
    assert.strictEqual(isActingBrowserCall('Browser', { action: 'get_text' }), false);
    assert.strictEqual(isActingBrowserCall('Bash', { action: 'click' }), false);
  });

  it('asks for a click even when Browser is always approved', async () => {
    const { ex, prompts, autoGranted } = executor();
    const result = await ex.execute('Browser', { action: 'click', selector: "button[type='submit']" });
    assert.strictEqual(prompts.length, 1);
    assert.deepStrictEqual(autoGranted, []);
    assert.strictEqual(result.success, false);
  });

  it('asks even when the agent config auto-approves Browser', async () => {
    const { ex, prompts } = executor({ shouldAutoApprove: async () => false });
    await ex.execute('Browser', { action: 'fill', selector: '#Phone', text: '+15550100' }, { autoApproveTools: ['Browser'] });
    assert.strictEqual(prompts.length, 1);
  });

  it('keeps the always-approve list for looking actions', async () => {
    const { ex, prompts, autoGranted } = executor();
    await ex.execute('Browser', { action: 'get_text', selector: 'body' });
    assert.strictEqual(prompts.length, 0);
    assert.deepStrictEqual(autoGranted.map((s) => s.type), ['global-auto-approve']);
  });

  it('an allow rule naming the action lifts it', async () => {
    const { ex, prompts, autoGranted } = executor({
      permissionRules: [{ tool: 'Browser', pattern: 'click', action: 'allow', source: 'user' }]
    });
    await ex.execute('Browser', { action: 'click', selector: '#go' });
    assert.strictEqual(prompts.length, 0);
    assert.deepStrictEqual(autoGranted.map((s) => s.type), ['rule']);

    await ex.execute('Browser', { action: 'fill', selector: '#Phone', text: 'x' });
    assert.strictEqual(prompts.length, 1, 'a rule for click says nothing about fill');
  });

  it("the owner's own words this turn lift it", async () => {
    const { ex, prompts, autoGranted } = executor({ ownerTurnText: 'Looks right. Go ahead and submit the Longhorn form.' });
    await ex.execute('Browser', { action: 'click', selector: '#go', ownerQuote: 'go ahead and  submit the Longhorn form' });
    assert.strictEqual(prompts.length, 0);
    assert.deepStrictEqual(autoGranted, [{ type: 'owner-quote', quote: 'go ahead and  submit the Longhorn form' }]);
  });

  it('a quote the owner did not say this turn still asks', async () => {
    const { ex, prompts } = executor({ ownerTurnText: 'What does the form ask for?' });
    await ex.execute('Browser', { action: 'click', selector: '#go', ownerQuote: 'go ahead and submit' });
    assert.strictEqual(prompts.length, 1);
  });

  it('a quote never counts on a run that refuses auto-approval (a remote origin)', async () => {
    const { ex, prompts } = executor({ ownerTurnText: 'go ahead and submit', denyAutoApproval: true });
    await ex.execute('Browser', { action: 'click', selector: '#go', ownerQuote: 'go ahead and submit' });
    assert.strictEqual(prompts.length, 1);
  });

  it('an ask rule outranks the owner quote', async () => {
    const { ex, prompts } = executor({
      ownerTurnText: 'go ahead and submit',
      permissionRules: [{ tool: 'Browser', pattern: '*', action: 'ask', source: 'user' }]
    });
    await ex.execute('Browser', { action: 'click', selector: '#go', ownerQuote: 'go ahead and submit' });
    assert.strictEqual(prompts.length, 1);
  });

  it('matches a quote on word boundaries, ignoring case and spacing', () => {
    assert.strictEqual(ownerQuoteInTurn('Submit  IT', 'ok, submit it now'), true);
    assert.strictEqual(ownerQuoteInTurn('ubmit it', 'ok, submit it now'), false);
    assert.strictEqual(ownerQuoteInTurn('', 'ok, submit it now'), false);
    assert.strictEqual(ownerQuoteInTurn('submit it', null), false);
  });
});

// C-8 (spec 2026-10-28 browser runner, §7.5, §11 "The approval label"): a
// ref means nothing on an approval card, so the executor adds what the ref
// names (role and name from the page's snapshot) before anyone is asked, and
// the handler refuses ref_changed when the element no longer has them.
// Headless bundled Chromium on setContent pages; no network.
describe('the approval label of a ref (headless Chromium)', () => {
  const { before, after, beforeEach } = require('node:test');
  const browserTool = require('../src/tools/builtin/browser-tool');
  const { getBrowser } = require('../src/tools/builtin/browser-registry');

  const PAGE = `<!DOCTYPE html><html><body>
<button type="button" id="send" onclick="document.getElementById('out').textContent='sent'">Contact seller</button>
<button type="button" id="odd" aria-label="Pay&#x202E;won">x</button>
<button type="button" id="long">${'Very long button name '.repeat(6).trim()}</button>
<ul><li id="a" draggable="true" aria-label="Apples">Apples</li><li id="b" aria-label="Bananas">Bananas</li></ul>
<p id="out">idle</p>
</body></html>`;

  const refOf = (snapshot, pattern) => {
    const line = snapshot.split('\n').find((l) => pattern.test(l) && /\[ref=/.test(l));
    assert.ok(line, `no line matches ${pattern} in:\n${snapshot}`);
    return line.match(/\[ref=((?:f\d+)?e\d+)\]/)[1];
  };
  const out = () => getBrowser().page.textContent('#out');
  let snap;

  before(async () => {
    await browserTool._cleanup();
    const r = await browserTool.execute({ action: 'start', headless: true, ephemeral: true });
    assert.strictEqual(r.ok, true, r.error);
  });
  after(async () => { await browserTool._cleanup(); });
  beforeEach(async () => {
    await getBrowser().page.setContent(PAGE);
    snap = (await browserTool.execute({ action: 'snapshot' })).snapshot;
  });

  it('a click on a ref asks with ref_label added by the executor', async () => {
    const { ex, prompts } = executor();
    const ref = refOf(snap, /button "Contact seller"/);
    const result = await ex.execute('BrowserPage', { action: 'click', selector: `ref=${ref}` });
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].params.ref_label, 'button "Contact seller"');
    assert.strictEqual(result.success, false);
    assert.strictEqual(await out(), 'idle');
  });

  it("a model's own ref_label is replaced, and removed where no ref is acted on", async () => {
    const { ex, prompts } = executor();
    const ref = refOf(snap, /button "Contact seller"/);
    await ex.execute('Browser', { action: 'click', selector: `ref=${ref}`, ref_label: 'button "Cancel"' });
    assert.strictEqual(prompts[0].params.ref_label, 'button "Contact seller"');
    await ex.execute('Browser', { action: 'click', selector: '#send', ref_label: 'button "Cancel"', target_ref_label: 'x' });
    assert.strictEqual('ref_label' in prompts[1].params, false);
    assert.strictEqual('target_ref_label' in prompts[1].params, false);
  });

  it('a label that is not one plain line shows hidden; a long one is cut at 80 characters', async () => {
    const { ex, prompts } = executor();
    await ex.execute('BrowserPage', { action: 'click', selector: `ref=${refOf(snap, /button "Pay/)}` });
    assert.strictEqual(prompts[0].params.ref_label, 'button (name hidden: not one plain line)');
    await ex.execute('BrowserPage', { action: 'click', selector: `ref=${refOf(snap, /button "Very long/)}` });
    const label = prompts[1].params.ref_label;
    assert.strictEqual(Array.from(label).length, 80);
    assert.ok(label.startsWith('button "Very long button name Very long'));
    assert.ok(label.endsWith('…'));
  });

  it("a PreToolUse hook's confirm prompt already shows the label", async () => {
    const { ex, prompts } = executor({ hookExecutor: { run: async (event) => (event === 'PreToolUse' ? { action: 'confirm', message: 'hook asks' } : {}) } });
    const ref = refOf(snap, /button "Contact seller"/);
    await ex.execute('BrowserPage', { action: 'click', selector: `ref=${ref}` });
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].params.ref_label, 'button "Contact seller"');
  });

  it('a ref with no label is refused ref_not_found before anyone is asked', async () => {
    const { ex, prompts } = executor();
    const result = await ex.execute('BrowserPage', { action: 'click', selector: 'ref=e999' });
    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.ok, false, 'shaped like the browser tools\' own refusals');
    assert.strictEqual(result.code, 'ref_not_found');
    assert.strictEqual(typeof result.error, 'string');
  });

  it('a ref in a login field is refused invalid_params before anything is filled or asked', async () => {
    await getBrowser().page.setContent('<input id="u"><input id="p" type="password"><p id="out">idle</p>');
    snap = (await browserTool.execute({ action: 'snapshot' })).snapshot;
    const ref = refOf(snap, /textbox/);
    const { ex, prompts } = executor();
    const viaExecutor = await ex.execute('BrowserSession', { action: 'login', passwordSelector: `ref=${ref}`, username: 'a', password: 'b' });
    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(viaExecutor.ok, false);
    assert.strictEqual(viaExecutor.code, 'invalid_params');
    for (const params of [
      { action: 'login', usernameSelector: '#u', passwordSelector: `ref=${ref}`, username: 'a', password: 'b' },
      { action: 'login', usernameSelector: 'aria-ref=e1', passwordSelector: '#p', username: 'a', password: 'b' },
      { action: 'fill_payment', cardNumberSelector: `ref=${ref}`, cardNumber: '4242424242424242' },
      { action: 'signup', emailSelector: `ref=${ref}`, email: 'a@example.com', password: 'x' }
    ]) {
      const direct = await browserTool.execute(params);
      assert.strictEqual(direct.ok, false, JSON.stringify(params));
      assert.strictEqual(direct.code, 'invalid_params', JSON.stringify(params));
    }
    assert.strictEqual(await getBrowser().page.inputValue('#u'), '');
    assert.strictEqual(await getBrowser().page.inputValue('#p'), '');
  });

  it('a ref from before a navigation is refused ref_stale before anyone is asked', async () => {
    const { ex, prompts } = executor();
    const ref = refOf(snap, /button "Contact seller"/);
    await getBrowser().page.goto('data:text/html,<p>elsewhere</p>');
    const result = await ex.execute('BrowserPage', { action: 'click', selector: `ref=${ref}` });
    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(result.code, 'ref_stale');
  });

  it('renaming the button between the approval and the run gives ref_changed', async () => {
    const ref = refOf(snap, /button "Contact seller"/);
    const ex = new ToolExecutor({
      requireApproval: true,
      approvalRequester: async () => {
        await getBrowser().page.evaluate(() => { document.getElementById('send').textContent = 'Delete account'; });
        return true;
      },
      shouldAutoApprove: async () => false
    });
    const result = await ex.execute('BrowserPage', { action: 'click', selector: `ref=${ref}` });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'ref_changed');
    assert.strictEqual(await out(), 'idle');
    // A ref_changed refusal is the host's, not a page failure: no image, no snapshot (T06).
    assert.strictEqual(result.image, undefined);
    assert.strictEqual(result.snapshot, undefined);
    assert.strictEqual(result._images, undefined);
    assert.deepStrictEqual(takeImages(result), []);
  });

  it('an approved ref click whose element is unchanged runs', async () => {
    const ref = refOf(snap, /button "Contact seller"/);
    const ex = new ToolExecutor({ requireApproval: true, approvalRequester: async () => true, shouldAutoApprove: async () => false });
    const result = await ex.execute('BrowserPage', { action: 'click', selector: `ref=${ref}` });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(await out(), 'sent');
  });

  it('allow Browser(click) still lifts the prompt for a ref click', async () => {
    const { ex, prompts, autoGranted } = executor({
      permissionRules: [{ tool: 'Browser', pattern: 'click', action: 'allow', source: 'user' }]
    });
    const ref = refOf(snap, /button "Contact seller"/);
    const result = await ex.execute('Browser', { action: 'click', selector: `ref=${ref}` });
    assert.strictEqual(prompts.length, 0);
    assert.deepStrictEqual(autoGranted.map((s) => s.type), ['rule']);
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(await out(), 'sent');
  });

  it('an ownerQuote still lifts the prompt for a ref click', async () => {
    const { ex, prompts } = executor({ ownerTurnText: 'Yes, contact the seller now.' });
    const ref = refOf(snap, /button "Contact seller"/);
    const result = await ex.execute('Browser', { action: 'click', selector: `ref=${ref}`, ownerQuote: 'contact the seller' });
    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(result.ok, true, result.error);
  });

  it('drag_and_drop labels its target ref as target_ref_label', async () => {
    const { ex, prompts } = executor();
    await ex.execute('BrowserPage', {
      action: 'drag_and_drop', selector: `ref=${refOf(snap, /Apples/)}`, target_selector: `ref=${refOf(snap, /Bananas/)}`
    });
    assert.strictEqual(prompts[0].params.ref_label, 'listitem "Apples"');
    assert.strictEqual(prompts[0].params.target_ref_label, 'listitem "Bananas"');
  });

  it('a looking call on a ref gets no label and is not asked', async () => {
    const { ex, prompts } = executor();
    const ref = refOf(snap, /button "Contact seller"/);
    const result = await ex.execute('BrowserExtract', { action: 'get_text', selector: `ref=${ref}`, ref_label: 'x' });
    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(result.ok, true, result.error);
  });
});

describe('the desktop approval dialog says what a ref names', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = src.indexOf('function browserRefSummary(');
  const end = src.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start, 'renderer.js has browserRefSummary');
  const browserRefSummary = new Function(`${src.slice(start, end)}\nreturn browserRefSummary;`)();

  it('a ref click reads as the action, the ref and its label', () => {
    assert.strictEqual(browserRefSummary('BrowserPage', { action: 'click', selector: 'ref=e15', ref_label: 'button "Contact seller"' }),
      'click ref=e15 (button "Contact seller")');
    assert.strictEqual(browserRefSummary('Browser', {
      action: 'drag_and_drop', selector: 'ref=e3', ref_label: 'listitem "Apples"', target_selector: 'ref=e4', target_ref_label: 'listitem "Bananas"'
    }), 'drag_and_drop ref=e3 (listitem "Apples") to ref=e4 (listitem "Bananas")');
  });

  it('says nothing for a call without a ref, and the dialog sets it as text', () => {
    assert.strictEqual(browserRefSummary('Browser', { action: 'click', selector: '#go' }), null);
    assert.strictEqual(browserRefSummary('Bash', { selector: 'ref=e1', ref_label: 'x' }), null);
    const dialog = src.slice(src.indexOf('function showToolApprovalDialog('), src.indexOf('\nfunction ', src.indexOf('function showToolApprovalDialog(') + 1));
    assert.match(dialog, /refLine\.textContent = refSummary/);
    assert.doesNotMatch(dialog, /refLine\.innerHTML/);
  });
});

describe('the ref label check, without a page', () => {
  const { prepareRefLabels, checkRefLabels } = require('../src/tools/builtin/browser-ref-label');
  const registry = require('../src/tools/builtin/browser-registry');
  const KEY = 'test-ref-label';
  const ctx = { browserKey: KEY };
  // A browser whose snapshot named e5 with one long name and whose page now names e5 with
  // another: both are cut to the same 80 characters on the approval.
  const longA = `button "${'Same start '.repeat(10)}A"`;
  const longB = `button "${'Same start '.repeat(10)}B"`;
  const fake = (now) => ({
    isRunning: true, page: {},
    refLocator() {}, refLabel: () => longA, currentRefLabel: async () => now
  });

  it('compares the exact label even when the params were copied after preparing', async () => {
    registry.setBrowser(KEY, fake(longB));
    try {
      const prepared = prepareRefLabels({ action: 'click', selector: 'ref=e5' }, ctx);
      assert.ok(prepared.params.ref_label.endsWith('…'));
      const copy = { ...prepared.params };
      await assert.rejects(checkRefLabels(copy, ctx), (err) => err.code === 'ref_changed');
      registry.setBrowser(KEY, fake(longA));
      await checkRefLabels({ ...prepared.params }, ctx);
    } finally {
      registry.removeBrowser(KEY);
    }
  });

  it('a browser that is not running is a coded refusal, not a TypeError', async () => {
    registry.setBrowser(KEY, { isRunning: false, page: null });
    try {
      await assert.rejects(checkRefLabels({ action: 'click', selector: 'ref=e5', ref_label: 'button "Go"' }, ctx),
        (err) => err.name === 'BrowserRefError' && err.code === 'ref_not_found');
    } finally {
      registry.removeBrowser(KEY);
    }
  });
});
