// tests/local-probe.test.js
// The probe and the catalog (spec 2026-10-13-local-inference-design.md §6;
// R-LI-7): each model on a local server is probed once, through the server's
// pinned transport, for its context size, tool calling and a smoke call, and
// enters the catalog as a free local model. What a server says about itself
// is an observation: it can make a model look less capable, never more
// trusted. The servers here are fake servers on 127.0.0.1.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalServers } = require('../src/models/local-servers');
const { listModels, probeModel, PROBE_TOOL_PROMPT, PROBE_SMOKE_PROMPT } = require('../src/models/local-probe');
const { createLocalTransport } = require('../src/models/local-transport');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { setLogLevel, addSink } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const DIGEST = 'cd'.repeat(32);

const entry = (id, kind, baseUrl, over = {}) => ({
  id, name: id === 'workstation' ? 'Workstation' : 'Compat box', kind, baseUrl, tlsFingerprint: null, allowCgnat: false,
  maxConcurrent: 2, timeoutMs: null, pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT, ...over
});

describe('local model probe', () => {
  let server;
  const dirs = [];
  const open = [];

  before(async () => {
    server = await startFakeLlmServer();
    server.setOllamaModels({
      'test-model': { digest: DIGEST, model_info: { 'llama.context_length': 8192 }, capabilities: ['completion', 'tools'] },
      'vision-model': { model_info: {}, capabilities: ['completion', 'vision'] },
      'gpt-oss:120b-cloud': { model_info: { 'gptoss.context_length': 131072 }, capabilities: ['completion', 'tools'] }
    });
    server.setModels([
      { id: 'tool-model', max_model_len: 32768 },
      { id: 'text-only-model' },
      { id: 'no-usage-model' },
      { id: 'slow-model' }
    ]);
  });
  after(async () => { await server.close(); });
  afterEach(() => {
    while (open.length) open.pop().close();
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  });

  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-local-probe-')); dirs.push(d); return d; };
  const entries = () => [entry('workstation', 'ollama', `${server.url}/ollama`), entry('compat', 'openai-compatible', `${server.url}/compat`)];

  function registry({ dir = tmp(), list = entries(), catalog = fixtureCatalog(), ...extra } = {}) {
    const probeFile = path.join(dir, 'models', 'local-probes.json');
    const servers = new LocalServers({ getEntries: typeof list === 'function' ? list : () => list, catalog, probeFile, ...extra });
    open.push(servers);
    return { servers, catalog, probeFile, dir };
  }
  const posts = (prefix) => server.requests.filter((r) => r.provider === prefix && r.method === 'POST' && r.path.endsWith('/chat/completions'));

  it('listModels: an Ollama server\'s tags, another kind\'s /v1/models, and a failure with its status', async () => {
    const ollama = createLocalTransport({ baseUrl: `${server.url}/ollama`, addresses: ['127.0.0.1'] });
    const compat = createLocalTransport({ baseUrl: `${server.url}/compat`, addresses: ['127.0.0.1'] });
    const missing = createLocalTransport({ baseUrl: `${server.url}/nothing/here`, addresses: ['127.0.0.1'] });
    try {
      assert.deepStrictEqual(await listModels({ kind: 'ollama', baseUrl: `${server.url}/ollama` }, { fetch: ollama.fetch }), ['test-model', 'vision-model', 'gpt-oss:120b-cloud']);
      assert.deepStrictEqual(await listModels({ kind: 'vllm', baseUrl: `${server.url}/compat` }, { fetch: compat.fetch }), ['tool-model', 'text-only-model', 'no-usage-model', 'slow-model']);
      server.failNext(503);
      await assert.rejects(listModels({ kind: 'vllm', baseUrl: `${server.url}/compat` }, { fetch: compat.fetch }), (err) => err.status === 503 && /503/.test(err.message));
      server.failNext(500);
      await assert.rejects(listModels({ kind: 'ollama', baseUrl: `${server.url}/ollama` }, { fetch: ollama.fetch }), (err) => err.status === 500);
      assert.ok(missing);
    } finally {
      ollama.close(); compat.close(); missing.close();
    }
  });

  it('listModels drops ids that are not one plain line, and never lists more than its cap', async () => {
    const t = createLocalTransport({ baseUrl: `${server.url}/compat`, addresses: ['127.0.0.1'] });
    const many = Array.from({ length: 700 }, (_, i) => ({ id: `m-${i}` }));
    server.setModels([{ id: 'good' }, { id: 'two\nlines' }, { id: '' }, { id: 7 }, { id: 'x'.repeat(400) }, 'not an object', { id: 'good' }, ...many]);
    try {
      const ids = await listModels({ kind: 'vllm', baseUrl: `${server.url}/compat` }, { fetch: t.fetch });
      assert.strictEqual(ids[0], 'good');
      assert.strictEqual(ids.filter((id) => id === 'good').length, 1);
      assert.ok(ids.every((id) => typeof id === 'string' && id && !/[\n\r]/.test(id) && id.length <= 200));
      assert.strictEqual(ids.length, 500);
    } finally {
      t.close();
      server.setModels([{ id: 'tool-model', max_model_len: 32768 }, { id: 'text-only-model' }, { id: 'no-usage-model' }, { id: 'slow-model' }]);
    }
  });

  it('R-LI-7: context, tool calling and the smoke call are recorded (an Ollama server)', async () => {
    const { servers, catalog } = registry();
    const sentBefore = posts('ollama').length;
    const view = await servers.refresh('workstation');
    const record = servers.probeRecord('workstation', 'test-model');
    assert.ok(!Number.isNaN(Date.parse(record.probedAt)));
    assert.strictEqual(record.context, 8192);
    assert.strictEqual(record.contextSource, 'server');
    assert.strictEqual(record.toolCall, 'yes');
    assert.strictEqual(record.imageInput, 'no');
    assert.strictEqual(record.stream, true);
    assert.strictEqual(record.usageReported, true);
    assert.ok(Number.isFinite(record.firstTokenMs) && record.firstTokenMs >= 0);
    assert.ok(record.tokensPerSecond === null || record.tokensPerSecond > 0);
    assert.strictEqual(record.sample, 'Hello there');
    assert.strictEqual(record.digest, `sha256:${DIGEST}`);
    assert.deepStrictEqual(record.adapters, []);
    assert.strictEqual(record.error, null);

    const vision = servers.probeRecord('workstation', 'vision-model');
    assert.strictEqual(vision.imageInput, 'yes');
    assert.strictEqual(vision.context, null);
    assert.strictEqual(vision.contextSource, 'unknown');
    assert.strictEqual(vision.digest, null);

    // The fixed strings, and nothing else, were sent.
    const sent = posts('ollama').slice(sentBefore);
    assert.strictEqual(sent.length, 4, 'two models, a tool step and a smoke step each');
    const toolStep = sent.find((r) => r.body.model === 'test-model' && Array.isArray(r.body.tools));
    assert.deepStrictEqual(toolStep.body.messages, [{ role: 'user', content: 'Call the ok tool.' }]);
    assert.strictEqual(toolStep.body.tools.length, 1);
    assert.strictEqual(toolStep.body.tools[0].function.name, 'ok');
    const smoke = sent.find((r) => r.body.model === 'test-model' && !r.body.tools);
    assert.deepStrictEqual(smoke.body.messages, [{ role: 'user', content: 'Reply with the word ok.' }]);
    assert.strictEqual(smoke.body.max_tokens, 8);
    assert.strictEqual(smoke.body.stream, true);
    assert.strictEqual(PROBE_TOOL_PROMPT, 'Call the ok tool.');
    assert.strictEqual(PROBE_SMOKE_PROMPT, 'Reply with the word ok.');

    // The catalog holds them as free local models.
    const row = catalog.get('local', 'workstation/test-model');
    assert.strictEqual(row.local, true);
    assert.deepStrictEqual(row.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, tiers: [] });
    assert.strictEqual(row.limits.context, 8192);
    assert.strictEqual(row.toolCall, true);
    assert.deepStrictEqual(row.input, ['text']);
    assert.deepStrictEqual(catalog.get('local', 'workstation/vision-model').input, ['text', 'image']);

    assert.deepStrictEqual(view.models.map((m) => m.id), ['test-model', 'vision-model', 'gpt-oss:120b-cloud']);
    assert.strictEqual(servers.explain('workstation/test-model', { needs: { toolCall: true, minContext: 8000 } }).usable, true);
  });

  it('R-LI-7: context, tool calling and the smoke call are recorded (an openai-compatible server)', async () => {
    const { servers, catalog } = registry();
    await servers.refresh('compat');
    const record = servers.probeRecord('compat', 'tool-model');
    assert.strictEqual(record.context, 32768);
    assert.strictEqual(record.contextSource, 'server');
    assert.strictEqual(record.toolCall, 'yes');
    assert.strictEqual(record.imageInput, 'unknown');
    assert.strictEqual(record.stream, true);
    assert.strictEqual(record.usageReported, true);
    assert.strictEqual(record.sample, 'Hello there');
    assert.strictEqual(record.error, null);
    assert.strictEqual(servers.probeRecord('compat', 'text-only-model').contextSource, 'unknown');
    assert.strictEqual(catalog.get('local', 'compat/tool-model').limits.context, 32768);
    assert.deepStrictEqual(catalog.list('local').map((e) => e.id), ['compat/no-usage-model', 'compat/slow-model', 'compat/text-only-model', 'compat/tool-model']);
    const listing = server.requests.filter((r) => r.provider === 'compat' && r.method === 'GET');
    assert.ok(listing.every((r) => r.path === '/compat/v1/models'));
  });

  it('a model that answers a tool request in text is toolCall "no", and explain refuses it a tool job', async () => {
    const { servers, catalog } = registry();
    await servers.refresh('compat');
    assert.strictEqual(servers.probeRecord('compat', 'text-only-model').toolCall, 'no');
    assert.strictEqual(catalog.get('local', 'compat/text-only-model').toolCall, false);
    const verdict = servers.explain('compat/text-only-model', { needs: { toolCall: true } });
    assert.strictEqual(verdict.usable, false);
    assert.match(verdict.reasons[0], /tool/);
    assert.strictEqual(servers.explain('compat/text-only-model').usable, true);
  });

  it('a server that reports no usage gives usageReported: false', async () => {
    const { servers } = registry();
    await servers.refresh('compat');
    const record = servers.probeRecord('compat', 'no-usage-model');
    assert.strictEqual(record.usageReported, false);
    assert.strictEqual(record.stream, true);
    assert.strictEqual(record.sample, 'Hello there');
    assert.strictEqual(record.error, null);
  });

  it('a delayed first token shows in firstTokenMs', async () => {
    const { servers } = registry();
    await servers.refresh('compat');
    const slow = servers.probeRecord('compat', 'slow-model').firstTokenMs;
    assert.ok(slow >= 100, `slow-model's first token took ${slow} ms`);
    assert.ok(servers.probeRecord('compat', 'tool-model').firstTokenMs < slow);
  });

  it('R-LI-7: a probed model is not probed again', async () => {
    const { servers } = registry();
    const start = posts('compat').length;
    await servers.refresh('compat');
    const chat = posts('compat').length;
    const all = server.requests.length;
    assert.strictEqual(chat - start, 8, 'four models, two steps each');
    await servers.refresh('compat');
    assert.strictEqual(posts('compat').length, chat, 'no model was probed a second time');
    assert.strictEqual(server.requests.length, all + 1, 'only the listing was asked again');
    // The owner asks: that one model is probed again.
    const first = servers.probeRecord('compat', 'tool-model').probedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await servers.probe('compat', 'tool-model');
    assert.strictEqual(posts('compat').length, chat + 2);
    assert.notStrictEqual(again.probedAt, first);
  });

  it('two refreshes at once share one run', async () => {
    const { servers } = registry();
    const before = server.requests.length;
    await Promise.all([servers.refresh('compat'), servers.refresh('compat')]);
    assert.strictEqual(server.requests.length - before, 1 + 8);
  });

  it('refresh with `only` probes just the models named', async () => {
    const { servers } = registry();
    const before = posts('compat').length;
    await servers.refresh('compat', { only: ['slow-model', 'not-on-the-server'] });
    assert.strictEqual(posts('compat').length - before, 2);
    assert.ok(servers.probeRecord('compat', 'slow-model'));
    assert.strictEqual(servers.probeRecord('compat', 'tool-model'), null);
    const verdict = servers.explain('compat/not-on-the-server');
    assert.strictEqual(verdict.usable, false);
    assert.strictEqual(verdict.code, 'LOCAL_MODEL_NOT_LISTED');
    // A listed model with no record yet is usable, capabilities unknown.
    const unprobed = servers.explain('compat/tool-model', { needs: { toolCall: true } });
    assert.strictEqual(unprobed.usable, true);
    assert.ok(unprobed.notes.some((n) => /not probed/.test(n)));
  });

  it('a cloud id is listed, not probed, and not in the catalog', async () => {
    const { servers, catalog } = registry();
    const view = await servers.refresh('workstation');
    const cloud = view.models.find((m) => m.id === 'gpt-oss:120b-cloud');
    assert.strictEqual(cloud.cloud, true);
    assert.strictEqual(cloud.record, null);
    assert.strictEqual(servers.probeRecord('workstation', 'gpt-oss:120b-cloud'), null);
    assert.ok(!posts('ollama').some((r) => r.body.model === 'gpt-oss:120b-cloud'));
    assert.ok(!server.requests.some((r) => r.path === '/ollama/api/show' && r.body.model === 'gpt-oss:120b-cloud'));
    assert.deepStrictEqual(catalog.list('local').map((e) => e.id), ['workstation/test-model', 'workstation/vision-model']);
    await assert.rejects(servers.probe('workstation', 'gpt-oss:120b-cloud'), (err) => err.code === 'LOCAL_CLOUD_MODEL');
    assert.throws(() => servers.setModelInfo('workstation', 'gpt-oss:120b-cloud', { context: 4096 }), (err) => err.code === 'LOCAL_CLOUD_MODEL');
    assert.deepStrictEqual(catalog.list('local').map((e) => e.id), ['workstation/test-model', 'workstation/vision-model']);
  });

  it('setModelInfo survives a restart and is not overwritten by refresh or a new probe', async () => {
    const dir = tmp();
    const first = registry({ dir });
    await first.servers.refresh('compat');
    const set = first.servers.setModelInfo('compat', 'text-only-model', { context: 16384, imageInput: true });
    assert.strictEqual(set.context, 16384);
    assert.strictEqual(set.contextSource, 'owner');
    assert.strictEqual(set.imageInput, 'yes');
    assert.throws(() => first.servers.setModelInfo('compat', 'text-only-model', { context: -4 }), (err) => err.code === 'LOCAL_MODEL_INFO_INVALID');
    assert.throws(() => first.servers.setModelInfo('compat', 'text-only-model', { imageInput: 'yes' }), (err) => err.code === 'LOCAL_MODEL_INFO_INVALID');
    assert.throws(() => first.servers.setModelInfo('gone', 'text-only-model', { context: 4096 }), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
    first.servers.close();

    const second = registry({ dir });
    const record = second.servers.probeRecord('compat', 'text-only-model');
    assert.strictEqual(record.context, 16384);
    assert.strictEqual(record.contextSource, 'owner');
    assert.strictEqual(record.imageInput, 'yes');
    // Loaded at start, with no request: the catalog has it before any refresh.
    const before = server.requests.length;
    assert.strictEqual(second.catalog.get('local', 'compat/text-only-model').limits.context, 16384);
    assert.deepStrictEqual(second.catalog.get('local', 'compat/text-only-model').input, ['text', 'image']);
    assert.strictEqual(server.requests.length, before);
    await second.servers.refresh('compat');
    await second.servers.probe('compat', 'text-only-model');
    const after = second.servers.probeRecord('compat', 'text-only-model');
    assert.strictEqual(after.context, 16384);
    assert.strictEqual(after.contextSource, 'owner');
    assert.strictEqual(after.imageInput, 'yes');
    assert.strictEqual(second.servers.explain('compat/text-only-model', { needs: { minContext: 20000 } }).usable, false);
    assert.strictEqual(second.servers.explain('compat/text-only-model', { needs: { minContext: 16000, imageInput: true } }).usable, true);
    assert.strictEqual(second.servers.explain('compat/tool-model', { needs: { imageInput: true } }).usable, false, 'unknown image input is never claimed');
  });

  it('the probe file is written atomically, in the documented shape', async () => {
    const { servers, probeFile, dir } = registry();
    await servers.refresh('compat', { only: ['tool-model'] });
    const doc = JSON.parse(fs.readFileSync(probeFile, 'utf8'));
    assert.strictEqual(doc.version, 1);
    assert.deepStrictEqual(Object.keys(doc.models), ['compat/tool-model']);
    assert.deepStrictEqual(Object.keys(doc.models['compat/tool-model']).sort(), [
      'adapters', 'context', 'contextSource', 'digest', 'error', 'firstTokenMs', 'imageInput', 'probedAt', 'sample', 'stream',
      'tokensPerSecond', 'toolCall', 'usageReported'
    ]);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'models')), ['local-probes.json'], 'no temp file is left');
  });

  it('a probe file that is not JSON is read as empty with one warning', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'models', 'local-probes.json'), '{ not json');
    const warnings = [];
    setLogLevel('warn');
    const remove = addSink((record) => { if (record.level === 'warn') warnings.push(record.message); });
    try {
      const { servers, catalog } = registry({ dir });
      assert.strictEqual(servers.probeRecord('compat', 'tool-model'), null);
      assert.strictEqual(servers.probeRecord('workstation', 'test-model'), null);
      assert.deepStrictEqual(catalog.list('local'), []);
      assert.strictEqual(warnings.length, 1);
    } finally {
      remove();
      setLogLevel('fatal');
    }
  });

  it('a probe file with records of the wrong shape keeps only the well-formed ones', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    const good = { probedAt: AT, context: 4096, contextSource: 'server', toolCall: 'yes', imageInput: 'no', stream: true, usageReported: true, firstTokenMs: 10, tokensPerSecond: 5, sample: 'ok', digest: null, adapters: [], error: null };
    fs.writeFileSync(path.join(dir, 'models', 'local-probes.json'), JSON.stringify({
      version: 1,
      models: {
        'compat/tool-model': good,
        'compat/forged': { ...good, toolCall: true, imageInput: 'definitely', context: '1e9', local: true, grade: 'guarantee' },
        'no-server-prefix': good,
        'compat/list': [1, 2]
      }
    }));
    const { servers, catalog } = registry({ dir });
    assert.strictEqual(servers.probeRecord('compat', 'tool-model').toolCall, 'yes');
    const forged = servers.probeRecord('compat', 'forged');
    assert.strictEqual(forged.toolCall, 'unknown');
    assert.strictEqual(forged.imageInput, 'unknown');
    assert.strictEqual(forged.context, null);
    assert.strictEqual('local' in forged, false);
    assert.strictEqual('grade' in forged, false);
    assert.strictEqual(catalog.get('local', 'compat/forged').toolCall, false);
    assert.strictEqual(servers.probeRecord('compat', 'list'), null);
  });

  it('a forged probe can make a model look capable; it cannot make a server local', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    const record = { probedAt: AT, context: 4096, contextSource: 'server', toolCall: 'yes', imageInput: 'yes', stream: true, usageReported: true, firstTokenMs: 10, tokensPerSecond: 5, sample: 'ok', digest: null, adapters: [], error: null };
    fs.writeFileSync(path.join(dir, 'models', 'local-probes.json'), JSON.stringify({ version: 1, models: { 'lan-http/m': record, 'gone/m': record } }));
    const lan = entry('lan-http', 'vllm', 'http://192.168.1.20:8000', { pinned: { addresses: ['192.168.1.20'], class: 'lan', at: AT } });
    const { servers, catalog } = registry({ dir, list: [lan] });
    assert.notStrictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'lan-http/m' }), true);
    assert.notStrictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'gone/m' }), true);
    assert.strictEqual(servers.explain('gone/m').code, 'LOCAL_SERVER_UNKNOWN');
    assert.strictEqual(catalog.get('local', 'gone/m'), null, 'a record for a server that is not configured is not in the catalog');
    assert.strictEqual(catalog.price('local', 'gone/m', { input: 10, output: 10 }), null);
  });

  it('the probe record and the log hold no text beyond sample', async () => {
    const lines = [];
    setLogLevel('trace');
    const remove = addSink((record) => lines.push(JSON.stringify(record)));
    let doc;
    try {
      const { servers, probeFile } = registry();
      await servers.refresh('compat');
      await servers.refresh('workstation');
      doc = fs.readFileSync(probeFile, 'utf8');
    } finally {
      remove();
      setLogLevel('fatal');
    }
    assert.ok(lines.length > 0, 'the probe logs what it did');
    for (const line of lines) {
      assert.ok(!/Hello|there|Call the ok tool|Reply with the word/i.test(line), line);
    }
    const parsed = JSON.parse(doc);
    for (const record of Object.values(parsed.models)) {
      const { sample, ...rest } = record;
      assert.ok(typeof sample === 'string' && sample.length <= 40);
      assert.ok(!/Hello|weather|Lookup/.test(JSON.stringify(rest)), JSON.stringify(rest));
    }
  });

  it('sample is the first 40 characters, on one line', async () => {
    const t = createLocalTransport({ baseUrl: `${server.url}/compat`, addresses: ['127.0.0.1'] });
    server.setReply('long-reply-model', `line one\nline two ${'x'.repeat(200)}`);
    try {
      const record = await probeModel({ id: 'compat', kind: 'vllm', baseUrl: `${server.url}/compat` }, 'long-reply-model', { fetch: t.fetch });
      assert.strictEqual(record.sample.length, 40);
      assert.ok(!/[\n\r]/.test(record.sample));
      assert.ok(record.sample.startsWith('line one line two'));
    } finally {
      t.close();
    }
  });

  it('each step that fails is "unknown" with the error; the probe never throws and never says capable', async () => {
    const t = createLocalTransport({ baseUrl: `${server.url}/compat`, addresses: ['127.0.0.1'] });
    const target = { id: 'compat', kind: 'vllm', baseUrl: `${server.url}/compat` };
    try {
      server.failNext(500);
      const toolFailed = await probeModel(target, 'tool-model', { fetch: t.fetch });
      assert.strictEqual(toolFailed.toolCall, 'unknown');
      assert.match(toolFailed.error, /500/);
      assert.strictEqual(toolFailed.sample, 'Hello there', 'the smoke step still ran');

      server.failNext(500, 2);
      const bothFailed = await probeModel(target, 'tool-model', { fetch: t.fetch });
      assert.strictEqual(bothFailed.toolCall, 'unknown');
      assert.strictEqual(bothFailed.stream, null);
      assert.strictEqual(bothFailed.usageReported, null);
      assert.strictEqual(bothFailed.firstTokenMs, null);
      assert.strictEqual(bothFailed.sample, '');
      assert.ok(bothFailed.error);

      // A server that never answers: each step ends at its timeout.
      const started = Date.now();
      const hung = await probeModel(target, 'hang-model', { fetch: t.fetch, timeoutMs: 150 });
      assert.strictEqual(hung.toolCall, 'unknown');
      assert.strictEqual(hung.stream, null);
      assert.match(hung.error, /timed out|150/);
      assert.ok(Date.now() - started < 3000);

      // A reply larger than the cap is cut off, not read to the end.
      server.setReply('huge-model', 'y'.repeat(3 * 1024 * 1024));
      const huge = await probeModel(target, 'huge-model', { fetch: t.fetch });
      assert.strictEqual(huge.toolCall, 'unknown', 'a tool reply over the cap is not read');
      assert.match(huge.error, /too large/);
      assert.ok(huge.sample.length <= 40);
      assert.notStrictEqual(huge.stream, true, 'a smoke reply over the cap is not a working stream');

      // Unreachable: a closed transport stands in for a server that is down.
      t.close();
      const down = await probeModel(target, 'tool-model', { fetch: t.fetch });
      assert.strictEqual(down.toolCall, 'unknown');
      assert.strictEqual(down.imageInput, 'unknown');
      assert.strictEqual(down.contextSource, 'unknown');
      assert.ok(down.error);
    } finally {
      t.close();
    }
  });

  it('what an Ollama server reports about tools never raises the answer, and can lower it', async () => {
    const t = createLocalTransport({ baseUrl: `${server.url}/ollama`, addresses: ['127.0.0.1'] });
    const target = { id: 'workstation', kind: 'ollama', baseUrl: `${server.url}/ollama` };
    try {
      // Says "tools", fails the tool step: unknown, not yes.
      server.failNext(500, 1, '/chat/completions');
      const claimed = await probeModel(target, 'test-model', { fetch: t.fetch });
      assert.strictEqual(claimed.toolCall, 'unknown');
      // Says no tools, and the tool step fails: no.
      server.failNext(400, 1, '/chat/completions');
      const denied = await probeModel(target, 'vision-model', { fetch: t.fetch });
      assert.strictEqual(denied.toolCall, 'no');
    } finally {
      t.close();
    }
  });

  it('a refresh that cannot list throws, records nothing, and a server that is not there is refused', async () => {
    const { servers, catalog } = registry();
    server.failNext(503);
    await assert.rejects(servers.refresh('compat'), (err) => err.status === 503);
    assert.strictEqual(servers.probeRecord('compat', 'tool-model'), null);
    assert.deepStrictEqual(catalog.list('local'), []);
    // Not listed yet, so nothing says the model is missing: usable, unknown.
    assert.strictEqual(servers.explain('compat/tool-model').usable, true);
    await assert.rejects(servers.refresh('gone'), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
    await assert.rejects(servers.probe('gone', 'm'), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
  });

  it('a server that is removed takes its models out of the catalog; its records stay on disk', async () => {
    let list = entries();
    const { servers, catalog } = registry({ list: () => list });
    await servers.refresh('compat', { only: ['tool-model'] });
    assert.ok(catalog.get('local', 'compat/tool-model'));
    list = [list[0]];
    servers.syncCatalog();
    assert.strictEqual(catalog.get('local', 'compat/tool-model'), null);
    assert.ok(servers.probeRecord('compat', 'tool-model'), 'the observation is kept');
  });

  it('models.overrides for local:<id> cannot change cost or local', async () => {
    let settings = {};
    const catalog = fixtureCatalog({ getSettings: () => settings });
    const { servers } = registry({ catalog });
    await servers.refresh('compat', { only: ['tool-model'] });
    settings = {
      models: {
        overrides: {
          'local:compat/tool-model': { cost: { input: 9, output: 9 }, local: false, toolCall: false, limits: { context: 1000 }, provider: 'openai', id: 'gpt-5.5' },
          'local:compat/never-probed': { cost: { input: 1, output: 1 }, toolCall: true },
          'local:gone/model': { toolCall: true }
        }
      }
    };
    const row = catalog.get('local', 'compat/tool-model');
    assert.strictEqual(row.local, true);
    assert.deepStrictEqual(row.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, tiers: [] });
    assert.strictEqual(row.provider, 'local');
    assert.strictEqual(row.id, 'compat/tool-model');
    // A capability may be changed (spec §6.5).
    assert.strictEqual(row.toolCall, false);
    assert.strictEqual(row.limits.context, 1000);
    assert.strictEqual(catalog.price('local', 'compat/tool-model', { input: 1e6, output: 1e6 }).usd, 0);
    // An override makes no local model that the registry does not hold.
    assert.strictEqual(catalog.get('local', 'compat/never-probed'), null);
    assert.strictEqual(catalog.get('local', 'gone/model'), null);
    // And a hosted override still works as before.
    settings = { models: { overrides: { 'openai:brand-new': { cost: { input: 2, output: 4 } } } } };
    assert.strictEqual(catalog.get('openai', 'brand-new').cost.input, 2);
  });
});

