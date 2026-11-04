// tests/window-seal.test.js
//
// The seal between a window and a node (R-RW-1, R-RW-2): the handshake, records,
// padding, the heartbeat and what the sender holds back. The bytes themselves are
// pinned in tests/window-vectors.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  WindowSeal, VERSION, RECORD_MAX, RECORD_WIRE_MAX, PAD_SMALL, PAD_LARGE, PING_MS, SILENCE_MS,
  advanceCounter, startHeartbeat, createFrameSender
} = require('../src/desktop-bridge/window-seal');
const { LIMITS } = require('../src/desktop-bridge/protocol');
const { sessionIdOf, windowKey, nodeKey, lookupOf, runHandshake } = require('./helpers/window-seal-fixture');

const SESSION = sessionIdOf('seal test');
const MIB = 1024 * 1024;

function makeWindow({ session = SESSION, name = 'A', pin = nodeKey().publicKey, ...rest } = {}) {
  return WindowSeal.window({ sessionId: session, ...windowKey(name), pin, ...rest });
}
function makeNode({ session = SESSION, name = 'web-01', lookup = lookupOf('A'), ...rest } = {}) {
  return WindowSeal.node({ sessionId: session, identity: nodeKey(name), lookupDevice: lookup, ...rest });
}
async function readyPair(options = {}) {
  const window = makeWindow(options.window);
  const node = makeNode(options.node);
  const wire = await runHandshake(window, node);
  assert.equal(wire.windowResult.ready, true);
  assert.equal(wire.nodeResult.ready, true);
  return { window, node, ...wire };
}
function assertHandshakeRefused(result, reason = 'handshake') {
  assert.deepEqual(result.close, { code: 4401, reason });
  assert.deepEqual(result.out, []);
  assert.deepEqual(result.frames, []);
  assert.equal(result.ready, false);
}
function assertRecordRefused(result) {
  assert.deepEqual(result.close, { code: 4400, reason: 'record' });
  assert.deepEqual(result.out, []);
  assert.deepEqual(result.frames, []);
}

describe('the constants', () => {
  it('are the ones R-RW-1 and R-RW-2 name', () => {
    assert.equal(VERSION, 1);
    assert.equal(RECORD_MAX, 1048576);
    assert.equal(PAD_SMALL, 256);
    assert.equal(PAD_LARGE, 4096);
    assert.equal(PING_MS, 20000);
    assert.equal(SILENCE_MS, 60000);
  });
});

