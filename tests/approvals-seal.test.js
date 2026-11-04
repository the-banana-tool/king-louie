// tests/approvals-seal.test.js
//
// The seal format (sealed phones plan, R-SP-1, R-SP-2, R-SP-4). `handSeal` below
// builds a sealed object from the ruling's words alone, so these tests hold the
// bytes to the ruling and not only to seal.js's own opener.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('../src/platform/jcs');
const { deviceIdFromJwk, deriveDeviceId, fingerprintGroups, fromB64url, toB64url } = require('../src/approvals/envelope');
const { SEAL_SPLIT, SealError, sealContent, openSealed, splitMessage, isSealedShape, newSalt, saltedHash, boxKeyFingerprint } = require('../src/approvals/seal');

const NODE_ID = 'kl-c2ubd6jjqumalzt5';
const VECTORS = path.join(__dirname, 'vectors', 'approval-v1');

function newBox() {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const jwk = { kty: 'EC', crv: 'P-256', x: toB64url(pub.subarray(1, 33)), y: toB64url(pub.subarray(33, 65)) };
  const agree = (other) => ecdh.computeSecret(Buffer.concat([Buffer.from([0x04]), fromB64url(other.x), fromB64url(other.y)]));
  return { jwk, agree, id: deviceIdFromJwk(jwk) };
}

const NODE_BOX = newBox();

function approvalParts(overrides = {}) {
  const salt = newSalt();
  const action = { kind: 'tool', name: 'Bash', params: { command: 'ls' }, cwd: '/srv/site', summary: 'Bash(ls)' };
  return {
    clear: {
      v: 1,
      type: 'kl.approval.request',
      request_id: crypto.randomUUID(),
      node_id: NODE_ID,
      node_name: 'web-01',
      action_hash: saltedHash(salt, action),
      created_at: '2026-09-23T18:04:11.201Z',
      expires_at: '2026-09-23T18:09:11.201Z',
      nonce: toB64url(crypto.randomBytes(32)),
      node_box: NODE_BOX.jwk,
      ...overrides
    },
    content: { action, origin: { client: 'gateway', session: 'chat-1', job_id: null }, salt }
  };
}

function sealTo(recipientBoxes, parts = approvalParts()) {
  const recipients = Object.fromEntries(recipientBoxes.map((b) => [b.id, b.jwk]));
  const message = sealContent({ type: 'kl.approval.request', senderId: NODE_ID, clear: parts.clear, content: parts.content, recipients });
  return { message, parts };
}

function gcm(key, iv, plaintext, aad = null) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) c.setAAD(aad);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]);
}

function ungcm(key, iv, sealedBytes, aad = null) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) d.setAAD(aad);
  d.setAuthTag(sealedBytes.subarray(sealedBytes.length - 16));
  return Buffer.concat([d.update(sealedBytes.subarray(0, sealedBytes.length - 16)), d.final()]);
}

const kekFor = (ikm, type, sender, recipient) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(`kl-seal-v1\n${type}\n${sender}\n${recipient}`, 'utf8'), 32));

// R-SP-1 from its words: any plaintext bytes, so a test can seal what the real
// sealer refuses to.
function handSeal({ type, sender, clear, plaintext, recipient }) {
  const eph = newBox();
  const cek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const ct = gcm(cek, iv, plaintext, Buffer.from(canonicalize(clear), 'utf8'));
  const wrap = gcm(kekFor(eph.agree(recipient.jwk), type, sender, recipient.id), Buffer.alloc(12), cek);
  return { ...clear, sealed: { v: 1, epk: eph.jwk, iv: toB64url(iv), ct: toB64url(ct), keys: { [recipient.id]: toB64url(wrap) } } };
}

function flipByte(b64, at = 0) {
  const bytes = Buffer.from(fromB64url(b64));
  bytes[at] ^= 0x01;
  return toB64url(bytes);
}

function reasonOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SealError, `expected a SealError, got ${err}`);
    return err.reason;
  }
  assert.fail('expected a SealError');
  return null;
}

const openAs = (box, message, type = 'kl.approval.request') => openSealed({ type, message, recipientId: box.id, agree: box.agree });

