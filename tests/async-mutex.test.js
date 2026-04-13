const { describe, it } = require('node:test');
const assert = require('node:assert');
const AsyncMutex = require('../src/workflows/async-mutex');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('AsyncMutex', () => {
  it('serializes calls with the same key', async () => {
    const mutex = new AsyncMutex();
    const events = [];

    const job = (label, delay) => mutex.run('k', async () => {
      events.push(`${label}:start`);
      await wait(delay);
      events.push(`${label}:end`);
    });

    await Promise.all([job('a', 20), job('b', 5), job('c', 5)]);

    assert.deepStrictEqual(events, [
      'a:start', 'a:end',
      'b:start', 'b:end',
      'c:start', 'c:end'
    ]);
  });

  it('runs different keys in parallel', async () => {
    const mutex = new AsyncMutex();
    const events = [];

    const job = (key) => mutex.run(key, async () => {
      events.push(`${key}:start`);
      await wait(40);
      events.push(`${key}:end`);
    });

    const start = Date.now();
    await Promise.all([job('x'), job('y')]);
    const elapsed = Date.now() - start;

    // Both ran in parallel, so total is ~40ms not ~80ms. Loose bound for
    // Windows timer granularity (~16ms).
    assert.ok(elapsed < 70, `expected parallel execution, took ${elapsed}ms`);
    // Both starts must come before either end.
    const xStartIdx = events.indexOf('x:start');
    const yStartIdx = events.indexOf('y:start');
    const xEndIdx = events.indexOf('x:end');
    const yEndIdx = events.indexOf('y:end');
    assert.ok(xStartIdx < xEndIdx && xStartIdx < yEndIdx, 'x must start before any end');
    assert.ok(yStartIdx < yEndIdx && yStartIdx < xEndIdx, 'y must start before any end');
  });

  it('does not poison the chain when a job rejects', async () => {
    const mutex = new AsyncMutex();
    let secondRan = false;

    const failing = mutex.run('k', async () => { throw new Error('boom'); });
    const following = mutex.run('k', async () => { secondRan = true; return 42; });

    await assert.rejects(failing, /boom/);
    const result = await following;

    assert.strictEqual(secondRan, true);
    assert.strictEqual(result, 42);
  });

  it('returns the function result', async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.run('k', async () => 'hello');
    assert.strictEqual(result, 'hello');
  });
});
