// Pairing request, <configDir>/desktop-devices.json and desktop-bridge.json
// (fleet stage 7 §3.2, §4.1–§4.3).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { deriveNodeId } = require('../mesh/node-identity');
const { adminConfigDir, defaultServiceDataDir } = require('../platform/paths');
const { windowsPowerShellExe } = require('../platform/windows-paths');
const { deriveDeviceId, fromB64url, toB64url } = require('./keys');
const { PROTOCOL, DEVICE_ID_RE } = require('./protocol');

const PAIR_PREFIX = 'klpair1';
const DEVICES_FILE = 'desktop-devices.json';
const BRIDGE_FILE = 'desktop-bridge.json';
const LABEL_MAX_BYTES = 64;
const LABEL_SUFFIX = "'s desktop";
// C0 controls, DEL and the C1 controls (U+0080-009F, spec §4.1) so a raw
// terminal-control byte can never reach a device list or a pairing UI; the
// bidi override/isolate controls (U+202A-202E, U+2066-2069) so a label can't
// be crafted to display as something other than what it is; the zero-width
// and formatting characters (U+200B-U+200F word joiners and marks, U+061C
// Arabic letter mark, U+2028/U+2029 line/paragraph separators, U+FEFF
// BOM/zero-width no-break space) so a label can't hide characters or break
// line-oriented rendering of the device list (fix round 1, minor).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]');
const MAX_PAIR_REQUEST_LENGTH = 256;
// A DER SPKI Ed25519 key is exactly 44 bytes (12-byte prefix + 32-byte raw
// key), so exactly 88 lowercase hex characters — anything else is refused
// before it is even handed to deriveNodeId.
const ED25519_SPKI_HEX_RE = /^[0-9a-f]{88}$/;
const ADMIN_OWNER_SIDS = Object.freeze(['S-1-5-18', 'S-1-5-32-544']);
const DEVICES_CONTROLS = Object.freeze({ decides: 'which desktops may drive this service', selfGrant: 'pair its own desktops' });

class PairingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

function validateLabel(label, code = 'MALFORMED_REQUEST') {
  if (typeof label !== 'string' || !label.trim()) throw new PairingError(code, 'the desktop label is empty');
  if (CONTROL_RE.test(label)) throw new PairingError(code, 'the desktop label contains control characters');
  if (Buffer.byteLength(label, 'utf8') > LABEL_MAX_BYTES) {
    throw new PairingError(code, `the desktop label is longer than ${LABEL_MAX_BYTES} bytes`);
  }
  return label;
}

function currentUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return 'owner';
  }
}

// Truncates `text` to at most `maxBytes` UTF-8 bytes, always on a code-point
// boundary: iterating a string with `for...of` yields whole code points
// (never one half of a surrogate pair), so appending one at a time and
// stopping just before the byte budget would be exceeded can never split a
// multi-byte UTF-8 sequence either.
function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  for (const ch of text) {
    const candidate = out + ch;
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) break;
    out = candidate;
  }
  return out;
}

function defaultDeviceLabel(username = currentUsername()) {
  const cleaned = String(username || '').replace(new RegExp(CONTROL_RE.source, 'g'), '');
  const maxNameBytes = LABEL_MAX_BYTES - Buffer.byteLength(LABEL_SUFFIX, 'utf8');
  const name = truncateUtf8(cleaned, maxNameBytes) || 'owner';
  return `${name}${LABEL_SUFFIX}`;
}

function encodePairRequest({ publicKeyRaw, label }) {
  const raw = Buffer.from(publicKeyRaw);
  if (raw.length !== 32) throw new PairingError('MALFORMED_REQUEST', 'an Ed25519 public key is 32 bytes');
  validateLabel(label);
  return [PAIR_PREFIX, deriveDeviceId(raw, 'kld-'), toB64url(raw), toB64url(Buffer.from(label, 'utf8'))].join('.');
}

// The length is capped before anything else runs, so an arbitrarily long
// string never reaches split/regex/base64 work over attacker-controlled data.
function decodePairRequest(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length > MAX_PAIR_REQUEST_LENGTH) {
    throw new PairingError('MALFORMED_REQUEST', `a pairing request is longer than ${MAX_PAIR_REQUEST_LENGTH} characters`);
  }
  const parts = trimmed.split('.');
  if (parts.length !== 4 || parts[0] !== PAIR_PREFIX) {
    throw new PairingError('MALFORMED_REQUEST', `a pairing request looks like ${PAIR_PREFIX}.<device id>.<key>.<label>`);
  }
  const [, deviceId, keyText, labelText] = parts;
  if (!DEVICE_ID_RE.test(deviceId)) throw new PairingError('MALFORMED_REQUEST', 'the device id is malformed');
  let raw;
  try {
    raw = fromB64url(keyText);
  } catch {
    throw new PairingError('MALFORMED_REQUEST', 'the public key is not base64url');
  }
  if (raw.length !== 32) throw new PairingError('MALFORMED_REQUEST', 'an Ed25519 public key is 32 bytes');
  if (deriveDeviceId(raw, 'kld-') !== deviceId) throw new PairingError('MALFORMED_REQUEST', 'the device id does not match the public key');
  let label;
  try {
    label = fromB64url(labelText).toString('utf8');
  } catch {
    throw new PairingError('MALFORMED_REQUEST', 'the label is not base64url');
  }
  // Invalid UTF-8 decodes to U+FFFD and would re-encode differently.
  if (toB64url(Buffer.from(label, 'utf8')) !== labelText) throw new PairingError('MALFORMED_REQUEST', 'the label is not valid UTF-8');
  validateLabel(label);
  return { deviceId, publicKey: keyText, publicKeyRaw: raw, label };
}

