// tests/cases-executor-registry.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { ExecutorUnavailableError, JobStore } = require('../src/cases/executors');
const { writeJsonAtomic, readJsonSafe } = require('../src/cases/executors/util');

after(fx.cleanup);

describe('resolution', () => {
  it('lists the built-ins with their availability on this node', () => {
    const env = fx.setupExecutors();
    const list = env.registry.list();
    assert.deepStrictEqual(list.map((e) => e.id), ['bash', 'files', 'web', 'browser', 'workflow', 'runbook', 'owner']);
    assert.deepStrictEqual(['runbook', 'workflow'].map((id) => list.find((e) => e.id === id).reason), [
      'no runbook engine on this node', 'no workflow engine on this node'
    ]);
    const hosted = fx.setupExecutors({ registryOptions: { getWorkflowEngine: () => ({}), getRunbookEngine: () => ({}) } });
    assert.ok(hosted.registry.list().every((e) => e.available));
  });

  it('lets settings change a built-in\'s constraints, never its kind or authority', () => {
    const env = fx.setupExecutors({ executors: { entries: { browser: { constraints: { contactsPerDay: 5 }, authority: 'none', kind: 'owner' } } } });
    const b = env.registry.get('browser');
    assert.deepStrictEqual([b.kind, b.authority, b.outbound, b.constraints.contactsPerDay], ['tool', 'envelope', 'message', 5]);
    assert.deepStrictEqual(b.warnings, [
      'browser: "authority" cannot be changed on a built-in executor; ignored',
      'browser: "kind" cannot be changed on a built-in executor; ignored'
    ]);
  });

  it('adds a pinned external agent and applies the floors (R42)', () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env, 'fake-agent', { entry: { authority: 'none', outbound: 'query' } });
    const e = env.registry.get('fake-agent');
    assert.strictEqual(e.available, true, e.reason);
    assert.deepStrictEqual([e.kind, e.capabilities, e.cannot, e.outbound, e.authority], [
      'external-agent', ['call', 'voicemail'], ['web-form', 'email', 'sms'], 'message', 'envelope'
    ]);
    assert.deepStrictEqual(e.warnings, [
      'fake-agent: outbound capabilities (call) keep outbound at "message"',
      'fake-agent: outbound capabilities (call) keep authority at "envelope" or above'
    ]);
    assert.deepStrictEqual(e.payloadSchema, { venue: { type: 'string' } });
    assert.strictEqual(e.config, undefined, 'config is not listed');
  });

  it('marks an unpinned package unavailable and shows the computed pin', () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env, 'fake-agent', { entry: { packageSha256: null } });
    const e = env.registry.get('fake-agent');
    assert.strictEqual(e.available, false);
    assert.strictEqual(e.reason, `pin required: set packageSha256 to ${e.computedSha256}`);
    assert.match(e.computedSha256, /^[0-9a-f]{64}$/);
  });

  it('refuses a configured id that is not a slug, and never throws from list', () => {
    const env = fx.setupExecutors({ executors: { entries: { 'Bad Id': { kind: 'external-agent', package: 'x' } } } });
    const bad = env.registry.list().find((e) => e.id === 'Bad Id');
    assert.deepStrictEqual([bad.available, bad.reason], [false, 'executor ids are lowercase slugs of 2 to 40 characters']);
  });

  it('narrows with a per-case override and ignores anything that widens', async () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env);
    const c = await env.runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    writeJsonAtomic(path.join(c.dir, '.kl', 'executors.json'), {
      'fake-agent': {
        override: {
          capabilities: ['call', 'sms'], constraints: { contactsPerDay: 10 }, authority: 'none',
          briefRules: ["Say the owner's first name only"], cost: { perJob: 0 }
        }
      }
    });
    const e = env.registry.get('fake-agent', { caseId: c.id });
    assert.deepStrictEqual([e.capabilities, e.constraints.contactsPerDay, e.authority], [['call'], 5, 'envelope']);
    assert.deepStrictEqual(e.overrideBriefRules, ["Say the owner's first name only"]);
    assert.deepStrictEqual(e.warnings.sort(), [
      'fake-agent: override "cost" would widen the executor; ignored',
      'fake-agent: override authority would widen the executor; ignored',
      'fake-agent: override capabilities sms would widen the executor; ignored',
      'fake-agent: override contactsPerDay would widen the executor; ignored'
    ]);
    assert.deepStrictEqual(env.registry.get('fake-agent').capabilities, ['call', 'voicemail'], 'other cases are unchanged');
    writeJsonAtomic(path.join(c.dir, '.kl', 'executors.json'), { browser: { override: { disabled: true, constraints: { callingWindow: { tz: 'UTC', start: '10:00', end: '12:00', weekdays: [1, 2] } } } } });
    const b = env.registry.get('browser', { caseId: c.id });
    assert.deepStrictEqual([b.available, b.reason, b.constraints.callingWindow], [false, 'disabled for this case', { tz: 'UTC', start: '10:00', end: '12:00', weekdays: [1, 2] }]);
  });

  it('in service mode takes entries only from the admin config and admin roots', () => {
    const env = fx.setupExecutors({ registryOptions: { isService: true, adminExecutors: { entries: {}, packageRoots: [] } } });
    fx.withFakeAgent(env);
    assert.strictEqual(env.registry.get('fake-agent'), null, 'a data-dir entry is ignored');
    const admin = { entries: { ...env.settings.executors.entries }, packageRoots: [env.packageRoot] };
    // The per-entry ownership check (POSIX) is bound to adminUid: the test
    // process owns the fixture files.
    const adminUid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const svc = fx.setupExecutors({ registryOptions: { isService: true, adminExecutors: admin, packageRoot: env.packageRoot, assertRoot: () => {}, adminUid } });
    assert.strictEqual(svc.registry.get('fake-agent').available, true, svc.registry.get('fake-agent').reason);
  });

  it('in service mode binds the default root check to the service adminUid (M16)', () => {
    const serviceConfig = require('../src/service/config');
    const env = fx.setupExecutors();
    fx.withFakeAgent(env);
    const admin = { entries: { ...env.settings.executors.entries }, packageRoots: [env.packageRoot] };
    const seen = [];
    const real = serviceConfig.assertAdminOwned;
    serviceConfig.assertAdminOwned = (root, geteuid, adminUid) => seen.push([root, geteuid(), adminUid]);
    try {
      const svc = fx.setupExecutors({ registryOptions: { isService: true, adminExecutors: admin, packageRoot: env.packageRoot, adminUid: 4242, geteuid: () => 7 } });
      svc.registry.get('fake-agent');
    } finally {
      serviceConfig.assertAdminOwned = real;
    }
    assert.deepStrictEqual(seen.map(([, euid, uid]) => [euid, uid]), [[7, 4242]]);
    assert.strictEqual(fs.realpathSync.native(seen[0][0]), fs.realpathSync.native(env.packageRoot));
  });
});

