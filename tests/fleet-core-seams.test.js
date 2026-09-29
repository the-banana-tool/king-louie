// tests/fleet-core-seams.test.js — fleet stage 4 §3.8 "Two small core edits".
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const AgentExecutor = require('../src/agents/agent-executor');
const { REFUSE_UNSAFE_MESSAGE } = require('../src/approvals/executor-options');
const { profileSettings, everyRole } = require('./helpers/profile-settings');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const FAKE = 'kl-test-seams-fake';
const GATED = 'KlSeamsGated';
const UNSAFE = 'KlSeamsUnsafe';
let unsafeRuns = 0;
let script = [];
class FakeProvider {
  async sendMessageWithTools() {
    const next = script.shift();
    return next || { type: 'text', content: 'finished' };
  }
  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }
}

const temps = [];
afterEach(() => { closeOpenHistoryStores(); while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });
before(() => {
  ProviderFactory.registerProvider(FAKE, FakeProvider);
  if (!toolRegistry.get(GATED)) {
    toolRegistry.register(new Tool({ name: GATED, description: 'test', parameters: { type: 'object', properties: {} }, requiresApproval: false, execute: async () => ({ ok: true }) }));
  }
  if (!toolRegistry.get(UNSAFE)) {
    toolRegistry.register(new Tool({ name: UNSAFE, description: 'test', parameters: { type: 'object', properties: {} }, requiresApproval: true, execute: async () => { unsafeRuns += 1; return { ok: true }; } }));
  }
});
after(() => { ProviderFactory._registry.delete(FAKE); });

async function phoneCore({ remoteApprovals = 'phone', withPolicy = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-seams-'));
  temps.push(dataDir);
  const calls = [];
  const audit = [];
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    remoteApprovals,
    phoneApprover: { ttlMs: 300000, isAvailable: () => true, requestApproval: async (tool, params, meta) => { calls.push({ tool, origin: meta.origin }); return true; } },
    auditLedger: { append: async (e) => { audit.push(e); return e; } },
    ...(withPolicy ? { nodePolicy: { allowed_roots: [dataDir], remote_sessions: { always_confirm: [GATED], deny: [] } } } : {})
  });
  core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: FAKE, model: 'fake' })));
  core.saveProviderToken(FAKE, 'fake-token-123456');
  await core.start();
  return { core, calls, audit, dataDir };
}

const ORIGIN = { client: 'Example Client', session: 'mcp-1', job_id: 'job-1' };

describe('core seams for delegate turns', () => {
  it('getAgentExecutorAdapter hands out the adapter, and executorOptions.origin reaches the phone and the audit', async () => {
    const { core, calls, audit, dataDir } = await phoneCore();
    try {
      script = [{ type: 'tool_use', toolName: GATED, toolUseId: 'c1', parameters: {} }];
      const adapter = core.context.getAgentExecutorAdapter();
      const res = await adapter.execute(core.context.getAgent('main'), 'go', { workingDirectory: dataDir, executorOptions: { origin: ORIGIN, chatId: 'delegate:job-1' } });
      assert.equal(res.content, 'finished');
      assert.deepEqual(calls, [{ tool: GATED, origin: ORIGIN }]);
      assert.ok(audit.some((e) => e.kind === 'exec.start' && e.data.origin.job_id === 'job-1'), JSON.stringify(audit));
    } finally {
      await core.shutdown();
    }
  });

  it('refuseUnsafe: an unsafe call is refused locally with the spec text, and the phone is never asked', async () => {
    const { core, calls, dataDir } = await phoneCore();
    try {
      script = [{ type: 'tool_use', toolName: GATED, toolUseId: 'c1', parameters: {} }];
      const res = await core.context.getAgentExecutorAdapter().execute(core.context.getAgent('main'), 'go', {
        workingDirectory: dataDir, executorOptions: { origin: ORIGIN, chatId: 'delegate:job-1', refuseUnsafe: true }
      });
      assert.deepEqual(calls, []);
      assert.equal(res.tools[0].result.success, false);
      assert.equal(res.tools[0].result.error, REFUSE_UNSAFE_MESSAGE);
      assert.equal(REFUSE_UNSAFE_MESSAGE, 'This client may not request unsafe actions (fleet:unsafe not granted). Nothing ran.');
    } finally {
      await core.shutdown();
    }
  });
});

