// tests/attached-host.test.js — no Electron: fake ipcMain, window, dialog and client.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { startAttachedHost } = require('../src/ipc/attached-host');
const { listIpcChannels } = require('../src/ipc/channel-inventory');
const { BridgeError } = require('../src/desktop-bridge/protocol');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-attached-')); dirs.push(d); return d; };

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.service = null;
    this.port = 18796;
    this.invoked = [];
    this.sent = [];
    this.calls = [];
    this.answers = new Map();
  }
  async connect() { return this.service; }
  retryNow() { return Promise.resolve(this.service); }
  close() { this.connected = false; }
  async invoke(channel, args) {
    this.invoked.push([channel, args]);
    if (this.answers.has(channel)) return this.answers.get(channel)(args);
    return { ok: true, data: { channel } };
  }
  send(channel, args) { this.sent.push([channel, args]); return true; }
  async call(method, params) {
    this.calls.push([method, params]);
    if (method === 'bridge.status') return this.service;
    if (method === 'bridge.setWorkingDirectory') return { ok: true, data: { id: params.chatId, workingDirectory: params.path } };
    if (method === 'bridge.addAllowedDirectory') return { ok: true, allowedDirectories: [params.path] };
    return { ok: true };
  }
  goLive(service) {
    this.service = service;
    this.connected = true;
    this.emit('state', { status: 'connected', code: null, error: null, service, nextRetryAt: null });
  }
  drop() {
    this.connected = false;
    this.emit('state', { status: 'disconnected', code: 'SERVICE_UNREACHABLE', error: 'The local King Louie service is not reachable (127.0.0.1:18796).', service: this.service, nextRetryAt: Date.now() + 1000 });
  }
}

const SERVICE = (channels, extra = {}) => ({ version: '26.9.0', protocol: 1, nodeId: 'kl-abcdefghijklmnop', account: 'LOCAL SERVICE', profile: 'agent', providersConfigured: true, channels, ...extra });

