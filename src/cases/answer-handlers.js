// src/cases/answer-handlers.js
// The typed answer handlers stage 2 registers (spec §3.9). Required by
// case-runtime.js for its side effect; `commit-failed` uses the default fact.
const path = require('path');
const { QuestionStore } = require('./questions');

const DAY = /\d{4}-\d{2}-\d{2}/;

function optionOrText(record, answer) {
  const option = answer.optionId ? (record.options || []).find((o) => o.id === answer.optionId) : null;
  return option ? option.label : answer.text;
}

// "1,500.50 dollars" -> 1500.5; null when the text holds no number.
function firstNumber(text) {
  const m = String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
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
  toFact: (record, answer) => {
    const category = String(record.payload?.budget || 'usd');
    const text = String(optionOrText(record, answer) ?? '');
    let value = null;
    if (category === 'deadline') {
      const m = text.match(DAY);
      if (m && m[0] > String(record.payload?.limit || '')) value = m[0];
    } else {
      const n = firstNumber(text);
      if (n !== null && n > Number(record.payload?.spent || 0)) value = n;
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
      return { applied: false, reason: 'no-limit' };
    }
    return runtime.applyOwnerFact(caseId, fact);
  }
});

module.exports = { firstNumber };
