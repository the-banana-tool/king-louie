// tests/frontdoor-doctor.test.js — fleet stage 4 §3.14 (doctor on a front door).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checks, NO_PHONE, BREAK_REASONS } = require('../src/frontdoor/doctor-checks');
const { runDoctor } = require('../src/service/doctor');
const { LETS_ENCRYPT_PRODUCTION } = require('../src/frontdoor/config');
const { createCa, issueCert } = require('./helpers/test-certs');
const { createFakePhone } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const ADMIN_UID = process.platform !== 'win32' ? process.getuid() : 0;
const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const A = createFakePhone({ seed: 'A' });
const OFF = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false };
const cleanups = [];
after(() => { for (const c of cleanups) c(); });

async function setup({ phones = [A], port = 443 } = {}) {
  const store = await approverStoreWith(phones.map((p) => p.approverRecord()), { allowTestKeys: true });
  cleanups.push(() => store.cleanup());
  const dataDir = path.join(store.baseDir, 'data');
  const configDir = path.join(store.baseDir, 'config');
  fs.mkdirSync(path.join(dataDir, 'frontdoor', 'acme'), { recursive: true });
  const nodeConfig = { name: 'frontdoor', profile: 'frontdoor', frontdoor: { domain: 'kl.example.com', listen: { host: '0.0.0.0', port }, acme: { email: null, directory: 'https://acme.example.com/directory', termsAgreed: true }, tls: null } };
  const serviceConfig = { profile: 'frontdoor', features: OFF, relayRaw: null };
  const write = (rel, value) => fs.writeFileSync(path.join(dataDir, 'frontdoor', rel), JSON.stringify(value));
  const run = (deps = {}) => checks({
    dataDir, configDir, adminUid: ADMIN_UID, nodeConfig, serviceConfig, platform: 'linux',
    deps: { approverStore: store, now: () => NOW, fetchDate: async () => new Date(NOW + 2000), readUnit: () => 'AmbientCapabilities=CAP_NET_BIND_SERVICE\n', ...deps }
  });
  return { dataDir, configDir, nodeConfig, serviceConfig, store, write, run };
}

const row = (rows, name) => rows.find((r) => r.check === name);

describe('doctor on a front door', () => {
  it('a fresh front door: no phone, no probe, waiting for ACME', async () => {
    const t = await setup({ phones: [] });
    const rows = await t.run();
    assert.deepEqual(row(rows, 'phone enrolled on this front door'), { check: 'phone enrolled on this front door', ok: false, detail: 'No phone enrolled on this front door: run "king-louie-service frontdoor enroll-device"' });
    assert.equal(row(rows, 'self-probe (DNS, mcp. and mesh.)').ok, false);
    assert.deepEqual([row(rows, 'mcp. certificate').ok, row(rows, 'mcp. certificate').detail], [false, 'waiting for ACME (no certificate issued yet)']);
    assert.ok(row(rows, 'frontdoor profile').ok);
  });

  it('a healthy front door', async () => {
    const t = await setup();
    t.write('probe.json', { at: new Date(NOW).toISOString(), ok: true, mcp: { ok: true, detail: 'x' }, mesh: { ok: true, detail: 'y' } });
    t.write('acme/cert.json', { v: 1, chain: '', not_before: new Date(NOW - 86400000).toISOString(), not_after: new Date(NOW + 60 * 86400000).toISOString(), spki: 'sha256/x' });
    t.write('alerts.json', { v: 1, seq: 1, alerts: [{ id: '1', kind: 'node_record_invalid', subject: 'node:kl-x', detail: {}, at: new Date(NOW).toISOString(), acked: true }] });
    const rows = await t.run();
    assert.deepEqual(rows.filter((r) => !r.ok), []);
    assert.equal(row(rows, 'mcp. certificate').detail, '60 days left');
    assert.equal(row(rows, 'clock skew').detail, '2 s');
  });

  it('fails a certificate under 21 days, a missing capability, unacked breaks and invalid records, and clock skew over 30 s', async () => {
    const t = await setup();
    t.write('acme/cert.json', { v: 1, chain: '', not_before: new Date(NOW - 86400000).toISOString(), not_after: new Date(NOW + 10 * 86400000).toISOString(), spki: 'sha256/x' });
    t.write('alerts.json', { v: 1, seq: 2, alerts: [
      { id: '1', kind: 'audit_chain_break', subject: 'node:kl-a', detail: {}, at: new Date(NOW).toISOString(), acked: false },
      { id: '2', kind: 'node_record_invalid', subject: 'grant:gr_x', detail: {}, at: new Date(NOW).toISOString(), acked: false }
    ] });
    const rows = await t.run({ readUnit: () => '[Service]\n', fetchDate: async () => new Date(NOW - 45000) });
    assert.deepEqual([row(rows, 'mcp. certificate').ok, row(rows, 'mcp. certificate').detail], [false, '10 days left (renewal should have happened; see the acme_renewal_failing alert)']);
    assert.equal(row(rows, 'CAP_NET_BIND_SERVICE').ok, false);
    assert.deepEqual([row(rows, 'no unacknowledged audit breaks').ok, row(rows, 'no unacknowledged audit breaks').detail], [false, 'audit_chain_break node:kl-a']);
    assert.deepEqual([row(rows, 'node and grant records verify').ok, row(rows, 'node and grant records verify').detail], [false, 'grant:gr_x']);
    assert.deepEqual([row(rows, 'clock skew').ok, row(rows, 'clock skew').detail], [false, '45 s (more than 30 s)']);
  });

  it('above port 1024 the capability is not needed; under ACME an unreachable directory fails', async () => {
    const t = await setup({ port: 8443 });
    const rows = await t.run({ fetchDate: async () => null });
    assert.deepEqual(row(rows, 'CAP_NET_BIND_SERVICE'), { check: 'CAP_NET_BIND_SERVICE', ok: true, detail: 'not needed (port 8443)' });
    assert.equal(row(rows, 'clock skew').ok, false, 'under ACME an unreachable directory is a failure');
  });
});

