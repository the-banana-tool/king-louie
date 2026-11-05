// tests/frontdoor-window.test.js
// Remote window plan, task 7 (R-RW-3 to R-RW-5): the front door joins a window's
// socket to its node's dial-back and reads nothing of what passes.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const { createBridgeDispatcher } = require('../src/desktop-bridge/bridge-dispatcher');
const { WindowSeal, RECORD_WIRE_MAX, PRE_READY_BYTES, SOCKET_OPTIONS } = require('../src/desktop-bridge/window-seal');
const { wsTransport } = require('../src/desktop-bridge/sealed-socket');
const { currentConnection } = require('../src/desktop-bridge/run-context');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');
const splice = require('../src/frontdoor/window/splice');
const { WindowSessions } = require('../src/frontdoor/window/sessions');
const { createMcpHttpServer } = require('../src/frontdoor/http');
const { parseFrontDoorConfig, WINDOW_DEFAULTS, FRONTDOOR_KEYS } = require('../src/frontdoor/config');
const { FRONT_DOOR_AUDIT_KINDS } = require('../src/frontdoor/audit/own-ledger');
const { startFakeWindowFrontDoor } = require('./helpers/fake-window-frontdoor');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const nodeA = new NodeIdentity({ nodeName: 'web-01' });
const nodeB = new NodeIdentity({ nodeName: 'web-02' });
const stranger = new NodeIdentity({ nodeName: 'not-registered' });
const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;

const TOKENS = {
  kla_all: { grant_id: 'g-all', client_id: 'c-window', scopes: ['window:attach'] },
  kla_web02: { grant_id: 'g-web02', client_id: 'c-window', scopes: ['window:attach;machines=web-02'] },
  kla_fleet: { grant_id: 'g-fleet', client_id: 'c-other', scopes: ['fleet:read'] },
  kla_mcp: { grant_id: 'g-mcp', client_id: 'c-mcp', scopes: ['window:attach'], aud: 'https://elsewhere.example.com/mcp' }
};