describe('sealContent and openSealed', () => {
  it('seals to two phones and the node, and each opens to the same full message', () => {
    const a = newBox();
    const b = newBox();
    const node = { ...NODE_BOX, id: NODE_ID };
    const { message, parts } = sealTo([a, b, node]);
    const { sealed, ...clearOnWire } = message;
    assert.deepEqual(clearOnWire, parts.clear, 'the clear keys are untouched');
    assert.deepEqual(Object.keys(sealed).sort(), ['ct', 'epk', 'iv', 'keys', 'v']);
    assert.deepEqual(Object.keys(sealed.keys).sort(), [a.id, b.id, NODE_ID].sort());
    for (const box of [a, b, node]) {
      const opened = openAs(box, message);
      assert.deepEqual(opened.content, parts.content);
      assert.deepEqual(opened.message, { ...parts.clear, ...parts.content });
      assert.equal(Object.hasOwn(opened.message, 'sealed'), false);
    }
  });

  it('the bytes on the wire are what R-SP-1 says, opened with none of seal.js', () => {
    const a = newBox();
    const { message, parts } = sealTo([a]);
    const { sealed, ...clear } = message;
    const wrap = fromB64url(sealed.keys[a.id]);
    assert.equal(wrap.length, 48);
    assert.equal(sealed.v, 1);
    assert.deepEqual(Object.keys(sealed.epk).sort(), ['crv', 'kty', 'x', 'y']);
    const cek = ungcm(kekFor(a.agree(sealed.epk), 'kl.approval.request', NODE_ID, a.id), Buffer.alloc(12), wrap);
    assert.equal(cek.length, 32);
    const iv = fromB64url(sealed.iv);
    assert.equal(iv.length, 12);
    const plaintext = ungcm(cek, iv, fromB64url(sealed.ct), Buffer.from(canonicalize(clear), 'utf8'));
    const text = plaintext.toString('utf8');
    assert.equal(text, canonicalize({ ...parts.content, pad: JSON.parse(text).pad }), 'the plaintext is the JCS bytes of the content, with its pad');
    assert.equal(plaintext.length % 256, 0, 'a whole number of 256-byte blocks');
  });

  it('opens what a sealer written from the ruling alone built', () => {
    const a = newBox();
    const { clear, content } = approvalParts();
    const message = handSeal({ type: 'kl.approval.request', sender: NODE_ID, clear, plaintext: Buffer.from(canonicalize(content), 'utf8'), recipient: a });
    assert.deepEqual(openAs(a, message).content, content);
  });

  it('every message has its own epk, iv and content key', () => {
    const a = newBox();
    const parts = approvalParts();
    const first = sealTo([a], parts).message.sealed;
    const second = sealTo([a], parts).message.sealed;
    assert.notEqual(first.epk.x, second.epk.x);
    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ct, second.ct);
    assert.notEqual(first.keys[a.id], second.keys[a.id]);
  });

  it('a wrap for a device that is not in keys is not_recipient', () => {
    const { message } = sealTo([newBox()]);
    assert.equal(reasonOf(() => openAs(newBox(), message)), 'not_recipient');
    assert.equal(reasonOf(() => openSealed({ type: 'kl.approval.request', message, recipientId: '__proto__', agree: newBox().agree })), 'not_recipient');
  });

  it('a phone in keys whose box key is not the one sealed to is open_failed', () => {
    const a = newBox();
    const { message } = sealTo([a]);
    const reset = newBox();
    assert.equal(reasonOf(() => openSealed({ type: 'kl.approval.request', message, recipientId: a.id, agree: reset.agree })), 'open_failed');
  });

  it('a recipient whose agree throws or answers the wrong size is open_failed', () => {
    const a = newBox();
    const { message } = sealTo([a]);
    const throws = () => { throw new Error('the enclave said no'); };
    assert.equal(reasonOf(() => openSealed({ type: 'kl.approval.request', message, recipientId: a.id, agree: throws })), 'open_failed');
    assert.equal(reasonOf(() => openSealed({ type: 'kl.approval.request', message, recipientId: a.id, agree: () => Buffer.alloc(31) })), 'open_failed');
  });

  it('a flipped byte in ct, or a changed clear field, is open_failed', () => {
    const a = newBox();
    const { message } = sealTo([a]);
    const lastByte = fromB64url(message.sealed.ct).length - 1;
    for (const at of [0, lastByte]) {
      assert.equal(reasonOf(() => openAs(a, { ...message, sealed: { ...message.sealed, ct: flipByte(message.sealed.ct, at) } })), 'open_failed', `ct byte ${at}`);
    }
    assert.equal(reasonOf(() => openAs(a, { ...message, sealed: { ...message.sealed, iv: flipByte(message.sealed.iv) } })), 'open_failed', 'iv');
    assert.equal(reasonOf(() => openAs(a, { ...message, sealed: { ...message.sealed, keys: { [a.id]: flipByte(message.sealed.keys[a.id]) } } })), 'open_failed', 'wrap');
    for (const field of ['node_name', 'created_at', 'nonce', 'expires_at']) {
      const changed = { ...message, [field]: field === 'nonce' ? toB64url(crypto.randomBytes(32)) : `${message[field]}x` };
      assert.equal(reasonOf(() => openAs(a, changed)), 'open_failed', field);
    }
    assert.equal(reasonOf(() => openAs(a, { ...message, node_box: newBox().jwk })), 'open_failed', 'node_box');
  });

  it('the same clear part cannot be reused with another message\'s sealed object', () => {
    const a = newBox();
    const first = sealTo([a]).message;
    const second = sealTo([a]).message;
    assert.equal(reasonOf(() => openAs(a, { ...first, sealed: second.sealed })), 'open_failed');
  });

  it('a wrap is bound to its recipient and its sender', () => {
    const a = newBox();
    const b = newBox();
    const { message } = sealTo([a, b]);
    const swapped = { ...message, sealed: { ...message.sealed, keys: { [b.id]: message.sealed.keys[a.id], [a.id]: message.sealed.keys[b.id] } } };
    assert.equal(reasonOf(() => openAs(a, swapped)), 'open_failed', 'another recipient\'s wrap');
    const { clear, content } = approvalParts();
    const otherSender = handSeal({ type: 'kl.approval.request', sender: 'kl-aaaaaaaaaaaaaaaa', clear, plaintext: Buffer.from(canonicalize(content), 'utf8'), recipient: a });
    assert.equal(reasonOf(() => openAs(a, otherSender)), 'open_failed', 'info names another sender');
  });

  it('a wrap is bound to its type', () => {
    const a = newBox();
    const { clear, content } = approvalParts();
    const otherType = handSeal({ type: 'kl.lease.request', sender: NODE_ID, clear, plaintext: Buffer.from(canonicalize(content), 'utf8'), recipient: a });
    assert.equal(reasonOf(() => openAs(a, otherType)), 'open_failed');
    assert.equal(reasonOf(() => openAs(a, sealTo([a]).message, 'kl.lease.request')), 'malformed', 'the type asked for is not the message\'s');
  });

  it('a shape that is wrong is malformed, before anything is opened', () => {
    const a = newBox();
    const { message, parts } = sealTo([a]);
    let agreed = 0;
    const counting = (epk) => { agreed += 1; return a.agree(epk); };
    const open = (m, type = 'kl.approval.request') => reasonOf(() => openSealed({ type, message: m, recipientId: a.id, agree: counting }));
    assert.equal(open({ ...message, action: parts.content.action }), 'malformed');
    assert.equal(open({ ...message, sealed: { ...message.sealed, v: 2 } }), 'malformed');
    assert.equal(open(null), 'malformed');
    assert.equal(open(message, 'kl.lease.grant'), 'malformed');
    assert.equal(agreed, 0, 'no secret was computed for a malformed message');
  });

  it('content that is not JSON, not an object, not JCS or holds a clear key is content_malformed', () => {
    const a = newBox();
    const { clear, content } = approvalParts();
    const cases = {
      'not JSON': Buffer.from('{not json', 'utf8'),
      'not UTF-8': Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
      'an array': Buffer.from('[1]', 'utf8'),
      'a string': Buffer.from('"text"', 'utf8'),
      null: Buffer.from('null', 'utf8'),
      'a clear key': Buffer.from(canonicalize({ ...content, node_name: 'other' }), 'utf8'),
      'a key of no part': Buffer.from(canonicalize({ ...content, extra: 1 }), 'utf8'),
      'a __proto__ key': Buffer.from(`{"__proto__":{"polluted":true},${canonicalize(content).slice(1)}`, 'utf8'),
      'not JCS': Buffer.from(JSON.stringify({ salt: content.salt, origin: content.origin, action: content.action }, null, 1), 'utf8'),
      'a duplicate key': Buffer.from(`{"salt":"x",${canonicalize(content).slice(1)}`, 'utf8'),
      'a lone surrogate': Buffer.from('{"salt":"\\ud800"}', 'utf8')
    };
    for (const [label, plaintext] of Object.entries(cases)) {
      const message = handSeal({ type: 'kl.approval.request', sender: NODE_ID, clear, plaintext, recipient: a });
      assert.equal(reasonOf(() => openAs(a, message)), 'content_malformed', label);
    }
    assert.equal({}.polluted, undefined);
  });

  it('a phone answering seals to the node under its own device id', () => {
    const phone = newBox();
    const node = { ...NODE_BOX, id: NODE_ID };
    const clear = { v: 1, type: 'kl.question.answer', node_id: NODE_ID, token: 'ABC123', device_id: phone.id, nonce: toB64url(crypto.randomBytes(32)), signed_at: '2026-09-23T18:04:11.201Z' };
    const content = { case_id: 'case-1', question_id: 'q-1', answer: 'yes' };
    const message = sealContent({ type: 'kl.question.answer', senderId: phone.id, clear, content, recipients: { [NODE_ID]: NODE_BOX.jwk } });
    assert.deepEqual(openSealed({ type: 'kl.question.answer', message, recipientId: NODE_ID, agree: node.agree }).content, content);
    assert.equal(reasonOf(() => sealContent({ type: 'kl.question.answer', senderId: NODE_ID, clear, content, recipients: { [NODE_ID]: NODE_BOX.jwk } })), 'malformed', 'senderId is not the clear part\'s sender');
  });

  it('refuses to seal to an off-curve recipient, an empty set, or with parts that do not fit the type', () => {
    const a = newBox();
    const { clear, content } = approvalParts();
    const base = { type: 'kl.approval.request', senderId: NODE_ID, clear, content, recipients: { [a.id]: a.jwk } };
    const offCurve = { ...a.jwk, y: toB64url(Buffer.alloc(32, 1)) };
    assert.equal(reasonOf(() => sealContent({ ...base, recipients: { [a.id]: offCurve } })), 'malformed');
    assert.equal(reasonOf(() => sealContent({ ...base, recipients: {} })), 'malformed');
    assert.equal(reasonOf(() => sealContent({ ...base, recipients: { 'not-an-id': a.jwk } })), 'malformed');
    assert.equal(reasonOf(() => sealContent({ ...base, type: 'kl.lease.grant' })), 'malformed');
    assert.equal(reasonOf(() => sealContent({ ...base, content: { ...content, node_name: 'other' } })), 'malformed');
    assert.equal(reasonOf(() => sealContent({ ...base, clear: { ...clear, action: content.action } })), 'malformed');
    assert.equal(reasonOf(() => sealContent({ ...base, clear: { ...clear, sealed: { v: 1 } } })), 'malformed', 'a clear part holding sealed');
    assert.equal(reasonOf(() => sealContent({ ...base, random: () => Buffer.alloc(4) })), 'malformed');
  });

  it('an injected ephemeral key and random source give the same bytes twice', () => {
    const a = newBox();
    const eph = newBox();
    const { clear, content } = approvalParts();
    const random = (n) => Buffer.alloc(n, 7);
    const once = () => sealContent({ type: 'kl.approval.request', senderId: NODE_ID, clear, content, recipients: { [a.id]: a.jwk }, ephemeral: { jwk: eph.jwk, agree: eph.agree }, random });
    assert.deepEqual(once(), once());
    assert.deepEqual(once().sealed.epk, eph.jwk);
  });
});

