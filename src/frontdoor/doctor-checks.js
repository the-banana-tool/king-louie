// `doctor` on a front door (fleet stage 4 §3.14). It reads what the running
// service recorded (probe.json, acme/cert.json, alerts.json) rather than
// re-verifying stores the service owns (Deviation 29).
//
// Policy comes only from the admin config dir: the startup rows judge the
// parsed admin node.yaml/service.json, and the approver set is the admin
// approvers/ dir (test keys never allowed). The data-dir files are status
// only, read as untrusted input: small regular files (never links), shape
// checked, and a file that is there but unreadable is a failure, never
// "all clear". Text from them is shown without control characters.
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { startupRows } = require('./startup-checks');
const { SelfProbe, readStatusJson } = require('./probe');
const { LETS_ENCRYPT_PRODUCTION } = require('./config');

const DAY_MS = 86400000;
// The unit installers.js writes (UNIT_PATH there).
const UNIT_PATH = '/etc/systemd/system/king-louie.service';
const NO_PHONE = 'No phone enrolled on this front door: run "king-louie-service frontdoor enroll-device"';
const MAX_CERT_FILE_BYTES = 64 * 1024;
// 500 alerts with ≤ 4 KiB of detail each, plus framing.
const MAX_ALERTS_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SHOWN_CHARS = 200;
const REASON_CODE_RE = /^[a-z_]{1,64}$/;
const CONTROL_FORMAT_RE = /[\p{Cc}\p{Cf}]/gu;

// What each AuditMirror break means for the owner, and what to do about it.
// A reason not listed here is printed as its code.
const BREAK_REASONS = Object.freeze({
  fork: 'the node\'s audit history no longer matches the copy this front door kept, so part of it was rewritten; check the node for tampering, then acknowledge the alert on your phone.',
  truncated: 'the node\'s audit history is now shorter than the copy this front door kept, so entries were deleted or its ledger was reset; check the node, then acknowledge the alert on your phone.',
  replay: 'the node sent an old part of its audit history again instead of its current head (a restored backup or a replayed message); check the node, then acknowledge the alert on your phone.',
  withheld_entries: 'the node signed a history that skips entries this front door has never seen; check the node\'s audit ledger for removed entries, then acknowledge the alert on your phone.',
  oversize_entry: 'one audit entry on the node is too large to mirror, so mirroring of this node has stopped; find the oversized entry in the node\'s audit ledger (king-louie-service doctor on the node).',
  oversize_page: 'the node sent more audit entries in one page than allowed, so the page was refused; update King Louie on the node so both sides match, and check it for tampering if it persists.',
  wrong_node: 'audit history signed for a different node arrived on this node\'s link; check which machine holds this node\'s key, then acknowledge the alert on your phone.',
  malformed_head: 'the node signed an audit head that is not valid, so its history was refused; update King Louie on the node, and check it for tampering if it persists.',
  mirror_state_corrupt: 'this front door\'s own mirror state for the node was damaged or deleted, so it can no longer vouch for the node\'s history; check the front door\'s data dir, then acknowledge the alert on your phone.'
});

function shown(value) {
  const s = String(value).replace(CONTROL_FORMAT_RE, '');
  return s.length > MAX_SHOWN_CHARS ? `${s.slice(0, MAX_SHOWN_CHARS - 1)}…` : s;
}

function present(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

function describeAlert(a) {
  const head = `${shown(a.kind)} ${shown(a.subject)}`;
  const detail = a.detail !== null && typeof a.detail === 'object' ? a.detail : {};
  if (a.kind === 'audit_gap') {
    return Number.isInteger(detail.from_seq) && Number.isInteger(detail.to_seq)
      ? `${head} (entries ${detail.from_seq}–${detail.to_seq} are missing from the mirror)`
      : head;
  }
  if (detail.reason === undefined) return head;
  const reason = typeof detail.reason === 'string' && REASON_CODE_RE.test(detail.reason) ? detail.reason : null;
  if (reason === null) return `${head} (unknown reason)`;
  return Object.hasOwn(BREAK_REASONS, reason) ? `${head} (${reason}): ${BREAK_REASONS[reason]}` : `${head} (${reason})`;
}

function fetchDate(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let req = null;
    const deadline = setTimeout(() => { if (req) req.destroy(); resolve(null); }, timeoutMs);
    if (typeof deadline.unref === 'function') deadline.unref();
    const done = (value) => {
      clearTimeout(deadline);
      resolve(value);
    };
    try {
      // No redirects are followed (https.request never does); any answer's
      // Date header will do, since only the clock is read.
      req = https.request(url, { method: 'HEAD', agent: false, timeout: timeoutMs }, (res) => {
        res.resume();
        const date = Date.parse(res.headers.date || '');
        done(Number.isFinite(date) ? new Date(date) : null);
      });
    } catch {
      done(null);
      return;
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => done(null));
    req.end();
  });
}

function readUnit() {
  try {
    return fs.readFileSync(UNIT_PATH, 'utf8');
  } catch {
    return null;
  }
}

