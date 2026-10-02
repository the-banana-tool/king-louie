'use strict';
// The answer call (benchmark spec §8 step 3): the answer model sees the
// adapter's context and the question, answers from the context alone, or
// says it does not know (prompts/answer-v1.md).
const { fillTemplate } = require('./prompts');

const DONT_KNOW = "I don't know";
// Spliced into the prompt instead of an empty context, so it is part of the
// answer's cache key (answer-stage.js answerKey) as well as answer-v1.md.
const NOTHING_SHOWN = '(the memory system showed nothing)';

function buildAnswerPrompt(template, { context, question }) {
  const text = String(context ?? '').trim() ? String(context) : NOTHING_SHOWN;
  return fillTemplate(template, { context: text, question: question.question });
}

module.exports = { DONT_KNOW, NOTHING_SHOWN, buildAnswerPrompt };
