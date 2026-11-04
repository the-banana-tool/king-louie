// A task's policy where the approval would ask (spec
// docs/superpowers/specs/2026-11-03-tasks-stage1-design.md §4.6): an allowed
// call runs with no prompt, a passthrough call asks as it always did, and only
// a task that is over refuses. The node's own refusals still win.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const { registerDeniedDir, clearDeniedDirs } = require('../src/tools/utils');
const WriteTool = require('../src/tools/builtin/write-tool');
const ToolExecutor = require('../src/execution/tool-executor');
const { createTaskPolicy } = require('../src/tasks/policy');
const { createTakePolicy } = require('../src/gui/take-policy');
const { createTakeHolder } = require('../src/gui/take-holder');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const { profileSettings, everyRole } = require('./helpers/profile-settings');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const GATED = 'KlTaskGated';
const NAMES = ['BrowserPage', 'Bash', 'Read', GATED];
let ran = [];
let seenContext = null;
const saved = new Map();

before(() => {
  const reg = (name, requiresApproval) => {
    saved.set(name, toolRegistry.get(name) || null);
    toolRegistry.register(new Tool({
      name,
      description: 'test',
      parameters: { type: 'object', properties: {} },
      requiresApproval,
      execute: async (params, context) => { ran.push(name); seenContext = context; return { success: true }; }
    }));
  };
  reg('BrowserPage', true);
  reg('Bash', true);
  reg('Read', false);
  reg(GATED, true);
});
after(() => {
  for (const name of NAMES) {
    toolRegistry.unregister(name);
    if (saved.get(name)) toolRegistry.register(saved.get(name));
  }
});

const WORK = path.join(os.tmpdir(), 'kl-no-such-task-work');
const CLICK = { action: 'click', selector: '#go' };

function taskPolicy(state = {}, { url = 'https://a.example.com/' } = {}) {
  return createTaskPolicy({
    getState: () => ({ ended: false, proposal: null, grant: { sites: ['a.example.com'], allows: ['browser-act'] }, awaiting: false, ...state }),
    currentUrl: async () => url,
    workDir: WORK,
    waitForGrant: async () => {},
  });
}

function executor(options = {}) {
  ran = [];
  seenContext = null;
  const calls = [];
  const denied = [];
  const granted = [];
  const ex = new ToolExecutor({
    requireApproval: true,
    approvalRequester: async (toolName, params) => { calls.push({ toolName, params }); return true; },
    taskPolicy: taskPolicy(),
    ...options
  });
  ex.on('approvalDenied', (evt) => denied.push(evt));
  ex.on('approvalAutoGranted', (evt) => granted.push(evt));
  return { ex, calls, denied, granted };
}

