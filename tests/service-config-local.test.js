// tests/service-config-local.test.js
// Local servers in service mode (spec 2026-10-13-local-inference-design.md
// §5.6, §13.3; R-LI-6, R-LI-29): they come only from the `localInference`
// block of the admin service.json. The data-dir copies (service.json and the
// settings) are ignored, each with one warning. An address in the block is
// checked when the file is loaded; a host name is resolved and pinned when
// the service starts, and an entry that fails is left out.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadServiceConfig, parseLocalInferenceConfig } = require('../src/service/config');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const { profileSettings } = require('./helpers/profile-settings');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { setLogLevel, addSink } = require('../src/logging');

setLogLevel('fatal');

const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-local-')); createdTempDirs.push(d); return d; };
const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const writeAdmin = (dir, cfg) => {
  const file = path.join(dir, 'service.json');
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  return file;
};
const opts = (dir) => ({ adminConfigDir: dir, geteuid: () => -1, adminUid: selfUid });
const load = (localInference, dataDir = tmp()) => {
  const admin = tmp();
  writeAdmin(admin, { localInference });
  return loadServiceConfig(dataDir, {}, opts(admin));
};
const FINGERPRINT = 'ab'.repeat(32);

function capture(level, fn) {
  const seen = [];
  setLogLevel(level);
  const remove = addSink((r) => { if (r.level === level) seen.push(r.message); });
  const done = () => { remove(); setLogLevel('fatal'); };
  let out;
  try {
    out = fn();
  } catch (err) {
    done();
    throw err;
  }
  if (out && typeof out.then === 'function') return out.then((value) => { done(); return { value, seen }; }, (err) => { done(); throw err; });
  done();
  return { value: out, seen };
}

