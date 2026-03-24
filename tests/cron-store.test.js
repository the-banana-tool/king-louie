const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const CronStore = require('../src/cron/cron-store');

describe('CronStore', () => {
  let store, tempFile;

  beforeEach(() => {
    tempFile = path.join(os.tmpdir(), `cron-test-${Date.now()}.json`);
    store = new CronStore(tempFile);
  });

  afterEach(() => {
    try { fs.unlinkSync(tempFile); } catch {}
  });

  it('loads from empty/missing file', async () => {
    await store.load();
    assert.deepStrictEqual(store.list(), []);
  });

  it('adds and retrieves a job', async () => {
    await store.load();
    const job = await store.add({
      schedule: { kind: 'every', everyMs: 60000 },
      payload: { kind: 'agentTurn', message: 'test' }
    });
    assert.ok(job.id);
    assert.strictEqual(store.get(job.id).payload.message, 'test');
  });

  it('persists to disk', async () => {
    await store.load();
    await store.add({ schedule: { kind: 'every', everyMs: 60000 }, payload: { message: 'test' } });

    // Load fresh instance from same file
    const store2 = new CronStore(tempFile);
    await store2.load();
    assert.strictEqual(store2.list().length, 1);
  });

  it('updates a job', async () => {
    await store.load();
    const job = await store.add({ schedule: { kind: 'every', everyMs: 60000 }, payload: { message: 'old' } });
    await store.update(job.id, { enabled: false });
    assert.strictEqual(store.get(job.id).enabled, false);
  });

  it('removes a job', async () => {
    await store.load();
    const job = await store.add({ schedule: { kind: 'every', everyMs: 60000 }, payload: { message: 'test' } });
    await store.remove(job.id);
    assert.strictEqual(store.get(job.id), undefined);
  });
});