describe('ToolExecutor with a task policy', () => {
  it('with no policy, the requester is asked as today', async () => {
    const { ex, calls } = executor({ taskPolicy: null });
    await ex.execute('BrowserPage', CLICK);
    assert.equal(calls.length, 1);
  });

  it('an allow lifts the acting-browser prompt', async () => {
    const { ex, calls, granted } = executor();
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(result.success, true);
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, ['BrowserPage']);
    assert.equal(granted.length, 1);
    assert.deepEqual(granted[0].source, { type: 'task' });
  });

  it('an allow lifts an always_confirm tier and the per-tool flag on a node', async () => {
    for (const reason of ['matched_always_confirm', 'tool_requires_approval']) {
      const { ex, calls } = executor({ classifyCall: () => ({ tier: 'unsafe', reason }) });
      const result = await ex.execute('BrowserPage', CLICK);
      assert.equal(result.success, true, reason);
      assert.equal(calls.length, 0, reason);
    }
  });

  for (const reason of ['command_substitution', 'some_new_reason', null]) {
    it(`a granted allow does not lift an unsafe tier for ${reason}: the phone is asked`, async () => {
      const { ex, calls, granted } = executor({ classifyCall: () => ({ tier: 'unsafe', reason }) });
      const result = await ex.execute('BrowserPage', CLICK);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, CLICK);
      assert.equal(result.success, true, 'the requester said yes');
      assert.equal(granted.length, 0);
    });
  }

  it('under a shell grant, the node classifier sends a command it cannot read in full to the phone', async () => {
    const { classifyToolCall } = require('../src/execution/safety-policy');
    const shellGrant = taskPolicy({ grant: { sites: [], allows: ['shell'] } });
    const classifyCall = (toolName, params) => classifyToolCall(toolName, params, { allowed_roots: [WORK] }, { cwd: WORK });
    const plain = executor({ taskPolicy: shellGrant, classifyCall, workingDirectory: WORK });
    assert.equal((await plain.ex.execute('Bash', { command: 'dir' })).success, true);
    assert.equal(plain.calls.length, 0, 'tool_requires_approval is the default gate');
    const hidden = executor({ taskPolicy: shellGrant, classifyCall, workingDirectory: WORK });
    await hidden.ex.execute('Bash', { command: 'echo $(whoami)' });
    assert.equal(hidden.calls.length, 1);
    assert.deepEqual(hidden.calls[0].params, { command: 'echo $(whoami)' });
  });

  it('a granted allow never lifts an ask rule: the phone is asked', async () => {
    const { ex, calls, granted } = executor({
      permissionRules: [{ tool: 'BrowserPage', pattern: 'click', action: 'ask', source: 'user' }]
    });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, CLICK);
    assert.equal(result.success, true, 'the requester said yes');
    assert.equal(granted.length, 0);
  });

  it('an allow never lifts a denied tier', async () => {
    const { ex, calls } = executor({ classifyCall: () => ({ tier: 'denied', reason: 'matched_deny_policy' }) });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(result.success, false);
    assert.equal(result.deniedBy, 'policy');
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('an allow never lifts a deny rule', async () => {
    const { ex, calls } = executor({
      permissionRules: [{ tool: 'BrowserPage', pattern: 'click', action: 'deny', source: 'user' }]
    });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(result.success, false);
    assert.equal(result.deniedBy, 'rule');
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('an allow never lifts a path outside the allowed roots: the phone is asked', async () => {
    const { ex, calls, granted } = executor({
      classifyCall: () => ({ tier: 'unsafe', reason: 'path_outside_allowed_roots' })
    });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, 'BrowserPage');
    assert.equal(result.success, true, 'the requester said yes');
    assert.equal(granted.length, 0);
  });

  it('an allow never lifts a path outside the allowed roots: a no stands', async () => {
    const { ex, calls } = executor({
      approvalRequester: async () => false,
      classifyCall: () => ({ tier: 'unsafe', reason: 'path_outside_allowed_roots' })
    });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(result.success, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('an allow never lifts a denied directory', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-task-denied-'));
    const workDir = path.join(dir, 'work');
    fs.mkdirSync(workDir);
    toolRegistry.register(WriteTool);
    registerDeniedDir(workDir);
    t.after(() => {
      clearDeniedDirs();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const target = path.join(workDir, 'a.txt');
    const { ex, calls } = executor({
      workingDirectory: workDir,
      taskPolicy: createTaskPolicy({
        getState: () => ({ ended: false, proposal: null, grant: { sites: [], allows: ['files-write'] }, awaiting: false }),
        currentUrl: async () => null,
        workDir,
        waitForGrant: async () => {},
      })
    });
    const result = await ex.execute('Write', { file_path: target, content: 'x' });
    assert.equal(calls.length, 0, 'the policy allowed it');
    assert.ok(!result.success, 'the tool refused it');
    assert.equal(fs.existsSync(target), false);
  });

  it('a passthrough reaches the requester with the exact action', async () => {
    const { ex, calls, granted } = executor({ taskPolicy: taskPolicy({ grant: null }) });
    const params = { action: 'click', selector: '#exact' };
    const result = await ex.execute('BrowserPage', params);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, 'BrowserPage');
    assert.deepEqual(calls[0].params, params);
    assert.equal(result.success, true);
    assert.equal(granted.length, 0);
  });

  it('a passthrough call that never asked still does not', async () => {
    const { ex, calls } = executor();
    const result = await ex.execute('Read', {});
    assert.equal(result.success, true);
    assert.equal(calls.length, 0);
  });

  it('a no on a passthrough stands', async () => {
    const { ex } = executor({ taskPolicy: taskPolicy({ grant: null }), approvalRequester: async () => false });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(result.success, false);
    assert.deepEqual(ran, []);
  });

  it('task_ended is a tool result with its code', async () => {
    const { ex, calls, denied } = executor({ taskPolicy: taskPolicy({ ended: true }) });
    const posts = [];
    ex.on('postExecute', (evt) => posts.push(evt));
    const result = await ex.execute('Read', {});
    assert.equal(result.success, false);
    assert.equal(result.code, 'task_ended');
    assert.equal(typeof result.error, 'string');
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
    assert.equal(denied.length, 1);
    assert.equal(denied[0].deniedBy, 'task');
    assert.equal(denied[0].code, 'task_ended');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].result, result);
  });

  it('a live task does not refuse a mid-run ask as a take does', async () => {
    const { ex, calls } = executor();
    const gated = await ex.execute(GATED, {});
    assert.equal(gated.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, GATED);
    assert.notEqual(gated.code, 'take_no_mid_take_approval');
  });

  it("a live task does not refuse a hook's confirm", async () => {
    const { ex, calls } = executor({
      hookExecutor: { run: async (event) => (event === 'PreToolUse' ? { action: 'confirm', message: 'check' } : {}) }
    });
    const result = await ex.execute('Read', {});
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
  });

  it('a live task leaves a tool that asks through its requester asking', async () => {
    const { ex, calls } = executor();
    await ex.execute('Read', {});
    const requester = seenContext.approvalRequester;
    assert.equal(await requester(GATED, { a: 1 }, {}), true);
    assert.deepEqual(calls, [{ toolName: GATED, params: { a: 1 } }]);
  });

  it('the requester carries the policy to sub-agents', async () => {
    const policy = taskPolicy();
    const { ex } = executor({ taskPolicy: policy });
    await ex.execute('Read', {});
    assert.equal(seenContext.approvalRequester.taskPolicy, policy);
    const none = executor({ taskPolicy: null });
    await none.ex.execute('Read', {});
    assert.equal('taskPolicy' in seenContext.approvalRequester, false);
  });

  it('decides on the parameters that will run, in the cwd they will run in', async () => {
    const seen = [];
    const { ex } = executor({
      workingDirectory: WORK,
      taskPolicy: { decide: async (tool, params, ctx) => { seen.push({ tool, params, ctx }); return { passthrough: true }; } }
    });
    await ex.execute('BrowserPage', CLICK);
    await ex.execute('BrowserPage', CLICK, { workingDirectory: path.join(WORK, 'child') });
    assert.deepEqual(seen, [
      { tool: 'BrowserPage', params: CLICK, ctx: { cwd: WORK, signal: null } },
      { tool: 'BrowserPage', params: CLICK, ctx: { cwd: path.join(WORK, 'child'), signal: null } }
    ]);
  });

  it('a decide that throws asks, never allows', async () => {
    const { ex, calls } = executor({ taskPolicy: { decide: async () => { throw new Error('broken'); } } });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(calls.length, 1);
    assert.equal(result.success, true, 'the requester said yes');
  });

  it('a call that waits runs only after the card is pressed', async () => {
    let state = { ended: false, proposal: { sites: ['a.example.com'], allows: ['browser-act'] }, grant: null, awaiting: true };
    let press;
    const pressed = new Promise((resolve) => { press = resolve; });
    const { ex, calls } = executor({
      taskPolicy: createTaskPolicy({
        getState: () => state,
        currentUrl: async () => 'https://a.example.com/',
        workDir: WORK,
        waitForGrant: () => pressed,
      })
    });
    const pending = ex.execute('BrowserPage', CLICK);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ran, []);
    state = { ended: false, proposal: null, grant: { sites: ['a.example.com'], allows: ['browser-act'] }, awaiting: false };
    press();
    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, ['BrowserPage']);
  });

  it('a call cut off during the wait does not run', async () => {
    const abort = new AbortController();
    let state = { ended: false, proposal: { sites: ['a.example.com'], allows: ['browser-act'] }, grant: null, awaiting: true };
    const { ex } = executor({
      taskPolicy: createTaskPolicy({
        getState: () => state,
        currentUrl: async () => 'https://a.example.com/',
        workDir: WORK,
        waitForGrant: async () => {
          state = { ...state, grant: { sites: ['a.example.com'], allows: ['browser-act'] }, awaiting: false };
          abort.abort();
        },
      })
    });
    const result = await ex.execute('BrowserPage', CLICK, { signal: abort.signal });
    assert.equal(result.cancelled, true);
    assert.deepEqual(ran, []);
  });

  it('a refuseUnsafe run keeps refusing: an allow does not lift the gate', async () => {
    const { ex, calls } = executor({ refuseUnsafe: true });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(result.success, false);
    assert.equal(result.deniedBy, 'policy');
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('a refuseUnsafe run keeps refusing what its gate refuses at the approval point: the per-tool flag', async () => {
    const { ex, calls } = executor({
      refuseUnsafe: true,
      taskPolicy: { decide: async () => ({ allow: true }) },
      classifyCall: () => ({ tier: 'routine', reason: 'test' })
    });
    const result = await ex.execute(GATED, {});
    assert.equal(result.success, false);
    assert.equal(result.deniedBy, 'policy');
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('a refuseUnsafe run refuses a passthrough as it does today', async () => {
    const { ex, calls } = executor({ refuseUnsafe: true, taskPolicy: taskPolicy({ grant: null }) });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(result.success, false);
    assert.equal(calls.length, 0);
  });

  it('a live take governs alone', async () => {
    const holder = createTakeHolder();
    holder.set(createTakePolicy({ sites: ['a.example.com'], browser: true }, { currentUrl: async () => 'https://a.example.com/' }));
    const { ex, granted } = executor({ takePolicy: holder, taskPolicy: taskPolicy({ ended: true }) });
    const result = await ex.execute('BrowserPage', CLICK);
    assert.equal(result.success, true);
    assert.deepEqual(granted[0].source, { type: 'take' });
  });
});

describe('the approval seam writes task.refused', () => {
  it('the owner\'s no and a call past the task\'s end each write the tool and a code, never the parameters', async () => {
    const { phoneExecutorOptions } = require('../src/approvals/executor-options');
    const entries = [];
    const ledger = { append: async (e) => { entries.push(e); return e; } };
    const origin = { client: 'stdio-mcp', session: null, job_id: null };
    const seam = (decision) => phoneExecutorOptions({ phoneApprover: { ttlMs: 60000, requestApproval: async () => decision }, auditLedger: ledger, origin, local: false });
    const build = (decision, policy) => {
      const s = seam(decision);
      const ex = new ToolExecutor({ requireApproval: true, ...s.options, taskPolicy: policy });
      s.attach(ex);
      return ex;
    };
    await build(false, taskPolicy({ grant: null })).execute('BrowserPage', { action: 'click', selector: '#secret' });
    await build(true, taskPolicy({ ended: true })).execute('BrowserPage', { action: 'click', selector: '#secret' });
    await build('timeout', taskPolicy({ grant: null })).execute('BrowserPage', { action: 'click', selector: '#secret' });
    await new Promise((r) => setImmediate(r));
    const refused = entries.filter((e) => e.kind === 'task.refused');
    assert.deepEqual(refused.map((e) => e.data), [
      { tool: 'BrowserPage', code: 'phone_denied', origin },
      { tool: 'BrowserPage', code: 'task_ended', origin }
    ]);
  });
});

describe('a stop while the policy waits for the card', () => {
  const never = (state) => createTaskPolicy({
    getState: () => state,
    currentUrl: async () => 'https://a.example.com/',
    workDir: WORK,
    waitForGrant: () => new Promise(() => {}),
  });
  const out = { ended: false, proposal: { sites: ['a.example.com'], allows: ['browser-act'] }, grant: null, awaiting: true };

  it('a wait that never settles ends in cancelled, with nobody asked', async () => {
    const abort = new AbortController();
    const { ex, calls } = executor({ taskPolicy: never(out) });
    const posts = [];
    ex.on('postExecute', (evt) => posts.push(evt.result));
    const pending = ex.execute('BrowserPage', CLICK, { signal: abort.signal });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
    assert.deepEqual(posts, [result]);
  });

  it('an ended task keeps its own answer on an aborted call', async () => {
    const abort = new AbortController();
    abort.abort();
    const { ex } = executor({ taskPolicy: taskPolicy({ ended: true }) });
    const result = await ex.execute('BrowserPage', CLICK, { signal: abort.signal });
    assert.equal(result.code, 'task_ended');
  });
});

// The real Bash patterns on the real path through execute(), with only the
// shell itself replaced, so no `dd` ever runs.
describe('a dangerous call in a task goes to the phone', () => {
  const BashTool = require('../src/tools/builtin/bash-tool');
  const DD = { command: 'dd if=/dev/zero of=/tmp/x' };
  const shellGrant = () => taskPolicy({ grant: { sites: [], allows: ['shell'] } });
  let earlier;
  before(() => {
    earlier = toolRegistry.get('Bash');
    toolRegistry.register(new Tool({
      name: 'Bash',
      description: 'test',
      parameters: { type: 'object', properties: {} },
      requiresApproval: true,
      dangerousPatterns: BashTool.dangerousPatterns,
      execute: async () => { ran.push('Bash'); return { success: true }; }
    }));
  });
  after(() => {
    toolRegistry.unregister('Bash');
    toolRegistry.register(earlier);
  });

  it('the patterns are the real ones', () => {
    assert.ok(BashTool.dangerousPatterns.length > 0);
    assert.equal(toolRegistry.get('Bash').isDangerous(DD), true);
  });

  it('a shell grant does not lift it: the exact action is asked, and a yes runs', async () => {
    const { ex, calls, granted } = executor({ taskPolicy: shellGrant() });
    const result = await ex.execute('Bash', DD);
    assert.deepEqual(calls, [{ toolName: 'Bash', params: DD }]);
    assert.equal(result.success, true);
    assert.deepEqual(ran, ['Bash']);
    assert.equal(granted.length, 0);
  });

  it('a no stands', async () => {
    const { ex } = executor({ taskPolicy: shellGrant(), approvalRequester: async () => false });
    const result = await ex.execute('Bash', DD);
    assert.equal(result.success, false);
    assert.deepEqual(ran, []);
  });

  it('the same under the real node classifier', async () => {
    const { classifyToolCall } = require('../src/execution/safety-policy');
    const { ex, calls } = executor({
      taskPolicy: shellGrant(),
      workingDirectory: WORK,
      classifyCall: (toolName, params) => classifyToolCall(toolName, params, { allowed_roots: [WORK] }, { cwd: WORK })
    });
    await ex.execute('Bash', DD);
    assert.deepEqual(calls, [{ toolName: 'Bash', params: DD }]);
  });

  it('a look allow does not lift it, nor an always_confirm reason from the tier, nor an allow rule', async () => {
    const look = { decide: async () => ({ allow: true, look: true }) };
    const lookRun = executor({ taskPolicy: look });
    await lookRun.ex.execute('Bash', DD);
    assert.equal(lookRun.calls.length, 1);
    const tier = executor({ taskPolicy: shellGrant(), classifyCall: () => ({ tier: 'unsafe', reason: 'matched_always_confirm' }) });
    await tier.ex.execute('Bash', DD);
    assert.equal(tier.calls.length, 1);
    const rule = executor({ taskPolicy: shellGrant(), permissionRules: [{ tool: 'Bash', pattern: '*', action: 'allow', source: 'user' }] });
    await rule.ex.execute('Bash', DD);
    assert.equal(rule.calls.length, 1);
  });

  it('an ended task is task_ended, not a phone press and not a throw', async () => {
    const { ex, calls, denied } = executor({ taskPolicy: taskPolicy({ ended: true }) });
    const result = await ex.execute('Bash', DD);
    assert.equal(result.code, 'task_ended');
    assert.equal(calls.length, 0);
    assert.equal(denied[0].deniedBy, 'task');
    assert.deepEqual(ran, []);
  });

  it('a deny rule and a denied tier still refuse', async () => {
    const rule = executor({ taskPolicy: shellGrant(), permissionRules: [{ tool: 'Bash', pattern: '*', action: 'deny', source: 'user' }] });
    assert.equal((await rule.ex.execute('Bash', DD)).deniedBy, 'rule');
    const tier = executor({ taskPolicy: shellGrant(), classifyCall: () => ({ tier: 'denied', reason: 'matched_deny_policy' }) });
    assert.equal((await tier.ex.execute('Bash', DD)).deniedBy, 'policy');
    assert.equal(rule.calls.length + tier.calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('a refuseUnsafe run refuses it', async () => {
    const { ex, calls } = executor({ refuseUnsafe: true, taskPolicy: shellGrant() });
    const result = await ex.execute('Bash', DD);
    assert.equal(result.success, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('outside a task it still throws', async () => {
    const { ex, calls } = executor({ taskPolicy: null });
    await assert.rejects(() => ex.execute('Bash', DD), /Dangerous operation detected/);
    assert.equal(calls.length, 0);
  });

  it('a live take governs alone: it still throws', async () => {
    const holder = createTakeHolder();
    holder.set(createTakePolicy({ sites: ['a.example.com'], browser: true }, { currentUrl: async () => 'https://a.example.com/' }));
    const { ex } = executor({ takePolicy: holder, taskPolicy: shellGrant() });
    await assert.rejects(() => ex.execute('Bash', DD), /Dangerous operation detected/);
  });

  it('bypassSafety is as before: a shell grant runs it', async () => {
    const { ex, calls } = executor({ taskPolicy: shellGrant() });
    assert.equal((await ex.execute('Bash', DD, { bypassSafety: true })).success, true);
    assert.equal(calls.length, 0);
  });
});

describe('a look-class allow lifts only the default gate', () => {
  const SNAPSHOT = { action: 'snapshot' };
  const look = () => taskPolicy({ grant: null });

  it('it lifts a plain requiresApproval', async () => {
    const { ex, calls, granted } = executor({ taskPolicy: look() });
    const result = await ex.execute('BrowserPage', SNAPSHOT);
    assert.equal(result.success, true);
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, ['BrowserPage']);
    assert.deepEqual(granted[0].source, { type: 'task' });
  });

  it('it lifts tool_requires_approval', async () => {
    const { ex, calls } = executor({ taskPolicy: look(), classifyCall: () => ({ tier: 'unsafe', reason: 'tool_requires_approval' }) });
    assert.equal((await ex.execute('BrowserPage', SNAPSHOT)).success, true);
    assert.equal(calls.length, 0);
  });

  for (const reason of ['matched_always_confirm', 'command_substitution', 'path_outside_allowed_roots', null]) {
    it(`an unsafe tier for ${reason} goes to the phone`, async () => {
      const { ex, calls, granted } = executor({ taskPolicy: look(), classifyCall: () => ({ tier: 'unsafe', reason }) });
      const result = await ex.execute('BrowserPage', SNAPSHOT);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, SNAPSHOT);
      assert.equal(result.success, true, 'the requester said yes');
      assert.equal(granted.length, 0);
    });
  }

  it('an ask rule goes to the phone, and a no stands', async () => {
    const seen = [];
    const { ex } = executor({
      taskPolicy: look(),
      approvalRequester: async (toolName) => { seen.push(toolName); return false; },
      permissionRules: [{ tool: 'BrowserPage', pattern: 'snapshot', action: 'ask', source: 'user' }]
    });
    const result = await ex.execute('BrowserPage', SNAPSHOT);
    assert.deepEqual(seen, ['BrowserPage']);
    assert.equal(result.success, false);
    assert.deepEqual(ran, []);
  });

  it('a denied tier and a deny rule still refuse', async () => {
    const tier = executor({ taskPolicy: look(), classifyCall: () => ({ tier: 'denied', reason: 'matched_deny_policy' }) });
    assert.equal((await tier.ex.execute('BrowserPage', SNAPSHOT)).deniedBy, 'policy');
    assert.equal(tier.calls.length, 0);
    const rule = executor({ taskPolicy: look(), permissionRules: [{ tool: 'BrowserPage', pattern: 'snapshot', action: 'deny', source: 'user' }] });
    assert.equal((await rule.ex.execute('BrowserPage', SNAPSHOT)).deniedBy, 'rule');
    assert.equal(rule.calls.length, 0);
    assert.deepEqual(ran, []);
  });

  it('a navigation with nothing bounding it is held the same way; on a grant site it is the owner\'s allow', async () => {
    const NAV = { action: 'navigate', url: 'https://a.example.com/' };
    const always = () => ({ tier: 'unsafe', reason: 'matched_always_confirm' });
    const unbounded = executor({ taskPolicy: look(), classifyCall: always });
    await unbounded.ex.execute('BrowserPage', NAV);
    assert.equal(unbounded.calls.length, 1);
    const onGrant = executor({ classifyCall: always });
    await onGrant.ex.execute('BrowserPage', NAV);
    assert.equal(onGrant.calls.length, 0);
  });

  it('a refuseUnsafe run refuses a look-class allow on the per-tool flag', async () => {
    const { ex, calls } = executor({ refuseUnsafe: true, taskPolicy: look(), classifyCall: () => ({ tier: 'routine', reason: 'test' }) });
    const result = await ex.execute('BrowserPage', SNAPSHOT);
    assert.equal(result.success, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(ran, []);
  });
});

describe('create-core carries the policy and the tool events', () => {
  const FAKE = 'kl-test-task-seams';
  let script = [];
  let currentDir = null;
  class FakeProvider {
    async sendMessageWithTools() {
      return script.shift() || { type: 'text', content: 'finished' };
    }
    buildToolMessages(response, toolResult, toolCallId) {
      return [
        { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
        { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
      ];
    }
  }
  before(() => ProviderFactory.registerProvider(FAKE, FakeProvider));
  after(() => ProviderFactory._registry.delete(FAKE));

  async function withCore(fn) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-task-seams-'));
    const phone = [];
    const core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals: 'phone',
      phoneApprover: { ttlMs: 300000, isAvailable: () => true, requestApproval: async (tool) => { phone.push(tool); return true; } },
      auditLedger: { append: async (e) => e },
      nodePolicy: { allowed_roots: [dataDir], remote_sessions: { always_confirm: [], deny: [] } }
    });
    try {
      core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: FAKE, model: 'fake' })));
      core.saveProviderToken(FAKE, 'fake-token-123456');
      await core.start();
      currentDir = dataDir;
      await fn(core, phone);
    } finally {
      await core.shutdown();
      closeOpenHistoryStores();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  // createCore registers the real browser tools over the fakes, so these turns call GATED.
  const allowAll = { decide: async () => ({ allow: true }) };
  const gatedReply = () => ({ type: 'tool_use', toolName: GATED, toolUseId: 'c1', parameters: {} });
  const run = (core, options) => core.context.getAgentExecutorAdapter().execute(core.context.getAgent('main'), 'go', { workingDirectory: currentDir, ...options });

  it('a turn with the policy runs its call with no phone, and reports the tool events', async () => {
    await withCore(async (core, phone) => {
      ran = [];
      script = [gatedReply()];
      const events = [];
      const result = await run(core, {
        executorOptions: {
          taskPolicy: allowAll,
          toolEvents: {
            pre: ({ toolName, parameters }) => events.push(['pre', toolName, parameters]),
            post: ({ toolName, parameters, result: r }) => events.push(['post', toolName, parameters, r.success]),
          }
        }
      });
      assert.ok(result);
      assert.deepEqual(ran, [GATED]);
      assert.deepEqual(phone, []);
      assert.deepEqual(events, [['pre', GATED, {}], ['post', GATED, {}, true]]);
    });
  });

  it('the same turn with no policy asks the phone', async () => {
    await withCore(async (core, phone) => {
      ran = [];
      script = [gatedReply()];
      await run(core, { executorOptions: {} });
      assert.deepEqual(phone, [GATED]);
    });
  });

  it('a tool event that throws changes nothing', async () => {
    await withCore(async (core) => {
      ran = [];
      script = [gatedReply()];
      await run(core, {
        executorOptions: {
          taskPolicy: allowAll,
          toolEvents: { pre: () => { throw new Error('pre'); }, post: () => { throw new Error('post'); } }
        }
      });
      assert.deepEqual(ran, [GATED]);
    });
  });

  it('a child run through the rethreaded requester is held to the policy', async () => {
    await withCore(async (core, phone) => {
      ran = [];
      script = [gatedReply()];
      const requester = async () => { throw new Error('nobody asks in this run'); };
      requester.taskPolicy = taskPolicy({ ended: true });
      const res = await run(core, { approvalRequester: requester });
      assert.deepEqual(ran, [], 'the ended policy reached the child');
      assert.deepEqual(phone, []);
      assert.equal(res.tools[0].result.code, 'task_ended');
    });
  });
});
