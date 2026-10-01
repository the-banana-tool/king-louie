// tests/longhaul-answer-stage.test.js
// One (adapter, question) item through the answer and the judge (benchmark
// spec §8 steps 3 and 4, §15), with scripted fake models: fields hold
// verdicts and numbers only; a repeat is free; an unparsable verdict, a
// failed call and the cap are recorded, not thrown; a refused key stops.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { answerAndJudge, mapPool, spotCheckFile, writeSpotCheckSample, EMPTY_ANSWER_FIELDS } = require('../src/longhaul/answer-stage');
const { ModelCache } = require('../src/longhaul/model-cache');
const { loadPrompt } = require('../src/longhaul/prompts');
const { buildAnswerPrompt } = require('../src/longhaul/answer');
const { buildJudgePrompt, VERDICTS } = require('../src/longhaul/judge');
const { UsageError } = require('../src/longhaul/errors');
const { tmpDir } = require('./helpers/longhaul-helpers');

const prompts = { answer: loadPrompt('answer'), judge: loadPrompt('judge') };
const status = (s) => Object.assign(new Error(`status ${s}`), { status: s });

function client(model, reply) {
  const seen = [];
  return {
    provider: 'fake', model, prompts: seen,
    async complete(p) {
      seen.push(p);
      const text = typeof reply === 'function' ? reply(p, seen.length) : reply;
      if (text instanceof Error) throw text;
      return { text, llmMetrics: { inputTokens: Math.ceil(p.length / 4), outputTokens: 5, costUsd: 0.002 } };
    }
  };
}

const question = {
  id: 'S-001', sessionId: 'S', kind: 'decision',
  question: 'What did we decide to use for amber-heron, and why?',
  answer: 'SQLite, because it needs no server', acceptableAnswers: ['SQLite']
};
const context = '[#4 assistant]\nWe decided to use SQLite for amber-heron because it needs no server.';
const item = (extra = {}) => ({ question, adapter: 'oracle', adapterConfigSha256: 'a'.repeat(64), context, contextSha256: 'c'.repeat(64), ...extra });
const REPLY = 'SQLite, since it needs no server.';
const deps = (over = {}) => ({
  cache: new ModelCache(path.join(tmpDir(), 'model-cache')), prompts,
  answerClient: client('fake-answer', REPLY),
  judgeClient: client('fake-judge', '{"verdict":"correct","reason":"same choice and reason"}'),
  answerMaxTokens: 400, judgeMaxTokens: 200, retry: { wait: async () => {} }, ...over
});

