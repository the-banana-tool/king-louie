// tests/cases-verify-store.test.js
// Cases stage 8, Task 3: <case>/.kl/verification.json (spec §7.3).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { addSink } = require('../src/logging');
const { VerificationStore } = require('../src/cases/verify/store');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function caseDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-verify-store-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.kl'));
  return d;
}
const file = (dir) => path.join(dir, '.kl', 'verification.json');
const T1 = '2026-10-21T09:14:10.000Z';
const T2 = '2026-10-22T08:00:00.000Z';
const clock = (...times) => { let i = 0; return () => new Date(times[Math.min(i++, times.length - 1)]); };
const H1 = `sha256:${'1'.repeat(64)}`;
const H2 = `sha256:${'2'.repeat(64)}`;
const EMPTY = { version: 1, nextRecord: 1, records: [], opinions: {}, cache: null, passes: null, declinedClose: null, closed: null };
const verdict = (extra = {}) => ({
  criterion: 'sc-001', criterionHash: H1, evidence: ['f-0042', 'f-0051'], note: 'Contract signed at 81,000; floor is 75,000.',
  turnId: 'turn-91c2', model: 'example-provider:example-model', ...extra
});

function warnings(fn) {
  const lines = [];
  const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
  try { return { value: fn(), lines }; } finally { remove(); }
}

