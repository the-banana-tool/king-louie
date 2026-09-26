// tests/cases-executor-core.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { mergeSettings } = require('../src/core/settings');
const { resolveExecutorSettings } = require('../src/cases/executors/defaults');
const { loadServiceConfig, validateExecutors } = require('../src/service/config');
const { registerExecutorHandlers } = require('../src/ipc/executor-handlers');
const IPC = require('../src/ipc/constants');
const { ExecutorRegistry, JobStore } = require('../src/cases/executors');
const envelopeOps = require('../src/cases/executors/envelope-ops');

after(fx.cleanup);

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
function adminDir(cfg) {
  const dir = fx.tempDir('kl-admin-');
  const file = path.join(dir, 'service.json');
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  return dir;
}

describe('settings.executors', () => {
  it('merges key by key over the defaults', () => {
    assert.deepStrictEqual(mergeSettings({}).executors, resolveExecutorSettings(undefined));
    const s = mergeSettings({ executors: { pollEveryMs: 120000, opsMemory: { maxEntries: 5 } } }).executors;
    assert.deepStrictEqual([s.pollEveryMs, s.submitTimeoutMs, s.opsMemory.maxEntries], [120000, 30000, 5]);
  });
});

describe('service.json executors', () => {
  it('reads entries and package roots from the admin config only', () => {
    const root = path.resolve('/opt/king-louie/executors');
    const admin = adminDir({ executors: { entries: { 'phone-agent': { kind: 'external-agent', package: 'phone-agent' } }, packageRoots: [root] } });
    const data = fx.tempDir('kl-data-');
    fs.writeFileSync(path.join(data, 'service.json'), JSON.stringify({ executors: { entries: { rogue: { kind: 'external-agent' } } } }));
    const cfg = loadServiceConfig(data, {}, { adminConfigDir: admin, geteuid: () => -1, adminUid: selfUid });
    assert.deepStrictEqual(cfg.executors, { entries: { 'phone-agent': { kind: 'external-agent', package: 'phone-agent' } }, packageRoots: [root] });
    const dataOnly = loadServiceConfig(data, {}, { adminConfigDir: fx.tempDir('kl-admin-'), geteuid: () => -1, adminUid: selfUid });
    assert.deepStrictEqual(dataOnly.executors, { entries: {}, packageRoots: [] }, 'the data-dir copy is ignored');
  });

  it('rejects unknown keys, bad ids and relative roots, naming the key', () => {
    // Ruling M7: the one unknown-key formatter (unknownKeyError).
    assert.throws(() => validateExecutors({ extra: 1 }, 'service.json'), /Invalid service\.json: unknown key "executors\.extra"/);
    assert.throws(() => validateExecutors({ entries: { 'Phone Agent': {} } }, 'service.json'), /executors\.entries\.Phone Agent is not a lowercase executor id/);
    assert.throws(() => validateExecutors({ packageRoots: ['relative/dir'] }, 'service.json'), /executors\.packageRoots must be a list of absolute paths/);
    assert.deepStrictEqual(validateExecutors(undefined, 'service.json'), { entries: {}, packageRoots: [] });
  });
});

// createCore on a temp data dir; with KL_CASES_ROOT unset the cases root is
// <dataDir>/cases.
function buildCore(extra = {}) {
  const { createCore } = require('../src/core');
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const { createAesGcmCipher } = require('../src/platform/cipher');
  const { createHeadlessPrompter } = require('../src/platform/prompter');
  const dataDir = fx.tempDir('kl-core-');
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    ...extra
  });
  return { core, dataDir };
}

function withoutCasesRootEnv(fn) {
  return async () => {
    const saved = process.env.KL_CASES_ROOT;
    delete process.env.KL_CASES_ROOT;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.KL_CASES_ROOT;
      else process.env.KL_CASES_ROOT = saved;
    }
  };
}

