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

// Push spec §8 (C-12, C-14): the push row, on a front door and a relay run host.
describe('doctor: the push row', () => {
  const { pushRow } = require('../src/frontdoor/doctor-checks');
  const KEY_FILE = '/etc/king-louie/push/fcm-key.json';
  const KEY_DIR = '/etc/king-louie/push';
  const SECRET = '-----BEGIN PRIVATE KEY-----\nAAAAsecretsecret\n-----END PRIVATE KEY-----\n';
  const key = (over = {}) => JSON.stringify({ type: 'service_account', project_id: 'kl-push-example', client_email: 'fcm@kl-push-example.iam.gserviceaccount.example.com', private_key: SECRET, private_key_id: 'abc123secretid', ...over });
  const fileStat = (over = {}) => ({ uid: 0, gid: 990, mode: 0o100640, isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, ...over });
  const dirStat = (over = {}) => ({ uid: 0, gid: 990, mode: 0o40750, isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true, ...over });
  function harness({ text = key(), file = fileStat(), dir = dirStat(), missing = false, status } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-push-doctor-'));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    if (status !== undefined) {
      fs.mkdirSync(path.join(dataDir, 'relay'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'relay', 'push-status.json'), typeof status === 'string' ? status : JSON.stringify(status));
    }
    const lstat = (p) => {
      if (p === KEY_FILE) {
        if (missing) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return file;
      }
      if (p === KEY_DIR) return dir;
      if (p === dataDir) return dirStat({ uid: 990, gid: 990, mode: 0o40700 });
      throw new Error(`unexpected lstat ${p}`);
    };
    const readFile = (p) => {
      assert.equal(p, KEY_FILE);
      if (missing) throw Object.assign(new Error('x'), { code: 'ENOENT' });
      return text;
    };
    const run = (push = { fcm: { serviceAccountFile: KEY_FILE } }, platform = 'linux') => pushRow({ dataDir, push, platform, adminUid: 0, deps: { lstat, readFile } });
    return { dataDir, run };
  }
  const noSecrets = (r) => {
    for (const s of ['AAAAsecretsecret', 'abc123secretid', 'gserviceaccount', 'BEGIN PRIVATE']) assert.ok(!r.detail.includes(s), `${s} in ${r.detail}`);
  };

  it('no push configured is "none", not a failure', () => {
    const t = harness();
    assert.deepEqual(t.run({}), { check: 'push', ok: true, detail: 'none (the app checks only while open)' });
    assert.deepEqual(t.run(null), { check: 'push', ok: true, detail: 'none (the app checks only while open)' });
  });

  it('a configured fcm sender: owner, mode and project id; no status yet', () => {
    const r = harness().run();
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.check, 'push');
    assert.match(r.detail, /^senders: fcm; /);
    assert.match(r.detail, /project_id kl-push-example/);
    assert.match(r.detail, /owned root:990, mode 0640, in a 0750 directory/);
    assert.match(r.detail, /no push sent yet/);
    noSecrets(r);
  });

  it('a wrong owner, group or mode fails on POSIX', () => {
    for (const [opts, want] of [
      [{ file: fileStat({ mode: 0o100644 }) }, /mode 0644/],
      [{ file: fileStat({ uid: 990 }) }, /owned by uid 990/],
      [{ file: fileStat({ gid: 0 }) }, /group 0/],
      [{ dir: dirStat({ mode: 0o40755 }) }, /directory .* mode 0755/],
      [{ dir: dirStat({ uid: 990 }) }, /directory .* owned by uid 990/],
      [{ file: fileStat({ isSymbolicLink: () => true, isFile: () => false }) }, /link/]
    ]) {
      const r = harness(opts).run();
      assert.equal(r.ok, false, JSON.stringify(opts));
      assert.match(r.detail, want);
      noSecrets(r);
    }
  });

  it('on Windows owner and mode are not checked', () => {
    const r = harness({ file: fileStat({ mode: 0o100666, uid: 5 }) }).run(undefined, 'win32');
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /owner and mode not checked \(POSIX only\)/);
    assert.match(r.detail, /project_id kl-push-example/);
  });

  it('a missing or unparsable file fails, naming the path and never the contents', () => {
    let r = harness({ missing: true }).run();
    assert.equal(r.ok, false);
    assert.match(r.detail, /fcm-key\.json/);
    assert.match(r.detail, /missing/);
    r = harness({ text: '{ "private_key": "AAAAsecretsecret" ' }).run();
    assert.equal(r.ok, false);
    assert.match(r.detail, /does not parse/);
    noSecrets(r);
    r = harness({ text: key({ project_id: undefined }) }).run();
    assert.equal(r.ok, false);
    assert.match(r.detail, /"project_id"/);
    noSecrets(r);
  });

  it('the last result from push-status.json: times and HTTP status only', () => {
    const status = { v: 1, last_send: { at: '2026-10-29T10:00:00.000Z', sender: 'fcm', status: 200 }, last_failure: { at: '2026-10-28T09:00:00.000Z', sender: 'fcm', status: 404 } };
    let r = harness({ status }).run();
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /last send 2026-10-29T10:00:00\.000Z fcm HTTP 200; last failure 2026-10-28T09:00:00\.000Z fcm HTTP 404/);
    assert.equal(r.warn, undefined);
    // The last send failed: a warning, not a failure.
    r = harness({ status: { v: 1, last_send: { at: '2026-10-29T10:00:00.000Z', sender: 'fcm', status: null }, last_failure: { at: '2026-10-29T10:00:00.000Z', sender: 'fcm', status: null } } }).run();
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.detail, /last send 2026-10-29T10:00:00\.000Z fcm no HTTP answer/);
  });

  it('a push-status.json that is there but unreadable or misshapen fails, and shows nothing of it', () => {
    for (const status of [
      '{nope',
      { v: 1, last_send: { at: 'yesterday\u001b[2J', sender: 'fcm', status: 200 }, last_failure: null },
      { v: 2 },
      { v: 1, last_send: { at: '2026-10-29T10:00:00.000Z', sender: 'fcm', status: 200, token: 'tok-secret' }, last_failure: null }
    ]) {
      const r = harness({ status }).run();
      assert.equal(r.ok, false, JSON.stringify(status));
      assert.match(r.detail, /cannot read .*push-status\.json/);
      assert.doesNotMatch(r.detail, /yesterday|tok-secret/);
    }
  });

  it('the front door checks() includes it, from service.json relay.push', async () => {
    const t = await setup();
    let rows = await t.run();
    assert.deepEqual(row(rows, 'push'), { check: 'push', ok: true, detail: 'none (the app checks only while open)' });
    t.serviceConfig.relayRaw = { push: { fcm: { service_account_file: path.join(t.dataDir, 'nope', 'key.json') } } };
    rows = await t.run();
    assert.equal(row(rows, 'push').ok, false);
    assert.match(row(rows, 'push').detail, /missing/);
  });
});

