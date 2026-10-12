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

// start() also schedules one tick 100 ms later. stop() cleared only the
// interval, so a core shut down inside those 100 ms ran its due jobs after
// shutdown() had returned: on a fresh data dir cases:wakeups is always due,
// and its jobs.json write re-created a data dir the caller had just removed.
describe('CronScheduler: stop() stops the start-up tick too', () => {
  function dueStore() {
    const store = new MockStore();
    store.add({ id: 'due', enabled: true, schedule: { kind: 'every', everyMs: 60000 }, state: { lastRunAtMs: 0, consecutiveErrors: 0 } });
    return store;
  }

  function trackTimeouts() {
    const realSet = global.setTimeout;
    const realClear = global.clearTimeout;
    const created = [];
    const cleared = new Set();
    global.setTimeout = (...args) => { const t = realSet(...args); created.push({ timer: t, fn: args[0], ms: args[1] }); return t; };
    global.clearTimeout = (t) => { cleared.add(t); return realClear(t); };
    return { created, cleared, restore: () => { global.setTimeout = realSet; global.clearTimeout = realClear; } };
  }

  it('clears the start-up timer, and that timer runs nothing if it fires anyway', async () => {
    let runs = 0;
    const scheduler = new CronScheduler(dueStore(), { execute: async () => { runs += 1; return { ok: true }; } });
    const timers = trackTimeouts();
    try {
      scheduler.start();
      scheduler.stop();
    } finally {
      timers.restore();
    }
    assert.strictEqual(timers.created.length, 1, 'start() schedules one start-up tick');
    assert.strictEqual(timers.created[0].ms, 100);
    assert.ok(timers.cleared.has(timers.created[0].timer), 'stop() did not clear the start-up tick');
    assert.strictEqual(scheduler.timer, null);

    // The callback itself, as if it had already been queued when stop() ran.
    await timers.created[0].fn();
    assert.strictEqual(runs, 0, 'a due job ran after stop()');
  });

  it('a stopped scheduler ignores tick() until it is started again', async () => {
    let runs = 0;
    const scheduler = new CronScheduler(dueStore(), { execute: async () => { runs += 1; return { ok: true }; } });
    scheduler.start();
    scheduler.stop();
    await scheduler.tick();
    assert.strictEqual(runs, 0);

    scheduler.start();
    try {
      await scheduler.tick();
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(runs, 1);
    } finally {
      scheduler.stop();
    }
  });

  it('a scheduler that was never started still runs a tick called directly', async () => {
    let runs = 0;
    const scheduler = new CronScheduler(dueStore(), { execute: async () => { runs += 1; return { ok: true }; } });
    await scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(runs, 1);
  });
});
