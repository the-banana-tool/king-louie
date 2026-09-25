// tests/cases-executor-jobs.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { JobStore, EnvelopeStore, PlanStore } = require('../src/cases/executors');
const jobs = require('../src/cases/executors/jobs');
const { readJsonSafe, writeJsonAtomic } = require('../src/cases/executors/util');

after(fx.cleanup);

async function setup(agentOpts = {}) {
  const env = fx.setupExecutors();
  const ctl = fx.withFakeAgent(env, 'fake-agent', agentOpts);
  const meta = await fx.activeCase(env.runtime);
  return { env, ctl, meta, reg: env.registry, dir: meta.dir };
}

function seed(dir) {
  new PlanStore(dir).write({ id: 'plan-001', status: 'approved', steps: [{ id: 's1', title: 'Call brokers', executor: 'fake-agent', capability: 'call', state: 'pending', jobIds: [] }] });
  new EnvelopeStore(dir).write({
    id: 'env-01', version: 1, status: 'active', executor: 'fake-agent', intent: 'Ask for a listing quote',
    recipients: { allow: ['+15550100'] }, facts: [], rules: [], caps: { usd: 20, contacts: 3, attemptsPerContact: 2 },
    window: { start: '2026-10-26', end: '2026-10-30', tz: 'UTC' }, usage: { usd: 0, contacts: [], attempts: {} }, payloads: [], deltas: []
  });
}

async function submitted({ reg, meta, dir }, over = {}) {
  seed(dir);
  const payload = { recipients: [{ address: '+15550100' }], text: 'Hello about the lot', attemptsPerContact: 1 };
  const job = new JobStore(dir).create({
    caseId: meta.id, executor: 'fake-agent', kind: 'external', envelopeId: 'env-01', planStepId: 's1', n: 1,
    signature: 'sig-1', payloadHash: 'hash-1', intent: 'Ask for a listing quote', recipients: ['+15550100'],
    payload, originalPayload: payload, estimateUsd: 2, newContacts: 1, reservedContacts: 1, createdAt: reg.now().toISOString(), ...over
  });
  const adapter = await reg.adapter('fake-agent');
  const res = await adapter.submit({ ...job, externalRef: `${meta.id}/${job.id}` }, null);
  return jobs.commitSubmit(reg, meta.id, job, res);
}

const budgetSpent = (env, id, category) => env.runtime.budget(id).status()[category].spent;

describe('commitSubmit', () => {
  it('records the payload, charges contacts, registers the poll and moves the step', async () => {
    const s = await setup();
    const job = await submitted(s);
    assert.deepStrictEqual([job.state, job.externalId], ['submitted', 'ext-1']);
    const wakeup = s.env.runtime.wakeups(s.meta.id).list().find((w) => w.id === job.wakeupId);
    assert.deepStrictEqual([wakeup.kind, wakeup.everyMs, wakeup.payload], ['poll-executor', 60000, { key: `poll:${job.id}`, executor: 'fake-agent', jobId: job.id }]);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'contactsPerDay'), 1);
    const envelope = new EnvelopeStore(s.dir).get('env-01');
    assert.deepStrictEqual([envelope.payloads.length, envelope.payloads[0].n, envelope.usage.contacts, envelope.usage.attempts], [1, 1, ['+15550100'], { '+15550100': 1 }]);
    const step = new PlanStore(s.dir).read().steps[0];
    assert.deepStrictEqual([step.state, step.jobIds], ['in-flight', [job.id]]);
    const journal = fs.readdirSync(path.join(s.dir, 'journal')).filter((n) => n.endsWith('-envelope.md'));
    assert.strictEqual(journal.length, 1);
    assert.match(fs.readFileSync(path.join(s.dir, 'journal', journal[0]), 'utf8'), /Payload as sent:[\s\S]*Hello about the lot/);
    assert.deepStrictEqual(s.reg.liveState({ caseId: s.meta.id }).map((r) => [r.jobId, r.state]), [[job.id, 'submitted']]);
  });
});

