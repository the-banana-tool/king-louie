// tests/local-leftovers.test.js
// Two things stage L1's Tasks 5 to 7 left open (local inference spec
// 2026-10-13 §5.6, §13.3): a local server's key that an administrator put
// in the vault is not the model's to read, list, change or delete (as the
// contact credentials are not), and a probe asked for over the desktop
// bridge gets the long timeout, since one probe can outlast the default.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const vaultTool = require('../src/tools/builtin/vault-tool');
const { isLocalServerVaultKey, LOCAL_SERVER_VAULT_PREFIX } = require('../src/models/local-vault-keys');
const { parseLocalInferenceConfig } = require('../src/service/config');
const { channelTimeoutMs, LONG_CHANNEL_TIMEOUT_MS, classifyChannel } = require('../src/desktop-bridge/allowlist');
const IPC = require('../src/ipc/constants');

function fakeVault(entries) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: (k) => store.get(k) || null,
    set: (k, v) => { store.set(k, v); },
    delete: (k) => store.delete(k),
    list: () => [...store.keys()]
  };
}

describe('a local server\'s key in the vault', () => {
  it('the namespace is "local", spelled any way the vault would read it', () => {
    assert.strictEqual(LOCAL_SERVER_VAULT_PREFIX, 'local');
    for (const key of ['local.lan-box', 'LOCAL.lan-box', ' local.x', 'local', 'lo\\cal.x', 'local[0]', 'Local.Workstation']) {
      assert.strictEqual(isLocalServerVaultKey(key), true, key);
    }
    for (const key of ['locals.x', 'localhost', 'my.local.x', 'contact.x', 'test_cc_number', '', null, undefined]) {
      assert.strictEqual(isLocalServerVaultKey(key), false, String(key));
    }
  });

  it('the Vault tool refuses to read, store or delete one, and hides it from list', async () => {
    const vault = fakeVault({ 'local.lan-box': 'sk-local-123', 'contact.relay': 'r', signup_password: 'p' });
    for (const action of ['retrieve', 'store', 'delete']) {
      for (const key of ['local.lan-box', 'LOCAL.lan-box', 'local']) {
        const out = await vaultTool.execute({ action, key, value: 'x' }, { vault });
        assert.strictEqual(out.ok, false, `${action} ${key}`);
        assert.match(out.error, /local server/);
        assert.ok(!JSON.stringify(out).includes('sk-local-123'));
      }
    }
    assert.strictEqual(vault.store.get('local.lan-box'), 'sk-local-123', 'nothing was changed');
    const listed = await vaultTool.execute({ action: 'list' }, { vault });
    assert.deepStrictEqual(listed.keys, ['signup_password']);
    // Other keys still work.
    assert.strictEqual((await vaultTool.execute({ action: 'retrieve', key: 'signup_password' }, { vault })).value, 'p');
  });

  it('the admin block takes a key only under local.', () => {
    const entry = (key) => ({ servers: [{ id: 'lan-box', name: 'LAN box', kind: 'vllm', baseUrl: 'http://127.0.0.1:8000', key }] });
    assert.strictEqual(parseLocalInferenceConfig(entry('${vault:local.lan-box}'), 'service.json').servers[0].key, '${vault:local.lan-box}');
    for (const key of ['${vault:lan-box}', '${vault:openai_key}', '${vault:contact.relay}']) {
      assert.throws(() => parseLocalInferenceConfig(entry(key), 'service.json'), /local\./, key);
    }
  });
});

describe('the probe over the desktop bridge', () => {
  it('models:local.probe is proxied with the long timeout', () => {
    assert.strictEqual(IPC.MODELS_LOCAL_PROBE, 'models:local.probe');
    assert.strictEqual(classifyChannel(IPC.MODELS_LOCAL_PROBE), 'proxy');
    assert.strictEqual(channelTimeoutMs(IPC.MODELS_LOCAL_PROBE, 120000), LONG_CHANNEL_TIMEOUT_MS);
    // A probe's own bounds: a listing (20 s) and two steps of up to 60 s each
    // already pass the default bridge timeout (120 s).
    assert.ok(20000 + 2 * 60000 >= 120000);
    assert.strictEqual(channelTimeoutMs(IPC.MODELS_LOCAL_LIST, 120000), 120000);
  });
});
