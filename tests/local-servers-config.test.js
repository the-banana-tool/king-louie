// tests/local-servers-config.test.js
// Who may configure a local server on the desktop (spec
// 2026-10-13-local-inference-design.md §5.6; R-LI-6, R-LI-29, R-LI-31): the
// registry's own add, remove, recheck and fromOllama are the only code that
// writes `settings.models.localServers`. A settings save from anywhere else
// keeps the stored list, whatever it was passed. The servers here are fake
// servers on 127.0.0.1; a LAN address is pinned, never dialled.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalServers } = require('../src/models/local-servers');
const { createLocalTransport, LocalTransportError } = require('../src/models/local-transport');
const { Profiles } = require('../src/models/profiles');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { profileSettings } = require('./helpers/profile-settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const NOW = '2026-10-13T09:00:00.000Z';
const t = (provider, model, effort = null) => ({ provider, model, effort });

describe('LocalServers: add, remove, recheck, fromOllama', () => {
  let server;
  const open = [];
  const dirs = [];

  before(async () => {
    server = await startFakeLlmServer();
    server.setModels([{ id: 'tool-model', max_model_len: 32768 }]);
    server.setOllamaModels({
      'llama3.2': { model_info: { 'llama.context_length': 8192 }, capabilities: ['completion', 'tools'] },
      'gpt-oss:120b-cloud': { model_info: {}, capabilities: ['completion', 'tools'] }
    });
  });
  after(async () => { await server.close(); });
  afterEach(() => {
    while (open.length) open.pop().close();
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  });

  // A registry over an in-memory settings object, as the core wires it. A
  // server that is not on 127.0.0.1 gets a transport that dials nothing.
  function registry({ entries = [], roles = { main: [], worker: [], utility: [] }, writable = true, lookup = null, ollamaBaseUrl = `${server.url}/ollama`, extraProfiles = [] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-local-config-'));
    dirs.push(dir);
    let settings = profileSettings({ models: { localServers: entries, ollama: { baseUrl: ollamaBaseUrl } } }, roles);
    settings.models.profiles.push(...extraProfiles);
    const writes = [];
    const removed = [];
    const dialled = [];
    const profiles = new Profiles({ getSettings: () => settings, setSettings: (next) => { settings = next; } });
    const servers = new LocalServers({
      getEntries: () => settings.models.localServers || [],
      ...(writable ? { writeEntries: (next) => { writes.push(next); settings = { ...settings, models: { ...settings.models, localServers: next } }; } } : {}),
      catalog: fixtureCatalog(),
      probeFile: path.join(dir, 'models', 'local-probes.json'),
      getProfiles: () => profiles,
      getOllamaBaseUrl: () => settings.models.ollama.baseUrl,
      onRemoved: (id) => removed.push(id),
      now: () => new Date(NOW),
      ...(lookup ? { lookup } : {}),
      createTransport: (options) => {
        if (options.addresses.every((a) => a === '127.0.0.1')) return createLocalTransport(options);
        const real = createLocalTransport(options);
        real.close();
        return {
          ...real,
          close: () => {},
          fetch: async (url) => { dialled.push(String(url)); throw new LocalTransportError('LOCAL_UNREACHABLE', 'not dialled in a unit test'); }
        };
      }
    });
    open.push(servers);
    return { servers, profiles, writes, removed, dialled, stored: () => settings.models.localServers, settings: () => settings };
  }

  it('add pins the address, stores the entry with its mark, and probes the models', async () => {
    const { servers, writes, stored } = registry();
    const result = await servers.add({ id: 'workstation', name: 'Workstation', kind: 'vllm', baseUrl: `${server.url}/compat/` });
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(stored(), [{
      id: 'workstation', name: 'Workstation', kind: 'vllm', baseUrl: `${server.url}/compat`, tlsFingerprint: null, allowCgnat: false,
      maxConcurrent: 2, timeoutMs: null, pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: NOW }, markedLocalAt: NOW
    }]);
    assert.strictEqual(result.server.usable, true);
    assert.strictEqual(result.server.grade, 'guarantee');
    assert.strictEqual(result.probeError, null);
    assert.deepStrictEqual(result.models.map((m) => [m.id, m.record.toolCall]), [['tool-model', 'yes']]);
    assert.strictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'workstation/tool-model' }), true);
  });

  it('add resolves a host name once and stores what it answered', async () => {
    const asked = [];
    const { servers, stored, dialled } = registry({ lookup: async (host) => { asked.push(host); return [{ address: '192.168.1.20', family: 4 }, { address: '::ffff:192.168.1.21', family: 6 }]; } });
    const result = await servers.add({ id: 'lan-box', kind: 'vllm', baseUrl: 'https://gpu-box.example.com:8443', tlsFingerprint: 'AB'.repeat(32) });
    assert.deepStrictEqual(asked, ['gpu-box.example.com']);
    assert.deepStrictEqual(stored()[0].pinned, { addresses: ['192.168.1.20', '192.168.1.21'], class: 'lan', at: NOW });
    assert.strictEqual(stored()[0].name, 'lan-box');
    assert.strictEqual(stored()[0].tlsFingerprint, 'ab'.repeat(32));
    assert.strictEqual(result.server.grade, 'guarantee');
    // The server did not answer the listing: it is added all the same, unprobed.
    assert.strictEqual(result.probeError.code, 'LOCAL_UNREACHABLE');
    assert.deepStrictEqual(result.models, []);
    assert.strictEqual(dialled.length, 1);
  });

  it('add of a public address is LOCAL_ADDRESS_PUBLIC and stores nothing', async () => {
    const { servers, writes, stored } = registry({ lookup: async () => [{ address: '192.168.1.20', family: 4 }, { address: '203.0.113.9', family: 4 }] });
    await assert.rejects(servers.add({ id: 'elsewhere', kind: 'vllm', baseUrl: 'http://203.0.113.9:8000' }), (err) => err.code === 'LOCAL_ADDRESS_PUBLIC');
    await assert.rejects(servers.add({ id: 'elsewhere', kind: 'vllm', baseUrl: 'http://gpu-box.example.com:8000' }), (err) => err.code === 'LOCAL_ADDRESS_PUBLIC' && err.refused[0].address === '203.0.113.9');
    await assert.rejects(servers.add({ id: 'elsewhere', kind: 'vllm', baseUrl: 'http://169.254.169.254' }), (err) => err.code === 'LOCAL_ADDRESS_PUBLIC');
    assert.deepStrictEqual(writes, []);
    assert.deepStrictEqual(stored(), []);
  });

  it('R-LI-29: a 100.64.0.0/10 address is added only with allowCgnat', async () => {
    const { servers, stored } = registry();
    await assert.rejects(servers.add({ id: 'overlay', kind: 'llamacpp', baseUrl: 'http://100.64.0.5:8000' }), (err) => err.code === 'LOCAL_ADDRESS_PUBLIC');
    await assert.rejects(servers.add({ id: 'overlay', kind: 'llamacpp', baseUrl: 'http://100.64.0.5:8000', allowCgnat: 'yes' }), (err) => err.code === 'LOCAL_SERVER_INVALID');
    const result = await servers.add({ id: 'overlay', kind: 'llamacpp', baseUrl: 'http://100.64.0.5:8000', allowCgnat: true });
    assert.strictEqual(stored()[0].allowCgnat, true);
    assert.strictEqual(stored()[0].pinned.class, 'cgnat');
    assert.strictEqual(result.server.grade, 'cost-only');
  });

  it('add refuses what is not a new, well-formed server, and never a caller\'s own pin or mark', async () => {
    const { servers, writes } = registry();
    const good = { id: 'workstation', kind: 'vllm', baseUrl: `${server.url}/compat` };
    const invalid = [
      null, 'workstation', { ...good, id: 'Work Station' }, { ...good, id: undefined }, { ...good, kind: 'cloud' }, { ...good, kind: undefined },
      { ...good, name: 'two\nlines' }, { ...good, tlsFingerprint: 'abc' }, { ...good, maxConcurrent: 0 }, { ...good, timeoutMs: -1 },
      { ...good, pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: NOW } }, { ...good, markedLocalAt: NOW }, { ...good, grade: 'guarantee' }, { ...good, key: 'k' }
    ];
    for (const input of invalid) {
      await assert.rejects(servers.add(input), (err) => err.code === 'LOCAL_SERVER_INVALID', JSON.stringify(input));
    }
    for (const baseUrl of ['ftp://127.0.0.1', 'http://user@127.0.0.1:8000', 'http://127.0.0.1:8000/?x=1', '', undefined]) {
      await assert.rejects(servers.add({ ...good, baseUrl }), (err) => err.code === 'LOCAL_URL_INVALID', String(baseUrl));
    }
    assert.deepStrictEqual(writes, []);
    await servers.add(good);
    await assert.rejects(servers.add({ ...good, baseUrl: 'http://127.0.0.1:9' }), (err) => err.code === 'LOCAL_SERVER_EXISTS');
    assert.strictEqual(writes.length, 1);
  });

  it('without writeEntries every change is LOCAL_SERVER_ADMIN_ONLY, and reading still works', async () => {
    const { servers } = registry({ writable: false });
    assert.strictEqual(servers.adminOnly, true);
    await assert.rejects(servers.add({ id: 'workstation', kind: 'vllm', baseUrl: `${server.url}/compat` }), (err) => err.code === 'LOCAL_SERVER_ADMIN_ONLY');
    await assert.rejects(servers.remove('workstation'), (err) => err.code === 'LOCAL_SERVER_ADMIN_ONLY');
    await assert.rejects(servers.recheck('workstation'), (err) => err.code === 'LOCAL_SERVER_ADMIN_ONLY');
    await assert.rejects(servers.fromOllama(), (err) => err.code === 'LOCAL_SERVER_ADMIN_ONLY');
    assert.deepStrictEqual(servers.list(), []);
    assert.strictEqual(registry().servers.adminOnly, false);
  });

  it('remove is refused while a profile names one of the server\'s models, with the references', async () => {
    const { servers, profiles, removed, stored } = registry({
      roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [t('local', 'workstation/tool-model'), t('local', 'other/tool-model')] }
    });
    await servers.add({ id: 'workstation', kind: 'vllm', baseUrl: `${server.url}/compat` });
    assert.ok(servers.probeRecord('workstation', 'tool-model'));
    await assert.rejects(servers.remove('workstation'), (err) => {
      assert.strictEqual(err.code, 'LOCAL_SERVER_IN_USE');
      assert.deepStrictEqual(err.references, [{ profileId: 'p-test', profileName: 'Test profile', role: 'utility', model: 'workstation/tool-model' }]);
      return true;
    });
    assert.strictEqual(stored().length, 1);
    await assert.rejects(servers.remove('gone'), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');

    profiles.update('p-test', { roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [t('local', 'other/tool-model')] } });
    assert.deepStrictEqual(await servers.remove('workstation'), { removed: 'workstation' });
    assert.deepStrictEqual(stored(), []);
    assert.deepStrictEqual(removed, ['workstation']);
    // What was observed about that machine goes with it: a later server under
    // the same id is another machine.
    assert.strictEqual(servers.probeRecord('workstation', 'tool-model'), null);
    assert.strictEqual(servers.explain('workstation/tool-model').code, 'LOCAL_SERVER_UNKNOWN');
  });

  it('recheck shows a changed answer and keeps the old pin until the owner confirms what was shown', async () => {
    let answer = [{ address: '192.168.1.20', family: 4 }];
    const { servers, stored, writes } = registry({ lookup: async () => answer });
    await servers.add({ id: 'lan-box', kind: 'vllm', baseUrl: 'http://gpu-box.example.com:8000' });
    const same = await servers.recheck('lan-box');
    assert.strictEqual(same.changed, false);
    assert.strictEqual(writes.length, 1);

    answer = [{ address: '192.168.1.77', family: 4 }];
    const seen = await servers.recheck('lan-box');
    assert.strictEqual(seen.changed, true);
    assert.strictEqual(seen.stored, false);
    assert.deepStrictEqual(seen.previous.addresses, ['192.168.1.20']);
    assert.deepStrictEqual(seen.resolved.addresses, ['192.168.1.77']);
    assert.deepStrictEqual(stored()[0].pinned.addresses, ['192.168.1.20'], 'the old pin is kept');
    assert.deepStrictEqual(servers.transportFor('lan-box').addresses, ['192.168.1.20']);

    // Confirming needs the addresses the owner was shown.
    await assert.rejects(servers.recheck('lan-box', { confirm: true }), (err) => err.code === 'LOCAL_RECHECK_STALE');
    answer = [{ address: '192.168.1.99', family: 4 }];
    await assert.rejects(servers.recheck('lan-box', { confirm: true, expected: ['192.168.1.77'] }), (err) => err.code === 'LOCAL_RECHECK_STALE');
    assert.deepStrictEqual(stored()[0].pinned.addresses, ['192.168.1.20']);

    const confirmed = await servers.recheck('lan-box', { confirm: true, expected: ['192.168.1.99'] });
    assert.strictEqual(confirmed.stored, true);
    assert.deepStrictEqual(stored()[0].pinned, { addresses: ['192.168.1.99'], class: 'lan', at: NOW });
    assert.deepStrictEqual(servers.transportFor('lan-box').addresses, ['192.168.1.99']);
    assert.strictEqual(stored()[0].markedLocalAt, NOW);
  });

  it('recheck to a public answer is refused and keeps the pin', async () => {
    let answer = [{ address: '192.168.1.20', family: 4 }];
    const { servers, stored, writes } = registry({ lookup: async () => answer });
    await servers.add({ id: 'lan-box', kind: 'vllm', baseUrl: 'http://gpu-box.example.com:8000' });
    answer = [{ address: '203.0.113.9', family: 4 }];
    await assert.rejects(servers.recheck('lan-box'), (err) => err.code === 'LOCAL_ADDRESS_PUBLIC');
    await assert.rejects(servers.recheck('lan-box', { confirm: true, expected: ['203.0.113.9'] }), (err) => err.code === 'LOCAL_ADDRESS_PUBLIC');
    assert.deepStrictEqual(stored()[0].pinned.addresses, ['192.168.1.20']);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(servers.get('lan-box').usable, true);
    await assert.rejects(servers.recheck('gone'), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
  });

  it('R-LI-31: fromOllama adds a server at the Ollama address, and with rewrite moves profile targets to it', async () => {
    const second = { id: 'p-second', name: 'Second', kind: 'user', roles: { main: [t('ollama', 'llama3.2', null), t('openai', 'gpt-5.5')], worker: [], utility: [] } };
    const { servers, profiles, stored } = registry({
      roles: { main: [t('openai', 'gpt-5.5')], worker: [t('ollama', 'gpt-oss:120b-cloud')], utility: [t('ollama', 'llama3.2'), t('ollama', 'gpt-oss:120b-cloud')] },
      extraProfiles: [second]
    });
    const first = await servers.fromOllama();
    assert.strictEqual(first.added, true);
    assert.deepStrictEqual(first.rewritten, []);
    assert.strictEqual(stored()[0].id, 'ollama-local');
    assert.strictEqual(stored()[0].kind, 'ollama');
    assert.strictEqual(stored()[0].baseUrl, `${server.url}/ollama`);
    assert.strictEqual(stored()[0].markedLocalAt, NOW);
    assert.deepStrictEqual(first.models.map((m) => [m.id, m.cloud]), [['llama3.2', false], ['gpt-oss:120b-cloud', true]]);
    // The built-in ollama targets are untouched by the first call (R-LI-31).
    assert.deepStrictEqual(profiles.get('p-test').roles.utility, [t('ollama', 'llama3.2'), t('ollama', 'gpt-oss:120b-cloud')]);
    assert.notStrictEqual(servers.isGuaranteeTarget({ provider: 'ollama', model: 'llama3.2' }), true);

    const again = await servers.fromOllama({ rewrite: true });
    assert.strictEqual(again.added, false);
    assert.deepStrictEqual(again.rewritten, [
      { profileId: 'p-test', role: 'utility', from: 'ollama/llama3.2', to: 'local/ollama-local/llama3.2' },
      { profileId: 'p-second', role: 'main', from: 'ollama/llama3.2', to: 'local/ollama-local/llama3.2' }
    ]);
    assert.deepStrictEqual(profiles.get('p-test').roles.utility, [t('local', 'ollama-local/llama3.2'), t('ollama', 'gpt-oss:120b-cloud')]);
    assert.deepStrictEqual(profiles.get('p-test').roles.worker, [t('ollama', 'gpt-oss:120b-cloud')], 'a cloud id is left alone');
    assert.deepStrictEqual(profiles.get('p-second').roles.main, [t('local', 'ollama-local/llama3.2'), t('openai', 'gpt-5.5')]);
    assert.strictEqual(stored().length, 1);
    assert.deepStrictEqual((await servers.fromOllama({ rewrite: true })).rewritten, []);
  });

  it('fromOllama refuses an id another server holds, and an Ollama address that is not local', async () => {
    const { servers } = registry();
    await servers.add({ id: 'ollama-local', kind: 'vllm', baseUrl: `${server.url}/compat` });
    await assert.rejects(servers.fromOllama(), (err) => err.code === 'LOCAL_SERVER_EXISTS');
    const elsewhere = registry({ ollamaBaseUrl: 'http://203.0.113.9:11434' });
    await assert.rejects(elsewhere.servers.fromOllama({ rewrite: true }), (err) => err.code === 'LOCAL_ADDRESS_PUBLIC');
    assert.deepStrictEqual(elsewhere.stored(), []);
  });

  it('changing the Ollama address does not touch a local server made from it', async () => {
    const { servers, stored, settings } = registry();
    await servers.fromOllama();
    const before = JSON.stringify(stored());
    settings().models.ollama.baseUrl = 'http://127.0.0.1:9';
    assert.strictEqual(JSON.stringify(stored()), before);
    assert.strictEqual(servers.get('ollama-local').baseUrl, `${server.url}/ollama`);
  });
});

