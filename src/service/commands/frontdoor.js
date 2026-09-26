// `king-louie-service frontdoor …` (fleet stage 4 §3.11): the admin console
// of a front door. Everything but remove-node talks to the running service
// through the file courier (never the network); console records are written
// here, by the administrator, into the admin-owned config dir.
//
// Run as root against a data dir the service account owns, the courier runs
// in the forked helper that drops to the data dir's owner (ruling
// T13-enroll): root never writes inside approvals/. What the service answers
// is checked before it is shown or written: a console record is only ever
// the pairing the administrator compared, for the name they typed.
const fs = require('fs');
const path = require('path');
const { adminConfigDir } = require('../../platform/paths');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { NODE_ID_RE, isTimestamp } = require('../../approvals/messages');
const { deriveNodeId } = require('../../mesh/node-identity');
const {
  NODE_NAME_RE, PAIRING_ID_RE, RAW_ED25519_RE, HEX_SHA256_RE, SPKI_PIN_RE, isDnsName, nodeFingerprint, spkiHexFromRaw
} = require('../../frontdoor/protocol/messages');
const { NodeRegistry } = require('../../frontdoor/router/node-registry');
const { isRoot, dataDirOwner } = require('../drop-privileges');
const { readLine, printable, runningServicePid } = require('./io');

