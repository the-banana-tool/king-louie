// Until F4's mesh hardening (auth before parse, ruling 8), MeshTransport
// parses a frame before it authenticates, so the relay's mesh listener may
// only bind a loopback or private IP literal.
const net = require('net');

const MESSAGE = 'relay.mesh_listen.host must be a loopback or private IP address until the stage 4 mesh hardening lands';

function ipv4Parts(host) {
  return host.split('.').map(Number);
}

function isPrivateV4(host) {
  const [a, b] = ipv4Parts(host);
  return a === 127 // loopback
    || a === 10 // RFC 1918
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254); // link-local
}

function isPrivateV6(host) {
  const h = host.toLowerCase();
  if (h === '::1') return true;
  const first = parseInt(h.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 // ULA fc00::/7
    || (first & 0xffc0) === 0xfe80; // link-local fe80::/10
}

function assertPrivateMeshHost(host) {
  const kind = net.isIP(String(host || ''));
  if (kind === 0) throw new Error(`${MESSAGE} (got "${host}", not an IP literal)`);
  if (host === '0.0.0.0' || host === '::') throw new Error(`${MESSAGE} (got the wildcard "${host}")`);
  const ok = kind === 4 ? isPrivateV4(host) : isPrivateV6(host);
  if (!ok) throw new Error(`${MESSAGE} (got "${host}")`);
}

module.exports = { assertPrivateMeshHost };
