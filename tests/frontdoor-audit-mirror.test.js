// tests/frontdoor-audit-mirror.test.js — fleet stage 4 §3.12.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AuditMirror } = require('../src/frontdoor/audit/mirror');
const { AuditLedger, verifyAuditSlice, entryHash } = require('../src/audit/audit-ledger');
const { seal, nodeSigner } = require('../src/approvals/envelope');
const { testNodeIdentity } = require('./helpers/fake-phone');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mirror-')); temps.push(d); return d; };

const NODE = testNodeIdentity({ nodeName: 'gpu-box' });
const SPKI = NODE.publicKey.toString('hex');

function kit({ retentionDays = null, now = () => Date.now() } = {}) {
  const raised = [];
  const alerts = { raise: (kind, opts) => { raised.push([kind, opts.subject]); return {}; } };
  const mirror = new AuditMirror({ dir: path.join(tmp(), 'mirror'), alerts, retentionDays, now });
  return { mirror, raised };
}

function nodeLedger({ now = () => Date.now() } = {}) {
  const ledger = new AuditLedger({ dir: tmp(), identity: NODE, nodeId: NODE.nodeId, now });
  const fetched = [];
  const fetchSlice = async (params) => {
    const envelope = ledger.slice(params);
    fetched.push({ params, envelope });
    return envelope;
  };
  return { ledger, fetched, fetchSlice, add: async (n, kind = 'test.event') => { for (let i = 0; i < n; i += 1) await ledger.append({ kind, data: { i } }); } };
}