const WAIT_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 30000;
const ROTATE_TIMEOUT_MS = 180000;
const PROFILES = ['agent', 'runbook'];
const CODE_TEXT_RE = /^[a-z]+(?: [a-z]+){5}$/;
const MAX_LINK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
// The service's refusals of a console confirmation that are final: the
// record just written must not stay (a later reload would trust it).
const CONFIRM_REFUSALS = new Set(['key_enrolled_as_other_name', 'console_record_mismatch', 'no_console_record', 'unknown_pairing']);
const HELP = `Usage: king-louie-service frontdoor enroll-device [--data-dir DIR]
       king-louie-service frontdoor code <node-name> [--confirm] [--data-dir DIR]
       king-louie-service frontdoor nodes [--data-dir DIR]
       king-louie-service frontdoor remove-node <node-name> [--data-dir DIR]
       king-louie-service frontdoor rotate-tls-key [--data-dir DIR]
`;
const BAD_NAME = 'A node name is 1–64 of A–Z, a–z, 0–9, dot, underscore and dash.\n';
const NOT_RUNNING = (dataDir) => `The front door service is not running on ${dataDir}. Start it (king-louie-service run --profile frontdoor), then try again.\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const validName = (name) => typeof name === 'string' && NODE_NAME_RE.test(name);

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function malformed(what) {
  return Object.assign(new Error(`the front door service sent a malformed ${what}`), { code: 'malformed' });
}

// A small file in the service-writable data dir, read without following a
// link, without blocking on a FIFO (O_NONBLOCK; fstat then refuses anything
// but a regular file) and with a size cap: root may be the reader.
function readSmallJson(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The front door's link.json (written by its self-link) as { relay, spki },
// or null when it is missing, malformed, or has no mcp. certificate yet.
function readFrontDoorLink(dataDir) {
  const link = readSmallJson(path.join(dataDir, 'approvals', 'link.json'), MAX_LINK_BYTES);
  if (!link || typeof link !== 'object' || typeof link.relay_spki !== 'string' || !SPKI_PIN_RE.test(link.relay_spki)) return null;
  let url;
  try {
    url = new URL(link.relay_public_url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== link.relay_public_url || !url.hostname.startsWith('mcp.') || !isDnsName(url.hostname)) return null;
  return { relay: link.relay_public_url, spki: link.relay_spki };
}

// { call(method, params, { timeoutMs }), stop() } to the running service.
async function openCourier(dataDir, deps) {
  if (deps.courier) return deps.courier;
  const pollMs = deps.pollMs ? { pollMs: deps.pollMs } : {};
  const useChild = deps.courierProcess
    ? deps.courierProcess === 'child'
    : isRoot() && dataDirOwner(dataDir, { who: 'frontdoor' }).uid !== 0;
  if (useChild) {
    const { CourierProxy } = require('../courier-proxy');
    const proxy = new CourierProxy({ dataDir, who: 'frontdoor', ...pollMs });
    try {
      await proxy.start();
    } catch (err) {
      proxy.stop();
      throw err;
    }
    return { call: (method, params, options) => proxy.call(method, params, { ...options, service: true }), stop: () => proxy.stop() };
  }
  const { FileCourier } = require('../../approvals/courier');
  const courier = new FileCourier({ dataDir, ...pollMs }).start();
  return { call: (method, params, options) => courier.callService(method, params, options), stop: () => courier.stop() };
}

async function withCourier(dataDir, io, deps, fn) {
  let courier;
  try {
    courier = await openCourier(dataDir, deps);
  } catch (err) {
    io.stderr.write(`Could not start the courier: ${printable(err.message)}\n`);
    return 1;
  }
  const call = (method, params = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) => courier.call(method, params, { timeoutMs });
  try {
    return await fn(call);
  } catch (err) {
    if (err && err.code === 'unavailable') {
      io.stderr.write(NOT_RUNNING(dataDir));
      return 1;
    }
    io.stderr.write(`Error: ${printable(err && err.message)}\n`);
    return 1;
  } finally {
    courier.stop();
  }
}

// frontdoor.status → { frontdoorId, domain }, checked.
function frontDoorStatus(s) {
  if (!s || typeof s !== 'object' || typeof s.frontdoor_id !== 'string' || !NODE_ID_RE.test(s.frontdoor_id) || !isDnsName(s.domain)) {
    throw malformed('status');
  }
  return { frontdoorId: s.frontdoor_id, domain: s.domain };
}

// frontdoor.pairing → the pending console pairing for `name`, checked: its
// id derives from its key, so the fingerprint shown is the key written.
function consolePairing(p, name) {
  if (p === null) return null;
  const ok = p && typeof p === 'object'
    && typeof p.pairing_id === 'string' && PAIRING_ID_RE.test(p.pairing_id)
    && typeof p.node_id === 'string' && NODE_ID_RE.test(p.node_id)
    && p.node_name === name && PROFILES.includes(p.profile)
    && typeof p.public_key === 'string' && RAW_ED25519_RE.test(p.public_key)
    && typeof p.tls_fingerprint === 'string' && HEX_SHA256_RE.test(p.tls_fingerprint)
    && (p.replaces === null || p.replaces === undefined || (typeof p.replaces === 'string' && NODE_ID_RE.test(p.replaces)));
  let derived = null;
  try {
    derived = ok ? deriveNodeId(spkiHexFromRaw(p.public_key)) : null;
  } catch {
    derived = null;
  }
  if (!ok || derived !== p.node_id) throw malformed('pairing');
  return { pairing_id: p.pairing_id, node_id: p.node_id, node_name: p.node_name, profile: p.profile, public_key: p.public_key, tls_fingerprint: p.tls_fingerprint, replaces: p.replaces || null };
}

// Every console record file as { file, text, record } (unparseable ones
// with record null).
function consoleRecords(configDir) {
  const dir = NodeRegistry.consoleDir(configDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const file = path.join(dir, name);
    let text = null;
    let record = null;
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && st.size <= MAX_RECORD_BYTES) {
        text = fs.readFileSync(file, 'utf8');
        record = JSON.parse(text);
      }
    } catch {
      record = null;
    }
    out.push({ file, text, record: record && typeof record === 'object' ? record : null });
  }
  return out;
}

// Ruling T28-rename: the name another record (a console record on disk, or
// any record the running front door trusts) holds this key under, or null.
// Written as is, the console record would move that node to the new name.
function enrolledAsOtherName(p, configDir, nodes) {
  for (const { record } of consoleRecords(configDir)) {
    if (record && record.node_id === p.node_id && record.node_name !== p.node_name) return String(record.node_name);
  }
  if (!Array.isArray(nodes)) throw malformed('node list');
  for (const n of nodes) {
    if (n && n.node_id === p.node_id && n.node_name !== p.node_name) return String(n.node_name);
  }
  return null;
}

async function runCode({ name, confirm, dataDir, configDir, io, deps }) {
  if (!validName(name)) {
    io.stderr.write(BAD_NAME);
    return 2;
  }
  if (confirm && !writable(configDir)) {
    io.stderr.write(`${configDir} is not writable: --confirm writes the node record there, so run it as an administrator.\n`);
    return 1;
  }
  return withCourier(dataDir, io, deps, async (call) => {
    const { frontdoorId, domain } = frontDoorStatus(await call('frontdoor.status'));
    const issued = await call('frontdoor.code', { node_name: name, confirm: Boolean(confirm) });
    if (!issued || typeof issued.code !== 'string' || !CODE_TEXT_RE.test(issued.code) || !isTimestamp(issued.expires_at)) throw malformed('pairing code');
    // The code is a secret: printed for the administrator only, never logged.
    io.stdout.write(`Pairing code for ${name}: ${issued.code}\n`);
    io.stdout.write(`It works once, until ${issued.expires_at}. On ${name}, as the administrator, run\n`);
    io.stdout.write(`  king-louie-service pair https://mcp.${domain}\n`);
    io.stdout.write('and type the code when it asks (typed, it stays out of your shell history).\n');
    io.stdout.write(`Front door fingerprint: ${nodeFingerprint(frontdoorId)}\n`);
    if (!confirm) {
      io.stdout.write('Then approve the node in the phone app (Nodes).\n');
      return 0;
    }
    io.stdout.write('Waiting for the node (up to 10 minutes)...\n');
    const deadline = Date.now() + WAIT_MS;
    let p = null;
    for (;;) {
      p = consolePairing(await call('frontdoor.pairing', { node_name: name }), name);
      if (p) break;
      if (Date.now() > deadline) {
        io.stderr.write('No node used the code within 10 minutes. Nothing was written.\n');
        return 1;
      }
      await sleep(deps.waitPollMs || 2000);
    }
    const decline = async () => {
      try {
        await call('frontdoor.declined', { pairing_id: p.pairing_id });
      } catch {
        // The pairing expires on its own.
      }
    };
    io.stdout.write(`Node ${p.node_name} (${p.profile}) fingerprint: ${nodeFingerprint(p.node_id)}\n`);
    if (p.replaces) io.stdout.write(`This replaces ${nodeFingerprint(p.replaces)}.\n`);
    io.stdout.write('Does the node console show the same? [y/N] ');
    const answer = await readLine(io.stdin);
    if (!answer || !/^y(es)?$/i.test(answer.trim())) {
      await decline();
      io.stdout.write('Not enrolled. Nothing was written.\n');
      return 1;
    }
    // Checked just before writing, against disk and the running service.
    const other = enrolledAsOtherName(p, configDir, await call('frontdoor.nodes'));
    if (other !== null) {
      await decline();
      io.stderr.write(`key_enrolled_as_other_name: this node key is already enrolled as "${printable(other)}". Remove ${printable(other)} first `
        + `(frontdoor remove-node, or in the phone app), then pair it as "${name}". Nothing was written.\n`);
      return 1;
    }
    // The new record goes in first; only then are older records of the name
    // taken out, so a failed write leaves the old node in place. Their text
    // is kept, to put back if the front door refuses the confirmation.
    const older = consoleRecords(configDir).filter((r) => r.record && r.record.node_name === p.node_name && r.record.node_id !== p.node_id && r.text !== null);
    const recordFile = path.join(NodeRegistry.consoleDir(configDir), `${p.node_id}.json`);
    try {
      NodeRegistry.writeConsoleRecord(configDir, {
        node_id: p.node_id, node_name: p.node_name, profile: p.profile, public_key: p.public_key, tls_fingerprint: p.tls_fingerprint,
        source: 'console', accepted_at: new Date().toISOString(), signed: null, confirmed_by: 'console'
      }, { frontdoorId });
    } catch (err) {
      await decline();
      throw err;
    }
    try {
      for (const r of older) fs.rmSync(r.file, { force: true });
    } catch (err) {
      // Two records with one name would leave the old key in place (and the
      // registry trusts neither): take the new one back out and decline.
      fs.rmSync(recordFile, { force: true });
      for (const r of older) if (!fs.existsSync(r.file)) writeFileAtomic(r.file, r.text, 0o644);
      await decline();
      io.stderr.write(`Could not remove the older record of ${p.node_name} (${printable(err.message)}). The new record was taken back out. Nothing was enrolled.\n`);
      return 1;
    }
    try {
      await call('frontdoor.confirmed', { pairing_id: p.pairing_id });
    } catch (err) {
      if (!CONFIRM_REFUSALS.has(err && err.code)) {
        io.stderr.write(`The node record for ${p.node_name} is written, but the front door did not answer (${printable(err && err.message)}). `
          + 'It trusts the node from its next reload; check with `frontdoor nodes`.\n');
        return 1;
      }
      // Refused: the record must not be trusted at the next reload.
      fs.rmSync(recordFile, { force: true });
      for (const r of older) writeFileAtomic(r.file, r.text, 0o644);
      try {
        await call('frontdoor.reload');
      } catch {
        // The next reload reads the restored records.
      }
      io.stderr.write(`The front door refused the enrollment (${printable(err.code)}: ${printable(err.message)}). The node record was taken back out. Nothing was enrolled.\n`);
      return 1;
    }
    io.stdout.write(`Enrolled ${p.node_name}. It links as soon as its service starts.\n`);
    return 0;
  });
}