const cleanups = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function waitFor(fn, what = 'a condition', ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await delay(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function clock() {
  const time = { t: 1800000000000 };
  time.now = () => time.t;
  time.advance = (ms) => { time.t += ms; };
  return time;
}

async function frontDoor(options = {}) {
  const fake = await startFakeWindowFrontDoor({ tokens: TOKENS, nodes: [{ identity: nodeA }, { identity: nodeB }], ...options });
  cleanups.push(() => fake.stop());
  return fake;
}

// What a socket says: messages in order, how it closed, and any failure to open.
function watch(ws) {
  const seen = { ws, messages: [], close: null, error: null, session: null };
  ws.on('message', (data, isBinary) => seen.messages.push({ data: Buffer.from(data), isBinary }));
  ws.on('upgrade', (res) => { seen.session = res.headers['x-kl-window-session'] || null; });
  ws.on('error', (err) => { seen.error = err; });
  ws.on('close', (code, reason) => { seen.close = { code, reason: reason.toString('utf8') }; });
  cleanups.push(() => ws.terminate());
  return seen;
}

function windowSocket(fake, token = 'kla_all', nodeId = nodeA.nodeId, { path: target = null, headers = {}, protocol = 'kl-window-v1' } = {}) {
  const url = `${fake.origin}${target || `/window/v1?node=${nodeId}`}`;
  return new WebSocket(url, protocol || undefined, {
    ...SOCKET_OPTIONS, rejectUnauthorized: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }
  });
}

const opened = (ws) => new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
const closed = (seen, what = 'the close') => waitFor(() => seen.close, what);

// A window and a node end joined through the splice, neither of them sealing.
async function joined(fake, token = 'kla_all', { nodeId = nodeA.nodeId } = {}) {
  const win = watch(windowSocket(fake, token, nodeId));
  await opened(win.ws);
  const session = win.session;
  const identity = nodeId === nodeA.nodeId ? nodeA : nodeB;
  const peer = watch(fake.dial(identity, session));
  await opened(peer.ws);
  return { win, node: peer, session };
}

// A front door whose nodes answer window.open and dial only when a test says.
const hands = () => [{ identity: nodeA, open: async () => ({ ok: true }) }, { identity: nodeB, open: async () => ({ ok: true }) }];

const reasons = (fake, kind) => fake.audit.filter((line) => line.kind === kind).map((line) => line.data);

describe('what the splice carries', () => {
  it('its limits are window-v1\'s', () => {
    assert.equal(splice.RECORD_WIRE_MAX, RECORD_WIRE_MAX);
    assert.equal(splice.PRE_READY_BYTES, PRE_READY_BYTES);
  });

  it('a window reaches its node, and its first invoke is answered, through the real seal and bridge', async () => {
    const { window: win, server, device } = await sealedPair();
    await waitFor(() => win.received.some((f) => f.t === 'ready'), 'the ready frame');
    win.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
    const answer = await waitFor(() => win.received.find((f) => f.id === 1), 'the answer');
    assert.equal(answer.t, 'result');
    assert.deepEqual(answer.value, { chats: ['stub'] });
    assert.deepEqual(server.connected.map((c) => [c.deviceId, c.remote]), [[device.deviceId, true]]);
  });

  it('what leaves one leg arrives on the other byte for byte, and holds no planted text', async () => {
    const planted = 'PLANTED-PLAINTEXT-7f3a';
    const { window: win, fake, tapped } = await sealedPair();
    await waitFor(() => win.received.some((f) => f.t === 'ready'), 'the ready frame');
    win.send({ t: 'invoke', id: 2, channel: 'chat:load', args: [planted] });
    await waitFor(() => win.received.find((f) => f.id === 2), 'the answer');
    await waitFor(() => Buffer.concat(tapped.nodeSent).equals(Buffer.concat(win.wireIn))
      && Buffer.concat(win.wireOut).equals(Buffer.concat(tapped.nodeReceived)), 'both legs to agree');
    const carried = Buffer.concat([...win.wireOut, ...win.wireIn]);
    assert.ok(carried.length > 0);
    assert.ok(!carried.includes(planted));
    const [record] = fake.splice.sessions.list();
    // Each client frame is its payload plus a header and a 4-byte mask.
    const onWire = (messages) => messages.reduce((n, m) => n + m.length + 6 + (m.length > 125 ? 2 : 0) + (m.length > 65535 ? 6 : 0), 0);
    assert.equal(record.bytes_in, onWire(win.wireOut));
    assert.equal(record.bytes_out, onWire(tapped.nodeSent));
    assert.ok(!JSON.stringify(fake.audit).includes(planted));
  });

  it('frames of each header size pass unchanged, a full record included, both ways', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win, node } = await joined(fake);
    const sizes = [0, 1, 125, 126, 65535, 65536, RECORD_WIRE_MAX];
    const blocks = sizes.map((size) => crypto.randomBytes(size));
    for (const block of blocks) win.ws.send(block);
    for (const block of blocks) node.ws.send(block);
    await waitFor(() => node.messages.length === sizes.length && win.messages.length === sizes.length, 'every frame', 20000);
    for (const [i, block] of blocks.entries()) {
      assert.ok(node.messages[i].data.equals(block), `window to node ${sizes[i]}`);
      assert.ok(win.messages[i].data.equals(block), `node to window ${sizes[i]}`);
      assert.equal(node.messages[i].isBinary, true);
    }
  });

  it('a frame split across chunks, a byte at a time, still arrives whole', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win, node } = await joined(fake);
    const payload = Buffer.from('split across chunks');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    const frame = Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, masked]);
    for (const byte of frame) {
      win.ws._socket.write(Buffer.from([byte]));
      await delay(1);
    }
    await waitFor(() => node.messages.length === 1, 'the frame');
    assert.ok(node.messages[0].data.equals(payload));
  });

  it('bytes the window sent before the node dialled reach the node once it does', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const win = watch(windowSocket(fake));
    await opened(win.ws);
    const early = crypto.randomBytes(86);
    win.ws.send(early);
    await waitFor(() => fake.splice.sessions.list()[0]?.bytes_in > 0, 'the bytes to arrive');
    const node = watch(fake.dial(nodeA, win.session));
    await opened(node.ws);
    await waitFor(() => node.messages.length === 1, 'the early frame');
    assert.ok(node.messages[0].data.equals(early));
  });

  it('a ping passes and its pong comes back', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win } = await joined(fake);
    const pong = new Promise((resolve) => { win.ws.once('pong', resolve); });
    win.ws.ping(Buffer.from('hi'));
    assert.equal((await pong).toString(), 'hi');
  });

  it('a close from either end reaches the other with its code, and the session ends', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const first = await joined(fake);
    first.win.ws.close(1000, 'done');
    assert.equal((await closed(first.node)).code, 1000);
    assert.equal((await closed(first.win)).code, 1000);
    await waitFor(() => fake.splice.sessions.size === 0, 'the session to end');
    assert.equal(reasons(fake, 'window.session.closed')[0].reason, 'window_closed');

    const second = await joined(fake);
    second.node.ws.close(4403, 'node says');
    const atWindow = await closed(second.win);
    assert.deepEqual(atWindow, { code: 4403, reason: 'node says' });
    await waitFor(() => reasons(fake, 'window.session.closed').length === 2, 'the audit line');
    assert.equal(reasons(fake, 'window.session.closed')[1].reason, 'node_closed');
  });

  it('a socket that drops takes the other leg with it', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win, node } = await joined(fake);
    win.ws.terminate();
    assert.equal((await closed(node)).code, 1001);
    assert.equal(fake.splice.sessions.size, 0);
    assert.equal(reasons(fake, 'window.session.closed')[0].reason, 'window_gone');
  });
});

