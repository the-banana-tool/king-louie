// tests/migration-vault-keys.test.js — a vault key with a dot in it, through the
// move (attach stage 2 §6.5). Both stores split a key at each dot, so
// browser_cred:<profile>:<host.tld> sits nested on disk, and it has to read
// whole on the desktop and land where the node's own browser tools look. Reading
// keys whole must not move what never moved: `contact.` and `local.` stay behind.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createVault } = require('../src/platform/vault');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { checkPath } = require('../src/desktop-bridge/check-path');
const { DesktopImporter, buildImportTargets } = require('../src/migration/desktop-import');
const { createSafeReader, readDesktopSource, planBatches, setAsideUnreadableSecrets } = require('../src/migration/desktop-source');
const { verifyMigration } = require('../src/migration/migration-verify');
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
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vaultkeys-'))); dirs.push(d); return d; };

const LOGIN = 'browser_cred:king-louie:login.example.com';
const LOGIN_VALUE = JSON.stringify({ username: 'owner@example.com', password: 'not-a-real-password' });
const desktopCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => `ENC:${s}`,
  decryptString: (s) => {
    if (typeof s !== 'string' || !s.startsWith('ENC:')) throw new Error('will not decrypt');
    return s.slice(4);
  }
};

// The desktop's config.json as electron-store writes it: through conf, the
// library electron-store wraps, so the nesting is the real one.
async function desktopConfig(secrets, extra = {}) {
  const userDataDir = tmp();
  const { default: Conf } = await import('conf');
  const conf = new Conf({ cwd: userDataDir, configName: 'config', projectName: 'kl-test' });
  const vault = createVault({ store: conf, cipher: desktopCipher });
  for (const [key, value] of Object.entries(secrets)) vault.set(key, value);
  const file = path.join(userDataDir, 'config.json');
  const written = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({ ...written, ...extra }));
  fs.writeFileSync(path.join(userDataDir, 'chat-data.json'), JSON.stringify({ settings: {} }));
  return userDataDir;
}
const readSource = (userDataDir) => readDesktopSource({
  userDataDir,
  reader: createSafeReader({ root: userDataDir }),
  decrypt: (encrypted) => desktopCipher.decryptString(encrypted)
});

async function nodeService({ hosting = 'personal' } = {}) {
  const dataDir = tmp();
  process.env.KL_CASES_ROOT = path.join(dataDir, 'cases');
  const masterKey = crypto.randomBytes(32);
  const cipher = createAesGcmCipher(masterKey);
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher,
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
  });
  cores.push(core);
  await core.start();
  const importer = new DesktopImporter({
    context: core.context,
    targets: await buildImportTargets({ context: core.context, dataDir }),
    dataDir,
    checkPath,
    cipher,
    scope: createDesktopScope({ dataDir, context: core.context }),
    hosting
  });
  return { core, dataDir, cipher, importer };
}

async function moveAll(importer, source) {
  const plan = await importer.plan({ installId: source.installId, inventory: source.inventory });
  const skipped = [];
  const sent = [];
  for (const batch of planBatches(plan.items, source, { skipped })) {
    sent.push(...batch);
    await importer.apply({ planId: plan.planId, batch });
  }
  const report = { ...(await importer.finish({ planId: plan.planId })), skipped, sendFailures: [] };
  return { plan, report, sent };
}
const itemOf = (plan, key) => plan.items.find((i) => i.category === 'vault' && i.key === key);

