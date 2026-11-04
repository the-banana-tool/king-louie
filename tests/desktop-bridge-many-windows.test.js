// tests/desktop-bridge-many-windows.test.js
// Remote window plan, task 2 (R-RW-6, R-RW-7, spec §9): a node takes up to
// eight windows at once. Chat events reach every one; a prompt reaches only the
// window whose call started the run.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const { registerHandlers } = require('../src/ipc/register');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const { createBridgeDispatcher } = require('../src/desktop-bridge/bridge-dispatcher');
const { createConnection } = require('../src/desktop-bridge/connection');
const { createDesktopBridgeHost } = require('../src/desktop-bridge/service-wiring');
const { runFor, currentConnection } = require('../src/desktop-bridge/run-context');
const { buildAuthC, newNonce, PROTOCOL, LIMITS, CLOSE, MESSAGES } = require('../src/desktop-bridge/protocol');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');
const { markLocalDesktopEvent, markRemoteWindowEvent } = require('../src/core/origin');
const { chatHarness } = require('./helpers/chat-harness');
const { profileSettings, everyRole } = require('./helpers/profile-settings');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const BUSY = { ok: false, code: 'CHAT_BUSY', error: 'A reply is still running in this chat.' };
const STOPPED_ROW = MESSAGES.DESKTOP_DISCONNECTED_RUN;
const PROBE_TOOL = 'KlTestManyWindowsProbe';

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const identity = new NodeIdentity({ nodeName: 'web-01' });
const dirs = [];
const servers = [];

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const waitFor = async (fn, what = 'a condition', ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

function makeDevice(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = keys.rawFromPublicKeyObject(publicKey);
  return { deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), label, privateKey };
}

function writeDevices(configDir, devices) {
  let doc = pairing.emptyDevices();
  for (const d of devices) doc = pairing.upsertDevice(doc, { deviceId: d.deviceId, publicKey: d.publicKey, label: d.label, pairedAt: '2026-11-04T10:00:00Z' });
  pairing.writeFileAtomic(path.join(configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
}

function fakeDispatcher() {
  return {
    served: { handle: ['chat:load'], on: [] },
    disconnects: [],
    providersConfigured: () => true,
    async handleFrame() {},
    async onDisconnect(conn) {
      if (conn.cleaned) return;
      conn.cleaned = true;
      this.disconnects.push(conn.deviceId);
    },
    forwardAmbient() {}
  };
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function startServer({ devices, createDispatcher, core = null, cipher = null, dataDir = null }) {
  const configDir = tempDir('kl-windows-');
  writeDevices(configDir, devices);
  const server = new DesktopBridgeServer({
    core, cipher, dataDir, identity, configDir, port: 0, version: '26.11.0', adminUid: selfUid, account: 'LOCAL SERVICE', createDispatcher
  });
  servers.push(server);
  const { port } = await server.start();
  return { server, port, configDir };
}

// A window on the wire: records every frame, says how it closed.
async function attach(port, device) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received = [];
  ws.on('message', (data) => received.push(JSON.parse(data.toString('utf8'))));
  ws.on('error', () => {});
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })));
  const send = (obj) => ws.send(JSON.stringify(obj));
  const first = (match) => received.find(match);
  const events = (channel) => received.filter((f) => f.t === 'event' && f.channel === channel);
  const window = { ws, received, closed, send, first, events, result: (id) => first((f) => f.t === 'result' && f.id === id) };
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const challenge = await waitFor(() => first((f) => f.t === 'challenge'), 'the challenge');
  const clientNonce = newNonce();
  send({ t: 'clientHello', protocol: PROTOCOL, deviceId: device.deviceId, clientNonce });
  await waitFor(() => first((f) => f.t === 'hello'), 'the hello');
  const fields = { nodeId: identity.nodeId, deviceId: device.deviceId, port, serverNonce: challenge.serverNonce, clientNonce };
  send({ t: 'auth', sig: keys.toB64url(crypto.sign(null, Buffer.from(buildAuthC(fields)), device.privateKey)) });
  const outcome = await Promise.race([
    closed.then((close) => ({ close })),
    waitFor(() => first((f) => f.t === 'ready'), 'ready').then((ready) => ({ ready }))
  ]);
  window.ready = outcome.ready || null;
  window.close = outcome.close || null;
  return window;
}

