'use strict';
// Synthetic sessions with planted facts at controlled distances (benchmark
// spec §10.3), for CI and for sanity-checking adapters. Every value is
// invented: a codename per question from two word lists, ports 18000-18999,
// retry limits 100-999, hosts build-NN.example.com, racks rack-A1..rack-H9.
// Filler uses other words and numbers below 100, so a planted value appears
// only where it was planted. Deterministic for a seed; no clock is read.
const path = require('path');
const { createRng } = require('./rng');
const { SessionIndex, buildManifest, writeSession } = require('./session-format');
const { normalizeQuestion, writeQuestions, questionsFile } = require('./questions');

const GENERATOR_VERSION = 1;
const BASE_TIME = Date.parse('2026-01-05T09:00:00.000Z');
const STEP_MS = 37000;

const ADJECTIVES = ['amber', 'cobalt', 'copper', 'crimson', 'dusky', 'ember', 'frosted', 'gilded', 'hollow', 'ivory', 'jade',
  'lunar', 'misty', 'onyx', 'pale', 'quiet', 'rustic', 'silver', 'tidal', 'umber', 'velvet', 'woven'];
const NOUNS = ['heron', 'lynx', 'otter', 'falcon', 'marmot', 'badger', 'kestrel', 'osprey', 'wren', 'bison', 'ibis', 'newt',
  'puffin', 'raven', 'sparrow', 'tapir', 'vole', 'yak', 'zebu', 'gecko'];
const CHOICES = [
  ['SQLite', 'it needs no server'],
  ['a message queue', 'bursts must not drop jobs'],
  ['blue-green deploys', 'rollbacks must be instant'],
  ['nightly snapshots', 'restores need a known point'],
  ['a read replica', 'reports must not slow writes'],
  ['feature flags', 'the rollout is gradual']
];
const FILLER_WORDS = ['parser', 'config', 'retry', 'schema', 'handler', 'queue', 'cache', 'router', 'session', 'token',
  'index', 'bundle', 'worker', 'buffer', 'timeout', 'fixture', 'module', 'review', 'branch', 'release'];
const FILES = ['src/app/router.js', 'src/app/queue.js', 'src/app/cache.js', 'src/lib/schema.js', 'src/lib/retry.js',
  'tests/router.test.js', 'docs/notes.md'];
const COMMANDS = ['npm test', 'git status', 'git diff --stat', 'node scripts/check.js', 'ls src/app'];
const RACK_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const SYNTH_FIXTURES = Object.freeze([
  {
    sessionId: 'synth-small', seed: 11, turns: 40, resultLines: 8, compactEvery: 0,
    plan: [
      { kind: 'user-said', distanceTokens: 1500 }, { kind: 'tool-observed', distanceTokens: 3000 },
      { kind: 'decision', distanceTokens: 2000 }, { kind: 'superseded', distanceTokens: 1200 },
      { kind: 'multi-hop', distanceTokens: 1000 }, { kind: 'abstain' }
    ]
  },
  {
    sessionId: 'synth-medium', seed: 22, turns: 220, resultLines: 24, compactEvery: 0,
    plan: [
      { kind: 'user-said', distanceTokens: 55000 }, { kind: 'user-said', distanceTokens: 3000 },
      { kind: 'tool-observed', distanceTokens: 25000 }, { kind: 'tool-observed', distanceTokens: 800 },
      { kind: 'decision', distanceTokens: 40000 }, { kind: 'superseded', distanceTokens: 15000 },
      { kind: 'multi-hop', distanceTokens: 20000 }, { kind: 'abstain' }, { kind: 'abstain' }
    ]
  },
  {
    sessionId: 'synth-compacted', seed: 33, turns: 90, resultLines: 12, compactEvery: 30,
    plan: [
      { kind: 'user-said', distanceTokens: 12000 }, { kind: 'decision', distanceTokens: 9000 },
      { kind: 'tool-observed', distanceTokens: 5000 }, { kind: 'superseded', distanceTokens: 4000 },
      { kind: 'multi-hop', distanceTokens: 3000 }, { kind: 'abstain' }
    ]
  }
]);

