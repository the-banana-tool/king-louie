// tests/cases-executor-util.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('../src/cases/executors/util');
const { EXECUTOR_SETTINGS_DEFAULTS, mergeExecutorSettings, resolveExecutorSettings } = require('../src/cases/executors/defaults');
const { canonicalize, sha256b64url } = require('../src/platform/jcs');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('executor util', () => {
  it('sha256hex hashes text and buffers alike', () => {
    assert.strictEqual(util.sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.strictEqual(util.sha256hex(Buffer.from('abc')), util.sha256hex('abc'));
  });

  it('localDate reads the calendar day in a zone', () => {
    assert.strictEqual(util.localDate(new Date('2026-11-02T05:30:00Z'), 'America/Chicago'), '2026-11-01');
    assert.strictEqual(util.localDate(new Date('2026-11-02T06:30:00Z'), 'America/Chicago'), '2026-11-02');
    assert.strictEqual(util.localDate('2026-11-02T06:30:00Z', 'UTC'), '2026-11-02');
  });

  it('pickTimeZone takes the first valid zone, else the host zone', () => {
    assert.strictEqual(util.pickTimeZone('', 'Not/AZone', 'Asia/Tokyo'), 'Asia/Tokyo');
    assert.strictEqual(util.pickTimeZone(undefined, null), util.hostTimeZone());
    assert.strictEqual(util.validTimeZone('UTC'), true);
    assert.strictEqual(util.validTimeZone('Mars/Base'), false);
  });

  it('counts allowed weekdays between two days', () => {
    // 2026-10-26 is a Monday.
    assert.strictEqual(util.weekdayOf('2026-10-26'), 1);
    assert.strictEqual(util.weekdayOf('2026-11-01'), 7);
    assert.strictEqual(util.countDays('2026-10-26', '2026-11-01'), 7);
    assert.strictEqual(util.countDays('2026-10-26', '2026-11-01', [1, 2, 3, 4, 5]), 5);
    assert.strictEqual(util.countDays('2026-11-01', '2026-10-26'), 0);
    assert.strictEqual(util.addDays('2026-10-31', 1), '2026-11-01');
    assert.strictEqual(util.addDays('2026-11-01', -1), '2026-10-31');
  });

  it('window instants follow local calendar days across DST', () => {
    assert.deepStrictEqual(util.windowInstants('2026-10-30', '2026-11-01', 'America/Chicago'), {
      notBefore: '2026-10-30T05:00:00Z',
      notAfter: '2026-11-02T05:59:59Z'
    });
    assert.deepStrictEqual(util.windowInstants('2026-10-30', '2026-10-30', 'Asia/Tokyo'), {
      notBefore: '2026-10-29T15:00:00Z',
      notAfter: '2026-10-30T14:59:59Z'
    });
  });

  it('writes JSON atomically and reads it back, with a fallback for missing or broken files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-exec-util-'));
    dirs.push(dir);
    const file = path.join(dir, 'a', 'b.json');
    util.writeJsonAtomic(file, { n: 1 });
    assert.deepStrictEqual(util.readJsonSafe(file, null), { n: 1 });
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['b.json'], 'no temp file is left behind');
    fs.writeFileSync(file, '{ broken');
    assert.strictEqual(util.readJsonSafe(file, 'fallback'), 'fallback');
    assert.strictEqual(util.readJsonSafe(path.join(dir, 'missing.json'), 7), 7);
  });

  it('parseJsonObject accepts only JSON text of an object', () => {
    assert.deepStrictEqual(util.parseJsonObject('{"a":1}', 'payload'), { ok: true, value: { a: 1 } });
    assert.match(util.parseJsonObject('[1]', 'payload').error, /"payload" must be JSON text of an object/);
    assert.match(util.parseJsonObject('{nope', 'payload').error, /"payload" is not valid JSON/);
    assert.match(util.parseJsonObject(undefined, 'payload').error, /"payload" is required/);
    assert.match(util.parseJsonObject(5, 'payload').error, /"payload" must be JSON text of an object/);
  });

  it('valueText and roundUsd render values the way cards and the gate show them', () => {
    assert.strictEqual(util.valueText(['a', 'b']), 'a, b');
    assert.strictEqual(util.valueText(12.5), '12.5');
    assert.strictEqual(util.valueText(null), '');
    assert.strictEqual(util.valueText({ a: 1 }), '{"a":1}');
    assert.strictEqual(util.roundUsd(0.1 + 0.2), 0.3);
  });
});

describe('executor settings', () => {
  it('defaults match the spec', () => {
    const s = resolveExecutorSettings(undefined);
    assert.deepStrictEqual(
      [s.defaultCountryCode, s.pollEveryMs, s.submitTimeoutMs, s.requestTimeoutMs, s.refreshBudgetMs, s.maxPollErrors, s.auditScanEntries, s.attemptsDefault, s.opsMemory.maxEntries],
      ['', 900000, 30000, 20000, 5000, 5, 5000, 2, 20]
    );
    assert.deepStrictEqual(Object.keys(s.outbound.categoryKeywords).sort(), ['financial', 'health', 'legal', 'personal']);
    assert.deepStrictEqual(s.entries, {});
  });

  it('merges key by key and replaces one category keyword list', () => {
    const s = mergeExecutorSettings(EXECUTOR_SETTINGS_DEFAULTS, {
      pollEveryMs: 60000,
      opsMemory: {},
      outbound: { categoryKeywords: { health: ['clinic'] } }
    });
    assert.strictEqual(s.pollEveryMs, 60000);
    assert.strictEqual(s.submitTimeoutMs, 30000);
    assert.strictEqual(s.opsMemory.maxEntries, 20);
    assert.deepStrictEqual(s.outbound.categoryKeywords.health, ['clinic']);
    assert.ok(s.outbound.categoryKeywords.financial.includes('floor price'));
    assert.strictEqual(EXECUTOR_SETTINGS_DEFAULTS.outbound.categoryKeywords.health.includes('clinic'), false, 'defaults are not mutated');
  });

  it('keeps entries from the source only when they are an object', () => {
    assert.deepStrictEqual(resolveExecutorSettings({ entries: { 'phone-agent': { kind: 'external-agent' } } }).entries, { 'phone-agent': { kind: 'external-agent' } });
    assert.deepStrictEqual(resolveExecutorSettings({ entries: ['nope'] }).entries, {});
  });
});

describe('JCS', () => {
  it('canonicalizes keys in code-unit order and hashes to base64url', () => {
    assert.strictEqual(canonicalize({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
    assert.strictEqual(sha256b64url(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });
});
