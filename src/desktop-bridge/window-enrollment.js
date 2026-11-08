// How a new window gets the owner's phone to approve it on a node (remote window plan
// R-RW-14, R-RW-15, R-RW-36). A front door carries every message and decides nothing:
// each answer is verified here against an approver's device key, a hash the window and
// the node's key are bound into, and the one request this node signed.
//
// A window's record is in desktop-devices.json. On a personal node the service owns that
// file and writes it on an approve. On a fleet node it is the administrator's: the
// approved pair is staged and `device apply` writes it, so an approve counts for nothing
// until then. A revoke acts at once either way: the file on a personal node, the store's
// in-memory overlay on a fleet one. isEnrolled reads the file and the overlay on each ask.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { assertAdminOwned } = require('../service/config');
const { plainLineProblem } = require('../cases/hidden-chars');
const { open } = require('../approvals/envelope');
const { MessageError, iso, WINDOW_ID_RE } = require('../approvals/messages');
const {
  WINDOW_PLATFORM, ENROLL_TTL_MS, spkiHex, refusedWindowKey,
  buildWindowEnroll, buildWindowList, openWindowEnroll, verifyWindowResponse, verifyWindowRevoke, revokeCovers
} = require('../approvals/window-messages');
const { deriveDeviceId, fromB64url } = require('./keys');
const {
  DEVICES_FILE, DEVICES_CONTROLS, emptyDevices, parseDevices, upsertDevice, removeDevice, findDevice,
  validateLabel, writeFileAtomic
} = require('./pairing');

const log = createLogger('window-enrollment');

const DEFAULT_LIMITS = Object.freeze({
  // A card on the owner's phone each, so few: one window asks once.
  requestsPerHour: 20
});
const HOUR_MS = 60 * 60 * 1000;
// How long an answered or lapsed request is remembered, for a window that polls late.
const RETAIN_MS = ENROLL_TTL_MS;
const PENDING = 'pending';
const STAGED = 'staged';
const APPROVED = 'approved';
const DENIED = 'denied';

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

const rejected = (reason) => ({ state: 'rejected', reason });

// The record file, for both writers: the service on a personal node, `device apply` on a
// fleet one. A file that cannot be read or trusted throws: the caller says no.
function createWindowDevices({ configDir, dataDir = null, identity, geteuid = null, adminUid = 0 }) {
  const file = path.join(configDir, DEVICES_FILE);
  const read = () => {
    if (!fs.existsSync(file)) return emptyDevices();
    if (geteuid) assertAdminOwned(file, geteuid, adminUid, DEVICES_CONTROLS);
    return parseDevices(fs.readFileSync(file, 'utf8'));
  };
  // Keeps the file's mode and, as root, its owner. A new one is what `desktop pair`
  // makes: readable by the service's group.
  const save = (doc) => {
    let st = null;
    try { st = fs.statSync(file); } catch { st = null; }
    const mode = st ? st.mode & 0o7777 : 0o640;
    writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, mode);
    if (process.platform === 'win32') return;
    fs.chmodSync(file, mode);
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
    if (st) fs.chownSync(file, st.uid, st.gid);
    else if (dataDir) fs.chownSync(file, 0, fs.statSync(dataDir).gid);
  };
  const agree = identity.box ? identity.box.agree : () => { throw new MessageError('no_box', 'this node has no box key'); };
  return {
    nodeId: identity.nodeId,
    agree,
    read,
    find: (deviceId) => findDevice(read(), deviceId),
    write: (record) => save(upsertDevice(read(), { ...record, remote: true })),
    remove: (deviceId) => save(removeDevice(read(), deviceId).doc),
    openRequest: (envelope) => openWindowEnroll({ envelope, nodeSpki: spkiHex(identity), nodeId: identity.nodeId, agree })
  };
}

