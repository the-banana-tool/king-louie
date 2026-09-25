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

  it('disconnectPeer closes a connected peer and emits peerDisconnected exactly once', async () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19040, useTls: false });
    transport2 = new MeshTransport({ identity: identity2, port: 19041, useTls: false });
    transport1.addTrustedPeer(identity2.peerId, identity2.publicKey);
    transport2.addTrustedPeer(identity1.peerId, identity1.publicKey);
    await transport1.start();
    await transport2.start();
    const connected = new Promise((resolve) => transport1.once('peerConnected', resolve));
    await transport2.connectToPeer('127.0.0.1', transport1.port);
    await connected;
    assert.ok(transport1.getPeer(identity2.peerId));

    const events = [];
    transport1.on('peerDisconnected', (info) => events.push(info));
    const disconnected = new Promise((resolve) => transport1.once('peerDisconnected', resolve));
    assert.strictEqual(transport1.disconnectPeer(identity2.peerId), true);
    await disconnected;
    // A brief wait: if the close listener somehow ran twice (the bug the
    // heartbeat-timeout path used to have), a second event would land here.
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(transport1.getPeer(identity2.peerId), null);
    // disconnectPeer on a peer that isn't connected is a no-op, not a throw.
    assert.strictEqual(transport1.disconnectPeer('kl-nonexistent'), false);
  });

  it('a late close of an old socket does not evict a newer live peer for the same id', () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19042, useTls: false });
    const oldPeerInfo = { peerId: identity2.peerId, ws: { close() {}, terminate() {} }, address: null, port: null };
    const newPeerInfo = { peerId: identity2.peerId, ws: { close() {}, terminate() {} }, address: null, port: null };
    // Simulate a reconnect: the new connection has already been promoted...
    transport1.peers.set(identity2.peerId, newPeerInfo);
    const events = [];
    transport1.on('peerDisconnected', (info) => events.push(info));
    // ...when the OLD socket's close handler (bound over oldPeerInfo, back
    // when it was promoted) finally fires.
    transport1._handlePeerDisconnect(identity2.peerId, oldPeerInfo);
    assert.strictEqual(transport1.peers.get(identity2.peerId), newPeerInfo, 'the live peer must still be tracked');
    assert.deepStrictEqual(events, [], 'a stale close must not emit peerDisconnected for the peer that replaced it');

    // A close for the CURRENT peer object still works normally.
    transport1._handlePeerDisconnect(identity2.peerId, newPeerInfo);
    assert.strictEqual(transport1.peers.has(identity2.peerId), false);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].peerId, identity2.peerId);
  });

  it('removeTrustedPeer emits peerDisconnected exactly once on the removing side (and once on the remote side)', async () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19043, useTls: false });
    transport2 = new MeshTransport({ identity: identity2, port: 19044, useTls: false });
    transport1.addTrustedPeer(identity2.peerId, identity2.publicKey);
    transport2.addTrustedPeer(identity1.peerId, identity1.publicKey);
    await transport1.start();
    await transport2.start();
    const connected = new Promise((resolve) => transport1.once('peerConnected', resolve));
    await transport2.connectToPeer('127.0.0.1', transport1.port);
    await connected;

    let removingSideEvents = 0;
    let remoteSideEvents = 0;
    transport1.on('peerDisconnected', () => { removingSideEvents += 1; });
    transport2.on('peerDisconnected', () => { remoteSideEvents += 1; });
    transport1.removeTrustedPeer(identity2.peerId);
    await new Promise((r) => setTimeout(r, 100));

    // Before this fix, deleting the peer from `peers` before its socket's
    // close event fired made the stale-socket guard in _handlePeerDisconnect
    // treat that close as a late echo and swallow it — removing a peer
    // never told the UI/gateway, and a link-rpc call to it would just wait
    // out its timeout instead of rejecting on disconnect.
    assert.strictEqual(removingSideEvents, 1);
    assert.strictEqual(remoteSideEvents, 1);
    assert.strictEqual(transport1.getPeer(identity2.peerId), null);
    assert.strictEqual(transport1.trustedPeers.has(identity2.peerId), false);
  });

  it('a real heartbeat timeout terminates the socket, disconnects exactly once via _checkHeartbeats, and falls back to the trusted address to redial an inbound peer', async () => {
    transport1 = new MeshTransport({ identity: identity1, port: 19045, useTls: false });
    transport2 = new MeshTransport({ identity: identity2, port: 19046, useTls: false });
    // identity2 dials INTO transport1, so transport1's own record of that
    // connection (peerInfo.address/port) is null — its trustedPeers entry is
    // the only place transport1 has an address to redial identity2 at.
    transport1.addTrustedPeer(identity2.peerId, identity2.publicKey, { address: '127.0.0.1', port: 19046 });
    transport2.addTrustedPeer(identity1.peerId, identity1.publicKey);
    await transport1.start();
    await transport2.start();
    const connected = new Promise((resolve) => transport1.once('peerConnected', resolve));
    await transport2.connectToPeer('127.0.0.1', transport1.port);
    await connected;

    const peer = transport1.getPeer(identity2.peerId);
    assert.ok(peer, 'the peer must be connected before driving the timeout');
    assert.equal(peer.address, null, 'this connection is inbound: peerInfo itself carries no address');
    // Back-date lastSeen instead of waiting out the real
    // HEARTBEAT_INTERVAL_MS/HEARTBEAT_TIMEOUT_MS, then drive the actual
    // per-tick timeout-detection method (not _handlePeerDisconnect) so the
    // real terminate() -> 'close' -> _handlePeerDisconnect path runs.
    peer.lastSeen = Date.now() - 91000;

    let events = 0;
    const disconnected = new Promise((resolve) => transport1.once('peerDisconnected', (info) => { events += 1; resolve(info); }));
    transport1._checkHeartbeats();
    const info = await disconnected;
    assert.strictEqual(info.reason, 'timeout');
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(events, 1, 'exactly one peerDisconnected for the timed-out peer');
    assert.strictEqual(transport1.getPeer(identity2.peerId), null);
    // The reconnect gate in _handlePeerDisconnect only reaches
    // _scheduleReconnect for a heartbeat timeout when peerInfo itself has no
    // address — proving it used trustedPeers' stored address, not the
    // (null) connection-level one, the way the original heartbeat code did
    // before it was consolidated onto _handlePeerDisconnect.
    assert.strictEqual(transport1.reconnectTimers.has(identity2.peerId), true);
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

  it('survives a malformed frame from an unauthenticated peer', async () => {
    const WebSocket = require('ws');
    transport1 = new MeshTransport({ identity: identity1, port: 0, useTls: false, host: '127.0.0.1' });
    await transport1.start();

    const ws = new WebSocket(`ws://127.0.0.1:${transport1.port}`);
    ws.on('error', () => {});
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    // Reserved bits set: `ws` raises 'error' on the server socket, and an
    // unauthenticated peer's socket had no 'error' listener at all.
    ws._socket.write(Buffer.from([0x70, 0x00]));
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.strictEqual(transport1.running, true);
    // The listener is still usable.
    const again = new WebSocket(`ws://127.0.0.1:${transport1.port}`);
    again.on('error', () => {});
    await new Promise((resolve, reject) => {
      again.once('open', resolve);
      again.once('error', reject);
    });
    again.close();
  });
});
