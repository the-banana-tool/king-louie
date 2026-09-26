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
    // Refilled from a minute ahead, so the bucket stays empty however long the
    // frames take to arrive (5 ms at 200/s would refill one token under load).
    peer.tokensAt = Date.now() + 60000;
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

// ── Task 7: TLS-bound authentication and the front-door listener ─────────────
const https = require('https');
const tls = require('tls');
const { execFileSync } = require('child_process');
const path = require('path');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { channelBinding, boundChallenge } = require('../src/mesh/mesh-transport');

async function frontDoorListener({ pinned }) {
  const fd = new NodeIdentity({ nodeName: 'frontdoor' });
  const server = https.createServer({ cert: fd.tlsCert, key: fd.tlsKey, requestCert: true, rejectUnauthorized: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = new MeshTransport({ identity: fd, listen: false, useTls: true, requireClientCert: true, isPinned: (fp) => pinned.has(fp) });
  await t.start();
  t.attachServer(server);
  cleanups.push(async () => { await t.stop(); await new Promise((r) => server.close(r)); });
  return { fd, t, url: `wss://127.0.0.1:${server.address().port}/mesh/v1` };
}

async function tlsNode(fd) {
  const node = new NodeIdentity({ nodeName: 'gpu-box' });
  const t = new MeshTransport({ identity: node, listen: false, useTls: true });
  await t.start();
  cleanups.push(() => t.stop());
  t.addTrustedPeer(fd.peerId, fd.publicKey, { tlsFingerprint: fd.tlsFingerprint });
  return { node, t };
}

describe('pinned front-door link', () => {
  it('a pinned node authenticates over TLS with channel binding, both ends on the 60 s window', async () => {
    const pinned = new Set();
    const { fd, t: fdT, url } = await frontDoorListener({ pinned });
    const { node, t } = await tlsNode(fd);
    pinned.add(node.tlsFingerprint);
    fdT.addTrustedPeer(node.peerId, node.publicKey, { tlsFingerprint: node.tlsFingerprint });
    const peer = await t.connectPinned({ url, pinnedFingerprint: fd.tlsFingerprint, frontdoorId: fd.nodeId });
    assert.equal(peer.peerId, fd.peerId);
    await waitFor(() => fdT.getPeer(node.peerId), 'the front door to promote the node');
    assert.equal(t.getPeer(fd.peerId).envelopeWindowMs, 60000);
    assert.equal(fdT.getPeer(node.peerId).envelopeWindowMs, 60000);
    const got = once(fdT, 'peerMessage');
    t.send(fd.peerId, { hello: 1 });
    assert.deepEqual((await got)[0].payload, { hello: 1 });
  });

  it('an unpinned client certificate is dropped before any frame is parsed', async () => {
    const { fd, url } = await frontDoorListener({ pinned: new Set() });
    const { t } = await tlsNode(fd);
    const realParse = JSON.parse;
    let parses = 0;
    JSON.parse = function parse(...args) { parses += 1; return realParse.apply(this, args); };
    try {
      await assert.rejects(t.connectPinned({ url, pinnedFingerprint: fd.tlsFingerprint, frontdoorId: fd.nodeId }));
    } finally {
      JSON.parse = realParse;
    }
    assert.equal(parses, 0);
  });

  it('the pinned peer key must derive the front door id', async () => {
    const pinned = new Set();
    const { fd, t: fdT, url } = await frontDoorListener({ pinned });
    const { node, t } = await tlsNode(fd);
    pinned.add(node.tlsFingerprint);
    fdT.addTrustedPeer(node.peerId, node.publicKey, { tlsFingerprint: node.tlsFingerprint });
    await assert.rejects(t.connectPinned({ url, pinnedFingerprint: fd.tlsFingerprint, frontdoorId: 'kl-c2ubd6jjqumalzt5' }), /front door id/);
  });

  it('a certificate that is not the pin: frontdoor_key_mismatch, and not one application byte written', async () => {
    const other = new NodeIdentity({ nodeName: 'impostor' });
    let appBytes = 0;
    const server = tls.createServer({ cert: other.tlsCert, key: other.tlsKey }, (socket) => {
      socket.on('data', (d) => { appBytes += d.length; });
      socket.on('error', () => {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    const t = new MeshTransport({ identity: node, listen: false, useTls: true });
    await t.start();
    cleanups.push(() => t.stop());
    const pin = crypto.randomBytes(32).toString('hex');
    await assert.rejects(
      t.connectPinned({ url: `wss://127.0.0.1:${server.address().port}/mesh/v1`, pinnedFingerprint: pin, frontdoorId: 'kl-c2ubd6jjqumalzt5' }),
      (err) => err.code === 'frontdoor_key_mismatch' && err.served === other.tlsFingerprint
    );
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(appBytes, 0);
  });

  it('a signature bound to one TLS session does not verify on another', async () => {
    const pinned = new Set();
    const { fd, url } = await frontDoorListener({ pinned });
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    pinned.add(node.tlsFingerprint);
    const port = Number(new URL(url).port);
    const bindings = [];
    for (let i = 0; i < 2; i += 1) {
      const ws = new WebSocket(url, { cert: node.tlsCert, key: node.tlsKey, rejectUnauthorized: false });
      await once(ws, 'open');
      bindings.push(channelBinding(ws));
      ws.terminate();
    }
    assert.equal(bindings[0].length, 32);
    assert.notDeepEqual(bindings[0], bindings[1]);
    const challenge = crypto.randomBytes(32);
    const sig = fd.signChallenge(boundChallenge(challenge, bindings[0]));
    assert.equal(MeshIdentity.verifyChallenge(boundChallenge(challenge, bindings[0]), sig, fd.publicKey), true);
    assert.equal(MeshIdentity.verifyChallenge(boundChallenge(challenge, bindings[1]), sig, fd.publicKey), false);
    assert.ok(port > 0);
  });

  it('requireClientCert refuses plain ws:// and pair:request', async () => {
    const id = new MeshIdentity({ displayName: 'x' });
    assert.throws(() => new MeshTransport({ identity: id, listen: false, useTls: false, requireClientCert: true }), /requireClientCert needs TLS/);
  });

  it('a pinned client certificate that sends pair:request is closed 4001 pairing_off (M18)', async () => {
    const pinned = new Set();
    const { t: fdT, url } = await frontDoorListener({ pinned });
    let pairingCalls = 0;
    fdT.onPairingRequest = () => { pairingCalls += 1; };
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    pinned.add(node.tlsFingerprint);
    const ws = new WebSocket(url, { cert: node.tlsCert, key: node.tlsKey, rejectUnauthorized: false });
    ws.on('error', () => {});
    await within(once(ws, 'open'), 5000, 'the pinned socket to open');
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'pair:request', pairingId: 'p-1', nonce: hex32(), proof: hex32(), identity: node.getPublicIdentity() }));
    const [code, reason] = await within(closed, 5000, 'the front door to close the socket');
    assert.equal(code, CLOSE_CODES.unauthenticated);
    assert.equal(String(reason), 'pairing_off');
    assert.equal(pairingCalls, 0);
  });

  it('a pinned certificate presented with another node key is refused (the two pins must match)', async () => {
    const pinned = new Set();
    const { fd, t: fdT, url } = await frontDoorListener({ pinned });
    const { node, t } = await tlsNode(fd);
    const other = new NodeIdentity({ nodeName: 'web-01' });
    // The certificate is allowed at the TLS layer, but the key it authenticates
    // with is pinned to a different certificate.
    pinned.add(node.tlsFingerprint);
    fdT.addTrustedPeer(node.peerId, node.publicKey, { tlsFingerprint: other.tlsFingerprint });
    await assert.rejects(
      t.connectPinned({ url, pinnedFingerprint: fd.tlsFingerprint, frontdoorId: fd.nodeId }),
      /tls fingerprint mismatch/
    );
    assert.equal(fdT.getPeer(node.peerId), null);
  });

  it('its own listener with requireClientCert refuses a certificate no trusted peer pins', async () => {
    const fd = new NodeIdentity({ nodeName: 'frontdoor' });
    const fdT = new MeshTransport({ identity: fd, host: '127.0.0.1', port: 0, useTls: true, requireClientCert: true });
    await fdT.start();
    cleanups.push(() => fdT.stop());
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    const stranger = new NodeIdentity({ nodeName: 'web-01' });
    fdT.addTrustedPeer(node.peerId, node.publicKey, { tlsFingerprint: node.tlsFingerprint });
    const dial = (id) => new Promise((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${fdT.port}`, { cert: id.tlsCert, key: id.tlsKey, rejectUnauthorized: false });
      ws.on('open', () => { ws.terminate(); resolve('open'); });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve('error'));
    });
    assert.equal(await within(dial(stranger), 5000, 'the stranger dial'), 401);
    assert.equal(await within(dial(node), 5000, 'the pinned dial'), 'open');
  });
});

describe('service mode never loads mDNS or the remote-control mesh', () => {
  it('requiring src/mesh loads neither mesh-discovery nor mesh-swarm', () => {
    const out = execFileSync(process.execPath, ['-e', `
      require('./src/mesh');
      process.stdout.write(JSON.stringify(Object.keys(require.cache)));
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, KING_LOUIE_LOG_LEVEL: 'silent' } }).toString();
    const loaded = JSON.parse(out).map((p) => p.split(path.sep).join('/'));
    for (const m of ['mesh-discovery', 'mesh-swarm', 'mesh-remote-control', 'mesh-channel']) {
      assert.ok(!loaded.some((p) => p.endsWith(`src/mesh/${m}.js`)), `${m} was loaded`);
    }
  });

  it('initializeMesh with frontDoor set keeps discovery off', async () => {
    const { initializeMesh } = require('../src/mesh');
    const store = { data: {}, get(k) { return this.data[k]; }, set(k, v) { this.data[k] = v; } };
    const cipher = { encryptString: (s) => `enc:${s}`, decryptString: (s) => s.slice(4) };
    const mesh = await initializeMesh({ store, cipher, frontDoor: true, settings: { mesh: { port: 0, host: '127.0.0.1', useTls: false, discovery: true } } });
    cleanups.push(() => mesh.shutdown());
    assert.equal(mesh.discovery.enabled, false);
  });
});

// ── Task 7 fix round 1 ───────────────────────────────────────────────────────
const http = require('http');
const { X509Certificate } = require('crypto');

function nextMessage(ws, what) {
  return within(new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString())))), 5000, what);
}

