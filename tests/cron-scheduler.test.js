const { describe, it } = require('node:test');
const assert = require('node:assert');
const CronScheduler = require('../src/cron/cron-scheduler');

// Simple in-memory mock store
class MockStore {
  constructor() {
    this.jobs = new Map();
  }
  list() { return Array.from(this.jobs.values()); }
  get(id) { return this.jobs.get(id); }
  async update(id, patch) {
    const job = this.jobs.get(id);
    if (job) {
      const updated = { ...job, ...patch };
      this.jobs.set(id, updated);
      return updated;
    }
  }
  add(job) {
    this.jobs.set(job.id, job);
  }
}

describe('CronScheduler', () => {
  it('calculates next run for interval schedule', () => {
    const mockStore = new MockStore();
    const mockExecutor = { execute: async () => ({ ok: true }) };
    const scheduler = new CronScheduler(mockStore, mockExecutor);
    const job = { id: 'j1', enabled: true, schedule: { kind: 'every', everyMs: 60000 }, state: { lastRunAtMs: Date.now() - 60001 } };
    assert.ok(scheduler.isDue(job));
  });

  it('calculates next run for cron expression', () => {
    const mockStore = new MockStore();
    const mockExecutor = { execute: async () => ({ ok: true }) };
    const scheduler = new CronScheduler(mockStore, mockExecutor);
    const nextRun = scheduler.getNextRun({
      id: 'j2',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' }
    });
    assert.ok(nextRun > 0);
  });

  it('calculates next run for one-shot schedule', () => {
    const mockStore = new MockStore();
    const mockExecutor = { execute: async () => ({ ok: true }) };
    const futureTime = new Date(Date.now() + 3600000).toISOString();
    const scheduler = new CronScheduler(mockStore, mockExecutor);
    const job = { id: 'j3', enabled: true, schedule: { kind: 'at', at: futureTime } };
    assert.ok(!scheduler.isDue(job));
  });

  it('executes due jobs on tick', async () => {
    const mockStore = new MockStore();
    let executed = false;
    const executor = { execute: async () => { executed = true; return { ok: true }; } };
    const scheduler = new CronScheduler(mockStore, executor);
    mockStore.add({ id: 'j4', enabled: true, schedule: { kind: 'every', everyMs: 60000 }, state: { lastRunAtMs: Date.now() - 60001 } });

    await scheduler.tick();
    assert.ok(executed);
  });

  it('respects maxConcurrentJobs', async () => {
    const mockStore = new MockStore();
    let executeCount = 0;
    const executor = { execute: async () => { executeCount++; return { ok: true }; } };
    const scheduler = new CronScheduler(mockStore, executor, { maxConcurrentJobs: 2 });

    // Add 5 due jobs
    for(let i=0; i<5; i++) {
        mockStore.add({ id: `j${i}`, enabled: true, schedule: { kind: 'every', everyMs: 1 }, state: { lastRunAtMs: 0 } });
    }

    await scheduler.tick();
    assert.strictEqual(executeCount, 2);
  });

  it('tracks consecutive errors', async () => {
    const mockStore = new MockStore();
    const executor = { execute: async () => ({ ok: false, error: 'failed' }) };
    const scheduler = new CronScheduler(mockStore, executor);
    mockStore.add({ id: 'j5', enabled: true, schedule: { kind: 'every', everyMs: 1 }, state: { lastRunAtMs: 0, consecutiveErrors: 0 } });

    await scheduler.tick();
    const job = mockStore.get('j5');
    assert.strictEqual(job.state.consecutiveErrors, 1);
  });

  it('runNow executes immediately regardless of schedule', async () => {
    const mockStore = new MockStore();
    let executed = false;
    const executor = { execute: async () => { executed = true; return { ok: true }; } };
    const scheduler = new CronScheduler(mockStore, executor);

    const futureTime = new Date(Date.now() + 3600000).toISOString();
    mockStore.add({ id: 'j6', enabled: true, schedule: { kind: 'at', at: futureTime } });

    await scheduler.runNow('j6');
    assert.ok(executed);
  });
});