describe('the handshake', () => {
  it('a window and a node complete it and exchange frames both ways', async () => {
    const { window, node, helloW, helloN, authW, windowResult, nodeResult } = await readyPair();
    assert.equal(helloW.length, 86);
    assert.equal(helloN.length, 148);
    assert.equal(authW.length, 65);
    assert.deepEqual(windowResult.peer, { nodeId: nodeKey().nodeId, publicKey: nodeKey().publicKey });
    assert.deepEqual(nodeResult.peer, { deviceId: windowKey().deviceId, publicKey: windowKey().publicKey });
    const [toNode] = window.wrap(Buffer.from('{"t":"call"}'));
    assert.deepEqual((await node.next(toNode)).frames, [Buffer.from('{"t":"call"}')]);
    const [toWindow] = node.wrap(Buffer.from('{"t":"ready"}'));
    assert.deepEqual((await window.next(toWindow)).frames, [Buffer.from('{"t":"ready"}')]);
  });

  it('a null pin takes the key the handshake proved, and hands it over', async () => {
    const { windowResult } = await readyPair({ window: { pin: null } });
    assert.deepEqual(windowResult.peer.publicKey, nodeKey().publicKey);
  });

  it('every session has fresh ephemeral keys', async () => {
    const first = await makeWindow().next(null);
    const second = await makeWindow().next(null);
    assert.notDeepEqual(first.out[0].subarray(2, 34), second.out[0].subarray(2, 34));
    const a = await makeNode().next(first.out[0]);
    const b = await makeNode().next(first.out[0]);
    assert.notDeepEqual(a.out[0].subarray(1, 33), b.out[0].subarray(1, 33));
  });

  it('a pin that differs fails before auth_w, and the tab can tell why', async () => {
    const window = makeWindow({ pin: nodeKey('gpu-box').publicKey });
    const node = makeNode();
    const hello = await window.next(null);
    const answer = await node.next(hello.out[0]);
    assertHandshakeRefused(await window.next(answer.out[0]), 'node_key_changed');
    assert.throws(() => window.wrap(Buffer.from('x')), { code: 'SEAL_CLOSED' });
  });

  it('auth_w is never signed when the node is not the pinned one', async () => {
    let signed = 0;
    const key = windowKey();
    const window = WindowSeal.window({ sessionId: SESSION, deviceId: key.deviceId, publicKey: key.publicKey, pin: nodeKey('gpu-box').publicKey, sign: async (b) => { signed += 1; return key.sign(b); } });
    const hello = await window.next(null);
    const answer = await makeNode().next(hello.out[0]);
    await window.next(answer.out[0]);
    assert.equal(signed, 0);
  });

  it('a node that signed another session id fails at the window', async () => {
    const window = makeWindow();
    const node = makeNode({ session: sessionIdOf('another') });
    const hello = await window.next(null);
    const answer = await node.next(hello.out[0]);
    assertHandshakeRefused(await window.next(answer.out[0]));
  });

  it('a window that signed another session id fails at the node', async () => {
    const eph = crypto.createHash('sha256').update('fixed node epk').digest();
    const nodeA = makeNode({ ephemeral: eph });
    const nodeB = makeNode({ ephemeral: eph, session: sessionIdOf('another') });
    const window = makeWindow();
    const hello = await window.next(null);
    const forA = await nodeA.next(hello.out[0]);
    await nodeB.next(hello.out[0]);
    const auth = await window.next(forA.out[0]);
    assert.equal(auth.ready, true);
    assertHandshakeRefused(await nodeB.next(auth.out[0]));
  });

  it('an unknown device gets hello_n like a known one, then the one code', async () => {
    const window = makeWindow();
    const node = makeNode({ lookup: () => null });
    const hello = await window.next(null);
    const answer = await node.next(hello.out[0]);
    assert.equal(answer.out.length, 1);
    const auth = await window.next(answer.out[0]);
    const result = await node.next(auth.out[0]);
    assertHandshakeRefused(result);
    assert.equal(result.peer, null);
  });

  it('a device whose stored key differs from the hello is refused the same way', async () => {
    const window = makeWindow();
    const node = makeNode({ lookup: () => windowKey('B').publicKey });
    const hello = await window.next(null);
    const answer = await node.next(hello.out[0]);
    const auth = await window.next(answer.out[0]);
    assertHandshakeRefused(await node.next(auth.out[0]));
  });

  it('a lookup that throws or answers a promise fails closed', async () => {
    for (const lookup of [() => { throw new Error('unreadable'); }, async () => windowKey().publicKey]) {
      const window = makeWindow();
      const node = makeNode({ lookup });
      const hello = await window.next(null);
      const answer = await node.next(hello.out[0]);
      const auth = await window.next(answer.out[0]);
      assertHandshakeRefused(await node.next(auth.out[0]));
    }
  });

  it('a hello_w whose device id is not its key refuses before the node signs', async () => {
    const hello = Buffer.from((await makeWindow().next(null)).out[0]);
    hello[34] ^= 0x01;
    let signed = 0;
    const key = nodeKey();
    const node = WindowSeal.node({ sessionId: SESSION, identity: { ...key, sign: (b) => { signed += 1; return key.sign(b); } }, lookupDevice: lookupOf('A') });
    assertHandshakeRefused(await node.next(hello));
    assert.equal(signed, 0);
  });

  it('a hello_n whose node id is not its key refuses', async () => {
    const window = makeWindow({ pin: null });
    const hello = await window.next(null);
    const answer = Buffer.from((await makeNode().next(hello.out[0])).out[0]);
    answer[33] ^= 0x01;
    assertHandshakeRefused(await window.next(answer));
  });

  it('a version the node does not speak refuses', async () => {
    const hello = Buffer.from((await makeWindow().next(null)).out[0]);
    hello[1] = 2;
    assertHandshakeRefused(await makeNode().next(hello));
  });

  it('a low-order key refuses, on either side', async () => {
    const lowOrder = [Buffer.alloc(32), Buffer.concat([Buffer.from([1]), Buffer.alloc(31)])];
    for (const point of lowOrder) {
      const hello = Buffer.from((await makeWindow().next(null)).out[0]);
      point.copy(hello, 2);
      assertHandshakeRefused(await makeNode().next(hello));
    }
    // The node's key, signed by the real node: a signature does not make it usable.
    const window = makeWindow();
    const helloW = (await window.next(null)).out[0];
    const key = nodeKey();
    const head = Buffer.concat([Buffer.from([0x02]), lowOrder[0], Buffer.from(key.nodeId, 'ascii'), key.publicKey]);
    const sig = key.sign(Buffer.concat([Buffer.from('kl-window-v1\nnode\n'), Buffer.from(SESSION, 'base64url'), helloW, head]));
    assertHandshakeRefused(await window.next(Buffer.concat([head, sig])));
  });

  it('a reflected ephemeral key refuses even under the real signature', async () => {
    const window = makeWindow();
    const helloW = (await window.next(null)).out[0];
    const key = nodeKey();
    const head = Buffer.concat([Buffer.from([0x02]), helloW.subarray(2, 34), Buffer.from(key.nodeId, 'ascii'), key.publicKey]);
    const sig = key.sign(Buffer.concat([Buffer.from('kl-window-v1\nnode\n'), Buffer.from(SESSION, 'base64url'), helloW, head]));
    assertHandshakeRefused(await window.next(Buffer.concat([head, sig])));
  });

  it('a message that arrives while a signature is pending refuses, and the signature goes nowhere', async () => {
    let release;
    const key = nodeKey();
    const node = WindowSeal.node({
      sessionId: SESSION,
      identity: { ...key, sign: (b) => new Promise((resolve) => { release = () => resolve(key.sign(b)); }) },
      lookupDevice: lookupOf('A')
    });
    const hello = (await makeWindow().next(null)).out[0];
    const pending = node.next(hello);
    assertHandshakeRefused(await node.next(hello));
    release();
    assertHandshakeRefused(await pending);
  });

  it('a signer that fails or gives the wrong size refuses', async () => {
    const key = windowKey();
    for (const sign of [async () => { throw new Error('locked'); }, async () => Buffer.alloc(10)]) {
      const window = WindowSeal.window({ sessionId: SESSION, deviceId: key.deviceId, publicKey: key.publicKey, pin: null, sign });
      const hello = await window.next(null);
      const answer = await makeNode().next(hello.out[0]);
      assertHandshakeRefused(await window.next(answer.out[0]));
    }
  });

  it('malformed input refuses before anything of it is read, whatever its size', async () => {
    const huge = Buffer.alloc(RECORD_WIRE_MAX + 1);
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(85), Buffer.alloc(87), huge, 'text', { length: 86 }]) {
      assertHandshakeRefused(await makeNode().next(bytes));
    }
    const window = makeWindow();
    await window.next(null);
    assertHandshakeRefused(await window.next(huge));
  });

  it('every handshake failure on the node reads the same', async () => {
    const seen = new Set();
    const hello = (await makeWindow().next(null)).out[0];
    const cases = [
      async () => makeNode().next(Buffer.alloc(10)),
      async () => { const b = Buffer.from(hello); b[0] = 9; return makeNode().next(b); },
      async () => { const n = makeNode(); await n.next(hello); return n.next(Buffer.alloc(65, 3)); },
      async () => { const n = makeNode({ lookup: () => null }); await n.next(hello); return n.next(Buffer.alloc(65, 3)); }
    ];
    for (const run of cases) seen.add(JSON.stringify((await run()).close));
    assert.equal(seen.size, 1);
  });

  it('nothing can be sent before ready', async () => {
    const window = makeWindow();
    await window.next(null);
    assert.throws(() => window.wrap(Buffer.from('x')), { code: 'SEAL_NOT_READY' });
    assert.throws(() => window.ping(), { code: 'SEAL_NOT_READY' });
    assert.throws(() => window.closeRecord(1000), { code: 'SEAL_NOT_READY' });
  });

  it('a session id that is not 32 bytes of canonical base64url is a caller error', () => {
    for (const sessionId of ['short', `${SESSION}A`, Buffer.alloc(32), null]) {
      assert.throws(() => makeWindow({ session: sessionId }), { code: 'SEAL_INVALID' });
      assert.throws(() => makeNode({ session: sessionId }), { code: 'SEAL_INVALID' });
    }
  });

  it('keys that are not what the ids say are a caller error', () => {
    const key = windowKey();
    assert.throws(() => WindowSeal.window({ sessionId: SESSION, deviceId: windowKey('B').deviceId, publicKey: key.publicKey, sign: key.sign, pin: null }), { code: 'SEAL_INVALID' });
    assert.throws(() => WindowSeal.node({ sessionId: SESSION, identity: { ...nodeKey(), nodeId: nodeKey('gpu-box').nodeId }, lookupDevice: () => null }), { code: 'SEAL_INVALID' });
    assert.throws(() => WindowSeal.window({ sessionId: SESSION, ...key, pin: Buffer.alloc(31) }), { code: 'SEAL_INVALID' });
    assert.throws(() => WindowSeal.window({ sessionId: SESSION, ...key, pin: null, ephemeral: Buffer.alloc(16) }), { code: 'SEAL_INVALID' });
  });
});

