// tests/longhaul-quota.test.js
// A provider refusal that means the account is out of credit or quota stops
// a LongHaul run like a refused key (QUOTA, exit 2, spend.json stoppedBy
// QUOTA) for answer, judge and summarizer calls; a plain rate limit is still
// retried. The errors come from the real providers' buildError over recorded
// response shapes. No network: a loopback server stands in for the provider.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const OpenAIProvider = require('../src/providers/openai-provider');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const {
  isQuotaFailure, retryable, withRetries, stopErrorFor, quotaStopError, STOP_CODES
} = require('../src/longhaul/retry');
const { runBenchmark } = require('../src/longhaul/run');
const { createAdapter } = require('../src/longhaul/adapters');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { ModelCache } = require('../src/longhaul/model-cache');
const { loadPrompt } = require('../src/longhaul/prompts');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OPENAI_QUOTA = { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } };
const OPENAI_RATE = { error: { message: 'Rate limit reached for test-model in organization org-test on tokens per min (TPM). Please try again in 20ms. You can increase your rate limit by adding a payment method at https://platform.openai.com/account/billing.', type: 'tokens', param: null, code: 'rate_limit_exceeded' } };
const ANTHROPIC_CREDIT = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } };
const ANTHROPIC_BILLING = { type: 'error', error: { type: 'billing_error', message: 'There is an issue with your billing.' } };
const ANTHROPIC_RATE = { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit.' } };
const noWait = async () => {};

describe('the thrown error tells a quota refusal from a rate limit', () => {
  const openai = new OpenAIProvider('sk-test-1234567890');
  const anthropic = new AnthropicProvider('sk-ant-test-1234567890');

  it('OpenAI insufficient_quota: HTTP 429 with type and code on the ProviderError; not retryable', async () => {
    const err = await openai.buildError(jsonResponse(429, OPENAI_QUOTA));
    assert.strictEqual(err.status, 429);
    assert.strictEqual(err.type, 'insufficient_quota');
    assert.strictEqual(err.code, 'insufficient_quota');
    assert.strictEqual(isQuotaFailure(err), true);
    assert.strictEqual(retryable(err), false);
  });

  it('a plain OpenAI rate limit stays retryable, though its message links the billing page', async () => {
    const err = await openai.buildError(jsonResponse(429, OPENAI_RATE));
    assert.strictEqual(err.code, 'rate_limit_exceeded');
    assert.strictEqual(isQuotaFailure(err), false);
    assert.strictEqual(retryable(err), true);
  });

  it('Anthropic: a 400 credit-balance message and a 402 billing_error are quota; a 429 rate_limit_error is not', async () => {
    const credit = await anthropic.buildError(jsonResponse(400, ANTHROPIC_CREDIT));
    assert.strictEqual(credit.status, 400);
    assert.match(credit.message, /credit balance is too low/);
    assert.strictEqual(isQuotaFailure(credit), true);
    const billing = await anthropic.buildError(jsonResponse(402, ANTHROPIC_BILLING));
    assert.strictEqual(billing.type, 'billing_error');
    assert.strictEqual(isQuotaFailure(billing), true);
    const rate = await anthropic.buildError(jsonResponse(429, ANTHROPIC_RATE));
    assert.strictEqual(isQuotaFailure(rate), false);
    assert.strictEqual(retryable(rate), true);
  });

  it('any 402 is quota (DeepSeek "Insufficient Balance"); a message with no status is not', async () => {
    const err = await openai.buildError(jsonResponse(402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } }));
    assert.strictEqual(isQuotaFailure(err), true);
    assert.strictEqual(isQuotaFailure(new TypeError('fetch failed')), false);
    assert.strictEqual(isQuotaFailure(new Error('insufficient quota')), false);
    assert.strictEqual(isQuotaFailure(null), false);
  });

  it('withRetries: a quota refusal is tried once, a rate limit four times; isRetryable overrides', async () => {
    let n = 0;
    const quota = Object.assign(new Error('quota'), { status: 429, type: 'insufficient_quota' });
    await assert.rejects(withRetries(async () => { n += 1; throw quota; }, { wait: noWait }), (e) => e === quota);
    assert.strictEqual(n, 1);
    n = 0;
    await assert.rejects(withRetries(async () => { n += 1; throw Object.assign(new Error('slow down'), { status: 429 }); }, { wait: noWait }));
    assert.strictEqual(n, 4);
    n = 0;
    const odd = Object.assign(new Error('odd'), { code: 'ODD' });
    await assert.rejects(withRetries(async () => { n += 1; throw odd; }, { wait: noWait, retries: 2, isRetryable: (e) => e.code === 'ODD' }));
    assert.strictEqual(n, 3);
  });

  it('stopErrorFor: QUOTA before AUTH, null for anything else', () => {
    const q = stopErrorFor(Object.assign(new Error('Your credit balance is too low'), { status: 403 }), 'anthropic');
    assert.ok(q instanceof UsageError);
    assert.strictEqual(q.code, 'QUOTA');
    assert.match(q.message, /^anthropic refused the call: the account is out of credit or quota \(403\); the run stopped\./);
    assert.strictEqual(stopErrorFor(Object.assign(new Error('no'), { status: 401 }), 'openai').code, 'AUTH');
    assert.strictEqual(stopErrorFor(Object.assign(new Error('x'), { status: 500 }), 'openai'), null);
    assert.match(quotaStopError('openai', 429, 'the summarizer').message, /\(429\) for the summarizer; the run stopped/);
    assert.deepStrictEqual([...STOP_CODES], ['AUTH', 'QUOTA']);
  });
});