describe('runDoctor on a relay run host', () => {
  function layout(tt, { serviceJson, nodeYaml } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-doctor-'));
    tt.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const dataDir = path.join(base, 'data');
    const configDir = path.join(base, 'config');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
    if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(dataDir, 0o700); }
    if (serviceJson) fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify(serviceJson), { mode: 0o644 });
    if (nodeYaml) fs.writeFileSync(path.join(configDir, 'node.yaml'), nodeYaml, { mode: 0o644 });
    return { dataDir, configDir, adminUid: process.platform !== 'win32' ? process.getuid() : 0 };
  }

  it('adds the push row when the admin service.json has a relay block', async (tt) => {
    const t = layout(tt, { serviceJson: { relay: { public_url: 'https://relay.example.com', tls: { cert_file: '/etc/kl/c.pem', key_file: '/etc/kl/k.pem' }, mesh_listen: { host: '10.0.0.5' } } } });
    const rows = await runDoctor({ dataDir: t.dataDir, configDir: t.configDir, adminUid: t.adminUid, platform: 'linux' });
    assert.deepEqual(rows.filter((r) => r.check === 'push'), [{ check: 'push', ok: true, detail: 'none (the app checks only while open)' }]);
  });

  it('adds no push row without a relay block', async (tt) => {
    const t = layout(tt, { nodeYaml: 'name: web-01\nprofile: runbook\n' });
    const rows = await runDoctor({ dataDir: t.dataDir, configDir: t.configDir, adminUid: t.adminUid, platform: 'linux' });
    assert.equal(rows.some((r) => r.check === 'push'), false);
  });
});
