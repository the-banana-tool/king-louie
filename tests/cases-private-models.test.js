// tests/cases-private-models.test.js
// A private case (local inference spec 2026-10-13 §7.3, §7.5, §8.1, §8.2,
// §9.2; R-LI-8, R-LI-13, R-LI-22, R-LI-23): one mark, on the case, that its
// chats follow; every case model call (orient, judge, classify, draft, the
// stage 8 verify pass and "Check now", a wake-up, ingest OCR, extract and
// verify) runs on a local model or is refused, skipped or failed with the
// reason, never sent to a hosted one; and a local call charges the case's
// usd budget nothing and counts no unpriced tokens.
//
// A real core on a temp data dir, a fake local server on 127.0.0.1, an
// OpenAI key, and a fetch stub that answers only OpenAI's model list (a
// connection test, no case text) and records every request. The tests mark
// a case with CaseRuntime#markPrivate (what case:markPrivate calls).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const IPC = require('../src/ipc/constants');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const { DetourClassifier } = require('../src/cases/detours/classifier');
const { DetourRouter } = require('../src/cases/detours/router');
const { shutdownPdfSandbox } = require('../src/cases/ingest/pdf-sandbox');
const { CASE_YAML_KEYS } = require('../src/cases/case-store');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { confirmAll } = require('./helpers/case-scope');
const { makePdf } = require('./helpers/ingest-fixtures');
const { HAS_GIT } = require('./helpers/ingest-harness');
const { setLogLevel, addSink } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const t = (provider, model, effort = null) => ({ provider, model, effort });
const HOSTED = t('openai', 'gpt-5.5');
const HOSTED_MINI = t('openai', 'gpt-5.4-mini');
// One local model per case role group, told apart by name on the fake
// server: the judge loop and verify run on main, draft on worker, orient
// and classify on utility.
const LOCAL_JUDGE = t('local', 'workstation/judge-model');
const LOCAL_DRAFT = t('local', 'workstation/draft-model');
const LOCAL_ORIENT = t('local', 'workstation/orient-model');
const PAYOFF = 'Example Bank\nLoan No. 0042-7781\nTotal payoff amount: $182,340.17\n';
const PROPOSALS = JSON.stringify({
  proposals: [{
    stmt: 'Payoff amount for loan 0042-7781 is $182,340.17',
    subject: 'loan-0042-7781',
    attr: 'payoff-amount',
    value: '182340.17',
    unit: 'usd',
    category: 'general',
    confidence: 0.9,
    anchor: { page: 1, quote: 'Total payoff amount: $182,340.17' }
  }]
});

const refusedPrivate = (err) => {
  assert.strictEqual(err.code, 'PRIVATE_NO_LOCAL_MODEL');
  assert.match(err.message, /this case is private/);
  assert.match(err.message, /Nothing was sent to a hosted model\.$/);
  return true;
};