describe('channel binding end to end', () => {
  it('the listener signs over challenge ‖ exporter and refuses an unbound auth:complete', async () => {
    const pinned = new Set();
    const { fd, t: fdT, url } = await frontDoorListener({ pinned });
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    pinned.add(node.tlsFingerprint);
    fdT.addTrustedPeer(node.peerId, node.publicKey, { tlsFingerprint: node.tlsFingerprint });
    const ws = new WebSocket(url, { cert: node.tlsCert, key: node.tlsKey, rejectUnauthorized: false });
    ws.on('error', () => {});
    await within(once(ws, 'open'), 5000, 'the pinned socket to open');
    const binding = channelBinding(ws);
    assert.equal(binding.length, 32);
    const challenge = crypto.randomBytes(32);
    const reply = nextMessage(ws, 'auth:response');
    ws.send(JSON.stringify({ type: 'auth:challenge', authId: 'auth-raw-1', challenge: challenge.toString('hex'), identity: node.getPublicIdentity() }));
    const res = await reply;
    assert.equal(res.type, 'auth:response');
    const sig = Buffer.from(res.signature, 'hex');
    assert.equal(MeshIdentity.verifyChallenge(challenge, sig, fd.publicKey), false, 'signed over the bare challenge');
    assert.equal(MeshIdentity.verifyChallenge(boundChallenge(challenge, binding), sig, fd.publicKey), true);

    const closed = within(once(ws, 'close'), 5000, 'the close');
    const unbound = node.signChallenge(Buffer.from(res.challenge, 'hex'));
    ws.send(JSON.stringify({ type: 'auth:complete', authId: 'auth-raw-1', signature: unbound.toString('hex') }));
    const [code] = await closed;
    assert.equal(code, CLOSE_CODES.unauthenticated);
    assert.equal(fdT.getPeer(node.peerId), null);
  });

  it('the dialer verifies over challenge ‖ exporter and signs its auth:complete the same way', async () => {
    const fd = new NodeIdentity({ nodeName: 'frontdoor' });
    const server = https.createServer({ cert: fd.tlsCert, key: fd.tlsKey });
    const wss = new WebSocket.Server({ server });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => server.close(() => r())); }));
    const url = `wss://127.0.0.1:${server.address().port}/mesh/v1`;
    // A scripted listener: signs its auth:response bound or bare, and reports
    // the dialer's auth:complete.
    let bindResponse = true;
    const completes = [];
    wss.on('connection', (sock) => {
      const binding = channelBinding(sock);
      const myChallenge = crypto.randomBytes(32);
      sock.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'auth:challenge') {
          const c = Buffer.from(msg.challenge, 'hex');
          sock.send(JSON.stringify({
            type: 'auth:response',
            authId: msg.authId,
            signature: fd.signChallenge(bindResponse ? boundChallenge(c, binding) : c).toString('hex'),
            challenge: myChallenge.toString('hex'),
            identity: fd.getPublicIdentity()
          }));
        } else if (msg.type === 'auth:complete') {
          completes.push({ sig: Buffer.from(msg.signature, 'hex'), myChallenge, binding });
        }
      });
    });
    const { t } = await tlsNode(fd);

    bindResponse = false;
    await assert.rejects(
      t.connectPinned({ url, pinnedFingerprint: fd.tlsFingerprint, frontdoorId: fd.nodeId }),
      /Challenge verification failed/
    );
    assert.equal(completes.length, 0);

    bindResponse = true;
    const node = t.identity;
    await t.connectPinned({ url, pinnedFingerprint: fd.tlsFingerprint, frontdoorId: fd.nodeId });
    await waitFor(() => completes.length === 1, 'the auth:complete');
    const [{ sig, myChallenge, binding }] = completes;
    assert.equal(binding.length, 32);
    assert.equal(MeshIdentity.verifyChallenge(myChallenge, sig, node.publicKey), false, 'signed over the bare challenge');
    assert.equal(MeshIdentity.verifyChallenge(boundChallenge(myChallenge, binding), sig, node.publicKey), true);
  });

  it('a TLS link with no exporter fails the handshake instead of continuing unbound', async () => {
    const pinned = new Set();
    const { t: fdT, url } = await frontDoorListener({ pinned });
    const real = tls.TLSSocket.prototype.exportKeyingMaterial;
    tls.TLSSocket.prototype.exportKeyingMaterial = function broken() { throw new Error('no exporter'); };
    const restore = () => { tls.TLSSocket.prototype.exportKeyingMaterial = real; };
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    pinned.add(node.tlsFingerprint);
    fdT.addTrustedPeer(node.peerId, node.publicKey, { tlsFingerprint: node.tlsFingerprint });
    try {
      const ws = new WebSocket(url, { cert: node.tlsCert, key: node.tlsKey, rejectUnauthorized: false });
      ws.on('error', () => {});
      await within(once(ws, 'open'), 5000, 'the pinned socket to open');
      const closed = within(once(ws, 'close'), 5000, 'the close');
      const reply = nextMessage(ws, 'the refusal');
      ws.send(JSON.stringify({ type: 'auth:challenge', authId: 'auth-raw-2', challenge: hex32(), identity: node.getPublicIdentity() }));
      assert.deepEqual(await reply, { type: 'auth:reject', reason: 'channel_binding_unavailable' });
      assert.equal((await closed)[0], CLOSE_CODES.unauthenticated);
    } finally {
      restore();
    }
  });
});

