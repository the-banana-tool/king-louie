// tests/window-vectors.test.js
//
// Runs every window-v1 vector through the production seal, opens records with the
// vector's keys without the seal, and checks the committed files are exactly what
// generate.js produces.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WindowSeal } = require('../src/desktop-bridge/window-seal');
const { windowKey, nodeKey, lookupOf, runHandshake, sealed, drive, sealFrame, closeRecordOf } = require('./helpers/window-seal-fixture');
const { buildVectors, serialize } = require('./vectors/window-v1/generate');

const DIR = path.join(__dirname, 'vectors', 'window-v1');
const EXPECTED = [
  'handshake-ok', 'handshake-wrong-session', 'handshake-wrong-node-key', 'handshake-unknown-device', 'handshake-reflected', 'handshake-truncated',
  'record-roundtrip', 'record-tampered', 'record-replayed', 'record-reordered', 'record-wrong-key', 'record-unknown-kind', 'record-oversized', 'record-bad-close-code', 'close-record'
];
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const raw = (text) => Buffer.from(text, 'base64url');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('base64url');

const windowFrom = (g, { session = g.session_id } = {}) => sealed((host) => WindowSeal.window({ ...host, sessionId: session, ...windowKey(g.window.key), pin: raw(g.pin), ephemeral: raw(g.window.ephemeral) }));
const nodeFrom = (g, { session = g.session_id, lookup = lookupOf(g.window.key) } = {}) => sealed((host) => WindowSeal.node({ ...host, sessionId: session, identity: nodeKey(g.node.key), lookupDevice: lookup, ephemeral: raw(g.node.ephemeral) }));
async function live(g) {
  const window = windowFrom(g);
  const node = nodeFrom(g);
  await runHandshake(window, node);
  return { window, node };
}

// A seal standing where the case's bytes arrive.
async function atStage(g, { to, stage }) {
  if (to === 'window') {
    const window = windowFrom(g);
    await drive(window, null);
    return window;
  }
  const node = nodeFrom(g);
  if (stage === 'auth') await drive(node, (await drive(windowFrom(g), null)).out[0]);
  return node;
}
function assertClosed(result, close) {
  assert.deepEqual(result.close, close);
  assert.deepEqual(result.out, []);
  assert.deepEqual(result.frames, []);
}

