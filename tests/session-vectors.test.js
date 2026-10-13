// tests/session-vectors.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/gui/helper-protocol');
const { buildVectors, serialize } = require('./vectors/session-v1/generate');

const DIR = path.join(__dirname, 'vectors', 'session-v1');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const bodyOf = (hex) => Buffer.from(hex, 'hex').subarray(4);

describe('session-v1 vectors', () => {
  it('the committed files are exactly what generate.js builds', () => {
    for (const v of buildVectors()) assert.equal(fs.readFileSync(path.join(DIR, `${v.name}.json`), 'utf8'), serialize(v), v.name);
    assert.equal(fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).length, 6);
  });

  it('handshake: proofs and HKDF keys', () => {
    const v = load('handshake');
    const secret = Buffer.from(v.given.secret_hex, 'hex');
    assert.equal(P.serviceProof(secret, v.given.node_id, v.given.nonce_h, v.given.nonce_s), v.expect.proof_s);
    assert.equal(P.helperProof(secret, v.given.node_id, v.given.nonce_s, v.given.nonce_h), v.expect.proof_h);
    assert.notEqual(v.expect.proof_s, v.expect.proof_h);
    const { kSh, kHs } = P.deriveSessionKeys(secret, v.given.node_id, v.given.nonce_h, v.given.nonce_s);
    assert.equal(kSh.toString('hex'), v.expect.k_sh_hex);
    assert.equal(kHs.toString('hex'), v.expect.k_hs_hex);
    assert.ok(P.proofEquals(v.expect.proof_s, v.expect.proof_s));
    assert.ok(!P.proofEquals(v.expect.proof_s, v.expect.proof_h));
  });

  it('sealed frames open in order with the right direction key', () => {
    const v = load('sealed-frames');
    for (const [list, key, dir] of [[v.expect.service_to_helper, v.given.k_sh_hex, P.DIR_SH], [v.expect.helper_to_service, v.given.k_hs_hex, P.DIR_HS]]) {
      const opener = P.createOpener(Buffer.from(key, 'hex'), dir);
      for (const f of list) assert.deepEqual(opener.open(bodyOf(f.frame_hex)), JSON.parse(f.plaintext_json));
    }
  });

  for (const name of ['reject-seq-skip', 'reject-seq-replay', 'reject-wrong-direction-key', 'reject-tampered-tag']) {
    it(`${name} is refused at the named frame`, () => {
      const v = load(name);
      const opener = P.createOpener(Buffer.from(v.given.key_hex, 'hex'), v.given.dir);
      v.given.frames.forEach((hex, i) => {
        if (i < v.expect.rejected_at) { opener.open(bodyOf(hex)); return; }
        if (i === v.expect.rejected_at) {
          assert.throws(() => opener.open(bodyOf(hex)), (e) => e.code === 'frame_rejected' && e.detail === v.expect.reason);
        }
      });
    });
  }
});

describe('plain framing', () => {
  it('round-trips through the decoder one frame at a time, even across chunks', () => {
    const a = P.encodeFrame({ t: 'hello', v: 1 });
    const b = P.encodeFrame({ t: 'auth', proof_h: 'x' });
    const all = Buffer.concat([a, b]);
    const d = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    d.push(all.subarray(0, 3));
    assert.equal(d.next(), null);
    d.push(all.subarray(3));
    assert.deepEqual(P.parsePlain(d.next()), { t: 'hello', v: 1 });
    assert.deepEqual(P.parsePlain(d.next()), { t: 'auth', proof_h: 'x' });
    assert.equal(d.next(), null);
  });

  it('refuses an oversize or zero length and unparseable JSON', () => {
    const d = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    const big = Buffer.alloc(4);
    big.writeUInt32BE(P.PLAIN_MAX + 1);
    d.push(big);
    assert.throws(() => d.next(), (e) => e.code === 'frame_rejected');
    const z = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    z.push(Buffer.alloc(4));
    assert.throws(() => z.next(), (e) => e.code === 'frame_rejected');
    assert.throws(() => P.parsePlain(Buffer.from('{nope')), (e) => e.code === 'frame_rejected');
    assert.throws(() => P.parsePlain(Buffer.from('[1]')), (e) => e.code === 'frame_rejected');
    assert.throws(() => P.encodeFrame({ pad: 'x'.repeat(P.PLAIN_MAX) }), (e) => e.code === 'frame_rejected');
  });

  it('a bad nonce is refused before any key is derived', () => {
    assert.throws(() => P.deriveSessionKeys(Buffer.alloc(32), 'kl-aaaaaaaaaaaaaaaa', 'short', P.randomNonce()), (e) => e.code === 'frame_rejected');
  });
});
