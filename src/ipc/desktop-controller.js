// Settings > Local service (fleet stage 7 §3.2, §3.7, §3.9): pairing, attach,
// detach, unpair, import. Mode switches persist and relaunch; handlers are
// never swapped under a live core. The private key is sealed with safeStorage
// and unsealed only for the moment of a signature.
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');
const { createLogger } = require('../logging');
const { DesktopBridgeClient } = require('../desktop-bridge/bridge-client');
const { encodePairRequest, defaultDeviceLabel, bridgeFilePath, readTrustedBridgeFile } = require('../desktop-bridge/pairing');
const { rawFromPublicKeyObject, fingerprintGroups } = require('../desktop-bridge/keys');
const { MESSAGES } = require('../desktop-bridge/protocol');
const { ATTACHED_UNAVAILABLE_TABS } = require('../desktop-bridge/allowlist');
const { loadDesktopSource, planImport, applyImport } = require('./desktop-export');

const log = createLogger('desktop-controller');

const DETACH_WARNING = 'After detaching, this app runs its own King Louie again next to the service; its cron jobs and channels may act twice. Stop the service if you no longer want it.';
const STANDALONE_ONCE = '--kl-standalone-once';

function currentUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return 'owner';
  }
}

function createDesktopController({
  state, mode, app, getWindow = () => null, env = process.env, platform = process.platform,
  userDataDir, safeStorage, stdout = process.stdout, argv = process.argv,
  readBridgeFile = null, clientFactory = null, pollMs = 3000, pollWindowMs = 10 * 60 * 1000,
  now = () => new Date(), username = null
}) {
  const emitter = new EventEmitter();
  const bridgeFile = () => bridgeFilePath({ env, platform });
  const readFile = readBridgeFile || (() => readTrustedBridgeFile(bridgeFile(), { env, platform }));
  const makeClient = clientFactory || ((options) => new DesktopBridgeClient(options));
  let client = null;
  let clientStateHandler = null;
  let connection = { status: mode === 'attached' ? 'connecting' : 'idle', code: null, error: null, nextRetryAt: null };
  let pollTimer = null;
  let found = null;
  let foundError = null;
  let importSession = null;
  let disposed = false;

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !(typeof win.isDestroyed === 'function' && win.isDestroyed())) win.webContents.send(channel, payload);
  };
  const notify = () => {
    send('desktop:statusChanged', {});
    emitter.emit('changed');
  };

  const signerFor = (pairing) => (bytes) => {
    const pem = state.unseal(pairing.privateKeySealed);
    return crypto.sign(null, Buffer.from(bytes), crypto.createPrivateKey(pem));
  };
  const clientOptionsFor = (pairing, service) => ({
    port: service.port,
    getPort: async () => {
      const r = readFile();
      return r && r.ok ? r.record.port : service.port;
    },
    pin: { nodeId: service.nodeId, publicKey: service.publicKey },
    deviceId: pairing.deviceId,
    sign: signerFor(pairing)
  });

  function relaunch(extraArgs = []) {
    if (env.KL_TEST_MODE === '1') {
      stdout.write('KL_RELAUNCH_REQUESTED\n');
      app.quit();
      return { ok: true, relaunching: true };
    }
    const args = argv.slice(1).filter((a) => a !== STANDALONE_ONCE).concat(extraArgs);
    app.relaunch({ args });
    app.exit(0);
    return { ok: true, relaunching: true };
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  // `until` is an absolute epoch ms deadline, computed from the pending
  // pair's own createdAt (fresh from pairStart, or resumed at construction)
  // so a desktop restart mid-pairing does not reset its own clock.
  function startPolling(until) {
    stopPolling();
    const tick = () => {
      if (Date.now() >= until) {
        pollTimer = null;
        // The window ran out: the owner never ran `desktop pair`, or never
        // will. Go back to unpaired rather than leave a stale pending pair
        // (with its sealed, now-orphaned key) sitting in the store forever.
        if (state.pendingPair) {
          state.setPendingPair(null);
          found = null;
          foundError = null;
          notify();
        }
        return;
      }
      const r = readFile();
      if (r && r.ok) { found = r.record; foundError = null; } else { found = null; foundError = r ? { code: r.code || null, error: r.error || null } : null; }
      notify();
      if (state.pendingPair) {
        pollTimer = setTimeout(tick, pollMs);
        pollTimer.unref?.();
      } else {
        pollTimer = null;
      }
    };
    tick();
  }

  // A pending pair persists across a desktop restart. Resume polling for
  // whatever's left of its window, or drop it outright if the window
  // already ran out while the app was closed. Clearing an already-expired
  // pair is free and stays synchronous; starting to poll a live window is
  // deferred — its first tick does a synchronous win32 PowerShell trust read
  // (Task 13), which construction (and therefore app-ready) must not block on.
  function resumePendingPair() {
    const pending = state.pendingPair;
    if (!pending) return;
    const created = Date.parse(pending.createdAt);
    const until = Number.isFinite(created) ? created + pollWindowMs : Date.now() - 1;
    if (until > Date.now()) {
      setImmediate(() => {
        if (!disposed) startPolling(until);
      });
    } else {
      state.setPendingPair(null);
      found = null;
      foundError = null;
    }
  }

  const pairCommand = (request) => (platform === 'win32'
    ? `king-louie-service desktop pair ${request}`
    : `sudo king-louie-service desktop pair ${request}`);

  function view() {
    const pairing = state.pairing;
    if (state.pendingPair) return 'pairing';
    if (!pairing || !pairing.service) return 'unpaired';
    if (mode === 'attached') return connection.status === 'connected' ? 'attached-connected' : 'attached-disconnected';
    return 'paired';
  }

  async function status() {
    const current = view();
    const pairing = state.pairing;
    const pending = state.pendingPair;
    let approvals = null;
    if (current === 'attached-connected' && client) {
      try {
        approvals = await client.call('bridge.approvalsStatus', {}, { timeoutMs: 5000 });
      } catch {
        approvals = { available: false };
      }
    }
    let bridge = null;
    if (current === 'unpaired') {
      const r = readFile() || {};
      bridge = r.ok ? { ok: true } : { ok: false, code: r.code || null, error: r.error || null };
    }
    const liveService = client && client.service ? client.service : null;
    return {
      ok: true,
      mode,
      view: current,
      standaloneOnce: argv.includes(STANDALONE_ONCE),
      bridgeFile: bridgeFile(),
      bridge,
      pairing: pairing ? {
        deviceId: pairing.deviceId,
        fingerprint: fingerprintGroups(pairing.deviceId),
        label: pairing.label,
        service: pairing.service ? { ...pairing.service, fingerprint: fingerprintGroups(pairing.service.nodeId) } : null
      } : null,
      pendingPair: pending ? {
        request: pending.request,
        command: pairCommand(pending.request),
        deviceFingerprint: fingerprintGroups(pending.deviceId),
        service: found ? { nodeId: found.nodeId, fingerprint: fingerprintGroups(found.nodeId), port: found.port } : null,
        error: foundError
      } : null,
      service: liveService || (pairing && pairing.service && pairing.service.info) || null,
      connection: { ...connection },
      approvals,
      lastImport: state.lastImport,
      unavailableTabs: mode === 'attached' ? [...ATTACHED_UNAVAILABLE_TABS] : [],
      detachWarning: DETACH_WARNING
    };
  }

  async function pairStart() {
    if (!state.secureStorageUsable()) return { ok: false, code: 'SECURE_STORAGE_UNAVAILABLE', error: MESSAGES.SECURE_STORAGE_UNAVAILABLE };
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = rawFromPublicKeyObject(publicKey);
    const label = defaultDeviceLabel(username || currentUsername());
    const request = encodePairRequest({ publicKeyRaw: raw, label });
    const createdAt = now();
    state.setPendingPair({
      deviceId: request.split('.')[1],
      publicKey: raw.toString('base64url'),
      privateKeySealed: state.seal(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      label,
      request,
      createdAt: createdAt.toISOString()
    });
    found = null;
    foundError = null;
    startPolling(createdAt.getTime() + pollWindowMs);
    return status();
  }

  async function pairConfirm(payload = {}) {
    const pending = state.pendingPair;
    if (!pending) return { ok: false, code: 'NOT_PAIRING', error: 'Start pairing first.' };
    // Pin `found`: the record whose fingerprint the owner was shown while
    // polling, never a fresh read taken at confirm time (a symlink/file
    // swap between the two could substitute a different service the owner
    // never actually compared).
    if (!found) return { ok: false, code: 'PAIR_NOT_FOUND', error: MESSAGES.PAIR_NOT_FOUND };
    // The pane passes the nodeId it actually displayed. A poll tick can
    // update `found` (and notify()) between that render and this call; if
    // the owner confirmed what they saw, not what `found` now holds, that
    // is the same "never compared" gap the fresh-read check below covers,
    // just on the controller's own polling instead of the bridge file.
    const expectedNodeId = payload && typeof payload.nodeId === 'string' ? payload.nodeId : null;
    if (expectedNodeId && expectedNodeId !== found.nodeId) {
      return { ok: false, code: 'PAIR_SERVICE_CHANGED', error: MESSAGES.PAIR_SERVICE_CHANGED };
    }
    const fresh = readFile() || {};
    if (!fresh.ok || fresh.record.nodeId !== found.nodeId || fresh.record.publicKey !== found.publicKey) {
      return { ok: false, code: 'PAIR_SERVICE_CHANGED', error: MESSAGES.PAIR_SERVICE_CHANGED };
    }
    const service = { nodeId: found.nodeId, publicKey: found.publicKey, port: found.port };
    const probe = makeClient(clientOptionsFor(pending, service));
    let info;
    try {
      info = await probe.connect();
    } catch (err) {
      probe.close();
      return { ok: false, code: err.code || 'SERVICE_UNREACHABLE', error: err.message };
    }
    probe.close();
    // The handshake above is the only await in this function; a pairCancel
    // that ran while it was in flight must win over this confirm.
    if (!state.pendingPair || state.pendingPair.request !== pending.request) {
      return { ok: false, code: 'NOT_PAIRING', error: 'Start pairing first.' };
    }
    state.setPairing({
      deviceId: pending.deviceId,
      publicKey: pending.publicKey,
      privateKeySealed: pending.privateKeySealed,
      label: pending.label,
      service: { ...service, pairedAt: now().toISOString(), info: { version: info.version, account: info.account, profile: info.profile, providersConfigured: info.providersConfigured } }
    });
    state.setPendingPair(null);
    stopPolling();
    log.info(`paired with the local service ${service.nodeId}`);
    notify();
    return status();
  }

  async function pairCancel() {
    state.setPendingPair(null);
    stopPolling();
    notify();
    return status();
  }

  async function attach() {
    const pairing = state.pairing;
    if (!pairing || !pairing.service) return { ok: false, code: 'NOT_PAIRED', error: 'Pair with the local service first.' };
    state.setMode('attached');
    return relaunch();
  }

  async function detach({ confirmed = false } = {}) {
    if (confirmed !== true) return { ok: false, code: 'CONFIRM_REQUIRED', error: DETACH_WARNING };
    state.setMode('standalone');
    return relaunch();
  }

  async function standaloneOnce() {
    return relaunch([STANDALONE_ONCE]);
  }

  async function unpair() {
    const pairing = state.pairing;
    const wasAttached = state.mode === 'attached';
    closeImportSession();
    state.clearPairing();
    state.setPendingPair(null);
    state.setMode('standalone');
    stopPolling();
    const command = pairing ? `${platform === 'win32' ? '' : 'sudo '}king-louie-service desktop unpair ${pairing.deviceId}` : null;
    if (wasAttached && mode === 'attached') return { ...relaunch(), command };
    notify();
    return { ok: true, command };
  }

  async function retry() {
    if (client) client.retryNow().catch(() => {});
    return { ok: true };
  }

  function closeImportSession() {
    if (importSession && importSession.temporary) importSession.client.close();
    importSession = null;
  }

  async function importClient() {
    const pairing = state.pairing;
    if (!pairing || !pairing.service) throw Object.assign(new Error('Pair with the local service first.'), { code: 'NOT_PAIRED' });
    if (client && client.connected) return { client, temporary: false };
    if (mode === 'attached') throw Object.assign(new Error(MESSAGES.SERVICE_UNREACHABLE(pairing.service.port)), { code: 'SERVICE_UNREACHABLE' });
    const temp = makeClient(clientOptionsFor(pairing, pairing.service));
    try {
      await temp.connect();
    } catch (err) {
      temp.close();
      throw err;
    }
    return { client: temp, temporary: true };
  }

  async function importPlan() {
    try {
      closeImportSession();
      const session = await importClient();
      const source = loadDesktopSource({ userDataDir, safeStorage, platform });
      const plan = await planImport({ client: session.client, source });
      importSession = { ...session, plan, source };
      return { ok: true, plan, attention: source.attention };
    } catch (err) {
      closeImportSession();
      return { ok: false, code: err.code || 'IMPORT_FAILED', error: err.message };
    }
  }

  async function importApply() {
    if (!importSession) return { ok: false, code: 'PLAN_EXPIRED', error: 'The import plan expired; plan the import again.' };
    try {
      const report = await applyImport({
        client: importSession.client,
        plan: importSession.plan,
        source: importSession.source,
        onProgress: (p) => send('desktop:importProgress', p)
      });
      state.setLastImport({ at: now().toISOString(), counts: report.counts });
      if (client && client.connected) {
        try { client.service = await client.call('bridge.status'); } catch { /* keep the old summary */ }
      }
      return { ok: true, report };
    } catch (err) {
      return { ok: false, code: err.code || 'IMPORT_FAILED', error: err.message };
    } finally {
      closeImportSession();
      notify();
    }
  }

  function createClient() {
    const pairing = state.pairing;
    if (!pairing || !pairing.service) return null;
    return makeClient(clientOptionsFor(pairing, pairing.service));
  }

  function setClient(next) {
    if (client && clientStateHandler) client.off('state', clientStateHandler);
    client = next;
    clientStateHandler = null;
    if (!client) return;
    clientStateHandler = (s) => {
      connection = { status: s.status, code: s.code, error: s.error, nextRetryAt: s.nextRetryAt };
      notify();
    };
    client.on('state', clientStateHandler);
  }

  function dispose() {
    disposed = true;
    stopPolling();
    closeImportSession();
    if (client && clientStateHandler) client.off('state', clientStateHandler);
    clientStateHandler = null;
  }

  resumePendingPair();

  return {
    status, pairStart, pairConfirm, pairCancel, attach, detach, standaloneOnce, unpair, retry,
    importPlan, importApply, createClient, setClient, dispose,
    on: (event, fn) => emitter.on(event, fn)
  };
}

module.exports = { createDesktopController, DETACH_WARNING, STANDALONE_ONCE };
