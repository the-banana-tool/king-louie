const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const DenialTracker = require('../src/tools/denial-tracker');

describe('DenialTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new DenialTracker({ threshold: 3 });
  });

  it('reports not-tripped below the threshold', () => {
    tracker.recordDenial('Bash', { command: 'rm file' });
    tracker.recordDenial('Bash', { command: 'rm file' });
    const check = tracker.check('Bash', { command: 'rm file' });
    assert.strictEqual(check.tripped, false);
    assert.strictEqual(check.count, 2);
  });

  it('trips at the threshold', () => {
    for (let i = 0; i < 3; i++) tracker.recordDenial('Bash', { command: 'rm file' });
    const check = tracker.check('Bash', { command: 'rm file' });
    assert.strictEqual(check.tripped, true);
    assert.strictEqual(check.count, 3);
  });

  it('scopes counts per (tool, key)', () => {
    for (let i = 0; i < 3; i++) tracker.recordDenial('Bash', { command: 'rm file' });
    // Different key — fresh counter.
    const other = tracker.check('Bash', { command: 'ls' });
    assert.strictEqual(other.tripped, false);
    assert.strictEqual(other.count, 0);
  });

  it('uses url as the key for WebFetch', () => {
    tracker.recordDenial('WebFetch', { url: 'https://example.com/a' });
    tracker.recordDenial('WebFetch', { url: 'https://example.com/b' });
    assert.strictEqual(tracker.check('WebFetch', { url: 'https://example.com/a' }).count, 1);
    assert.strictEqual(tracker.check('WebFetch', { url: 'https://example.com/b' }).count, 1);
  });

  it('falls back to tool-level key when no string field is present', () => {
    tracker.recordDenial('Cron', { schedule: {} });
    tracker.recordDenial('Cron', { schedule: {} });
    assert.strictEqual(tracker.check('Cron', { schedule: {} }).count, 2);
  });

  it('recordGrant clears the counter for that key', () => {
    tracker.recordDenial('Bash', { command: 'rm file' });
    tracker.recordDenial('Bash', { command: 'rm file' });
    tracker.recordGrant('Bash', { command: 'rm file' });
    assert.strictEqual(tracker.check('Bash', { command: 'rm file' }).count, 0);
  });

  it('reset clears all counters', () => {
    tracker.recordDenial('Bash', { command: 'a' });
    tracker.recordDenial('Bash', { command: 'b' });
    assert.strictEqual(tracker.size(), 2);
    tracker.reset();
    assert.strictEqual(tracker.size(), 0);
  });
});
