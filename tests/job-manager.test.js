const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JobManager } = require('../src/runbooks/runbook-engine');

describe('JobManager statuses, timing and cancellation', () => {
  it('records a denied job that never runs, holds no slot and is already finished', () => {
    const manager = new JobManager({ maxConcurrentJobs: 1 });
    const denied = manager.createJob({ machine: 'm', runbook: 'r', tier: 'unsafe', status: 'denied', reason: 'denied_by_policy: x' });
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reason, 'denied_by_policy: x');
    assert.ok(denied.finished_at);
    assert.equal(denied.started_at, null);
    assert.equal(manager.getSignal(denied.job_id), null);
    assert.equal(manager.cancelJob(denied.job_id), false);
    // The one slot is still free.
    assert.equal(manager.createJob({ machine: 'm', runbook: 'r' }).status, 'queued');
  });

  it('refuses to create a job in a status it could only reach by running', () => {
    const manager = new JobManager();
    assert.throws(() => manager.createJob({ machine: 'm', runbook: 'r', status: 'succeeded' }), /cannot start/);
  });

  it('stamps started_at on the first move to running and finished_at on the first terminal status', () => {
    const manager = new JobManager();
    const job = manager.createJob({ machine: 'm', runbook: 'r' });
    assert.equal(job.started_at, null);
    assert.equal(job.finished_at, null);
    manager.updateJob(job.job_id, { status: 'running' });
    const started = job.started_at;
    assert.ok(started);
    manager.updateJob(job.job_id, { logs: ['x'] });
    assert.equal(job.started_at, started);
    manager.updateJob(job.job_id, { status: 'succeeded' });
    assert.ok(job.finished_at);
    assert.equal(manager.isTerminal(job.job_id), true);
    assert.equal(manager.getSignal(job.job_id), null);
  });

  it('cancelJob aborts the job signal and marks it cancelled', () => {
    const manager = new JobManager();
    const job = manager.createJob({ machine: 'm', runbook: 'r' });
    const signal = manager.getSignal(job.job_id);
    assert.equal(signal.aborted, false);
    assert.equal(manager.cancelJob(job.job_id), true);
    assert.equal(signal.aborted, true);
    assert.equal(job.status, 'cancelled');
    assert.ok(job.finished_at);
    assert.equal(manager.cancelJob(job.job_id), false);
  });

  it('keeps counting a cancelled job against the limit until its execution settles', () => {
    const manager = new JobManager({ maxConcurrentJobs: 1 });
    const job = manager.createJob({ machine: 'm', runbook: 'r' });
    manager.updateJob(job.job_id, { status: 'running' });
    manager.markExecuting(job.job_id);
    assert.equal(manager.cancelJob(job.job_id), true);
    assert.equal(job.status, 'cancelled');
    assert.equal(manager.isExecuting(job.job_id), true);
    assert.equal(manager.activeJobCount(), 1);
    assert.throws(() => manager.createJob({ machine: 'm', runbook: 'r' }), (err) => err.code === 'max_concurrent_jobs');

    manager.markSettled(job.job_id);
    assert.equal(manager.activeJobCount(), 0);
    assert.equal(manager.createJob({ machine: 'm', runbook: 'r' }).status, 'queued');
  });

  it('gives the concurrency refusal a code', () => {
    const manager = new JobManager({ maxConcurrentJobs: 1 });
    manager.createJob({ machine: 'm', runbook: 'r' });
    assert.throws(() => manager.createJob({ machine: 'm', runbook: 'r' }), (err) => err.code === 'max_concurrent_jobs');
  });
});