describe('answerAndJudge', () => {
  it('answers, judges and scores one item; its fields hold verdicts and numbers only', async () => {
    const d = deps();
    const out = await answerAndJudge(item(), d);
    const answerPrompt = buildAnswerPrompt(prompts.answer.text, { context, question });
    const judgePrompt = buildJudgePrompt(prompts.judge.text, { question, reply: REPLY });
    assert.deepStrictEqual({ ...out.fields, answerLatencyMs: 0 }, {
      verdict: 'correct', answerCorrect: true, abstainCorrect: null, answerError: null,
      answerCached: false, answerInputTokens: Math.ceil(answerPrompt.length / 4), answerOutputTokens: 5, answerCostUsd: 0.002, answerLatencyMs: 0,
      judgeCached: false, judgeInputTokens: Math.ceil(judgePrompt.length / 4), judgeOutputTokens: 5, judgeCostUsd: 0.002
    });
    assert.deepStrictEqual(Object.keys(out.fields).sort(), Object.keys(EMPTY_ANSWER_FIELDS).sort());
    for (const v of Object.values(out.fields)) assert.ok(typeof v !== 'string' || VERDICTS.includes(v), `no text in fields: ${v}`);
    assert.strictEqual(out.reply, REPLY);
    assert.strictEqual(out.reason, 'same choice and reason');
    assert.deepStrictEqual(d.answerClient.prompts, [answerPrompt]);
    assert.deepStrictEqual(d.judgeClient.prompts, [judgePrompt]);
    assert.ok(!d.judgeClient.prompts[0].includes('We decided to use SQLite'), 'the judge never sees the context');
  });

  it('answers a repeat from the cache for nothing', async () => {
    const d = deps();
    await answerAndJudge(item(), d);
    const again = await answerAndJudge(item(), d);
    assert.strictEqual(again.fields.answerCached, true);
    assert.strictEqual(again.fields.judgeCached, true);
    assert.strictEqual(again.fields.verdict, 'correct');
    assert.strictEqual(d.answerClient.prompts.length, 1);
    assert.strictEqual(d.judgeClient.prompts.length, 1);
  });

  it('asks again when the context changes, the question is edited or the endpoint differs', async () => {
    const d = deps();
    await answerAndJudge(item(), d);
    await answerAndJudge(item({ contextSha256: 'd'.repeat(64) }), d);
    await answerAndJudge(item({ question: { ...question, answer: 'SQLite, as it needs no server' } }), d);
    await answerAndJudge(item(), { ...d, answerClient: { ...d.answerClient, baseUrl: 'http://127.0.0.1:18080/v1' } });
    assert.strictEqual(d.answerClient.prompts.length, 4);
  });

  it('keys the judge on the prompt it is sent: text spliced in under the same judge-v1.md hash is judged afresh', async () => {
    const d = deps();
    await answerAndJudge(item(), d);
    // Same sha256 field, different text: what an edit to JUDGE_KIND_RULES looks like to the cache.
    const edited = { ...prompts.judge, text: `${prompts.judge.text}
One more rule.` };
    const again = await answerAndJudge(item(), { ...d, prompts: { ...prompts, judge: edited } });
    assert.strictEqual(again.fields.answerCached, true, 'the answer is still a hit');
    assert.strictEqual(again.fields.judgeCached, false);
    assert.strictEqual(d.judgeClient.prompts.length, 2);
  });

  it('records judge-unparsed and keeps the reply for the spot check, without a verdict', async () => {
    const d = deps({ judgeClient: client('fake-judge', 'The reply looks right to me.') });
    const out = await answerAndJudge(item(), d);
    assert.strictEqual(out.fields.answerError, 'judge-unparsed');
    assert.strictEqual(out.fields.verdict, null);
    assert.strictEqual(out.fields.answerCorrect, null);
    assert.strictEqual(out.fields.judgeCostUsd, 0.002, 'the judge call was paid');
    assert.strictEqual(out.reply, REPLY);
  });

  it('records an answer call that failed after its retries, and makes no judge call', async () => {
    const d = deps({ answerClient: client('fake-answer', () => status(500)) });
    const out = await answerAndJudge(item(), d);
    assert.strictEqual(out.fields.answerError, 'answer-failed:500');
    assert.strictEqual(d.answerClient.prompts.length, 4, 'one call and three retries');
    assert.strictEqual(d.judgeClient.prompts.length, 0);
  });

  it('records a judge call that failed', async () => {
    const d = deps({ judgeClient: client('fake-judge', () => status(400)) });
    const out = await answerAndJudge(item(), d);
    assert.strictEqual(out.fields.answerError, 'judge-failed:400');
    assert.strictEqual(out.fields.answerCached, false);
    assert.strictEqual(out.fields.verdict, null);
  });

  it('stops the run on a refused key', async () => {
    const d = deps({ answerClient: client('fake-answer', () => status(401)) });
    await assert.rejects(answerAndJudge(item(), d), (err) => err instanceof UsageError && err.code === 'AUTH' && /refused the API key/.test(err.message));
  });

  it('records over-budget when the spend guard refuses the call, and makes no call', async () => {
    const refuse = { beforeCall: () => { throw Object.assign(new Error('cap'), { code: 'OVER_BUDGET' }); }, afterCall: () => {}, cancel: () => {} };
    const d = deps({ hooks: refuse });
    const out = await answerAndJudge(item(), d);
    assert.strictEqual(out.fields.answerError, 'over-budget');
    assert.strictEqual(d.answerClient.prompts.length, 0);
  });

  it('scores an abstain question on declining', async () => {
    const abstain = { ...question, id: 'S-002', kind: 'abstain', answer: 'not in the session', acceptableAnswers: [] };
    const d = deps({ answerClient: client('fake-answer', "I don't know"), judgeClient: client('fake-judge', '{"verdict":"abstained","reason":"declined"}') });
    const out = await answerAndJudge(item({ question: abstain }), d);
    assert.deepStrictEqual([out.fields.verdict, out.fields.answerCorrect, out.fields.abstainCorrect], ['abstained', null, true]);
  });
});

describe('mapPool', () => {
  it('runs every item with at most N at once', async () => {
    let running = 0;
    let peak = 0;
    const done = [];
    await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      done.push(x);
    });
    assert.strictEqual(peak, 3);
    assert.deepStrictEqual(done.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('takes no new item after an error and rethrows it', async () => {
    const started = [];
    await assert.rejects(mapPool([1, 2, 3, 4], 1, async (x) => {
      started.push(x);
      if (x === 2) throw new Error('stop');
    }), /stop/);
    assert.deepStrictEqual(started, [1, 2]);
  });
});

describe('spot-check sample', () => {
  it('writes a seeded tenth of the judged items under private/spot-checks, none reviewed yet', () => {
    const home = { private: path.join(tmpDir(), 'private') };
    const rows = Array.from({ length: 25 }, (_, i) => ({
      runId: 'R', sessionId: 'S', questionId: `q${String(i).padStart(2, '0')}`, adapter: 'oracle', kind: 'user-said',
      question: `Question ${i}?`, reference: 'A', acceptableAnswers: [], reply: 'A', verdict: 'correct', reason: 'same'
    }));
    const file = spotCheckFile(home, '20260930T101500Z-abcd');
    assert.strictEqual(file, path.join(home.private, 'spot-checks', '20260930T101500Z-abcd.jsonl'));
    assert.strictEqual(writeSpotCheckSample(file, [...rows, { ...rows[0], questionId: 'x', verdict: null }], { seed: 7 }), 3);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 3);
    assert.ok(lines.every((l) => l.humanVerdict === null && l.reviewer === null && l.verdict === 'correct'));
    const again = path.join(path.dirname(file), 'again.jsonl');
    writeSpotCheckSample(again, [...rows].reverse(), { seed: 7 });
    assert.strictEqual(fs.readFileSync(again, 'utf8'), fs.readFileSync(file, 'utf8'), 'the same seed picks the same items in any order');
  });
});