describe('refreshCase', () => {
  it('charges reported cost once, settles the job and reports a material change', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.ctl.jobs.get('ext-1').state = 'done';
    s.ctl.jobs.get('ext-1').costUsd = 1.25;
    s.ctl.jobs.get('ext-1').lastChange = '2026-10-26T15:10:00Z';
    const r = await s.reg.refreshCase(s.meta.id, { force: true });
    assert.strictEqual(r.material, true);
    const done = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([done.state, done.chargedUsd, done.wakeupId], ['done', 1.25, null]);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 1.25);
    assert.strictEqual(new EnvelopeStore(s.dir).get('env-01').usage.usd, 1.25);
    assert.strictEqual(s.env.runtime.wakeups(s.meta.id).list().some((w) => w.kind === 'poll-executor'), false);
    const plan = new PlanStore(s.dir).read();
    assert.deepStrictEqual([plan.steps[0].state, plan.status], ['done', 'done']);
    const snap = readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null);
    assert.deepStrictEqual(snap['fake-agent'].material, { openJobs: 0, lastChange: '2026-10-26T15:10:00Z', failedJobs: 0, unreachableJobs: 0 });
    assert.deepStrictEqual(snap['fake-agent'].state.jobs[job.id], { externalId: 'ext-1', state: 'done' });
    assert.strictEqual((await s.reg.refreshCase(s.meta.id, { force: true })).material, false);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 1.25, 'charged once');
  });

  it('charges the estimate when a finished job never reported a cost', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.ctl.jobs.get('ext-1').state = 'done';
    await s.reg.refreshCase(s.meta.id, { force: true });
    assert.strictEqual(new JobStore(s.dir).get(job.id).chargedUsd, 2);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 2);
  });

  it('poll failure goes stale, then unreachable', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.ctl.jobs.get('ext-1').lastChange = '2026-10-26T15:01:00Z';
    await s.reg.refreshCase(s.meta.id, { force: true });
    const good = readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null)['fake-agent'].fetchedAt;
    s.ctl.statusThrows = 5;
    const t0 = s.env.clock.now.getTime();
    const first = await s.reg.refreshCase(s.meta.id, { force: true });
    let j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.stale, j.pollErrors, j.error], ['running', true, 1, 'errands API unavailable'], 'the last good state is kept');
    assert.strictEqual(Date.parse(j.nextPollAt) - t0, 120000, 'backoff is pollEveryMs × 2');
    const snap = readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null)['fake-agent'];
    assert.deepStrictEqual([snap.stale, snap.error, snap.fetchedAt], [true, 'errands API unavailable', good]);
    assert.strictEqual(first.material, false, 'stale is never material');
    const polls = s.ctl.calls.filter((c) => c[0] === 'status').length;
    await s.reg.refreshCase(s.meta.id);
    assert.strictEqual(s.ctl.calls.filter((c) => c[0] === 'status').length, polls, 'the backoff is respected without force');
    await s.reg.refreshCase(s.meta.id, { force: true });
    j = new JobStore(s.dir).get(job.id);
    assert.strictEqual(Date.parse(j.nextPollAt) - t0, 240000, 'backoff doubles');
    await s.reg.refreshCase(s.meta.id, { force: true });
    await s.reg.refreshCase(s.meta.id, { force: true });
    const last = await s.reg.refreshCase(s.meta.id, { force: true });
    j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.stale, j.pollErrors], ['unreachable', false, 5]);
    assert.strictEqual(last.material, true);
    const after5 = readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null)['fake-agent'];
    assert.deepStrictEqual([after5.stale, after5.material.unreachableJobs], [false, 1]);
    const lines = fs.readdirSync(path.join(s.dir, 'journal')).filter((n) => n.includes('-envelope'))
      .map((n) => fs.readFileSync(path.join(s.dir, 'journal', n), 'utf8'));
    assert.ok(lines.some((t) => /unreachable after 5 failed polls/.test(t)));
    assert.strictEqual(new PlanStore(s.dir).read().steps[0].state, 'failed');
  });
});