describe('the sealed key in the core (R-LI-6)', () => {
  const { createCore } = require('../src/core');
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const { createAesGcmCipher } = require('../src/platform/cipher');
  const { createHeadlessPrompter } = require('../src/platform/prompter');
  const { setActiveCatalog } = require('../src/models');
  const { registerSettingsHandlers } = require('../src/ipc/settings-handlers');
  const { registerModelsHandlers } = require('../src/ipc/models-handlers');
  const IPC = require('../src/ipc/constants');
  const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
  const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');

  let server;
  const cores = [];
  const dirs = [];
  const originalFetch = globalThis.fetch;

  before(async () => {
    server = await startFakeLlmServer();
    server.setModels([{ id: 'tool-model', max_model_len: 32768 }]);
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

  function makeCore({ localServers } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-local-seal-'));
    dirs.push(dataDir);
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', profileSettings(localServers === undefined ? {} : { models: { localServers } }, { main: [t('openai', 'gpt-5.5')] }));
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
      ingest: 'none'
    });
    cores.push(core);
    return { core, store };
  }

  const forged = (id = 'sneaked') => ({
    id, name: 'Sneaked', kind: 'vllm', baseUrl: 'http://127.0.0.1:9', tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
    pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: NOW }, markedLocalAt: NOW
  });
  const storedServers = (store) => store.get('settings').models.localServers;

  it('R-LI-6: setSettings cannot add, change or remove a local server', async () => {
    const { core, store } = makeCore();
    const ctx = core.context;

    // Add: a save that carries a new entry stores none.
    ctx.setSettings({ ...ctx.getSettings(), models: { ...ctx.getSettings().models, localServers: [forged()] } });
    assert.strictEqual(storedServers(store), undefined);
    assert.deepStrictEqual(ctx.getLocalServers().list(), []);
    assert.notStrictEqual(ctx.getLocalServers().isGuaranteeTarget({ provider: 'local', model: 'sneaked/m' }), true);

    // The registry's own add is the one writer.
    await ctx.getLocalServers().add({ id: 'workstation', name: 'Workstation', kind: 'vllm', baseUrl: `${server.url}/compat` });
    const kept = JSON.stringify(storedServers(store));
    assert.strictEqual(storedServers(store).length, 1);

    // Change, remove, replace, and a value that is not a list at all.
    const tries = [
      [{ ...storedServers(store)[0], baseUrl: 'http://127.0.0.1:9', pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: NOW } }],
      [{ ...storedServers(store)[0], tlsFingerprint: 'ab'.repeat(32) }],
      [...storedServers(store), forged()],
      [],
      null,
      'none'
    ];
    for (const localServers of tries) {
      const s = ctx.getSettings();
      ctx.setSettings({ ...s, models: { ...s.models, localServers } });
      assert.strictEqual(JSON.stringify(storedServers(store)), kept, JSON.stringify(localServers));
    }
    // A save that drops the key.
    const { localServers: _dropped, ...others } = ctx.getSettings().models;
    ctx.setSettings({ ...ctx.getSettings(), models: others });
    assert.strictEqual(JSON.stringify(storedServers(store)), kept);

    // Everything else in a save still lands.
    const s = ctx.getSettings();
    ctx.setSettings({ ...s, models: { ...s.models, localServers: [], ollama: { baseUrl: 'http://127.0.0.1:9999' } } });
    assert.strictEqual(ctx.getSettings().models.ollama.baseUrl, 'http://127.0.0.1:9999');
    assert.strictEqual(JSON.stringify(storedServers(store)), kept, 'changing the Ollama address touches no local server');
    ctx.getProfiles().update('p-test', { roles: { main: [t('local', 'workstation/tool-model')], worker: [], utility: [] } });
    assert.deepStrictEqual(ctx.getProfiles().get('p-test').roles.main, [t('local', 'workstation/tool-model')]);
    assert.strictEqual(JSON.stringify(storedServers(store)), kept);

    // A save with no models key at all resets the other model settings, as
    // it always did, and still keeps the list.
    ctx.setSettings({ defaults: { agentMode: true } });
    assert.strictEqual(JSON.stringify(storedServers(store)), kept);
    assert.deepStrictEqual(ctx.getLocalServers().list().map((r) => r.id), ['workstation']);
  });

  it('R-LI-6: a settings pane save, a models save and a stale read cannot change the list either', async () => {
    const { core, store } = makeCore();
    await core.context.getLocalServers().add({ id: 'workstation', kind: 'vllm', baseUrl: `${server.url}/compat` });
    const kept = JSON.stringify(storedServers(store));
    // Handlers read, change one thing and save the whole object. Here each
    // reads a copy in which the list was tampered with.
    const tampered = {
      ...core.context,
      getSettings: () => {
        const s = core.context.getSettings();
        return { ...s, models: { ...s.models, localServers: [forged()] } };
      }
    };
    const handlers = new Map();
    const ipc = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
    registerSettingsHandlers(ipc, tampered);
    registerModelsHandlers(ipc, tampered);

    const defaults = await handlers.get('settings:saveDefaults')({}, { defaults: { agentMode: true } });
    assert.strictEqual(defaults.ok, true);
    assert.strictEqual(core.context.getSettings().defaults.agentMode, true);
    assert.strictEqual(JSON.stringify(storedServers(store)), kept);

    const catalogSave = await handlers.get(IPC.MODELS_SAVE_CATALOG_SETTINGS)({}, { refreshHours: 12 });
    assert.strictEqual(catalogSave.ok, true);
    assert.strictEqual(core.context.getSettings().models.catalog.refreshHours, 12);
    assert.strictEqual(JSON.stringify(storedServers(store)), kept);

    assert.deepStrictEqual(core.context.getLocalServers().list().map((r) => r.id), ['workstation']);
  });

  it('the core hands out no writer for the list', () => {
    const { core } = makeCore();
    const names = [...Object.keys(core.context), ...Object.keys(core)];
    assert.deepStrictEqual(names.filter((name) => /writeLocal|setLocalServers|writeEntries/i.test(name)), []);
    assert.strictEqual(core.context.getLocalServers().adminOnly, false);
  });

  it('removing a server clears its key', async () => {
    const { core, store } = makeCore();
    await core.context.getLocalServers().add({ id: 'workstation', kind: 'vllm', baseUrl: `${server.url}/compat` });
    store.set('apiTokens', { ...store.get('apiTokens'), __local_workstation: core.context.encryptToken('key-for-workstation'), openai: core.context.encryptToken('sk-test-123456') });
    assert.strictEqual(core.context.getLocalServers().providerFor('workstation').getHeaders().Authorization, 'Bearer key-for-workstation');
    await core.context.getLocalServers().remove('workstation');
    assert.strictEqual('__local_workstation' in store.get('apiTokens'), false);
    assert.ok(store.get('apiTokens').openai, 'no other token is touched');
  });

  it('only the registry, the core\'s seal and the import\'s exclusion name models.localServers in src/', () => {
    const root = path.join(__dirname, '..', 'src');
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /\blocalServers\b/.test(fs.readFileSync(full, 'utf8'))) found.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    };
    walk(root);
    assert.deepStrictEqual(found.sort(), ['core/create-core.js', 'migration/desktop-import.js', 'models/local-servers.js']);
  });
});
