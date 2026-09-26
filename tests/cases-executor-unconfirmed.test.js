// tests/cases-executor-unconfirmed.test.js
// C3 final review I1 and I3, against the reference phone-agent package and
// the in-process errands server:
// - an ambiguous submit (a 5xx, a timeout, a network error) keeps the job
//   submitting with its contacts held, and a later turn or sweep reconciles
//   it to ONE job with the same idempotency key, contacts reserved once and
//   cost charged once; a clear 4xx fails it and frees its contacts;
// - the sweep's executor polls run outside the case lock, so an owner
//   message during a slow poll is not refused as busy.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { startFakeErrandsServer } = require('./helpers/fake-errands-server');
const { computePackageSha256 } = require('../src/cases/executors/package-loader');
const envelopeOps = require('../src/cases/executors/envelope-ops');
const { submitJob } = require('../src/cases/executors/submit');

let server;
before(async () => { server = await startFakeErrandsServer(); });
after(async () => {
  await server.close();
  fx.cleanup();
});

function resetServer() {
  server.state.jobs.clear();
  server.state.idempotency.clear();
  server.state.requests.length = 0;
  server.state.seq = 0;
  Object.assign(server.knobs, { failNextStatus: null, latencyMs: 0, status422: false, status5xx: false, failAfterWrite: null, postStatus: null });
}

