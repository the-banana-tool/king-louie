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
const { MESSAGES } = require('../src/desktop-bridge/protocol');
const { EventEmitter } = require('events');

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

function controllerFor({
  mode = 'standalone', safeStorage = fakeSafeStorage(), readBridgeFile, env = {},
  pollWindowMs, clientFactory, pollMs = 20, extra = {}
} = {}) {
  const userDataDir = tmp();
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory });
  const app = fakeApp();
  const sentToWindow = [];
  const out = [];
  const window = { isDestroyed: () => false, webContents: { send: (ch, p) => sentToWindow.push([ch, p]) } };
  const controller = createDesktopController({
    state, mode, app, getWindow: () => window, env, platform: 'linux', userDataDir, safeStorage,
    stdout: { write: (s) => out.push(s) }, argv: ['electron', '.'], readBridgeFile, pollMs, username: 'alex',
    ...(pollWindowMs !== undefined ? { pollWindowMs } : {}),
    ...(clientFactory ? { clientFactory } : {}),
    ...extra
  });
  return { controller, state, app, sentToWindow, out, userDataDir };
}

const pairedRecord = ({ deviceId = 'kld-abcdefghijklmnop', service } = {}) => ({
  deviceId, publicKey: 'x', privateKeySealed: 'y', label: 'desk',
  service: service || { nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex'), port: 18796, pairedAt: '2026-09-23T14:02:11Z' }
});

// A stand-in DesktopBridgeClient for import tests: real connect()/close()
// bookkeeping (so "the session got closed" is observable), and a `call`
// that answers the desktop-export protocol (import.plan/apply/finish)
// without a real bridge server.
function fakeImportClient({ plan, applyResults = { results: [] }, finish = { planId: 'p1', counts: {}, failures: [], attention: [], secretsMissing: [], cronDisabled: 0, notes: [] }, failPlan = false, failFinish = false } = {}) {
  let closed = false;
  return {
    get connected() { return !closed; },
    async connect() { return { version: '26.9.0', account: 'LOCAL SERVICE', profile: 'agent', providersConfigured: true }; },
    close() { closed = true; },
    async call(method) {
      if (method === 'import.plan') {
        if (failPlan) throw Object.assign(new Error('planning failed'), { code: 'IMPORT_FAILED' });
        return plan;
      }
      if (method === 'import.apply') return applyResults;
      if (method === 'import.finish') {
        if (failFinish) throw Object.assign(new Error('finish failed'), { code: 'IMPORT_FAILED' });
        return finish;
      }
      throw new Error(`fakeImportClient: unexpected method ${method}`);
    }
  };
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
    const confirmed = await controller.pairConfirm({ nodeId: identity.nodeId });
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
    const out = await controller.pairConfirm({ nodeId: identity.nodeId });
    assert.deepStrictEqual(out, { ok: false, code: 'DEVICE_UNPAIRED', error: 'The service does not know this desktop. Pair again in Settings > Local service.' });
    controller.dispose();
  });

  it('attach, detach and standalone-once relaunch; in test mode they print KL_RELAUNCH_REQUESTED', async () => {
    const { controller, state, app, out } = controllerFor({ env: { KL_TEST_MODE: '1' }, readBridgeFile: () => ({ ok: false }) });
    assert.strictEqual((await controller.attach()).code, 'NOT_PAIRED');
    state.setPairing({ deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', service: { nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex'), port: 18796, pairedAt: '2026-09-23T14:02:11Z' } });
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

  // --- Fix round 1 (Task 13 review): pairConfirm pins `found` -----------

  it('pairConfirm refuses when no service has been found yet', async () => {
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false, code: 'BRIDGE_FILE_MISSING', error: 'x' }) });
    await controller.pairStart();
    const out = await controller.pairConfirm();
    assert.deepStrictEqual(out, { ok: false, code: 'PAIR_NOT_FOUND', error: MESSAGES.PAIR_NOT_FOUND });
    controller.dispose();
  });

  // --- Fix round 1 (Task 16 review): the nodeId argument is required, not
  // just checked when present — a caller that never names what it saw must
  // not be able to confirm on the controller's say-so alone.
  // Fix round 2: a missing nodeId gets its own message (PAIR_CONFIRM_STALE)
  // distinct from PAIR_SERVICE_CHANGED, which is reserved for a nodeId that
  // was named but no longer matches — the two are different problems.

  it('pairConfirm refuses with no nodeId argument even when a service was found', async () => {
    const svc = await startService();
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: true, record: pairing.parseBridgeFile(JSON.stringify(record)) }) });
    await controller.pairStart();
    const out = await controller.pairConfirm();
    assert.deepStrictEqual(out, { ok: false, code: 'PAIR_CONFIRM_STALE', error: MESSAGES.PAIR_CONFIRM_STALE });
    controller.dispose();
  });

  it('pairConfirm refuses when the service changed since its fingerprint was shown', async () => {
    const svcA = await startService();
    const otherIdentity = new NodeIdentity({ nodeName: 'web-01' });
    let current = pairing.parseBridgeFile(JSON.stringify(pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svcA.port })));
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: true, record: current }) });
    const started = await controller.pairStart();
    assert.strictEqual(started.pendingPair.service.fingerprint, keys.fingerprintGroups(identity.nodeId), 'found pinned the first service');
    // The bridge file now points at a different service (a swap, or a
    // stale/rewritten file) — pairConfirm must not silently pin the new one.
    current = pairing.parseBridgeFile(JSON.stringify(pairing.bridgeFileRecord({ publicKey: otherIdentity.publicKey, port: svcA.port })));
    // Pass the nodeId the owner was actually shown (the first service's),
    // so this exercises the fresh-read check below, not just the
    // missing-nodeId refusal.
    const out = await controller.pairConfirm({ nodeId: identity.nodeId });
    assert.deepStrictEqual(out, { ok: false, code: 'PAIR_SERVICE_CHANGED', error: MESSAGES.PAIR_SERVICE_CHANGED });
    controller.dispose();
  });

  // --- Task 16 carry: Confirm sends the nodeId the pane displayed, so a
  // poll tick that changes `found` between render and click cannot pin a
  // service the owner never actually compared.

  it('pairConfirm refuses when the passed nodeId no longer matches found (a poll tick raced the render)', async () => {
    const svc = await startService();
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: true, record: pairing.parseBridgeFile(JSON.stringify(record)) }) });
    await controller.pairStart();
    await new Promise((r) => setTimeout(r, 60));
    const polled = await controller.status();
    assert.strictEqual(polled.pendingPair.service.nodeId, identity.nodeId, 'this is what the pane would have shown');
    const out = await controller.pairConfirm({ nodeId: 'kld-somethingelsesomethin' });
    assert.deepStrictEqual(out, { ok: false, code: 'PAIR_SERVICE_CHANGED', error: MESSAGES.PAIR_SERVICE_CHANGED });
    controller.dispose();
  });

  it('pairConfirm succeeds when the passed nodeId matches found', async () => {
    const svc = await startService();
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    const { controller, state } = controllerFor({ readBridgeFile: () => ({ ok: true, record: pairing.parseBridgeFile(JSON.stringify(record)) }) });
    const started = await controller.pairStart();
    const decoded = pairing.decodePairRequest(started.pendingPair.request);
    await new Promise((r) => setTimeout(r, 60));
    const polled = await controller.status();
    pairing.writeFileAtomic(path.join(svc.configDir, pairing.DEVICES_FILE), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), {
      deviceId: decoded.deviceId, publicKey: decoded.publicKey, label: decoded.label, pairedAt: '2026-09-23T14:02:11Z'
    })), 0o644);
    const confirmed = await controller.pairConfirm({ nodeId: polled.pendingPair.service.nodeId });
    assert.strictEqual(confirmed.view, 'paired', JSON.stringify(confirmed));
    assert.strictEqual(state.pairing.service.nodeId, identity.nodeId);
    controller.dispose();
  });

  // --- Fix round 1: poll-window expiry and resuming a persisted pending pair

  it('clears an expired pending pair and notifies the window', async () => {
    const { controller, state, sentToWindow } = controllerFor({ readBridgeFile: () => ({ ok: false }), pollWindowMs: 50 });
    await controller.pairStart();
    assert.ok(state.pendingPair, 'pending pair is set');
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(state.pendingPair, null, 'the expired pending pair was cleared');
    assert.ok(sentToWindow.some(([ch]) => ch === 'desktop:statusChanged'));
    const status = await controller.status();
    assert.strictEqual(status.view, 'unpaired');
    controller.dispose();
  });

  it('pairCancel stops polling and returns to unpaired', async () => {
    const { controller, state } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    await controller.pairStart();
    assert.ok(state.pendingPair);
    const out = await controller.pairCancel();
    assert.strictEqual(out.view, 'unpaired');
    assert.strictEqual(state.pendingPair, null);
    controller.dispose();
  });

  it('resumes polling for a persisted pending pair with time remaining', async () => {
    const svc = await startService();
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    const userDataDir = tmp();
    const safeStorage = fakeSafeStorage();
    const state = openDesktopState(userDataDir, safeStorage, { storeFactory });
    const { publicKey, privateKey } = require('crypto').generateKeyPairSync('ed25519');
    const raw = keys.rawFromPublicKeyObject(publicKey);
    const request = pairing.encodePairRequest({ publicKeyRaw: raw, label: "alex's desktop" });
    // A pending pair saved by a previous run of the app (e.g. it was closed
    // mid-pairing), still well within its window.
    state.setPendingPair({
      deviceId: request.split('.')[1],
      publicKey: raw.toString('base64url'),
      privateKeySealed: state.seal(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      label: "alex's desktop",
      request,
      createdAt: new Date().toISOString()
    });
    const app = fakeApp();
    const window = { isDestroyed: () => false, webContents: { send: () => {} } };
    const controller = createDesktopController({
      state, mode: 'standalone', app, getWindow: () => window, env: {}, platform: 'linux', userDataDir, safeStorage,
      readBridgeFile: () => ({ ok: true, record: pairing.parseBridgeFile(JSON.stringify(record)) }),
      pollMs: 20, pollWindowMs: 5000, username: 'alex'
    });
    await new Promise((r) => setTimeout(r, 40));
    const status = await controller.status();
    assert.strictEqual(status.view, 'pairing');
    assert.ok(status.pendingPair.service, 'polling resumed on its own and found the service');
    controller.dispose();
  });

  it('clears an already-expired persisted pending pair at construction', async () => {
    const userDataDir = tmp();
    const safeStorage = fakeSafeStorage();
    const state = openDesktopState(userDataDir, safeStorage, { storeFactory });
    state.setPendingPair({
      deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', request: 'klpair1.x.y.z',
      createdAt: new Date(Date.now() - 60000).toISOString()
    });
    const app = fakeApp();
    const window = { isDestroyed: () => false, webContents: { send: () => {} } };
    const controller = createDesktopController({
      state, mode: 'standalone', app, getWindow: () => window, env: {}, platform: 'linux', userDataDir, safeStorage,
      readBridgeFile: () => ({ ok: false }), pollMs: 20, pollWindowMs: 1000, username: 'alex'
    });
    assert.strictEqual(state.pendingPair, null, 'cleared before anything else ran');
    const status = await controller.status();
    assert.strictEqual(status.view, 'unpaired');
    controller.dispose();
  });

  // --- Fix round 1 minors ------------------------------------------------

  it("detach refuses a truthy confirmed value that isn't exactly true", async () => {
    const { controller, state } = controllerFor({ env: { KL_TEST_MODE: '1' }, readBridgeFile: () => ({ ok: false }) });
    state.setPairing(pairedRecord());
    await controller.attach();
    assert.deepStrictEqual(await controller.detach({ confirmed: 'yes' }), { ok: false, code: 'CONFIRM_REQUIRED', error: DETACH_WARNING });
    assert.strictEqual(state.mode, 'attached');
    controller.dispose();
  });

  it('unpair clears pairing, pending pair and mode, and returns the unpair command', async () => {
    const { controller, state } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    state.setPairing(pairedRecord());
    const out = await controller.unpair();
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.command, 'sudo king-louie-service desktop unpair kld-abcdefghijklmnop');
    assert.strictEqual(state.pairing, null);
    assert.strictEqual(state.mode, 'standalone');
    controller.dispose();
  });

  // --- Fix round 2 (Task 16 re-review): the unpair follow-up command must
  // survive both a repaint (status() read after the fact) and a relaunch
  // (a fresh controller built over the same persisted state) — notify()
  // (or, in attached mode, the relaunch itself) can beat the original
  // reply back to the renderer, so the reply alone is not enough.

  it("unpair's command survives in status() after the reply, and in a new controller over the same state", async () => {
    const { controller, state, userDataDir } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    state.setPairing(pairedRecord());
    const out = await controller.unpair();
    assert.strictEqual(out.command, 'sudo king-louie-service desktop unpair kld-abcdefghijklmnop');

    const afterStatus = await controller.status();
    assert.strictEqual(afterStatus.pendingServiceCommand.command, out.command);
    controller.dispose();

    // A fresh controller over the same userDataDir stands in for a relaunch:
    // the command must have been persisted, not just returned.
    const rebuiltState = openDesktopState(userDataDir, fakeSafeStorage(), { storeFactory });
    const rebuilt = createDesktopController({
      state: rebuiltState, mode: 'standalone', app: fakeApp(), getWindow: () => null, env: {}, platform: 'linux',
      userDataDir, safeStorage: fakeSafeStorage(), stdout: { write: () => {} }, argv: ['electron', '.'],
      readBridgeFile: () => ({ ok: false }), pollMs: 20, username: 'alex'
    });
    const rebuiltStatus = await rebuilt.status();
    assert.strictEqual(rebuiltStatus.pendingServiceCommand.command, out.command);
    rebuilt.dispose();
  });

  it('dismissServiceCommand clears the command and notifies', async () => {
    const { controller, state, sentToWindow } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    state.setPairing(pairedRecord());
    await controller.unpair();
    assert.ok(state.pendingServiceCommand);
    sentToWindow.length = 0;
    const out = await controller.dismissServiceCommand();
    assert.strictEqual(out.pendingServiceCommand, null);
    assert.strictEqual(state.pendingServiceCommand, null);
    assert.ok(sentToWindow.some(([ch]) => ch === 'desktop:statusChanged'));
    controller.dispose();
  });

  it('a new pairing (pairStart) clears any leftover pendingServiceCommand', async () => {
    const { controller, state } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    state.setPairing(pairedRecord());
    await controller.unpair();
    assert.ok(state.pendingServiceCommand);
    await controller.pairStart();
    assert.strictEqual(state.pendingServiceCommand, null);
    controller.dispose();
  });

  it('unpair closes an open (temporary) import session', async () => {
    const client = fakeImportClient({ plan: { planId: 'p1', items: [], counts: {} } });
    const { controller, state } = controllerFor({ readBridgeFile: () => ({ ok: false }), clientFactory: () => client });
    state.setPairing(pairedRecord());
    const planned = await controller.importPlan();
    assert.strictEqual(planned.ok, true);
    assert.strictEqual(client.connected, true);
    await controller.unpair();
    assert.strictEqual(client.connected, false, 'the temporary import client was closed');
  });

  it("setClient and dispose detach the previous client's 'state' listener", () => {
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    const clientA = new EventEmitter();
    const clientB = new EventEmitter();
    controller.setClient(clientA);
    assert.strictEqual(clientA.listenerCount('state'), 1);
    controller.setClient(clientB);
    assert.strictEqual(clientA.listenerCount('state'), 0, 'the old client listener was removed');
    assert.strictEqual(clientB.listenerCount('state'), 1);
    controller.dispose();
    assert.strictEqual(clientB.listenerCount('state'), 0, 'dispose removes the current client listener too');
  });

  it('setPendingPair refuses a raw privateKey field or a missing privateKeySealed, like setPairing', () => {
    const { state } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    assert.throws(() => state.setPendingPair({ deviceId: 'kld-x', publicKey: 'x', privateKey: 'RAW', request: 'klpair1.x.y.z' }));
    assert.throws(() => state.setPendingPair({ deviceId: 'kld-x', publicKey: 'x', request: 'klpair1.x.y.z' }));
    assert.strictEqual(state.pendingPair, null);
    state.setPendingPair(null); // still the way pairCancel/pairConfirm/unpair clear it
    assert.strictEqual(state.pendingPair, null);
  });

  // --- Fix round 1: importPlan / importApply, success and failure -------

  it('importPlan succeeds against the paired service', async () => {
    const client = fakeImportClient({ plan: { planId: 'p1', items: [{ category: 'chat', key: 'c1', action: 'new' }], counts: { new: 1 } } });
    const { controller, state } = controllerFor({ readBridgeFile: () => ({ ok: false }), clientFactory: () => client });
    state.setPairing(pairedRecord());
    const out = await controller.importPlan();
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.plan.planId, 'p1');
    controller.dispose();
  });

  it('importPlan fails when there is no pairing yet', async () => {
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    const out = await controller.importPlan();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'NOT_PAIRED');
    controller.dispose();
  });

  it('importApply succeeds, records lastImport, reports progress and closes the session', async () => {
    const client = fakeImportClient({
      plan: { planId: 'p1', items: [{ category: 'chat', key: 'c1', action: 'new' }], counts: { new: 1 } },
      finish: { planId: 'p1', counts: { new: 1, failed: 0 }, failures: [], attention: [], secretsMissing: [], cronDisabled: 0, notes: [] }
    });
    const { controller, state, sentToWindow } = controllerFor({ readBridgeFile: () => ({ ok: false }), clientFactory: () => client });
    state.setPairing(pairedRecord());
    const planned = await controller.importPlan();
    assert.strictEqual(planned.ok, true);
    const applied = await controller.importApply();
    assert.strictEqual(applied.ok, true, JSON.stringify(applied));
    assert.deepStrictEqual(state.lastImport.counts, { new: 1, failed: 0 });
    assert.ok(sentToWindow.some(([ch]) => ch === 'desktop:importProgress'));
    assert.strictEqual(client.connected, false, 'the temporary import client was closed after apply');
    controller.dispose();
  });

  it('importApply fails with PLAN_EXPIRED when no plan was made', async () => {
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    const out = await controller.importApply();
    assert.deepStrictEqual(out, { ok: false, code: 'PLAN_EXPIRED', error: 'The import plan expired; plan the import again.' });
    controller.dispose();
  });

  it('importApply fails and still closes the session when the service errors', async () => {
    const client = fakeImportClient({
      plan: { planId: 'p1', items: [], counts: {} },
      failFinish: true
    });
    const { controller, state, sentToWindow } = controllerFor({ readBridgeFile: () => ({ ok: false }), clientFactory: () => client });
    state.setPairing(pairedRecord());
    const planned = await controller.importPlan();
    assert.strictEqual(planned.ok, true);
    const applied = await controller.importApply();
    assert.strictEqual(applied.ok, false);
    assert.strictEqual(applied.code, 'IMPORT_FAILED');
    assert.strictEqual(client.connected, false, 'the session is closed even though apply failed');
    assert.ok(sentToWindow.some(([ch]) => ch === 'desktop:importProgress'), 'progress notify still ran in the finally');
    controller.dispose();
  });
});

