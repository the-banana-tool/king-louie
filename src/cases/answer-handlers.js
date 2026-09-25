// src/cases/answer-handlers.js
// The typed answer handlers stage 2 registers (spec §3.9). Required by
// case-runtime.js for its side effect; `commit-failed` uses the default fact.
const path = require('path');
const { QuestionStore } = require('./questions');
const { PER_DAY } = require('./budget');
const { isRealCalendarDate } = require('./clock');
const { createLogger } = require('../logging');

const log = createLogger('cases/answer-handlers');

// A grant reply must be essentially just the amount (controller ruling I5 on
// Task 11 review): a money category matches "$25", "25", "25 usd" or
// "25 dollars"; a per-day category a bare integer; a deadline a real
// calendar date. Anything else is recorded as a reply, not a grant.
const MONEY_RE = /^\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:usd|dollars?)?\s*$/i;
const INT_RE = /^\s*(\d+)\s*$/;
const NO_LIMIT_NOTE = 'Reply with just the amount, for example 25.';

function optionOrText(record, answer) {
  const option = answer.optionId ? (record.options || []).find((o) => o.id === answer.optionId) : null;
  return option ? option.label : answer.text;
}

QuestionStore.registerAnswerHandler('direction', {
  toFact: (record, answer) => {
    const value = optionOrText(record, answer);
    const attr = path.basename(String(record.payload?.failure || 'failure'), '.md');
    return { stmt: `Owner's direction after ${attr}: ${value}`, subject: 'direction', attr, value };
  },
  onAnswered: (record, fact, { runtime, caseId }) => runtime.applyOwnerFact(caseId, fact, { questionId: record.id })
});

QuestionStore.registerAnswerHandler('budget-grant', {
  // Only the reply's format decides whether it names an amount at all;
  // whether that amount actually raises the limit is checked against the
  // budget's CURRENT numbers in CaseRuntime.applyOwnerFact, never against
  // numbers this record captured when the question was asked (I3).
  toFact: (record, answer) => {
    const category = String(record.payload?.budget || 'usd');
    const text = String(optionOrText(record, answer) ?? '').trim();
    let value = null;
    if (category === 'deadline') {
      value = isRealCalendarDate(text) ? text : null;
    } else if (PER_DAY.includes(category)) {
      const m = text.match(INT_RE);
      value = m ? Number(m[1]) : null;
    } else {
      const m = text.match(MONEY_RE);
      value = m ? Number(m[1]) : null;
    }
    if (value !== null) {
      return { stmt: `Owner set the ${category} budget to ${value} (answer to ${record.id}).`, subject: 'budget', attr: category, value };
    }
    return { stmt: `Owner replied to the ${category} budget question ${record.id}: ${text}`, subject: 'budget', attr: `${category}-reply`, value: text };
  },
  onAnswered: (record, fact, { runtime, caseId }) => {
    const category = String(record.payload?.budget || 'usd');
    if (!fact || fact.attr !== category) {
      runtime.records(caseId).writeJournal(
        'question',
        `${record.id}: the reply had no usable ${category} limit, so the case stays paused. Answer with a number, or use the Grant button.`,
        runtime.now()
      );
      try {
        runtime.questions(caseId).note(record.id, NO_LIMIT_NOTE);
      } catch (err) {
        log.warn(`Could not note the unusable reply on ${record.id}: ${err.message}`);
      }
      try {
        runtime.askBudgetGrant(caseId, category);
      } catch (err) {
        log.warn(`Could not raise a fresh ${category} grant question after ${record.id}: ${err.message}`);
      }
      return { applied: false, reason: 'no-limit' };
    }
    return runtime.applyOwnerFact(caseId, fact);
  }
});
