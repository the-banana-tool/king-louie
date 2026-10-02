// tests/longhaul-author.test.js
// Minimal authoring (benchmark spec §6) with a scripted fake model; the CLI
// path runs against the local fake server. No network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { authorCandidates, parseReply, readAuthoringState, DEFAULT_PROMPT } = require('../src/longhaul/author');
const { planAuthoring } = require('../src/longhaul/sampling');
const { SYNTH_FIXTURES, generateSynthetic, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { validateQuestionSet, readQuestions, writeQuestions, questionsFile, rejectedFile } = require('../src/longhaul/questions');
const { sha256Text } = require('../src/longhaul/files');
const { main } = require('../src/longhaul/cli');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

// A fake model that reads the span headers in the prompt and cites messages
// of the right sender for the kind it was asked for.
function fakeReply(prompt) {
  const kind = /^Kind: (\S+)$/m.exec(prompt)[1];
  const headers = [...prompt.matchAll(/^\[#(\d+) ([^\]]+)\]$/gm)].map((m) => ({ seq: Number(m[1]), label: m[2] }));
  const pick = (pred, n = 1) => headers.filter(pred).slice(0, n).map((h) => h.seq);
  const prose = (h) => h.label === 'user' || h.label === 'assistant';
  const evidence = {
    'user-said': pick((h) => h.label === 'user'),
    'tool-observed': pick((h) => h.label.endsWith(' result')),
    decision: pick((h) => h.label === 'assistant'),
    superseded: pick(prose, 2),
    'multi-hop': pick(prose, 2),
    abstain: []
  }[kind];
  return JSON.stringify({ question: `A question about ${kind}?`, answer: 'an answer', acceptableAnswers: ['answer'], evidenceSeqs: evidence, notes: 'fake' });
}
function scripted(reply = fakeReply) {
  const prompts = [];
  return {
    provider: 'fake', model: 'fake-1', prompts,
    async complete(prompt) {
      prompts.push(prompt);
      return { text: reply(prompt, prompts.length) };
    }
  };
}

// Marks a synthetic session private, as `longhaul import` would a real one.
function makePrivate(root, sessionId) {
  const file = path.join(root, 'sessions', sessionId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...manifest, private: true, license: 'private' }, null, 2)}\n`);
}

const gen = generateSynthetic(SYNTH_FIXTURES[1]);
const session = { manifest: gen.manifest, messages: gen.messages, index: gen.index };
const SID = 'synth-medium';
// 30 = 5 per kind = one per distance bucket, so every kind has items in the
// buckets synth-medium can hold.
const plan = planAuthoring(session.index, { count: 30, seed: 5 });

describe('authorCandidates', () => {
  it('writes valid, unverified, generated candidates and records the prompt hash', async () => {
    const out = await authorCandidates({ session, plan, client: scripted(), sessionId: SID });
    assert.strictEqual(out.rejected.length, 0, JSON.stringify(out.rejected));
    assert.strictEqual(out.candidates.length, plan.items.length);
    assert.deepStrictEqual(validateQuestionSet(out.candidates, { index: session.index, sessionId: SID }), []);
    assert.ok(out.candidates.every((q) => q.authoredBy === 'generated' && q.verifiedBy === null));
    assert.deepStrictEqual(out.candidates.map((q) => q.id).slice(0, 2), [`${SID}-g0001`, `${SID}-g0002`]);
    assert.strictEqual(out.promptSha256, sha256Text(fs.readFileSync(DEFAULT_PROMPT, 'utf8')));
  });

  it('shows the kind rule and askAtSeq, and only messages before askAtSeq', async () => {
    const client = scripted();
    await authorCandidates({ session, plan, client, sessionId: SID });
    client.prompts.forEach((prompt, i) => {
      const item = plan.items[i];
      assert.match(prompt, new RegExp(`^Kind: ${item.kind}$`, 'm'));
      assert.ok(prompt.includes(`message #${item.askAtSeq}`));
      const seqs = [...prompt.matchAll(/^\[#(\d+) /gm)].map((m) => Number(m[1]));
      assert.ok(seqs.length > 0 && seqs.every((s) => s < item.askAtSeq));
    });
  });

  it('is deterministic for the same plan and replies', async () => {
    const a = await authorCandidates({ session, plan, client: scripted(), sessionId: SID });
    const b = await authorCandidates({ session, plan, client: scripted(), sessionId: SID });
    assert.deepStrictEqual(a.candidates, b.candidates);
  });

  it('rejects a bad reply without stopping, and keeps the good one', async () => {
    const item = plan.items.find((i) => i.kind === 'user-said');
    const toolResult = [];
    for (let s = item.spanFrom; s <= item.spanTo; s++) if (session.index.get(s).sender === 'toolResult') toolResult.push(s);
    const replies = [
      () => 'I cannot do that.',
      () => '{"skip": "nothing specific here"}',
      () => JSON.stringify({ question: 'Q?', answer: 'A', evidenceSeqs: [item.askAtSeq] }),
      () => JSON.stringify({ question: 'Q?', answer: 'A', evidenceSeqs: [toolResult[0]] }),
      () => { throw new Error('rate limited'); },
      (prompt) => `Here you go:\n\`\`\`json\n${fakeReply(prompt)}\n\`\`\``
    ];
    const client = {
      provider: 'fake', model: 'fake-1',
      calls: 0,
      async complete(prompt) { const r = replies[this.calls++](prompt); return { text: r }; }
    };
    const out = await authorCandidates({ session, plan: { items: replies.map(() => item), shortfall: [] }, client, sessionId: SID });
    assert.deepStrictEqual(out.rejected.map((r) => r.reason), ['unparsed', 'model-skipped', 'evidence-outside-span', 'invalid', 'model-error']);
    assert.match(out.rejected[3].detail, /evidence-sender/);
    assert.strictEqual(out.candidates.length, 1);
  });

  it('forces an abstain candidate to have no evidence and the abstain answer', async () => {
    const item = plan.items.find((i) => i.kind === 'abstain');
    const client = scripted(() => JSON.stringify({ question: 'Which cache port did we pick?', answer: '18000', evidenceSeqs: [item.spanFrom] }));
    const out = await authorCandidates({ session, plan: { items: [item], shortfall: [] }, client, sessionId: SID });
    assert.deepStrictEqual(out.candidates[0].evidenceSeqs, []);
    assert.strictEqual(out.candidates[0].answer, 'not in the session');
  });

  it('continues the id series after existing questions', async () => {
    const existing = [{ id: `${SID}-g0003` }, { id: `${SID}-007` }];
    const out = await authorCandidates({ session, plan, client: scripted(), sessionId: SID, existing });
    assert.strictEqual(out.candidates[0].id, `${SID}-g0004`);
  });
});

