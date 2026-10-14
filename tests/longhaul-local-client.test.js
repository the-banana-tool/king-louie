// tests/longhaul-local-client.test.js
// LongHaul's local model client (local inference spec 2026-10-13 §11.1;
// R-LI-14): the base URL is checked and pinned as the app checks a local
// server's, a public address or an Ollama cloud id is refused before any
// request, the client is local (free, and exempt from --send-private), and
// config.json records it. The local server is the fake server on 127.0.0.1;
// an address that must be refused is never dialled, and names are resolved
// by an injected lookup.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createLocalClient } = require('../src/longhaul/local-client');
const { priceCall } = require('../src/longhaul/cost');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { FIXTURE_ROOT, tmpDir, sink, makePrivate } = require('./helpers/longhaul-helpers');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const DIGEST = `sha256:${'ab'.repeat(32)}`;
const refusedConnect = (dialled) => (options) => {
  dialled.push(options.host);
  throw Object.assign(new Error(`connect ECONNREFUSED ${options.host}`), { code: 'ECONNREFUSED' });
};

describe('createLocalClient', () => {
  let server;
  const clients = [];
  before(async () => {
    server = await startFakeLlmServer();
    server.setOllamaModels({ 'test-model': { model_info: {}, capabilities: ['completion'], digest: DIGEST } });
  });
  after(async () => {
    for (const c of clients) c.close();
    await server.close();
  });
  const keep = (c) => { clients.push(c); return c; };

  it('a loopback server gives a local client that sends through the pinned transport at temperature 0', async () => {
    const client = keep(await createLocalClient({ provider: 'ollama', model: 'test-model', baseUrl: `${server.url}/ollama` }));
    assert.strictEqual(client.local, true);
    assert.strictEqual(client.provider, 'local');
    assert.strictEqual(client.kind, 'ollama');
    assert.strictEqual(client.model, 'test-model');
    assert.strictEqual(client.addressClass, 'loopback');
    assert.strictEqual(client.digest, DIGEST);
    assert.strictEqual(client.baseUrl, `${server.url}/ollama`);
    const n = server.requests.length;
    const reply = await client.complete('Say hello.', { maxTokens: 16 });
    assert.strictEqual(reply.text, 'Hello there');
    assert.strictEqual(reply.llmMetrics.costUsd, 0);
    const sent = server.requests.slice(n).find((r) => r.method === 'POST');
    assert.strictEqual(sent.path, '/ollama/v1/chat/completions');
    assert.strictEqual(sent.body.model, 'test-model', 'the server is asked for its own name for the model');
    assert.strictEqual(sent.body.temperature, 0);
  });

  it('--local-context gives the window when the server does not', async () => {
    const client = keep(await createLocalClient({ provider: 'ollama', model: 'test-model', baseUrl: `${server.url}/ollama`, context: 8192 }));
    assert.strictEqual(client.context, 8192);
  });

  it('a public address is LOCAL_REQUIRED, and no socket is opened', async () => {
    const dialled = [];
    await assert.rejects(
      createLocalClient({ provider: 'openai-compatible', model: 'm', baseUrl: 'http://203.0.113.9:8000', transportOptions: { _connect: refusedConnect(dialled) } }),
      (err) => err instanceof UsageError && err.code === 'LOCAL_REQUIRED' && /nothing was sent/.test(err.message)
    );
    assert.deepStrictEqual(dialled, []);
  });

  it('a name whose answer is public is LOCAL_REQUIRED, and no socket is opened', async () => {
    const dialled = [];
    const asked = [];
    const lookup = async (host) => { asked.push(host); return [{ address: '203.0.113.9', family: 4 }]; };
    await assert.rejects(
      createLocalClient({ provider: 'ollama', model: 'test-model', baseUrl: 'http://gpu-box.example.com:11434', lookup, transportOptions: { _connect: refusedConnect(dialled) } }),
      (err) => err.code === 'LOCAL_REQUIRED'
    );
    assert.deepStrictEqual(asked, ['gpu-box.example.com']);
    assert.deepStrictEqual(dialled, []);
  });

  it('an Ollama cloud id is LOCAL_REQUIRED before anything is looked up', async () => {
    const asked = [];
    const lookup = async (host) => { asked.push(host); return [{ address: '127.0.0.1', family: 4 }]; };
    for (const model of ['qwen3:cloud', 'gpt-oss:120b-cloud']) {
      await assert.rejects(createLocalClient({ provider: 'ollama', model, baseUrl: 'http://box.example.com:11434', lookup }), (err) => err.code === 'LOCAL_REQUIRED');
    }
    assert.deepStrictEqual(asked, []);
  });

  it('a LAN http address is accepted (LongHaul measures; it carries no guarantee), and only the pinned address is dialled', async () => {
    const dialled = [];
    const lookup = async () => [{ address: '192.168.1.20', family: 4 }];
    const client = keep(await createLocalClient({
      provider: 'openai-compatible', model: 'm', baseUrl: 'http://gpu-box.example.com:8000', lookup, transportOptions: { _connect: refusedConnect(dialled) }
    }));
    assert.strictEqual(client.addressClass, 'lan');
    assert.strictEqual(client.digest, null);
    assert.deepStrictEqual(dialled, ['192.168.1.20'], 'the listing went to the pinned address and nowhere else');
  });

  it('on Ollama the model must be listed, since its digest names it in the cache keys', async () => {
    await assert.rejects(createLocalClient({ provider: 'ollama', model: 'not-pulled', baseUrl: `${server.url}/ollama` }), (err) => err.code === 'LOCAL_MODEL_NOT_LISTED');
  });

  it('an unknown provider and a missing model are usage errors', async () => {
    await assert.rejects(createLocalClient({ provider: 'openai', model: 'm', baseUrl: 'http://127.0.0.1:9' }), (err) => err instanceof UsageError);
    await assert.rejects(createLocalClient({ provider: 'ollama', model: '' }), (err) => err instanceof UsageError);
    await assert.rejects(createLocalClient({ provider: 'openai-compatible', model: 'm' }), /--local-base-url/);
  });

  it('a local client is priced at $0', async () => {
    const client = keep(await createLocalClient({ provider: 'ollama', model: 'test-model', baseUrl: `${server.url}/ollama` }));
    assert.strictEqual(priceCall(fixtureCatalog(), client, { input: 100000, output: 1000 }), 0);
  });
});

