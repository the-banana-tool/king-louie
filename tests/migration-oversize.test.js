// tests/migration-oversize.test.js — a chat too big for one import entry
// (attach stage 2 final review, finding 1): its messages go over several entries,
// the node assembles them under the plan and lands them in one transaction.
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
const { planBatches, readDesktopSource, createSafeReader } = require('../src/migration/desktop-source');
const { loadDesktopSource } = require('../src/ipc/desktop-export');
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-oversize-')); dirs.push(d); return d; };

const MIB = 1024 * 1024;
const attachment = (bytes, fill = 'a') => ({ name: 'screenshot.png', mimeType: 'image/png', base64: Buffer.alloc(bytes, fill).toString('base64') });

async function realBridge({ seed, sourceOptions = {} }, run) {
  const root = tmp();
  const dataDir = path.join(root, 'node', 'data');
  const configDir = path.join(root, 'node', 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  process.env.KL_CASES_ROOT = path.join(dataDir, 'cases');
  fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: laptop-01\nprofile: agent\nhosting: personal\n');
  const adminUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const host = createDesktopBridgeHost({ dataDir, configDir, features: { desktopBridge: true }, ports: { desktopBridge: 0 }, adminUid, version: '26.9.0' });
  const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
  const core = createCore({
    ...servicePorts, ...host.coreDeps,
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    remoteApprovals: 'deny', workingDirectory: dataDir, builtinSkillsDir: path.join(__dirname, '..', 'skills')
  });
  await core.start();
  const userDataDir = path.join(root, 'profile', 'king-louie');
  fs.mkdirSync(userDataDir, { recursive: true });
  const seeded = HistoryStore.open(path.join(userDataDir, 'history.sqlite'));
  seed(seeded);
  seeded.close();
  fs.writeFileSync(path.join(userDataDir, 'chat-data.json'), JSON.stringify({ settings: {} }));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() };
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory: ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults }) });
  let client = null;
  let controller = null;
  try {
    const server = await host.start({ core, ports: servicePorts, approvals: null });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = keys.rawFromPublicKeyObject(publicKey);
    const deviceId = keys.deriveDeviceId(raw, 'kld-');
    pairing.writeFileAtomic(path.join(configDir, 'desktop-devices.json'), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), { deviceId, publicKey: keys.toB64url(raw), label: 'laptop-01 desk', pairedAt: '2026-11-04T09:00:00Z' })), 0o644);
    client = new DesktopBridgeClient({ port: server.port, pin: { nodeId: server.identity.nodeId, publicKey: server.identity.publicKey.toString('hex') }, deviceId, sign: async (bytes) => crypto.sign(null, bytes, privateKey) });
    await client.connect();
    state.setMode('attached');
    state.setPairing({ deviceId, publicKey: 'x', privateKeySealed: 'y', label: 'desk', service: { nodeId: server.identity.nodeId, publicKey: server.identity.publicKey.toString('hex'), port: server.port, hosting: 'personal', dataDir, name: 'laptop-01' } });
    controller = createDesktopController({
      state, mode: 'attached', app: { relaunch() {}, exit() {}, quit() {}, getVersion: () => '26.9.0' }, env: {}, platform: 'linux', userDataDir, safeStorage,
      stdout: { write() {} }, argv: ['electron', '.'], username: 'alex', launch: { host: 'attached', why: 'attached', degraded: false }, nodeRunner: null,
      migrationDeps: { loadDesktopSource: (args) => loadDesktopSource({ ...args, ...sourceOptions }) }
    });
    controller.setClient(client);
    await run({ controller, core, state, dataDir });
  } finally {
    if (controller) controller.dispose();
    if (client) client.close();
    await host.stop();
    await core.shutdown();
  }
}