describe('parseReply', () => {
  it('finds one JSON object inside fences or prose, and returns null otherwise', () => {
    assert.deepStrictEqual(parseReply('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(parseReply('Sure. {"a":{"b":2}} Done.'), { a: { b: 2 } });
    assert.strictEqual(parseReply('[1,2]'), null);
    assert.strictEqual(parseReply('no json here'), null);
    assert.strictEqual(parseReply('{"a":'), null);
  });
});

describe('authoring after a rejection', () => {
  it('numbers new candidates past a rejected id and does not reuse rejected evidence', async () => {
    const { root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[1]]);
    const first = await authorCandidates({ session, plan, client: scripted(), sessionId: SID });
    const [live1, live2, rejectedQ] = first.candidates;
    writeQuestions(questionsFile(root, SID), [live1, live2]);
    fs.writeFileSync(rejectedFile(root, SID), `${JSON.stringify({ ...rejectedQ, rejectedBy: 'human:TT', rejectReason: 'vague', rejectedAt: '2026-09-29T12:00:00.000Z' })}\n`);
    assert.strictEqual(rejectedQ.id, `${SID}-g0003`);

    const state = await readAuthoringState(root, SID);
    assert.deepStrictEqual(state.existing.map((q) => q.id), [live1.id, live2.id]);
    assert.deepStrictEqual(state.rejected.map((q) => q.id), [rejectedQ.id]);
    for (const s of rejectedQ.evidenceSeqs) assert.ok(state.excludeSeqs.includes(s), `rejected evidence #${s} is excluded`);

    const next = planAuthoring(session.index, { count: 6, seed: 9, excludeSeqs: state.excludeSeqs });
    const out = await authorCandidates({ session, plan: next, client: scripted(), sessionId: SID, existing: state.existing, reserved: state.rejected });
    assert.ok(out.candidates.length > 0);
    assert.strictEqual(out.candidates[0].id, `${SID}-g0004`, 'the rejected id is not reused');
    for (const q of out.candidates) {
      assert.ok(!q.evidenceSeqs.some((s) => rejectedQ.evidenceSeqs.includes(s)), `${q.id} reuses rejected evidence`);
    }
  });
});

describe('longhaul author CLI', () => {
  let server;
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  it('says which environment variable is missing, with exit 2', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const stderr = sink();
    const code = await main(['author', '--session', 'synth-small', '--provider', 'openai', '--model', 'm'], { stdout: sink(), stderr, env });
    assert.strictEqual(code, 2);
    assert.match(stderr.text, /OPENAI_API_KEY/);
  });

  it('calls the model through a real provider and logs the run; unusable replies write nothing', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const before = await readQuestions(questionsFile(root, 'synth-small'));
    const stdout = sink();
    const code = await main([
      'author', '--session', 'synth-small', '--provider', 'openai', '--model', 'test-model',
      '--base-url', `${server.url}/openai/v1`, '--count', '6', '--seed', '2'
    ], { stdout, stderr: sink(), env: { ...env, OPENAI_API_KEY: 'test-key-123456' } });
    assert.strictEqual(code, 0);
    const log = fs.readFileSync(path.join(root, 'questions', 'synth-small.author-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].promptSha256, sha256Text(fs.readFileSync(DEFAULT_PROMPT, 'utf8')));
    assert.strictEqual(log[0].written, 0);
    assert.strictEqual(log[0].rejected.unparsed, log[0].planned);
    assert.strictEqual(log[0].seed, 2);
    assert.deepStrictEqual(await readQuestions(questionsFile(root, 'synth-small')), before);
    assert.match(stdout.text, /longhaul verify --session synth-small/);
  });

  it('refuses a private session without --send-private: exit 2, no model call, nothing written', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    makePrivate(root, 'synth-small');
    const before = await readQuestions(questionsFile(root, 'synth-small'));
    const stderr = sink();
    const calls = server.requests.length;
    const code = await main([
      'author', '--session', 'synth-small', '--provider', 'openai', '--model', 'test-model',
      '--base-url', `${server.url}/openai/v1`, '--count', '6'
    ], { stdout: sink(), stderr, env: { ...env, OPENAI_API_KEY: 'test-key-123456' } });
    assert.strictEqual(code, 2);
    assert.match(stderr.text, /synth-small is private/);
    assert.match(stderr.text, /--send-private/);
    assert.strictEqual(server.requests.length, calls, 'no span reached a model');
    assert.ok(!fs.existsSync(path.join(root, 'questions', 'synth-small.author-log.jsonl')));
    assert.deepStrictEqual(await readQuestions(questionsFile(root, 'synth-small')), before);
  });

  it('with --send-private, authors a private session and says its spans go to the provider', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    makePrivate(root, 'synth-small');
    const stderr = sink();
    const calls = server.requests.length;
    const code = await main([
      'author', '--session', 'synth-small', '--provider', 'openai', '--model', 'test-model',
      '--base-url', `${server.url}/openai/v1`, '--count', '6', '--send-private'
    ], { stdout: sink(), stderr, env: { ...env, OPENAI_API_KEY: 'test-key-123456' } });
    assert.strictEqual(code, 0, stderr.text);
    assert.ok(server.requests.length > calls, 'the spans went to the provider');
    assert.match(stderr.text, /spans of private session synth-small are sent to openai \(test-model\)/);
    const log = fs.readFileSync(path.join(root, 'questions', 'synth-small.author-log.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(log.length, 1);
  });

  it('--kinds plans only the kinds named, logs them, and refuses an unknown kind before any call', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const e = { ...env, OPENAI_API_KEY: 'test-key-123456' };
    const args = ['author', '--session', 'synth-small', '--provider', 'openai', '--model', 'test-model', '--base-url', `${server.url}/openai/v1`, '--count', '4'];
    const calls = server.requests.length;
    const bad = sink();
    assert.strictEqual(await main([...args, '--kinds', 'decision,nope'], { stdout: sink(), stderr: bad, env: e }), 2);
    assert.match(bad.text, /--kinds/);
    assert.strictEqual(server.requests.length, calls);
    assert.strictEqual(await main([...args, '--kinds', 'decision'], { stdout: sink(), stderr: sink(), env: e }), 0);
    const log = fs.readFileSync(path.join(root, 'questions', 'synth-small.author-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(log.at(-1).kinds, ['decision']);
    assert.ok(log.at(-1).planned >= 1 && log.at(-1).planned <= 4);
    assert.strictEqual(server.requests.length - calls, log.at(-1).planned, 'one call per planned decision item');
  });
});
