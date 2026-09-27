// `doctor` on a node with front-door.json (fleet stage 4 §3.14): the pin is
// admin-owned, approvers.relay is superseded (WARN), and a TLS-only probe of
// mesh.<domain> is served the pinned certificate. The probe closes after the
// handshake and never authenticates, so it is not a second link.
const tls = require('tls');
const crypto = require('crypto');
const { readPin } = require('./front-door-pin');

function probeMeshCertificate(pin, { lookup = null, timeoutMs = 10000 } = {}) {
  const url = new URL(pin.mesh_url);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: url.hostname, port: Number(url.port) || 443, servername: url.hostname,
      rejectUnauthorized: false, checkServerIdentity: () => undefined, ALPNProtocols: ['http/1.1'],
      ...(lookup ? { lookup } : {})
    });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no TLS answer from ${url.host} within ${timeoutMs} ms`)); }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerX509Certificate();
      socket.destroy();
      resolve(cert ? crypto.createHash('sha256').update(cert.raw).digest('hex') : null);
    });
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function nodeFrontDoorChecks({ configDir, adminUid = 0, geteuid, nodeConfig = null, probe = probeMeshCertificate } = {}) {
  const check = 'front-door.json is admin-owned and valid';
  let pin;
  try {
    pin = readPin(configDir, { adminUid, ...(geteuid ? { geteuid } : {}) });
  } catch (err) {
    return [{ check, ok: false, detail: err.message }];
  }
  if (!pin) return [];
  const out = [{ check, ok: true, detail: `${pin.frontdoor_id} at ${pin.domain}` }];
  if (nodeConfig && nodeConfig.approvers && nodeConfig.approvers.relay) {
    out.push({ check: 'approvers.relay', ok: true, warn: true, detail: 'approvers.relay is superseded by front-door.json; remove it from node.yaml' });
  }
  const certCheck = 'front door mesh certificate matches the pin';
  try {
    const served = await probe(pin);
    const ok = served === pin.mesh_cert_fingerprint;
    out.push({ check: certCheck, ok, detail: ok ? served : `pinned ${pin.mesh_cert_fingerprint}, served ${served || 'no certificate'}` });
  } catch (err) {
    out.push({ check: certCheck, ok: false, detail: err.message });
  }
  return out;
}

module.exports = { nodeFrontDoorChecks, probeMeshCertificate };
