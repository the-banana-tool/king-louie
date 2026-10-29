// `king-louie-service relay run|code|nodes|remove-node|qr` (spec §3.12) and
// `relay push-test` (push spec §9).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { loadServiceConfig, hostPushConfig } = require('../config');
const { restoreDataDirOwnership } = require('../ownership');
const { runningServicePid, renderQr } = require('./io');

const log = createLogger('relay');
const CODE_TTL_MS = 120000;
const NODE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RELAY_HELP = `Usage: king-louie-service relay run [--data-dir DIR]
       king-louie-service relay code <node-name> [--data-dir DIR]
       king-louie-service relay nodes [--data-dir DIR]
       king-louie-service relay remove-node <node-name> [--data-dir DIR]
       king-louie-service relay qr [--data-dir DIR]
       king-louie-service relay push-test [--device <device-id>] [--data-dir DIR]
`;

function registryFile(dataDir) {
  return path.join(dataDir, 'relay', 'nodes.json');
}

function readNodes(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(registryFile(dataDir), 'utf8')).nodes || [];
  } catch {
    return [];
  }
}

function relayConfig(dataDir, io, deps) {
  const config = (deps.loadConfig || ((d) => loadServiceConfig(d)))(dataDir).relay;
  if (!config) {
    io.stderr.write('There is no "relay" block in the admin service.json. See the relay section of the install guide.\n');
    return null;
  }
  return config;
}

async function runRelayServer({ dataDir, io, deps }) {
  const { assertPrivateMeshHost } = require('../../frontdoor/net');
  const config = relayConfig(dataDir, io, deps);
  if (!config) return 1;
  try {
    assertPrivateMeshHost(config.meshListen && config.meshListen.host);
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return 1;
  }
  const { acquireInstanceLock } = require('../pidfile');
  const { buildServicePorts } = require('../ports');
  const { getOrGenerateNodeIdentity } = require('../../mesh/node-identity');
  const { startRelay } = require('../../frontdoor/relay');
  const { fingerprintGroups } = require('../../approvals/envelope');
  const lock = acquireInstanceLock(dataDir);
  try {
    const ports = buildServicePorts({ dataDir });
    const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, 'relay');
    const relay = await startRelay({ dataDir, config, identity, useTls: deps.useTls !== false });
    const fingerprint = fingerprintGroups(identity.nodeId);
    log.info(`relay ${identity.nodeId} fingerprint ${fingerprint}`);
    io.stdout.write(`${JSON.stringify({ event: 'ready', relay_id: identity.nodeId, fingerprint, phone_spki: relay.phoneSpki, ...relay.address() })}\n`);
    await new Promise((resolve) => {
      const onMessage = (m) => { if (m && m.type === 'shutdown') done(); };
      // Every way to stop removes all of them, so nothing outlives the relay.
      function done() {
        process.removeListener('SIGTERM', done);
        process.removeListener('SIGINT', done);
        process.removeListener('message', onMessage);
        if (deps.signal) deps.signal.removeEventListener('abort', done);
        resolve();
      }
      process.once('SIGTERM', done);
      process.once('SIGINT', done);
      process.on('message', onMessage);
      if (deps.signal) {
        if (deps.signal.aborted) done();
        else deps.signal.addEventListener('abort', done, { once: true });
      }
    });
    await relay.stop();
    return 0;
  } finally {
    lock.release();
  }
}

