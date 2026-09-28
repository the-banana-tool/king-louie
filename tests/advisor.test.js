// tests/advisor.test.js
// The advisor stays on main and records its usage (models spec 2026-09-27
// §8, §17.1); one-shot calls report usage through streamMessage.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const Advisor = require('../src/execution/advisor');
const { oneShot } = require('../src/providers/one-shot');

describe('oneShot', () => {
  it('collects the streamed text and returns the call\'s metrics', async () => {
    const provider = { streamMessage: async (_m, _o, onChunk) => { onChunk('Road '); onChunk('trip'); return { llmMetrics: { costUsd: 0.001 } }; } };
    assert.deepStrictEqual(await oneShot(provider, [{ role: 'user', content: 'hi' }]), { text: 'Road trip', llmMetrics: { costUsd: 0.001 } });
  });

  it('takes a whole-string answer, with no metrics', async () => {
    const provider = { streamMessage: async () => 'Whole answer' };
    assert.deepStrictEqual(await oneShot(provider, []), { text: 'Whole answer', llmMetrics: null });
  });
});

describe('Advisor', () => {
  it('reviews through one streamed call and records its usage', async () => {
    const recorded = [];
    const provider = {
      streamMessage: async (_m, _opts, onChunk) => {
        onChunk('LGTM\nClean change.');
        return { llmMetrics: { provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 3, totalTokens: 13, costUsd: 0.002, role: 'main' } };
      }
    };
    const advisor = new Advisor({ provider, usageTracker: { record: (e) => { recorded.push(e); return e; } } });
    const out = await advisor.review({ content: 'done', tools: [] }, { userMessage: 'fix it' });
    assert.deepStrictEqual([out.verdict, out.review, out.llmMetrics.costUsd], ['LGTM', 'LGTM\nClean change.', 0.002]);
    assert.deepStrictEqual(recorded.map((e) => [e.role, e.costUsd]), [['main', 0.002]]);
  });

  it('says so when the provider cannot stream', async () => {
    const out = await new Advisor({ provider: { sendMessage: async () => 'x' } }).review({ content: '' });
    assert.strictEqual(out.error, 'No provider configured');
  });

  it('reports a failed call as an error, never as a review', async () => {
    const out = await new Advisor({ provider: { streamMessage: async () => { throw new Error('boom'); } } }).review({ content: '' });
    assert.match(out.error, /Advisor review failed: boom/);
    assert.strictEqual(out.llmMetrics, null);
  });
});
