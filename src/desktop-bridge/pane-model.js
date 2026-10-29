// What Settings > Local service shows for each state (fleet stage 7 §3.9).
// Pure, so the wording is tested in node; the preload exposes it to the renderer.
const { MESSAGES, DEFAULT_DESKTOP_BRIDGE_PORT } = require('./protocol');

const UNAVAILABLE_TAB_NOTICE = 'Managed by the local service; not available while attached.';
const INSTALL_HINT = 'Install king-louie-service on this computer and run it with the agent profile to use this app as its window.';

function dirOf(file) {
  const text = String(file || '');
  const i = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return i > 0 ? text.slice(0, i) : text;
}

// Desktop attached to the personal node (spec 2026-10-28 §6.2, §6.4, §7.4,
// §8, §11). Every string the node, the CLI or the task read supplies (the
// node's name, a refusal's message, a log line, the install's output) goes
// through `shown`: one plain line, marked when anything was removed.
function plain(value) {
  // Required here: the preload loads this module, and only these views need it.
  const { shown } = require('../service/commands/io');
  return shown(value);
}

const NODE_LINES = {
  NODE_TASK_MISSING: 'King Louie Node has no logon task on this computer, so this app cannot start it.',
  NODE_TASK_DISABLED: 'The logon task "KingLouie Node" is disabled in Task Scheduler. Enable it there to let this app start the node.',
  NODE_TASK_OTHER_ACCOUNT: 'The logon task "KingLouie Node" belongs to another account; this app does not run it.',
  NODE_START_TIMEOUT: 'King Louie Node did not answer within 60 seconds.',
  NOT_RUNNING: 'King Louie Node is not running.',
  STARTING: 'Starting King Louie Node…'
};
const TASK_CODES = { missing: 'NODE_TASK_MISSING', disabled: 'NODE_TASK_DISABLED', 'other-account': 'NODE_TASK_OTHER_ACCOUNT' };
const START_FAILED = (line) => `King Louie Node stopped while starting: ${plain(line)}`;
const RUN_FAILED = (message) => `King Louie Node could not be started: ${plain(message)}`;
const STOP_FAILED = (message) => `King Louie Node could not be stopped: ${plain(message)}`;
const RUNNING_NO_BRIDGE = (pid) => `King Louie Node is running (pid ${plain(pid)}) but its desktop bridge is not open.`;
const PAIR_ELEVATED_LINE = 'This app is running as administrator. Close it and open it normally to pair.';
const PERSONAL_PAIR_WARNING = 'Every paired desktop sees every chat, setting and secret name in the node.';
const INSTALL_ACTION = { id: 'nodeInstallPreview', label: 'Install…' };

// A personal node is what the status says now (`node`, read from the disk
// each time) or what the pairing recorded; a fleet status has neither.
function personalNode(s) {
  return s.node && s.node.hosting === 'personal' ? s.node : null;
}
function isPersonal(s) {
  return Boolean(personalNode(s) || (s.pairing && s.pairing.service && s.pairing.service.hosting === 'personal'));
}
function installOffered(s) {
  const n = personalNode(s);
  return Boolean(n && n.task === 'missing');
}
function errorText(error) {
  if (!error) return '';
  return String(error.message || error.error || error.code || '');
}

// The §6.4 pane line for a refusal, by its code.
function refusalLine(error) {
  const code = error && error.code;
  const text = errorText(error);
  if (code === 'PAIR_ELEVATED') return PAIR_ELEVATED_LINE;
  if (code === 'PAIR_COMMAND_FAILED') return /^Pairing did not finish/.test(text) ? plain(text) : `Pairing did not finish: ${plain(text)}`;
  if (code === 'NODE_START_FAILED') return START_FAILED(text);
  if (code === 'NODE_TASK_RUN_FAILED') return RUN_FAILED(text);
  if (code === 'NODE_STOP_FAILED') return STOP_FAILED(text);
  if (NODE_LINES[code]) return NODE_LINES[code];
  return plain(text);
}