const catalog = fixtureCatalog();
const prompts = { answer: loadPrompt('answer'), judge: loadPrompt('judge'), summarize: loadPrompt('summarize') };
const fixedNow = () => new Date('2026-10-04T10:15:00.000Z');
const quotaError = () => Object.assign(
  new Error('You exceeded your current quota, please check your plan and billing details.'),
  { status: 429, type: 'insufficient_quota', code: 'insufficient_quota' }
);

function setup() {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeSyntheticRoot(home.root, [SYNTH_FIXTURES[0]]);
  return home;
}

// Declines every question (the judge rules a decline abstained); out of
// quota from call number quotaAt on.
function client(provider, model, { quotaAt = null, judge = false } = {}) {
  return {
    provider, model, prompts: [],
    async complete(prompt) {
      this.prompts.push(prompt);
      if (quotaAt !== null && this.prompts.length >= quotaAt) throw quotaError();
      const text = judge ? JSON.stringify({ verdict: 'abstained', reason: 'fake reason' }) : "I don't know";
      const input = Math.ceil(prompt.length / 4);
      return { text, llmMetrics: { inputTokens: input, outputTokens: 5, costUsd: catalog.price(provider, model, { input, output: 5 }).usd } };
    }
  };
}

const options = (home, over = {}) => ({
  answerClient: client('openai', 'gpt-6-lite'),
  judgeClient: client('anthropic', 'claude-haiku-4-5', { judge: true }),
  prompts, catalog, cache: ModelCache.forHome(home), concurrency: 1, retry: { wait: noWait }, ...over
});
const onlySpend = (home) => {
  const [run] = fs.readdirSync(home.runs);
  return JSON.parse(fs.readFileSync(path.join(home.runs, run, 'spend.json'), 'utf8'));
};

describe('a run out of quota stops', () => {
  it('an answer call: QUOTA, stoppedBy QUOTA, nothing cached for it; a rerun finishes from the cache', async () => {
    const home = setup();
    const answerClient = client('openai', 'gpt-6-lite', { quotaAt: 4 });
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle')], answer: options(home, { answerClient }), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'QUOTA' && /^openai refused the call: the account is out of credit or quota \(429\)/.test(err.message)
    );
    assert.strictEqual(answerClient.prompts.length, 4, 'the refusal is not retried and no item starts after it');
    const spend = onlySpend(home);
    assert.strictEqual(spend.stoppedBy, 'QUOTA');
    assert.strictEqual(spend.calls, 6, 'three answers and three judgments were paid before the refusal');

    let counts = null;
    const second = options(home, { onPlan: (p) => { counts = p.counts; } });
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: second, now: fixedNow, commit: 'x' });
    // counts.answers / judgments are the calls still to make (planCalls).
    assert.deepStrictEqual(counts, { answers: 3, answersCached: 3, judgments: 3, judgmentsCached: 3, summaries: 0, summariesCached: 0 });
    assert.strictEqual(second.answerClient.prompts.length, 3, 'only the answers the stopped run never got');
    assert.strictEqual(out.spend.stoppedBy, null);
    assert.ok(out.records.every((r) => !r.answerError));
  });

  it('a judge call: QUOTA naming the judge provider', async () => {
    const home = setup();
    const judgeClient = client('anthropic', 'claude-haiku-4-5', { judge: true, quotaAt: 2 });
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle')], answer: options(home, { judgeClient }), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'QUOTA' && /^anthropic refused the call/.test(err.message)
    );
    assert.strictEqual(judgeClient.prompts.length, 2);
    assert.strictEqual(onlySpend(home).stoppedBy, 'QUOTA');
  });

  it('a summarizer call: QUOTA for the summarizer, called once', async () => {
    const home = setup();
    const cache = ModelCache.forHome(home);
    const summarizer = { provider: 'openai', model: 'gpt-6-lite', prompts: [], async complete(p) { this.prompts.push(p); throw quotaError(); } };
    const adapter = createAdapter('summarize-compact', {
      compactEveryTokens: 2000, summarizer: { client: summarizer, cache, prompt: prompts.summarize, retry: { wait: noWait } }
    });
    await assert.rejects(
      runBenchmark({ home, adapters: [adapter], answer: options(home, { cache }), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'QUOTA' && /for the summarizer; the run stopped/.test(err.message)
    );
    assert.strictEqual(summarizer.prompts.length, 1);
    assert.strictEqual(onlySpend(home).stoppedBy, 'QUOTA');
  });

  it('from the CLI against a provider answering 429 insufficient_quota: exit 2, one request', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests.push(req.url);
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify(OPENAI_QUOTA));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1`;
    try {
      const { env, root } = tmpHome();
      writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
      const io = { stdout: sink(), stderr: sink(), env: { ...env, OPENAI_API_KEY: 'test-key-123456' } };
      const code = await main(['run', '--adapters', 'oracle',
        '--answer-provider', 'openai', '--answer-model', 'test-model', '--answer-base-url', url,
        '--judge-provider', 'openai', '--judge-model', 'test-judge', '--judge-base-url', url,
        '--allow-unpriced', '--concurrency', '1'], io);
      assert.strictEqual(code, 2, io.stderr.text);
      assert.match(io.stderr.text, /out of credit or quota \(429\)/);
      assert.strictEqual(requests.length, 1, 'not retried');
      const [run] = fs.readdirSync(path.join(root, 'runs'));
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'runs', run, 'spend.json'), 'utf8')).stoppedBy, 'QUOTA');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
