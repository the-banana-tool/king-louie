// tests/cases-executor-service.test.js
// The unattended round trip (spec §10): submit → the sweep polls without a
// model → a material change queues a turn → results → commit. A quiet poll
// queues nothing.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fx = require('./helpers/executor-fixtures');
const { startFakeErrandsServer } = require('./helpers/fake-errands-server');
const { computePackageSha256 } = require('../src/cases/executors/package-loader');
const envelopeOps = require('../src/cases/executors/envelope-ops');
const { submitJob } = require('../src/cases/executors/submit');
const { fetchResults } = require('../src/cases/executors/results');

let server;
before(async () => { server = await startFakeErrandsServer(); });
after(async () => {
  await server.close();
  fx.cleanup();
});

describe('phone-agent in an unattended case', () => {
  it('polls quietly, wakes on a material change, saves results and commits them', async () => {
    // Real service mode (M22): entries and package roots come only from the
    // admin service.json; the root ownership check is the test's own.
    const admin = { entries: {}, packageRoots: [] };
    const env = fx.setupExecutors({
      registryOptions: {
        isService: true, adminExecutors: admin, assertRoot: () => {},
        ...(typeof process.getuid === 'function' ? { adminUid: process.getuid() } : {})
      }
    });
    admin.packageRoots.push(env.packageRoot);
    const dir = path.join(env.packageRoot, 'phone-agent');
    fs.cpSync(path.join(__dirname, '..', 'examples', 'executors', 'phone-agent'), dir, { recursive: true });
    admin.entries = {
      'phone-agent': {
        kind: 'external-agent', package: 'phone-agent', packageSha256: computePackageSha256(dir),
        config: { baseUrl: server.url, token: '${vault:errands-token}' },
        constraints: { contactsPerDay: 5 }, cost: { perJob: 0.5, perContact: 0.25, perAttempt: 0.1 }, latency: 'async-hours', pollEveryMs: 60000
      }
    };
    const rt = env.runtime;
    const reg = env.registry;
    assert.deepStrictEqual([reg.isService, reg.get('phone-agent').available], [true, true]);
    rt.addTurnStartHook('executors', (ctx) => reg.turnStartHook(ctx));
    const meta = await fx.activeCase(rt);
    const ctx = { caseId: meta.id, turnId: 'turn-1' };

    const { turn } = await fx.openTurn(rt, meta.id);
    const env1 = await envelopeOps.requestEnvelope(reg, ctx, {
      executor: 'phone-agent', intent: 'Ask a broker for a listing quote', recipients: { allow: ['+15550100'] },
      caps: { usd: 10, contacts: 1, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30' }
    });
    await rt.answerQuestion(meta.id, env1.questionId, { channel: 'in-app', optionId: 'approve' });
    envelopeOps.syncEnvelopes(reg, meta.id);
    const sub = await submitJob(reg, ctx, {
      executor: 'phone-agent', envelopeId: env1.envelopeId,
      payload: JSON.stringify({ recipients: [{ address: '+15550100' }], text: 'Hello, we would like a listing quote for the lot.', attemptsPerContact: 2 })
    });
    assert.deepStrictEqual([sub.ok, sub.externalId], [true, 'job_1'], sub.error);
    assert.strictEqual(server.state.requests.at(-1).body.externalRef, `${meta.id}/job-0001`);
    await reg.refreshCase(meta.id, { force: true });
    await rt.endTurn(turn, { summary: 'submitted the call' });
    const turnsAfterOwner = rt.budget(meta.id).status().turnsPerDay.spent;

    env.clock.now = new Date(env.clock.now.getTime() + 61000);
    const pollId = reg.jobs(meta.id).get('job-0001').wakeupId;
    const quiet = await rt.sweep(meta.id, env.clock.now);
    assert.deepStrictEqual([quiet.due.includes(pollId), quiet.quiet], [false, 1], 'a quiet poll queues no turn');

    server.setJob('job_1', { state: 'done', costUsd: 1.1 });
    server.addRecord('job_1', { id: 'r1', contactId: 'c1', kind: 'call', at: '2026-10-26T15:10:00Z', summary: 'Broker will send a quote by email', outcome: 'answered', fields: {} });
    env.clock.now = new Date(env.clock.now.getTime() + 61000);
    const woke = await rt.sweep(meta.id, env.clock.now);
    assert.ok(woke.due.includes(pollId), 'a material change queues a turn');
    assert.strictEqual(rt.budget(meta.id).status().turnsPerDay.spent, turnsAfterOwner, 'polling charges no turns');
    assert.strictEqual(rt.budget(meta.id).status().usd.spent, 1.1);

    const next = await rt.beginTurn(meta.id, { turnId: 'turn-2', source: 'wakeup' });
    next.reorientPending = false;
    const results = await fetchResults(reg, { caseId: meta.id, turnId: 'turn-2' }, { jobId: 'job-0001' });
    assert.deepStrictEqual(results.saved, ['sources/phone-agent/job-0001/r1.json']);
    await rt.endTurn(next, { summary: 'saved the call record' });
    const files = execFileSync('git', ['log', '-1', '--name-only', '--pretty=format:'], { cwd: meta.dir }).toString();
    assert.match(files, /sources\/phone-agent\/job-0001\/r1\.json/);
    const facts = [...rt.ledger(meta.id).view().facts.values()].filter((f) => f.provenance === 'external-agent');
    assert.deepStrictEqual(facts.map((f) => [f.subject, f.attr, f.value]), [['contact:c1', 'call-outcome', 'answered']]);
  });
});
