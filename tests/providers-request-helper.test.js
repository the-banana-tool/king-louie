// tests/providers-request-helper.test.js
// One request helper (spec 2026-09-27 §9): every provider fetch carries the
// abort signal, and an aborted call reports the usage it had so far.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const GroqProvider = require('../src/providers/groq-provider');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const { fixtureCatalog } = require('./helpers/models-fixture');

const PROVIDERS_DIR = path.join(__dirname, '..', 'src', 'providers');
const providerFiles = () => fs.readdirSync(PROVIDERS_DIR).filter((f) => f.endsWith('-provider.js') && f !== 'base-provider.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('BaseLLMProvider.request', () => {
  it('attaches options.abortSignal, and adds no signal without one', async () => {
    const seen = [];
    globalThis.fetch = async (_url, init) => { seen.push(init); return new Response('{}'); };
    const p = new GroqProvider('test-key-123456');
    const controller = new AbortController();
    await p.request('http://127.0.0.1:9/x', { method: 'GET' }, { abortSignal: controller.signal });
    await p.request('http://127.0.0.1:9/x', { method: 'GET' }, {});
    assert.strictEqual(seen[0].signal, controller.signal);
    assert.strictEqual(seen[0].method, 'GET');
    assert.strictEqual('signal' in seen[1], false);
  });

  it('turns an abort before the response into an AbortError with an empty partial record', async () => {
    globalThis.fetch = async (_url, init) => { throw init.signal.reason; };
    const p = new GroqProvider('test-key-123456', { catalog: fixtureCatalog() });
    const controller = new AbortController();
    controller.abort('stopped by owner');
    await assert.rejects(p.request('http://127.0.0.1:9/x', {}, { abortSignal: controller.signal, model: 'llama-3.3-70b' }), (err) => {
      assert.strictEqual(err.name, 'AbortError');
      assert.match(err.message, /stopped by owner/);
      assert.strictEqual(err.partialLlmMetrics.usagePartial, true);
      assert.strictEqual(err.partialLlmMetrics.costUsd, null);
      assert.strictEqual(err.partialLlmMetrics.model, 'llama-3.3-70b');
      return true;
    });
  });

  it('surfaces an AbortSignal.timeout() as a timeout, not a bare "aborted" message', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    globalThis.fetch = async (_url, init) => { throw init.signal.reason; };
    const p = new GroqProvider('test-key-123456', { catalog: fixtureCatalog() });
    await assert.rejects(p.request('http://127.0.0.1:9/x', {}, { abortSignal: signal, model: 'llama-3.3-70b' }), (err) => {
      assert.strictEqual(err.name, 'AbortError');
      assert.match(err.message, /timeout/i);
      assert.notStrictEqual(err.message, 'The operation was aborted.');
      return true;
    });
  });

  it('leaves a failure that is not an abort untouched', async () => {
    const boom = new Error('fetch failed');
    globalThis.fetch = async () => { throw boom; };
    const p = new GroqProvider('test-key-123456');
    await assert.rejects(p.request('http://127.0.0.1:9/x', {}, { abortSignal: new AbortController().signal }), (err) => err === boom);
  });
});

describe('BaseLLMProvider.guardStream', () => {
  it('attaches the usage reported before the abort, priced', async () => {
    const p = new AnthropicProvider('sk-ant-test-123456', { catalog: fixtureCatalog() });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      p.guardStream({ abortSignal: controller.signal }, () => ({ model: 'claude-haiku-4-5', usage: { input_tokens: 1200, output_tokens: 1 } }), async () => { throw new DOMException('aborted', 'AbortError'); }),
      (err) => err.name === 'AbortError' && err.partialLlmMetrics.inputTokens === 1200 && err.partialLlmMetrics.costUsd === 0.001205 && err.partialLlmMetrics.usagePartial === true
    );
  });

  it('passes a read result and a non-abort failure through', async () => {
    const p = new GroqProvider('test-key-123456');
    assert.strictEqual(await p.guardStream({}, () => ({}), async () => 'done'), 'done');
    const boom = new Error('bad chunk');
    await assert.rejects(p.guardStream({}, () => ({}), async () => { throw boom; }), (err) => err === boom && !err.partialLlmMetrics);
  });
});

describe('every provider goes through the helper', () => {
  it('no provider calls fetch directly', () => {
    for (const file of providerFiles()) {
      const src = fs.readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');
      assert.doesNotMatch(src, /(^|[^.\w])fetch\(/m, `${file} calls fetch directly; use this.request(url, init, options)`);
    }
  });

  it('every streaming method reads through guardStream', () => {
    for (const file of providerFiles()) {
      const src = fs.readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');
      const streams = (src.match(/async (streamMessage|streamMessageWithTools|_streamResponses)\(/g) || []).length;
      const guarded = (src.match(/this\.guardStream\(/g) || []).length;
      assert.ok(streams > 0, `${file} has a streaming method`);
      assert.strictEqual(guarded, streams, `${file}: ${streams} streaming methods, ${guarded} guarded`);
    }
  });

  it('every listModels takes options', () => {
    for (const file of providerFiles()) {
      const src = fs.readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');
      assert.match(src, /async listModels\(options = \{\}\)/, file);
    }
  });
});
