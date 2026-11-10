'use strict';
// tests/longhaul-compaction-study.test.js
// `longhaul compaction-loss` (benchmark spec §9): the study end to end over a
// hand-built session with two compactions, scripted model providers and the
// fixture catalog. No network and no real model.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { main, COMMANDS } = require('../src/longhaul/cli');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { buildManifest, writeSession, sessionDir } = require('../src/longhaul/session-format');
const { normalizeText } = require('../src/longhaul/scoring');
const { EmbeddingCache, cacheDir } = require('../src/longhaul/embeddings');
const { factQueryText, factQueryId } = require('../src/longhaul/compaction/matches');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { fakeEmbedder } = require('./helpers/fake-embedding-server');
const { tmpHome, sink, makePrivate, FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

const SID = 'hand-study';
const A = 'alpha-key-4411 deploy key';
const B = 'bravo-port-9922 web port';
const C = 'charlie-dir-5533 cache folder';
const FACTS = { 3: A, 18: B, 30: C };
// More user facts for the concurrency tests (writeHandSession's extra), so a
// run has enough items for replies to finish out of plan order.
const EXTRA = {
  5: 'delta-host-6101 build host', 7: 'echo-team-6202 owners', 9: 'foxtrot-zone-6303 region', 11: 'golf-flag-6404 feature flag',
  13: 'hotel-file-6505 config file', 24: 'india-db-6606 database', 26: 'juliet-user-6707 service user', 32: 'kilo-queue-6808 job queue',
  34: 'lima-cron-6909 nightly cron'
};
const ALL_FACTS = { ...FACTS, ...EXTRA };

function msg(seq, sender, text, meta) {
  return { id: `m${seq}`, seq, sender, text, timestamp: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(), ...(meta ? { meta } : {}) };
}

// Window 1 is 1-20 (summary 21) holding A at 3 and B at 18; window 2 is 22-40
// (summary 41) holding C at 30. The summary of window 1 keeps A and not B;
// B's token comes back at 50.
function writeHandSession(root, { sessionId = SID, compactions = true, extra = false } = {}) {
  const messages = [];
  for (let seq = 1; seq <= 60; seq++) {
    let m = msg(seq, seq % 2 ? 'user' : 'assistant', `ok ${seq}`);
    if (seq === 3) m = msg(seq, 'user', `please set ${A} for the release now`);
    if (seq === 18) m = msg(seq, 'user', `we will serve on ${B} from today onward`);
    if (seq === 30) m = msg(seq, 'user', `remember ${C} holds our build data`);
    if (seq === 50) m = msg(seq, 'assistant', 'bravo-port-9922 again here');
    if (extra && EXTRA[seq]) m = msg(seq, 'user', `please note ${EXTRA[seq]} for the team`);
    if (extra && seq === 52) m = msg(seq, 'assistant', 'echo-team-6202 and india-db-6606 came up again');
    if (compactions && seq === 21) m = msg(seq, 'status', `Summary: ${A} chosen.`, { compaction: true });
    if (compactions && seq === 41) m = msg(seq, 'status', `Summary: ${C} noted.`, { compaction: true });
    messages.push(m);
  }
  const manifest = buildManifest({
    sessionId, source: 'synthetic', sourceRef: 'test', license: 'CC-BY-4.0', private: false, messages,
    compactions: compactions ? [
      { atSeq: 21, summarySeq: 21, windowFromSeq: 1, windowToSeq: 20 },
      { atSeq: 41, summarySeq: 41, windowFromSeq: 22, windowToSeq: 40 }
    ] : []
  });
  writeSession(sessionDir(root, sessionId), { manifest, messages });
}

const between = (text, open, close) => {
  const s = text.indexOf(open);
  return s < 0 ? '' : text.slice(s + open.length, text.indexOf(close, s)).trim();
};

// The author states the fact of the one marked message in its span (fact =
// quote); the judge says preserved iff the fact is in the summary, and needed
// iff it was shown any candidate. delay (optional) is the ms to wait before
// the reply, given the call's start index; costUsd is what each call reports.
function scriptedClient(calls, { delay = null, costUsd = 0.001, starts = null, facts = FACTS } = {}) {
  const reply = (prompt) => {
    if (prompt.startsWith('You pick one fact')) {
      for (const [seq, fact] of Object.entries(facts)) {
        if (prompt.includes(`[#${seq} `)) return JSON.stringify({ fact, quote: fact, evidenceSeq: Number(seq) });
      }
      return '{"skip": true}';
    }
    if (prompt.startsWith('You grade one summary')) {
      const kept = normalizeText(between(prompt, '<summary>', '</summary>')).includes(normalizeText(between(prompt, '<fact>', '</fact>')));
      return JSON.stringify({ verdict: kept ? 'preserved' : 'lost', reason: 'scripted' });
    }
    const seqs = [...prompt.split('Later messages:')[1].matchAll(/^\[#(\d+) /gm)].map((m) => Number(m[1]));
    return JSON.stringify(seqs.length ? { verdict: 'needed', seqs: [seqs[0]], reason: 'scripted' } : { verdict: 'not-needed', seqs: [], reason: 'scripted' });
  };
  return {
    async streamMessage(messages, _options, onChunk) {
      const index = calls.length;
      calls.push(1);
      if (starts) starts.push(starts.completed);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay(index)));
      const text = reply(messages[0].content);
      onChunk(text);
      if (starts) starts.completed += 1;
      return { content: '', llmMetrics: { inputTokens: 100, outputTokens: 20, costUsd } };
    }
  };
}

function setup({ extra = false, ...clientOptions } = {}) {
  const { env, root } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeHandSession(root, { extra });
  const calls = [];
  const scripted = (c) => scriptedClient(c, { ...clientOptions, ...(extra ? { facts: ALL_FACTS } : {}) });
  const ctx = { home, env, stdout: sink(), stderr: sink(), now: () => new Date('2026-11-09T10:00:00Z'), cwd: process.cwd() };
  const deps = { providerInstances: { author: scripted(calls), judge: scripted(calls) }, catalog: fixtureCatalog(), retry: { wait: async () => {} } };
  const values = {
    sessions: SID, 'author-provider': 'openai', 'author-model': 'gpt-5.4-mini', 'judge-provider': 'anthropic', 'judge-model': 'claude-haiku-4-5',
    'facts-per-window': '2'
  };
  return { env, root, home, ctx, deps, values, calls };
}

const runDirs = (root) => fs.readdirSync(path.join(root, 'runs')).sort();
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('longhaul compaction-loss', () => {
  it('measures preserved, lost and lost-and-needed over the hand-built facts, with no text in runs/', async () => {
    const t = setup();
    assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, t.values, [], t.deps), 0, t.ctx.stderr.text);
    const [runId] = runDirs(t.root);
    const dir = path.join(t.root, 'runs', runId);
    const summary = readJson(path.join(dir, 'summary.json'));
    const s = summary.sessions[SID];
    assert.equal(s.windows, 2);
    assert.equal(s.judged, 3);
    assert.equal(s.preservedRate, 2 / 3);
    assert.equal(s.lostRate, 1 / 3);
    assert.equal(s.partialRate, 0);
    assert.equal(s.neededRate, 1 / 3);
    assert.equal(s.lostAndNeededRate, 1 / 3);
    assert.deepEqual(summary.all.lostAndNeededRate, 1 / 3);

    const records = fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const byAnchor = Object.fromEntries(records.map((r) => [r.anchorSeq, r]));
    assert.equal(byAnchor[3].preserved, 'preserved');
    assert.equal(byAnchor[3].noCandidates, true);
    assert.equal(byAnchor[18].preserved, 'lost');
    assert.equal(byAnchor[18].needed, 'needed');
    assert.deepEqual(byAnchor[18].neededSeqs, [50]);
    assert.equal(byAnchor[30].needed, 'not-needed');
    // A and C had no later candidate: 3 authors + 3 preserved + 1 needed.
    assert.equal(t.calls.length, 7);

    for (const f of ['records.jsonl', 'summary.json', 'summary.md', 'config.json', 'spend.json']) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const fact of [A, B, C]) assert.ok(!text.includes(fact) && !text.includes(fact.split(' ')[0]), `${f} holds no fact text`);
    }
    assert.ok(![A, B, C].some((x) => t.ctx.stdout.text.includes(x.split(' ')[0])));
    const facts = fs.readFileSync(path.join(t.root, 'private', 'compaction', runId, 'facts.jsonl'), 'utf8');
    assert.ok(facts.includes(A) && facts.includes(B));
    const spot = fs.readFileSync(path.join(t.root, 'private', 'spot-checks', `${runId}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(spot.length, 1);
    assert.ok(spot[0].preserved.verdict && spot[0].needed.verdict);

    const config = readJson(path.join(dir, 'config.json'));
    assert.equal(config.kind, 'compaction-loss');
    assert.equal(config.stage, 'B4');
    assert.equal(config.embed, null);
    assert.deepEqual(Object.keys(config.prompts).sort(), ['compactionFact', 'compactionNeeded', 'compactionPreserved']);
    assert.deepEqual(config.sessions, [{ sessionId: SID, source: 'synthetic', private: false, license: 'CC-BY-4.0', windows: 2 }]);
  });

  it('a rerun over the same home costs $0 and gives the same summary', async () => {
    const t = setup();
    assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, t.values, [], t.deps), 0, t.ctx.stderr.text);
    const first = t.calls.length;
    t.ctx.now = () => new Date('2026-11-09T11:00:00Z');
    assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, t.values, [], t.deps), 0, t.ctx.stderr.text);
    assert.equal(t.calls.length, first, 'every call came from the cache');
    const [r1, r2] = runDirs(t.root);
    const strip = (id) => { const s = readJson(path.join(t.root, 'runs', id, 'summary.json')); delete s.runId; return s; };
    assert.deepEqual(strip(r2), strip(r1));
    assert.equal(readJson(path.join(t.root, 'runs', r2, 'spend.json')).spentUsd, 0);
  });

  it('refuses a private session without --send-private and builds no client', async () => {
    const t = setup();
    makePrivate(t.root, SID);
    await assert.rejects(COMMANDS['compaction-loss'].run(t.ctx, t.values, [], t.deps), (err) => err.code === 'PRIVATE_SESSION');
    assert.equal(t.calls.length, 0);
    const out = { stdout: sink(), stderr: sink(), env: t.env };
    assert.equal(await main(['compaction-loss', '--sessions', SID, '--author-provider', 'openai', '--author-model', 'gpt-5.4-mini',
      '--judge-provider', 'openai', '--judge-model', 'gpt-5.4'], out), 2);
    assert.match(out.stderr.text, /private/);
    assert.deepEqual(runDirs(t.root), []);
  });

  it('--dry-run prints the estimate and calls nothing; a tiny cap is OVER_BUDGET', async () => {
    const t = setup();
    assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, { ...t.values, 'dry-run': true }, [], t.deps), 0, t.ctx.stderr.text);
    assert.match(t.ctx.stdout.text, /estimate: \$/);
    assert.equal(t.calls.length, 0);
    assert.deepEqual(runDirs(t.root), []);
    await assert.rejects(COMMANDS['compaction-loss'].run(t.ctx, { ...t.values, 'max-usd': '0.000001' }, [], t.deps), (err) => err.code === 'OVER_BUDGET');
    assert.equal(t.calls.length, 0);
  });

  it('lists a session without compactions in config.skipped, and refuses an unknown session', async () => {
    const t = setup();
    writeHandSession(t.root, { sessionId: 'no-comp', compactions: false });
    assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, { ...t.values, sessions: `${SID},no-comp` }, [], t.deps), 0, t.ctx.stderr.text);
    const [runId] = runDirs(t.root);
    const config = readJson(path.join(t.root, 'runs', runId, 'config.json'));
    assert.deepEqual(config.skipped, [{ sessionId: 'no-comp', reason: 'no-compactions' }]);
    const out = { stdout: sink(), stderr: sink(), env: t.env };
    assert.equal(await main(['compaction-loss', '--sessions', 'nope', '--fake-models'], out), 2);
  });

  it('embeds each fact query when --embed-* is given, and refuses without the session\'s chunk vectors', async () => {
    const t = setup();
    const values = { ...t.values, 'embed-provider': 'openai', 'embed-model': 'text-embedding-3-small', 'allow-unpriced': true };
    const embedder = fakeEmbedder();
    await assert.rejects(COMMANDS['compaction-loss'].run(t.ctx, values, [], { ...t.deps, embedder }),
      (err) => err.code === 'EMBEDDINGS_MISSING' && /longhaul embed --session hand-study --provider openai --model text-embedding-3-small/.test(err.message));
    assert.equal(t.calls.length, 0);
    assert.equal(embedder.calls.length, 0);

    assert.equal(await COMMANDS.embed.run(t.ctx, { session: SID, provider: 'openai', model: 'text-embedding-3-small' }, [], { providerInstance: embedder }), 0);
    const chunkCalls = embedder.calls.length;
    assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, values, [], { ...t.deps, embedder }), 0, t.ctx.stderr.text);
    assert.ok(embedder.calls.length > chunkCalls);
    assert.ok(embedder.calls.slice(chunkCalls).every((c) => c.model === 'text-embedding-3-small'));
    const cache = EmbeddingCache.open(cacheDir(t.home.private, SID, 'text-embedding-3-small'));
    for (const fact of [A, B, C]) {
      const q = factQueryText(fact, fact);
      assert.ok(cache.question(factQueryId(q), q), 'the fact query vector is cached');
    }
    const [runId] = runDirs(t.root);
    assert.deepEqual(readJson(path.join(t.root, 'runs', runId, 'config.json')).embed, { provider: 'openai', model: 'text-embedding-3-small' });
  });

  it('counts fact queries an embedder answered one vector short and goes on lexically', async () => {
    const t = setup();
    const values = { ...t.values, 'embed-provider': 'openai', 'embed-model': 'text-embedding-3-small', 'allow-unpriced': true };
    const good = fakeEmbedder();
    assert.equal(await COMMANDS.embed.run(t.ctx, { session: SID, provider: 'openai', model: 'text-embedding-3-small' }, [], { providerInstance: good }), 0);
    const short = {
      async embed(inputs, opts) {
        const res = await good.embed(inputs, opts);
        return { ...res, vectors: res.vectors.slice(1) };
      }
    };
    assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, values, [], { ...t.deps, embedder: short }), 0, t.ctx.stderr.text);
    const cache = EmbeddingCache.open(cacheDir(t.home.private, SID, 'text-embedding-3-small'));
    for (const fact of [A, B, C]) {
      const q = factQueryText(fact, fact);
      assert.equal(cache.question(factQueryId(q), q), null);
    }
    const [runId] = runDirs(t.root);
    const summary = readJson(path.join(t.root, 'runs', runId, 'summary.json'));
    assert.equal(summary.embedFailures, 3);
    assert.ok(summary.all.judged > 0);
  });

  it('gives the same records, summary and spot-check sample at --concurrency 4 as at 1, with replies finishing out of order', async () => {
    // Earlier calls wait longer, so later items finish first.
    const delay = (i) => (8 - (i % 8)) * 6;
    const outputs = [];
    for (const concurrency of ['1', '4']) {
      const t = setup({ delay, extra: true });
      const values = { ...t.values, 'facts-per-window': '5', concurrency };
      assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, values, [], t.deps), 0, t.ctx.stderr.text);
      const [runId] = runDirs(t.root);
      const dir = path.join(t.root, 'runs', runId);
      const summary = readJson(path.join(dir, 'summary.json'));
      delete summary.runId;
      const spot = fs.readFileSync(path.join(t.root, 'private', 'spot-checks', `${runId}.jsonl`), 'utf8').trim().split('\n')
        .map((line) => { const r = JSON.parse(line); delete r.runId; return r; });
      const config = readJson(path.join(dir, 'config.json'));
      const cacheFiles = fs.readdirSync(path.join(t.root, 'private', 'model-cache'), { recursive: true }).map(String).sort();
      outputs.push({ records: fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8'), summary, spot, calls: t.calls.length, cacheFiles, concurrency: config.concurrency });
    }
    const [one, four] = outputs;
    assert.equal(one.concurrency, 1);
    assert.equal(four.concurrency, 4);
    assert.ok(one.records.trim().split('\n').length >= 8);
    assert.equal(four.records, one.records);
    assert.deepEqual(four.summary, one.summary);
    assert.deepEqual(four.spot, one.spot);
    assert.equal(four.calls, one.calls);
    assert.deepEqual(four.cacheFiles, one.cacheFiles, 'the same cache keys');
  });

  it('starts no call once the spend guard trips at --concurrency 4', async () => {
    const starts = Object.assign([], { completed: 0 });
    // Each call reports $2 against a $1 cap: the first reply trips the guard.
    const t = setup({ delay: (i) => 20 + (i % 3) * 10, costUsd: 2, starts, extra: true });
    const values = { ...t.values, 'facts-per-window': '5', concurrency: '4', 'max-usd': '1' };
    assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, values, [], t.deps), 1, t.ctx.stderr.text);
    assert.equal(starts.length, 4, 'only the four calls already in flight went out');
    assert.deepEqual([...starts], [0, 0, 0, 0], 'every call started before the first reply settled');
    const [runId] = runDirs(t.root);
    const spend = readJson(path.join(t.root, 'runs', runId, 'spend.json'));
    assert.equal(spend.overBudget, true);
    assert.equal(spend.calls, 4);
    const records = fs.readFileSync(path.join(t.root, 'runs', runId, 'records.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.some((r) => r.reason === 'over-budget'));
  });

  it('reports progress on stderr in counts and money only', async () => {
    const t = setup();
    assert.equal(await COMMANDS['compaction-loss'].run(t.ctx, { ...t.values, concurrency: '3' }, [], t.deps), 0, t.ctx.stderr.text);
    const lines = t.ctx.stderr.text.split('\n').filter((l) => l.startsWith('compaction-loss: '));
    assert.ok(lines.some((l) => /^compaction-loss: hand-study author 0\/3 items, \$0\.0000 spent$/.test(l)), t.ctx.stderr.text);
    assert.ok(lines.some((l) => /^compaction-loss: hand-study needed 0\/3 items, \$\d+\.\d{4} spent$/.test(l)), t.ctx.stderr.text);
    for (const fact of [A, B, C]) {
      for (const word of fact.split(' ')) assert.ok(!t.ctx.stderr.text.includes(word), `stderr holds no fact text (${word})`);
    }
  });

  it('refuses --concurrency outside 1 to 32 with exit 2', async () => {
    const t = setup();
    for (const bad of ['0', '33', '1.5', 'x']) {
      const out = { stdout: sink(), stderr: sink(), env: t.env };
      assert.equal(await main(['compaction-loss', '--sessions', SID, '--fake-models', '--concurrency', bad], out), 2, bad);
      assert.match(out.stderr.text, /--concurrency/);
    }
    assert.deepEqual(runDirs(t.root), []);
  });

  it('runs end to end on synth-compacted with --fake-models, for $0', async () => {
    const { env, root } = tmpHome();
    ensureDirs(resolveHome(env));
    fs.cpSync(path.join(FIXTURE_ROOT, 'sessions', 'synth-compacted'), path.join(root, 'sessions', 'synth-compacted'), { recursive: true });
    const out = { stdout: sink(), stderr: sink(), env };
    assert.equal(await main(['compaction-loss', '--sessions', 'synth-compacted', '--fake-models', '--facts-per-window', '3'], out), 0, out.stderr.text);
    assert.match(out.stdout.text, /estimate: \$0\.0000/);
    const [runId] = runDirs(root);
    const summary = readJson(path.join(root, 'runs', runId, 'summary.json'));
    assert.equal(summary.sessions['synth-compacted'].windows, 2);
    assert.equal(summary.sessions['synth-compacted'].facts, 6);
    assert.ok(summary.sessions['synth-compacted'].judged > 0, JSON.stringify(summary));
    assert.equal(readJson(path.join(root, 'runs', runId, 'spend.json')).spentUsd, 0);
  });
});
