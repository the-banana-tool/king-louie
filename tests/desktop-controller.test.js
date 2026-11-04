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
const { createDesktopController, DETACH_WARNING, DETACH_WARNING_WINDOWS } = require('../src/ipc/desktop-controller');
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

  it('relaunch strips both flags', async () => {
    const argv = ['electron', '.', '--kl-standalone', '--kl-standalone-once', '--user-data-dir=x'];
    const { controller, state, app } = controllerFor({ readBridgeFile: () => ({ ok: false }), extra: { argv } });
    state.setMode('attached');
    await controller.detach({ confirmed: true });
    assert.deepStrictEqual(app.calls, [['relaunch', { args: ['.', '--user-data-dir=x'] }], ['exit', 0]]);
    app.calls.length = 0;
    await controller.standaloneOnce();
    assert.deepStrictEqual(app.calls, [['relaunch', { args: ['.', '--user-data-dir=x', '--kl-standalone-once'] }], ['exit', 0]], 'the one session asks for its own flag again');
    controller.dispose();
  });

  it('status().launch echoes what was passed', async () => {
    const launch = { host: 'attached', why: 'needs-node', degraded: false };
    const { controller } = controllerFor({ mode: 'attached', readBridgeFile: () => ({ ok: false }), extra: { launch } });
    assert.deepStrictEqual((await controller.status()).launch, launch);
    controller.dispose();
  });

  it('status().launch without one says what the mode says', async () => {
    const standalone = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    assert.deepStrictEqual((await standalone.controller.status()).launch, { host: 'standalone', why: 'dev', degraded: false });
    standalone.controller.dispose();
    const attached = controllerFor({ mode: 'attached', readBridgeFile: () => ({ ok: false }) });
    assert.deepStrictEqual((await attached.controller.status()).launch, { host: 'attached', why: 'attached', degraded: false });
    attached.controller.dispose();
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
  personal = true, fresh = false, running = false, task = 'registered', failure = null,
  cli = () => ({ code: 0, stdout: '', stderr: '', json: { ok: true } }),
  trust = () => ({ ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found.' }),
  stop = () => ({ ok: true }), unpairCode = 0
} = {}) {
  const calls = [];
  const node = fresh
    ? { personal: false, fresh: true, dataDir: PERSONAL_DATA_DIR, configDir: 'C:\\Users\\owner\\AppData\\Local\\KingLouie\\node\\config', me: OWNER_SID }
    : personal
    ? { personal: true, name: 'laptop-01', dataDir: PERSONAL_DATA_DIR, configDir: 'C:\\Users\\owner\\AppData\\Local\\KingLouie\\node\\config', me: OWNER_SID }
    : { personal: false, dataDir: 'C:\\ProgramData\\KingLouie\\data', configDir: 'C:\\ProgramData\\KingLouie\\config', reason: 'not-personal' };
  const runner = {
    calls,
    running,
    node,
    async inspectLocal(a = {}) { calls.push(['inspectLocal', a]); return { trust: trust(), node: runner.node }; },
    async detectPersonalNode(a = {}) { calls.push(['detectPersonalNode', a]); return runner.node; },
    task,
    async queryTask(a) { calls.push(['queryTask', a]); return { state: runner.task }; },
    async nodeRunning(a) { calls.push(['nodeRunning', a]); return runner.running ? { running: true, pid: 4242 } : { running: false, pid: null }; },
    async runTask() { calls.push(['runTask']); return { ok: true, ranAt: 1000 }; },
    async stopNode(a) {
      calls.push(['stopNode', a]);
      const r = stop();
      if (r.ok) runner.running = false;
      return r;
    },
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
    assert.ok(!runner.calls.some(([c]) => c === 'stopNode' || c === 'runTask'), 'nothing restarted yet');
    assert.strictEqual((await controller.pairRestartConfirm({ confirmed: 'yes' })).code, 'CONFIRM_REQUIRED');
    assert.ok(!runner.calls.some(([c]) => c === 'stopNode'));
    const before = runner.calls.length;
    const done = await controller.pairRestartConfirm({ confirmed: true });
    assert.strictEqual(done.view, 'paired', JSON.stringify(done));
    // §7.1, §12: the task is checked before anything is stopped, then stop, then /Run.
    const steps = runner.calls.slice(before).map(([c]) => c).filter((c) => ['queryTask', 'stopNode', 'runTask'].includes(c));
    assert.deepStrictEqual(steps, ['queryTask', 'stopNode', 'runTask']);
    assert.deepStrictEqual(runner.calls.filter(([c]) => c === 'stopNode').map(([, a]) => a), [{ dataDir: PERSONAL_DATA_DIR }]);
    assert.strictEqual(state.pairing.service.hosting, 'personal');
    controller.dispose();
  });

  for (const [task, code] of [['other-account', 'NODE_TASK_OTHER_ACCOUNT'], ['disabled', 'NODE_TASK_DISABLED'], ['missing', 'NODE_TASK_MISSING']]) {
    it(`"Restart and pair" with a task that is ${task} stops nothing and runs nothing (${code})`, async () => {
      const svc = await startService();
      const runner = fakeRunner({ running: true, task, cli: pairingCli(svc, { bridgeTurnedOn: true }), trust: trustedRecord(svc.port) });
      const { controller } = controllerFor({ extra: { nodeRunner: runner, ...fakeTimers().extra } });
      await controller.pairStart();
      const out = await controller.pairRestartConfirm({ confirmed: true });
      assert.strictEqual(out.pendingPair.error.code, code);
      assert.ok(!runner.calls.some(([c]) => c === 'stopNode' || c === 'runTask'));
      assert.strictEqual(out.node.starting, false);
      controller.dispose();
    });
  }

  it("a refusal's text from the trust read reaches the status through shown", async () => {
    const svc = await startService();
    const runner = fakeRunner({ cli: pairingCli(svc), trust: () => ({ ok: false, code: 'BRIDGE_FILE_UNTRUSTED', error: 'Refusing to trust C:\\x\\desktop-bridge.json: a link.\u202e\nsecond line' }) });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.pairStart();
    assert.strictEqual(out.pendingPair.error.code, 'BRIDGE_FILE_UNTRUSTED');
    assert.strictEqual(out.pendingPair.error.message, 'Refusing to trust C:\\x\\desktop-bridge.json: a link. second line [hidden or control characters removed]');
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
    assert.ok(!runner.calls.some(([c]) => c === 'stopNode' || c === 'runTask'));
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

// --- The attached start (spec 2026-10-28 §7.2, §7.3, §8, C-11, C-13): the
// node is run once per launch, the client's own loop is the only connection
// loop (retryNow every 3 s), Start/Restart only on a press, Install from the pane.

class FakeAttachedClient extends EventEmitter {
  constructor({ liveOnRetry = null, fatalOnRetry = null } = {}) {
    super();
    this.connected = false;
    this.service = null;
    this.retries = 0;
    this.connects = 0;
    this.liveOnRetry = liveOnRetry;
    this.fatalOnRetry = fatalOnRetry;
  }
  connect() { this.connects += 1; return Promise.resolve(null); }
  retryNow() {
    this.retries += 1;
    if (this.liveOnRetry === this.retries) this.goLive();
    else if (this.fatalOnRetry === this.retries) this.fail('DEVICE_UNPAIRED');
    return Promise.resolve(null);
  }
  close() {}
  async call() { return { available: false }; }
  goLive() {
    this.connected = true;
    this.service = { version: '26.10.0', account: 'owner', profile: 'agent', providersConfigured: true };
    this.emit('state', { status: 'connected', code: null, error: null, service: this.service, nextRetryAt: null });
  }
  drop() {
    this.connected = false;
    this.emit('state', { status: 'disconnected', code: 'SERVICE_UNREACHABLE', error: 'not reachable', service: this.service, nextRetryAt: null });
  }
  fail(code) {
    this.connected = false;
    this.emit('state', { status: 'failed', code, error: `refused: ${code}`, service: null, nextRetryAt: null });
  }
}

const personalPairing = () => pairedRecord({ service: { nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex'), port: 18796, hosting: 'personal', dataDir: PERSONAL_DATA_DIR, name: 'laptop-01' } });

function attachedController({ runner, client = new FakeAttachedClient(), pairingRecord = personalPairing(), timers = fakeTimers(), extra = {} } = {}) {
  const made = controllerFor({ mode: 'attached', extra: { nodeRunner: runner, ...timers.extra, ...extra } });
  made.state.setPairing(pairingRecord);
  made.controller.setClient(client);
  return { ...made, client, timers };
}

// Timers that never fire by themselves: what is pending and what was cleared.
function heldTimers() {
  const pending = new Set();
  const cleared = [];
  return {
    pending, cleared, now: 0, sleeps: [],
    extra: {
      clock: () => 0,
      setTimer: (fn, ms) => { const h = { fn, ms }; pending.add(h); return h; },
      clearTimer: (h) => { cleared.push(h); pending.delete(h); }
    }
  };
}

describe('desktop controller: the attached start of a personal node', () => {
  it('no node running: the task is run once, the view is attached-starting, and the client connects', async () => {
    const runner = fakeRunner();
    const client = new FakeAttachedClient({ liveOnRetry: 3 });
    const { controller } = attachedController({ runner, client });
    const views = [];
    controller.on('changed', () => { controller.status().then((s) => views.push(s.view)); });
    await controller.startAttached();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(runner.calls.filter(([c]) => c === 'runTask').length, 1);
    assert.deepStrictEqual(runner.calls.find(([c]) => c === 'detectPersonalNode')[1], { dataDir: PERSONAL_DATA_DIR });
    assert.strictEqual(runner.calls.find(([c]) => c === 'queryTask')[1].me, OWNER_SID);
    assert.ok(views.includes('attached-starting'), views.join());
    assert.strictEqual(client.retries, 3, 'retryNow is the one connection loop');
    assert.strictEqual(client.connects, 0, 'no second connect beside retryNow');
    const status = await controller.status();
    assert.strictEqual(status.view, 'attached-connected');
    assert.strictEqual(status.node.starting, false);
    assert.strictEqual(status.node.startError, null);
    assert.strictEqual(status.node.running, true);
    controller.dispose();
  });

  it('a read that finds the task registered clears a start refused for its task, and only that', async () => {
    const runner = fakeRunner({ task: 'missing' });
    const client = new FakeAttachedClient();
    const { controller } = attachedController({ runner, client, extra: { nodeRefreshMs: 0 } });
    await controller.startAttached();
    assert.strictEqual((await controller.status()).node.startError.code, 'NODE_TASK_MISSING');
    await controller.refreshIdle();
    // Still missing: the refusal agrees.
    assert.strictEqual((await controller.status()).node.startError.code, 'NODE_TASK_MISSING');
    await controller.refreshIdle();
    runner.task = 'registered';
    runner.running = true;
    await controller.status();
    await controller.refreshIdle();
    assert.strictEqual((await controller.status()).node.startError, null);
    controller.dispose();
  });

  it('a read of the task leaves a start error that is not about the task', async () => {
    const runner = fakeRunner({ failure: { line: 'service failed to start: the instance lock is held' } });
    const { controller } = attachedController({ runner, extra: { nodeRefreshMs: 0 } });
    await controller.startAttached();
    await controller.status();
    await controller.refreshIdle();
    assert.strictEqual((await controller.status()).node.startError.code, 'NODE_START_FAILED');
    controller.dispose();
  });

  it('a node already running is never run again; the wait still connects', async () => {
    const runner = fakeRunner({ running: true });
    const client = new FakeAttachedClient({ liveOnRetry: 1 });
    const { controller } = attachedController({ runner, client });
    await controller.startAttached();
    assert.ok(!runner.calls.some(([c]) => c === 'runTask' || c === 'queryTask'));
    assert.strictEqual((await controller.status()).view, 'attached-connected');
    controller.dispose();
  });

  it('a node already running whose bridge never answers leaves the Restart row, not a start error', async () => {
    const runner = fakeRunner({ running: true });
    const { controller } = attachedController({ runner });
    const keepAlive = setTimeout(() => {}, 60000);
    try {
      await controller.startAttached();
      const status = await controller.status();
      assert.strictEqual(status.view, 'attached-disconnected');
      assert.strictEqual(status.node.running, true);
      assert.strictEqual(status.node.pid, 4242);
      assert.strictEqual(status.node.startError, null);
    } finally {
      clearTimeout(keepAlive);
      controller.dispose();
    }
  });

  for (const [task, code] of [['missing', 'NODE_TASK_MISSING'], ['disabled', 'NODE_TASK_DISABLED'], ['other-account', 'NODE_TASK_OTHER_ACCOUNT']]) {
    it(`a task that is ${task}: nothing is run, ${code} in the status, the client connects as now`, async () => {
      const runner = fakeRunner({ task });
      const { controller, client } = attachedController({ runner });
      await controller.startAttached();
      assert.ok(!runner.calls.some(([c]) => c === 'runTask'));
      const status = await controller.status();
      assert.strictEqual(status.view, 'attached-disconnected');
      assert.strictEqual(status.node.task, task);
      assert.strictEqual(status.node.startError.code, code);
      assert.strictEqual(client.connects + client.retries, 1);
      controller.dispose();
    });
  }

  it('60 s with nothing: NODE_START_TIMEOUT and attached-disconnected, retrying every 3 s', async () => {
    const runner = fakeRunner();
    const { controller, client, timers } = attachedController({ runner });
    const keepAlive = setTimeout(() => {}, 60000);
    try {
      await controller.startAttached();
      assert.strictEqual(timers.now, 60000);
      assert.ok(timers.sleeps.every((ms) => ms === 3000), timers.sleeps.join());
      assert.strictEqual(client.retries, 21, "every 3 s from 0 s to 60 s");
      const status = await controller.status();
      assert.strictEqual(status.view, 'attached-disconnected');
      assert.deepStrictEqual(status.node.startError, { code: 'NODE_START_TIMEOUT', message: 'King Louie Node did not answer within 60 seconds.' });
      assert.strictEqual(status.node.starting, false);
    } finally {
      clearTimeout(keepAlive);
      controller.dispose();
    }
  });

  it("a failure line in the node's log after the /Run ends the wait with NODE_START_FAILED", async () => {
    const runner = fakeRunner({ failure: { at: 1500, line: 'service failed to start: the instance lock is held' } });
    const { controller, timers } = attachedController({ runner });
    await controller.startAttached();
    assert.ok(timers.now < 60000);
    assert.strictEqual(runner.calls.find(([c]) => c === 'startFailureSince')[1], 1000);
    const status = await controller.status();
    assert.deepStrictEqual(status.node.startError, { code: 'NODE_START_FAILED', message: 'service failed to start: the instance lock is held' });
    assert.strictEqual(status.view, 'attached-disconnected');
    controller.dispose();
  });

  it('a /Run that fails is NODE_TASK_RUN_FAILED, and the client still connects as now', async () => {
    const runner = fakeRunner();
    runner.runTask = async () => { runner.calls.push(['runTask']); return { ok: false, code: 'NODE_TASK_RUN_FAILED', message: 'ERROR: Access is denied.' }; };
    const { controller, client } = attachedController({ runner });
    await controller.startAttached();
    const status = await controller.status();
    assert.deepStrictEqual(status.node.startError, { code: 'NODE_TASK_RUN_FAILED', message: 'ERROR: Access is denied.' });
    assert.strictEqual(status.view, 'attached-disconnected');
    assert.strictEqual(client.connects + client.retries, 1);
    controller.dispose();
  });

  it('a fatal bridge code ends the wait early and is shown as now', async () => {
    const runner = fakeRunner();
    const client = new FakeAttachedClient({ fatalOnRetry: 2 });
    const { controller, timers } = attachedController({ runner, client });
    await controller.startAttached();
    assert.ok(timers.now < 60000);
    const status = await controller.status();
    assert.strictEqual(status.view, 'attached-disconnected');
    assert.strictEqual(status.connection.code, 'DEVICE_UNPAIRED');
    assert.strictEqual(status.node.startError, null);
    controller.dispose();
  });

  it("a connect mid-sleep clears the sleep's timer and ends the wait at once", async () => {
    const runner = fakeRunner();
    const timers = heldTimers();
    const { controller, client } = attachedController({ runner, timers });
    const keepAlive = setTimeout(() => {}, 60000);
    try {
      const done = controller.startAttached();
      while (timers.pending.size === 0) await new Promise((r) => setImmediate(r));
      assert.strictEqual((await controller.status()).view, 'attached-starting');
      client.goLive();
      await done;
      assert.strictEqual(timers.cleared.length, 1, 'the sleep timer was cleared');
      assert.strictEqual(timers.pending.size, 0);
      assert.strictEqual((await controller.status()).view, 'attached-connected');
    } finally {
      clearTimeout(keepAlive);
      controller.dispose();
    }
  });

  it('dispose during the wait clears the timer and ends it', async () => {
    const runner = fakeRunner();
    const timers = heldTimers();
    const { controller } = attachedController({ runner, timers });
    const keepAlive = setTimeout(() => {}, 60000);
    try {
      const done = controller.startAttached();
      while (timers.pending.size === 0) await new Promise((r) => setImmediate(r));
      controller.dispose();
      await done;
      assert.strictEqual(timers.pending.size, 0);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('a drop after the desktop connected never runs the task; the start runs once per launch (C-13)', async () => {
    const runner = fakeRunner();
    const client = new FakeAttachedClient({ liveOnRetry: 1 });
    const { controller } = attachedController({ runner, client });
    await controller.startAttached();
    client.drop();
    await controller.startAttached();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(runner.calls.filter(([c]) => c === 'runTask').length, 1);
    assert.strictEqual((await controller.status()).view, 'attached-disconnected');
    controller.dispose();
  });

  it('a fleet pairing connects at once and never touches the runner', async () => {
    const runner = fakeRunner();
    const { controller, client } = attachedController({ runner, pairingRecord: pairedRecord() });
    await controller.startAttached();
    assert.deepStrictEqual(runner.calls, []);
    assert.strictEqual(client.connects, 1);
    assert.strictEqual(client.retries, 0);
    controller.dispose();
  });

  it('a personal pairing the disk no longer agrees with connects at once and runs nothing (C-7)', async () => {
    const runner = fakeRunner({ personal: false });
    const { controller, client } = attachedController({ runner });
    await controller.startAttached();
    assert.ok(!runner.calls.some(([c]) => c === 'runTask' || c === 'queryTask' || c === 'nodeRunning'));
    assert.strictEqual(client.connects, 1);
    controller.dispose();
  });

  it('nodeStart runs the task on a press and waits in the background', async () => {
    const runner = fakeRunner();
    const client = new FakeAttachedClient({ liveOnRetry: 2 });
    const { controller } = attachedController({ runner, client });
    const out = await controller.nodeStart({ restart: false });
    assert.strictEqual(out.ok, true);
    await controller.startIdle();
    assert.strictEqual(runner.calls.filter(([c]) => c === 'runTask').length, 1);
    assert.ok(!runner.calls.some(([c]) => c === 'stopNode'));
    assert.strictEqual((await controller.status()).view, 'attached-connected');
    controller.dispose();
  });

  it('nodeStart with a node already running runs nothing (C-11)', async () => {
    const runner = fakeRunner({ running: true });
    const { controller } = attachedController({ runner, client: new FakeAttachedClient({ liveOnRetry: 1 }) });
    await controller.nodeStart({ restart: false });
    await controller.startIdle();
    assert.ok(!runner.calls.some(([c]) => c === 'runTask' || c === 'stopNode'));
    controller.dispose();
  });

  it('nodeStart({ restart: true }) checks the task, stops, then runs it', async () => {
    const runner = fakeRunner({ running: true });
    const client = new FakeAttachedClient({ liveOnRetry: 2 });
    const { controller } = attachedController({ runner, client });
    await controller.nodeStart({ restart: true });
    await controller.startIdle();
    const steps = runner.calls.map(([c]) => c).filter((c) => ['queryTask', 'stopNode', 'runTask'].includes(c));
    assert.deepStrictEqual(steps, ['queryTask', 'stopNode', 'runTask']);
    assert.deepStrictEqual(runner.calls.filter(([c]) => c === 'stopNode').map(([, a]) => a), [{ dataDir: PERSONAL_DATA_DIR }]);
    assert.strictEqual(runner.calls.find(([c]) => c === 'queryTask')[1].me, OWNER_SID);
    assert.strictEqual(runner.calls.find(([c]) => c === 'startFailureSince')[1], 1000, 'the wait reads the log from the /Run');
    controller.dispose();
  });

  for (const [task, code] of [['other-account', 'NODE_TASK_OTHER_ACCOUNT'], ['disabled', 'NODE_TASK_DISABLED']]) {
    it(`a restart with a task that is ${task} stops nothing and runs nothing (${code})`, async () => {
      const runner = fakeRunner({ running: true, task });
      const { controller } = attachedController({ runner });
      await controller.nodeStart({ restart: true });
      await controller.startIdle();
      assert.ok(!runner.calls.some(([c]) => c === 'stopNode' || c === 'runTask'));
      const status = await controller.status();
      assert.strictEqual(status.node.startError.code, code);
      assert.strictEqual(status.node.running, true, 'the node was left running');
      controller.dispose();
    });
  }

  it('a restart with no node running just starts it: no stop', async () => {
    const runner = fakeRunner({ running: false });
    const client = new FakeAttachedClient({ liveOnRetry: 1 });
    const { controller } = attachedController({ runner, client });
    await controller.nodeStart({ restart: true });
    await controller.startIdle();
    assert.ok(!runner.calls.some(([c]) => c === 'stopNode'));
    assert.strictEqual(runner.calls.filter(([c]) => c === 'runTask').length, 1);
    assert.strictEqual((await controller.status()).view, 'attached-connected');
    controller.dispose();
  });

  it('after a drop the status reads the node again: no stale running row, nothing is run (C-13)', async () => {
    const runner = fakeRunner({ running: true });
    const client = new FakeAttachedClient({ liveOnRetry: 1 });
    const { controller } = attachedController({ runner, client });
    await controller.startAttached();
    assert.strictEqual((await controller.status()).view, 'attached-connected');
    runner.running = false; // the owner stopped the node
    client.drop();
    await controller.refreshIdle();
    const status = await controller.status();
    assert.strictEqual(status.view, 'attached-disconnected');
    assert.strictEqual(status.node.running, false);
    assert.strictEqual(status.node.pid, null);
    assert.strictEqual(status.node.task, 'registered', 'the Start row, chosen from what is found now');
    assert.ok(!runner.calls.some(([c]) => c === 'runTask'));
    controller.dispose();
  });

  it('the disconnected status reads the node again, at most once a while', async () => {
    const runner = fakeRunner({ running: false, task: 'missing' });
    const timers = fakeTimers();
    const { controller } = attachedController({ runner, timers });
    // Not started: the view is attached-disconnected from the start.
    const first = await controller.status();
    assert.strictEqual(first.view, 'attached-disconnected');
    assert.strictEqual(first.node.task, 'missing');
    await controller.status();
    await controller.status();
    assert.strictEqual(runner.calls.filter(([c]) => c === 'nodeRunning').length, 1, 'rate-limited');
    timers.now += 60000;
    runner.task = 'registered';
    assert.strictEqual((await controller.status()).node.task, 'registered');
    assert.strictEqual(runner.calls.filter(([c]) => c === 'nodeRunning').length, 2);
    assert.ok(!runner.calls.some(([c]) => c === 'runTask'));
    controller.dispose();
  });

  it('a wait where nothing was run times out when the node is gone by then', async () => {
    const runner = fakeRunner({ running: true });
    const { controller } = attachedController({ runner });
    const keepAlive = setTimeout(() => {}, 60000);
    try {
      const realNodeRunning = runner.nodeRunning;
      let reads = 0;
      runner.nodeRunning = async (a) => { reads += 1; if (reads > 1) runner.running = false; return realNodeRunning(a); };
      await controller.startAttached();
      const status = await controller.status();
      assert.strictEqual(status.node.startError.code, 'NODE_START_TIMEOUT');
      assert.strictEqual(status.node.running, false);
      assert.ok(!runner.calls.some(([c]) => c === 'runTask'));
    } finally {
      clearTimeout(keepAlive);
      controller.dispose();
    }
  });

  it('the timeout says the wait it was given', async () => {
    const runner = fakeRunner();
    const timers = fakeTimers();
    const made = controllerFor({ mode: 'attached', extra: { nodeRunner: runner, ...timers.extra, nodeStartWaitMs: 30000 } });
    made.state.setPairing(personalPairing());
    made.controller.setClient(new FakeAttachedClient());
    const keepAlive = setTimeout(() => {}, 60000);
    try {
      await made.controller.startAttached();
      assert.deepStrictEqual((await made.controller.status()).node.startError, { code: 'NODE_START_TIMEOUT', message: 'King Louie Node did not answer within 30 seconds.' });
    } finally {
      clearTimeout(keepAlive);
      made.controller.dispose();
    }
  });

  it('two waits at once each keep their own timer, and dispose clears both', async () => {
    const svc = await startService();
    const port = await deadPort();
    const runner = fakeRunner({ cli: pairingCli(svc), trust: trustedRecord(port) });
    const timers = heldTimers();
    const { controller } = attachedController({ runner, timers });
    const keepAlive = setTimeout(() => {}, 60000);
    try {
      const attached = controller.startAttached();
      while (timers.pending.size === 0) await new Promise((r) => setImmediate(r));
      const paired = controller.pairStart();
      while (timers.pending.size < 2) await new Promise((r) => setTimeout(r, 5));
      controller.dispose();
      await Promise.all([attached, paired]);
      assert.strictEqual(timers.pending.size, 0, 'no timer left behind');
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('a restart whose stop fails is NODE_STOP_FAILED in the status', async () => {
    const runner = fakeRunner({ running: true, stop: () => ({ ok: false, code: 'NODE_STOP_FAILED', message: 'stop did not finish' }) });
    const { controller } = attachedController({ runner });
    await controller.nodeStart({ restart: true });
    await controller.startIdle();
    const status = await controller.status();
    assert.deepStrictEqual(status.node.startError, { code: 'NODE_STOP_FAILED', message: 'stop did not finish' });
    assert.strictEqual(status.node.starting, false);
    controller.dispose();
  });

  it('nodeStart refuses without a personal pairing', async () => {
    const runner = fakeRunner();
    const { controller } = attachedController({ runner, pairingRecord: pairedRecord() });
    const out = await controller.nodeStart({ restart: false });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'NOT_PERSONAL');
    assert.deepStrictEqual(runner.calls, []);
    controller.dispose();
  });
});

describe('desktop controller: Install from the pane (§8)', () => {
  const cliRunner = (outputs) => fakeRunner({ task: 'missing', cli: (args) => outputs(args) });

  it('nodeInstallPreview runs install --personal --dry-run and returns its lines through shown', async () => {
    const runner = cliRunner(() => ({ code: 0, stdout: 'Account: LAPTOP-01\\owner\r\nTask: KingLouie Node\nodd\u0007line\n', stderr: '', json: null }));
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.nodeInstallPreview();
    const cli = runner.calls.find(([c]) => c === 'runCli');
    assert.deepStrictEqual(cli[1], ['install', '--personal', '--dry-run', '--data-dir', PERSONAL_DATA_DIR]);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.lines, ['Account: LAPTOP-01\\owner', 'Task: KingLouie Node', 'oddline [hidden or control characters removed]']);
    controller.dispose();
  });

  it('a refused preview carries a code and the first line', async () => {
    const runner = cliRunner(() => ({ code: 2, stdout: '', stderr: 'install --personal refuses an elevated prompt.\n', json: null }));
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.nodeInstallPreview();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'NODE_INSTALL_FAILED');
    assert.strictEqual(out.message, 'install --personal refuses an elevated prompt.');
    assert.deepStrictEqual(out.lines, ['install --personal refuses an elevated prompt.']);
    controller.dispose();
  });

  it('nodeInstall refuses without confirmed: true and runs nothing', async () => {
    const runner = cliRunner(() => ({ code: 0, stdout: '', stderr: '', json: null }));
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    for (const confirmed of [undefined, false, 'yes', 1]) {
      const out = await controller.nodeInstall({ confirmed });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.code, 'CONFIRM_REQUIRED');
      assert.deepStrictEqual(out.lines, []);
    }
    assert.ok(!runner.calls.some(([c]) => c === 'runCli'));
    controller.dispose();
  });

  it('nodeInstall runs install --personal --yes and refreshes the task state', async () => {
    const runner = cliRunner(() => ({ code: 0, stdout: 'Registered KingLouie Node.\n', stderr: '', json: null }));
    const { controller, state } = controllerFor({ extra: { nodeRunner: runner } });
    state.setPairing(personalPairing());
    const realCli = runner.runCli;
    runner.runCli = async (args, opts) => { const r = await realCli(args, opts); runner.task = 'registered'; return r; };
    const out = await controller.nodeInstall({ confirmed: true });
    assert.deepStrictEqual(runner.calls.find(([c]) => c === 'runCli')[1], ['install', '--personal', '--yes', '--data-dir', PERSONAL_DATA_DIR]);
    assert.deepStrictEqual(out, { ok: true, lines: ['Registered KingLouie Node.'] });
    const ran = runner.calls.map(([c]) => c);
    assert.ok(ran.indexOf('detectPersonalNode') < ran.indexOf('runCli'), 'the disk is read before the install (C-7)');
    assert.deepStrictEqual(runner.calls.find(([c]) => c === 'detectPersonalNode')[1], { dataDir: PERSONAL_DATA_DIR });
    assert.ok(ran.indexOf('queryTask') < ran.indexOf('runCli'), 'the task is checked before the install');
    assert.ok(ran.lastIndexOf('queryTask') > ran.indexOf('runCli'), 'the task is read after the install');
    assert.strictEqual((await controller.status()).node.task, 'registered');
    assert.ok(!ran.includes('runTask'), 'the desktop runs nothing itself after an install');
    controller.dispose();
  });

  for (const task of ['registered', 'disabled', 'other-account', 'unknown']) {
    it(`nodeInstall refuses a task that is ${task} and runs nothing (§8: only with no task)`, async () => {
      const runner = fakeRunner({ task, cli: () => ({ code: 0, stdout: 'Registered.\n', stderr: '', json: null }) });
      const { controller } = controllerFor({ extra: { nodeRunner: runner } });
      const out = await controller.nodeInstall({ confirmed: true });
      assert.strictEqual(out.ok, false);
      assert.ok(out.code && out.code !== 'NODE_TASK_MISSING', out.code);
      assert.ok(out.message);
      assert.deepStrictEqual(out.lines, []);
      assert.ok(!runner.calls.some(([c]) => c === 'runCli'));
      controller.dispose();
    });
  }

  it('a recorded personal pairing the disk no longer agrees with: Install refuses (C-7)', async () => {
    const runner = fakeRunner({ personal: false, task: 'missing' });
    const { controller, state } = controllerFor({ extra: { nodeRunner: runner } });
    state.setPairing(personalPairing());
    for (const out of [await controller.nodeInstallPreview(), await controller.nodeInstall({ confirmed: true })]) {
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.code, 'NOT_PERSONAL');
    }
    assert.deepStrictEqual(runner.calls.filter(([c]) => c === 'detectPersonalNode').map(([, a]) => a), [{ dataDir: PERSONAL_DATA_DIR }, { dataDir: PERSONAL_DATA_DIR }]);
    assert.ok(!runner.calls.some(([c]) => c === 'runCli'));
    controller.dispose();
  });

  // Attach stage 2 §6.4 (C-4): installing from nothing.
  it('a fresh machine: the preview and the install target personalDataDir()', async () => {
    const runner = fakeRunner({ personal: false, fresh: true, task: 'missing', cli: () => ({ code: 0, stdout: 'will set up\n', stderr: '', json: null }) });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const preview = await controller.nodeInstallPreview();
    assert.deepStrictEqual(preview, { ok: true, lines: ['will set up'] });
    assert.deepStrictEqual(runner.calls.find(([c]) => c === 'runCli')[1], ['install', '--personal', '--dry-run', '--data-dir', PERSONAL_DATA_DIR]);
    assert.deepStrictEqual(runner.calls.find(([c]) => c === 'detectPersonalNode')[1], {});
    const out = await controller.nodeInstall({ confirmed: true });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(runner.calls.filter(([c]) => c === 'runCli')[1][1], ['install', '--personal', '--yes', '--data-dir', PERSONAL_DATA_DIR]);
    assert.strictEqual(runner.calls.find(([c]) => c === 'queryTask')[1].me, OWNER_SID);
    controller.dispose();
  });

  it('the CLI\'s log lines do not reach the preview, or a failure\'s message', async () => {
    const out = '[service/config] feature "desktopBridge" is ENABLED by C:\\x\\service.json\nwill set up\n';
    const ok = fakeRunner({ personal: false, fresh: true, task: 'missing', cli: () => ({ code: 0, stdout: out, stderr: '', json: null }) });
    const a = controllerFor({ extra: { nodeRunner: ok } });
    assert.deepStrictEqual(await a.controller.nodeInstallPreview(), { ok: true, lines: ['will set up'] });
    a.controller.dispose();
    const failed = fakeRunner({ personal: false, fresh: true, task: 'missing', cli: () => ({ code: 2, stdout: '', stderr: '[service/config] noise\nrefused for a reason\n', json: null }) });
    const b = controllerFor({ extra: { nodeRunner: failed } });
    const refused = await b.controller.nodeInstallPreview();
    assert.strictEqual(refused.message, 'refused for a reason');
    assert.deepStrictEqual(refused.lines, ['refused for a reason']);
    b.controller.dispose();
  });

  it('a recorded pairing is never installed for by a fresh answer (C-7)', async () => {
    const runner = fakeRunner({ personal: false, fresh: true, task: 'missing' });
    const { controller, state } = controllerFor({ extra: { nodeRunner: runner } });
    state.setPairing(personalPairing());
    const out = await controller.nodeInstallPreview();
    assert.strictEqual(out.code, 'NOT_PERSONAL');
    assert.ok(!runner.calls.some(([c]) => c === 'runCli'));
    controller.dispose();
  });

  it('with no personal node found, Install refuses', async () => {
    const runner = fakeRunner({ personal: false });
    const { controller } = controllerFor({ extra: { nodeRunner: runner } });
    const out = await controller.nodeInstallPreview();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'NOT_PERSONAL');
    assert.deepStrictEqual(out.lines, []);
    assert.ok(!runner.calls.some(([c]) => c === 'runCli'));
    controller.dispose();
  });
});

// --- The node's hosting and the version gap (spec 2026-11-03 §6.8, §8, C-12).

describe('desktop controller: hosting and the version gap', () => {
  const fleetPairing = () => pairedRecord();
  function connectedTo(service, { pairingRecord = personalPairing(), extra = { appVersion: '1.0.1' } } = {}) {
    const client = new FakeAttachedClient();
    const made = attachedController({ runner: fakeRunner({ running: true }), client, pairingRecord, extra });
    client.connected = true;
    client.service = service;
    client.emit('state', { status: 'connected', code: null, error: null, service, nextRetryAt: null });
    return made;
  }

  it('unavailableTabs: the mesh alone on a personal pairing, connected or down', async () => {
    const { controller } = connectedTo({ version: '1.0.1', hosting: 'personal' });
    assert.deepStrictEqual((await controller.status()).unavailableTabs, ['mesh']);
    controller.dispose();
    const down = attachedController({ runner: fakeRunner({ running: false }) });
    assert.deepStrictEqual((await down.controller.status()).unavailableTabs, ['mesh']);
    down.controller.dispose();
  });

  it('unavailableTabs: the whole list on a fleet pairing', async () => {
    const { controller } = connectedTo({ version: '1.0.0', hosting: 'service' }, { pairingRecord: fleetPairing() });
    assert.deepStrictEqual((await controller.status()).unavailableTabs, ['mcp', 'channels', 'hooks', 'skills', 'webhooks', 'workflows', 'mesh', 'diagnostics', 'system-apps']);
    controller.dispose();
  });

  it('what the node says of itself is coerced: hosting only personal or service, version a version or nothing', async () => {
    const odd = connectedTo({ version: 'Restart\u0007 now', hosting: { evil: true } });
    const status = await odd.controller.status();
    assert.strictEqual(status.service.hosting, 'personal', 'not a word from the node: the pairing record says');
    assert.strictEqual(status.service.version, null);
    assert.strictEqual(status.versionMismatch, null);
    odd.controller.dispose();
    const number = connectedTo({ version: 7, hosting: 'personal' });
    const numbered = await number.controller.status();
    assert.strictEqual(numbered.service.version, null);
    assert.strictEqual(numbered.versionMismatch, null, 'nothing a person could read: no row');
    number.controller.dispose();
    const long = connectedTo({ version: '9'.repeat(500), hosting: 'personal' });
    assert.strictEqual((await long.controller.status()).service.version, null);
    long.controller.dispose();
    const fleet = connectedTo({ version: '1.0.0', hosting: 'root' }, { pairingRecord: fleetPairing() });
    assert.strictEqual((await fleet.controller.status()).service.hosting, 'service');
    fleet.controller.dispose();
  });

  it('a personal node on another version: versionMismatch names both', async () => {
    const { controller } = connectedTo({ version: '1.0.0', hosting: 'personal' });
    const status = await controller.status();
    assert.strictEqual(status.view, 'attached-connected');
    assert.strictEqual(status.service.hosting, 'personal');
    assert.deepStrictEqual(status.versionMismatch, { node: '1.0.0', app: '1.0.1' });
    controller.dispose();
  });

  it('a fleet service with the same difference: null', async () => {
    const { controller } = connectedTo({ version: '1.0.0', hosting: 'service' }, { pairingRecord: fleetPairing() });
    const status = await controller.status();
    assert.strictEqual(status.service.hosting, 'service');
    assert.strictEqual(status.versionMismatch, null);
    controller.dispose();
  });

  it('a personal node on the same version: null', async () => {
    const { controller } = connectedTo({ version: '1.0.1', hosting: 'personal' });
    assert.strictEqual((await controller.status()).versionMismatch, null);
    controller.dispose();
  });

  it('a node from before the field: hosting comes from the pairing record, so an older personal node still shows the gap', async () => {
    const { controller } = connectedTo({ version: '1.0.0' });
    const status = await controller.status();
    assert.strictEqual(status.service.hosting, 'personal');
    assert.deepStrictEqual(status.versionMismatch, { node: '1.0.0', app: '1.0.1' });
    controller.dispose();
  });

  it('a fleet node from before the field reads as service', async () => {
    const { controller } = connectedTo({ version: '1.0.0' }, { pairingRecord: fleetPairing() });
    const status = await controller.status();
    assert.strictEqual(status.service.hosting, 'service');
    assert.strictEqual(status.versionMismatch, null);
    controller.dispose();
  });

  it('never connected this launch: hosting from the record, and the version seen at pairing is no gap', async () => {
    const record = personalPairing();
    record.service.info = { version: '1.0.0', account: 'owner' };
    const { controller } = attachedController({ runner: fakeRunner({ running: true }), pairingRecord: record, extra: { appVersion: '1.0.1' } });
    const status = await controller.status();
    assert.strictEqual(status.service.account, 'owner');
    assert.strictEqual(status.service.hosting, 'personal');
    assert.strictEqual(status.versionMismatch, null);
    controller.dispose();
  });

  it('no version on either side is no gap', async () => {
    const noNode = connectedTo({ version: null, hosting: 'personal' });
    assert.strictEqual((await noNode.controller.status()).versionMismatch, null);
    noNode.controller.dispose();
    const noApp = connectedTo({ version: '1.0.0', hosting: 'personal' }, { extra: { appVersion: null } });
    assert.strictEqual((await noApp.controller.status()).versionMismatch, null);
    noApp.controller.dispose();
  });

  it('appVersion defaults to the app\'s own', async () => {
    const { controller } = connectedTo({ version: '1.0.0', hosting: 'personal' }, { extra: { app: { ...fakeApp(), getVersion: () => '2.0.0' } } });
    assert.deepStrictEqual((await controller.status()).versionMismatch, { node: '1.0.0', app: '2.0.0' });
    controller.dispose();
  });

  it('with no pairing and no client the service stays null', async () => {
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false, code: 'BRIDGE_FILE_MISSING', error: 'none' }), extra: { appVersion: '1.0.1' } });
    const status = await controller.status();
    assert.strictEqual(status.service, null);
    assert.strictEqual(status.versionMismatch, null);
    controller.dispose();
  });
});

// --- The one-time move (attach stage 2 §6.5): a temp profile on disk, a real
// backup, a fake node that keeps what the apply batches gave it.

class FakeNodeClient extends EventEmitter {
  constructor({ hosting = 'personal', dropChat = null, shortChat = null, finish = {}, failFinish = false, excluded = [] } = {}) {
    super();
    this.connected = true;
    this.service = { version: '1.0.0', account: 'alex', profile: 'agent', providersConfigured: true, hosting };
    this.chats = new Map();
    this.cases = new Set();
    this.marked = new Set();
    this.lastAt = new Map();
    this.loseMark = false;
    this.attentionItems = [];
    this.plans = 0;
    this.finishes = 0;
    Object.assign(this, { dropChat, shortChat, finishExtra: finish, failFinish, excluded });
  }
  close() {}
  retryNow() { return Promise.resolve(null); }
  async call(method, params) {
    if (method === 'bridge.status') return this.service;
    if (method === 'bridge.approvalsStatus') return { available: false };
    if (method === 'import.plan') {
      this.plans += 1;
      const { inventory } = params;
      const items = [
        ...inventory.chats.map((c) => ({ category: 'chat', key: c.id, action: this.chats.has(c.id) ? 'skip-present' : 'new', note: null, targetKey: c.id })),
        ...inventory.cases.map((c) => ({ category: 'case', key: c.dir, action: this.cases.has(c.dir) ? 'skip-present' : 'new', note: null, targetKey: c.dir })),
        ...this.excluded.map((e) => ({ category: 'excluded', key: e.key, action: 'skip-excluded', note: e.note, targetKey: e.key })),
        ...this.attentionItems
      ];
      return { planId: `plan-${this.plans}`, items, counts: {} };
    }
    if (method === 'import.apply') {
      const results = [];
      for (const entry of params.batch) {
        if (entry.category === 'chat' && entry.key !== this.dropChat) {
          const n = entry.value.messages.length;
          this.chats.set(entry.key, entry.key === this.shortChat ? n - 1 : n);
          if (entry.value.private === true && !this.loseMark) this.marked.add(entry.key);
          const shownMessages = entry.value.messages.filter((m) => m.sender === 'user' || m.sender === 'assistant');
          this.lastAt.set(entry.key, shownMessages.length ? shownMessages[shownMessages.length - 1].timestamp : null);
        }
        if (entry.category === 'case') this.cases.add(entry.key);
        results.push({ category: entry.category, key: entry.key, ok: true });
      }
      return { results };
    }
    if (method === 'import.finish') {
      this.finishes += 1;
      if (this.failFinish) throw Object.assign(new Error('the node went away'), { code: 'SERVICE_UNREACHABLE' });
      return { planId: params.planId, counts: { failed: 0 }, failures: [], attention: [], incomplete: [], secretsMissing: [], cronDisabled: 0, notes: [], ...this.finishExtra };
    }
    throw new Error(`unexpected ${method}`);
  }
  async invoke(channel) {
    if (channel === 'chat:load') return { ok: true, data: { chats: [...this.chats].map(([id, messageCount]) => ({ id, messageCount, lastMessageAt: this.lastAt.get(id) || null, ...(this.marked.has(id) ? { private: true } : {}) })), history: { available: true } } };
    if (channel === 'case:list') return { ok: true, cases: [...this.cases].map((dir) => ({ dir: path.join('C:', 'node', 'cases', dir) })) };
    throw new Error(`unexpected ${channel}`);
  }
}

describe('desktop controller: the one-time move', () => {
  const { openTempStore, seedChat } = require('./helpers/history-fixture');
  const { readBackupManifest } = require('../src/migration/profile-backup');

  // A profile with a real store, a chat-data.json and a case folder.
  function moveController({ client = new FakeNodeClient(), chats = [['c1', 2], ['c2', 3]], launch = { host: 'attached', why: 'attached', degraded: false }, pairingRecord = personalPairing(), profile = true, extra = {} } = {}) {
    const parent = tmp();
    const userDataDir = path.join(parent, 'king-louie');
    fs.mkdirSync(userDataDir);
    if (profile) {
      const temp = openTempStore();
      for (const [id, n] of chats) seedChat(temp.store, { id, messages: Array.from({ length: n }, (_, i) => ({ sender: 'user', text: `line ${i}` })) });
      temp.store.close();
      fs.copyFileSync(temp.dbPath, path.join(userDataDir, 'history.sqlite'));
      fs.rmSync(temp.dir, { recursive: true, force: true });
      fs.writeFileSync(path.join(userDataDir, 'chat-data.json'), JSON.stringify({ settings: {} }));
      fs.mkdirSync(path.join(userDataDir, 'cases', 'lakeside-lot'), { recursive: true });
      fs.writeFileSync(path.join(userDataDir, 'cases', 'lakeside-lot', 'case.yaml'), 'id: case-lot\nslug: lakeside-lot\ntitle: Lakeside lot\n');
    }
    const state = openDesktopState(userDataDir, fakeSafeStorage(), { storeFactory });
    state.setMode('attached');
    if (pairingRecord) state.setPairing(pairingRecord);
    const app = fakeApp();
    const sent = [];
    const controller = createDesktopController({
      state, mode: 'attached', app, getWindow: () => ({ isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } }),
      env: {}, platform: 'win32', userDataDir, safeStorage: fakeSafeStorage(), stdout: { write() {} },
      argv: ['electron', '.'], username: 'alex', launch, nodeRunner: fakeRunner({ running: true }), ...extra
    });
    if (client) controller.setClient(client);
    return { controller, state, app, client, userDataDir, parent, sent };
  }
  const backupsIn = (parent) => fs.readdirSync(parent).filter((n) => n.startsWith('king-louie.backup-'));

  it('migrationPlan makes the backup first and returns the plan and what stays behind', async () => {
    const client = new FakeNodeClient({ excluded: [{ key: 'skills', note: 'skills, pins and customizations are set up on the service by an administrator' }] });
    const { controller, parent, userDataDir } = moveController({ client });
    const out = await controller.migrationPlan();
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(backupsIn(parent).length, 1);
    assert.strictEqual(path.dirname(out.backup.dest), path.dirname(userDataDir));
    assert.deepStrictEqual(out.backup.history, { chats: 2, messages: 5 });
    const manifest = await readBackupManifest(path.join(parent, backupsIn(parent)[0]));
    assert.deepStrictEqual(manifest.history, { chats: 2, messages: 5 });
    const planned = out.plan.items.filter((i) => i.category === 'chat').map((i) => [i.key, i.action, i.messageCount]);
    assert.deepStrictEqual(planned.sort(), [['c1', 'new', 2], ['c2', 'new', 3]]);
    const behind = out.staysBehind.join('\n');
    assert.match(behind, /browser profiles/i);
    assert.match(behind, /local servers/i);
    assert.match(behind, /typesafe/i);
    assert.match(behind, /skills, pins and customizations/);
    assert.ok(Array.isArray(out.attention));
    controller.dispose();
  });

  it('what stays behind comes from the node\'s plan, so what a personal node carries is not listed', async () => {
    const { controller } = moveController();
    const out = await controller.migrationPlan();
    assert.doesNotMatch(out.staysBehind.join('\n'), /bot tokens|chat bot|hooks spawn|MCP servers spawn/);
    controller.dispose();
  });

  it('what it returns goes through shown; the plan it applies keeps the real keys', async () => {
    const client = new FakeNodeClient({ excluded: [{ key: 'x', note: 'stays \u202Eevil' }] });
    const { controller } = moveController({ client });
    const out = await controller.migrationPlan();
    assert.ok(!JSON.stringify(out).includes('\u202E'));
    controller.dispose();
  });

  it('the backup is made once per launch and reused while it still reads whole', async () => {
    const { controller, parent, client } = moveController();
    const first = await controller.migrationPlan();
    const second = await controller.migrationPlan();
    assert.strictEqual(second.backup.dest, first.backup.dest);
    assert.strictEqual(backupsIn(parent).length, 1);
    assert.strictEqual(client.plans, 2);
    controller.dispose();
  });

  it('a backup that no longer reads whole is made again', async () => {
    let tick = 0;
    const { controller, parent } = moveController({ extra: { now: () => new Date(Date.UTC(2026, 10, 4, 10, 0, tick++)) } });
    const first = await controller.migrationPlan();
    fs.rmSync(path.join(parent, backupsIn(parent)[0], 'backup.json'));
    const second = await controller.migrationPlan();
    assert.notStrictEqual(second.backup.dest, first.backup.dest);
    assert.strictEqual(backupsIn(parent).length, 2);
    controller.dispose();
  });

  it('migrationPlan refuses on schemaProblem: no backup made, MIGRATION_SOURCE', async () => {
    const { controller, parent, userDataDir, client } = moveController();
    fs.writeFileSync(path.join(userDataDir, 'history.sqlite'), 'this is not a database, not at all');
    const out = await controller.migrationPlan();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'MIGRATION_SOURCE');
    assert.ok(out.error);
    assert.deepStrictEqual(backupsIn(parent), []);
    assert.strictEqual(client.plans, 0);
    controller.dispose();
  });

  it('a profile with nothing in it plans no move and makes no backup', async () => {
    const { controller, parent } = moveController({ profile: false });
    const out = await controller.migrationPlan();
    assert.strictEqual(out.code, 'MIGRATION_SOURCE');
    assert.deepStrictEqual(backupsIn(parent), []);
    controller.dispose();
  });

  it('a backup that fails stops the move: BACKUP_FAILED, the directory named, nothing planned', async () => {
    const client = new FakeNodeClient();
    const { controller } = moveController({
      client,
      extra: { migrationDeps: { backupProfile: async ({ dest }) => { throw Object.assign(new Error(`The profile could not be backed up: the disk is full. The unfinished copy is at ${dest}.`), { code: 'BACKUP_FAILED', dest }); } } }
    });
    const out = await controller.migrationPlan();
    assert.strictEqual(out.code, 'BACKUP_FAILED');
    assert.ok(out.backupDir.includes('king-louie.backup-'));
    assert.strictEqual(client.plans, 0);
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).code, 'PLAN_EXPIRED');
    controller.dispose();
  });

  it('a source that reads fewer chats than the backup holds is refused, never planned as a smaller move', async () => {
    const client = new FakeNodeClient();
    const { controller } = moveController({
      client,
      extra: { migrationDeps: { loadDesktopSource: async () => ({ installId: 'i-1', attention: [], inventory: { installId: 'i-1', chats: [], cases: [] }, getValue: () => null, caseFiles: () => [] }) } }
    });
    const out = await controller.migrationPlan();
    assert.strictEqual(out.code, 'MIGRATION_SOURCE');
    assert.strictEqual(client.plans, 0);
    controller.dispose();
  });

  it('a store the second read refuses is refused too, not planned as empty', async () => {
    const client = new FakeNodeClient();
    const { controller } = moveController({
      client,
      extra: { migrationDeps: { loadDesktopSource: async () => ({ installId: 'i-1', attention: [{ category: 'source', key: 'history.sqlite', note: 'could not be read (locked)' }], inventory: { installId: 'i-1', chats: [], cases: [] }, getValue: () => null, caseFiles: () => [] }) } }
    });
    const out = await controller.migrationPlan();
    assert.strictEqual(out.code, 'MIGRATION_SOURCE');
    assert.match(out.error, /locked/);
    assert.strictEqual(client.plans, 0);
    controller.dispose();
  });

  it('needs a pairing, a personal node and a live connection, before any backup', async () => {
    const none = moveController({ pairingRecord: null, client: null });
    assert.strictEqual((await none.controller.migrationPlan()).code, 'NOT_PAIRED');
    assert.deepStrictEqual(backupsIn(none.parent), []);
    none.controller.dispose();

    const fleet = moveController({ pairingRecord: pairedRecord(), client: new FakeNodeClient({ hosting: 'service' }) });
    assert.strictEqual((await fleet.controller.migrationPlan()).code, 'NOT_PERSONAL');
    assert.deepStrictEqual(backupsIn(fleet.parent), []);
    fleet.controller.dispose();

    const down = moveController();
    down.client.connected = false;
    assert.strictEqual((await down.controller.migrationPlan()).code, 'SERVICE_UNREACHABLE');
    assert.deepStrictEqual(backupsIn(down.parent), []);
    down.controller.dispose();
  });

  it('migrationApply without confirmed is CONFIRM_REQUIRED and sends nothing', async () => {
    const { controller, client, state } = moveController();
    await controller.migrationPlan();
    for (const payload of [undefined, {}, { confirmed: 'true' }]) {
      assert.strictEqual((await controller.migrationApply(payload)).code, 'CONFIRM_REQUIRED');
    }
    assert.strictEqual(client.finishes, 0);
    assert.strictEqual(state.migration, null);
    controller.dispose();
  });

  it('migrationApply with no plan is PLAN_EXPIRED', async () => {
    const { controller } = moveController();
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).code, 'PLAN_EXPIRED');
    controller.dispose();
  });

  it('a verified move sets the marker with backupDir, nodeId, nodeDataDir and counts', async () => {
    const { controller, state, sent, client } = moveController();
    const planned = await controller.migrationPlan();
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(out.verified, { ok: true, checked: { chats: 2, cases: 1 } });
    assert.ok(out.report);
    const marker = state.migration;
    assert.strictEqual(marker.backupDir, planned.backup.dest);
    assert.strictEqual(marker.nodeId, identity.nodeId);
    assert.strictEqual(marker.nodeDataDir, PERSONAL_DATA_DIR);
    assert.deepStrictEqual(marker.counts, { chats: 2, cases: 1, attention: 0 });
    assert.ok(Date.parse(marker.at));
    assert.ok(sent.some(([ch]) => ch === 'desktop:importProgress'));
    assert.strictEqual(client.finishes, 1);
    controller.dispose();
  });

  it('one chat missing on the node: no marker, MIGRATION_UNVERIFIED naming it, and Try again lands it', async () => {
    const client = new FakeNodeClient({ dropChat: 'c2' });
    const { controller, state, parent } = moveController({ client });
    await controller.migrationPlan();
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'MIGRATION_UNVERIFIED');
    assert.deepStrictEqual(out.verified.missing.map((m) => m.key), ['c2']);
    assert.ok(out.report);
    assert.ok(out.error);
    assert.strictEqual(state.migration, null);

    client.dropChat = null;
    const again = await controller.migrationPlan();
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.plan.items.find((i) => i.key === 'c1').action, 'skip-present');
    assert.strictEqual(backupsIn(parent).length, 1, 'the launch\'s backup is reused');
    const second = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(second.ok, true, JSON.stringify(second));
    assert.deepStrictEqual(state.migration.counts, { chats: 2, cases: 1, attention: 0 });
    controller.dispose();
  });

  it('a chat short of its messages on the node: no marker', async () => {
    const client = new FakeNodeClient({ shortChat: 'c1' });
    const { controller, state } = moveController({ client });
    await controller.migrationPlan();
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.code, 'MIGRATION_UNVERIFIED');
    assert.strictEqual(state.migration, null);
    controller.dispose();
  });

  it('a report that lists a failure: no marker, even with everything else there', async () => {
    const client = new FakeNodeClient({ finish: { failures: [{ category: 'memory', key: 'm-1', error: 'disk full' }], counts: { failed: 1 } } });
    const { controller, state } = moveController({ client });
    await controller.migrationPlan();
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.code, 'MIGRATION_UNVERIFIED');
    assert.strictEqual(state.migration, null);
    controller.dispose();
  });

  it('the node going away mid-apply: no marker, and it can be tried again', async () => {
    const client = new FakeNodeClient({ failFinish: true });
    const { controller, state } = moveController({ client });
    await controller.migrationPlan();
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'SERVICE_UNREACHABLE');
    assert.strictEqual(state.migration, null);
    client.failFinish = false;
    assert.strictEqual((await controller.migrationPlan()).ok, true);
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).ok, true);
    assert.ok(state.migration);
    controller.dispose();
  });

  it('a marker that cannot be written: said so, with the verified result, and the retry marks', async () => {
    const { controller, state } = moveController();
    const real = state.setMigration;
    state.setMigration = () => { throw new Error('EPERM on desktop-bridge.json'); };
    await controller.migrationPlan();
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'MIGRATION_MARK_FAILED');
    assert.strictEqual(out.verified.ok, true);
    state.setMigration = real;
    await controller.migrationPlan();
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).ok, true);
    controller.dispose();
  });

  it('two presses of Move everything run one move', async () => {
    const { controller, client } = moveController();
    await controller.migrationPlan();
    const [a, b] = await Promise.all([controller.migrationApply({ confirmed: true }), controller.migrationApply({ confirmed: true })]);
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(client.finishes, 1);
    controller.dispose();
  });

  it('the pane\'s import waits out a move: it would drop the plan under it', async () => {
    const { controller } = moveController();
    const running = controller.migrationPlan();
    assert.strictEqual((await controller.importPlan()).code, 'MIGRATION_BUSY');
    await running;
    controller.dispose();
  });

  it('a custom cases root with cases in it: planned and shown, but the move is refused', async () => {
    const elsewhere = tmp();
    fs.mkdirSync(path.join(elsewhere, 'north-field'));
    const { controller, state, client } = moveController({ extra: { env: { KL_CASES_ROOT: elsewhere } } });
    const planned = await controller.migrationPlan();
    assert.strictEqual(planned.ok, true, JSON.stringify(planned));
    assert.strictEqual(planned.backup.customCases, 1);
    assert.ok(planned.backup.customCasesRoot);
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.code, 'MIGRATION_SOURCE');
    assert.strictEqual(state.migration, null);
    assert.strictEqual(client.finishes, 0);
    controller.dispose();
  });

  it('a private chat moves private: the plan counts it and says what it needs; the node losing the mark is no marker', async () => {
    const client = new FakeNodeClient();
    client.loseMark = true;
    const { controller, state, userDataDir } = moveController({ client });
    const { HistoryStore } = require('../src/history');
    const store = HistoryStore.open(path.join(userDataDir, 'history.sqlite'));
    store.markPrivate('c1');
    store.close();
    const planned = await controller.migrationPlan();
    assert.strictEqual(planned.ok, true, JSON.stringify(planned));
    assert.strictEqual(planned.plan.private.chats, 1);
    assert.doesNotMatch(planned.plan.private.note, /PRIVATE_NO_LOCAL_MODEL/);
    assert.strictEqual(planned.plan.items.find((i) => i.key === 'c1').private, true);
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.code, 'MIGRATION_UNVERIFIED');
    assert.deepStrictEqual(out.verified.missing.map((m) => m.key), ['c1']);
    assert.strictEqual(state.migration, null);
    client.loseMark = false;
    client.chats.clear();
    await controller.migrationPlan();
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).ok, true);
    assert.ok(state.migration);
    controller.dispose();
  });

  it('what needs attention and the secrets left behind are plain data on the plan, the result and the marker', async () => {
    const client = new FakeNodeClient();
    client.attentionItems = [
      { category: 'settings', key: 'models', action: 'needs-attention', note: 'your 2 model profiles were not moved', targetKey: 'models' },
      { category: 'vault', key: 'github', action: 'needs-attention', note: 'secure storage is off', targetKey: 'github' },
      { category: 'providerToken', key: 'anthropic', action: 'needs-desktop', note: 'only the desktop', targetKey: 'anthropic' },
      { category: 'case', key: 'held\u202E', action: 'needs-attention', note: 'already there', targetKey: 'held' }
    ];
    client.finishExtra = { secretsMissing: [{ category: 'searchKey', key: 'brave' }], failures: [], attention: [{ category: 'chat', key: 'c1', note: 'its working directory was dropped' }] };
    const { controller, state } = moveController({ client });
    const planned = await controller.migrationPlan();
    assert.deepStrictEqual(planned.leftBehind.secrets.map((s) => s.key), ['github', 'anthropic']);
    assert.deepStrictEqual(planned.leftBehind.needsAttention.map((s) => s.key.slice(0, 4)), ['mode', 'held']);
    assert.ok(!JSON.stringify(planned.leftBehind).includes('\u202E'));
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(out.leftBehind.secrets.map((s) => s.key), ['github', 'anthropic', 'brave']);
    assert.ok(out.leftBehind.needsAttention.some((a) => a.key === 'c1'));
    assert.deepStrictEqual(state.migration.leftBehind, out.leftBehind);
    assert.deepStrictEqual((await controller.status()).migration.leftBehind, out.leftBehind);
    controller.dispose();
  });

  it('finding 4: a case the reader holds back refuses the move, named; its chats do not land', async () => {
    const client = new FakeNodeClient();
    const { controller, state, userDataDir } = moveController({ client });
    fs.mkdirSync(path.join(userDataDir, 'cases', 'held-case', 'clone', '.git'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'cases', 'held-case', 'clone', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(userDataDir, 'cases', 'held-case', 'case.yaml'), 'id: held-1\nslug: held-case\ntitle: Held\n');
    const planned = await controller.migrationPlan();
    assert.strictEqual(planned.ok, true, JSON.stringify(planned));
    assert.deepStrictEqual(planned.heldCases.map((h) => h.key), ['held-case']);
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.code, 'MIGRATION_SOURCE');
    assert.match(out.error, /held-case/);
    assert.strictEqual(state.migration, null);
    assert.strictEqual(client.finishes, 0);
    assert.strictEqual(client.chats.size, 0);
    controller.dispose();
  });

  it('finding 4: per-file refusals are counted on the plan and the result, and do not refuse the move', async () => {
    const realLoad = require('../src/ipc/desktop-export').loadDesktopSource;
    const { controller, state } = moveController({
      extra: { migrationDeps: { loadDesktopSource: async (args) => {
        const source = await realLoad(args);
        source.attention.push({ category: 'case', key: 'lakeside-lot/.kl/odd.bin', note: 'has 2 hard links' });
        return source;
      } } }
    });
    const planned = await controller.migrationPlan();
    assert.strictEqual(planned.refusedFiles, 1);
    assert.ok(planned.leftBehind.needsAttention.some((a) => a.key.endsWith('odd.bin')));
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.refusedFiles, 1);
    assert.ok(state.migration);
    controller.dispose();
  });

  it('fix round 2, finding 6: both reads of the backup report progress', async () => {
    const { controller, sent } = moveController();
    await controller.migrationPlan();
    const checksOf = () => sent.filter(([ch, p]) => ch === 'desktop:importProgress' && p.stage === 'backup-check');
    assert.strictEqual(checksOf().length, 0, 'the first plan made the backup and did not read it');
    await controller.migrationPlan();
    const onRetry = checksOf().length;
    assert.ok(onRetry > 0, 'a retry\'s read says so');
    const last = checksOf()[onRetry - 1][1];
    assert.ok(Number.isInteger(last.sent) && Number.isInteger(last.total));
    assert.strictEqual(last.sent, last.total);
    await controller.migrationApply({ confirmed: true });
    assert.ok(checksOf().length > onRetry, 'the read before the mark says so');
    controller.dispose();
  });

  it('fix round 2: an unverified move says what can help, not just to try again', async () => {
    const client = new FakeNodeClient({ dropChat: 'c2' });
    const { controller } = moveController({ client });
    await controller.migrationPlan();
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.code, 'MIGRATION_UNVERIFIED');
    assert.doesNotMatch(out.error, /; try again\.$/);
    assert.match(out.error, /each/i);
    controller.dispose();
  });

  it('finding 6: a backup that no longer reads whole refuses the mark, and the next plan makes a new one', async () => {
    let tick = 0;
    const { controller, state, parent } = moveController({ extra: { now: () => new Date(Date.UTC(2026, 10, 4, 10, 0, tick++)) } });
    const first = await controller.migrationPlan();
    const store = path.join(parent, backupsIn(parent)[0], 'history.sqlite');
    const bytes = fs.readFileSync(store);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(store, bytes);
    const out = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'BACKUP_FAILED');
    assert.match(out.error, /backup/i);
    assert.strictEqual(out.verified.ok, true);
    assert.strictEqual(state.migration, null);
    const second = await controller.migrationPlan();
    assert.notStrictEqual(second.backup.dest, first.backup.dest);
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).ok, true);
    assert.strictEqual(state.migration.backupDir.endsWith(path.basename(second.backup.dest)), true);
    controller.dispose();
  });

  it('the Detach warning on Windows says what Detach does there; off Windows it keeps its words', async () => {
    assert.strictEqual(DETACH_WARNING_WINDOWS, 'After detaching, this app has no King Louie to show: it opens on the setup screen until you attach it again. King Louie keeps running in the background, with its cron jobs and channels, and nothing is deleted.');
    assert.strictEqual(DETACH_WARNING, 'After detaching, this app runs its own King Louie again next to the service; its cron jobs and channels may act twice. Stop the service if you no longer want it.');
    const { controller } = moveController();
    assert.strictEqual((await controller.status()).detachWarning, DETACH_WARNING_WINDOWS);
    assert.deepStrictEqual(await controller.detach({}), { ok: false, code: 'CONFIRM_REQUIRED', error: DETACH_WARNING_WINDOWS });
    controller.dispose();
    const linux = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    assert.strictEqual((await linux.controller.status()).detachWarning, DETACH_WARNING);
    linux.controller.dispose();
  });

  it('status names the profile folder, for the screens that send the owner to it', async () => {
    const { controller, userDataDir } = moveController();
    assert.strictEqual((await controller.status()).profileDir, userDataDir);
    controller.dispose();
  });

  it('status.node names the launcher when the install wrote one, and only then', async () => {
    const pairing = { deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', service: { nodeId: 'kl-abc', publicKey: 'aa', port: 18796, hosting: 'personal', dataDir: 'C:\\Users\\Al Smith\\node\\data', pairedAt: '2026-11-04T10:00:00Z' } };
    const cli = 'C:\\Users\\Al Smith\\node\\king-louie-service.cmd';
    const asked = [];
    const there = moveController({ pairingRecord: pairing, extra: { cliExists: (p) => { asked.push(p); return true; } } });
    assert.strictEqual((await there.controller.status()).node.serviceCli, cli);
    assert.ok(asked.includes(cli));
    there.controller.dispose();
    const absent = moveController({ pairingRecord: pairing, extra: { cliExists: () => false } });
    assert.ok(!('serviceCli' in (await absent.controller.status()).node));
    absent.controller.dispose();
  });

  it('PROFILE_MIGRATED unless dev: standaloneOnce and detach', async () => {
    const marked = moveController();
    marked.state.setMigration({ at: '2026-11-04T10:00:00.000Z', backupDir: 'C:\\Users\\alex\\king-louie.backup-1', nodeDataDir: PERSONAL_DATA_DIR, nodeId: 'kl-abc', counts: {} });
    for (const out of [await marked.controller.standaloneOnce(), await marked.controller.detach({ confirmed: true }), await marked.controller.detach()]) {
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.code, 'PROFILE_MIGRATED');
      assert.match(out.error, /2026-11-04/);
      assert.match(out.error, /king-louie\.backup-1/);
    }
    assert.strictEqual(marked.state.mode, 'attached', 'detach changed nothing');
    assert.deepStrictEqual(marked.app.calls, []);
    marked.controller.dispose();

    const dev = moveController({ launch: { host: 'standalone', why: 'dev', degraded: false } });
    dev.state.setMigration({ at: '2026-11-04T10:00:00.000Z', backupDir: 'C:\\b', nodeDataDir: PERSONAL_DATA_DIR, nodeId: 'kl-abc', counts: {} });
    assert.strictEqual((await dev.controller.standaloneOnce()).ok, true);
    assert.strictEqual((await dev.controller.detach({ confirmed: true })).ok, true);
    dev.controller.dispose();
  });

  it('an unmigrated profile: the degraded path stays open, also after an unverified move', async () => {
    const client = new FakeNodeClient({ dropChat: 'c1' });
    const { controller, app } = moveController({ client });
    await controller.migrationPlan();
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).code, 'MIGRATION_UNVERIFIED');
    assert.strictEqual((await controller.standaloneOnce()).ok, true);
    assert.ok(app.calls.some(([name]) => name === 'relaunch'));
    controller.dispose();
  });

  it('a migrated profile is not moved again, whatever launched it', async () => {
    const { controller, state, parent, client } = moveController();
    state.setMigration({ at: '2026-11-04T10:00:00.000Z', backupDir: 'C:\\b', nodeDataDir: PERSONAL_DATA_DIR, nodeId: 'kl-abc', counts: {} });
    assert.strictEqual((await controller.migrationPlan()).code, 'PROFILE_MIGRATED');
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).code, 'PROFILE_MIGRATED');
    assert.deepStrictEqual(backupsIn(parent), []);
    assert.strictEqual(client.plans, 0);
    controller.dispose();
  });

  it('unpair keeps the marker, and desktop:status carries it with the backup path shown', async () => {
    const { controller, state } = moveController();
    state.setMigration({ at: '2026-11-04T10:00:00.000Z', backupDir: 'C:\\b\u202E', nodeDataDir: PERSONAL_DATA_DIR, nodeId: 'kl-abc', counts: { chats: 1 } });
    const status = await controller.status();
    assert.strictEqual(status.migration.at, '2026-11-04T10:00:00.000Z');
    assert.ok(!status.migration.backupDir.includes('\u202E'));
    controller.dispose();
    const second = moveController();
    second.state.setMigration({ at: '2026-11-04T10:00:00.000Z', backupDir: 'C:\\b', nodeDataDir: PERSONAL_DATA_DIR, nodeId: 'kl-abc', counts: {} });
    await second.controller.unpair();
    assert.ok(second.state.migration);
    second.controller.dispose();
  });
});

