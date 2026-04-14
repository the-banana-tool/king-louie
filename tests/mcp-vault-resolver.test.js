const { test } = require('node:test');
const assert = require('node:assert');
const { createVaultEnvResolver } = require('../src/mcp/vault-resolver');

function mockStore(map = {}) {
  return {
    get: (k) => map[k]
  };
}

test('returns identity resolver when vaultStore missing', () => {
  const resolver = createVaultEnvResolver({});
  const cfg = { command: 'npx', env: { TOKEN: '${vault:foo}' } };
  assert.strictEqual(resolver(cfg), cfg);
});

test('expands ${vault:key} in env values using decryptToken', () => {
  const store = mockStore({ '__vault_github_token': 'encrypted-abc' });
  const resolver = createVaultEnvResolver({
    vaultStore: store,
    decryptToken: (enc) => enc === 'encrypted-abc' ? 'ghp_secret' : null
  });

  const resolved = resolver({
    command: 'npx',
    env: { GITHUB_TOKEN: '${vault:github_token}', OTHER: 'plain' }
  });

  assert.strictEqual(resolved.env.GITHUB_TOKEN, 'ghp_secret');
  assert.strictEqual(resolved.env.OTHER, 'plain');
});

test('leaves reference unresolved and calls onMissing when key not in vault', () => {
  const store = mockStore({});
  const missing = [];
  const resolver = createVaultEnvResolver({
    vaultStore: store,
    decryptToken: () => 'x',
    onMissing: (key) => missing.push(key)
  });

  const resolved = resolver({ env: { T: '${vault:absent}' } });
  assert.strictEqual(resolved.env.T, '${vault:absent}');
  assert.deepStrictEqual(missing, ['absent']);
});

test('supports multiple references in a single env value', () => {
  const store = mockStore({
    '__vault_user': 'enc-u',
    '__vault_pass': 'enc-p'
  });
  const resolver = createVaultEnvResolver({
    vaultStore: store,
    decryptToken: (e) => ({ 'enc-u': 'alice', 'enc-p': 'sekret' }[e])
  });

  const resolved = resolver({ env: { DSN: 'postgres://${vault:user}:${vault:pass}@host/db' } });
  assert.strictEqual(resolved.env.DSN, 'postgres://alice:sekret@host/db');
});

test('leaves non-string env values untouched', () => {
  const resolver = createVaultEnvResolver({
    vaultStore: mockStore(),
    decryptToken: () => 'x'
  });
  const resolved = resolver({ env: { PORT: 5432, NAME: 'plain' } });
  assert.strictEqual(resolved.env.PORT, 5432);
  assert.strictEqual(resolved.env.NAME, 'plain');
});