describe('AgentExecutor passes abortSignal and evidenceLedger to the loop', () => {
  const agent = { id: 'a', name: 'a', maxIterations: 5, autoApproveTools: [], canUseTool: () => true };
  const provider = (responses) => {
    let i = 0;
    return { sendMessageWithTools: async () => responses[i++] || { type: 'text', content: 'done' }, buildToolMessages: (r, res, id) => [{ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: r.toolName, arguments: '{}' } }] }, { role: 'tool', tool_call_id: id, content: JSON.stringify(res) }] };
  };

  it('a pre-aborted signal stops the loop before the provider is called', async () => {
    let called = 0;
    const p = provider([]);
    const wrapped = { ...p, sendMessageWithTools: async (...a) => { called += 1; return p.sendMessageWithTools(...a); } };
    const controller = new AbortController();
    controller.abort();
    const res = await new AgentExecutor(wrapped, { execute: async () => ({ ok: true }) }).execute(agent, 'hi', { abortSignal: controller.signal });
    assert.equal(res.type, 'stopped');
    assert.equal(called, 0);
  });

  it('the supplied evidence ledger sees the turn\'s edits', async () => {
    const marked = [];
    const ledger = { markEdited: (root, paths) => marked.push(...paths), record: () => null, status: () => ({}) };
    const p = provider([{ type: 'tool_use', toolName: 'Write', toolUseId: 't1', parameters: { filePath: '/srv/x.txt' } }]);
    const exec = { execute: async () => ({ success: true, filePath: '/srv/x.txt' }) };
    await new AgentExecutor(p, exec).execute(agent, 'write', { evidenceLedger: ledger, tools: [{ name: 'Write', description: '', parameters: {} }], workingDirectory: '/srv' });
    assert.deepEqual(marked, ['/srv/x.txt']);
  });
});

describe('the fleet:unsafe gate is inherited and never widens F3', () => {
  const { approvalSeam } = require('../src/approvals/executor-options');
  const ToolExecutor = require('../src/execution/tool-executor');
  const phoneApprover = { ttlMs: 300000, requestApproval: async () => true };
  const unsafeClassify = () => ({ tier: 'unsafe', reason: 'always_confirm' });

  it('without refuseUnsafe the phone-mode options carry no gate', () => {
    const seam = approvalSeam({ remoteApprovals: 'phone', phoneApprover, nodePolicy: { allowed_roots: [], remote_sessions: { always_confirm: [], deny: [] } } });
    assert.equal(seam.toolExecutorOptions.refuseUnsafe, undefined);
    assert.equal(typeof seam.toolExecutorOptions.approvalRequester, 'function');
  });

  it('a re-threaded requester carries origin and refuseUnsafe, and a child seam built from it refuses unsafe calls', () => {
    const origin = { client: 'Example Client', session: 'mcp-1', job_id: 'job-1' };
    const parent = new ToolExecutor({ origin, refuseUnsafe: true, classifyCall: unsafeClassify });
    const requester = parent._rethreadedRequester();
    assert.equal(requester.refuseUnsafe, true);
    assert.deepEqual(requester.origin, origin);
    // The child passes no executorOptions.refuseUnsafe: the requester alone keeps the gate.
    const seam = approvalSeam({ remoteApprovals: 'phone', phoneApprover, approvalRequester: requester, executorOptions: { refuseUnsafe: false } });
    assert.equal(seam.toolExecutorOptions.refuseUnsafe, true);
    const { refuseUnsafeClassifier } = require('../src/approvals/executor-options');
    assert.deepEqual(refuseUnsafeClassifier(unsafeClassify)('X', {}, {}), { tier: 'denied', reason: 'fleet_unsafe_not_granted', message: REFUSE_UNSAFE_MESSAGE });
    assert.deepEqual(refuseUnsafeClassifier(() => ({ tier: 'routine', reason: 'r' }))('X', {}, {}), { tier: 'routine', reason: 'r' });
  });
});