// Final review I2: the bridge-file trust read is async (a PowerShell child
// process on Windows), so the pairing poll and confirm must await it and
// cope with state changing while it runs.
describe('desktop controller with an async bridge-file reader', () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const okRecord = () => ({ ok: true, record: pairing.parseBridgeFile(JSON.stringify(pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: 18796 }))) });

  it('pairStart answers with what the first (async) read found', async () => {
    const { controller } = controllerFor({
      readBridgeFile: () => new Promise((resolve) => setTimeout(() => resolve(okRecord()), 30)),
      pollMs: 60000
    });
    const started = await controller.pairStart();
    assert.strictEqual(started.pendingPair.service.fingerprint, keys.fingerprintGroups(identity.nodeId));
    controller.dispose();
  });

  it('a cancel while a poll read is in flight discards that read and stops polling', async () => {
    let reads = 0;
    const second = deferred();
    const { controller, sentToWindow } = controllerFor({
      readBridgeFile: () => {
        reads += 1;
        return reads === 2 ? second.promise : { ok: false, code: 'BRIDGE_FILE_MISSING' };
      },
      pollMs: 10
    });
    await controller.pairStart();
    while (reads < 2) await new Promise((r) => setTimeout(r, 5));
    await controller.pairCancel();
    const notifiesBefore = sentToWindow.length;
    const readsBefore = reads;
    second.resolve(okRecord());
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(sentToWindow.length, notifiesBefore, 'the stale read changed nothing');
    assert.strictEqual(reads, readsBefore, 'no further polling after the cancel');
    assert.strictEqual((await controller.status()).view, 'unpaired');
    controller.dispose();
  });

  it("a cancel while pairConfirm's fresh read is in flight wins", async () => {
    let hold = null;
    const { controller, state } = controllerFor({
      readBridgeFile: () => (hold ? hold.promise : okRecord()),
      pollMs: 60000
    });
    await controller.pairStart();
    hold = deferred();
    const confirming = controller.pairConfirm({ nodeId: identity.nodeId });
    const held = hold;
    hold = null;
    await controller.pairCancel();
    held.resolve(okRecord());
    assert.deepStrictEqual(await confirming, { ok: false, code: 'NOT_PAIRING', error: 'Start pairing first.' });
    assert.strictEqual(state.pairing, null);
    controller.dispose();
  });

  it('a reader that rejects is reported as an error, not thrown', async () => {
    const { controller } = controllerFor({
      readBridgeFile: async () => { throw Object.assign(new Error('powershell failed'), { code: 'EFAIL' }); },
      pollMs: 60000
    });
    const status = await controller.status();
    assert.deepStrictEqual(status.bridge, { ok: false, code: 'EFAIL', error: 'powershell failed' });
    const started = await controller.pairStart();
    assert.deepStrictEqual(started.pendingPair.error, { code: 'EFAIL', error: 'powershell failed' });
    controller.dispose();
  });
});