describe('a private case: the mark, and every case model call behind it', { skip: HAS_GIT ? false : 'git is not on PATH' }, () => {
  let box;
  let dataDir;
  let core;
  let ctx;
  let rt;
  const originalFetch = globalThis.fetch;
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  const fetched = [];
  // Every request that would carry text to a hosted model (a GET of the
  // model list is a connection test and carries none).
  const hostedSends = () => fetched.filter((f) => f.method !== 'GET');
  const localCalls = () => box.requests.filter((r) => r.method === 'POST' && /\/chat\/completions$/.test(r.path));
  const localModels = () => localCalls().map((r) => r.body.model);

  before(async () => {
    box = await startFakeLlmServer();
    box.setModels([{ id: 'judge-model' }, { id: 'draft-model' }, { id: 'orient-model' }]);
    box.setReply('judge-model', '{"agrees": true, "note": "matches the page"}');
    box.setReply('draft-model', PROPOSALS);
    box.setReply('orient-model', '{"changed": false, "why": "nothing new"}');
    globalThis.fetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      fetched.push({ url: String(url), method });
      if (method === 'GET' && /api\.openai\.com\/v1\/models/.test(String(url))) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4-mini' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`no network in unit tests (${method} ${url})`);
    };
    delete process.env.KL_CASES_ROOT;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-private-'));
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    const tools = { toolCall: true };
    store.set('settings', {
      models: {
        localServers: [{
          id: 'workstation', name: 'workstation', kind: 'vllm', baseUrl: `${box.url}/vllm`, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
          pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT
        }],
        profiles: [
          { id: 'p-hosted', name: 'Hosted', kind: 'user', roles: { main: [HOSTED], worker: [HOSTED_MINI], utility: [HOSTED_MINI] } },
          { id: 'p-local', name: 'Local', kind: 'user', roles: { main: [LOCAL_JUDGE, HOSTED], worker: [LOCAL_DRAFT, HOSTED_MINI], utility: [LOCAL_ORIENT, HOSTED_MINI] } }
        ],
        defaultProfileId: 'p-hosted',
        overrides: {
          'local:workstation/judge-model': tools,
          'local:workstation/draft-model': tools,
          'local:workstation/orient-model': tools
        }
      },
      cases: { timeZone: 'UTC' }
    });
    core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() }
    });
    core.saveProviderToken('openai', 'sk-test-openai-123456');
    await core.start();
    ctx = core.context;
    rt = ctx.getCaseRuntime();
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    if (core) await core.shutdown();
    await shutdownPdfSandbox();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    await box.close();
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  beforeEach(() => {
    fetched.length = 0;
    box.requests.length = 0;
  });

  // An active case on a profile, its criteria confirmed, gating complete,
  // and optionally marked private. force: the cases here share an objective.
  let n = 0;
  async function activeCase({ profile = 'p-hosted', marked = true, title = null, objective = 'Convert the lot to cash' } = {}) {
    n += 1;
    const info = await rt.createCase({ title: title || `Lakeside lot ${n}`, objective, force: true });
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
    confirmAll(rt, info.id);
    rt.completeGating(info.id);
    await rt.setModelChoice(info.id, { profile });
    if (marked) await rt.markPrivate(info.id);
    return rt.getCase(info.id);
  }
  let turnCount = 0;
  const begin = (caseId, opts = {}) => rt.beginTurn(caseId, { turnId: `turn-${++turnCount}`, source: 'owner', ...opts });
  const src = { kind: 'url', ref: 'https://records.example.org/1' };

  it('case.yaml has the key private (L1)', () => {
    assert.strictEqual(CASE_YAML_KEYS.private, 'L1');
  });

  it('R-LI-23: a case chat is private exactly when its case is', async () => {
    const c = await activeCase({ marked: false });
    for (const id of [`${c.id}-a`, `${c.id}-b`]) ctx.createChat({ id, title: c.title, caseId: c.id, createdAt: AT, updatedAt: AT, messages: [] });
    const store = ctx.getHistoryStore();
    assert.strictEqual(rt.isPrivate(c.id), false);
    assert.strictEqual(ctx.egressFor({ caseId: c.id }), null);
    assert.strictEqual(ctx.egressFor({ chatId: `${c.id}-a` }), null);
    assert.strictEqual(store.isPrivate(`${c.id}-a`), false);

    await rt.markPrivate(c.id);
    assert.strictEqual(rt.isPrivate(c.id), true);
    assert.strictEqual(rt.getCase(c.id).private, true);
    assert.match(fs.readFileSync(path.join(c.dir, 'case.yaml'), 'utf8'), /^private: true$/m);
    assert.strictEqual(ctx.egressFor({ caseId: c.id }).reason, 'private-case');
    for (const id of [`${c.id}-a`, `${c.id}-b`]) {
      assert.strictEqual(store.isPrivate(id), true, `${id} is marked in the store too`);
      assert.strictEqual(ctx.snapshotModels({ chatId: id }).egress.localOnly, true);
    }
    // A chat made for the case afterwards (a question's card, an attach)
    // follows the case at its next turn start.
    ctx.createChat({ id: `${c.id}-c`, title: c.title, caseId: c.id, createdAt: AT, updatedAt: AT, messages: [] });
    assert.strictEqual(ctx.egressFor({ chatId: `${c.id}-c` }).localOnly, true, 'the case mark holds before the chat row is marked');
    const turn = await begin(c.id);
    await rt.endTurn(turn, { summary: 'nothing' });
    assert.strictEqual(store.isPrivate(`${c.id}-c`), true);
  });

  it('R-LI-10: the mark is one way: marking again changes nothing, and no case.yaml write takes it off', async () => {
    const c = await activeCase();
    const yaml = () => fs.readFileSync(path.join(c.dir, 'case.yaml'), 'utf8');
    const before = yaml();
    await rt.markPrivate(c.id);
    assert.strictEqual(yaml(), before);
    for (const value of [false, null, 'no']) {
      assert.throws(() => rt.store.updateMeta(c.id, { private: value }), (err) => err.code === 'PRIVATE_ONE_WAY');
    }
    await rt.setModelChoice(c.id, { profile: 'p-local' });
    assert.strictEqual(rt.getCase(c.id).private, true, 'another case.yaml write keeps the mark');
    assert.strictEqual(rt.isPrivate(c.id), true);
  });

  it('a case.yaml whose private is not exactly true or absent is private, with one warning', async () => {
    const c = await activeCase({ marked: false });
    const file = path.join(c.dir, 'case.yaml');
    const warnings = [];
    setLogLevel('warn');
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    try {
      for (const value of ['maybe', 'false', '0', '[]']) {
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^private:.*\n/m, '') + `private: ${value}\n`);
        assert.strictEqual(rt.isPrivate(c.id), true, `private: ${value}`);
      }
    } finally {
      remove();
      setLogLevel('fatal');
    }
    assert.strictEqual(warnings.filter((m) => /treated as private/.test(m)).length, 1, 'one warning for the case');
    assert.ok(!warnings.some((m) => m.includes('maybe')), 'the warning does not repeat what the file holds');
    assert.strictEqual(rt.isPrivate('no-such-case'), true, 'a case that cannot be read is private');
  });

  it('a case created private carries the key from its first commit; createCase takes nothing but exactly true', async () => {
    const made = await rt.createCase({ title: 'Lakeside lot private', objective: 'Convert the lot to cash', force: true, private: true });
    assert.strictEqual(rt.getCase(made.id).private, true);
    const plain = await rt.createCase({ title: 'Lakeside lot plain', objective: 'Convert the lot to cash', force: true, private: 'yes' });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rt.getCase(plain.id), 'private'), false);
    assert.strictEqual(rt.isPrivate(plain.id), false);
  });

  it('a turn of a private case is under the case\'s policy, and its routed providers refuse a hosted target', async () => {
    const c = await activeCase();
    const turn = await begin(c.id);
    try {
      assert.strictEqual(turn.models.egress.reason, 'private-case');
      assert.strictEqual(turn.models.egress.caseId, c.id);
      // A list handed in by a caller (the owner turn's main) is refused at
      // the router, before any request.
      await assert.rejects(rt.routedProvider(turn, { targets: [HOSTED] }).sendMessage([{ role: 'user', content: 'hi' }]), (err) => err.code === 'PRIVATE_HOSTED_TARGET');
    } finally {
      await rt.endTurn(turn, { summary: 'nothing' });
    }
    assert.deepStrictEqual(hostedSends(), []);
  });

  for (const role of ['orient', 'judge', 'classify', 'draft', 'verify']) {
    it(`R-LI-8: ${role} in a private case with only hosted models is refused before any call`, async () => {
      const c = await activeCase();
      const turn = await begin(c.id);
      try {
        await rt.ensureRoleTested(c.id, role, { turn });
        assert.throws(() => rt.routedProvider(turn, { role }), refusedPrivate);
      } finally {
        await rt.endTurn(turn, { summary: 'nothing' });
      }
      assert.deepStrictEqual(hostedSends(), []);
      assert.deepStrictEqual(localCalls(), []);
    });
  }

  it('R-LI-8: the detour classifier fails open with no request', async () => {
    const c = await activeCase();
    const turn = await begin(c.id);
    let result;
    try {
      result = await new DetourClassifier({ runtime: rt }).classify(c.id, { source: 'owner-message', text: 'Also book a piano tuner for next week please', turn });
    } finally {
      await rt.endTurn(turn, { summary: 'nothing' });
    }
    assert.strictEqual(result.onCase, true);
    assert.strictEqual(result.detour, false);
    assert.ok(result.failed, 'the classifier says it did not run');
    assert.deepStrictEqual(hostedSends(), []);
  });

  it('R-LI-8: orient, judge, classify and draft of a private case run on its local models', async () => {
    const c = await activeCase({ profile: 'p-local' });
    const turn = await begin(c.id);
    try {
      for (const role of ['orient', 'judge', 'classify', 'draft']) {
        const provider = rt.routedProvider(turn, { role });
        assert.strictEqual(provider.current().provider, 'local', `${role} starts on its local model`);
        await provider.sendMessageWithTools([{ role: 'user', content: 'hi' }], [], {});
      }
    } finally {
      await rt.endTurn(turn, { summary: 'nothing' });
    }
    assert.deepStrictEqual(localModels(), ['orient-model', 'judge-model', 'orient-model', 'draft-model']);
    assert.deepStrictEqual(hostedSends(), []);
  });

  it('R-LI-8, R-LI-13: an owner turn of a private case completes on the local model, and its calls charge the budget nothing', async () => {
    const c = await activeCase({ profile: 'p-local' });
    const chatId = `${c.id}-chat`;
    ctx.createChat({ id: chatId, title: c.title, caseId: c.id, createdAt: AT, updatedAt: AT, messages: [] });
    const handlers = new Map();
    registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, ctx);
    const event = { sender: { send: () => {}, isDestroyed: () => false } };
    const result = await handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId, message: 'Where does the payoff stand?', agentMode: true });
    assert.notStrictEqual(result?.ok, false, JSON.stringify(result));
    await rt.verifyIdle(c.id);
    assert.ok(localModels().includes('judge-model'), 'the turn ran on the local judge model');
    assert.deepStrictEqual(hostedSends(), []);
    const usd = rt.budget(c.id).status().usd;
    assert.strictEqual(usd.spent, 0);
    assert.strictEqual(usd.unpricedTokens || 0, 0, 'a local call is not an unpriced call');
    const raw = JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'budget.json'), 'utf8'));
    assert.ok(raw.usd.localTokens > 0, 'the local tokens are recorded');
  });

  it('R-LI-22: an owner turn of a private case with only hosted models is refused before any call', async () => {
    const c = await activeCase();
    const chatId = `${c.id}-chat`;
    ctx.createChat({ id: chatId, title: c.title, caseId: c.id, createdAt: AT, updatedAt: AT, messages: [] });
    const handlers = new Map();
    registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, ctx);
    const errors = [];
    const event = { sender: { send: (channel, payload) => { if (channel === 'chat:messageError') errors.push(payload); }, isDestroyed: () => false } };
    const result = await handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId, message: 'Where does the payoff stand?', agentMode: true }).catch((err) => ({ ok: false, error: err.message }));
    assert.strictEqual(result?.ok, false);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].error, /^This case is private/);
    assert.match(errors[0].error, /Nothing was sent to a hosted model.$/);
    assert.deepStrictEqual(hostedSends(), []);
    assert.deepStrictEqual(localCalls(), []);
    assert.strictEqual(rt.runningTurn(c.id), null, 'the case is released');
  });

  it('R-LI-13: the case budget charges a local call nothing and counts no unpriced tokens; a hosted unknown model still counts unpriced', async () => {
    const c = await activeCase({ marked: false });
    const turn = await begin(c.id);
    try {
      rt.usageHook(turn)({ provider: 'local', model: 'workstation/judge-model', totalTokens: 300, cost: 0, local: { server: 'workstation', class: 'loopback' } });
      rt.usageHook(turn)({ provider: 'openai', model: 'gpt-unknown', totalTokens: 50, cost: null });
      rt.usageHook(turn)({ provider: 'openai', model: 'gpt-zero', totalTokens: 40, cost: 0 });
      rt.usageHook(turn)({ provider: 'openai', model: 'gpt-5.5', totalTokens: 20, cost: 0.25 });
      // A record that says local without a server is not a local call.
      rt.usageHook(turn)({ provider: 'local', model: 'x', totalTokens: 7, cost: 0, local: true });
    } finally {
      await rt.endTurn(turn, { summary: 'nothing' });
    }
    const raw = JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'budget.json'), 'utf8'));
    assert.strictEqual(raw.usd.spent, 0.25);
    assert.strictEqual(raw.usd.unpricedTokens, 50 + 40 + 7);
    assert.strictEqual(raw.usd.localTokens, 300);
  });

  it('R-LI-22: a wake-up of a private case with no local model is a failed wake-up, with the refusal\'s code', async () => {
    const c = await activeCase();
    const id = rt.wakeups(c.id).register({ kind: 'retry', at: new Date(Date.now() - 60000).toISOString(), payload: { key: 'test' } });
    const counts = await rt.runDueWakeups(new Date());
    assert.strictEqual(counts.failed, 1);
    const w = rt.wakeups(c.id).list().find((x) => x.id === id);
    assert.strictEqual(w.lastOutcome, 'failed');
    assert.match(w.lastError, /^PRIVATE_NO_LOCAL_MODEL: /);
    assert.strictEqual(w.attempts, 1, 'the backoff counts it');
    assert.deepStrictEqual(hostedSends(), []);
    assert.deepStrictEqual(localCalls(), []);
  });

  it('R-LI-8: a wake-up of a private case runs orient on its local model', async () => {
    const c = await activeCase({ profile: 'p-local' });
    rt.wakeups(c.id).register({ kind: 'retry', at: new Date(Date.now() - 60000).toISOString(), payload: { key: 'test' } });
    const counts = await rt.runDueWakeups(new Date());
    assert.strictEqual(counts.quiet, 1, JSON.stringify(counts));
    assert.deepStrictEqual(localModels(), ['orient-model']);
    assert.deepStrictEqual(hostedSends(), []);
  });

  it('R-LI-8: the verify pass after a turn of a private case runs on its local model', async () => {
    const c = await activeCase({ profile: 'p-local' });
    const turn = await begin(c.id);
    rt.ledger(c.id).assert({ stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, source: src, addedBy: turn.turnId });
    await rt.endTurn(turn, { summary: 'wrote', journal: 'Recorded the signed contract.', verify: true });
    await rt.verifyIdle(c.id);
    // verify falls back to the judge's local model (a first probe of it
    // may come before the pass: local too).
    assert.ok(localModels().length >= 1 && localModels().every((m) => m === 'judge-model'), localModels().join(', '));
    assert.deepStrictEqual(hostedSends(), []);
  });

  it('the verify pass after a turn of a private case with no local model is skipped, uncounted, and says why in the journal', async () => {
    const c = await activeCase();
    const turn = await begin(c.id);
    rt.ledger(c.id).assert({ stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, source: src, addedBy: turn.turnId });
    await rt.endTurn(turn, { summary: 'wrote', journal: 'Recorded the signed contract.', verify: true });
    await rt.verifyIdle(c.id);
    assert.deepStrictEqual(hostedSends(), []);
    assert.deepStrictEqual(localCalls(), []);
    const file = rt.verification(c.id).read();
    assert.strictEqual(file.passes ? file.passes.count : 0, 0, 'a skipped pass is not counted');
    const journal = fs.readdirSync(path.join(c.dir, 'journal')).map((f) => fs.readFileSync(path.join(c.dir, 'journal', f), 'utf8')).join('\n');
    assert.match(journal, /this case is private and no local model can take the verify pass/);
  });

  it('"Check now" on a private case with no local model is refused PRIVATE_NO_LOCAL_MODEL, before anything is counted or written', async () => {
    const c = await activeCase();
    rt.ledger(c.id).assert({ stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, source: src });
    await assert.rejects(rt.verifyNow(c.id), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL' && /Nothing was sent to a hosted model/.test(err.message));
    const file = rt.verification(c.id).read();
    assert.strictEqual(file.passes ? file.passes.count : 0, 0);
    assert.deepStrictEqual(hostedSends(), []);
    assert.deepStrictEqual(localCalls(), []);
  });

  it('"Check now" on a private case runs on its local model', async () => {
    const c = await activeCase({ profile: 'p-local' });
    rt.ledger(c.id).assert({ stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, source: src });
    await rt.verifyNow(c.id);
    assert.deepStrictEqual(localModels(), ['judge-model']);
    assert.deepStrictEqual(hostedSends(), []);
  });

  it('R-LI-8: ingest extract and verify of a private case run on its local models, through the core\'s callModel', async () => {
    const c = await activeCase({ profile: 'p-local' });
    const svc = ctx.getIngestService();
    const out = await svc.store(c.id, { name: 'payoff.txt', bytes: Buffer.from(PAYOFF), origin: { kind: 'owner-drop' } });
    await svc.drain();
    const rec = await svc.get(c.id, out.docId || out.record?.docId);
    assert.ok(rec, 'the document is stored');
    assert.ok(localModels().includes('draft-model'), `extract ran on the local draft model (${localModels().join(', ')})`);
    assert.ok(localModels().includes('judge-model'), 'verify ran on the local main model');
    assert.deepStrictEqual(hostedSends(), []);
    const raw = JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'budget.json'), 'utf8'));
    assert.strictEqual(raw.usd.spent, 0);
    assert.strictEqual(raw.usd.unpricedTokens || 0, 0, 'a local ingest call is not unpriced');
  });

  it('R-LI-8: ingest of a private case with only hosted models sends nothing; the document waits with the reason', async () => {
    const c = await activeCase();
    const svc = ctx.getIngestService();
    const out = await svc.store(c.id, { name: 'payoff.txt', bytes: Buffer.from(PAYOFF), origin: { kind: 'owner-drop' } });
    await svc.drain();
    const docId = out.docId || out.record?.docId;
    const rec = (await svc.get(c.id, docId)).record || (await svc.get(c.id, docId));
    assert.notStrictEqual(rec.status, 'failed', 'the document is not failed: it waits for a local model');
    assert.ok(rec.failedChunks.length > 0);
    assert.ok(rec.failedChunks.every((ch) => ch.reason === 'private-no-local-model'), JSON.stringify(rec.failedChunks));
    assert.deepStrictEqual(hostedSends(), []);
    assert.deepStrictEqual(localCalls(), []);
  });

  it('R-LI-8: ingest OCR of a private case with only hosted models sends nothing; the page says why', async () => {
    const c = await activeCase();
    const svc = ctx.getIngestService();
    const out = await svc.store(c.id, { name: 'plat.pdf', bytes: await makePdf({ pages: [{ scan: true }] }), origin: { kind: 'owner-drop' } });
    await svc.drain();
    const docId = out.docId || out.record?.docId;
    const got = await svc.get(c.id, docId);
    const rec = got.record || got;
    const page = rec.pages.find((p) => p.n === 1);
    assert.ok(page && page.method !== 'ocr', JSON.stringify(rec.pages));
    assert.match(String(page.error || rec.note || ''), /private/);
    assert.deepStrictEqual(hostedSends(), []);
    assert.deepStrictEqual(localCalls(), []);
  });

  it('a case a detour of a private case creates is created private', async () => {
    const door = await activeCase();
    const router = new DetourRouter({ runtime: rt });
    const p = await router.propose(door.id, { summary: 'Book a piano tuner for the living room', reason: 'Unrelated errand' });
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'new' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app', title: `Piano tuner ${n}` });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(rt.getCase(r.linkedCaseId).private, true);
    assert.strictEqual(rt.isPrivate(r.linkedCaseId), true);
  });

  it('a detour of a private case is not attached to a case that is not private (cautious reading; open question)', async () => {
    const door = await activeCase({ title: 'Rear door quotes', objective: 'Three written quotes for the rear door' });
    const phone = await activeCase({ marked: false, title: 'Phone agent maintenance', objective: 'Keep the phone agent answering and reporting call status' });
    const router = new DetourRouter({ runtime: rt });
    const p = await router.propose(door.id, { summary: 'Fix the phone agent status polling that drops calls', reason: 'Fixing the phone agent does not collect door quotes' });
    assert.ok(p.questionId, JSON.stringify(p));
    const targets = rt.questions(door.id).get(p.questionId).payload.targets;
    const option = p.detour.options.find((o) => targets[o.optionId] === phone.id);
    assert.ok(option, `the ordinary case is offered: ${JSON.stringify(p.detour.options)}`);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: option.optionId });
    const r = await router.resolve(door.id, p.detour.id, { optionId: option.optionId, by: 'in-app' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'PRIVATE_CASE_REQUIRED');
    assert.deepStrictEqual(rt.getCase(phone.id).related || [], []);
  });
});
