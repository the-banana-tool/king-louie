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
const { createPersonalNodeRunner, PERSONAL_TASK_NAME, firstLine } = require('../desktop-bridge/personal-node');
const { shown } = require('../service/commands/io');

const log = createLogger('desktop-controller');

const DETACH_WARNING = 'After detaching, this app runs its own King Louie again next to the service; its cron jobs and channels may act twice. Stop the service if you no longer want it.';
const STANDALONE_ONCE = '--kl-standalone-once';
// Spec 2026-10-28 §6.2, §7.3 (C-12).
const PAIR_CLI_TIMEOUT_MS = 120000;
const NODE_START_WAIT_MS = 60000;
const NODE_RETRY_MS = 3000;
// §7.4: an attached-disconnected status reads the node again at most this often.
const NODE_REFRESH_MS = 5000;
const startTimeoutText = (ms) => `King Louie Node did not answer within ${Math.round(ms / 1000)} seconds.`;
const TASK_REFUSALS = {
  missing: { code: 'NODE_TASK_MISSING', message: 'King Louie Node has no logon task on this computer, so this app cannot start it.' },
  disabled: { code: 'NODE_TASK_DISABLED', message: `The logon task "${PERSONAL_TASK_NAME}" is disabled in Task Scheduler. Enable it there to let this app start the node.` },
  'other-account': { code: 'NODE_TASK_OTHER_ACCOUNT', message: `The logon task "${PERSONAL_TASK_NAME}" belongs to another account; this app does not run it.` },
  unknown: { code: 'NODE_TASK_MISSING', message: `The logon task "${PERSONAL_TASK_NAME}" could not be read, so this app cannot start it.` }
};
// §8: Install runs only while no task is registered.
const INSTALL_REFUSALS = {
  registered: { code: 'NODE_TASK_REGISTERED', message: `The logon task "${PERSONAL_TASK_NAME}" is already registered; there is nothing to install.` },
  disabled: TASK_REFUSALS.disabled,
  'other-account': TASK_REFUSALS['other-account'],
  unknown: { code: 'NODE_TASK_UNREADABLE', message: TASK_REFUSALS.unknown.message }
};
// §7.3: the bridge codes that end an attached start's wait (the client's FATAL).
const BRIDGE_FATAL = new Set(['DEVICE_UNPAIRED', 'PROTOCOL_MISMATCH', 'ANOTHER_DEVICE', 'SERVICE_KEY_CHANGED']);
// pairConfirm answers that waiting will not change (the bridge client's
// FATAL set, and the pairing's own refusals); anything else is a bridge
// that is not up yet.
const PAIR_FATAL = new Set([...BRIDGE_FATAL, 'PAIR_SERVICE_CHANGED', 'PAIR_NOT_FOUND', 'PAIR_CONFIRM_STALE', 'NOT_PAIRING']);
const INITIAL_NODE_STATE = Object.freeze({ task: 'unknown', running: false, pid: null, starting: false, startError: null });
const INSTALL_CLI_TIMEOUT_MS = 120000;
const NOT_PERSONAL_TEXT = 'No King Louie Node on this computer is paired with this desktop.';

// A data dir as the disk names it and as the pairing recorded it: Windows
// paths compare without case and without a trailing separator.
function samePath(a, b) {
  const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  return typeof a === 'string' && typeof b === 'string' && norm(a) === norm(b);
}