// T10 ruling: refuseUnsafe fails closed in every approval mode.
describe('refuseUnsafe fails closed in every approval mode', () => {
  const REFUSE = { executorOptions: { origin: ORIGIN, chatId: 'delegate:job-1', refuseUnsafe: true } };

  async function run(core, dataDir, toolName, extra = {}) {
    script = [{ type: 'tool_use', toolName, toolUseId: 'c1', parameters: {} }];
    const res = await core.context.getAgentExecutorAdapter().execute(core.context.getAgent('main'), 'go', { workingDirectory: dataDir, ...extra });
    return res.tools[0].result;
  }

  it("'allow' mode: an unsafe call is refused and the requester is never asked; a routine call runs", async () => {
    const { core, dataDir } = await phoneCore({ remoteApprovals: 'allow', withPolicy: false });
    try {
      const asked = [];
      const approvalRequester = async (tool) => { asked.push(tool); return true; };
      const before = unsafeRuns;
      const refused = await run(core, dataDir, UNSAFE, { ...REFUSE, approvalRequester });
      assert.equal(refused.success, false);
      assert.equal(refused.error, REFUSE_UNSAFE_MESSAGE);
      assert.equal(unsafeRuns, before);
      assert.deepEqual(asked, []);
      const ok = await run(core, dataDir, GATED, { ...REFUSE, approvalRequester });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.deepEqual(asked, []);
    } finally {
      await core.shutdown();
    }
  });

  it("'allow' mode without refuseUnsafe is unchanged: the requester answers the unsafe call", async () => {
    const { core, dataDir } = await phoneCore({ remoteApprovals: 'allow', withPolicy: false });
    try {
      const asked = [];
      const approvalRequester = async (tool) => { asked.push(tool); return true; };
      const before = unsafeRuns;
      const res = await run(core, dataDir, UNSAFE, { executorOptions: { origin: ORIGIN }, approvalRequester });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.deepEqual(asked, [UNSAFE]);
      assert.equal(unsafeRuns, before + 1);
    } finally {
      await core.shutdown();
    }
  });

  it('phone mode without nodePolicy: an unsafe call is refused and the phone is never called; a routine call runs', async () => {
    const { core, calls, dataDir } = await phoneCore({ withPolicy: false });
    try {
      const refused = await run(core, dataDir, UNSAFE, REFUSE);
      assert.equal(refused.error, REFUSE_UNSAFE_MESSAGE);
      const ok = await run(core, dataDir, GATED, REFUSE);
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.deepEqual(calls, []);
    } finally {
      await core.shutdown();
    }
  });

  it('phone mode without nodePolicy and without refuseUnsafe is unchanged: the phone answers', async () => {
    const { core, calls, dataDir } = await phoneCore({ withPolicy: false });
    try {
      const res = await run(core, dataDir, UNSAFE, { executorOptions: { origin: ORIGIN } });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.deepEqual(calls, [{ tool: UNSAFE, origin: ORIGIN }]);
    } finally {
      await core.shutdown();
    }
  });

  it('a call that would ask a person (an ask rule, a hook confirm) is refused, never asked', async () => {
    const ToolExecutor = require('../src/execution/tool-executor');
    const asked = [];
    const approvalRequester = async (tool) => { asked.push(tool); return true; };
    const askRule = new ToolExecutor({ runtimeEnvironment: {}, useSandbox: false, refuseUnsafe: true, approvalRequester,
      permissionRules: [{ tool: GATED, action: 'ask', source: 'test' }] });
    assert.equal((await askRule.execute(GATED, {})).error, REFUSE_UNSAFE_MESSAGE);
    const hook = new ToolExecutor({ runtimeEnvironment: {}, useSandbox: false, refuseUnsafe: true, approvalRequester,
      hookExecutor: { run: async () => ({ action: 'confirm', message: 'check' }) } });
    assert.equal((await hook.execute(GATED, {})).error, REFUSE_UNSAFE_MESSAGE);
    assert.deepEqual(asked, []);
    // Read-only and routine calls still run.
    const plain = new ToolExecutor({ runtimeEnvironment: {}, useSandbox: false, refuseUnsafe: true, approvalRequester });
    assert.equal((await plain.execute(GATED, {})).ok, true);
    assert.deepEqual(asked, []);
  });
});

