// tests/migration-verify.test.js — is the move really on the node (attach stage 2 §6.5)?
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { checkPath } = require('../src/desktop-bridge/check-path');
const { DesktopImporter, buildImportTargets } = require('../src/migration/desktop-import');
const { verifyMigration, withSourceCounts } = require('../src/migration/migration-verify');
const { CaseRuntime } = require('../src/cases/case-runtime');
const { CaseStore } = require('../src/cases/case-store');
const git = require('../src/cases/git');
const { HistoryStore } = require('../src/history');
const { CHAT_DATA_DEFAULTS } = require('../src/core/settings');
const { buildServicePorts } = require('../src/service/ports');
const { createDesktopBridgeHost } = require('../src/desktop-bridge/service-wiring');
const { DesktopBridgeClient } = require('../src/desktop-bridge/bridge-client');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { createDesktopController } = require('../src/ipc/desktop-controller');
const { seedChat } = require('./helpers/history-fixture');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const dirs = [];
const cores = [];
const savedRoot = process.env.KL_CASES_ROOT;
after(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  closeOpenHistoryStores();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (savedRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedRoot;
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-verify-')); dirs.push(d); return d; };

const chatItem = (key, messageCount, extra = {}) => ({ category: 'chat', key, action: 'new', note: null, targetKey: key, messageCount, ...extra });
const caseItem = (key, extra = {}) => ({ category: 'case', key, action: 'new', note: null, targetKey: key, ...extra });
const cleanReport = (extra = {}) => ({ counts: { failed: 0 }, failures: [], attention: [], incomplete: [], skipped: [], sendFailures: [], ...extra });

function nodeAnswers({ chats = [], cases = [], available = true } = {}) {
  const asked = [];
  const invoke = async (channel) => {
    asked.push(channel);
    if (channel === 'chat:load') return { chats, activeChatId: null, history: { available, error: null, migrationFailed: 0 } };
    if (channel === 'case:list') return { ok: true, cases };
    throw new Error(`unexpected channel ${channel}`);
  };
  return { invoke, asked };
}
const nodeCase = (dir) => ({ id: `id-${dir}`, slug: dir, title: dir, dir: `C:\\node\\cases\\${dir}` });

describe('verifyMigration', () => {
  it('passes when the planned chats and cases are on the node, by target id and count', async () => {
    const { invoke } = nodeAnswers({
      chats: [{ id: 'c1', messageCount: 3 }, { id: 'c2-ab12', messageCount: 1 }],
      cases: [nodeCase('lakeside-lot')]
    });
    const plan = { items: [chatItem('c1', 3), chatItem('c2', 1, { action: 'copy', targetKey: 'c2-ab12' }), caseItem('lakeside-lot')] };
    assert.deepStrictEqual(await verifyMigration({ plan, report: cleanReport(), invoke }), { ok: true, checked: { chats: 2, cases: 1 } });
  });

  it('reads the handlers\' wrapped answers ({ ok, data }), as the bridge really gives them', async () => {
    const invoke = async (channel) => (channel === 'chat:load'
      ? { ok: true, data: { chats: [{ id: 'c1', messageCount: 1 }], history: { available: true } } }
      : { ok: true, cases: [nodeCase('lot')] });
    assert.strictEqual((await verifyMigration({ plan: { items: [chatItem('c1', 1), caseItem('lot')] }, report: cleanReport(), invoke })).ok, true);
    const shutWrapped = async () => ({ ok: true, data: { chats: [], history: { available: false, error: 'the store did not open' } } });
    const out = await verifyMigration({ plan: { items: [chatItem('c1', 1)] }, report: cleanReport(), invoke: shutWrapped });
    assert.match(out.missing[0].why, /did not open/);
    const refused = await verifyMigration({ plan: { items: [chatItem('c1', 1)] }, report: cleanReport(), invoke: async () => ({ ok: false, error: 'refused here' }) });
    assert.match(refused.missing[0].why, /refused here/);
  });

  it('one chat missing is MIGRATION_UNVERIFIED and names it', async () => {
    const { invoke } = nodeAnswers({ chats: [{ id: 'c1', messageCount: 1 }] });
    const out = await verifyMigration({ plan: { items: [chatItem('c1', 1), chatItem('c2', 1)] }, report: cleanReport(), invoke });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'MIGRATION_UNVERIFIED');
    assert.deepStrictEqual(out.missing.map((m) => [m.category, m.key]), [['chat', 'c2']]);
    assert.ok(out.missing[0].why);
  });

  it('a chat there under its source id does not stand in for a copy planned under another id', async () => {
    const { invoke } = nodeAnswers({ chats: [{ id: 'c2', messageCount: 1 }] });
    const plan = { items: [chatItem('c2', 1, { action: 'copy', targetKey: 'c2-ab12' })] };
    assert.strictEqual((await verifyMigration({ plan, report: cleanReport(), invoke })).ok, false);
  });

  it('a chat moved without all its messages is unverified: short by one', async () => {
    const { invoke } = nodeAnswers({ chats: [{ id: 'c1', messageCount: 2 }] });
    const out = await verifyMigration({ plan: { items: [chatItem('c1', 3)] }, report: cleanReport(), invoke });
    assert.strictEqual(out.ok, false);
    assert.match(out.missing[0].why, /2/);
    assert.match(out.missing[0].why, /3/);
  });

  it('fails closed on a chat with no count on either side', async () => {
    const noSource = await verifyMigration({ plan: { items: [chatItem('c1', undefined)] }, report: cleanReport(), invoke: nodeAnswers({ chats: [{ id: 'c1', messageCount: 1 }] }).invoke });
    assert.strictEqual(noSource.ok, false);
    const noNode = await verifyMigration({ plan: { items: [chatItem('c1', 1)] }, report: cleanReport(), invoke: nodeAnswers({ chats: [{ id: 'c1' }] }).invoke });
    assert.strictEqual(noNode.ok, false);
  });

  it('a chat already on the node (skip-present) is checked too: there, and holding at least the source\'s messages', async () => {
    const present = chatItem('c1', 3, { action: 'skip-present' });
    assert.strictEqual((await verifyMigration({ plan: { items: [present] }, report: cleanReport(), invoke: nodeAnswers({ chats: [{ id: 'c1', messageCount: 5 }] }).invoke })).ok, true, 'the node may have gone on');
    assert.strictEqual((await verifyMigration({ plan: { items: [present] }, report: cleanReport(), invoke: nodeAnswers({ chats: [{ id: 'c1', messageCount: 2 }] }).invoke })).ok, false);
    assert.strictEqual((await verifyMigration({ plan: { items: [present] }, report: cleanReport(), invoke: nodeAnswers({ chats: [] }).invoke })).ok, false);
  });

  it('a case that is not on the node is unverified, also on a retry that plans it skip-present', async () => {
    const { invoke } = nodeAnswers({ cases: [nodeCase('other')] });
    const out = await verifyMigration({ plan: { items: [caseItem('lakeside-lot')] }, report: cleanReport(), invoke });
    assert.deepStrictEqual(out.missing.map((m) => m.key), ['lakeside-lot']);
    assert.strictEqual((await verifyMigration({ plan: { items: [caseItem('lakeside-lot', { action: 'skip-present' })] }, report: cleanReport(), invoke })).ok, false);
  });

  it('a case\'s directory is compared by its last segment, whichever separator the node used', async () => {
    const { invoke } = nodeAnswers({ cases: [{ dir: '/srv/node/cases/lakeside-lot' }, { dir: 'C:\\node\\cases\\north-field' }] });
    const plan = { items: [caseItem('lakeside-lot'), caseItem('north-field')] };
    assert.strictEqual((await verifyMigration({ plan, report: cleanReport(), invoke })).ok, true);
  });

  it('needs-attention items are not verified as missing', async () => {
    const { invoke, asked } = nodeAnswers();
    const plan = {
      items: [
        caseItem('hand-moved', { action: 'needs-attention', note: 'a case with this directory already exists on the service' }),
        { category: 'settings', key: 'models', action: 'needs-attention', note: 'your 2 model profiles were not moved' },
        { category: 'excluded', key: 'skills', action: 'skip-excluded', note: 'stays' }
      ]
    };
    const report = cleanReport({ attention: [{ category: 'settings', key: 'models', note: 'your 2 model profiles were not moved' }] });
    assert.deepStrictEqual(await verifyMigration({ plan, report, invoke }), { ok: true, checked: { chats: 0, cases: 0 } });
    assert.deepStrictEqual(asked, [], 'nothing planned to check, nothing asked');
  });

  it('an attention note on a chat that landed is not a miss (a working directory dropped)', async () => {
    const { invoke } = nodeAnswers({ chats: [{ id: 'c1', messageCount: 1 }] });
    const report = cleanReport({ attention: [{ category: 'chat', key: 'c1', note: 'the service cannot read the working directory; it was dropped' }] });
    assert.strictEqual((await verifyMigration({ plan: { items: [chatItem('c1', 1)] }, report, invoke })).ok, true);
  });

  it('a case that landed incomplete is unverified, in this run\'s report or from the plan of a retry', async () => {
    const { invoke } = nodeAnswers({ cases: [nodeCase('lakeside-lot')] });
    const now = await verifyMigration({ plan: { items: [caseItem('lakeside-lot')] }, report: cleanReport({ incomplete: [{ category: 'case', key: 'lakeside-lot', note: 'received 1 file(s)' }] }), invoke });
    assert.deepStrictEqual(now.missing.map((m) => m.key), ['lakeside-lot']);
    const retry = await verifyMigration({ plan: { items: [caseItem('lakeside-lot', { action: 'needs-attention', incomplete: true, note: 'landed incomplete' })] }, report: cleanReport(), invoke });
    assert.strictEqual(retry.ok, false);
  });

  it('every way a report says a failure is a failure', async () => {
    const { invoke } = nodeAnswers();
    const plan = { items: [] };
    for (const report of [
      cleanReport({ failures: [{ category: 'memory', key: 'm-1', error: 'disk full' }] }),
      cleanReport({ sendFailures: [{ category: 'memory', key: 'm-1', ok: false, error: 'refused' }] }),
      cleanReport({ skipped: [{ category: 'case', key: 'lot/a.md', error: 'missing' }] }),
      cleanReport({ counts: { failed: 1 } })
    ]) {
      const out = await verifyMigration({ plan, report, invoke });
      assert.strictEqual(out.ok, false, JSON.stringify(report));
      assert.strictEqual(out.code, 'MIGRATION_UNVERIFIED');
    }
  });

  it('a report with no failures list proves nothing (the importer answers `failures`; there is no `failed`)', async () => {
    const { invoke } = nodeAnswers();
    for (const report of [null, {}, { failed: [] }]) {
      assert.strictEqual((await verifyMigration({ plan: { items: [] }, report, invoke })).ok, false, JSON.stringify(report));
    }
    assert.strictEqual((await verifyMigration({ plan: null, report: cleanReport(), invoke })).ok, false);
  });

  it('a node that does not answer, or whose store is shut, is unverified and never throws', async () => {
    const plan = { items: [chatItem('c1', 1), caseItem('lot')] };
    const refused = await verifyMigration({ plan, report: cleanReport(), invoke: async () => { throw Object.assign(new Error('not reachable'), { code: 'SERVICE_UNREACHABLE' }); } });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.missing.length, 2);
    const shut = await verifyMigration({ plan: { items: [chatItem('c1', 1)] }, report: cleanReport(), invoke: nodeAnswers({ chats: [{ id: 'c1', messageCount: 1 }], available: false }).invoke });
    assert.strictEqual(shut.ok, false);
    const noList = await verifyMigration({ plan: { items: [caseItem('lot')] }, report: cleanReport(), invoke: async () => ({ ok: false, error: 'off' }) });
    assert.strictEqual(noList.ok, false);
  });

  it('what it names goes through shown', async () => {
    const { invoke } = nodeAnswers();
    const out = await verifyMigration({ plan: { items: [chatItem('c\u202Eevil', 1)] }, report: cleanReport(), invoke });
    assert.ok(!out.missing[0].key.includes('\u202E'));
  });

  it('withSourceCounts puts the source\'s count on each chat item and leaves the rest alone', () => {
    const plan = { planId: 'p', counts: {}, items: [chatItem('c1', undefined), caseItem('lot')] };
    const out = withSourceCounts(plan, { getValue: (cat, id) => (cat === 'chat' && id === 'c1' ? { id, messages: [{}, {}] } : null) });
    assert.strictEqual(out.items[0].messageCount, 2);
    assert.strictEqual('messageCount' in out.items[1], false);
    assert.strictEqual(out.planId, 'p');
  });
});

