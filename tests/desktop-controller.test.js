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
  pollWindowMs, clientFactory
} = {}) {
  const userDataDir = tmp();
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory });
  const app = fakeApp();
  const sentToWindow = [];
  const out = [];
  const window = { isDestroyed: () => false, webContents: { send: (ch, p) => sentToWindow.push([ch, p]) } };
  const controller = createDesktopController({
    state, mode, app, getWindow: () => window, env, platform: 'linux', userDataDir, safeStorage,
    stdout: { write: (s) => out.push(s) }, argv: ['electron', '.'], readBridgeFile, pollMs: 20, username: 'alex',
    ...(pollWindowMs !== undefined ? { pollWindowMs } : {}),
    ...(clientFactory ? { clientFactory } : {})
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
