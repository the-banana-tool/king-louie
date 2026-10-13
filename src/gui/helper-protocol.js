// src/gui/helper-protocol.js
// kl-session-v1 (fleet stage 5 spec §3.2, §4.2; docs/protocol/session-v1.md):
// the local protocol between the service and the session helper. Shared by
// both sides; no platform code. Before `ready`: 4-byte length + JSON. After:
// every frame sealed with AES-256-GCM under per-direction HKDF keys with a
// strict sequence, so a relaying local account can pass frames through but
// cannot read, inject or reorder them.
const crypto = require('crypto');
const { GuiError } = require('./errors');

const PROTOCOL = 'kl-session-v1';
const PLAIN_MAX = 16 * 1024;
const SEALED_MAX = 8 * 1024 * 1024;
const DIR_SH = 0x01;
const DIR_HS = 0x02;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const TAG_BYTES = 16;

const rejected = (why) => new GuiError('frame_rejected', why);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function lengthPrefix(n) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(n);
  return len;
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > PLAIN_MAX) throw rejected('plain frame over 16 KiB');
  return Buffer.concat([lengthPrefix(body.length), body]);
}

class FrameDecoder {
  constructor({ maxBytes = PLAIN_MAX } = {}) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }

  setMax(n) {
    this.maxBytes = n;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
  }

  // One frame at a time, so the caller can switch the limit (and the
  // meaning of the next frame) at `ready`.
  next() {
    if (this.buffer.length < 4) return null;
    const n = this.buffer.readUInt32BE(0);
    if (n === 0 || n > this.maxBytes) throw rejected(`frame of ${n} bytes`);
    if (this.buffer.length < 4 + n) return null;
    const body = this.buffer.subarray(4, 4 + n);
    this.buffer = this.buffer.subarray(4 + n);
    return body;
  }
}

function parsePlain(body) {
  let obj;
  try {
    obj = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw rejected('json');
  }
  if (!isPlainObject(obj)) throw rejected('json');
  return obj;
}

const randomNonce = () => crypto.randomBytes(32).toString('base64url');
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text, 'utf8').digest('base64url');

function serviceProof(secret, nodeId, nonceH, nonceS) {
  return hmac(secret, `${PROTOCOL}\nservice\n${nodeId}\n${nonceH}\n${nonceS}`);
}

function helperProof(secret, nodeId, nonceS, nonceH) {
  return hmac(secret, `${PROTOCOL}\nhelper\n${nodeId}\n${nonceS}\n${nonceH}`);
}

function proofEquals(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function nonceBytes(nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw rejected('nonce');
  return Buffer.from(nonce, 'base64url');
}

// info = UTF-8 label ‖ UTF-8 node_id ‖ raw nonce_h ‖ raw nonce_s (Deviation 19).
function deriveSessionKeys(secret, nodeId, nonceH, nonceS) {
  const info = Buffer.concat([Buffer.from(`${PROTOCOL} keys`, 'utf8'), Buffer.from(String(nodeId), 'utf8'), nonceBytes(nonceH), nonceBytes(nonceS)]);
  const okm = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, 64));
  return { kSh: okm.subarray(0, 32), kHs: okm.subarray(32, 64) };
}

function ivFor(dir, seq) {
  const iv = Buffer.alloc(12);
  iv[0] = dir;
  iv.writeBigUInt64BE(seq, 4);
  return iv;
}

function aadFor(dir, seq) {
  const label = Buffer.from(PROTOCOL, 'utf8');
  const tail = Buffer.alloc(9);
  tail[0] = dir;
  tail.writeBigUInt64BE(seq, 1);
  return Buffer.concat([label, tail]);
}

function createSealer(key, dir) {
  let seq = 0n;
  return {
    seal(obj) {
      seq += 1n;
      const cipher = crypto.createCipheriv('aes-256-gcm', key, ivFor(dir, seq));
      cipher.setAAD(aadFor(dir, seq));
      const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
      const seqBuf = Buffer.alloc(8);
      seqBuf.writeBigUInt64BE(seq);
      const body = Buffer.concat([seqBuf, ct, cipher.getAuthTag()]);
      if (body.length > SEALED_MAX) throw rejected('sealed frame over 8 MiB');
      return Buffer.concat([lengthPrefix(body.length), body]);
    }
  };
}

function createOpener(key, dir) {
  let last = 0n;
  return {
    open(body) {
      if (!body || body.length < 8 + TAG_BYTES) throw rejected('short');
      const seq = body.readBigUInt64BE(0);
      if (seq !== last + 1n) throw rejected('sequence');
      let plain;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivFor(dir, seq));
        decipher.setAAD(aadFor(dir, seq));
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        plain = Buffer.concat([decipher.update(body.subarray(8, body.length - TAG_BYTES)), decipher.final()]);
      } catch {
        throw rejected('authentication');
      }
      last = seq;
      return parsePlain(plain);
    }
  };
}

module.exports = {
  PROTOCOL, PLAIN_MAX, SEALED_MAX, DIR_SH, DIR_HS, NONCE_RE,
  encodeFrame, FrameDecoder, parsePlain, randomNonce,
  serviceProof, helperProof, proofEquals, deriveSessionKeys, createSealer, createOpener
};