describe('pollWakeup', () => {
  it('reports material on a change and quiet otherwise', async () => {
    const s = await setup();
    const job = await submitted(s);
    const wakeup = { id: job.wakeupId, kind: 'poll-executor', payload: { key: `poll:${job.id}`, executor: 'fake-agent', jobId: job.id } };
    assert.deepStrictEqual(await s.reg.pollWakeup(s.meta.id, wakeup), { material: true }, 'first snapshot');
    assert.deepStrictEqual(await s.reg.pollWakeup(s.meta.id, wakeup), { material: false });
    s.ctl.jobs.get('ext-1').state = 'waiting';
    s.ctl.jobs.get('ext-1').lastChange = '2026-10-26T15:20:00Z';
    assert.deepStrictEqual(await s.reg.pollWakeup(s.meta.id, wakeup), { material: true });
  });
});

describe('cancel', () => {
  it('cancels at the executor, stops polling and fails the step', async () => {
    const s = await setup();
    const job = await submitted(s);
    const r = await jobs.cancelJob(s.reg, s.meta.id, job.id, 'cancelled');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(s.ctl.calls.filter((c) => c[0] === 'cancel'), [['cancel', 'ext-1']]);
    const j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.wakeupId], ['cancelled', null]);
    const step = new PlanStore(s.dir).read().steps[0];
    assert.deepStrictEqual([step.state, step.reason], ['failed', 'cancelled']);
    assert.deepStrictEqual(await jobs.cancelJob(s.reg, s.meta.id, job.id, 'again'), { ok: false, error: `${job.id} is already cancelled.` });
  });

  it('releases the reservation of a job cancelled while submitting', async () => {
    const s = await setup();
    await s.reg.reserveContacts('fake-agent', 2, { caseId: s.meta.id });
    const job = new JobStore(s.dir).create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', state: 'submitting', reservedContacts: 2 });
    assert.strictEqual(s.reg.globalRemaining('fake-agent'), 3);
    await jobs.cancelJob(s.reg, s.meta.id, job.id, 'case paused');
    assert.strictEqual(s.reg.globalRemaining('fake-agent'), 5);
  });

  it('cancelOpenJobs cancels every open job of the case', async () => {
    const s = await setup();
    const job = await submitted(s);
    assert.deepStrictEqual(await s.reg.cancelOpenJobs(s.meta.id, 'case abandoned'), { cancelled: [job.id] });
    assert.deepStrictEqual(await s.reg.cancelOpenJobs(s.meta.id, 'again'), { cancelled: [] });
  });
});

describe('reconcile and background output', () => {
  it('commits a submitting job the executor has, fails one it does not', async () => {
    const s = await setup({ findByExternalRef: true });
    seed(s.dir);
    const store = new JobStore(s.dir);
    const known = store.create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', state: 'submitting', recipients: ['+15550100'], envelopeId: 'env-01' });
    const lost = store.create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', state: 'submitting', recipients: ['+15550101'] });
    const adapter = await s.reg.adapter('fake-agent');
    await adapter.submit({ ...known, externalRef: `${s.meta.id}/${known.id}` }, null);
    const out = await jobs.reconcileSubmitting(s.reg, s.meta.id);
    assert.deepStrictEqual(out, [{ jobId: known.id, state: 'submitted' }, { jobId: lost.id, state: 'failed' }]);
    assert.deepStrictEqual([store.get(lost.id).state, store.get(lost.id).reason], ['failed', 'interrupted']);
    assert.strictEqual(store.get(known.id).externalId, 'ext-1');
  });

  it('copies finished background output into sources/', async () => {
    const s = await setup();
    const job = new JobStore(s.dir).create({ caseId: s.meta.id, executor: 'runbook', kind: 'runbook', state: 'running' });
    const run = jobs.runDir(s.reg, s.meta.id, job.id);
    writeJsonAtomic(path.join(run, 'output.json'), { success: true });
    assert.deepStrictEqual(await jobs.copyBackgroundOutput(s.reg, s.meta.id), [], 'nothing until the run finishes');
    jobs.writeRunStatus(s.reg, s.meta.id, job.id, { state: 'done', finishedAt: '2026-10-26T15:30:00Z' });
    assert.deepStrictEqual(await jobs.copyBackgroundOutput(s.reg, s.meta.id), [job.id]);
    assert.deepStrictEqual(readJsonSafe(path.join(s.dir, 'sources', 'runbook', job.id, 'output.json'), null), { success: true });
    assert.deepStrictEqual([new JobStore(s.dir).get(job.id).state, new JobStore(s.dir).get(job.id).copied], ['done', true]);
  });
});

