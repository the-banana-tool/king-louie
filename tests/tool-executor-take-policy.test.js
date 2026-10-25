// A take's policy answers approvals inside the take (spec
// docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md §7.2):
// an allowed call runs without asking, a refused one is a tool result with its
// code, and a call the node would send to the phone is refused instead.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const ToolExecutor = require('../src/execution/tool-executor');
const { createTakePolicy } = require('../src/gui/take-policy');
const { createTakeHolder } = require('../src/gui/take-holder');

const GATED = 'KlTakeGated';
const NAMES = ['BrowserPage', 'Bash', 'Read', GATED];
let ran = [];
let seenContext = null;

before(() => {
  const reg = (name, requiresApproval) => toolRegistry.register(new Tool({
    name,
    description: 'test',
    parameters: { type: 'object', properties: {} },
    requiresApproval,
    execute: async (params, context) => { ran.push(name); seenContext = context; return { success: true }; }
  }));
  reg('BrowserPage', true);
  reg('Bash', true);
  reg('Read', false);
  reg(GATED, true);
});
after(() => { for (const name of NAMES) toolRegistry.unregister(name); });

function executor(options = {}) {
  ran = [];
  seenContext = null;
  const calls = [];
  const holder = createTakeHolder();
  const denied = [];
  const granted = [];
  const ex = new ToolExecutor({
    requireApproval: true,
    approvalRequester: async (toolName, params) => { calls.push({ toolName, params }); return true; },
    takePolicy: holder,
    ...options
  });
  ex.on('approvalDenied', (evt) => denied.push(evt));
  ex.on('approvalAutoGranted', (evt) => granted.push(evt));
  return { ex, calls, holder, denied, granted };
}

const policy = () => createTakePolicy(
  { sites: ['a.example.com'], browser: true, apps: [], credentials: false },
  { currentUrl: async () => 'https://a.example.com' }
);

describe('ToolExecutor with a take policy', () => {
  it('with no take, the requester is asked as today', async () => {
    const { ex, calls } = executor();
    const result = await ex.execute('BrowserPage', { action: 'click', selector: '#go' });
    assert.equal(calls.length, 1);
    assert.equal(result.success, true);
  });

  it('inside a take, an allowed click runs without the requester', async () => {
    const { ex, calls, holder, granted } = executor();
    holder.set(policy());
    const result = await ex.execute('BrowserPage', { action: 'click', selector: '#go' });
    assert.equal(result.success, true);
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, ['BrowserPage']);
    assert.equal(granted.length, 1);
    assert.equal(granted[0].source, 'take');
    assert.equal(granted[0].toolName, 'BrowserPage');
  });

  it('inside a take, a refused action is a tool result with its code', async () => {
    const { ex, calls, holder, denied } = executor();
    holder.set(policy());
    const result = await ex.execute('Bash', { command: 'sleep 5' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'take_tool_not_allowed');
    assert.equal(typeof result.error, 'string');
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
    assert.equal(denied.length, 1);
    assert.equal(denied[0].deniedBy, 'take');
    assert.equal(denied[0].code, 'take_tool_not_allowed');

    const outside = await ex.execute('BrowserPage', { action: 'evaluate', script: '1' });
    assert.equal(outside.code, 'take_action_not_allowed');
    assert.ok(!('allowed' in outside));
  });

  it('a narrowed take lists what it allows', async () => {
    const { ex, holder } = executor();
    holder.set(createTakePolicy({ sites: ['a.example.com'], browser: ['click'] }, { currentUrl: async () => 'https://a.example.com' }));
    const result = await ex.execute('BrowserPage', { action: 'fill', selector: '#q', text: 'x' });
    assert.equal(result.code, 'take_action_not_allowed');
    assert.deepEqual(result.allowed, ['click']);
  });

  it('inside a take, a passthrough tool that needs approval is refused, not asked', async () => {
    const { ex, calls, holder } = executor();
    holder.set(policy());
    const result = await ex.execute(GATED, {});
    assert.equal(result.success, false);
    assert.equal(result.code, 'take_no_mid_take_approval');
    assert.equal(result.error, `this take did not ask for ${GATED}; nothing was sent to the phone`);
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);

    // A passthrough tool that needs no approval runs as today.
    const read = await ex.execute('Read', {});
    assert.equal(read.success, true);
    assert.equal(calls.length, 0);
  });

  it("inside a take, a hook's confirm is refused, not asked", async () => {
    const { ex, calls, holder } = executor({
      hookExecutor: { run: async (event) => (event === 'PreToolUse' ? { action: 'confirm', message: 'check' } : {}) }
    });
    holder.set(policy());
    const result = await ex.execute('Read', {});
    assert.equal(result.code, 'take_no_mid_take_approval');
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('a deny permission rule still wins inside a take', async () => {
    const { ex, calls, holder } = executor({
      permissionRules: [{ tool: 'BrowserPage', pattern: 'click', action: 'deny', source: 'user' }]
    });
    holder.set(policy());
    const result = await ex.execute('BrowserPage', { action: 'click', selector: '#go' });
    assert.equal(result.success, false);
    assert.equal(result.deniedBy, 'rule');
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('a denied tier and a path outside the allowed roots still win inside a take', async () => {
    const { ex, calls, holder } = executor({
      classifyCall: (toolName, params) => (params.selector === '#deny'
        ? { tier: 'denied', reason: 'matched_deny_policy' }
        : { tier: 'unsafe', reason: 'path_outside_allowed_roots' })
    });
    holder.set(policy());
    const denied = await ex.execute('BrowserPage', { action: 'click', selector: '#deny' });
    assert.equal(denied.deniedBy, 'policy');
    const outside = await ex.execute('BrowserPage', { action: 'click', selector: '#go' });
    assert.equal(outside.success, false);
    assert.equal(outside.code, 'take_no_mid_take_approval');
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('the context carries takePolicy and nodeLocalOrigin', async () => {
    const { ex, holder } = executor({ nodeLocalOrigin: false });
    await ex.execute('Read', {});
    assert.equal(seenContext.takePolicy, holder);
    assert.equal(seenContext.nodeLocalOrigin, false);
    const requester = seenContext.approvalRequester;
    assert.equal(requester.takePolicy, holder);
    assert.equal(requester.nodeLocalOrigin, false);

    const local = executor();
    await local.ex.execute('Read', {});
    assert.equal(seenContext.nodeLocalOrigin, true, 'nodeLocalOrigin defaults to true');
  });

  it('clearing the holder restores asking', async () => {
    const { ex, calls, holder } = executor();
    holder.set(policy());
    await ex.execute('BrowserPage', { action: 'click', selector: '#go' });
    assert.equal(calls.length, 0);
    holder.clear();
    assert.equal(holder.current, null);
    const result = await ex.execute('BrowserPage', { action: 'click', selector: '#go' });
    assert.equal(calls.length, 1);
    assert.equal(result.success, true);
  });
});