describe('what the splice refuses to carry (window-v1 §5)', () => {
  const refused = async (act, reason) => {
    const fake = await frontDoor({ nodes: hands() });
    const { win, node } = await joined(fake);
    act(win.ws);
    assert.equal((await closed(win)).code, 1008);
    assert.equal((await closed(node)).code, 1008);
    assert.equal(reasons(fake, 'window.session.closed')[0].reason, reason);
    assert.equal(node.messages.length, 0);
  };
  const header = (first, second, ...rest) => Buffer.from([first, second, ...rest]);
  const MASK = [1, 2, 3, 4];

  it('a text frame', () => refused((ws) => ws.send('words'), 'window_frame_opcode'));

  it('a frame declared over the longest record, before its payload is sent', () => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(RECORD_WIRE_MAX + 1));
    return refused((ws) => ws._socket.write(Buffer.concat([header(0x82, 0xff), length, Buffer.from(MASK)])), 'window_frame_too_long');
  });

  it('a compressed frame', () => refused((ws) => ws._socket.write(header(0xc2, 0x80, ...MASK)), 'window_frame_reserved_bits'));

  it('a fragment', () => refused((ws) => ws._socket.write(header(0x02, 0x80, ...MASK)), 'window_frame_fragment'));

  it('a frame with no mask', () => refused((ws) => ws._socket.write(header(0x82, 0x00)), 'window_frame_unmasked'));

  it('more than a seal may send before the node has dialled', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const win = watch(windowSocket(fake));
    await opened(win.ws);
    win.ws.send(crypto.randomBytes(PRE_READY_BYTES + 1));
    assert.equal((await closed(win)).code, 1008);
    assert.equal(reasons(fake, 'window.session.closed')[0].reason, 'too_early');
    assert.equal(fake.splice.sessions.size, 0);
  });
});