function runCode({ dataDir, name, io, deps }) {
  const { WORDLIST } = require('../../mesh/mesh-pairing');
  if (!name || !NODE_NAME_RE.test(name)) {
    io.stderr.write('A node name is 1–64 of A–Z, a–z, 0–9, dot, underscore and dash.\n');
    return 2;
  }
  if (readNodes(dataDir).some((n) => n.node_name === name)) {
    io.stderr.write(`name_taken: a node named "${name}" is already paired. Remove it first with \`relay remove-node ${name}\`.\n`);
    return 1;
  }
  const words = Array.from(crypto.randomBytes(6), (b) => WORDLIST[b]);
  const code = words.join(' ');
  const expiresAt = new Date((deps.now || Date.now)() + CODE_TTL_MS).toISOString();
  const relayDir = path.join(dataDir, 'relay');
  const codesDir = path.join(relayDir, 'codes');
  // Run as root on a service-owned data dir, what this writes goes back to
  // the data dir's owner, as pair and the device commands do.
  const written = [relayDir, codesDir].filter((d) => !fs.existsSync(d));
  try {
    fs.mkdirSync(codesDir, { recursive: true, mode: 0o700 });
    const file = path.join(codesDir, `${crypto.randomBytes(6).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify({ code, node_name: name, expires_at: expiresAt }), { mode: 0o600 });
    written.push(file);
  } finally {
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
  io.stdout.write(`Pairing code for ${name}: ${code}\n`);
  io.stdout.write(`It works once, until ${expiresAt}. On ${name}, as the administrator, run\n`);
  io.stdout.write('  king-louie-service pair wss://<relay-host>:<mesh-port>\n');
  io.stdout.write('and type the code when it asks (typed, it stays out of your shell history).\n');
  if (!runningServicePid(dataDir)) io.stderr.write('The relay is not running here; start `relay run` before the code expires.\n');
  return 0;
}

// On profile: frontdoor, F3's relay-registry commands have front-door
// counterparts (fleet stage 4 §3.1); `relay qr` still prints the kl.relay
// re-pin code, from the front door's own link.json.
const FRONT_DOOR_COUNTERPARTS = { code: 'frontdoor code <node-name>', nodes: 'frontdoor nodes', 'remove-node': 'frontdoor remove-node <node-name>' };

function onFrontDoor(dataDir, deps) {
  try {
    const cfg = (deps.loadConfig || ((d) => loadServiceConfig(d)))(dataDir);
    return Boolean(cfg && cfg.profile === 'frontdoor');
  } catch {
    return false;
  }
}

// The relay's own node name, the `n` of a test push: node.yaml's name (a front
// door always has one); a `relay run` host without a node.yaml is "relay",
// the name its identity is made under.
function defaultRelayNodeName(dataDir) {
  const { adminConfigDir } = require('../../platform/paths');
  const { loadNodeConfig, NODE_CONFIG_FILE } = require('../node-config');
  const dir = adminConfigDir({ dataDir });
  if (!fs.existsSync(path.join(dir, NODE_CONFIG_FILE))) return { name: 'relay' };
  return loadNodeConfig({ dataDir, adminConfigDir: dir });
}

// Device records as the relay stored them, read without the registry (whose
// constructor reads the enrollment log too): this command writes nothing.
function readDeviceRecords(dataDir) {
  const { DEVICE_ID_RE } = require('../../approvals/messages');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'devices.json'), 'utf8'));
  } catch {
    return [];
  }
  return Object.values((parsed && parsed.devices) || {}).filter((r) => r && typeof r.device_id === 'string' && DEVICE_ID_RE.test(r.device_id));
}

const hasFcmToken = (record) => Boolean(record.push && record.push.platform === 'fcm' && typeof record.push.token === 'string' && record.push.token);

// `relay push-test [--device <device-id>]` (push spec §9, C-14): one `test`
// push to each device with an fcm token, or to the named one, straight
// through the FCM sender (no dedupe, no coalescing). Prints each device's id,
// name and `sent` or the HTTP status; never a token. Runs with the relay
// running or not, and changes nothing: a token FCM rejects stays on file
// (the running relay drops it at its next push).
async function runPushTest({ dataDir, io, flags = {}, deps = {} }) {
  const { isAdmin: defaultIsAdmin } = require('./admin-check');
  const { shown } = require('./io');
  const isAdmin = deps.isAdmin || (() => defaultIsAdmin());
  if (!(await isAdmin())) {
    io.stderr.write('relay push-test reads the push credential; run it as root/an administrator.\n');
    return 1;
  }
  let push;
  let nodeName;
  let serviceAccount;
  try {
    push = hostPushConfig((deps.loadConfig || ((d) => loadServiceConfig(d)))(dataDir));
    if (push === null) {
      io.stderr.write('There is no "relay" block in the admin service.json. See the relay section of the install guide.\n');
      return 1;
    }
    if (!push.fcm) {
      io.stderr.write('No FCM push is configured: the admin service.json has no relay.push.fcm block, so phones get no push (the app checks only while open). See the install guide\'s push part.\n');
      return 1;
    }
    const { readServiceAccountFile } = require('../../frontdoor/push/service-account');
    serviceAccount = readServiceAccountFile(push.fcm.serviceAccountFile);
    nodeName = ((deps.loadNodeConfig || defaultRelayNodeName)(dataDir) || {}).name || '';
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return 1;
  }

  const records = readDeviceRecords(dataDir);
  let targets;
  if (flags.device !== undefined) {
    const record = records.find((r) => r.device_id === flags.device);
    if (!record) {
      io.stderr.write(`No device ${shown(flags.device, 64)} is enrolled with this relay. \`king-louie-service relay push-test\` with no --device tries every phone with a push token.\n`);
      return 1;
    }
    if (!hasFcmToken(record)) {
      io.stderr.write(`${record.device_id}  ${shown(record.name, 64)}  has no fcm push token: open the app on that phone (it sends its token at start), then try again.\n`);
      return 1;
    }
    targets = [record];
  } else {
    targets = records.filter(hasFcmToken);
    if (targets.length === 0) {
      io.stderr.write('There is no device with an fcm push token on this relay: enroll the phone, or open the app on it (it sends its token at start), then try again.\n');
      return 1;
    }
  }

  const { createFcmSender } = require('../../frontdoor/push/fcm');
  const sender = createFcmSender({ serviceAccount, ...(deps.fcm || {}) });
  let failed = 0;
  for (const record of targets) {
    let outcome;
    try {
      const result = await sender.notify(record, { kind: 'test', id: crypto.randomBytes(8).toString('hex'), node_name: nodeName });
      outcome = result.ok ? 'sent' : `HTTP ${result.status}${result.dropToken ? ' (FCM no longer knows this token; the relay drops it at its next push)' : ''}`;
    } catch (err) {
      // The sender's own messages name a status, never a token.
      outcome = `failed: ${shown(err.message, 200)}`;
    }
    if (outcome !== 'sent') failed += 1;
    io.stdout.write(`${record.device_id}  ${shown(record.name, 64)}  ${outcome}\n`);
  }
  return failed === 0 ? 0 : 1;
}