describe('doctor on a front door: mirror break wording', () => {
  const REASONS = ['fork', 'truncated', 'replay', 'withheld_entries', 'oversize_entry', 'oversize_page', 'wrong_node', 'malformed_head', 'mirror_state_corrupt'];

  it('every known break reason has its own plain-English line: what happened and what to do', async () => {
    const t = await setup();
    const lines = new Set();
    for (const reason of REASONS) {
      t.write('alerts.json', { v: 1, seq: 1, alerts: [{ id: '1', kind: 'audit_chain_break', subject: 'node:kl-a', detail: { reason, seq: 7 }, at: new Date(NOW).toISOString(), acked: false }] });
      const r = row(await t.run(), 'no unacknowledged audit breaks');
      assert.equal(r.ok, false, reason);
      assert.ok(r.detail.startsWith(`audit_chain_break node:kl-a (${reason}): `), r.detail);
      const text = r.detail.slice(`audit_chain_break node:kl-a (${reason}): `.length);
      assert.equal(text, BREAK_REASONS[reason], reason);
      assert.ok(text.length > 40 && /[.;]/.test(text), `${reason}: says what happened and what to do`);
      lines.add(text);
    }
    assert.equal(lines.size, REASONS.length, 'each reason reads differently');
    assert.deepEqual(Object.keys(BREAK_REASONS).sort(), [...REASONS].sort());
  });

  it('an unknown reason prints its code; a gap names the missing range', async () => {
    const t = await setup();
    t.write('alerts.json', { v: 1, seq: 3, alerts: [
      { id: '1', kind: 'audit_chain_break', subject: 'node:kl-a', detail: { reason: 'hash_mismatch' }, at: new Date(NOW).toISOString(), acked: false },
      { id: '2', kind: 'audit_chain_break', subject: 'node:kl-b', detail: { reason: 'not a code!' }, at: new Date(NOW).toISOString(), acked: false },
      { id: '3', kind: 'audit_gap', subject: 'node:kl-c', detail: { from_seq: 5, to_seq: 9 }, at: new Date(NOW).toISOString(), acked: false }
    ] });
    const r = row(await t.run(), 'no unacknowledged audit breaks');
    assert.equal(r.ok, false);
    assert.equal(r.detail, 'audit_chain_break node:kl-a (hash_mismatch); audit_chain_break node:kl-b (unknown reason); audit_gap node:kl-c (entries 5–9 are missing from the mirror)');
  });
});

