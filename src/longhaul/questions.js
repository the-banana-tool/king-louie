'use strict';
// LongHaul's question format and validator (benchmark spec §5). Distance is
// computed from the session, never typed: from the nearest evidence message
// to askAtSeq, in messages and in estimated tokens strictly between.
const fs = require('fs');
const path = require('path');
const { readJsonlLines } = require('../history/importers/jsonl-lines');
const { writeFileAtomic, childPath } = require('./files');
const { UsageError } = require('./errors');

const KINDS = Object.freeze(['user-said', 'tool-observed', 'decision', 'superseded', 'multi-hop', 'abstain']);
const BUCKETS = Object.freeze([
  { id: '<10K', min: 0, max: 10000 },
  { id: '10K-50K', min: 10000, max: 50000 },
  { id: '50K-200K', min: 50000, max: 200000 },
  { id: '200K-1M', min: 200000, max: 1000000 },
  { id: '>1M', min: 1000000, max: Infinity }
]);
const NO_BUCKET = 'none';
const AUTHORED_BY = Object.freeze(['generated', 'human']);
const VERIFIED_BY_RE = /^(human:[A-Za-z0-9._-]{1,32}|synthetic)$/;
const EVIDENCE_SENDERS = Object.freeze({ 'user-said': ['user'], 'tool-observed': ['toolResult'], decision: ['assistant', 'user'] });
const MIN_EVIDENCE = Object.freeze({ 'user-said': 1, 'tool-observed': 1, decision: 1, superseded: 2, 'multi-hop': 2, abstain: 0 });

function bucketFor(distance) {
  if (!distance) return NO_BUCKET;
  return BUCKETS.find((b) => distance.estTokens >= b.min && distance.estTokens < b.max).id;
}

function computeDistance(index, question) {
  const seqs = Array.isArray(question.evidenceSeqs) ? question.evidenceSeqs : [];
  if (seqs.length === 0) return null;
  const nearest = Math.max(...seqs);
  return { messages: question.askAtSeq - nearest, estTokens: index.tokensBetween(nearest, question.askAtSeq) };
}

function isVerified(question) {
  return typeof question.verifiedBy === 'string' && VERIFIED_BY_RE.test(question.verifiedBy);
}

function validateQuestion(q, { index, sessionId }) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return ['not-an-object: the question is not a JSON object'];
  const errors = [];
  const add = (code, detail) => errors.push(`${code}: ${detail}`);

  if (typeof q.id !== 'string' || !q.id.trim()) add('id', 'missing id');
  if (q.sessionId !== sessionId) add('session', `sessionId ${JSON.stringify(q.sessionId)} is not ${sessionId}`);
  if (!KINDS.includes(q.kind)) add('kind', `unknown kind ${JSON.stringify(q.kind)}`);
  if (typeof q.question !== 'string' || !q.question.trim()) add('question', 'the question is empty');
  if (typeof q.answer !== 'string' || !q.answer.trim()) add('answer', 'the answer is empty');
  if (q.acceptableAnswers !== undefined && (!Array.isArray(q.acceptableAnswers) || q.acceptableAnswers.some((a) => typeof a !== 'string' || !a.trim()))) {
    add('acceptable-answers', 'acceptableAnswers must be non-empty strings');
  }
  if (!AUTHORED_BY.includes(q.authoredBy)) add('authored-by', `authoredBy must be ${AUTHORED_BY.join(' or ')}`);
  if (q.verifiedBy !== null && !isVerified(q)) add('verified-by', 'verifiedBy must be null, "human:<initials>" or "synthetic"');

  const at = index.get(q.askAtSeq);
  if (!at) add('askAtSeq-range', `askAtSeq ${q.askAtSeq} is not a message of the session (1..${index.maxSeq})`);
  else if (at.sender !== 'user') add('askAtSeq-not-user', `message #${q.askAtSeq} is a ${at.sender} message; askAtSeq must point at a user message`);

  const ev = q.evidenceSeqs;
  if (!Array.isArray(ev) || ev.some((s) => !Number.isInteger(s))) {
    add('evidence-type', 'evidenceSeqs must be an array of whole numbers');
  } else {
    if (new Set(ev).size !== ev.length) add('evidence-duplicate', 'evidenceSeqs repeats a seq');
    for (const s of ev) {
      if (Number.isInteger(q.askAtSeq) && s >= q.askAtSeq) add('evidence-after-ask', `evidence #${s} is not before askAtSeq ${q.askAtSeq}`);
      else if (!index.get(s)) add('evidence-range', `evidence #${s} is not a message of the session`);
    }
    if (KINDS.includes(q.kind)) {
      if (q.kind === 'abstain' && ev.length > 0) add('abstain-evidence', 'an abstain question has no evidence');
      else if (ev.length < MIN_EVIDENCE[q.kind]) add('evidence-count', `${q.kind} needs at least ${MIN_EVIDENCE[q.kind]} evidence seqs, has ${ev.length}`);
      const allowed = EVIDENCE_SENDERS[q.kind];
      if (allowed) {
        for (const s of ev) {
          const m = index.get(s);
          if (m && s < q.askAtSeq && !allowed.includes(m.sender)) add('evidence-sender', `${q.kind} evidence #${s} is a ${m.sender} message; expected ${allowed.join(' or ')}`);
        }
      }
    }
  }

  if (q.supersededBy !== null && q.supersededBy !== undefined) {
    if (q.kind !== 'superseded') add('superseded-by', 'only a superseded question names supersededBy');
    else if (!Number.isInteger(q.supersededBy) || q.supersededBy <= q.askAtSeq || !index.get(q.supersededBy)) {
      add('superseded-by', `supersededBy must be a message after askAtSeq ${q.askAtSeq}`);
    }
  }

  if (errors.length === 0 && q.distance !== undefined) {
    const computed = computeDistance(index, q);
    const same = computed === null
      ? q.distance === null
      : Boolean(q.distance) && q.distance.messages === computed.messages && q.distance.estTokens === computed.estTokens;
    if (!same) add('distance-mismatch', `stored ${JSON.stringify(q.distance)}, computed ${JSON.stringify(computed)}; distance is computed, never typed`);
  }
  return errors;
}

