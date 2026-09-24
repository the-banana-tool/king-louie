// tests/cases-budget.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Budget, CATEGORIES, THRESHOLDS } = require('../src/cases/budget');
const { localDay, addDays, zonedTime, nextLocalTime, nextLocalMidnight, parseHhmm, toMs } = require('../src/cases/clock');
const { readJson, writeJsonIfChanged } = require('../src/cases/jsonfile');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const caseDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-budget-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.kl'));
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('clock helpers', () => {
  it('computes local days, local times and midnights in a time zone', () => {
    const at = new Date('2026-09-23T23:30:00Z');
    assert.strictEqual(localDay(at, 'UTC'), '2026-09-23');
    assert.strictEqual(localDay(at, 'Asia/Tokyo'), '2026-09-24');
    assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
    assert.strictEqual(zonedTime('2026-09-24', 9, 0, 'Asia/Tokyo').toISOString(), '2026-09-24T00:00:00.000Z');
    assert.strictEqual(nextLocalTime(at, '09:00', 'UTC').toISOString(), '2026-09-24T09:00:00.000Z');
    assert.strictEqual(nextLocalMidnight(at, 'UTC').toISOString(), '2026-09-24T00:00:00.000Z');
  });

  it('keeps 09:00 local across a daylight-saving change', () => {
    const before = new Date('2026-10-31T13:00:30Z'); // 09:00:30 EDT
    assert.strictEqual(nextLocalTime(before, '09:00', 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z');
  });

  it('falls back to 09:00 for a malformed time and parses dates and strings', () => {
    assert.deepStrictEqual(parseHhmm('25:99'), [9, 0]);
    assert.deepStrictEqual(parseHhmm('7:05'), [7, 5]);
    assert.strictEqual(toMs('2026-09-23T00:00:00Z'), Date.parse('2026-09-23T00:00:00Z'));
    assert.strictEqual(toMs(new Date(5)), 5);
    assert.ok(Number.isNaN(toMs(null)));
  });

  it('writes a JSON file only when its content changes', async () => {
    const file = path.join(caseDir(), '.kl', 'x.json');
    assert.deepStrictEqual(readJson(file, { none: true }), { none: true });
    assert.strictEqual(writeJsonIfChanged(file, { a: 1 }), true);
    assert.strictEqual(writeJsonIfChanged(file, { a: 1 }), false);
    assert.deepStrictEqual(readJson(file, null), { a: 1 });
  });
});

describe('Budget', () => {
  it('lists the five categories and three thresholds', () => {
    assert.deepStrictEqual([...CATEGORIES], ['usd', 'deadline', 'turnsPerDay', 'contactsPerDay', 'questionsPerDay']);
    assert.deepStrictEqual([...THRESHOLDS], [50, 80, 100]);
  });

  it('reports each threshold once, as it is crossed', () => {
    const b = new Budget(caseDir(), { defaults: { usd: 10 }, timeZone: 'UTC' });
    assert.deepStrictEqual(b.charge('usd', 4).crossedNow, []);
    assert.deepStrictEqual(b.charge('usd', 1).crossedNow, [50]);
    assert.deepStrictEqual(b.charge('usd', 3.5).crossedNow, [80]);
    const last = b.charge('usd', 2);
    assert.deepStrictEqual(last, { spent: 10.5, limit: 10, crossedNow: [100] });
    assert.deepStrictEqual(b.charge('usd', 1).crossedNow, []);
    assert.deepStrictEqual(b.exhausted(), ['usd']);
    assert.strictEqual(b.remaining('usd'), -1.5);
  });

  it('prefers the case override over the default, and treats null or 0 as unlimited', () => {
    const d = caseDir();
    assert.strictEqual(new Budget(d, { defaults: { usd: 20 }, overrides: { usd: 40 } }).limitFor('usd'), 40);
    const none = new Budget(d, { defaults: { usd: null } });
    assert.deepStrictEqual(none.charge('usd', 1000).crossedNow, []);
    assert.strictEqual(none.remaining('usd'), null);
    const zero = new Budget(d, { defaults: { usd: 20 }, overrides: { usd: 0 } });
    assert.strictEqual(zero.limitFor('usd'), null);
    assert.deepStrictEqual(zero.exhausted(), []);
  });

  it('rolls a per-day category over at local midnight in the time zone, never backwards', () => {
    const d = caseDir();
    let clock = new Date('2026-09-23T23:30:00Z'); // Tokyo: 2026-09-24 08:30
    const b = new Budget(d, { defaults: { turnsPerDay: 2 }, now: () => clock, timeZone: 'Asia/Tokyo' });
    assert.deepStrictEqual(b.charge('turnsPerDay', 1), { spent: 1, limit: 2, crossedNow: [50] });
    clock = new Date('2026-09-24T14:59:00Z'); // Tokyo 23:59, same day
    assert.deepStrictEqual(b.charge('turnsPerDay', 1).crossedNow, [80, 100]);
    assert.strictEqual(b.atLimit('turnsPerDay'), true);
    clock = new Date('2026-09-24T15:01:00Z'); // Tokyo 00:01 on the 25th
    assert.strictEqual(b.atLimit('turnsPerDay'), false);
    assert.deepStrictEqual(b.charge('turnsPerDay', 1), { spent: 1, limit: 2, crossedNow: [50] });
    clock = new Date('2026-09-24T10:00:00Z'); // the clock jumps back to the 24th
    assert.deepStrictEqual(b.charge('turnsPerDay', 1), { spent: 2, limit: 2, crossedNow: [80, 100] });
    assert.strictEqual(b.status().turnsPerDay.day, '2026-09-25');
  });

  it('measures the deadline as elapsed time between creation and the end of the deadline day', () => {
    const d = caseDir();
    let clock = new Date('2026-09-06T00:00:00Z');
    const b = new Budget(d, { overrides: { deadline: '2026-09-10' }, createdAt: '2026-09-01T00:00:00Z', now: () => clock, timeZone: 'UTC' });
    assert.deepStrictEqual(b.charge('deadline', 0), { spent: null, limit: '2026-09-10', crossedNow: [50] });
    clock = new Date('2026-09-09T00:00:00Z');
    assert.deepStrictEqual(b.charge('deadline', 0).crossedNow, [80]);
    clock = new Date('2026-09-11T00:00:00Z');
    assert.deepStrictEqual(b.charge('deadline', 0).crossedNow, [100]);
    assert.deepStrictEqual(b.exhausted(), ['deadline']);
    assert.strictEqual(b.status().deadline.ratio, 1);
    assert.strictEqual(readJson(path.join(d, '.kl', 'budget.json'), null).deadline.ratio, undefined, 'the ratio is never stored');
  });

  it('counts a deadline on or before creation as 100 %', () => {
    const b = new Budget(caseDir(), { overrides: { deadline: '2026-09-10' }, createdAt: '2026-09-20T00:00:00Z', now: () => new Date('2026-09-21T00:00:00Z'), timeZone: 'UTC' });
    assert.deepStrictEqual(b.charge('deadline', 0).crossedNow, [50, 80, 100]);
  });

  it('reads a deadline that YAML parsed into a Date', () => {
    const b = new Budget(caseDir(), { overrides: { deadline: new Date('2026-11-30T00:00:00Z') } });
    assert.strictEqual(b.limitFor('deadline'), '2026-11-30');
  });

  it('does not rewrite budget.json on a quiet deadline charge', async () => {
    const d = caseDir();
    const b = new Budget(d, { overrides: { deadline: '2026-12-31' }, createdAt: '2026-09-01T00:00:00Z', now: () => new Date('2026-09-02T00:00:00Z'), timeZone: 'UTC' });
    b.charge('deadline', 0);
    const file = path.join(d, '.kl', 'budget.json');
    const before = { text: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs };
    await sleep(30);
    b.charge('deadline', 0);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before.text);
    assert.strictEqual(fs.statSync(file).mtimeMs, before.mtime);
  });

  it('reconcile raises and lowers a limit, dropping and re-reporting thresholds', () => {
    const d = caseDir();
    const at10 = new Budget(d, { overrides: { usd: 10 } });
    at10.charge('usd', 9);
    assert.deepStrictEqual(at10.status().usd.crossed, [50, 80]);
    const at20 = new Budget(d, { overrides: { usd: 20 } });
    assert.deepStrictEqual(at20.reconcile(), {});
    assert.deepStrictEqual(at20.status().usd.crossed, []);
    const at5 = new Budget(d, { overrides: { usd: 5 } });
    assert.deepStrictEqual(at5.reconcile(), { usd: [50, 80, 100] });
    assert.deepStrictEqual(at5.exhausted(), ['usd']);
  });

  it('adds unpriced tokens to the usd entry and records grants', () => {
    const d = caseDir();
    const b = new Budget(d, { defaults: { usd: 20 } });
    b.charge('usd', 0, { unpricedTokens: 1200 });
    b.charge('usd', 0.5, { unpricedTokens: 0 });
    const usd = b.status().usd;
    assert.strictEqual(usd.unpricedTokens, 1200);
    assert.strictEqual(usd.spent, 0.5);
    b.recordGrant('usd', 'f-0007');
    b.recordGrant('usd', 'f-0007');
    assert.deepStrictEqual(b.status().usd.grantedBy, ['f-0007']);
  });

  it('refuses an unknown category', () => {
    assert.throws(() => new Budget(caseDir()).charge('tokens', 1), /Unknown budget category "tokens"/);
  });
});