describe('records', () => {
  it('a tampered record closes the session and no later record opens', async () => {
    const { window, node } = await readyPair();
    const [good] = window.wrap(Buffer.from('one'));
    const [later] = window.wrap(Buffer.from('two'));
    for (const offset of [0, 1, 8, 9, 100, good.length - 1]) {
      const pair = await readyPair();
      const [record] = pair.window.wrap(Buffer.from('one'));
      const bad = Buffer.from(record);
      bad[offset] ^= 0x40;
      assertRecordRefused(await pair.node.next(bad));
      const [after] = pair.window.wrap(Buffer.from('two'));
      const result = await pair.node.next(after);
      assert.deepEqual(result.close, { code: 4400, reason: 'record' });
      assert.deepEqual(result.frames, []);
    }
    assert.deepEqual((await node.next(good)).frames, [Buffer.from('one')]);
    assert.deepEqual((await node.next(later)).frames, [Buffer.from('two')]);
  });

  it('a replayed record closes', async () => {
    const { window, node } = await readyPair();
    const [record] = window.wrap(Buffer.from('one'));
    assert.deepEqual((await node.next(record)).frames, [Buffer.from('one')]);
    assertRecordRefused(await node.next(record));
  });

  it('a reordered record closes', async () => {
    const { window, node } = await readyPair();
    window.wrap(Buffer.from('one'));
    const [second] = window.wrap(Buffer.from('two'));
    assertRecordRefused(await node.next(second));
  });

  it('a record reflected to its sender closes', async () => {
    const { window } = await readyPair();
    const [record] = window.wrap(Buffer.from('one'));
    assertRecordRefused(await window.next(record));
  });

  it('a record of one session does not open in another', async () => {
    const first = await readyPair();
    const second = await readyPair();
    const [record] = first.window.wrap(Buffer.from('one'));
    assertRecordRefused(await second.node.next(record));
  });

  it('the handshake cannot be replayed into a live session', async () => {
    const { node, helloW, authW } = await readyPair();
    assertRecordRefused(await node.next(helloW));
    const other = await readyPair();
    assertRecordRefused(await other.node.next(authW));
  });

  it('a record before the handshake ends is a handshake failure', async () => {
    const { window } = await readyPair();
    const [record] = window.wrap(Buffer.from('one'));
    assertHandshakeRefused(await makeNode().next(record));
  });

  it('a record that is too long, or of no possible length, closes before it is opened', async () => {
    for (const size of [RECORD_WIRE_MAX + 256, 281 + 1, 280, 9, 0]) {
      const { node } = await readyPair();
      const bytes = Buffer.alloc(size);
      if (size > 0) bytes[0] = 0x10;
      assertRecordRefused(await node.next(bytes));
    }
  });

  it('a counter ends rather than wraps', () => {
    assert.equal(advanceCounter(0n), 1n);
    assert.equal(advanceCounter((1n << 64n) - 2n), (1n << 64n) - 1n);
    assert.equal(advanceCounter((1n << 64n) - 1n), null);
  });
});