after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
  closeOpenHistoryStores();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('run-context', () => {
  it('names the connection across awaits, timers and immediates, and only inside', async () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    assert.strictEqual(currentConnection(), null);
    const seen = [];
    const run = (conn, ms) => runFor(conn, async () => {
      seen.push([conn.id, currentConnection().id]);
      await delay(ms);
      seen.push([conn.id, currentConnection().id]);
      await new Promise((resolve) => { setImmediate(resolve); });
      seen.push([conn.id, currentConnection().id]);
      return conn.id;
    });
    assert.deepStrictEqual(await Promise.all([run(a, 15), run(b, 5)]), ['a', 'b']);
    assert.ok(seen.every(([started, read]) => started === read), JSON.stringify(seen));
    assert.strictEqual(seen.length, 6);
    assert.strictEqual(currentConnection(), null);
  });
});

describe('the server takes several windows', () => {
  it('two devices attach at once and both get ready', async () => {
    const a = makeDevice('desk at home');
    const b = makeDevice('laptop');
    const { port, server } = await startServer({ devices: [a, b], createDispatcher: fakeDispatcher });
    const one = await attach(port, a);
    const two = await attach(port, b);
    assert.ok(one.ready);
    assert.ok(two.ready);
    assert.deepStrictEqual(server.connected, [
      { deviceId: a.deviceId, label: 'desk at home', remote: false },
      { deviceId: b.deviceId, label: 'laptop', remote: false }
    ]);
    assert.strictEqual(one.ws.readyState, WebSocket.OPEN);
    one.ws.close();
    await one.closed;
    await waitFor(() => server.connected.length === 1, 'the first window to go');
    assert.strictEqual(server.connected[0].deviceId, b.deviceId);
    two.ws.close();
  });

  it('a ninth is closed 4409 "too many windows"; a window attaching again while full is not', async () => {
    assert.strictEqual(LIMITS.maxDevices, 8);
    assert.strictEqual(CLOSE.TOO_MANY_WINDOWS, 4409);
    assert.strictEqual(CLOSE.OTHER_DEVICE, undefined);
    const devices = Array.from({ length: 9 }, (_, i) => makeDevice(`window ${i + 1}`));
    const { port, server } = await startServer({ devices, createDispatcher: fakeDispatcher });
    const windows = [];
    for (const device of devices.slice(0, 8)) {
      const w = await attach(port, device);
      assert.ok(w.ready, device.label);
      windows.push(w);
    }
    const ninth = await attach(port, devices[8]);
    assert.deepStrictEqual(ninth.close, { code: 4409, reason: 'too many windows' });
    assert.strictEqual(server.connected.length, 8);
    const again = await attach(port, devices[3]);
    assert.ok(again.ready, 'one connection per device: replacing itself does not count');
    assert.strictEqual((await windows[3].closed).code, 1000);
    assert.strictEqual(server.connected.length, 8);
    for (const w of [...windows, again]) w.ws.terminate();
    await waitFor(() => server.connected.length === 0, 'every window to go');
    assert.ok((await attach(port, devices[8])).ready, 'the room is free again');
  });

  it('a device attaching again replaces its own connection and the other stays', async () => {
    const a = makeDevice('desk at home');
    const b = makeDevice('laptop');
    let dispatcher;
    const { port, server } = await startServer({ devices: [a, b], createDispatcher: () => { dispatcher = fakeDispatcher(); return dispatcher; } });
    const first = await attach(port, a);
    const other = await attach(port, b);
    const second = await attach(port, a);
    assert.ok(second.ready);
    assert.strictEqual((await first.closed).code, 1000);
    await waitFor(() => dispatcher.disconnects.length === 1, 'the old connection to be cleaned');
    assert.deepStrictEqual(dispatcher.disconnects, [a.deviceId]);
    assert.strictEqual(other.ws.readyState, WebSocket.OPEN);
    assert.deepStrictEqual(server.connected.map((c) => c.deviceId).sort(), [a.deviceId, b.deviceId].sort());
    other.ws.close();
    second.ws.close();
  });

  it('stop() says bye to every window and cleans every connection', async () => {
    const a = makeDevice('desk at home');
    const b = makeDevice('laptop');
    let dispatcher;
    const { port, server } = await startServer({ devices: [a, b], createDispatcher: () => { dispatcher = fakeDispatcher(); return dispatcher; } });
    const one = await attach(port, a);
    const two = await attach(port, b);
    await server.stop();
    for (const w of [one, two]) {
      assert.strictEqual((await w.closed).code, 1001);
      assert.deepStrictEqual(w.first((f) => f.t === 'bye'), { t: 'bye', code: 'SERVICE_STOPPING' });
    }
    assert.deepStrictEqual([...dispatcher.disconnects].sort(), [a.deviceId, b.deviceId].sort());
    assert.deepStrictEqual(server.connected, []);
    assert.strictEqual(server.connections.size, 0);
  });

  it('the re-read closes only the device that is no longer paired', async () => {
    const a = makeDevice('desk at home');
    const b = makeDevice('laptop');
    const { port, server, configDir } = await startServer({ devices: [a, b], createDispatcher: fakeDispatcher });
    const one = await attach(port, a);
    const two = await attach(port, b);
    writeDevices(configDir, [b]);
    server._recheckLive();
    assert.strictEqual((await one.closed).code, 4403);
    await delay(20);
    assert.strictEqual(two.ws.readyState, WebSocket.OPEN);
    assert.deepStrictEqual(server.connected.map((c) => c.deviceId), [b.deviceId]);
    two.ws.close();
  });

  it('a service with no window is not interactive; one window is', () => {
    const host = createDesktopBridgeHost({ dataDir: tempDir('kl-windows-host-'), configDir: tempDir('kl-windows-host-'), features: { desktopBridge: true }, ports: { desktopBridge: 0 }, adminUid: selfUid, version: '26.11.0' });
    const interactive = () => host.coreDeps.host.interactive();
    assert.strictEqual(interactive(), false);
    host.server = { connected: [] };
    assert.strictEqual(interactive(), false, 'an empty list is nobody there');
    host.server = { connected: [{ deviceId: 'kld-aaaaaaaaaaaaaaaa', label: 'laptop', remote: false }] };
    assert.strictEqual(interactive(), true);
  });
});

