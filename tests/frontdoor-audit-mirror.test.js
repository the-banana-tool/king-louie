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

function kit({ retentionDays = null, now = () => Date.now(), pageLimit = 200 } = {}) {
  const raised = [];
  const alerts = { raise: (kind, opts) => { raised.push([kind, opts.subject]); return {}; } };
  const mirror = new AuditMirror({ dir: path.join(tmp(), 'mirror'), alerts, retentionDays, now, pageLimit });
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
    const { mirror } = kit({ pageLimit: 2 });
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
    const { mirror } = kit({ pageLimit: 3 });
    const n = nodeLedger();
    await n.add(7);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const h = mirror.history(NODE.nodeId, { before_seq: 5 });
    assert.deepEqual(h, { segment: 0, envelope: n.fetched[1].envelope }, 'the slice holding seq 4..6, byte for byte');
    assert.equal(verifyAuditSlice(h.envelope, SPKI).ok, true);
    assert.deepEqual(mirror.history(NODE.nodeId, {}), { segment: 0, envelope: n.fetched.at(-1).envelope });
    assert.equal(mirror.history('kl-aaaaaaaaaaaaaaaa', {}), null);
  });

  it('a slice with a bad signature is refused and changes nothing', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(2);
    const other = testNodeIdentity({ nodeName: 'x' });
    const r = await mirror.ingestSlice(NODE.nodeId, n.ledger.slice({ after: null }), other.publicKey.toString('hex'));
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
  const signedSlice = (entries, head, anchor = { seq: 1, prev: null }) => seal({
    v: 1, type: 'kl.audit.slice', node_id: NODE.nodeId, entries,
    head, anchor, created_at: '2026-05-01T00:00:00.000Z'
  }, nodeSigner(NODE));
  // A node chain c[1..n] (index = seq), hashed and linked like F3's ledger.
  const chain = (n, kind = 'test.event') => {
    const c = [null];
    for (let i = 1; i <= n; i += 1) c.push(entry(i, i === 1 ? null : c[i - 1].hash, kind));
    return c;
  };
  // Seqs a..b of chain c, signed as a node whose oldest retained entry is `oldest`.
  const page = (c, a, b, { headSeq = c.length - 1, oldest = a } = {}) => signedSlice(
    c.slice(a, b + 1), { seq: headSeq, hash: c[headSeq].hash }, { seq: oldest, prev: c[oldest].prev });

  it('refuses a malformed node id in every public method before touching a path', async () => {
    const { mirror } = kit();
    const n = nodeLedger();
    await n.add(1);
    for (const bad of ['../escape', 'kl-aaaaaaaaaaaaaaaa/../x', '__proto__', '', null]) {
      for (const call of [
        () => mirror.cursor(bad), () => mirror.breaks(bad), () => mirror.audit(bad), () => mirror.status(bad), () => mirror.prune(bad)
      ]) assert.throws(call, { code: 'bad_node' });
      await assert.rejects(mirror.ingestSlice(bad, n.ledger.slice({ after: null }), SPKI), { code: 'bad_node' });
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
    assert.deepEqual(await mirror.ingestSlice(NODE.nodeId, env, SPKI), { outcome: 'chain_break', more: false });
    assert.deepEqual(mirror.cursor(NODE.nodeId), head);
    assert.equal(mirror.breaks(NODE.nodeId)[0].reason, 'broken_chain');
    assert.deepEqual(raised, [['audit_chain_break', `node:${NODE.nodeId}`]]);
    assert.equal(count(mirror), 1);
  });

  it("a signed slice with non-integer sequence numbers is refused by the mirror's own entry check", async () => {
    const { mirror } = kit();
    // verifyAuditSlice accepts this chain (2.5 === 1.5 + 1); the mirror must not.
    const e1 = entry(1.5, null);
    const e2 = entry(2.5, e1.hash);
    const env = signedSlice([e1, e2], { seq: 3, hash: 'a'.repeat(64) });
    assert.equal(verifyAuditSlice(env, SPKI).ok, true);
    assert.equal((await mirror.ingestSlice(NODE.nodeId, env, SPKI)).outcome, 'chain_break');
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

  it('refuses pages over pageBytes or pageLimit; a signed one is a break, alerted once, head not moved', async () => {
    const raised = [];
    const alerts = { raise: (kind, opts) => { raised.push([kind, opts.detail.reason]); return {}; } };
    const small = new AuditMirror({ dir: path.join(tmp(), 'mirror'), pageBytes: 1024, alerts });
    const n = nodeLedger();
    await n.ledger.append({ kind: 'big', data: { blob: 'x'.repeat(4000) } });
    const big = n.ledger.slice({ after: null });
    assert.deepEqual(await small.ingestSlice(NODE.nodeId, big, SPKI), { outcome: 'invalid', more: false });
    assert.deepEqual(await small.ingestSlice(NODE.nodeId, big, SPKI), { outcome: 'invalid', more: false });
    assert.equal(small.cursor(NODE.nodeId), null);
    assert.equal(small.audit(NODE.nodeId), 'broken');
    assert.deepEqual(small.breaks(NODE.nodeId).map((b) => b.reason), ['oversize_entry']);
    assert.deepEqual(raised, [['audit_chain_break', 'oversize_entry']], 'alerted once, not on every sync');
    assert.deepEqual(new AuditMirror({ dir: small.dir, pageBytes: 1024 }).breaks(NODE.nodeId).map((b) => b.reason), ['oversize_entry'], 'persisted');
    // Not signed by the node: refused, and nothing recorded.
    const other = testNodeIdentity({ nodeName: 'x' });
    const quiet = new AuditMirror({ dir: path.join(tmp(), 'mirror'), pageBytes: 1024 });
    assert.deepEqual(await quiet.ingestSlice(NODE.nodeId, big, other.publicKey.toString('hex')), { outcome: 'invalid', more: false });
    assert.equal(fs.existsSync(quiet.dir), false);

    const { mirror, raised: r2 } = kit({ pageLimit: 2 });
    const m = nodeLedger();
    await m.add(3);
    assert.deepEqual(await mirror.ingestSlice(NODE.nodeId, m.ledger.slice({ after: null, limit: 3 }), SPKI), { outcome: 'invalid', more: false });
    assert.equal(mirror.cursor(NODE.nodeId), null);
    assert.equal(mirror.breaks(NODE.nodeId)[0].reason, 'oversize_page');
    assert.equal(r2.length, 1);
  });

  it('page caps cannot be changed after construction', () => {
    const { mirror } = kit({ pageLimit: 3 });
    assert.equal(Reflect.set(mirror, 'pageLimit', 999), false);
    assert.equal(Reflect.set(mirror, 'pageBytes', 1e9), false);
    assert.equal(mirror.pageLimit, 3);
    assert.equal(mirror.pageBytes, 262144);
  });

  it('sync stops at maxPages and refuses a bad maxPages', async () => {
    const { mirror } = kit({ pageLimit: 1 });
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
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }); // the segment's first slice
    now += 10 * 86400000;
    await n.add(2);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }); // holds the head
    now += 31 * 86400000;
    await n.add(2);
    mirror._writeState = () => { throw new Error('disk full'); };
    await assert.rejects(mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI }));
    delete mirror._writeState;
    now += 31 * 86400000; // every stored slice is now past retention
    assert.equal(mirror.prune(NODE.nodeId), 1, 'only the first (ordinary) slice goes');
    const kept = fs.readFileSync(path.join(mirror.dir, NODE.nodeId, 'slices.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(kept.map((r) => [r.first_seq, r.last_seq]), [[3, 4], [5, 6]], 'the head holder and the newest stay');
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

  it('an empty slice whose head is past the mirror head (withheld entries) is refused and recorded once', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(2);
    await mirror.sync(NODE.nodeId, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const env = signedSlice([], { seq: 9, hash: 'b'.repeat(64) });
    assert.deepEqual(await mirror.ingestSlice(NODE.nodeId, env, SPKI), { outcome: 'invalid', more: false });
    assert.deepEqual(await mirror.ingestSlice(NODE.nodeId, env, SPKI), { outcome: 'invalid', more: false });
    assert.equal(mirror.cursor(NODE.nodeId).seq, 2);
    assert.equal(mirror.audit(NODE.nodeId), 'broken');
    assert.deepEqual(mirror.breaks(NODE.nodeId).map((b) => b.reason), ['withheld_entries']);
    assert.deepEqual(raised, [['audit_chain_break', `node:${NODE.nodeId}`]]);
  });

  it('a signed slice naming another node is refused and recorded as wrong_node', async () => {
    const { mirror, raised } = kit();
    // Signed with this node's key, but claiming to be another node.
    const otherId = 'kl-aaaaaaaaaaaaaaaa';
    const base = { v: 1, seq: 1, at: '2026-05-01T00:00:00.000Z', node_id: otherId, writer: 'service', kind: 'k', data: {}, prev: null };
    const e1 = { ...base, hash: entryHash(base) };
    const env = seal({ v: 1, type: 'kl.audit.slice', node_id: otherId, entries: [e1], head: { seq: 1, hash: e1.hash }, anchor: { seq: 1, prev: null }, created_at: '2026-05-01T00:00:00.000Z' },
      { alg: 'Ed25519', kid: otherId, sign: (b) => NODE.sign(b) });
    assert.equal(verifyAuditSlice(env, SPKI).ok, true);
    assert.deepEqual(await mirror.ingestSlice(NODE.nodeId, env, SPKI), { outcome: 'invalid', more: false });
    assert.equal(mirror.breaks(NODE.nodeId)[0].reason, 'wrong_node');
    assert.equal(mirror.cursor(NODE.nodeId), null);
    assert.equal(raised.length, 1);
  });

  // --- fix round 1 -------------------------------------------------------

  const ID = NODE.nodeId;
  const DAY = 86400000;
  const records = (mirror) => fs.readFileSync(path.join(mirror.dir, ID, 'slices.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).map((r) => [r.segment, r.first_seq, r.last_seq]);
  const editState = (mirror, edit) => {
    const f = path.join(mirror.dir, ID, 'state.json');
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    edit(s);
    fs.writeFileSync(f, JSON.stringify(s));
  };

  it('T29-serial: a direct ingest while a sync waits on its fetch is queued behind it, with no false fork', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(4);
    let release;
    const gate = new Promise((r) => { release = r; });
    const order = [];
    const slow = async (params) => { await gate; return n.fetchSlice(params); };
    const syncing = mirror.sync(ID, { fetchSlice: slow, spkiHex: SPKI }).then((o) => { order.push('sync'); return o; });
    await new Promise((r) => setImmediate(r));
    const direct = mirror.ingestSlice(ID, n.ledger.slice({ after: null }), SPKI).then((r) => { order.push('ingest'); return r; });
    await new Promise((r) => setImmediate(r));
    release();
    assert.equal(await syncing, 'append');
    assert.deepEqual(await direct, { outcome: 'empty', more: false }, 'the same page again is nothing new');
    assert.deepEqual(order, ['sync', 'ingest']);
    assert.equal(mirror.audit(ID), 'ok');
    assert.equal(count(mirror), 1);
    assert.deepEqual(raised, []);
  });

  it('T29-withheld: a later page that skips entries its signed anchor says the node still has is withheld_entries, not a gap', async () => {
    const c = chain(10);
    const { mirror, raised } = kit();
    assert.equal((await mirror.ingestSlice(ID, page(c, 1, 3), SPKI)).outcome, 'append');
    // The node's anchor is seq 1 (it still has 4..7) but the page jumps to 8.
    assert.deepEqual(await mirror.ingestSlice(ID, page(c, 8, 10, { oldest: 1 }), SPKI), { outcome: 'invalid', more: false });
    // Anchor past the head, but the page does not start at it.
    assert.deepEqual(await mirror.ingestSlice(ID, page(c, 8, 10, { oldest: 6 }), SPKI), { outcome: 'invalid', more: false });
    assert.equal(mirror.cursor(ID).seq, 3);
    assert.deepEqual(mirror.status(ID).gaps, []);
    assert.deepEqual(mirror.breaks(ID).map((b) => [b.reason, b.seq]), [['withheld_entries', 8]]);
    assert.deepEqual(raised, [['audit_chain_break', `node:${ID}`]]);
    // An honest gap (the page starts at the signed anchor, past the head) is still a gap.
    assert.equal((await mirror.ingestSlice(ID, page(c, 8, 10, { oldest: 8 }), SPKI)).outcome, 'gap');
    assert.equal(mirror.cursor(ID).seq, 10);
  });

  it('T29-withheld: a first sync whose page starts above the signed anchor (anchor 1, entries 50..60) is not a prune anchor', async () => {
    const c = chain(60);
    const { mirror, raised } = kit();
    assert.deepEqual(await mirror.ingestSlice(ID, page(c, 50, 60, { oldest: 1 }), SPKI), { outcome: 'invalid', more: false });
    assert.equal(mirror.cursor(ID), null);
    assert.deepEqual(mirror.status(ID).gaps, []);
    assert.equal(mirror.breaks(ID)[0].reason, 'withheld_entries');
    assert.equal(raised.length, 1);
    // The honest version (the node really pruned 1..49) anchors without an alert.
    const honest = kit();
    assert.equal((await honest.mirror.ingestSlice(ID, page(c, 50, 60, { oldest: 50 }), SPKI)).outcome, 'anchor');
    assert.deepEqual(honest.raised, []);
  });

  it('retention keeps break evidence: 30 days, a fork on day 1, syncs on days 41 and 81', async () => {
    let now = Date.parse('2026-05-01T00:00:00.000Z');
    const { mirror } = kit({ retentionDays: 30, now: () => now });
    const a = chain(5);
    const b = chain(8, 'other.event');
    await mirror.ingestSlice(ID, page(a, 1, 3, { headSeq: 3 }), SPKI);
    now += DAY / 2;
    await mirror.ingestSlice(ID, page(a, 4, 5, { oldest: 1 }), SPKI); // holds the head the node will walk away from
    now = Date.parse('2026-05-02T00:00:00.000Z');
    assert.equal((await mirror.ingestSlice(ID, page(b, 1, 4, { headSeq: 4 }), SPKI)).outcome, 'chain_break');
    now += 40 * DAY;
    await mirror.ingestSlice(ID, page(b, 5, 6, { headSeq: 6, oldest: 1 }), SPKI);
    mirror.prune(ID);
    assert.deepEqual(records(mirror), [[0, 4, 5], [1, 1, 4], [1, 5, 6]]);
    now += 40 * DAY;
    await mirror.ingestSlice(ID, page(b, 7, 8, { oldest: 1 }), SPKI);
    assert.equal(mirror.prune(ID), 1);
    assert.deepEqual(records(mirror), [[0, 4, 5], [1, 1, 4], [1, 7, 8]],
      'the forked-from head and the start of the segment the fork opened survive; ordinary old slices still go');
  });

  it('retention keeps the slices either side of a gap', async () => {
    let now = Date.parse('2026-05-01T00:00:00.000Z');
    const { mirror } = kit({ retentionDays: 30, now: () => now });
    const c = chain(12);
    await mirror.ingestSlice(ID, page(c, 1, 3), SPKI);
    now += 5 * DAY;
    await mirror.ingestSlice(ID, page(c, 4, 5, { oldest: 1 }), SPKI);
    now += 55 * DAY;
    assert.equal((await mirror.ingestSlice(ID, page(c, 8, 9, { oldest: 8 }), SPKI)).outcome, 'gap');
    now += 5 * DAY;
    await mirror.ingestSlice(ID, page(c, 10, 10, { oldest: 8 }), SPKI);
    now += 35 * DAY;
    await mirror.ingestSlice(ID, page(c, 11, 12, { oldest: 8 }), SPKI);
    assert.equal(mirror.prune(ID), 2);
    assert.deepEqual(records(mirror), [[0, 4, 5], [0, 8, 9], [0, 11, 12]]);
  });

  it('the first break is never evicted by the cap', async () => {
    const { mirror } = kit();
    const n = nodeLedger();
    await n.add(2);
    await mirror.sync(ID, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const at = '2026-05-01T00:00:00.000Z';
    editState(mirror, (s) => {
      s.breaks = [{ seq: null, reason: 'first_one', mirror_head: null, at }];
      for (let i = 1; i < 1000; i += 1) s.breaks.push({ seq: i, reason: 'filler', mirror_head: null, at });
      s.status = 'broken';
    });
    const reopened = new AuditMirror({ dir: mirror.dir });
    const head = reopened.cursor(ID);
    const e3 = entry(3, head.hash);
    const e4 = entry(4, head.hash);
    assert.equal((await reopened.ingestSlice(ID, signedSlice([e3, e4], { seq: 4, hash: e4.hash }), SPKI)).outcome, 'chain_break');
    const breaks = reopened.breaks(ID);
    assert.equal(breaks.length, 1000);
    assert.equal(breaks[0].reason, 'first_one');
    assert.equal(breaks.at(-1).reason, 'broken_chain');
  });

  it('a replayed old page is a replay break (head and segment stay); a repeated page through the head appends only what is new', async () => {
    const { mirror, raised } = kit();
    const n = nodeLedger();
    await n.add(4);
    await mirror.sync(ID, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    assert.deepEqual(await mirror.ingestSlice(ID, n.ledger.slice({ after: null, limit: 2 }), SPKI), { outcome: 'chain_break', more: false });
    assert.deepEqual(mirror.breaks(ID).map((b) => [b.reason, b.seq]), [['replay', 2]]);
    assert.equal(mirror.cursor(ID).seq, 4);
    assert.equal(mirror.history(ID, {}).segment, 0, 'no new segment');
    assert.equal(raised.length, 1);
    await n.add(2);
    assert.deepEqual(await mirror.ingestSlice(ID, n.ledger.slice({ after: null }), SPKI), { outcome: 'append', more: false });
    assert.equal(mirror.cursor(ID).seq, 6);
    assert.equal(mirror.breaks(ID).length, 1);
  });

  it('a node that drops its newest entries (the rest match the mirror) is truncated, not a fork', async () => {
    const { mirror } = kit();
    const n = nodeLedger();
    await n.add(5);
    await mirror.sync(ID, { fetchSlice: n.fetchSlice, spkiHex: SPKI });
    const seg = fs.readdirSync(n.ledger.dir).find((f) => f.endsWith('.jsonl'));
    const file = path.join(n.ledger.dir, seg);
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').split('\n').slice(0, 3).join('\n')}\n`);
    assert.equal(await mirror.sync(ID, { fetchSlice: n.fetchSlice, spkiHex: SPKI }), 'chain_break');
    assert.deepEqual(mirror.breaks(ID).map((b) => [b.reason, b.seq]), [['truncated', 3]]);
    assert.equal(mirror.cursor(ID).seq, 5);
    assert.equal(mirror.history(ID, {}).segment, 0);
  });

  it('history prefers the current segment and says which segment it served', async () => {
    const { mirror } = kit();
    const a = chain(8);
    const b = chain(3, 'other.event');
    await mirror.ingestSlice(ID, page(a, 1, 8), SPKI);
    const forked = page(b, 1, 3);
    assert.equal((await mirror.ingestSlice(ID, forked, SPKI)).outcome, 'chain_break');
    assert.deepEqual(mirror.history(ID, { before_seq: 3 }), { segment: 1, envelope: forked });
    assert.deepEqual(mirror.history(ID, {}), { segment: 1, envelope: forked });
  });

  // --- fix round 2 -------------------------------------------------------

  // A node that answers audit.slice like F3's ledger over chain `node.chain`:
  // after a hash it holds, the entries that follow; otherwise from its oldest.
  const fakeNode = (c) => {
    const node = { chain: c, fetched: 0 };
    node.fetchSlice = async ({ limit, after }) => {
      node.fetched += 1;
      const cc = node.chain;
      const top = cc.length - 1;
      const i = after === null ? -1 : cc.findIndex((e, k) => k > 0 && e.hash === after);
      const start = i > 0 ? i + 1 : 1;
      if (start > top) return signedSlice([], { seq: top, hash: cc[top].hash }, { seq: 1, prev: null });
      return page(cc, start, Math.min(top, start + limit - 1), { oldest: 1 });
    };
    return node;
  };

  it('a fork past the first page (pageLimit 3) is a fork, not an endless replay', async () => {
    const a = chain(6);
    const b = [null, a[1], a[2], a[3], a[4]];
    for (let i = 5; i <= 8; i += 1) b.push(entry(i, b[i - 1].hash, 'rewritten'));
    const { mirror, raised } = kit({ pageLimit: 3 });
    const node = fakeNode(a);
    assert.equal(await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI }), 'append');
    assert.equal(mirror.cursor(ID).seq, 6);
    node.chain = b; // rewritten from seq 5 and grown to 8: our head hash is gone
    assert.equal(await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI }), 'chain_break');
    assert.deepEqual(mirror.cursor(ID), { seq: 8, hash: b[8].hash });
    assert.deepEqual(mirror.breaks(ID).map((x) => x.reason), ['fork']);
    assert.equal(raised.length, 1);
    assert.equal(await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI }), 'empty', 'and it moves on');
  });

  it('a node alternating between two chains cannot grow the mirror (40 syncs, 1-day retention)', async () => {
    let now = Date.parse('2026-05-01T00:00:00.000Z');
    const { mirror, raised } = kit({ retentionDays: 1, now: () => now });
    const a = chain(3);
    const b = chain(3, 'other.event');
    const node = fakeNode(a);
    const sizes = [];
    for (let i = 0; i < 40; i += 1) {
      node.chain = i % 2 ? b : a;
      await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI });
      sizes.push(count(mirror));
      now += DAY;
    }
    assert.ok(Math.max(...sizes) <= 3, `stored slices stay bounded: ${sizes.join(',')}`);
    assert.deepEqual(mirror.breaks(ID).map((x) => [x.reason, x.segment]), [['fork', 1], ['fork', 2]]);
    assert.equal(raised.length, 2, 'one alert per distinct fork');
    assert.deepEqual(mirror.cursor(ID), { seq: 3, hash: b[3].hash });
    assert.equal(mirror.history(ID, {}).segment, 1, 'back in the segment that holds chain b');
    // Chain b grew while the node was on chain a: its signed head is not the
    // stored head of b's segment, so this is a new fork (and a new alert), not a re-entry.
    node.chain = a;
    await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI });
    const before = count(mirror);
    const grown = [...b, entry(4, b[3].hash, 'other.event')];
    node.chain = grown;
    assert.equal(await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI }), 'chain_break');
    assert.deepEqual(mirror.cursor(ID), { seq: 4, hash: grown[4].hash });
    assert.equal(count(mirror), before + 1);
    assert.deepEqual(mirror.breaks(ID).map((x) => [x.reason, x.segment]), [['fork', 1], ['fork', 2], ['fork', 3]]);
    assert.equal(raised.length, 3);
  });

  it('a third chain sharing the first page with two known chains is a new fork with an alert, without ping-pong', async () => {
    const base = chain(5);
    const variant = (kind) => {
      const c = base.slice();
      for (let i = 6; i <= 8; i += 1) c.push(entry(i, c[i - 1].hash, kind));
      return c;
    };
    const a = variant('a.event');
    const b = variant('b.event');
    const c = variant('c.event');
    const { mirror, raised } = kit({ pageLimit: 3 });
    const node = fakeNode(a);
    for (const ch of [a, b, a, b, a]) {
      node.chain = ch;
      await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI });
    }
    assert.equal(raised.length, 2, 'two distinct forks so far');
    node.chain = c;
    node.fetched = 0;
    assert.equal(await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI }), 'chain_break');
    assert.ok(node.fetched <= 4, `no ping-pong between known segments (${node.fetched} pages)`);
    assert.deepEqual(mirror.breaks(ID).map((x) => [x.reason, x.segment]), [['fork', 1], ['fork', 2], ['fork', 3]]);
    assert.equal(raised.length, 3);
    assert.deepEqual(mirror.cursor(ID), { seq: 8, hash: c[8].hash });
    node.fetched = 0;
    assert.equal(await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI }), 'empty');
    assert.equal(node.fetched, 1);
    assert.equal(raised.length, 3);
  });

  it('a known head signed over another chain\'s page is a new fork, not a re-entry', async () => {
    const a = chain(3);
    const b = chain(3, 'other.event');
    const c = chain(3, 'third.event');
    const { mirror, raised } = kit();
    const node = fakeNode(a);
    for (const ch of [a, b, a]) {
      node.chain = ch;
      await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI });
    }
    // Chain c's entries 1..2 under chain b's (known) signed head.
    const env = signedSlice([c[1], c[2]], { seq: 3, hash: b[3].hash });
    assert.equal((await mirror.ingestSlice(ID, env, SPKI)).outcome, 'chain_break');
    assert.deepEqual(mirror.breaks(ID).map((x) => [x.reason, x.segment]), [['fork', 1], ['fork', 2], ['fork', 3]]);
    assert.deepEqual(mirror.cursor(ID), { seq: 2, hash: c[2].hash });
    assert.equal(raised.length, 3);
  });

  it('a re-entry ends the sync: one re-entry per sync, no further paging', async () => {
    const a = chain(3);
    const b = chain(3, 'other.event');
    const { mirror } = kit();
    const node = fakeNode(a);
    for (const ch of [a, b, a]) {
      node.chain = ch;
      await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI });
    }
    // The node flips to b and then back to a on every fetch: without the limit
    // a sync would re-enter segment 1, then segment 2, and so on to maxPages.
    let fetches = 0;
    const flipping = async (params) => { fetches += 1; node.chain = fetches % 2 ? b : a; return node.fetchSlice(params); };
    assert.equal(await mirror.sync(ID, { fetchSlice: flipping, spkiHex: SPKI }), 'chain_break');
    assert.equal(fetches, 1);
    assert.deepEqual(mirror.cursor(ID), { seq: 3, hash: b[3].hash });
    assert.equal(mirror.breaks(ID).length, 2);
  });

  it('a third chain from a known fork point is a new fork in a new segment, never re-entry into another chain', async () => {
    const { mirror } = kit();
    const a = chain(3);
    const b = chain(3, 'other.event');
    const c = chain(3, 'third.event');
    const node = fakeNode(a);
    for (const ch of [a, b, a, b]) {
      node.chain = ch;
      await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI });
    }
    // In segment 1 (chain b); the recorded fork from b's head went to segment 2 (chain a).
    node.chain = c;
    assert.equal(await mirror.sync(ID, { fetchSlice: node.fetchSlice, spkiHex: SPKI }), 'chain_break');
    assert.deepEqual(mirror.breaks(ID).map((x) => [x.reason, x.segment]), [['fork', 1], ['fork', 2], ['fork', 3]]);
    assert.deepEqual(mirror.cursor(ID), { seq: 3, hash: c[3].hash });
    assert.deepEqual(mirror.history(ID, {}), { segment: 3, envelope: page(c, 1, 3, { oldest: 1 }) });
  });

  it('two different tamperings at the same stuck head are two breaks, each recorded once', async () => {
    const { mirror, raised } = kit();
    const c = chain(5);
    await mirror.ingestSlice(ID, page(c, 1, 2), SPKI);
    const head5 = { seq: 5, hash: c[5].hash };
    const first = signedSlice([{ ...c[3], data: { i: 'rewritten' } }, c[4]], head5);
    const second = signedSlice([c[3], { ...c[4], data: { i: 'rewritten' } }], head5);
    for (const env of [first, second, first, second]) {
      assert.equal((await mirror.ingestSlice(ID, env, SPKI)).outcome, 'chain_break');
    }
    assert.deepEqual(mirror.breaks(ID).map((x) => [x.reason, x.seq]), [['hash_mismatch', 3], ['hash_mismatch', 4]]);
    assert.equal(raised.length, 2);
    assert.equal(mirror.cursor(ID).seq, 2);
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
      'has a head that is not a hash': (f) => rewrite(f, (s) => { s.head.hash = '../../x'; }),
      'has a fork segment that is not a number': (f) => rewrite(f, (s) => {
        s.breaks = [{ seq: 1, reason: 'fork', mirror_head: null, at: '2026-05-01T00:00:00.000Z', segment: '1' }];
        s.status = 'broken';
      })
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
