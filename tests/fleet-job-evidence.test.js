// tests/fleet-job-evidence.test.js — fleet stage 4 §3.7 (evidence), §3.8 (slots).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { RunbookEngine, JobManager } = require('../src/runbooks/runbook-engine');

const servers = [];
after(() => { for (const s of servers) s.close(); });

async function statusServer(codes) {
  let i = 0;
  const server = http.createServer((req, res) => { res.statusCode = codes[Math.min(i++, codes.length - 1)]; res.end('x'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/healthz`;
}

function engineWith(steps) {
  const engine = new RunbookEngine({ killGraceMs: 200 });
  engine.runbooks.set('site.check', { name: 'site.check', tier: 'read', params: {}, timeout_s: 30, rate_limit: null, steps });
  return engine;
}

describe('runbook check evidence', () => {
  it('records each check step: index, check, ok, attempts, status, time', async () => {
    const url = await statusServer([200]);
    const engine = engineWith([{ run: [process.execPath, '-e', '0'] }, { check: { http_get: url, expect_status: 200 } }]);
    const res = await engine.executeRunbook('site.check', {});
    assert.equal(res.success, true);
    assert.equal(res.checks.length, 1);
    const [c] = res.checks;
    assert.deepEqual({ step_index: c.step_index, check: c.check, ok: c.ok, attempts: c.attempts, status_code: c.status_code, error: c.error },
      { step_index: 1, check: { http_get: url, expect_status: 200 }, ok: true, attempts: 1, status_code: 200, error: null });
    assert.ok(!Number.isNaN(Date.parse(c.at)));
  });

  it('a failed check carries its attempts, last status and error, and ends the run', async () => {
    const url = await statusServer([503, 503]);
    const engine = engineWith([{ check: { http_get: url, expect_status: 200, retries: 2 } }, { run: [process.execPath, '-e', '0'] }]);
    const res = await engine.executeRunbook('site.check', {});
    assert.equal(res.success, false);
    assert.equal(res.checks.length, 1);
    assert.equal(res.checks[0].ok, false);
    assert.equal(res.checks[0].attempts, 2);
    assert.equal(res.checks[0].status_code, 503);
    assert.match(res.checks[0].error, /did not return 200/);
  });

  it('a run with no check steps reports an empty list', async () => {
    const engine = engineWith([{ run: [process.execPath, '-e', '0'] }]);
    assert.deepEqual((await engine.executeRunbook('site.check', {})).checks, []);
  });
});

describe('JobManager: delegate jobs and turn slots', () => {
  it('an idle delegate session takes no slot; a running turn does', () => {
    const jobs = new JobManager({ maxConcurrentJobs: 1 });
    const d = jobs.createDelegateJob({ machine: 'gpu-box', task: 'train', cwd: '/srv' });
    assert.equal(d.kind, 'delegate');
    assert.equal(d.status, 'running');
    assert.equal(d.session, 'idle');
    assert.equal(jobs.activeJobCount(), 0);
    assert.ok(jobs.getSignal(d.job_id));
    jobs.beginTurn(d.job_id);
    assert.equal(jobs.getJob(d.job_id).session, 'turn');
    assert.equal(jobs.activeJobCount(), 1);
    assert.equal(jobs.hasFreeSlot(), false);
    assert.throws(() => jobs.createJob({ machine: 'gpu-box', runbook: 'x', tier: 'routine' }), (err) => err.code === 'max_concurrent_jobs');
    jobs.endTurn(d.job_id);
    assert.equal(jobs.getJob(d.job_id).session, 'idle');
    assert.equal(jobs.activeJobCount(), 0);
  });

  it('beginTurn refuses a second turn, a full node and a closed session', () => {
    const jobs = new JobManager({ maxConcurrentJobs: 1 });
    const a = jobs.createDelegateJob({ machine: 'n', task: 'a', cwd: '/srv' });
    const b = jobs.createDelegateJob({ machine: 'n', task: 'b', cwd: '/srv' });
    jobs.beginTurn(a.job_id);
    assert.throws(() => jobs.beginTurn(a.job_id), (err) => err.code === 'node_busy');
    assert.throws(() => jobs.beginTurn(b.job_id), (err) => err.code === 'max_concurrent_jobs');
    jobs.endTurn(a.job_id);
    jobs.updateJob(b.job_id, { status: 'succeeded', session: 'closed' });
    assert.throws(() => jobs.beginTurn(b.job_id), (err) => err.code === 'bad_transition');
  });

  it('emits update on creation and on every status or session change, not on log appends', () => {
    const jobs = new JobManager();
    const seen = [];
    jobs.on('update', (job) => seen.push(`${job.status}/${job.session || '-'}`));
    const r = jobs.createJob({ machine: 'n', runbook: 'x', tier: 'routine' });
    jobs.updateJob(r.job_id, { logs: ['a'] });
    jobs.updateJob(r.job_id, { status: 'running' });
    jobs.updateJob(r.job_id, { status: 'succeeded' });
    const d = jobs.createDelegateJob({ machine: 'n', task: 't', cwd: '/srv' });
    jobs.beginTurn(d.job_id);
    jobs.endTurn(d.job_id);
    assert.deepEqual(seen, ['queued/-', 'running/-', 'succeeded/-', 'running/idle', 'running/turn', 'running/idle']);
  });

  it('cancelJob aborts a delegate job\'s signal and marks it cancelled', () => {
    const jobs = new JobManager();
    const d = jobs.createDelegateJob({ machine: 'n', task: 't', cwd: '/srv' });
    const signal = jobs.getSignal(d.job_id);
    assert.equal(jobs.cancelJob(d.job_id), true);
    assert.equal(signal.aborted, true);
    assert.equal(jobs.getJob(d.job_id).status, 'cancelled');
  });
});
