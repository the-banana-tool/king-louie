// tests/service-cli-devices.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { main } = require('../src/service/cli');
const { runEnrollDevice, runDevice } = require('../src/service/commands/devices');
const { CourierPump } = require('../src/approvals/courier');
const { ApproverStore } = require('../src/approvals/approver-store');
const { checkApproverDir } = require('../src/approvals/approver-store');
const { decodeQr } = require('../src/approvals/messages');
const { open } = require('../src/approvals/envelope');
const { AuditLedger } = require('../src/audit/audit-ledger');
const { runDoctor } = require('../src/service/doctor');
const { buildServicePorts } = require('../src/service/ports');
const { getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
const { createFakePhone } = require('./helpers/fake-phone');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const storeOptions = { geteuid: () => UID, adminUid: UID, platform: 'linux' };
const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

function streamIo() {
  const text = { out: '', err: '' };
  return {
    stdin: new PassThrough(),
    stdout: { write: (s) => { text.out += String(s); return true; } },
    stderr: { write: (s) => { text.err += String(s); return true; } },
    text
  };
}

// A node: data dir, admin config dir with node.yaml, approvers/ and (unless
// told otherwise) a running service (this process's pid) linked to its relay.
function node({ relay = true, running = true, linked = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-devices-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(dataDir, { recursive: true });
  if (POSIX) for (const d of [base, configDir, path.join(configDir, 'approvers')]) fs.chmodSync(d, 0o755);
  fs.writeFileSync(path.join(configDir, 'node.yaml'), `name: web-01\n${relay ? 'approvers:\n  relay: wss://10.0.0.5:18795\n' : ''}`, { mode: 0o644 });
  if (running) fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
  if (linked) {
    fs.mkdirSync(path.join(dataDir, 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'approvals', 'link.json'), JSON.stringify({ connected: true, since: null, relay_id: 'kl-nt4ritcfj5kepq3y', relay_public_url: 'https://kl.example.com:8443', relay_spki: 'sha256/test' }));
  }
  return { base, dataDir, configDir };
}

// The running service's side of the courier, with a relay that records calls.
function servicePump(n) {
  const ports = buildServicePorts({ dataDir: n.dataDir });
  const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, 'web-01');
  const calls = [];
  const pump = new CourierPump({ dataDir: n.dataDir, relayClient: { call: async (method, params) => { calls.push([method, params]); return { ok: true }; } }, identity, pollMs: 10 }).start();
  cleanups.push(() => pump.stop());
  return { pump, calls, identity };
}

const deps = { storeOptions, renderQr: async () => '[QR]', pollMs: 10, timeoutMs: 5000 };

async function waitFor(check, what) {
  for (let i = 0; i < 400; i += 1) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('enroll-device refusals', () => {
  it('needs a writable approvers dir, a running service, approvers.relay and a linked relay', async () => {
    const blocked = node();
    fs.rmSync(path.join(blocked.configDir, 'approvers'), { recursive: true });
    fs.writeFileSync(path.join(blocked.configDir, 'approvers'), 'not a dir');
    let io = streamIo();
    assert.equal(await runEnrollDevice({ ...blocked, io, deps }), 1);
    assert.match(io.text.err, /Run this as root\/Administrator: .* is not writable\./);

    io = streamIo();
    assert.equal(await runEnrollDevice({ ...node({ running: false }), io, deps }), 1);
    assert.match(io.text.err, /The King Louie service is not running on this node/);

    io = streamIo();
    assert.equal(await runEnrollDevice({ ...node({ relay: false }), io, deps }), 1);
    assert.match(io.text.err, /approvers\.relay is not set in .*node\.yaml/);

    io = streamIo();
    assert.equal(await runEnrollDevice({ ...node({ linked: false }), io, deps }), 1);
    assert.match(io.text.err, /not linked to its relay yet/);
  });
});

describe('enroll-device', () => {
  async function enroll(answer) {
    const n = node();
    const { pump, calls } = servicePump(n);
    const io = streamIo();
    const phone = createFakePhone({ name: 'Pixel 9' });
    const running = runEnrollDevice({ ...n, io, deps });
    const text = await waitFor(() => /Or paste this into the app: (kl1:\S+)/.exec(io.text.out), 'the pairing code');
    const qr = decodeQr(text[1]);
    assert.equal(qr.t, 'kl.pair');
    assert.equal(qr.relay, 'https://kl.example.com:8443');
    assert.equal(qr.relay_spki, 'sha256/test');
    assert.match(io.text.out, /Relay fingerprint: nt4r itcf j5ke pq3y/);
    assert.ok(calls.some(([m]) => m === 'enroll.open'));
    const envelope = phone.enroll({ codeId: qr.code_id, code: qr.code });
    const inbox = pump.routeFor('enroll.claim', { code_id: qr.code_id });
    pump.deliver(inbox, 'enroll.claim', { code_id: qr.code_id, envelope });
    await waitFor(() => /does the phone show the same\? \[y\/N\]/.test(io.text.out), 'the prompt');
    assert.match(io.text.out, new RegExp(`Device "Pixel 9" \\(android\\) d-${phone.deviceId.slice(2, 6)} `));
    io.stdin.write(`${answer}\n`);
    const code = await running;
    await waitFor(() => calls.some(([m]) => m === 'enroll.done'), 'enroll.done');
    const done = open(calls.find(([m]) => m === 'enroll.done')[1].envelope).message;
    return { n, code, io, phone, done };
  }

  it('y writes the approver, audits it, and tells the relay', async () => {
    const { n, code, phone, done } = await enroll('y');
    assert.equal(code, 0);
    const record = JSON.parse(fs.readFileSync(path.join(n.configDir, 'approvers', `${phone.deviceId}.json`), 'utf8'));
    assert.equal(record.enrolled_by, 'console');
    assert.equal(record.name, 'Pixel 9');
    assert.equal(done.refused, false);
    assert.equal(open(done.enroll).message.device.device_id, phone.deviceId);
    const ledger = new AuditLedger({ dir: path.join(n.dataDir, 'audit'), nodeId: null });
    assert.deepEqual(ledger.tail(1).map((e) => [e.kind, e.writer, e.data.device_id]), [['device.enrolled', 'cli', phone.deviceId]]);
  });

  it('anything but y refuses and writes nothing', async () => {
    const { n, code, phone, done } = await enroll('n');
    assert.equal(code, 1);
    assert.equal(fs.existsSync(path.join(n.configDir, 'approvers', `${phone.deviceId}.json`)), false);
    assert.equal(done.refused, true);
  });
});

describe('device list | revoke | apply', () => {
  it('apply --yes enrolls a staged device, list shows it, revoke ends it', async () => {
    const n = node();
    const a = createFakePhone({ name: 'Owner phone' });
    const b = createFakePhone({ name: 'Second phone', platform: 'ios' });
    fs.writeFileSync(path.join(n.configDir, 'approvers', `${a.deviceId}.json`), JSON.stringify(a.approverRecord()), { mode: 0o644 });
    const store = new ApproverStore({ dir: path.join(n.configDir, 'approvers'), stagedDir: path.join(n.dataDir, 'approvals', 'staged'), ...storeOptions });
    await store.ready();
    assert.equal(store.stage(a.enroll({ device: b.device() })).state, 'staged');

    let io = streamIo();
    assert.equal(await runDevice({ sub: 'apply', flags: { yes: true }, ...n, io, deps }), 0);
    assert.match(io.text.out, new RegExp(`enroll  ${b.deviceId}  signed by ${a.deviceId}`));
    assert.match(io.text.out, new RegExp(`${b.deviceId}: enrolled`));

    io = streamIo();
    assert.equal(await runDevice({ sub: 'list', ...n, io, deps }), 0);
    assert.match(io.text.out, new RegExp(`${b.deviceId}  Second phone \\(ios\\)  active  enrolled by ${a.deviceId}`));

    io = streamIo();
    assert.equal(await runDevice({ sub: 'revoke', arg: b.deviceId, ...n, io, deps }), 0);
    const record = JSON.parse(fs.readFileSync(path.join(n.configDir, 'approvers', `${b.deviceId}.json`), 'utf8'));
    assert.equal(record.revoked_by, 'console');
    io = streamIo();
    await runDevice({ sub: 'list', ...n, io, deps });
    assert.match(io.text.out, new RegExp(`${b.deviceId}.*revoked`));
  });

  it('apply without --yes asks, and a no changes nothing', async () => {
    const n = node();
    const a = createFakePhone();
    fs.writeFileSync(path.join(n.configDir, 'approvers', `${a.deviceId}.json`), JSON.stringify(a.approverRecord()), { mode: 0o644 });
    const store = new ApproverStore({ dir: path.join(n.configDir, 'approvers'), stagedDir: path.join(n.dataDir, 'approvals', 'staged'), ...storeOptions });
    await store.ready();
    store.stage(a.enroll({ device: createFakePhone().device() }));
    const io = streamIo();
    const running = runDevice({ sub: 'apply', flags: {}, ...n, io, deps });
    await waitFor(() => /Apply these\? \[y\/N\]/.test(io.text.out), 'the question');
    io.stdin.write('n\n');
    assert.equal(await running, 0);
    assert.match(io.text.out, /Nothing applied\./);
    assert.equal(fs.readdirSync(path.join(n.dataDir, 'approvals', 'staged')).filter((f) => f.endsWith('.json')).length, 1);
  });

  it('revoke of an unknown device fails, and the CLI dispatches device and prints usage', async () => {
    const n = node();
    const io = streamIo();
    assert.equal(await runDevice({ sub: 'revoke', arg: 'd-aaaaaaaaaaaaaaaa', ...n, io, deps }), 1);
    assert.match(io.text.err, /No approver d-aaaaaaaaaaaaaaaa/);
    const usage = streamIo();
    assert.equal(await main(['device', 'frobnicate', '--data-dir', n.dataDir], usage), 2);
    assert.match(usage.text.err, /Usage: king-louie-service device list/);
  });

  it('age is judged on the signed created_at, never a service-written ageMs, and unsafe/deferred staged items are handled', async () => {
    const n = node();
    const a = createFakePhone({ name: 'Owner phone' });
    fs.writeFileSync(path.join(n.configDir, 'approvers', `${a.deviceId}.json`), JSON.stringify(a.approverRecord()), { mode: 0o644 });
    const store = new ApproverStore({ dir: path.join(n.configDir, 'approvers'), stagedDir: path.join(n.dataDir, 'approvals', 'staged'), ...storeOptions });
    await store.ready();
    const b = createFakePhone({ name: 'Third phone' });
    const createdAtMs = Date.now() - 5 * 60000;
    // An enroll whose signed created_at is 5 minutes old (kl.device.enroll's
    // own created_at→expires_at span is capped at 10 minutes, so it can't be
    // aged further back than that and still be unexpired) — age must be
    // computed from that timestamp (message.created_at), not any ageMs field
    // (Task 7 never produces one, and the carry says never invent one here).
    assert.equal(store.stage(a.enroll({ device: b.device(), now: createdAtMs })).state, 'staged');

    // A revoke of a device with no approver record yet: applyStaged defers
    // it (`deferred: unknown device`) instead of rejecting or crashing.
    const ghost = createFakePhone({ name: 'Ghost phone' });
    assert.equal(store.stage(a.revoke(ghost.deviceId)).state, 'revoked-pending-apply');

    // A misnamed file in staged/ that Task 7's listStaged() reports as
    // type: 'unsafe' rather than reading it.
    fs.writeFileSync(path.join(n.dataDir, 'approvals', 'staged', 'not-a-nonce.json'), '{}');

    const io = streamIo();
    assert.equal(await runDevice({ sub: 'apply', flags: { yes: true }, ...n, io, deps }), 0);
    assert.match(io.text.out, new RegExp(`enroll  ${b.deviceId}  signed by ${a.deviceId}  \\(\\d+ min ago\\)`));
    assert.doesNotMatch(io.text.out, /NaN min ago/);
    assert.match(io.text.out, new RegExp(`${b.deviceId}: enrolled`));
    assert.match(io.text.out, new RegExp(`${ghost.deviceId}: deferred: unknown device`));
    assert.match(io.text.out, /unsafe .*not-a-nonce\.json.* \(misnamed\)/);

    // The deferred revoke must still be staged (not moved to done/), so a
    // later apply after the device is enrolled would still see it.
    const stillStaged = fs.readdirSync(path.join(n.dataDir, 'approvals', 'staged')).filter((f) => f.endsWith('.json'));
    assert.ok(stillStaged.length >= 1);
  });
});

describe('listStaged()/applyStaged() throwing ApproverAdminError', () => {
  it('a symlinked staged/done is reported as a result, never an uncaught throw', async () => {
    const n = node();
    const stagedDir = path.join(n.dataDir, 'approvals', 'staged');
    fs.mkdirSync(stagedDir, { recursive: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-elsewhere-'));
    cleanups.push(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    // staged/ and staged/done/ are service-writable, so the service account
    // could swap either for a symlink and try to walk root's admin CLI
    // somewhere else; Task 7 made ApproverAdmin refuse that (ApproverAdminError)
    // instead of following it. `dir` on POSIX, `junction` on win32 (which
    // needs no elevated privilege to create, unlike a real symlink there).
    fs.symlinkSync(elsewhere, path.join(stagedDir, 'done'), POSIX ? 'dir' : 'junction');

    const listIo = streamIo();
    assert.equal(await runDevice({ sub: 'list', ...n, io: listIo, deps }), 0);
    assert.match(listIo.text.err, /Warning: Refusing to use .*done.*: it is a symlink/);

    const applyIo = streamIo();
    assert.equal(await runDevice({ sub: 'apply', flags: { yes: true }, ...n, io: applyIo, deps }), 1);
    assert.match(applyIo.text.err, /Refusing to use .*done.*: it is a symlink/);
  });
});

describe('device list and doctor run the approver-dir check as an administrator (win32 serviceProbe)', () => {
  it('device list does not treat a truly-writable dir as untrusted when told platform: win32', async () => {
    const n = node();
    const a = createFakePhone({ name: 'Owner phone' });
    fs.writeFileSync(path.join(n.configDir, 'approvers', `${a.deviceId}.json`), JSON.stringify(a.approverRecord()), { mode: 0o644 });
    // Sanity: without serviceProbe: false, a directory this process can
    // really write to reports untrusted on win32 — proving the assertion
    // below is not vacuous.
    assert.notEqual(checkApproverDir({ dir: path.join(n.configDir, 'approvers'), platform: 'win32' }), null);

    const io = streamIo();
    const win32Deps = { ...deps, storeOptions: { ...storeOptions, platform: 'win32' } };
    assert.equal(await runDevice({ sub: 'list', ...n, io, deps: win32Deps }), 0);
    assert.doesNotMatch(io.text.err, /writable by the account running the service/);
    assert.match(io.text.out, new RegExp(a.deviceId));
  });

  it('doctor does not treat a truly-writable dir as untrusted on win32 either', () => {
    const n = node();
    const results = runDoctor({ dataDir: n.dataDir, platform: 'win32' });
    const check = results.find((r) => r.check === 'approvers dir is writable only by an administrator');
    assert.ok(check);
    assert.equal(check.ok, true);
  });
});

describe('doctor', () => {
  it('counts a real approver as active, not permanently untrusted', () => {
    const n = node();
    const a = createFakePhone({ name: 'Owner phone' });
    fs.writeFileSync(path.join(n.configDir, 'approvers', `${a.deviceId}.json`), JSON.stringify(a.approverRecord()), { mode: 0o644 });
    const results = runDoctor({ dataDir: n.dataDir, platform: 'win32' });
    const check = results.find((r) => r.check === 'active phone approvers');
    assert.equal(check.detail, '1');
  });

  it('reports the approver dir, the relay link and the audit chain', async () => {
    const n = node();
    const ledger = new AuditLedger({ dir: path.join(n.dataDir, 'audit'), nodeId: 'kl-aaaaaaaaaaaaaaaa' });
    await ledger.append({ kind: 'x', data: { i: 1 } });
    await ledger.append({ kind: 'x', data: { i: 2 } });
    const byCheck = (results) => Object.fromEntries(results.map((r) => [r.check, r]));
    let results = byCheck(runDoctor({ dataDir: n.dataDir, platform: 'linux' }));
    assert.equal(results['audit ledger chain'].ok, true);
    // On POSIX this test's node.yaml is not root-owned, so the check fails
    // there and says why; on Windows the link.json above is what it reads.
    if (!POSIX) assert.equal(results['relay paired and linked'].ok, true);
    assert.ok(results['relay paired and linked'].detail);
    assert.ok(results['approvers dir is writable only by an administrator']);
    const seg = fs.readdirSync(path.join(n.dataDir, 'audit')).find((f) => f.endsWith('.jsonl'));
    const file = path.join(n.dataDir, 'audit', seg);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"i":2', '"i":3'));
    results = byCheck(runDoctor({ dataDir: n.dataDir, platform: 'linux' }));
    assert.equal(results['audit ledger chain'].ok, false);
    assert.match(results['audit ledger chain'].detail, /broken at seq 2/);
  });
});
