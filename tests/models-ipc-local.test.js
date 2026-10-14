// tests/models-ipc-local.test.js
// The models:local.* channels (spec 2026-10-13-local-inference-design.md
// §5.6, §13.2; R-LI-4, R-LI-6, R-LI-31). Adding a server is the owner's mark,
// so the channels that change the list act only on an event the app's own
// window sent, and in service mode not at all.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IPC = require('../src/ipc/constants');
const { registerModelsHandlers } = require('../src/ipc/models-handlers');
const { markLocalDesktopEvent } = require('../src/core/origin');
const { classifyChannel } = require('../src/desktop-bridge/allowlist');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const { profileSettings } = require('./helpers/profile-settings');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model, effort = null) => ({ provider, model, effort });
const CHANNELS = ['list', 'add', 'remove', 'recheck', 'probe', 'setModelInfo', 'fromOllama'];

describe('models:local.* IPC', () => {
  let server;
  const cores = [];
  const dirs = [];
  const originalFetch = globalThis.fetch;

  before(async () => {
    server = await startFakeLlmServer();
    server.setModels([{ id: 'tool-model', max_model_len: 32768 }, { id: 'text-only-model' }]);
    server.setOllamaModels({ 'llama3.2': { model_info: { 'llama.context_length': 8192 }, capabilities: ['completion', 'tools'] } });
    globalThis.fetch = async (url) => { throw new Error(`no network in unit tests (${url})`); };
  });
  afterEach(async () => {
    while (cores.length) await cores.pop().shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    await server.close();
  });

  async function setup({ service = null, roles = { main: [t('openai', 'gpt-5.5')] }, lookup = null } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-local-ipc-'));
    dirs.push(dataDir);
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', profileSettings({ models: { ollama: { baseUrl: `${server.url}/ollama` } } }, roles));
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
      ...(lookup ? { lookup } : {}),
      ...(service ? { localInference: service } : {})
    });
    cores.push(core);
    if (service) await core.start();
    const handlers = new Map();
    registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, core.context);
    const windowEvent = () => markLocalDesktopEvent({ sender: {} });
    const call = (name, payload, event = windowEvent()) => handlers.get(`models:local.${name}`)(event, payload);
    return { core, store, handlers, call, windowEvent };
  }
  const compat = () => ({ id: 'workstation', name: 'Workstation', kind: 'vllm', baseUrl: `${server.url}/compat` });

  it('registers the seven channels, named by the constants and exposed by the preload', async () => {
    const { handlers } = await setup();
    assert.deepStrictEqual(
      [IPC.MODELS_LOCAL_LIST, IPC.MODELS_LOCAL_ADD, IPC.MODELS_LOCAL_REMOVE, IPC.MODELS_LOCAL_RECHECK, IPC.MODELS_LOCAL_PROBE, IPC.MODELS_LOCAL_SET_MODEL_INFO, IPC.MODELS_LOCAL_FROM_OLLAMA],
      CHANNELS.map((name) => `models:local.${name}`)
    );
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    for (const name of CHANNELS) {
      assert.ok(handlers.has(`models:local.${name}`), name);
      assert.ok(preload.includes(`'models:local.${name}'`), `preload invokes models:local.${name}`);
    }
    assert.match(preload, /local: \{\s*\n\s*list: \(\) => ipcRenderer\.invoke\('models:local\.list'\)/);
  });

  it('the channels ride the proxied models domain', () => {
    for (const name of CHANNELS) assert.strictEqual(classifyChannel(`models:local.${name}`), 'proxy', name);
  });

  it('R-LI-4: adding is the mark', async () => {
    const { call, store } = await setup();
    const reply = await call('add', compat());
    assert.strictEqual(reply.ok, true);
    assert.strictEqual(reply.untrustedText, true);
    assert.ok(!Number.isNaN(Date.parse(reply.server.markedLocalAt)));
    assert.strictEqual(reply.server.usable, true);
    assert.strictEqual(reply.server.grade, 'guarantee');
    assert.deepStrictEqual(reply.server.pinned.addresses, ['127.0.0.1']);
    assert.deepStrictEqual(reply.models.map((m) => [m.id, m.record.toolCall]), [['tool-model', 'yes'], ['text-only-model', 'no']]);
    assert.strictEqual(store.get('settings').models.localServers[0].markedLocalAt, reply.server.markedLocalAt);

    const listed = await call('list');
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.untrustedText, true);
    assert.strictEqual(listed.adminOnly, false);
    assert.deepStrictEqual(listed.servers.map((s) => [s.id, s.grade, s.pinned.class, s.models.length]), [['workstation', 'guarantee', 'loopback', 2]]);
    // A payload cannot carry its own pin or mark.
    const forged = await call('add', { ...compat(), id: 'second', pinned: { addresses: ['127.0.0.1'], class: 'loopback' }, markedLocalAt: '2020-01-01T00:00:00.000Z' });
    assert.strictEqual(forged.ok, false);
    assert.strictEqual(forged.code, 'LOCAL_SERVER_INVALID');
    const publicAddress = await call('add', { id: 'elsewhere', kind: 'vllm', baseUrl: 'http://203.0.113.9:8000' });
    assert.deepStrictEqual([publicAddress.ok, publicAddress.code], [false, 'LOCAL_ADDRESS_PUBLIC']);
    assert.strictEqual(store.get('settings').models.localServers.length, 1);
  });

  it('R-LI-6: add is refused for an event that is not the local window\'s', async () => {
    const { call, store } = await setup();
    const notTheWindow = [
      {},
      { sender: {} },
      null,
      // A paired desktop over the bridge: the owner, but not this app's window.
      markLocalDesktopEvent({ sender: {} }, { deviceId: 'kld-0123456789abcdef' })
    ];
    for (const event of notTheWindow) {
      for (const [name, payload] of [['add', compat()], ['remove', { id: 'workstation' }], ['recheck', { id: 'workstation' }], ['fromOllama', {}]]) {
        const reply = await call(name, payload, event);
        assert.deepStrictEqual([reply.ok, reply.code], [false, 'NOT_LOCAL_WINDOW'], name);
      }
    }
    assert.strictEqual(store.get('settings').models.localServers, undefined);
    // The same payload from the window is taken.
    assert.strictEqual((await call('add', compat())).ok, true);
    // Probing and model details need the owner's desktop: the window or a paired one.
    for (const event of [{}, null]) {
      assert.strictEqual((await call('probe', { id: 'workstation', model: 'tool-model' }, event)).code, 'NOT_LOCAL_WINDOW');
      assert.strictEqual((await call('setModelInfo', { id: 'workstation', model: 'tool-model', context: 4096 }, event)).code, 'NOT_LOCAL_WINDOW');
    }
    assert.strictEqual((await call('setModelInfo', { id: 'workstation', model: 'tool-model', context: 4096 }, notTheWindow[3])).ok, true);
    assert.strictEqual((await call('list', {}, {})).ok, true);
  });

  it('R-LI-6: add is refused LOCAL_SERVER_ADMIN_ONLY in service mode, while list and probe answer', async () => {
    const adminEntry = { id: 'workstation', name: 'Workstation', kind: 'vllm', baseUrl: `${server.url}/compat`, addresses: null, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null, key: null, adapters: [] };
    const { call, windowEvent } = await setup({ service: { servers: [adminEntry] } });
    const bridge = markLocalDesktopEvent({ sender: {} }, { deviceId: 'kld-0123456789abcdef' });
    for (const event of [windowEvent(), bridge, {}]) {
      for (const [name, payload] of [['add', { ...compat(), id: 'another' }], ['remove', { id: 'workstation' }], ['recheck', { id: 'workstation', confirm: true, expected: ['127.0.0.1'] }], ['fromOllama', { rewrite: true }]]) {
        const reply = await call(name, payload, event);
        assert.deepStrictEqual([reply.ok, reply.code], [false, 'LOCAL_SERVER_ADMIN_ONLY'], name);
      }
    }
    const listed = await call('list', {}, bridge);
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.adminOnly, true);
    assert.deepStrictEqual(listed.servers.map((s) => s.id), ['workstation']);
    assert.strictEqual('key' in listed.servers[0], false);
    const probed = await call('probe', { id: 'workstation', model: 'tool-model' }, bridge);
    assert.strictEqual(probed.ok, true);
    assert.strictEqual(probed.untrustedText, true);
    assert.strictEqual(probed.record.toolCall, 'yes');
    const refreshed = await call('probe', { id: 'workstation' }, bridge);
    assert.deepStrictEqual(refreshed.models.map((m) => m.id), ['tool-model', 'text-only-model']);
  });

  it('remove while a profile names a model returns the references; then removes', async () => {
    const { call, core } = await setup();
    await call('add', compat());
    core.context.getProfiles().update('p-test', { roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [t('local', 'workstation/tool-model')] } });
    const refused = await call('remove', { id: 'workstation' });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.code, 'LOCAL_SERVER_IN_USE');
    assert.strictEqual(refused.untrustedText, true);
    assert.deepStrictEqual(refused.references, [{ profileId: 'p-test', profileName: 'Test profile', role: 'utility', model: 'workstation/tool-model' }]);
    core.context.getProfiles().update('p-test', { roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [] } });
    assert.deepStrictEqual(await call('remove', { id: 'workstation' }), { ok: true, removed: 'workstation' });
    assert.deepStrictEqual((await call('list')).servers, []);
    assert.strictEqual((await call('remove', { id: 'workstation' })).code, 'LOCAL_SERVER_UNKNOWN');
  });

  it('recheck is two steps: what the name answers now, then the owner\'s confirmation of it', async () => {
    let answer = [{ address: '127.0.0.1', family: 4 }];
    const { call, store } = await setup({ lookup: async () => answer });
    const added = await call('add', { id: 'named', kind: 'vllm', baseUrl: 'http://box.example.com:9/compat' });
    assert.strictEqual(added.ok, true);
    answer = [{ address: '192.168.1.77', family: 4 }];
    const seen = await call('recheck', { id: 'named' });
    assert.deepStrictEqual([seen.ok, seen.changed, seen.stored, seen.untrustedText], [true, true, false, true]);
    assert.deepStrictEqual(seen.resolved.addresses, ['192.168.1.77']);
    assert.deepStrictEqual(store.get('settings').models.localServers[0].pinned.addresses, ['127.0.0.1']);
    assert.strictEqual((await call('recheck', { id: 'named', confirm: true })).code, 'LOCAL_RECHECK_STALE');
    const confirmed = await call('recheck', { id: 'named', confirm: true, expected: seen.resolved.addresses });
    assert.deepStrictEqual([confirmed.ok, confirmed.stored], [true, true]);
    assert.deepStrictEqual(store.get('settings').models.localServers[0].pinned.addresses, ['192.168.1.77']);
    answer = [{ address: '203.0.113.9', family: 4 }];
    assert.strictEqual((await call('recheck', { id: 'named', confirm: true, expected: ['203.0.113.9'] })).code, 'LOCAL_ADDRESS_PUBLIC');
    assert.deepStrictEqual(store.get('settings').models.localServers[0].pinned.addresses, ['192.168.1.77']);
  });

  it('probe and setModelInfo answer with the record', async () => {
    const { call } = await setup();
    await call('add', compat());
    const set = await call('setModelInfo', { id: 'workstation', model: 'text-only-model', context: 16384, imageInput: true });
    assert.deepStrictEqual([set.ok, set.untrustedText, set.record.context, set.record.contextSource, set.record.imageInput], [true, true, 16384, 'owner', 'yes']);
    assert.strictEqual((await call('setModelInfo', { id: 'workstation', model: 'text-only-model', context: 'big' })).code, 'LOCAL_MODEL_INFO_INVALID');
    assert.strictEqual((await call('setModelInfo', { id: 'workstation' })).ok, false);
    const probed = await call('probe', { id: 'workstation', model: 'text-only-model' });
    assert.deepStrictEqual([probed.ok, probed.record.toolCall, probed.record.context], [true, 'no', 16384]);
    assert.strictEqual((await call('probe', { id: 'workstation', model: 'not-there' })).code, 'LOCAL_MODEL_NOT_LISTED');
    assert.strictEqual((await call('probe', { id: 'gone', model: 'm' })).code, 'LOCAL_SERVER_UNKNOWN');
    assert.strictEqual((await call('probe', {})).ok, false);
  });

  it('R-LI-31: fromOllama adds a server, and on the second call rewrites profile targets', async () => {
    const { call, core, store } = await setup({ roles: { main: [t('openai', 'gpt-5.5')], utility: [t('ollama', 'llama3.2'), t('ollama', 'gpt-oss:120b-cloud')] } });
    // Until the owner acts, the built-in Ollama is not a local server.
    assert.deepStrictEqual((await call('list')).servers, []);
    assert.notStrictEqual(core.context.getLocalServers().isGuaranteeTarget({ provider: 'ollama', model: 'llama3.2' }), true);

    const first = await call('fromOllama', {});
    assert.deepStrictEqual([first.ok, first.added, first.untrustedText], [true, true, true]);
    assert.deepStrictEqual(first.rewritten, []);
    assert.strictEqual(first.server.id, 'ollama-local');
    assert.strictEqual(first.server.kind, 'ollama');
    assert.strictEqual(store.get('settings').models.localServers[0].baseUrl, `${server.url}/ollama`);
    assert.deepStrictEqual(core.context.getProfiles().get('p-test').roles.utility, [t('ollama', 'llama3.2'), t('ollama', 'gpt-oss:120b-cloud')]);

    const second = await call('fromOllama', { rewrite: true });
    assert.deepStrictEqual([second.ok, second.added], [true, false]);
    assert.deepStrictEqual(second.rewritten, [{ profileId: 'p-test', role: 'utility', from: 'ollama/llama3.2', to: 'local/ollama-local/llama3.2' }]);
    assert.deepStrictEqual(core.context.getProfiles().get('p-test').roles.utility, [t('local', 'ollama-local/llama3.2'), t('ollama', 'gpt-oss:120b-cloud')]);
    assert.strictEqual(core.context.getLocalServers().isGuaranteeTarget({ provider: 'local', model: 'ollama-local/llama3.2' }), true);
    // The built-in Ollama provider and its address setting are as they were.
    assert.strictEqual(core.context.getSettings().models.ollama.baseUrl, `${server.url}/ollama`);
  });

  it('models:explain answers for a local model from the registry', async () => {
    const { call, handlers } = await setup();
    await call('add', compat());
    const explain = (payload) => handlers.get(IPC.MODELS_EXPLAIN)({}, payload);
    assert.deepStrictEqual(await explain({ provider: 'local', model: 'workstation/tool-model', needs: { toolCall: true } }), { ok: true, usable: true, reasons: [], notes: [] });
    const refused = await explain({ provider: 'local', model: 'workstation/text-only-model', needs: { toolCall: true } });
    assert.strictEqual(refused.usable, false);
    assert.strictEqual((await explain({ provider: 'local', model: 'gone/m' })).usable, false);
  });
});