// §7.4: the line and the added button for an attached personal pairing that
// is not connected, from what the controller found. `install` is the added
// button for a missing task (the pane opens the preview; the banner opens
// the pane). Null: nothing found to say, so today's line stands.
function disconnectedRow(n, { install }) {
  const err = n.startError;
  if (err && err.code === 'NODE_START_FAILED') return { line: START_FAILED(errorText(err)), action: { id: 'nodeStart', label: 'Start King Louie Node' } };
  if (err && err.code === 'NODE_START_TIMEOUT') return { line: NODE_LINES.NODE_START_TIMEOUT, action: null };
  if (err && err.code === 'NODE_TASK_RUN_FAILED') return { line: RUN_FAILED(errorText(err)), action: { id: 'nodeStart', label: 'Start King Louie Node' } };
  if (err && err.code === 'NODE_STOP_FAILED') return { line: STOP_FAILED(errorText(err)), action: { id: 'nodeRestart', label: 'Restart King Louie Node' } };
  const taskCode = TASK_CODES[n.task] || (err && Object.values(TASK_CODES).includes(err.code) ? err.code : null);
  if (taskCode === 'NODE_TASK_MISSING') return { line: NODE_LINES.NODE_TASK_MISSING, action: install };
  if (taskCode) return { line: NODE_LINES[taskCode], action: null };
  if (n.running) return { line: RUNNING_NO_BRIDGE(n.pid), action: { id: 'nodeRestart', label: 'Restart King Louie Node' } };
  if (n.task === 'registered') return { line: NODE_LINES.NOT_RUNNING, action: { id: 'nodeStart', label: 'Start King Louie Node' } };
  return null;
}

function personalPairingPane(s, lines, actions) {
  const p = s.pendingPair || {};
  const n = personalNode(s) || {};
  if (p.deviceFingerprint) lines.push(`This desktop: ${p.deviceFingerprint}`);
  if (p.error) {
    lines.push(refusalLine(p.error));
    actions.push({ id: 'pair', label: 'Try again' }, { id: 'pairCancel', label: 'Cancel' });
    return;
  }
  switch (p.stage) {
    case 'restart-needed':
      lines.push(`King Louie Node is running (pid ${plain(n.pid)}). Pairing restarts it: a turn or a take in progress stops.`);
      actions.push({ id: 'pairRestartConfirm', label: 'Restart and pair' }, { id: 'pairCancel', label: 'Cancel' });
      break;
    case 'starting':
      lines.push(NODE_LINES.STARTING);
      break;
    case 'confirming':
      lines.push('Checking the node\'s desktop bridge…');
      break;
    default:
      lines.push(n.name ? `Pairing with King Louie Node "${plain(n.name)}"…` : 'Pairing with King Louie Node…');
  }
}

function serviceLines(status) {
  const lines = [];
  const fp = status.pairing && status.pairing.service && status.pairing.service.fingerprint;
  if (fp) lines.push(`Service: ${fp}`);
  const svc = status.service;
  if (isPersonal(status)) {
    if (svc && svc.version) lines.push(`Version ${svc.version}.`);
    lines.push(svc && svc.account ? `Running as you (${plain(svc.account)}), in your session.` : 'Running as you, in your session.');
  } else if (svc && svc.account) {
    lines.push(`Version ${svc.version}, running as ${svc.account}.`);
    lines.push(`Tools will run as ${svc.account}.`);
  } else {
    lines.push('Tools will run as the service account, not as you.');
  }
  if (svc && svc.providersConfigured === false) lines.push(MESSAGES.NO_PROVIDER);
  return lines;
}

function describeApprovals(status) {
  if (status.view !== 'attached-connected') return null;
  const a = status.approvals;
  const commands = ['king-louie-service enroll-device', 'king-louie-service device revoke <device-id>'];
  if (!a || !a.available) return { lines: ['Phone approvals are not set up on this service.'], commands };
  const lines = [];
  if (a.relay && a.relay.configured) {
    lines.push(`Relay ${a.relay.relay_id || ''}: ${a.relay.connected ? `connected since ${a.relay.since}` : 'not connected'}`);
  } else {
    lines.push('No relay is configured.');
  }
  for (const d of a.devices || []) lines.push(`${d.name || d.device_id} (${d.platform || 'unknown'})${d.active ? '' : ' — inactive'}`);
  for (const p of a.pending || []) lines.push(`Waiting: ${p.summary} (until ${p.expires_at})`);
  if (a.audit && a.audit.last_seq !== null && a.audit.last_seq !== undefined) lines.push(`Audit ledger: entry ${a.audit.last_seq} at ${a.audit.last_at}`);
  return { lines, commands };
}

