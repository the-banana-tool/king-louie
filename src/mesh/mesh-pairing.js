const crypto = require('crypto');
const WebSocket = require('ws');

// BIP39-inspired wordlist (256 words = 8 bits per word, 6 words = 48 bits of entropy)
const WORDLIST = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
  'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
  'across', 'action', 'actor', 'actual', 'adapt', 'address', 'adjust', 'admit',
  'advance', 'advice', 'afford', 'again', 'agent', 'agree', 'ahead', 'allow',
  'almost', 'alone', 'alpha', 'already', 'alter', 'always', 'amount', 'anchor',
  'ancient', 'anger', 'angle', 'animal', 'ankle', 'annual', 'answer', 'apart',
  'appear', 'apple', 'arena', 'army', 'arrow', 'artist', 'assume', 'attack',
  'attend', 'august', 'autumn', 'avocado', 'awake', 'aware', 'awful', 'bacon',
  'badge', 'balance', 'bamboo', 'banana', 'banner', 'barrel', 'basket', 'battle',
  'beach', 'beauty', 'become', 'before', 'begin', 'behind', 'believe', 'below',
  'bench', 'benefit', 'between', 'beyond', 'bird', 'bitter', 'blanket', 'blast',
  'bless', 'blind', 'blood', 'blossom', 'board', 'bonus', 'border', 'bottle',
  'bottom', 'bounce', 'brave', 'bread', 'breeze', 'brick', 'bridge', 'brief',
  'bring', 'broken', 'bronze', 'brother', 'brush', 'bubble', 'budget', 'buffalo',
  'burden', 'butter', 'cabin', 'cable', 'cactus', 'camera', 'campus', 'candle',
  'cannon', 'canyon', 'carbon', 'carpet', 'carry', 'castle', 'cattle', 'caught',
  'cause', 'cellar', 'cement', 'census', 'cereal', 'certain', 'chair', 'chapter',
  'cherry', 'chicken', 'chief', 'chimney', 'choice', 'chunk', 'circle', 'citizen',
  'civil', 'claim', 'classic', 'clean', 'clever', 'climb', 'clock', 'cloud',
  'cluster', 'coach', 'coconut', 'coffee', 'coil', 'collect', 'color', 'column',
  'combine', 'comfort', 'common', 'company', 'concert', 'connect', 'consider', 'control',
  'convert', 'copper', 'coral', 'corner', 'cotton', 'country', 'couple', 'course',
  'cousin', 'cover', 'coyote', 'crack', 'cradle', 'crane', 'cream', 'create',
  'credit', 'creek', 'cricket', 'crime', 'crisp', 'cross', 'crowd', 'cruel',
  'cruise', 'crunch', 'crush', 'crystal', 'cube', 'culture', 'curtain', 'curve',
  'custom', 'cycle', 'damage', 'dance', 'danger', 'daring', 'dash', 'daughter',
  'dawn', 'debate', 'decade', 'december', 'decide', 'decline', 'decorate', 'defense',
  'define', 'degree', 'delay', 'deliver', 'demand', 'denial', 'dentist', 'depend',
  'deposit', 'depth', 'deputy', 'derive', 'desert', 'design', 'destroy', 'detail',
  'detect', 'develop', 'device', 'diamond', 'diary', 'diesel', 'differ', 'digital',
  'dignity', 'dinner', 'dinosaur', 'direct', 'disease', 'dismiss', 'display', 'distance',
  'divide', 'doctor', 'dolphin', 'domain', 'donkey', 'donor', 'double', 'dragon'
];

const PAIRING_CODE_WORDS = 6;
const PAIRING_TIMEOUT_MS = 120000; // 2 minutes

class MeshPairing {
  // options.timeoutMs: how long a code stays valid and how long acceptCode
  // waits (default two minutes).
  constructor(identity, transport, { timeoutMs = PAIRING_TIMEOUT_MS } = {}) {
    this.identity = identity;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.pendingPairings = new Map();
    // Optional admit(remoteIdentity, meta) → null | reason: a last say on a
    // proof-valid pairing, asked before anything is trusted or answered, so
    // a refused peer gets pair:reject rather than a pair:accept taken back.
    this.admit = null;
  }

  generateCode(meta = {}) {
    const bytes = crypto.randomBytes(PAIRING_CODE_WORDS);
    const words = [];
    for (let i = 0; i < PAIRING_CODE_WORDS; i++) {
      words.push(WORDLIST[bytes[i]]);
    }
    const { pairingId, code } = this.addCode(words.join(' '), meta);
    return { pairingId, code };
  }

  // Registers a code made elsewhere (the relay's `relay code` CLI). `meta`
  // travels with the code and comes back on success; `meta.nodeName`, when
  // set, must equal the pairing node's name or the pairing is refused
  // (`name_mismatch`).
  addCode(code, meta = {}) {
    const normalized = String(code).trim().toLowerCase();
    const secret = crypto.createHash('sha256').update(normalized).digest();
    const pairingId = crypto.randomBytes(8).toString('hex');
    this.pendingPairings.set(pairingId, {
      code: normalized,
      secret,
      meta,
      createdAt: Date.now(),
      direction: 'initiator',
      timeout: setTimeout(() => {
        this.pendingPairings.delete(pairingId);
      }, this.timeoutMs)
    });
    return { pairingId, code: normalized, expiresAt: Date.now() + this.timeoutMs };
  }

