const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createVault, VAULT_PREFIX } = require('../src/platform/vault');
const { createAesGcmCipher } = require('../src/platform/cipher');

function memoryStore() {
  const data = {};
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    has: (k) => k in data,
    delete: (k) => { delete data[k]; },
    get store() { return { ...data }; },
    _data: data
  };
}

describe('vault', () => {
  it('stores ciphertext under the legacy prefix and lists bare keys', () => {
    const store = memoryStore();
    store.set('unrelated', 1);
    const vault = createVault({ store, cipher: createAesGcmCipher(crypto.randomBytes(32)) });
    vault.set('api_key', 'hunter2');
    assert.ok(store._data[`${VAULT_PREFIX}api_key`].startsWith('klc1:'));
    assert.strictEqual(vault.get('api_key'), 'hunter2');
    assert.deepStrictEqual(vault.list(), ['api_key']);
    assert.strictEqual(vault.has('api_key'), true);
    assert.strictEqual(vault.delete('api_key'), true);
    assert.strictEqual(vault.delete('api_key'), false);
    assert.strictEqual(vault.get('api_key'), null);
  });
});

describe('a vault name is read by own properties only', () => {
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const cipher = { encryptString: (s) => `E:${s}`, decryptString: (s) => s.slice(2) };
  const realVault = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vault-'));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new JsonFileStore({ dir, name: 'config' });
    return { dir, store, vault: createVault({ store, cipher }) };
  };

  it('x.toString over a branch reaches nothing', () => {
    const { vault } = realVault();
    vault.set('x.example.com', 'one');
    for (const name of ['x.toString', 'x.constructor', 'x.__proto__', 'x.example.hasOwnProperty']) {
      assert.strictEqual(vault.holds(name), false, name);
      assert.strictEqual(vault.has(name), false, name);
      assert.strictEqual(vault.get(name), null, name);
    }
    assert.strictEqual(vault.get('x.example.com'), 'one');
    assert.strictEqual(vault.has('x.example'), true, 'a name with entries under it is still there');
    assert.strictEqual(vault.holds('x.example'), false);
    assert.strictEqual(vault.get('x.example'), null);
  });

  it('settings:vaultHeld answers the same', async () => {
    const { store, vault } = realVault();
    vault.set('x.example.com', 'one');
    const handlers = new Map();
    require('../src/ipc/settings-handlers').registerSettingsHandlers({ handle: (c, fn) => handlers.set(c, fn) }, { vaultStore: store, encryptToken: cipher.encryptString, decryptToken: cipher.decryptString });
    const answer = await handlers.get('settings:vaultHeld')({}, { keys: ['x.toString', 'x.example.com'] });
    assert.deepStrictEqual((answer.data || answer).held, ['x.example.com']);
  });
});