function createWindowEnrollment({
  identity, configDir, dataDir, approvals, hosting = 'service', sealPolicy, now = Date.now,
  attached = () => [], limits = {}, geteuid = null, adminUid = 0, allowTestKeys = false
}) {
  const { approverStore: store, auditLedger, relayClient: link } = approvals;
  const devices = createWindowDevices({ configDir, dataDir, identity, geteuid, adminUid });
  const personal = hosting === 'personal';
  const settings = { ...DEFAULT_LIMITS, ...limits };
  // request id -> { request_id, deviceId, envelope, message, state, answeredBy, answer }
  const requests = new Map();
  const asked = [];
  const listeners = new Set();
  let closed = false;

  const audit = (kind, data) => {
    if (!auditLedger) return;
    try {
      Promise.resolve(auditLedger.append({ kind, data })).catch((err) => log.warn(`audit ${kind} failed: ${err.message}`));
    } catch (err) {
      log.warn(`audit ${kind} failed: ${err.message}`);
    }
  };

  const changed = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        log.warn(`an enrollment listener failed: ${err.message}`);
      }
    }
  };

  const expiresOf = (entry) => Date.parse(entry.message.expires_at);
  const lapsed = (entry) => entry.state === PENDING && now() > expiresOf(entry);

  const sweep = () => {
    const t = now();
    for (const [id, entry] of requests) if (t > expiresOf(entry) + RETAIN_MS) requests.delete(id);
    while (asked.length > 0 && t - asked[0] > HOUR_MS) asked.shift();
  };

  const pendingOf = (deviceId) => {
    for (const entry of requests.values()) {
      if (entry.deviceId === deviceId && entry.state === PENDING && !lapsed(entry)) return entry;
    }
    return null;
  };

  // A revoke still in force over this record.
  const revokedRecord = (record) => {
    const at = store.windowOverlay ? store.windowOverlay.get(record.deviceId) : undefined;
    return at !== undefined && revokeCovers(record, at);
  };

  const readRecord = (deviceId) => {
    try {
      return devices.find(deviceId);
    } catch (err) {
      log.warn(`the devices file cannot be read: ${err.message}`);
      return null;
    }
  };

  const signerOf = (deviceId) => {
    const record = store.get(deviceId);
    if (!record) return null;
    return store.isActive(deviceId) ? record : { ...record, inactive: true };
  };

  const send = (entry) => link.send(entry.envelope, {
    push: { kind: 'window', id: entry.request_id, expires_at: entry.message.expires_at },
    to_device: null
  });

  // The mailbox is the relay's memory: what is pending goes again when the link is back.
  const resend = () => {
    for (const entry of requests.values()) {
      if (entry.state === PENDING && !lapsed(entry)) send(entry).catch((err) => log.warn(`a window's request did not go out: ${err.code || err.message}`));
    }
  };
  if (link && typeof link.on === 'function') link.on('connected', resend);

  function checkLabel(label) {
    try {
      validateLabel(label);
    } catch {
      throw refusal('bad_label', 'a window label is one plain line of at most 64 bytes');
    }
    if (plainLineProblem(label)) throw refusal('bad_label', 'a window label is one plain line of at most 64 bytes');
  }

  function checkKey(deviceId, publicKey) {
    let raw;
    try {
      raw = fromB64url(publicKey);
    } catch {
      throw refusal('bad_key', 'not a key');
    }
    if (raw.length !== 32 || deriveDeviceId(raw, 'kld-') !== deviceId) throw refusal('bad_key', 'the device id is not this key\'s');
    const refused = refusedWindowKey(raw, { allowTestKeys });
    if (refused) throw refusal(refused, 'this key cannot be enrolled');
  }

  async function request({ deviceId, publicKey, label }) {
    if (closed) throw refusal('remote_window_off', 'this node is not taking windows');
    sweep();
    let canSeal = false;
    try {
      canSeal = sealPolicy.canSeal() === true;
    } catch {
      canSeal = false;
    }
    if (!canSeal) throw refusal('node_not_sealing', 'this node cannot seal to a phone: apply a phone\'s box key');
    checkKey(deviceId, publicKey);
    checkLabel(label);
    const pending = pendingOf(deviceId);
    if (pending) return { request_id: pending.request_id, expires_at: pending.message.expires_at };
    if (asked.length >= settings.requestsPerHour) throw refusal('rate_limited', 'too many windows have asked this hour');
    asked.push(now());
    const window = { device_id: deviceId, public_key: publicKey, label, platform: WINDOW_PLATFORM };
    let built;
    try {
      built = buildWindowEnroll({ identity, window, nodeKey: spkiHex(identity), sealPolicy, now: now() });
    } catch (err) {
      if (err instanceof MessageError) throw refusal('node_not_sealing', 'this node cannot seal to a phone');
      throw err;
    }
    const entry = { request_id: built.message.request_id, deviceId, envelope: built.envelope, message: built.message, state: PENDING, answeredBy: null, answer: null };
    requests.set(entry.request_id, entry);
    try {
      await send(entry);
    } catch (err) {
      requests.delete(entry.request_id);
      log.warn(`a window's request did not go out: ${err.code || err.message}`);
      throw refusal('phone_unreachable', 'the phones cannot be reached from this node');
    }
    return { request_id: entry.request_id, expires_at: entry.message.expires_at };
  }

  // What a window is told. `approved` only when the record is there to attach by.
  function status(requestId, deviceId) {
    const entry = typeof requestId === 'string' ? requests.get(requestId) : null;
    if (!entry || entry.deviceId !== deviceId) return { state: 'unknown' };
    if (lapsed(entry)) return { state: 'expired' };
    return { state: entry.state };
  }

  function writeApproved(entry, phoneId, envelope) {
    const { window } = entry.opened;
    const existing = devices.find(window.device_id);
    if (existing && existing.remote !== true) return rejected('not_remote');
    if (personal) {
      devices.write({ deviceId: window.device_id, publicKey: window.public_key, label: window.label, pairedAt: iso(now()) });
      entry.state = APPROVED;
      audit('window.enrolled', { device_id: window.device_id, by: phoneId, envelope: null });
      return { state: 'approved' };
    }
    const staged = store.stage(envelope, { window: { request: entry.envelope } });
    if (staged.state !== 'staged') return rejected(staged.reason || staged.state);
    entry.state = STAGED;
    return { state: 'approved', pending_apply: true };
  }

  // Never throws, and nothing awaits between the check of `answer` and setting it: the
  // first answer stands.
  function onResponse(envelope) {
    sweep();
    let requestId = null;
    try {
      requestId = open(envelope).message.request_id;
    } catch {
      return rejected('malformed');
    }
    const entry = typeof requestId === 'string' ? requests.get(requestId) : null;
    const verdict = verifyWindowResponse({
      envelope, expected: entry ? entry.message : null, nodeId: identity.nodeId, signerOf, agree: devices.agree, now: now()
    });
    if (verdict.reason) return rejected(verdict.reason);
    if (entry.answer) {
      if (entry.answeredBy === verdict.message.device_id) return entry.answer;
      return rejected('already_answered');
    }
    const opened = devices.openRequest(entry.envelope);
    if (opened.reason) return rejected(opened.reason);
    entry.opened = opened.content;
    const phoneId = verdict.message.device_id;
    let answer;
    if (verdict.decision === 'approve') {
      try {
        answer = writeApproved(entry, phoneId, envelope);
      } catch (err) {
        log.error(`a window's record could not be written: ${err.message}`);
        return rejected('write_failed');
      }
      if (answer.state === 'rejected') return answer;
    } else {
      entry.state = DENIED;
      answer = { state: 'denied' };
      audit('window.denied', { device_id: entry.deviceId, by: phoneId });
    }
    entry.answer = answer;
    entry.answeredBy = phoneId;
    changed();
    return answer;
  }

  // Any pending request of this window ends: a revoke says no to it as well.
  function withdraw(deviceId) {
    for (const entry of requests.values()) {
      if (entry.deviceId !== deviceId || entry.answer) continue;
      entry.state = DENIED;
      // Nobody's answer: whoever answers next, the revoking phone too, is told it is over.
      entry.answer = rejected('already_answered');
      entry.answeredBy = null;
    }
  }

  function onRevoke(envelope) {
    const verdict = verifyWindowRevoke({ envelope, nodeId: identity.nodeId, signerOf, now: now() });
    if (verdict.reason) return rejected(verdict.reason);
    const { window_id: windowId, device_id: phoneId, created_at: createdAt } = verdict.message;
    if (!WINDOW_ID_RE.test(windowId)) return rejected('malformed');
    let record;
    try {
      record = devices.find(windowId);
    } catch (err) {
      log.warn(`a revoke met an unreadable devices file: ${err.message}`);
      record = null;
      if (personal) return rejected('write_failed');
    }
    if (record && record.remote !== true) return rejected('not_remote');
    // Replayed, or held back: it is about an enrollment before this one.
    if (record && !revokeCovers(record, Date.parse(createdAt))) return { state: 'stale' };
    withdraw(windowId);
    let answer;
    if (personal) {
      try {
        if (record) devices.remove(windowId);
      } catch (err) {
        log.error(`a window's record could not be removed: ${err.message}`);
        changed();
        return rejected('write_failed');
      }
      audit('window.revoked', { device_id: windowId, by: phoneId, envelope: null });
      answer = { state: 'revoked' };
    } else {
      const staged = store.stage(envelope, { window: {} });
      if (staged.state === 'duplicate') answer = { state: 'revoked-pending-apply' };
      else if (staged.state === 'revoked-pending-apply') answer = staged;
      else answer = rejected(staged.reason || staged.state);
    }
    changed();
    return answer;
  }

  function list(toDevice) {
    const record = store.get(toDevice);
    if (!record) throw refusal('unknown_device', 'no such phone on this node');
    if (!store.isActive(toDevice)) throw refusal('signer_not_active', 'this phone no longer approves here');
    if (!record.box_key) throw refusal('no_box_key', 'this phone has no box key');
    const live = new Set(attached());
    const windows = devices.read().devices
      .filter((d) => d.remote === true && !revokedRecord(d))
      .map((d) => ({ device_id: d.deviceId, label: d.label, platform: WINDOW_PLATFORM, enrolled_at: new Date(Date.parse(d.pairedAt)).toISOString(), attached: live.has(d.deviceId) }));
    return buildWindowList({ identity, toDevice, recipientBox: record.box_key, windows, now: now() });
  }

  function isEnrolled(deviceId) {
    const record = readRecord(deviceId);
    return Boolean(record) && record.remote === true && !revokedRecord(record);
  }

  return {
    request,
    status,
    onResponse,
    onRevoke,
    list,
    isEnrolled,
    revokedRecord,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    held() {
      sweep();
      return requests.size;
    },
    close() {
      closed = true;
      if (link && typeof link.off === 'function') link.off('connected', resend);
      listeners.clear();
    }
  };
}

module.exports = { createWindowEnrollment, createWindowDevices };