// The whole path: a temp profile on disk, the controller, a real bridge client
// and server, a real personal-node core. Only the phone-free agent wiring is left out.
describe('the move over a real bridge', () => {
  it('moves a chat and a case into the node, verifies by the node\'s own answers, marks, and a second plan is refused', async () => {
    const root = tmp();
    const dataDir = path.join(root, 'node', 'data');
    const configDir = path.join(root, 'node', 'config');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    const nodeCases = path.join(dataDir, 'cases');
    process.env.KL_CASES_ROOT = nodeCases;
    fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: laptop-01\nprofile: agent\nhosting: personal\n');
    const adminUid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const host = createDesktopBridgeHost({ dataDir, configDir, features: { desktopBridge: true }, ports: { desktopBridge: 0 }, adminUid, version: '26.9.0' });
    const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
    const core = createCore({
      ...servicePorts,
      ...host.coreDeps,
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals: 'deny',
      workingDirectory: dataDir,
      builtinSkillsDir: path.join(__dirname, '..', 'skills')
    });
    await core.start();

    // The old profile: a store with one chat of three messages, one real case.
    const userDataDir = path.join(root, 'profile', 'king-louie');
    fs.mkdirSync(userDataDir, { recursive: true });
    const seeded = HistoryStore.open(path.join(userDataDir, 'history.sqlite'));
    seedChat(seeded, { id: 'c1', title: 'Lakeside lot', messages: [{ sender: 'user', text: 'one' }, { sender: 'assistant', text: 'two' }, { sender: 'user', text: 'three' }] });
    seeded.close();
    fs.writeFileSync(path.join(userDataDir, 'chat-data.json'), JSON.stringify({ settings: {} }));
    const runtime = new CaseRuntime({ root: path.join(userDataDir, 'cases') });
    const made = await runtime.createCase({ title: 'North field', objective: 'Survey the field', force: true });
    const caseDir = runtime.getCase(made.id).dir;
    const sourceHead = (await git.git(caseDir, ['rev-parse', 'HEAD'])).trim();
    const profileHash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(userDataDir, 'history.sqlite'))).digest('hex');
    const hashBefore = profileHash();

    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() };
    const storeFactory = ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults });
    const state = openDesktopState(userDataDir, safeStorage, { storeFactory });
    let client = null;
    let controller = null;
    try {
      const server = await host.start({ core, ports: servicePorts, approvals: null });
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const raw = keys.rawFromPublicKeyObject(publicKey);
      const deviceId = keys.deriveDeviceId(raw, 'kld-');
      pairing.writeFileAtomic(path.join(configDir, 'desktop-devices.json'), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), { deviceId, publicKey: keys.toB64url(raw), label: 'laptop-01 desk', pairedAt: '2026-11-04T09:00:00Z' })), 0o644);
      client = new DesktopBridgeClient({
        port: server.port,
        pin: { nodeId: server.identity.nodeId, publicKey: server.identity.publicKey.toString('hex') },
        deviceId,
        sign: async (bytes) => crypto.sign(null, bytes, privateKey)
      });
      await client.connect();
      state.setMode('attached');
      state.setPairing({ deviceId, publicKey: 'x', privateKeySealed: 'y', label: 'desk', service: { nodeId: server.identity.nodeId, publicKey: server.identity.publicKey.toString('hex'), port: server.port, hosting: 'personal', dataDir, name: 'laptop-01' } });
      const app = { relaunch() {}, exit() {}, quit() {}, getVersion: () => '26.9.0' };
      controller = createDesktopController({
        state, mode: 'attached', app, env: {}, platform: 'linux', userDataDir, safeStorage,
        stdout: { write() {} }, argv: ['electron', '.'], username: 'alex',
        launch: { host: 'attached', why: 'attached', degraded: false }, nodeRunner: null
      });
      controller.setClient(client);

      const planned = await controller.migrationPlan();
      assert.strictEqual(planned.ok, true, JSON.stringify(planned));
      assert.deepStrictEqual(planned.backup.history, { chats: 1, messages: 3 });
      assert.strictEqual(planned.plan.items.find((i) => i.category === 'chat').action, 'new');
      assert.strictEqual(planned.plan.items.find((i) => i.category === 'case').action, 'new');
      assert.doesNotMatch(planned.staysBehind.join('\n'), /bot tokens stay|hooks spawn|MCP servers spawn/, 'a personal node carries these');

      const out = await controller.migrationApply({ confirmed: true });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      assert.deepStrictEqual(out.verified, { ok: true, checked: { chats: 1, cases: 1 } });

      assert.strictEqual(core.context.getChat('c1').messages.length, 3);
      const landed = path.join(nodeCases, path.basename(caseDir));
      assert.strictEqual((await git.git(landed, ['rev-parse', 'HEAD'])).trim(), sourceHead);
      assert.strictEqual((await git.git(landed, ['status', '--porcelain'])).trim(), '');

      assert.strictEqual(state.migration.nodeId, server.identity.nodeId);
      assert.strictEqual(state.migration.nodeDataDir, dataDir);
      assert.ok(fs.existsSync(path.join(state.migration.backupDir, 'backup.json')));
      assert.strictEqual(profileHash(), hashBefore, 'the old profile\'s store is untouched');
      assert.ok(fs.existsSync(caseDir), 'and its cases are still there');

      assert.strictEqual((await controller.migrationPlan()).code, 'PROFILE_MIGRATED');
      assert.strictEqual((await controller.standaloneOnce()).code, 'PROFILE_MIGRATED');
    } finally {
      if (controller) controller.dispose();
      if (client) client.close();
      await host.stop();
      await core.shutdown();
    }
  });
});

