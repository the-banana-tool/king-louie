// tests/helpers/executor-fixtures.js
// Shared fixtures for the cases stage 3 tests: a data dir with a case
// runtime and an executor registry, and a scriptable fake external agent
// installed as a real pinned package.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../../src/cases');
const { ExecutorRegistry } = require('../../src/cases/executors');
const { computePackageSha256 } = require('../../src/cases/executors/package-loader');

const made = [];
function tempDir(prefix = 'kl-exec-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
function cleanup() {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
}

function fakeVault(values = { 'errands-token': 'tok-test' }) {
  const m = new Map(Object.entries(values));
  return { get: (k) => (m.has(k) ? m.get(k) : null), has: (k) => m.has(k), set: (k, v) => m.set(k, v) };
}

// The adapter defers to globalThis.__klFakeExecutors[id], set by installFakeAdapter.
const FAKE_ADAPTER_SOURCE = 'module.exports.createAdapter = (config, host) => globalThis.__klFakeExecutors[host.id](config, host);\n';

function writeFakePackage(root, id, { capabilities = ['call', 'voicemail'], cannot = ['web-form', 'email', 'sms'], payloadSchema = { venue: { type: 'string' } } } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `kl-executor-${id}`, version: '1.0.0', main: 'adapter.js',
    kingLouie: {
      executor: {
        apiVersion: 1, id, kind: 'external-agent', capabilities, cannot,
        configSchema: { baseUrl: { type: 'string', required: true }, token: { type: 'string', secret: true, required: true } },
        payloadSchema, origins: ['config:baseUrl']
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'adapter.js'), FAKE_ADAPTER_SOURCE);
  return { dir, sha: computePackageSha256(dir) };
}

function externalEntry(sha, over = {}) {
  return {
    kind: 'external-agent',
    package: 'fake-agent',
    packageSha256: sha,
    config: { baseUrl: 'https://errands.example.com', token: '${vault:errands-token}' },
    constraints: { contactsPerDay: 5 },
    cost: { perJob: 1, perContact: 0.5, perAttempt: 0.25 },
    latency: 'async-hours',
    outbound: 'message',
    authority: 'envelope',
    pollEveryMs: 60000,
    ...over
  };
}

function installFakeAdapter(id, {
  capabilities = ['call', 'voicemail'], cannot = ['web-form', 'email', 'sms'], briefRules = ['Say who you are calling for.'],
  recordToFacts = null, findByExternalRef = false
} = {}) {
  globalThis.__klFakeExecutors = globalThis.__klFakeExecutors || {};
  const ctl = {
    calls: [], jobs: new Map(), records: new Map(), statusThrows: 0, normalizeAs: {}, submitError: null,
    submitDelayMs: 0, cancelThrows: false, rules: briefRules, seq: 0, config: null
  };
  globalThis.__klFakeExecutors[id] = (config) => {
    ctl.config = config;
    const adapter = {
      capabilities: () => ({ capabilities, cannot, constraints: {}, cost: {}, latency: 'async-hours', state: 'poll' }),
      async submit(job, envelope) {
        ctl.calls.push(['submit', job, envelope]);
        if (ctl.submitDelayMs) await new Promise((r) => setTimeout(r, ctl.submitDelayMs));
        if (ctl.submitError) throw ctl.submitError;
        ctl.seq += 1;
        const externalId = `ext-${ctl.seq}`;
        const contacts = (job.recipients || []).map((r, i) => ({ id: `c${i + 1}`, address: r, normalizedAddress: ctl.normalizeAs[r] || r }));
        ctl.jobs.set(externalId, {
          state: 'running', externalRef: job.externalRef, lastChange: null, costUsd: null,
          contacts: contacts.map((c) => ({ id: c.id, state: 'pending', attempts: 0, lastAttemptAt: null }))
        });
        return { jobId: externalId, contacts };
      },
      async status(jobId) {
        ctl.calls.push(['status', jobId]);
        if (ctl.statusThrows > 0) {
          ctl.statusThrows -= 1;
          throw new Error('errands API unavailable');
        }
        const j = ctl.jobs.get(jobId);
        if (!j) throw new Error(`no job ${jobId}`);
        const { externalRef, ...status } = j;
        return JSON.parse(JSON.stringify(status));
      },
      async results(jobId, { after } = {}) {
        ctl.calls.push(['results', jobId, after || null]);
        const all = ctl.records.get(jobId) || [];
        const i = after ? all.findIndex((r) => r.id === after) + 1 : 0;
        return { records: all.slice(i) };
      },
      async cancel(jobId) {
        ctl.calls.push(['cancel', jobId]);
        if (ctl.cancelThrows) throw new Error('cancel failed');
        const j = ctl.jobs.get(jobId);
        if (j) j.state = 'cancelled';
        return { state: 'cancelled' };
      },
      briefRules: () => ctl.rules
    };
    if (recordToFacts) adapter.recordToFacts = recordToFacts;
    if (findByExternalRef) {
      adapter.findByExternalRef = async (ref) => {
        ctl.calls.push(['find', ref]);
        for (const [externalId, j] of ctl.jobs) if (j.externalRef === ref) return { jobId: externalId, contacts: [] };
        return null;
      };
    }
    return adapter;
  };
  return ctl;
}

function setupExecutors({ executors = {}, cases = { timeZone: 'UTC' }, now = '2026-10-26T15:00:00Z', registryOptions = {}, host = {} } = {}) {
  const dataDir = tempDir('kl-exec-data-');
  const clock = { now: new Date(now) };
  const settings = { cases: { ...cases }, executors: { ...executors } };
  let registry = null;
  const runtime = new CaseRuntime({
    root: path.join(dataDir, 'cases'),
    getSettings: () => settings,
    now: () => clock.now,
    host: { getExecutorRegistry: () => registry, ...host }
  });
  registry = new ExecutorRegistry({
    dataDir, getSettings: () => settings, caseRuntime: runtime, now: () => clock.now, vault: fakeVault(), ...registryOptions
  });
  return { dataDir, runtime, registry, settings, clock, packageRoot: path.join(dataDir, 'executors') };
}

function withFakeAgent(env, id = 'fake-agent', opts = {}) {
  const { sha } = writeFakePackage(env.packageRoot, id, opts);
  env.settings.executors.entries = {
    ...(env.settings.executors.entries || {}),
    [id]: externalEntry(sha, { package: id, ...(opts.entry || {}) })
  };
  return installFakeAdapter(id, opts);
}

// force: these fixtures open several cases with one objective on purpose;
// the similar-case gate (cases stage 5) is not what they exercise.
async function activeCase(runtime, { title = 'Lakeside lot', brief = {} } = {}) {
  const info = await runtime.createCase({ title, objective: 'Convert the lot to cash', force: true });
  const b = runtime.brief(info.id);
  b.update('why', 'Paying for a move', { provenance: 'user' });
  b.update('successCriteria', ['Sold within the year'], { provenance: 'model' });
  for (const [field, value] of Object.entries(brief)) b.update(field, value, { provenance: 'user' });
  runtime.completeGating(info.id);
  return runtime.getCase(info.id);
}

async function openTurn(runtime, caseId, { turnId = 'turn-1', ownerMessages = [] } = {}) {
  const turn = await runtime.beginTurn(caseId, { turnId });
  // These tests exercise executor rules, not re-orientation.
  turn.reorientPending = false;
  return { turn, caseContext: runtime.caseContext(turn, { ownerMessages }) };
}

module.exports = {
  tempDir, cleanup, fakeVault, writeFakePackage, externalEntry, installFakeAdapter,
  setupExecutors, withFakeAgent, activeCase, openTurn
};
