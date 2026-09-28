// tests/chat-usability.test.js
// The send path checks usability instead of the fixed
// ['openai', 'anthropic', 'gemini'] list (spec 2026-09-27 §5.5, M-D7).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ProviderFactory = require('../src/providers/provider-factory');
const { chatHarness } = require('./helpers/chat-harness');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { Availability } = require('../src/models/availability');
const { setLogLevel } = require('../src/logging');

// A couple of cases here deliberately refuse a send (an unusable model, a
// 401 from the provider); silence wrapHandler's resulting error log so TAP
// output stays clean.
setLogLevel('fatal');

// An availability double: a verdict per provider/model, and a record of calls.
function fakeAvailability(verdicts = {}) {
  const calls = [];
  return {
    calls,
    ensureTested: async (provider) => { calls.push(['ensureTested', provider]); return { ok: true }; },
    explain: (provider, model, { needs } = {}) => {
      calls.push(['explain', provider, model, needs]);
      return verdicts[`${provider}/${model}`] || { usable: true, reasons: [], notes: [], entry: null };
    }
  };
}

describe('chat:sendMessage and usability', () => {
  let server;
  const catalog = fixtureCatalog();
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  it('answers through a provider outside the old three (Groq), when it is usable', async () => {
    const provider = ProviderFactory.create('groq', 'test-key-123456', { baseUrl: `${server.url}/groq/openai/v1`, catalog });
    const availability = fakeAvailability();
    const h = chatHarness({ provider, providerType: 'groq', model: 'llama-3.3-70b', overrides: { getAvailability: () => availability } });
    const result = await h.send({ agentMode: false });
    assert.notStrictEqual(result.ok, false, JSON.stringify(result));
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.strictEqual(reply.sender, 'assistant');
    assert.strictEqual(reply.text, 'Hello there');
    assert.deepStrictEqual(availability.calls, [['ensureTested', 'groq'], ['explain', 'groq', 'llama-3.3-70b', {}]]);
  });

  it('refuses an unusable model before any model call, with the reasons', async () => {
    let called = false;
    const provider = { streamMessage: async () => { called = true; return {}; }, sendMessageWithTools: async () => { called = true; return {}; } };
    const availability = fakeAvailability({ 'groq/llama-3.3-70b': { usable: false, reasons: ['Groq connection test failed at 2026-09-27T11:00:00.000Z: Invalid API Key'], notes: [], entry: null } });
    const h = chatHarness({ provider, providerType: 'groq', model: 'llama-3.3-70b', overrides: { getAvailability: () => availability } });
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /^No usable model for main in the profile "Test profile"\. Skipped: groq\/llama-3\.3-70b \(Groq connection test failed at 2026-09-27T11:00:00\.000Z: Invalid API Key\)/);
    assert.strictEqual(called, false);
    assert.ok(h.sent.some((e) => e.channel === 'chat:messageError'));
  });

  it('asks for tool calling in agent mode and for image input with images', async () => {
    const availability = fakeAvailability();
    const provider = { streamMessage: async () => ({}), sendMessageWithTools: async () => ({ type: 'text', content: 'ok' }) };
    const h = chatHarness({ provider, overrides: { getAvailability: () => availability } });
    await h.send({ agentMode: true, images: [{ base64: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'a.png' }] });
    const explain = availability.calls.find((c) => c[0] === 'explain');
    assert.deepStrictEqual(explain[3], { toolCall: true, imageInput: true });
  });

  it('tests a never-tested provider first (a profile from before the catalog)', async () => {
    const order = [];
    const availability = {
      ensureTested: async () => { order.push('ensureTested'); },
      explain: () => { order.push('explain'); return { usable: true, reasons: [], notes: [] }; }
    };
    const h = chatHarness({ provider: { streamMessage: async () => ({}) }, overrides: { getAvailability: () => availability } });
    await h.send({ agentMode: false });
    assert.deepStrictEqual(order, ['ensureTested', 'explain']);
  });

  it('reports a failed call so a 401 can mark the provider unusable', async () => {
    const reported = [];
    const authError = Object.assign(new Error('Invalid API Key'), { status: 401 });
    const provider = { streamMessage: async () => { throw authError; } };
    const h = chatHarness({ provider, providerType: 'groq', overrides: { reportProviderError: (p, err) => reported.push([p, err]) } });
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(reported, [['groq', authError]]);
  });

  it('runs with no check in a host without availability', async () => {
    const h = chatHarness({ provider: { streamMessage: async () => ({}) }, providerType: 'mistral' });
    assert.notStrictEqual((await h.send({ agentMode: false })).ok, false);
  });

  it('the fixed three-provider list is gone', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'chat-handlers.js'), 'utf8');
    assert.doesNotMatch(src, /does not support chat completions yet/);
    assert.doesNotMatch(src, /\['openai', 'anthropic', 'gemini'\]\.includes/);
  });

  // Review focus (fix round): a profile upgraded from before M1 — a saved
  // key with either no stored apiStatus at all, or a status shape from
  // before the catalog (no `models` list) — must not have its first send
  // refused. ensureTested runs before explain, and explain's rule 3 falls
  // back to the catalog when the status carries no model list; these use
  // the real Availability, not a double, to prove that combination holds
  // through the actual send path, not just in each piece separately.
  describe('a profile upgraded from before M1 is not refused on its first send', () => {
    it('no stored apiStatus at all: tested on demand, then usable', async () => {
      let store = {};
      const tested = [];
      const availability = new Availability({
        catalog,
        hasCredential: () => true,
        createProvider: async (p) => {
          tested.push(p);
          return ProviderFactory.create('groq', 'test-key-123456', { baseUrl: `${server.url}/groq/openai/v1`, catalog });
        },
        getStatuses: () => store,
        setStatuses: (s) => { store = s; }
      });
      // The fake server's account lists "test-model"; requesting that same
      // id is what a real account with a saved key and no status yet would
      // do once ensureTested() has just discovered its own model list.
      const provider = ProviderFactory.create('groq', 'test-key-123456', { baseUrl: `${server.url}/groq/openai/v1`, catalog });
      const h = chatHarness({ provider, providerType: 'groq', model: 'test-model', overrides: { getAvailability: () => availability } });
      const result = await h.send({ agentMode: false });
      assert.notStrictEqual(result.ok, false, JSON.stringify(result));
      assert.deepStrictEqual(tested, ['groq'], 'ensureTested actually ran the one connection test, not a refusal');
      assert.strictEqual(availability.status('groq').ok, true);
    });

    it('a status from before the catalog (no models list): falls back to the catalog, not refused', async () => {
      let store = { groq: { ok: true, message: 'Connection successful' } }; // pre-M1 shape: no `models`
      const availability = new Availability({
        catalog,
        hasCredential: () => true,
        createProvider: async () => { throw new Error('must not retest: a status already exists'); },
        getStatuses: () => store,
        setStatuses: (s) => { store = s; }
      });
      const provider = ProviderFactory.create('groq', 'test-key-123456', { baseUrl: `${server.url}/groq/openai/v1`, catalog });
      const h = chatHarness({ provider, providerType: 'groq', model: 'llama-3.3-70b', overrides: { getAvailability: () => availability } });
      const result = await h.send({ agentMode: false });
      assert.notStrictEqual(result.ok, false, JSON.stringify(result));
    });
  });

  // Fix round 1, finding 1: the gate's own "Cannot use p/m: …" refusal is not
  // a model-call failure. Reporting it to reportProviderError misclassified
  // it as an auth failure (markAuthFailure), overwriting the very status
  // that produced the refusal and nesting the message further on every send.
  it('a refused send leaves the stored status unchanged (finding 1)', async () => {
    // The gate's staleness check (chat-handlers.js) compares against the
    // real Date.now(), not Availability's injectable now(), so checkedAt
    // is set relative to real wall-clock time here: a few ms old, well
    // under the 60s threshold, so the finding-2 stale-retest branch does
    // not fire either; createProvider throws if it is ever called, so any
    // retest attempt fails the test loudly.
    let store = {
      groq: { ok: false, error: 'Invalid API Key', message: 'Invalid API Key', checkedAt: new Date().toISOString(), models: [] }
    };
    const before = JSON.parse(JSON.stringify(store));
    const availability = new Availability({
      catalog,
      hasCredential: () => true,
      createProvider: async () => { throw new Error('must not create a provider: a fresh failed status already exists'); },
      getStatuses: () => store,
      setStatuses: (s) => { store = s; }
    });
    const provider = { streamMessage: async () => ({}) };
    const h = chatHarness({ provider, providerType: 'groq', model: 'llama-3.3-70b', overrides: { getAvailability: () => availability } });
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(store, before, 'the refusal must not rewrite the stored status');
  });

  // Fix round 1, finding 2: a transient (non-auth) connection-test failure
  // must not stick until the next scheduled 24h retest.
  describe('a stale non-auth failure is retested once at send time', () => {
    it('retests and lets the send through when it now passes (finding 2a)', async () => {
      // Relative to real wall-clock time, matching the gate's own Date.now() check.
      const staleCheckedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes old
      let store = { groq: { ok: false, error: 'timeout', message: 'timeout', checkedAt: staleCheckedAt, models: [] } };
      const tested = [];
      const availability = new Availability({
        catalog,
        hasCredential: () => true,
        createProvider: async (p) => {
          tested.push(p);
          // The fake server's account always lists "test-model" regardless
          // of provider; requesting that same id is what lets this retest's
          // discovered model list satisfy explain()'s rule 3 below.
          return ProviderFactory.create('groq', 'test-key-123456', { baseUrl: `${server.url}/groq/openai/v1`, catalog });
        },
        getStatuses: () => store,
        setStatuses: (s) => { store = s; }
      });
      const provider = ProviderFactory.create('groq', 'test-key-123456', { baseUrl: `${server.url}/groq/openai/v1`, catalog });
      const h = chatHarness({ provider, providerType: 'groq', model: 'test-model', overrides: { getAvailability: () => availability } });
      const result = await h.send({ agentMode: false });
      assert.notStrictEqual(result.ok, false, JSON.stringify(result));
      assert.deepStrictEqual(tested, ['groq'], 'the stale failure must be retested exactly once');
      assert.strictEqual(store.groq.ok, true);
    });

    it('does not retest an authFailed status, even when stale (finding 2b)', async () => {
      const staleCheckedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes old
      const seeded = { ok: false, error: 'rejected', message: 'Groq rejected the key: Invalid API Key', checkedAt: staleCheckedAt, models: [], authFailed: true };
      let store = { groq: { ...seeded } };
      const tested = [];
      const availability = new Availability({
        catalog,
        hasCredential: () => true,
        createProvider: async (p) => { tested.push(p); return { listModels: async () => ['test-model'] }; },
        getStatuses: () => store,
        setStatuses: (s) => { store = s; }
      });
      const provider = { streamMessage: async () => ({}) };
      const h = chatHarness({ provider, providerType: 'groq', model: 'llama-3.3-70b', overrides: { getAvailability: () => availability } });
      const result = await h.send({ agentMode: false });
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(tested, [], 'an authFailed status must never be retested here');
      assert.deepStrictEqual(store.groq, seeded, 'the authFailed status must be untouched');
    });
  });
});
