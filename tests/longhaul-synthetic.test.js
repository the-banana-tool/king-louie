// tests/longhaul-synthetic.test.js
// Synthetic sessions with planted facts (benchmark spec §10.3). The committed
// fixtures must equal what the generator produces.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createRng } = require('../src/longhaul/rng');
const { SYNTH_FIXTURES, generateSynthetic, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { validateMessages, validateManifest, loadSession, messageText } = require('../src/longhaul/session-format');
const { validateQuestionSet, isVerified, bucketFor, readQuestions, questionsFile } = require('../src/longhaul/questions');
const { scanForPersonalValues } = require('./helpers/example-denylist');
const { FIXTURE_ROOT, tmpDir } = require('./helpers/longhaul-helpers');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsWord = (text, word) => new RegExp(`(^|[^0-9A-Za-z-])${escape(word)}($|[^0-9A-Za-z-])`).test(text);

describe('createRng', () => {
  it('is deterministic and keeps int() inside its inclusive bounds', () => {
    const a = createRng(7);
    const b = createRng(7);
    const xs = Array.from({ length: 50 }, () => a.int(3, 5));
    assert.deepStrictEqual(xs, Array.from({ length: 50 }, () => b.int(3, 5)));
    assert.ok(xs.every((x) => x >= 3 && x <= 5));
    assert.deepStrictEqual(new Set(xs), new Set([3, 4, 5]));
    assert.deepStrictEqual(createRng(1).shuffle([1, 2, 3, 4]).sort(), [1, 2, 3, 4]);
  });
});

describe('generateSynthetic', () => {
  it('is deterministic for a seed and changes with it', () => {
    const a = generateSynthetic(SYNTH_FIXTURES[0]);
    const b = generateSynthetic(SYNTH_FIXTURES[0]);
    assert.deepStrictEqual(a.messages, b.messages);
    assert.deepStrictEqual(a.questions, b.questions);
    assert.notDeepStrictEqual(generateSynthetic({ ...SYNTH_FIXTURES[0], seed: 12 }).messages, a.messages);
  });

  for (const config of SYNTH_FIXTURES) {
    it(`${config.sessionId}: a valid session with valid, verified questions of every planned kind`, () => {
      const { manifest, messages, questions, index } = generateSynthetic(config);
      assert.deepStrictEqual(validateMessages(messages), []);
      assert.deepStrictEqual(validateManifest(manifest, messages), []);
      assert.deepStrictEqual(validateQuestionSet(questions, { index, sessionId: config.sessionId }), []);
      assert.ok(questions.every(isVerified));
      assert.deepStrictEqual(questions.map((q) => q.kind).sort(), config.plan.map((p) => p.kind).sort());
      assert.strictEqual(manifest.private, false);
    });

    it(`${config.sessionId}: each planted answer is in its evidence and nowhere else before askAtSeq`, () => {
      const { questions, index } = generateSynthetic(config);
      for (const q of questions.filter((x) => x.kind !== 'abstain')) {
        const answer = q.acceptableAnswers[0];
        const holders = [];
        for (let s = 1; s < q.askAtSeq; s++) if (containsWord(messageText(index.get(s)), answer)) holders.push(s);
        assert.ok(holders.length > 0, `${q.id}: "${answer}" is not in the session`);
        assert.ok(holders.every((s) => q.evidenceSeqs.includes(s)), `${q.id}: "${answer}" also appears at ${holders}`);
      }
    });

    it(`${config.sessionId}: an abstain codename never appears before askAtSeq`, () => {
      const { questions, index } = generateSynthetic(config);
      for (const q of questions.filter((x) => x.kind === 'abstain')) {
        const codename = /for the (\S+) cache/.exec(q.question)[1];
        for (let s = 1; s < q.askAtSeq; s++) assert.ok(!messageText(index.get(s)).includes(codename), `${q.id}: ${codename} at #${s}`);
      }
    });

    it(`${config.sessionId}: invented values only`, () => {
      const { messages, questions } = generateSynthetic(config);
      const text = messages.map(messageText).join('\n') + JSON.stringify(questions);
      assert.deepStrictEqual(scanForPersonalValues(text), []);
    });
  }

  it('synth-compacted carries two compactions whose summaries are compaction status messages', () => {
    const config = SYNTH_FIXTURES.find((c) => c.sessionId === 'synth-compacted');
    const { manifest, index } = generateSynthetic(config);
    assert.strictEqual(manifest.compactions.length, 2);
    for (const c of manifest.compactions) assert.deepStrictEqual(index.get(c.summarySeq).meta, { compaction: true });
  });

  it('the fixtures cover three distance buckets and abstain', () => {
    const buckets = new Set(SYNTH_FIXTURES.flatMap((c) => generateSynthetic(c).questions.map((q) => bucketFor(q.distance))));
    for (const b of ['<10K', '10K-50K', '50K-200K', 'none']) assert.ok(buckets.has(b), `no question in ${b}`);
  });

  it('the committed fixtures match the generator', async () => {
    const out = tmpDir();
    writeSyntheticRoot(out);
    for (const c of SYNTH_FIXTURES) {
      const committed = await loadSession(path.join(FIXTURE_ROOT, 'sessions', c.sessionId));
      const fresh = await loadSession(path.join(out, 'sessions', c.sessionId));
      assert.deepStrictEqual(committed.manifest, fresh.manifest, `${c.sessionId} manifest drifted: run node bin/longhaul.js synth --out tests/fixtures/longhaul`);
      assert.deepStrictEqual(committed.messages, fresh.messages, `${c.sessionId} messages drifted`);
      assert.deepStrictEqual(await readQuestions(questionsFile(FIXTURE_ROOT, c.sessionId)), await readQuestions(questionsFile(out, c.sessionId)));
    }
  });
});
