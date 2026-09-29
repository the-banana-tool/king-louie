// tests/history-token-estimator.test.js
// Token estimates with per-model calibration (recall spec §6.6).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const { TokenEstimator } = require('../src/history/token-estimator');
const { openTempStore } = require('./helpers/history-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

describe('TokenEstimator', () => {
  const t = openTempStore();
  after(() => t.cleanup());

  it('defaults to 4 characters per token', () => {
    const e = new TokenEstimator();
    assert.strictEqual(e.estimate('x'.repeat(10)), 3);
    assert.strictEqual(e.estimate(''), 0);
    assert.strictEqual(e.estimate(null), 0);
    assert.strictEqual(e.fromChars(4000), 1000);
    assert.strictEqual(e.charsPerToken('any-model'), 4);
  });

  it('observe moves the ratio by an EMA from the default and persists it', () => {
    const e = new TokenEstimator({ store: t.store });
    const first = e.observe('test-model', 12000, 4000); // observed 3
    assert.strictEqual(first.samples, 1);
    assert.ok(Math.abs(first.charsPerToken - 3.8) < 1e-9);
    assert.strictEqual(e.estimate('x'.repeat(38), 'test-model'), 10);
    const fresh = new TokenEstimator({ store: t.store });
    assert.ok(Math.abs(fresh.charsPerToken('test-model') - 3.8) < 1e-9, 'read back from the store');
    const second = fresh.observe('test-model', 12000, 4000);
    assert.strictEqual(second.samples, 2);
    assert.ok(Math.abs(second.charsPerToken - (3.8 * 0.8 + 3 * 0.2)) < 1e-9);
  });

  it('clamps an absurd ratio and ignores unusable observations', () => {
    const e = new TokenEstimator({ store: t.store });
    assert.ok(Math.abs(e.observe('wide-model', 100000, 1).charsPerToken - (4 * 0.8 + 12 * 0.2)) < 1e-9);
    assert.strictEqual(e.observe('m', 0, 10), null);
    assert.strictEqual(e.observe('m', 100, 0), null);
    assert.strictEqual(e.observe('m', NaN, 10), null);
    assert.strictEqual(e.observe(null, 100, 10), null);
  });

  it('a failing store is logged, never thrown', () => {
    const store = { calibration() { throw new Error('locked'); }, setCalibration() { throw new Error('locked'); } };
    const e = new TokenEstimator({ store });
    assert.strictEqual(e.estimate('abcd', 'm'), 1);
    assert.doesNotThrow(() => e.observe('m', 800, 100));
  });
});