describe('doctor on a front door: fail closed on what it reads', () => {
  it('builds its own approver store from the admin config dir, never allowing test keys', async () => {
    const t = await setup();
    const rows = await t.run({ approverStore: undefined });
    assert.deepEqual(row(rows, 'phone enrolled on this front door'), { check: 'phone enrolled on this front door', ok: false, detail: NO_PHONE });
  });

  it('a corrupt, oversize or misshapen alerts.json fails both alert rows instead of reading as "none"', async () => {
    const t = await setup();
    fs.writeFileSync(path.join(t.dataDir, 'frontdoor', 'alerts.json'), '{not json');
    let rows = await t.run();
    assert.equal(row(rows, 'no unacknowledged audit breaks').ok, false);
    assert.equal(row(rows, 'node and grant records verify').ok, false);
    assert.match(row(rows, 'no unacknowledged audit breaks').detail, /alerts\.json/);
    fs.writeFileSync(path.join(t.dataDir, 'frontdoor', 'alerts.json'), JSON.stringify({ v: 1, alerts: [], pad: 'x'.repeat(9 * 1024 * 1024) }));
    rows = await t.run();
    assert.equal(row(rows, 'no unacknowledged audit breaks').ok, false);
    fs.writeFileSync(path.join(t.dataDir, 'frontdoor', 'alerts.json'), JSON.stringify({ v: 1, alerts: 'nope' }));
    rows = await t.run();
    assert.equal(row(rows, 'node and grant records verify').ok, false);
  });

  it('no alerts.json yet is a clean start', async () => {
    const t = await setup();
    const rows = await t.run();
    assert.deepEqual([row(rows, 'no unacknowledged audit breaks').ok, row(rows, 'node and grant records verify').ok], [true, true]);
  });

  it('an unreadable cert.json is a failure, never "NaN days left"', async () => {
    const t = await setup();
    for (const cert of [{ v: 1, not_after: 'soon' }, { v: 1 }, 'x']) {
      t.write('acme/cert.json', cert);
      const r = row(await t.run(), 'mcp. certificate');
      assert.equal(r.ok, false, JSON.stringify(cert));
      assert.doesNotMatch(r.detail, /NaN/);
    }
  });

  it('operator TLS: reads the admin certificate file; an unreachable directory is WARN not checked', async (tt) => {
    const t = await setup();
    const ca = createCa();
    const leaf = issueCert(ca, { dnsNames: ['mcp.kl.example.com'], notAfter: NOW + 10 * 86400000 + 3600000 });
    const certFile = path.join(t.dataDir, '..', 'config', 'mcp.pem');
    fs.writeFileSync(certFile, leaf.cert);
    tt.after(() => fs.rmSync(certFile, { force: true }));
    t.nodeConfig.frontdoor.acme = null;
    t.nodeConfig.frontdoor.tls = { certFile, keyFile: `${certFile}.key` };
    let asked = null;
    const rows = await t.run({ fetchDate: async (url) => { asked = url; return null; } });
    assert.equal(asked, LETS_ENCRYPT_PRODUCTION);
    assert.deepEqual(row(rows, 'clock skew'), { check: 'clock skew', ok: true, detail: `not checked (${LETS_ENCRYPT_PRODUCTION} unreachable)`, warn: true });
    assert.deepEqual([row(rows, 'mcp. certificate').ok, row(rows, 'mcp. certificate').detail], [false, '10 days left']);
  });

  it('throwing deps are failures, not crashes', async () => {
    const t = await setup();
    const rows = await t.run({ fetchDate: async () => { throw new Error('boom'); }, readUnit: () => { throw new Error('boom'); } });
    assert.equal(row(rows, 'clock skew').ok, false);
    assert.equal(row(rows, 'CAP_NET_BIND_SERVICE').ok, false);
  });

  it('text from the data dir is shown without control characters', async () => {
    const t = await setup();
    t.write('probe.json', { at: new Date(NOW).toISOString(), ok: false, mcp: { ok: false, detail: 'mcp.kl.example.com: \u001b[2Jboom‮' }, mesh: { ok: true, detail: 'y' } });
    t.write('alerts.json', { v: 1, seq: 1, alerts: [{ id: '1', kind: 'node_record_invalid', subject: 'grant:\u001b[31mgr_x', detail: {}, at: new Date(NOW).toISOString(), acked: false }] });
    const rows = await t.run();
    assert.equal(row(rows, 'self-probe (DNS, mcp. and mesh.)').detail, `${new Date(NOW).toISOString()}: mcp.kl.example.com: [2Jboom`);
    assert.equal(row(rows, 'node and grant records verify').detail, 'grant:[31mgr_x');
  });

  it('a probe.json whose `at` is not a strict ISO-8601 instant is unreadable, and nothing of it is shown', async () => {
    const t = await setup();
    t.write('probe.json', { at: `${new Date(NOW).toISOString()}\u001b[2J`, ok: true, mcp: { ok: true, detail: 'x' }, mesh: { ok: true, detail: 'y' } });
    const r = row(await t.run(), 'self-probe (DNS, mcp. and mesh.)');
    assert.equal(r.ok, false);
    assert.match(r.detail, /^cannot read .*probe\.json/);
    assert.doesNotMatch(r.detail, /\p{Cc}/u);
  });

  it('on a non-Linux host the capability row is a warning, not a check', async () => {
    const t = await setup();
    const rows = await checks({ dataDir: t.dataDir, configDir: t.configDir, nodeConfig: t.nodeConfig, serviceConfig: t.serviceConfig, platform: 'win32', deps: { approverStore: t.store, now: () => NOW, fetchDate: async () => new Date(NOW) } });
    assert.deepEqual(row(rows, 'CAP_NET_BIND_SERVICE'), { check: 'CAP_NET_BIND_SERVICE', ok: true, detail: 'not checked (the frontdoor profile installs on Linux only)', warn: true });
  });
});