// --- Attach stage 2 §6.3: the controller walks the setup. ---

describe('desktop controller: the setup walk', () => {
  const renderServiceCliForTest = () => require('../src/service/personal-install').renderServiceCli({ nodePath: 'C:\\k.exe', entryPath: 'C:\\k.js' });
  const { openTempStore, seedChat } = require('./helpers/history-fixture');
  const NEEDS_NODE = { host: 'attached', why: 'needs-node', degraded: false };
  const ATTACHED = { host: 'attached', why: 'attached', degraded: false };

  function seedProfile(userDataDir, { chats = [['c1', 2]], settings = {} } = {}) {
    const temp = openTempStore();
    for (const [id, n] of chats) seedChat(temp.store, { id, messages: Array.from({ length: n }, (_, i) => ({ sender: 'user', text: `line ${i}` })) });
    temp.store.close();
    fs.copyFileSync(temp.dbPath, path.join(userDataDir, 'history.sqlite'));
    fs.rmSync(temp.dir, { recursive: true, force: true });
    fs.writeFileSync(path.join(userDataDir, 'chat-data.json'), JSON.stringify({ settings }));
  }

  // The fake clock, but for the one real wait: how long a step waits for the read.
  const READ_WAIT_MS = 30000;
  function walkTimers() {
    const fake = fakeTimers().extra;
    return {
      ...fake,
      oldProfileWaitMs: READ_WAIT_MS,
      setTimer: (fn, ms) => (ms === READ_WAIT_MS ? setTimeout(fn, ms) : fake.setTimer(fn, ms)),
      clearTimer: (h) => { clearTimeout(h); clearImmediate(h); }
    };
  }

  // A store on a temp profile, and a controller over it; `again` builds the next
  // launch's controller over the same state.
  function walk({ profile = true, seed = {}, launch = NEEDS_NODE, mode = 'standalone', runner = fakeRunner({ fresh: true, task: 'missing' }), client = null, pairingRecord = null, extra = {}, counted = true } = {}) {
    const parent = tmp();
    const userDataDir = path.join(parent, 'king-louie');
    fs.mkdirSync(userDataDir);
    if (profile) seedProfile(userDataDir, seed);
    const state = openDesktopState(userDataDir, fakeSafeStorage(), { storeFactory });
    state.setMode(mode);
    if (pairingRecord) state.setPairing(pairingRecord);
    const app = fakeApp();
    const reads = { count: 0 };
    const { detectOldProfile } = require('../src/migration/profile-backup');
    const detect = async (dir, opts) => { reads.count += 1; return detectOldProfile(dir, opts); };
    const build = (over = {}) => {
      const made = createDesktopController({
        state, mode: over.mode || mode, app, getWindow: () => null,
        env: {}, platform: 'win32', userDataDir, safeStorage: fakeSafeStorage(), stdout: { write() {} },
        argv: ['electron', '.'], username: 'alex', launch: over.launch || launch, nodeRunner: runner,
        ...walkTimers(),
        migrationDeps: counted ? { detectOldProfile: detect } : {},
        ...extra
      });
      const liveClient = 'client' in over ? over.client : client;
      if (liveClient) {
        made.setClient(liveClient);
        if (liveClient.connected) liveClient.emit('state', { status: 'connected', code: null, error: null, nextRetryAt: null });
      }
      return made;
    };
    const controller = build();
    return { controller, build, state, app, runner, client, reads, userDataDir, parent };
  }
  // A node that answers the setup's own reads as well as the import.
  function nodeClient({ providersConfigured = true, userProfile = { name: 'Alex', role: 'Owner' }, ...rest } = {}) {
    const client = new FakeNodeClient(rest);
    client.service.providersConfigured = providersConfigured;
    client.userProfile = userProfile;
    client.connect = async () => client.service;
    const invoke = client.invoke.bind(client);
    client.invoke = async (channel, args) => (channel === 'settings:load' ? { ok: true, userProfile: client.userProfile } : invoke(channel, args));
    return client;
  }
  const attachedWalk = (opts = {}) => walk({ launch: ATTACHED, mode: 'attached', pairingRecord: personalPairing(), runner: fakeRunner({ running: true }), client: nodeClient(), ...opts });
  const ids = (answer) => answer.actions.map((a) => a.id);

  it('a fresh machine is at install, and the install moves it to pair', async () => {
    const runner = fakeRunner({ fresh: true, task: 'missing', cli: (args) => {
      if (args.includes('--yes')) { runner.task = 'registered'; runner.node = { personal: true, name: 'laptop-01', dataDir: PERSONAL_DATA_DIR, me: OWNER_SID }; }
      return { code: 0, stdout: 'would do this\n', stderr: '', json: null };
    } });
    const { controller } = walk({ runner, profile: false });
    const first = await controller.setupStep();
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.step, 'install');
    assert.deepStrictEqual(ids(first), ['nodeInstallPreview']);
    const status = await controller.status();
    assert.strictEqual(status.node.fresh, true);
    assert.strictEqual(status.platform, 'win32');
    assert.deepStrictEqual(status.launch, NEEDS_NODE);
    assert.strictEqual(status.setup.step, 'install');
    assert.strictEqual(status.setup.completedAt, null);

    assert.strictEqual((await controller.nodeInstallPreview()).ok, true);
    const previewed = await controller.setupStep();
    assert.deepStrictEqual(ids(previewed), ['nodeInstall']);
    assert.match(previewed.pre, /would do this/);

    assert.strictEqual((await controller.nodeInstall({ confirmed: true })).ok, true);
    assert.strictEqual(runner.task, 'registered');
    const paired = await controller.setupStep();
    assert.strictEqual(paired.step, 'pair');
    assert.deepStrictEqual(ids(paired), ['pairStart']);
    controller.dispose();
  });

  it('a fleet machine reads NOT_PERSONAL, and a refused install on a fresh machine shows its refusal', async () => {
    const fleet = walk({ runner: fakeRunner({ personal: false }), profile: false });
    assert.strictEqual((await fleet.controller.setupStep()).error.code, 'NOT_PERSONAL');
    fleet.controller.dispose();

    const refused = walk({ runner: fakeRunner({ fresh: true, task: 'missing', cli: () => ({ code: 1, stdout: '', stderr: 'no room on the disk\n', json: null }) }), profile: false });
    await refused.controller.nodeInstallPreview();
    const answer = await refused.controller.setupStep();
    assert.strictEqual(answer.error.code, 'NODE_INSTALL_FAILED');
    assert.match(answer.error.message, /no room on the disk/);
    refused.controller.dispose();
  });

  it('install --personal elevated is the elevated answer, and Check again clears it', async () => {
    const runner = fakeRunner({ fresh: true, task: 'missing', cli: () => ({ code: 2, stdout: '', stderr: 'install --personal runs as you, not elevated: open a normal prompt\n', json: null }) });
    const { controller } = walk({ runner, profile: false });
    await controller.nodeInstallPreview();
    assert.strictEqual((await controller.status()).elevated, true);
    const answer = await controller.setupStep();
    assert.strictEqual(answer.error.code, 'PAIR_ELEVATED');
    assert.deepStrictEqual(ids(answer), ['retry']);
    assert.deepStrictEqual(await controller.retry(), { ok: true });
    const after = await controller.setupStep();
    assert.strictEqual(after.error, null);
    assert.deepStrictEqual(ids(after), ['nodeInstallPreview']);
    controller.dispose();
  });

  it('Check again clears a PAIR_ELEVATED pending pair, so the step is not stuck on it', async () => {
    const runner = fakeRunner({ cli: () => ({ code: 1, stdout: '', stderr: '', json: { ok: false, code: 'PAIR_ELEVATED', message: 'runs as you' } }) });
    const { controller, state } = walk({ runner, profile: false });
    await controller.pairStart();
    assert.strictEqual((await controller.setupStep()).error.code, 'PAIR_ELEVATED');
    assert.ok(state.pendingPair);
    await controller.retry();
    assert.strictEqual(state.pendingPair, null);
    const after = await controller.setupStep();
    assert.strictEqual(after.step, 'pair');
    assert.deepStrictEqual(ids(after), ['pairStart']);
    controller.dispose();
  });

  it('pairing from the setup ends attached, with a relaunch; from the pane it stays as it was', async () => {
    const svc = await startService();
    const made = walk({ runner: fakeRunner({ cli: pairingCli(svc), trust: trustedRecord(svc.port) }), profile: false });
    const out = await made.controller.pairStart();
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(made.state.mode, 'attached', JSON.stringify(out.pendingPair));
    assert.ok(made.state.pairing);
    assert.ok(made.app.calls.some(([name]) => name === 'relaunch'));
    made.controller.dispose();

    const pane = walk({ launch: { host: 'standalone', why: 'dev', degraded: false }, runner: fakeRunner({ cli: pairingCli(svc), trust: trustedRecord(svc.port) }), profile: false });
    const paned = await pane.controller.pairStart();
    assert.strictEqual(paned.view, 'paired');
    assert.strictEqual(pane.state.mode, 'standalone');
    assert.deepStrictEqual(pane.app.calls, []);
    pane.controller.dispose();
  });

  it('attached and connected over a profile with chats is at migrate, then provider, profile, phone, done', async () => {
    const client = nodeClient({ providersConfigured: false, userProfile: { name: '', role: '', goals: [], preferences: {}, projectContext: '' } });
    const { controller, state, runner } = attachedWalk({ client });
    const migrate = await controller.setupStep();
    assert.strictEqual(migrate.step, 'migrate');
    assert.deepStrictEqual(ids(migrate), ['migrationPlan', 'setupLater']);
    assert.strictEqual((await controller.migrationPlan()).ok, true);
    const planned = await controller.setupStep();
    assert.ok(ids(planned).includes('migrationApply'));

    const applied = await controller.migrationApply({ confirmed: true });
    assert.strictEqual(applied.ok, true, JSON.stringify(applied));
    assert.ok(state.migration);
    await controller.startIdle();
    client.goLive?.();
    const provider = await controller.setupStep();
    assert.strictEqual(provider.step, 'provider');
    assert.match(provider.lines.join('\n'), /moved into King Louie Node/);

    // The form saves through the proxied channel; the next step reads it anew.
    client.service.providersConfigured = true;
    const profile = await controller.setupStep();
    assert.strictEqual(profile.step, 'profile');

    client.userProfile = { name: 'Alex', role: 'Owner', goals: [], preferences: {}, projectContext: '' };
    const phone = await controller.setupStep();
    assert.strictEqual(phone.step, 'phone');
    assert.strictEqual(state.setup.phoneOffered, true);

    assert.strictEqual((await controller.setupFinish({ skip: 'phone' })).step, 'done');
    assert.strictEqual(state.setup.phoneSeen, true);
    const finished = await controller.setupFinish();
    assert.strictEqual(finished.ok, true);
    assert.ok(state.setup.completedAt);
    assert.strictEqual((await controller.setupStep()).step, 'done');
    assert.strictEqual((await controller.status()).setup.step, 'done');
    assert.ok(runner.calls.length);
    controller.dispose();
  });

  it('a verified apply restarts the node, so its channels and MCP servers come up; a failed one does not', async () => {
    const good = attachedWalk();
    await good.controller.migrationPlan();
    assert.strictEqual((await good.controller.migrationApply({ confirmed: true })).ok, true);
    await good.controller.startIdle();
    assert.strictEqual(good.runner.calls.filter(([c]) => c === 'stopNode').length, 1);
    assert.strictEqual(good.runner.calls.filter(([c]) => c === 'runTask').length, 1);
    good.controller.dispose();

    const bad = attachedWalk({ client: nodeClient({ dropChat: 'c1' }) });
    await bad.controller.migrationPlan();
    assert.strictEqual((await bad.controller.migrationApply({ confirmed: true })).code, 'MIGRATION_UNVERIFIED');
    await bad.controller.startIdle();
    assert.ok(!bad.runner.calls.some(([c]) => c === 'stopNode' || c === 'runTask'));
    bad.controller.dispose();
  });

  it('setupLater relaunches once while unmigrated, is PROFILE_MIGRATED after, NOT_POSTPONABLE on an empty profile', async () => {
    const { STANDALONE_ONCE } = require('../src/ipc/desktop-controller');
    const later = walk();
    const out = await later.controller.setupLater();
    assert.strictEqual(out.ok, true);
    const relaunch = later.app.calls.find(([name]) => name === 'relaunch');
    assert.ok(relaunch[1].args.includes(STANDALONE_ONCE));
    later.state.setMigration({ at: '2026-11-04T10:00:00.000Z', backupDir: 'C:\\b', nodeId: 'kl-abc' });
    assert.strictEqual((await later.controller.setupLater()).code, 'PROFILE_MIGRATED');
    later.controller.dispose();

    const empty = walk({ profile: false });
    const refused = await empty.controller.setupLater();
    assert.strictEqual(refused.code, 'NOT_POSTPONABLE');
    assert.deepStrictEqual(empty.app.calls, []);
    assert.strictEqual((await empty.controller.setupStep()).error.code, 'NOT_POSTPONABLE');
    empty.controller.dispose();
  });

  it('a failed move can be put off into the standalone mode and tried again at the next launch', async () => {
    const client = nodeClient({ dropChat: 'c1' });
    const made = attachedWalk({ client });
    await made.controller.migrationPlan();
    await made.controller.migrationApply({ confirmed: true });
    const failed = await made.controller.setupStep();
    assert.strictEqual(failed.error.code, 'MIGRATION_UNVERIFIED');
    assert.ok(ids(failed).includes('setupLater'));
    assert.strictEqual((await made.controller.setupLater()).ok, true);
    made.controller.dispose();

    client.dropChat = null;
    const next = made.build();
    assert.strictEqual((await next.setupStep()).step, 'migrate');
    assert.strictEqual((await next.migrationPlan()).ok, true);
    assert.strictEqual((await next.migrationApply({ confirmed: true })).ok, true);
    await next.startIdle();
    next.dispose();
  });

  it('the old profile is read once per launch, again after Check again, and again after an apply', async () => {
    const made = attachedWalk();
    const { controller, reads } = made;
    await controller.setupStep();
    await controller.setupStep();
    await controller.status();
    assert.strictEqual(reads.count, 1);
    await controller.retry();
    assert.strictEqual(reads.count, 1, 'the next step reads, not the press');
    await controller.setupStep();
    assert.strictEqual(reads.count, 2);
    await controller.migrationPlan();
    assert.strictEqual(reads.count, 3, 'a plan reads what is there now');
    await controller.setupStep();
    assert.strictEqual(reads.count, 3, 'and that answers the step');
    await controller.migrationApply({ confirmed: true });
    await controller.startIdle();
    await controller.setupStep();
    assert.strictEqual(reads.count, 4);
    controller.dispose();
  });

  it('nothing reads the old profile where no setup is shown', async () => {
    for (const opts of [
      { launch: { host: 'standalone', why: 'dev', degraded: false } },
      { launch: { host: 'standalone', why: 'once', degraded: true } },
      { launch: ATTACHED, mode: 'attached', pairingRecord: pairedRecord(), client: nodeClient({ hosting: 'service' }) }
    ]) {
      const made = walk(opts);
      assert.strictEqual((await made.controller.setupStep()).step, 'done');
      await made.controller.status();
      assert.strictEqual(made.reads.count, 0, JSON.stringify(opts.launch));
      made.controller.dispose();
    }
    const finished = attachedWalk();
    finished.state.setSetup({ completedAt: '2026-11-04T10:00:00.000Z' });
    assert.strictEqual((await finished.controller.setupStep()).step, 'done');
    assert.strictEqual(finished.reads.count, 0);
    finished.controller.dispose();
  });

  it('a read that is slow answers with a line and no press, never a step past the move', async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const made = attachedWalk({ counted: false, extra: { setTimer: setTimeout, clearTimer: clearTimeout, clock: Date.now, oldProfileWaitMs: 5, migrationDeps: { detectOldProfile: () => held } } });
    const changed = [];
    made.controller.on('changed', () => changed.push(1));
    const answer = await made.controller.setupStep();
    assert.strictEqual(answer.step, 'migrate');
    assert.deepStrictEqual(ids(answer), ['retry']);
    assert.match(answer.lines[0], /earlier/);
    assert.strictEqual((await made.controller.status()).oldProfile, null);
    release({ found: false, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: null, customCasesRoot: null, customCases: 0 });
    await new Promise((r) => setImmediate(r));
    assert.ok(changed.length, 'the window is told when it is known');
    assert.strictEqual((await made.controller.setupStep()).step, 'phone');
    made.controller.dispose();
  });

  it('a read that throws is a problem on screen, never nothing to move', async () => {
    const made = attachedWalk({ extra: { migrationDeps: { detectOldProfile: async () => { throw new Error('the child went away'); } } } });
    const answer = await made.controller.setupStep();
    assert.strictEqual(answer.step, 'migrate');
    assert.match(answer.error.message, /the child went away/);
    assert.deepStrictEqual(ids(answer), ['retry', 'skip']);
    made.controller.dispose();
  });

  it('skip names the step it was pressed on: a press arriving twice does not skip the next one', async () => {
    const made = attachedWalk({ counted: false, extra: { migrationDeps: { detectOldProfile: async () => ({ found: true, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: 'unreadable', customCasesRoot: null, customCases: 0 }) } } });
    const { controller, state } = made;
    assert.strictEqual((await controller.setupStep()).step, 'migrate');
    const [one, two] = await Promise.all([controller.setupFinish({ skip: 'migrate' }), controller.setupFinish({ skip: 'migrate' })]);
    assert.strictEqual(one.step, 'phone');
    assert.strictEqual(two.step, 'phone');
    assert.ok(!state.setup || !state.setup.phoneSeen);
    assert.strictEqual((await controller.setupFinish({ skip: 'phone' })).step, 'done');
    assert.strictEqual(state.setup.phoneSeen, true);
    // A step with nothing to skip stays where it is.
    assert.strictEqual((await controller.setupFinish({ skip: 'phone' })).step, 'done');
    controller.dispose();
  });

  it('setupFinish cannot jump the steps before the wizard, and keeps the first completedAt', async () => {
    const early = walk();
    const refused = await early.controller.setupFinish();
    assert.strictEqual(refused.code, 'SETUP_NOT_DONE');
    assert.strictEqual(early.state.setup, null);
    early.controller.dispose();

    const unmoved = attachedWalk();
    assert.strictEqual((await unmoved.controller.setupFinish()).code, 'SETUP_NOT_DONE');
    unmoved.controller.dispose();

    const clock = [new Date('2026-11-04T10:00:00.000Z'), new Date('2026-11-04T11:00:00.000Z')];
    const done = attachedWalk({ profile: false, extra: { now: () => clock.shift() } });
    await done.controller.setupStep();
    const first = done.controller.setupFinish();
    const second = done.controller.setupFinish();
    await Promise.all([first, second]);
    assert.strictEqual(done.state.setup.completedAt, '2026-11-04T10:00:00.000Z');
    done.controller.dispose();
  });

  it('a press arriving twice runs the one thing once', async () => {
    let installs = 0;
    const runner = fakeRunner({ fresh: true, task: 'missing', cli: () => { installs += 1; return { code: 0, stdout: 'x', stderr: '', json: null }; } });
    const { controller } = walk({ runner, profile: false });
    await Promise.all([controller.nodeInstallPreview(), controller.nodeInstallPreview()]);
    assert.strictEqual(installs, 1);
    await Promise.all([controller.nodeInstall({ confirmed: true }), controller.nodeInstall({ confirmed: true })]);
    assert.strictEqual(installs, 2);
    controller.dispose();

    const pairs = fakeRunner({ cli: () => ({ code: 1, stdout: '', stderr: '', json: { ok: false, code: 'PERSONAL_NOT_OWNER', message: 'no' } }) });
    const pair = walk({ runner: pairs, profile: false });
    await Promise.all([pair.controller.pairStart(), pair.controller.pairStart()]);
    assert.strictEqual(pairs.calls.filter(([c]) => c === 'runCli').length, 1);
    pair.controller.dispose();

    const later = walk();
    await Promise.all([later.controller.setupLater(), later.controller.setupLater()]);
    assert.strictEqual(later.app.calls.filter(([name]) => name === 'relaunch').length, 1);
    later.controller.dispose();

    const moved = attachedWalk();
    const [a, b] = await Promise.all([moved.controller.migrationPlan(), moved.controller.migrationPlan()]);
    assert.strictEqual(a, b);
    assert.strictEqual(moved.client.plans, 1);
    moved.controller.dispose();
  });

  it('an apply pressed twice moves once and restarts once', async () => {
    const made = attachedWalk();
    await made.controller.migrationPlan();
    const [a, b] = await Promise.all([made.controller.migrationApply({ confirmed: true }), made.controller.migrationApply({ confirmed: true })]);
    assert.strictEqual(a, b);
    assert.strictEqual(a.ok, true);
    await made.controller.startIdle();
    assert.strictEqual(made.runner.calls.filter(([c]) => c === 'stopNode').length, 1);
    made.controller.dispose();
  });

  it('while the node restarts after the move the step has no press, and a restart that fails says what it means', async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const runner = fakeRunner({ running: true, stop: () => ({ ok: false, code: 'NODE_STOP_FAILED', message: 'stop did not finish' }) });
    const stopNode = runner.stopNode.bind(runner);
    runner.stopNode = async (a) => { await held; return stopNode(a); };
    const made = attachedWalk({ runner });
    await made.controller.migrationPlan();
    assert.strictEqual((await made.controller.migrationApply({ confirmed: true })).ok, true);
    const during = await made.controller.setupStep();
    assert.deepStrictEqual(during.actions, []);
    assert.match(during.lines.join(' '), /[Rr]estart/);
    release();
    await made.controller.startIdle();
    const after = await made.controller.setupStep();
    assert.strictEqual(after.step, 'phone');
    assert.ok(after.actions.length);
    assert.match(after.error.message, /stop did not finish/);
    assert.match(after.error.message, /next time/);
    made.controller.dispose();
  });

  it('a standalone window finishes nothing, and neither a Finish nor a Skip lands during a move', async () => {
    const dev = walk({ launch: { host: 'standalone', why: 'dev', degraded: false } });
    assert.strictEqual((await dev.controller.setupFinish()).ok, true);
    assert.strictEqual(dev.state.setup, null);
    dev.controller.dispose();

    let release;
    const held = new Promise((r) => { release = r; });
    const { backupProfile } = require('../src/migration/profile-backup');
    const made = attachedWalk({ extra: { migrationDeps: { backupProfile: async (args) => { await held; return backupProfile(args); } } }, counted: false });
    const planning = made.controller.migrationPlan();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual((await made.controller.setupFinish({ skip: 'migrate' })).code, 'MIGRATION_BUSY');
    assert.strictEqual((await made.controller.setupFinish()).code, 'MIGRATION_BUSY');
    release();
    await planning;
    assert.strictEqual((await made.controller.status()).setup.migrateSkipped, false);
    made.controller.dispose();
  });

  it('while a plan runs, a status answers and the step says so with no press', async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const { backupProfile } = require('../src/migration/profile-backup');
    const made = attachedWalk({ extra: { migrationDeps: { backupProfile: async (args) => { await held; return backupProfile(args); } } }, counted: false });
    const planning = made.controller.migrationPlan();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual((await made.controller.status()).ok, true);
    const busy = await made.controller.setupStep();
    assert.deepStrictEqual(busy.actions, []);
    assert.ok(busy.lines.length === 1);
    assert.strictEqual((await made.controller.migrationApply({ confirmed: true })).code, 'MIGRATION_BUSY');
    assert.strictEqual((await made.controller.setupLater()).code, 'MIGRATION_BUSY');
    release();
    assert.strictEqual((await planning).ok, true);
    assert.ok(ids(await made.controller.setupStep()).includes('migrationApply'), 'a refused second press leaves the plan on screen');
    made.controller.dispose();
  });

  it('the node dying during the move: start while it is down, then the failure and a new plan', async () => {
    const client = nodeClient();
    const made = attachedWalk({ client });
    await made.controller.migrationPlan();
    const realCall = client.call.bind(client);
    const realInvoke = client.invoke.bind(client);
    const gone = () => Object.assign(new Error('The local King Louie service is not reachable.'), { code: 'SERVICE_UNREACHABLE' });
    client.invoke = async () => { throw gone(); };
    client.call = async (method) => {
      if (method === 'import.apply') {
        client.connected = false;
        client.emit('state', { status: 'disconnected', code: 'SERVICE_UNREACHABLE', error: 'not reachable', nextRetryAt: null });
      }
      throw gone();
    };
    const out = await made.controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.code, 'SERVICE_UNREACHABLE');
    assert.strictEqual(made.state.migration, null);
    assert.ok(!made.runner.calls.some(([c]) => c === 'stopNode'));
    assert.strictEqual((await made.controller.setupStep()).step, 'start');

    client.call = realCall;
    client.invoke = realInvoke;
    client.connected = true;
    client.emit('state', { status: 'connected', code: null, error: null, nextRetryAt: null });
    const back = await made.controller.setupStep();
    assert.strictEqual(back.step, 'migrate');
    assert.strictEqual(back.error.code, 'SERVICE_UNREACHABLE');
    assert.ok(ids(back).includes('migrationPlan'));
    assert.strictEqual((await made.controller.migrationPlan()).ok, true);
    assert.strictEqual((await made.controller.migrationApply({ confirmed: true })).ok, true);
    await made.controller.startIdle();
    made.controller.dispose();
  });

  it('a drop forgets a plan the node no longer holds, and the apply says it expired', async () => {
    const client = nodeClient();
    const { controller } = attachedWalk({ client });
    await controller.migrationPlan();
    client.connected = false;
    client.emit('state', { status: 'disconnected', code: 'SERVICE_UNREACHABLE', error: 'not reachable', nextRetryAt: null });
    client.connected = true;
    client.emit('state', { status: 'connected', code: null, error: null, nextRetryAt: null });
    assert.deepStrictEqual(ids(await controller.setupStep()), ['migrationPlan', 'setupLater']);
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).code, 'PLAN_EXPIRED');
    controller.dispose();
  });

  it('a relaunch at each step comes back to that step', async () => {
    // After the install: the task and node.yaml are there.
    const installed = walk({ runner: fakeRunner({ task: 'registered' }) });
    const relaunched = installed.build();
    assert.strictEqual((await relaunched.setupStep()).step, 'pair');
    installed.controller.dispose();
    relaunched.dispose();

    // In the middle of pairing: says so, runs nothing by itself.
    const pairing = walk({ runner: fakeRunner({ cli: () => ({ code: 1, stdout: '', stderr: '', json: { ok: false, code: 'X', message: 'y' } }) }) });
    await pairing.controller.pairStart();
    pairing.controller.dispose();
    const cliBefore = pairing.runner.calls.filter(([c]) => c === 'runCli').length;
    const midPair = pairing.build();
    const midAnswer = await midPair.setupStep();
    assert.strictEqual(midAnswer.step, 'pair');
    assert.strictEqual(midAnswer.error.code, 'PAIR_COMMAND_FAILED');
    assert.strictEqual(pairing.runner.calls.filter(([c]) => c === 'runCli').length, cliBefore);
    midPair.dispose();

    // Paired, the relaunch into attached lost: Attach is the one press.
    const paired = walk({ runner: fakeRunner({ running: true }), pairingRecord: personalPairing() });
    const pairedAnswer = await paired.controller.setupStep();
    assert.strictEqual(pairedAnswer.step, 'pair');
    assert.ok(ids(pairedAnswer).includes('attach'));
    paired.controller.dispose();

    // Attached with the node down.
    const down = attachedWalk({ client: new FakeAttachedClient(), runner: fakeRunner() });
    assert.strictEqual((await down.controller.setupStep()).step, 'start');
    down.controller.dispose();

    // A plan on screen does not outlive the launch; the backup is made again.
    const planned = attachedWalk();
    await planned.controller.migrationPlan();
    planned.controller.dispose();
    const next = planned.build();
    const answer = await next.setupStep();
    assert.strictEqual(answer.step, 'migrate');
    assert.deepStrictEqual(ids(answer), ['migrationPlan', 'setupLater']);
    next.dispose();

    // Moved: the marker holds, and the phone step once offered stays offered.
    const moved = attachedWalk();
    await moved.controller.migrationPlan();
    await moved.controller.migrationApply({ confirmed: true });
    await moved.controller.startIdle();
    assert.strictEqual((await moved.controller.setupStep()).step, 'phone');
    moved.controller.dispose();
    const stopped = nodeClient();
    stopped.connected = false;
    const after = moved.build({ client: stopped });
    assert.strictEqual((await after.setupStep()).step, 'phone', 'stopping the node is its first instruction');
    after.dispose();
  });

  it('the custom-root instruction works: do what the screen says, press Check again, and the cases move', async () => {
    const outside = tmp();
    fs.mkdirSync(path.join(outside, 'lakeside-lot'));
    fs.writeFileSync(path.join(outside, 'lakeside-lot', 'case.yaml'), 'id: case-lot\nslug: lakeside-lot\ntitle: Lakeside lot\n');
    fs.mkdirSync(path.join(outside, '.index'));
    fs.writeFileSync(path.join(outside, '.index', 'bm25.json'), '{}');
    const client = nodeClient();
    const made = attachedWalk({ client, seed: { settings: { cases: { root: outside } } }, counted: false });
    const { controller, userDataDir, state, parent } = made;

    const before = await controller.setupStep();
    assert.strictEqual(before.step, 'migrate');
    assert.strictEqual(before.error.code, 'MIGRATION_SOURCE');
    assert.ok(before.error.message.includes(path.join(userDataDir, 'cases')), before.error.message);
    assert.deepStrictEqual(ids(before), ['retry', 'setupLater']);
    // The plan refuses too, and makes a backup that does not hold the case.
    const refusedPlan = await controller.migrationPlan();
    assert.strictEqual(refusedPlan.ok, true);
    assert.strictEqual(refusedPlan.backup.customCases, 1);
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).code, 'MIGRATION_SOURCE');
    await controller.retry();

    // What the screen says, as the owner would do it: the folder, not the index.
    fs.mkdirSync(path.join(userDataDir, 'cases'));
    fs.renameSync(path.join(outside, 'lakeside-lot'), path.join(userDataDir, 'cases', 'lakeside-lot'));

    const after = await controller.setupStep();
    assert.strictEqual(after.error, null, JSON.stringify(after.error));
    assert.deepStrictEqual(ids(after), ['migrationPlan', 'setupLater']);
    assert.match(after.lines[0], /1 case\b/);
    const plan = await controller.migrationPlan();
    assert.strictEqual(plan.ok, true, JSON.stringify(plan));
    assert.ok(plan.plan.items.some((i) => i.category === 'case' && i.key === 'lakeside-lot' && i.action === 'new'), JSON.stringify(plan.plan.items));
    assert.ok(!plan.leftBehind.needsAttention.some((a) => String(a.note).includes('custom')), 'no word of a root that holds nothing');
    // The backup taken before the move of the folder does not hold it: a new one does.
    const manifest = JSON.parse(fs.readFileSync(path.join(plan.backup.dest, 'backup.json'), 'utf8'));
    assert.ok(manifest.files.some((f) => f.path.includes('lakeside-lot')), 'the backup holds the moved case');
    assert.ok(fs.readdirSync(parent).filter((n) => n.startsWith('king-louie.backup-')).length >= 1);
    assert.ok(ids(await controller.setupStep()).includes('migrationApply'));
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).ok, true);
    assert.ok(client.cases.has('lakeside-lot'));
    assert.ok(state.migration);
    await controller.startIdle();
    controller.dispose();
  });

  // The review's walk: a root holding a case, the drive pulled.
  function unpluggedWalk() {
    const outside = path.join(tmp(), 'cases-on-a-drive');
    fs.mkdirSync(path.join(outside, 'lakeside-lot'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'lakeside-lot', 'case.yaml'), 'id: case-lot\nslug: lakeside-lot\ntitle: Lakeside lot\n');
    const pulled = `${outside}-pulled`;
    fs.renameSync(outside, pulled);
    const client = nodeClient();
    const call = client.call.bind(client);
    client.call = async (method, params) => {
      if (method === 'import.plan') client.plannedRoot = params.inventory.customCasesRoot;
      return call(method, params);
    };
    const made = attachedWalk({ client, seed: { settings: { cases: { root: outside } } }, counted: false });
    return { ...made, client, outside, pulled };
  }

  it('a custom root on a drive not plugged in: the screen says so, nothing is marked, and the case moves refused until it is back', async () => {
    const { controller, state, client, outside, pulled } = unpluggedWalk();
    const first = await controller.setupStep();
    assert.strictEqual(first.step, 'migrate');
    assert.match(first.error.message, /is not there/);
    const planned = await controller.migrationPlan();
    assert.strictEqual(planned.ok, true);
    assert.strictEqual(client.plannedRoot, outside, 'the node is told, so its plan keeps its needs-attention line');
    const screen = await controller.setupStep();
    assert.ok(!ids(screen).includes('migrationApply'));
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).code, 'MIGRATION_SOURCE');
    assert.strictEqual(state.migration, null);

    // Plugged back in: it holds a case, so the old refusal stands.
    fs.renameSync(pulled, outside);
    await controller.retry();
    const back = await controller.setupStep();
    assert.match(back.error.message, /1 case is kept in/);
    assert.strictEqual(state.migration, null);
    controller.dispose();
  });

  it('a custom root no longer used: an empty folder at that path lets the move go on', async () => {
    const { controller, state, outside } = unpluggedWalk();
    await controller.setupStep();
    fs.mkdirSync(outside);
    await controller.retry();
    const after = await controller.setupStep();
    assert.strictEqual(after.error, null, JSON.stringify(after.error));
    assert.strictEqual((await controller.migrationPlan()).ok, true);
    assert.strictEqual((await controller.migrationApply({ confirmed: true })).ok, true);
    assert.ok(state.migration);
    await controller.startIdle();
    controller.dispose();
  });

  it('the count is taken again before the mark: a root that went away or filled up after the plan marks nothing', async () => {
    for (const change of [(root) => fs.rmSync(root, { recursive: true }), (root) => fs.mkdirSync(path.join(root, 'late-case'))]) {
      const outside = tmp();
      const client = nodeClient();
      const made = attachedWalk({ client, seed: { settings: { cases: { root: outside } } }, counted: false });
      assert.strictEqual((await made.controller.migrationPlan()).ok, true);
      change(outside);
      const out = await made.controller.migrationApply({ confirmed: true });
      assert.strictEqual(out.code, 'MIGRATION_SOURCE', JSON.stringify(out));
      assert.strictEqual(made.state.migration, null);
      assert.ok(!made.runner.calls.some(([c]) => c === 'stopNode'));
      fs.mkdirSync(outside, { recursive: true });
      made.controller.dispose();
    }

    // Between the landing and the mark.
    const outside = tmp();
    const client = nodeClient();
    const made = attachedWalk({ client, seed: { settings: { cases: { root: outside } } }, counted: false });
    await made.controller.migrationPlan();
    const realInvoke = client.invoke.bind(client);
    client.invoke = async (channel, args) => {
      if (fs.existsSync(outside)) fs.rmSync(outside, { recursive: true });
      return realInvoke(channel, args);
    };
    const out = await made.controller.migrationApply({ confirmed: true });
    assert.strictEqual(out.code, 'MIGRATION_SOURCE', JSON.stringify(out));
    assert.strictEqual(made.state.migration, null);
    fs.mkdirSync(outside, { recursive: true });
    made.controller.dispose();
  });

  it('Skip for now finishes this launch only: nothing is written, and the move is offered at the next', async () => {
    const failing = { detectOldProfile: async () => ({ found: true, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: 'the reader ended with code 1', customCasesRoot: null, customCases: 0 }) };
    const made = attachedWalk({ counted: false, extra: { migrationDeps: failing } });
    const { controller, state } = made;
    assert.strictEqual((await controller.setupStep()).step, 'migrate');
    await controller.setupFinish({ skip: 'migrate' });
    await controller.setupFinish({ skip: 'phone' });
    assert.strictEqual((await controller.setupStep()).step, 'done');
    const finished = await controller.setupFinish();
    assert.strictEqual(finished.ok, true);
    assert.strictEqual(finished.step, 'done');
    assert.deepStrictEqual(finished.actions, [], 'nothing left to draw this launch');
    assert.strictEqual(state.setup.completedAt, undefined);
    assert.strictEqual((await controller.status()).setup.finishedForNow, true);
    controller.dispose();

    const next = made.build();
    assert.strictEqual((await next.setupStep()).step, 'migrate');
    assert.strictEqual((await next.status()).setup.finishedForNow, false);
    next.dispose();
  });

  it('NOT_POSTPONABLE on a profile that failed to read says that, and not that nothing is here', async () => {
    const made = attachedWalk({ counted: false, extra: { migrationDeps: { detectOldProfile: async () => ({ found: true, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: 'bad', customCasesRoot: null, customCases: 0 }) } } });
    const out = await made.controller.setupLater();
    assert.strictEqual(out.code, 'NOT_POSTPONABLE');
    assert.match(out.error, /could not be read/);
    assert.doesNotMatch(out.error, /nothing on this computer/);
    made.controller.dispose();
  });

  it('three presses on a read that hangs leave one child: Check again joins the read in flight', async () => {
    let count = 0;
    const answers = [];
    const detect = () => { count += 1; return new Promise((r) => answers.push(r)); };
    const made = attachedWalk({ counted: false, extra: { setTimer: setTimeout, clearTimer: clearTimeout, clock: Date.now, oldProfileWaitMs: 5, migrationDeps: { detectOldProfile: detect } } });
    const hung = await made.controller.setupStep();
    assert.deepStrictEqual(ids(hung), ['retry']);
    for (let i = 0; i < 3; i += 1) {
      await made.controller.retry();
      await made.controller.setupStep();
    }
    assert.strictEqual(count, 1);
    answers[0]({ found: false, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: null, customCasesRoot: null, customCases: 0 });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual((await made.controller.setupStep()).step, 'phone');
    // With the read landed, the next press reads again.
    await made.controller.retry();
    await made.controller.setupStep();
    assert.strictEqual(count, 2);
    answers[1]({ found: false, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: null, customCasesRoot: null, customCases: 0 });
    await new Promise((r) => setImmediate(r));
    made.controller.dispose();
  });

  it('a new plan takes back Skip for now: finished for this launch ends, and the move is the step again', async () => {
    const made = attachedWalk();
    const { controller } = made;
    await controller.setupStep();
    await controller.setupFinish({ skip: 'migrate' });
    await controller.setupFinish();
    assert.strictEqual((await controller.status()).setup.finishedForNow, true);
    await controller.migrationPlan();
    const after = await controller.status();
    assert.strictEqual(after.setup.finishedForNow, false);
    assert.strictEqual(after.setup.migrateSkipped, false);
    assert.strictEqual((await controller.setupStep()).step, 'migrate');
    controller.dispose();
  });

  it('a cases-folder refusal at the apply shows its path through shown', async () => {
    // caseRootRefusal's three messages are the only ones built from the session's root.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ipc', 'desktop-controller.js'), 'utf8');
    assert.strictEqual((src.match(/\$\{customCasesRoot\}/g) || []).length, 0);
    assert.strictEqual((src.match(/\$\{shown\(customCasesRoot, 400\)\}/g) || []).length, 3);
  });

  it('a restart that fails after the move offers its press on the step that follows', async () => {
    const client = nodeClient();
    const made = attachedWalk({ client });
    await made.controller.setupStep();
    await made.controller.migrationPlan();
    made.runner.runTask = async () => ({ ok: false, error: 'the task would not run' });
    await made.controller.migrationApply({ confirmed: true });
    await made.controller.startIdle();
    const answer = await made.controller.setupStep();
    assert.ok(answer.actions.some((a) => a.id === 'nodeRestart' || a.id === 'nodeStart'), JSON.stringify(answer));
    assert.ok(answer.error, 'and says why');
    made.controller.dispose();
  });

  it('a move whose restart was lost to an app death restarts once at the next launch', async () => {
    const client = nodeClient();
    const made = attachedWalk({ client });
    made.state.setMigration({ at: '2026-11-04T10:00:00.000Z', backupDir: 'C:\\b', nodeId: 'kl-abc', restartDue: true });
    const launch1 = made.build();
    await launch1.startAttached();
    await launch1.startIdle();
    assert.strictEqual(made.runner.calls.filter(([c]) => c === 'stopNode').length, 1);
    assert.strictEqual(made.runner.calls.filter(([c]) => c === 'runTask').length, 1);
    assert.strictEqual(made.state.migration.restartDue, undefined);
    assert.ok(made.state.migration.backupDir);
    launch1.dispose();
    const launch2 = made.build();
    await launch2.startAttached();
    await launch2.startIdle();
    assert.strictEqual(made.runner.calls.filter(([c]) => c === 'stopNode').length, 1, 'once');
    launch2.dispose();
    made.controller.dispose();
  });

  it('a verified apply writes restartDue with the mark and clears it as the restart goes', async () => {
    const seen = [];
    const made = attachedWalk();
    const stopNode = made.runner.stopNode.bind(made.runner);
    made.runner.stopNode = async (a) => { seen.push(made.state.migration.restartDue); return stopNode(a); };
    const setMigration = made.state.setMigration;
    made.state.setMigration = (entry) => { seen.push(entry.restartDue); return setMigration(entry); };
    await made.controller.migrationPlan();
    await made.controller.migrationApply({ confirmed: true });
    await made.controller.startIdle();
    assert.deepStrictEqual(seen, [true, undefined]);
    made.controller.dispose();
  });

  it('a file of the launcher\'s name that is not ours is not offered as the launcher', async () => {
    const made = walk({ profile: false, launch: ATTACHED, mode: 'attached', runner: fakeRunner({ running: true }), client: nodeClient() });
    const dataDir = path.join(made.parent, 'node', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const record = personalPairing();
    record.service.dataDir = dataDir;
    made.state.setPairing(record);
    const cli = path.join(path.dirname(dataDir), 'king-louie-service.cmd');
    fs.writeFileSync(cli, '@echo off\r\necho mine\r\n');
    assert.ok(!('serviceCli' in (await made.controller.status()).node));
    fs.writeFileSync(cli, renderServiceCliForTest());
    assert.strictEqual((await made.controller.status()).node.serviceCli, cli);
    made.controller.dispose();
  });

  it('status carries the launcher, the default data dir, the profile dir and the setup facts through shown', async () => {
    const made = attachedWalk({ extra: { cliExists: () => true }, profile: false });
    await made.controller.setupStep();
    const status = await made.controller.status();
    assert.ok(status.node.serviceCli.endsWith('king-louie-service.cmd'));
    assert.strictEqual(typeof status.node.defaultDataDir, 'string');
    assert.strictEqual(status.profileDir, made.userDataDir);
    assert.strictEqual(status.userProfileDefault, false);
    assert.deepStrictEqual(Object.keys(status.setup).sort(), ['completedAt', 'finishedForNow', 'migrateSkipped', 'phoneOffered', 'phoneSeen', 'step']);
    made.controller.dispose();
  });

  it('a profile read fails open: a node that cannot say is not asked for a name', async () => {
    const client = nodeClient();
    client.invoke = async () => { throw new Error('gone'); };
    const made = attachedWalk({ client, profile: false });
    assert.strictEqual((await made.controller.setupStep()).step, 'phone');
    made.controller.dispose();
  });

  it('the handlers reach the new methods', async () => {
    const { DESKTOP_METHODS } = require('../src/ipc/desktop-handlers');
    for (const [channel, method] of [['desktop:setupStep', 'setupStep'], ['desktop:setupLater', 'setupLater'], ['desktop:setupFinish', 'setupFinish'], ['desktop:nodeRestart', 'nodeRestart']]) {
      assert.strictEqual(DESKTOP_METHODS[channel], method);
    }
    const made = attachedWalk({ profile: false, client: new FakeAttachedClient(), runner: fakeRunner() });
    await made.controller.nodeRestart();
    await made.controller.startIdle();
    assert.strictEqual(made.runner.calls.filter(([c]) => c === 'runTask').length, 1);
    made.controller.dispose();
  });
});
