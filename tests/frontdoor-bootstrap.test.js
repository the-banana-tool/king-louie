// tests/frontdoor-bootstrap.test.js — fleet stage 4 §3.11: a fresh front
// door, its first phone from the console, a console-confirmed node paired
// with `pair https://`, and doctor before and after. This test process stands
// in for the running service (service.pid holds its own pid).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { startFrontDoor } = require('../src/frontdoor/profile');
const { parseFrontDoorConfig } = require('../src/frontdoor/config');
const { checks } = require('../src/frontdoor/doctor-checks');
const { runFrontDoorCommand } = require('../src/service/commands/frontdoor');
const { runPair } = require('../src/service/commands/pair');
const { ApproverStore } = require('../src/approvals/approver-store');
const { decodeQr } = require('../src/approvals/messages');
const { nodeFingerprint } = require('../src/frontdoor/protocol/messages');
const { createFakePhone } = require('./helpers/fake-phone');
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
const until = async (fn, what, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
function streamIo() {
  const text = { out: '', err: '' };
  return { stdin: new PassThrough(), stdout: { write: (s) => { text.out += String(s); return true; } }, stderr: { write: (s) => { text.err += String(s); return true; } }, text };
}

let t;
before(async () => {
  const store = await approverStoreWith([], { allowTestKeys: true });
  cleanups.push(() => store.cleanup());
  const base = store.baseDir;
  const configDir = path.join(base, 'config');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const ca = createCa();
  const leaf = issueCert(ca, { dnsNames: ['mcp.kl.example.com'] });
  fs.writeFileSync(path.join(configDir, 'mcp.pem'), leaf.cert, { mode: 0o644 });
  fs.writeFileSync(path.join(configDir, 'mcp.key'), leaf.key, { mode: 0o600 });
  fs.writeFileSync(path.join(base, 'ca.pem'), ca.cert);
  const tlsKeys = { cert_file: path.join(configDir, 'mcp.pem'), key_file: path.join(configDir, 'mcp.key') };
  fs.writeFileSync(path.join(configDir, 'node.yaml'), `name: frontdoor\nprofile: frontdoor\nfrontdoor:\n  domain: kl.example.com\n  tls: { cert_file: ${JSON.stringify(tlsKeys.cert_file)}, key_file: ${JSON.stringify(tlsKeys.key_file)} }\n`, { mode: 0o644 });
  const nodeConfig = { name: 'frontdoor', profile: 'frontdoor', frontdoor: parseFrontDoorConfig({ domain: 'kl.example.com', tls: tlsKeys }, 'node.yaml') };
  const serviceConfig = { profile: 'frontdoor', features: OFF, ports: {}, relayRaw: null, audit: { retentionDays: 365 } };
  const fd = await startFrontDoor({
    dataDir, configDir, adminUid: UID, geteuid: () => UID, nodeConfig, serviceConfig,
    deps: { listen: { host: '127.0.0.1', port: 0 }, lookup, probeCa: ca.cert, allowTestKeys: true, approverStoreOptions: STORE }
  });
  cleanups.push(() => fd.stop());
  fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
  const port = fd.address().port;
  const doctor = async () => {
    const approverStore = new ApproverStore({ dir: path.join(configDir, 'approvers'), stagedDir: path.join(dataDir, 'approvals', 'staged'), ...STORE, allowTestKeys: true });
    await approverStore.ready();
    return checks({ dataDir, configDir, adminUid: UID, nodeConfig, serviceConfig, platform: 'linux', deps: { approverStore, fetchDate: async () => new Date(), readUnit: () => '' } });
  };
  t = { base, configDir, dataDir, ca, fd, port, url: `https://mcp.kl.example.com:${port}`, tls: { ca: ca.cert, lookup }, doctor, caFile: path.join(base, 'ca.pem') };
});

const row = (rows, name) => rows.find((r) => r.check === name);

describe('bootstrapping a front door', () => {
  it('doctor fails "no phone" on a fresh front door', async () => {
    assert.deepEqual(row(await t.doctor(), 'phone enrolled on this front door').ok, false);
  });

  it('frontdoor enroll-device enrolls the first phone from the console', async () => {
    const io = streamIo();
    const phone = createFakePhone({ seed: 'A', name: 'Owner phone' });
    const enrolling = runFrontDoorCommand({ sub: 'enroll-device', dataDir: t.dataDir, configDir: t.configDir, io, deps: { renderQr: async () => '[QR]', storeOptions: STORE, allowTestKeys: true, pollMs: 25 } });
    const qrText = await until(() => /Or paste this into the app: (kl1:\S+)/.exec(io.text.out), () => `the QR (${io.text.err})`);
    const qr = decodeQr(qrText[1]);
    assert.equal(qr.relay, 'https://mcp.kl.example.com');
    assert.equal(qr.relay_spki, t.fd.relay.phoneSpki);
    assert.equal(qr.node.id, t.fd.identity.nodeId);
    const claim = await request(t.url, { method: 'POST', path: `/v1/enroll/${qr.code_id}`, json: phone.enroll({ codeId: qr.code_id, code: qr.code }), tls: t.tls });
    assert.equal(claim.status, 202, claim.text);
    await until(() => /does the phone show the same\? \[y\/N\]/.test(io.text.out), 'the confirmation prompt');
    io.stdin.write('y\n');
    assert.equal(await enrolling, 0, io.text.err);
    assert.ok(fs.existsSync(path.join(t.configDir, 'approvers', `${phone.deviceId}.json`)));
    assert.equal(row(await t.doctor(), 'phone enrolled on this front door').ok, true);
  });

  it('frontdoor code --confirm and pair https:// enroll a node from the two consoles', async () => {
    const nodeBase = path.join(t.base, 'node');
    const nodeData = path.join(nodeBase, 'data');
    const nodeConfigDir = path.join(nodeBase, 'config');
    fs.mkdirSync(nodeData, { recursive: true });
    fs.mkdirSync(nodeConfigDir, { recursive: true, mode: 0o755 });
    const codeIo = streamIo();
    const coding = runFrontDoorCommand({ sub: 'code', arg: 'unnamed-node', flags: { confirm: true }, dataDir: t.dataDir, configDir: t.configDir, io: codeIo, deps: { pollMs: 25, waitPollMs: 25 } });
    const code = (await until(() => /^Pairing code for unnamed-node: ([a-z]+(?: [a-z]+){5})$/m.exec(codeIo.text.out), () => `the code (${codeIo.text.err})`))[1];
    const pairIo = streamIo();
    const pairing = runPair({
      url: t.url, dataDir: nodeData, io: pairIo,
      flags: { code, caFile: t.caFile, yesFingerprint: nodeFingerprint(t.fd.identity.nodeId) },
      // /pair/v1 allows 10 requests a minute per IP, and pair honours a
      // 429's retry_after (up to 60 s): poll slowly enough to stay under it.
      deps: { lookup, configDir: nodeConfigDir, pollMs: 1000 }
    });
    await until(() => /Does the node console show the same\? \[y\/N\] $/.test(codeIo.text.out), () => `the console prompt (${codeIo.text.err} ${pairIo.text.err})`);
    const nodeId = /^Node ID: (kl-[a-z2-7]{16})$/m.exec(pairIo.text.out)[1];
    assert.match(pairIo.text.out, new RegExp(`^Node fingerprint: ${nodeFingerprint(nodeId)}$`, 'm'));
    assert.match(codeIo.text.out, new RegExp(`^Node unnamed-node \\(\\w+\\) fingerprint: ${nodeFingerprint(nodeId)}$`, 'm'));
    codeIo.stdin.write('y\n');
    assert.equal(await coding, 0, codeIo.text.err);
    assert.equal(await pairing, 0, pairIo.text.err);
    assert.match(pairIo.text.out, new RegExp(`^Front door fingerprint: ${nodeFingerprint(t.fd.identity.nodeId)}  \\(compare with the phone app\\)$`, 'm'));
    const pin = JSON.parse(fs.readFileSync(path.join(nodeConfigDir, 'front-door.json'), 'utf8'));
    assert.deepEqual([pin.frontdoor_id, pin.domain, pin.mesh_url], [t.fd.identity.nodeId, 'kl.example.com', `wss://mesh.kl.example.com:${t.port}/mesh/v1`]);
    assert.ok(fs.existsSync(path.join(t.configDir, 'frontdoor-nodes', `${nodeId}.json`)));
    assert.equal(t.fd.registry.byName('unnamed-node').source, 'console');

    const listIo = streamIo();
    assert.equal(await runFrontDoorCommand({ sub: 'nodes', dataDir: t.dataDir, configDir: t.configDir, io: listIo, deps: { pollMs: 25 } }), 0);
    assert.match(listIo.text.out, new RegExp(`^unnamed-node  console  offline  ${nodeFingerprint(nodeId)}`, 'm'));

    const removeIo = streamIo();
    assert.equal(await runFrontDoorCommand({ sub: 'remove-node', arg: 'unnamed-node', dataDir: t.dataDir, configDir: t.configDir, io: removeIo, deps: { pollMs: 25 } }), 0, removeIo.text.err);
    assert.equal(t.fd.registry.byName('unnamed-node'), null);
    assert.equal(await runFrontDoorCommand({ sub: 'remove-node', arg: 'unnamed-node', dataDir: t.dataDir, configDir: t.configDir, io: streamIo(), deps: { pollMs: 25 } }), 1);
  });

  it('pair https:// refuses a wrong code and a declined fingerprint, and writes nothing', async () => {
    const nodeBase = path.join(t.base, 'node2');
    const nodeData = path.join(nodeBase, 'data');
    const nodeConfigDir = path.join(nodeBase, 'config');
    fs.mkdirSync(nodeData, { recursive: true });
    fs.mkdirSync(nodeConfigDir, { recursive: true, mode: 0o755 });
    const pinFile = path.join(nodeConfigDir, 'front-door.json');
    const wrong = streamIo();
    await t.fd.pairing.issue('unnamed-node', { by: 'console', confirm: 'phone' });
    assert.equal(await runPair({ url: t.url, dataDir: nodeData, io: wrong, flags: { code: 'abandon ability able about above absent', caFile: t.caFile, yesFingerprint: 'x' }, deps: { lookup, configDir: nodeConfigDir, pollMs: 25 } }), 1);
    assert.match(wrong.text.err, /pairing code rejected/);
    const { code } = await t.fd.pairing.issue('unnamed-node', { by: 'console', confirm: 'phone' });
    const declined = streamIo();
    assert.equal(await runPair({ url: t.url, dataDir: nodeData, io: declined, flags: { code, caFile: t.caFile, yesFingerprint: 'kl-aaaa aaaa aaaa aaaa' }, deps: { lookup, configDir: nodeConfigDir, pollMs: 25 } }), 1);
    assert.match(declined.text.out, /Not paired\. Nothing was written\./);
    const notty = streamIo();
    const again = await t.fd.pairing.issue('unnamed-node', { by: 'console', confirm: 'phone' });
    assert.equal(await runPair({ url: t.url, dataDir: nodeData, io: notty, flags: { code: again.code, caFile: t.caFile }, deps: { lookup, configDir: nodeConfigDir, pollMs: 25 } }), 2);
    assert.match(notty.text.err, /--yes-fingerprint/);
    assert.equal(fs.existsSync(pinFile), false);
  });

  it("F3 relay commands name their frontdoor counterparts; relay qr prints the front door's re-pin code", async () => {
    const { runRelayCommand } = require('../src/service/commands/relay');
    const io = streamIo();
    assert.equal(await runRelayCommand({ sub: 'code', arg: 'web-01', dataDir: t.dataDir, io, deps: { loadConfig: () => ({ profile: 'frontdoor', relay: null }) } }), 2);
    assert.match(io.text.err, /relay code is not used on a front door; use "king-louie-service frontdoor code <node-name>"/);
    const qrIo = streamIo();
    assert.equal(await runRelayCommand({ sub: 'qr', dataDir: t.dataDir, io: qrIo, deps: { loadConfig: () => ({ profile: 'frontdoor', relay: null }), renderQr: async () => '[QR]' } }), 0);
    const qr = decodeQr(/^(kl1:\S+)$/m.exec(qrIo.text.out)[1]);
    assert.deepEqual(qr, { t: 'kl.relay', relay: 'https://mcp.kl.example.com', relay_spki: t.fd.relay.phoneSpki });
  });
});
