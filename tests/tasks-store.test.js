'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore, TASK_STATES, UNFINISHED } = require('../src/tasks/store');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('TaskStore', () => {
  let dir;
  let now;
  let warnings;
  const log = () => ({ warn: (...a) => warnings.push(a), info() {}, debug() {}, error() {} });
  const make = () => new TaskStore({ dataDir: dir, clock: () => now, log: log() });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tasks-'));
    now = Date.parse('2026-11-03T10:00:00Z');
    warnings = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('exports the states', () => {
    assert.deepEqual(UNFINISHED, ['requested', 'awaiting_grant', 'running']);
    for (const s of UNFINISHED) assert.ok(TASK_STATES.includes(s));
    assert.ok(TASK_STATES.includes('waiting') && TASK_STATES.includes('interrupted'));
  });

  it('mints a UUID v4 id and survives a new store on the same dir', () => {
    const rec = make().create({ text: 'find a plumber', chat_id: 'c1', client: { kind: 'stdio' } });
    assert.match(rec.task_id, UUID_RE);
    assert.equal(rec.state, 'requested');
    assert.equal(rec.seq, 1);
    assert.equal(rec.created_at, '2026-11-03T10:00:00.000Z');
    assert.deepEqual(make().get(rec.task_id), rec);
  });

  it('refuses host keys and unknown keys', () => {
    const s = make();
    assert.throws(() => s.create({ task_id: 'x' }), /cannot set/);
    assert.throws(() => s.create({ bogus: 1 }), /unknown task key/);
    assert.throws(() => s.create({ state: 'nope' }), /state/);
  });

  it('update bumps seq and updated_at, keeps the id and created_at', () => {
    const s = make();
    const rec = s.create({ text: 't' });
    now += 5000;
    const next = s.update(rec.task_id, { state: 'running' });
    assert.equal(next.seq, 2);
    assert.equal(next.state, 'running');
    assert.equal(next.updated_at, '2026-11-03T10:00:05.000Z');
    assert.equal(next.created_at, rec.created_at);
    assert.throws(() => s.update(rec.task_id, { seq: 9 }), /cannot set/);
    assert.throws(() => s.update('11111111-1111-4111-8111-111111111111', { state: 'done' }), /no task/);
  });

  it('refuses an id that is not a UUID v4, so no path leaves the dir', () => {
    const s = make();
    assert.equal(s.get('../evil'), null);
    assert.equal(s.get('..\\evil'), null);
    assert.equal(s.get(42), null);
    assert.throws(() => s.update('../evil', { state: 'done' }), /invalid id/);
  });

  it('list is newest first', () => {
    const s = make();
    const a = s.create({ text: 'a' });
    now += 1000;
    const b = s.create({ text: 'b' });
    assert.deepEqual(s.list().map((r) => r.task_id), [b.task_id, a.task_id]);
  });

  it('skips a corrupt file with a warning, not a throw', () => {
    const s = make();
    const good = s.create({ text: 'ok' });
    const badId = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(path.join(dir, 'tasks', `${badId}.json`), '{not json');
    assert.deepEqual(s.list().map((r) => r.task_id), [good.task_id]);
    assert.equal(s.get(badId), null);
    assert.ok(warnings.length >= 1);
    assert.ok(!JSON.stringify(warnings).includes('not json'));
  });

  it('markInterrupted changes only unfinished records and keeps the answer', () => {
    const s = make();
    const answer = { text: 'partial', at: 'x', seq: 1 };
    const ids = {};
    for (const state of TASK_STATES) ids[state] = s.create({ text: state, state, answer }).task_id;
    now += 1000;
    const changed = s.markInterrupted();
    assert.deepEqual([...changed].sort(), UNFINISHED.map((st) => ids[st]).sort());
    for (const state of TASK_STATES) {
      const r = s.get(ids[state]);
      if (UNFINISHED.includes(state)) {
        assert.equal(r.state, 'interrupted');
        assert.equal(r.ended, null);
        assert.equal(r.interrupted_at, '2026-11-03T10:00:01.000Z');
        assert.deepEqual(r.answer, answer);
        assert.equal(r.seq, 2);
      } else {
        assert.equal(r.state, state);
        assert.equal(r.seq, 1);
      }
    }
  });
});
