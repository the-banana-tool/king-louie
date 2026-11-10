'use strict';
// tests/longhaul-compaction-report.test.js
// `longhaul report` and `longhaul spot-check` over a compaction-loss run
// (benchmark spec §9, §8 step 4): the run is made by the real command over a
// hand-built session with scripted providers, as in the study's own test.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { main, COMMANDS } = require('../src/longhaul/cli');
const { writeReport } = require('../src/longhaul/report');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { buildManifest, writeSession, sessionDir } = require('../src/longhaul/session-format');
const { normalizeText } = require('../src/longhaul/scoring');
const { writeFileAtomic } = require('../src/longhaul/files');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { tmpHome, sink, makePrivate } = require('./helpers/longhaul-helpers');

const SID = 'hand-report';
const A = 'alpha-key-4411 deploy key';
const B = 'bravo-port-9922 web port';
const C = 'charlie-dir-5533 cache folder';
const FACTS = { 3: A, 18: B, 30: C };

function msg(seq, sender, text, meta) {
  return { id: `m${seq}`, seq, sender, text, timestamp: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(), ...(meta ? { meta } : {}) };
}

function writeHandSession(root) {
  const messages = [];
  for (let seq = 1; seq <= 60; seq++) {
    let m = msg(seq, seq % 2 ? 'user' : 'assistant', `ok ${seq}`);
    if (seq === 3) m = msg(seq, 'user', `please set ${A} for the release now`);
    if (seq === 18) m = msg(seq, 'user', `we will serve on ${B} from today onward`);
    if (seq === 30) m = msg(seq, 'user', `remember ${C} holds our build data`);
    if (seq === 50) m = msg(seq, 'assistant', 'bravo-port-9922 again here');
    if (seq === 21) m = msg(seq, 'status', `Summary: ${A} chosen.`, { compaction: true });
    if (seq === 41) m = msg(seq, 'status', `Summary: ${C} noted.`, { compaction: true });
    messages.push(m);
  }
  const manifest = buildManifest({
    sessionId: SID, source: 'synthetic', sourceRef: 'test', license: 'CC-BY-4.0', private: false, messages,
    compactions: [
      { atSeq: 21, summarySeq: 21, windowFromSeq: 1, windowToSeq: 20 },
      { atSeq: 41, summarySeq: 41, windowFromSeq: 22, windowToSeq: 40 }
    ]
  });
  writeSession(sessionDir(root, SID), { manifest, messages });
}

const between = (text, open, close) => {
  const s = text.indexOf(open);
  return s < 0 ? '' : text.slice(s + open.length, text.indexOf(close, s)).trim();
};

function scripted() {
  const reply = (prompt) => {
    if (prompt.startsWith('You pick one fact')) {
      for (const [seq, fact] of Object.entries(FACTS)) {
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
      onChunk(reply(messages[0].content));
      return { content: '', llmMetrics: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 } };
    }
  };
}

async function studyRun({ isPrivate = false } = {}) {
  const { env, root } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeHandSession(root);
  if (isPrivate) makePrivate(root, SID);
  const ctx = { home, env, stdout: sink(), stderr: sink(), now: () => new Date('2026-11-09T10:00:00Z'), cwd: process.cwd() };
  const deps = { providerInstances: { author: scripted(), judge: scripted() }, catalog: fixtureCatalog(), retry: { wait: async () => {} } };
  const values = {
    sessions: SID, 'author-provider': 'openai', 'author-model': 'gpt-5.4-mini', 'judge-provider': 'anthropic', 'judge-model': 'claude-haiku-4-5',
    'facts-per-window': '2', ...(isPrivate ? { 'send-private': true } : {})
  };
  assert.equal(await COMMANDS['compaction-loss'].run(ctx, values, [], deps), 0, ctx.stderr.text);
  const [runId] = fs.readdirSync(home.runs);
  return { env, root, home, runId };
}

const readAll = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
const input = (lines) => Readable.from([lines.map((l) => `${l}\n`).join('')]);

