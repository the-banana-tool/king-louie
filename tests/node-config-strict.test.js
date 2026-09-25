// tests/node-config-strict.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadNodeConfig, NODE_YAML_KEYS } = require('../src/service/node-config');
const { runDoctor } = require('../src/service/doctor');

const EUID = typeof process.geteuid === 'function' ? process.geteuid() : 0;
const POSIX = process.platform !== 'win32';

// <root>/config/node.yaml, admin-owned the way the loader wants it: the test's
// own uid stands in for root, the dir is 0755 and the file 0644.
function withAdminDir(yaml, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-strict-'));
  try {
    const dir = path.join(root, 'config');
    fs.mkdirSync(dir);
    if (POSIX) fs.chmodSync(dir, 0o755);
    const file = path.join(dir, 'node.yaml');
    fs.writeFileSync(file, yaml, 'utf8');
    if (POSIX) fs.chmodSync(file, 0o644);
    return fn({ root, dir, file });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const load = (dir) => loadNodeConfig({ adminConfigDir: dir, geteuid: () => EUID, adminUid: EUID });

function expectUnknown(yaml, keyPath, known) {
  withAdminDir(yaml, ({ dir, file }) => {
    assert.throws(() => load(dir), (err) => {
      assert.equal(err.message, `Invalid ${file}: unknown key "${keyPath}" (known: ${known.join(', ')})`);
      return true;
    });
  });
}

describe('NODE_YAML_KEYS', () => {
  it('lists every key node.yaml may carry, per level, frozen', () => {
    assert.deepEqual([...NODE_YAML_KEYS.top], ['name', 'profile', 'front_door', 'capabilities', 'policy', 'runbooks_dir']);
    assert.deepEqual([...NODE_YAML_KEYS.policy], ['allowed_roots', 'remote_sessions', 'max_concurrent_jobs']);
    assert.deepEqual([...NODE_YAML_KEYS.remote_sessions], ['always_confirm', 'deny']);
    assert.ok(Object.isFrozen(NODE_YAML_KEYS));
    for (const level of Object.values(NODE_YAML_KEYS)) assert.ok(Object.isFrozen(level));
  });
});

describe('loadNodeConfig rejects unknown keys', () => {
  it('names an unknown top-level key and the keys allowed there', () => {
    expectUnknown('name: n\nrunbook_dir: runbooks\n', 'runbook_dir', NODE_YAML_KEYS.top);
  });

  it('names an unknown policy key with its dotted path', () => {
    expectUnknown('policy:\n  allowed_root: [/srv/site]\n', 'policy.allowed_root', NODE_YAML_KEYS.policy);
  });

  it('names an unknown remote_sessions key with its dotted path', () => {
    expectUnknown(
      'policy:\n  remote_sessions:\n    always_confirmm: []\n',
      'policy.remote_sessions.always_confirmm',
      NODE_YAML_KEYS.remote_sessions
    );
  });

  it('checks the top level before policy', () => {
    expectUnknown('policy:\n  allowed_root: []\nnmae: x\n', 'nmae', NODE_YAML_KEYS.top);
  });

  it('reports an unknown key before any per-key type error', () => {
    expectUnknown('max_jobs: 1\ncapabilities: gpu\n', 'max_jobs', NODE_YAML_KEYS.top);
  });

  it('leaves the existing type error for a policy that is not a mapping', () => {
    withAdminDir('policy: [a]\n', ({ dir }) => {
      assert.throws(() => load(dir), /policy must be a mapping/);
    });
  });

  it('accepts a file that uses every known key at every level', () => {
    const yaml = [
      'name: web-01',
      'profile: runbook',
      'front_door: https://kl.example.com',
      'capabilities: [site]',
      'policy:',
      '  allowed_roots: [/srv/site]',
      '  remote_sessions:',
      "    always_confirm: ['Bash(ssh *)']",
      "    deny: ['Bash(rm -rf /*)']",
      '  max_concurrent_jobs: 1',
      'runbooks_dir: runbooks',
      ''
    ].join('\n');
    withAdminDir(yaml, ({ dir }) => {
      const cfg = load(dir);
      assert.equal(cfg.name, 'web-01');
      assert.equal(cfg.frontDoor, 'https://kl.example.com');
      assert.equal(cfg.policy.max_concurrent_jobs, 1);
    });
  });

  it('still returns the defaults when node.yaml is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-strict-missing-'));
    try {
      assert.equal(load(dir).name, 'unnamed-node');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes runDoctor report the typo as the node config FAIL row', () => {
    withAdminDir('name: n\npolicy:\n  alowed_roots: []\n', ({ root }) => {
      const dataDir = path.join(root, 'data');
      fs.mkdirSync(dataDir);
      if (POSIX) fs.chmodSync(dataDir, 0o700);
      const rows = runDoctor({ dataDir, adminUid: EUID });
      const row = rows.find((r) => r.check === 'node config / runbooks health');
      assert.ok(row, JSON.stringify(rows));
      assert.equal(row.ok, false);
      assert.match(row.detail, /unknown key "policy\.alowed_roots"/);
    });
  });
});
