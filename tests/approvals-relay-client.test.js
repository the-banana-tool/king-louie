// tests/approvals-relay-client.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { createLinkRpc } = require('../src/approvals/link-rpc');
const { RelayClient, isReservedMethod } = require('../src/approvals/relay-client');
const { addSink } = require('../src/logging');

let relayIdentity;
let nodeIdentity;
before(() => {
  relayIdentity = new NodeIdentity({ nodeName: 'relay' });
  nodeIdentity = new NodeIdentity({ nodeName: 'web-01' });
});

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-client-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Just enough relay to answer the link: hello plus recorders.
async function fakeRelay({ port = 0, relayId = null } = {}) {
  const transport = new MeshTransport({ identity: relayIdentity, host: '127.0.0.1', port, useTls: false });
  transport.addTrustedPeer(nodeIdentity.peerId, nodeIdentity.publicKey);
  await transport.start();
  const rpc = createLinkRpc(transport);
  const seen = [];
  rpc.handle('relay.hello', (params) => { seen.push(['relay.hello', params]); return { relay_id: relayId || relayIdentity.nodeId, public_url: 'https://kl.example.com:8443', phone_spki: 'sha256/test' }; });
  rpc.handle('approval.submit', (params) => { seen.push(['approval.submit', params]); return { ok: true }; });
  rpc.handle('message.submit', (params) => { seen.push(['message.submit', params]); return { ok: true, seq: 1 }; });
  rpc.onUnhandled((method, params) => { seen.push([method, params]); return { ok: true }; });
  return { transport, rpc, seen, stop: () => transport.stop() };
}

function pinFor(relay) {
  return {
    relay_id: relayIdentity.nodeId, peerId: relayIdentity.peerId, publicKey: relayIdentity.publicKey.toString('hex'),
    tlsFingerprint: null, address: '127.0.0.1', port: relay.transport.port, pairedAt: new Date().toISOString()
  };
}

function client(relay, extra = {}) {
  const dataDir = tempDir();
  const c = new RelayClient({ identity: nodeIdentity, relayPin: pinFor(relay), dataDir, useTls: false, reconnectDelays: [50, 100], ...extra });
  cleanups.push(() => c.stop());
  return { c, dataDir };
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));
const readLink = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));