// Fix round 1: pin the fail-closed wrap itself (the ToolExecutor constructor
// wrap, refuseUnsafeGate's fallback, and the seam's phone-mode wrap).
describe('the refuseUnsafe wrap is load-bearing', () => {
  const ToolExecutor = require('../src/execution/tool-executor');
  const { approvalSeam } = require('../src/approvals/executor-options');
  const ABS = path.resolve(os.tmpdir(), 'kl-seams-abs', 'x.txt');
  const spies = {};
  const originals = {};

  before(() => {
    for (const name of ['Read', 'Glob']) {
      const tool = toolRegistry.get(name);
      originals[name] = tool.execute;
      spies[name] = 0;
      tool.execute = async () => { spies[name] += 1; return { success: true }; };
    }
  });
  after(() => { for (const name of Object.keys(originals)) toolRegistry.get(name).execute = originals[name]; });

  it('no classifier, refuseUnsafe: Read and Glob on an absolute path are refused, never run, never asked', async () => {
    const asked = [];
    const ex = new ToolExecutor({ runtimeEnvironment: {}, useSandbox: false, refuseUnsafe: true, approvalRequester: async (t) => { asked.push(t); return true; } });
    const read = await ex.execute('Read', { file_path: ABS });
    const glob = await ex.execute('Glob', { pattern: '*', cwd: path.dirname(ABS) });
    assert.equal(read.error, REFUSE_UNSAFE_MESSAGE);
    assert.equal(glob.error, REFUSE_UNSAFE_MESSAGE);
    assert.deepEqual(spies, { Read: 0, Glob: 0 });
    assert.deepEqual(asked, []);
  });

  it("'allow' mode: a delegate turn with refuseUnsafe that Reads a path is refused", async () => {
    const { core, dataDir } = await phoneCore({ remoteApprovals: 'allow', withPolicy: false });
    try {
      const asked = [];
      script = [{ type: 'tool_use', toolName: 'Read', toolUseId: 'c1', parameters: { file_path: path.join(dataDir, 'x.txt') } }];
      const res = await core.context.getAgentExecutorAdapter().execute(core.context.getAgent('main'), 'go', {
        workingDirectory: dataDir,
        approvalRequester: async (t) => { asked.push(t); return true; },
        executorOptions: { origin: ORIGIN, chatId: 'delegate:job-1', refuseUnsafe: true }
      });
      assert.equal(res.tools[0].result.error, REFUSE_UNSAFE_MESSAGE);
      assert.equal(spies.Read, 0);
      assert.deepEqual(asked, []);
    } finally {
      await core.shutdown();
    }
  });

  it('a refuseUnsafe executor re-threads a requester that always answers false, keeping origin and the flag', async () => {
    const asked = [];
    const ex = new ToolExecutor({ refuseUnsafe: true, origin: ORIGIN, approvalRequester: async (t) => { asked.push(t); return true; } });
    const requester = ex._rethreadedRequester();
    assert.equal(await requester('Bash', { command: 'ls' }, {}), false);
    assert.deepEqual(asked, []);
    assert.equal(requester.refuseUnsafe, true);
    assert.deepEqual(requester.origin, ORIGIN);
  });

  it('approvalSeam in phone mode wraps the node-policy classifier itself', () => {
    const seam = approvalSeam({
      remoteApprovals: 'phone',
      phoneApprover: { ttlMs: 300000, requestApproval: async () => true },
      nodePolicy: { allowed_roots: [os.tmpdir()], remote_sessions: { always_confirm: [GATED], deny: [] } },
      executorOptions: { refuseUnsafe: true }
    });
    assert.deepEqual(seam.toolExecutorOptions.classifyCall(GATED, {}, {}), { tier: 'denied', reason: 'fleet_unsafe_not_granted', message: REFUSE_UNSAFE_MESSAGE });
  });
});
