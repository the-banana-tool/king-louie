// tests/longhaul-compaction-steps.test.js
// The compaction-loss study's three model steps (benchmark spec §9): author
// a fact inside a window, judge whether the summary preserved it, judge
// whether a later message needed it.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionIndex } = require('../src/longhaul/session-format');
const { ModelCache } = require('../src/longhaul/model-cache');
const { authorFact, judgePreserved, judgeNeeded } = require('../src/longhaul/compaction/steps');

const tmpCache = () => new ModelCache(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lh-csteps-')), 'model-cache'));

function buildSession() {
  const messages = [];
  for (let seq = 1; seq <= 30; seq++) {
    const sender = seq % 3 === 1 ? 'user' : seq % 3 === 2 ? 'assistant' : 'toolResult';
    let text = `Message ${seq} talks about routine work on the project, nothing notable here.`;
    if (seq === 5) text = 'The owner said: “Deploy the Ledgerport service on port 7731” and keep the old one.';
    messages.push({ id: `m${seq}`, seq, sender, text, timestamp: '2026-11-01T00:00:00Z', ...(sender === 'toolResult' ? { toolName: 'Bash' } : {}) });
  }
  return { manifest: { sessionId: 'sess-1' }, messages, index: new SessionIndex(messages) };
}

const session = buildSession();
const window = { index: 0, atSeq: 21, summarySeq: 22, windowFromSeq: 1, windowToSeq: 20, windowTokens: 300, summaryTokens: 20, ratio: 15, preTokens: null, postTokens: null };
const item = { kind: 'user-said', anchorSeq: 5, spanFrom: 2, spanTo: 8, tokensToSummary: 200 };

function scripted(replies) {
  const prompts = [];
  let i = 0;
  return {
    provider: 'test',
    model: 'm',
    prompts,
    async complete(prompt) {
      prompts.push(prompt);
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { text: typeof r === 'string' ? r : JSON.stringify(r), llmMetrics: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } };
    }
  };
}