describe('who gets a socket (R-RW-3)', () => {
  it('a token for another audience, or none, is 4401 and nothing is asked', async () => {
    const fake = await frontDoor();
    for (const token of ['kla_mcp', 'kla_unknown', null]) {
      const win = watch(windowSocket(fake, token));
      assert.deepEqual(await closed(win), { code: 4401, reason: 'invalid_token' });
      assert.equal(win.session, null);
    }
    assert.equal(fake.rpcCalls.length, 0);
    assert.equal(fake.audit.length, 0, 'anyone can ask, so a refused stranger writes no line');
  });

  it('a token with no window:attach is 4403 insufficient_scope', async () => {
    const fake = await frontDoor();
    const win = watch(windowSocket(fake, 'kla_fleet'));
    assert.deepEqual(await closed(win), { code: 4403, reason: 'insufficient_scope' });
  });

  it('a token without the machine, or naming no such node, is 4403 unknown_machine', async () => {
    const fake = await frontDoor();
    for (const [token, nodeId] of [['kla_web02', nodeA.nodeId], ['kla_all', stranger.nodeId], ['kla_all', 'not-a-node-id']]) {
      const win = watch(windowSocket(fake, token, nodeId));
      assert.deepEqual(await closed(win), { code: 4403, reason: 'unknown_machine' });
    }
    assert.equal(fake.rpcCalls.length, 0);
  });

  it('a grant that pinned the name to another key is 4403 unknown_machine', async () => {
    const fake = await frontDoor({
      tokens: { kla_pinned: { grant_id: 'g-pinned', client_id: 'c', scopes: ['window:attach;machines=web-02'], machine_ids: { 'web-02': stranger.nodeId } } }
    });
    const win = watch(windowSocket(fake, 'kla_pinned', nodeB.nodeId));
    assert.deepEqual(await closed(win), { code: 4403, reason: 'unknown_machine' });
    assert.equal(fake.rpcCalls.length, 0);
  });

  it('an offline node is 4404 and window.open is never sent', async () => {
    const fake = await frontDoor();
    fake.setOnline(nodeA.nodeId, false);
    const win = watch(windowSocket(fake));
    assert.deepEqual(await closed(win), { code: 4404, reason: 'node_offline' });
    assert.equal(fake.rpcCalls.length, 0);
  });

  it('a runbook node has no window to open, and is not asked', async () => {
    const fake = await frontDoor({ nodes: [{ identity: nodeA, profile: 'runbook' }] });
    const win = watch(windowSocket(fake));
    assert.deepEqual(await closed(win), { code: 4403, reason: 'remote_window_off' });
    assert.equal(fake.rpcCalls.length, 0);
  });

  it('the fifth session on one grant is 4429 session_limit', async () => {
    const fake = await frontDoor({ nodes: hands() });
    for (let i = 0; i < 4; i += 1) await opened(watch(windowSocket(fake)).ws);
    const fifth = watch(windowSocket(fake));
    assert.deepEqual(await closed(fifth), { code: 4429, reason: 'session_limit' });
    assert.equal(fifth.session, null);
    assert.equal(fake.splice.sessions.size, 4);
  });

  it('a third session of one device on one node is 4429 session_limit, once the device is known', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const hello = Buffer.concat([Buffer.from([1, 1]), Buffer.alloc(32), Buffer.from('kld-abcdefghijklmnop'), Buffer.alloc(32)]);
    assert.equal(hello.length, 86);
    const wins = [];
    for (let i = 0; i < 3; i += 1) {
      const { win } = await joined(fake);
      win.ws.send(hello);
      wins.push(win);
    }
    assert.deepEqual(await closed(wins[2]), { code: 4429, reason: 'session_limit' });
    assert.equal(wins[0].close, null);
    assert.deepEqual(fake.splice.sessions.list().map((r) => r.device_id), ['kld-abcdefghijklmnop', 'kld-abcdefghijklmnop']);
  });

  it('a first frame that is not a hello_w is passed through unread and names no device', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win, node } = await joined(fake);
    const notHello = crypto.randomBytes(85);
    win.ws.send(notHello);
    win.ws.send(Buffer.concat([Buffer.from([1, 1]), Buffer.alloc(32), Buffer.from('kld-abcdefghijklmnop'), Buffer.alloc(32)]));
    await waitFor(() => node.messages.length === 2, 'both frames');
    assert.ok(node.messages[0].data.equals(notHello));
    assert.equal(fake.splice.sessions.list()[0].device_id, null);
  });

  it('a request that is no window\'s upgrade is destroyed', async () => {
    const fake = await frontDoor();
    const noProtocol = watch(windowSocket(fake, 'kla_all', nodeA.nodeId, { protocol: null }));
    const otherHost = watch(windowSocket(fake, 'kla_all', nodeA.nodeId, { headers: { host: 'other.example.com' } }));
    for (const seen of [noProtocol, otherHost]) await waitFor(() => seen.error, 'the refusal');
    assert.equal(fake.rpcCalls.length, 0);
  });
});

