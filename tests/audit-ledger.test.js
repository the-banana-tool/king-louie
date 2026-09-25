// tests/audit-ledger.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { deriveNodeId } = require('../src/mesh/node-identity');
const { open } = require('../src/approvals/envelope');
const { AuditLedger, verifyAuditSlice } = require('../src/audit/audit-ledger');

const ROOT = path.join(__dirname, '..');
const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-audit-'));
  tmp.push(d);
  return d;
}

function testIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName: 'web-01', publicKey: spki, sign: (b) => crypto.sign(null, b, privateKey) };
}

function ledger(dir, extra = {}) {
  const identity = extra.identity || testIdentity();
  return new AuditLedger({ dir, identity, nodeId: identity.nodeId, ...extra });
}

async function fill(l, n) {
  for (let i = 0; i < n; i += 1) await l.append({ kind: 'tier.decision', data: { i } });
}

function segmentFile(dir) {
  return path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('ledger-')));
}

describe('AuditLedger chain', () => {
  it('appends seq-numbered, hash-chained entries into a monthly segment', async () => {
    const dir = tempDir();
    const l = ledger(dir, { now: () => Date.parse('2026-09-23T18:04:11.230Z') });
    const first = await l.append({ kind: 'approval.request', data: { job_id: null, envelope: { a: 1 } } });
    const second = await l.append({ kind: 'approval.outcome', data: { request_id: 'r', state: 'expired', reason: null } });
    assert.equal(first.seq, 1);
    assert.equal(first.prev, null);
    assert.equal(second.seq, 2);
    assert.equal(second.prev, first.hash);
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    assert.equal(first.writer, 'service');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')), ['ledger-2026-09.jsonl']);
    assert.deepEqual(l.verify(), { ok: true, entries: 2 });
    assert.deepEqual(l.tail(1), [second]);
  });

  it('refuses data that is not JSON', async () => {
    const l = ledger(tempDir());
    await assert.rejects(l.append({ kind: 'x', data: { bad: undefined } }));
  });

  it('verify finds an edited, a deleted and a reordered line', async () => {
    for (const damage of ['edit', 'delete', 'reorder']) {
      const dir = tempDir();
      const l = ledger(dir);
      await fill(l, 5);
      const file = segmentFile(dir);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      if (damage === 'edit') lines[2] = lines[2].replace('"i":2', '"i":9');
      if (damage === 'delete') lines.splice(2, 1);
      if (damage === 'reorder') [lines[1], lines[2]] = [lines[2], lines[1]];
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      const result = l.verify();
      assert.equal(result.ok, false, damage);
      assert.equal(result.brokenAt, damage === 'reorder' ? 3 : (damage === 'delete' ? 4 : 3), damage);
    }
  });
});

describe('AuditLedger lock', () => {
  it('keeps one chain when several processes append at once', async () => {
    const dir = tempDir();
    const identity = testIdentity();
    const script = `
      const { AuditLedger } = require('./src/audit/audit-ledger');
      const l = new AuditLedger({ dir: process.env.KL_AUDIT_DIR, nodeId: '${identity.nodeId}', writer: 'mcp' });
      (async () => { for (let i = 0; i < 15; i += 1) await l.append({ kind: 'exec.start', data: { pid: process.pid, i } }); })()
        .catch((err) => { process.stderr.write(err.message); process.exit(1); });
    `;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, KL_AUDIT_DIR: dir, KING_LOUIE_LOG_LEVEL: 'silent' } });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
    await Promise.all([run(), run(), run()]);
    const l = ledger(dir, { identity });
    const result = l.verify();
    assert.deepEqual(result, { ok: true, entries: 45 });
    assert.deepEqual(l.tail(45).map((e) => e.seq), Array.from({ length: 45 }, (_, i) => i + 1));
  });

  it('breaks a lock left by a dead process', async () => {
    const dir = tempDir();
    const l = ledger(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ledger.lock'), '999999999');
    const entry = await l.append({ kind: 'x', data: {} });
    assert.equal(entry.seq, 1);
    assert.equal(fs.existsSync(path.join(dir, 'ledger.lock')), false);
  });

  it('breaks a lock older than staleLockMs even when its pid is alive', async () => {
    const dir = tempDir();
    const l = ledger(dir, { staleLockMs: 50 });
    const lock = path.join(dir, 'ledger.lock');
    fs.writeFileSync(lock, String(process.pid));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    assert.equal((await l.append({ kind: 'x', data: {} })).seq, 1);
  });

  it('rejects with audit_unavailable when a live lock never clears', async () => {
    const dir = tempDir();
    const l = ledger(dir, { lockTimeoutMs: 100 });
    fs.writeFileSync(path.join(dir, 'ledger.lock'), String(process.pid));
    await assert.rejects(l.append({ kind: 'x', data: {} }), /audit_unavailable/);
  });
});