// §8: the CLI's output as lines for a <pre>, each through `shown`; blank
// lines inside are kept, those at either end dropped.
function outputLines(...texts) {
  const lines = texts.filter(Boolean).join('\n').split(/\r?\n/).map((l) => shown(l.replace(/\s+$/, ''), 400));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

// nodeRunning's answer as the status's two fields.
function runningFields(r) {
  const running = Boolean(r && r.running);
  return { running, pid: running && Number.isInteger(r.pid) ? r.pid : null };
}

// A refusal or error from the node, the CLI or the trust read, as the
// status carries it: every string through `shown`.
function shownError(error) {
  return {
    code: shown((error && error.code) || 'NODE_START_FAILED', 80),
    message: shown((error && (error.message || error.error)) || '', 400)
  };
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

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
  now = () => new Date(), username = null,
  // The personal node (spec 2026-10-28): the runner that reads and starts it,
  // and the clock and timers of the §7.3 wait (tests inject a fake clock).
  nodeRunner = platform === 'win32' ? createPersonalNodeRunner({ env, platform }) : null,
  clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  nodeStartWaitMs = NODE_START_WAIT_MS, nodeRetryMs = NODE_RETRY_MS, nodeRefreshMs = NODE_REFRESH_MS
}) {
  const emitter = new EventEmitter();
  const bridgeFile = () => bridgeFilePath({ env, platform });
  // Async (final review I2): on Windows the trust read is a ~1.5 s
  // PowerShell child process; an injected reader may still be synchronous.
  // A personal pairing (pending or made) reads its own data dir's bridge
  // file through the runner: one inspector call, the same trust rule.
  const personalDataDir = () => {
    const pending = state.pendingPair;
    if (pending && pending.personal && pending.personal.dataDir) return pending.personal.dataDir;
    const svc = state.pairing && state.pairing.service;
    return svc && svc.hosting === 'personal' && svc.dataDir ? svc.dataDir : null;
  };
  const readFile = async () => {
    if (readBridgeFile) return readBridgeFile();
    const dataDir = personalDataDir();
    if (dataDir && nodeRunner) return (await nodeRunner.inspectLocal({ dataDir })).trust;
    return readTrustedBridgeFile(bridgeFile(), { env, platform });
  };
  const makeClient = clientFactory || ((options) => new DesktopBridgeClient(options));
  let client = null;
  let clientStateHandler = null;
  let connection = { status: mode === 'attached' ? 'connecting' : 'idle', code: null, error: null, nextRetryAt: null };
  let pollTimer = null;
  // Bumped by stopPolling/startPolling so a tick whose trust read is still
  // in flight knows it was superseded and does nothing when it resumes.
  let pollGeneration = 0;
  let found = null;
  let foundError = null;
  let importSession = null;
  let disposed = false;
  // The one-click pairing in flight (§6.2): which pending pair, its stage
  // and its refusal. In memory: a pending pair from before a restart has none.
  let personalFlow = null;
  // What the desktop last learnt of the personal node (§7.1, §11).
  let nodeState = { ...INITIAL_NODE_STATE };
  // Every §7.3 wait's sleep, each with its own timer (the pairing flow's and
  // the attached start's can run at once); dispose() ends them all.
  const sleeps = new Set();
  // The attached start's and the pairing flow's current sleeps, so a
  // connect, a fatal code or a cancel ends that wait alone.
  let attachSlot = null;
  let pairSlot = null;
  // §7.4: the node read again after a drop and in a disconnected status.
  let lastNodeReadAt = -Infinity;
  let refreshRun = null;
  // The attached start (§7.2, §7.3): run by itself once per launch (C-13);
  // a press starts a new generation, which ends the wait before it.
  let launchStarted = false;
  let startGeneration = 0;
  let startRun = null;
  let attachWaiting = false;

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
      const r = await readFile();
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
    pollGeneration += 1;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  // `until` is an absolute epoch ms deadline, computed from the pending
  // pair's own createdAt (fresh from pairStart, or resumed at construction)
  // so a desktop restart mid-pairing does not reset its own clock.
  // Returns the first tick's promise, so pairStart can answer with whatever
  // that first read found.
  function startPolling(until) {
    stopPolling();
    const generation = pollGeneration;
    const current = () => generation === pollGeneration && !disposed;
    const tick = async () => {
      pollTimer = null;
      if (!current()) return;
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
      let r;
      try {
        r = await readFile();
      } catch (err) {
        r = { ok: false, code: err.code || null, error: err.message };
      }
      // Cancelled, confirmed, restarted or disposed while the read ran.
      if (!current()) return;
      if (r && r.ok) { found = r.record; foundError = null; } else { found = null; foundError = r ? { code: r.code || null, error: r.error || null } : null; }
      notify();
      if (state.pendingPair) {
        pollTimer = setTimeout(tick, pollMs);
        pollTimer.unref?.();
      }
    };
    return tick();
  }

  // A pending pair persists across a desktop restart. Resume polling for
  // whatever's left of its window, or drop it outright if the window
  // already ran out while the app was closed. Clearing an already-expired
  // pair is free and stays synchronous; starting to poll a live window is
  // deferred to the next turn so construction does no I/O of its own. The
  // deferred start checks that the same pending pair is still there.
  function resumePendingPair() {
    const pending = state.pendingPair;
    if (!pending) return;
    const created = Date.parse(pending.createdAt);
    const until = Number.isFinite(created) ? created + pollWindowMs : Date.now() - 1;
    if (until > Date.now() && pending.personal) {
      // The one-click flow died with the app that ran it: say so, and let
      // the owner try again or cancel. Nothing is run by itself.
      personalFlow = {
        request: pending.request,
        stage: 'command',
        error: { code: 'PAIR_COMMAND_FAILED', message: 'Pairing did not finish: the app closed while pairing.' },
        record: null
      };
    } else if (until > Date.now()) {
      setImmediate(() => {
        if (!disposed && state.pendingPair && state.pendingPair.request === pending.request) {
          startPolling(until).catch((err) => log.warn(`pairing poll failed: ${err.message}`));
        }
      });
    } else {
      state.setPendingPair(null);
      found = null;
      foundError = null;
    }
  }

  // §11's `node`: null unless the node in question is a personal one.
  function nodeStatus() {
    const pending = state.pendingPair;
    const svc = state.pairing && state.pairing.service;
    let base = null;
    if (pending && pending.personal) base = pending.personal;
    else if (!pending && svc && svc.hosting === 'personal') base = { name: svc.name || null, dataDir: svc.dataDir };
    return base ? nodeView(base) : null;
  }

  // §11's `node`, from what the desktop last learnt of it.
  function nodeView(base) {
    return {
      hosting: 'personal', name: base.name || null, dataDir: base.dataDir || null,
      task: nodeState.task, running: nodeState.running, pid: nodeState.pid,
      starting: nodeState.starting, startError: nodeState.startError
    };
  }

  const setRunning = (r) => { nodeState = { ...nodeState, ...runningFields(r) }; };

  const pairCommand = (request) => (platform === 'win32'
    ? `king-louie-service desktop pair ${request}`
    : `sudo king-louie-service desktop pair ${request}`);

  function view() {
    const pairing = state.pairing;
    if (state.pendingPair) return 'pairing';
    if (!pairing || !pairing.service) return 'unpaired';
    if (mode === 'attached') {
      if (connection.status === 'connected') return 'attached-connected';
      return nodeState.starting && nodeStatus() ? 'attached-starting' : 'attached-disconnected';
    }
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
    // §7.4: a disconnected personal pairing shows what §7.1 finds now
    // (rate-limited: not a PowerShell call per repaint).
    if (current === 'attached-disconnected') await refreshNode().catch(() => {});
    let node = nodeStatus();
    if (current === 'unpaired') {
      let r;
      try {
        if (nodeRunner) {
          // C-1: one inspector call answers the bridge read and whether a
          // personal node lives here.
          const local = await nodeRunner.inspectLocal({ bridgeFile: bridgeFile() });
          r = (readBridgeFile ? await readBridgeFile() : local.trust) || {};
          node = await unpairedNode(local.node);
        } else {
          r = (await readFile()) || {};
        }
      } catch (err) {
        r = { ok: false, code: err.code || null, error: err.message };
      }
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
      pendingPair: pending ? (pending.personal ? {
        request: pending.request,
        personal: true,
        stage: personalFlow && personalFlow.request === pending.request ? personalFlow.stage : 'command',
        deviceFingerprint: fingerprintGroups(pending.deviceId),
        service: found ? { nodeId: found.nodeId, fingerprint: fingerprintGroups(found.nodeId), port: found.port } : null,
        error: personalFlow && personalFlow.request === pending.request ? personalFlow.error : null
      } : {
        request: pending.request,
        command: pairCommand(pending.request),
        deviceFingerprint: fingerprintGroups(pending.deviceId),
        service: found ? { nodeId: found.nodeId, fingerprint: fingerprintGroups(found.nodeId), port: found.port } : null,
        error: foundError
      }) : null,
      node,
      service: liveService || (pairing && pairing.service && pairing.service.info) || null,
      connection: current === 'attached-starting' ? { ...connection, status: 'starting' } : { ...connection },
      approvals,
      lastImport: state.lastImport,
      unavailableTabs: mode === 'attached' ? [...ATTACHED_UNAVAILABLE_TABS] : [],
      detachWarning: DETACH_WARNING,
      pendingServiceCommand: state.pendingServiceCommand
    };
  }

  // The unpaired view's node: what the inspector said, plus the task and
  // whether a node runs (§7.1), so the pane can offer Install.
  async function unpairedNode(local) {
    if (!local || !local.personal) return null;
    const [task, running] = await Promise.all([
      nodeRunner.queryTask({ me: local.me }).catch(() => ({ state: 'unknown' })),
      nodeRunner.nodeRunning({ dataDir: local.dataDir }).catch(() => ({ running: false, pid: null }))
    ]);
    nodeState = { ...nodeState, task: task.state, ...runningFields(running) };
    return nodeView(local);
  }

  // §7.3, shared with the attached start (T07): from the /Run (`since`, or
  // null when nothing was run) call `attempt()` every nodeRetryMs until it
  // answers `{ done: true, result }`, the node's log says it failed to start
  // after `since`, or nodeStartWaitMs pass. `isCurrent()` false or dispose()
  // ends it as CANCELLED. Each sleep is a ref'd timer of its own, held in
  // `slot` (when given) while it runs; waking it clears that timer.
  function sleep(ms, slot) {
    return new Promise((resolve) => {
      const h = { timer: null };
      const end = (clear) => {
        if (!sleeps.delete(h)) return;
        if (clear) clearTimer(h.timer);
        if (slot && slot.current === h) slot.current = null;
        resolve();
      };
      h.wake = () => end(true);
      sleeps.add(h);
      if (slot) slot.current = h;
      h.timer = setTimer(() => end(false), ms);
    });
  }
  const wakeSlot = (slot) => { if (slot && slot.current) slot.current.wake(); };
  async function waitForNode({ dataDir, since = null, attempt, isCurrent = () => true, slot = null }) {
    const cancelled = { ok: false, code: 'CANCELLED' };
    const started = clock();
    for (;;) {
      if (disposed || !isCurrent()) return cancelled;
      const r = await attempt();
      if (disposed || !isCurrent()) return cancelled;
      if (r && r.done) return { ok: true, result: r.result };
      if (since !== null && nodeRunner) {
        const failed = await nodeRunner.startFailureSince(since, { dataDir });
        if (disposed || !isCurrent()) return cancelled;
        if (failed) return { ok: false, code: 'NODE_START_FAILED', message: shown(failed.line, 400) };
      }
      const left = started + nodeStartWaitMs - clock();
      if (left <= 0) return { ok: false, code: 'NODE_START_TIMEOUT', message: startTimeoutText(nodeStartWaitMs) };
      await sleep(Math.min(nodeRetryMs, left), slot);
    }
  }

  // §6.2: is this pending pair still the one the flow was started for?
  const flowCurrent = (request) => () => !disposed && Boolean(state.pendingPair) && state.pendingPair.request === request
    && Boolean(personalFlow) && personalFlow.request === request;

  function setStage(request, stage) {
    if (!personalFlow || personalFlow.request !== request) return;
    personalFlow.stage = stage;
    personalFlow.error = null;
    notify();
  }

  async function failFlow(request, error) {
    if (personalFlow && personalFlow.request === request) {
      personalFlow.error = shownError(error);
      nodeState = { ...nodeState, starting: false };
      notify();
    }
    return status();
  }

  // §7.1, §12: the one way the desktop runs the task, for the pairing flow,
  // the attached start, Start and Restart. The task is read first and must
  // be registered, enabled and this account's (never another account's
  // task: TASK_REFUSALS); a restart then stops a node that runs (and only
  // one that runs); then /Run. Resolves { ok: true, ranAt }, a refusal
  // { ok: false, code, message } (shown), or { cancelled: true }.
  async function runNodeTask({ dataDir, me, restart = false, isCurrent, onStarting = null }) {
    const task = await nodeRunner.queryTask({ me }).catch(() => ({ state: 'unknown' }));
    if (!isCurrent()) return { cancelled: true };
    nodeState = { ...nodeState, task: task.state };
    if (task.state !== 'registered') return { ok: false, ...(TASK_REFUSALS[task.state] || TASK_REFUSALS.unknown) };
    if (onStarting) onStarting();
    if (restart) {
      const running = await nodeRunner.nodeRunning({ dataDir });
      if (!isCurrent()) return { cancelled: true };
      setRunning(running);
      if (running.running) {
        const stopped = await nodeRunner.stopNode({ dataDir });
        if (!isCurrent()) return { cancelled: true };
        if (!stopped.ok) return { ok: false, ...shownError({ code: stopped.code || 'NODE_STOP_FAILED', message: stopped.message }) };
        setRunning(null);
      }
    }
    const ran = await nodeRunner.runTask();
    if (!isCurrent()) return { cancelled: true };
    if (!ran.ok) return { ok: false, ...shownError({ code: ran.code || 'NODE_TASK_RUN_FAILED', message: ran.message }) };
    return { ok: true, ranAt: ran.ranAt };
  }

  // §6.2 steps 2-4 for a pending personal pair; step 5 is finishPersonalPair.
  async function runPersonalPair(request) {
    const current = flowCurrent(request);
    const dataDir = state.pendingPair.personal.dataDir;
    // 2. The CLI, as this account, unelevated.
    const cli = await nodeRunner.runCli(['desktop', 'pair', request, '--yes', '--json', '--data-dir', dataDir], { timeoutMs: PAIR_CLI_TIMEOUT_MS });
    if (!current()) return status();
    const json = cli && cli.json && typeof cli.json === 'object' ? cli.json : null;
    if (json && json.ok === false) {
      return failFlow(request, { code: json.code || 'PAIR_COMMAND_FAILED', message: json.message || '' });
    }
    if (!json || json.ok !== true || cli.code !== 0 || typeof json.nodeId !== 'string') {
      const why = firstLine(cli && cli.stderr) || (cli && cli.timedOut ? 'the command did not finish in time' : ((cli && cli.error) || 'the command failed'));
      return failFlow(request, { code: 'PAIR_COMMAND_FAILED', message: `Pairing did not finish: ${why}` });
    }
    // 3. The trusted read: the personal rule, the CLI's own node.
    let trust;
    try {
      trust = (await nodeRunner.inspectLocal({ dataDir })).trust || {};
    } catch (err) {
      trust = { ok: false, code: 'BRIDGE_FILE_UNTRUSTED', error: err.message };
    }
    if (!current()) return status();
    if (!trust.ok) {
      return failFlow(request, { code: trust.code || 'BRIDGE_FILE_UNTRUSTED', message: trust.error || MESSAGES.PAIR_SERVICE_CHANGED });
    }
    if (trust.hosting !== 'personal' || !trust.record || trust.record.nodeId !== json.nodeId) {
      return failFlow(request, { code: 'PAIR_SERVICE_CHANGED', message: MESSAGES.PAIR_SERVICE_CHANGED });
    }
    personalFlow.record = trust.record;
    found = trust.record;
    foundError = null;
    // 4. Bring the bridge up.
    const running = await nodeRunner.nodeRunning({ dataDir });
    if (!current()) return status();
    setRunning(running);
    if (running.running && json.bridgeTurnedOn === true) {
      // C-6: never restart a running node without asking.
      setStage(request, 'restart-needed');
      return status();
    }
    if (running.running) {
      setStage(request, 'confirming');
      return finishPersonalPair(request, null);
    }
    const ran = await runNodeTask({
      dataDir,
      isCurrent: current,
      onStarting: () => {
        nodeState = { ...nodeState, starting: true, startError: null };
        setStage(request, 'starting');
      }
    });
    if (ran.cancelled) return status();
    if (!ran.ok) return failFlow(request, ran);
    return finishPersonalPair(request, ran.ranAt);
  }

  // §6.2 step 5: wait for the bridge (§7.3), each try the existing
  // pairConfirm with the record of step 3.
  async function finishPersonalPair(request, since) {
    const current = flowCurrent(request);
    const record = personalFlow.record;
    const dataDir = state.pendingPair.personal.dataDir;
    const slot = { current: null };
    pairSlot = slot;
    const waited = await waitForNode({
      dataDir,
      since,
      slot,
      isCurrent: current,
      attempt: async () => {
        found = record;
        const r = await pairConfirm({ nodeId: record.nodeId });
        if (r && r.ok && r.view && r.view !== 'pairing') return { done: true, result: r };
        if (r && !r.ok && PAIR_FATAL.has(r.code)) return { done: true, result: r };
        return { done: false };
      }
    });
    if (pairSlot === slot) pairSlot = null;
    nodeState = { ...nodeState, starting: false };
    if (waited.code === 'CANCELLED') return status();
    if (!waited.ok) {
      nodeState = { ...nodeState, startError: shownError(waited) };
      return failFlow(request, waited);
    }
    const r = waited.result;
    if (!r.ok) return failFlow(request, { code: r.code, message: r.error || '' });
    personalFlow = null;
    nodeState = { ...nodeState, running: true, startError: null };
    return status();
  }

  // §6.2 step 4's "Restart and pair".
  async function pairRestartConfirm({ confirmed = false } = {}) {
    const pending = state.pendingPair;
    if (!pending || !pending.personal || !personalFlow || personalFlow.request !== pending.request || personalFlow.stage !== 'restart-needed') {
      return { ok: false, code: 'NOT_PAIRING', error: 'No pairing is waiting for a restart.' };
    }
    if (confirmed !== true) return { ok: false, code: 'CONFIRM_REQUIRED', error: 'Pairing restarts King Louie Node: a turn or a take in progress stops.' };
    const request = pending.request;
    const restarted = await runNodeTask({
      dataDir: pending.personal.dataDir,
      restart: true,
      isCurrent: flowCurrent(request),
      onStarting: () => {
        nodeState = { ...nodeState, starting: true, startError: null };
        setStage(request, 'starting');
      }
    });
    if (restarted.cancelled) return status();
    if (!restarted.ok) return failFlow(request, restarted);
    return finishPersonalPair(request, restarted.ranAt);
  }

  async function pairStart() {
    if (!state.secureStorageUsable()) return { ok: false, code: 'SECURE_STORAGE_UNAVAILABLE', error: MESSAGES.SECURE_STORAGE_UNAVAILABLE };
    // §6.2: the local read decides which flow runs.
    let local = null;
    if (nodeRunner) {
      try {
        local = (await nodeRunner.detectPersonalNode({})) || null;
      } catch (err) {
        log.warn(`personal node read failed: ${err.message}`);
      }
    }
    const personal = Boolean(local && local.personal && local.dataDir);
    // A follow-up command from a previous unpair is moot once a new pairing
    // starts; the owner dismisses it or it's superseded, never both shown.
    state.setPendingServiceCommand(null);
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
      createdAt: createdAt.toISOString(),
      ...(personal ? { personal: { dataDir: local.dataDir, name: local.name || null } } : {})
    });
    found = null;
    foundError = null;
    if (personal) {
      stopPolling();
      personalFlow = { request, stage: 'command', error: null, record: null };
      nodeState = { ...INITIAL_NODE_STATE };
      notify();
      return runPersonalPair(request);
    }
    personalFlow = null;
    await startPolling(createdAt.getTime() + pollWindowMs);
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
    // The pane must pass the nodeId it actually displayed — required, not
    // just checked when present. A caller that names nothing never
    // compared anything (a stale/incompatible caller, not a race); that
    // gets its own message. A poll tick can update `found` (and notify())
    // between the render and this call, so a caller that names something
    // other than the current `found` is the race the fresh-read check
    // below also covers, just on the controller's own polling instead of
    // the bridge file — that one is PAIR_SERVICE_CHANGED.
    const expectedNodeId = payload && typeof payload.nodeId === 'string' ? payload.nodeId : null;
    if (!expectedNodeId) return { ok: false, code: 'PAIR_CONFIRM_STALE', error: MESSAGES.PAIR_CONFIRM_STALE };
    if (expectedNodeId !== found.nodeId) {
      return { ok: false, code: 'PAIR_SERVICE_CHANGED', error: MESSAGES.PAIR_SERVICE_CHANGED };
    }
    // Held locally: a poll tick may replace or clear `found` during the
    // fresh read's await below.
    const shown = found;
    let fresh;
    try {
      fresh = (await readFile()) || {};
    } catch {
      fresh = {};
    }
    // The fresh read is an await too: a pairCancel (or a new pairStart) that
    // landed meanwhile wins.
    if (!state.pendingPair || state.pendingPair.request !== pending.request) {
      return { ok: false, code: 'NOT_PAIRING', error: 'Start pairing first.' };
    }
    if (!fresh.ok || fresh.record.nodeId !== shown.nodeId || fresh.record.publicKey !== shown.publicKey) {
      return { ok: false, code: 'PAIR_SERVICE_CHANGED', error: MESSAGES.PAIR_SERVICE_CHANGED };
    }
    const service = { nodeId: shown.nodeId, publicKey: shown.publicKey, port: shown.port };
    const probe = makeClient(clientOptionsFor(pending, service));
    let info;
    try {
      info = await probe.connect();
    } catch (err) {
      probe.close();
      return { ok: false, code: err.code || 'SERVICE_UNREACHABLE', error: err.message };
    }
    probe.close();
    // A pairCancel that ran while the handshake was in flight must win over
    // this confirm.
    if (!state.pendingPair || state.pendingPair.request !== pending.request) {
      return { ok: false, code: 'NOT_PAIRING', error: 'Start pairing first.' };
    }
    state.setPairing({
      deviceId: pending.deviceId,
      publicKey: pending.publicKey,
      privateKeySealed: pending.privateKeySealed,
      label: pending.label,
      service: {
        ...service,
        // C-7: what the pairing was made with; each launch reads the disk again.
        ...(pending.personal ? { hosting: 'personal', dataDir: pending.personal.dataDir, name: pending.personal.name || null } : {}),
        pairedAt: now().toISOString(),
        info: { version: info.version, account: info.account, profile: info.profile, providersConfigured: info.providersConfigured }
      }
    });
    state.setPendingPair(null);
    stopPolling();
    log.info(`paired with the local service ${service.nodeId}`);
    notify();
    return status();
  }

  async function pairCancel() {
    state.setPendingPair(null);
    personalFlow = null;
    wakeSlot(pairSlot);
    nodeState = { ...nodeState, starting: false };
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
    personalFlow = null;
    const svc = pairing && pairing.service;
    const personalDir = svc && svc.hosting === 'personal' && svc.dataDir && nodeRunner ? svc.dataDir : null;
    let command = pairing ? `${platform === 'win32' ? '' : 'sudo '}king-louie-service desktop unpair ${pairing.deviceId}` : null;
    if (personalDir) {
      // C-8: under personal hosting the desktop removes itself from the node;
      // the follow-up command shows only when that fails.
      const r = await nodeRunner.runCli(['desktop', 'unpair', pairing.deviceId, '--data-dir', personalDir], { timeoutMs: PAIR_CLI_TIMEOUT_MS });
      if (r && r.code === 0) {
        command = null;
      } else {
        command = `king-louie-service desktop unpair ${pairing.deviceId} --data-dir ${quoteArg(personalDir)}`;
        log.warn(`desktop unpair did not finish: ${firstLine(r && r.stderr) || 'no output'}`);
      }
    }
    // Persisted, not just returned: notify() below (or, in attached mode,
    // the relaunch) can reach the pane before this reply ever does, and the
    // pane needs to keep showing this on every repaint — including one
    // after a relaunch — until the owner dismisses it or pairs again.
    if (command) state.setPendingServiceCommand({ command, at: now().toISOString() });
    if (wasAttached && mode === 'attached') return { ...relaunch(), command };
    notify();
    return { ok: true, command };
  }

  async function dismissServiceCommand() {
    state.setPendingServiceCommand(null);
    notify();
    return status();
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
      const source = await loadDesktopSource({ userDataDir, safeStorage, platform });
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
      const was = connection.status;
      connection = { status: s.status, code: s.code, error: s.error, nextRetryAt: s.nextRetryAt };
      // §7.3: a connect, or a code waiting will not change, ends the
      // attached start's sleep at once (its timer cleared).
      if (attachWaiting && (s.status === 'connected' || BRIDGE_FATAL.has(s.code))) wakeSlot(attachSlot);
      notify();
      // §7.4, C-13: after a drop the row is chosen from what §7.1 finds
      // now. Read only: a drop never runs the task.
      if (was === 'connected' && s.status !== 'connected') {
        refreshNode({ force: true })
          .then((changed) => { if (changed) notify(); })
          .catch((err) => log.warn(`reading King Louie Node after a drop failed: ${err.message}`));
      }
    };
    client.on('state', clientStateHandler);
  }

  function dispose() {
    disposed = true;
    stopPolling();
    for (const h of [...sleeps]) h.wake();
    closeImportSession();
    if (client && clientStateHandler) client.off('state', clientStateHandler);
    clientStateHandler = null;
  }

  // --- §7.2-§7.4, §8: the personal node an attached desktop starts. ---

  const personalPairingDir = () => {
    const svc = state.pairing && state.pairing.service;
    return svc && svc.hosting === 'personal' && svc.dataDir ? svc.dataDir : null;
  };

  // Today's connect: the client's own loop and backoff, nothing else.
  function connectNow() {
    if (client) client.connect().catch((err) => log.warn(`the local service is not reachable yet: ${err.message}`));
  }

  function endStart(startError) {
    nodeState = { ...nodeState, starting: false, startError: startError ? shownError(startError) : null };
    notify();
  }

  // §7.4: read the task and the pidfile again for an attached personal
  // pairing that is not starting. At most once per nodeRefreshMs unless
  // forced (a drop); resolves true when it read something.
  function refreshNode({ force = false } = {}) {
    const dataDir = personalPairingDir();
    if (mode !== 'attached' || !dataDir || !nodeRunner || disposed) return Promise.resolve(false);
    if (startRun || nodeState.starting) return Promise.resolve(false);
    if (refreshRun) return refreshRun;
    if (!force && clock() - lastNodeReadAt < nodeRefreshMs) return Promise.resolve(false);
    lastNodeReadAt = clock();
    const run = (async () => {
      const [task, running] = await Promise.all([
        nodeRunner.queryTask({}).catch(() => ({ state: 'unknown' })),
        nodeRunner.nodeRunning({ dataDir }).catch(() => ({ running: false, pid: null }))
      ]);
      // A start begun meanwhile owns the state.
      if (disposed || startRun || nodeState.starting) return false;
      nodeState = { ...nodeState, task: task.state, ...runningFields(running) };
      return true;
    })();
    refreshRun = run;
    run.then(() => { if (refreshRun === run) refreshRun = null; }, () => { if (refreshRun === run) refreshRun = null; });
    return run;
  }

  // Resolves once no read of the node is in flight.
  async function refreshIdle() {
    while (refreshRun) await refreshRun.catch(() => {});
  }

  // Whether the client's own loop has settled the wait: connected, or a
  // code that waiting will not change (shown as now).
  function clientSettled() {
    if (client && client.connected) return { done: true, result: { connected: true } };
    if (connection.status === 'failed' && BRIDGE_FATAL.has(connection.code)) return { done: true, result: { connected: false } };
    return null;
  }

  // One start: check the disk (C-7), run or restart the node when that is
  // what is asked and allowed (C-11), then the §7.3 wait over the client's
  // own loop: retryNow() every nodeRetryMs, no second connection loop.
  async function attachedStart({ dataDir, restart = false, gen }) {
    const current = () => !disposed && gen === startGeneration;
    let local = null;
    try {
      local = await nodeRunner.detectPersonalNode({ dataDir });
    } catch (err) {
      log.warn(`personal node read failed: ${err.message}`);
    }
    if (!current()) return;
    if (!local || !local.personal || !samePath(local.dataDir, dataDir)) {
      // The record only says whether to try; the disk says no.
      endStart(null);
      connectNow();
      return;
    }
    let since = null;
    let run = restart;
    if (!restart) {
      const running = await nodeRunner.nodeRunning({ dataDir });
      if (!current()) return;
      setRunning(running);
      run = !running.running;
    }
    if (run) {
      // A restart stops only a node that runs: with none, it is a start.
      const ran = await runNodeTask({
        dataDir,
        me: local.me,
        restart,
        isCurrent: current,
        onStarting: () => {
          nodeState = { ...nodeState, starting: true, startError: null };
          notify();
        }
      });
      if (ran.cancelled) return;
      if (!ran.ok) {
        endStart(ran);
        connectNow();
        return;
      }
      since = ran.ranAt;
    }
    nodeState = { ...nodeState, starting: true, startError: null };
    notify();
    attachWaiting = true;
    const slot = { current: null };
    attachSlot = slot;
    let waited;
    try {
      waited = await waitForNode({
        dataDir,
        since,
        slot,
        isCurrent: current,
        attempt: async () => {
          const before = clientSettled();
          if (before) return before;
          if (client) client.retryNow().catch(() => {});
          return clientSettled() || { done: false };
        }
      });
    } finally {
      if (gen === startGeneration) attachWaiting = false;
      if (attachSlot === slot) attachSlot = null;
    }
    if (waited.code === 'CANCELLED') return;
    if (waited.ok) {
      if (waited.result.connected) nodeState = { ...nodeState, running: true };
      endStart(null);
    } else if (waited.code === 'NODE_START_TIMEOUT' && since === null) {
      // Nothing was run: the node was up at the start. Read it again: still
      // up, its bridge never answered (the "running (pid N)" row and its
      // Restart say so); gone, the timeout stands (§7.3).
      const now = await nodeRunner.nodeRunning({ dataDir }).catch(() => ({ running: false, pid: null }));
      if (!current()) return;
      setRunning(now);
      lastNodeReadAt = clock();
      endStart(now.running ? null : waited);
    } else {
      endStart({ code: waited.code, message: waited.message });
    }
  }

  function launchStart(dataDir, restart) {
    const gen = ++startGeneration;
    wakeSlot(attachSlot);
    const run = attachedStart({ dataDir, restart, gen }).catch((err) => {
      log.warn(`starting King Louie Node failed: ${err.message}`);
      if (gen === startGeneration) endStart({ code: 'NODE_START_FAILED', message: shown(err.message, 400) });
    });
    startRun = run;
    run.then(() => { if (startRun === run) startRun = null; });
    return run;
  }

  // §7.2: called by the attached host in place of client.connect(). A
  // personal pairing runs the node at most once per launch (C-13); a fleet
  // pairing connects at once, as before.
  async function startAttached() {
    if (mode !== 'attached' || !client) return;
    const first = !launchStarted;
    launchStarted = true;
    const dataDir = personalPairingDir();
    if (!first || !dataDir || !nodeRunner) {
      connectNow();
      return;
    }
    await launchStart(dataDir, false);
  }

  // §7.4's Start/Restart buttons: only on a press. Answers once the start
  // is under way; the wait goes on in the background (statusChanged on
  // each step), so the pane is not held for up to 60 s.
  async function nodeStart({ restart = false } = {}) {
    const dataDir = personalPairingDir();
    if (!dataDir || !nodeRunner) return { ok: false, code: 'NOT_PERSONAL', error: NOT_PERSONAL_TEXT };
    if (mode !== 'attached' || !client) return { ok: false, code: 'NOT_ATTACHED', error: 'Attach to King Louie Node first.' };
    launchStarted = true;
    nodeState = { ...nodeState, starting: true, startError: null };
    notify();
    launchStart(dataDir, restart === true);
    return status();
  }

  // Resolves once no start is in flight.
  async function startIdle() {
    while (startRun) await startRun;
  }

  // §8: which data dir Install is for, and whose task it reads after.
  // The disk is read every time (C-7): a recorded data dir only says where
  // to look, and must still be a personal node's.
  async function installTarget() {
    if (!nodeRunner) return null;
    const recorded = personalDataDir();
    let local;
    try {
      local = await nodeRunner.detectPersonalNode(recorded ? { dataDir: recorded } : {});
    } catch (err) {
      log.warn(`personal node read failed: ${err.message}`);
      return null;
    }
    if (!local || !local.personal || !local.dataDir) return null;
    if (recorded && !samePath(local.dataDir, recorded)) return null;
    return { dataDir: local.dataDir, me: local.me };
  }

  function installResult(cli) {
    const lines = outputLines(cli && cli.stdout, cli && cli.stderr);
    if (cli && cli.code === 0) return { ok: true, lines };
    const message = firstLine(cli && cli.stderr) || firstLine(cli && cli.stdout)
      || (cli && cli.timedOut ? 'the command did not finish in time' : shown((cli && cli.error) || 'the command failed', 400));
    return { ok: false, code: 'NODE_INSTALL_FAILED', message, lines };
  }

  const notPersonalInstall = () => ({ ok: false, code: 'NOT_PERSONAL', message: NOT_PERSONAL_TEXT, error: NOT_PERSONAL_TEXT, lines: [] });

  async function nodeInstallPreview() {
    const target = await installTarget();
    if (!target) return notPersonalInstall();
    const cli = await nodeRunner.runCli(['install', '--personal', '--dry-run', '--data-dir', target.dataDir], { timeoutMs: INSTALL_CLI_TIMEOUT_MS });
    return installResult(cli);
  }

  async function nodeInstall({ confirmed = false } = {}) {
    if (confirmed !== true) {
      const text = 'Installing King Louie Node needs the Install press.';
      return { ok: false, code: 'CONFIRM_REQUIRED', message: text, error: text, lines: [] };
    }
    const target = await installTarget();
    if (!target) return notPersonalInstall();
    // §8: only while no task is registered.
    const before = await nodeRunner.queryTask({ me: target.me }).catch(() => ({ state: 'unknown' }));
    if (before.state !== 'missing') {
      nodeState = { ...nodeState, task: before.state };
      notify();
      const refusal = INSTALL_REFUSALS[before.state] || INSTALL_REFUSALS.unknown;
      return { ok: false, code: refusal.code, message: refusal.message, error: refusal.message, lines: [] };
    }
    const cli = await nodeRunner.runCli(['install', '--personal', '--yes', '--data-dir', target.dataDir], { timeoutMs: INSTALL_CLI_TIMEOUT_MS });
    // Whatever the install did, the task and the node are read again.
    const [task, running] = await Promise.all([
      nodeRunner.queryTask({ me: target.me }).catch(() => ({ state: 'unknown' })),
      nodeRunner.nodeRunning({ dataDir: target.dataDir }).catch(() => ({ running: false, pid: null }))
    ]);
    nodeState = { ...nodeState, task: task.state, ...runningFields(running) };
    notify();
    return installResult(cli);
  }

  resumePendingPair();

  return {
    status, pairStart, pairConfirm, pairRestartConfirm, pairCancel, attach, detach, standaloneOnce, unpair, retry,
    importPlan, importApply, dismissServiceCommand, createClient, setClient, dispose,
    startAttached, startIdle, refreshIdle, nodeStart, nodeInstallPreview, nodeInstall,
    on: (event, fn) => emitter.on(event, fn)
  };
}

module.exports = { createDesktopController, DETACH_WARNING, STANDALONE_ONCE };