describe('the session and the node (R-RW-3)', () => {
  it('window.open carries the session id the 101 gave, and no more', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const win = watch(windowSocket(fake));
    await opened(win.ws);
    await waitFor(() => fake.rpcCalls.length === 1, 'the call');
    const [call] = fake.rpcCalls;
    assert.equal(call.method, 'window.open');
    assert.equal(call.nodeId, nodeA.nodeId);
    assert.equal(call.options.timeoutMs, 10000);
    assert.deepEqual(Object.keys(call.params).sort(), ['expires_at', 'session_id']);
    assert.equal(call.params.session_id, win.session);
    assert.equal(Buffer.from(win.session, 'base64url').length, 32);
    assert.ok(Date.parse(call.params.expires_at) > Date.now());
    assert.equal(win.ws.protocol, 'kl-window-v1');
  });

  it('a node that does not dial closes the window 4408 after 30 s', async () => {
    const time = clock();
    const fake = await frontDoor({ nodes: hands(), now: time.now });
    const win = watch(windowSocket(fake));
    await opened(win.ws);
    time.advance(29999);
    fake.splice.sweep();
    await delay(20);
    assert.equal(win.close, null);
    time.advance(1);
    fake.splice.sweep();
    assert.deepEqual(await closed(win), { code: 4408, reason: 'node_did_not_dial' });
    assert.equal(fake.splice.sessions.size, 0);
  });

  it('a node that refuses closes the window 4403 with its code', async () => {
    for (const code of ['remote_window_off', 'too_many_windows', 'node_not_sealing']) {
      const fake = await frontDoor({ nodes: [{ identity: nodeA, open: async () => ({ ok: false, code }) }] });
      const win = watch(windowSocket(fake));
      assert.deepEqual(await closed(win), { code: 4403, reason: code });
      assert.equal(reasons(fake, 'window.session.closed')[0].reason, code);
    }
  });

  it('a refusal in words a close frame should not carry says node_refused', async () => {
    const fake = await frontDoor({ nodes: [{ identity: nodeA, open: async () => ({ ok: false, code: 'Not\r\nA code' }) }] });
    const win = watch(windowSocket(fake));
    assert.deepEqual(await closed(win), { code: 4403, reason: 'node_refused' });
  });

  it('a link failure is 4404, and a node with no such method has the window off', async () => {
    const fail = (code) => async () => { throw Object.assign(new Error('no'), { code }); };
    for (const [code, want] of [['timeout', { code: 4404, reason: 'node_offline' }], ['offline', { code: 4404, reason: 'node_offline' }], ['unknown_method', { code: 4403, reason: 'remote_window_off' }]]) {
      const fake = await frontDoor({ nodes: [{ identity: nodeA, open: fail(code) }] });
      const win = watch(windowSocket(fake));
      assert.deepEqual(await closed(win), want);
    }
  });

  it('a dial-back on another node\'s certificate is destroyed, and the session waits for the right one', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const win = watch(windowSocket(fake));
    await opened(win.ws);
    for (const identity of [nodeB, stranger]) {
      const wrong = watch(fake.dial(identity, win.session));
      await waitFor(() => wrong.error, 'the wrong dial to be refused');
    }
    assert.equal(win.close, null);
    assert.equal(fake.splice.sessions.size, 1);
    const right = watch(fake.dial(nodeA, win.session));
    await opened(right.ws);
    win.ws.send(Buffer.from('through'));
    await waitFor(() => right.messages.length === 1, 'the frame');
  });

  it('a dial with no client certificate is destroyed', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const win = watch(windowSocket(fake));
    await opened(win.ws);
    const bare = watch(new WebSocket(`${fake.meshUrl}/window/v1/${win.session}`, { ...SOCKET_OPTIONS, rejectUnauthorized: false }));
    await waitFor(() => bare.error, 'the dial to be refused');
    assert.equal(win.close, null);
  });

  it('a second dial for one session is destroyed, and the first carries on', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win, node, session } = await joined(fake);
    const second = watch(fake.dial(nodeA, session));
    await waitFor(() => second.error, 'the second dial to be refused');
    win.ws.send(Buffer.from('still here'));
    await waitFor(() => node.messages.length === 1, 'the frame');
  });

  it('a dial for a session nobody opened is destroyed, and a path that is not the splice\'s is left to the caller', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const unknown = watch(fake.dial(nodeA, crypto.randomBytes(32).toString('base64url')));
    await waitFor(() => unknown.error, 'the refusal');
    const destroyed = [];
    const socket = { destroy() { destroyed.push(true); }, on() {}, once() {} };
    assert.equal(fake.splice.onMeshUpgrade({ url: '/mesh/v1', headers: {} }, socket, Buffer.alloc(0)), false);
    assert.equal(destroyed.length, 0);
    assert.equal(fake.splice.onMeshUpgrade({ url: '/window/v1/short', headers: {} }, { ...socket, setTimeout() {}, setNoDelay() {} }, Buffer.alloc(0)), true);
    assert.equal(destroyed.length, 1);
    assert.equal(fake.splice.onMeshUpgrade({ url: '/window/v1', headers: {} }, { ...socket, setTimeout() {}, setNoDelay() {} }, Buffer.alloc(0)), true);
  });
});

