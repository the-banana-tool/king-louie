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