function words(rng, min, max) {
  const n = rng.int(min, max);
  const out = [];
  for (let i = 0; i < n; i++) out.push(rng.pick(FILLER_WORDS));
  return out.join(' ');
}
const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const fillerUser = (rng) => `Can you look at the ${rng.pick(FILLER_WORDS)} ${rng.pick(FILLER_WORDS)} next? ${capitalized(words(rng, 8, 20))}.`;
const fillerAssistant = (rng) => `${capitalized(words(rng, 20, 50))}. Checking ${rng.pick(FILES)} now.`;
function fillerResult(rng, lines) {
  const out = [];
  for (let i = 1; i <= lines; i++) out.push(`ok ${i % 100} - ${words(rng, 3, 7)} (${rng.int(1, 99)} ms)`);
  return out.join('\n');
}

function valueSource(rng) {
  const used = new Set();
  const fresh = (make) => {
    for (let i = 0; i < 1000; i++) {
      const v = make();
      if (!used.has(v)) { used.add(v); return v; }
    }
    throw new Error('the synthetic generator ran out of unique values');
  };
  return {
    codename: () => fresh(() => `${rng.pick(ADJECTIVES)}-${rng.pick(NOUNS)}`),
    port: () => fresh(() => String(rng.int(18000, 18999))),
    limit: () => fresh(() => String(rng.int(100, 999))),
    host: () => fresh(() => `build-${rng.int(10, 99)}.example.com`),
    rack: () => fresh(() => `rack-${rng.pick(RACK_ROWS)}${rng.int(1, 9)}`)
  };
}

