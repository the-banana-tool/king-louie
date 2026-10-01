'use strict';
// The judge (benchmark spec §8 step 4): a model other than the answer model
// grades one reply against the reference answer and the acceptable answers
// as correct, partial, incorrect or abstained, with a one-line reason
// (prompts/judge-v1.md). It sees the question, the references and the reply,
// never the context: less of a private session leaves the machine and each
// call stays small. It grades meaning, not wording: 40% of the verified
// answers are paraphrases of their evidence (recall spec §6.7), all the
// decision questions among them. For an abstain question only "abstained" is
// right; any other verdict is a false answer.
const { fillTemplate } = require('./prompts');
const { parseReply } = require('./author');
const { sha256Text } = require('./files');

const VERDICTS = Object.freeze(['correct', 'partial', 'incorrect', 'abstained']);
const JUDGE_KIND_RULES = Object.freeze({
  'user-said': 'The owner stated this fact earlier in the session. A reply that states the same fact in other words is correct.',
  'tool-observed': 'This fact appeared in tool output (a port, a path, a count, an error string). Values must match exactly; the words around them need not.',
  decision: 'The reference gives a decision and the reason for it. correct needs both, in any wording; the decision without its reason is partial, even when an acceptable answer lists the decision alone.',
  superseded: 'The value changed during the session; only the latest value (the reference) is correct. The earlier value is incorrect.',
  'multi-hop': 'The answer combines two facts from different places; only the final answer the question asks for must match.',
  abstain: 'The fact was never stated in the session, so the right reply declines. Use abstained when the reply declines or says it does not know; use incorrect when it states any answer. Never use correct or partial for this kind.'
});
const NO_REFERENCE = '(none: the fact is never stated in the session)';
const NO_OTHER_ANSWERS = '(none)';
const EMPTY_REPLY = '(empty reply)';
// These strings are part of every judge prompt but not of judge-v1.md, so
// the file's hash alone does not name the prompt a verdict came from.
// config.json records this hash beside it, and the judge's cache key is the
// hash of the rendered prompt (answer-stage.js judgeKey), so editing any of
// them makes new keys. Insertion order is fixed here, so JSON.stringify is
// stable.
const JUDGE_RULES_SHA256 = sha256Text(JSON.stringify({
  kindRules: JUDGE_KIND_RULES, noReference: NO_REFERENCE, noOtherAnswers: NO_OTHER_ANSWERS, emptyReply: EMPTY_REPLY
}));
const REASON_MAX = 300;

function buildJudgePrompt(template, { question, reply }) {
  const abstain = question.kind === 'abstain';
  const others = abstain ? [] : [...new Set((question.acceptableAnswers || []).filter((a) => a !== question.answer))];
  return fillTemplate(template, {
    kind: question.kind,
    kindRule: JUDGE_KIND_RULES[question.kind],
    question: question.question,
    reference: abstain ? NO_REFERENCE : question.answer,
    acceptable: others.length ? others.map((a) => JSON.stringify(a)).join('; ') : NO_OTHER_ANSWERS,
    reply: String(reply ?? '').trim() || EMPTY_REPLY
  });
}

// { verdict, reason } from the judge's reply, or null when it is not one
// JSON object with a known verdict (recorded as judge-unparsed, spec §15).
function parseVerdict(text) {
  const value = parseReply(text);
  if (!value) return null;
  const verdict = typeof value.verdict === 'string' ? value.verdict.trim().toLowerCase() : '';
  if (!VERDICTS.includes(verdict)) return null;
  const reason = typeof value.reason === 'string' ? value.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : '';
  return { verdict, reason };
}

// answerCorrect for an answerable question, abstainCorrect for an abstain
// one; the other is null.
function scoreVerdict(question, verdict) {
  if (question.kind === 'abstain') return { answerCorrect: null, abstainCorrect: verdict === 'abstained' };
  return { answerCorrect: verdict === 'correct', abstainCorrect: null };
}

// Whether a judged record is right: correct on an answerable question,
// abstained on an abstain one.
function isRight(record) {
  return record.kind === 'abstain' ? record.verdict === 'abstained' : record.verdict === 'correct';
}

module.exports = { VERDICTS, JUDGE_KIND_RULES, JUDGE_RULES_SHA256, buildJudgePrompt, parseVerdict, scoreVerdict, isRight };