describe('the pad', () => {
  const answerClear = (phone) => ({ v: 1, type: 'kl.question.answer', node_id: NODE_ID, token: 'ABC123', device_id: phone.id, nonce: 'n'.repeat(43), signed_at: '2026-09-23T18:04:11.201Z' });
  const ctLength = (message) => fromB64url(message.sealed.ct).length;
  const sealHand = (clear, plaintext, a) => handSeal({ type: 'kl.approval.request', sender: NODE_ID, clear, plaintext: Buffer.from(plaintext, 'utf8'), recipient: a });

  it('two answers of different lengths give ciphertexts of one length', () => {
    const phone = newBox();
    const sealAnswer = (id) => sealContent({
      type: 'kl.question.answer', senderId: phone.id, clear: answerClear(phone),
      content: { case_id: 'c-1', question_id: 'q-0012', answer: { option_id: id } }, recipients: { [NODE_ID]: NODE_BOX.jwk }
    });
    assert.equal(ctLength(sealAnswer('approve')), ctLength(sealAnswer('refuse')));
    assert.equal(ctLength(sealAnswer('approve')), 256 + 16);
  });

  it('lands on a multiple of 256 at every length, multi-byte text included', () => {
    const a = newBox();
    const parts = approvalParts();
    const sizes = new Set();
    for (let n = 0; n < 300; n += 7) {
      for (const unit of ['x', 'é', '€', '😀', '"', '\n']) {
        const content = { ...parts.content, action: { ...parts.content.action, summary: unit.repeat(n) } };
        const message = sealContent({ type: 'kl.approval.request', senderId: NODE_ID, clear: parts.clear, content, recipients: { [a.id]: a.jwk } });
        const body = ctLength(message) - 16;
        assert.equal(body % 256, 0, `${n} ${JSON.stringify(unit)}`);
        sizes.add(body);
        assert.deepEqual(openAs(a, message).content, content);
      }
    }
    assert.ok(sizes.size > 3);
  });

  it('an exact fit takes an empty pad, and one byte more takes the next block', () => {
    const a = newBox();
    const parts = approvalParts();
    const plaintextOf = (content) => {
      const { sealed, ...clear } = sealContent({ type: 'kl.approval.request', senderId: NODE_ID, clear: parts.clear, content, recipients: { [a.id]: a.jwk } });
      const cek = ungcm(kekFor(a.agree(sealed.epk), 'kl.approval.request', NODE_ID, a.id), Buffer.alloc(12), fromB64url(sealed.keys[a.id]));
      return ungcm(cek, fromB64url(sealed.iv), fromB64url(sealed.ct), Buffer.from(canonicalize(clear), 'utf8')).toString('utf8');
    };
    const withSummary = (n) => ({ ...parts.content, action: { ...parts.content.action, summary: 'x'.repeat(n) } });
    const bare = (n) => Buffer.byteLength(canonicalize({ ...withSummary(n), pad: '' }), 'utf8');
    const fit = 256 * 4 - bare(0);
    assert.equal(bare(fit) % 256, 0);
    assert.equal(JSON.parse(plaintextOf(withSummary(fit))).pad, '');
    const over = plaintextOf(withSummary(fit + 1));
    assert.equal(JSON.parse(over).pad, ' '.repeat(255));
    assert.equal(Buffer.byteLength(over, 'utf8'), 256 * 5);
  });

  it('an opener takes a pad of any number of spaces, strips it from both results, and takes none at all', () => {
    const a = newBox();
    const { clear, content } = approvalParts();
    for (const pad of [null, '', ' ', ' '.repeat(255), ' '.repeat(1000)]) {
      const opened = openAs(a, sealHand(clear, canonicalize(pad === null ? content : { ...content, pad }), a));
      assert.deepEqual(opened.content, content);
      assert.deepEqual(opened.message, { ...clear, ...content });
      assert.equal(Object.hasOwn(opened.content, 'pad'), false);
      assert.equal(Object.hasOwn(opened.message, 'pad'), false);
    }
  });

  it('a pad that is not only spaces is content_malformed, and so is any other extra key', () => {
    const a = newBox();
    const { clear, content } = approvalParts();
    for (const pad of ['x', ' x ', '\t', '\n', ' ', '　', 1, 0, null, true, [' '], { a: ' ' }]) {
      assert.equal(reasonOf(() => openAs(a, sealHand(clear, canonicalize({ ...content, pad }), a))), 'content_malformed', JSON.stringify(pad));
    }
    for (const key of ['padding', 'Pad', 'PAD', 'pad ', 'node_id', 'extra']) {
      assert.equal(reasonOf(() => openAs(a, sealHand(clear, canonicalize({ ...content, pad: '', [key]: ' ' }), a))), 'content_malformed', key);
    }
    // A pad out of its JCS place, and two pads, one of them not spaces.
    assert.equal(reasonOf(() => openAs(a, sealHand(clear, `${canonicalize(content).slice(0, -1)},"pad":" "}`, a))), 'content_malformed');
    assert.equal(reasonOf(() => openAs(a, sealHand(clear, `{"pad":"x",${canonicalize({ ...content, pad: ' ' }).slice(1)}`, a))), 'content_malformed');
  });

  it('a sender cannot pass its own pad, and the table does not list one', () => {
    const a = newBox();
    const { clear, content } = approvalParts();
    assert.equal(reasonOf(() => sealContent({ type: 'kl.approval.request', senderId: NODE_ID, clear, content: { ...content, pad: ' ' }, recipients: { [a.id]: a.jwk } })), 'malformed');
    for (const keys of Object.values(SEAL_SPLIT)) assert.equal(keys.includes('pad'), false);
  });

  it('the pad is outside the salted hash', () => {
    const a = newBox();
    const { message, parts } = sealTo([a]);
    assert.equal(saltedHash(parts.content.salt, parts.content.action), message.action_hash);
    assert.equal(saltedHash(parts.content.salt, openAs(a, message).content.action), message.action_hash);
  });
});

