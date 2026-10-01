// tests/longhaul-summarize-compact.test.js
// summarize-compact (benchmark spec §7, §14, §16): the summarizer is called
// at the right points, with a fake summarizer; summaries are cached; the
// estimate counts every call before any is made; nothing at or after
// askAtSeq is ever shown or summarized.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createAdapter } = require('../src/longhaul/adapters');
const { checkpoints, DEFAULT_SUMMARY_MAX_TOKENS } = require('../src/longhaul/adapters/summarize-compact');
const { loadSession, estimateTokens, messageText } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { ModelCache } = require('../src/longhaul/model-cache');
const { loadPrompt } = require('../src/longhaul/prompts');
const { UsageError } = require('../src/longhaul/errors');
const { FIXTURE_ROOT, tmpDir } = require('./helpers/longhaul-helpers');

const EVERY = 2000;

function fakeSummarizer() {
  const prompts = [];
  return {
    provider: 'fake', model: 'fake-summarizer', local: true, prompts,
    async complete(prompt) {
      prompts.push(prompt);
      return { text: `S${prompts.length}`, llmMetrics: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 1, costUsd: 0 } };
    }
  };
}

async function setup({ cache = new ModelCache(path.join(tmpDir(), 'model-cache')), client = fakeSummarizer() } = {}) {
  const session = await loadSession(path.join(FIXTURE_ROOT, 'sessions', 'synth-small'));
  const questions = await readQuestions(questionsFile(FIXTURE_ROOT, 'synth-small'));
  const adapter = createAdapter('summarize-compact', { compactEveryTokens: EVERY, summarizer: { client, cache, prompt: loadPrompt('summarize') } });
  const upToSeq = Math.max(...questions.map((q) => q.askAtSeq));
  return { session, questions, client, cache, adapter, upToSeq, cps: checkpoints(session.index, { compactEveryTokens: EVERY, upToSeq }) };
}

describe('summarize-compact checkpoints', () => {
  it('closes a window at the first message that brings it to compactEveryTokens, all before upToSeq', async () => {
    const { session, upToSeq, cps } = await setup();
    assert.ok(cps.length >= 3, `${cps.length} checkpoints`);
    let from = 1;
    for (const c of cps) {
      let sum = 0;
      for (let s = from; s <= c; s++) sum += estimateTokens(messageText(session.index.get(s)));
      const last = estimateTokens(messageText(session.index.get(c)));
      assert.ok(sum >= EVERY && sum - last < EVERY, `window ${from}-${c}`);
      from = c + 1;
    }
    assert.ok(cps.at(-1) < upToSeq);
  });
});

describe('summarize-compact', () => {
  it('calls the summarizer once per checkpoint, each on its own window after the previous summary', async () => {
    const { session, client, adapter, upToSeq, cps } = await setup();
    const handle = await adapter.prepare(session, { upToSeq });
    assert.strictEqual(client.prompts.length, cps.length);
    let from = 1;
    cps.forEach((c, k) => {
      const p = client.prompts[k];
      assert.ok(p.includes(`[#${from} `) && p.includes(`[#${c} `), `window ${from}-${c}`);
      assert.ok(!p.includes(`[#${c + 1} `), `nothing after #${c}`);
      assert.ok(k === 0 ? p.includes('(none yet') : p.includes(`Previous summary:\nS${k}\n`));
      from = c + 1;
    });
    assert.deepStrictEqual(handle.setup, { calls: cps.length, cachedCalls: 0, costUsd: 0, unpricedCalls: 0 });
  });

  it('shows the latest summary before the question and the messages after its checkpoint, nothing at or after askAtSeq', async () => {
    const { session, questions, adapter, upToSeq, cps } = await setup();
    const handle = await adapter.prepare(session, { upToSeq });
    for (const q of questions) {
      const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
      const k = cps.filter((c) => c < q.askAtSeq).length;
      if (k === 0) {
        assert.strictEqual(r.compactionSeq, null);
      } else {
        assert.strictEqual(r.compactionSeq, cps[k - 1]);
        assert.match(r.text, new RegExp(`^\\[summary of messages #1-#${cps[k - 1]}\\]\\nS${k}(\\n|$)`), q.id);
      }
      assert.ok([...r.evidenceSeqsShown, ...r.evidenceSeqsPartial].every((s) => s > (r.compactionSeq ?? 0) && s < q.askAtSeq), q.id);
    }
  });

  it('pays nothing the second time: every summary comes from the cache', async () => {
    const first = await setup();
    await first.adapter.prepare(first.session, { upToSeq: first.upToSeq });
    const second = await setup({ cache: first.cache });
    assert.deepStrictEqual(second.adapter.estimate(second.session, { upToSeq: second.upToSeq }).calls, []);
    const handle = await second.adapter.prepare(second.session, { upToSeq: second.upToSeq });
    assert.strictEqual(second.client.prompts.length, 0);
    assert.strictEqual(handle.setup.cachedCalls, first.client.prompts.length);
  });

  it('estimates every summary before any call, counting a previous summary not written yet at maxTokens', async () => {
    const { session, client, adapter, upToSeq, cps } = await setup();
    const est = adapter.estimate(session, { upToSeq });
    assert.strictEqual(client.prompts.length, 0);
    assert.strictEqual(est.calls.length, cps.length);
    assert.strictEqual(est.cached, 0);
    assert.strictEqual(est.calls[0].extraInputTokens, 0);
    assert.ok(est.calls.slice(1).every((c) => c.extraInputTokens === DEFAULT_SUMMARY_MAX_TOKENS && c.maxTokens === DEFAULT_SUMMARY_MAX_TOKENS));
    assert.deepStrictEqual(Object.keys(est.calls[0]).sort(), ['extraInputTokens', 'inputChars', 'local', 'maxTokens', 'model', 'provider']);
    assert.ok(est.contextChars > EVERY * 4);
  });

  it('refuses to run without a summarizer', async () => {
    const { session } = await setup();
    const adapter = createAdapter('summarize-compact', {});
    assert.strictEqual(adapter.usesModel, true);
    await assert.rejects(adapter.prepare(session, { upToSeq: 50 }), UsageError);
  });
});
