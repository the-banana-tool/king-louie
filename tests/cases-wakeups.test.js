// tests/cases-wakeups.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WakeupStore } = require('../src/cases/wakeups');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const caseDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wakeups-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.kl'));
  return d;
};
const T0 = new Date('2026-09-23T12:00:00.000Z');
const plus = (d, ms) => new Date(d.getTime() + ms);
const HOUR = 3600000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function store({ clock = { now: T0 }, timeZone = 'UTC', dailyAt = '09:00' } = {}) {
  const d = caseDir();
  return { d, clock, s: new WakeupStore(d, { now: () => clock.now, timeZone, dailyAt }) };
}

describe('WakeupStore', () => {
  it('registers, lists, cancels and never reuses an id', () => {
    const { s } = store();
    const a = s.register({ kind: 'deadline-check', every: 86400000, payload: { key: 'deadline' } });
    const b = s.register({ kind: 'retry', at: '2026-09-23T13:00:00Z', payload: { key: 'r' }, createdBy: 'model' });
    assert.deepStrictEqual([a, b], ['w-0001', 'w-0002']);
    const [first, second] = s.list();
    assert.strictEqual(first.nextAt, '2026-09-24T12:00:00.000Z');
    assert.strictEqual(first.everyMs, 86400000);
    assert.strictEqual(first.at, null);
    assert.strictEqual(second.nextAt, '2026-09-23T13:00:00.000Z');
    assert.strictEqual(second.createdBy, 'model');
    assert.strictEqual(s.cancel(b), true);
    assert.strictEqual(s.cancel(b), false);
    assert.strictEqual(s.register({ kind: 'retry', at: '2026-09-23T14:00:00Z' }), 'w-0003');
    assert.strictEqual(s.cancelAll(), 2);
    assert.deepStrictEqual(s.list(), []);
  });

  it('validates at, every and kind', () => {
    const { s } = store();
    assert.throws(() => s.register({ kind: 'retry', every: 59999 }), /at least 60000/);
    assert.throws(() => s.register({ kind: 'retry', every: 90000.5 }), /integer/);
    assert.throws(() => s.register({ kind: 'retry', at: '2026-09-23T13:00:00Z', every: 60000 }), /exactly one/);
    assert.throws(() => s.register({ kind: 'retry' }), /exactly one/);
    assert.throws(() => s.register({ kind: 'retry', at: 'tomorrow' }), /RFC3339/);
    assert.throws(() => s.register({ kind: 'Retry Now', every: 60000 }), /kind/);
    assert.ok(s.register({ kind: 'detours:incoming', every: 60000 }));
  });

  it('ensure returns the existing id for the same kind and payload key', () => {
    const { s } = store();
    const a = s.ensure('daily-orientation', { every: 86400000, payload: { key: 'daily' } });
    assert.strictEqual(s.ensure('daily-orientation', { every: 86400000, payload: { key: 'daily' } }), a);
    assert.notStrictEqual(s.ensure('daily-orientation', { every: 86400000, payload: { key: 'other' } }), a);
    assert.strictEqual(s.list().length, 2);
  });

  it('anchors daily-orientation to dailyAt in the time zone', () => {
    const { s } = store({ dailyAt: '09:00' });
    s.register({ kind: 'daily-orientation', every: 86400000, payload: { key: 'daily' } });
    assert.strictEqual(s.list()[0].nextAt, '2026-09-24T09:00:00.000Z');
  });

  it('keeps daily-orientation at 09:00 local across a daylight-saving change', () => {
    const clock = { now: new Date('2026-10-30T13:00:00Z') }; // 09:00 EDT
    const { s } = store({ clock, timeZone: 'America/New_York' });
    const id = s.register({ kind: 'daily-orientation', every: 86400000, payload: { key: 'daily' } });
    assert.strictEqual(s.list()[0].nextAt, '2026-10-31T13:00:00.000Z');
    const ran = s.markRan(id, { outcome: 'quiet', now: new Date('2026-10-31T13:00:30Z') });
    assert.strictEqual(ran.nextAt, '2026-11-01T14:00:00.000Z', '09:00 EST, not 08:00');
  });

  it('marks runs: quiet and acted move every-entries on and remove at-entries', () => {
    const { s } = store();
    const every = s.register({ kind: 'deadline-check', every: HOUR });
    const once = s.register({ kind: 'retry', at: '2026-09-23T12:00:00Z' });
    const at = plus(T0, 5 * 60000);
    assert.deepStrictEqual(s.due(at).map((w) => w.id), [once]);
    const moved = s.markRan(every, { outcome: 'quiet', now: at });
    assert.strictEqual(moved.nextAt, plus(at, HOUR).toISOString());
    assert.strictEqual(moved.lastOutcome, 'quiet');
    assert.strictEqual(s.markRan(once, { outcome: 'acted', now: at }), null);
    assert.deepStrictEqual(s.list().map((w) => w.id), [every]);
  });

  it('skipped keeps an at-entry and moves it to the next local midnight', () => {
    const { s } = store();
    const once = s.register({ kind: 'retry', at: '2026-09-23T12:00:00Z' });
    const kept = s.markRan(once, { outcome: 'skipped', now: T0 });
    assert.strictEqual(kept.nextAt, '2026-09-24T00:00:00.000Z');
    assert.strictEqual(kept.attempts, 0);
  });

  it('failed backs off 5, 15, 60, then 60 minutes and records the error', () => {
    const { s } = store();
    const id = s.register({ kind: 'retry', at: '2026-09-23T12:00:00Z' });
    const steps = [5, 15, 60, 60];
    steps.forEach((minutes, i) => {
      const w = s.markRan(id, { outcome: 'failed', error: 'provider down', now: T0 });
      assert.strictEqual(w.attempts, i + 1);
      assert.strictEqual(w.nextAt, plus(T0, minutes * 60000).toISOString());
      assert.strictEqual(w.lastError, 'provider down');
    });
    const ok = s.markRan(id, { outcome: 'skipped', now: T0 });
    assert.strictEqual(ok.attempts, 0);
    assert.throws(() => s.markRan(id, { outcome: 'maybe', now: T0 }), /outcome/);
  });

  it('a clock three days forward yields one due entry, rescheduled from now', () => {
    const { s } = store();
    const id = s.register({ kind: 'deadline-check', every: HOUR });
    const later = plus(T0, 3 * 24 * HOUR);
    assert.deepStrictEqual(s.due(later).map((w) => w.id), [id]);
    const w = s.markRan(id, { outcome: 'acted', now: later });
    assert.strictEqual(w.nextAt, plus(later, HOUR).toISOString());
    assert.deepStrictEqual(s.due(later), []);
  });

  it('a clock two hours back reanchors an every-entry that is now too far out', () => {
    const { s } = store();
    const id = s.register({ kind: 'deadline-check', every: HOUR });
    const earlier = plus(T0, -2 * HOUR);
    assert.strictEqual(s.reanchor(earlier), 1);
    assert.strictEqual(s.list().find((w) => w.id === id).nextAt, plus(earlier, HOUR).toISOString());
    assert.strictEqual(s.reanchor(earlier), 0);
  });

  it('writes only when something changes', async () => {
    const { d, s } = store();
    s.register({ kind: 'deadline-check', every: HOUR });
    const file = path.join(d, '.kl', 'wakeups.json');
    const mtime = fs.statSync(file).mtimeMs;
    await sleep(30);
    assert.strictEqual(s.markRan('w-0404', { outcome: 'quiet', now: T0 }), null);
    assert.strictEqual(s.reanchor(T0), 0);
    assert.strictEqual(s.cancel('w-0404'), false);
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
  });
});