describe('a real core behind several windows', () => {
  let core;
  let dataDir;
  let probe = null;
  const script = [];
  const realOpenAI = ProviderFactory._registry.get('openai');
  const cipher = createAesGcmCipher(crypto.randomBytes(32));
  const askUser = { type: 'tool_use', toolName: 'AskUser', toolUseId: 'call_ask', parameters: { question: 'Which lot?' } };
  const text = (content) => ({ type: 'text', content });

  class ScriptedProvider {
    async listModels() { return ['fake']; }
    async sendMessageWithTools() {
      const step = script.shift();
      assert.ok(step, 'the script ran out');
      return typeof step === 'function' ? step() : step;
    }
    buildToolMessages(response, toolResult, toolCallId) {
      return [
        { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
        { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
      ];
    }
  }

  before(async () => {
    ProviderFactory.registerProvider('openai', ScriptedProvider);
    toolRegistry.register(new Tool({
      name: PROBE_TOOL,
      description: 'Test-only tool that requires approval.',
      parameters: { type: 'object', properties: {} },
      requiresApproval: true,
      execute: async () => ({ ok: true })
    }));
    dataDir = tempDir('kl-windows-core-');
    core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher,
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals: 'deny'
    });
    core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: 'openai', model: 'fake' })));
    core.saveProviderToken('openai', 'fake-token-123456');
    await core.start();
  });

  after(async () => {
    for (const s of servers.splice(0)) await s.stop().catch(() => {});
    await core.shutdown().catch(() => {});
    if (realOpenAI) ProviderFactory.registerProvider('openai', realOpenAI);
  });

  // chat:get stands in for a handler a test wants to run on a connection.
  const bridge = (devices) => startServer({
    devices,
    core,
    cipher,
    dataDir,
    createDispatcher: (opts) => createBridgeDispatcher({
      ...opts,
      registerHandlers: (ipc, ctx) => {
        registerHandlers(ipc, ctx);
        ipc.handle('chat:get', async (event, arg) => probe(event, ctx, arg));
      }
    })
  });

  async function twoWindows() {
    const a = makeDevice('desk at home');
    const b = makeDevice('laptop');
    const { port, server } = await bridge([a, b]);
    return { server, A: await attach(port, a), B: await attach(port, b) };
  }

  let chatNumber = 0;
  const newChat = () => {
    chatNumber += 1;
    const id = `c-window-${chatNumber}`;
    core.context.createChat({ id, title: 'Lakeside lot', createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z', messages: [] });
    return id;
  };
  const sendInto = (w, id, chatId, message = 'Go on') => w.send({ t: 'invoke', id, channel: 'chat:sendMessage', args: [{ chatId, message, agentMode: true }] });
  const rows = (chatId, sender) => core.context.getChat(chatId, { messages: true }).messages.filter((m) => m.sender === sender);

  it('a run started on A streams to both windows and asks only A', async () => {
    const { server, A, B } = await twoWindows();
    const chatId = newChat();
    // Over a timer, so the turn has left the frame that started it.
    script.push(async () => { await delay(20); return askUser; }, text('Lot 12.'));
    sendInto(A, 1, chatId);
    const asked = await waitFor(() => A.events('agent:askUser')[0], "A's question");
    assert.strictEqual(asked.payload.question, 'Which lot?');
    assert.strictEqual(B.events('chat:messageStart').length, 1, 'B watches the same chat');
    assert.deepStrictEqual(B.events('agent:askUser'), []);
    const { requestId } = asked.payload;
    B.send({ t: 'send', channel: 'agent:userResponse', args: [{ requestId, response: 'from the laptop' }] });
    await delay(30);
    assert.ok(server.dispatcher.bridgeContext.pendingAskUserResolvers.has(requestId), "B cannot answer A's question");
    A.send({ t: 'send', channel: 'agent:userResponse', args: [{ requestId, response: 'Lot 12' }] });
    await waitFor(() => A.result(1), "A's result");
    assert.strictEqual(A.result(1).value.ok, true);
    await waitFor(() => B.events('chat:messageComplete').length === 1, 'the end to reach B');
    for (const w of [A, B]) {
      assert.deepStrictEqual(w.events('chat:messageChunk').map((f) => f.payload.chunk), ['Lot 12.']);
      assert.strictEqual(w.events('chat:messageComplete').length, 1);
    }
    assert.strictEqual(B.first((f) => f.t === 'result'), undefined, 'the result is A\'s alone');
    A.ws.close();
    B.ws.close();
  });

  it('a second send into a running chat is CHAT_BUSY from either window, and a drop still stops the run', async () => {
    const { server, A, B } = await twoWindows();
    const chatId = newChat();
    const hold = deferred();
    script.push(async () => { await hold.promise; return text('too late'); });
    sendInto(A, 1, chatId, 'First');
    await waitFor(() => A.events('chat:messageStart')[0], 'the turn to start');
    sendInto(B, 2, chatId, 'From the laptop');
    await waitFor(() => B.result(2), "B's answer");
    assert.deepStrictEqual(B.result(2).value, BUSY);
    sendInto(A, 3, chatId, 'From the desk again');
    await waitFor(() => A.result(3), "A's second answer");
    assert.deepStrictEqual(A.result(3).value, BUSY);
    assert.deepStrictEqual(rows(chatId, 'user').map((m) => m.text), ['First'], 'a refused send stores nothing');
    assert.strictEqual(A.result(1), undefined, 'the first turn is still running');

    // A's refused send did not take the chat off A's runs: its drop stops the turn.
    A.ws.terminate();
    await waitFor(() => rows(chatId, 'assistant').some((m) => m.text === STOPPED_ROW), 'the stopped row');
    hold.resolve();
    await waitFor(() => B.events('chat:messageComplete').length === 1, "the stop to reach the window still here");
    assert.strictEqual(B.events('chat:messageComplete')[0].payload.stopped, true);
    assert.strictEqual(B.ws.readyState, WebSocket.OPEN);
    assert.strictEqual(server.connected.length, 1);
    B.ws.close();
  });

  it("B's drop does not stop A's run, even after B was refused in that chat", async () => {
    const { A, B } = await twoWindows();
    const chatId = newChat();
    const hold = deferred();
    script.push(async () => { await hold.promise; return text('Finished.'); });
    sendInto(A, 1, chatId);
    await waitFor(() => A.events('chat:messageStart')[0], 'the turn to start');
    sendInto(B, 2, chatId);
    await waitFor(() => B.result(2), "B's answer");
    B.ws.terminate();
    await B.closed;
    await delay(30);
    hold.resolve();
    await waitFor(() => A.result(1), "A's result");
    assert.strictEqual(A.result(1).value.ok, true);
    const assistant = rows(chatId, 'assistant').map((m) => m.text);
    assert.ok(assistant.includes('Finished.'), JSON.stringify(assistant));
    assert.ok(!assistant.includes(STOPPED_ROW));
    A.ws.close();
  });

  it('a stop, then a new send in the same chat: the first ending leaves the second tracked', async () => {
    const { A, B } = await twoWindows();
    const chatId = newChat();
    const first = deferred();
    const second = deferred();
    script.push(async () => { await first.promise; return text('old'); });
    sendInto(A, 1, chatId, 'First');
    await waitFor(() => A.events('chat:messageStart')[0], 'the first turn');
    A.send({ t: 'invoke', id: 2, channel: 'chat:stopResponse', args: [{ chatId }] });
    await waitFor(() => A.result(2), 'the stop');
    script.push(async () => { await second.promise; return text('new'); });
    sendInto(A, 3, chatId, 'Second');
    await waitFor(() => A.events('chat:messageStart').length === 2, 'the second turn');
    first.resolve();
    await waitFor(() => A.result(1), 'the first turn to end');
    A.ws.terminate();
    await waitFor(() => rows(chatId, 'assistant').some((m) => m.text === STOPPED_ROW), 'the second turn stopped by the drop');
    second.resolve();
    B.ws.close();
  });

  it("each window's prompts stay with its own run across timers; a gone window's run asks nobody else", async () => {
    const { server, A, B } = await twoWindows();
    probe = async (_event, ctx, { question, wait }) => {
      await delay(wait);
      await new Promise((resolve) => { setImmediate(resolve); });
      return ctx.prompter.askUser({ question });
    };
    A.send({ t: 'invoke', id: 1, channel: 'chat:get', args: [{ question: 'for the desk', wait: 25 }] });
    B.send({ t: 'invoke', id: 2, channel: 'chat:get', args: [{ question: 'for the laptop', wait: 5 }] });
    const toA = await waitFor(() => A.events('agent:askUser')[0], "A's question");
    const toB = await waitFor(() => B.events('agent:askUser')[0], "B's question");
    assert.strictEqual(toA.payload.question, 'for the desk');
    assert.strictEqual(toB.payload.question, 'for the laptop');
    assert.strictEqual(A.events('agent:askUser').length, 1);
    assert.strictEqual(B.events('agent:askUser').length, 1);
    A.send({ t: 'send', channel: 'agent:userResponse', args: [{ requestId: toA.payload.requestId, response: 'a' }] });
    B.send({ t: 'send', channel: 'agent:userResponse', args: [{ requestId: toB.payload.requestId, response: 'b' }] });
    await waitFor(() => A.result(1) && B.result(2), 'both answers');
    assert.deepStrictEqual(A.result(1).value, { ok: true, response: 'a' });
    assert.deepStrictEqual(B.result(2).value, { ok: true, response: 'b' });

    // The run outlives its window: its next question goes to nobody, not to B.
    const gate = deferred();
    let answer = null;
    probe = async (_event, ctx) => {
      await gate.promise;
      answer = await ctx.prompter.askUser({ question: 'still there?' });
      const dir = await ctx.prompter.requestDirectoryAccess({ directory: 'C:\\example', toolName: 'Read' });
      return { ok: true, dir };
    };
    A.send({ t: 'invoke', id: 3, channel: 'chat:get', args: [{}] });
    await delay(20);
    A.ws.terminate();
    await waitFor(() => server.connected.length === 1, "A's connection to go");
    gate.resolve();
    await waitFor(() => answer, 'the refused question');
    assert.strictEqual(answer.ok, false);
    await delay(20);
    assert.strictEqual(B.events('agent:askUser').length, 1, 'only the one B started');
    assert.deepStrictEqual(B.events('tool:directoryAccessRequired'), []);
    B.ws.close();
  });

  it('a directory prompt reaches only the window whose run asked, and another window cannot answer it', async () => {
    const { server, A, B } = await twoWindows();
    probe = async (_event, ctx) => ({ ok: true, granted: await ctx.prompter.requestDirectoryAccess({ directory: 'C:\\example', toolName: 'Read' }) });
    A.send({ t: 'invoke', id: 1, channel: 'chat:get', args: [{}] });
    const asked = await waitFor(() => A.events('tool:directoryAccessRequired')[0], "A's prompt");
    assert.deepStrictEqual(B.events('tool:directoryAccessRequired'), []);
    B.send({ t: 'send', channel: 'tool:directoryAccessResponse', args: [{ requestId: asked.payload.requestId, approved: true }] });
    await delay(30);
    assert.ok(server.dispatcher.bridgeContext.pendingDirectoryAccessResolvers.has(asked.payload.requestId));
    A.send({ t: 'send', channel: 'tool:directoryAccessResponse', args: [{ requestId: asked.payload.requestId, approved: false }] });
    await waitFor(() => A.result(1), "A's result");
    assert.strictEqual(A.result(1).value.granted, false);
    A.ws.close();
    B.ws.close();
  });

  it("a tool approval reaches only the window that asked, and B's answer is dropped", async () => {
    const { server, A, B } = await twoWindows();
    A.send({ t: 'invoke', id: 1, channel: 'tool:execute', args: [{ toolName: PROBE_TOOL, parameters: {} }] });
    const prompt = await waitFor(() => A.events('tool:approvalRequired')[0], "A's approval");
    assert.deepStrictEqual(B.events('tool:approvalRequired'), []);
    B.send({ t: 'send', channel: 'tool:approvalResponse', args: [{ approvalId: prompt.payload.approvalId, approved: true }] });
    await delay(30);
    assert.strictEqual(A.result(1), undefined, 'still waiting');
    A.send({ t: 'send', channel: 'tool:approvalResponse', args: [{ approvalId: prompt.payload.approvalId, approved: true }] });
    await waitFor(() => A.result(1), "A's result");
    assert.strictEqual(A.result(1).value.ok, true);
    assert.deepStrictEqual(B.events('tool:approvalRequired'), []);
    assert.strictEqual(server.connected.length, 2);
    A.ws.close();
    B.ws.close();
  });

  it('forwardAmbient reaches every window, and never with a prompt or canvas code', async () => {
    const { server, A, B } = await twoWindows();
    server.forwardAmbient('chat:updated', { chatId: 'c-1' });
    server.forwardAmbient('agent:askUser', { requestId: 'x', question: 'no' });
    server.forwardAmbient('tool:approvalRequired', { approvalId: 'x' });
    server.forwardAmbient('canvas:executeJs', { requestId: 'x', code: '1' });
    server.forwardAmbient('not:aRendererEvent', {});
    await waitFor(() => A.events('chat:updated').length && B.events('chat:updated').length, 'both windows');
    await delay(20);
    for (const w of [A, B]) assert.deepStrictEqual(w.received.filter((f) => f.t === 'event').map((f) => f.channel), ['chat:updated']);
    A.ws.close();
    B.ws.close();
  });

  it('canvas code goes to the run\'s window only; a render goes to all; a gone window\'s code fails at once', async () => {
    const { server, A, B } = await twoWindows();
    let sender = null;
    probe = async (event) => {
      sender = event.sender;
      sender.send('canvas:render', { chatId: 'c-1', title: 'Plan', content: '<p>Lot</p>' });
      sender.send('canvas:executeJs', { chatId: 'c-1', requestId: 'js-1', code: '1' });
      return { ok: true };
    };
    A.send({ t: 'invoke', id: 1, channel: 'chat:get', args: [{}] });
    await waitFor(() => A.result(1) && B.events('canvas:render').length, 'the probe');
    assert.strictEqual(A.events('canvas:render').length, 1);
    assert.strictEqual(A.events('canvas:executeJs').length, 1);
    assert.deepStrictEqual(B.events('canvas:executeJs'), []);

    A.ws.terminate();
    await waitFor(() => server.connected.length === 1, "A's connection to go");
    assert.strictEqual(sender.isDestroyed(), false, 'a window is still there for the chat events');
    sender.send('chat:updated', { chatId: 'c-1' });
    await waitFor(() => B.events('chat:updated').length === 1, 'the event from a gone window\'s run');
    const failed = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve('timed out'), 60000);
      timeout.unref();
      core.pendingCanvasJsResolvers.set('js-2', { resolve: () => resolve('resolved'), reject: (err) => resolve(err.message), timeout });
    });
    sender.send('canvas:executeJs', { chatId: 'c-1', requestId: 'js-2', code: '2' });
    assert.strictEqual(await failed, 'The desktop disconnected.');
    assert.strictEqual(core.pendingCanvasJsResolvers.has('js-2'), false);
    assert.deepStrictEqual(B.events('canvas:executeJs'), []);

    B.ws.close();
    await waitFor(() => server.connected.length === 0, "B's connection to go");
    assert.strictEqual(sender.isDestroyed(), true, 'no window left');
  });

  it('with no run behind it a prompt goes to the oldest local window, never a remote one', async () => {
    const a = makeDevice('desk at home');
    const b = makeDevice('laptop');
    const { port, server } = await bridge([a, b]);
    const sent = [];
    const remote = createConnection({ deviceId: 'kld-remoteremoterem', label: 'travel laptop', remote: true, send: (f) => sent.push(f) });
    assert.strictEqual(remote.remote, true);
    assert.strictEqual(createConnection({ deviceId: 'kld-aaaaaaaaaaaaaaaa', label: 'x', send() {} }).remote, false);
    server.connections.set(remote.deviceId, remote);
    const { prompter } = server.dispatcher.bridgeContext;

    assert.strictEqual((await prompter.askUser({ question: 'anyone?' })).ok, false, 'a remote window alone is asked nothing');
    assert.strictEqual(await prompter.requestDirectoryAccess({ directory: 'C:\\example', toolName: 'Read' }), false);

    const A = await attach(port, a);
    const B = await attach(port, b);
    const answer = prompter.askUser({ question: 'anyone at the desk?' });
    const asked = await waitFor(() => A.events('agent:askUser')[0], 'the oldest local window');
    assert.deepStrictEqual(B.events('agent:askUser'), []);
    assert.deepStrictEqual(sent.filter((f) => f.channel === 'agent:askUser'), []);
    A.send({ t: 'send', channel: 'agent:userResponse', args: [{ requestId: asked.payload.requestId, response: 'yes' }] });
    assert.deepStrictEqual(await answer, { ok: true, response: 'yes' });
    assert.deepStrictEqual(server.connected.map((c) => c.remote), [true, false, false]);

    // A remote run's own question goes to its window, its tool approval to no window.
    let sender = null;
    probe = async (event, ctx) => { sender = event.sender; return ctx.prompter.askUser({ question: 'from the road?' }); };
    const frame = server.dispatcher.handleFrame(remote, { t: 'invoke', id: 7, channel: 'chat:get', args: [{}] });
    const remoteAsked = await waitFor(() => sent.find((f) => f.channel === 'agent:askUser'), "the remote run's question");
    assert.strictEqual(remoteAsked.payload.question, 'from the road?');
    assert.strictEqual(B.events('agent:askUser').length, 0);
    sender.send('tool:approvalRequired', { approvalId: 'never', toolName: PROBE_TOOL, parameters: {} });
    await delay(20);
    assert.ok(!sent.some((f) => f.channel === 'tool:approvalRequired'));
    for (const w of [A, B]) assert.deepStrictEqual(w.events('tool:approvalRequired'), []);
    await server.dispatcher.handleFrame(remote, { t: 'send', channel: 'agent:userResponse', args: [{ requestId: remoteAsked.payload.requestId, response: 'yes' }] });
    await frame;
    server.connections.delete(remote.deviceId);
    A.ws.close();
    B.ws.close();
  });
});

