// `king-louie-service pair <url>` (spec §3.11). `wss://host:port` pairs this
// node with its relay: the one-time code from `relay code <node-name>` is read
// from stdin, and the relay's key is pinned in the node's store. `https://` is
// the stage 4 front door's flow (F4 extends this module, R22).
const { buildServicePorts } = require('../ports');
const { loadNodeConfig } = require('../node-config');
const { restoreDataDirOwnership } = require('../ownership');
const { readLine, runningServicePid } = require('./io');

const USAGE = 'Usage: king-louie-service pair <front-door-url> [--data-dir DIR]\n'
  + '       pair wss://relay-host:port pairs with a phone-approval relay; the one-time code is read from stdin\n';

async function readAll(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

async function runPair({ url, dataDir, io, deps = {} }) {
  if (!url) {
    io.stderr.write(USAGE);
    return 2;
  }
  let target;
  try {
    target = new URL(url);
  } catch {
    io.stderr.write(`Not a URL: ${url}\n${USAGE}`);
    return 2;
  }
  const useTls = deps.useTls !== false;
  const relayScheme = useTls ? 'wss:' : 'ws:';
  if (target.protocol !== 'https:' && target.protocol !== relayScheme) {
    io.stderr.write(`Unsupported URL scheme ${target.protocol}\n${USAGE}`);
    return 2;
  }
  // Creating the identity writes to the service's store, which a running
  // service would overwrite from its own in-memory copy.
  const pid = runningServicePid(dataDir);
  if (pid) {
    io.stderr.write(`The service is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
    return 1;
  }

  const written = [];
  try {
    const { getOrGenerateNodeIdentity, deriveNodeId } = require('../../mesh/node-identity');
    const { derivePeerId } = require('../../mesh/mesh-identity');
    const ports = buildServicePorts({ dataDir, onPathWritten: (p) => written.push(p) });
    const nodeCfg = loadNodeConfig({ dataDir });
    const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeCfg.name);

    if (target.protocol === 'https:') {
      // What §5.1 step 1 shows the owner. The front door exchange is stage 4's.
      io.stdout.write(`Node Name: ${nodeCfg.name}\n`);
      io.stdout.write(`Node ID: ${identity.nodeId}\n`);
      io.stdout.write(`TLS Fingerprint: ${identity.tlsFingerprint}\n`);
      io.stderr.write(`Pairing with a front door is not available yet: the front door is built in stage 4. Nothing was sent to ${url}.\n`);
      return 1;
    }

    const port = Number(target.port);
    if (!target.hostname || !Number.isInteger(port) || port < 1) {
      io.stderr.write('The relay URL needs a host and a port, like wss://10.0.0.5:18795\n');
      return 2;
    }
    let code;
    if (deps.code !== undefined) {
      code = deps.code;
    } else if (io.stdin && io.stdin.isTTY) {
      // Typed at a prompt, so the code stays out of shell history.
      io.stdout.write('Pairing code (from `relay code` on the relay host): ');
      code = await readLine(io.stdin);
    } else {
      code = await readAll(io.stdin);
    }
    code = String(code).trim();
    if (!code) {
      io.stderr.write('No pairing code on stdin. Get one on the relay host with `king-louie-service relay code <node-name>`.\n');
      return 2;
    }
    const { MeshTransport } = require('../../mesh/mesh-transport');
    const { MeshPairing } = require('../../mesh/mesh-pairing');
    const { fingerprintGroups } = require('../../approvals/envelope');
    const transport = new MeshTransport({ identity, listen: false, useTls });
    const pairing = new MeshPairing(identity, transport, { timeoutMs: deps.timeoutMs || 30000 });
    let info;
    try {
      info = await pairing.acceptCode(code, target.hostname.replace(/^\[|\]$/g, ''), port);
    } catch (err) {
      io.stderr.write(`Pairing failed: ${err.message}\n`);
      return 1;
    } finally {
      pairing.cleanup();
    }
    // The relay's peerId travels over the wire as a claim, not something the
    // mesh recomputes and checks (mesh-pairing.js takes msg.identity.peerId
    // as given). Node ids are recomputed from the key everywhere they matter
    // (deriveNodeId below); the peer id pinned for the mesh transport must
    // get the same treatment, or a relay (or a MITM during the handshake)
    // could hand back a peerId of its choosing while a mismatched key still
    // hashes to the node id the owner expects.
    const derivedPeerId = derivePeerId(info.publicKey);
    if (info.peerId !== derivedPeerId) {
      io.stderr.write(`Pairing failed: the relay's peer id does not match its public key (got ${info.peerId}, expected ${derivedPeerId}). Refusing to pair.\n`);
      return 1;
    }
    // The pairing proof binds the TLS fingerprint the relay claims (I4), so
    // it cannot be swapped on path; this checks the claim against the
    // certificate this connection was actually served. Over TLS a missing
    // claim would leave nothing to pin, so it is refused too.
    // The certificate cannot be read → refuse too: fail closed, never pin
    // a claim nothing checked. By now the relay has already recorded this
    // node, so a retry first needs it removed there.
    if (useTls) {
      const retry = `On the relay host run \`king-louie-service relay remove-node ${nodeCfg.name}\` before trying again.\n`;
      if (!info.tlsFingerprint) {
        io.stderr.write(`Pairing failed: the relay did not present a TLS fingerprint. Refusing to pair.\n${retry}`);
        return 1;
      }
      if (!info.servedTlsFingerprint) {
        io.stderr.write(`Pairing failed: could not read the certificate the relay served. Refusing to pair.\n${retry}`);
        return 1;
      }
      if (info.servedTlsFingerprint !== info.tlsFingerprint) {
        io.stderr.write(`Pairing failed: the certificate the relay served does not match the fingerprint it claimed. Refusing to pair.\n${retry}`);
        return 1;
      }
    }
    const relayId = deriveNodeId(info.publicKey);
    ports.store.set('approvals.relay', {
      relay_id: relayId,
      peerId: info.peerId,
      publicKey: info.publicKey,
      tlsFingerprint: info.tlsFingerprint || null,
      address: target.hostname.replace(/^\[|\]$/g, ''),
      port,
      pairedAt: new Date().toISOString()
    });
    io.stdout.write(`Paired ${nodeCfg.name} (${identity.nodeId}) with relay ${relayId}.\n`);
    io.stdout.write(`Relay fingerprint: ${fingerprintGroups(relayId)}\n`);
    io.stdout.write('Compare it with the fingerprint `king-louie-service relay run` logs on the relay host.\n');
    if (nodeCfg.approvers.relay !== url) {
      io.stdout.write(`Next: set "approvers: { relay: ${url} }" in the admin node.yaml, then start the service.\n`);
    }
    return 0;
  } finally {
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
}

module.exports = { runPair, USAGE };
