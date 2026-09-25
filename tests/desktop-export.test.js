// tests/desktop-export.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { openDesktopState, secureStorageUsable } = require('../src/ipc/desktop-state');
const { loadDesktopSource, planImport, applyImport } = require('../src/ipc/desktop-export');
const { createCore } = require('../src/core');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { DesktopImporter, buildImportTargets } = require('../src/migration/desktop-import');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { checkPath } = require('../src/desktop-bridge/check-path');

const dirs = [];
const cores = [];
after(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p = 'kl-export-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

// Reversible stand-in for Electron's safeStorage.
const fakeSafeStorage = (available = true, backend = 'gnome_libsecret') => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^sealed:/, '')
});
const storeFactory = ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults });
const sealed = (plain) => Buffer.from(`sealed:${plain}`).toString('base64');

describe('desktop bridge state', () => {
  it('defaults to standalone with a persistent installId', () => {
    const dir = tmp();
    const state = openDesktopState(dir, fakeSafeStorage(), { storeFactory });
    assert.strictEqual(state.mode, 'standalone');
    assert.match(state.installId, /^[0-9a-f-]{36}$/);
    const again = openDesktopState(dir, fakeSafeStorage(), { storeFactory });
    assert.strictEqual(again.installId, state.installId);
    state.setMode('attached');
    assert.strictEqual(openDesktopState(dir, fakeSafeStorage(), { storeFactory }).mode, 'attached');
    assert.throws(() => state.setMode('sideways'), /unknown mode/);
    assert.ok(fs.existsSync(path.join(dir, 'desktop-bridge.json')));
  });

  it('seals with safeStorage and refuses without it (or with basic_text on Linux)', () => {
    const state = openDesktopState(tmp(), fakeSafeStorage(), { storeFactory, platform: 'linux' });
    const box = state.seal('-----BEGIN PRIVATE KEY-----');
    assert.strictEqual(state.unseal(box), '-----BEGIN PRIVATE KEY-----');
    assert.strictEqual(secureStorageUsable(fakeSafeStorage(true, 'basic_text'), 'linux'), false);
    assert.strictEqual(secureStorageUsable(fakeSafeStorage(true, 'basic_text'), 'win32'), true);
    assert.strictEqual(secureStorageUsable(fakeSafeStorage(false), 'darwin'), false);
    const bare = openDesktopState(tmp(), fakeSafeStorage(false), { storeFactory });
    assert.throws(() => bare.seal('x'), (err) => err.code === 'SECURE_STORAGE_UNAVAILABLE');
  });
});

