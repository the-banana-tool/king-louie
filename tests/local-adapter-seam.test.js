// tests/local-adapter-seam.test.js
// The adapter seam (spec 2026-10-13-local-inference-design.md §12; R-LI-15).
// A local target may name an adapter: the owner (desktop) or the
// administrator (service mode) declares it for one model, with what the
// server calls it (`ref`), and the model's digest at that moment is kept as
// `baseDigest`. A target with an adapter sends the adapter's ref as the
// request's model; an unknown adapter, or one made for another version of the
// model, makes the target unusable, and the next target in the role is used.
// Nothing here trains, stores or evaluates an adapter. Servers are fake
// servers on 127.0.0.1.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../src/models/roles');
const { normalizeProfile } = require('../src/models/profiles');
const { createTurnModels } = require('../src/models/resolver');
const { LocalServers, ADAPTER_JOBS } = require('../src/models/local-servers');
const { parseLocalInferenceConfig } = require('../src/service/config');
const InferenceRouter = require('../src/providers/inference-router');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const HI = [{ role: 'user', content: 'Name this chat.' }];
const DIGEST_A = 'a1'.repeat(32);
const DIGEST_B = 'b2'.repeat(32);
const t = (provider, model, extra = {}) => ({ provider, model, effort: null, ...extra });

const entry = (id, baseUrl, over = {}) => ({
  id, name: id === 'workstation' ? 'Workstation' : id, kind: 'ollama', baseUrl, tlsFingerprint: null, allowCgnat: false,
  maxConcurrent: 2, timeoutMs: null, pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT, ...over
});

describe('targets that name an adapter', () => {
  it('normalizeTarget keeps a slug adapter on a local target only, and a target without one is as before', () => {
    assert.deepStrictEqual(R.normalizeTarget({ provider: 'local', model: 'workstation/qwen3:8b', adapter: 'titles-1' }),
      { provider: 'local', model: 'workstation/qwen3:8b', effort: null, adapter: 'titles-1' });
    const plain = R.normalizeTarget({ provider: 'local', model: 'workstation/qwen3:8b' });
    assert.deepStrictEqual(Object.keys(plain), ['provider', 'model', 'effort']);
    assert.deepStrictEqual(R.normalizeTarget({ provider: 'openai', model: 'gpt-5.5', adapter: 'titles-1' }), t('openai', 'gpt-5.5'));
    assert.deepStrictEqual(Object.keys(R.normalizeTarget({ provider: 'ollama', model: 'qwen3:8b', adapter: 'titles-1' })), ['provider', 'model', 'effort']);
    for (const bad of ['', 'Titles', 'titles 1', 't', '1-titles', 'a'.repeat(41), 42, null]) {
      assert.strictEqual('adapter' in R.normalizeTarget({ provider: 'local', model: 'workstation/qwen3:8b', adapter: bad }), false, String(bad));
    }
  });

  it('targetKey and targetLabel name the adapter; without one they are byte-identical to before', () => {
    const base = t('local', 'workstation/qwen3:8b');
    const tuned = t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' });
    assert.strictEqual(R.targetKey(base), 'local:workstation/qwen3:8b');
    assert.strictEqual(R.targetKey(tuned), 'local:workstation/qwen3:8b@titles-1');
    assert.strictEqual(R.targetLabel(base), 'local/workstation/qwen3:8b');
    assert.strictEqual(R.targetLabel(tuned), 'local/workstation/qwen3:8b + titles-1');
    assert.strictEqual(R.targetKey(t('openai', 'gpt-5.5')), 'openai:gpt-5.5');
    assert.strictEqual(R.targetLabel(t('openai', 'gpt-5.5')), 'openai/gpt-5.5');
  });

  it('a usage record carries the adapter of a local call, and only of one', () => {
    const UsageTracker = require('../src/tracking/usage-tracker');
    const local = { server: 'workstation', class: 'loopback' };
    assert.strictEqual(UsageTracker.eventFromMetrics({ provider: 'local', model: 'workstation/qwen3:8b', costUsd: 0, local, adapter: 'titles-1' }).adapter, 'titles-1');
    assert.strictEqual('adapter' in UsageTracker.eventFromMetrics({ provider: 'local', model: 'workstation/qwen3:8b', costUsd: 0, local }), false);
    assert.strictEqual('adapter' in UsageTracker.eventFromMetrics({ provider: 'openai', model: 'gpt-5.5', costUsd: 0.01, adapter: 'titles-1' }), false);
    assert.strictEqual('adapter' in UsageTracker.eventFromMetrics({ provider: 'local', model: 'workstation/qwen3:8b', costUsd: 0, local, adapter: 'Not An Id' }), false);
  });

  it('the same model with and without an adapter are two entries in a role, and resolve in order', () => {
    const profile = normalizeProfile({
      id: 'p-1', name: 'Local', kind: 'user',
      roles: { main: [], worker: [], utility: [t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' }), t('local', 'workstation/qwen3:8b'), t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' })] }
    });
    assert.deepStrictEqual(profile.roles.utility, [t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' }), t('local', 'workstation/qwen3:8b')]);
    const asked = [];
    const models = createTurnModels({ profile, explain: (provider, model, options) => { asked.push({ provider, model, adapter: options.adapter ?? null }); return { usable: true }; } });
    assert.deepStrictEqual(models.resolve('utility').targets, profile.roles.utility);
    assert.deepStrictEqual(asked, [
      { provider: 'local', model: 'workstation/qwen3:8b', adapter: 'titles-1' },
      { provider: 'local', model: 'workstation/qwen3:8b', adapter: null }
    ], 'explain is asked about the adapter');
  });
});

