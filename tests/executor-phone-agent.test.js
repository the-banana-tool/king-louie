// tests/executor-phone-agent.test.js
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startFakeErrandsServer } = require('./helpers/fake-errands-server');
const { createAdapter } = require('../examples/executors/phone-agent/adapter');
const { makeHostFetch, checkPackage, loadAdapter, computePackageSha256 } = require('../src/cases/executors/package-loader');

let server;
before(async () => { server = await startFakeErrandsServer(); });
after(() => server.close());
afterEach(() => {
  Object.assign(server.knobs, { failNextStatus: null, normalizeAs: {}, latencyMs: 0, status429: null, status404: false, status422: false, status5xx: false });
});

const silent = { info() {}, warn() {}, error() {}, debug() {} };
function adapter(token = 'tok-test') {
  return createAdapter({ baseUrl: server.url, token }, {
    id: 'phone-agent', log: silent, now: () => new Date(),
    fetch: makeHostFetch({ origins: ['config:baseUrl'], config: { baseUrl: server.url }, requestTimeoutMs: 5000 })
  });
}
const job = (over = {}) => ({
  id: 'job-0001', caseId: 'case-7', externalRef: 'case-7/job-0001', idempotencyKey: 'k-1', intent: 'Ask for a listing quote',
  recipients: ['+15550100'],
  payload: {
    recipients: [{ address: '+1 555 0100', name: 'Harbor Realty' }], text: 'Hello, calling about the lot.', attemptsPerContact: 2,
    expect: [{ subject: 'lot', attr: 'acreage', question: 'What acreage does the listing show?' }], venue: 'phone'
  },
  facts: [{ id: 'f-0001', stmt: 'Lot size is 2.12 acres', value: 2.12 }],
  maxCostUsd: 12.5,
  window: { notBefore: '2026-10-26T14:00:00Z', notAfter: '2026-10-31T04:59:59Z', tz: 'America/Chicago' },
  ...over
});
const code = (c) => (err) => err.name === 'ErrandsError' && err.code === c;

describe('the reference package', () => {
  it('passes the loader checks with its pin', async () => {
    const root = path.join(__dirname, '..', 'examples', 'executors');
    const dir = path.join(root, 'phone-agent');
    const checked = checkPackage({
      id: 'phone-agent', dir, roots: [root],
      entry: { packageSha256: computePackageSha256(dir), config: { baseUrl: 'https://errands.example.com', token: '${vault:errands-token}' } },
      vault: { get: () => 'tok-test' }
    });
    assert.strictEqual(checked.ok, true, checked.error);
    assert.deepStrictEqual(checked.manifest.origins, ['config:baseUrl']);
    const { capabilities } = await loadAdapter(checked, { id: 'phone-agent', entry: {} });
    assert.deepStrictEqual([capabilities.capabilities, capabilities.state], [['call', 'voicemail'], 'poll']);
  });
});