async function runNodes({ dataDir, io, deps }) {
  return withCourier(dataDir, io, deps, async (call) => {
    const nodes = await call('frontdoor.nodes');
    if (!Array.isArray(nodes)) throw malformed('node list');
    if (!nodes.length) io.stdout.write('No nodes are enrolled with this front door.\n');
    for (const n of nodes) {
      if (!n || typeof n.node_id !== 'string' || !NODE_ID_RE.test(n.node_id)) throw malformed('node list');
      const tlsFp = typeof n.tls_fingerprint === 'string' ? printable(n.tls_fingerprint).slice(0, 16) : '?';
      const seen = typeof n.last_seen === 'string' ? `  last seen ${printable(n.last_seen).slice(0, 40)}` : '';
      io.stdout.write(`${printable(n.node_name).slice(0, 64)}  ${printable(n.source).slice(0, 16)}  ${n.online === true ? 'online' : 'offline'}  ${nodeFingerprint(n.node_id)}  tls ${tlsFp}…${seen}\n`);
    }
    return 0;
  });
}

async function runRemoveNode({ name, dataDir, configDir, io, deps }) {
  if (name === undefined) {
    io.stderr.write(HELP);
    return 2;
  }
  if (!validName(name)) {
    io.stderr.write(BAD_NAME);
    return 2;
  }
  if (!writable(configDir)) {
    io.stderr.write(`${configDir} is not writable: run remove-node as an administrator.\n`);
    return 1;
  }
  let removed;
  try {
    removed = NodeRegistry.removeConsoleRecord(configDir, name);
  } catch (err) {
    io.stderr.write(`Could not remove the console record for "${name}": ${printable(err.message)}\n`);
    return 1;
  }
  if (!removed) {
    io.stderr.write(`No console record for "${name}" in ${NodeRegistry.consoleDir(configDir)}. A node a phone enrolled is removed in the phone app (Nodes).\n`);
    return 1;
  }
  io.stdout.write(`Removed ${name}.\n`);
  if (!runningServicePid(dataDir)) {
    io.stdout.write('The front door is not running; it will not trust the node when it starts.\n');
    return 0;
  }
  const code = await withCourier(dataDir, io, deps, async (call) => {
    await call('frontdoor.reload', { removed: name });
    io.stdout.write('The front door reloaded its nodes and closed the node\'s link.\n');
    return 0;
  });
  if (code !== 0) io.stderr.write('The record is gone, but the running front door did not reload: send it SIGHUP or restart it.\n');
  return code;
}