describe('probing from the core', () => {
  const crypto = require('node:crypto');
  const { createCore } = require('../src/core');
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const { createAesGcmCipher } = require('../src/platform/cipher');
  const { createHeadlessPrompter } = require('../src/platform/prompter');
  const { setActiveCatalog } = require('../src/models');
  const { profileSettings } = require('./helpers/profile-settings');
  const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
  const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');

  let server;
  const originalFetch = globalThis.fetch;
  const originalTestMode = process.env.KL_TEST_MODE;
  const cores = [];
  const dirs = [];
  const t = (provider, model) => ({ provider, model, effort: null });

  before(async () => {
    server = await startFakeLlmServer();
    server.setModels([{ id: 'tool-model', max_model_len: 32768 }, { id: 'text-only-model' }, { id: 'slow-model' }]);
    globalThis.fetch = async (url) => { throw new Error(`no network in unit tests (${url})`); };
  });
  afterEach(async () => {
    if (originalTestMode === undefined) delete process.env.KL_TEST_MODE;
    else process.env.KL_TEST_MODE = originalTestMode;
    while (cores.length) await cores.pop().shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    await server.close();
  });

  function makeCore(roles, { dataDir = null } = {}) {
    const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kl-local-probe-core-'));
    if (!dataDir) dirs.push(dir);
    const store = new JsonFileStore({ dir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', profileSettings({ models: { localServers: [entry('compat', 'vllm', `${server.url}/compat`)] } }, roles));
    const core = createCore({
      paths: { dataDir: dir },
      store,
      vaultStore: new JsonFileStore({ dir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() }
    });
    cores.push(core);
    return { core, dir };
  }

  it('building and starting a core probes nothing and reads the probe file', async () => {
    delete process.env.KL_TEST_MODE;
    const before = server.requests.length;
    const { core, dir } = makeCore({ main: [t('local', 'compat/tool-model')] });
    await core.start();
    assert.strictEqual(server.requests.length, before, 'no request at build or start');
    assert.strictEqual(core.context.getLocalServers().probeRecord('compat', 'tool-model'), null);
    // The file is <dataDir>/models/local-probes.json.
    await core.context.getLocalServers().refresh('compat', { only: ['tool-model'] });
    assert.ok(fs.existsSync(path.join(dir, 'models', 'local-probes.json')));
    await cores.pop().shutdown();
    closeOpenHistoryStores();
    const again = makeCore({ main: [t('local', 'compat/tool-model')] }, { dataDir: dir });
    const requests = server.requests.length;
    assert.strictEqual(again.core.context.getLocalServers().probeRecord('compat', 'tool-model').toolCall, 'yes');
    assert.strictEqual(again.core.models.catalog.get('local', 'compat/tool-model').toolCall, true);
    assert.strictEqual(server.requests.length, requests);
  });

  it('resolveRole probes an unprobed local target before it resolves, and only that model', async () => {
    delete process.env.KL_TEST_MODE;
    const { core } = makeCore({ main: [t('local', 'compat/text-only-model'), t('local', 'compat/tool-model')] });
    const resolved = await core.context.resolveRole('main', { needs: { toolCall: true } });
    assert.deepStrictEqual(resolved.targets, [t('local', 'compat/tool-model')], 'the model that answers in text is skipped for a tool job');
    assert.match(resolved.skipped[0].reasons[0], /tool/);
    const servers = core.context.getLocalServers();
    assert.ok(servers.probeRecord('compat', 'tool-model'));
    assert.ok(servers.probeRecord('compat', 'text-only-model'));
    assert.strictEqual(servers.probeRecord('compat', 'slow-model'), null, 'a model the role does not name is left alone');
    // A second resolve asks the server nothing.
    const before = server.requests.length;
    await core.context.resolveRole('main', { needs: { toolCall: true } });
    assert.strictEqual(server.requests.length, before);
  });

  it('never probes under KL_TEST_MODE', async () => {
    process.env.KL_TEST_MODE = '1';
    const { core } = makeCore({ main: [t('local', 'compat/tool-model')] });
    const before = server.requests.length;
    const resolved = await core.context.resolveRole('main', { needs: { toolCall: true } });
    assert.deepStrictEqual(resolved.targets, [t('local', 'compat/tool-model')]);
    assert.strictEqual(server.requests.length, before);
    assert.deepStrictEqual(await core.models.startBackgroundChecks(), { skipped: true });
    assert.strictEqual(server.requests.length, before);
  });

  it('a server that does not answer the listing does not stop the resolve, and is not asked again at once', async () => {
    delete process.env.KL_TEST_MODE;
    const { core } = makeCore({ main: [t('local', 'compat/tool-model')] });
    server.failNext(503);
    const before = server.requests.length;
    const resolved = await core.context.resolveRole('main');
    assert.deepStrictEqual(resolved.targets, [t('local', 'compat/tool-model')]);
    assert.strictEqual(server.requests.length, before + 1);
    await core.context.resolveRole('main');
    assert.strictEqual(server.requests.length, before + 1, 'the failed listing is not retried within the minute');
  });
});