describe('padding', () => {
  it('two different short frames of similar size give equal record lengths', async () => {
    const { window } = await readyPair();
    const [a] = window.wrap(Buffer.from('{"t":"event","ch":"chat:messageChunk","d":"hi"}'));
    const [b] = window.wrap(Buffer.from('{"t":"result","id":1,"ok":false,"code":"X"}'));
    assert.equal(a.length, b.length);
    assert.equal(a.length, 9 + PAD_SMALL + 16);
  });

  it('is to the rule on either side of each edge', async () => {
    const { window } = await readyPair();
    const size = async (bytes) => window.wrap(Buffer.alloc(bytes, 0x61))[0].length - 25;
    assert.equal(await size(0), 256);
    assert.equal(await size(251), 256);
    assert.equal(await size(252), 512);
    assert.equal(await size(65535), 65792);
    assert.equal(await size(65536), 69632);
    assert.equal(await size(RECORD_MAX), 1052672);
  });

  it('a control record is one short block', async () => {
    const { window } = await readyPair();
    assert.equal(window.ping().length, 281);
    assert.equal(window.closeRecord(1000).length, 281);
  });

  it('the padding is checked: nonzero or too much closes, under a good tag', async () => {
    const raw = await rawSealedPair();
    const cases = [
      plain(0x00, Buffer.from('abc'), 256, (p) => { p[100] = 1; }),      // a pad byte that is not zero
      plain(0x00, Buffer.from('abc'), 512),                              // a block more than the rule
      plain(0x00, Buffer.alloc(70000, 0x61), 256),                       // a large frame on the small rule
      plain(0x01, Buffer.alloc(100, 0x61), 256),                         // a fragment shorter than a record
      plain(0x20, Buffer.from('x'), 256),                                // a ping with a body
      plain(0x30, Buffer.from('xy'), 256),                               // a close code that is not 4 bytes
      plain(0x30, Buffer.from([0, 0, 0, 1]), 256)                        // a close code outside the range
    ];
    for (const p of cases) {
      const pair = await raw();
      assertRecordRefused(await pair.node.next(pair.seal(0n, p)));
    }
  });

  it('a claimed length past the plaintext closes, under a good tag', async () => {
    const raw = await rawSealedPair();
    const pair = await raw();
    const p = Buffer.alloc(256);
    p.writeUInt32BE(0xffffffff, 1);
    assertRecordRefused(await pair.node.next(pair.seal(0n, p)));
  });

  it('an unknown kind closes, under a good tag', async () => {
    const raw = await rawSealedPair();
    const pair = await raw();
    assertRecordRefused(await pair.node.next(pair.seal(0n, plain(0x7f, Buffer.alloc(0), 256))));
  });
});

