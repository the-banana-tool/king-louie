const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { MeshIdentity } = require('../src/mesh/mesh-identity');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { MeshPairing, WORDLIST } = require('../src/mesh/mesh-pairing');
const { wrapHandler } = require('../src/ipc/wrap-handler');
const { registerMeshHandlers } = require('../src/ipc/mesh-handlers');

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

  describe('IPC handler integration', () => {
    // Simulates the full IPC path: handler → wrapHandler → renderer unwrap

    function createIpcMainMock() {
      const handlers = new Map();
      return {
        handlers,
        handle(channel, handler) { handlers.set(channel, handler); }
      };
    }

    it('MESH_PAIR_START returns code wrapped correctly for renderer', async () => {
      const portA = nextPort();
      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      const ipcMain = createIpcMainMock();
      registerMeshHandlers(ipcMain, {
        getMeshContext: () => ({
          identity: identityA,
          transport: transportA,
          pairing: pairingA,
          discovery: { isAvailable: () => false, getDiscoveredPeers: () => [] },
          remoteControl: { getStatus: () => ({}) },
          swarm: { listSwarms: () => [] }
        }),
        getStore: () => ({ get: () => null, set: () => {} })
      });

      const handler = ipcMain.handlers.get('mesh:pairStart');
      assert.ok(handler, 'mesh:pairStart handler should be registered');

      const result = await handler({});
      // wrapHandler wraps as { ok: true, data: { pairingId, code } }
      assert.strictEqual(result.ok, true);
      assert.ok(result.data.pairingId, 'should have pairingId');
      assert.ok(result.data.code, 'should have code');
      assert.strictEqual(result.data.code.split(' ').length, 6);

      // Renderer unwraps as: const result = raw?.data || raw
      const rendererResult = result.data;
      assert.ok(rendererResult.code, 'renderer should be able to read code from .data');
    });

    it('MESH_PAIR_ACCEPT returns peerId and displayName wrapped for renderer', async () => {
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

      const ipcMain = createIpcMainMock();
      registerMeshHandlers(ipcMain, {
        getMeshContext: () => ({
          identity: identityB,
          transport: transportB,
          pairing: pairingB,
          discovery: { isAvailable: () => false, getDiscoveredPeers: () => [] },
          remoteControl: { getStatus: () => ({}) },
          swarm: { listSwarms: () => [] }
        }),
        getStore: () => ({ get: () => null, set: () => {} })
      });

      const handler = ipcMain.handlers.get('mesh:pairAccept');
      const result = await handler({}, { code, address: '127.0.0.1', port: portA });

      // wrapHandler wraps as { ok: true, data: { peerId, displayName } }
      assert.strictEqual(result.ok, true);

      // Renderer does: const result = raw?.data || raw
      const rendererResult = result.data;
      assert.strictEqual(rendererResult.peerId, identityA.peerId, 'renderer should see peerId');
      assert.strictEqual(rendererResult.displayName, 'Node A', 'renderer should see displayName');

      // Verify the exact template string the renderer uses
      const displayText = `Paired with ${rendererResult.displayName || rendererResult.peerId}!`;
      assert.ok(!displayText.includes('undefined'), `display text should not contain undefined, got: "${displayText}"`);
    });

    it('MESH_STATUS returns enabled:true wrapped for renderer', async () => {
      const portA = nextPort();
      transportA = new MeshTransport({ identity: identityA, port: portA, useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      const ipcMain = createIpcMainMock();
      registerMeshHandlers(ipcMain, {
        getMeshContext: () => ({
          identity: identityA,
          transport: transportA,
          pairing: pairingA,
          discovery: { isAvailable: () => false, getDiscoveredPeers: () => [] },
          remoteControl: { getStatus: () => ({}) },
          swarm: { listSwarms: () => [] }
        }),
        getStore: () => ({ get: () => null, set: () => {} })
      });

      const handler = ipcMain.handlers.get('mesh:status');
      const result = await handler({});

      assert.strictEqual(result.ok, true);

      // Renderer does: const status = result?.data || result
      const status = result.data;
      assert.strictEqual(status.enabled, true, 'renderer should see enabled: true via .data');
      assert.strictEqual(status.peerId, identityA.peerId);
    });

    it('MESH_STATUS returns enabled:false when meshContext is null', async () => {
      const ipcMain = createIpcMainMock();
      registerMeshHandlers(ipcMain, {
        getMeshContext: () => null,
        getStore: () => ({ get: () => null, set: () => {} })
      });

      const handler = ipcMain.handlers.get('mesh:status');
      const result = await handler({});

      // wrapHandler wraps { enabled: false } as { ok: true, data: { enabled: false } }
      assert.strictEqual(result.ok, true);

      // Renderer does: const status = result?.data || result
      const status = result.data;
      assert.strictEqual(status.enabled, false);
    });

    it('MESH_PAIR_ACCEPT error is wrapped as ok:false with error message', async () => {
      const ipcMain = createIpcMainMock();
      registerMeshHandlers(ipcMain, {
        getMeshContext: () => null,
        getStore: () => ({ get: () => null, set: () => {} })
      });

      const handler = ipcMain.handlers.get('mesh:pairAccept');
      const result = await handler({}, { code: 'test', address: '1.2.3.4', port: 18791 });

      // When mesh is not enabled, handler throws and wrapHandler catches it
      assert.strictEqual(result.ok, false);
      assert.ok(result.error, 'should have error message');
      assert.ok(result.error.includes('not enabled'), `error should mention not enabled, got: "${result.error}"`);

      // Renderer does: const result = raw?.data || raw
      // When ok:false, data is undefined, so it falls back to raw
      const rendererResult = result.data || result;
      // rendererResult.peerId would be undefined → "Paired with undefined"
      // This is the bug path — renderer should check result.ok first
      assert.strictEqual(rendererResult.peerId, undefined, 'peerId should be undefined on error');
    });
  });

  describe('acceptCode result shape', () => {
    it('returns all expected fields for renderer consumption', async () => {
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
      const peerInfo = await pairingB.acceptCode(code, '127.0.0.1', portA);

      // These are the fields the IPC handler passes through
      assert.ok(peerInfo.peerId, 'must have peerId');
      assert.strictEqual(typeof peerInfo.peerId, 'string');
      assert.ok(peerInfo.peerId.startsWith('kl-'), 'peerId should start with kl-');
      assert.strictEqual(typeof peerInfo.displayName, 'string');
      assert.ok(peerInfo.publicKey, 'must have publicKey');
      assert.ok(peerInfo.address, 'must have address');
      assert.ok(peerInfo.port, 'must have port');
    });

    it('both sides store TLS fingerprint after TLS pairing', async () => {
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
      await pairingB.acceptCode(code, '127.0.0.1', portA);

      // Responder (B) should have A's fingerprint
      const trustedOnB = transportB.trustedPeers.get(identityA.peerId);
      assert.ok(trustedOnB.tlsFingerprint, 'B should store A\'s TLS fingerprint');
      assert.strictEqual(trustedOnB.tlsFingerprint, identityA.tlsFingerprint);

      // Initiator (A) should have B's fingerprint
      const trustedOnA = transportA.trustedPeers.get(identityB.peerId);
      assert.ok(trustedOnA.tlsFingerprint, 'A should store B\'s TLS fingerprint');
      assert.strictEqual(trustedOnA.tlsFingerprint, identityB.tlsFingerprint);
    });
  });

  describe('auto-connect after pairing', () => {
    it('paired peers can auto-connect and appear as connected', async () => {
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
      await pairingB.acceptCode(code, '127.0.0.1', portA);

      // After pairing, peers are trusted but NOT connected
      assert.strictEqual(transportA.getConnectedPeers().length, 0, 'no connected peers yet');
      assert.strictEqual(transportB.getConnectedPeers().length, 0, 'no connected peers yet');
      assert.ok(transportA.trustedPeers.has(identityB.peerId), 'but B is trusted');
      assert.ok(transportB.trustedPeers.has(identityA.peerId), 'but A is trusted');

      // Simulate what the IPC handler should do: auto-connect after pairing
      const peerConnectedOnA = new Promise((resolve) => {
        transportA.once('peerConnected', resolve);
      });

      await transportB.connectToPeer('127.0.0.1', portA);
      await peerConnectedOnA;

      assert.strictEqual(transportA.getConnectedPeers().length, 1, 'A should have 1 connected peer');
      assert.strictEqual(transportB.getConnectedPeers().length, 1, 'B should have 1 connected peer');
      assert.strictEqual(transportA.getConnectedPeers()[0].peerId, identityB.peerId);
      assert.strictEqual(transportB.getConnectedPeers()[0].peerId, identityA.peerId);
    });

    it('getConnectedPeers returns displayName after pairing + connect', async () => {
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
      await pairingB.acceptCode(code, '127.0.0.1', portA);

      const peerConnected = new Promise((r) => transportA.once('peerConnected', r));
      await transportB.connectToPeer('127.0.0.1', portA);
      await peerConnected;

      // The status handler uses getConnectedPeers() — verify it has the data
      const peersOnA = transportA.getConnectedPeers();
      assert.strictEqual(peersOnA[0].peerId, identityB.peerId);
      assert.strictEqual(peersOnA[0].displayName, 'Node B');
    });
  });

  describe('secret derivation consistency', () => {
    it('generateCode and acceptCode derive the same HMAC secret', () => {
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      const { code } = pairingA.generateCode();
      const pending = Array.from(pairingA.pendingPairings.values())[0];

      // acceptCode lowercases the code before hashing
      const acceptSecret = crypto.createHash('sha256').update(code.trim().toLowerCase()).digest();

      // The wordlist is all lowercase, so these should match
      assert.ok(pending.secret.equals(acceptSecret),
        'initiator and responder should derive the same secret from the same code');
    });

    it('different codes produce different secrets', () => {
      transportA = new MeshTransport({ identity: identityA, port: nextPort(), useTls: false });
      pairingA = new MeshPairing(identityA, transportA);

      pairingA.generateCode();
      pairingA.generateCode();

      const pairings = Array.from(pairingA.pendingPairings.values());
      assert.ok(!pairings[0].secret.equals(pairings[1].secret),
        'different codes should produce different secrets');
    });
  });
});