// Binding carries (Task 7 review, progress ledger): adapter states are
// validated before any side effect, a charge lands exactly once across
// crashes and late cancels, and a failed submit releases its reservation.
const { Budget } = require('../src/cases/budget');

function newJob({ reg, meta, dir }, over = {}) {
  seed(dir);
  const payload = { recipients: [{ address: '+15550100' }], text: 'Hello about the lot', attemptsPerContact: 1 };
  return new JobStore(dir).create({
    caseId: meta.id, executor: 'fake-agent', kind: 'external', envelopeId: 'env-01', planStepId: 's1', n: 1,
    signature: 'sig-1', payloadHash: 'hash-1', intent: 'Ask for a listing quote', recipients: ['+15550100'],
    payload, originalPayload: payload, estimateUsd: 2, newContacts: 1, reservedContacts: 1, createdAt: reg.now().toISOString(), ...over
  });
}

// Makes proto[name] throw once, the way a crash between two writes would
// leave the files; returns the restore function.
function failOnce(proto, name, when = () => true) {
  const orig = proto[name];
  let armed = true;
  proto[name] = function patched(...args) {
    if (armed && when(...args)) {
      armed = false;
      throw new Error(`simulated crash in ${name}`);
    }
    return orig.apply(this, args);
  };
  return () => { proto[name] = orig; };
}

const journalText = (dir) => fs.readdirSync(path.join(dir, 'journal')).map((n) => fs.readFileSync(path.join(dir, 'journal', n), 'utf8')).join('\n');

describe('adapter states are validated before any side effect', () => {
  it('a poll reporting an unknown state is a poll error: nothing charged, the state kept', async () => {
    const s = await setup();
    const job = await submitted(s);
    await s.reg.refreshCase(s.meta.id, { force: true });
    Object.assign(s.ctl.jobs.get('ext-1'), { state: 'in_progress', costUsd: 1.25, lastChange: '2026-10-26T15:05:00Z' });
    const r = await s.reg.refreshCase(s.meta.id, { force: true });
    const j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.stale, j.pollErrors, j.chargedUsd, j.costReported], ['running', true, 1, 0, false]);
    assert.match(j.error, /unknown job state "in_progress"/);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 0);
    assert.strictEqual(new EnvelopeStore(s.dir).get('env-01').usage.usd, 0);
    assert.strictEqual(r.material, false);
    assert.strictEqual(readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null)['fake-agent'].state.jobs[job.id].state, 'running');
  });

  it('the node-only states are refused from an adapter too', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.ctl.jobs.get('ext-1').state = 'unreachable';
    await s.reg.refreshCase(s.meta.id, { force: true });
    const j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.pollErrors], ['submitted', 1]);
    assert.match(j.error, /unknown job state "unreachable"/);
  });

  it('a submit reporting an unknown state fails the job, charges nothing and releases the reservation', async () => {
    const s = await setup();
    await s.reg.reserveContacts('fake-agent', 1, { caseId: s.meta.id });
    const job = newJob(s);
    const adapter = await s.reg.adapter('fake-agent');
    const res = await adapter.submit({ ...job, externalRef: `${s.meta.id}/${job.id}` }, null);
    const out = await jobs.commitSubmit(s.reg, s.meta.id, job, { ...res, state: 'in_progress' });
    assert.deepStrictEqual([out.state, out.externalId, out.reservedContacts], ['failed', 'ext-1', 0]);
    assert.match(out.reason, /unknown job state "in_progress"/);
    const stored = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([stored.state, stored.chargedUsd, stored.wakeupId], ['failed', 0, null]);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'contactsPerDay'), 0);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 0);
    const envelope = new EnvelopeStore(s.dir).get('env-01');
    assert.deepStrictEqual([envelope.payloads, envelope.usage], [[], { usd: 0, contacts: [], attempts: {} }]);
    assert.strictEqual(s.env.runtime.wakeups(s.meta.id).list().some((w) => w.kind === 'poll-executor'), false);
    assert.strictEqual(s.reg.globalRemaining('fake-agent'), 5);
    assert.deepStrictEqual(s.ctl.calls.filter((c) => c[0] === 'cancel'), [['cancel', 'ext-1']], 'the executor is told to drop it');
    assert.strictEqual(new PlanStore(s.dir).read().steps[0].state, 'failed');
  });
});