describe('a bridge send into a running chat', () => {
  const bridgeEvent = (h) => markLocalDesktopEvent(h.event, { deviceId: 'kld-aaaaaaaaaaaaaaaa' });

  it('a case chat is busy from before its turn begins', async () => {
    const release = deferred();
    let begun = 0;
    const h = chatHarness({
      provider: {},
      chat: { id: 'chat-1', title: 'Chat', caseId: 'case-1', messages: [] },
      overrides: {
        getCaseRuntime: () => ({
          beginTurn: async () => {
            begun += 1;
            await release.promise;
            throw Object.assign(new Error('no case'), { code: 'CASE_NOT_FOUND' });
          }
        })
      }
    });
    bridgeEvent(h);
    const first = h.send();
    assert.strictEqual(h.context.isChatRunning('chat-1'), true);
    assert.deepStrictEqual(await h.send(), BUSY);
    assert.strictEqual(begun, 1, 'the second send began nothing');
    release.resolve();
    assert.strictEqual((await first).ok, false);
    assert.strictEqual(h.context.isChatRunning('chat-1'), false);
  });

  it('a remote window is held to it too, and the desktop\'s own window is not', async () => {
    const release = deferred();
    const provider = {
      async sendMessage() { await release.promise; return { content: 'done' }; },
      async *streamMessage() { await release.promise; yield 'done'; }
    };
    const h = chatHarness({ provider });
    markRemoteWindowEvent(h.event, { deviceId: 'kld-aaaaaaaaaaaaaaaa' });
    const first = h.send();
    assert.strictEqual(h.context.isChatRunning('chat-1'), true);
    assert.deepStrictEqual(await h.send(), BUSY);

    // The Electron host's own window: two sends may overlap, as they always could.
    markLocalDesktopEvent(h.event, { deviceId: null });
    const second = h.send();
    await delay(5);
    assert.strictEqual(h.chat.messages.filter((m) => m.sender === 'user').length, 2);
    release.resolve();
    await Promise.all([first, second]);
    assert.strictEqual(h.context.isChatRunning('chat-1'), false);
  });
});
