const { describe, it } = require('node:test');
const assert = require('node:assert');
const CronScheduler = require('../src/cron/cron-scheduler');

describe('CronScheduler', () => {
  const mockStore = {
    jobs: [],
    list() { return this.jobs; },
    get(id) { return this.jobs.find(j => j.id === id); },
    update(id, patch) {
      const job = this.get(id);
      if (job) Object.assign(job, patch);
      return Promise.resolve(job);
    }
  };

  const mockExecutor = {
    async execute() { return { ok: true }; }
  };

  it('calculates next run for interval schedule', () => {
    const scheduler = new CronScheduler(mockStore, mockExecutor);
    const job = { enabled: true, schedule: { kind: 'every', everyMs: 60000 }, state: { lastRunAtMs: Date.now() - 60001 } };
    assert.ok(scheduler.isDue(job));
  });

  it('calculates next run for cron expression', () => {
    const scheduler = new CronScheduler(mockStore, mockExecutor);
    const nextRun = scheduler.getNextRun({
      schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' }
    });
    assert.ok(nextRun > Date.now());
  });

  it('calculates next run for one-shot schedule', () => {
    const futureTime = new Date(Date.now() + 3600000).toISOString();
    const scheduler = new CronScheduler(mockStore, mockExecutor);
    const job = { enabled: true, schedule: { kind: 'at', at: futureTime } };
    assert.ok(!scheduler.isDue(job));
  });

  it('executes due jobs on tick', async () => {
    let executed = false;
    const executor = { async execute() { executed = true; return { ok: true }; } };
    const scheduler = new CronScheduler({ ...mockStore, jobs: [{ id: '1', enabled: true, schedule: { kind: 'every', everyMs: 1 }, state: { lastRunAtMs: 0 } }] }, executor);
    await scheduler.tick();
    assert.ok(executed);
  });

  it('respects maxConcurrentJobs', async () => {
    let executions = 0;
    const executor = {
      async execute() {
        executions++;
        return new Promise(resolve => setTimeout(() => resolve({ ok: true }), 100)); // Delay to simulate running
      }
    };

    const jobs = Array.from({ length: 5 }).map((_, i) => ({
      id: `job-${i}`, enabled: true, schedule: { kind: 'every', everyMs: 1 }, state: { lastRunAtMs: 0 }
    }));

    const scheduler = new CronScheduler({ ...mockStore, jobs }, executor, { maxConcurrentJobs: 2 });
    await scheduler.tick();

    // We didn't await the jobs finishing inside tick() because tick() itself just spins them off asynchronously?
    // Let's modify the test. In our implementation of tick(), we iterate and call `executeJob`, which modifies activeJobs.
    assert.strictEqual(scheduler.activeJobs.size, 2);
    assert.strictEqual(executions, 2);
  });

  it('tracks consecutive errors', async () => {
    const job = { id: 'err-job', enabled: true, schedule: { kind: 'every', everyMs: 1 }, state: {} };
    const store = {
      list() { return [job]; },
      get() { return job; },
      async update(id, patch) { Object.assign(job, patch); }
    };
    const executor = { async execute() { throw new Error('test err'); } };
    const scheduler = new CronScheduler(store, executor);

    await scheduler.executeJob(job);
    assert.strictEqual(job.state.consecutiveErrors, 1);
  });

  it('runNow executes immediately regardless of schedule', async () => {
    let executed = false;
    const job = { id: 'run-now-job', enabled: true, schedule: { kind: 'at', at: new Date(Date.now() + 3600000).toISOString() }, state: {} };
    const store = { list() { return [job]; }, get(id) { return id === job.id ? job : null; }, async update() {} };
    const executor = { async execute() { executed = true; return { ok: true }; } };
    const scheduler = new CronScheduler(store, executor);

    await scheduler.runNow('run-now-job');
    assert.ok(executed);
  });
});