function describeServicePane(status = {}) {
  const s = status || {};
  const lines = [];
  const actions = [];
  let request = null;
  let command = null;
  switch (s.view) {
    case 'pairing': {
      const p = s.pendingPair || {};
      if (p.personal) {
        personalPairingPane(s, lines, actions);
        break;
      }
      request = p.request || null;
      command = p.command || null;
      lines.push(`This desktop: ${p.deviceFingerprint}`);
      if (p.service) lines.push(`Service: ${p.service.fingerprint} (port ${p.service.port})`);
      else if (p.error && p.error.code === 'BRIDGE_FILE_UNTRUSTED') lines.push(p.error.error);
      else lines.push('Waiting for the service… run the command below as an administrator.');
      lines.push('Compare both fingerprints with what the command printed before you confirm.');
      actions.push({ id: 'pairConfirm', label: 'Confirm', disabled: !p.service }, { id: 'pairCancel', label: 'Cancel' });
      break;
    }
    case 'paired':
      lines.push(...serviceLines(s));
      actions.push({ id: 'import', label: 'Import…' }, { id: 'attach', label: 'Attach' }, { id: 'unpair', label: 'Unpair' });
      if (installOffered(s)) actions.push(INSTALL_ACTION);
      break;
    case 'attached-connected':
      lines.push(...serviceLines(s));
      lines.push('Chats made while attached live in the service.');
      actions.push({ id: 'import', label: 'Import…' }, { id: 'detach', label: 'Detach' }, { id: 'unpair', label: 'Unpair' });
      if (installOffered(s)) actions.push(INSTALL_ACTION);
      break;
    case 'attached-starting':
      lines.push(NODE_LINES.STARTING);
      break;
    case 'attached-disconnected': {
      const c = s.connection || {};
      const knownPort = s.pairing && s.pairing.service && s.pairing.service.port;
      const n = personalNode(s);
      const row = n ? disconnectedRow(n, { install: INSTALL_ACTION }) : null;
      lines.push(row ? row.line : (c.error || MESSAGES.SERVICE_UNREACHABLE(knownPort || DEFAULT_DESKTOP_BRIDGE_PORT)));
      if (c.nextRetryAt) lines.push(`Next retry at ${new Date(c.nextRetryAt).toLocaleTimeString()}.`);
      actions.push({ id: 'retry', label: 'Retry now' }, { id: 'standaloneOnce', label: 'Use standalone this time' }, { id: 'detach', label: 'Detach' });
      if (row && row.action) actions.push(row.action);
      break;
    }
    default: {
      const n = personalNode(s);
      if (n) {
        lines.push(`King Louie Node "${plain(n.name)}" runs on this computer as you.`, PERSONAL_PAIR_WARNING);
        actions.push({ id: 'pair', label: 'Pair' });
        if (installOffered(s)) actions.push(INSTALL_ACTION);
        break;
      }
      const b = s.bridge || {};
      if (b.ok) lines.push('A local King Louie service is installed on this computer.');
      else if (b.code === 'BRIDGE_FILE_UNTRUSTED' && b.error) lines.push(b.error);
      else lines.push(b.error || `No local service found at ${dirOf(s.bridgeFile)}.`);
      lines.push(INSTALL_HINT);
      actions.push({ id: 'pair', label: 'Pair' });
    }
  }
  return {
    view: s.view || 'unpaired', lines, actions, request, command,
    detachWarning: s.detachWarning || null, approvals: describeApprovals(s),
    serviceCommand: describeServiceCommand(s)
  };
}

// The banner over the chat while attached and not connected (§7.4), so
// renderer.js holds no copy of the rules. Null: no banner. Action ids:
// `retry`, `standaloneOnce`, `openServiceSettings` (also the Install… row:
// it opens Settings > Local service, where the preview runs), `nodeStart`,
// `nodeRestart`.
function describeAttachedBanner(status) {
  const s = status || {};
  if (s.view === 'attached-starting') return { line: NODE_LINES.STARTING, actions: [] };
  if (s.view !== 'attached-disconnected') return null;
  const n = personalNode(s);
  const row = n ? disconnectedRow(n, { install: { id: 'openServiceSettings', label: 'Install…' } }) : null;
  const actions = [
    { id: 'retry', label: 'Retry now' },
    { id: 'standaloneOnce', label: 'Use standalone this time' },
    { id: 'openServiceSettings', label: 'Local service settings' }
  ];
  if (row && row.action) actions.push(row.action);
  const c = s.connection || {};
  return { line: row ? row.line : (c.error || 'The local King Louie service is not reachable.'), actions };
}

