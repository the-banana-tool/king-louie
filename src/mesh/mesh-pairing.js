const crypto = require('crypto');
const WebSocket = require('ws');
const { canonicalize } = require('../platform/jcs');

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
const NONCE_RE = /^[0-9a-f]{32}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;

// Each side proves it knows the code with
//   HMAC-SHA256(secret, nonce || JCS(identity))
// over the whole identity object it presents in the same message (key, peer
// id, TLS fingerprint, display name, capabilities, node id and name — every
// field as sent). An on-path attacker who forwards a proof cannot change any
// of it: the code is exchanged out of band, so it cannot compute a proof over
// anything else. The nonce is fixed-length hex, so the concatenation is
// unambiguous. (A peer running the older, unbound proof fails closed against
// this one: its proofs never verify.)
function pairingProof(secret, nonce, identity) {
  return crypto.createHmac('sha256', secret).update(nonce).update(canonicalize(identity)).digest('hex');
}

// The identity exactly as it will arrive: what JSON carries (undefined
// fields dropped), so both ends canonicalize the same object.
function wireIdentity(identity) {
  return JSON.parse(JSON.stringify(identity));
}

// Recomputes the proof over the identity actually received. Anything
// malformed is simply "no match", never a throw.
function proofMatches(secret, nonce, identity, proof) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return false;
  if (typeof proof !== 'string' || !PROOF_RE.test(proof)) return false;
  if (!identity || typeof identity !== 'object') return false;
  if (typeof identity.publicKey !== 'string' || typeof identity.peerId !== 'string') return false;
  const fp = identity.tlsFingerprint;
  if (fp !== undefined && fp !== null && typeof fp !== 'string') return false;
  let expected;
  try {
    expected = pairingProof(secret, nonce, identity);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'));
}

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

      // The certificate the far side actually served, when TLS is on. The
      // caller compares it with the fingerprint the peer claims (pair.js).
      let servedTlsFingerprint = null;

      ws.on('open', () => {
        if (useTls && ws._socket && typeof ws._socket.getPeerCertificate === 'function') {
          const peerCert = ws._socket.getPeerCertificate(true);
          if (peerCert && peerCert.raw) {
            servedTlsFingerprint = crypto.createHash('sha256').update(peerCert.raw).digest('hex');
          }
        }
        const nonce = crypto.randomBytes(16).toString('hex');
        const identity = wireIdentity(this.identity.getPublicIdentity());

        ws.send(JSON.stringify({
          type: 'pair:request',
          pairingId,
          nonce,
          proof: pairingProof(secret, nonce, identity),
          identity
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);

          if (msg.type === 'pair:accept') {
            if (!proofMatches(secret, msg.nonce, msg.identity, msg.proof)) {
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
              servedTlsFingerprint,
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
        if (proofMatches(pairing.secret, nonce, remoteIdentity, proof)) {
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

    // Send back our proof, bound to the identity we answer with.
    const responseNonce = crypto.randomBytes(16).toString('hex');
    const ownIdentity = wireIdentity(this.identity.getPublicIdentity());

    ws.send(JSON.stringify({
      type: 'pair:accept',
      nonce: responseNonce,
      proof: pairingProof(pairing.secret, responseNonce, ownIdentity),
      identity: ownIdentity
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

module.exports = { MeshPairing, WORDLIST, pairingProof };