describe('a big chat over a real bridge', () => {
  it('a chat with 5 MB of attachments moves and verifies, in order, whole', async () => {
    const messages = [
      { sender: 'user', text: 'first', attachments: [attachment(MIB, 'a')] },
      { sender: 'assistant', text: 'second' },
      { sender: 'user', text: 'third', attachments: [attachment(3 * MIB, 'b')] },
      { sender: 'assistant', text: 'fourth' },
      { sender: 'user', text: 'fifth', attachments: [attachment(MIB, 'c')] },
      { sender: 'assistant', text: 'sixth' }
    ];
    await realBridge({
      seed: (store) => {
        seedChat(store, { id: 'big', title: 'Lakeside photos', messages });
        seedChat(store, { id: 'small', title: 'Small', messages: [{ sender: 'user', text: 'hello' }] });
      }
    }, async ({ controller, core, state }) => {
      const planned = await controller.migrationPlan();
      assert.strictEqual(planned.ok, true, JSON.stringify(planned));
      assert.strictEqual(planned.plan.items.find((i) => i.key === 'big').action, 'new');
      const out = await controller.migrationApply({ confirmed: true });
      assert.strictEqual(out.ok, true, JSON.stringify(out.verified || out));
      assert.deepStrictEqual(out.verified, { ok: true, checked: { chats: 2, cases: 0 } });
      assert.ok(state.migration, 'the mark is written');
      const chat = core.context.getChat('big');
      assert.deepStrictEqual(chat.messages.map((m) => m.text), messages.map((m) => m.text));
      assert.deepStrictEqual(chat.messages.map((m) => m.seq), [1, 2, 3, 4, 5, 6]);
      assert.strictEqual(chat.messages[2].attachments[0].base64, messages[2].attachments[0].base64);
      assert.strictEqual(chat.title, 'Lakeside photos');
    });
  });

  it('one message past what a frame can carry: named with its size before the press, the rest lands, the mark is not blocked', async () => {
    await realBridge({
      sourceOptions: { maxMessageBytes: 2 * MIB },
      seed: (store) => {
        seedChat(store, { id: 'huge', title: 'Survey scans', messages: [{ sender: 'user', text: 'before' }, { sender: 'user', text: 'the big one', attachments: [attachment(3 * MIB)] }, { sender: 'assistant', text: 'after' }] });
      }
    }, async ({ controller, core, state, dataDir }) => {
      const planned = await controller.migrationPlan();
      assert.strictEqual(planned.ok, true, JSON.stringify(planned));
      const item = planned.plan.items.find((i) => i.key === 'huge');
      assert.strictEqual(item.action, 'needs-attention');
      assert.match(item.note, /Survey scans/);
      assert.match(item.note, /4\.0 MB/);
      assert.match(planned.staysBehind.join('\n'), /Survey scans/, 'and in Stays on this computer');
      assert.ok(planned.leftBehind.needsAttention.some((a) => a.key === 'huge'), 'and in what the owner reads');
      const out = await controller.migrationApply({ confirmed: true });
      assert.strictEqual(out.ok, true, JSON.stringify(out.verified || out));
      assert.ok(state.migration, 'the owner has read the line: the mark goes on');
      const chat = core.context.getChat('huge');
      assert.deepStrictEqual(chat.messages.map((m) => m.seq), [1, 2, 3], 'order and seq stay');
      assert.strictEqual(chat.messages[0].text, 'before');
      assert.strictEqual(chat.messages[2].text, 'after');
      assert.match(chat.messages[1].text, /too large/i);
      assert.ok(!chat.messages[1].attachments || chat.messages[1].attachments.length === 0);
      const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'imports', fs.readdirSync(path.join(dataDir, 'imports'))[0]), 'utf8'));
      assert.strictEqual(manifest.items['chat:huge'].incomplete, true, 'it lands without being marked complete');
    });
  });
});