describe('VerificationStore', () => {
  it('reads the empty shape when there is no file, and writes nothing', () => {
    const dir = caseDir();
    const store = new VerificationStore(dir);
    assert.deepStrictEqual(store.read(), EMPTY);
    assert.strictEqual(store.passesOn('2026-10-21'), 0);
    assert.strictEqual(fs.existsSync(file(dir)), false);
  });

  it('addRecord writes the record of the spec, and ids count up', () => {
    const dir = caseDir();
    const store = new VerificationStore(dir, { now: clock(T1, T2) });
    const a = store.addRecord(verdict());
    assert.deepStrictEqual(a, {
      id: 'v-0001', kind: 'verify', criterion: 'sc-001', criterionHash: H1, evidence: ['f-0042', 'f-0051'],
      note: 'Contract signed at 81,000; floor is 75,000.', turnId: 'turn-91c2', model: 'example-provider:example-model', at: T1, disagreed: null
    });
    const b = store.addRecord(verdict({ criterion: 'sc-002', criterionHash: H2, evidence: ['f-0060'] }));
    assert.deepStrictEqual([b.id, b.at], ['v-0002', T2]);
    const onDisk = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    assert.deepStrictEqual(onDisk, { ...EMPTY, nextRecord: 3, records: [a, b] });
    assert.deepStrictEqual(store.read(), onDisk);
  });

  it('refuses a record that names no criterion, hash or evidence', () => {
    const dir = caseDir();
    const store = new VerificationStore(dir);
    for (const bad of [{ criterion: '' }, { criterionHash: null }, { evidence: [] }, { evidence: 'f-0042' }, { evidence: ['f-0042', 7] }, { evidence: undefined }]) {
      assert.throws(() => store.addRecord(verdict(bad)), /verification record/, JSON.stringify(bad));
    }
    assert.throws(() => store.addRecord(), /verification record/);
    assert.strictEqual(fs.existsSync(file(dir)), false);
  });

  it('keeps the newest 5 records per criterion', () => {
    const store = new VerificationStore(caseDir(), { now: clock(T1) });
    store.addRecord(verdict({ criterion: 'sc-002', criterionHash: H2 }));
    for (let i = 0; i < 7; i += 1) store.addRecord(verdict({ note: `pass ${i}` }));
    const { records, nextRecord } = store.read();
    assert.strictEqual(nextRecord, 9, 'ids are never reused');
    assert.deepStrictEqual(records.filter((r) => r.criterion === 'sc-001').map((r) => r.id), ['v-0004', 'v-0005', 'v-0006', 'v-0007', 'v-0008']);
    assert.deepStrictEqual(records.filter((r) => r.criterion === 'sc-002').map((r) => r.id), ['v-0001'], "another criterion's records are left alone");
  });

  it('markDisagreed marks one record, once', () => {
    const store = new VerificationStore(caseDir(), { now: clock(T1, T2) });
    const a = store.addRecord(verdict());
    assert.strictEqual(store.markDisagreed('v-0009', { turnId: 'turn-a1b2' }), null);
    assert.deepStrictEqual(store.markDisagreed(a.id, { turnId: 'turn-a1b2' }).disagreed, { turnId: 'turn-a1b2', at: T2 });
    assert.deepStrictEqual(store.markDisagreed(a.id, { turnId: 'turn-zzzz' }).disagreed, { turnId: 'turn-a1b2', at: T2 }, 'the first mark stands');
    assert.deepStrictEqual(store.read().records[0].disagreed, { turnId: 'turn-a1b2', at: T2 });
  });

  it('keeps the newest opinion per criterion', () => {
    const store = new VerificationStore(caseDir(), { now: clock(T1) });
    store.setOpinion('sc-003', { status: 'met', evidence: ['f-0099'], rejected: [{ id: 'f-0099', reason: 'evidence-provenance' }], turnId: 'turn-91c2' });
    store.setOpinion('sc-002', { status: 'unmet', evidence: [], turnId: 'turn-91c2', at: T2 });
    assert.deepStrictEqual(store.read().opinions, {
      'sc-003': { status: 'met', evidence: ['f-0099'], rejected: [{ id: 'f-0099', reason: 'evidence-provenance' }], turnId: 'turn-91c2', at: T1 },
      'sc-002': { status: 'unmet', evidence: [], turnId: 'turn-91c2', at: T2 }
    });
    store.setOpinion('sc-003', { status: 'unmet', evidence: [], turnId: 'turn-a1b2' });
    assert.strictEqual(store.read().opinions['sc-003'].status, 'unmet');
    store.clearOpinion('sc-003');
    store.clearOpinion('sc-009');
    assert.deepStrictEqual(Object.keys(store.read().opinions), ['sc-002']);
  });

  it('setCache writes only when the states differ', () => {
    const dir = caseDir();
    const store = new VerificationStore(dir, { now: clock(T1, T2) });
    assert.strictEqual(store.setCache({ 'sc-001': 'met', 'sc-002': 'stale' }), true);
    assert.deepStrictEqual(store.read().cache, { at: T1, states: { 'sc-001': 'met', 'sc-002': 'stale' } });
    const bytes = fs.readFileSync(file(dir));
    const mtime = fs.statSync(file(dir)).mtimeMs;
    assert.strictEqual(store.setCache({ 'sc-002': 'stale', 'sc-001': 'met' }), false, 'the same states in another order');
    assert.ok(bytes.equals(fs.readFileSync(file(dir))));
    assert.strictEqual(fs.statSync(file(dir)).mtimeMs, mtime);
    assert.strictEqual(store.setCache({ 'sc-001': 'met', 'sc-002': 'met' }), true);
    assert.deepStrictEqual(store.read().cache, { at: T2, states: { 'sc-001': 'met', 'sc-002': 'met' } });
    assert.strictEqual(store.setCache({ 'sc-001': 'met' }), true, 'a criterion that went away');
    // An empty cache on a case with no file is not worth a file.
    const quiet = caseDir();
    assert.strictEqual(new VerificationStore(quiet).setCache({}), false);
    assert.strictEqual(fs.existsSync(file(quiet)), false);
  });

  it('counts verify passes per day', () => {
    const store = new VerificationStore(caseDir());
    assert.strictEqual(store.countPass('2026-10-21'), 1);
    assert.strictEqual(store.countPass('2026-10-21'), 2);
    assert.strictEqual(store.passesOn('2026-10-21'), 2);
    assert.strictEqual(store.passesOn('2026-10-22'), 0);
    assert.strictEqual(store.countPass('2026-10-22'), 1, 'a new day starts over');
    assert.deepStrictEqual(store.read().passes, { day: '2026-10-22', count: 1 });
    assert.strictEqual(store.passesOn('2026-10-21'), 0);
  });

  it('records a declined close proposal and a frozen close', () => {
    const store = new VerificationStore(caseDir(), { now: clock(T1) });
    store.setDeclinedClose('sha256:77e1');
    assert.deepStrictEqual(store.read().declinedClose, { fingerprint: 'sha256:77e1', at: T1 });
    const closed = { at: T1, status: 'done', summary: '1 of 1 confirmed criteria met', criteria: [{ id: 'sc-001', state: 'met' }], readiness: { ready: true, items: [] } };
    store.freeze(closed);
    assert.deepStrictEqual(store.read().closed, closed);
    assert.deepStrictEqual(store.read().declinedClose, { fingerprint: 'sha256:77e1', at: T1 }, 'one write leaves the other parts alone');
  });

  it('an unreadable file reads empty with one warning and is replaced by the next write', () => {
    for (const text of ['not json', '[]', '"verification"', 'null']) {
      const dir = caseDir();
      fs.writeFileSync(file(dir), text);
      const store = new VerificationStore(dir, { now: clock(T1) });
      const { value, lines } = warnings(() => store.read());
      assert.deepStrictEqual(value, EMPTY, text);
      assert.strictEqual(lines.length, 1, `${text}: ${lines.join(' | ')}`);
      assert.match(lines[0], /verification\.json/);
      assert.strictEqual(fs.readFileSync(file(dir), 'utf8'), text, 'a read never writes');
      const a = store.addRecord(verdict());
      assert.strictEqual(a.id, 'v-0001');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file(dir), 'utf8')), { ...EMPTY, nextRecord: 2, records: [a] });
    }
  });

  it('a file with parts missing or of the wrong kind reads with those parts empty', () => {
    const dir = caseDir();
    const kept = { id: 'v-0007', kind: 'verify', criterion: 'sc-001', criterionHash: H1, evidence: ['f-0042'], note: '', turnId: null, model: null, at: T1, disagreed: null };
    fs.writeFileSync(file(dir), JSON.stringify({ version: 1, nextRecord: 2, records: [kept, 'junk', { id: 7 }], opinions: [], cache: 'met', passes: { day: 7 }, closed: 'yes' }));
    const store = new VerificationStore(dir);
    assert.deepStrictEqual(store.read(), { ...EMPTY, nextRecord: 8, records: [kept] });
    assert.strictEqual(store.addRecord(verdict()).id, 'v-0008', 'an id in the file is never handed out again');
  });
});

describe('VerificationStore.noteSkip (the verify pass says a skip once a day)', () => {
  it('is true the first time a reason is noted on a day, and the file has no such key before', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vstore-skip-'));
    try {
      fs.mkdirSync(path.join(d, '.kl'));
      const store = new VerificationStore(d, { now: () => new Date('2026-10-21T09:00:00.000Z') });
      assert.strictEqual('skipNoted' in store.read(), false);
      assert.strictEqual(store.noteSkip('2026-10-21', 'daily-cap'), true);
      assert.strictEqual(store.noteSkip('2026-10-21', 'daily-cap'), false);
      assert.strictEqual(store.noteSkip('2026-10-21', 'usd-budget'), true);
      assert.strictEqual(store.noteSkip('2026-10-22', 'usd-budget'), true);
      assert.deepStrictEqual(store.read().skipNoted, { day: '2026-10-22', reason: 'usd-budget' });
      assert.throws(() => store.noteSkip('', 'daily-cap'));
      // Counting a pass keeps it.
      store.countPass('2026-10-22');
      assert.deepStrictEqual(store.read().skipNoted, { day: '2026-10-22', reason: 'usd-budget' });
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