describe('longhaul run with a local model', () => {
  let server;
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  const io = (env) => ({ env, stdout: sink(), stderr: sink() });
  const setup = () => {
    const root = path.join(tmpDir(), 'lh');
    const data = path.join(tmpDir(), 'data');
    fs.cpSync(FIXTURE_ROOT, data, { recursive: true });
    makePrivate(data, 'synth-small');
    return { env: { LONGHAUL_HOME: root }, root, data };
  };
  const local = ['--local-provider', 'ollama', '--local-model', 'test-model', '--local-base-url', `${'URL'}/ollama`];
  const withUrl = (args) => args.map((a) => a.replace('URL', server.url));

  it('a private session with only the local model and --fake-models runs without --send-private', async () => {
    const { env, root, data } = setup();
    const base = ['run', '--sessions', data, '--session', 'synth-small', '--adapters', 'kl-recall-rewrite'];
    const first = io(env);
    assert.strictEqual(await main([...base, ...withUrl(local)], first), 0, first.stderr.text);
    const runs = fs.readdirSync(path.join(root, 'runs'));
    const config = JSON.parse(fs.readFileSync(path.join(root, 'runs', runs[0], 'config.json'), 'utf8'));
    assert.strictEqual(config.local.provider, 'ollama');
    assert.strictEqual(config.local.model, 'test-model');
    assert.strictEqual(config.local.addressClass, 'loopback');
    assert.strictEqual(config.local.baseUrl, `${server.url}/ollama`);
    assert.match(config.local.prompts.rewrite.sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(config.local.prompts.abstainCheck, undefined);

    // The answer stage reads the local calls from the cache; nothing asks for --send-private.
    const second = io(env);
    assert.strictEqual(await main([...base, ...withUrl(local), '--fake-models'], second), 0, second.stderr.text);
    assert.doesNotMatch(second.stderr.text, /send-private/);
  });

  it('the answer stage without the evidence-only run first stops with LOCAL_CALLS_MISSING', async () => {
    const { env, data } = setup();
    const out = io(env);
    const code = await main(['run', '--sessions', data, '--session', 'synth-small', '--adapters', 'kl-recall-rewrite', ...withUrl(local), '--fake-models'], out);
    assert.strictEqual(code, 2);
    assert.match(out.stderr.text, /evidence-only run/);
  });

  it('a public --local-base-url exits 2 before any request', async () => {
    const { env, data } = setup();
    const out = io(env);
    const n = server.requests.length;
    const code = await main(['run', '--sessions', data, '--adapters', 'kl-recall-rewrite', '--local-provider', 'openai-compatible', '--local-model', 'm', '--local-base-url', 'http://203.0.113.9:8000'], out);
    assert.strictEqual(code, 2);
    assert.match(out.stderr.text, /not a local server address/);
    assert.strictEqual(server.requests.length, n);
  });

  it('--local-* without a local adapter is a usage error', async () => {
    const { env, data } = setup();
    const out = io(env);
    assert.strictEqual(await main(['run', '--sessions', data, '--adapters', 'kl-recall', ...withUrl(local)], out), 2);
    assert.match(out.stderr.text, /--local-/);
  });
});