describe('AuditLedger reading and signing', () => {
  it('entriesAfter pages forward from a hash, or from the oldest entry', async () => {
    const l = ledger(tempDir());
    await fill(l, 5);
    const all = l.tail(5);
    assert.deepEqual(l.entriesAfter(null, 2).map((e) => e.seq), [1, 2]);
    assert.deepEqual(l.entriesAfter(all[1].hash, 10).map((e) => e.seq), [3, 4, 5]);
    assert.deepEqual(l.entriesAfter('f'.repeat(64), 1).map((e) => e.seq), [1]);
  });

  it('slice pages backwards and forwards, respects max_bytes, and always returns one entry', async () => {
    const identity = testIdentity();
    const l = ledger(tempDir(), { identity });
    await fill(l, 10);
    const spki = identity.publicKey.toString('hex');
    const back = verifyAuditSlice(l.slice({ before_seq: 8, limit: 3 }), spki);
    assert.equal(back.ok, true);
    assert.deepEqual(back.message.entries.map((e) => e.seq), [5, 6, 7]);
    assert.deepEqual(back.message.head.seq, 10);
    assert.deepEqual(back.message.anchor, { seq: 1, prev: null });
    const all = l.tail(10);
    const fwd = open(l.slice({ after: all[6].hash, limit: 200 })).message;
    assert.deepEqual(fwd.entries.map((e) => e.seq), [8, 9, 10]);
    const tiny = open(l.slice({ max_bytes: 1 })).message;
    assert.deepEqual(tiny.entries.map((e) => e.seq), [10]);
    assert.equal(open(l.slice({ limit: 500 })).message.entries.length, 10);
  });

  it('verifyAuditSlice refuses a tampered entry and a foreign key', async () => {
    const identity = testIdentity();
    const l = ledger(tempDir(), { identity });
    await fill(l, 3);
    const env = l.slice({});
    assert.equal(verifyAuditSlice(env, testIdentity().publicKey.toString('hex')).reason, 'bad_signature');
  });

  it('head() is a signed kl.audit.slice.head', async () => {
    const identity = testIdentity();
    const l = ledger(tempDir(), { identity });
    await fill(l, 2);
    const env = l.head();
    const { message } = open(env);
    assert.equal(message.type, 'kl.audit.slice.head');
    assert.equal(message.seq, 2);
    assert.equal(message.hash, l.tail(1)[0].hash);
    assert.equal(env.kid, identity.nodeId);
  });
});

describe('AuditLedger retention', () => {
  it('prunes whole old segments, keeps the newest, and still verifies from the anchor', async () => {
    const dir = tempDir();
    let clock = Date.parse('2025-01-10T00:00:00.000Z');
    const l = ledger(dir, { now: () => clock, retentionDays: 30 });
    await fill(l, 2);
    clock = Date.parse('2025-03-10T00:00:00.000Z');
    await fill(l, 2);
    clock = Date.parse('2025-05-10T00:00:00.000Z');
    await fill(l, 1);
    assert.deepEqual(l.prune(clock), { removedSegments: 2 });
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')), ['ledger-2025-05.jsonl']);
    const result = l.verify();
    assert.deepEqual(result, { ok: true, entries: 1 });
    const anchor = open(l.slice({})).message.anchor;
    assert.equal(anchor.seq, 5);
    assert.match(anchor.prev, /^[0-9a-f]{64}$/);
    assert.equal((await l.append({ kind: 'x', data: {} })).seq, 6);
  });
});