describe('pins and listener checks (fix round 1)', () => {
  it('a failed authentication leaves an unpinned peer unpinned', async () => {
    const aId = new MeshIdentity({ displayName: 'listener' });
    const a = new MeshTransport({ identity: aId, host: '127.0.0.1', port: 0, useTls: true });
    await a.start();
    cleanups.push(() => a.stop());
    const bId = new MeshIdentity({ displayName: 'dialer' });
    const b = new MeshTransport({ identity: bId, listen: false, useTls: true });
    await b.start();
    cleanups.push(() => b.stop());
    a.addTrustedPeer(bId.peerId, bId.publicKey);
    // b trusts a's peer id with the wrong key: a's signature cannot verify.
    b.addTrustedPeer(aId.peerId, new MeshIdentity().publicKey);
    await assert.rejects(b.connectToPeer('127.0.0.1', a.port), /Challenge verification failed/);
    assert.equal(b.trustedPeers.get(aId.peerId).tlsFingerprint, null);
  });

  it('attachServer with requireClientCert destroys a plain ws:// socket', async () => {
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    const t = new MeshTransport({ identity: new NodeIdentity({ nodeName: 'frontdoor' }), listen: false, useTls: true, requireClientCert: true, isPinned: () => true });
    await t.start();
    const server = http.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(async () => { await t.stop(); await new Promise((r) => server.close(r)); });
    const wss = t.attachServer(server);
    let upgrades = 0;
    const realUpgrade = wss.handleUpgrade.bind(wss);
    wss.handleUpgrade = (...args) => { upgrades += 1; return realUpgrade(...args); };

    // A real plain socket never opens.
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/mesh/v1`);
    const outcome = await within(new Promise((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('error'));
    }), 5000, 'the plain socket');
    assert.equal(outcome, 'error');

    // Nor does a plain socket that somehow carries a pinned certificate: the
    // encrypted check itself refuses it.
    let destroyed = 0;
    const fake = {
      encrypted: false,
      getPeerX509Certificate: () => new X509Certificate(node.tlsCert),
      destroy() { destroyed += 1; },
      on() {}, once() {}, write() {}, end() {}, setTimeout() {}, setNoDelay() {}
    };
    server.emit('upgrade', { url: '/mesh/v1', headers: {}, method: 'GET' }, fake, Buffer.alloc(0));
    assert.equal(destroyed, 1);
    assert.equal(upgrades, 0);
  });

  it('isPinned must return exactly true: a truthy "yes" is dropped', async () => {
    const fd = new NodeIdentity({ nodeName: 'frontdoor' });
    const server = https.createServer({ cert: fd.tlsCert, key: fd.tlsKey, requestCert: true, rejectUnauthorized: false });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const t = new MeshTransport({ identity: fd, listen: false, useTls: true, requireClientCert: true, isPinned: () => 'yes' });
    await t.start();
    t.attachServer(server);
    cleanups.push(async () => { await t.stop(); await new Promise((r) => server.close(r)); });
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    const ws = new WebSocket(`wss://127.0.0.1:${server.address().port}/mesh/v1`, { cert: node.tlsCert, key: node.tlsKey, rejectUnauthorized: false });
    const outcome = await within(new Promise((resolve) => {
      ws.on('open', () => { ws.terminate(); resolve('open'); });
      ws.on('error', () => resolve('error'));
    }), 5000, 'the dial');
    assert.equal(outcome, 'error');
  });

  it('attachServer refuses requireClientCert on a transport built without it', async () => {
    const t = new MeshTransport({ identity: new NodeIdentity({ nodeName: 'frontdoor' }), listen: false, useTls: true });
    const server = https.createServer({});
    assert.throws(() => t.attachServer(server, { requireClientCert: true }), /requireClientCert/);
    assert.doesNotThrow(() => t.attachServer(server));
  });
});
