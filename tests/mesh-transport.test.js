const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { MeshIdentity } = require('../src/mesh/mesh-identity');
// Tests run without TLS for simplicity (no cert generation overhead)
const { MeshTransport } = require('../src/mesh/mesh-transport');

describe('MeshTransport', () => {
  let identity1, identity2;
  let transport1, transport2;

  beforeEach(() => {
    identity1 = new MeshIdentity({ displayName: 'Node A', capabilities: ['gpu'] });
    identity2 = new MeshIdentity({ displayName: 'Node B', capabilities: ['build'] });
  });

  afterEach(async () => {
    if (transport1) await transport1.stop().catch(() => {});
    if (transport2) await transport2.stop().catch(() => {});
  });

  it('constructs with identity and port', () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19001, useTls: false });
    assert.strictEqual(transport1.port, 19001);
    assert.strictEqual(transport1.identity.peerId, identity1.peerId);
  });

  it('starts and stops cleanly', async () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19002, useTls: false });
    await transport1.start();
    assert.strictEqual(transport1.running, true);
    assert.ok(transport1.server);

    await transport1.stop();
    assert.strictEqual(transport1.running, false);
  });

  it('manages trusted peers', () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19003, useTls: false });

    transport1.addTrustedPeer(identity2.peerId, identity2.publicKey, {
      displayName: 'Node B',
      capabilities: ['build']
    });

    assert.strictEqual(transport1.trustedPeers.size, 1);
    const trusted = transport1.trustedPeers.get(identity2.peerId);
    assert.strictEqual(trusted.displayName, 'Node B');
    assert.deepStrictEqual(trusted.capabilities, ['build']);

    transport1.removeTrustedPeer(identity2.peerId);
    assert.strictEqual(transport1.trustedPeers.size, 0);
  });

  it('getConnectedPeers returns empty when no connections', () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19004, useTls: false });
    const peers = transport1.getConnectedPeers();
    assert.deepStrictEqual(peers, []);
  });

  it('two transports connect and authenticate', async () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19005, useTls: false });
    transport2 = new MeshTransport({ identity: identity2, port: 19006, useTls: false });

    // Each trusts the other
    transport1.addTrustedPeer(identity2.peerId, identity2.publicKey, {
      displayName: 'Node B'
    });
    transport2.addTrustedPeer(identity1.peerId, identity1.publicKey, {
      displayName: 'Node A'
    });

    await transport1.start();
    await transport2.start();

    // Transport2 connects to transport1
    const peerConnected = new Promise((resolve) => {
      transport1.once('peerConnected', resolve);
    });

    await transport2.connectToPeer('127.0.0.1', 19005);
    const connectedPeer = await peerConnected;

    assert.strictEqual(connectedPeer.peerId, identity2.peerId);
    assert.strictEqual(transport1.getConnectedPeers().length, 1);
  });

  it('rejects connections from untrusted peers', async () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19007, useTls: false });
    transport2 = new MeshTransport({ identity: identity2, port: 19008, useTls: false });

    // Only transport2 trusts transport1, but transport1 does NOT trust transport2
    transport2.addTrustedPeer(identity1.peerId, identity1.publicKey);

    await transport1.start();
    await transport2.start();

    await assert.rejects(
      () => transport2.connectToPeer('127.0.0.1', 19007),
      (err) => {
        assert.ok(err.message.includes('not trusted') || err.message.includes('timeout'));
        return true;
      }
    );
  });

  it('sends and receives messages between peers', async () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19009, useTls: false });
    transport2 = new MeshTransport({ identity: identity2, port: 19010, useTls: false });

    transport1.addTrustedPeer(identity2.peerId, identity2.publicKey);
    transport2.addTrustedPeer(identity1.peerId, identity1.publicKey);

    await transport1.start();
    await transport2.start();

    await transport2.connectToPeer('127.0.0.1', 19009);

    // Wait for both sides to register the connection
    await new Promise((resolve) => setTimeout(resolve, 100));

    const messageReceived = new Promise((resolve) => {
      transport1.once('peerMessage', resolve);
    });

    transport2.send(identity1.peerId, {
      method: 'test.hello',
      params: { greeting: 'hi from node B' }
    });

    const msg = await messageReceived;
    assert.strictEqual(msg.from, identity2.peerId);
    assert.strictEqual(msg.payload.method, 'test.hello');
    assert.strictEqual(msg.payload.params.greeting, 'hi from node B');
  });

  it('throws when sending to disconnected peer', () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19011, useTls: false });

    assert.throws(
      () => transport1.send('kl-nonexistent', { method: 'test' }),
      (err) => {
        assert.ok(err.message.includes('not connected'));
        return true;
      }
    );
  });

  it('sendRpc sends and receives RPC response', async () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19012, useTls: false });
    transport2 = new MeshTransport({ identity: identity2, port: 19013, useTls: false });

    transport1.addTrustedPeer(identity2.peerId, identity2.publicKey);
    transport2.addTrustedPeer(identity1.peerId, identity1.publicKey);

    await transport1.start();
    await transport2.start();

    await transport2.connectToPeer('127.0.0.1', 19012);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Transport1 handles incoming RPC and responds
    transport1.on('peerMessage', (msg) => {
      if (msg.payload.method === 'echo') {
        transport1.sendRpcResponse(
          msg.from,
          msg.payload.id,
          { echoed: msg.payload.params.text }
        );
      }
    });

    const result = await transport2.sendRpc(identity1.peerId, 'echo', { text: 'hello' });
    assert.deepStrictEqual(result, { echoed: 'hello' });
  });

  it('connects over TLS with self-signed certs', async () => {
    // Use TLS-enabled transports (default behavior in production)
    transport1 = new MeshTransport({ identity: identity1, port: 19014, useTls: true });
    transport2 = new MeshTransport({ identity: identity2, port: 19015, useTls: true });

    transport1.addTrustedPeer(identity2.peerId, identity2.publicKey, {
      displayName: 'Node B',
      tlsFingerprint: identity2.tlsFingerprint
    });
    transport2.addTrustedPeer(identity1.peerId, identity1.publicKey, {
      displayName: 'Node A',
      tlsFingerprint: identity1.tlsFingerprint
    });

    await transport1.start();
    await transport2.start();

    const peerConnected = new Promise((resolve) => {
      transport1.once('peerConnected', resolve);
    });

    await transport2.connectToPeer('127.0.0.1', 19014);
    const connectedPeer = await peerConnected;

    assert.strictEqual(connectedPeer.peerId, identity2.peerId);
    assert.strictEqual(connectedPeer.tlsVerified, true);
    assert.strictEqual(transport1.getConnectedPeers().length, 1);
    assert.strictEqual(transport1.getConnectedPeers()[0].tlsVerified, true);
  });

  it('sends messages over TLS connection', async () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19016, useTls: true });
    transport2 = new MeshTransport({ identity: identity2, port: 19017, useTls: true });

    transport1.addTrustedPeer(identity2.peerId, identity2.publicKey, {
      tlsFingerprint: identity2.tlsFingerprint
    });
    transport2.addTrustedPeer(identity1.peerId, identity1.publicKey, {
      tlsFingerprint: identity1.tlsFingerprint
    });

    await transport1.start();
    await transport2.start();

    await transport2.connectToPeer('127.0.0.1', 19016);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const messageReceived = new Promise((resolve) => {
      transport1.once('peerMessage', resolve);
    });

    transport2.send(identity1.peerId, {
      method: 'secure.hello',
      params: { secret: 'encrypted over TLS' }
    });

    const msg = await messageReceived;
    assert.strictEqual(msg.payload.method, 'secure.hello');
    assert.strictEqual(msg.payload.params.secret, 'encrypted over TLS');
  });
});
