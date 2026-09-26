// tests/mesh-hardening.test.js — fleet stage 4 §3.10.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { once, EventEmitter } = require('events');
const WebSocket = require('ws');
const { MeshIdentity } = require('../src/mesh/mesh-identity');
const { MeshTransport, CLOSE_CODES, PRE_AUTH_MAX_BYTES, MAX_PAYLOAD_BYTES } = require('../src/mesh/mesh-transport');
const { MeshPairing, WORDLIST, pairingProof } = require('../src/mesh/mesh-pairing');
const { createLinkRpc } = require('../src/approvals/link-rpc');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()().catch(() => {}); });

async function waitFor(fn, what, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function listener(identity = new MeshIdentity({ displayName: 'listener' })) {
  const t = new MeshTransport({ identity, host: '127.0.0.1', port: 0, useTls: false });
  await t.start();
  cleanups.push(() => t.stop());
  return t;
}

async function linked() {
  const a = await listener();
  const bId = new MeshIdentity({ displayName: 'dialer' });
  const b = new MeshTransport({ identity: bId, listen: false, useTls: false });
  await b.start();
  cleanups.push(() => b.stop());
  a.addTrustedPeer(bId.peerId, bId.publicKey);
  b.addTrustedPeer(a.identity.peerId, a.identity.publicKey);
  await b.connectToPeer('127.0.0.1', a.port);
  await waitFor(() => a.getPeer(bId.peerId), 'the listener to promote the dialer');
  return { a, b, aId: a.identity, bId };
}

// A wait that fails by name instead of hanging the file (Linux, Node 22).
function within(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function envelopeWith(identity, to, payload, { nonce = crypto.randomBytes(16).toString('hex'), timestamp = Date.now() } = {}) {
  const body = JSON.stringify({ nonce, timestamp, to, payload });
  return { from: identity.peerId, to, nonce, timestamp, signature: identity.sign(body).toString('hex'), payload };
}

function rawSend(transport, peerId, frame) {
  const peer = transport.peers.get(peerId);
  peer.sendSeq += 1;
  peer.ws.send(JSON.stringify({ seq: peer.sendSeq, ...frame }));
}

describe('frame limits and auth before parse', () => {
  it('limits a frame to 1 MiB and an unauthenticated one to 16 KiB', () => {
    assert.equal(MAX_PAYLOAD_BYTES, 1024 * 1024);
    assert.equal(PRE_AUTH_MAX_BYTES, 16 * 1024);
  });

  it('closes an oversized pre-auth frame with 1009 without parsing it', async () => {
    const a = await listener();
    const realParse = JSON.parse;
    let bigParses = 0;
    JSON.parse = function parse(text, ...rest) {
      if (String(text).length > PRE_AUTH_MAX_BYTES) bigParses += 1;
      return realParse.call(this, text, ...rest);
    };
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'auth:challenge', pad: 'x'.repeat(20 * 1024) }));
      const [code] = await once(ws, 'close');
      assert.equal(code, CLOSE_CODES.tooBig);
    } finally {
      JSON.parse = realParse;
    }
    assert.equal(bigParses, 0);
  });

  it('closes anything that is not exactly auth:challenge or pair:request with 4001', async () => {
    const a = await listener();
    for (const frame of [{ type: 'hello' }, { type: 'auth:challenge', authId: 'x', challenge: 'y' }, [1, 2], 'not json']) {
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
      await once(ws, 'open');
      ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
      const [code] = await once(ws, 'close');
      assert.equal(code, CLOSE_CODES.unauthenticated, JSON.stringify(frame));
    }
  });

  // Ruling T6-cap (fix round 1): the cap evicts the OLDEST unauthenticated
  // socket (4029) instead of refusing the newest, so holding sockets open
  // cannot keep a valid peer out.
  it('holds at most 8 unauthenticated sockets per IP, evicting the oldest', async () => {
    const a = await listener();
    const open = [];
    for (let i = 0; i < 8; i += 1) {
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
      await once(ws, 'open');
      open.push(ws);
    }
    const oldestClosed = within(once(open[0], 'close'), 5000, 'the oldest socket to be evicted');
    const ninth = new WebSocket(`ws://127.0.0.1:${a.port}`);
    await once(ninth, 'open');
    const [code] = await oldestClosed;
    assert.equal(code, CLOSE_CODES.rateLimited);
    await waitFor(() => a.unauth.size === 8, 'eight unauthenticated sockets');
    assert.equal(ninth.readyState, WebSocket.OPEN);
    for (const ws of [...open, ninth]) ws.terminate();
  });

  it('closes a socket that sends no first frame within about 2 s', async () => {
    const a = await listener();
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
    await once(ws, 'open');
    const started = Date.now();
    const [code] = await within(once(ws, 'close'), 5000, 'the first-frame deadline');
    assert.equal(code, CLOSE_CODES.unauthenticated);
    assert.ok(Date.now() - started < 4000, `closed after ${Date.now() - started} ms`);
  });

  it('an attacker holding 8 sockets on the same address cannot keep a valid peer out', async () => {
    const a = await listener();
    const held = [];
    for (let i = 0; i < 8; i += 1) {
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
      ws.on('error', () => {});
      await once(ws, 'open');
      held.push(ws);
    }
    const bId = new MeshIdentity({ displayName: 'dialer' });
    a.addTrustedPeer(bId.peerId, bId.publicKey);
    const b = new MeshTransport({ identity: bId, listen: false, useTls: false });
    await b.start();
    cleanups.push(() => b.stop());
    b.addTrustedPeer(a.identity.peerId, a.identity.publicKey);
    await within(b.connectToPeer('127.0.0.1', a.port), 5000, 'b to authenticate');
    await waitFor(() => a.getPeer(bId.peerId), 'the listener to promote b');
    for (const ws of held) ws.terminate();
  });

  it('churn at the global cap from other addresses cannot keep a valid peer out', async () => {
    const a = await listener();
    let stop = false;
    let opened = 0;
    const live = new Set();
    cleanups.push(async () => { stop = true; for (const ws of live) ws.terminate(); });
    // 8 addresses x 8 sockets fills the global cap of 64; every socket that
    // is evicted (or times out) is reopened at once from the same address.
    const hold = (localAddress) => {
      if (stop) return;
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}`, { localAddress });
      live.add(ws);
      ws.on('error', () => {});
      ws.on('open', () => { opened += 1; });
      ws.on('close', () => { live.delete(ws); hold(localAddress); });
    };
    for (let ip = 2; ip <= 9; ip += 1) for (let i = 0; i < 8; i += 1) hold(`127.0.0.${ip}`);
    await waitFor(() => a.unauth.size === 64, 'the global cap to fill');
    const bId = new MeshIdentity({ displayName: 'dialer' });
    a.addTrustedPeer(bId.peerId, bId.publicKey);
    const b = new MeshTransport({ identity: bId, listen: false, useTls: false });
    await b.start();
    cleanups.push(() => b.stop());
    b.addTrustedPeer(a.identity.peerId, a.identity.publicKey);
    const before = opened;
    await within(b.connectToPeer('127.0.0.1', a.port), 5000, 'b to authenticate');
    await waitFor(() => a.getPeer(bId.peerId), 'the listener to promote b');
    await waitFor(() => opened > before, 'the churn to continue');
    stop = true;
    assert.ok(a.unauth.size <= 64);
  });
});

describe('authenticated links', () => {
  it('still authenticates and carries messages, with a sequence number on every frame', async () => {
    const { a, b, aId, bId } = await linked();
    const got = once(a, 'peerMessage');
    b.send(aId.peerId, { hello: 'world' });
    const [{ from, payload }] = await got;
    assert.equal(from, bId.peerId);
    assert.deepEqual(payload, { hello: 'world' });
    assert.equal(a.getPeer(bId.peerId).recvSeq, 1);
  });

  it('a replayed or unsequenced frame closes the link with 4010', async () => {
    const { b, aId } = await linked();
    const closed = within(once(b, 'peerDisconnected'), 10000, 'the link to close');
    b.peers.get(aId.peerId).ws.send(JSON.stringify({ type: 'mesh:heartbeat', seq: 0 }));
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.replayDetected);
  });

  it('drops an envelope signed before this connection authenticated', async () => {
    const { a, b, aId, bId } = await linked();
    const seen = [];
    a.on('peerMessage', (m) => seen.push(m.payload));
    const authAt = a.getPeer(bId.peerId).authAt;
    rawSend(b, aId.peerId, { type: 'mesh:message', envelope: envelopeWith(bId, aId.peerId, { n: 'stale' }, { timestamp: authAt - 10000 }) });
    rawSend(b, aId.peerId, { type: 'mesh:message', envelope: envelopeWith(bId, aId.peerId, { n: 'fresh' }) });
    await waitFor(() => seen.length === 1, 'the fresh message');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, [{ n: 'fresh' }]);
  });

  it('keeps nonces per peer: one peer cannot burn another peer\'s nonce', async () => {
    const a = await listener();
    const seen = [];
    a.on('peerMessage', (m) => seen.push(`${m.from}:${m.payload.n}`));
    const dialers = [];
    for (const name of ['b', 'c']) {
      const id = new MeshIdentity({ displayName: name });
      const t = new MeshTransport({ identity: id, listen: false, useTls: false });
      await t.start();
      cleanups.push(() => t.stop());
      a.addTrustedPeer(id.peerId, id.publicKey);
      t.addTrustedPeer(a.identity.peerId, a.identity.publicKey);
      await t.connectToPeer('127.0.0.1', a.port);
      await waitFor(() => a.getPeer(id.peerId), `${name} linked`);
      dialers.push({ t, id });
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    for (const { t, id } of dialers) rawSend(t, a.identity.peerId, { type: 'mesh:message', envelope: envelopeWith(id, a.identity.peerId, { n: 1 }, { nonce }) });
    await waitFor(() => seen.length === 2, 'both messages with the same nonce');
    const [{ t, id }] = dialers;
    rawSend(t, a.identity.peerId, { type: 'mesh:message', envelope: envelopeWith(id, a.identity.peerId, { n: 2 }, { nonce }) });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.length, 2, 'the same peer replaying its nonce is dropped');
  });

  it('closes a peer over 200 messages a second (burst 400) with 4029', async () => {
    const { b, aId } = await linked();
    const closed = within(once(b, 'peerDisconnected'), 15000, 'the rate-limit close');
    // Keep sending until the link closes (a slow receiver refills the bucket
    // while a fixed 450 are in flight), capped at 5000 frames.
    for (let i = 0; i < 5000 && b.getPeer(aId.peerId); i += 1) {
      try { b.send(aId.peerId, { i }); } catch { break; }
      if (i % 100 === 99) await new Promise((r) => setImmediate(r));
    }
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.rateLimited);
  });

  it('closes a peer that stops reading once 8 MiB is buffered', async () => {
    const { a, b, aId, bId } = await linked();
    const peer = b.peers.get(aId.peerId);
    Object.defineProperty(peer.ws, 'bufferedAmount', { get: () => 9 * 1024 * 1024 });
    const closed = within(once(a, 'peerDisconnected'), 10000, 'the link to close');
    assert.throws(() => b.send(aId.peerId, { x: 1 }), /send buffer full/);
    const [{ peerId, code }] = await closed;
    assert.equal(peerId, bId.peerId);
    assert.equal(code, CLOSE_CODES.rateLimited);
  });
});

describe('link RPC', () => {
  it('refuses a 257th pending call to one peer with peer_busy', async () => {
    const transport = Object.assign(new EventEmitter(), { send: () => {} });
    const rpc = createLinkRpc(transport, { defaultTimeoutMs: 60000 });
    const pending = [];
    for (let i = 0; i < 256; i += 1) pending.push(rpc.call('kl-aaaaaaaaaaaa', 'm').catch(() => {}));
    await assert.rejects(rpc.call('kl-aaaaaaaaaaaa', 'm'), (err) => err.code === 'peer_busy');
    const other = rpc.call('kl-bbbbbbbbbbbb', 'm').catch((err) => err.code);
    rpc.close();
    assert.equal(await other, 'closed');
    await Promise.all(pending);
  });
});

describe('LAN pairing', () => {
  function request(identityObj, secret, { good }) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const proof = good ? pairingProof(secret, nonce, identityObj) : crypto.randomBytes(32).toString('hex');
    return { type: 'pair:request', pairingId: crypto.randomBytes(8).toString('hex'), nonce, proof, identity: identityObj };
  }
  const fakeWs = () => { const sent = []; return { sent, send: (s) => sent.push(JSON.parse(s)), close: () => {} }; };

  it('locks pairing for 2 minutes after 5 failed proofs', () => {
    let now = 1_000_000;
    const me = new MeshIdentity({ displayName: 'relay' });
    const pairing = new MeshPairing(me, new MeshTransport({ identity: me, listen: false, useTls: false }), { now: () => now });
    const { code } = pairing.generateCode();
    const secret = crypto.createHash('sha256').update(code).digest();
    const other = JSON.parse(JSON.stringify(new MeshIdentity({ displayName: 'node' }).getPublicIdentity()));
    for (let i = 0; i < 5; i += 1) {
      const ws = fakeWs();
      pairing.handlePairingRequest(ws, request(other, secret, { good: false }));
      assert.equal(ws.sent[0].reason, 'no_matching_code');
    }
    const locked = fakeWs();
    pairing.handlePairingRequest(locked, request(other, secret, { good: true }));
    assert.equal(locked.sent[0].reason, 'pairing_locked');
    now += 120001;
    const later = fakeWs();
    assert.ok(pairing.handlePairingRequest(later, request(other, secret, { good: true })));
    assert.equal(later.sent[0].type, 'pair:accept');
    pairing.cleanup();
  });

  it('draws code words with randomInt over the whole word list', () => {
    const me = new MeshIdentity({ displayName: 'x' });
    const pairing = new MeshPairing(me, new MeshTransport({ identity: me, listen: false, useTls: false }));
    const seen = new Set();
    for (let i = 0; i < 3000; i += 1) for (const w of pairing.generateCode().code.split(' ')) seen.add(w);
    pairing.cleanup();
    assert.equal(seen.size, WORDLIST.length);
  });
});

// --- Beyond the brief: the same guarantees probed from the hostile side. ---

async function rawDial(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(d)));
  ws.on('error', () => {});
  return { ws, frames };
}

const hex32 = () => crypto.randomBytes(32).toString('hex');

describe('frame limits at the socket', () => {
  it('pins the ws receiver field the pre-auth limit relies on', async () => {
    const a = await listener();
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
    await once(ws, 'open');
    await waitFor(() => a.unauth.size === 1, 'the listener to see the socket');
    const [serverWs] = a.unauth.keys();
    assert.equal(serverWs._receiver._maxPayload, PRE_AUTH_MAX_BYTES);
    ws.terminate();
  });

  it('closes 1009 on a pre-auth frame header over 16 KiB before any of its payload arrives', async () => {
    const a = await listener();
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
    await once(ws, 'open');
    ws.on('error', () => {});
    // A masked text frame declaring 900 KiB, then nothing: a listener that
    // buffered first would sit waiting for the payload.
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(900 * 1024), 2);
    crypto.randomBytes(4).copy(header, 10);
    ws._socket.write(header);
    const started = Date.now();
    const [code] = await once(ws, 'close');
    assert.equal(code, CLOSE_CODES.tooBig);
    assert.ok(Date.now() - started < 2000);
  });

  it('carries a 512 KiB message once authenticated, and closes 1009 above 1 MiB', async () => {
    const { a, b, aId, bId } = await linked();
    const got = once(a, 'peerMessage');
    b.send(aId.peerId, { blob: 'x'.repeat(512 * 1024) });
    const [{ payload }] = await got;
    assert.equal(payload.blob.length, 512 * 1024);
    // send() refuses an oversize frame itself and keeps the link.
    assert.throws(() => b.send(aId.peerId, { blob: 'x'.repeat(MAX_PAYLOAD_BYTES) }), /larger than/);
    assert.ok(a.getPeer(bId.peerId));
    const closed = within(once(b, 'peerDisconnected'), 10000, 'the link to close');
    rawSend(b, aId.peerId, { type: 'mesh:heartbeat', pad: 'x'.repeat(MAX_PAYLOAD_BYTES) });
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.tooBig);
  });
});

describe('the handshake refuses hostile frames', () => {
  it('refuses a challenge that is not exactly 32 bytes, so the listener never signs chosen data', async () => {
    const { a, bId } = await linked();
    const body = JSON.stringify({ nonce: 'n', timestamp: Date.now(), to: 'kl-x', payload: { method: 'x' } });
    const { ws, frames } = await rawDial(a.port);
    ws.send(JSON.stringify({ type: 'auth:challenge', authId: 'a1', challenge: Buffer.from(body).toString('hex'), identity: bId.getPublicIdentity() }));
    const [code] = await once(ws, 'close');
    assert.equal(code, CLOSE_CODES.unauthenticated);
    assert.deepEqual(frames, []);
  });

  it('closes 4001, and keeps running, on a malformed auth:complete or a frame before it', async () => {
    const { a, bId } = await linked();
    const variants = [
      { type: 'auth:complete', signature: {} },
      { type: 'auth:complete', signature: 'ab'.repeat(64) },
      { type: 'auth:complete', signature: 'ab'.repeat(64), extra: 1 },
      { type: 'mesh:message', seq: 1, envelope: {} }
    ];
    for (const v of variants) {
      const { ws, frames } = await rawDial(a.port);
      ws.send(JSON.stringify({ type: 'auth:challenge', authId: `a-${crypto.randomBytes(4).toString('hex')}`, challenge: hex32(), identity: bId.getPublicIdentity() }));
      await waitFor(() => frames.length === 1, 'the auth:response');
      assert.equal(frames[0].type, 'auth:response');
      ws.send(JSON.stringify({ ...v, ...(v.type === 'auth:complete' ? { authId: frames[0].authId } : {}) }));
      const [code] = await once(ws, 'close');
      assert.equal(code, CLOSE_CODES.unauthenticated, JSON.stringify(v));
    }
    assert.ok(a.getPeer(bId.peerId), 'the real link is untouched');
    assert.equal(a.pendingAuth.size, 0);
  });

  it('a dialer survives a hostile listener: malformed or oversized handshake frames fail the dial', async () => {
    for (const reply of [
      (m) => JSON.stringify({ type: 'auth:response', authId: m.authId, signature: {}, challenge: 5, identity: null }),
      () => JSON.stringify({ type: 'auth:response', pad: 'x'.repeat(20 * 1024) }),
      () => JSON.stringify({ type: 'mesh:message', seq: 1, envelope: {} })
    ]) {
      const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
      await once(wss, 'listening');
      cleanups.push(() => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
      wss.on('connection', (ws) => { ws.on('error', () => {}); ws.on('message', (d) => ws.send(reply(JSON.parse(d)))); });
      const id = new MeshIdentity({ displayName: 'dialer' });
      const t = new MeshTransport({ identity: id, listen: false, useTls: false });
      await t.start();
      cleanups.push(() => t.stop());
      const started = Date.now();
      await assert.rejects(t.connectToPeer('127.0.0.1', wss.address().port));
      assert.ok(Date.now() - started < 3000, 'fails fast, not by timeout');
      assert.equal(t.pendingAuth.size, 0);
    }
  });

  it('an auth:challenge cannot take over another handshake\'s authId', async () => {
    const a = await listener();
    const bId = new MeshIdentity({ displayName: 'b' });
    a.addTrustedPeer(bId.peerId, bId.publicKey);
    const first = await rawDial(a.port);
    first.ws.send(JSON.stringify({ type: 'auth:challenge', authId: 'same', challenge: hex32(), identity: bId.getPublicIdentity() }));
    await waitFor(() => first.frames.length === 1, 'the first auth:response');
    const firstServerWs = a.pendingAuth.get('same').ws;
    const second = await rawDial(a.port);
    second.ws.send(JSON.stringify({ type: 'auth:challenge', authId: 'same', challenge: hex32(), identity: bId.getPublicIdentity() }));
    const [code] = await once(second.ws, 'close');
    assert.equal(code, CLOSE_CODES.unauthenticated);
    assert.equal(a.pendingAuth.get('same').ws, firstServerWs);
    first.ws.terminate();
  });
});

describe('sequence numbers and nonces', () => {
  it('a reordered frame closes the link with 4010', async () => {
    const { b, aId } = await linked();
    const closed = within(once(b, 'peerDisconnected'), 10000, 'the link to close');
    const peer = b.peers.get(aId.peerId);
    peer.ws.send(JSON.stringify({ type: 'mesh:heartbeat', seq: peer.sendSeq + 2 }));
    peer.ws.send(JSON.stringify({ type: 'mesh:heartbeat', seq: peer.sendSeq + 1 }));
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.replayDetected);
  });

  it('heartbeats are sequenced and keep the link', async () => {
    const { a, b, bId } = await linked();
    b._checkHeartbeats();
    b._checkHeartbeats();
    b._checkHeartbeats();
    await waitFor(() => a.getPeer(bId.peerId).recvSeq === 3, 'three sequenced heartbeats');
    assert.ok(a.getPeer(bId.peerId));
  });

  it('drops an envelope addressed to another peer', async () => {
    const { a, b, aId, bId } = await linked();
    const seen = [];
    a.on('peerMessage', (m) => seen.push(m.payload));
    rawSend(b, aId.peerId, { type: 'mesh:message', envelope: envelopeWith(bId, 'kl-someoneelse', { n: 'misrouted' }) });
    rawSend(b, aId.peerId, { type: 'mesh:message', envelope: envelopeWith(bId, aId.peerId, { n: 'ok' }) });
    await waitFor(() => seen.length === 1, 'the addressed message');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, [{ n: 'ok' }]);
  });

  // Fix round 1, item 7: nonces leave by age (once the envelope window has
  // passed, verifyEnvelope refuses the envelope anyway), with a hard cap as a
  // memory backstop that a peer within the rate limit never reaches.
  it('forgets a nonce only once its envelope is older than the envelope window', async () => {
    const { a, aId, bId } = await linked();
    const peer = a.getPeer(bId.peerId);
    peer.envelopeWindowMs = 300;
    const first = envelopeWith(bId, aId.peerId, { n: 1 });
    a._handlePeerMessage(bId.peerId, { type: 'mesh:message', seq: 1, envelope: first });
    const second = envelopeWith(bId, aId.peerId, { n: 2 });
    a._handlePeerMessage(bId.peerId, { type: 'mesh:message', seq: 2, envelope: second });
    assert.ok(peer.seenNonces.has(first.nonce) && peer.seenNonces.has(second.nonce));
    await new Promise((r) => setTimeout(r, 400));
    const third = envelopeWith(bId, aId.peerId, { n: 3 });
    a._handlePeerMessage(bId.peerId, { type: 'mesh:message', seq: 3, envelope: third });
    assert.deepEqual([...peer.seenNonces.keys()], [third.nonce]);
    // and the forgotten one cannot be replayed: it is outside the window
    const seen = [];
    a.on('peerMessage', (m) => seen.push(m.payload));
    a._handlePeerMessage(bId.peerId, { type: 'mesh:message', seq: 4, envelope: first });
    assert.deepEqual(seen, []);
  });

  it('keeps nonces within the window even past 10 000 messages', async () => {
    const { a, aId, bId } = await linked();
    const peer = a.getPeer(bId.peerId);
    let first = null;
    for (let i = 1; i <= 10001; i += 1) {
      const envelope = envelopeWith(bId, aId.peerId, { i });
      if (i === 1) first = envelope.nonce;
      a._handlePeerMessage(bId.peerId, { type: 'mesh:message', seq: i, envelope });
    }
    assert.equal(peer.seenNonces.size, 10001);
    assert.ok(peer.seenNonces.has(first), 'a nonce still inside the window is never forgotten early');
  });

  it('caps the nonce memory at rate x window + burst as a backstop', async () => {
    const { a, aId, bId } = await linked();
    const peer = a.getPeer(bId.peerId);
    peer.envelopeWindowMs = 10000; // cap = 200/s x 10 s + 400 = 2400
    let first = null;
    for (let i = 1; i <= 2401; i += 1) {
      const envelope = envelopeWith(bId, aId.peerId, { i });
      if (i === 1) first = envelope.nonce;
      a._handlePeerMessage(bId.peerId, { type: 'mesh:message', seq: i, envelope });
    }
    assert.equal(peer.seenNonces.size, 2400);
    assert.equal(peer.seenNonces.has(first), false);
  });

  it('takes a token before parsing, and closes 4010 on a frame that is not a JSON object', async () => {
    for (const garbage of ['not json', '[1,2]', '42', 'null']) {
      const { a, b, aId, bId } = await linked();
      let taken = 0;
      const realTake = a._takeToken.bind(a);
      a._takeToken = (p) => { taken += 1; return realTake(p); };
      const closed = within(once(a, 'peerDisconnected'), 5000, 'the close');
      b.peers.get(aId.peerId).ws.send(garbage);
      const [{ peerId, code }] = await closed;
      assert.equal(peerId, bId.peerId);
      assert.equal(code, CLOSE_CODES.replayDetected, garbage);
      assert.equal(taken, 1, garbage);
    }
  });

  it('a flood of garbage frames is rate-limited and closed', async () => {
    const { a, b, aId, bId } = await linked();
    const peer = a.getPeer(bId.peerId);
    peer.tokens = 0; // an empty bucket: the next frame, garbage or not, is over the rate
    peer.tokensAt = Date.now();
    const closed = within(once(a, 'peerDisconnected'), 5000, 'the close');
    const ws = b.peers.get(aId.peerId).ws;
    for (let i = 0; i < 50; i += 1) ws.send('garbage');
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.rateLimited);
  });

  it('draws envelope nonces and auth challenges from the CSPRNG', () => {
    const realRandomBytes = crypto.randomBytes;
    const calls = [];
    crypto.randomBytes = (n, ...rest) => { calls.push(n); return realRandomBytes(n, ...rest); };
    try {
      const id = new MeshIdentity({ displayName: 'x' });
      calls.length = 0;
      const env = MeshIdentity.createEnvelope(id, 'kl-y', {});
      assert.deepEqual(calls, [16]);
      assert.match(env.nonce, /^[0-9a-f]{32}$/);
      calls.length = 0;
      assert.equal(id.generateChallenge().length, 32);
      assert.deepEqual(calls, [32]);
    } finally {
      crypto.randomBytes = realRandomBytes;
    }
  });

  it('a throwing peerMessage listener neither crashes the process nor drops the link', async () => {
    const { a, b, aId, bId } = await linked();
    const seen = [];
    a.on('peerMessage', (m) => { if (m.payload.boom) throw new Error('boom'); seen.push(m.payload); });
    b.send(aId.peerId, { boom: true });
    b.send(aId.peerId, { n: 'after' });
    await waitFor(() => seen.length === 1, 'the message after the throw');
    assert.deepEqual(seen, [{ n: 'after' }]);
    assert.ok(a.getPeer(bId.peerId));
  });
});

describe('LAN lockout throttles failures, never a valid signature', () => {
  function request(identityObj, secret, { good }) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const proof = good ? pairingProof(secret, nonce, identityObj) : crypto.randomBytes(32).toString('hex');
    return { type: 'pair:request', pairingId: crypto.randomBytes(8).toString('hex'), nonce, proof, identity: identityObj };
  }
  const fakeWs = () => { const sent = []; return { sent, send: (s) => sent.push(JSON.parse(s)), close: () => {} }; };

  it('a matching proof resets the failure count', () => {
    const me = new MeshIdentity({ displayName: 'relay' });
    const pairing = new MeshPairing(me, new MeshTransport({ identity: me, listen: false, useTls: false }));
    const other = JSON.parse(JSON.stringify(new MeshIdentity({ displayName: 'node' }).getPublicIdentity()));
    const { code } = pairing.generateCode();
    const secret = crypto.createHash('sha256').update(code).digest();
    for (let i = 0; i < 4; i += 1) pairing.handlePairingRequest(fakeWs(), request(other, secret, { good: false }));
    assert.ok(pairing.handlePairingRequest(fakeWs(), request(other, secret, { good: true })));
    for (let i = 0; i < 4; i += 1) {
      const ws = fakeWs();
      pairing.handlePairingRequest(ws, request(other, secret, { good: false }));
      assert.equal(ws.sent[0].reason, 'no_matching_code');
    }
    assert.equal(pairing.lockedUntil, 0);
    pairing.cleanup();
  });

  it('a trusted peer authenticates while failures from its own address flood the listener', async () => {
    const a = await listener();
    const pairing = new MeshPairing(a.identity, a);
    cleanups.push(async () => pairing.cleanup());
    a.onPairingRequest = (ws, msg) => pairing.handlePairingRequest(ws, msg);
    const { code } = pairing.generateCode();
    const secret = crypto.createHash('sha256').update(code).digest();

    const bId = new MeshIdentity({ displayName: 'dialer' });
    a.addTrustedPeer(bId.peerId, bId.publicKey);
    const stranger = new MeshIdentity({ displayName: 'stranger' });
    const strangerPublic = JSON.parse(JSON.stringify(stranger.getPublicIdentity()));

    // Four workers (under the 8-per-IP cap), each failing in a loop: a wrong
    // pairing proof, an untrusted key, and an impersonation of b's key with a
    // signature that does not verify.
    let failures = 0;
    let stop = false;
    const attempt = async (frameFor) => {
      const { ws, frames } = await rawDial(a.port);
      const closed = once(ws, 'close');
      ws.send(JSON.stringify(frameFor()));
      if (frameFor.complete) {
        await waitFor(() => frames.length === 1 || ws.readyState !== WebSocket.OPEN, 'a response');
        if (frames[0] && frames[0].type === 'auth:response') ws.send(JSON.stringify({ type: 'auth:complete', authId: frames[0].authId, signature: 'cd'.repeat(64) }));
      }
      await closed;
      failures += 1;
    };
    const badPair = () => request(strangerPublic, secret, { good: false });
    const untrusted = () => ({ type: 'auth:challenge', authId: `x-${crypto.randomBytes(6).toString('hex')}`, challenge: hex32(), identity: strangerPublic });
    const impostor = () => ({ type: 'auth:challenge', authId: `y-${crypto.randomBytes(6).toString('hex')}`, challenge: hex32(), identity: bId.getPublicIdentity() });
    impostor.complete = true;
    const workers = [badPair, untrusted, impostor, impostor].map(async (frameFor) => {
      while (!stop) await attempt(frameFor);
    });

    await waitFor(() => failures >= 40 && pairing.lockedUntil > Date.now(), 'the flood to lock pairing');
    const b = new MeshTransport({ identity: bId, listen: false, useTls: false });
    await b.start();
    cleanups.push(() => b.stop());
    b.addTrustedPeer(a.identity.peerId, a.identity.publicKey);
    await b.connectToPeer('127.0.0.1', a.port);
    await waitFor(() => a.getPeer(bId.peerId), 'the listener to promote b mid-flood');
    const got = once(a, 'peerMessage');
    b.send(a.identity.peerId, { still: 'here' });
    assert.deepEqual((await got)[0].payload, { still: 'here' });
    const during = failures;
    stop = true;
    await Promise.all(workers);
    assert.ok(during >= 40, `failures kept coming (${during})`);
    assert.ok(pairing.lockedUntil > Date.now(), 'pairing is still locked; authentication never was');
  });
});

describe('dialer socket options (fix round 1)', () => {
  it('pins the dialer receiver field: 16 KiB during the handshake, 1 MiB once linked', async () => {
    const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    await once(wss, 'listening');
    cleanups.push(() => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
    wss.on('connection', (ws) => ws.on('error', () => {}));
    const t = new MeshTransport({ identity: new MeshIdentity({ displayName: 'd' }), listen: false, useTls: false });
    await t.start();
    cleanups.push(() => t.stop());
    const dial = t.connectToPeer('127.0.0.1', wss.address().port).catch(() => {});
    await waitFor(() => t.pendingAuth.size === 1, 'the handshake to start');
    const [pending] = t.pendingAuth.values();
    assert.equal(pending.ws._receiver._maxPayload, PRE_AUTH_MAX_BYTES);
    await t.stop();
    await dial;

    const { b, aId } = await linked();
    assert.equal(b.peers.get(aId.peerId).ws._receiver._maxPayload, MAX_PAYLOAD_BYTES);
  });

  it('fails the dial when the frame limit cannot be set', async () => {
    const a = await listener();
    const t = new MeshTransport({ identity: new MeshIdentity({ displayName: 'd' }), listen: false, useTls: false });
    await t.start();
    cleanups.push(() => t.stop());
    const real = t._initiateAuth.bind(t);
    t._initiateAuth = (ws, ...rest) => { delete ws._receiver._maxPayload; return real(ws, ...rest); };
    await assert.rejects(within(t.connectToPeer('127.0.0.1', a.port), 5000, 'the dial to fail'), /frame limit/);
    assert.equal(t.pendingAuth.size, 0);
  });

  it('never offers permessage-deflate', async () => {
    const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
    await once(wss, 'listening');
    cleanups.push(() => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
    const offered = new Promise((resolve) => wss.on('connection', (ws, req) => { ws.on('error', () => {}); resolve(req.headers['sec-websocket-extensions']); }));
    const t = new MeshTransport({ identity: new MeshIdentity({ displayName: 'd' }), listen: false, useTls: false });
    await t.start();
    cleanups.push(() => t.stop());
    t.connectToPeer('127.0.0.1', wss.address().port).catch(() => {});
    assert.equal(await within(offered, 5000, 'the upgrade'), undefined);
  });

  it('pins ws exactly, since the frame limit reaches a private receiver field', () => {
    const pkg = require('../package.json');
    const lock = require('../package-lock.json');
    assert.equal(pkg.dependencies.ws, '8.20.0');
    assert.equal(lock.packages['node_modules/ws'].version, '8.20.0');
    assert.equal(require('ws/package.json').version, '8.20.0');
  });
});
