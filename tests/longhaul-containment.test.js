// tests/longhaul-containment.test.js
// Answer containment (benchmark spec §8, B0 secondary metric): whether an
// adapter's context text holds the question's answer, strict and by tokens.
// Invented fixtures only.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { answerContainment, normalizeText, normalizeAnswer, splitMessages, summarize, renderSummaryMarkdown } = require('../src/longhaul/scoring');
const { runBenchmark } = require('../src/longhaul/run');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink, FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

const q = (answer, acceptableAnswers = [], kind = 'user-said') => ({ kind, answer, acceptableAnswers });

describe('answer containment: normalization', () => {
  it('folds case, NFKC forms, typographic punctuation and whitespace', () => {
    assert.strictEqual(normalizeText('  Rack F2\n\n\tNOW '), 'rack f2 now');
    assert.strictEqual(normalizeText('Ｒａｃｋ'), 'rack'); // fullwidth
    assert.strictEqual(normalizeText('“blue—green” it’s'), '"blue-green" it\'s');
  });

  it('strips surrounding punctuation from an answer, not inner punctuation', () => {
    assert.strictEqual(normalizeAnswer('  "rack-F2."  '), 'rack-f2');
    assert.strictEqual(normalizeAnswer('(port 18796)!'), 'port 18796');
    assert.strictEqual(normalizeAnswer('...'), '');
  });
});

describe('answer containment: matching', () => {
  const context = '[#3 user]\nThe  staging PORT is “18796”.\n\n[#9 · assistant · 2 days ago]\nWe use blue-green deploys.';

  it('finds the answer as a substring after normalization', () => {
    assert.deepStrictEqual(answerContainment(context, q('port is "18796"')), { strict: true, tokens: true });
    assert.deepStrictEqual(answerContainment(context, q('Blue–Green deploys.')), { strict: true, tokens: true });
  });

  it('counts any acceptable answer', () => {
    assert.deepStrictEqual(answerContainment(context, q('eighteen seven nine six', ['18796'])), { strict: true, tokens: true });
  });

  it('token variant: every word of the shortest answer inside one message', () => {
    // Words out of order within message #3: tokens yes, strict no.
    assert.deepStrictEqual(answerContainment(context, q('18796, staging')), { strict: false, tokens: true });
    // One word in #3 and the other in #9: neither.
    assert.deepStrictEqual(answerContainment(context, q('staging deploys')), { strict: false, tokens: false });
    // The shortest answer is the one tokenized.
    assert.deepStrictEqual(answerContainment(context, q('staging port deploys soon', ['port staging'])), { strict: false, tokens: true });
  });

  it('misses a paraphrase and an absent answer', () => {
    assert.deepStrictEqual(answerContainment(context, q('the port for staging is eighteen seven nine six')), { strict: false, tokens: false });
    assert.deepStrictEqual(answerContainment('', q('18796')), { strict: false, tokens: false });
  });

  it('leaves abstain questions and empty answers out (null)', () => {
    assert.strictEqual(answerContainment(context, q('not in the session', [], 'abstain')), null);
    assert.strictEqual(answerContainment(context, q('...')), null);
  });

  it('splits a context at LongHaul and excerpt headers', () => {
    const text = 'preamble\n[#1 user]\na\n\n[#2 · user · 1 day ago]\nb\n\n[chat "x" · #3 · user]\nc';
    assert.deepStrictEqual(splitMessages(text), ['preamble', 'a', 'b', 'c']);
  });
});

describe('answer containment in summaries', () => {
  const r = (kind, bucket, er, contained, tokens) => ({
    adapter: 'a', kind, bucket, evidenceRecall: er, chunkEvidenceRecall: null, answerContained: contained, answerTokensContained: tokens,
    estTokens: 10, latencyMs: 1, cpuMs: 1, leaked: 0, error: null
  });

  it('rates containment over scored questions, abstain excluded, by kind and bucket', () => {
    const s = summarize([
      r('user-said', '<10K', 0, true, true), r('user-said', '<10K', 1, false, true),
      r('superseded', '10K-50K', 0.5, false, false), r('abstain', 'none', null, null, null)
    ]).a;
    assert.strictEqual(s.scored, 3);
    assert.strictEqual(s.answerContainment, 1 / 3);
    assert.strictEqual(s.answerTokenContainment, 2 / 3);
    assert.deepStrictEqual(s.byKind['user-said'], { n: 2, evidenceRecall: 0.5, answerContainment: 0.5, answerTokenContainment: 1 });
    assert.strictEqual(s.byBucket['10K-50K'].answerContainment, 0);
    assert.strictEqual(s.byKind.abstain, undefined);
  });

  it('renders containment next to evidence recall in every table', () => {
    const summary = summarize([r('user-said', '<10K', 0, true, true)]);
    const md = renderSummaryMarkdown({ runId: 'x', budgetTokens: 6000, seed: 1, commit: 'c', sessions: [] }, summary);
    assert.match(md, /\| Evidence recall \| Answer contained \| Answer tokens contained \| Partial \|/);
    assert.match(md, /\| a \| 1 \| 1 \| 0 \| 0\.000 \| 1\.000 \| 1\.000 \| 0 \|/);
    assert.match(md, /## Evidence recall \/ answer contained by kind/);
    assert.match(md, /## Evidence recall \/ answer contained by distance/);
    assert.match(md, /\| a \| 0\.000 \/ 1\.000 \(n=1\)/);
  });
});

describe('answer containment in a run', () => {
  it('records booleans per question (null for abstain), never the text; oracle contains every answer', async () => {
    const { env } = tmpHome();
    const home = ensureDirs(resolveHome(env));
    writeSyntheticRoot(home.root, [SYNTH_FIXTURES[0]]);
    const out = await runBenchmark({ home, adapterNames: ['oracle'], now: () => new Date('2026-09-29T10:00:00Z'), commit: 'x' });
    for (const rec of out.records) {
      if (rec.kind === 'abstain') {
        assert.strictEqual(rec.answerContained, null);
        assert.strictEqual(rec.answerTokensContained, null);
      } else {
        assert.strictEqual(rec.answerContained, true, rec.questionId);
      }
    }
    assert.strictEqual(out.summary.oracle.answerContainment, 1);
    const raw = fs.readFileSync(path.join(out.dir, 'records.jsonl'), 'utf8');
    assert.ok(!/"text"/.test(raw), 'records carry no context text');
  });

  it('prints containment on the CLI line', async () => {
    const { env } = tmpHome();
    const stdout = sink();
    const code = await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle', '--include-unverified'], { stdout, stderr: sink(), env });
    assert.strictEqual(code, 0);
    assert.match(stdout.text, /oracle +evidence recall 1\.000 \(n=\d+\) {2}answer contained 1\.000 \(tokens 1\.000\)/);
  });
});
