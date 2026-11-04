// Settings > Local service (fleet stage 7 §3.2, §3.7, §3.9): pairing, attach,
// detach, unpair, import. Mode switches persist and relaunch; handlers are
// never swapped under a live core. The private key is sealed with safeStorage
// and unsealed only for the moment of a signature.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('../logging');
const { DesktopBridgeClient } = require('../desktop-bridge/bridge-client');
const { encodePairRequest, defaultDeviceLabel, bridgeFilePath, readTrustedBridgeFile } = require('../desktop-bridge/pairing');
const { rawFromPublicKeyObject, fingerprintGroups } = require('../desktop-bridge/keys');
const { MESSAGES } = require('../desktop-bridge/protocol');
const { unavailableTabsFor } = require('../desktop-bridge/allowlist');
const { PERSONAL_CLI_FILE, defaultServiceDataDir, isPersonalCli } = require('../platform/paths');
const { nodeHosting, nodeVersion } = require('../desktop-bridge/pane-model');
const { describeSetup, nextSetupStep, setupFacts } = require('../desktop-bridge/setup-flow');
const { loadDesktopSource, planImport, applyImport } = require('./desktop-export');
const { backupProfile, backupDirFor, readBackupManifest, readCaseRoot } = require('../migration/profile-backup');
const { detectOldProfileApart } = require('../migration/old-profile-read');
const { verifyMigration, withSourceFacts } = require('../migration/migration-verify');
const { SECRET_CATEGORIES } = require('../migration/desktop-import');
const { createPersonalNodeRunner, PERSONAL_TASK_NAME, firstLine } = require('../desktop-bridge/personal-node');
const { shown } = require('../service/commands/io');
const { STANDALONE_FLAG, STANDALONE_ONCE_FLAG: STANDALONE_ONCE } = require('../desktop-bridge/launch-mode');

const log = createLogger('desktop-controller');

const DETACH_WARNING = 'After detaching, this app runs its own King Louie again next to the service; its cron jobs and channels may act twice. Stop the service if you no longer want it.';
// §6.1: on Windows a detached app has no core of its own; the launch rule brings
// it back to the setup screen. Once the profile is moved, Detach is refused.
const DETACH_WARNING_WINDOWS = 'After detaching, this app has no King Louie to show: it opens on the setup screen until you attach it again. King Louie keeps running in the background, with its cron jobs and channels, and nothing is deleted.';
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
// §6.5: named beside what the node's plan lists, since the engine walks none of them.
const STAYS_BEHIND_FIXED = Object.freeze([
  'Browser profiles: log in again in the node\'s browser.',
  'Local servers: add them to the node\'s service.json.',
  'The typesafe.ai key: enter it again on the node.'
]);
const MIGRATION_STORE_FILES = new Set(['history.sqlite', 'chat-data.json']);
const MOVE_RUNNING = { ok: false, code: 'MIGRATION_BUSY', error: 'The move of this profile is running; wait for it to finish.' };
// §6.3: how long a step waits for the old profile before it answers with a line,
// so a big profile does not leave the window blank. The read goes on.
const OLD_PROFILE_WAIT_MS = 1500;
const READING_OLD_PROFILE = 'Looking for your earlier King Louie on this computer…';
// Until the read answers, the walk stops at the move rather than go past it.
const OLD_PROFILE_UNKNOWN = Object.freeze({ found: true });
// The steps a Finish cannot jump: after them, the wizard's form takes over.
const BEFORE_THE_FORM = new Set(['install', 'pair', 'start', 'migrate']);
const INSTALL_ELEVATED = /runs as you, not elevated/;
const RESTARTING_AFTER_MOVE = 'Restarting King Louie Node, so what moved starts…';

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

// The CLI's own log lines (createLogger's `[subsystem] text`) are not what it
// says to the owner, so a pane never shows them.
const LOG_LINE = /^\[[A-Za-z][\w./-]*\]\s/;
const withoutLogLines = (text) => String(text || '').split(/\r?\n/).filter((l) => !LOG_LINE.test(l)).join('\n');