describe('the vault pane and tool cannot destroy a dotted entry', () => {
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const vaultTool = require('../src/tools/builtin/vault-tool');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const cipher = { encryptString: (s) => `E:${s}`, decryptString: (s) => s.slice(2) };
  const A = 'browser_cred:p:www.alpha-example.com';
  const B = 'browser_cred:p:www.beta-example.org';
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vault-'));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new JsonFileStore({ dir, name: 'config' });
    const vault = createVault({ store, cipher });
    vault.set(A, 'one');
    vault.set(B, 'two');
    vault.set('plain', 'three');
    const handlers = new Map();
    require('../src/ipc/settings-handlers').registerSettingsHandlers({ handle: (c, fn) => handlers.set(c, fn) }, { vaultStore: store, encryptToken: cipher.encryptString, decryptToken: cipher.decryptString });
    const call = async (channel, arg) => { const a = await handlers.get(channel)({}, arg); return a.data && a.ok !== false ? { ok: a.ok, ...a.data } : a; };
    return { store, vault, call };
  }
  const BRANCH = 'browser_cred:p:www';
  const intact = (vault) => { assert.strictEqual(vault.get(A), 'one'); assert.strictEqual(vault.get(B), 'two'); };

  it('every list shows whole keys, one row per secret', async () => {
    const { vault, call } = setup();
    assert.deepStrictEqual([...vault.list()].sort(), [A, B, 'plain'].sort());
    assert.deepStrictEqual([...(await call('settings:vaultList')).keys].sort(), [A, B, 'plain'].sort());
  });

  it('Delete takes one whole key, and refuses a branch', async () => {
    const { vault, call } = setup();
    assert.strictEqual((await call('settings:vaultDelete', { key: BRANCH })).ok, false);
    intact(vault);
    assert.strictEqual((await call('settings:vaultDelete', { key: A })).ok, true);
    assert.strictEqual(vault.get(A), null);
    assert.strictEqual(vault.get(B), 'two');
  });

  it('Update refuses a branch by either name, and never writes over one', async () => {
    const { vault, call } = setup();
    assert.strictEqual((await call('settings:vaultUpdate', { oldKey: BRANCH, newKey: BRANCH, value: 'new' })).ok, false);
    assert.strictEqual((await call('settings:vaultUpdate', { oldKey: BRANCH, newKey: 'other' })).ok, false);
    assert.strictEqual((await call('settings:vaultUpdate', { oldKey: 'plain', newKey: BRANCH })).ok, false);
    assert.strictEqual((await call('settings:vaultUpdate', { oldKey: 'plain', newKey: BRANCH, value: 'new' })).ok, false);
    assert.strictEqual((await call('settings:vaultUpdate', { oldKey: 'plain', newKey: `${A}.deeper` })).ok, false, 'nor under a secret');
    intact(vault);
    assert.strictEqual(vault.get('plain'), 'three', 'a refused rename loses nothing');
  });

  it('Update still changes a whole key, its name or its value', async () => {
    const { vault, call } = setup();
    assert.strictEqual((await call('settings:vaultUpdate', { oldKey: A, newKey: A, value: 'changed' })).ok, true);
    assert.strictEqual(vault.get(A), 'changed');
    assert.strictEqual((await call('settings:vaultUpdate', { oldKey: 'plain', newKey: 'renamed' })).ok, true);
    assert.strictEqual(vault.get('renamed'), 'three');
    assert.strictEqual(vault.get('plain'), null);
    assert.strictEqual(vault.get(B), 'two');
  });

  it('Store and vault.set refuse a name a secret or a branch is in the way of', async () => {
    const { vault, call } = setup();
    assert.strictEqual((await call('settings:vaultStore', { key: BRANCH, value: 'new' })).ok, false);
    assert.strictEqual((await call('settings:vaultStore', { key: `${A}.deeper`, value: 'new' })).ok, false);
    assert.throws(() => vault.set(BRANCH, 'new'));
    assert.throws(() => vault.set('plain.deeper', 'new'));
    intact(vault);
    assert.strictEqual(vault.get('plain'), 'three');
    vault.set(A, 'again');
    assert.strictEqual(vault.get(A), 'again', 'its own name is no obstacle');
  });

  it('vault.delete takes a secret, never a branch', () => {
    const { vault } = setup();
    assert.strictEqual(vault.delete(BRANCH), false);
    intact(vault);
    assert.strictEqual(vault.delete(A), true);
  });

  it('the Vault tool: whole keys in its list, nothing destroyed, contact. and local. still refused and hidden', async () => {
    const { vault } = setup();
    vault.set('contact.relay', 'relay');
    vault.set('local.box', 'box');
    const run = (params) => vaultTool.execute(params, { vault });
    const listed = await run({ action: 'list' });
    assert.deepStrictEqual([...listed.keys].sort(), [A, B, 'plain'].sort());
    assert.strictEqual((await run({ action: 'store', key: BRANCH, value: 'new' })).ok, false);
    assert.strictEqual((await run({ action: 'delete', key: BRANCH })).ok, false);
    assert.strictEqual((await run({ action: 'retrieve', key: BRANCH })).ok, false);
    intact(vault);
    for (const key of ['contact.relay', 'local.box']) {
      for (const action of ['store', 'retrieve', 'delete']) assert.strictEqual((await run({ action, key, value: 'x' })).ok, false, `${action} ${key}`);
    }
    assert.strictEqual(vault.get('contact.relay'), 'relay');
  });

  it('a stored flat name still lists and reads, and is not said to be deleted when it was not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vault-'));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ '__vault_flat.name': 'E:value' }));
    const vault = createVault({ store: new JsonFileStore({ dir, name: 'config' }), cipher });
    assert.deepStrictEqual(vault.list(), ['flat.name']);
    assert.strictEqual(vault.get('flat.name'), 'value');
    assert.strictEqual(vault.delete('flat.name'), false);
  });
});