// The importer and a real core: what the node's own stores and repositories answer.
describe('verifyMigration against a real importer', () => {
  async function service() {
    const dataDir = tmp();
    process.env.KL_CASES_ROOT = path.join(dataDir, 'cases');
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
    const makeImporter = async () => new DesktopImporter({
      context: core.context,
      targets: await buildImportTargets({ context: core.context, dataDir }),
      dataDir,
      checkPath,
      scope: createDesktopScope({ dataDir, context: core.context }),
      hosting: 'personal'
    });
    const root = path.join(dataDir, 'cases');
    const invoke = async (channel) => {
      if (channel === 'chat:load') return { chats: core.context.listChats({ messages: false }), history: { available: true } };
      if (channel === 'case:list') return { ok: true, cases: new CaseStore({ root }).list() };
      throw new Error(`unexpected ${channel}`);
    };
    return { core, dataDir, root, importer: await makeImporter(), makeImporter, invoke };
  }

  const installId = 'install-0007';
  const chat = (id, n = 2) => ({
    id, title: `Chat ${id}`, createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
    messages: Array.from({ length: n }, (_, i) => ({ id: `${id}-m${i}`, sender: i % 2 ? 'assistant' : 'user', text: `line ${i}`, timestamp: '2026-09-20T10:00:00.000Z' }))
  });

  // A real case on the desktop, committed: every file of it, as the walker sends them.
  async function sourceCase() {
    const srcRoot = tmp();
    const runtime = new CaseRuntime({ root: srcRoot });
    const created = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot', force: true });
    const { dir } = runtime.getCase(created.id);
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n');
    await git.commitAll(dir, 'notes');
    const files = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(child);
        else files.push({ relPath: child, mode: 0o644, offset: 0, b64: fs.readFileSync(path.join(dir, child)).toString('base64') });
      }
    };
    walk('');
    return { name: path.basename(dir), dir, files };
  }
  const inventoryEntry = (name, files) => ({ dir: name, files: files.length, bytes: files.reduce((n, f) => n + Buffer.from(f.b64, 'base64').length, 0) });
  const inventoryOf = ({ chats = [], cases = [] }) => ({ installId, chats: chats.map((c) => ({ id: c.id, updatedAt: c.updatedAt, title: c.title })), cases, secrets: 'included' });
  const sourceFor = (chats) => ({ getValue: (cat, id) => (cat === 'chat' ? chats.find((c) => c.id === id) || null : null) });

  async function move(importer, { chats = [], cases = [], files = {}, declared = null }) {
    const inventory = inventoryOf({ chats, cases: declared || cases.map((c) => inventoryEntry(c, files[c])) });
    const plan = withSourceCounts(await importer.plan({ installId, inventory }), sourceFor(chats));
    const batch = [];
    for (const item of plan.items) {
      if (!['new', 'update', 'copy'].includes(item.action)) continue;
      if (item.category === 'chat') batch.push({ category: 'chat', key: item.key, value: chats.find((c) => c.id === item.key) });
      if (item.category === 'case') for (const f of files[item.key]) batch.push({ category: 'case', key: item.key, value: f });
    }
    if (batch.length) await importer.apply({ planId: plan.planId, batch });
    const report = { ...(await importer.finish({ planId: plan.planId })), skipped: [], sendFailures: [] };
    return { plan, report };
  }

  it('a real chat and a real case: verified, and the case reads as it did on the desktop (HEAD, clean tree)', async () => {
    const { importer, root, invoke } = await service();
    const src = await sourceCase();
    const headBefore = (await git.git(src.dir, ['rev-parse', 'HEAD'])).trim();
    const { plan, report } = await move(importer, { chats: [chat('c1', 3)], cases: [src.name], files: { [src.name]: src.files } });
    assert.deepStrictEqual(report.failures, []);
    assert.deepStrictEqual(report.incomplete, []);
    assert.deepStrictEqual(await verifyMigration({ plan, report, invoke }), { ok: true, checked: { chats: 1, cases: 1 } });
    const landed = path.join(root, src.name);
    assert.strictEqual((await git.git(landed, ['rev-parse', 'HEAD'])).trim(), headBefore);
    const dirty = (await git.git(landed, ['status', '--porcelain'])).trim();
    assert.strictEqual(dirty, '', 'the index was rebuilt from HEAD, so a clean case lands clean');
  });

  it('a case whose HEAD does not read (the commit object did not land) is incomplete, and a retry does not forgive it', async () => {
    const { importer, makeImporter, invoke, root } = await service();
    const src = await sourceCase();
    const head = (await git.git(src.dir, ['rev-parse', 'HEAD'])).trim();
    const objectPath = `.git/objects/${head.slice(0, 2)}/${head.slice(2)}`;
    const files = src.files.filter((f) => f.relPath !== objectPath);
    assert.notStrictEqual(files.length, src.files.length, 'the head commit was a loose object');
    const { plan, report } = await move(importer, { cases: [src.name], files: { [src.name]: files } });
    assert.ok(fs.existsSync(path.join(root, src.name)), 'it landed');
    assert.deepStrictEqual(report.incomplete.map((i) => i.key), [src.name]);
    assert.strictEqual((await verifyMigration({ plan, report, invoke })).ok, false);

    const retry = await move(await makeImporter(), { cases: [src.name], files: { [src.name]: files } });
    const item = retry.plan.items.find((i) => i.category === 'case');
    assert.strictEqual(item.action, 'needs-attention');
    assert.strictEqual(item.incomplete, true);
    const out = await verifyMigration({ ...retry, invoke });
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(out.missing.map((m) => m.key), [src.name]);
  });

  it('a case delivered short is incomplete, the retry stays unverified, and removing it on the node lets it land again', async () => {
    const { importer, makeImporter, invoke, root } = await service();
    const src = await sourceCase();
    const whole = inventoryEntry(src.name, src.files);
    const short = src.files.filter((f) => f.relPath !== 'notes.md');
    const first = await move(importer, { cases: [src.name], files: { [src.name]: short }, declared: [whole] });
    assert.deepStrictEqual(first.report.incomplete.map((i) => i.key), [src.name]);
    assert.strictEqual((await verifyMigration({ ...first, invoke })).ok, false);

    const second = await move(await makeImporter(), { cases: [src.name], files: { [src.name]: src.files }, declared: [whole] });
    assert.strictEqual((await verifyMigration({ ...second, invoke })).ok, false);

    fs.rmSync(path.join(root, src.name), { recursive: true, force: true });
    const third = await move(await makeImporter(), { cases: [src.name], files: { [src.name]: src.files }, declared: [whole] });
    assert.strictEqual(third.plan.items.find((i) => i.category === 'case').action, 'new');
    assert.strictEqual((await verifyMigration({ ...third, invoke })).ok, true);
  });

  it('a move cut off before finish, then a retry: no duplicate, and verified by what is really there', async () => {
    const { core, importer, makeImporter, invoke } = await service();
    const chats = [chat('c1', 2), chat('c2', 4)];
    const plan = await importer.plan({ installId, inventory: inventoryOf({ chats }) });
    // c1 lands; the node goes down before c2 and before finish, so no manifest.
    await importer.apply({ planId: plan.planId, batch: [{ category: 'chat', key: 'c1', value: chats[0] }] });

    const retry = await move(await makeImporter(), { chats });
    assert.strictEqual(retry.plan.items.find((i) => i.key === 'c1').action, 'skip-present');
    assert.strictEqual(retry.plan.items.find((i) => i.key === 'c2').action, 'new');
    assert.deepStrictEqual(await verifyMigration({ ...retry, invoke }), { ok: true, checked: { chats: 2, cases: 0 } });
    assert.strictEqual(core.context.listChats({ messages: false }).length, 2, 'no copy of c1');
  });

  it('a chat already on the node with fewer messages and the same stamp: skip-present, and still unverified', async () => {
    const { core, importer, invoke } = await service();
    core.context.upsertChat(chat('c1', 1));
    const retry = await move(importer, { chats: [chat('c1', 3)] });
    assert.strictEqual(retry.plan.items[0].action, 'skip-present');
    const out = await verifyMigration({ ...retry, invoke });
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(out.missing.map((m) => m.key), ['c1']);
  });
});
