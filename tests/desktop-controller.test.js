// tests/desktop-controller.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const pairing = require('../src/desktop-bridge/pairing');
const keys = require('../src/desktop-bridge/keys');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { createDesktopController, DETACH_WARNING } = require('../src/ipc/desktop-controller');
const { registerDesktopHandlers } = require('../src/ipc/desktop-handlers');

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const dirs = [];
const servers = [];
after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ctl-')); dirs.push(d); return d; };
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^sealed:/, '')
});
const storeFactory = ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults });
const identity = new NodeIdentity({ nodeName: 'gpu-box' });

function fakeApp() {
  const calls = [];
  return { calls, relaunch: (o) => calls.push(['relaunch', o]), exit: (c) => calls.push(['exit', c]), quit: () => calls.push(['quit']), getPath: () => tmp() };
}

async function startService() {
  const configDir = tmp();
  const dispatcher = {
    served: { handle: ['chat:load'], on: [] },
    providersConfigured: () => true,
    async handleFrame(conn, frame) {
      if (frame.t === 'call' && frame.method === 'bridge.approvalsStatus') conn.send({ t: 'result', id: frame.id, value: { available: false } });
    },
    onDisconnect() {},
    forwardAmbient() {}
  };
  const server = new DesktopBridgeServer({ identity, configDir, port: 0, version: '26.9.0', adminUid: selfUid, account: 'LOCAL SERVICE', createDispatcher: () => dispatcher });
  servers.push(server);
  const { port } = await server.start();
  return { server, port, configDir };
}

function controllerFor({ mode = 'standalone', safeStorage = fakeSafeStorage(), readBridgeFile, env = {} } = {}) {
  const userDataDir = tmp();
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory });
  const app = fakeApp();
  const sentToWindow = [];
  const out = [];
  const window = { isDestroyed: () => false, webContents: { send: (ch, p) => sentToWindow.push([ch, p]) } };
  const controller = createDesktopController({
    state, mode, app, getWindow: () => window, env, platform: 'linux', userDataDir, safeStorage,
    stdout: { write: (s) => out.push(s) }, argv: ['electron', '.'], readBridgeFile, pollMs: 20, username: 'alex'
  });
  return { controller, state, app, sentToWindow, out };
}