async function runRelayCommand({ sub, arg, dataDir, io, flags = {}, deps = {} }) {
  if (Object.hasOwn(FRONT_DOOR_COUNTERPARTS, sub) && onFrontDoor(dataDir, deps)) {
    io.stderr.write(`relay ${sub} is not used on a front door; use "king-louie-service ${FRONT_DOOR_COUNTERPARTS[sub]}".\n`);
    return 2;
  }
  if (sub === 'qr' && onFrontDoor(dataDir, deps)) {
    const { encodeQr } = require('../../approvals/messages');
    const { readFrontDoorLink } = require('./frontdoor');
    const link = readFrontDoorLink(dataDir);
    if (!link) {
      io.stderr.write('The front door has no mcp. certificate yet, or is not running. Run `king-louie-service doctor`.\n');
      return 1;
    }
    const qr = encodeQr({ t: 'kl.relay', relay: link.relay, relay_spki: link.spki });
    io.stdout.write(`${await (deps.renderQr || renderQr)(qr)}\n${qr}\n`);
    return 0;
  }
  if (sub === 'run') return runRelayServer({ dataDir, io, deps });
  if (sub === 'code') return runCode({ dataDir, name: arg, io, deps });
  if (sub === 'nodes') {
    const nodes = readNodes(dataDir);
    if (nodes.length === 0) io.stdout.write('No nodes are paired with this relay.\n');
    for (const n of nodes) io.stdout.write(`${n.node_name}  ${n.node_id}  paired ${n.paired_at || 'by the front door'}\n`);
    return 0;
  }
  if (sub === 'remove-node') {
    if (!arg) {
      io.stderr.write(RELAY_HELP);
      return 2;
    }
    const pid = runningServicePid(dataDir);
    if (pid) {
      io.stderr.write(`The relay is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
      return 1;
    }
    const nodes = readNodes(dataDir);
    const kept = nodes.filter((n) => n.node_name !== arg);
    if (kept.length === nodes.length) {
      io.stderr.write(`No node named "${arg}" is paired with this relay.\n`);
      return 1;
    }
    fs.writeFileSync(registryFile(dataDir), `${JSON.stringify({ nodes: kept }, null, 2)}\n`, { mode: 0o600 });
    io.stdout.write(`Removed ${arg}.\n`);
    return 0;
  }
  if (sub === 'push-test') return runPushTest({ dataDir, io, flags, deps });
  if (sub === 'qr') {
    const { relaySpkiPin } = require('../../frontdoor/tls');
    const { encodeQr } = require('../../approvals/messages');
    const config = relayConfig(dataDir, io, deps);
    if (!config) return 1;
    const qr = encodeQr({ t: 'kl.relay', relay: config.publicUrl, relay_spki: relaySpkiPin(fs.readFileSync(config.tls.certFile, 'utf8')) });
    io.stdout.write(`${await (deps.renderQr || renderQr)(qr)}\n${qr}\n`);
    return 0;
  }
  io.stderr.write(RELAY_HELP);
  return 2;
}

module.exports = { runRelayCommand, RELAY_HELP, CODE_TTL_MS };
