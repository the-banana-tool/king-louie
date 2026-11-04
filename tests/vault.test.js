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

describe('a branch with no secret in it is nothing', () => {
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const cipher = { encryptString: (s) => `E:${s}`, decryptString: (s) => s.slice(2) };
  const tmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vault-'));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  function setup() {
    const dir = tmpDir();
    const store = new JsonFileStore({ dir, name: 'config' });
    const vault = createVault({ store, cipher });
    const handlers = new Map();
    require('../src/ipc/settings-handlers').registerSettingsHandlers({ handle: (c, fn) => handlers.set(c, fn) }, { vaultStore: store, encryptToken: cipher.encryptString, decryptToken: cipher.decryptString });
    const call = async (channel, arg) => { const a = await handlers.get(channel)({}, arg); return a.data && a.ok !== false ? { ok: a.ok, ...a.data } : a; };
    return { dir, store, vault, call };
  }

  const AU = 'browser_cred:p:example.com.au';
  const COM = 'browser_cred:p:example.com';

  it('save, delete, save the shorter name: nothing is in the way, and no parent is left', () => {
    const { vault, store } = setup();
    vault.set(AU, 'one');
    assert.strictEqual(vault.delete(AU), true);
    assert.deepStrictEqual(Object.keys(store.store).filter((k) => k.startsWith('__vault_')), [], 'the empty parents go');
    assert.strictEqual(vault.blockedBy(COM), null);
    vault.set(COM, 'two');
    assert.strictEqual(vault.get(COM), 'two');
  });

  it('delete keeps the parents another secret still needs', () => {
    const { vault } = setup();
    vault.set(AU, 'one');
    vault.set('browser_cred:p:example.org', 'two');
    vault.delete(AU);
    assert.strictEqual(vault.get('browser_cred:p:example.org'), 'two');
    assert.deepStrictEqual(vault.list(), ['browser_cred:p:example.org']);
  });

  it('the same order on the store the desktop uses, whose delete does not prune', async () => {
    const { default: Conf } = await import('conf');
    const conf = new Conf({ cwd: tmpDir(), configName: 'config', projectName: 'kl-test' });
    const vault = createVault({ store: conf, cipher });
    vault.set(AU, 'one');
    vault.delete(AU);
    assert.strictEqual(vault.blockedBy(COM), null);
    vault.set(COM, 'two');
    assert.strictEqual(vault.get(COM), 'two');
    assert.deepStrictEqual(vault.list(), [COM]);
  });

  it('empty parents already on disk block nothing, and writing over them works', () => {
    const { vault, store } = setup();
    store.set(`__vault_${COM}`, { au: {} });
    assert.strictEqual(vault.holds(COM), false);
    assert.strictEqual(vault.blockedBy(COM), null);
    vault.set(COM, 'two');
    assert.strictEqual(vault.get(COM), 'two');
  });

  it('a branch with a secret, or with something that is no branch, still blocks', () => {
    const { vault, store } = setup();
    vault.set(AU, 'one');
    assert.strictEqual(vault.blockedBy(COM), COM);
    store.set('__vault_odd', { count: 3 });
    assert.strictEqual(vault.blockedBy('odd'), 'odd');
  });

  it('a rename off a dotted name leaves no empty parent in the way', async () => {
    const { vault, call } = setup();
    vault.set(AU, 'one');
    assert.strictEqual((await call('settings:vaultUpdate', { oldKey: AU, newKey: 'plain' })).ok, true);
    assert.strictEqual(vault.blockedBy(COM), null);
    vault.set(COM, 'two');
    assert.strictEqual(vault.get('plain'), 'one');
    assert.strictEqual(vault.get(COM), 'two');
  });
});

describe('a prototype part is no name to write', () => {
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const cipher = { encryptString: (s) => `E:${s}`, decryptString: (s) => s.slice(2) };
  const tmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vault-'));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  function setup() {
    const dir = tmpDir();
    const store = new JsonFileStore({ dir, name: 'config' });
    const vault = createVault({ store, cipher });
    const handlers = new Map();
    require('../src/ipc/settings-handlers').registerSettingsHandlers({ handle: (c, fn) => handlers.set(c, fn) }, { vaultStore: store, encryptToken: cipher.encryptString, decryptToken: cipher.decryptString });
    const call = async (channel, arg) => { const a = await handlers.get(channel)({}, arg); return a.data && a.ok !== false ? { ok: a.ok, ...a.data } : a; };
    return { dir, store, vault, call };
  }

  const NAMES = ['a.__proto__.polluted', '__proto__.polluted', 'a.constructor.prototype.polluted'];

  it('vault.set refuses it, and nothing is polluted', () => {
    const { vault } = setup();
    for (const name of NAMES) assert.throws(() => vault.set(name, 'x'), { code: 'VAULT_NAME_REFUSED' }, name);
    assert.strictEqual({}.polluted, undefined);
  });

  it('the pane refuses it on Store, and on Update by value or by rename', async () => {
    const { vault, call } = setup();
    vault.set('plain', 'one');
    for (const name of NAMES) {
      assert.strictEqual((await call('settings:vaultStore', { key: name, value: 'x' })).ok, false, name);
      assert.strictEqual((await call('settings:vaultUpdate', { oldKey: 'plain', newKey: name, value: 'x' })).ok, false, name);
      assert.strictEqual((await call('settings:vaultUpdate', { oldKey: 'plain', newKey: name })).ok, false, name);
    }
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(vault.get('plain'), 'one');
  });
});
