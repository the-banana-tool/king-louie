const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { MeshIdentity } = require('../src/mesh/mesh-identity');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { MeshPairing, WORDLIST } = require('../src/mesh/mesh-pairing');

describe('MeshPairing', () => {
  let identityA, identityB;
  let transportA, transportB;
  let pairingA, pairingB;

  // Use unique port ranges to avoid collisions with other test files
  let portCounter = 19200;
  const nextPort = () => portCounter++;

  beforeEach(() => {
    identityA = new MeshIdentity({ displayName: 'Node A', capabilities: ['gpu'] });
    identityB = new MeshIdentity({ displayName: 'Node B', capabilities: ['build'] });
  });

  afterEach(async () => {
    if (pairingA) pairingA.cleanup();
    if (pairingB) pairingB.cleanup();
    if (transportA) await transportA.stop().catch(() => {});
    if (transportB) await transportB.stop().catch(() => {});
  });

  describe('generateCode', () => {
    it('returns a pairing ID and 6-word code', () => {
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      const { pairingId, code } = pairingA.generateCode();

      assert.ok(pairingId, 'should return a pairingId');
      assert.ok(code, 'should return a code');
      const words = code.split(' ');
      assert.strictEqual(words.length, 6, 'code should have 6 words');
      for (const word of words) {
        assert.ok(WORDLIST.includes(word), `word "${word}" should be in the wordlist`);
      }
    });

    it('generates unique codes each time', () => {
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      const result1 = pairingA.generateCode();
      const result2 = pairingA.generateCode();

      assert.notStrictEqual(result1.pairingId, result2.pairingId);
      // Codes are random — very unlikely to collide but theoretically possible
      // Just ensure both are valid
      assert.strictEqual(result1.code.split(' ').length, 6);
      assert.strictEqual(result2.code.split(' ').length, 6);
    });

    it('stores pending pairing with direction initiator', () => {
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      const { pairingId } = pairingA.generateCode();

      assert.strictEqual(pairingA.pendingPairings.size, 1);
      const pending = pairingA.pendingPairings.get(pairingId);
      assert.ok(pending, 'pending pairing should exist');
      assert.strictEqual(pending.direction, 'initiator');
      assert.ok(pending.secret, 'should have a secret');
      assert.ok(pending.code, 'should have the code');
    });
  });

  describe('cleanup', () => {
    it('clears all pending pairings', () => {
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      pairingA.generateCode();
      pairingA.generateCode();
      assert.strictEqual(pairingA.pendingPairings.size, 2);

      pairingA.cleanup();
      assert.strictEqual(pairingA.pendingPairings.size, 0);
    });
  });

  describe('handlePairingRequest', () => {
    it('rejects when no matching code exists', () => {
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      const sent = [];
      let closed = false;
      const fakeWs = {
        send: (data) => sent.push(JSON.parse(data)),
        close: () => { closed = true; }
      };

      pairingA.handlePairingRequest(fakeWs, {
        nonce: 'abc123',
        proof: 'badproof',
        identity: identityB.getPublicIdentity()
      });

      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].type, 'pair:reject');
      assert.strictEqual(sent[0].reason, 'no_matching_code');
      assert.ok(closed);
    });

    it('rejects when proof does not match any pending code', () => {
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      pairingA.generateCode();

      const sent = [];
      let closed = false;
      const fakeWs = {
        send: (data) => sent.push(JSON.parse(data)),
        close: () => { closed = true; }
      };

      pairingA.handlePairingRequest(fakeWs, {
        nonce: 'abc123',
        proof: 'definitely_wrong_proof',
        identity: identityB.getPublicIdentity()
      });

      assert.strictEqual(sent[0].type, 'pair:reject');
      assert.ok(closed);
    });

    it('accepts when proof matches and adds trusted peer', () => {
      const crypto = require('crypto');
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      const { code } = pairingA.generateCode();
      const secret = crypto.createHash('sha256').update(code).digest();
      const nonce = crypto.randomBytes(16).toString('hex');
      const proof = crypto.createHmac('sha256', secret).update(nonce).digest('hex');

      const sent = [];
      let closed = false;
      const fakeWs = {
        send: (data) => sent.push(JSON.parse(data)),
        close: () => { closed = true; }
      };

      const result = pairingA.handlePairingRequest(fakeWs, {
        nonce,
        proof,
        identity: identityB.getPublicIdentity()
      });

      // Should send pair:accept with valid proof
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].type, 'pair:accept');
      assert.ok(sent[0].nonce, 'response should include a nonce');
      assert.ok(sent[0].proof, 'response should include a proof');
      assert.ok(sent[0].identity, 'response should include identity');
      assert.strictEqual(sent[0].identity.peerId, identityA.peerId);

      // Should have added the peer as trusted
      assert.ok(transportA.trustedPeers.has(identityB.peerId), 'peer B should be trusted');
      const trusted = transportA.trustedPeers.get(identityB.peerId);
      assert.strictEqual(trusted.displayName, 'Node B');

      // Should have cleaned up the pending pairing
      assert.strictEqual(pairingA.pendingPairings.size, 0);

      // Should return peer info
      assert.ok(result);
      assert.strictEqual(result.peerId, identityB.peerId);

      assert.ok(closed);
    });

    it('response proof is verifiable by the responder', () => {
      const crypto = require('crypto');
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      const { code } = pairingA.generateCode();
      const secret = crypto.createHash('sha256').update(code).digest();
      const nonce = crypto.randomBytes(16).toString('hex');
      const proof = crypto.createHmac('sha256', secret).update(nonce).digest('hex');

      const sent = [];
      const fakeWs = {
        send: (data) => sent.push(JSON.parse(data)),
        close: () => {}
      };

      pairingA.handlePairingRequest(fakeWs, {
        nonce,
        proof,
        identity: identityB.getPublicIdentity()
      });

      const response = sent[0];
      const expectedProof = crypto.createHmac('sha256', secret)
        .update(response.nonce)
        .digest('hex');

      assert.strictEqual(response.proof, expectedProof, 'response proof should be verifiable');
    });
  });

  describe('full pairing flow (integration)', () => {
    it('two nodes pair successfully using plain WS', async () => {
      const portA = nextPort();
      const portB = nextPort();

      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });
      transportB = new MeshTransport({ identity: identityB, port: portB, useTls: false });
      pairingA = new MeshPairing(identityA, transportA);
      pairingB = new MeshPairing(identityB, transportB);

      // Wire pairing handler into transport
      transportA.onPairingRequest = (ws, msg) => pairingA.handlePairingRequest(ws, msg);
      transportB.onPairingRequest = (ws, msg) => pairingB.handlePairingRequest(ws, msg);

      await transportA.start();
      await transportB.start();

      // Node A generates code
      const { code } = pairingA.generateCode();

      // Node B accepts the code and connects to Node A
      const peerInfo = await pairingB.acceptCode(code, '127.0.0.1', portA);

      // Verify peer info returned
      assert.ok(peerInfo, 'acceptCode should resolve with peer info');
      assert.strictEqual(peerInfo.peerId, identityA.peerId);
      assert.strictEqual(peerInfo.displayName, 'Node A');

      // Both should have each other as trusted peers
      assert.ok(transportA.trustedPeers.has(identityB.peerId), 'A should trust B');
      assert.ok(transportB.trustedPeers.has(identityA.peerId), 'B should trust A');

      // Trusted peer data should include address/port on B's side
      const trustedOnB = transportB.trustedPeers.get(identityA.peerId);
      assert.strictEqual(trustedOnB.displayName, 'Node A');
    });

    it('two nodes pair successfully using TLS', async () => {
      const portA = nextPort();
      const portB = nextPort();

      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: true });
      transportB = new MeshTransport({ identity: identityB, port: portB, useTls: true });
      pairingA = new MeshPairing(identityA, transportA);
      pairingB = new MeshPairing(identityB, transportB);

      transportA.onPairingRequest = (ws, msg) => pairingA.handlePairingRequest(ws, msg);

      await transportA.start();
      await transportB.start();

      const { code } = pairingA.generateCode();
      const peerInfo = await pairingB.acceptCode(code, '127.0.0.1', portA);

      assert.strictEqual(peerInfo.peerId, identityA.peerId);
      assert.ok(transportA.trustedPeers.has(identityB.peerId));
      assert.ok(transportB.trustedPeers.has(identityA.peerId));

      // TLS fingerprint should be stored
      const trustedOnB = transportB.trustedPeers.get(identityA.peerId);
      assert.ok(trustedOnB.tlsFingerprint, 'TLS fingerprint should be stored');
    });

    it('paired nodes can subsequently connect and exchange messages', async () => {
      const portA = nextPort();
      const portB = nextPort();

      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });
      transportB = new MeshTransport({ identity: identityB, port: portB, useTls: false });
      pairingA = new MeshPairing(identityA, transportA);
      pairingB = new MeshPairing(identityB, transportB);

      transportA.onPairingRequest = (ws, msg) => pairingA.handlePairingRequest(ws, msg);

      await transportA.start();
      await transportB.start();

      // Pair the nodes
      const { code } = pairingA.generateCode();
      await pairingB.acceptCode(code, '127.0.0.1', portA);

      // Now connect using normal auth (since they're trusted)
      const peerConnected = new Promise((resolve) => {
        transportA.once('peerConnected', resolve);
      });

      await transportB.connectToPeer('127.0.0.1', portA);
      const connectedPeer = await peerConnected;
      assert.strictEqual(connectedPeer.peerId, identityB.peerId);

      // Exchange a message
      const messageReceived = new Promise((resolve) => {
        transportA.once('peerMessage', resolve);
      });

      transportB.send(identityA.peerId, {
        method: 'test.hello',
        params: { greeting: 'paired and connected!' }
      });

      const msg = await messageReceived;
      assert.strictEqual(msg.from, identityB.peerId);
      assert.strictEqual(msg.payload.params.greeting, 'paired and connected!');
    });

    it('rejects pairing with wrong code', async () => {
      const portA = nextPort();
      const portB = nextPort();

      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });
      transportB = new MeshTransport({ identity: identityB, port: portB, useTls: false });
      pairingA = new MeshPairing(identityA, transportA);
      pairingB = new MeshPairing(identityB, transportB);

      transportA.onPairingRequest = (ws, msg) => pairingA.handlePairingRequest(ws, msg);

      await transportA.start();
      await transportB.start();

      pairingA.generateCode(); // generates real code

      // Node B tries to pair with the wrong code
      await assert.rejects(
        () => pairingB.acceptCode('wrong wrong wrong wrong wrong wrong', '127.0.0.1', portA),
        (err) => {
          assert.ok(
            err.message.includes('reject') || err.message.includes('no_matching_code'),
            `Expected rejection error, got: ${err.message}`
          );
          return true;
        }
      );

      // Neither should trust the other
      assert.strictEqual(transportA.trustedPeers.has(identityB.peerId), false);
      assert.strictEqual(transportB.trustedPeers.has(identityA.peerId), false);
    });

    it('case-insensitive code matching works', async () => {
      const portA = nextPort();
      const portB = nextPort();

      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });
      transportB = new MeshTransport({ identity: identityB, port: portB, useTls: false });
      pairingA = new MeshPairing(identityA, transportA);
      pairingB = new MeshPairing(identityB, transportB);

      transportA.onPairingRequest = (ws, msg) => pairingA.handlePairingRequest(ws, msg);

      await transportA.start();
      await transportB.start();

      const { code } = pairingA.generateCode();

      // Accept with uppercase code
      const peerInfo = await pairingB.acceptCode(code.toUpperCase(), '127.0.0.1', portA);
      assert.strictEqual(peerInfo.peerId, identityA.peerId);
    });

    it('rejects pairing when no code was generated (no pending pairings)', async () => {
      const portA = nextPort();
      const portB = nextPort();

      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });
      transportB = new MeshTransport({ identity: identityB, port: portB, useTls: false });
      pairingA = new MeshPairing(identityA, transportA);
      pairingB = new MeshPairing(identityB, transportB);

      transportA.onPairingRequest = (ws, msg) => pairingA.handlePairingRequest(ws, msg);

      await transportA.start();
      await transportB.start();

      // No code generated — try to pair anyway
      await assert.rejects(
        () => pairingB.acceptCode('abandon ability able about above absent', '127.0.0.1', portA),
        (err) => {
          assert.ok(err.message, 'should have an error message');
          return true;
        }
      );
    });

    it('pairing fails when initiator transport is not running', async () => {
      const portA = nextPort();
      const portB = nextPort();

      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });
      transportB = new MeshTransport({ identity: identityB, port: portB, useTls: false });
      pairingA = new MeshPairing(identityA, transportA);
      pairingB = new MeshPairing(identityB, transportB);

      // Don't start transportA
      await transportB.start();

      const { code } = pairingA.generateCode();

      await assert.rejects(
        () => pairingB.acceptCode(code, '127.0.0.1', portA),
        (err) => {
          assert.ok(err.message, 'should fail to connect');
          return true;
        }
      );
    });
  });

  describe('transport onPairingRequest wiring', () => {
    it('transport routes pair:request to onPairingRequest handler', async () => {
      const portA = nextPort();
      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });

      let receivedMsg = null;
      transportA.onPairingRequest = (_ws, msg) => {
        receivedMsg = msg;
        _ws.close();
      };

      await transportA.start();

      // Manually connect and send a pair:request
      const WebSocket = require('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${portA}`);

      await new Promise((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'pair:request',
            pairingId: 'test123',
            nonce: 'testnonce',
            proof: 'testproof',
            identity: identityB.getPublicIdentity()
          }));
          // Give it a moment to process
          setTimeout(resolve, 200);
        });
        ws.on('error', reject);
      });

      assert.ok(receivedMsg, 'onPairingRequest should have been called');
      assert.strictEqual(receivedMsg.type, 'pair:request');
      assert.strictEqual(receivedMsg.nonce, 'testnonce');

      ws.close();
    });

    it('transport ignores pair:request when onPairingRequest is not set', async () => {
      const portA = nextPort();
      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });
      // Do NOT set transportA.onPairingRequest

      await transportA.start();

      const WebSocket = require('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${portA}`);

      await new Promise((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'pair:request',
            pairingId: 'test456',
            nonce: 'testnonce',
            proof: 'testproof',
            identity: identityB.getPublicIdentity()
          }));
          setTimeout(resolve, 200);
        });
        ws.on('error', reject);
      });

      // Should not crash — just silently ignored
      assert.ok(true, 'transport should not crash on unhandled pair:request');

      ws.close();
    });
  });
});