// A start refused for its task is about the task as it was. Read as registered
// now, that refusal is over, whatever else the error says stands.
const TASK_ERROR_CODES = new Set(['NODE_TASK_MISSING', 'NODE_TASK_DISABLED', 'NODE_TASK_OTHER_ACCOUNT', 'NODE_TASK_UNREADABLE']);
function withoutStaleTaskError(startError, taskState) {
  return startError && taskState === 'registered' && TASK_ERROR_CODES.has(startError.code) ? null : startError;
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
  // resolveLaunchMode's answer (spec 2026-11-03 §6.1), for desktop:status.
  launch = { host: mode, why: mode === 'attached' ? 'attached' : 'dev', degraded: false },
  cliExists = isPersonalCli,
  // What a personal node's version is compared with (spec 2026-11-03 §6.8).
  appVersion = app && typeof app.getVersion === 'function' ? app.getVersion() : null,
  // The personal node (spec 2026-10-28): the runner that reads and starts it,
  // and the clock and timers of the §7.3 wait (tests inject a fake clock).
  nodeRunner = platform === 'win32' ? createPersonalNodeRunner({ env, platform }) : null,
  clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  nodeStartWaitMs = NODE_START_WAIT_MS, nodeRetryMs = NODE_RETRY_MS, nodeRefreshMs = NODE_REFRESH_MS,
  oldProfileWaitMs = OLD_PROFILE_WAIT_MS,
  migrationDeps = {}
}) {
  const move = { detectOldProfile: detectOldProfileApart, backupProfile, loadDesktopSource, ...migrationDeps };
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
  // The one-time move (§6.5): this launch's backup, and the plan or apply
  // running now, so a second press joins it and nothing drops its session.
  let backupMade = null;
  let moveRun = null;
  // The setup (§6.3). What the last press answered, for describeSetup, and the
  // line of a step under way; both in memory, so a relaunch reads the facts anew.
  let answers = {};
  let setupProgress = null;
  let moveAnswer = null;
  let restartedAfterMove = false;
  let elevated = false;
  let migrateSkipped = false;
  let finishedForNow = false;
  let profileDefault = false;
  // The old profile, read once per launch and again when asked (§6.5). The read
  // takes a while on a big profile, so it has one run, and a run overtaken by a
  // Check again answers nobody.
  const oldRead = { known: false, value: null, run: null, generation: 0 };
  // A press arriving twice joins the run in flight.
  const pressRuns = new Map();

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
    const args = argv.slice(1).filter((a) => a !== STANDALONE_ONCE && a !== STANDALONE_FLAG).concat(extraArgs);
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
    // The launcher an install from this app wrote, beside the config dir. Only
    // shown to the owner as words to type; a checkout install has none.
    const cli = base.dataDir ? path.win32.join(path.win32.dirname(base.dataDir), PERSONAL_CLI_FILE) : null;
    return {
      hosting: 'personal', name: base.name || null, dataDir: base.dataDir || null,
      task: nodeState.task, running: nodeState.running, pid: nodeState.pid,
      starting: nodeState.starting, startError: nodeState.startError,
      defaultDataDir: cliDefaultDataDir(),
      ...(cli && cliExists(cli) ? { serviceCli: shown(cli, 400) } : {})
    };
  }

  // Where the CLI looks with no --data-dir, so the phone step's commands name it
  // only when they must.
  function cliDefaultDataDir() {
    if (platform !== 'win32') return null;
    try {
      return shown(defaultServiceDataDir({ platform, env }), 400);
    } catch {
      return null;
    }
  }

  const setRunning = (r) => { nodeState = { ...nodeState, ...runningFields(r) }; };

  const detachWarning = () => (platform === 'win32' ? DETACH_WARNING_WINDOWS : DETACH_WARNING);

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
    const record = pairing && pairing.service;
    const summary = liveService || (record && record.info) || null;
    // A node from before `hosting` says nothing: a personal pairing's record
    // always does, so no word anywhere is a fleet service.
    const service = summary ? {
      ...summary,
      hosting: nodeHosting(summary.hosting) || nodeHosting(record && record.hosting) || 'service',
      version: nodeVersion(summary.version)
    } : null;
    return withSetupStep({
      ok: true,
      mode,
      platform,
      view: current,
      standaloneOnce: mode === 'standalone' && argv.includes(STANDALONE_ONCE),
      migration: state.migration ? { ...state.migration, backupDir: shown(state.migration.backupDir, 400) } : null,
      launch: { ...launch },
      oldProfile: oldRead.known ? oldRead.value : null,
      elevated,
      userProfileDefault: profileDefault,
      setup: setupRecord(),
      profileDir: userDataDir ? shown(userDataDir, 400) : null,
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
      service,
      versionMismatch: versionGap(service, liveService),
      connection: current === 'attached-starting' ? { ...connection, status: 'starting' } : { ...connection },
      approvals,
      lastImport: state.lastImport,
      // The pairing record, as the attached host's routes go by it: the tabs
      // and the channels behind them cannot disagree.
      unavailableTabs: mode === 'attached' ? [...unavailableTabsFor(record && record.hosting)] : [],
      detachWarning: detachWarning(),
      pendingServiceCommand: state.pendingServiceCommand
    });
  }

  // --- §6.3: the setup's own state. ---

  function setupRecord() {
    const stored = state.setup || {};
    return {
      completedAt: stored.completedAt || null,
      phoneOffered: stored.phoneOffered === true,
      phoneSeen: stored.phoneSeen === true,
      migrateSkipped,
      finishedForNow
    };
  }

  // The step, from the status it goes with. describeSetup reads the same facts.
  function stepOf(s, oldProfile) {
    return nextSetupStep(setupFacts({ ...s, oldProfile }));
  }
  function withSetupStep(s) {
    s.setup.step = stepOf(s, oldRead.known ? oldRead.value : OLD_PROFILE_UNKNOWN);
    return s;
  }

  function invalidateOldProfile() {
    oldRead.known = false;
    oldRead.value = null;
    oldRead.run = null;
    oldRead.generation += 1;
  }

  function setOldProfile(value) {
    oldRead.generation += 1;
    oldRead.run = null;
    oldRead.known = true;
    oldRead.value = value;
  }

  // One read per launch. Never rejects: a failure is a problem on screen, never
  // nothing to move.
  function readOldProfile() {
    if (oldRead.known) return Promise.resolve(oldRead.value);
    if (oldRead.run) return oldRead.run;
    const generation = ++oldRead.generation;
    const failed = (err) => ({
      found: true, chats: 0, messages: 0, cases: 0, bytes: 0, customCasesRoot: null, customCases: 0,
      schemaProblem: shown(`The old profile could not be read: ${err.message}`, 400)
    });
    const run = (async () => {
      let value;
      try {
        value = await move.detectOldProfile(userDataDir, { env });
      } catch (err) {
        value = failed(err);
      }
      if (generation !== oldRead.generation) return readOldProfile();
      setOldProfile(value);
      if (!disposed) notify();
      return value;
    })();
    oldRead.run = run;
    return run;
  }

  // What only the node can say, read now, since the wizard's form saves over the
  // proxied channels and says nothing here. A node that cannot say is not asked
  // for a name: this reads only to skip a question.
  async function readNodeFacts() {
    if (mode !== 'attached' || !client || !client.connected || moveRun) return;
    if (!personalPairingDir() || (state.setup && state.setup.completedAt)) return;
    if (client.service && client.service.providersConfigured === false) {
      try { client.service = await client.call('bridge.status'); } catch { /* keep the old summary */ }
    }
    try {
      const loaded = await client.invoke('settings:load', []);
      const profile = loaded && (loaded.userProfile || (loaded.data && loaded.data.userProfile));
      profileDefault = Boolean(profile) && !profile.name && !profile.role && !profile.projectContext
        && !(Array.isArray(profile.goals) && profile.goals.length);
    } catch {
      profileDefault = false;
    }
  }

  function setProgress(line) {
    setupProgress = line;
    notify();
  }

  function clearAnswers() {
    answers = {};
  }

  // The answer for the window: what the last press said, beside the status.
  function describeNow(s, extra = {}) {
    const restarting = restartedAfterMove && (startRun || nodeState.starting);
    const facts = { ...s, ...answers, setupProgress: setupProgress || (restarting ? RESTARTING_AFTER_MOVE : null), ...extra };
    // The move is done either way, and the owner is told what is not up yet.
    const failed = restartedAfterMove && !restarting && nodeState.startError;
    if (failed && !facts.setupError) {
      facts.setupError = {
        code: failed.code,
        error: `King Louie Node did not restart after the move (${failed.message || failed.code}). Bots and MCP servers that moved start the next time it starts.`,
        offerRestart: true
      };
    }
    return { ok: true, ...describeSetup(facts) };
  }

  // The status with the old profile as far as it is known; `wait` is how long to
  // wait for it (Infinity for a decision the read must make).
  async function setupStatus(wait) {
    await readNodeFacts();
    const s = await status();
    // No setup to show, whatever the old profile holds: nothing is read for it.
    if (s.setup.step === 'done' || stepOf(s, OLD_PROFILE_UNKNOWN) === 'done') return { status: s, reading: false };
    if (!oldRead.known) {
      const read = readOldProfile();
      if (wait === Infinity) {
        await read;
      } else {
        const slot = { current: null };
        await Promise.race([read, sleep(wait, slot)]);
        wakeSlot(slot);
      }
    }
    if (!oldRead.known) return { status: s, reading: true };
    s.oldProfile = oldRead.value;
    s.setup.step = stepOf(s, oldRead.value);
    return { status: s, reading: false };
  }

  // §8's desktop:setupStep. Never leaves the walk past the move while it does not
  // know whether there is one: a line and no press until the read answers.
  async function setupStep() {
    const { status: s, reading } = await setupStatus(oldProfileWaitMs);
    if (reading) {
      const answer = describeNow({ ...s, oldProfile: OLD_PROFILE_UNKNOWN }, { setupProgress: setupProgress || READING_OLD_PROFILE });
      // A read can hang for as long as its time limit: Check again joins it, and says what it found.
      return setupProgress ? answer : { ...answer, actions: [...answer.actions, { id: 'retry', label: 'Check again' }] };
    }
    // The phone step's first instruction stops the node: once offered it stays.
    if (s.setup.step === 'phone' && !s.setup.phoneOffered) {
      state.noteSetup({ phoneOffered: true });
      s.setup.phoneOffered = true;
    }
    return describeNow(s);
  }

  // §6.3's Not now: the standalone-once relaunch, while there is something the
  // owner would be cut off from and nothing is under way.
  function setupLater() {
    return joined('later', async () => {
      clearAnswers();
      const refused = (answer) => { answers = { setupError: answer }; notify(); return answer; };
      if (state.migration) return refused(profileMigrated());
      if (moveRun) return { ...MOVE_RUNNING };
      const old = await readOldProfile();
      if (state.migration) return refused(profileMigrated());
      if (moveRun) return { ...MOVE_RUNNING };
      if (old && old.found && old.schemaProblem) {
        return refused({ ok: false, code: 'NOT_POSTPONABLE', error: 'Your earlier King Louie could not be read, so the old standalone mode cannot be relied on to open it. Press Retry, or Skip for now.' });
      }
      if (!old || !old.found) {
        return refused({ ok: false, code: 'NOT_POSTPONABLE', error: 'There is nothing on this computer to keep using, so there is no standalone mode to go back to.' });
      }
      return relaunch([STANDALONE_ONCE]);
    });
  }

  // §6.3's Done, and the Skip of the step it names: a press arriving twice finds
  // the walk already past that step and does nothing. Finishing stays closed
  // until the move has had its turn, and the first completedAt stands.
  async function setupFinish({ skip = null } = {}) {
    if (moveRun) return { ...MOVE_RUNNING };
    const { status: s } = await setupStatus(Infinity);
    // A window with its own core has no setup to finish.
    if (launch.host === 'standalone') return describeNow(s);
    const step = s.setup.step;
    const answer = async () => {
      notify();
      return setupStep();
    };
    if (skip !== null) {
      if (skip !== step) return describeNow(s);
      if (step === 'migrate') {
        migrateSkipped = true;
        clearAnswers();
        if (importSession && importSession.move && !moveRun) closeImportSession();
      } else if (step === 'phone') {
        state.noteSetup({ phoneSeen: true });
      } else {
        return { ok: false, code: 'SETUP_CANNOT_SKIP', error: 'This step cannot be skipped.' };
      }
      return answer();
    }
    if (state.setup && state.setup.completedAt) return answer();
    if (BEFORE_THE_FORM.has(step)) {
      answers = { setupError: { ok: false, code: 'SETUP_NOT_DONE', error: 'King Louie Node is not set up yet; this step comes first.' } };
      notify();
      return answers.setupError;
    }
    if (step === 'phone') state.noteSetup({ phoneSeen: true });
    // A move skipped and not made is not a setup finished: the window goes on for
    // this launch, and the move is offered at the next. A read that failed for a
    // passing reason offers that Skip, so it must not close the move for good.
    if (migrateSkipped && !state.migration) {
      finishedForNow = true;
      return answer();
    }
    state.setSetup({ completedAt: now().toISOString() });
    return answer();
  }

  function joined(key, work) {
    if (pressRuns.has(key)) return pressRuns.get(key);
    const run = Promise.resolve().then(work).finally(() => {
      if (pressRuns.get(key) === run) pressRuns.delete(key);
    });
    pressRuns.set(key, run);
    return run;
  }

  // §6.8, C-12: only a node this launch has heard from. The version in the
  // pairing record is the one it had when paired, and a personal node may have
  // been updated since. The fleet updates its own service: no gap to show.
  function versionGap(service, liveService) {
    if (!liveService || service.hosting !== 'personal') return null;
    const node = service.version;
    if (!node || !appVersion || node === appVersion) return null;
    return { node, app: appVersion };
  }

  // The unpaired view's node: what the inspector said, plus the task and
  // whether a node runs (§7.1), so the pane can offer Install.
  async function unpairedNode(local) {
    // §6.4: nothing here yet, so Install is the way on (attach stage 2).
    if (local && local.fresh === true) {
      nodeState = { ...nodeState, task: 'missing', ...runningFields(null) };
      return {
        fresh: true, personal: false, dataDir: shown(local.dataDir, 400), task: 'missing', running: false, pid: null,
        starting: false, startError: null, defaultDataDir: cliDefaultDataDir()
      };
    }
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
    // A confirm that held clears the pending pair, which is what `current` looks
    // at: that is the flow ending, not the flow overtaken.
    let confirmed = false;
    const waited = await waitForNode({
      dataDir,
      since,
      slot,
      isCurrent: () => confirmed || current(),
      attempt: async () => {
        found = record;
        const r = await pairConfirm({ nodeId: record.nodeId });
        if (r && r.ok && r.view && r.view !== 'pairing') {
          confirmed = true;
          return { done: true, result: r };
        }
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
    // §6.3 step 2: from the setup, pairing ends attached. The pane's own pairing
    // keeps its Attach press.
    if (launch.why === 'needs-node') return attach();
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

  function pairStart() {
    return joined('pair', async () => {
      clearAnswers();
      const out = await startPairing();
      if (out && out.ok === false) {
        answers = { setupError: out };
        notify();
      }
      return out;
    });
  }

  async function startPairing() {
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
    pressRuns.delete('pair');
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

  // §6.5: what the marker says, for a refusal.
  function profileMigrated() {
    const { at, backupDir } = state.migration;
    return {
      ok: false,
      code: 'PROFILE_MIGRATED',
      error: `This profile was moved into King Louie Node on ${shown(String(at).slice(0, 10), 20)}; its copy here is kept but no longer used. The backup is at ${shown(backupDir, 400)}.`
    };
  }
  const migratedRefusal = () => (state.migration && launch.why !== 'dev' ? profileMigrated() : null);

  async function detach({ confirmed = false } = {}) {
    const migrated = migratedRefusal();
    if (migrated) return migrated;
    if (confirmed !== true) return { ok: false, code: 'CONFIRM_REQUIRED', error: detachWarning() };
    state.setMode('standalone');
    return relaunch();
  }

  async function standaloneOnce() {
    const migrated = migratedRefusal();
    if (migrated) return migrated;
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

  // Check again: the facts are read anew, and what the last press said goes. The
  // screens that say to fix something and press this rely on it.
  async function retry() {
    if (client) client.retryNow().catch(() => {});
    clearAnswers();
    elevated = false;
    // A read still under way joins: a new one would leave its child reading the
    // whole store beside this one, one more for every press while a read hangs.
    if (!oldRead.run) invalidateOldProfile();
    // A refusal for this app being elevated is about that launch's CLI run.
    const pending = state.pendingPair;
    if (pending && pending.personal && personalFlow && personalFlow.request === pending.request
      && personalFlow.error && personalFlow.error.code === 'PAIR_ELEVATED') {
      state.setPendingPair(null);
      personalFlow = null;
      pressRuns.delete('pair');
      found = null;
      foundError = null;
    }
    await refreshNode({ force: true }).catch(() => {});
    notify();
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
    if (moveRun) return { ...MOVE_RUNNING };
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
    if (moveRun) return { ...MOVE_RUNNING };
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

  // One at a time: a second press of the same step gets the run in flight, and
  // the other step is refused until it ends.
  function runMove(kind, work) {
    if (moveRun) return moveRun.kind === kind ? (moveAnswer || moveRun.promise) : Promise.resolve({ ...MOVE_RUNNING });
    moveAnswer = null;
    const promise = work().finally(() => { moveRun = null; });
    moveRun = { kind, promise };
    return promise;
  }

  // The live connection to this desktop's personal node, or why there is none.
  // The move needs the node up, and a backup for a move that cannot run is waste.
  function moveTarget() {
    const pairing = state.pairing;
    if (!pairing || !pairing.service) return { refusal: { ok: false, code: 'NOT_PAIRED', error: 'Pair with the local service first.' } };
    const live = client && client.service && client.service.hosting;
    if (pairing.service.hosting !== 'personal' || (live && live !== 'personal')) {
      return { refusal: { ok: false, code: 'NOT_PERSONAL', error: NOT_PERSONAL_TEXT } };
    }
    if (!client || !client.connected) {
      return { refusal: { ok: false, code: 'SERVICE_UNREACHABLE', error: MESSAGES.SERVICE_UNREACHABLE(pairing.service.port) } };
    }
    return { client, service: pairing.service };
  }

  const backupProgress = (stage) => (p) => send('desktop:importProgress', { stage, ...p, sent: p.files, total: p.totalFiles });

  // §6.5: once per launch, while what it wrote still reads whole.
  // A backup taken while cases were outside the profile does not hold them once
  // the owner has moved them in, so a changed count makes a new one.
  async function ensureBackup(onProgress, customCases) {
    const sameRoot = backupMade && (backupMade.customCases === undefined || backupMade.customCases === customCases);
    if (sameRoot && await readBackupManifest(backupMade.dest, { onProgress: backupProgress('backup-check') })) return backupMade;
    backupMade = await move.backupProfile({
      userDataDir, dest: backupDirFor(userDataDir, now), now, appVersion, env, onProgress
    });
    return backupMade;
  }

  const moveSourceRefusal = (error) => ({ ok: false, code: 'MIGRATION_SOURCE', error: shown(error, 600) });

  // The source as read now against the backup just made of it: a store that
  // stopped reading, or a reader that dropped chats, must not plan a smaller
  // move that then verifies.
  function sourceProblem(source, backup) {
    const refused = source.attention.filter((a) => a.category === 'source' && MIGRATION_STORE_FILES.has(a.key));
    if (refused.length) return refused.map((a) => `${a.key}: ${a.note}`).join('; ');
    const chats = source.inventory.chats.map((c) => source.getValue('chat', c.id));
    const messages = chats.reduce((n, c) => n + (c && Array.isArray(c.messages) ? c.messages.length : 0), 0);
    if (chats.length < backup.history.chats || messages < backup.history.messages) {
      return `the profile reads as ${chats.length} chats and ${messages} messages, and its backup holds ${backup.history.chats} and ${backup.history.messages}`;
    }
    return null;
  }

  function staysBehindLines(plan) {
    const named = (plan.items || []).filter((i) => i.action === 'skip-excluded' && i.note).map((i) => i.note);
    return [...new Set([...named, ...STAYS_BEHIND_FIXED])].map((line) => shown(line, 400));
  }

  // What the owner reads of a plan or a report; the session keeps the real one.
  const shownEntry = (entry) => {
    const out = { ...entry };
    for (const key of ['category', 'key', 'targetKey', 'note', 'error']) {
      if (out[key] !== null && out[key] !== undefined) out[key] = shown(out[key], key === 'note' || key === 'error' ? 400 : 200);
    }
    return out;
  };
  const shownEntries = (list) => (Array.isArray(list) ? list.filter(Boolean).map(shownEntry) : []);
  const shownReport = (report) => ({
    ...report,
    failures: shownEntries(report.failures),
    attention: shownEntries(report.attention),
    incomplete: shownEntries(report.incomplete),
    secretsMissing: shownEntries(report.secretsMissing),
    skipped: shownEntries(report.skipped),
    sendFailures: shownEntries(report.sendFailures),
    notes: Array.isArray(report.notes) ? report.notes.map((n) => shown(n, 400)) : []
  });

  // What the owner must still see, as plain data: secrets that did not come, and
  // whatever the plan, the source or the landing says needs attention. Each once.
  function leftBehindOf({ plan, source, report = null }) {
    const items = Array.isArray(plan.items) ? plan.items : [];
    const entry = ({ category, key, note }) => shownEntry({ category, key, note: note || null });
    const once = (list) => {
      const seen = new Set();
      return list.filter(({ category, key }) => {
        const id = `${category}:${key}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }).map(entry);
    };
    const isSecret = (i) => SECRET_CATEGORIES.has(i.category);
    const open = items.filter((i) => i.action === 'needs-attention' || i.action === 'needs-desktop');
    const reported = (key) => (report && Array.isArray(report[key]) ? report[key].filter(Boolean) : []);
    return {
      needsAttention: once([...open.filter((i) => !isSecret(i)), ...reported('attention').filter((i) => !isSecret(i)), ...(source.attention || [])]),
      secrets: once([...open.filter(isSecret), ...reported('secretsMissing'), ...reported('attention').filter(isSecret)])
    };
  }

  // What a press does for the setup around a move: what it says on screen while
  // it runs, and its answer after. A press refused because another run is under
  // way changes nothing on screen, and neither does one joining a run.
  function movePress(field, line, run, after = null) {
    if (moveRun) return run();
    clearAnswers();
    setProgress(line);
    const promise = run().then((answer) => {
      answers[field] = answer;
      if (after) after(answer);
      setProgress(null);
      return answer;
    }, (err) => {
      setProgress(null);
      throw err;
    });
    // A second press gets the first press's answer, with its after-work done.
    moveAnswer = promise;
    return promise;
  }

  function migrationPlan() {
    return movePress('migrationPlan', READING_OLD_PROFILE, runMigrationPlan);
  }

  function migrationApply(payload = {}) {
    if (!payload || payload.confirmed !== true) return runMigrationApply(payload);
    return movePress('migrationResult', 'Moving your chats and cases into King Louie Node…', () => runMigrationApply(payload), (answer) => {
      // An apply that never began left the store as it was; anything that ran may
      // have changed what there is to move.
      if (answer.code !== 'PLAN_EXPIRED') invalidateOldProfile();
      if (answer.ok === true) restartAfterMove();
    });
  }

  // What landed (MCP servers, bots, hooks) starts only when the node does, and
  // otherwise stays down until the next logon. A restart the node refuses shows
  // on its row; the move is done either way.
  function restartAfterMove() {
    restartedAfterMove = true;
    state.clearRestartDue();
    nodeStartNow({ restart: true }).catch((err) => log.warn(`restarting King Louie Node after the move failed: ${err.message}`));
  }

  function runMigrationPlan() {
    return runMove('plan', async () => {
      if (state.migration) return profileMigrated();
      // Planning the move is the owner taking back a Skip for now: the walk goes on
      // to the move and its Finish, rather than staying finished for this launch.
      finishedForNow = false;
      migrateSkipped = false;
      const target = moveTarget();
      if (target.refusal) return target.refusal;
      try {
        const old = await move.detectOldProfile(userDataDir, { env });
        setOldProfile(old);
        if (old.schemaProblem) return moveSourceRefusal(`The old profile cannot be read, so nothing was moved: ${old.schemaProblem}`);
        if (!old.found) return moveSourceRefusal('This profile holds no chats or cases to move.');
        let backup;
        try {
          setProgress('Making a backup of your earlier King Louie…');
          backup = await ensureBackup(backupProgress('backup'), old.customCases);
        } catch (err) {
          return { ok: false, code: err.code || 'BACKUP_FAILED', error: shown(err.message, 800), backupDir: err.dest ? shown(err.dest, 400) : null };
        }
        setProgress('Working out what will move…');
        const source = await move.loadDesktopSource({ userDataDir, safeStorage, platform, customRootEmpty: old.customCases === 0 });
        const problem = sourceProblem(source, backup);
        if (problem) return moveSourceRefusal(`The old profile did not read whole, so nothing was moved: ${problem}`);
        closeImportSession();
        const plan = withSourceFacts(await planImport({ client: target.client, source }), source);
        // A case the reader holds back whole is in no plan, so nothing could ever
        // find it missing: the apply refuses while there is one.
        const heldCases = shownEntries(source.attention.filter((a) => a.category === 'case' && a.wholeCase === true));
        const refusedFiles = source.attention.filter((a) => a.category === 'case' && a.wholeCase !== true && String(a.key).includes('/')).length;
        importSession = {
          client: target.client,
          temporary: false,
          plan,
          source,
          move: { backup, service: target.service, customCasesRoot: old.customCasesRoot, customCases: old.customCases, heldCases, refusedFiles }
        };
        return {
          ok: true,
          backup: {
            dest: shown(backup.dest, 400),
            bytes: backup.bytes,
            files: backup.files,
            history: backup.history,
            customCasesRoot: old.customCasesRoot ? shown(old.customCasesRoot, 400) : null,
            customCases: old.customCases,
            customCasesMissing: old.customCasesMissing === true
          },
          plan: {
            ...plan,
            items: plan.items.map(shownEntry),
            dirtyCases: plan.dirtyCases.map((d) => ({ key: shown(d.key), note: shown(d.note, 400) }))
          },
          heldCases,
          refusedFiles,
          attention: shownEntries(source.attention),
          staysBehind: staysBehindLines(plan),
          leftBehind: leftBehindOf({ plan, source })
        };
      } catch (err) {
        closeImportSession();
        return { ok: false, code: err.code || 'IMPORT_FAILED', error: shown(err.message, 600) };
      }
    });
  }

  function runMigrationApply({ confirmed = false } = {}) {
    if (confirmed !== true) {
      return Promise.resolve({ ok: false, code: 'CONFIRM_REQUIRED', error: 'Moving this profile needs the owner\'s press.' });
    }
    return runMove('apply', async () => {
      if (state.migration) return profileMigrated();
      const session = importSession && importSession.move ? importSession : null;
      if (!session) return { ok: false, code: 'PLAN_EXPIRED', error: 'The plan for this move expired; plan it again.' };
      const { backup, service, customCasesRoot, customCases, heldCases, refusedFiles } = session.move;
      // The move carries only the profile's own cases folder, so marking it
      // would leave these behind with no way back to them from this profile. The
      // plan's count is only what it was: a drive can go, or a case arrive, since.
      const caseRootRefusal = async () => {
        if (!customCasesRoot) return null;
        const now = await readCaseRoot(customCasesRoot);
        if (now.customCases === 0) return null;
        return moveSourceRefusal(now.customCasesMissing
          ? `The cases folder ${shown(customCasesRoot, 400)} is not there, so its cases would not move. Plug its drive in, or if that folder is no longer used make an empty folder at that path, and plan again.`
          : `Cases under ${shown(customCasesRoot, 400)} are outside this profile and would not move. Move them into the profile's cases folder, or out of use, and plan again.`);
      };
      if (customCases !== 0 && customCasesRoot) {
        const refused = await caseRootRefusal();
        return refused || moveSourceRefusal(`The cases folder ${shown(customCasesRoot, 400)} has changed since the plan, so plan again.`);
      }
      const rootChanged = await caseRootRefusal();
      if (rootChanged) return rootChanged;
      if (heldCases.length) {
        const names = heldCases.map((h) => h.key).join(', ');
        return moveSourceRefusal(`${heldCases.length === 1 ? 'A case cannot' : 'Cases cannot'} be moved as ${heldCases.length === 1 ? 'it stands' : 'they stand'}: ${names}. Nothing was moved. Sort ${heldCases.length === 1 ? 'it' : 'them'} out on the desktop and plan again.`);
      }
      try {
        const report = await applyImport({
          client: session.client,
          plan: session.plan,
          source: session.source,
          onProgress: (p) => send('desktop:importProgress', p)
        });
        state.setLastImport({ at: now().toISOString(), counts: report.counts });
        if (client && client.connected) {
          try { client.service = await client.call('bridge.status'); } catch { /* keep the old summary */ }
        }
        setProgress('Checking what landed on the node…');
        const verified = await verifyMigration({
          plan: session.plan,
          report,
          invoke: (channel, args = []) => session.client.invoke(channel, args)
        });
        const shownOut = shownReport(report);
        const leftBehind = leftBehindOf({ plan: session.plan, source: session.source, report });
        if (!verified.ok) {
          return {
            ok: false,
            code: 'MIGRATION_UNVERIFIED',
            error: `${verified.missing.length} ${verified.missing.length === 1 ? 'item' : 'items'} on the node do not match the desktop, so this profile was not marked as moved. Nothing was removed. Each one says what it needs; what is only missing lands if you move again.`,
            report: shownOut,
            leftBehind,
            refusedFiles,
            verified
          };
        }
        // The mark is what stops the old profile opening, so the backup it names
        // must still be whole at that moment.
        if (!(await readBackupManifest(backup.dest, { onProgress: backupProgress('backup-check') }))) {
          backupMade = null;
          return {
            ok: false,
            code: 'BACKUP_FAILED',
            error: `The move is on the node, but its backup at ${shown(backup.dest, 400)} no longer reads whole, so this profile was not marked as moved. Try again: a new backup is made first.`,
            report: shownOut,
            leftBehind,
            refusedFiles,
            verified
          };
        }
        const rootGone = await caseRootRefusal();
        if (rootGone) return { ...rootGone, report: shownOut, leftBehind, refusedFiles, verified };
        try {
          state.setMigration({
            at: now().toISOString(),
            // Cleared as the restart goes; an app death before that leaves it for the next launch.
            restartDue: true,
            backupDir: backup.dest,
            nodeDataDir: service.dataDir || null,
            nodeId: service.nodeId,
            counts: { ...verified.checked, attention: Array.isArray(report.attention) ? report.attention.length : 0 },
            leftBehind,
            // Both outlast the plan: the setup keeps them on screen up to Done.
            private: session.plan.private || null,
            staysBehind: staysBehindLines(session.plan),
            notes: shownOut.notes
          });
        } catch (err) {
          log.warn(`the migration marker was not written: ${err.message}`);
          return { ok: false, code: 'MIGRATION_MARK_FAILED', error: `The move is on the node, but this profile could not be marked as moved (${shown(err.message, 300)}). Try again.`, report: shownOut, leftBehind, refusedFiles, verified };
        }
        log.info('this profile was moved into the node and verified', verified.checked);
        return { ok: true, report: shownOut, leftBehind, refusedFiles, verified };
      } catch (err) {
        return { ok: false, code: err.code || 'IMPORT_FAILED', error: shown(err.message, 600) };
      } finally {
        closeImportSession();
        notify();
      }
    });
  }

  // A plan lives on the node for its connection: after a drop only a new one can
  // be applied. A move in flight ends with its own refusal.
  function forgetPlan() {
    if (moveRun) return;
    if (importSession && importSession.move) closeImportSession();
    if (answers.migrationPlan && answers.migrationPlan.ok) delete answers.migrationPlan;
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
        forgetPlan();
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
    // A restart refused while connected leaves the connection it had: no second one.
    if (client && !client.connected) client.connect().catch((err) => log.warn(`the local service is not reachable yet: ${err.message}`));
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
      nodeState = { ...nodeState, task: task.state, ...runningFields(running), startError: withoutStaleTaskError(nodeState.startError, task.state) };
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
    // A move marked by a launch that died before its restart: owed once.
    const owed = Boolean(state.migration && state.migration.restartDue);
    if (owed) {
      state.clearRestartDue();
      restartedAfterMove = true;
    }
    await launchStart(dataDir, owed);
  }

  // §7.4's Start/Restart buttons: only on a press. Answers once the start
  // is under way; the wait goes on in the background (statusChanged on
  // each step), so the pane is not held for up to 60 s.
  async function nodeStart({ restart = false } = {}) {
    clearAnswers();
    const out = await nodeStartNow({ restart });
    if (out && out.ok === false) answers = { setupError: out };
    return out;
  }

  const nodeRestart = () => nodeStart({ restart: true });

  async function nodeStartNow({ restart = false } = {}) {
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
  // to look, and must still be a personal node's. With none recorded, a
  // machine with nothing on it may be installed on (attach stage 2 §6.4).
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
    if (!local || !local.dataDir) return null;
    if (!local.personal && !(local.fresh === true && !recorded)) return null;
    if (recorded && !samePath(local.dataDir, recorded)) return null;
    return { dataDir: local.dataDir, me: local.me };
  }

  function installResult(cli) {
    const stdout = withoutLogLines(cli && cli.stdout);
    const stderr = withoutLogLines(cli && cli.stderr);
    const lines = outputLines(stdout, stderr);
    if (cli && cli.code === 0) return { ok: true, lines };
    const message = firstLine(stderr) || firstLine(stdout)
      || (cli && cli.timedOut ? 'the command did not finish in time' : shown((cli && cli.error) || 'the command failed', 400));
    return { ok: false, code: 'NODE_INSTALL_FAILED', message, lines };
  }

  const notPersonalInstall = () => ({ ok: false, code: 'NOT_PERSONAL', message: NOT_PERSONAL_TEXT, error: NOT_PERSONAL_TEXT, lines: [] });

  // What the setup keeps of an install press, and the elevated refusal in it.
  function installPress(field, line, work) {
    return joined(field, async () => {
      clearAnswers();
      elevated = false;
      setProgress(line);
      let answer;
      try {
        answer = await work();
      } finally {
        setupProgress = null;
      }
      answers[field] = answer;
      if (!answer.ok && INSTALL_ELEVATED.test(`${answer.message || ''}\n${(answer.lines || []).join('\n')}`)) elevated = true;
      notify();
      return answer;
    });
  }

  function nodeInstallPreview() {
    return installPress('installPreview', 'Reading what installing would do…', runInstallPreview);
  }

  function nodeInstall(payload = {}) {
    if (!payload || payload.confirmed !== true) return runInstall(payload);
    return installPress('installResult', 'Installing King Louie Node…', () => runInstall(payload));
  }

  async function runInstallPreview() {
    const target = await installTarget();
    if (!target) return notPersonalInstall();
    const cli = await nodeRunner.runCli(['install', '--personal', '--dry-run', '--data-dir', target.dataDir], { timeoutMs: INSTALL_CLI_TIMEOUT_MS });
    return installResult(cli);
  }

  async function runInstall({ confirmed = false } = {}) {
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
    importPlan, importApply, migrationPlan, migrationApply, dismissServiceCommand, createClient, setClient, dispose,
    startAttached, startIdle, refreshIdle, nodeStart, nodeRestart, nodeInstallPreview, nodeInstall,
    setupStep, setupLater, setupFinish, finishedForNow: () => finishedForNow,
    on: (event, fn) => emitter.on(event, fn)
  };
}

module.exports = { createDesktopController, DETACH_WARNING, DETACH_WARNING_WINDOWS, STANDALONE_ONCE };