// --- Desktop attached to the personal node (spec 2026-10-28 §6.2, §6.4, §11):
// one-click pairing, personal unpair, the node in status(). The runner is a
// fake; the bridge server and the handshake are real.

const PERSONAL_DATA_DIR = 'C:\\Users\\owner\\AppData\\Local\\KingLouie\\node\\data';
const OWNER_SID = 'S-1-5-21-1000-2000-3000-1001';

function fakeRunner({
  personal = true, running = false, task = 'registered', failure = null,
  cli = () => ({ code: 0, stdout: '', stderr: '', json: { ok: true } }),
  trust = () => ({ ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found.' }),
  restart = () => ({ ok: true, ranAt: 2000 }), unpairCode = 0
} = {}) {
  const calls = [];
  const node = personal
    ? { personal: true, name: 'laptop-01', dataDir: PERSONAL_DATA_DIR, configDir: 'C:\\Users\\owner\\AppData\\Local\\KingLouie\\node\\config', me: OWNER_SID }
    : { personal: false, dataDir: 'C:\\ProgramData\\KingLouie\\data', configDir: 'C:\\ProgramData\\KingLouie\\config', reason: 'not-personal' };
  const runner = {
    calls,
    running,
    async inspectLocal(a = {}) { calls.push(['inspectLocal', a]); return { trust: trust(), node }; },
    async detectPersonalNode(a = {}) { calls.push(['detectPersonalNode', a]); return node; },
    async queryTask(a) { calls.push(['queryTask', a]); return { state: task }; },
    async nodeRunning(a) { calls.push(['nodeRunning', a]); return runner.running ? { running: true, pid: 4242 } : { running: false, pid: null }; },
    async runTask() { calls.push(['runTask']); return { ok: true, ranAt: 1000 }; },
    async restartNode(a) { calls.push(['restartNode', a]); return restart(); },
    async runCli(args, opts) {
      calls.push(['runCli', args, opts]);
      if (args[0] === 'desktop' && args[1] === 'unpair') return { code: unpairCode, stdout: '', stderr: unpairCode ? 'could not remove the device\n' : '', json: null };
      return cli(args);
    },
    async startFailureSince(since, a) { calls.push(['startFailureSince', since, a]); return failure; }
  };
  return runner;
}

// A clock that moves only when the controller sleeps.
function fakeTimers() {
  const t = { now: 0, sleeps: [] };
  t.extra = {
    clock: () => t.now,
    setTimer: (fn, ms) => { t.sleeps.push(ms); t.now += ms; return setImmediate(fn); },
    clearTimer: (h) => clearImmediate(h)
  };
  return t;
}

// What the real `desktop pair --yes --json` does for the test: it writes the
// device into the service's devices file and prints its JSON line.
function pairingCli(svc, { bridgeTurnedOn = true, nodeId = identity.nodeId } = {}) {
  return (args) => {
    const decoded = pairing.decodePairRequest(args[2]);
    pairing.writeFileAtomic(path.join(svc.configDir, pairing.DEVICES_FILE), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), {
      deviceId: decoded.deviceId, publicKey: decoded.publicKey, label: decoded.label, pairedAt: '2026-10-28T10:00:00Z'
    })), 0o644);
    return { code: 0, stdout: '', stderr: '', json: { ok: true, nodeId, port: svc.port, bridgeTurnedOn, hosting: 'personal' } };
  };
}
const recordFor = (port) => pairing.parseBridgeFile(JSON.stringify(pairing.bridgeFileRecord({ publicKey: identity.publicKey, port })));
const trustedRecord = (port) => () => ({ ok: true, hosting: 'personal', record: recordFor(port) });