async function runRotate({ dataDir, io, deps }) {
  return withCourier(dataDir, io, deps, async (call) => {
    const r = await call('frontdoor.rotate_tls_key', {}, { timeoutMs: ROTATE_TIMEOUT_MS });
    if (!r || typeof r.oldSpki !== 'string' || typeof r.newSpki !== 'string') throw malformed('rotation');
    io.stdout.write(`The mcp. key was rotated: ${printable(r.oldSpki).slice(0, 80)} → ${printable(r.newSpki).slice(0, 80)}.\n`);
    io.stdout.write('Phones re-pin from the signed kl.relay.repin the next time they open the app.\n');
    return 0;
  });
}

async function runFrontDoorEnrollDevice({ dataDir, configDir, io, deps }) {
  if (!readFrontDoorLink(dataDir)) {
    io.stderr.write('The front door has no mcp. certificate yet (waiting for ACME), or is not running. Run `king-louie-service doctor` and try again once it has one.\n');
    return 1;
  }
  const { runEnrollDevice } = require('./devices');
  return runEnrollDevice({ dataDir, configDir, io, deps });
}

async function runFrontDoorCommand({ sub, arg, flags = {}, dataDir, configDir = adminConfigDir({ dataDir }), io, deps = {} }) {
  if (flags.confirm && sub !== 'code') {
    io.stderr.write('Flag "--confirm" is only valid for "frontdoor code".\n');
    return 2;
  }
  if (sub === 'enroll-device') return runFrontDoorEnrollDevice({ dataDir, configDir, io, deps });
  if (sub === 'code') return runCode({ name: arg, confirm: Boolean(flags.confirm), dataDir, configDir, io, deps });
  if (sub === 'nodes') return runNodes({ dataDir, io, deps });
  if (sub === 'remove-node') return runRemoveNode({ name: arg, dataDir, configDir, io, deps });
  if (sub === 'rotate-tls-key') return runRotate({ dataDir, io, deps });
  io.stderr.write(HELP);
  return 2;
}

module.exports = { runFrontDoorCommand, readFrontDoorLink, HELP };