describe('charges land exactly once', () => {
  it('a crash between the budget and the envelope write never charges the budget twice', async () => {
    const s = await setup();
    const job = await submitted(s);
    Object.assign(s.ctl.jobs.get('ext-1'), { state: 'done', costUsd: 1.25, lastChange: '2026-10-26T15:10:00Z' });
    const restore = failOnce(EnvelopeStore.prototype, 'write');
    try {
      await s.reg.refreshCase(s.meta.id, { force: true });
    } finally {
      restore();
    }
    let j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.chargedUsd, j.pendingCharge.usd], ['submitted', 1.25, 1.25], 'the write-ahead is on disk');
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 1.25);
    assert.strictEqual(new EnvelopeStore(s.dir).get('env-01').usage.usd, 0);
    await s.reg.refreshCase(s.meta.id, { force: true });
    await s.reg.refreshCase(s.meta.id, { force: true });
    j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.chargedUsd, j.pendingCharge], ['done', 1.25, null]);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 1.25, 'not charged again');
    assert.strictEqual(new EnvelopeStore(s.dir).get('env-01').usage.usd, 1.25, 'the envelope is completed once');
  });

  it('a crash before the budget write is reported, never replayed into a double charge', async () => {
    const s = await setup();
    const job = await submitted(s);
    Object.assign(s.ctl.jobs.get('ext-1'), { state: 'done', costUsd: 1.25 });
    const restore = failOnce(Budget.prototype, 'charge', (category) => category === 'usd');
    try {
      await s.reg.refreshCase(s.meta.id, { force: true });
    } finally {
      restore();
    }
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 0);
    await s.reg.refreshCase(s.meta.id, { force: true });
    const j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.chargedUsd, j.pendingCharge], ['done', 1.25, null]);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 0, 'an interrupted charge is not re-applied');
    assert.strictEqual(new EnvelopeStore(s.dir).get('env-01').usage.usd, 1.25);
    assert.match(journalText(s.dir), /charge of \$1\.25 for job-0001 on fake-agent was interrupted/);
  });

  it('the envelope keeps the charged total per job, so completing a charge is idempotent', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.ctl.jobs.get('ext-1').state = 'done';
    await s.reg.refreshCase(s.meta.id, { force: true });
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 2);
    const j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.chargedUsd, new EnvelopeStore(s.dir).get('env-01').usage.charged], [2, { [job.id]: 2 }]);
  });

  it('a cancel landing while a poll is out wins; the poll charges nothing', async () => {
    const s = await setup();
    const job = await submitted(s);
    Object.assign(s.ctl.jobs.get('ext-1'), { state: 'done', costUsd: 1.25 });
    const adapter = await s.reg.adapter('fake-agent');
    const status = adapter.status;
    adapter.status = async (id) => {
      const out = await status(id);
      await jobs.cancelJob(s.reg, s.meta.id, job.id, 'case paused');
      return { ...out, state: 'done' };
    };
    try {
      await s.reg.refreshCase(s.meta.id, { force: true });
    } finally {
      adapter.status = status;
    }
    const j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.chargedUsd, j.costReported], ['cancelled', 2, false], 'the cancel charged the estimate');
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 2);
    assert.strictEqual(new EnvelopeStore(s.dir).get('env-01').usage.usd, 2);
  });

  it('a commit interrupted halfway is finished by reconcile without charging contacts twice', async () => {
    const s = await setup();
    const job = newJob(s);
    const adapter = await s.reg.adapter('fake-agent');
    const res = await adapter.submit({ ...job, externalRef: `${s.meta.id}/${job.id}` }, null);
    const restore = failOnce(PlanStore.prototype, 'updateStep');
    try {
      await assert.rejects(jobs.commitSubmit(s.reg, s.meta.id, job, res), /simulated crash/);
    } finally {
      restore();
    }
    const half = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([half.state, half.externalId, half.contactsCharged], ['submitting', 'ext-1', true]);
    assert.deepStrictEqual(await jobs.reconcileSubmitting(s.reg, s.meta.id), [{ jobId: job.id, state: 'submitted' }]);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'contactsPerDay'), 1);
    const envelope = new EnvelopeStore(s.dir).get('env-01');
    assert.deepStrictEqual([envelope.payloads.length, envelope.usage.attempts], [1, { '+15550100': 1 }]);
    assert.strictEqual(s.env.runtime.wakeups(s.meta.id).list().filter((w) => w.kind === 'poll-executor').length, 1);
  });
});