describe('adapters and brief rules', () => {
  it('loads an adapter once and refuses an unavailable executor', async () => {
    const env = fx.setupExecutors();
    const ctl = fx.withFakeAgent(env);
    const a = await env.registry.adapter('fake-agent');
    assert.strictEqual(await env.registry.adapter('fake-agent'), a);
    assert.strictEqual(ctl.config.token, 'tok-test');
    await assert.rejects(env.registry.adapter('runbook'), (err) => err instanceof ExecutorUnavailableError && err.code === 'EXECUTOR_UNAVAILABLE');
    await assert.rejects(env.registry.adapter('nope'), /nope is unavailable: not a known executor/);
  });

  it('orders brief rules adapter, override, extra sources, without duplicates', async () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env, 'fake-agent', { briefRules: ['Say who you are calling for.', 'Shared rule'] });
    const c = await env.runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    writeJsonAtomic(path.join(c.dir, '.kl', 'executors.json'), { 'fake-agent': { override: { briefRules: ["Say the owner's first name only", 'Shared rule'] } } });
    env.registry.registerExtraBriefRules((id, caseId) => (id === 'fake-agent' && caseId === c.id ? ['From a playbook'] : []));
    assert.deepStrictEqual(env.registry.briefRules('fake-agent', { caseId: c.id }), ["Say the owner's first name only", 'Shared rule', 'From a playbook']);
    await env.registry.adapter('fake-agent');
    assert.deepStrictEqual(env.registry.briefRules('fake-agent', { caseId: c.id }), [
      'Say who you are calling for.', 'Shared rule', "Say the owner's first name only", 'From a playbook'
    ]);
  });
});