describe('service.json: localInference', () => {
  it('no block means no local server', () => {
    assert.deepStrictEqual(loadServiceConfig(tmp()).localInference, { servers: [] });
    assert.deepStrictEqual(load({}).localInference, { servers: [] });
    assert.deepStrictEqual(load({ servers: [] }).localInference, { servers: [] });
  });

  it('a valid block loads, with defaults filled in', () => {
    const cfg = load({
      servers: [
        { id: 'workstation', name: 'Workstation', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', maxConcurrent: 2 },
        { id: 'lan-box', name: 'LAN box', kind: 'vllm', baseUrl: 'https://gpu-box.example.com:8443', tlsFingerprint: FINGERPRINT.toUpperCase(), key: '${vault:local.lan-box}', timeoutMs: 120000 }
      ]
    });
    assert.deepStrictEqual(cfg.localInference.servers, [
      { id: 'workstation', name: 'Workstation', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', addresses: null, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null, key: null, adapters: [] },
      { id: 'lan-box', name: 'LAN box', kind: 'vllm', baseUrl: 'https://gpu-box.example.com:8443', addresses: null, tlsFingerprint: FINGERPRINT, allowCgnat: false, maxConcurrent: 2, timeoutMs: 120000, key: '${vault:local.lan-box}', adapters: [] }
    ]);
  });

  it('an unknown key is the standard unknown-key error', () => {
    assert.throws(() => load({ servers: [], autoAdd: true }), /unknown key "localInference\.autoAdd" \(known: servers\)/);
    assert.throws(
      () => load({ servers: [{ id: 'workstation', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', pinned: { addresses: ['127.0.0.1'] } }] }),
      /unknown key "localInference\.servers\[0\]\.pinned" \(known: id, name, kind, baseUrl, addresses, tlsFingerprint, allowCgnat, maxConcurrent, timeoutMs, key, adapters\)/
    );
    assert.throws(() => load({ servers: [{ id: 'workstation', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', markedLocalAt: 'now' }] }), /unknown key/);
  });

  it('refuses a block of the wrong shape, field by field', () => {
    const base = { id: 'workstation', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' };
    const bad = [
      'servers',
      { servers: {} },
      { servers: ['workstation'] },
      { servers: [{ ...base, id: 'Work Station' }] },
      { servers: [{ ...base, id: undefined }] },
      { servers: [{ ...base, kind: 'cloud' }] },
      { servers: [{ ...base, baseUrl: 'ftp://127.0.0.1' }] },
      { servers: [{ ...base, baseUrl: 'http://user@127.0.0.1:11434' }] },
      { servers: [{ ...base, name: 'two\nlines' }] },
      { servers: [{ ...base, tlsFingerprint: 'abc' }] },
      { servers: [{ ...base, allowCgnat: 'yes' }] },
      { servers: [{ ...base, maxConcurrent: 0 }] },
      { servers: [{ ...base, timeoutMs: -1 }] },
      { servers: [{ ...base, key: 'a-plain-key-in-the-file' }] },
      { servers: [{ ...base, adapters: 'lora' }] },
      { servers: [{ ...base, addresses: [] }] },
      { servers: [{ ...base, addresses: ['gpu-box.example.com'] }] },
      // An address written in the URL is the address: `addresses` cannot name another.
      { servers: [{ ...base, addresses: ['192.168.1.20'] }] },
      { servers: [base, { ...base }] },
      { servers: Array.from({ length: 33 }, (_, i) => ({ ...base, id: `box-${i}` })) }
    ];
    for (const block of bad) {
      assert.throws(() => load(block), /Invalid .*service\.json: /, JSON.stringify(block));
    }
  });

  it('R-LI-6: localInference in the data-dir service.json is ignored with one warning', () => {
    const dataDir = tmp();
    fs.writeFileSync(path.join(dataDir, 'service.json'), JSON.stringify({
      localInference: { servers: [{ id: 'workstation', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }] }
    }));
    const { value, seen } = capture('warn', () => loadServiceConfig(dataDir, {}, opts(tmp())));
    assert.deepStrictEqual(value.localInference, { servers: [] });
    const about = seen.filter((m) => /localInference/.test(m));
    assert.strictEqual(about.length, 1, JSON.stringify(seen));
    assert.ok(about[0].includes('service.json'));
  });

  it('R-LI-29: allowCgnat is an admin key', () => {
    const overlay = { id: 'overlay', kind: 'llamacpp', baseUrl: 'http://100.64.0.5:8000' };
    assert.throws(() => load({ servers: [overlay] }), /100\.64\.0\.5/);
    assert.throws(() => load({ servers: [{ ...overlay, allowCgnat: false }] }), /100\.64\.0\.5/);
    assert.strictEqual(load({ servers: [{ ...overlay, allowCgnat: true }] }).localInference.servers[0].allowCgnat, true);
    // The same for an address the admin lists for a host name.
    const named = { id: 'overlay', kind: 'llamacpp', baseUrl: 'http://gpu-box.example.com:8000', addresses: ['100.64.0.5'] };
    assert.throws(() => load({ servers: [named] }), /100\.64\.0\.5/);
    assert.deepStrictEqual(load({ servers: [{ ...named, allowCgnat: true }] }).localInference.servers[0].addresses, ['100.64.0.5']);
  });

  it('a public literal stops the load', () => {
    for (const baseUrl of ['http://203.0.113.9:8000', 'http://[2001:db8::1]:8000', 'http://169.254.169.254', 'http://0.0.0.0:8000', 'http://[::ffff:203.0.113.9]:8000']) {
      assert.throws(() => load({ servers: [{ id: 'elsewhere', kind: 'vllm', baseUrl }] }), /Invalid .*service\.json: localInference\.servers\[0\]/, baseUrl);
    }
    assert.throws(
      () => load({ servers: [{ id: 'elsewhere', kind: 'vllm', baseUrl: 'https://gpu-box.example.com:8443', addresses: ['192.168.1.20', '203.0.113.9'] }] }),
      /203\.0\.113\.9/
    );
  });

  it('a host name loads without a lookup', () => {
    // No resolver is injectable here at all: loading never resolves.
    const cfg = load({ servers: [{ id: 'lan-box', kind: 'vllm', baseUrl: 'https://gpu-box.example.com:8443', tlsFingerprint: FINGERPRINT }] });
    assert.strictEqual(cfg.localInference.servers[0].baseUrl, 'https://gpu-box.example.com:8443');
    assert.strictEqual(cfg.localInference.servers[0].addresses, null);
    assert.deepStrictEqual(parseLocalInferenceConfig(undefined, 'service.json'), { servers: [] });
  });
});

describe('a core in service mode', () => {
  let server = null;
  const cores = [];
  const dirs = [];
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    while (cores.length) await cores.pop().shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
    if (server) { await server.close(); server = null; }
  });

  function makeCore({ localInference, lookup = null, settings = {}, vault = {}, localPinTimeoutMs = null } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-local-core-'));
    dirs.push(dataDir);
    globalThis.fetch = async (url) => { throw new Error(`no network in unit tests (${url})`); };
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', profileSettings(settings, {}));
    const vaultStore = new JsonFileStore({ dir: dataDir, name: 'config' });
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    for (const [key, value] of Object.entries(vault)) vaultStore.set(`__vault_${key}`, cipher.encryptString(value));
    const lookups = [];
    const core = createCore({
      paths: { dataDir },
      store,
      vaultStore,
      cipher,
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() },
      ingest: 'none',
      localInference,
      ...(localPinTimeoutMs ? { localPinTimeoutMs } : {}),
      ...(lookup ? { lookup: async (host, options) => { lookups.push(host); return lookup(host, options); } } : {})
    });
    cores.push(core);
    return { core, store, lookups, dataDir };
  }

  it('pins the admin\'s servers at start: an address as written, a host name through the lookup', async () => {
    const { core, lookups } = makeCore({
      localInference: {
        servers: [
          { id: 'workstation', name: 'Workstation', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', addresses: null, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null, key: null, adapters: [] },
          { id: 'lan-box', name: 'LAN box', kind: 'vllm', baseUrl: 'https://gpu-box.example.com:8443', addresses: null, tlsFingerprint: FINGERPRINT, allowCgnat: false, maxConcurrent: 2, timeoutMs: null, key: null, adapters: [] },
          { id: 'listed', name: 'Listed', kind: 'vllm', baseUrl: 'http://other-box.example.com:8000', addresses: ['192.168.1.30'], tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null, key: null, adapters: [] }
        ]
      },
      lookup: async () => [{ address: '192.168.1.20', family: 4 }]
    });
    const servers = core.context.getLocalServers();
    assert.deepStrictEqual(servers.list(), [], 'nothing is a local server before the pins are checked');
    await core.start();
    const rows = servers.list();
    assert.deepStrictEqual(rows.map((r) => [r.id, r.usable, r.grade, r.pinned.addresses, r.pinned.class]), [
      ['workstation', true, 'guarantee', ['127.0.0.1'], 'loopback'],
      ['lan-box', true, 'guarantee', ['192.168.1.20'], 'lan'],
      ['listed', true, 'cost-only', ['192.168.1.30'], 'lan']
    ]);
    assert.ok(rows.every((r) => typeof r.markedLocalAt === 'string' && r.markedLocalAt));
    assert.deepStrictEqual(lookups, ['gpu-box.example.com'], 'only the host name with no listed address was resolved');
    assert.strictEqual(servers.adminOnly, true);
  });

  it('a host-name server whose lookup answers a public address: the core starts, lists no local server, and logs one error', async () => {
    const { core } = makeCore({
      localInference: {
        servers: [{ id: 'lan-box', name: 'LAN box', kind: 'vllm', baseUrl: 'https://gpu-box.example.com:8443', addresses: null, tlsFingerprint: FINGERPRINT, allowCgnat: false, maxConcurrent: 2, timeoutMs: null, key: null, adapters: [] }]
      },
      lookup: async () => [{ address: '192.168.1.20', family: 4 }, { address: '203.0.113.9', family: 4 }]
    });
    const { seen } = await capture('error', () => core.start());
    assert.deepStrictEqual(core.context.getLocalServers().list(), []);
    const about = seen.filter((m) => /lan-box/.test(m));
    assert.strictEqual(about.length, 1, JSON.stringify(seen));
    assert.match(about[0], /203\.0\.113\.9/);
    assert.notStrictEqual(core.context.getLocalServers().isGuaranteeTarget({ provider: 'local', model: 'lan-box/m' }), true);
    assert.strictEqual(core.context.explainTarget('local', 'lan-box/m').code, 'LOCAL_SERVER_UNKNOWN');
  });

  it('a lookup that fails or never answers leaves the entry out, and the core still starts', async () => {
    const entry = (id, host) => ({ id, name: id, kind: 'vllm', baseUrl: `http://${host}:8000`, addresses: null, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null, key: null, adapters: [] });
    const { core } = makeCore({
      localInference: { servers: [entry('gone', 'gone.example.com'), entry('slow', 'slow.example.com'), entry('fine', 'fine.example.com')] },
      localPinTimeoutMs: 200,
      lookup: async (host) => {
        if (host === 'gone.example.com') throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        if (host === 'slow.example.com') return new Promise(() => {});
        return [{ address: '192.168.1.40', family: 4 }];
      }
    });
    const started = Date.now();
    const { seen } = await capture('error', () => core.start());
    assert.ok(Date.now() - started < 5000);
    assert.deepStrictEqual(core.context.getLocalServers().list().map((r) => r.id), ['fine']);
    assert.strictEqual(seen.filter((m) => /\bgone\b/.test(m)).length, 1);
    assert.strictEqual(seen.filter((m) => /\bslow\b/.test(m)).length, 1);
  });

  it('R-LI-6: models.localServers in the data-dir settings is ignored with one warning per start', async () => {
    const stored = {
      id: 'sneaked', name: 'Sneaked', kind: 'vllm', baseUrl: 'http://127.0.0.1:9', tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
      pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: '2026-10-13T09:00:00.000Z' }, markedLocalAt: '2026-10-13T09:00:00.000Z'
    };
    const { core } = makeCore({ localInference: { servers: [] }, settings: { models: { localServers: [stored] } } });
    const { seen } = await capture('warn', () => core.start());
    assert.deepStrictEqual(core.context.getLocalServers().list(), []);
    assert.strictEqual(core.context.explainTarget('local', 'sneaked/m').code, 'LOCAL_SERVER_UNKNOWN');
    assert.strictEqual(core.models.catalog.price('local', 'sneaked/m', { input: 10, output: 10 }), null);
    const about = seen.filter((m) => /localServers/.test(m));
    assert.strictEqual(about.length, 1, JSON.stringify(seen));
    assert.match(about[0], /service\.json/);
  });

  it('service mode with no localInference block at all has no local server either', async () => {
    const stored = {
      id: 'sneaked', name: 'Sneaked', kind: 'vllm', baseUrl: 'http://127.0.0.1:9', tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
      pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: '2026-10-13T09:00:00.000Z' }, markedLocalAt: '2026-10-13T09:00:00.000Z'
    };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-local-core-'));
    dirs.push(dataDir);
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', profileSettings({ models: { localServers: [stored] } }, {}));
    const core = createCore({
      paths: { dataDir }, store, vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }), cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(), ui: { send: () => {} }, builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() }, ingest: 'none',
      isService: true
    });
    cores.push(core);
    await core.start();
    assert.deepStrictEqual(core.context.getLocalServers().list(), []);
    assert.strictEqual(core.context.getLocalServers().adminOnly, true);
  });

  it('the admin\'s add, remove, recheck and fromOllama are refused; a server\'s key is its vault reference', async () => {
    server = await startFakeLlmServer();
    const { core } = makeCore({
      localInference: {
        servers: [{ id: 'workstation', name: 'Workstation', kind: 'vllm', baseUrl: `${server.url}/compat`, addresses: null, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null, key: '${vault:local.workstation}', adapters: [] }]
      },
      vault: { 'local.workstation': 'key-from-the-vault' }
    });
    await core.start();
    const servers = core.context.getLocalServers();
    await assert.rejects(servers.add({ id: 'another', kind: 'vllm', baseUrl: 'http://127.0.0.1:9' }), (err) => err.code === 'LOCAL_SERVER_ADMIN_ONLY');
    await assert.rejects(servers.remove('workstation'), (err) => err.code === 'LOCAL_SERVER_ADMIN_ONLY');
    await assert.rejects(servers.recheck('workstation', { confirm: true, expected: ['127.0.0.1'] }), (err) => err.code === 'LOCAL_SERVER_ADMIN_ONLY');
    await assert.rejects(servers.fromOllama({}), (err) => err.code === 'LOCAL_SERVER_ADMIN_ONLY');
    assert.strictEqual(servers.list().length, 1);
    // The listing never carries the key or its reference.
    assert.ok(!JSON.stringify(servers.list()).includes('vault'));
    assert.strictEqual('key' in servers.list()[0], false);
    assert.strictEqual(await servers.providerFor('workstation').sendMessage([{ role: 'user', content: 'hi' }], { model: 'workstation/test-model' }), 'Hello there');
    const req = [...server.requests].reverse().find((r) => r.method === 'POST');
    assert.strictEqual(req.headers.authorization, 'Bearer key-from-the-vault');
  });
});