// A port where something accepts and hangs up at once: a node whose bridge
// is not answering, without the slow refused connect Windows makes.
async function deadPort() {
  const net = require('net');
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push({ stop: () => new Promise((r) => server.close(r)) });
  return server.address().port;
}

describe('desktop controller: a personal node', () => {
  it('the unpaired view says a personal node lives here, from one inspectLocal call', async () => {
    const runner = fakeRunner({ task: 'missing' });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const status = await controller.status();
    assert.strictEqual(status.view, 'unpaired');
    assert.deepStrictEqual(status.bridge, { ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found.' });
    assert.strictEqual(status.node.hosting, 'personal');
    assert.strictEqual(status.node.name, 'laptop-01');
    assert.strictEqual(status.node.dataDir, PERSONAL_DATA_DIR);
    assert.strictEqual(status.node.task, 'missing');
    assert.strictEqual(status.node.running, false);
    assert.strictEqual(runner.calls.filter(([c]) => c === 'inspectLocal').length, 1);
    controller.dispose();
  });

  it('a fleet machine has no node in the unpaired status', async () => {
    const runner = fakeRunner({ personal: false });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const status = await controller.status();
    assert.strictEqual(status.node, null);
    controller.dispose();
  });

  it('pairs in one click: CLI JSON, trusted read, /Run, handshake, paired with hosting stored', async () => {
    const svc = await startService();
    const runner = fakeRunner({ cli: pairingCli(svc), trust: trustedRecord(svc.port) });
    const timers = fakeTimers();
    const { controller, state, sentToWindow } = controllerFor({ extra: { nodeRunner: runner, ...timers.extra } });
    const out = await controller.pairStart();
    assert.strictEqual(out.view, 'paired', JSON.stringify(out));
    const cli = runner.calls.find(([c]) => c === 'runCli');
    assert.deepStrictEqual(cli[1].slice(0, 2), ['desktop', 'pair']);
    assert.deepStrictEqual(cli[1].slice(3), ['--yes', '--json', '--data-dir', PERSONAL_DATA_DIR]);
    assert.strictEqual(cli[2].timeoutMs, 120000);
    assert.strictEqual(runner.calls.filter(([c]) => c === 'runTask').length, 1);
    assert.strictEqual(state.pairing.service.nodeId, identity.nodeId);
    assert.strictEqual(state.pairing.service.hosting, 'personal');
    assert.strictEqual(state.pairing.service.dataDir, PERSONAL_DATA_DIR);
    assert.strictEqual(state.pendingPair, null);
    assert.strictEqual(out.node.hosting, 'personal');
    assert.strictEqual(out.pairing.service.hosting, 'personal');
    assert.ok(sentToWindow.filter(([ch]) => ch === 'desktop:statusChanged').length >= 3, 'each stage notified');
    controller.dispose();
  });

  it('shows each stage in the pending pair while the flow runs', async () => {
    const svc = await startService();
    const runner = fakeRunner({ cli: pairingCli(svc), trust: trustedRecord(svc.port) });
    const timers = fakeTimers();
    const stages = [];
    const { controller } = controllerFor({ extra: { nodeRunner: runner, ...timers.extra } });
    controller.on('changed', () => {
      controller.status().then((s) => { if (s.pendingPair) stages.push(s.pendingPair.stage); });
    });
    await controller.pairStart();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(stages.includes('command'), stages.join());
    assert.ok(stages.includes('starting'), stages.join());
    controller.dispose();
  });

  it('a CLI refusal ends with its code and message, the pending pair kept', async () => {
    const runner = fakeRunner({ cli: () => ({ code: 1, stdout: '', stderr: '', json: { ok: false, code: 'PERSONAL_NOT_OWNER', message: 'the data dir is owned by another account' } }) });
    const { controller, state } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.pairStart();
    assert.strictEqual(out.view, 'pairing');
    assert.strictEqual(out.pendingPair.personal, true);
    assert.deepStrictEqual(out.pendingPair.error, { code: 'PERSONAL_NOT_OWNER', message: 'the data dir is owned by another account' });
    assert.ok(state.pendingPair, 'the pending pair is kept for Try again');
    assert.ok(!runner.calls.some(([c]) => c === 'runTask'));
    controller.dispose();
  });

  it('a CLI with no JSON line is PAIR_COMMAND_FAILED with its first stderr line', async () => {
    const runner = fakeRunner({ cli: () => ({ code: 3, stdout: '', stderr: '\nboom happened\nmore\n', json: null }) });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.pairStart();
    assert.deepStrictEqual(out.pendingPair.error, { code: 'PAIR_COMMAND_FAILED', message: 'Pairing did not finish: boom happened' });
    controller.dispose();
  });

  it('a bridge file naming another node than the CLI is PAIR_SERVICE_CHANGED', async () => {
    const svc = await startService();
    const runner = fakeRunner({ cli: pairingCli(svc, { nodeId: 'kln-somebody-else' }), trust: trustedRecord(svc.port) });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.pairStart();
    assert.strictEqual(out.pendingPair.error.code, 'PAIR_SERVICE_CHANGED');
    assert.ok(!runner.calls.some(([c]) => c === 'runTask'));
    controller.dispose();
  });

  it('a bridge file trusted under the fleet rule is PAIR_SERVICE_CHANGED', async () => {
    const svc = await startService();
    const runner = fakeRunner({ cli: pairingCli(svc), trust: () => ({ ...trustedRecord(svc.port)(), hosting: 'service' }) });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.pairStart();
    assert.strictEqual(out.pendingPair.error.code, 'PAIR_SERVICE_CHANGED');
    controller.dispose();
  });

  it("an untrusted bridge file after the command carries the rule's message", async () => {
    const svc = await startService();
    const runner = fakeRunner({ cli: pairingCli(svc), trust: () => ({ ok: false, code: 'BRIDGE_FILE_UNTRUSTED', error: 'Refusing to trust F: a link.' }) });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.pairStart();
    assert.deepStrictEqual(out.pendingPair.error, { code: 'BRIDGE_FILE_UNTRUSTED', message: 'Refusing to trust F: a link.' });
    controller.dispose();
  });

  it('a node running with the bridge just turned on asks first and restarts nothing until pairRestartConfirm', async () => {
    const svc = await startService();
    const runner = fakeRunner({ running: true, cli: pairingCli(svc, { bridgeTurnedOn: true }), trust: trustedRecord(svc.port) });
    const timers = fakeTimers();
    const { controller, state } = controllerFor({ extra: { nodeRunner: runner, ...timers.extra } });
    const out = await controller.pairStart();
    assert.strictEqual(out.pendingPair.stage, 'restart-needed');
    assert.strictEqual(out.pendingPair.error, null);
    assert.strictEqual(out.node.running, true);
    assert.strictEqual(out.node.pid, 4242);
    assert.ok(!runner.calls.some(([c]) => c === 'restartNode' || c === 'runTask'), 'nothing restarted yet');
    assert.strictEqual((await controller.pairRestartConfirm({ confirmed: 'yes' })).code, 'CONFIRM_REQUIRED');
    assert.ok(!runner.calls.some(([c]) => c === 'restartNode'));
    const done = await controller.pairRestartConfirm({ confirmed: true });
    assert.strictEqual(done.view, 'paired', JSON.stringify(done));
    assert.deepStrictEqual(runner.calls.filter(([c]) => c === 'restartNode').map(([, a]) => a), [{ dataDir: PERSONAL_DATA_DIR }]);
    assert.ok(!runner.calls.some(([c]) => c === 'runTask'), 'the restart runs the task itself');
    assert.strictEqual(state.pairing.service.hosting, 'personal');
    controller.dispose();
  });

  it('pairRestartConfirm refuses when no restart is waiting', async () => {
    const { controller } = controllerFor({ extra: { nodeRunner: fakeRunner() } });
    assert.strictEqual((await controller.pairRestartConfirm({ confirmed: true })).code, 'NOT_PAIRING');
    controller.dispose();
  });

  it('a node running with the bridge already on is neither run nor restarted', async () => {
    const svc = await startService();
    const runner = fakeRunner({ running: true, cli: pairingCli(svc, { bridgeTurnedOn: false }), trust: trustedRecord(svc.port) });
    const timers = fakeTimers();
    const { controller } = controllerFor({ extra: { nodeRunner: runner, ...timers.extra } });
    const out = await controller.pairStart();
    assert.strictEqual(out.view, 'paired', JSON.stringify(out));
    assert.ok(!runner.calls.some(([c]) => c === 'restartNode' || c === 'runTask'));
    controller.dispose();
  });

  it("no node and a task that is not this account's: nothing is run", async () => {
    const svc = await startService();
    const runner = fakeRunner({ task: 'other-account', cli: pairingCli(svc), trust: trustedRecord(svc.port) });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.pairStart();
    assert.strictEqual(out.pendingPair.error.code, 'NODE_TASK_OTHER_ACCOUNT');
    assert.strictEqual(out.node.task, 'other-account');
    assert.ok(!runner.calls.some(([c]) => c === 'runTask'));
    controller.dispose();
  });

  it('the wait gives up at 60 s with NODE_START_TIMEOUT, retrying every 3 s', async () => {
    const svc = await startService();
    const port = await deadPort();
    const runner = fakeRunner({ cli: pairingCli(svc), trust: trustedRecord(port) });
    const timers = fakeTimers();
    const { controller, state } = controllerFor({ extra: { nodeRunner: runner, ...timers.extra } });
    // A ref'd timer keeps the loop alive across the awaits (CLAUDE.md Testing).
    const keepAlive = setTimeout(() => {}, 60000);
    try {
      const out = await controller.pairStart();
      assert.strictEqual(out.pendingPair.error.code, 'NODE_START_TIMEOUT');
      assert.strictEqual(timers.now, 60000);
      assert.ok(timers.sleeps.every((ms) => ms === 3000), timers.sleeps.join());
      assert.ok(state.pendingPair, 'kept for Try again');
    } finally {
      clearTimeout(keepAlive);
      controller.dispose();
    }
  });

  it("a failure line in the node's log ends the wait early with NODE_START_FAILED", async () => {
    const svc = await startService();
    const port = await deadPort();
    const runner = fakeRunner({ cli: pairingCli(svc), trust: trustedRecord(port), failure: { at: 1500, line: 'service failed to start: the instance lock is held' } });
    const timers = fakeTimers();
    const { controller } = controllerFor({ extra: { nodeRunner: runner, ...timers.extra } });
    const out = await controller.pairStart();
    assert.deepStrictEqual(out.pendingPair.error, { code: 'NODE_START_FAILED', message: 'service failed to start: the instance lock is held' });
    assert.ok(timers.now < 60000);
    const since = runner.calls.find(([c]) => c === 'startFailureSince');
    assert.strictEqual(since[1], 1000, 'only lines after the /Run');
    controller.dispose();
  });

  it('a cancel during the CLI wins: nothing after it runs', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const runner = fakeRunner({ cli: async () => { await gate; return { code: 0, stdout: '', stderr: '', json: { ok: true, nodeId: 'x', port: 1, bridgeTurnedOn: false, hosting: 'personal' } }; } });
    const { controller, state } = controllerFor({ extra: { nodeRunner: runner } });
    const pending = controller.pairStart();
    await new Promise((r) => setTimeout(r, 10));
    await controller.pairCancel();
    release();
    await pending;
    assert.strictEqual(state.pendingPair, null);
    assert.ok(!runner.calls.some(([c, a]) => c === 'inspectLocal' && a && a.dataDir), 'no trusted read after the cancel');
    controller.dispose();
  });

  it('Unpair under personal runs desktop unpair itself and keeps no follow-up', async () => {
    const runner = fakeRunner();
    const { controller, state } = controllerFor({ extra: { nodeRunner: runner } });
    state.setPairing(pairedRecord({ service: { nodeId: identity.nodeId, publicKey: 'p', port: 18796, hosting: 'personal', dataDir: PERSONAL_DATA_DIR } }));
    const out = await controller.unpair();
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.command, null);
    assert.strictEqual(state.pendingServiceCommand, null);
    assert.strictEqual(state.pairing, null);
    const cli = runner.calls.find(([c]) => c === 'runCli');
    assert.deepStrictEqual(cli[1], ['desktop', 'unpair', 'kld-abcdefghijklmnop', '--data-dir', PERSONAL_DATA_DIR]);
    controller.dispose();
  });

  it('Unpair under personal keeps the follow-up command when desktop unpair fails', async () => {
    const runner = fakeRunner({ unpairCode: 1 });
    const { controller, state } = controllerFor({ extra: { nodeRunner: runner } });
    state.setPairing(pairedRecord({ service: { nodeId: identity.nodeId, publicKey: 'p', port: 18796, hosting: 'personal', dataDir: PERSONAL_DATA_DIR } }));
    const out = await controller.unpair();
    assert.strictEqual(out.command, `king-louie-service desktop unpair kld-abcdefghijklmnop --data-dir "${PERSONAL_DATA_DIR}"`);
    assert.strictEqual(state.pendingServiceCommand.command, out.command);
    controller.dispose();
  });

  it('a fleet pairing never touches the runner', async () => {
    const runner = fakeRunner();
    const { controller, state } = controllerFor({ readBridgeFile: () => ({ ok: false }), extra: { nodeRunner: runner } });
    state.setPairing(pairedRecord());
    const status = await controller.status();
    assert.strictEqual(status.view, 'paired');
    assert.strictEqual(status.node, null);
    const out = await controller.unpair();
    assert.strictEqual(out.command, 'sudo king-louie-service desktop unpair kld-abcdefghijklmnop');
    assert.deepStrictEqual(runner.calls, []);
    controller.dispose();
  });

  it("a fleet machine pairs with today's flow even with a runner", async () => {
    const runner = fakeRunner({ personal: false });
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false }), pollMs: 60000, extra: { nodeRunner: runner } });
    const out = await controller.pairStart();
    assert.strictEqual(out.view, 'pairing');
    assert.ok(out.pendingPair.command.includes('desktop pair'));
    assert.ok(!out.pendingPair.personal);
    assert.ok(!runner.calls.some(([c]) => c === 'runCli'));
    controller.dispose();
  });

  it('a personal pending pair left by a closed app comes back as a refusal to try again', async () => {
    const runner = fakeRunner();
    const first = controllerFor({ extra: { nodeRunner: runner } });
    first.state.setPendingPair({
      deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', request: 'klpair1.kld-abcdefghijklmnop.x',
      createdAt: new Date().toISOString(), personal: { dataDir: PERSONAL_DATA_DIR, name: 'laptop-01' }
    });
    first.controller.dispose();
    const second = createDesktopController({
      state: first.state, mode: 'standalone', app: fakeApp(), platform: 'linux', userDataDir: first.userDataDir,
      safeStorage: fakeSafeStorage(), stdout: { write() {} }, argv: ['electron', '.'], username: 'alex', nodeRunner: runner
    });
    const status = await second.status();
    assert.strictEqual(status.pendingPair.personal, true);
    assert.strictEqual(status.pendingPair.error.code, 'PAIR_COMMAND_FAILED');
    assert.ok(!runner.calls.some(([c]) => c === 'runCli'));
    second.dispose();
  });
});