describe('window-v1 vectors', () => {
  it('the committed files are what generate.js produces', async () => {
    const vectors = await buildVectors();
    assert.deepEqual(vectors.map((v) => v.name).sort(), [...EXPECTED].sort());
    for (const v of vectors) {
      assert.deepEqual(v.consumers, ['node']);
      assert.equal(fs.readFileSync(path.join(DIR, `${v.name}.json`), 'utf8'), serialize(v), `${v.name}.json differs`);
    }
  });

  it('handshake-ok: the seal makes these bytes, and these keys open its records', async () => {
    const { given: g, input, expect } = load('handshake-ok');
    const window = windowFrom(g);
    const node = nodeFrom(g);
    const wire = await runHandshake(window, node);
    assert.equal(wire.helloW.toString('base64url'), input.hello_w);
    assert.equal(wire.helloN.toString('base64url'), input.hello_n);
    assert.equal(wire.authW.toString('base64url'), input.auth_w);
    assert.equal(wire.helloN.subarray(84).toString('base64url'), expect.sig_node);
    assert.equal(wire.authW.subarray(1).toString('base64url'), expect.sig_dev);
    assert.equal(wire.windowResult.peer.nodeId, g.node.node_id);
    assert.equal(wire.nodeResult.peer.deviceId, g.window.device_id);
    assert.ok(crypto.verify(null, raw(expect.node_signed), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw(g.node.public_key)]), format: 'der', type: 'spki' }), raw(expect.sig_node)));

    const openWith = (key, dir, record, counter) => {
      const c = Buffer.alloc(8);
      c.writeBigUInt64BE(counter);
      assert.deepEqual(record.subarray(1, 9), c);
      const d = crypto.createDecipheriv('chacha20-poly1305', raw(key), Buffer.concat([Buffer.alloc(4), c]), { authTagLength: 16 });
      d.setAAD(Buffer.concat([Buffer.from([1, dir]), c]));
      d.setAuthTag(record.subarray(record.length - 16));
      return Buffer.concat([d.update(record.subarray(9, record.length - 16)), d.final()]);
    };
    const w2n = openWith(expect.k_w2n, 0, sealFrame(window, Buffer.from('to the node'))[0], 0n);
    assert.equal(w2n.subarray(5, 16).toString(), 'to the node');
    const n2w = openWith(expect.k_n2w, 1, sealFrame(node, Buffer.from('to the window'))[0], 0n);
    assert.equal(n2w.subarray(5, 18).toString(), 'to the window');
  });

  it('handshake-wrong-session: neither side goes on', async () => {
    const { given: g, input, expect } = load('handshake-wrong-session');
    const window = windowFrom(g);
    await drive(window, null);
    const atWindow = await drive(window, raw(input.hello_n_other_session));
    assertClosed(atWindow, expect.window_on_other_hello_n);
    const node = nodeFrom(g, { session: g.other_session_id });
    assert.equal((await drive(node, raw(input.hello_w))).out[0].toString('base64url'), input.hello_n_other_session);
    assertClosed(await drive(node, raw(input.auth_w)), expect.node_on_other_session);
  });

  it('handshake-wrong-node-key: auth_w is never produced', async () => {
    const { given: g, input, expect } = load('handshake-wrong-node-key');
    const window = windowFrom(g);
    await drive(window, null);
    const result = await drive(window, raw(input.hello_n));
    assert.deepEqual(result.close, expect.close);
    assert.deepEqual(result.out, expect.out);
  });

  it('handshake-unknown-device: answered like a known one, then the one code', async () => {
    const { given: g, input, expect } = load('handshake-unknown-device');
    for (const [lookup, close] of [[() => null, expect.close], [() => raw(expect.stored_other_key.key), expect.stored_other_key.close]]) {
      const node = nodeFrom(g, { lookup });
      const hello = await drive(node, raw(input.hello_w));
      assert.equal(hello.out.length === 1, expect.hello_n_answered);
      assert.equal(hello.out[0].toString('base64url'), input.hello_n);
      const result = await drive(node, raw(input.auth_w));
      assertClosed(result, close);
      assert.equal(result.peer, null);
    }
  });

  for (const name of ['handshake-reflected', 'handshake-truncated']) {
    it(`${name}: every case closes with the one code`, async () => {
      const { given: g, input, expect } = load(name);
      for (const c of input.cases) {
        const seal = await atStage(g, c);
        const result = await drive(seal, raw(c.bytes));
        assert.deepEqual(result.close, expect.close, c.name);
        assert.deepEqual(result.out, expect.out, c.name);
      }
    });
  }

  it('record-roundtrip: sizes, padding and bytes, both ways', async () => {
    const { given: g, input, expect } = load('record-roundtrip');
    const { window, node } = await live(g);
    for (const [i, frame] of input.frames.entries()) {
      const [from, to] = frame.from === 'window' ? [window, node] : [node, window];
      const bytes = Buffer.alloc(frame.bytes, frame.fill);
      const records = sealFrame(from, bytes);
      const want = expect.frames[i];
      assert.deepEqual(records.map((r) => ({ length: r.length, sha256: sha256(r) })), want.records);
      for (const r of records) assert.equal((r.length - 25) % want.multiple, 0);
      let got = [];
      for (const r of records) got = (await drive(to, r)).frames;
      assert.deepEqual(got, [bytes]);
    }
    assert.equal(expect.frames[0].records.length, 1);
    assert.equal(expect.frames[0].records[0].length, 25 + 256);
    assert.equal(expect.frames[2].records.length, 2);
  });

  it('record-tampered: closes, and no later record opens', async () => {
    const { given: g, input, expect } = load('record-tampered');
    const { node } = await live(g);
    assertClosed(await drive(node, raw(input.tampered)), expect.close);
    assertClosed(await drive(node, raw(input.later)), expect.close);
  });

  it('record-replayed: the second time closes', async () => {
    const { given: g, input, expect } = load('record-replayed');
    const { node } = await live(g);
    assert.equal((await drive(node, raw(input.first))).frames[0].toString('base64url'), expect.first_frame);
    assertClosed(await drive(node, raw(input.replay)), expect.close);
  });

  it('record-reordered: the early one closes, and the right one no longer opens', async () => {
    const { given: g, input, expect } = load('record-reordered');
    const { node } = await live(g);
    assertClosed(await drive(node, raw(input.first_on_the_wire)), expect.close);
    assertClosed(await drive(node, raw(input.second_on_the_wire)), expect.close);
  });

  it('record-wrong-key: closes under every wrong key, and opens under the right one', async () => {
    const { given: g, input, expect } = load('record-wrong-key');
    for (const c of input.cases) {
      const { node } = await live(g);
      assert.deepEqual((await drive(node, raw(c.bytes))).close, expect.close, c.name);
    }
    const { node } = await live(g);
    assert.equal((await drive(node, raw(input.control))).frames[0].toString('base64url'), expect.control_frame);
  });

  it('record-unknown-kind: closes under a good tag', async () => {
    const { given: g, input, expect } = load('record-unknown-kind');
    const { node } = await live(g);
    assertClosed(await drive(node, raw(input.record)), expect.close);
  });

  it('record-bad-close-code: a code a socket cannot send closes as a failure', async () => {
    const { given: g, input, expect } = load('record-bad-close-code');
    for (const c of input.cases) {
      const { node } = await live(g);
      assertClosed(await drive(node, raw(c.bytes)), expect.close);
    }
    const { node } = await live(g);
    assert.deepEqual((await drive(node, raw(input.control))).close, expect.control_close);
  });

  it('record-oversized: a claimed length and a wire length both close, the second unopened', async (t) => {
    const { given: g, input, expect } = load('record-oversized');
    const first = await live(g);
    assertClosed(await drive(first.node, raw(input.claimed_length)), expect.close);
    const second = await live(g);
    const big = Buffer.alloc(input.wire_bytes);
    big[0] = 0x10;
    const spy = t.mock.method(crypto, 'createDecipheriv');
    assertClosed(await drive(second.node, big), expect.close);
    assert.equal(spy.mock.callCount(), 0);
  });

  it('close-record: the code arrives, and nothing opens after it', async () => {
    const { given: g, input, expect } = load('close-record');
    const { window, node } = await live(g);
    assert.equal(closeRecordOf(window, 1000).toString('base64url'), input.record);
    assertClosed(await drive(node, raw(input.record)), expect.close);
    assertClosed(await drive(node, raw(input.later)), expect.close);
    assert.equal(raw(expect.plaintext).length, 256);
  });
});