describe('desktop controller', () => {
  it('starts unpaired and reports a missing bridge file', async () => {
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found at /etc/king-louie.' }) });
    const status = await controller.status();
    assert.strictEqual(status.view, 'unpaired');
    assert.strictEqual(status.mode, 'standalone');
    assert.deepStrictEqual(status.bridge, { ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found at /etc/king-louie.' });
    assert.deepStrictEqual(status.unavailableTabs, []);
  });

  it('refuses to pair without secure storage', async () => {
    const { controller } = controllerFor({ safeStorage: fakeSafeStorage(false), readBridgeFile: () => ({ ok: false }) });
    assert.deepStrictEqual(await controller.pairStart(), {
      ok: false, code: 'SECURE_STORAGE_UNAVAILABLE', error: "This system has no secure storage; the desktop can't hold a pairing key."
    });
  });

  it('pairs: request and command, finds the service, confirms with a real handshake', async () => {
    const svc = await startService();
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    const { controller, state, sentToWindow } = controllerFor({ readBridgeFile: () => ({ ok: true, record: pairing.parseBridgeFile(JSON.stringify(record)) }) });
    const started = await controller.pairStart();
    assert.strictEqual(started.view, 'pairing');
    const request = started.pendingPair.request;
    const decoded = pairing.decodePairRequest(request);
    assert.strictEqual(decoded.label, "alex's desktop");
    assert.strictEqual(started.pendingPair.command, `sudo king-louie-service desktop pair ${request}`);
    assert.strictEqual(started.pendingPair.deviceFingerprint, keys.fingerprintGroups(decoded.deviceId));
    assert.ok(!JSON.stringify(started).includes('PRIVATE KEY'), 'the private key never reaches the renderer');
    await new Promise((r) => setTimeout(r, 60));
    const polled = await controller.status();
    assert.strictEqual(polled.pendingPair.service.fingerprint, keys.fingerprintGroups(identity.nodeId));
    assert.ok(sentToWindow.some(([ch]) => ch === 'desktop:statusChanged'));
    // The administrator ran `desktop pair`: the device is in the devices file.
    pairing.writeFileAtomic(path.join(svc.configDir, pairing.DEVICES_FILE), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), {
      deviceId: decoded.deviceId, publicKey: decoded.publicKey, label: decoded.label, pairedAt: '2026-09-23T14:02:11Z'
    })), 0o644);
    const confirmed = await controller.pairConfirm();
    assert.strictEqual(confirmed.view, 'paired', JSON.stringify(confirmed));
    assert.strictEqual(state.pairing.service.nodeId, identity.nodeId);
    assert.strictEqual(state.pairing.service.info.account, 'LOCAL SERVICE');
    assert.strictEqual(state.pendingPair, null);
    controller.dispose();
  });

  it('reports a service that does not know the device', async () => {
    const svc = await startService();
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: true, record: pairing.parseBridgeFile(JSON.stringify(record)) }) });
    await controller.pairStart();
    const out = await controller.pairConfirm();
    assert.deepStrictEqual(out, { ok: false, code: 'DEVICE_UNPAIRED', error: 'The service does not know this desktop. Pair again in Settings > Local service.' });
    controller.dispose();
  });

  it('attach, detach and standalone-once relaunch; in test mode they print KL_RELAUNCH_REQUESTED', async () => {
    const { controller, state, app, out } = controllerFor({ env: { KL_TEST_MODE: '1' }, readBridgeFile: () => ({ ok: false }) });
    assert.strictEqual((await controller.attach()).code, 'NOT_PAIRED');
    state.setPairing({ deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', service: { nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex'), port: 18795, pairedAt: '2026-09-23T14:02:11Z' } });
    assert.deepStrictEqual(await controller.attach(), { ok: true, relaunching: true });
    assert.strictEqual(state.mode, 'attached');
    assert.deepStrictEqual(out, ['KL_RELAUNCH_REQUESTED\n']);
    assert.deepStrictEqual(app.calls, [['quit']]);
    assert.deepStrictEqual(await controller.detach({}), { ok: false, code: 'CONFIRM_REQUIRED', error: DETACH_WARNING });
    assert.strictEqual(state.mode, 'attached');
    await controller.detach({ confirmed: true });
    assert.strictEqual(state.mode, 'standalone');
  });

  it('relaunches with --kl-standalone-once outside test mode', async () => {
    const { controller, state, app } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    state.setMode('attached');
    await controller.standaloneOnce();
    assert.deepStrictEqual(app.calls, [['relaunch', { args: ['.', '--kl-standalone-once'] }], ['exit', 0]]);
    assert.strictEqual(state.mode, 'attached', 'the mode is not changed');
  });

  it('shows unavailable tabs and approvals when attached and connected', async () => {
    const svc = await startService();
    const { controller, state } = controllerFor({ mode: 'attached', readBridgeFile: () => ({ ok: false }) });
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    await controller.status();
    // A paired device (as after pairConfirm), then the attached host's client.
    const { privateKey, publicKey } = require('crypto').generateKeyPairSync('ed25519');
    const raw = keys.rawFromPublicKeyObject(publicKey);
    const deviceId = keys.deriveDeviceId(raw, 'kld-');
    state.setPairing({ deviceId, publicKey: keys.toB64url(raw), privateKeySealed: state.seal(privateKey.export({ type: 'pkcs8', format: 'pem' })), label: 'desk', service: { nodeId: record.nodeId, publicKey: record.publicKey, port: svc.port, pairedAt: '2026-09-23T14:02:11Z' } });
    pairing.writeFileAtomic(path.join(svc.configDir, pairing.DEVICES_FILE), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), { deviceId, publicKey: keys.toB64url(raw), label: 'desk', pairedAt: '2026-09-23T14:02:11Z' })), 0o644);
    const client = controller.createClient();
    controller.setClient(client);
    await client.connect();
    const status = await controller.status();
    assert.strictEqual(status.view, 'attached-connected');
    assert.deepStrictEqual(status.approvals, { available: false });
    assert.ok(status.unavailableTabs.includes('hooks'));
    assert.strictEqual(status.service.account, 'LOCAL SERVICE');
    client.close();
    controller.dispose();
  });

  it('is what desktop:* calls through registerDesktopHandlers', async () => {
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false, code: 'BRIDGE_FILE_MISSING', error: 'x' }) });
    const handlers = new Map();
    registerDesktopHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, { desktopBridge: controller });
    const out = await handlers.get('desktop:status')({});
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.view, 'unpaired');
  });
});