async function checks({ dataDir, configDir, adminUid = 0, nodeConfig, serviceConfig, platform = process.platform, deps = {} } = {}) {
  const now = deps.now || Date.now;
  const fd = (nodeConfig && nodeConfig.frontdoor) || {};
  const rows = [...startupRows({ serviceConfig, nodeConfig })];
  const push = (check, ok, detail, extra = {}) => rows.push({ check, ok, detail, ...extra });
  const fdDir = path.join(dataDir, 'frontdoor');

  let store = deps.approverStore || null;
  try {
    if (!store) {
      const { ApproverStore } = require('../approvals/approver-store');
      store = new ApproverStore({ dir: path.join(configDir, 'approvers'), stagedDir: path.join(dataDir, 'approvals', 'staged'), platform, adminUid, serviceProbe: false });
      await store.ready();
    }
    const count = store.activeCount();
    push('phone enrolled on this front door', count > 0, count > 0 ? `${count} active` : NO_PHONE);
  } catch (err) {
    push('phone enrolled on this front door', false, `${NO_PHONE} (${shown(err.message)})`);
  }

  const probeFile = path.join(fdDir, 'probe.json');
  const probe = SelfProbe.readLast(probeFile);
  if (!probe) {
    push('self-probe (DNS, mcp. and mesh.)', false, present(probeFile)
      ? `cannot read ${probeFile}; the service rewrites it at its next probe`
      : 'no self-probe result yet (the service probes 60 s after it starts)');
  } else {
    push('self-probe (DNS, mcp. and mesh.)', probe.ok === true, probe.ok === true
      ? `ok at ${shown(probe.at)}`
      : `${shown(probe.at)}: ${[probe.mcp, probe.mesh].filter((x) => !x.ok).map((x) => shown(x.detail)).join('; ')}`);
  }

  let notAfter = null;
  if (fd.tls) {
    try {
      notAfter = Date.parse(new crypto.X509Certificate(fs.readFileSync(fd.tls.certFile)).validTo);
      if (!Number.isFinite(notAfter)) throw new Error('no expiry date');
    } catch (err) {
      notAfter = null;
      push('mcp. certificate', false, `cannot read ${fd.tls.certFile}: ${shown(err.message)}`);
    }
  } else {
    const certFile = path.join(fdDir, 'acme', 'cert.json');
    if (!present(certFile)) {
      push('mcp. certificate', false, 'waiting for ACME (no certificate issued yet)');
    } else {
      const cert = readStatusJson(certFile, MAX_CERT_FILE_BYTES);
      const at = cert !== null && typeof cert === 'object' && typeof cert.not_after === 'string' ? Date.parse(cert.not_after) : NaN;
      if (Number.isFinite(at)) notAfter = at;
      else push('mcp. certificate', false, `cannot read ${certFile}; the service rewrites it at its next renewal check`);
    }
  }
  if (notAfter !== null) {
    const days = Math.floor((notAfter - now()) / DAY_MS);
    if (days < 21) push('mcp. certificate', false, `${days} days left${fd.tls ? '' : ' (renewal should have happened; see the acme_renewal_failing alert)'}`);
    else push('mcp. certificate', true, `${days} days left`);
  }

  const port = fd.listen ? fd.listen.port : 443;
  if (platform !== 'linux') push('CAP_NET_BIND_SERVICE', true, 'not checked (the frontdoor profile installs on Linux only)', { warn: true });
  else if (port >= 1024) push('CAP_NET_BIND_SERVICE', true, `not needed (port ${port})`);
  else {
    let unit = null;
    let problem = null;
    try {
      unit = (deps.readUnit || readUnit)();
    } catch (err) {
      problem = err.message;
    }
    const has = Boolean(typeof unit === 'string' && /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m.test(unit));
    push('CAP_NET_BIND_SERVICE', has, has
      ? 'the unit grants it'
      : `the unit lacks AmbientCapabilities=CAP_NET_BIND_SERVICE; run install --profile frontdoor again (port ${port})${problem ? ` (${shown(problem)})` : ''}`);
  }

  const alertsFile = path.join(fdDir, 'alerts.json');
  if (!present(alertsFile)) {
    push('node and grant records verify', true, 'verified by the service at its last load');
    push('no unacknowledged audit breaks', true, 'none');
  } else {
    const stored = readStatusJson(alertsFile, MAX_ALERTS_FILE_BYTES);
    if (stored === null || typeof stored !== 'object' || !Array.isArray(stored.alerts)) {
      const detail = `cannot read ${alertsFile} (the service's alerts), so this is not known; check the phone's alert list`;
      push('node and grant records verify', false, detail);
      push('no unacknowledged audit breaks', false, detail);
    } else {
      const open = stored.alerts.filter((a) => a !== null && typeof a === 'object' && a.acked !== true);
      const invalid = open.filter((a) => a.kind === 'node_record_invalid');
      push('node and grant records verify', invalid.length === 0, invalid.length ? invalid.map((a) => shown(a.subject)).join(', ') : 'verified by the service at its last load');
      const breaks = open.filter((a) => a.kind === 'audit_chain_break' || a.kind === 'audit_gap');
      push('no unacknowledged audit breaks', breaks.length === 0, breaks.length ? breaks.map(describeAlert).join('; ') : 'none');
    }
  }

  const directory = fd.acme ? fd.acme.directory : LETS_ENCRYPT_PRODUCTION;
  let date = null;
  try {
    date = await (deps.fetchDate || fetchDate)(directory);
  } catch {
    date = null;
  }
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    if (fd.acme) push('clock skew', false, `could not reach ${directory}`);
    else push('clock skew', true, `not checked (${directory} unreachable)`, { warn: true });
  } else {
    const skew = Math.round(Math.abs(date.getTime() - now()) / 1000);
    push('clock skew', skew <= 30, skew <= 30 ? `${skew} s` : `${skew} s (more than 30 s)`);
  }
  return rows;
}

module.exports = { checks, NO_PHONE, BREAK_REASONS };