describe('AuditMirror', () => {
  it('ingests and verifies from seq 1 (prev: null), then appends what follows its head', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(5);
    assert.equal(await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'append');
    assert.equal(n.fetched[0].params.after, null);
    assert.equal(mirror.cursor(NODE.nodeId).seq, 5);
    await n.add(3);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    assert.equal(n.fetched.at(-1).params.after, n.ledger.tail(4)[0].hash);
    assert.deepEqual(mirror.status(NODE.nodeId), { head_seq: 8, anchor: { seq: 1, prev: null }, gaps: [], breaks: [] });
    assert.equal(mirror.audit(NODE.nodeId), 'ok');
    assert.deepEqual(raised, []);
  });

  it('pages until the node head, bounded by the page limit', async () => {
    const { mirror } = kit();
    mirror.pageLimit = 2;
    const n = nodeLedger();
    await n.add(5);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    assert.equal(mirror.cursor(NODE.nodeId).seq, 5);
    assert.equal(n.fetched.length, 3);
  });

  it('a tampered entry is a chain break: alert, audit broken, head not moved', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(5);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    await n.add(3);
    const seg = fs.readdirSync(n.ledger.dir).find((f) => f.endsWith('.jsonl'));
    const file = path.join(n.ledger.dir, seg);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const i = lines.findIndex((l) => l && JSON.parse(l).seq === 7);
    const e = JSON.parse(lines[i]);
    e.data = { i: 'rewritten' };
    lines[i] = JSON.stringify(e);
    fs.writeFileSync(file, lines.join('\n'));
    assert.equal(await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'chain_break');
    assert.equal(mirror.cursor(NODE.nodeId).seq, 5);
    assert.equal(mirror.audit(NODE.nodeId), 'broken');
    assert.equal(mirror.breaks(NODE.nodeId)[0].reason, 'hash_mismatch');
    assert.deepEqual(raised, [['audit_chain_break', `node:${NODE.nodeId}`]]);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    assert.equal(mirror.breaks(NODE.nodeId).length, 1, 'the same break is recorded once');
  });

  it('a fork (the node no longer has the mirror head) starts a new segment from the node chain', async () => {
    const { mirror, raised } = kit();
    const original = nodeLedger();
    await original.add(5);
    await mirror.sync(NODE.nodeId, { fetchSlice: original.fetchSlice, spkiHex: SPKI });
    const rewritten = nodeLedger();
    await rewritten.add(6, 'other.event');
    assert.equal(await mirror.sync(NODE.nodeId, { fetchSlice: rewritten.fetchSlice, spkiHex: SPKI }), 'chain_break');
    assert.deepEqual(raised, [['audit_chain_break', `node:${NODE.nodeId}`]]);
    assert.equal(mirror.audit(NODE.nodeId), 'broken');
    assert.deepEqual(mirror.cursor(NODE.nodeId), { seq: 6, hash: rewritten.ledger.tail(1)[0].hash });
    assert.equal(mirror.breaks(NODE.nodeId)[0].reason, 'fork');
    assert.equal(mirror.breaks(NODE.nodeId)[0].mirror_head.seq, 5);
  });

  it('first sync from a node that already pruned: anchor, a pruned_before record, no alert', async () => {
    let now = Date.parse('2026-01-15T00:00:00.000Z');
    const n = nodeLedger({ now: () => now });
    await n.add(3);
    now = Date.parse('2026-03-15T00:00:00.000Z');
    await n.add(2);
    n.ledger.retentionDays = 30;
    n.ledger.prune(now);
    const { mirror, raised } = kit();
    assert.equal(await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'anchor');
    const s = mirror.status(NODE.nodeId);
    assert.deepEqual(s.anchor, { seq: 4, prev: n.ledger.tail(2)[0].prev });
    assert.deepEqual(s.gaps.map((g) => [g.kind, g.from_seq, g.to_seq]), [['pruned_before', 1, 3]]);
    assert.equal(s.head_seq, 5);
    assert.deepEqual(raised, []);
    assert.equal(mirror.audit(NODE.nodeId), 'ok');
  });

  it('a later prune past the mirror head is a gap, with an alert', async () => {
    let now = Date.parse('2026-01-15T00:00:00.000Z');
    const n = nodeLedger({ now: () => now });
    await n.add(3);
    const { mirror, raised } = kit();
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    now = Date.parse('2026-02-10T00:00:00.000Z');
    await n.add(2);
    now = Date.parse('2026-03-15T00:00:00.000Z');
    await n.add(2);
    n.ledger.retentionDays = 10;
    n.ledger.prune(now);
    assert.equal(await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'gap');
    assert.deepEqual(mirror.status(NODE.nodeId).gaps.map((g) => [g.kind, g.from_seq, g.to_seq]), [['gap', 4, 5]]);
    assert.equal(mirror.cursor(NODE.nodeId).seq, 7);
    assert.equal(mirror.audit(NODE.nodeId), 'gap');
    assert.deepEqual(raised, [['audit_gap', `node:${NODE.nodeId}`]]);
  });

  it('offline history serves the stored node-signed envelope, which still verifies', async () => {
    const { mirror } = kit();
    mirror.pageLimit = 3;
    const n = nodeLedger();
    await n.add(7);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const env = mirror.history(NODE.nodeId, { before_seq: 5 });
    assert.deepEqual(env, n.fetched[1].envelope, 'the slice holding seq 4..6, byte for byte');
    assert.equal(verifyAuditSlice(env, SPKI).ok, true);
    assert.deepEqual(mirror.history(NODE.nodeId, {}), n.fetched.at(-1).envelope);
    assert.equal(mirror.history('kl-aaaaaaaaaaaaaaaa', {}), null);
  });

  it('a slice with a bad signature is refused and changes nothing', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(2);
    const other = testNodeIdentity({ nodeName: 'x' });
    const r = mirror.ingestSlice(NODE.nodeId, n.ledger.slice({ after: null }), other.publicKey.toString('hex'));
    assert.deepEqual(r, { outcome: 'invalid', more: false });
    assert.equal(mirror.cursor(NODE.nodeId), null);
    assert.deepEqual(raised, []);
  });

  it('retention: unlimited keeps every slice; retention_days drops old ones but never the newest', async () => {
    let now = Date.parse('2026-05-01T00:00:00.000Z');
    const n = nodeLedger();
    await n.add(2);
    const keepAll = kit({ now: () => now });
    const limited = kit({ retentionDays: 30, now: () => now });
    for (const k of [keepAll, limited]) await k.mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    now += 31 * 86400000;
    await n.add(2);
    for (const k of [keepAll, limited]) await k.mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const count = (k) => fs.readFileSync(path.join(k.mirror.dir, NODE.nodeId, 'slices.jsonl'), 'utf8').trim().split('\n').length;
    assert.equal(count(keepAll), 2);
    assert.equal(count(limited), 1);
    assert.equal(limited.mirror.cursor(NODE.nodeId).seq, 4);
  });
  // --- hardening (carries) ---------------------------------------------

  const count = (mirror) => {
    const f = path.join(mirror.dir, NODE.nodeId, 'slices.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
  };
  const stateFile = (mirror) => path.join(mirror.dir, NODE.nodeId, 'state.json');
  const entry = (seq, prev, kind = 'test.event') => {
    const base = { v: 1, seq, at: '2026-05-01T00:00:00.000Z', node_id: NODE.nodeId, writer: 'service', kind, data: {}, prev };
    return { ...base, hash: entryHash(base) };
  };
  // A slice the node really signed, over entries we choose.
  const signedSlice = (entries, head) => seal({
    v: 1, type: 'kl.audit.slice', node_id: NODE.nodeId, entries,
    head, anchor: { seq: 1, prev: null }, created_at: '2026-05-01T00:00:00.000Z'
  }, nodeSigner(NODE));

  it('refuses a malformed node id in every public method before touching a path', async () => {
    const { mirror } = kit();
    const n = nodeLedger();
    await n.add(1);
    for (const bad of ['../escape', 'kl-aaaaaaaaaaaaaaaa/../x', '__proto__', '', null]) {
      for (const call of [
        () => mirror.cursor(bad), () => mirror.breaks(bad), () => mirror.audit(bad), () => mirror.status(bad), () => mirror.prune(bad),
        () => mirror.ingestSlice(bad, n.ledger.slice({ after: null }), SPKI)
      ]) assert.throws(call, { code: 'bad_node' });
      await assert.rejects(mirror.sync(bad, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), { code: 'bad_node' });
      assert.equal(mirror.history(bad, {}), null);
    }
    assert.equal(n.fetched.length, 0);
    assert.equal(fs.existsSync(mirror.dir), false, 'nothing was written');
  });

  it('a signed slice whose own chain is broken is a chain break; the head does not move', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(2);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const head = mirror.cursor(NODE.nodeId);
    // seq 3 continues the head; seq 4 does not continue seq 3.
    const e3 = entry(3, head.hash);
    const e4 = entry(4, head.hash);
    const env = signedSlice([e3, e4], { seq: 4, hash: e4.hash });
    assert.deepEqual(mirror.ingestSlice(NODE.nodeId, env, SPKI), { outcome: 'chain_break', more: false });
    assert.deepEqual(mirror.cursor(NODE.nodeId), head);
    assert.equal(mirror.breaks(NODE.nodeId)[0].reason, 'broken_chain');
    assert.deepEqual(raised, [['audit_chain_break', `node:${NODE.nodeId}`]]);
    assert.equal(count(mirror), 1);
  });

  it("a signed slice with non-integer sequence numbers is refused by the mirror's own entry check", () => {
    const { mirror } = kit();
    // verifyAuditSlice accepts this chain (2.5 === 1.5 + 1); the mirror must not.
    const e1 = entry(1.5, null);
    const e2 = entry(2.5, e1.hash);
    const env = signedSlice([e1, e2], { seq: 3, hash: 'a'.repeat(64) });
    assert.equal(verifyAuditSlice(env, SPKI).ok, true);
    assert.equal(mirror.ingestSlice(NODE.nodeId, env, SPKI).outcome, 'chain_break');
    assert.equal(mirror.breaks(NODE.nodeId)[0].reason, 'malformed_entry');
    assert.equal(mirror.cursor(NODE.nodeId), null);
  });

  it('a node that truncates its whole ledger is a chain break, not "empty"', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(3);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    for (const f of fs.readdirSync(n.ledger.dir)) fs.rmSync(path.join(n.ledger.dir, f));
    assert.equal(await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'chain_break');
    assert.equal(mirror.breaks(NODE.nodeId)[0].reason, 'truncated');
    assert.equal(mirror.cursor(NODE.nodeId).seq, 3);
    assert.deepEqual(raised, [['audit_chain_break', `node:${NODE.nodeId}`]]);
  });

  it('refuses pages over pageBytes or pageLimit without changing anything', async () => {
    const small = new AuditMirror({ dir: path.join(tmp(), 'mirror'), pageBytes: 1024 });
    const n = nodeLedger();
    await n.ledger.append({ kind: 'big', data: { blob: 'x'.repeat(4000) } });
    assert.deepEqual(small.ingestSlice(NODE.nodeId, n.ledger.slice({ after: null }), SPKI), { outcome: 'invalid', more: false });
    assert.equal(small.cursor(NODE.nodeId), null);
    assert.equal(fs.existsSync(small.dir), false);
    const { mirror } = kit();
    mirror.pageLimit = 2;
    const m = nodeLedger();
    await m.add(3);
    assert.deepEqual(mirror.ingestSlice(NODE.nodeId, m.ledger.slice({ after: null, limit: 3 }), SPKI), { outcome: 'invalid', more: false });
    assert.equal(mirror.cursor(NODE.nodeId), null);
    assert.equal(fs.existsSync(mirror.dir), false);
  });

  it('sync stops at maxPages and refuses a bad maxPages', async () => {
    const { mirror } = kit();
    mirror.pageLimit = 1;
    const n = nodeLedger();
    await n.add(5);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI, maxPages: 2 });
    assert.equal(n.fetched.length, 2);
    assert.equal(mirror.cursor(NODE.nodeId).seq, 2);
    for (const maxPages of [0, -1, 1.5, Infinity, 'x']) {
      await assert.rejects(mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI, maxPages }), { code: 'bad_request' });
    }
  });

  it('two overlapping syncs of one node do not see each other as a fork', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(4);
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = async (params) => { await gate; return n.fetchSlice(params); };
    const a = mirror.sync(NODE.nodeId, { fetchSlice: slow, spkiHex: SPKI });
    const b = mirror.sync(NODE.nodeId, { fetchSlice: slow, spkiHex: SPKI });
    release();
    assert.deepEqual(await Promise.all([a, b]), ['append', 'empty']);
    assert.equal(mirror.audit(NODE.nodeId), 'ok');
    assert.equal(count(mirror), 1);
    assert.deepEqual(raised, []);
  });

  it('a failed state save never advances the head, and the retry does not double-append', async () => {
    const { mirror } = kit();
    const n = nodeLedger();
    await n.add(3);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const before = fs.readFileSync(stateFile(mirror), 'utf8');
    await n.add(2);
    mirror._writeState = () => { throw new Error('disk full'); };
    await assert.rejects(mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), /disk full/);
    assert.equal(mirror.cursor(NODE.nodeId).seq, 3, 'head not advanced');
    assert.equal(fs.readFileSync(stateFile(mirror), 'utf8'), before);
    assert.equal(count(mirror), 2, 'the slice record was appended before the save failed');
    delete mirror._writeState;
    assert.equal(await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'append');
    assert.equal(mirror.cursor(NODE.nodeId).seq, 5);
    assert.equal(count(mirror), 2, 'the unacknowledged record was reused, not appended again');
    assert.equal(mirror.audit(NODE.nodeId), 'ok');
  });

  it('a failed slice append leaves state untouched, and the retry appends once', async () => {
    const { mirror } = kit();
    const n = nodeLedger();
    await n.add(3);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const before = fs.readFileSync(stateFile(mirror), 'utf8');
    await n.add(2);
    mirror._appendRecord = () => { throw new Error('EIO'); };
    await assert.rejects(mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), /EIO/);
    assert.equal(mirror.cursor(NODE.nodeId).seq, 3);
    assert.equal(fs.readFileSync(stateFile(mirror), 'utf8'), before);
    assert.equal(count(mirror), 1);
    delete mirror._appendRecord;
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    assert.equal(mirror.cursor(NODE.nodeId).seq, 5);
    assert.equal(count(mirror), 2);
  });

  it('a first sync whose save fails is not mistaken for a deleted state after a restart', async () => {
    const { mirror } = kit();
    const n = nodeLedger();
    await n.add(2);
    let writes = 0;
    mirror._writeState = function (...args) {
      writes += 1;
      if (writes > 1) throw new Error('disk full');
      return AuditMirror.prototype._writeState.apply(this, args);
    };
    await assert.rejects(mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), /disk full/);
    const restarted = new AuditMirror({ dir: mirror.dir });
    assert.equal(restarted.audit(NODE.nodeId), 'ok', 'state.json existed before the first slice record');
    assert.equal(await restarted.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'append');
    assert.equal(restarted.cursor(NODE.nodeId).seq, 2);
    assert.equal(count(restarted), 1);
  });

  it('after a failed save and a restart, a longer retry drops the stale tail and a torn line', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(3);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    await n.add(2);
    mirror._writeState = () => { throw new Error('disk full'); };
    await assert.rejects(mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }));
    fs.appendFileSync(path.join(mirror.dir, NODE.nodeId, 'slices.jsonl'), '{"received_at":"2026-');
    await n.add(2);
    const restarted = new AuditMirror({ dir: mirror.dir, alerts: { raise: (k, o) => raised.push([k, o.subject]) } });
    assert.equal(await restarted.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'append');
    assert.equal(restarted.cursor(NODE.nodeId).seq, 7);
    const lines = fs.readFileSync(path.join(mirror.dir, NODE.nodeId, 'slices.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((r) => [r.first_seq, r.last_seq]), [[1, 3], [4, 7]]);
    assert.equal(restarted.audit(NODE.nodeId), 'ok');
    assert.deepEqual(raised, []);
  });

  it('raises the gap and fork alerts even when the step after them fails', async () => {
    let now = Date.parse('2026-01-15T00:00:00.000Z');
    const n = nodeLedger({ now: () => now });
    await n.add(3);
    const { mirror, raised } = kit();
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    now = Date.parse('2026-02-10T00:00:00.000Z');
    await n.add(2);
    now = Date.parse('2026-03-15T00:00:00.000Z');
    await n.add(2);
    n.ledger.retentionDays = 10;
    n.ledger.prune(now);
    mirror._appendRecord = () => { throw new Error('EIO'); };
    await assert.rejects(mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }));
    assert.deepEqual(raised, [['audit_gap', `node:${NODE.nodeId}`]]);
    assert.equal(mirror.cursor(NODE.nodeId).seq, 3, 'nothing committed');

    const fork = kit();
    const original = nodeLedger();
    await original.add(2);
    await fork.mirror.sync(NODE.nodeId, { fetchSlice: original.fetchSlice, spkiHex: SPKI });
    const rewritten = nodeLedger();
    await rewritten.add(3);
    fork.mirror._writeState = () => { throw new Error('disk full'); };
    await assert.rejects(fork.mirror.sync(NODE.nodeId, { fetchSlice: rewritten.fetchSlice, spkiHex: SPKI }));
    assert.deepEqual(fork.raised, [['audit_chain_break', `node:${NODE.nodeId}`]]);
    assert.equal(fork.mirror.cursor(NODE.nodeId).seq, 2);
  });

  it('prune keeps the slice holding the head even when a newer unacknowledged slice exists', async () => {
    let now = Date.parse('2026-05-01T00:00:00.000Z');
    const n = nodeLedger();
    await n.add(2);
    const { mirror } = kit({ retentionDays: 30, now: () => now });
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    now += 31 * 86400000;
    await n.add(2);
    mirror._writeState = () => { throw new Error('disk full'); };
    await assert.rejects(mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }));
    delete mirror._writeState;
    now += 31 * 86400000; // both stored slices are now past retention
    assert.equal(mirror.prune(NODE.nodeId), 0, 'one holds the head, the other is the newest');
    assert.equal(count(mirror), 2);
  });

  it('a torn last line is dropped before the next record is appended', async () => {
    const { mirror } = kit();
    const n = nodeLedger();
    await n.add(2);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    fs.appendFileSync(path.join(mirror.dir, NODE.nodeId, 'slices.jsonl'), '{"received_at":"2026-');
    await n.add(2);
    const restarted = new AuditMirror({ dir: mirror.dir });
    assert.equal(await restarted.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'append');
    const lines = fs.readFileSync(path.join(mirror.dir, NODE.nodeId, 'slices.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((r) => [r.first_seq, r.last_seq]), [[1, 2], [3, 4]]);
  });

  it('an empty slice whose head is past the mirror head (withheld entries) is refused', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(2);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const env = signedSlice([], { seq: 9, hash: 'b'.repeat(64) });
    assert.deepEqual(mirror.ingestSlice(NODE.nodeId, env, SPKI), { outcome: 'invalid', more: false });
    assert.equal(mirror.cursor(NODE.nodeId).seq, 2);
    assert.equal(mirror.audit(NODE.nodeId), 'ok');
    assert.deepEqual(raised, []);
  });

  describe('an untrusted state.json', () => {
    async function synced() {
      const { mirror } = kit();
      const n = nodeLedger();
      await n.add(5);
      await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
      return mirror.dir;
    }
    function reopen(dir) {
      const raised = [];
      const mirror = new AuditMirror({ dir, alerts: { raise: (k, o) => { raised.push([k, o.subject, o.detail.reason]); return {}; } } });
      return { mirror, raised };
    }
    const rewrite = (f, edit) => { const s = JSON.parse(fs.readFileSync(f, 'utf8')); edit(s); fs.writeFileSync(f, JSON.stringify(s)); };
    const cases = {
      'is garbage': (f) => fs.writeFileSync(f, '{not json'),
      'is deleted while slices remain': (f) => fs.rmSync(f),
      'claims ok despite a recorded break': (f) => rewrite(f, (s) => { s.breaks = [{ seq: 1, reason: 'fork', mirror_head: null, at: '2026-05-01T00:00:00.000Z' }]; }),
      'carries a __proto__ key': (f) => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('{', '{"__proto__":{"polluted":true},')),
      'has a head that is not a hash': (f) => rewrite(f, (s) => { s.head.hash = '../../x'; })
    };
    for (const [name, corrupt] of Object.entries(cases)) {
      it(`${name}: quarantined, broken, alerted, never reset to no history`, async () => {
        const dir = await synced();
        const file = path.join(dir, NODE.nodeId, 'state.json');
        corrupt(file);
        const { mirror, raised } = reopen(dir);
        assert.equal(mirror.audit(NODE.nodeId), 'broken');
        assert.equal({}.polluted, undefined);
        assert.deepEqual(raised, [['audit_chain_break', `node:${NODE.nodeId}`, 'mirror_state_corrupt']]);
        assert.equal(mirror.breaks(NODE.nodeId)[0].reason, 'state_corrupt');
        assert.equal(mirror.cursor(NODE.nodeId).seq, 5, 'head recovered from the stored slices');
        const again = reopen(dir);
        assert.equal(again.mirror.audit(NODE.nodeId), 'broken');
        assert.deepEqual(again.raised, [], 'the quarantined state was saved, so a restart loads it rather than re-quarantining');
        if (name !== 'is deleted while slices remain') {
          assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('state.json.corrupt-')), 'the bad file is kept aside');
        }
        // A forged history from seq 1 is a fork against the recovered head, not a clean anchor.
        const forged = nodeLedger();
        await forged.add(2, 'forged');
        assert.equal(await mirror.sync(NODE.nodeId, { fetchSlice: forged.fetchSlice, spkiHex: SPKI }), 'chain_break');
        assert.equal(mirror.audit(NODE.nodeId), 'broken');
        // The quarantined state was saved: a restart is still broken.
        assert.equal(reopen(dir).mirror.audit(NODE.nodeId), 'broken');
      });
    }
  });
});