describe('longhaul report over a compaction-loss run', () => {
  it('writes the study table with the exact rates in CSV, TeX and Markdown, and no session text', async () => {
    const t = await studyRun();
    const out = writeReport(t.home, [t.runId]);
    assert.deepEqual(out.files, ['compaction-loss.csv', 'compaction-loss.tex', 'report.md']);
    const files = readAll(out.dir);
    const rows = files['compaction-loss.csv'].trim().split('\n');
    assert.equal(rows[0], 'run,session,windows,facts,judged,rejected,errors,preserved_rate,partial_rate,lost_rate,needed_rate,lost_and_needed_rate,median_ratio');
    assert.equal(rows.length, 3);
    assert.match(rows[1], new RegExp(`^${t.runId},${SID},2,3,3,0,0,0\\.667,0\\.000,0\\.333,0\\.333,0\\.333,\\d+\\.\\d$`));
    assert.match(rows[2], new RegExp(`^${t.runId},all,2,3,3,0,0,0\\.667,0\\.000,0\\.333,0\\.333,0\\.333,`));
    assert.match(files['compaction-loss.tex'], /hand-report & 2 & 3 & 0\.667 & 0\.000 & 0\.333 & 0\.333 & 0\.333 & /);
    assert.match(files['compaction-loss.tex'], /\\begin\{tabular\}/);
    const config = JSON.parse(fs.readFileSync(path.join(t.home.runs, t.runId, 'config.json'), 'utf8'));
    assert.ok(files['report.md'].includes(config.prompts.compactionFact.slice(0, 12)));
    assert.match(files['report.md'], /openai\/gpt-5\.4-mini/);
    assert.match(files['report.md'], /anthropic\/claude-haiku-4-5/);
    assert.match(files['report.md'], /not reviewed \(1 sampled\)/);
    for (const [name, text] of Object.entries(files)) {
      for (const fact of [A, B, C]) assert.ok(!text.includes(fact.split(' ')[0]), `${name} holds no fact text`);
      assert.ok(!text.includes('scripted'), `${name} holds no judge reason`);
    }
  });

  it('regenerates byte-identical files', async () => {
    const t = await studyRun();
    const first = readAll(writeReport(t.home, [t.runId]).dir);
    const second = readAll(writeReport(t.home, [t.runId]).dir);
    assert.deepEqual(second, first);
  });

  it('--public refuses a run over a private session, exit 2', async () => {
    const t = await studyRun({ isPrivate: true });
    const out = { stdout: sink(), stderr: sink(), env: t.env };
    assert.equal(await main(['report', '--runs', t.runId, '--public'], out), 2);
    assert.match(out.stderr.text, /private/);
    assert.deepEqual(fs.readdirSync(t.home.reports), []);
  });

  it('refuses a cohort mixing an answer-stage run and a compaction run, MIXED_RUN_KINDS', async () => {
    const t = await studyRun();
    const other = '20260930T100000Z-aaaa';
    writeFileAtomic(path.join(t.home.runs, other, 'config.json'), `${JSON.stringify({
      runId: other, stage: 'B3', commit: 'abcdef1234567890', adapters: [], sessions: [{ sessionId: 'S1', private: false, questions: 0 }],
      answer: {
        tier: 'grid', answerModel: { provider: 'openai', model: 'm', maxTokens: 400 }, judgeModel: { provider: 'anthropic', model: 'j', maxTokens: 200 },
        prompts: { answer: { sha256: 'a'.repeat(64) }, judge: { sha256: 'b'.repeat(64) } }
      }
    })}\n`);
    writeFileAtomic(path.join(t.home.runs, other, 'records.jsonl'), '');
    assert.throws(() => writeReport(t.home, [t.runId, other]), (err) => err.code === 'MIXED_RUN_KINDS');
    const out = { stdout: sink(), stderr: sink(), env: t.env };
    assert.equal(await main(['report', '--runs', `${t.runId},${other}`], out), 2);
  });

  it('spot-check shows the fact, quote, evidence and summary; y agrees with both and the report shows it', async () => {
    const t = await studyRun();
    const stdout = sink();
    assert.equal(await main(['spot-check', '--run', t.runId, '--reviewer', 'TT'], { stdout, stderr: sink(), env: t.env, stdin: input(['y']) }), 0);
    const [row] = fs.readFileSync(path.join(t.root, 'private', 'spot-checks', `${t.runId}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(row.humanPreserved, row.preserved.verdict);
    assert.equal(row.humanNeeded, row.needed.verdict);
    assert.equal(row.reviewer, 'human:TT');
    assert.ok(stdout.text.includes(`Fact: ${row.fact}`));
    assert.ok(stdout.text.includes(`Quote: ${row.quote}`));
    assert.match(stdout.text, new RegExp(`Evidence #${row.evidenceSeq}:`));
    assert.match(stdout.text, new RegExp(`Summary #${row.summarySeq}:\\nSummary: `));
    assert.match(stdout.text, /Judge agreement: 1\/1 \(1\.000\) of 1 sampled/);
    const md = readAll(writeReport(t.home, [t.runId]).dir)['report.md'];
    assert.match(md, /1\/1 agreed with both \(1 sampled; summary 1\/1, needed 1\/1\)/);
  });
});