function emptyDevices() {
  return { v: 1, devices: [] };
}

function invalidDevices(message) {
  return new PairingError('DEVICES_FILE_INVALID', `${DEVICES_FILE}: ${message}`);
}

function validateDevices(doc) {
  if (!doc || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.devices)) {
    throw invalidDevices('must be { "v": 1, "devices": [...] }');
  }
  const seen = new Set();
  for (const d of doc.devices) {
    if (!d || !DEVICE_ID_RE.test(String(d.deviceId))) throw invalidDevices('a device id is malformed');
    let raw;
    try {
      raw = fromB64url(d.publicKey);
    } catch {
      throw invalidDevices(`device ${d.deviceId} has a malformed public key`);
    }
    if (raw.length !== 32 || deriveDeviceId(raw, 'kld-') !== d.deviceId) throw invalidDevices(`device ${d.deviceId} does not match its public key`);
    validateLabel(d.label, 'DEVICES_FILE_INVALID');
    if (typeof d.pairedAt !== 'string' || Number.isNaN(Date.parse(d.pairedAt))) throw invalidDevices(`device ${d.deviceId} has no valid pairedAt`);
    if (seen.has(d.deviceId)) throw invalidDevices(`duplicate device ${d.deviceId}`);
    seen.add(d.deviceId);
  }
  return doc;
}

function parseDevices(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw invalidDevices(`not JSON (${err.message})`);
  }
  return validateDevices(doc);
}

function upsertDevice(doc, { deviceId, publicKey, label, pairedAt }) {
  const devices = doc.devices.filter((d) => d.deviceId !== deviceId);
  devices.push({ deviceId, publicKey, label, pairedAt });
  return validateDevices({ v: 1, devices });
}

function removeDevice(doc, deviceId) {
  const devices = doc.devices.filter((d) => d.deviceId !== deviceId);
  return { doc: { v: 1, devices }, removed: devices.length !== doc.devices.length };
}

function findDevice(doc, deviceId) {
  return doc.devices.find((d) => d.deviceId === deviceId) || null;
}

function bridgeFileRecord({ publicKey, port }) {
  const hex = Buffer.isBuffer(publicKey) ? publicKey.toString('hex') : String(publicKey);
  return { v: 1, nodeId: deriveNodeId(hex), publicKey: hex, host: '127.0.0.1', port, protocol: PROTOCOL };
}

function parseBridgeFile(text, file = BRIDGE_FILE) {
  const invalid = (message) => new PairingError('BRIDGE_FILE_INVALID', `${file}: ${message}`);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw invalid('not JSON');
  }
  if (!doc || typeof doc !== 'object' || doc.v !== 1) throw invalid('"v" must be 1');
  if (doc.host !== '127.0.0.1') throw invalid('host must be 127.0.0.1');
  if (!Number.isInteger(doc.port) || doc.port < 1 || doc.port > 65535) throw invalid('port must be an integer from 1 to 65535');
  if (!Number.isInteger(doc.protocol)) throw invalid('protocol must be an integer');
  if (typeof doc.publicKey !== 'string' || !ED25519_SPKI_HEX_RE.test(doc.publicKey)) {
    throw invalid('publicKey must be 88 lowercase hex characters (a DER SPKI Ed25519 key)');
  }
  let nodeId;
  try {
    nodeId = deriveNodeId(doc.publicKey);
  } catch {
    throw invalid('publicKey is not an Ed25519 SPKI key');
  }
  if (nodeId !== doc.nodeId) throw invalid('nodeId does not match publicKey');
  return { nodeId: doc.nodeId, publicKey: doc.publicKey, host: doc.host, port: doc.port, protocol: doc.protocol };
}

// The temp file is opened 'wx' (exclusive create — fails rather than
// silently overwriting anything already at that name) and fsynced before
// the rename, so a crash between the write and the rename can never leave
// the rename pointing at a file whose content didn't actually reach disk.
// The name is random, not pid/clock-derived (fleet stage 7 Task 9, fix round
// 1): an admin CLI writes some of these inside a directory the service
// account controls, and a predictable name there can be squatted in advance.
function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function bridgeFilePath({ env = process.env, platform = process.platform } = {}) {
  if (env.KL_DESKTOP_BRIDGE_FILE) return env.KL_DESKTOP_BRIDGE_FILE;
  const dataDir = defaultServiceDataDir({ platform, env });
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(adminConfigDir({ platform, dataDir }), BRIDGE_FILE);
}