describe('limits over a live session (R-RW-4, R-RW-5)', () => {
  it('the byte budget closes both legs 4429', async () => {
    const fake = await frontDoor({ nodes: hands(), config: { maxBytesPerHour: 1000 } });
    const { win, node } = await joined(fake);
    win.ws.send(crypto.randomBytes(400));
    await waitFor(() => node.messages.length === 1, 'the frame within budget');
    node.ws.send(crypto.randomBytes(400));
    await waitFor(() => win.messages.length === 1, 'the reply within budget');
    win.ws.send(crypto.randomBytes(400));
    assert.deepEqual(await closed(win), { code: 4429, reason: 'byte_budget' });
    assert.deepEqual(await closed(node), { code: 4429, reason: 'byte_budget' });
    assert.equal(node.messages.length, 1, 'the frame that passed the budget is not carried');
  });

  it('the budget rolls with the hour', () => {
    const time = clock();
    const sessions = new WindowSessions({ maxSessionsPerGrant: 4, maxSessionsPerDeviceNode: 2, maxBytesPerHour: 1000, now: time.now });
    sessions.add({ session_id: 's', grant_id: 'g', client_id: 'c', node_id: 'n' });
    assert.equal(sessions.addBytes('s', 'in', 600), true);
    time.advance(30 * 60000);
    assert.equal(sessions.addBytes('s', 'out', 300), true);
    time.advance(31 * 60000);
    assert.equal(sessions.addBytes('s', 'in', 600), true, 'the first 600 have left the hour');
    assert.equal(sessions.addBytes('s', 'in', 200), false);
    const [record] = sessions.list();
    assert.equal(record.bytes_in, 1400);
    assert.equal(record.bytes_out, 300);
  });

  it('a grant revoked mid-session closes both legs 4403 grant_revoked', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win, node } = await joined(fake);
    fake.revokeGrant('g-all');
    assert.deepEqual(await closed(win), { code: 4403, reason: 'grant_revoked' });
    assert.deepEqual(await closed(node), { code: 4403, reason: 'grant_revoked' });
    assert.equal(fake.splice.sessions.size, 0);
  });

  it('a close frame is never put inside a frame going out: that leg is cut', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win, node } = await joined(fake);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(1000);
    win.ws._socket.write(Buffer.concat([Buffer.from([0x82, 0xfe]), length, Buffer.from([1, 2, 3, 4]), Buffer.alloc(10)]));
    await waitFor(() => fake.splice.sessions.list()[0].bytes_in > 0, 'the start of the frame');
    fake.revokeGrant('g-all');
    assert.deepEqual(await closed(win), { code: 4403, reason: 'grant_revoked' });
    await closed(node);
    assert.equal(node.messages.length, 0);
    assert.notEqual(node.close.code, 4403);
  });

  it('a grant gone by another path ends at the next sweep; an access token running out does not end it', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win } = await joined(fake);
    fake.expireToken('kla_all');
    fake.splice.sweep();
    await delay(20);
    assert.equal(win.close, null);
    fake.dropGrant('g-all');
    fake.splice.sweep();
    assert.deepEqual(await closed(win), { code: 4403, reason: 'grant_revoked' });
  });

  it('a node removed from the registry ends its sessions', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win } = await joined(fake);
    fake.removeNode(nodeA.nodeId);
    fake.splice.sweep();
    assert.deepEqual(await closed(win), { code: 4403, reason: 'unknown_machine' });
  });

  it('nothing for idle_s closes 1001, and any byte puts it off', async () => {
    const time = clock();
    const fake = await frontDoor({ nodes: hands(), now: time.now, config: { idleS: 600 } });
    const { win, node } = await joined(fake);
    time.advance(599000);
    win.ws.send(Buffer.from('still here'));
    await waitFor(() => node.messages.length === 1, 'the frame');
    time.advance(599000);
    fake.splice.sweep();
    await delay(20);
    assert.equal(win.close, null);
    time.advance(1000);
    fake.splice.sweep();
    assert.deepEqual(await closed(win), { code: 1001, reason: 'idle' });
    assert.equal((await closed(node)).code, 1001);
  });

  it('stop closes every session, and sends nothing after', async () => {
    const fake = await frontDoor({ nodes: hands() });
    const { win } = await joined(fake);
    fake.splice.stop();
    assert.equal((await closed(win)).code, 1001);
    assert.equal(fake.splice.sessions.size, 0);
  });
});