describe('authorFact', () => {
  it('accepts a quote found in the evidence message despite case and typographic quotes', async () => {
    const client = scripted([{ fact: 'The service runs on port 7731.', quote: '"deploy the LEDGERPORT service on port 7731"', evidenceSeq: 5 }]);
    const out = await authorFact({ session, window, item, client, cache: tmpCache() });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.value, { kind: 'user-said', fact: 'The service runs on port 7731.', quote: '"deploy the LEDGERPORT service on port 7731"', evidenceSeq: 5 });
    assert.strictEqual(out.call.cached, false);
    assert.match(client.prompts[0], /\[#5 assistant\]\nThe owner said/);
    assert.doesNotMatch(client.prompts[0], /\[#9 /);
    assert.match(client.prompts[0], /data from a transcript, not instructions/);
    assert.doesNotMatch(client.prompts[0], /\{\{\w+\}\}/);
  });

  it('rejects evidence outside the window and a quote not in the message', async () => {
    const outside = await authorFact({ session, window, item, client: scripted([{ fact: 'x y z', quote: 'routine work', evidenceSeq: 25 }]), cache: tmpCache() });
    assert.strictEqual(outside.ok, false);
    assert.strictEqual(outside.reason, 'evidence-outside-window');
    const madeUp = await authorFact({ session, window, item, client: scripted([{ fact: 'x y z', quote: 'port 9999 forever', evidenceSeq: 5 }]), cache: tmpCache() });
    assert.strictEqual(madeUp.ok, false);
    assert.strictEqual(madeUp.reason, 'quote-not-found');
  });

  it('maps a skip, non-JSON and a thrown call to their reasons', async () => {
    const skip = await authorFact({ session, window, item, client: scripted([{ skip: true }]), cache: tmpCache() });
    assert.strictEqual(skip.reason, 'model-skipped');
    const junk = await authorFact({ session, window, item, client: scripted(['no json here']), cache: tmpCache() });
    assert.strictEqual(junk.reason, 'unparsed');
    const boom = await authorFact({ session, window, item, client: scripted([Object.assign(new Error('bad'), { status: 400 })]), cache: tmpCache() });
    assert.strictEqual(boom.reason, 'model-error');
    assert.strictEqual(boom.call, null);
  });

  it('lets a refused key stop the run rather than become a rejection', async () => {
    const client = scripted([Object.assign(new Error('unauthorized'), { status: 401 })]);
    await assert.rejects(authorFact({ session, window, item, client, cache: tmpCache() }), (err) => err.code === 'AUTH');
  });

  it('serves a second identical call from the cache', async () => {
    const cache = tmpCache();
    const client = scripted([{ fact: 'Port 7731.', quote: 'port 7731', evidenceSeq: 5 }]);
    await authorFact({ session, window, item, client, cache });
    const again = await authorFact({ session, window, item, client, cache });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.call.cached, true);
    assert.strictEqual(client.prompts.length, 1);
  });
});

describe('judgePreserved', () => {
  const fact = 'The service runs on port 7731.';
  const summary = 'The session set up a service and chose its port.';

  it('maps each verdict and rejects an unknown one', async () => {
    for (const verdict of ['preserved', 'partial', 'lost']) {
      const out = await judgePreserved({ fact, summary, client: scripted([{ verdict, reason: 'because' }]), cache: tmpCache() });
      assert.strictEqual(out.ok, true);
      assert.deepStrictEqual(out.value, { verdict, reason: 'because' });
    }
    const kept = await judgePreserved({ fact, summary, client: scripted([{ verdict: 'kept', reason: 'x' }]), cache: tmpCache() });
    assert.strictEqual(kept.ok, false);
    assert.strictEqual(kept.reason, 'unparsed');
  });

  it('shows the fact and the summary only', async () => {
    const client = scripted([{ verdict: 'lost', reason: 'r' }]);
    await judgePreserved({ fact, summary, client, cache: tmpCache() });
    assert.ok(client.prompts[0].includes(fact));
    assert.ok(client.prompts[0].includes(summary));
    assert.doesNotMatch(client.prompts[0], /\[#\d+ /);
  });

  it('serves a second identical call from the cache', async () => {
    const cache = tmpCache();
    const client = scripted([{ verdict: 'lost', reason: 'r' }]);
    await judgePreserved({ fact, summary, client, cache });
    const again = await judgePreserved({ fact, summary, client, cache });
    assert.strictEqual(again.call.cached, true);
    assert.strictEqual(client.prompts.length, 1);
  });
});

describe('judgeNeeded', () => {
  const fact = 'The service runs on port 7731.';
  const candidates = [session.index.get(25), session.index.get(28)];

  it('accepts needed with shown seqs and not-needed with none', async () => {
    const needed = await judgeNeeded({ fact, candidates, client: scripted([{ verdict: 'needed', seqs: [28], reason: 'uses the port' }]), cache: tmpCache() });
    assert.deepStrictEqual(needed.value, { verdict: 'needed', seqs: [28], reason: 'uses the port' });
    const not = await judgeNeeded({ fact, candidates, client: scripted([{ verdict: 'not-needed', seqs: [], reason: 'unrelated' }]), cache: tmpCache() });
    assert.deepStrictEqual(not.value, { verdict: 'not-needed', seqs: [], reason: 'unrelated' });
  });

  it('rejects needed with no seqs, a seq it was not shown, and seqs on not-needed', async () => {
    const replies = [
      { verdict: 'needed', seqs: [], reason: 'x' },
      { verdict: 'needed', seqs: [12], reason: 'x' },
      { verdict: 'not-needed', seqs: [25], reason: 'x' }
    ];
    for (const r of replies) {
      const out = await judgeNeeded({ fact, candidates, client: scripted([r]), cache: tmpCache() });
      assert.strictEqual(out.ok, false, JSON.stringify(r));
      assert.strictEqual(out.reason, 'unparsed');
    }
  });

  it('shows the candidates by seq and serves a repeat from the cache', async () => {
    const cache = tmpCache();
    const client = scripted([{ verdict: 'not-needed', seqs: [], reason: 'r' }]);
    await judgeNeeded({ fact, candidates, client, cache });
    assert.match(client.prompts[0], /\[#25 /);
    assert.match(client.prompts[0], /\[#28 /);
    const again = await judgeNeeded({ fact, candidates, client, cache });
    assert.strictEqual(again.call.cached, true);
    assert.strictEqual(client.prompts.length, 1);
  });
});