describe('splitMessage', () => {
  it('splits a full message by the table and seals back to the same whole', () => {
    const a = newBox();
    const { clear, content } = approvalParts();
    const split = splitMessage('kl.approval.request', { ...clear, ...content });
    assert.deepEqual(split, { clear, content });
    const message = sealContent({ type: 'kl.approval.request', senderId: NODE_ID, ...split, recipients: { [a.id]: a.jwk } });
    assert.deepEqual(openAs(a, message).message, { ...clear, ...content });
  });

  it('refuses an unknown type and a message already sealed', () => {
    const { clear, content } = approvalParts();
    assert.equal(reasonOf(() => splitMessage('kl.lease.grant', { ...clear, ...content })), 'malformed');
    assert.equal(reasonOf(() => splitMessage('kl.approval.request', sealTo([newBox()]).message)), 'malformed');
  });
});

describe('saltedHash', () => {
  it('saltedHash differs for the same action under two salts and matches the vector', () => {
    const action = { kind: 'tool', name: 'Bash', params: { command: 'ls' }, cwd: null, summary: 'Bash(ls)' };
    const s1 = newSalt();
    const s2 = newSalt();
    assert.equal(fromB64url(s1).length, 32);
    assert.notEqual(s1, s2);
    assert.notEqual(saltedHash(s1, action), saltedHash(s2, action));
    assert.equal(saltedHash(s1, action), saltedHash(s1, action));
    // R-SP-2 from its words.
    const hand = crypto.createHash('sha256').update(Buffer.concat([fromB64url(s1), Buffer.from(canonicalize(action), 'utf8')])).digest('base64url');
    assert.equal(saltedHash(s1, action), hand);
    const v = JSON.parse(fs.readFileSync(path.join(VECTORS, 'seal-open.json'), 'utf8'));
    assert.equal(saltedHash(v.expect.message.salt, v.expect.message.action), v.input.action_hash);
  });

  it('refuses a salt that is not 32 bytes of canonical base64url', () => {
    assert.equal(reasonOf(() => saltedHash(toB64url(Buffer.alloc(31)), {})), 'malformed');
    assert.equal(reasonOf(() => saltedHash('not base64url!', {})), 'malformed');
    assert.equal(reasonOf(() => saltedHash(undefined, {})), 'malformed');
  });
});

