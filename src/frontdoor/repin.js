// The signed re-pin (fleet stage 4 §3.3.1): after `frontdoor rotate-tls-key`
// the front door signs kl.relay.repin with its Ed25519 identity and serves it
// at GET /v1/repin, so a phone that pinned the old mcp. key moves to the new
// one only on the front door's signed word.
//
// The new key is already being served when rotated() runs, so the envelope
// is published in memory, the relay's pin follows and the audit entry is
// written even when saving repin.json fails; that failure is thrown after.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('../approvals/approver-store');
const { buildRelayRepin } = require('./protocol/messages');
const { recordFrontDoorEvent } = require('./audit/own-ledger');

const log = createLogger('frontdoor/repin');

// repin.json is one small envelope; the data dir is service-writable.
const MAX_FILE_BYTES = 16 * 1024;
const ENVELOPE_KEYS = ['alg', 'kid', 'payload', 'sig'];

function readStored(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const env = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
    if (!ENVELOPE_KEYS.every((k) => typeof env[k] === 'string')) return null;
    return { alg: env.alg, kid: env.kid, payload: env.payload, sig: env.sig };
  } catch {
    return null; // no rotation yet, or nothing usable
  }
}

class RepinPublisher {
  constructor({ identity, publicUrl, file, auditLedger = null, onPinChanged = () => {} } = {}) {
    if (!identity || typeof identity.sign !== 'function') throw new TypeError('RepinPublisher needs the front door identity');
    if (typeof publicUrl !== 'string' || !publicUrl) throw new TypeError('RepinPublisher needs the public URL');
    if (typeof file !== 'string' || !file) throw new TypeError('RepinPublisher needs its repin.json path');
    this.identity = identity;
    this.publicUrl = publicUrl;
    this.file = file;
    this.auditLedger = auditLedger;
    this.onPinChanged = onPinChanged;
    // What is served is only ever what this key signed: the phone verifies
    // it, so a planted file can at worst fail that check.
    this.envelope = readStored(file);
  }

  current() {
    return this.envelope;
  }

  async rotated({ oldSpki, newSpki }) {
    const envelope = buildRelayRepin({ identity: this.identity, relay: this.publicUrl, oldSpki, newSpki });
    this.envelope = envelope;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, `${JSON.stringify(envelope)}\n`);
    } finally {
      try {
        this.onPinChanged(newSpki);
      } catch (err) {
        log.error(`the relay did not take the new pin ${newSpki}: ${err.message}`);
      }
      await recordFrontDoorEvent(this.auditLedger, 'frontdoor.tls.repin', { old_spki: oldSpki, new_spki: newSpki });
    }
    return envelope;
  }
}

module.exports = { RepinPublisher };