describe('runDoctor on a front door', () => {
  it('appends the front-door rows when node.yaml says profile: frontdoor, reading only the admin config dir', async (tt) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fd-doctor-'));
    tt.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const dataDir = path.join(base, 'data');
    const configDir = path.join(base, 'config');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
    if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(dataDir, 0o700); }
    fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: frontdoor\nprofile: frontdoor\nfrontdoor:\n  domain: kl.example.com\n  acme:\n    terms_agreed: true\n', { mode: 0o644 });
    fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify({ profile: 'frontdoor' }), { mode: 0o644 });
    // The data dir is service-writable: a profile or relay block there decides nothing.
    fs.writeFileSync(path.join(dataDir, 'service.json'), JSON.stringify({ profile: 'agent', relay: { nonsense: 1 } }));
    const adminUid = process.platform !== 'win32' ? process.getuid() : 0;
    const rows = await runDoctor({ dataDir, configDir, adminUid, platform: 'linux' });
    const names = rows.map((r) => r.check);
    for (const name of ['frontdoor profile', 'frontdoor.domain', 'frontdoor TLS source', 'frontdoor features and relay keys', 'phone enrolled on this front door', 'self-probe (DNS, mcp. and mesh.)', 'mcp. certificate', 'CAP_NET_BIND_SERVICE', 'node and grant records verify', 'no unacknowledged audit breaks', 'clock skew']) {
      assert.ok(names.includes(name), name);
    }
    for (const name of ['frontdoor profile', 'frontdoor.domain', 'frontdoor TLS source', 'frontdoor features and relay keys']) assert.equal(row(rows, name).ok, true, name);
  });

  it('adds nothing on another profile', async (tt) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fd-doctor-'));
    tt.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const dataDir = path.join(base, 'data');
    const configDir = path.join(base, 'config');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: web-01\nprofile: runbook\n', { mode: 0o644 });
    const adminUid = process.platform !== 'win32' ? process.getuid() : 0;
    const rows = await runDoctor({ dataDir, configDir, adminUid, platform: 'linux' });
    assert.equal(rows.some((r) => r.check === 'frontdoor profile'), false);
  });
});