describe('isSealedShape', () => {
  it('isSealedShape refuses sealed plus any content key, and a keys entry that is not 48 bytes', () => {
    const a = newBox();
    const { message, parts } = sealTo([a]);
    const type = 'kl.approval.request';
    assert.equal(isSealedShape(type, message), true);
    for (const key of SEAL_SPLIT[type]) {
      assert.equal(isSealedShape(type, { ...message, [key]: parts.content[key] }), false, key);
    }
    const withKeys = (keys) => ({ ...message, sealed: { ...message.sealed, keys } });
    assert.equal(isSealedShape(type, withKeys({ [a.id]: toB64url(Buffer.alloc(47)) })), false, '47 bytes');
    assert.equal(isSealedShape(type, withKeys({ [a.id]: toB64url(Buffer.alloc(49)) })), false, '49 bytes');
    assert.equal(isSealedShape(type, withKeys({})), false, 'no recipient');
    assert.equal(isSealedShape(type, withKeys({ 'not-an-id': message.sealed.keys[a.id] })), false, 'not a device or node id');
    assert.equal(isSealedShape(type, withKeys([message.sealed.keys[a.id]])), false, 'an array');
    assert.equal(isSealedShape(type, withKeys({ [NODE_ID]: message.sealed.keys[a.id] })), true, 'a node id is a recipient');
  });

  it('refuses every other way the sealed object can be off', () => {
    const a = newBox();
    const { message } = sealTo([a]);
    const type = 'kl.approval.request';
    const withSealed = (patch) => ({ ...message, sealed: { ...message.sealed, ...patch } });
    assert.equal(isSealedShape(type, withSealed({ v: 2 })), false, 'v');
    assert.equal(isSealedShape(type, withSealed({ iv: toB64url(Buffer.alloc(11)) })), false, 'iv');
    assert.equal(isSealedShape(type, withSealed({ ct: toB64url(Buffer.alloc(15)) })), false, 'ct under a tag');
    assert.equal(isSealedShape(type, withSealed({ ct: toB64url(Buffer.alloc(16)) })), true, 'ct of a bare tag');
    assert.equal(isSealedShape(type, withSealed({ ct: `${message.sealed.ct}=` })), false, 'padded base64url');
    assert.equal(isSealedShape(type, withSealed({ epk: { ...message.sealed.epk, y: toB64url(Buffer.alloc(32, 1)) } })), false, 'off-curve epk');
    assert.equal(isSealedShape(type, withSealed({ epk: { ...message.sealed.epk, d: 'x' } })), false, 'a private part');
    assert.equal(isSealedShape(type, withSealed({ extra: 1 })), false, 'extra key in sealed');
    const { node_box: _dropped, ...missingClear } = message;
    assert.equal(isSealedShape(type, missingClear), false, 'a clear key missing');
    assert.equal(isSealedShape(type, { ...message, extra: 1 }), false, 'a key of no part');
    assert.equal(isSealedShape('kl.lease.request', message), false, 'another type');
    assert.equal(isSealedShape('kl.approval.response', message), false, 'a type that is not sealed');
    assert.equal(isSealedShape(type, null), false);
    const { sealed: _gone, ...clearOnly } = message;
    assert.equal(isSealedShape(type, clearOnly), false, 'the clear shape is not the sealed shape');
  });

  it('answers false, and never throws, for every type name that is not sealed or has no clear keys', () => {
    for (const type of Object.keys(SEAL_SPLIT)) {
      assert.equal(isSealedShape(type, { type }), false, type);
    }
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'kl.lease.grant', '', 42, null, undefined]) {
      assert.equal(isSealedShape(type, { type }), false, String(type));
      assert.equal(reasonOf(() => sealContent({ type, senderId: NODE_ID, clear: { type, node_id: NODE_ID }, content: {}, recipients: { [NODE_ID]: NODE_BOX.jwk } })), 'malformed', String(type));
      assert.equal(reasonOf(() => splitMessage(type, { type })), 'malformed', String(type));
    }
  });

  // The clear column of R-SP-4, written out here so the table in seal.js is
  // checked against a second copy. kl.lease.status: `name` is the only content key.
  const CLEAR_KEYS = {
    'kl.approval.request': ['v', 'type', 'request_id', 'node_id', 'node_name', 'action_hash', 'created_at', 'expires_at', 'nonce', 'node_box'],
    'kl.lease.request': ['v', 'type', 'request_id', 'lease_id', 'node_id', 'node_name', 'lease_hash', 'created_at', 'expires_at', 'nonce', 'node_box'],
    'kl.lease.status': ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'state', 'locked', 'reason', 'expires_at', 'contact_token', 'granted_by', 'kind', 'unattended'],
    'kl.lease.view': ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'to_device', 'state', 'locked', 'remaining_s', 'contact_token'],
    'kl.question.ask': ['v', 'type', 'node_id', 'token', 'kind', 'urgency', 'expires_at', 'node_box'],
    'kl.question.answer': ['v', 'type', 'node_id', 'token', 'device_id', 'nonce', 'signed_at']
  };

  for (const [type, clearKeys] of Object.entries(CLEAR_KEYS)) {
    it(`${type}: exactly its clear keys and sealed, and it opens`, () => {
      const a = newBox();
      const sender = type === 'kl.question.answer' ? a.id : NODE_ID;
      const clear = Object.fromEntries(clearKeys.map((k) => [k, `value-${k}`]));
      clear.type = type;
      clear.node_id = NODE_ID;
      if (type === 'kl.question.answer') clear.device_id = sender;
      const content = Object.fromEntries(SEAL_SPLIT[type].map((k) => [k, `secret-${k}`]));
      const message = sealContent({ type, senderId: sender, clear, content, recipients: { [a.id]: a.jwk } });
      assert.deepEqual(Object.keys(message).sort(), [...clearKeys, 'sealed'].sort());
      assert.equal(isSealedShape(type, message), true);
      assert.deepEqual(openSealed({ type, message, recipientId: a.id, agree: a.agree }).message, { ...clear, ...content });
    });
  }
});

