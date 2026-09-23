const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { NodeIdentity, deriveNodeId, getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
const { MeshIdentity, saveIdentity } = require('../src/mesh/mesh-identity');
const { loadNodeConfig } = require('../src/service/node-config');

const currentUid = process.getuid ? process.getuid() : 0;

// RFC 4648 base32, lowercase and unpadded, written out bit by bit so the
// expected IDs below do not lean on the module's own encoder.
function referenceBase32(buf) {
  const bits = [...buf].map((b) => b.toString(2).padStart(8, '0')).join('');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return out;
}
const referenceNodeId = (rawKey) => `kl-${referenceBase32(crypto.createHash('sha256').update(rawKey).digest()).slice(0, 16)}`;

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// The public key from RFC 8032 section 7.1, TEST 1.
const RFC8032_RAW_KEY = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
const RFC8032_SPKI = Buffer.concat([ED25519_SPKI_PREFIX, RFC8032_RAW_KEY]);

describe('Node Identity', () => {
  it('derives node ID in kl-<base32>[0..16] format', () => {
    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    assert.match(identity.nodeId, /^kl-[a-z2-7]{16}$/);
    assert.equal(identity.nodeName, 'gpu-box');
  });

  it('hashes the raw 32-byte Ed25519 key, not its DER encoding (fixed vector)', () => {
    const expected = referenceNodeId(RFC8032_RAW_KEY);
    assert.equal(expected, 'kl-eh7ddx5bksrgcytl');
    assert.equal(deriveNodeId(RFC8032_SPKI), expected);
    assert.equal(deriveNodeId(RFC8032_SPKI.toString('hex')), expected);
    assert.notEqual(deriveNodeId(RFC8032_SPKI), referenceNodeId(RFC8032_SPKI));
  });

  it('takes the raw key from the end of a generated SPKI key', () => {
    const identity = new NodeIdentity({ nodeName: 'n' });
    // Node's own JWK export gives the raw key independently of the DER layout.
    const jwk = crypto.createPublicKey({ key: identity.publicKey, format: 'der', type: 'spki' }).export({ format: 'jwk' });
    const raw = Buffer.from(jwk.x, 'base64url');
    assert.equal(raw.length, 32);
    assert.equal(identity.nodeId, referenceNodeId(raw));
  });

  it('refuses a key that is not a DER-encoded Ed25519 public key', () => {
    assert.throws(() => deriveNodeId(RFC8032_RAW_KEY), /Ed25519/);
    const wrongPrefix = Buffer.from(RFC8032_SPKI);
    wrongPrefix[9] = 0x71; // OID 1.3.101.113 (Ed448) instead of 1.3.101.112
    assert.throws(() => deriveNodeId(wrongPrefix), /Ed25519/);
    const { publicKey: x25519 } = crypto.generateKeyPairSync('x25519', { publicKeyEncoding: { type: 'spki', format: 'der' } });
    assert.throws(() => deriveNodeId(x25519), /Ed25519/);
  });

  it('keeps the mesh peer id of the same key, so existing mesh pairings survive', () => {
    const mesh = new MeshIdentity({ displayName: 'gpu-box' });
    const node = new NodeIdentity({
      nodeName: 'gpu-box',
      displayName: mesh.displayName,
      publicKey: mesh.publicKey,
      privateKey: mesh.privateKey,
      tlsCert: mesh.tlsCert,
      tlsKey: mesh.tlsKey
    });
    assert.equal(node.peerId, mesh.peerId);
    assert.match(node.peerId, /^kl-[0-9a-f]{12}$/);
    assert.notEqual(node.nodeId, node.peerId);

    const pub = node.getPublicIdentity();
    assert.equal(pub.peerId, mesh.peerId);
    assert.equal(pub.nodeId, node.nodeId);
    assert.equal(pub.nodeName, 'gpu-box');
    assert.equal(pub.tlsFingerprint, mesh.tlsFingerprint);
    assert.equal(pub.privateKey, undefined);
  });

  it('keeps the stored mesh peer id when a saved mesh identity is loaded as a node identity', () => {
    const storeMap = new Map();
    const store = { get: (k) => storeMap.get(k), set: (k, v) => storeMap.set(k, v), delete: (k) => storeMap.delete(k) };
    const cipher = { encryptString: (s) => `enc:${s}`, decryptString: (s) => s.slice(4), isEncryptionAvailable: () => true };
    const mesh = new MeshIdentity({ displayName: 'laptop' });
    saveIdentity(store, mesh, cipher);

    const node = getOrGenerateNodeIdentity(store, cipher, 'laptop');
    assert.equal(node.peerId, mesh.peerId);
    assert.equal(node.tlsFingerprint, mesh.tlsFingerprint);
    assert.equal(node.nodeId, deriveNodeId(mesh.publicKey));
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