// A pair whose window key is known, so a test can seal what no honest sender would.
function plain(kind, bytes, multiple, edit = null) {
  const total = Math.ceil((5 + bytes.length) / multiple) * multiple;
  const p = Buffer.alloc(total);
  p[0] = kind;
  p.writeUInt32BE(bytes.length, 1);
  bytes.copy(p, 5);
  if (edit) edit(p);
  return p;
}
async function rawSealedPair() {
  const label = crypto.createHash('sha256').update('raw window epk').digest();
  const nodeEph = crypto.createHash('sha256').update('raw node epk').digest();
  return async () => {
    const window = makeWindow({ ephemeral: label });
    const node = makeNode({ ephemeral: nodeEph });
    const { helloW, helloN } = await runHandshake(window, node);
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), helloN.subarray(1, 33)]), format: 'der', type: 'spki' });
    const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), label]), format: 'der', type: 'pkcs8' });
    const ss = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
    const salt = crypto.createHash('sha256').update(Buffer.from(SESSION, 'base64url')).update(helloW).update(helloN).digest();
    const key = Buffer.from(crypto.hkdfSync('sha256', ss, salt, 'kl-window-v1 w2n', 32));
    const seal = (counter, plaintext) => {
      const c = Buffer.alloc(8);
      c.writeBigUInt64BE(counter);
      const cipher = crypto.createCipheriv('chacha20-poly1305', key, Buffer.concat([Buffer.alloc(4), c]), { authTagLength: 16 });
      cipher.setAAD(Buffer.concat([Buffer.from([1, 0]), c]), { plaintextLength: plaintext.length });
      const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      return Buffer.concat([Buffer.from([0x10]), c, ct]);
    };
    return { window, node, seal };
  };
}