function generateSynthetic({ sessionId, seed, turns, resultLines = 12, compactEvery = 0, plan }) {
  const rng = createRng(seed);
  const messages = [];
  const compactions = [];
  let lastSummary = 0;
  const add = (fields) => {
    const seq = messages.length + 1;
    messages.push({ id: `${sessionId}-m${seq}`, seq, timestamp: new Date(BASE_TIME + seq * STEP_MS).toISOString(), ...fields });
    return seq;
  };

  for (let t = 1; t <= turns; t++) {
    add({ sender: 'user', text: fillerUser(rng) });
    add({ sender: 'assistant', text: fillerAssistant(rng) });
    add({ sender: 'toolUse', toolName: 'Bash', parameters: { command: rng.pick(COMMANDS) } });
    add({ sender: 'toolResult', toolName: 'Bash', result: fillerResult(rng, resultLines) });
    add({ sender: 'assistant', text: fillerAssistant(rng) });
    if (compactEvery && t % compactEvery === 0 && t < turns) {
      const summarySeq = add({ sender: 'status', text: `Summary of the work so far: ${words(rng, 30, 60)}.`, meta: { compaction: true } });
      compactions.push({ atSeq: summarySeq, summarySeq, windowFromSeq: lastSummary + 1, windowToSeq: summarySeq - 1 });
      lastSummary = summarySeq;
    }
  }

  const values = valueSource(rng);
  const filler = new SessionIndex(messages);
  const used = new Set();
  const askPool = rng.shuffle(filler.userSeqs.filter((s) => s > messages.length * 0.6)).slice(0, plan.length);
  if (askPool.length < plan.length) {
    throw new Error(`${sessionId}: ${plan.length} questions need ${plan.length} user messages in the last 40%; lengthen the session`);
  }
  for (const s of askPool) used.add(s);
  const setText = (seq, text) => { messages[seq - 1].text = text; };
  // The nearest free message of an allowed sender at least `tokens`
  // estimated tokens before fromSeq.
  const plantBefore = (fromSeq, tokens, senders) => {
    let seq = fromSeq - 1;
    while (seq >= 1 && filler.tokensBetween(seq, fromSeq) < tokens) seq -= 1;
    for (; seq >= 1; seq -= 1) {
      if (senders.includes(messages[seq - 1].sender) && !used.has(seq)) {
        used.add(seq);
        return seq;
      }
    }
    throw new Error(`${sessionId}: cannot place a ${senders.join('/')} fact ${tokens} tokens before #${fromSeq}; lengthen the session`);
  };

  const planted = plan.map((item, i) => {
    const askAtSeq = askPool[i];
    const codename = values.codename();
    const d = item.distanceTokens || 0;
    let fact;
    switch (item.kind) {
      case 'user-said': {
        const port = values.port();
        const e = plantBefore(askAtSeq, d, ['user']);
        setText(e, `For the record, the staging port for ${codename} is ${port}.`);
        fact = { question: `What staging port did I give for ${codename}?`, answer: port, acceptableAnswers: [port], evidenceSeqs: [e] };
        break;
      }
      case 'tool-observed': {
        const port = values.port();
        const e = plantBefore(askAtSeq, d, ['toolResult']);
        messages[e - 1].result = `${messages[e - 1].result}\nworker ${codename} listening on port ${port}`;
        fact = { question: `Which port was the ${codename} worker listening on, according to the tool output?`, answer: port, acceptableAnswers: [port], evidenceSeqs: [e] };
        break;
      }
      case 'decision': {
        const [choice, reason] = rng.pick(CHOICES);
        const e = plantBefore(askAtSeq, d, ['assistant']);
        setText(e, `We decided to use ${choice} for ${codename} because ${reason}.`);
        fact = { question: `What did we decide to use for ${codename}, and why?`, answer: `${choice}, because ${reason}`, acceptableAnswers: [choice], evidenceSeqs: [e] };
        break;
      }
      case 'superseded': {
        const before = values.limit();
        const after = values.limit();
        const eNew = plantBefore(askAtSeq, d, ['user']);
        const eOld = plantBefore(eNew, d, ['user']);
        setText(eOld, `Set the ${codename} retry limit to ${before}.`);
        setText(eNew, `Change of plan: the ${codename} retry limit is now ${after}.`);
        fact = { question: `What is the current retry limit for ${codename}?`, answer: after, acceptableAnswers: [after], evidenceSeqs: [eOld, eNew] };
        break;
      }
      case 'multi-hop': {
        const host = values.host();
        const rack = values.rack();
        const eNear = plantBefore(askAtSeq, d, ['user']);
        const eFar = plantBefore(eNear, d, ['assistant']);
        setText(eFar, `The ${codename} service runs on ${host}.`);
        setText(eNear, `Note that ${host} sits in ${rack}.`);
        fact = { question: `Which rack does the ${codename} service run in?`, answer: rack, acceptableAnswers: [rack], evidenceSeqs: [eFar, eNear] };
        break;
      }
      case 'abstain':
        fact = { question: `What port did we pick for the ${codename} cache?`, answer: 'not in the session', acceptableAnswers: [], evidenceSeqs: [] };
        break;
      default:
        throw new Error(`unknown kind ${item.kind}`);
    }
    setText(askAtSeq, fact.question);
    return {
      id: `${sessionId}-${String(i + 1).padStart(3, '0')}`, sessionId, askAtSeq, kind: item.kind, ...fact,
      supersededBy: null, authoredBy: 'generated', verifiedBy: 'synthetic',
      notes: `planted by the synthetic generator, target distance ${d} tokens`
    };
  });

  const index = new SessionIndex(messages);
  const questions = planted.map((q) => normalizeQuestion(q, index)).sort((a, b) => a.askAtSeq - b.askAtSeq);
  const manifest = buildManifest({
    sessionId,
    source: 'synthetic',
    sourceRef: `synthetic:v${GENERATOR_VERSION}:seed=${seed}`,
    license: 'CC-BY-4.0',
    private: false,
    messages,
    compactions,
    extra: {
      title: `Synthetic session ${sessionId}`,
      generator: { version: GENERATOR_VERSION, seed, turns, resultLines, compactEvery },
      unmapped: 0,
      constructed: false
    }
  });
  return { manifest, messages, questions, index };
}

function writeSyntheticRoot(root, fixtures = SYNTH_FIXTURES) {
  return fixtures.map((config) => {
    const { manifest, messages, questions } = generateSynthetic(config);
    writeSession(path.join(root, 'sessions', config.sessionId), { manifest, messages });
    writeQuestions(questionsFile(root, config.sessionId), questions);
    return { sessionId: config.sessionId, messages: messages.length, questions: questions.length, estTokens: manifest.estTokens };
  });
}

module.exports = { SYNTH_FIXTURES, GENERATOR_VERSION, generateSynthetic, writeSyntheticRoot };
