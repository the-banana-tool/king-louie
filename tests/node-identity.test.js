const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NodeIdentity, getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
const { loadNodeConfig } = require('../src/service/node-config');

const currentUid = process.getuid ? process.getuid() : 0;

describe('Node Identity', () => {
  it('derives node ID in kl-<base32>[0..16] format', () => {
    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    assert.match(identity.nodeId, /^kl-[a-z2-7]{16}$/);
    assert.equal(identity.nodeName, 'gpu-box');
  });

  it('encrypts private keys on save and decrypts on load', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-id-test-'));
    try {
      const storeMap = new Map();
      const store = {
        get: (k) => storeMap.get(k),
        set: (k, v) => storeMap.set(k, v),
        delete: (k) => storeMap.delete(k)
      };

      const cipher = {
        encryptString: (str) => `enc:${str}`,
        decryptString: (str) => str.slice(4),
        isEncryptionAvailable: () => true
      };

      const identity1 = getOrGenerateNodeIdentity(store, cipher, 'gpu-box');
      assert.ok(identity1.nodeId);

      const savedRecord = storeMap.get('mesh.identity');
      assert.equal(savedRecord.privateKey, null);
      assert.equal(savedRecord.keyEncryption, 'cipher-v1');
      assert.ok(savedRecord.encryptedPrivateKey.startsWith('enc:'));

      const identity2 = getOrGenerateNodeIdentity(store, cipher, 'gpu-box');
      assert.equal(identity2.nodeId, identity1.nodeId);
      assert.equal(identity2.nodeName, 'gpu-box');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Node Config Loader', () => {
  it('loads node.yaml and applies defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-cfg-test-'));
    try {
      if (process.platform !== 'win32') fs.chmodSync(tmpDir, 0o700);
      const yamlContent = `
name: web-01
profile: runbook
capabilities: [web, linux]
policy:
  allowed_roots: [/srv/site]
  remote_sessions:
    always_confirm: ['Bash(*restart*)']
    deny: ['Bash(rm -rf /*)']
  max_concurrent_jobs: 4
runbooks_dir: my_runbooks
`;
      const configFile = path.join(tmpDir, 'node.yaml');
      fs.writeFileSync(configFile, yamlContent, 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(configFile, 0o600);

      const config = loadNodeConfig({ adminConfigDir: tmpDir, geteuid: () => currentUid, adminUid: currentUid });
      assert.equal(config.name, 'web-01');
      assert.equal(config.profile, 'runbook');
      assert.deepEqual(config.capabilities, ['web', 'linux']);
      assert.equal(config.policy.max_concurrent_jobs, 4);
      assert.deepEqual(config.policy.allowed_roots, [path.resolve('/srv/site')]);
      assert.equal(config.runbooksDir, path.join(tmpDir, 'my_runbooks'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses to read node.yaml if group/world writable or owned by service account on POSIX', { skip: process.platform === 'win32' }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-cfg-perm-test-'));
    try {
      if (process.platform !== 'win32') fs.chmodSync(tmpDir, 0o700);
      const configFile = path.join(tmpDir, 'node.yaml');
      fs.writeFileSync(configFile, 'name: insecure-node\n', 'utf8');
      fs.chmodSync(configFile, 0o666);

      assert.throws(
        () => loadNodeConfig({ adminConfigDir: tmpDir, geteuid: () => currentUid, adminUid: currentUid }),
        /group- or world-writable/
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
