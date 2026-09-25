// `king-louie-service relay run|code|nodes|remove-node|qr` (spec §3.12).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { loadServiceConfig } = require('../config');
const { runningServicePid, renderQr } = require('./io');

const log = createLogger('relay');
const CODE_TTL_MS = 120000;
const NODE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RELAY_HELP = `Usage: king-louie-service relay run [--data-dir DIR]
       king-louie-service relay code <node-name> [--data-dir DIR]
       king-louie-service relay nodes [--data-dir DIR]
       king-louie-service relay remove-node <node-name> [--data-dir DIR]
       king-louie-service relay qr [--data-dir DIR]
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
      const done = () => resolve();
      process.once('SIGTERM', done);
      process.once('SIGINT', done);
      process.on('message', (m) => { if (m && m.type === 'shutdown') done(); });
      if (deps.signal) deps.signal.addEventListener('abort', done, { once: true });
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
  const codesDir = path.join(dataDir, 'relay', 'codes');
  fs.mkdirSync(codesDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(codesDir, `${crypto.randomBytes(6).toString('hex')}.json`), JSON.stringify({ code, node_name: name, expires_at: expiresAt }), { mode: 0o600 });
  io.stdout.write(`Pairing code for ${name}: ${code}\n`);
  io.stdout.write(`It works once, until ${expiresAt}. On ${name}, as the administrator:\n`);
  io.stdout.write(`  echo '${code}' | king-louie-service pair wss://<relay-host>:<mesh-port>\n`);
  if (!runningServicePid(dataDir)) io.stderr.write('The relay is not running here; start `relay run` before the code expires.\n');
  return 0;
}

async function runRelayCommand({ sub, arg, dataDir, io, deps = {} }) {
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