async function setup({ executors = {} } = {}) {
  resetServer();
  const env = fx.setupExecutors({ executors });
  const dir = path.join(env.packageRoot, 'phone-agent');
  fs.cpSync(path.join(__dirname, '..', 'examples', 'executors', 'phone-agent'), dir, { recursive: true });
  env.settings.executors.entries = {
    'phone-agent': {
      kind: 'external-agent', package: 'phone-agent', packageSha256: computePackageSha256(dir),
      config: { baseUrl: server.url, token: '${vault:errands-token}' },
      constraints: { contactsPerDay: 5 }, cost: { perJob: 0.5, perContact: 0.25, perAttempt: 0.1 }, latency: 'async-hours', pollEveryMs: 60000
    }
  };
  const rt = env.runtime;
  const reg = env.registry;
  const meta = await fx.activeCase(rt);
  const ctx = { caseId: meta.id, turnId: 'turn-1' };
  const req = await envelopeOps.requestEnvelope(reg, ctx, {
    executor: 'phone-agent', intent: 'Ask a broker for a listing quote', recipients: { allow: ['+15550100'] },
    caps: { usd: 10, contacts: 1, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30' }
  });
  await rt.answerQuestion(meta.id, req.questionId, { channel: 'in-app', optionId: 'approve' });
  envelopeOps.syncEnvelopes(reg, meta.id);
  const submit = () => submitJob(reg, ctx, {
    executor: 'phone-agent', envelopeId: req.envelopeId,
    payload: JSON.stringify({ recipients: [{ address: '+15550100' }], text: 'Hello, we would like a listing quote for the lot.', attemptsPerContact: 2 })
  });
  const later = (ms = 61000) => { env.clock.now = new Date(env.clock.now.getTime() + ms); return env.clock.now; };
  return { env, rt, reg, meta, submit, later };
}

const posts = () => server.state.requests.filter((r) => r.method === 'POST' && r.path === '/jobs');
const spent = (s, category) => s.rt.budget(s.meta.id).status()[category].spent;

describe('an unconfirmed submit', () => {
  it('a 5xx after the write stays submitting, then the sweep reconciles it to one job, charged once', async () => {
    const s = await setup();
    server.knobs.failAfterWrite = 503;
    const r = await s.submit();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /did not confirm job-0001 \(failed after the write\); it may already be running/);
    const held = s.reg.jobs(s.meta.id).get('job-0001');
    assert.deepStrictEqual([held.state, held.unconfirmed, typeof held.wakeupId], ['submitting', true, 'string']);
    assert.strictEqual(s.reg.globalRemaining('phone-agent'), 4, 'the contact stays reserved');

    await s.rt.sweep(s.meta.id, s.later());
    const job = s.reg.jobs(s.meta.id).get('job-0001');
    assert.deepStrictEqual([job.state, job.externalId], ['submitted', 'job_1']);
    assert.strictEqual(server.state.jobs.size, 1, 'one job at the executor');
    assert.strictEqual(posts().length, 1, 'found by externalRef, not posted again');
    assert.strictEqual(s.reg.globalRemaining('phone-agent'), 4, 'reserved once');
    assert.strictEqual(spent(s, 'contactsPerDay'), 1, 'one contact charged');

    server.setJob('job_1', { state: 'done', costUsd: 1.1 });
    await s.rt.sweep(s.meta.id, s.later());
    await s.reg.refreshCase(s.meta.id, { force: true });
    assert.strictEqual(spent(s, 'usd'), 1.1, 'cost charged once');
    assert.strictEqual(s.reg.jobs(s.meta.id).get('job-0001').state, 'done');
  });

  it('a request the executor never got is resubmitted with the same idempotency key at the next turn start', async () => {
    const s = await setup();
    s.rt.addTurnStartHook('executors', (ctx) => s.reg.turnStartHook(ctx));
    server.knobs.failNextStatus = 502;
    const r = await s.submit();
    assert.match(r.error, /it may already be running/);
    assert.strictEqual(server.state.jobs.size, 0);
    const { turn } = await fx.openTurn(s.rt, s.meta.id, { turnId: 'turn-2' });
    await s.rt.endTurn(turn, { summary: 'reconciled' });
    const job = s.reg.jobs(s.meta.id).get('job-0001');
    assert.deepStrictEqual([job.state, job.externalId], ['submitted', 'job_1']);
    const keys = posts().map((p) => p.headers['idempotency-key']);
    assert.strictEqual(keys.length, 2);
    assert.strictEqual(keys[0], keys[1], 'the resubmit reuses the key');
    assert.strictEqual(server.state.jobs.size, 1);
    assert.strictEqual(s.reg.globalRemaining('phone-agent'), 4);
  });

  it('a timeout (the request aborted) stays submitting and reconciles to the job the executor took', async () => {
    const s = await setup({ executors: { requestTimeoutMs: 150 } });
    server.knobs.latencyMs = 400;
    const r = await s.submit();
    assert.match(r.error, /did not confirm job-0001 .*it may already be running/);
    assert.strictEqual(s.reg.jobs(s.meta.id).get('job-0001').state, 'submitting');
    // The executor finishes taking the job after the node gave up waiting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    server.knobs.latencyMs = 0;
    assert.strictEqual(server.state.jobs.size, 1);
    await s.rt.sweep(s.meta.id, s.later());
    assert.strictEqual(s.reg.jobs(s.meta.id).get('job-0001').state, 'submitted');
    assert.deepStrictEqual([server.state.jobs.size, posts().length], [1, 1]);
    assert.strictEqual(s.reg.globalRemaining('phone-agent'), 4);
  });

  it('a clear 4xx fails the job and frees its contacts', async () => {
    const s = await setup();
    server.knobs.status422 = true;
    const r = await s.submit();
    assert.match(r.error, /^phone-agent refused job-0001: bad request body/);
    assert.strictEqual(s.reg.jobs(s.meta.id).get('job-0001').state, 'failed');
    assert.strictEqual(s.reg.globalRemaining('phone-agent'), 5);
  });

  it('a 4xx on the resubmit fails the held job and frees its contacts', async () => {
    const s = await setup();
    server.knobs.failNextStatus = 503;
    await s.submit();
    assert.strictEqual(s.reg.globalRemaining('phone-agent'), 4);
    server.knobs.postStatus = 422;
    await s.rt.sweep(s.meta.id, s.later());
    const job = s.reg.jobs(s.meta.id).get('job-0001');
    assert.deepStrictEqual([job.state, job.reason], ['failed', 'refused on resubmit: refused with 422']);
    assert.strictEqual(s.reg.globalRemaining('phone-agent'), 5);
  });
});

describe('the sweep and the owner', () => {
  it('an owner message during a slow executor poll is not refused as busy', async () => {
    const s = await setup();
    const r = await s.submit();
    assert.strictEqual(r.ok, true, r.error);
    const now = s.later();
    server.knobs.latencyMs = 600;
    const polls = () => server.state.requests.filter((q) => q.method === 'GET' && q.path === '/jobs/job_1').length;
    const before = polls();
    const sweeping = s.rt.runDueWakeups(now);
    while (polls() === before) await new Promise((resolve) => setTimeout(resolve, 10));
    // The poll is out on the network now; the owner's turn gets the case.
    const turn = await s.rt.beginTurn(s.meta.id, { turnId: 'owner-1' });
    turn.reorientPending = false;
    await s.rt.endTurn(turn, { summary: 'owner message' });
    server.knobs.latencyMs = 0;
    await sweeping;
    assert.strictEqual(s.reg.jobs(s.meta.id).get('job-0001').state, 'submitted');
  });
});