describe('large frames', () => {
  it('a frame of exactly RECORD_MAX is one record', async () => {
    const { window, node } = await readyPair();
    const frame = crypto.randomBytes(RECORD_MAX);
    const records = window.wrap(frame);
    assert.equal(records.length, 1);
    assert.equal(records[0].length, RECORD_WIRE_MAX);
    assert.deepEqual((await node.next(records[0])).frames, [frame]);
  });

  it('a frame a byte over is two, with the small end padded to the large rule', async () => {
    const { window, node } = await readyPair();
    const frame = crypto.randomBytes(RECORD_MAX + 1);
    const records = window.wrap(frame);
    assert.equal(records.length, 2);
    assert.equal(records[1].length, 9 + PAD_LARGE + 16);
    assert.deepEqual((await node.next(records[0])).frames, []);
    assert.deepEqual((await node.next(records[1])).frames, [frame]);
  });

  it('a ping between fragments does not break the frame', async () => {
    const { window, node } = await readyPair();
    const frame = crypto.randomBytes(RECORD_MAX + 10);
    const iterator = window.records(frame);
    const first = iterator.next().value;
    const ping = window.ping();
    const second = iterator.next().value;
    assert.equal(iterator.next().done, true);
    assert.deepEqual((await node.next(first)).frames, []);
    const answered = await node.next(ping);
    assert.equal(answered.out.length, 1);
    assert.deepEqual((await node.next(second)).frames, [frame]);
    assert.deepEqual((await window.next(answered.out[0])).frames, []);
  });

  it('a second frame cannot start inside the first', async () => {
    const { window } = await readyPair();
    const iterator = window.records(Buffer.alloc(RECORD_MAX + 10));
    iterator.next();
    assert.throws(() => window.wrap(Buffer.from('x')), { code: 'SEAL_BUSY' });
    assert.throws(() => window.records(Buffer.from('x')), { code: 'SEAL_BUSY' });
  });

  it('a frame given up halfway ends the sending side, so nothing merges into it', async () => {
    const { window } = await readyPair();
    const iterator = window.records(Buffer.alloc(RECORD_MAX + 10));
    iterator.next();
    iterator.return();
    assert.throws(() => window.wrap(Buffer.from('x')), { code: 'SEAL_BUSY' });
  });

  it('a frame over the bridge limit is refused before a counter moves', async () => {
    const { window, node } = await readyPair();
    assert.throws(() => window.wrap(Buffer.alloc(LIMITS.frameBytes + 1)), { code: 'PAYLOAD_TOO_LARGE' });
    assert.deepEqual((await node.next(window.wrap(Buffer.from('after'))[0])).frames, [Buffer.from('after')]);
  });

  it('a fragment run over the limit closes, before it is held', async () => {
    const raw = await rawSealedPair();
    const pair = await raw();
    const fragment = plain(0x01, Buffer.alloc(RECORD_MAX, 0x61), PAD_LARGE);
    // 63 leave room for the final one; a 64th would leave none.
    const count = LIMITS.frameBytes / RECORD_MAX - 1;
    let counter = 0n;
    for (; counter < BigInt(count); counter += 1n) {
      assert.equal((await pair.node.next(pair.seal(counter, fragment))).close, null);
    }
    assertRecordRefused(await pair.node.next(pair.seal(counter, fragment)));
  });

  it('a final fragment with nothing in it closes, as no sender makes one', async () => {
    const raw = await rawSealedPair();
    const pair = await raw();
    await pair.node.next(pair.seal(0n, plain(0x01, Buffer.alloc(RECORD_MAX, 0x61), PAD_LARGE)));
    assertRecordRefused(await pair.node.next(pair.seal(1n, plain(0x00, Buffer.alloc(0), PAD_LARGE))));
  });

  it('the largest frame the bridge allows crosses, through the sender', async () => {
    const { window, node } = await readyPair();
    const frame = Buffer.alloc(LIMITS.frameBytes);
    for (let i = 0; i < frame.length; i += 4096) frame.writeUInt32BE(i, i);
    const expected = crypto.createHash('sha256').update(frame).digest('hex');
    let got = null;
    const sender = createFrameSender({
      seal: window,
      write: async (record) => {
        const result = await node.next(record);
        assert.equal(result.close, null);
        if (result.frames.length) [got] = result.frames;
      }
    });
    await sender.send(frame);
    assert.equal(got.length, LIMITS.frameBytes);
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'), expected);
  });
});

