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

// Cases stage 4: contact channel credentials never leave the vault through
// an MCP env reference, however the key is spelled (electron-store's
// dot-prop drops a backslash before an ordinary character).
test('leaves ${vault:contact.…} references unresolved, never reads them, and logs', () => {
  const reads = [];
  const warnings = [];
  const store = { get: (k) => { reads.push(k); return 'encrypted'; } };
  const resolver = createVaultEnvResolver({
    vaultStore: store,
    decryptToken: () => 'secret',
    logger: { warn: (m) => warnings.push(m) }
  });
  const refs = ['${vault:contact.relay.main.token}', '${vault: Contact.x}', '${vault:\\contact.relay.main.token}', '${vault:cont\\act.x}', '${vault:contact[0]}'];
  const env = Object.fromEntries(refs.map((r, i) => [`K${i}`, r]));
  const resolved = resolver({ env: { ...env, OK: '${vault:github_token}' } });
  refs.forEach((r, i) => assert.strictEqual(resolved.env[`K${i}`], r));
  assert.strictEqual(resolved.env.OK, 'secret');
  assert.deepStrictEqual(reads, ['__vault_github_token']);
  assert.strictEqual(warnings.length, refs.length);
  assert.match(warnings[0], /contact/);
});
