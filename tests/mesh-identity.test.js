const { describe, it } = require('node:test');
const assert = require('node:assert');

const { MeshIdentity } = require('../src/mesh/mesh-identity');

describe('MeshIdentity', () => {
  it('generates a keypair and peer ID on construction', () => {
    const identity = new MeshIdentity({ displayName: 'test-node' });

    assert.ok(identity.peerId.startsWith('kl-'));
    assert.strictEqual(identity.peerId.length, 3 + 12); // 'kl-' + 12 hex chars
    assert.ok(Buffer.isBuffer(identity.publicKey));
    assert.ok(Buffer.isBuffer(identity.privateKey));
    assert.strictEqual(identity.displayName, 'test-node');
  });

  it('derives the same peer ID from the same keys', () => {
    const identity = new MeshIdentity();
    const serialized = identity.serialize();
    const restored = MeshIdentity.deserialize(serialized);

    assert.strictEqual(restored.peerId, identity.peerId);
  });

  it('signs and verifies data correctly', () => {
    const identity = new MeshIdentity();
    const data = 'hello mesh';
    const signature = identity.sign(data);

    assert.ok(Buffer.isBuffer(signature));

    const valid = MeshIdentity.verify(data, signature, identity.publicKey);
    assert.strictEqual(valid, true);

    const invalid = MeshIdentity.verify('wrong data', signature, identity.publicKey);
    assert.strictEqual(invalid, false);
  });

  it('signs and verifies challenges', () => {
    const identity = new MeshIdentity();
    const challenge = identity.generateChallenge();

    assert.ok(Buffer.isBuffer(challenge));
    assert.strictEqual(challenge.length, 32);

    const signature = identity.signChallenge(challenge);
    const valid = MeshIdentity.verifyChallenge(challenge, signature, identity.publicKey);
    assert.strictEqual(valid, true);
  });

  it('rejects verification with wrong public key', () => {
    const identity1 = new MeshIdentity();
    const identity2 = new MeshIdentity();

    const data = 'test data';
    const signature = identity1.sign(data);

    const valid = MeshIdentity.verify(data, signature, identity2.publicKey);
    assert.strictEqual(valid, false);
  });

  it('serializes and deserializes with metadata', () => {
    const identity = new MeshIdentity({
      displayName: 'My Desktop',
      capabilities: ['gpu', 'build-server']
    });

    const serialized = identity.serialize();
    assert.strictEqual(serialized.displayName, 'My Desktop');
    assert.deepStrictEqual(serialized.capabilities, ['gpu', 'build-server']);
    assert.ok(serialized.publicKey);
    assert.ok(serialized.privateKey);

    const restored = MeshIdentity.deserialize(serialized);
    assert.strictEqual(restored.peerId, identity.peerId);
    assert.strictEqual(restored.displayName, 'My Desktop');
    assert.deepStrictEqual(restored.capabilities, ['gpu', 'build-server']);
  });

  it('getPublicIdentity excludes private key', () => {
    const identity = new MeshIdentity({ displayName: 'node1' });
    const pub = identity.getPublicIdentity();

    assert.ok(pub.peerId);
    assert.ok(pub.publicKey);
    assert.strictEqual(pub.displayName, 'node1');
    assert.strictEqual(pub.privateKey, undefined);
  });

  it('creates and verifies envelopes', () => {
    const sender = new MeshIdentity({ displayName: 'sender' });
    const receiver = new MeshIdentity({ displayName: 'receiver' });

    const payload = { method: 'test', params: { foo: 'bar' } };
    const envelope = MeshIdentity.createEnvelope(sender, receiver.peerId, payload);

    assert.strictEqual(envelope.from, sender.peerId);
    assert.strictEqual(envelope.to, receiver.peerId);
    assert.ok(envelope.nonce);
    assert.ok(envelope.timestamp);
    assert.ok(envelope.signature);
    assert.deepStrictEqual(envelope.payload, payload);

    const result = MeshIdentity.verifyEnvelope(envelope, sender.publicKey);
    assert.strictEqual(result.valid, true);
  });

  it('rejects expired envelopes', () => {
    const sender = new MeshIdentity();
    const envelope = MeshIdentity.createEnvelope(sender, 'kl-target', { method: 'test' });

    // Simulate old timestamp
    envelope.timestamp = Date.now() - (6 * 60 * 1000); // 6 minutes ago

    const result = MeshIdentity.verifyEnvelope(envelope, sender.publicKey);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'message_expired');
  });

  it('rejects tampered envelopes', () => {
    const sender = new MeshIdentity();
    const envelope = MeshIdentity.createEnvelope(sender, 'kl-target', { method: 'test' });

    // Tamper with payload
    envelope.payload.method = 'hacked';

    const result = MeshIdentity.verifyEnvelope(envelope, sender.publicKey);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'invalid_signature');
  });

  it('generates TLS certificate and key on construction', () => {
    const identity = new MeshIdentity({ displayName: 'tls-test' });

    assert.ok(identity.tlsCert, 'should have TLS cert');
    assert.ok(identity.tlsKey, 'should have TLS key');
    assert.ok(identity.tlsFingerprint, 'should have TLS fingerprint');
    assert.ok(identity.tlsCert.includes('-----BEGIN CERTIFICATE-----'));
    assert.ok(identity.tlsKey.includes('-----BEGIN PRIVATE KEY-----'));
    assert.strictEqual(identity.tlsFingerprint.length, 64); // SHA-256 hex
  });

  it('serializes and deserializes TLS credentials', () => {
    const identity = new MeshIdentity({ displayName: 'tls-persist' });
    const serialized = identity.serialize();

    assert.ok(serialized.tlsCert);
    assert.ok(serialized.tlsKey);
    assert.ok(serialized.tlsFingerprint);

    const restored = MeshIdentity.deserialize(serialized);
    assert.strictEqual(restored.tlsFingerprint, identity.tlsFingerprint);
    assert.strictEqual(restored.tlsCert, identity.tlsCert);
    assert.strictEqual(restored.tlsKey, identity.tlsKey);
  });

  it('getPublicIdentity includes TLS fingerprint but not key', () => {
    const identity = new MeshIdentity();
    const pub = identity.getPublicIdentity();

    assert.ok(pub.tlsFingerprint);
    assert.strictEqual(pub.tlsCert, undefined);
    assert.strictEqual(pub.tlsKey, undefined);
  });

  it('verifies cert fingerprints correctly', () => {
    const identity = new MeshIdentity();
    const fp = MeshIdentity.getCertFingerprint(identity.tlsCert);

    assert.strictEqual(fp, identity.tlsFingerprint);
    assert.strictEqual(MeshIdentity.verifyCertFingerprint(identity.tlsCert, fp), true);
    assert.strictEqual(
      MeshIdentity.verifyCertFingerprint(identity.tlsCert, '0'.repeat(64)),
      false
    );
  });

  it('different identities have different TLS fingerprints', () => {
    const id1 = new MeshIdentity();
    const id2 = new MeshIdentity();
    assert.notStrictEqual(id1.tlsFingerprint, id2.tlsFingerprint);
  });

  it('generates unique nonces', () => {
    const nonces = new Set();
    for (let i = 0; i < 100; i++) {
      nonces.add(MeshIdentity.generateNonce());
    }
    assert.strictEqual(nonces.size, 100);
  });

  it('generates unique peer IDs for different keypairs', () => {
    const id1 = new MeshIdentity();
    const id2 = new MeshIdentity();
    assert.notStrictEqual(id1.peerId, id2.peerId);
  });
});