describe('createCore wiring', () => {
  it('builds the registry, gives it to the case runtime and registers the turn-start hook', withoutCasesRootEnv(() => {
    const { core } = buildCore();
    const registry = core.context.getExecutorRegistry();
    assert.ok(registry instanceof ExecutorRegistry);
    const runtime = core.context.getCaseRuntime();
    assert.strictEqual(runtime.host.getExecutorRegistry(), registry);
    assert.ok(runtime.hooks.some((h) => h.name === 'executors' && h.phase === 'turn-start'));
    assert.strictEqual(registry.isService, false);
    const { core: svc } = buildCore({ adminExecutors: { entries: {}, packageRoots: [] } });
    assert.strictEqual(svc.context.getExecutorRegistry().isService, true);
  }));

  it("keeps F7's injected host.interactive (R50)", withoutCasesRootEnv(() => {
    const interactive = () => true;
    assert.strictEqual(buildCore({ host: { interactive } }).core.context.getCaseRuntime().host.interactive, interactive);
    assert.strictEqual(buildCore().core.context.getCaseRuntime().host.interactive(), false, 'no UI attached');
  }));

  it('in service mode reads entries only from adminExecutors, with the root check bound to the service adminUid', withoutCasesRootEnv(() => {
    const { core } = buildCore({ adminExecutors: { entries: { 'phone-agent': { package: 'phone-agent' } }, packageRoots: ['/opt/kl/executors'] }, adminUid: 4242 });
    const settings = core.getSettings();
    core.context.setSettings({ ...settings, executors: { entries: { rogue: { package: 'rogue' } } } });
    const registry = core.context.getExecutorRegistry();
    assert.deepStrictEqual(Object.keys(registry._configured()), ['phone-agent']);
    assert.deepStrictEqual(registry._roots(), ['/opt/kl/executors']);
    assert.strictEqual(registry.adminUid, 4242);
    assert.strictEqual(typeof registry.assertRoot, 'function');
    if (process.platform !== 'win32') {
      // A root the test account owns is not owned by uid 4242.
      assert.throws(() => registry.assertRoot(fx.tempDir('kl-root-')), /executor packages/);
    }
    const desktop = buildCore().core.context.getExecutorRegistry();
    assert.deepStrictEqual([desktop.assertRoot, desktop.adminUid], [null, 0]);
  }));

  it('in service mode data-dir category keywords only add; on the desktop they replace', withoutCasesRootEnv(() => {
    const defaults = resolveExecutorSettings(undefined).outbound.categoryKeywords;
    const keywords = { financial: ['escrow'], health: [] };
    for (const [service, expectFinancial, expectHealth] of [
      [true, [...new Set([...defaults.financial, 'escrow'])], defaults.health],
      [false, ['escrow'], []]
    ]) {
      const { core } = buildCore(service ? { adminExecutors: { entries: {}, packageRoots: [] } } : {});
      const settings = core.getSettings();
      core.context.setSettings({ ...settings, executors: { outbound: { categoryKeywords: keywords } } });
      const got = core.context.getExecutorRegistry().settings().outbound.categoryKeywords;
      assert.deepStrictEqual([got.financial, got.health, got.legal], [expectFinancial, expectHealth, defaults.legal], `service ${service}`);
    }
  }));

  it('gives the signed-grant audit path the admin approver store, node id and key, and the audit ledger', withoutCasesRootEnv(() => {
    const approverStore = { admin: true };
    const auditLedger = { verify: () => ({ ok: true }), tail: () => [] };
    const { core } = buildCore({
      adminExecutors: { entries: {}, packageRoots: [] },
      auditLedger,
      approvalTrust: { approverStore, nodeId: 'kl-node', nodePublicKey: 'ab12' }
    });
    const o = envelopeOps.grantCheckOptions(core.context.getExecutorRegistry(), 'case-x', 'env-01');
    assert.deepStrictEqual([o.approverStore, o.nodeId, o.nodePublicKey, o.auditLedger], [approverStore, 'kl-node', 'ab12', auditLedger]);
    // Without it the audit path gets no trust and fails closed.
    const bare = envelopeOps.grantCheckOptions(buildCore().core.context.getExecutorRegistry(), 'case-x', 'env-01');
    assert.deepStrictEqual([bare.approverStore, bare.nodeId, bare.nodePublicKey, bare.auditLedger], [null, null, null, null]);
  }));
});