// §8: `install --personal --dry-run`'s output (lines for a <pre>), then the
// Install press, which is the consent the CLI's [y/N] asks for.
function installLines(result) {
  return (Array.isArray(result && result.lines) ? result.lines : []).map((l) => plain(l));
}
function describeInstallPreview(result = {}) {
  const lines = installLines(result);
  const ok = Boolean(result && result.ok);
  const actions = ok ? [{ id: 'nodeInstall', label: 'Install' }] : [];
  actions.push({ id: 'nodeInstallCancel', label: 'Cancel' });
  return { lines, pre: lines.join('\n'), error: ok ? null : refusalLine(result), actions };
}
function describeInstallResult(result = {}) {
  const lines = installLines(result);
  const ok = Boolean(result && result.ok);
  return { lines, pre: lines.join('\n'), error: ok ? null : refusalLine(result), actions: [] };
}

// A follow-up CLI command the owner still needs to run on the service (e.g.
// after unpair). Independent of `view` — it survives a repaint, an unpair
// that changes the view, and (persisted server-side) a relaunch — and is
// shown until the owner dismisses it or a new pairing starts.
function describeServiceCommand(status) {
  const p = status.pendingServiceCommand;
  if (!p || typeof p.command !== 'string' || !p.command) return null;
  return { command: p.command, line: `Run this on the service to finish removing this desktop: ${p.command}` };
}

function describeImportReport(report = {}) {
  const lines = [];
  const counts = report.counts || {};
  lines.push(Object.entries(counts).filter(([, n]) => n).map(([action, n]) => `${action}: ${n}`).join(', '));
  for (const f of report.failures || []) lines.push(`Failed: ${f.category} ${f.key} — ${f.error}`);
  for (const f of report.sendFailures || []) lines.push(`Not sent: ${f.category} ${f.key} — ${f.error}`);
  for (const s of report.skipped || []) lines.push(`Not read: ${s.category} ${s.key} — ${s.error}`);
  if ((report.secretsMissing || []).length) lines.push(`Secrets that did not arrive: ${report.secretsMissing.map((s) => `${s.category} ${s.key}`).join(', ')}`);
  for (const a of report.attention || []) lines.push(`Needs attention: ${a.category} ${a.key} — ${a.note}`);
  for (const note of report.notes || []) lines.push(note);
  return lines;
}

// Detach needs a genuine second click on the rendered warning ("Detach
// anyway"), not just a flag — a click can outrun the render that shows
// that warning (e.g. while the pane awaits a status() round trip), and a
// stale click must not confirm on the strength of `armed` alone. The
// renderer stamps every paint that changes the pane's shape with a token
// that only increases; arming records the token of the paint that showed
// the warning, and a click confirms only if no such repaint happened since
// (`armedAtToken === currentToken`) AND at least DETACH_CONFIRM_DELAY_MS
// has passed since that paint — a second click that beats even that short
// delay is a double-click, not a deliberate second decision, and re-arms
// instead. Pure and tiny so it is unit tested without a DOM.
const DETACH_CONFIRM_DELAY_MS = 400;

function decideDetachClick({ armed, armedAtToken, currentToken, armedAt, now } = {}) {
  const sameRender = armed && armedAtToken === currentToken;
  const elapsed = typeof armedAt === 'number' && typeof now === 'number' ? now - armedAt : -Infinity;
  if (sameRender && elapsed >= DETACH_CONFIRM_DELAY_MS) return { confirm: true, arm: false };
  return { confirm: false, arm: true };
}

// A repaint that changes nothing the owner could act on — same view, same
// exact set of actions — must not by itself invalidate an armed Detach.
// Only a change the owner could actually see and react to (a different
// view, or different/disabled actions) should force a re-arm. Compared by
// value, not identity, since the renderer rebuilds the model object on
// every render even when nothing meaningful changed.
function paneShapeChanged(prevModel, nextModel) {
  if (!prevModel || !nextModel) return true;
  if (prevModel.view !== nextModel.view) return true;
  return JSON.stringify(prevModel.actions) !== JSON.stringify(nextModel.actions);
}

module.exports = {
  describeServicePane, describeApprovals, describeImportReport, describeServiceCommand,
  describeAttachedBanner, describeInstallPreview, describeInstallResult,
  decideDetachClick, paneShapeChanged, DETACH_CONFIRM_DELAY_MS, UNAVAILABLE_TAB_NOTICE
};