describe('the audit (R-RW-4)', () => {
  it('holds opened, closed with the byte counts, and refused, and no frame content', async () => {
    const time = clock();
    const fake = await frontDoor({ nodes: hands(), now: time.now });
    const planted = Buffer.from('PLANTED-IN-A-FRAME');
    const { win, node, session } = await joined(fake);
    win.ws.send(planted);
    await waitFor(() => node.messages.length === 1, 'the frame');
    node.ws.send(planted);
    await waitFor(() => win.messages.length === 1, 'the reply');
    const { bytes_in: bytesIn, bytes_out: bytesOut } = fake.splice.sessions.list()[0];
    time.advance(5000);
    fake.revokeGrant('g-all');
    await closed(win);
    const refusedSocket = watch(windowSocket(fake, 'kla_web02', nodeA.nodeId));
    await closed(refusedSocket);

    assert.deepEqual(reasons(fake, 'window.session.opened'), [{ session_id: session, grant_id: 'g-all', client_id: 'c-window', node_id: nodeA.nodeId }]);
    assert.deepEqual(reasons(fake, 'window.session.closed'), [{ session_id: session, device_id: null, bytes_in: bytesIn, bytes_out: bytesOut, seconds: 5, reason: 'grant_revoked' }]);
    assert.deepEqual(reasons(fake, 'window.session.refused'), [{ grant_id: 'g-web02', client_id: 'c-window', node_id: nodeA.nodeId, code: 'unknown_machine' }]);
    assert.ok(bytesIn >= planted.length && bytesOut >= planted.length);
    assert.ok(!JSON.stringify(fake.audit).includes('PLANTED'));
  });

  it('its three kinds are ones the front door\'s own ledger takes', () => {
    for (const kind of ['window.session.opened', 'window.session.closed', 'window.session.refused']) assert.ok(FRONT_DOOR_AUDIT_KINDS.includes(kind), kind);
  });
});

describe('the mcp server\'s upgrades', () => {
  async function plainServer(options) {
    const received = [];
    const server = createMcpHttpServer((req, res) => { res.writeHead(404); res.end(); }, {}, options);
    const listener = net.createServer((socket) => server.emit('connection', socket));
    await new Promise((resolve) => { listener.listen(0, '127.0.0.1', resolve); });
    cleanups.push(() => new Promise((resolve) => { listener.close(resolve); }));
    return { received, port: listener.address().port };
  }
  const upgrade = (port, target) => new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', path: target, headers: { connection: 'Upgrade', upgrade: 'websocket' } });
    req.on('error', () => resolve('destroyed'));
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve('upgraded'); });
    req.on('response', () => resolve('answered'));
    req.end();
  });

  it('keeps /window/v1 for onUpgrade and destroys every other', async () => {
    const taken = [];
    const { port } = await plainServer({
      onUpgrade: (req, socket) => {
        taken.push(req.url);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      }
    });
    assert.equal(await upgrade(port, '/foo'), 'destroyed');
    assert.equal(await upgrade(port, '/window/v1/extra'), 'destroyed');
    assert.equal(await upgrade(port, '/window/v1?node=x'), 'upgraded');
    assert.deepEqual(taken, ['/window/v1?node=x']);
  });

  it('with no onUpgrade destroys them all, as before', async () => {
    const { port } = await plainServer(undefined);
    assert.equal(await upgrade(port, '/window/v1'), 'destroyed');
  });

  it('an onUpgrade that throws costs that socket only', async () => {
    const { port } = await plainServer({ onUpgrade: () => { throw new Error('no'); } });
    assert.equal(await upgrade(port, '/window/v1'), 'destroyed');
  });
});

