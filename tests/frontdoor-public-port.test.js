// tests/frontdoor-public-port.test.js — a front door reached on a port other
// than 443 (frontdoor.listen.port 8443 behind a host whose 443 is taken)
// carries that port in every URL it hands out: the relay URL in link.json
// and the QR, the relay hello, OAuth's issuer, resource and endpoints, the
// MCP origin and its metadata URL. On 443 none of them names a port.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startFrontDoor } = require('../src/frontdoor/profile');
const { parseFrontDoorConfig } = require('../src/frontdoor/config');
const { readFrontDoorLink } = require('../src/service/commands/frontdoor');
const { runRelayCommand } = require('../src/service/commands/relay');
const { decodeQr } = require('../src/approvals/messages');
const { approverStoreWith } = require('./helpers/approver-set');
const { createCa, issueCert } = require('./helpers/test-certs');
const { request } = require('./helpers/oauth-test-client');
const { holdEventLoop } = require('./helpers/hold-event-loop');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const release = holdEventLoop();
const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const STORE = { geteuid: () => UID, adminUid: UID, platform: 'linux' };
const OFF = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false };
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); release(); });

const lookup = (host, options, cb) => {
  const done = typeof options === 'function' ? options : cb;
  const opts = typeof options === 'function' ? {} : options || {};
  if (opts.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
  else done(null, '127.0.0.1', 4);
};

function streamIo() {
  const text = { out: '', err: '' };
  return { stdout: { write: (s) => { text.out += String(s); return true; } }, stderr: { write: (s) => { text.err += String(s); return true; } }, text };
}

// A front door listening on an ephemeral port that says it is reached on
// publicPort (what a real listen.port of 8443 or 443 gives).
async function frontDoorOn(publicPort) {
  const store = await approverStoreWith([], { allowTestKeys: true });
  cleanups.push(() => store.cleanup());
  const configDir = path.join(store.baseDir, 'config');
  const dataDir = path.join(store.baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const ca = createCa();
  const leaf = issueCert(ca, { dnsNames: ['mcp.kl.example.com'] });
  fs.writeFileSync(path.join(configDir, 'mcp.pem'), leaf.cert, { mode: 0o644 });
  fs.writeFileSync(path.join(configDir, 'mcp.key'), leaf.key, { mode: 0o600 });
  const tlsKeys = { cert_file: path.join(configDir, 'mcp.pem'), key_file: path.join(configDir, 'mcp.key') };
  const nodeConfig = { name: 'frontdoor', profile: 'frontdoor', frontdoor: parseFrontDoorConfig({ domain: 'kl.example.com', tls: tlsKeys }, 'node.yaml') };
  const serviceConfig = { profile: 'frontdoor', features: OFF, ports: {}, relayRaw: null, audit: { retentionDays: 365 } };
  const fd = await startFrontDoor({
    dataDir, configDir, adminUid: UID, geteuid: () => UID, nodeConfig, serviceConfig,
    deps: { listen: { host: '127.0.0.1', port: 0 }, publicPort, lookup, probeCa: ca.cert, allowTestKeys: true, approverStoreOptions: STORE }
  });
  cleanups.push(() => fd.stop());
  // Requests go to the port actually bound; the URLs say publicPort.
  return { fd, dataDir, base: `https://mcp.kl.example.com:${fd.address().port}`, tls: { ca: ca.cert, lookup } };
}

for (const [publicPort, origin] of [[8443, 'https://mcp.kl.example.com:8443'], [443, 'https://mcp.kl.example.com']]) {
  describe(`a front door reached on port ${publicPort}`, () => {
    let t;
    before(async () => { t = await frontDoorOn(publicPort); });

    it('gives phones and nodes the relay URL with that port', async () => {
      assert.equal(t.fd.relay.publicUrl, origin, 'the relay hello nodes get');
      const link = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'approvals', 'link.json'), 'utf8'));
      assert.equal(link.relay_public_url, origin);
      assert.deepEqual(readFrontDoorLink(t.dataDir), { relay: origin, spki: t.fd.relay.phoneSpki }, 'what enroll-device puts in its QR');
      const io = streamIo();
      assert.equal(await runRelayCommand({ sub: 'qr', dataDir: t.dataDir, io, deps: { loadConfig: () => ({ profile: 'frontdoor', relay: null }), renderQr: async () => '[QR]' } }), 0, io.text.err);
      assert.equal(decodeQr(/^(kl1:\S+)$/m.exec(io.text.out)[1]).relay, origin);
      assert.equal((await t.fd.adminRpc('frontdoor.status')).public_url, origin);
    });

    it('serves OAuth metadata whose issuer, resource and endpoints carry that port', async () => {
      const as = await request(t.base, { path: '/.well-known/oauth-authorization-server', tls: t.tls });
      assert.equal(as.status, 200);
      assert.equal(as.json.issuer, origin);
      for (const [key, p] of [['authorization_endpoint', '/oauth/authorize'], ['token_endpoint', '/oauth/token'], ['registration_endpoint', '/oauth/register'], ['revocation_endpoint', '/oauth/revoke']]) {
        assert.equal(as.json[key], `${origin}${p}`, key);
      }
      const pr = await request(t.base, { path: '/.well-known/oauth-protected-resource/mcp', tls: t.tls });
      assert.equal(pr.status, 200);
      assert.equal(pr.json.resource, `${origin}/mcp`);
      assert.deepEqual(pr.json.authorization_servers, [origin]);
      assert.equal(t.fd.oauth.resourceUrl, `${origin}/mcp`);
    });

    it('takes MCP requests from that origin only, and points at metadata with that port', async () => {
      const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
      const own = await request(t.base, { method: 'POST', path: '/mcp', tls: t.tls, headers: { origin }, json: body });
      assert.equal(own.status, 401, 'past the Origin check, refused only for want of a token');
      assert.equal(own.headers['www-authenticate'], `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
      const other = publicPort === 443 ? 'https://mcp.kl.example.com:8443' : 'https://mcp.kl.example.com';
      const foreign = await request(t.base, { method: 'POST', path: '/mcp', tls: t.tls, headers: { origin: other }, json: body });
      assert.equal(foreign.status, 403);
    });
  });
}
