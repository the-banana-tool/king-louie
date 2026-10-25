'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TakeStore, TAKE_KEYS, TAKE_STATES } = require('../src/gui/take-store');

function fakeLog() {
  const warnings = [];
  return {
    warnings,
    warn: (msg, meta) => warnings.push({ msg, meta }),
    info() {}, debug() {}, error() {}, trace() {},
  };
}

describe('TakeStore', () => {
  let root;
  let dir;
  let now;
  let log;
  let store;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'take-store-'));
    dir = path.join(root, 'takes');
    now = Date.parse('2026-10-24T12:00:00.000Z');
    log = fakeLog();
    store = new TakeStore({ dir, clock: () => now, log });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('has exactly the record keys and states of spec 5.3', () => {
    assert.deepEqual([...TAKE_KEYS], ['take_id', 'name', 'job_id', 'origin', 'lease_id', 'grant', 'state',
      'steps', 'recording', 'log', 'ended', 'created_at']);
    assert.deepEqual([...TAKE_STATES], ['requested', 'live', 'waiting', 'ended']);
  });

  it('creates, gets and updates a record (round trip)', () => {
    assert.equal(fs.existsSync(dir), false, 'the folder is made on first write');
    const rec = store.create({ name: 'Signup demo', job_id: 'job-1', origin: { kind: 'stdio' } });
    assert.match(rec.take_id, /^take-[0-9a-f]{12}$/);
    assert.equal(rec.created_at, '2026-10-24T12:00:00.000Z');
    assert.equal(rec.state, 'requested');
    assert.deepEqual(Object.keys(rec).sort(), [...TAKE_KEYS].sort());
    assert.ok(fs.existsSync(path.join(dir, `${rec.take_id}.json`)));

    assert.deepEqual(store.get(rec.take_id), rec);

    const updated = store.update(rec.take_id, { state: 'live', lease_id: 'lease-9', steps: [{ index: 0, action: 'click', ok: true, ms: 12 }] });
    assert.equal(updated.state, 'live');
    assert.equal(updated.lease_id, 'lease-9');
    assert.equal(updated.name, 'Signup demo');
    assert.equal(updated.take_id, rec.take_id);
    assert.equal(updated.created_at, rec.created_at);
    assert.deepEqual(store.get(rec.take_id), updated);

    const again = new TakeStore({ dir, clock: () => now, log });
    assert.deepEqual(again.get(rec.take_id), updated);
    assert.deepEqual(again.list().map((r) => r.take_id), [rec.take_id]);
  });

  it('refuses unknown keys, a bad state and a changed take_id', () => {
    assert.throws(() => store.create({ name: 'x', extra: 1 }), /unknown take key/);
    assert.throws(() => store.create({ name: 'x', state: 'paused' }), /state/);
    const rec = store.create({ name: 'x' });
    assert.throws(() => store.update(rec.take_id, { state: 'bogus' }), /state/);
    assert.throws(() => store.update(rec.take_id, { take_id: 'take-000000000000' }), /take_id/);
    assert.throws(() => store.update(rec.take_id, { nope: true }), /unknown take key/);
    assert.throws(() => store.update('take-ffffffffffff', { name: 'y' }), /no take/);
  });

  it('never reads a path outside the folder', () => {
    assert.equal(store.get('../etc/passwd'), null);
    assert.equal(store.get('take-zzzzzzzzzzzz'), null);
    assert.throws(() => store.update('../x', { name: 'y' }), /no take/);
  });

  it("markLiveEnded('service_restarted') ends requested, live and waiting, leaves ended", () => {
    const requested = store.create({ name: 'a' });
    const live = store.create({ name: 'b', state: 'live' });
    const waiting = store.create({ name: 'c', state: 'waiting' });
    const ended = store.create({ name: 'd', state: 'ended', ended: { at: '2026-10-24T11:00:00.000Z', reason: 'done' } });
    now += 5000;

    const ids = store.markLiveEnded('service_restarted');
    assert.deepEqual(ids.sort(), [requested.take_id, live.take_id, waiting.take_id].sort());
    for (const id of ids) {
      const r = store.get(id);
      assert.equal(r.state, 'ended');
      assert.deepEqual(r.ended, { at: '2026-10-24T12:00:05.000Z', reason: 'service_restarted' });
    }
    assert.deepEqual(store.get(ended.take_id), ended);
    assert.deepEqual(store.markLiveEnded('service_restarted'), []);
  });

  it('markLiveEnded appends the ending to each record\'s log, after what was there', () => {
    const noted = store.create({ name: 'a', state: 'live', log: [{ at: '2026-10-24T11:59:00.000Z', text: 'closed a popup' }] });
    const bare = store.create({ name: 'b', state: 'waiting' });
    now += 5000;
    store.markLiveEnded('service_restarted');
    assert.deepEqual(store.get(noted.take_id).log, [
      { at: '2026-10-24T11:59:00.000Z', text: 'closed a popup' },
      { at: '2026-10-24T12:00:05.000Z', ended: 'service_restarted' }
    ]);
    assert.deepEqual(store.get(bare.take_id).log, [{ at: '2026-10-24T12:00:05.000Z', ended: 'service_restarted' }]);
  });

  it('one record that cannot be updated is warned about by its id, and the later ones are still ended', () => {
    const first = store.create({ name: 'a', state: 'live' });
    const second = store.create({ name: 'b', state: 'live' });
    const [bad, good] = [first, second].sort((x, y) => x.take_id.localeCompare(y.take_id));
    const update = store.update.bind(store);
    store.update = (takeId, patch) => {
      if (takeId === bad.take_id) throw new Error('disk full');
      return update(takeId, patch);
    };
    let ids;
    assert.doesNotThrow(() => { ids = store.markLiveEnded('service_restarted'); });
    assert.deepEqual(ids, [good.take_id]);
    assert.equal(store.get(good.take_id).state, 'ended');
    assert.equal(store.get(bad.take_id).state, 'live');
    assert.equal(log.warnings.length, 1);
    assert.equal(log.warnings[0].meta.takeId, bad.take_id);
  });

  it('summary gives the driver-side take object of spec 11', () => {
    const rec = store.create({
      name: 'Signup demo',
      state: 'live',
      grant: { sites: ['https://example.com'], minutes: 10, expires_at: '2026-10-24T12:10:00.000Z' },
      steps: [{ index: 0, action: 'click', ok: true, ms: 12 }, { index: 1, action: 'type', ok: true, ms: 30 },
        { index: 2, action: 'click', ok: false, ms: 5, error: 'not found' }, { index: 3, action: 'wait' }],
      recording: { path: 'C:\\takes\\a.mp4', started_at: 't0', stopped_at: null, duration_s: 42, bytes: 1000 },
    });
    assert.deepEqual(store.summary(rec), {
      take_id: rec.take_id,
      name: 'Signup demo',
      state: 'live',
      steps: { done: 2, failed: 1, total: 4 },
      recording: { path: 'C:\\takes\\a.mp4', duration_s: 42 },
      lease: { expires_at: '2026-10-24T12:10:00.000Z' },
    });

    const bare = store.create({ name: 'b' });
    assert.deepEqual(store.summary(bare), {
      take_id: bare.take_id,
      name: 'b',
      state: 'requested',
      steps: { done: 0, failed: 0, total: 0 },
      recording: null,
      lease: { expires_at: null },
    });
  });

  it('list() skips a file that is not JSON with one warning, never throws', () => {
    const good = store.create({ name: 'good' });
    const secret = 'sk-SECRET-CONTENTS';
    fs.writeFileSync(path.join(dir, 'take-abcdefabcdef.json'), `{ not json ${secret}`);
    fs.writeFileSync(path.join(dir, 'take-123456123456.json'), '[1,2]');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    let listed;
    assert.doesNotThrow(() => { listed = store.list(); });
    assert.deepEqual(listed.map((r) => r.take_id), [good.take_id]);
    assert.equal(log.warnings.length, 2);
    for (const w of log.warnings) {
      assert.ok(!JSON.stringify(w).includes(secret), 'the warning names no file contents');
    }
    // A bad file is skipped by markLiveEnded too.
    assert.doesNotThrow(() => store.markLiveEnded('service_restarted'));
  });

  it('list() of a folder that does not exist is empty', () => {
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.markLiveEnded('service_restarted'), []);
  });
});