  async acceptCode(code, peerAddress, peerPort) {
    const secret = crypto.createHash('sha256').update(code.trim().toLowerCase()).digest();
    const pairingId = crypto.randomBytes(8).toString('hex');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPairings.delete(pairingId);
        reject(new Error('Pairing timeout'));
      }, this.timeoutMs);

      this.pendingPairings.set(pairingId, {
        code: code.trim().toLowerCase(),
        secret,
        createdAt: Date.now(),
        direction: 'responder',
        timeout,
        resolve,
        reject
      });

      this._initiatePairingHandshake(pairingId, secret, peerAddress, peerPort)
        .catch((err) => {
          this.pendingPairings.delete(pairingId);
          clearTimeout(timeout);
          reject(err);
        });
    });
  }

  async _initiatePairingHandshake(pairingId, secret, address, port) {
    const useTls = this.transport.useTls;
    const protocol = useTls ? 'wss' : 'ws';
    const url = `${protocol}://${address}:${port}`;
    const wsOptions = useTls ? { rejectUnauthorized: false } : {};
    const ws = new WebSocket(url, wsOptions);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Pairing connection timeout'));
      }, 10000);

      ws.on('open', () => {
        const nonce = crypto.randomBytes(16).toString('hex');
        const proof = crypto.createHmac('sha256', secret)
          .update(nonce)
          .digest('hex');

        ws.send(JSON.stringify({
          type: 'pair:request',
          pairingId,
          nonce,
          proof,
          identity: this.identity.getPublicIdentity()
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);

          if (msg.type === 'pair:accept') {
            const expectedProof = crypto.createHmac('sha256', secret)
              .update(msg.nonce)
              .digest('hex');

            if (expectedProof !== msg.proof) {
              ws.close();
              clearTimeout(timeout);
              reject(new Error('Invalid pairing proof from peer'));
              return;
            }

            // Pairing successful - store peer
            clearTimeout(timeout);
            ws.close();

            const pending = this.pendingPairings.get(pairingId);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingPairings.delete(pairingId);
            }

            const peerInfo = {
              peerId: msg.identity.peerId,
              publicKey: msg.identity.publicKey,
              displayName: msg.identity.displayName,
              capabilities: msg.identity.capabilities,
              tlsFingerprint: msg.identity.tlsFingerprint || null,
              nodeId: msg.identity.nodeId || null,
              nodeName: msg.identity.nodeName || null,
              address,
              port
            };

            this.transport.addTrustedPeer(
              peerInfo.peerId,
              peerInfo.publicKey,
              {
                displayName: peerInfo.displayName,
                capabilities: peerInfo.capabilities,
                tlsFingerprint: peerInfo.tlsFingerprint,
                address,
                port
              }
            );

            if (pending && pending.resolve) {
              pending.resolve(peerInfo);
            }

            resolve(peerInfo);
          } else if (msg.type === 'pair:reject') {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(msg.reason || 'Pairing rejected'));
          }
        } catch (err) {
          clearTimeout(timeout);
          ws.close();
          reject(err);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  handlePairingRequest(ws, msg) {
    const { nonce, proof, identity: remoteIdentity } = msg;

    // Find a pending pairing from this side (initiator side)
    let matchedPairing = null;
    for (const [id, pairing] of this.pendingPairings) {
      if (pairing.direction === 'initiator') {
        const expectedProof = crypto.createHmac('sha256', pairing.secret)
          .update(nonce)
          .digest('hex');

        if (expectedProof === proof) {
          matchedPairing = { id, pairing };
          break;
        }
      }
    }

    if (!matchedPairing) {
      ws.send(JSON.stringify({ type: 'pair:reject', reason: 'no_matching_code' }));
      ws.close();
      return;
    }

    const { id: pairingId, pairing } = matchedPairing;
    const meta = pairing.meta || {};

    // A code issued for one node name cannot pair a node with another.
    if (meta.nodeName && remoteIdentity.nodeName !== meta.nodeName) {
      clearTimeout(pairing.timeout);
      this.pendingPairings.delete(pairingId);
      ws.send(JSON.stringify({ type: 'pair:reject', reason: 'name_mismatch' }));
      ws.close();
      return null;
    }

    if (typeof this.admit === 'function') {
      let reason;
      try {
        reason = this.admit(remoteIdentity || {}, meta);
      } catch {
        reason = 'refused';
      }
      if (reason) {
        clearTimeout(pairing.timeout);
        this.pendingPairings.delete(pairingId);
        ws.send(JSON.stringify({ type: 'pair:reject', reason: String(reason) }));
        ws.close();
        return null;
      }
    }

    // Send back our proof
    const responseNonce = crypto.randomBytes(16).toString('hex');
    const responseProof = crypto.createHmac('sha256', pairing.secret)
      .update(responseNonce)
      .digest('hex');

    ws.send(JSON.stringify({
      type: 'pair:accept',
      nonce: responseNonce,
      proof: responseProof,
      identity: this.identity.getPublicIdentity()
    }));

    // Store the peer
    clearTimeout(pairing.timeout);
    this.pendingPairings.delete(pairingId);

    const peerInfo = {
      peerId: remoteIdentity.peerId,
      publicKey: remoteIdentity.publicKey,
      displayName: remoteIdentity.displayName,
      capabilities: remoteIdentity.capabilities,
      tlsFingerprint: remoteIdentity.tlsFingerprint || null
    };

    this.transport.addTrustedPeer(
      peerInfo.peerId,
      peerInfo.publicKey,
      {
        displayName: peerInfo.displayName,
        capabilities: peerInfo.capabilities,
        tlsFingerprint: peerInfo.tlsFingerprint
      }
    );

    ws.close();
    return { ...peerInfo, nodeId: remoteIdentity.nodeId || null, nodeName: remoteIdentity.nodeName || null, meta };
  }

  cleanup() {
    for (const [id, pairing] of this.pendingPairings) {
      if (pairing.timeout) clearTimeout(pairing.timeout);
    }
    this.pendingPairings.clear();
  }
}

module.exports = { MeshPairing, WORDLIST };