describe('boxKeyFingerprint', () => {
  it('boxKeyFingerprint is b- and the device-id rule over 0x04||x||y', () => {
    const a = newBox();
    const raw = Buffer.concat([Buffer.from([0x04]), fromB64url(a.jwk.x), fromB64url(a.jwk.y)]);
    const fp = boxKeyFingerprint(a.jwk);
    assert.match(fp, /^b-[a-z2-7]{4} [a-z2-7]{4} [a-z2-7]{4} [a-z2-7]{4}$/);
    assert.equal(fp, `b-${fingerprintGroups(deriveDeviceId(raw, 'b-'))}`);
    assert.equal(fp.slice(2), fingerprintGroups(a.id), 'the same digits as the id the same key would have');
    assert.equal(reasonOf(() => boxKeyFingerprint({ ...a.jwk, y: toB64url(Buffer.alloc(32, 1)) })), 'malformed');
  });
});

describe('SEAL_SPLIT', () => {
  it('SEAL_SPLIT names exactly the six types of the spec table', () => {
    assert.deepEqual(Object.keys(SEAL_SPLIT).map((t) => [t, [...SEAL_SPLIT[t]]]).sort(), [
      ['kl.approval.request', ['action', 'origin', 'salt']],
      ['kl.lease.request', ['lease', 'origin', 'salt']],
      ['kl.lease.status', ['name']],
      ['kl.lease.view', ['foreground', 'frame', 'frame_dropped', 'actions']],
      ['kl.question.ask', ['case_id', 'question_id', 'case_title', 'text', 'options']],
      ['kl.question.answer', ['case_id', 'question_id', 'answer']]
    ].sort());
    assert.equal(Object.isFrozen(SEAL_SPLIT), true);
    for (const keys of Object.values(SEAL_SPLIT)) assert.equal(Object.isFrozen(keys), true);
  });
});