function validateQuestionSet(questions, ctx) {
  const problems = [];
  const seen = new Set();
  for (const question of questions) {
    const errors = validateQuestion(question, ctx);
    const id = question?.id ?? '(no id)';
    if (seen.has(id)) errors.push(`duplicate-id: ${id} appears more than once`);
    seen.add(id);
    if (errors.length) problems.push({ id, errors });
  }
  return problems;
}

function normalizeQuestion(q, index) {
  return {
    id: q.id,
    sessionId: q.sessionId,
    askAtSeq: q.askAtSeq,
    kind: q.kind,
    question: q.question,
    answer: q.answer,
    acceptableAnswers: Array.isArray(q.acceptableAnswers) ? q.acceptableAnswers : [],
    evidenceSeqs: [...q.evidenceSeqs].sort((a, b) => a - b),
    supersededBy: q.supersededBy ?? null,
    distance: computeDistance(index, q),
    authoredBy: q.authoredBy,
    verifiedBy: q.verifiedBy ?? null,
    notes: typeof q.notes === 'string' ? q.notes : ''
  };
}

function questionsPath(dataRoot, sessionId, suffix) {
  const base = path.join(dataRoot, 'questions');
  const escape = () => new UsageError(`Session id ${JSON.stringify(sessionId)} leaves ${base}.`, 'BAD_SESSION_ID');
  const out = childPath(base, `${sessionId}${suffix}`, escape);
  if (path.dirname(path.resolve(out)) !== path.resolve(base)) throw escape();
  return out;
}

function questionsFile(dataRoot, sessionId) {
  return questionsPath(dataRoot, sessionId, '.jsonl');
}

// Questions rejected in `verify`, and one line per `author` invocation.
function rejectedFile(dataRoot, sessionId) {
  return questionsPath(dataRoot, sessionId, '.rejected.jsonl');
}

function authorLogFile(dataRoot, sessionId) {
  return questionsPath(dataRoot, sessionId, '.author-log.jsonl');
}

async function readQuestions(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for await (const { line, lineNo } of readJsonlLines(file)) {
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${path.basename(file)} line ${lineNo}: ${err.message}`);
    }
  }
  return out;
}

function writeQuestions(file, questions) {
  writeFileAtomic(file, (write) => {
    for (const question of questions) write(`${JSON.stringify(question)}\n`);
  });
}

module.exports = {
  KINDS, BUCKETS, NO_BUCKET, VERIFIED_BY_RE,
  bucketFor, computeDistance, isVerified,
  validateQuestion, validateQuestionSet, normalizeQuestion,
  questionsFile, rejectedFile, authorLogFile, readQuestions, writeQuestions
};