describe('desktop export over a bridge client', () => {
  function desktopProfile() {
    const root = tmp('kl-export-profile-');
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({
      chats: [{ id: 'c1', title: 'Lakeside lot', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', messages: [] }],
      settings: { inference: { activeTier: 'fast' } },
      apiTokens: { anthropic: sealed('sk-example-anthropic') }
    }));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ __vault_github: sealed('ghp_example_token') }));
    fs.writeFileSync(path.join(root, 'desktop-bridge.json'), JSON.stringify({ mode: 'standalone', installId: '11111111-2222-4333-8444-555555555555' }));
    return root;
  }

  async function serviceClient() {
    const dataDir = tmp('kl-export-svc-');
    const core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    });
    cores.push(core);
    await core.start();
    const importer = new DesktopImporter({
      context: core.context, targets: await buildImportTargets({ context: core.context, dataDir }), dataDir, checkPath,
      scope: createDesktopScope({ dataDir, context: core.context })
    });
    const calls = [];
    const client = {
      call: async (method, params) => {
        calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
        return importer[method.split('.')[1]](params);
      }
    };
    return { core, client, calls };
  }

  it('plans with ids only, then sends decrypted secrets in apply batches', async () => {
    const root = desktopProfile();
    const source = loadDesktopSource({ userDataDir: root, safeStorage: fakeSafeStorage(), platform: 'win32' });
    assert.strictEqual(source.installId, '11111111-2222-4333-8444-555555555555');
    const { core, client, calls } = await serviceClient();
    const plan = await planImport({ client, source });
    assert.strictEqual(calls[0].method, 'import.plan');
    assert.ok(!JSON.stringify(calls[0].params).includes('ghp_example_token'));
    const progress = [];
    const report = await applyImport({ client, plan, source, onProgress: (p) => progress.push(p) });
    assert.deepStrictEqual(report.failures, []);
    assert.deepStrictEqual(calls.map((c) => c.method).slice(-1), ['import.finish']);
    assert.ok(calls.some((c) => c.method === 'import.apply' && JSON.stringify(c.params).includes('ghp_example_token')));
    assert.strictEqual(core.context.vault.get('github'), 'ghp_example_token');
    assert.strictEqual(core.context.decryptToken(core.context.getApiTokens().anthropic), 'sk-example-anthropic');
    assert.ok(progress.length >= 1);
    const last = progress[progress.length - 1];
    assert.strictEqual(last.sent, last.total);
  });

  it('marks secrets needs-attention when this desktop has no secure storage', async () => {
    const root = desktopProfile();
    const source = loadDesktopSource({ userDataDir: root, safeStorage: fakeSafeStorage(false), platform: 'win32' });
    assert.strictEqual(source.inventory.secrets, 'unavailable');
    const { client } = await serviceClient();
    const plan = await planImport({ client, source });
    const vault = plan.items.find((i) => i.category === 'vault');
    assert.strictEqual(vault.action, 'needs-attention');
    assert.strictEqual(vault.note, "This system has no secure storage; the desktop can't hold a pairing key.");
  });

  it('reports a batch the service refused as per-item failures', async () => {
    const root = desktopProfile();
    const source = loadDesktopSource({ userDataDir: root, safeStorage: fakeSafeStorage(), platform: 'win32' });
    const client = {
      call: async (method) => {
        if (method === 'import.plan') return { planId: 'p1', items: [{ category: 'chat', key: 'c1', action: 'new' }], counts: { new: 1 } };
        if (method === 'import.apply') throw Object.assign(new Error('The import plan expired; plan the import again.'), { code: 'PLAN_EXPIRED' });
        return { planId: 'p1', counts: { new: 1, failed: 1 }, failures: [{ category: 'chat', key: 'c1', error: 'not sent by the desktop' }], attention: [], secretsMissing: [], cronDisabled: 0, notes: [] };
      }
    };
    const plan = await planImport({ client, source });
    const report = await applyImport({ client, plan, source });
    assert.deepStrictEqual(report.sendFailures, [{ category: 'chat', key: 'c1', ok: false, error: 'The import plan expired; plan the import again.', code: 'PLAN_EXPIRED' }]);
  });
});