// Windows: owners read through the installers' handle-based inspector (one
// no-follow handle per path). Paths travel in an environment variable, never
// in the script text. First output line: the current user's SID.
function inspectScript() {
  const { WINDOWS_INSPECT_CSHARP } = require('../service/installers');
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  Add-Type -TypeDefinition @'",
    WINDOWS_INSPECT_CSHARP,
    "'@",
    '  [Console]::Out.WriteLine("me " + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)',
    '  foreach ($p in $env:KL_INSPECT_PATHS.Split([char]10)) {',
    '    $r = [KlFsInspect]::Inspect($p)',
    "    if ($null -eq $r) { [Console]::Out.WriteLine('missing'); continue }",
    '    $sd = [System.Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$r[1], 0)',
    "    $o = if ($sd.Owner) { $sd.Owner.Value } else { '(none)' }",
    "    $k = if (([uint32]$r[0]) -band 0x400) { 'link' } else { 'plain' }",
    '    [Console]::Out.WriteLine("$o $k")',
    '  }',
    '  exit 0',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\n');
}

function inspectWindowsOwners(paths, { execFile = execFileSync, env = process.env } = {}) {
  const out = execFile(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', inspectScript()], {
    env: { ...env, KL_INSPECT_PATHS: paths.join('\n') },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
  const lines = String(out).trim().split(/\r?\n/);
  const me = (lines.shift() || '').replace(/^me /, '').trim();
  const entries = lines.map((line) => {
    if (line.trim() === 'missing') return null;
    const [owner, kind] = line.trim().split(' ');
    return { owner, link: kind === 'link' };
  });
  return { me, entries };
}

function untrusted(file) {
  return { ok: false, code: 'BRIDGE_FILE_UNTRUSTED', error: `${file} is not owned by an administrator; refusing to trust it.` };
}

function missing(file) {
  return { ok: false, code: 'BRIDGE_FILE_MISSING', error: `No local service found at ${path.dirname(file)}.` };
}

// The file and its directory must be administrator-owned and not writable by
// anyone else. With KL_TEST_MODE=1 and KL_DESKTOP_BRIDGE_FILE set, the current
// user is accepted too (e2e only).
function checkBridgeFileTrust(file, {
  env = process.env,
  platform = process.platform,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  lstat = fs.lstatSync,
  inspectOwners = inspectWindowsOwners
} = {}) {
  const dir = path.dirname(file);
  const testMode = env.KL_TEST_MODE === '1' && Boolean(env.KL_DESKTOP_BRIDGE_FILE);
  if (platform === 'win32') {
    const paths = [dir, file];
    let report;
    try {
      report = inspectOwners(paths, { env });
    } catch {
      return untrusted(file);
    }
    // No evidence is not trust: an inspector that didn't report back exactly
    // one entry per path asked about (wrong shape, wrong count, or threw
    // something that got swallowed upstream) is refused, never treated as
    // an empty "nothing to check" pass and never thrown from here.
    if (!report || !Array.isArray(report.entries) || report.entries.length !== paths.length) {
      return untrusted(file);
    }
    for (const entry of report.entries) {
      if (!entry) return missing(file);
      if (entry.link) return untrusted(file);
      const ok = ADMIN_OWNER_SIDS.includes(entry.owner) || (testMode && entry.owner === report.me);
      if (!ok) return untrusted(file);
    }
    return { ok: true };
  }
  const me = getuid();
  for (const target of [dir, file]) {
    let st;
    try {
      st = lstat(target);
    } catch {
      return missing(file);
    }
    if (st.isSymbolicLink()) return untrusted(file);
    const ownerOk = st.uid === 0 || (testMode && st.uid === me);
    if (!ownerOk || (st.mode & 0o022)) return untrusted(file);
  }
  return { ok: true };
}

function readTrustedBridgeFile(file, options = {}) {
  const trust = checkBridgeFileTrust(file, options);
  if (!trust.ok) return trust;
  try {
    return { ok: true, record: parseBridgeFile(fs.readFileSync(file, 'utf8'), file) };
  } catch (err) {
    if (err.code === 'ENOENT') return missing(file);
    return { ok: false, code: err.code === 'BRIDGE_FILE_INVALID' ? err.code : 'BRIDGE_FILE_INVALID', error: err.message };
  }
}

module.exports = {
  PAIR_PREFIX,
  DEVICES_FILE,
  BRIDGE_FILE,
  DEVICES_CONTROLS,
  ADMIN_OWNER_SIDS,
  PairingError,
  defaultDeviceLabel,
  encodePairRequest,
  decodePairRequest,
  emptyDevices,
  validateDevices,
  parseDevices,
  upsertDevice,
  removeDevice,
  findDevice,
  bridgeFileRecord,
  parseBridgeFile,
  writeFileAtomic,
  bridgeFilePath,
  inspectWindowsOwners,
  checkBridgeFileTrust,
  readTrustedBridgeFile
};