describe('reading the desktop vault', () => {
  it('nests a dotted key on disk, so a flat read could never have found it', async () => {
    const config = JSON.parse(fs.readFileSync(path.join(await desktopConfig({ [LOGIN]: LOGIN_VALUE }), 'config.json'), 'utf8'));
    assert.strictEqual(config[`__vault_${LOGIN}`], undefined);
    assert.strictEqual(config['__vault_browser_cred:king-louie:login'].example.com, `ENC:${LOGIN_VALUE}`);
  });

  it('lists a dotted key whole and reads its value by the whole key', async () => {
    const source = readSource(await desktopConfig({ [LOGIN]: LOGIN_VALUE, github: 'plain-github', 'browser_cred:king-louie:shop.example.org': 'second' }));
    assert.deepStrictEqual([...source.inventory.vault].sort(), [LOGIN, 'browser_cred:king-louie:shop.example.org', 'github'].sort());
    assert.strictEqual(source.getValue('vault', LOGIN), LOGIN_VALUE);
    assert.strictEqual(source.getValue('vault', 'github'), 'plain-github');
    assert.strictEqual(source.getValue('vault', 'browser_cred:king-louie:login'), null, 'the truncated name is no key');
  });

  it('a key stored flat still reads, as before', async () => {
    const source = readSource(await desktopConfig({}, { '__vault_flat.name': 'ENC:value' }));
    assert.deepStrictEqual(source.inventory.vault, ['flat.name']);
    assert.strictEqual(source.getValue('vault', 'flat.name'), 'value');
  });

  it('takes nothing from a prototype key, at any level', async () => {
    const dir = await desktopConfig({ github: 'x' });
    const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8').replace(/^\{/, '{"__vault_proto":{"__proto__":{"polluted":"ENC:a"},"constructor":{"prototype":{"polluted":"ENC:b"}},"prototype":"ENC:c","fine":"ENC:d"},"__vault___proto__":"ENC:e",');
    fs.writeFileSync(path.join(dir, 'config.json'), raw);
    const source = readSource(dir);
    assert.deepStrictEqual([...source.inventory.vault].sort(), ['github', 'proto.fine']);
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(source.getValue('vault', '__proto__'), null);
    assert.strictEqual(source.getValue('vault', 'constructor'), null);
    assert.strictEqual(source.getValue('vault', 'proto.__proto__.polluted'), null);
    const said = source.attention.filter((a) => a.category === 'vault').map((a) => a.key);
    assert.ok(said.length >= 1, 'what was not read is said');
  });

  it('says what it cannot read in a stored entry, rather than dropping it unsaid', async () => {
    const source = readSource(await desktopConfig({}, { __vault_odd: { list: ['ENC:a'], count: 3, fine: 'ENC:b' } }));
    assert.deepStrictEqual(source.inventory.vault, ['odd.fine']);
    assert.deepStrictEqual(source.attention.filter((a) => a.category === 'vault').map((a) => a.key).sort(), ['odd.count', 'odd.list']);
  });

  it('a login that will not decrypt is named by its whole key, and readable logins are not a wrong environment', async () => {
    const source = readSource(await desktopConfig({
      'browser_cred:king-louie:a.example.com': 'one',
      'browser_cred:king-louie:b.example.com': 'two',
      'browser_cred:king-louie:c.example.com': 'three'
    }, { '__vault_browser_cred:king-louie:d': { example: { com: 'sealed-by-another-account' } } }));
    const keys = setAsideUnreadableSecrets(source);
    assert.strictEqual(keys.total, 4);
    assert.deepStrictEqual(keys.unreadable, [{ category: 'vault', key: 'browser_cred:king-louie:d.example.com' }]);
    assert.ok(!source.inventory.vault.includes('browser_cred:king-louie:d.example.com'));
    assert.strictEqual(source.inventory.vault.length, 3);
  });
});

describe('a dotted key landing on a node', () => {
  it('round trips through the real write and the real read, where the browser tools look', async () => {
    const source = readSource(await desktopConfig({ [LOGIN]: LOGIN_VALUE, github: 'plain-github' }));
    const { core, dataDir, cipher, importer } = await nodeService();
    assert.strictEqual(setAsideUnreadableSecrets(source).unreadable.length, 0);
    const { plan, report } = await moveAll(importer, source);
    assert.strictEqual(itemOf(plan, LOGIN).action, 'new');
    assert.deepStrictEqual(report.failures, []);
    assert.deepStrictEqual(report.skipped, []);
    // The tools' vault, then a reader that only has what is on disk.
    assert.deepStrictEqual(JSON.parse(core.context.vault.get(LOGIN)), JSON.parse(LOGIN_VALUE));
    const fresh = createVault({ store: new JsonFileStore({ dir: dataDir, name: 'config' }), cipher });
    assert.strictEqual(fresh.get(LOGIN), LOGIN_VALUE);
    assert.strictEqual(fresh.get('github'), 'plain-github');
    // A second plan finds it where it landed, and sends nothing.
    const again = itemOf(await importer.plan({ installId: source.installId, inventory: source.inventory }), LOGIN);
    assert.strictEqual(again.action, 'skip-present');
    assert.match(again.note, /already on this node/);
    assert.match(again.note, /not compared/);
  });

  it('never overwrites a secret the key would have to nest under, and says so', async () => {
    const { core, importer } = await nodeService();
    core.context.vault.set('browser_cred:king-louie:shop.example.com', 'the-node-own');
    const source = readSource(await desktopConfig({ 'browser_cred:king-louie:shop.example.com.au': 'from-desktop' }));
    const { plan, report } = await moveAll(importer, source);
    const item = itemOf(plan, 'browser_cred:king-louie:shop.example.com.au');
    assert.strictEqual(item.action, 'needs-attention');
    assert.match(item.note, /browser_cred:king-louie:shop\.example\.com\b/);
    assert.deepStrictEqual(report.failures, []);
    assert.strictEqual(core.context.vault.get('browser_cred:king-louie:shop.example.com'), 'the-node-own');
  });

  it('a name the node only holds entries under is not already there', async () => {
    const { core, importer } = await nodeService();
    core.context.vault.set('browser_cred:king-louie:shop.example.com.au', 'the-node-own');
    const source = readSource(await desktopConfig({ 'browser_cred:king-louie:shop.example.com': 'from-desktop' }));
    const { plan } = await moveAll(importer, source);
    assert.strictEqual(itemOf(plan, 'browser_cred:king-louie:shop.example.com').action, 'needs-attention');
    assert.strictEqual(core.context.vault.get('browser_cred:king-louie:shop.example.com.au'), 'the-node-own');
  });
});

describe('what reading whole must not widen', () => {
  const RESERVED = ['contact.relay', 'contact.email.password', 'local.workstation', 'Contact.Relay', ' local .x'];

  for (const hosting of ['personal', 'service']) {
    it(`contact. and local. keys stay behind, each with its own named line (${hosting})`, async () => {
      const source = readSource(await desktopConfig({ 'contact.relay': 'relay-secret', 'local.workstation': 'server-secret', github: 'plain-github' }));
      const { core, importer } = await nodeService({ hosting });
      const { plan, report, sent } = await moveAll(importer, source);
      for (const key of ['contact.relay', 'local.workstation']) {
        const item = itemOf(plan, key);
        assert.strictEqual(item.action, 'skip-excluded', key);
        assert.ok(item.note.includes(key), item.note);
        assert.strictEqual(core.context.vault.has(key), false, `${key} must not land`);
      }
      assert.ok(!sent.some((e) => e.category === 'vault' && /^(contact|local)/.test(e.key)), 'never sent');
      assert.strictEqual(core.context.vault.get('github'), 'plain-github');
      assert.deepStrictEqual(report.failures, []);
    });
  }

  it('however it is spelled: the plan reads a key as the Vault tool does', async () => {
    const { importer } = await nodeService();
    const inventory = { installId: 'install-0001', vault: RESERVED, secrets: 'included' };
    const plan = await importer.plan({ installId: inventory.installId, inventory });
    for (const key of RESERVED) assert.strictEqual(itemOf(plan, key).action, 'skip-excluded', key);
  });

  it('a name with a prototype part in it is no name a node stores, whatever a desktop lists', async () => {
    const { core, importer } = await nodeService();
    const inventory = { installId: 'install-0001', vault: ['a.__proto__.polluted', 'constructor.x'], secrets: 'included' };
    const plan = await importer.plan({ installId: inventory.installId, inventory });
    for (const key of inventory.vault) assert.strictEqual(itemOf(plan, key).action, 'skip-excluded', key);
    await importer.apply({ planId: plan.planId, batch: [{ category: 'vault', key: 'a.__proto__.polluted', value: 'x' }] });
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(core.context.vault.holds('a.__proto__.polluted'), false);
  });

  it('a desktop that sends one anyway is refused by the node', async () => {
    const { core, importer } = await nodeService();
    const plan = await importer.plan({ installId: 'install-0001', inventory: { installId: 'install-0001', vault: ['contact.relay'], secrets: 'included' } });
    const { results } = await importer.apply({ planId: plan.planId, batch: [{ category: 'vault', key: 'contact.relay', value: 'relay-secret' }] });
    assert.strictEqual(results[0].ok, false);
    assert.strictEqual(core.context.vault.has('contact.relay'), false);
  });

  it('a reserved key is never decrypted, and one that would not decrypt is no unreadable key', async () => {
    const source = readSource(await desktopConfig({ github: 'plain-github' }, { __vault_contact: { relay: 'sealed-by-another-account' }, __vault_local: { box: 'also-sealed' } }));
    const keys = setAsideUnreadableSecrets(source);
    assert.strictEqual(keys.total, 1, 'not counted toward the wrong-environment refusal');
    assert.deepStrictEqual(keys.unreadable, []);
    assert.ok(source.inventory.vault.includes('contact.relay'), 'the plan still gets to say it stays');
  });
});

describe('the verifier covers the vault', () => {
  const cleanReport = () => ({ counts: { failed: 0 }, failures: [], attention: [], incomplete: [], skipped: [], sendFailures: [] });
  const vaultItem = (key, action = 'new') => ({ category: 'vault', key, action, note: null, targetKey: key });
  it('a held secret the node cannot read is named with its true remedy, not "move again"', async () => {
    const verified = await verifyMigration({ plan: { items: [vaultItem(LOGIN, 'skip-present')] }, report: cleanReport(), invoke: async () => ({ ok: true, held: [], unreadable: [LOGIN] }) });
    assert.strictEqual(verified.ok, false);
    assert.strictEqual(verified.missing[0].key, LOGIN);
    assert.match(verified.missing[0].why, /cannot read/);
    assert.match(verified.missing[0].why, /[Dd]elete it/);
  });

  const nodeHolding = (held) => async (channel, args) => {
    if (channel !== 'settings:vaultHeld') throw new Error(`unexpected ${channel}`);
    return { ok: true, held: args[0].keys.filter((k) => held.includes(k)) };
  };

  it('a key that did not land is not verified, and is named whole', async () => {
    const verified = await verifyMigration({ plan: { items: [vaultItem(LOGIN), vaultItem('github')] }, report: cleanReport(), invoke: nodeHolding(['github']) });
    assert.strictEqual(verified.ok, false);
    assert.deepStrictEqual(verified.missing.map((m) => [m.category, m.key]), [['vault', LOGIN]]);
  });

  it('a key planned as already there is held to the same', async () => {
    const verified = await verifyMigration({ plan: { items: [vaultItem(LOGIN, 'skip-present')] }, report: cleanReport(), invoke: nodeHolding([]) });
    assert.strictEqual(verified.ok, false);
  });

  it('keys that landed pass, and a node that cannot say is not a pass', async () => {
    const items = [vaultItem(LOGIN)];
    assert.deepStrictEqual(await verifyMigration({ plan: { items }, report: cleanReport(), invoke: nodeHolding([LOGIN]) }), { ok: true, checked: { chats: 0, cases: 0, vault: 1 } });
    const threw = await verifyMigration({ plan: { items }, report: cleanReport(), invoke: async () => { throw new Error('no such channel'); } });
    assert.strictEqual(threw.ok, false);
    const refused = await verifyMigration({ plan: { items }, report: cleanReport(), invoke: async () => ({ ok: false, error: 'refused' }) });
    assert.strictEqual(refused.ok, false);
  });

  it('asks nothing about keys that stay behind, or when there are none', async () => {
    const items = [vaultItem('contact.relay', 'skip-excluded'), vaultItem(LOGIN, 'needs-attention')];
    assert.deepStrictEqual(await verifyMigration({ plan: { items }, report: cleanReport(), invoke: async (c) => { throw new Error(`unexpected ${c}`); } }), { ok: true, checked: { chats: 0, cases: 0 } });
  });

  it('settings:vaultHeld answers from the node\'s own store: whole keys, never a reserved one, never a value', async () => {
    const { core, cipher } = await nodeService();
    core.context.vault.set(LOGIN, LOGIN_VALUE);
    core.context.vault.set('github', 'plain-github');
    core.context.vault.set('contact.relay', 'relay-secret');
    core.context.vaultStore.set('__vault_sealed', 'not-ciphertext');
    const handlers = new Map();
    const { registerSettingsHandlers } = require('../src/ipc/settings-handlers');
    registerSettingsHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, core.context);
    const ask = (keys) => handlers.get('settings:vaultHeld')({}, { keys });
    const answer = await ask([LOGIN, 'github', 'browser_cred:king-louie:login', 'contact.relay', 'sealed', 'absent', 7]);
    const held = answer.held || (answer.data && answer.data.held);
    assert.deepStrictEqual(held, [LOGIN, 'github']);
    assert.deepStrictEqual(answer.unreadable || answer.data.unreadable, ['sealed'], 'held, and unreadable, is said apart from absent');
    assert.ok(!JSON.stringify(answer).includes('plain-github'));
    assert.ok(cipher);
  });
});

describe('the source refuses what must not move, whatever a node plans', () => {
  it('a node that plans a reserved key, or a prototype part, is sent nothing', async () => {
    const source = readSource(await desktopConfig({ 'contact.relay': 'relay-secret', 'local.box': 'box-secret', github: 'plain-github' }));
    for (const key of ['contact.relay', 'local.box']) assert.strictEqual(source.getValue('vault', key), null, key);
    const skipped = [];
    const items = ['contact.relay', 'local.box', 'a.__proto__.b', 'github'].map((key) => ({ category: 'vault', key, action: 'new', targetKey: key }));
    const sent = [...planBatches(items, source, { skipped })].flat();
    assert.deepStrictEqual(sent.map((e) => e.key), ['github']);
    assert.deepStrictEqual(skipped.map((s) => s.key), ['contact.relay', 'local.box', 'a.__proto__.b']);
    assert.ok(!JSON.stringify({ sent, skipped }).includes('relay-secret'));
  });
});
