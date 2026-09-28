// tests/llm-totals.test.js
// A reply's llm record (models spec 2026-09-27 §10): the parent's own calls,
// each sub-agent run, and totals by role over both.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { summarizeTurnLlm, costByRole } = require('../src/tracking/llm-totals');

const call = (role, costUsd, extra = {}) => ({ provider: 'openai', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd, ...(role ? { role } : {}), ...extra });

describe('summarizeTurnLlm', () => {
  it('keeps the parent\'s calls and totals them with the sub-agents\' by role', () => {
    const out = summarizeTurnLlm({
      calls: [call('main', 0.09), call('utility', 0.01)],
      subagents: [{ agentId: 'code-explorer', role: 'worker', calls: [call('worker', 0.02)] }]
    });
    assert.strictEqual(out.calls.length, 2);
    assert.deepStrictEqual(out.subagents, [{ agentId: 'code-explorer', role: 'worker', calls: [call('worker', 0.02)], totals: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.02 } }]);
    assert.strictEqual(out.totals.costUsd, 0.12);
    assert.deepStrictEqual(Object.keys(out.byRole), ['main', 'utility', 'worker']);
    assert.deepStrictEqual(out.byRole.worker, { calls: 1, totalTokens: 2, costUsd: 0.02 });
  });

  it('marks an unpriced or partial role, and files an untagged call under other', () => {
    const byRole = costByRole([call('main', null), call('main', 0.01, { usagePartial: true }), call(null, 0.5)]);
    assert.deepStrictEqual(byRole.main, { calls: 2, totalTokens: 4, costUsd: 0.01, unpriced: true, partial: true });
    assert.deepStrictEqual(byRole.other, { calls: 1, totalTokens: 2, costUsd: 0.5 });
  });

  it('has no subagents or byRole when there is nothing to show', () => {
    assert.deepStrictEqual(summarizeTurnLlm({ calls: [] }), { calls: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } });
    assert.strictEqual('subagents' in summarizeTurnLlm({ calls: [call('main', 0.1)], subagents: [] }), false);
  });
});