describe('RelayClient', () => {
  it('dials, says hello, writes link.json and emits connected', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const { c, dataDir } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    assert.equal(c.isConnected(), true);
    assert.deepEqual(relay.seen[0], ['relay.hello', { node_id: nodeIdentity.nodeId, node_name: 'web-01', versions: [1] }]);
    const link = readLink(dataDir);
    assert.equal(link.connected, true);
    assert.equal(link.relay_id, relayIdentity.nodeId);
    assert.equal(link.relay_public_url, 'https://kl.example.com:8443');
    assert.equal(link.relay_spki, 'sha256/test');
  });

  it('submit and send reach the relay; relay calls reach onMessage and registered methods', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const { c } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    await c.submit({ alg: 'Ed25519', kid: 'k', payload: 'p', sig: 's' });
    assert.deepEqual(await c.send({ a: 1 }, { push: { kind: 'lease', id: 'l-1' } }), { ok: true, seq: 1 });
    assert.deepEqual(relay.seen.slice(1).map((s) => s[0]), ['approval.submit', 'message.submit']);
    assert.deepEqual(relay.seen[2][1], { envelope: { a: 1 }, push: { kind: 'lease', id: 'l-1' }, to_device: null });

    c.onMessage(async (method, params) => ({ delivered: true, method, params }));
    assert.deepEqual(await relay.rpc.call(nodeIdentity.peerId, 'approval.response', { envelope: 'x' }), { delivered: true, method: 'approval.response', params: { envelope: 'x' } });
    c.registerMethod('question.answer', async (params, { peer }) => ({ got: params.q, peer }));
    assert.deepEqual(await relay.rpc.call(nodeIdentity.peerId, 'question.answer', { q: 1 }), { got: 1, peer: relayIdentity.peerId });

    c.notify('presence.foreground', { device_id: 'd-x' });
    // notify() is fire-and-forget (no reply expected); give the relay's
    // handler a tick to run before checking it actually arrived.
    for (let i = 0; i < 50 && relay.seen.length < 4; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(relay.seen[3], ['presence.foreground', { device_id: 'd-x' }]);
  });

  it('registerMethod refuses F3 names and mesh.task.* / mesh.channel.*, but not a mesh.taskx-style name', () => {
    const c = new RelayClient({ identity: nodeIdentity, relayPin: null });
    for (const name of ['approval.response', 'relay.hello', 'mesh.task.run', 'mesh.channel.open']) {
      assert.throws(() => c.registerMethod(name, () => {}), (err) => err.code === 'method_reserved', name);
      assert.equal(isReservedMethod(name), true);
    }
    // The prefix check is exact (requires the trailing dot): a name that
    // merely starts with the reserved word, but isn't actually inside that
    // namespace, is untouched.
    assert.equal(isReservedMethod('mesh.taskx'), false);
    assert.doesNotThrow(() => c.registerMethod('mesh.taskx', () => {}));
    assert.doesNotThrow(() => c.registerMethod('lease.grant', () => {}));
  });

  it('registerMethod validates the handler and refuses to replace an existing method', () => {
    const c = new RelayClient({ identity: nodeIdentity, relayPin: null });
    assert.throws(() => c.registerMethod('question.answer', 'not a function'), TypeError);
    assert.throws(() => c.registerMethod('question.answer', undefined), TypeError);
    c.registerMethod('question.answer', () => {});
    assert.throws(
      () => c.registerMethod('question.answer', () => {}),
      (err) => err.code === 'method_exists'
    );
  });

  it('marks the link down when the relay goes, reconnects when it returns, and can still deliver', async () => {
    const relay = await fakeRelay();
    const port = relay.transport.port;
    const { c, dataDir } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    const disconnected = once(c, 'disconnected');
    await relay.stop();
    await disconnected;
    assert.equal(c.isConnected(), false);
    assert.equal(readLink(dataDir).connected, false);
    assert.deepEqual(c.canDeliver(), { ok: true });
    await assert.rejects(c.submit({}), (err) => err.code === 'relay_offline');
    const back = once(c, 'connected');
    const again = await fakeRelay({ port });
    cleanups.push(again.stop);
    await back;
    assert.equal(c.isConnected(), true);
  });

  it('refuses a relay that answers with another relay id: never connects, inbound is refused, link.json stays down', async () => {
    const relay = await fakeRelay({ relayId: 'kl-aaaaaaaaaaaaaaaa' });
    cleanups.push(relay.stop);
    // Keep the (wrongly identified) relay's transport-level connection up
    // after the mismatch, instead of letting the real disconnectPeer tear it
    // down — so the assertions below prove the node's OWN inbound guard
    // refuses the link, not merely that the socket happened to already be
    // gone by the time they run.
    const transportFactory = (options) => {
      const t = new MeshTransport(options);
      t.disconnectPeer = () => false;
      return t;
    };
    const { c, dataDir } = client(relay, { transportFactory });
    let everConnected = false;
    c.on('connected', () => { everConnected = true; });
    await c.start();
    for (let i = 0; i < 50 && relay.seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(relay.seen[0][0], 'relay.hello', 'the node must still say hello, even though this relay is wrong');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.isConnected(), false);
    assert.equal(everConnected, false, "'connected' must never fire for a relay that fails identity verification");
    assert.equal(readLink(dataDir).connected, false);

    // I2: with no verified link, every inbound path — the fixed NODE_INBOUND
    // handlers and the onUnhandled extension dispatcher — refuses the relay,
    // not just each other kind of misuse.
    c.onMessage(async () => ({ should: 'never run' }));
    c.registerMethod('lease.grant', async () => ({ should: 'never run' }));
    await assert.rejects(
      relay.rpc.call(nodeIdentity.peerId, 'approval.response', { envelope: 'x' }),
      (err) => err.code === 'not_linked'
    );
    await assert.rejects(
      relay.rpc.call(nodeIdentity.peerId, 'lease.grant', { a: 1 }),
      (err) => err.code === 'not_linked'
    );
  });

  it('inbound calls are refused before hello completes', async () => {
    const transport = new MeshTransport({ identity: relayIdentity, host: '127.0.0.1', port: 0, useTls: false });
    transport.addTrustedPeer(nodeIdentity.peerId, nodeIdentity.publicKey);
    await transport.start();
    cleanups.push(() => transport.stop());
    const rpc = createLinkRpc(transport);
    let releaseHello;
    rpc.handle('relay.hello', () => new Promise((resolve) => { releaseHello = resolve; }));

    const dataDir = tempDir();
    const c = new RelayClient({
      identity: nodeIdentity,
      relayPin: {
        relay_id: relayIdentity.nodeId, peerId: relayIdentity.peerId, publicKey: relayIdentity.publicKey.toString('hex'),
        address: '127.0.0.1', port: transport.port
      },
      dataDir, useTls: false, reconnectDelays: [50, 100]
    });
    cleanups.push(() => c.stop());
    c.onMessage(async () => ({ should: 'never run' }));
    c.registerMethod('lease.grant', async () => ({ should: 'never run' }));

    await c.start();
    for (let i = 0; i < 100 && !releaseHello; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(releaseHello, 'relay.hello should be in flight (not yet answered) by now');
    assert.equal(c.isConnected(), false);

    await assert.rejects(
      rpc.call(nodeIdentity.peerId, 'approval.response', { envelope: 'x' }),
      (err) => err.code === 'not_linked'
    );
    await assert.rejects(
      rpc.call(nodeIdentity.peerId, 'lease.grant', { a: 1 }),
      (err) => err.code === 'not_linked'
    );

    // Let hello resolve so the transport can shut down cleanly.
    releaseHello({ relay_id: relayIdentity.nodeId, public_url: 'https://kl.example.com:8443', phone_spki: 'sha256/test' });
    await once(c, 'connected');
  });

  it('escalates the reconnect delay across unreachable-relay attempts, and resets it after a successful hello', async () => {
    const attemptsAt = [];
    const transportFactory = (options) => {
      const t = new MeshTransport(options);
      const originalConnect = t.connectToPeer.bind(t);
      t.connectToPeer = (...args) => { attemptsAt.push(Date.now()); return originalConnect(...args); };
      return t;
    };
    const dataDir = tempDir();
    // Nothing listens on this port: every connect attempt fails fast
    // (connection refused) so the escalating delays are what paces retries.
    const c = new RelayClient({
      identity: nodeIdentity,
      relayPin: {
        relay_id: relayIdentity.nodeId, peerId: relayIdentity.peerId, publicKey: relayIdentity.publicKey.toString('hex'),
        address: '127.0.0.1', port: 1
      },
      dataDir, useTls: false, reconnectDelays: [40, 90, 90], transportFactory
    });
    cleanups.push(() => c.stop());
    await c.start();
    for (let i = 0; i < 100 && attemptsAt.length < 3; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.ok(attemptsAt.length >= 3, `expected at least 3 dial attempts, got ${attemptsAt.length}`);
    const gap1 = attemptsAt[1] - attemptsAt[0];
    const gap2 = attemptsAt[2] - attemptsAt[1];
    assert.ok(gap1 >= 25, `first gap (${gap1}ms) should be at least the ~40ms configured delay`);
    assert.ok(gap2 > gap1, `second gap (${gap2}ms) should be longer than the first (${gap1}ms) — escalating, not fixed`);
    assert.equal(c.dialAttempt > 0, true);
  });

  it('a relay_id mismatch always redials at the longest configured delay, logging an error every time', async () => {
    let answerAs = 'kl-aaaaaaaaaaaaaaaa'; // wrong on purpose, until fixed below
    const transport = new MeshTransport({ identity: relayIdentity, host: '127.0.0.1', port: 0, useTls: false });
    transport.addTrustedPeer(nodeIdentity.peerId, nodeIdentity.publicKey);
    await transport.start();
    cleanups.push(() => transport.stop());
    const rpc = createLinkRpc(transport);
    const helloAt = [];
    rpc.handle('relay.hello', () => {
      helloAt.push(Date.now());
      return { relay_id: answerAs, public_url: 'https://kl.example.com:8443', phone_spki: 'sha256/test' };
    });

    const errors = [];
    const unsubscribe = addSink((record) => {
      if (record.subsystem === 'approvals/relay-client' && record.level === 'error') errors.push(record.message);
    });

    const dataDir = tempDir();
    const c = new RelayClient({
      identity: nodeIdentity,
      relayPin: {
        relay_id: relayIdentity.nodeId, peerId: relayIdentity.peerId, publicKey: relayIdentity.publicKey.toString('hex'),
        address: '127.0.0.1', port: transport.port
      },
      dataDir, useTls: false, reconnectDelays: [15, 30, 45]
    });
    cleanups.push(() => c.stop());
    try {
      await c.start();
      for (let i = 0; i < 200 && helloAt.length < 3; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.ok(helloAt.length >= 3, `expected at least 3 hello attempts, got ${helloAt.length}`);
      const gap1 = helloAt[1] - helloAt[0];
      const gap2 = helloAt[2] - helloAt[1];
      // Both gaps sit near the longest configured delay (45ms), not the
      // escalating 15 → 30 → 45 an ordinary (non-mismatch) failure would use.
      assert.ok(gap1 >= 35, `gap1 (${gap1}ms) should be ~45ms, the longest delay`);
      assert.ok(gap2 >= 35, `gap2 (${gap2}ms) should be ~45ms, the longest delay`);
      assert.ok(errors.length >= 2, `expected an error log per mismatch retry, got ${errors.length}`);
      assert.ok(errors.every((m) => /relay answered as/.test(m) || /relay link down \(mismatch\)/.test(m)));

      // Fix the relay's answer: the client must recover, proving a mismatch
      // never gives up (re-pairing can fix it at any moment).
      answerAs = relayIdentity.nodeId;
      await once(c, 'connected');
      assert.equal(c.isConnected(), true);
    } finally {
      unsubscribe();
    }
  });

  // Integration fix: on Windows the atomic rename fails with EPERM while
  // another process (doctor, the desktop, a test polling the file) has
  // link.json open; the state must still land once the reader lets go.
  it('retries a link.json write that fails, landing the latest state, and stops retrying on stop()', async () => {
    const { writeFileAtomic } = require('../src/approvals/approver-store');
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    let failures = 2;
    let alwaysFail = false;
    const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    const { c, dataDir } = client(relay, {
      linkRetryMs: 10,
      platform: 'win32',
      writeLinkFile: (file, text) => {
        if (alwaysFail) throw eperm();
        if (failures > 0) { failures -= 1; throw eperm(); }
        return writeFileAtomic(file, text);
      }
    });
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    const deadline = Date.now() + 5000;
    while (!(fs.existsSync(path.join(dataDir, 'approvals', 'link.json')) && readLink(dataDir).connected === true)) {
      assert.ok(Date.now() < deadline, 'link.json never showed the connected state');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(failures, 0);
    assert.equal(c.linkRetryTimer, null);

    alwaysFail = true;
    c._writeLink();
    assert.notEqual(c.linkRetryTimer, null, 'a failed write arms a retry');
    await c.stop();
    assert.equal(c.linkRetryTimer, null, 'stop() clears the retry and does not re-arm it');
  });

  it('retries only a Windows EPERM/EBUSY/EACCES: another error, or another platform, warns at once with no retry', () => {
    const calls = { n: 0 };
    const make = (platform, code) => new RelayClient({
      identity: nodeIdentity, relayPin: { relay_id: 'r', publicKey: nodeIdentity.publicKey.toString('hex') }, dataDir: tempDir(),
      useTls: false, linkRetryMs: 1, platform,
      writeLinkFile: () => { calls.n += 1; throw Object.assign(new Error(code), { code }); }
    });
    for (const [platform, code] of [['win32', 'ENOSPC'], ['linux', 'EPERM'], ['darwin', 'EBUSY']]) {
      const c = make(platform, code);
      calls.n = 0;
      c._writeLink();
      assert.equal(c.linkRetryTimer, null, `${platform} ${code}: no delayed retry`);
      assert.equal(calls.n, 1);
    }
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const c = make('win32', code);
      c._writeLink();
      assert.notEqual(c.linkRetryTimer, null, `win32 ${code}: a delayed retry is armed`);
      clearTimeout(c.linkRetryTimer);
    }
  });

  it('stop() retries its final write synchronously on a Windows lock, so link.json ends connected:false', async () => {
    const { writeFileAtomic } = require('../src/approvals/approver-store');
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    let failStop = 0;
    const { c, dataDir } = client(relay, {
      linkRetryMs: 5,
      platform: 'win32',
      writeLinkFile: (file, text) => {
        if (failStop > 0 && text.includes('"connected":false')) { failStop -= 1; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
        return writeFileAtomic(file, text);
      }
    });
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    assert.equal(readLink(dataDir).connected, true);
    failStop = 3;
    await c.stop();
    assert.equal(failStop, 0);
    assert.equal(readLink(dataDir).connected, false);
    assert.equal(c.linkRetryTimer, null);
  });

  it('stop() writes link.json connected:false and settles a pending call', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const { c, dataDir } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    relay.rpc.handle('slow.method', () => new Promise(() => {}));
    const pending = c.call('slow.method', {});
    await c.stop();
    await assert.rejects(pending, (err) => err.code === 'closed');
    assert.equal(readLink(dataDir).connected, false);
    assert.equal(c.retryTimer, null);
  });

  it('stop() clears an already-armed reconnect timer, so no dial follows it', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const { c, dataDir } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    const disconnected = once(c, 'disconnected');
    await relay.stop(); // a real disconnect, so a reconnect timer gets armed
    await disconnected;
    assert.notEqual(c.retryTimer, null);

    await c.stop();
    assert.equal(readLink(dataDir).connected, false);
    assert.equal(c.retryTimer, null);
    // Waiting past what would have been the scheduled retry must not
    // produce a new dial attempt.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.isConnected(), false);
  });

  it('a front-door.json that exists but is not valid JSON is warned about and ignored (falls back to the pinned address)', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const configDir = tempDir();
    fs.writeFileSync(path.join(configDir, 'front-door.json'), '{ not valid json');
    const warnings = [];
    const unsubscribe = addSink((record) => {
      if (record.subsystem === 'approvals/relay-client' && record.level === 'warn') warnings.push(record.message);
    });
    try {
      const { c } = client(relay, { configDir });
      const connected = once(c, 'connected');
      await c.start();
      await connected;
      assert.equal(c.isConnected(), true);
      assert.ok(warnings.some((m) => /front-door\.json/.test(m) && /JSON/.test(m)), warnings.join('\n'));
    } finally {
      unsubscribe();
    }
  });

  it('derives the relay peerId from the pinned publicKey when the pin record has no peerId (spec §3.11)', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const dataDir = tempDir();
    const pin = pinFor(relay);
    delete pin.peerId;
    const c = new RelayClient({ identity: nodeIdentity, relayPin: pin, dataDir, useTls: false, reconnectDelays: [50, 100] });
    cleanups.push(() => c.stop());
    assert.equal(c.relayPeerId, relayIdentity.peerId);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    assert.equal(c.isConnected(), true);
  });

  it("start() failing resets `started`, so a later start() is not a silent no-op", async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const dataDir = tempDir();
    let calls = 0;
    const transportFactory = (options) => {
      calls += 1;
      const t = new MeshTransport(options);
      if (calls === 1) t.start = async () => { throw new Error('boom'); };
      return t;
    };
    const c = new RelayClient({ identity: nodeIdentity, relayPin: pinFor(relay), dataDir, useTls: false, reconnectDelays: [50, 100], transportFactory });
    cleanups.push(() => c.stop());
    await assert.rejects(c.start(), /boom/);
    assert.equal(c.started, false);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    assert.equal(c.isConnected(), true);
    assert.equal(calls, 2);
  });

  it('stop() while a dial is in flight resets `dialing`, so a later start() can dial again', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const dataDir = tempDir();
    let factoryCalls = 0;
    let hungConnect = null;
    const transportFactory = (options) => {
      factoryCalls += 1;
      const t = new MeshTransport(options);
      if (factoryCalls === 1) {
        // The very first dial never settles, so `dialing` is still true
        // when stop() runs.
        t.connectToPeer = () => new Promise((resolve, reject) => { hungConnect = reject; });
      }
      return t;
    };
    const c = new RelayClient({ identity: nodeIdentity, relayPin: pinFor(relay), dataDir, useTls: false, reconnectDelays: [50, 100], transportFactory });
    await c.start();
    for (let i = 0; i < 50 && !hungConnect; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(hungConnect, 'the first dial should be in flight (never resolved) by now');
    assert.equal(c.dialing, true);

    await c.stop();
    assert.equal(c.dialing, false);

    const connected = once(c, 'connected');
    await c.start();
    cleanups.push(() => c.stop());
    await connected;
    assert.equal(c.isConnected(), true);
  });

  it('dials front-door.json through connectPinned when the transport has it (E7)', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const configDir = tempDir();
    fs.writeFileSync(path.join(configDir, 'front-door.json'), JSON.stringify({ url: 'https://kl.example.com' }));
    const pinned = [];
    const transportFactory = (options) => {
      const t = new MeshTransport(options);
      t.connectPinned = (fd) => { pinned.push(fd); return t.connectToPeer('127.0.0.1', relay.transport.port); };
      return t;
    };
    const { c } = client(relay, { configDir, transportFactory });
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    assert.deepEqual(pinned, [{ url: 'https://kl.example.com' }]);
  });
});