describe('errands API contract', () => {
  it('submits with the idempotency key and the case id in externalRef', async () => {
    const r = await adapter().submit(job(), { intent: 'Ask for a listing quote' });
    assert.strictEqual(r.jobId, 'job_1');
    assert.deepStrictEqual(r.contacts, [{ id: 'c1', address: '+15550100', normalizedAddress: '+15550100' }]);
    const req = server.state.requests.at(-1);
    assert.deepStrictEqual([req.method, req.path, req.headers['idempotency-key'], req.headers.authorization], ['POST', '/jobs', 'k-1', 'Bearer tok-test']);
    assert.deepStrictEqual(req.body, {
      externalRef: 'case-7/job-0001',
      intent: 'Ask for a listing quote',
      text: 'Hello, calling about the lot.',
      recipients: [{ address: '+15550100', name: 'Harbor Realty' }],
      facts: [{ id: 'f-0001', statement: 'Lot size is 2.12 acres', value: 2.12 }],
      expect: [{ key: 'q1', question: 'What acreage does the listing show?' }],
      maxCostUsd: 12.5,
      maxAttemptsPerContact: 2,
      window: { notBefore: '2026-10-26T14:00:00Z', notAfter: '2026-10-31T04:59:59Z', tz: 'America/Chicago' },
      extra: { venue: 'phone' }
    });
  });

  it('a retry reuses the job; the same key with another body is a conflict', async () => {
    const a = adapter();
    const first = await a.submit(job({ idempotencyKey: 'k-2' }), null);
    const again = await a.submit(job({ idempotencyKey: 'k-2' }), null);
    assert.strictEqual(again.jobId, first.jobId);
    await assert.rejects(a.submit(job({ idempotencyKey: 'k-2', intent: 'Something else' }), null), (err) => code('conflict')(err) && err.status === 409);
  });

  it('maps HTTP failures to error codes', async () => {
    const a = adapter();
    await assert.rejects(a.status('job_404'), code('not-found'));
    server.knobs.status422 = true;
    await assert.rejects(a.submit(job({ idempotencyKey: 'k-3' }), null), code('invalid'));
    server.knobs.status422 = false;
    server.knobs.status5xx = true;
    await assert.rejects(a.status('job_1'), code('unavailable'));
    server.knobs.status5xx = false;
    server.knobs.status429 = 30;
    await assert.rejects(a.status('job_1'), (err) => code('rate-limited')(err) && err.retryAfterSeconds === 30);
    server.knobs.status429 = null;
    await assert.rejects(adapter('wrong').status('job_1'), code('auth'));
  });

  it('reports job status in node states', async () => {
    const a = adapter();
    const { jobId } = await a.submit(job({ idempotencyKey: 'k-4' }), null);
    assert.deepStrictEqual((await a.status(jobId)).state, 'submitted');
    server.setJob(jobId, { state: 'running', costUsd: 1.75 });
    const s = await a.status(jobId);
    assert.deepStrictEqual([s.state, s.costUsd, s.contacts[0].id, s.contacts[0].state], ['running', 1.75, 'c1', 'pending']);
    assert.match(s.lastChange, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('pages results after a cursor', async () => {
    const a = adapter();
    const { jobId } = await a.submit(job({ idempotencyKey: 'k-5' }), null);
    for (const id of ['r1', 'r2', 'r3']) server.addRecord(jobId, { id, contactId: 'c1', kind: 'call', at: '2026-10-26T16:00:00Z', summary: `Call ${id}`, outcome: 'answered', fields: {} });
    const page1 = await a.results(jobId);
    assert.deepStrictEqual([page1.records.map((r) => r.id), page1.next], [['r1', 'r2'], 'r2']);
    const page2 = await a.results(jobId, { after: page1.next });
    assert.deepStrictEqual([page2.records.map((r) => r.id), page2.next], [['r3'], undefined]);
  });

  it('cancels and finds a job by externalRef', async () => {
    const a = adapter();
    const { jobId } = await a.submit(job({ idempotencyKey: 'k-6', externalRef: 'case-7/job-0006' }), null);
    assert.deepStrictEqual(await a.findByExternalRef('case-7/job-0006'), { jobId, contacts: [{ id: 'c1', address: '+15550100', normalizedAddress: '+15550100' }] });
    assert.strictEqual(await a.findByExternalRef('case-7/job-9999'), null);
    assert.deepStrictEqual(await a.cancel(jobId), { state: 'cancelled' });
    assert.strictEqual(server.state.requests.at(-1).method, 'DELETE');
  });

  it('turns a record into facts: the summary and each expected answer', () => {
    const facts = adapter().recordToFacts({
      id: 'r9', contactId: 'c1', kind: 'call', at: '2026-10-26T16:00:00Z', summary: 'Broker says the listing shows 2.5 acres',
      outcome: 'answered', fields: { q1: { value: 2.5, type: 'number', unit: 'acres' }, q7: { value: 'ignored' } }
    }, { ...job(), contacts: [{ id: 'c1', normalizedAddress: '+15550100' }] });
    assert.deepStrictEqual(facts.map((f) => [f.subject, f.attr, f.value, f.unit ?? null]), [
      ['contact:c1', 'call-outcome', 'answered', null],
      ['lot', 'acreage', 2.5, 'acres']
    ]);
    const money = adapter().recordToFacts({ id: 'r10', contactId: 'c1', kind: 'call', summary: 'Quote', outcome: 'answered', fields: { q1: { value: 1200, type: 'money', unit: 'USD' } } }, job());
    assert.strictEqual(money[1].category, 'financial');
  });

  it('carries brief rules for the calling agent', () => {
    assert.ok(adapter().briefRules().length >= 3);
  });
});