describe('frontdoor.window (R-RW-5)', () => {
  const FILE = 'node.yaml';
  const parse = (block) => parseFrontDoorConfig({ domain: 'kl.example.com', ...(block === undefined ? {} : { window: block }) }, FILE).window;

  it('defaults to the ruling\'s values', () => {
    assert.deepEqual(parse(undefined), { maxSessionsPerGrant: 4, maxSessionsPerDeviceNode: 2, maxBytesPerHour: 1073741824, idleS: 600 });
    assert.deepEqual(WINDOW_DEFAULTS, parse(undefined));
    assert.ok(FRONTDOOR_KEYS.top.includes('window'));
  });

  it('takes its four keys and refuses any other', () => {
    assert.deepEqual(parse({ max_sessions_per_grant: 8, max_sessions_per_device_node: 3, max_bytes_per_hour: 2048, idle_s: 120 }), {
      maxSessionsPerGrant: 8, maxSessionsPerDeviceNode: 3, maxBytesPerHour: 2048, idleS: 120
    });
    assert.throws(() => parse({ max_sessions: 1 }), /frontdoor\.window\.max_sessions/);
    assert.throws(() => parse('on'), /frontdoor\.window must be a mapping/);
  });

  it('refuses a limit that is not a whole number in range', () => {
    for (const [key, value] of [['max_sessions_per_grant', 0], ['max_sessions_per_device_node', 1.5], ['max_bytes_per_hour', -1], ['idle_s', '600'], ['idle_s', 59]]) {
      assert.throws(() => parse({ [key]: value }), new RegExp(`frontdoor\\.window\\.${key}`), `${key} ${value}`);
    }
  });
});

// A window with a real seal and a node with a real DesktopBridgeServer, on either
// side of the splice. wireOut and wireIn are the sealed messages as the window sent
// and got them; tapped is the same at the node.
async function sealedPair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-window-splice-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = keys.rawFromPublicKeyObject(publicKey);
  const device = { deviceId: keys.deriveDeviceId(raw, 'kld-'), raw, privateKey };
  const doc = pairing.upsertDevice(pairing.emptyDevices(), {
    deviceId: device.deviceId, publicKey: keys.toB64url(raw), label: 'Laptop', pairedAt: '2026-11-04T10:00:00Z', remote: true
  });
  pairing.writeFileAtomic(path.join(dir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
  const context = { getSettings: () => ({}), setSettings() {}, getActiveChatId: () => null, setActiveChatId() {}, appendMessageToChat() {}, getApiTokens: () => ({}) };
  const server = new DesktopBridgeServer({
    identity: nodeA, configDir: dir, port: 0, version: '26.11.0', adminUid: selfUid, account: 'LOCAL SERVICE',
    approvals: { sealPolicy: { canSeal: () => true } },
    createDispatcher: (opts) => createBridgeDispatcher({
      ...opts,
      core: { context },
      dataDir: dir,
      getConnection: () => currentConnection(),
      listChannels: () => ({ handle: ['chat:load'], on: [] }),
      registerHandlers: (ipc) => ipc.handle('chat:load', () => ({ chats: ['stub'] }))
    })
  });
  cleanups.push(() => server.stop());

  const tapped = { nodeSent: [], nodeReceived: [] };
  const fake = await frontDoor({
    nodes: [{
      identity: nodeA,
      server,
      tap: (transport) => {
        const send = transport.send;
        transport.send = (bytes) => {
          tapped.nodeSent.push(Buffer.from(bytes));
          return send(bytes);
        };
        transport.on('data', (bytes) => tapped.nodeReceived.push(Buffer.from(bytes)));
      }
    }]
  });

  const ws = windowSocket(fake);
  const seen = watch(ws);
  await opened(ws);
  const transport = wsTransport(ws);
  const win = { received: [], wireOut: [], wireIn: [] };
  const seal = WindowSeal.window({
    sessionId: seen.session,
    deviceId: device.deviceId,
    publicKey: raw,
    sign: (bytes) => crypto.sign(null, bytes, privateKey),
    pin: Buffer.from(nodeA.publicKey, 'hex').subarray(-32),
    write: (bytes) => {
      win.wireOut.push(Buffer.from(bytes));
      return transport.send(bytes);
    },
    onClose: () => {}
  });
  cleanups.push(() => seal.destroy());
  let queue = Promise.resolve();
  transport.on('data', (bytes) => {
    win.wireIn.push(Buffer.from(bytes));
    queue = queue.then(() => seal.next(bytes)).then((result) => {
      for (const frame of result.frames) win.received.push(JSON.parse(frame.toString('utf8')));
    }).catch(() => {});
  });
  win.send = (obj) => { for (const step of seal.records(Buffer.from(JSON.stringify(obj)))) assert.ok(step); };
  await seal.next(null);
  return { window: win, server, device, fake, tapped };
}