// Final pass (Task 12 parked): applyImport robustness.
describe('applyImport robustness', () => {
  // Three ~1 MB items: each batch holds one, so there are three batches.
  const bigSource = { getValue: (category, key) => `${key}:${'x'.repeat(1000000)}` };
  const bigPlan = { planId: 'p1', items: ['m1', 'm2', 'm3'].map((key) => ({ category: 'memory', key, action: 'new' })) };
  const finishReport = { planId: 'p1', counts: {}, failures: [], attention: [], secretsMissing: [], cronDisabled: 0, notes: [] };

  function recordingClient(onApply, onFinish = async () => finishReport) {
    const calls = [];
    return {
      calls,
      call: async (method, params) => {
        calls.push(method);
        if (method === 'import.apply') return onApply(params, calls.filter((m) => m === 'import.apply').length);
        if (method === 'import.finish') return onFinish();
        throw new Error(`unexpected ${method}`);
      }
    };
  }

  it('a malformed apply answer fails that batch, keeps going, and still finishes', async () => {
    const client = recordingClient((params, n) => (n === 2 ? {} : { results: params.batch.map((e) => ({ category: e.category, key: e.key, ok: true })) }));
    const progress = [];
    const report = await applyImport({ client, plan: bigPlan, source: bigSource, onProgress: (x) => progress.push(x) });
    assert.deepStrictEqual(client.calls, ['import.apply', 'import.apply', 'import.apply', 'import.finish']);
    assert.deepStrictEqual(report.sendFailures, [{ category: 'memory', key: 'm2', ok: false, error: 'The service sent no per-item results for this batch.', code: 'MALFORMED_RESPONSE' }]);
    assert.deepStrictEqual(progress[progress.length - 1], { sent: 3, total: 3 });
  });

  it('per-item ok:false results are send failures; ok must be true', async () => {
    const client = recordingClient((params) => ({ results: params.batch.map((e) => ({ category: e.category, key: e.key, ok: e.key === 'm1' ? true : (e.key === 'm2' ? 'yes' : false), error: 'refused' })) }));
    const report = await applyImport({ client, plan: bigPlan, source: bigSource });
    assert.deepStrictEqual(report.sendFailures.map((f) => f.key), ['m2', 'm3']);
  });

  it('PLAN_EXPIRED stops sending, keeps the code, and still asks for the report', async () => {
    const client = recordingClient(() => { throw Object.assign(new Error('The import plan expired; plan the import again.'), { code: 'PLAN_EXPIRED' }); });
    const progress = [];
    const report = await applyImport({ client, plan: bigPlan, source: bigSource, onProgress: (x) => progress.push(x) });
    assert.deepStrictEqual(client.calls, ['import.apply', 'import.finish']);
    assert.deepStrictEqual(report.sendFailures, [{ category: 'memory', key: 'm1', ok: false, error: 'The import plan expired; plan the import again.', code: 'PLAN_EXPIRED' }]);
    assert.deepStrictEqual(progress[progress.length - 1], { sent: 3, total: 3 });
  });

  it('a closed connection stops sending and surfaces the apply error when finish fails too', async () => {
    const gone = () => Object.assign(new Error('The local King Louie service is not reachable (127.0.0.1:18796).'), { code: 'SERVICE_UNREACHABLE' });
    const client = recordingClient(() => { throw gone(); }, async () => { throw Object.assign(new Error('finish failed'), { code: 'OTHER' }); });
    await assert.rejects(applyImport({ client, plan: bigPlan, source: bigSource }), (err) => err.code === 'SERVICE_UNREACHABLE');
    assert.deepStrictEqual(client.calls, ['import.apply', 'import.finish']);
  });

  it('a non-fatal apply error (timeout) keeps going', async () => {
    const client = recordingClient((params, n) => {
      if (n === 1) throw Object.assign(new Error('The local service did not answer in time.'), { code: 'BRIDGE_TIMEOUT' });
      return { results: params.batch.map((e) => ({ category: e.category, key: e.key, ok: true })) };
    });
    const report = await applyImport({ client, plan: bigPlan, source: bigSource });
    assert.deepStrictEqual(client.calls, ['import.apply', 'import.apply', 'import.apply', 'import.finish']);
    assert.deepStrictEqual(report.sendFailures.map((f) => [f.key, f.code]), [['m1', 'BRIDGE_TIMEOUT']]);
  });

  it('secrets unavailable: a vault item the plan still asks for is skipped, never sent', async () => {
    const root = tmp('kl-export-profile-');
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({ chats: [], settings: {} }));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ __vault_github: sealed('ghp_example_token') }));
    const source = loadDesktopSource({ userDataDir: root, safeStorage: fakeSafeStorage(false), platform: 'win32' });
    assert.strictEqual(source.inventory.secrets, 'unavailable');
    const sent = [];
    const client = recordingClient((params) => { sent.push(params); return { results: [] }; });
    const plan = { planId: 'p1', items: [{ category: 'vault', key: 'github', action: 'new' }] };
    const report = await applyImport({ client, plan, source });
    assert.strictEqual(report.skipped.length, 1);
    assert.strictEqual(report.skipped[0].key, 'github');
    assert.ok(!JSON.stringify(sent).includes('ghp_example_token'), 'the secret never left');
    assert.deepStrictEqual(client.calls, ['import.finish']);
  });
});
