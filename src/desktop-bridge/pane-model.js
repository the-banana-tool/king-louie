// What Settings > Local service shows for each state (fleet stage 7 §3.9).
// Pure, so the wording is tested in node; the preload exposes it to the renderer.
const { MESSAGES } = require('./protocol');

const UNAVAILABLE_TAB_NOTICE = 'Managed by the local service; not available while attached.';
const INSTALL_HINT = 'Install king-louie-service on this computer and run it with the agent profile to use this app as its window.';

function dirOf(file) {
  const text = String(file || '');
  const i = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return i > 0 ? text.slice(0, i) : text;
}

function serviceLines(status) {
  const lines = [];
  const fp = status.pairing && status.pairing.service && status.pairing.service.fingerprint;
  if (fp) lines.push(`Service: ${fp}`);
  const svc = status.service;
  if (svc && svc.account) {
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
      break;
    case 'attached-connected':
      lines.push(...serviceLines(s));
      lines.push('Chats made while attached live in the service.');
      actions.push({ id: 'import', label: 'Import…' }, { id: 'detach', label: 'Detach' }, { id: 'unpair', label: 'Unpair' });
      break;
    case 'attached-disconnected': {
      const c = s.connection || {};
      lines.push(c.error || MESSAGES.SERVICE_UNREACHABLE(18795));
      if (c.nextRetryAt) lines.push(`Next retry at ${new Date(c.nextRetryAt).toLocaleTimeString()}.`);
      actions.push({ id: 'retry', label: 'Retry now' }, { id: 'standaloneOnce', label: 'Use standalone this time' }, { id: 'detach', label: 'Detach' });
      break;
    }
    default: {
      const b = s.bridge || {};
      if (b.ok) lines.push('A local King Louie service is installed on this computer.');
      else if (b.code === 'BRIDGE_FILE_UNTRUSTED' && b.error) lines.push(b.error);
      else lines.push(b.error || `No local service found at ${dirOf(s.bridgeFile)}.`);
      lines.push(INSTALL_HINT);
      actions.push({ id: 'pair', label: 'Pair' });
    }
  }
  return { view: s.view || 'unpaired', lines, actions, request, command, detachWarning: s.detachWarning || null, approvals: describeApprovals(s) };
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

module.exports = { describeServicePane, describeApprovals, describeImportReport, UNAVAILABLE_TAB_NOTICE };
