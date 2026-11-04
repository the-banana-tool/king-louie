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
const { verifyMigration, withSourceFacts } = require('../src/migration/migration-verify');
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

  it('withSourceFacts puts the source\'s count on each chat item and leaves the rest alone', () => {
    const plan = { planId: 'p', counts: {}, items: [chatItem('c1', undefined), caseItem('lot')] };
    const out = withSourceFacts(plan, { getValue: (cat, id) => (cat === 'chat' && id === 'c1' ? { id, messages: [{}, {}] } : null) });
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
    seedChat(seeded, { id: 'secret-1', title: 'Private', messages: [{ sender: 'user', text: 'hush' }] });
    seeded.markPrivate('secret-1');
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
      assert.deepStrictEqual(planned.backup.history, { chats: 2, messages: 4 });
      assert.strictEqual(planned.plan.private.chats, 1);
      assert.strictEqual(planned.plan.items.find((i) => i.category === 'chat').action, 'new');
      assert.strictEqual(planned.plan.items.find((i) => i.category === 'case').action, 'new');
      assert.doesNotMatch(planned.staysBehind.join('\n'), /bot tokens stay|hooks spawn|MCP servers spawn/, 'a personal node carries these');

      const out = await controller.migrationApply({ confirmed: true });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      assert.deepStrictEqual(out.verified, { ok: true, checked: { chats: 2, cases: 1 } });

      assert.strictEqual(core.context.getChat('c1').messages.length, 3);
      assert.strictEqual(core.context.getHistoryStore().chatRef('secret-1').private, true);
      assert.strictEqual(core.context.getHistoryStore().chatRef('c1').private, false);
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
    const plan = withSourceFacts(await importer.plan({ installId, inventory }), sourceFor(chats));
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

// Controller ruling: a private chat stays private through the move.
describe('verifyMigration: the private mark', () => {
  it('a chat private on the desktop and not on the node is unverified, moved or skip-present', async () => {
    for (const action of ['new', 'update', 'skip-present']) {
      const item = chatItem('c1', 1, { action, private: true });
      const bare = await verifyMigration({ plan: { items: [item] }, report: cleanReport(), invoke: nodeAnswers({ chats: [{ id: 'c1', messageCount: 1 }] }).invoke });
      assert.strictEqual(bare.ok, false, action);
      assert.strictEqual(bare.code, 'MIGRATION_UNVERIFIED');
      assert.match(bare.missing[0].why, /private/);
      const marked = await verifyMigration({ plan: { items: [item] }, report: cleanReport(), invoke: nodeAnswers({ chats: [{ id: 'c1', messageCount: 1, private: true }] }).invoke });
      assert.strictEqual(marked.ok, true, action);
    }
  });

  it('a chat the desktop has as ordinary may be private on the node', async () => {
    const out = await verifyMigration({ plan: { items: [chatItem('c1', 1)] }, report: cleanReport(), invoke: nodeAnswers({ chats: [{ id: 'c1', messageCount: 1, private: true }] }).invoke });
    assert.strictEqual(out.ok, true);
  });

  it('a case private on the desktop and not on the node is unverified', async () => {
    const item = caseItem('lot', { private: true });
    assert.strictEqual((await verifyMigration({ plan: { items: [item] }, report: cleanReport(), invoke: nodeAnswers({ cases: [nodeCase('lot')] }).invoke })).ok, false);
    assert.strictEqual((await verifyMigration({ plan: { items: [item] }, report: cleanReport(), invoke: nodeAnswers({ cases: [{ ...nodeCase('lot'), private: true }] }).invoke })).ok, true);
  });

  it('withSourceFacts reads the mark and fails closed: a chat it cannot read counts as private', () => {
    const plan = { items: [chatItem('c1'), chatItem('c2'), chatItem('c3'), caseItem('lot'), caseItem('open')] };
    const source = {
      inventory: { cases: [{ dir: 'lot', private: true }, { dir: 'open' }] },
      getValue: (cat, id) => ({ c1: { id, messages: [{}] }, c2: { id, messages: [{}], private: true } }[id] || null)
    };
    const out = withSourceFacts(plan, source);
    assert.deepStrictEqual(out.items.map((i) => i.private === true), [false, true, true, true, false]);
    assert.strictEqual(out.private.chats, 2);
    assert.strictEqual(out.private.cases, 1);
    assert.match(out.private.note, /2 private chats and 1 private case/);
    assert.match(out.private.note, /PRIVATE_NO_LOCAL_MODEL/);
    assert.match(out.private.note, /admin service\.json/);
    assert.match(out.private.note, /localInference/);
  });

  it('with nothing private the plan says so, in numbers and no words', () => {
    const out = withSourceFacts({ items: [chatItem('c1')] }, { getValue: (_c, id) => ({ id, messages: [] }) });
    assert.deepStrictEqual(out.private, { chats: 0, cases: 0, note: null });
  });

  it('what will not move is not counted as moving', () => {
    const plan = { items: [caseItem('held', { action: 'needs-attention' })] };
    const out = withSourceFacts(plan, { inventory: { cases: [{ dir: 'held', private: true }] }, getValue: () => null });
    assert.strictEqual(out.private.cases, 0);
  });
});

describe('reading the mark from an old profile', () => {
  const { createSafeReader, readDesktopSource } = require('../src/migration/desktop-source');
  const { readHistoryChats } = require('../src/migration/desktop-history');
  const { downgradeToVersion1 } = require('./helpers/history-fixture');
  const { DatabaseSync } = require('node:sqlite');

  function profile(fill) {
    const root = tmp();
    const store = HistoryStore.open(path.join(root, 'history.sqlite'));
    fill(store);
    store.close();
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({ settings: {} }));
    return root;
  }
  const writeCase = (root, dir, yamlText) => {
    fs.mkdirSync(path.join(root, 'cases', dir), { recursive: true });
    if (yamlText !== null) fs.writeFileSync(path.join(root, 'cases', dir, 'case.yaml'), yamlText);
  };
  async function read(root) {
    const reader = createSafeReader({ root });
    const history = await readHistoryChats({ reader });
    return readDesktopSource({ userDataDir: root, reader, secrets: 'needs-desktop', history });
  }

  it('the store\'s mark reaches the chat, and an ordinary chat has no key', async () => {
    const root = profile((s) => { seedChat(s, { id: 'secret-1', messages: [] }); seedChat(s, { id: 'open-1', messages: [] }); s.markPrivate('secret-1'); });
    const source = await read(root);
    assert.strictEqual(source.getValue('chat', 'secret-1').private, true);
    assert.strictEqual('private' in source.getValue('chat', 'open-1'), false);
  });

  it('a store from before the column has no marks: no chat could have one, and the mark is one way', async () => {
    const root = profile((s) => { seedChat(s, { id: 'old-1', messages: [] }); });
    const db = new DatabaseSync(path.join(root, 'history.sqlite'));
    downgradeToVersion1(db);
    db.close();
    const source = await read(root);
    assert.strictEqual(source.getValue('chat', 'old-1').private, undefined);
  });

  it('a chat of a private case follows it; case.yaml says so on the inventory entry', async () => {
    const root = profile((s) => { seedChat(s, { id: 'in-case', caseId: 'case-a', messages: [] }); seedChat(s, { id: 'other', caseId: 'case-b', messages: [] }); });
    writeCase(root, 'alpha', 'id: case-a\nslug: alpha\ntitle: Alpha\nprivate: true\n');
    writeCase(root, 'beta', 'id: case-b\nslug: beta\ntitle: Beta\nprivate: false\n');
    const source = await read(root);
    assert.strictEqual(source.getValue('chat', 'in-case').private, true);
    assert.strictEqual('private' in source.getValue('chat', 'other'), false);
    assert.strictEqual(source.inventory.cases.find((c) => c.dir === 'alpha').private, true);
    assert.strictEqual('private' in source.inventory.cases.find((c) => c.dir === 'beta'), false);
  });

  it('a case with a marked chat and no key is private; a private: that is not a boolean is private', async () => {
    const root = profile((s) => { seedChat(s, { id: 'marked', caseId: 'case-a', messages: [] }); s.markPrivate('marked'); });
    writeCase(root, 'alpha', 'id: case-a\nslug: alpha\ntitle: Alpha\n');
    writeCase(root, 'beta', 'id: case-b\nslug: beta\ntitle: Beta\nprivate: "yes"\n');
    const source = await read(root);
    assert.strictEqual(source.inventory.cases.find((c) => c.dir === 'alpha').private, true);
    assert.strictEqual(source.inventory.cases.find((c) => c.dir === 'beta').private, true);
  });

  it('a case.yaml that cannot be read is private, and so is a chat naming a case nothing can vouch for', async () => {
    const root = profile((s) => { seedChat(s, { id: 'lost', caseId: 'case-x', messages: [] }); seedChat(s, { id: 'free', messages: [] }); });
    writeCase(root, 'broken', 'id: [unclosed\n');
    const source = await read(root);
    assert.strictEqual(source.inventory.cases.find((c) => c.dir === 'broken').private, true);
    assert.strictEqual(source.getValue('chat', 'lost').private, true);
    assert.strictEqual('private' in source.getValue('chat', 'free'), false);
  });

  it('a case\'s HEAD is read from its own files: a ref, or packed', async () => {
    const root = profile(() => {});
    const sha = 'a'.repeat(40);
    writeCase(root, 'loose', 'id: case-a\nslug: loose\ntitle: A\n');
    fs.mkdirSync(path.join(root, 'cases', 'loose', '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cases', 'loose', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(root, 'cases', 'loose', '.git', 'refs', 'heads', 'main'), `${sha}\n`);
    writeCase(root, 'packed', 'id: case-b\nslug: packed\ntitle: B\n');
    fs.mkdirSync(path.join(root, 'cases', 'packed', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cases', 'packed', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(root, 'cases', 'packed', '.git', 'packed-refs'), `# pack-refs\n${'b'.repeat(40)} refs/heads/main\n`);
    writeCase(root, 'bare', 'id: case-c\nslug: bare\ntitle: C\n');
    const { inventory } = await read(root);
    assert.strictEqual(inventory.cases.find((c) => c.dir === 'loose').head, sha);
    assert.strictEqual(inventory.cases.find((c) => c.dir === 'packed').head, 'b'.repeat(40));
    assert.strictEqual(inventory.cases.find((c) => c.dir === 'bare').head, null);
  });
});

describe('landing a private chat and case on the node', () => {
  const { startEmbedIndexer } = require('../src/history/embed-indexer');
  const { readDb } = require('./helpers/history-fixture');

  async function node({ hosting = 'personal' } = {}) {
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
    const importer = async () => new DesktopImporter({
      context: core.context, targets: await buildImportTargets({ context: core.context, dataDir }), dataDir, checkPath,
      scope: createDesktopScope({ dataDir, context: core.context }), hosting
    });
    const root = path.join(dataDir, 'cases');
    const refOf = (c) => ({ ...c, ...(core.context.getHistoryStore().chatRef(c.id)?.private === true ? { private: true } : {}) });
    const invoke = async (channel) => {
      if (channel === 'chat:load') return { ok: true, data: { chats: core.context.listChats({ messages: false }).map(refOf), history: { available: true } } };
      if (channel === 'case:list') return { ok: true, cases: new CaseStore({ root }).list() };
      throw new Error(`unexpected ${channel}`);
    };
    return { core, dataDir, root, importer, invoke, store: core.context.getHistoryStore() };
  }
  const privateChat = (id, n = 2, text = 'the private matter') => ({
    id, title: id, private: true, createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
    messages: Array.from({ length: n }, (_, i) => ({ id: `${id}-m${i}`, sender: 'user', text: `${text} ${i}`, timestamp: '2026-09-20T10:00:00.000Z' }))
  });
  const land = async (imp, chats) => {
    const inventory = { installId: 'install-0009', chats: chats.map((c) => ({ id: c.id, updatedAt: c.updatedAt, title: c.title })), cases: [], secrets: 'included' };
    const plan = await imp.plan({ installId: 'install-0009', inventory });
    await imp.apply({ planId: plan.planId, batch: chats.map((c) => ({ category: 'chat', key: c.id, value: c })) });
    return { plan: withSourceFacts(plan, { getValue: (_cat, id) => chats.find((c) => c.id === id) || null }), report: { ...(await imp.finish({ planId: plan.planId })), skipped: [], sendFailures: [] } };
  };

  for (const hosting of ['personal', 'service']) {
    it(`a private chat lands marked, through markPrivate (${hosting} hosting): verified`, async () => {
      const n = await node({ hosting });
      const calls = [];
      const real = n.store.markPrivate.bind(n.store);
      n.store.markPrivate = (id) => { calls.push(id); return real(id); };
      try {
        const moved = await land(await n.importer(), [privateChat('secret-1')]);
        assert.deepStrictEqual(moved.report.failures, []);
        assert.deepStrictEqual(calls, ['secret-1']);
        assert.strictEqual(n.store.chatRef('secret-1').private, true);
        assert.strictEqual(n.core.context.getChat('secret-1').messages.length, 2);
        assert.strictEqual((await verifyMigration({ ...moved, invoke: n.invoke })).ok, true);
      } finally {
        n.store.markPrivate = real;
      }
    });
  }

  it('the landing and the mark are one transaction: another connection never sees the chat unmarked', async () => {
    const n = await node();
    const real = n.store.markPrivate.bind(n.store);
    const file = path.join(n.dataDir, 'history.sqlite');
    const seenAtMark = [];
    n.store.markPrivate = (id) => {
      const other = readDb(file);
      seenAtMark.push(other.prepare('SELECT COUNT(*) AS n FROM chats WHERE id = ?').get(id).n);
      other.close();
      return real(id);
    };
    try {
      await land(await n.importer(), [privateChat('secret-1')]);
    } finally {
      n.store.markPrivate = real;
    }
    assert.deepStrictEqual(seenAtMark, [0], 'the row is not committed when the mark is written');
    const after = readDb(file);
    assert.strictEqual(Number(after.prepare('SELECT private FROM chats WHERE id = ?').get('secret-1').private), 1);
    after.close();
  });

  it('a hosted embedder running through the landing gets no chunk of a private chat', async () => {
    const n = await node();
    const texts = [];
    const hosted = { name: 'openai:fake', kind: 'openai', model: 'fake', dim: 4, tokens: 0, async embed(batch) { texts.push(...batch); return batch.map(() => Float32Array.from([1, 0, 0, 0])); } };
    const host = { active: hosted, current() { return this.active; }, fail() {}, keepLocalKey: () => null, ensureKeepLocal: () => null };
    const indexer = startEmbedIndexer({ store: n.store, host, getSettings: () => ({ history: { embedder: { batchSize: 8 } } }), setTimer: () => 1, clearTimer: () => {}, log: { warn() {}, info() {}, debug() {} } });
    try {
      const open = { ...privateChat('open-1', 1, 'the ordinary matter') };
      delete open.private;
      const imp = await n.importer();
      await indexer.tick();
      const moved = land(imp, [privateChat('secret-1'), open]);
      await indexer.tick();
      await moved;
      for (let i = 0; i < 3; i += 1) await indexer.tick();
      assert.ok(texts.some((t) => t.includes('ordinary')), 'the indexer ran over what landed');
      assert.deepStrictEqual(texts.filter((t) => t.includes('private matter')), []);
      assert.deepStrictEqual(n.store.pendingEmbeddings('openai:fake').filter((r) => String(r.text).includes('private matter')), []);
    } finally {
      await indexer.stop();
    }
  });

  it('a chat that cannot be marked does not land, and is a failure', async () => {
    const n = await node();
    const real = n.store.markPrivate.bind(n.store);
    n.store.markPrivate = () => { throw new Error('the mark could not be written'); };
    let moved;
    try {
      moved = await land(await n.importer(), [privateChat('secret-1')]);
    } finally {
      n.store.markPrivate = real;
    }
    assert.strictEqual(n.core.context.getChat('secret-1', { messages: false }), null);
    assert.deepStrictEqual(moved.report.failures.map((f) => f.key), ['secret-1']);
    assert.strictEqual((await verifyMigration({ ...moved, invoke: n.invoke })).ok, false);
  });

  it('an update of a chat that cannot be marked leaves the node\'s copy as it was', async () => {
    const n = await node();
    const first = privateChat('secret-1', 1);
    delete first.private;
    await land(await n.importer(), [first]);
    const real = n.store.markPrivate.bind(n.store);
    n.store.markPrivate = () => { throw new Error('no'); };
    try {
      await land(await n.importer(), [{ ...privateChat('secret-1', 4), updatedAt: '2026-09-21T10:00:00.000Z' }]);
    } finally {
      n.store.markPrivate = real;
    }
    assert.strictEqual(n.core.context.getChat('secret-1').messages.length, 1);
  });

  async function sourceCase({ asPrivate = false, chop = false } = {}) {
    const runtime = new CaseRuntime({ root: tmp() });
    const made = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot', force: true, private: asPrivate });
    const { dir, id } = runtime.getCase(made.id);
    if (chop) {
      const text = fs.readFileSync(path.join(dir, 'case.yaml'), 'utf8').replace(/^private:.*\n/m, '');
      fs.writeFileSync(path.join(dir, 'case.yaml'), text);
      await git.commitAll(dir, 'lost the key');
    }
    const files = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(child);
        else files.push({ relPath: child, mode: 0o644, offset: 0, b64: fs.readFileSync(path.join(dir, child)).toString('base64') });
      }
    };
    walk('');
    return { dir, id, name: path.basename(dir), files, head: (await git.git(dir, ['rev-parse', 'HEAD'])).trim() };
  }
  const entry = (src, extra = {}) => ({ dir: src.name, head: src.head, files: src.files.length, bytes: src.files.reduce((a, f) => a + Buffer.from(f.b64, 'base64').length, 0), ...extra });
  async function landCase(imp, src, { extra = {}, chats = [] } = {}) {
    const inventory = { installId: 'install-0009', chats: chats.map((c) => ({ id: c.id, updatedAt: c.updatedAt, title: c.title })), cases: [entry(src, extra)], secrets: 'included' };
    const plan = await imp.plan({ installId: 'install-0009', inventory });
    const batch = chats.map((c) => ({ category: 'chat', key: c.id, value: c }));
    if (plan.items.find((i) => i.category === 'case').action === 'new') for (const f of src.files) batch.push({ category: 'case', key: src.name, value: f });
    if (batch.length) await imp.apply({ planId: plan.planId, batch });
    return {
      plan: withSourceFacts(plan, { inventory, getValue: (_c, id) => chats.find((c) => c.id === id) || null }),
      report: { ...(await imp.finish({ planId: plan.planId })), skipped: [], sendFailures: [] }
    };
  }

  it('a private case travels with its case.yaml and verifies; its chat lands private', async () => {
    const n = await node();
    const src = await sourceCase({ asPrivate: true });
    const moved = await landCase(await n.importer(), src, { extra: { private: true }, chats: [{ ...privateChat('in-case'), caseId: src.id }] });
    assert.deepStrictEqual(moved.report.incomplete, []);
    assert.strictEqual(n.store.chatRef('in-case').private, true);
    assert.strictEqual(new CaseStore({ root: n.root }).list()[0].private, true);
    assert.strictEqual((await verifyMigration({ ...moved, invoke: n.invoke })).ok, true);
  });

  it('a private case whose case.yaml lost the key is marked on landing', async () => {
    const n = await node();
    const src = await sourceCase({ asPrivate: true, chop: true });
    const moved = await landCase(await n.importer(), src, { extra: { private: true }, chats: [{ ...privateChat('in-case'), caseId: src.id }] });
    assert.strictEqual(new CaseStore({ root: n.root }).list()[0].private, true);
    assert.deepStrictEqual(moved.report.incomplete, []);
    assert.strictEqual((await verifyMigration({ ...moved, invoke: n.invoke })).ok, true);
  });

  // Concern 2: the landing is on disk, the manifest never written.
  const forgetManifest = (n) => fs.rmSync(path.join(n.dataDir, 'imports'), { recursive: true, force: true });

  it('a retry recognises a case landed with no record, by HEAD and a clean tree', async () => {
    const n = await node();
    const src = await sourceCase();
    await landCase(await n.importer(), src);
    forgetManifest(n);
    const retry = await landCase(await n.importer(), src);
    const item = retry.plan.items.find((i) => i.category === 'case');
    assert.strictEqual(item.action, 'skip-present');
    assert.strictEqual((await verifyMigration({ ...retry, invoke: n.invoke })).ok, true);
  });

  it('a retry recognises one the node has gone on from: the source\'s HEAD is in its history', async () => {
    const n = await node();
    const src = await sourceCase();
    await landCase(await n.importer(), src);
    forgetManifest(n);
    const landed = path.join(n.root, src.name);
    fs.writeFileSync(path.join(landed, 'later.md'), 'later\n');
    await git.commitAll(landed, 'went on');
    const retry = await landCase(await n.importer(), src);
    assert.strictEqual(retry.plan.items.find((i) => i.category === 'case').action, 'skip-present');
  });

  for (const [what, spoil] of [
    ['a dirty tree', (dir) => fs.writeFileSync(path.join(dir, 'brief.md'), 'changed\n')],
    ['a file gone', (dir) => fs.rmSync(path.join(dir, 'brief.md'))],
    ['another history', async (dir) => { fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true }); await git.initRepo(dir); await git.commitAll(dir, 'another'); }],
    ['no repository', (dir) => fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true })]
  ]) {
    it(`a retry does not forgive a case that does not match: ${what}`, async () => {
      const n = await node();
      const src = await sourceCase();
      await landCase(await n.importer(), src);
      forgetManifest(n);
      await spoil(path.join(n.root, src.name));
      const retry = await landCase(await n.importer(), src);
      const item = retry.plan.items.find((i) => i.category === 'case');
      assert.strictEqual(item.action, 'needs-attention');
      assert.strictEqual(item.incomplete, true);
      const out = await verifyMigration({ ...retry, invoke: n.invoke });
      assert.strictEqual(out.code, 'MIGRATION_UNVERIFIED');
      assert.deepStrictEqual(out.missing.map((m) => m.key), [src.name]);
    });
  }

  it('a fleet import keeps today\'s plain needs-attention for a directory already there', async () => {
    const n = await node({ hosting: 'service' });
    const src = await sourceCase();
    await landCase(await n.importer(), src);
    forgetManifest(n);
    const retry = await landCase(await n.importer(), src);
    const item = retry.plan.items.find((i) => i.category === 'case');
    assert.strictEqual(item.action, 'needs-attention');
    assert.strictEqual('incomplete' in item, false);
  });
});