describe('createCore wiring of the case guard and isolated children', () => {
  const ProviderFactory = require('../src/providers/provider-factory');
  const browserTool = require('../src/tools/builtin/browser-tool');
  const FAKE = 'kl-test-executor-core-fake';
  const ORIGIN = { client: 'telegram', session: 'chat-9', job_id: null };
  const script = { calls: [], toolResults: [] };

  class FakeProvider {
    constructor() { this.n = 0; }
    async sendMessageWithTools(messages, tools, options) {
      this.n += 1;
      script.calls.push({ tools: (tools || []).map((t) => t.name || t.function?.name), systemPrompt: options?.systemPrompt || '' });
      if (this.n === 1) return { type: 'tool_use', toolName: 'WebFetch', toolUseId: 'call_1', parameters: { url: 'http://127.0.0.1:9/lot' } };
      return { type: 'text', content: 'done' };
    }
    buildToolMessages(response, toolResult, toolCallId) {
      script.toolResults.push(toolResult);
      return [
        { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
        { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
      ];
    }
  }

  let started = null;
  const savedRoot = process.env.KL_CASES_ROOT;
  async function shared() {
    if (started) return started;
    delete process.env.KL_CASES_ROOT;
    ProviderFactory.registerProvider(FAKE, FakeProvider);
    const { core, dataDir } = buildCore();
    await core.start();
    const tiers = { provider: FAKE, model: 'fake' };
    const settings = core.getSettings();
    core.context.setSettings({
      ...settings,
      activeProvider: FAKE,
      inference: { ...settings.inference, llmRouting: { enabled: false }, tierMap: { fast: tiers, standard: tiers, smart: tiers } }
    });
    core.saveProviderToken(FAKE, 'fake-token-123456');
    started = { core, dataDir };
    return started;
  }
  after(async () => {
    if (started) await started.core.shutdown().catch(() => {});
    ProviderFactory._registry.delete(FAKE);
    if (savedRoot === undefined) delete process.env.KL_CASES_ROOT;
    else process.env.KL_CASES_ROOT = savedRoot;
  });

  it('configures the case guard and hands a guardContext to the ToolExecutor (data-dir writes refused)', async () => {
    const { core, dataDir } = await shared();
    const ex = await core.context.createToolExecutorWithApprovals(null, null, null, { guardContext: { caseId: 'case-x' }, workingDirectory: dataDir });
    assert.deepStrictEqual(ex.extraToolOptions.guardContext, { caseId: 'case-x' });
    const target = path.join(dataDir, 'executors', 'evil.js');
    const r = await ex.execute('Write', { file_path: target, content: 'x' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /written only by King Louie/);
    assert.strictEqual(fs.existsSync(target), false);
    const plain = await core.context.createToolExecutorWithApprovals(null, null, null, { workingDirectory: dataDir });
    assert.strictEqual(plain.extraToolOptions.guardContext, null);
  });

  it('createAgentRuntime threads guardContext and allowedToolNames and keeps origin', async () => {
    const { core } = await shared();
    const rt = await core.context.createAgentRuntime({ tier: 'standard' }, null, null, {
      guardContext: { caseId: 'case-x' }, allowedToolNames: ['Read', 'Grep'], origin: ORIGIN
    });
    assert.deepStrictEqual(rt.toolExecutor.extraToolOptions.guardContext, { caseId: 'case-x' });
    assert.deepStrictEqual([...rt.toolExecutor.allowedToolNames].sort(), ['Grep', 'Read']);
    assert.deepStrictEqual(rt.toolExecutor.origin, ORIGIN);
    const open = await core.context.createAgentRuntime({ tier: 'standard' }, null, null, {});
    assert.deepStrictEqual([open.toolExecutor.extraToolOptions.guardContext, open.toolExecutor.allowedToolNames], [null, null]);
  });

  it('an isolated case-researcher child gets only its tools, no owner context, and is guarded for its case', async () => {
    const { core, dataDir } = await shared();
    const parent = await core.context.createToolExecutorWithApprovals(null, null, null, { workingDirectory: dataDir });
    const adapter = parent.extraToolOptions.agentExecutorAdapter;
    const researcher = parent.extraToolOptions.getAgent('case-researcher');
    script.calls.length = 0;
    script.toolResults.length = 0;
    await adapter.execute(researcher, 'Find the permit office hours', { isolatedContext: true, guardContext: { caseId: 'case-missing' } });
    for (const name of script.calls[0].tools) assert.ok(researcher.allowedTools.includes(name), `offered ${name}`);
    // The guard ran for the child: its case is unknown, so WebFetch is refused, never fetched.
    assert.strictEqual(script.toolResults[0].success, false);
    assert.match(script.toolResults[0].error, /^WebFetch is refused/);
    const isolatedPrompt = script.calls[0].systemPrompt;

    script.calls.length = 0;
    script.toolResults.length = 0;
    await adapter.execute(researcher, 'Find the permit office hours', {});
    assert.ok(script.calls[0].systemPrompt.length > isolatedPrompt.length, 'a normal child gets the memory, profile and project sections');
  });

  // SpawnAgent forwards neither guardContext nor allowedToolNames, so no case
  // run may reach it: owner and wake-up case turns refuse it (C2), and a
  // case's only children are isolated case-researchers without it.
  it('no case run can start an unguarded child through SpawnAgent', async () => {
    const { core, dataDir } = await shared();
    const { WAKEUP_BASE_TOOLS, CASE_TOOL_NAMES } = require('../src/cases/chat-integration');
    script.calls.length = 0;
    const owner = await core.context.createToolExecutorWithApprovals(null, null, null, {
      workingDirectory: dataDir, caseContext: { caseId: 'case-x', dir: dataDir }
    });
    const refused = await owner.execute('SpawnAgent', { task: 'Price the Lakeside lot' });
    assert.deepStrictEqual([refused.success, /not available in case turns/.test(refused.error)], [false, true]);
    assert.strictEqual(script.calls.length, 0, 'no child ran');
    assert.ok(![...CASE_TOOL_NAMES, ...WAKEUP_BASE_TOOLS].includes('SpawnAgent'), 'a wake-up never offers SpawnAgent');
    const researcher = owner.extraToolOptions.getAgent('case-researcher');
    assert.ok(!researcher.allowedTools.includes('SpawnAgent'));
    const child = await core.context.createAgentRuntime({ tier: 'standard' }, null, null,
      require('../src/agents/child-context').childRuntimeOptions(researcher, { isolatedContext: true, guardContext: { caseId: 'case-x' } }));
    const fromChild = await child.toolExecutor.execute('SpawnAgent', { task: 'Price the Lakeside lot' });
    assert.deepStrictEqual([fromChild.success, fromChild.error], [false, 'Tool "SpawnAgent" is not available in this turn.']);
    assert.strictEqual(script.calls.length, 0, 'no grandchild ran');
  });

  it("gives the WorkflowEngine the registry's trusted child extras", async () => {
    const { core, dataDir } = await shared();
    const engine = core.context.getWorkflowEngine();
    assert.strictEqual(typeof engine.resolveExecuteExtras, 'function');
    fs.mkdirSync(path.join(dataDir, 'executors'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'executors', 'jobs.json'), JSON.stringify({
      'case-x/job-0001': { executor: 'workflow', externalId: 'wf-9', state: 'running' }
    }));
    const extras = engine.resolveExecuteExtras({ id: 'wf-9' });
    assert.deepStrictEqual([extras.isolatedContext, extras.guardContext], [true, { caseId: 'case-x' }]);
    assert.ok(extras.allowedToolNames.includes('WebFetch'));
    assert.strictEqual(engine.resolveExecuteExtras({ id: 'wf-other' }), null);
  });

  it('refuses browser actions in a guarded run while the browser is open in another profile', async () => {
    const { core, dataDir } = await shared();
    const ex = await core.context.createToolExecutorWithApprovals(null, null, null, { guardContext: { caseId: 'case-x' }, workingDirectory: dataDir });
    const real = browserTool.actions.profile_current;
    browserTool.actions.profile_current = async () => ({ ok: true, active: 'personal', running: true });
    try {
      const r = await ex.execute('BrowserPage', { action: 'screenshot' });
      assert.strictEqual(r.success, false);
      assert.match(r.error, /open with profile "personal"/);
    } finally {
      browserTool.actions.profile_current = real;
    }
  });
});

describe('case browser profile guard', () => {
  const { caseBrowserProfileGuard, configureCaseGuard } = require('../src/cases/executors/case-guard');
  const ctx = { guardContext: { caseId: 'case-x' } };
  after(() => configureCaseGuard({}));

  it('lets a guarded run use the browser only in the cases profile', async () => {
    const answer = { value: null };
    configureCaseGuard({ browserProfile: async () => {
      if (answer.value instanceof Error) throw answer.value;
      return answer.value;
    } });
    answer.value = { ok: true, active: 'kl-cases', running: true };
    assert.strictEqual(await caseBrowserProfileGuard('BrowserPage', { action: 'click' }, ctx), null);
    answer.value = { ok: true, active: null, running: false };
    assert.strictEqual(await caseBrowserProfileGuard('BrowserPage', { action: 'click' }, ctx), null, 'nothing running: the action fails on its own');
    answer.value = { ok: true, active: 'personal', running: true };
    const refused = await caseBrowserProfileGuard('BrowserExtract', { action: 'content' }, ctx);
    assert.strictEqual(refused.success, false);
    assert.match(refused.error, /open with profile "personal"/);
    assert.strictEqual(await caseBrowserProfileGuard('BrowserExtract', { action: 'content' }, {}), null, 'not a case run');
    assert.strictEqual(await caseBrowserProfileGuard('WebFetch', { url: 'https://example.com' }, ctx), null, 'not a browser tool');
    for (const action of ['start', 'stop', 'status', 'profile_current', 'profile_list']) {
      assert.strictEqual(await caseBrowserProfileGuard('BrowserSession', { action }, ctx), null, action);
    }
    answer.value = new Error('boom');
    assert.match((await caseBrowserProfileGuard('Browser', { action: 'navigate', url: 'https://example.com' }, ctx)).error, /could not be read/);
    answer.value = null;
    assert.match((await caseBrowserProfileGuard('Browser', { action: 'navigate', url: 'https://example.com' }, ctx)).error, /could not be read/);
  });
});

describe('executor IPC', () => {
  async function setup({ withRegistry = true } = {}) {
    const env = fx.setupExecutors();
    const ctl = fx.withFakeAgent(env);
    const meta = await fx.activeCase(env.runtime);
    const handlers = new Map();
    registerExecutorHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, {
      getExecutorRegistry: () => (withRegistry ? env.registry : null),
      getCaseRuntime: () => env.runtime
    });
    return { env, ctl, meta, call: (ch, payload) => handlers.get(ch)({}, payload) };
  }

  it('lists executors with their availability and pins', async () => {
    const s = await setup();
    const r = await s.call(IPC.EXECUTORS_LIST, {});
    assert.strictEqual(r.ok, true);
    const fake = r.executors.find((e) => e.id === 'fake-agent');
    assert.deepStrictEqual([fake.available, typeof fake.computedSha256], [true, 'string']);
  });

  it('lists envelopes, cancels a job and revokes an envelope for the owner', async () => {
    const s = await setup();
    const req = await envelopeOps.requestEnvelope(s.env.registry, { caseId: s.meta.id }, {
      executor: 'fake-agent', intent: 'Ask brokers for a listing quote', recipients: { allow: ['+15550100'] },
      caps: { usd: 5, contacts: 1, attemptsPerContact: 1 }, window: { start: '2026-10-26', end: '2026-10-30' }
    });
    const listed = await s.call(IPC.CASE_ENVELOPES, { caseId: s.meta.id });
    assert.deepStrictEqual(listed.envelopes.map((e) => [e.id, e.status]), [[req.envelopeId, 'requested']]);
    const job = new JobStore(s.meta.dir).create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', state: 'submitted', externalId: 'ext-7', envelopeId: req.envelopeId });
    s.ctl.jobs.set('ext-7', { state: 'running', contacts: [] });
    assert.deepStrictEqual(await s.call(IPC.CASE_CANCEL_JOB, { caseId: s.meta.id, jobId: job.id }), { ok: true, jobId: job.id, state: 'cancelled' });
    assert.deepStrictEqual(await s.call(IPC.CASE_REVOKE_ENVELOPE, { caseId: s.meta.id, envelopeId: req.envelopeId }), { ok: true, cancelled: [] });
    assert.deepStrictEqual(await s.call(IPC.CASE_CANCEL_JOB, { caseId: s.meta.id }), { ok: false, error: 'caseId and jobId are required.' });
  });

  it('reports a host without executors', async () => {
    const s = await setup({ withRegistry: false });
    assert.deepStrictEqual(await s.call(IPC.EXECUTORS_LIST, {}), { ok: false, error: 'Executors are not available in this host.' });
  });
});