describe('jobs', () => {
  it('numbers jobs by replay in the case', async () => {
    const env = fx.setupExecutors();
    const c = await env.runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    const store = new JobStore(c.dir);
    const a = store.create({ executor: 'fake-agent', state: 'submitting' });
    const b = store.create({ executor: 'fake-agent', state: 'submitting' });
    assert.deepStrictEqual([a.id, b.id], ['job-0001', 'job-0002']);
    assert.strictEqual(store.update('job-0001', { state: 'running' }).state, 'running');
    assert.deepStrictEqual(env.registry.jobs(c.id).list().map((j) => j.id), ['job-0001', 'job-0002']);
  });

  it('liveState lists open jobs across cases in the C5 shape', async () => {
    const env = fx.setupExecutors();
    await env.registry.indexJob('case-a', { id: 'job-0001', executor: 'fake-agent', state: 'running', signature: 's1', intent: 'Ask for a quote', recipients: ['+15550100'] });
    await env.registry.indexJob('case-a', { id: 'job-0002', executor: 'fake-agent', state: 'done', signature: 's2', intent: 'x', recipients: [] });
    await env.registry.indexJob('case-b', { id: 'job-0001', executor: 'browser', state: 'submitting', signature: 's3', intent: 'File', recipients: ['https://permits.example.com'] });
    assert.deepStrictEqual(env.registry.liveState({ caseId: 'case-a' }), [{
      jobId: 'job-0001', executorId: 'fake-agent', signature: 's1', state: 'running', caseId: 'case-a', intent: 'Ask for a quote', recipients: ['+15550100']
    }]);
    assert.deepStrictEqual(env.registry.liveState().map((r) => `${r.caseId}/${r.jobId}`), ['case-a/job-0001', 'case-b/job-0001']);
  });
});

describe('global daily cap', () => {
  it('global cap is shared across cases under the mutex', async () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env);
    const [a, b] = await Promise.all([
      env.registry.reserveContacts('fake-agent', 3, { caseId: 'case-a' }),
      env.registry.reserveContacts('fake-agent', 3, { caseId: 'case-b' })
    ]);
    assert.deepStrictEqual([a.ok, b.ok], [true, false]);
    assert.strictEqual(b.error, 'fake-agent daily cap 5 reached (used by 1 case); resets 2026-10-27 00:00 UTC');
    const usage = readJsonSafe(path.join(env.dataDir, 'executors', 'usage.json'), null);
    assert.deepStrictEqual(usage['fake-agent'], { day: '2026-10-26', tz: 'UTC', limit: 5, used: 3, byCase: { 'case-a': 3 } });
    assert.strictEqual(env.registry.globalRemaining('fake-agent'), 2);
    assert.deepStrictEqual(await env.registry.releaseContacts('fake-agent', 1, { caseId: 'case-a' }), { ok: true, released: 1 });
    assert.strictEqual(env.registry.globalRemaining('fake-agent'), 3);
    env.clock.now = new Date('2026-10-27T00:30:00Z');
    assert.strictEqual(env.registry.globalRemaining('fake-agent'), 5, 'the next local day starts fresh');
    assert.deepStrictEqual(await env.registry.reserveContacts('fake-agent', 3, { caseId: 'case-b' }), { ok: true, used: 3, limit: 5, day: '2026-10-27' });
    assert.strictEqual(fs.existsSync(path.join(env.dataDir, 'executors', 'usage.json')), true);
  });

  it('concurrent reserves never overshoot the cap, and the count survives a restart', async () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (
      env.registry.reserveContacts('fake-agent', 1, { caseId: `case-${i % 3}` })
    )));
    assert.strictEqual(results.filter((r) => r.ok).length, 5);
    assert.deepStrictEqual(results.filter((r) => r.ok).map((r) => r.used), [1, 2, 3, 4, 5]);
    const usage = readJsonSafe(path.join(env.dataDir, 'executors', 'usage.json'), null)['fake-agent'];
    assert.strictEqual(usage.used, 5);
    assert.strictEqual(Object.values(usage.byCase).reduce((a, b) => a + b, 0), 5);
    // A new registry over the same data dir (a restart) sees the day's count.
    const { ExecutorRegistry } = require('../src/cases/executors');
    const restarted = new ExecutorRegistry({
      dataDir: env.dataDir, getSettings: () => env.settings, caseRuntime: env.runtime, now: () => env.clock.now, vault: fx.fakeVault()
    });
    assert.strictEqual(restarted.globalRemaining('fake-agent'), 0);
    const again = await restarted.reserveContacts('fake-agent', 1, { caseId: 'case-9' });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.error, 'fake-agent daily cap 5 reached (used by 3 cases); resets 2026-10-27 00:00 UTC');
  });

  it('a corrupt usage file starts the day fresh instead of throwing', async () => {
    const env = fx.setupExecutors();
    fx.withFakeAgent(env);
    writeJsonAtomic(path.join(env.dataDir, 'executors', 'usage.json'), null);
    assert.strictEqual(env.registry.globalRemaining('fake-agent'), 5);
    assert.strictEqual((await env.registry.reserveContacts('fake-agent', 2, { caseId: 'case-a' })).ok, true);
    assert.strictEqual(env.registry.globalRemaining('fake-agent'), 3);
  });

  it('an executor without contactsPerDay has no global cap', async () => {
    const env = fx.setupExecutors();
    assert.strictEqual((await env.registry.reserveContacts('browser', 50, { caseId: 'case-a' })).ok, true);
    assert.strictEqual(env.registry.globalRemaining('browser'), null);
  });
});