describe('a slow reader', () => {
  // A socket that takes records only as the reader lets it.
  function slowSocket() {
    const taken = [];
    const waiting = [];
    return {
      taken,
      write(record) {
        taken.push(record.length);
        return new Promise((resolve) => waiting.push(resolve));
      },
      readOne() {
        const next = waiting.shift();
        if (next) next();
        return Boolean(next);
      },
      unread: () => waiting.length
    };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('does not make the sender encrypt ahead of it', async () => {
    const { window } = await readyPair();
    const socket = slowSocket();
    const highWater = 4 * RECORD_WIRE_MAX;
    const sender = createFrameSender({ seal: window, write: socket.write, highWater });
    const done = sender.send(Buffer.alloc(32 * MIB));
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(socket.taken.length, 4, 'records stop at the high water');
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(socket.taken.length, 4, 'and stay stopped');
    let most = 0;
    while (socket.readOne()) {
      await tick();
      most = Math.max(most, socket.unread());
    }
    assert.ok(most <= 4, `at most four records unread, saw ${most}`);
    await done;
    assert.equal(socket.taken.length, 32);
  });

  it('frames queued behind it are refused past the bound, and nothing else is lost', async () => {
    const { window } = await readyPair();
    const socket = slowSocket();
    const sender = createFrameSender({ seal: window, write: socket.write, highWater: RECORD_WIRE_MAX, maxQueuedBytes: 3 * MIB });
    const first = sender.send(Buffer.alloc(2 * MIB));
    const second = sender.send(Buffer.alloc(MIB));
    await assert.rejects(sender.send(Buffer.alloc(1)), { code: 'SEND_QUEUE_FULL' });
    while (socket.unread() || socket.taken.length < 3) {
      socket.readOne();
      await tick();
    }
    await first;
    await second;
  });

  it('a write that fails ends the sender and every queued frame', async () => {
    const { window } = await readyPair();
    const sender = createFrameSender({ seal: window, write: async () => { throw new Error('socket gone'); } });
    const a = sender.send(Buffer.from('one'));
    const b = sender.send(Buffer.from('two'));
    await assert.rejects(a, /socket gone/);
    await assert.rejects(b, /socket gone/);
    await assert.rejects(sender.send(Buffer.from('three')), /socket gone/);
  });

  it('stop refuses what is queued', async () => {
    const { window } = await readyPair();
    const socket = slowSocket();
    const sender = createFrameSender({ seal: window, write: socket.write, highWater: 1 });
    const a = sender.send(Buffer.alloc(3 * MIB));
    const b = sender.send(Buffer.from('two'));
    sender.stop();
    socket.readOne();
    await assert.rejects(a, { code: 'SEND_STOPPED' });
    await assert.rejects(b, { code: 'SEND_STOPPED' });
  });
});

describe('ping and close records', () => {
  it('a ping is answered with a pong, which gives nothing', async () => {
    const { window, node } = await readyPair();
    const answer = await node.next(window.ping());
    assert.equal(answer.out.length, 1);
    assert.deepEqual(answer.frames, []);
    const result = await window.next(answer.out[0]);
    assert.deepEqual(result.out, []);
    assert.deepEqual(result.frames, []);
    assert.equal(result.close, null);
  });

  it('a close record closes with its code, and nothing opens after it', async () => {
    const { window, node } = await readyPair();
    const record = window.closeRecord(4403);
    assert.deepEqual((await node.next(record)).close, { code: 4403, reason: 'peer' });
    assert.throws(() => node.wrap(Buffer.from('x')), { code: 'SEAL_CLOSED' });
    assert.throws(() => window.wrap(Buffer.from('x')), { code: 'SEAL_CLOSED' });
    assert.deepEqual((await node.next(Buffer.from(record))).close, { code: 4403, reason: 'peer' });
  });

  it('a close code outside 1000 to 4999 is a caller error', async () => {
    const { window } = await readyPair();
    for (const code of [999, 5000, 1.5, '1000']) assert.throws(() => window.closeRecord(code), { code: 'SEAL_INVALID' });
  });
});

describe('the heartbeat', () => {
  function fakeClock() {
    let now = 0;
    let timers = [];
    let id = 0;
    return {
      now: () => now,
      setTimer: (fn, ms) => { id += 1; timers.push({ id, at: now + ms, fn }); return id; },
      clearTimer: (timer) => { timers = timers.filter((t) => t.id !== timer); },
      pending: () => timers.length,
      advance(ms) {
        const end = now + ms;
        for (;;) {
          const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
          if (!due) break;
          timers = timers.filter((t) => t !== due);
          now = due.at;
          due.fn();
        }
        now = end;
      }
    };
  }
  function start(clock) {
    const log = { pings: [], silence: [] };
    const beat = startHeartbeat({
      ping: () => log.pings.push(clock.now()),
      onSilence: (close) => log.silence.push({ at: clock.now(), ...close }),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    return { beat, log };
  }

  it('pings after PING_MS of sending nothing, and not while frames go', () => {
    const clock = fakeClock();
    const { beat, log } = start(clock);
    clock.advance(PING_MS - 1);
    assert.deepEqual(log.pings, []);
    clock.advance(1);
    assert.deepEqual(log.pings, [PING_MS]);
    beat.received();
    clock.advance(10000);
    beat.sent();
    clock.advance(PING_MS - 1);
    assert.equal(log.pings.length, 1);
    clock.advance(1);
    assert.equal(log.pings.length, 2);
    beat.stop();
  });

  it('closes 1001 after SILENCE_MS without a record, and pings no more', () => {
    const clock = fakeClock();
    const { log } = start(clock);
    clock.advance(SILENCE_MS - 1);
    assert.deepEqual(log.silence, []);
    clock.advance(1);
    assert.deepEqual(log.silence, [{ at: SILENCE_MS, code: 1001, reason: 'silence' }]);
    const pings = log.pings.length;
    clock.advance(10 * SILENCE_MS);
    assert.equal(log.pings.length, pings);
    assert.equal(clock.pending(), 0);
  });

  it('any record received holds the silence off', () => {
    const clock = fakeClock();
    const { beat, log } = start(clock);
    for (let i = 0; i < 10; i += 1) {
      clock.advance(SILENCE_MS - 1);
      beat.received();
    }
    assert.deepEqual(log.silence, []);
    beat.stop();
  });

  it('stop leaves no timer', () => {
    const clock = fakeClock();
    const { beat, log } = start(clock);
    beat.stop();
    assert.equal(clock.pending(), 0);
    clock.advance(10 * SILENCE_MS);
    assert.deepEqual(log.pings, []);
    assert.deepEqual(log.silence, []);
  });

  it('uses a ref\'d timer: nothing in the module unrefs', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop-bridge', 'window-seal.js'), 'utf8');
    assert.doesNotMatch(text, /\.unref\(/);
  });
});

describe('the source', () => {
  const SRC = path.join(__dirname, '..', 'src');
  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  it('no file under src/ but the seal itself injects an ephemeral key', () => {
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (rel === 'desktop-bridge/window-seal.js') continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!/window-seal|WindowSeal/.test(text)) continue;
      assert.doesNotMatch(text, /\bephemeral\b/, `${rel} names ephemeral`);
      // An alias or a spread could carry one past the word.
      assert.doesNotMatch(text, /=\s*WindowSeal\b(?!\.)/, `${rel} aliases WindowSeal`);
      assert.doesNotMatch(text, /WindowSeal\.(window|node)\b(?!\s*\()/, `${rel} takes a constructor by name`);
      for (const match of text.matchAll(/WindowSeal\.(window|node)\s*\(/g)) {
        assert.doesNotMatch(argumentsAt(text, match.index + match[0].length - 1), /\.\.\./, `${rel} spreads into the call`);
      }
    }
  });

  function argumentsAt(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) return text.slice(open + 1, i);
      }
    }
    throw new Error('unbalanced call');
  }

  it('it uses node:crypto, the bridge\'s keys and protocol, and nothing else', () => {
    const text = fs.readFileSync(path.join(SRC, 'desktop-bridge', 'window-seal.js'), 'utf8');
    const required = [...text.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(required, ['./keys', './protocol', 'crypto']);
  });

  it('the front door, the relay and the runbook code do not load it', () => {
    // The agent profile and the window's hosts may. tests/service-profile-graph.test.js
    // forbids the whole of src/desktop-bridge/ from those graphs at Task 7.
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (!/^(frontdoor|fleet|approvals|mesh|runbooks?)\//.test(rel)) continue;
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /window-seal/, `${rel} loads the seal`);
    }
  });
});