describe('the importer assembles a chat', () => {
  async function service({ hosting = 'personal' } = {}) {
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
    const importer = new DesktopImporter({ context: core.context, targets: await buildImportTargets({ context: core.context, dataDir }), dataDir, checkPath, scope: createDesktopScope({ dataDir, context: core.context }), hosting });
    return { core, importer, dataDir };
  }
  const chat = (over = {}) => ({
    id: 'c1', title: 'Parts', createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
    messages: Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, sender: i % 2 ? 'assistant' : 'user', text: `line ${i} ${'x'.repeat(600)}`, timestamp: '2026-09-20T10:00:00.000Z' })),
    ...over
  });
  const source = (c) => ({ getValue: (cat, id) => (cat === 'chat' && id === c.id ? c : null), caseFiles: () => [] });
  const inventory = (c) => ({ chats: [{ id: c.id, updatedAt: c.updatedAt, title: c.title }], cases: [], secrets: 'included' });
  const entriesOf = (plan, c) => [...planBatches(plan.items, source(c), { maxBytes: 1200, chatParts: plan.chatParts === true })].flat();

  it('a plan on a personal node says it takes parts; a fleet plan does not', async () => {
    const personal = await service();
    assert.strictEqual((await personal.importer.plan({ installId: 'i-1', inventory: inventory(chat()) })).chatParts, true);
    const fleet = await service({ hosting: 'service' });
    assert.ok(!('chatParts' in (await fleet.importer.plan({ installId: 'i-1', inventory: inventory(chat()) }))));
  });

  it('a cut-off mid-chat leaves nothing landed, and the next plan offers it again', async () => {
    const { core, importer } = await service();
    const c = chat();
    const plan = await importer.plan({ installId: 'i-1', inventory: inventory(c) });
    const entries = entriesOf(plan, c);
    assert.ok(entries.length >= 2, 'it went in parts');
    await importer.apply({ planId: plan.planId, batch: [entries[0]] });
    assert.ok(!core.context.getChat('c1'), 'nothing lands before the last part');
    const report = await importer.finish({ planId: plan.planId });
    assert.deepStrictEqual(report.failures.map((f) => f.key), ['c1']);
    assert.ok(!core.context.getChat('c1'));
    assert.strictEqual((await importer.plan({ installId: 'i-1', inventory: inventory(c) })).items.find((i) => i.key === 'c1').action, 'new');
  });

  it('parts out of order are refused, and nothing lands', async () => {
    const { core, importer } = await service();
    const c = chat();
    const plan = await importer.plan({ installId: 'i-1', inventory: inventory(c) });
    const entries = entriesOf(plan, c);
    const answer = await importer.apply({ planId: plan.planId, batch: [entries[1]] });
    assert.strictEqual(answer.results[0].ok, false);
    assert.ok(!core.context.getChat('c1'));
  });

  it('a private chat in parts lands with its mark, in order', async () => {
    const { core, importer } = await service();
    const c = chat({ private: true });
    const plan = await importer.plan({ installId: 'i-1', inventory: inventory(c) });
    for (const entry of entriesOf(plan, c)) await importer.apply({ planId: plan.planId, batch: [entry] });
    const report = await importer.finish({ planId: plan.planId });
    assert.deepStrictEqual(report.failures, []);
    assert.strictEqual(core.context.getHistoryStore().chatRef('c1').private, true);
    assert.deepStrictEqual(core.context.getChat('c1').messages.map((m) => m.id), ['m0', 'm1', 'm2', 'm3']);
  });

  it('a private chat whose mark cannot be written does not land at all', async () => {
    const { core, importer } = await service();
    const c = chat({ private: true });
    const store = core.context.getHistoryStore();
    const markPrivate = store.markPrivate;
    store.markPrivate = () => { throw new Error('the mark failed'); };
    try {
      const plan = await importer.plan({ installId: 'i-1', inventory: inventory(c) });
      const answers = [];
      for (const entry of entriesOf(plan, c)) answers.push(...(await importer.apply({ planId: plan.planId, batch: [entry] })).results);
      assert.strictEqual(answers[answers.length - 1].ok, false);
      assert.ok(!core.context.getChat('c1'));
    } finally {
      store.markPrivate = markPrivate;
    }
  });

  it('a fleet importer refuses parts, and a fleet send still skips an oversize chat', async () => {
    const { importer } = await service({ hosting: 'service' });
    const c = chat();
    const plan = await importer.plan({ installId: 'i-1', inventory: inventory(c) });
    const skipped = [];
    assert.deepStrictEqual([...planBatches(plan.items, source(c), { maxBytes: 1200, skipped })], []);
    assert.match(skipped[0].error, /batch limit/);
    const answer = await importer.apply({ planId: plan.planId, batch: [{ category: 'chat', key: 'c1', value: { id: 'c1', messages: [], chatPart: { index: 0, total: 2 } } }] });
    assert.strictEqual(answer.results[0].ok, false);
  });
});

describe('the source says which chat has a message too large', () => {
  it('names the chat and its size only past the limit', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({ settings: {}, chats: [
      { id: 'ok', title: 'Fine', updatedAt: 'a', messages: [{ sender: 'user', text: 'x'.repeat(100) }] },
      { id: 'big', title: 'Big', updatedAt: 'a', messages: [{ sender: 'user', text: 'x'.repeat(5000) }] }
    ] }));
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), maxMessageBytes: 1000 });
    const byId = Object.fromEntries(source.inventory.chats.map((c) => [c.id, c]));
    assert.ok(!('tooLargeBytes' in byId.ok), 'an ordinary chat is as it was');
    assert.ok(byId.big.tooLargeBytes > 5000);
  });
});