function setup() {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (ch, fn) => { assert.ok(!handlers.has(ch), `duplicate handle ${ch}`); handlers.set(ch, fn); },
    on: (ch, fn) => { assert.ok(!listeners.has(ch), `duplicate on ${ch}`); listeners.set(ch, fn); }
  };
  const sent = [];
  const window = { isDestroyed: () => false, close: () => sent.push(['closed']), webContents: { send: (ch, p) => sent.push([ch, p]) } };
  const dialogAnswers = [];
  const dialog = { showOpenDialog: async () => dialogAnswers.shift() };
  const userDataDir = tmp();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() };
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory: ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults }) });
  state.setMode('attached');
  state.setPairing({ deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', service: { nodeId: 'kl-abcdefghijklmnop', publicKey: 'aa', port: 18796, pairedAt: '2026-09-23T14:02:11Z' } });
  const client = new FakeClient();
  const app = { getPath: () => userDataDir, relaunch() {}, exit() {}, quit() {} };
  const host = startAttachedHost({ app, ipcMain, safeStorage, dialog, getWindow: () => window, state, env: {}, platform: 'linux', clientFactory: () => client });
  return { host, handlers, listeners, sent, client, dialogAnswers };
}

describe('attached host', () => {
  it('registers every inventory channel exactly once, plus canvas:executeJsResult', () => {
    const { handlers, listeners } = setup();
    const inv = listIpcChannels();
    assert.deepStrictEqual([...handlers.keys()].sort(), [...inv.handle].sort());
    assert.deepStrictEqual([...listeners.keys()].sort(), [...inv.on, 'canvas:executeJsResult'].sort());
  });

  it('routes proxy, deny, local and service-too-old channels', async () => {
    const { host, handlers, client } = setup();
    host.start();
    assert.strictEqual((await handlers.get('chat:load')({})).code, 'SERVICE_UNREACHABLE');
    client.goLive(SERVICE(['chat:load', 'chat:sendMessage', 'tool:approvalResponse']));
    assert.deepStrictEqual(await handlers.get('chat:load')({}), { ok: true, data: { channel: 'chat:load' } });
    assert.deepStrictEqual(await handlers.get('hooks:list')({}), {
      ok: false, code: 'ATTACHED_UNAVAILABLE', error: 'Not available while attached to the local service. Detach in Settings > Local service to use it.'
    });
    assert.strictEqual((await handlers.get('settings:mcpList')({})).code, 'ATTACHED_UNAVAILABLE');
    assert.deepStrictEqual(await handlers.get('cron:list')({}), {
      ok: false, code: 'SERVICE_TOO_OLD', error: 'The local service (version 26.9.0) does not support cron:list. Upgrade the service.'
    });
    assert.ok(!client.invoked.some(([ch]) => ch === 'hooks:list'));
    client.answers.set('chat:load', () => { throw new BridgeError('BRIDGE_TIMEOUT', 'The local service did not answer in time.'); });
    assert.deepStrictEqual(await handlers.get('chat:load')({}), { ok: false, code: 'BRIDGE_TIMEOUT', error: 'The local service did not answer in time.' });
    client.answers.set('chat:load', () => { throw new BridgeError('PAYLOAD_TOO_LARGE', 'Payload too large'); });
    assert.strictEqual((await handlers.get('chat:load')({})).error, 'That request is too large for the local service (64 MiB limit).');
  });

  it('wizard is local, and a send without a provider says so', async () => {
    const { handlers, client } = setup();
    assert.deepStrictEqual(await handlers.get('wizard:getStatus')({}), { ok: true, isFirstRun: false });
    assert.deepStrictEqual(await handlers.get('wizard:complete')({}), { ok: true });
    assert.ok((await handlers.get('wizard:getSteps')({})).steps.length > 0);
    client.goLive(SERVICE(['chat:sendMessage'], { providersConfigured: false }));
    assert.deepStrictEqual(await handlers.get('chat:sendMessage')({}, { chatId: 'c1', message: 'hi' }), {
      ok: false, code: 'NO_PROVIDER', error: 'The service has no provider key yet — import or add one in Providers.'
    });
    assert.ok(client.calls.some(([m]) => m === 'bridge.status'), 'it re-reads the service status first');
    client.service = SERVICE(['chat:sendMessage']);
    client.call = async () => client.service;
    assert.strictEqual((await handlers.get('chat:sendMessage')({}, { chatId: 'c1', message: 'hi' })).ok, true);
  });

  it('runs the directory pickers locally and reshapes the bridge answers', async () => {
    const { handlers, client, dialogAnswers } = setup();
    client.goLive(SERVICE(['chat:load']));
    dialogAnswers.push({ canceled: true, filePaths: [] });
    assert.deepStrictEqual(await handlers.get('chat:pickWorkingDirectory')({}, { chatId: 'c1' }), { ok: true, data: { canceled: true } });
    dialogAnswers.push({ canceled: false, filePaths: ['/srv/projects'] });
    assert.deepStrictEqual(await handlers.get('chat:pickWorkingDirectory')({}, { chatId: 'c1' }), { ok: true, data: { canceled: false, chat: { id: 'c1', workingDirectory: '/srv/projects' } } });
    dialogAnswers.push({ canceled: false, filePaths: ['/srv/data'] });
    assert.deepStrictEqual(await handlers.get('settings:addAllowedDirectory')({}), { ok: true, allowedDirectories: ['/srv/data'] });
    dialogAnswers.push({ canceled: true, filePaths: [] });
    assert.deepStrictEqual(await handlers.get('settings:addAllowedDirectory')({}), { ok: false, canceled: true });
  });

  it('forwards renderer events and proxies prompt answers', async () => {
    const { listeners, sent, client } = setup();
    client.goLive(SERVICE(['chat:load', 'tool:approvalResponse']));
    client.emit('event', 'tool:approvalRequired', { approvalId: 'a1', toolName: 'Bash', parameters: {} });
    client.emit('event', 'workflow:progress', {});
    assert.ok(sent.some(([ch]) => ch === 'tool:approvalRequired'));
    assert.ok(!sent.some(([ch]) => ch === 'workflow:progress'));
    listeners.get('tool:approvalResponse')({}, { approvalId: 'a1', approved: true });
    assert.deepStrictEqual(client.sent, [['tool:approvalResponse', [{ approvalId: 'a1', approved: true }]]]);
    listeners.get('canvas:executeJsResult')({}, { requestId: 'r1', result: 1 });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(client.calls.pop(), ['bridge.canvasJsResult', { requestId: 'r1', result: 1 }]);
  });

  it('a dropped connection ends open runs with chat:messageError', () => {
    const { sent, client } = setup();
    client.goLive(SERVICE(['chat:sendMessage']));
    client.emit('event', 'chat:messageStart', { chatId: 'c1', responseId: 'r1' });
    client.emit('event', 'chat:messageStart', { chatId: 'c2', responseId: 'r2' });
    client.emit('event', 'chat:messageComplete', { chatId: 'c2', responseId: 'r2', message: 'done' });
    client.drop();
    const errors = sent.filter(([ch]) => ch === 'chat:messageError').map(([, p]) => p);
    assert.deepStrictEqual(errors, [{ chatId: 'c1', responseId: 'r1', error: 'The local service restarted; the reply was lost.' }]);
    assert.ok(sent.some(([ch]) => ch === 'desktop:statusChanged'));
  });

  it('reconnect with changed service info: new channels apply at once', async () => {
    const { handlers, client } = setup();
    client.goLive(SERVICE(['chat:load']));
    assert.strictEqual((await handlers.get('cron:list')({})).code, 'SERVICE_TOO_OLD');
    client.drop();
    assert.strictEqual((await handlers.get('chat:load')({})).code, 'SERVICE_UNREACHABLE');
    client.goLive(SERVICE(['chat:load', 'cron:list'], { version: '26.10.0' }));
    assert.deepStrictEqual(await handlers.get('cron:list')({}), { ok: true, data: { channel: 'cron:list' } });
  });

  it('answers desktop:status through the controller', async () => {
    const { handlers, client } = setup();
    client.goLive(SERVICE(['chat:load']));
    const status = await handlers.get('desktop:status')({});
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.view, 'attached-connected');
    assert.ok(status.unavailableTabs.includes('mcp'));
  });
});