// Fix round 1 (Task 9 review).
const { CaseRecords } = require('../src/cases/records');

describe('fix round 1', () => {
  it('a lower reported cost never refunds; the decrease is journaled', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.ctl.jobs.get('ext-1').costUsd = 15;
    await s.reg.refreshCase(s.meta.id, { force: true });
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 15);
    s.ctl.jobs.get('ext-1').costUsd = 0;
    await s.reg.refreshCase(s.meta.id, { force: true });
    await s.reg.refreshCase(s.meta.id, { force: true });
    assert.strictEqual(new JobStore(s.dir).get(job.id).chargedUsd, 15);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 15);
    assert.strictEqual(new EnvelopeStore(s.dir).get('env-01').usage.usd, 15);
    const notes = journalText(s.dir).match(/reported a cost of \$0\.00 for job-0001, below the \$15\.00 already charged/g) || [];
    assert.strictEqual(notes.length, 1, 'journaled once, not on every poll');
  });

  it('a reported cost above maxCostUsd is recorded in full and journaled', async () => {
    const s = await setup();
    const job = await submitted(s, { maxCostUsd: 1 });
    s.ctl.jobs.get('ext-1').costUsd = 1.25;
    await s.reg.refreshCase(s.meta.id, { force: true });
    assert.strictEqual(new JobStore(s.dir).get(job.id).chargedUsd, 1.25);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'usd'), 1.25);
    assert.match(journalText(s.dir), /reported a cost of \$1\.25 for job-0001, above the \$1\.00 maximum sent at submit/);
  });

  it('an external submit without a job id fails the submit', async () => {
    const s = await setup();
    await s.reg.reserveContacts('fake-agent', 1, { caseId: s.meta.id });
    const job = newJob(s);
    const out = await jobs.commitSubmit(s.reg, s.meta.id, job, { contacts: [] });
    assert.deepStrictEqual([out.state, out.reason, out.reservedContacts], ['failed', 'the executor returned no job id', 0]);
    assert.strictEqual(budgetSpent(s.env, s.meta.id, 'contactsPerDay'), 0);
    assert.strictEqual(s.reg.globalRemaining('fake-agent'), 5);
    assert.strictEqual(new PlanStore(s.dir).read().steps[0].state, 'failed');
    assert.strictEqual(s.env.runtime.wakeups(s.meta.id).list().some((w) => w.kind === 'poll-executor'), false);
  });

  it('an open external job with no external id is a poll error, not a quiet success', async () => {
    const s = await setup();
    const job = newJob(s, { state: 'submitted' });
    await s.reg.refreshCase(s.meta.id, { force: true });
    const j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.pollErrors, j.stale], ['submitted', 1, true]);
    assert.match(j.error, /no external id/);
  });

  it('adapter text is cut to 300 characters', async () => {
    const s = await setup();
    const job = await submitted(s);
    const adapter = await s.reg.adapter('fake-agent');
    const status = adapter.status;
    adapter.status = async () => ({ state: 'x'.repeat(5000), costUsd: 'y'.repeat(5000) });
    try {
      await s.reg.refreshCase(s.meta.id, { force: true });
      adapter.status = async () => { throw new Error('z'.repeat(5000)); };
      s.env.settings.executors.maxPollErrors = 2;
      await s.reg.refreshCase(s.meta.id, { force: true });
    } finally {
      adapter.status = status;
    }
    const j = new JobStore(s.dir).get(job.id);
    assert.strictEqual(j.state, 'unreachable');
    assert.ok(j.error.length <= 300 && j.reason.length <= 300, 'error and reason are cut');
    const snap = readJsonSafe(path.join(s.dir, '.kl', 'executors.json'), null)['fake-agent'];
    assert.ok(JSON.stringify(snap).length < 1000, 'the snapshot carries no long adapter text');
    for (const n of fs.readdirSync(path.join(s.dir, 'journal'))) {
      assert.ok(!/z{301}/.test(fs.readFileSync(path.join(s.dir, 'journal', n), 'utf8')), `${n} has no long adapter text`);
    }
  });

  it('the unreachable job is saved even when its journal line fails', async () => {
    const s = await setup();
    const job = await submitted(s);
    s.env.settings.executors.maxPollErrors = 1;
    s.ctl.statusThrows = 1;
    const restore = failOnce(CaseRecords.prototype, 'writeJournal', (kind, text) => /unreachable/.test(String(text)));
    try {
      await s.reg.refreshCase(s.meta.id, { force: true });
    } finally {
      restore();
    }
    const j = new JobStore(s.dir).get(job.id);
    assert.deepStrictEqual([j.state, j.wakeupId], ['unreachable', null]);
  });

  it('refreshCase never throws: an index or snapshot failure is logged', async () => {
    const s = await setup();
    const job = await submitted(s);
    const indexJob = s.reg.indexJob;
    s.reg.indexJob = async () => { throw new Error('index down'); };
    fs.mkdirSync(path.join(s.dir, '.kl', 'executors.json'), { recursive: true });
    try {
      const r = await s.reg.refreshCase(s.meta.id, { force: true });
      assert.strictEqual(r.material, false);
    } finally {
      s.reg.indexJob = indexJob;
    }
    assert.strictEqual(new JobStore(s.dir).get(job.id).state, 'running', 'the poll itself was saved');
  });

  it('copyBackgroundOutput re-reads the job, refuses unknown run states and marks copied once', async () => {
    const s = await setup();
    const store = new JobStore(s.dir);
    const first = store.create({ caseId: s.meta.id, executor: 'runbook', kind: 'runbook', state: 'running' });
    const late = store.create({ caseId: s.meta.id, executor: 'runbook', kind: 'runbook', state: 'running' });
    const odd = store.create({ caseId: s.meta.id, executor: 'runbook', kind: 'runbook', state: 'running' });
    for (const j of [first, late]) {
      writeJsonAtomic(path.join(jobs.runDir(s.reg, s.meta.id, j.id), 'output.json'), { success: true });
      jobs.writeRunStatus(s.reg, s.meta.id, j.id, { state: 'done', finishedAt: '2026-10-26T15:30:00Z' });
    }
    writeJsonAtomic(path.join(jobs.runDir(s.reg, s.meta.id, odd.id), 'output.json'), { success: true });
    jobs.writeRunStatus(s.reg, s.meta.id, odd.id, { state: 'finished' });
    // A cancel lands while the loop awaits the index write of the first job.
    const indexJob = s.reg.indexJob.bind(s.reg);
    let once = true;
    s.reg.indexJob = async (caseId, job) => {
      if (once) {
        once = false;
        store.update(late.id, { state: 'cancelled', reason: 'case paused' });
      }
      return indexJob(caseId, job);
    };
    try {
      assert.deepStrictEqual(await jobs.copyBackgroundOutput(s.reg, s.meta.id), [first.id, late.id]);
    } finally {
      s.reg.indexJob = indexJob;
    }
    assert.deepStrictEqual([store.get(first.id).state, store.get(first.id).copied], ['done', true]);
    assert.deepStrictEqual([store.get(late.id).state, store.get(late.id).copied], ['cancelled', true]);
    assert.deepStrictEqual([store.get(odd.id).state, store.get(odd.id).copied], ['running', false]);
    assert.deepStrictEqual(await jobs.copyBackgroundOutput(s.reg, s.meta.id), [], 'never copied twice');
  });
});