describe('declaring adapters and using them', () => {
  let server;
  const dirs = [];
  const open = [];

  before(async () => {
    server = await startFakeLlmServer();
  });
  after(async () => { await server.close(); });
  afterEach(() => {
    while (open.length) open.pop().close();
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  });

  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-adapter-seam-')); dirs.push(d); return d; };
  const serveDigest = (digest) => server.setOllamaModels({ 'qwen3:8b': { digest, model_info: { 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools'] } });

  function registry({ dir = tmp(), entries = [entry('workstation', `${server.url}/ollama`)], ...extra } = {}) {
    const probeFile = path.join(dir, 'models', 'local-probes.json');
    const servers = new LocalServers({ getEntries: () => entries, catalog: fixtureCatalog(), probeFile, writeEntries: () => {}, ...extra });
    open.push(servers);
    return { servers, probeFile, dir };
  }

  function route(servers, targets) {
    const router = new InferenceRouter({
      getProviderToken: () => null,
      createProvider: (provider, token, target) => servers.providerFor(servers.splitModel(target.model).serverId),
      isGuaranteeTarget: (target) => servers.isGuaranteeTarget(target),
      sleep: async () => {}
    });
    return router.routedProvider({ targets });
  }
  const chatPosts = () => server.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/chat/completions'));

  it('the job ids are the spec\'s', () => {
    assert.deepStrictEqual([...ADAPTER_JOBS], ['title', 'classify', 'orient', 'rewrite', 'rerank', 'digest', 'abstain-check']);
  });

  it('declareAdapter records the model\'s current digest as baseDigest, and the record keeps it through a restart and a new probe', async () => {
    serveDigest(DIGEST_A);
    const { servers, dir } = registry();
    await servers.probe('workstation', 'qwen3:8b');
    const digest = servers.probeRecord('workstation', 'qwen3:8b').digest;
    assert.ok(digest && digest.endsWith(DIGEST_A));
    const record = servers.declareAdapter('workstation', 'qwen3:8b', { id: 'titles-1', job: 'title', ref: 'qwen3-titles-1' });
    assert.strictEqual(record.adapters.length, 1);
    const [adapter] = record.adapters;
    assert.deepStrictEqual({ ...adapter, addedAt: typeof adapter.addedAt }, { id: 'titles-1', job: 'title', ref: 'qwen3-titles-1', baseDigest: digest, addedAt: 'string' });
    await servers.probe('workstation', 'qwen3:8b');
    assert.deepStrictEqual(servers.probeRecord('workstation', 'qwen3:8b').adapters, [adapter], 'a new probe keeps the declared adapters');
    const again = registry({ dir });
    assert.deepStrictEqual(again.servers.probeRecord('workstation', 'qwen3:8b').adapters, [adapter], 'read back from the probe file');
    // Declaring the same id again replaces it (one per id, per model).
    again.servers.declareAdapter('workstation', 'qwen3:8b', { id: 'titles-1', job: 'title', ref: 'qwen3-titles-2' });
    assert.deepStrictEqual(again.servers.probeRecord('workstation', 'qwen3:8b').adapters.map((a) => a.ref), ['qwen3-titles-2']);
  });

  it('declareAdapter refuses what it cannot record', async () => {
    serveDigest(DIGEST_A);
    const { servers } = registry();
    assert.throws(() => servers.declareAdapter('workstation', 'qwen3:8b', { id: 'titles-1', job: 'title', ref: 'qwen3-titles-1' }), (err) => err.code === 'LOCAL_ADAPTER_INVALID' && /probe/i.test(err.message), 'an unprobed model has no digest to bind to');
    await servers.probe('workstation', 'qwen3:8b');
    const bad = [
      { id: 'Titles', job: 'title', ref: 'r' },
      { id: 'titles-1', job: 'translate', ref: 'r' },
      { id: 'titles-1', job: 'title', ref: '' },
      { id: 'titles-1', job: 'title', ref: 'two\nlines' },
      { id: 'titles-1', job: 'title', ref: 'r', baseDigest: 'sha256:' + DIGEST_B }
    ];
    for (const decl of bad) {
      assert.throws(() => servers.declareAdapter('workstation', 'qwen3:8b', decl), (err) => err.code === 'LOCAL_ADAPTER_INVALID', JSON.stringify(decl));
    }
    assert.throws(() => servers.declareAdapter('gone', 'qwen3:8b', { id: 'titles-1', job: 'title', ref: 'r' }), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
    assert.deepStrictEqual(servers.probeRecord('workstation', 'qwen3:8b').adapters, []);
  });

  it('R-LI-15: a target with an adapter sends the adapter\'s ref', async () => {
    serveDigest(DIGEST_A);
    const { servers } = registry();
    await servers.probe('workstation', 'qwen3:8b');
    servers.declareAdapter('workstation', 'qwen3:8b', { id: 'titles-1', job: 'title', ref: 'qwen3-titles-1' });
    const provider = servers.providerFor('workstation');
    assert.strictEqual(provider.requestModelFor(t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' })), 'qwen3-titles-1');
    assert.strictEqual(provider.requestModelFor(t('local', 'workstation/qwen3:8b')), 'qwen3:8b');

    const tuned = route(servers, [t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' })]);
    let streamed = '';
    const res = await tuned.streamMessage(HI, {}, (c) => { streamed += c; });
    assert.ok(streamed);
    assert.strictEqual(chatPosts().at(-1).body.model, 'qwen3-titles-1');
    assert.strictEqual(res.llmMetrics.adapter, 'titles-1');
    assert.strictEqual(res.llmMetrics.model, 'workstation/qwen3:8b', 'recorded under the base model');
    assert.strictEqual(res.llmMetrics.local.server, 'workstation');

    const base = route(servers, [t('local', 'workstation/qwen3:8b')]);
    const plain = await base.sendMessageWithTools(HI, [{ name: 'Lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } }], {});
    assert.strictEqual(chatPosts().at(-1).body.model, 'qwen3:8b');
    assert.strictEqual('adapter' in plain.llmMetrics, false);
  });

  it('R-LI-15: a stale adapter makes the target unusable, and the next target is used', async () => {
    serveDigest(DIGEST_A);
    const { servers } = registry();
    await servers.probe('workstation', 'qwen3:8b');
    servers.declareAdapter('workstation', 'qwen3:8b', { id: 'titles-1', job: 'title', ref: 'qwen3-titles-1' });
    assert.strictEqual(servers.explain('workstation/qwen3:8b', { adapter: 'titles-1' }).usable, true);

    // The tag is pulled again: another version of the model.
    serveDigest(DIGEST_B);
    await servers.probe('workstation', 'qwen3:8b');
    const verdict = servers.explain('workstation/qwen3:8b', { adapter: 'titles-1' });
    assert.strictEqual(verdict.usable, false);
    assert.strictEqual(verdict.code, 'LOCAL_ADAPTER_STALE');
    assert.deepStrictEqual(verdict.reasons, ['titles-1 was made for another version of qwen3:8b.']);
    assert.strictEqual(servers.explain('workstation/qwen3:8b', {}).usable, true, 'the model itself is fine');

    const profile = normalizeProfile({ id: 'p-1', name: 'Local', kind: 'user', roles: { main: [], worker: [], utility: [t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' }), t('local', 'workstation/qwen3:8b')] } });
    const models = createTurnModels({ profile, explain: (p, m, o) => servers.explain(m, o), isGuaranteeTarget: (x) => servers.isGuaranteeTarget(x) });
    const resolved = models.resolve('utility');
    assert.deepStrictEqual(resolved.targets, [t('local', 'workstation/qwen3:8b')]);
    assert.deepStrictEqual(resolved.skipped, [{ target: t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' }), reasons: ['titles-1 was made for another version of qwen3:8b.'] }]);

    // A route handed the stale target anyway sends nothing for it and moves on.
    const before = chatPosts().length;
    const text = await route(servers, [t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' }), t('local', 'workstation/qwen3:8b')]).sendMessage(HI, {});
    assert.ok(text);
    assert.deepStrictEqual(chatPosts().slice(before).map((r) => r.body.model), ['qwen3:8b']);
    assert.throws(() => servers.providerFor('workstation').requestModelFor(t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' })), (err) => err.code === 'LOCAL_ADAPTER_STALE');
  });

  it('an adapter the model does not have makes the target unusable', async () => {
    serveDigest(DIGEST_A);
    const { servers } = registry();
    await servers.probe('workstation', 'qwen3:8b');
    const verdict = servers.explain('workstation/qwen3:8b', { adapter: 'titles-1' });
    assert.strictEqual(verdict.usable, false);
    assert.strictEqual(verdict.code, 'LOCAL_ADAPTER_UNKNOWN');
    assert.deepStrictEqual(verdict.reasons, ['qwen3:8b on Workstation has no adapter titles-1.']);
    const before = chatPosts().length;
    await assert.rejects(route(servers, [t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' })]).sendMessage(HI, {}), (err) => err.code === 'LOCAL_ADAPTER_UNKNOWN');
    assert.strictEqual(chatPosts().length, before, 'nothing was sent');
  });

  it('service mode: adapters come only from the admin block; one is bound to the digest the model has when it is first used', async () => {
    serveDigest(DIGEST_A);
    const admin = { workstation: [{ model: 'qwen3:8b', id: 'titles-1', job: 'title', ref: 'qwen3-titles-1' }] };
    const { servers } = registry({ writeEntries: null, getAdminAdapters: (id) => admin[id] || [] });
    assert.throws(() => servers.declareAdapter('workstation', 'qwen3:8b', { id: 'other-1', job: 'title', ref: 'x' }), (err) => err.code === 'LOCAL_SERVER_ADMIN_ONLY');
    assert.strictEqual(servers.explain('workstation/qwen3:8b', { adapter: 'titles-1' }).usable, false, 'an unprobed model cannot bind one yet');
    await servers.probe('workstation', 'qwen3:8b');
    assert.strictEqual(servers.explain('workstation/qwen3:8b', { adapter: 'titles-1' }).usable, true);
    const digest = servers.probeRecord('workstation', 'qwen3:8b').digest;
    assert.strictEqual(servers.probeRecord('workstation', 'qwen3:8b').adapters[0].baseDigest, digest);
    assert.strictEqual(servers.explain('workstation/qwen3:8b', { adapter: 'other-1' }).code, 'LOCAL_ADAPTER_UNKNOWN');
    // An adapter the administrator took out of the block is not used, whatever the record holds.
    admin.workstation = [];
    assert.strictEqual(servers.explain('workstation/qwen3:8b', { adapter: 'titles-1' }).code, 'LOCAL_ADAPTER_UNKNOWN');
  });

  it('the admin block\'s adapters are checked when service.json is read', () => {
    const server1 = (adapters) => ({ servers: [{ id: 'workstation', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', adapters }] });
    const parsed = parseLocalInferenceConfig(server1([{ model: 'qwen3:8b', id: 'titles-1', job: 'title', ref: 'qwen3-titles-1' }]), 'service.json');
    assert.deepStrictEqual(parsed.servers[0].adapters, [{ model: 'qwen3:8b', id: 'titles-1', job: 'title', ref: 'qwen3-titles-1' }]);
    for (const bad of [
      ['titles-1'],
      [{ model: 'qwen3:8b', id: 'titles-1', job: 'title' }],
      [{ model: 'qwen3:8b', id: 'titles-1', job: 'translate', ref: 'r' }],
      [{ model: 'qwen3:8b', id: 'titles-1', job: 'title', ref: 'r', baseDigest: 'x' }],
      [{ model: 'qwen3:8b', id: 'titles-1', job: 'title', ref: 'r' }, { model: 'qwen3:8b', id: 'titles-1', job: 'title', ref: 's' }]
    ]) {
      assert.throws(() => parseLocalInferenceConfig(server1(bad), 'service.json'), /adapters/, JSON.stringify(bad));
    }
  });
});

describe('adapters through the core', () => {
  const { createCore } = require('../src/core');
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const { createAesGcmCipher } = require('../src/platform/cipher');
  const { createHeadlessPrompter } = require('../src/platform/prompter');
  const { setActiveCatalog } = require('../src/models');
  const { registerModelsHandlers } = require('../src/ipc/models-handlers');
  const { markLocalDesktopEvent } = require('../src/core/origin');
  const { profileSettings } = require('./helpers/profile-settings');
  const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
  const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');

  let server;
  const originalFetch = globalThis.fetch;
  const originalTestMode = process.env.KL_TEST_MODE;
  const cores = [];
  const dirs = [];

  before(async () => {
    server = await startFakeLlmServer();
    server.setOllamaModels({ 'qwen3:8b': { digest: DIGEST_A, model_info: { 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools'] } });
    globalThis.fetch = async (url) => { throw new Error(`no network in unit tests (${url})`); };
    process.env.KL_TEST_MODE = '1';
  });
  afterEach(async () => {
    while (cores.length) await cores.pop().shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    if (originalTestMode === undefined) delete process.env.KL_TEST_MODE;
    else process.env.KL_TEST_MODE = originalTestMode;
    await server.close();
  });

  async function setup({ service = null, roles }) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-adapter-core-'));
    dirs.push(dataDir);
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', profileSettings(service ? {} : { models: { localServers: [entry('workstation', `${server.url}/ollama`)] } }, roles));
    const core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() },
      ingest: 'none',
      ...(service ? { localInference: service } : {})
    });
    cores.push(core);
    await core.start();
    const handlers = new Map();
    registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, core.context);
    const call = (name, payload, event = markLocalDesktopEvent({ sender: {} })) => handlers.get(`models:local.${name}`)(event, payload);
    return { core, call };
  }
  const chatPosts = () => server.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/chat/completions'));

  it('desktop: setModelInfo declares an adapter, and resolveRole sends its ref', async () => {
    const roles = { main: [t('local', 'workstation/qwen3:8b')], utility: [t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' }), t('local', 'workstation/qwen3:8b')] };
    const { core, call } = await setup({ roles });
    assert.strictEqual((await call('probe', { id: 'workstation', model: 'qwen3:8b' })).ok, true);
    const set = await call('setModelInfo', { id: 'workstation', model: 'qwen3:8b', adapter: { id: 'titles-1', job: 'title', ref: 'qwen3-titles-1' } });
    assert.strictEqual(set.ok, true);
    assert.strictEqual(set.untrustedText, true);
    assert.deepStrictEqual(set.record.adapters.map((a) => a.id), ['titles-1']);
    assert.strictEqual((await call('setModelInfo', { id: 'workstation', model: 'qwen3:8b', adapter: { id: 'titles-1', job: 'nope', ref: 'r' } })).code, 'LOCAL_ADAPTER_INVALID');

    const utility = await core.context.resolveRole('utility');
    assert.deepStrictEqual(utility.targets[0], t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' }));
    const res = await utility.provider.sendMessageWithTools(HI, [{ name: 'Lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } }], {});
    assert.strictEqual(chatPosts().at(-1).body.model, 'qwen3-titles-1');
    assert.strictEqual(res.llmMetrics.adapter, 'titles-1');
  });

  it('service mode: an adapter in the admin block is used; setModelInfo cannot declare one', async () => {
    const roles = { main: [t('local', 'workstation/qwen3:8b')], utility: [t('local', 'workstation/qwen3:8b', { adapter: 'titles-1' })] };
    const service = { servers: [{ id: 'workstation', name: 'Workstation', kind: 'ollama', baseUrl: `${server.url}/ollama`, maxConcurrent: 2, timeoutMs: null, tlsFingerprint: null, allowCgnat: false, key: null, adapters: [{ model: 'qwen3:8b', id: 'titles-1', job: 'title', ref: 'qwen3-titles-1' }] }] };
    const { core, call } = await setup({ service, roles });
    assert.strictEqual((await call('probe', { id: 'workstation', model: 'qwen3:8b' })).ok, true);
    assert.strictEqual((await call('setModelInfo', { id: 'workstation', model: 'qwen3:8b', adapter: { id: 'other-1', job: 'title', ref: 'x' } })).code, 'LOCAL_SERVER_ADMIN_ONLY');
    const utility = await core.context.resolveRole('utility');
    await utility.provider.sendMessage(HI, {});
    assert.strictEqual(chatPosts().at(-1).body.model, 'qwen3-titles-1');
  });
});
