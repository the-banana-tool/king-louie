'use strict';
// Human spot-checks of the judge (benchmark spec §8 step 4). An answer-stage
// run writes a seeded tenth of its judgments to
// LONGHAUL_HOME/private/spot-checks/<runId>.jsonl (they quote questions and
// replies). `longhaul spot-check` shows each one (question, references,
// reply, the judge's verdict and reason) and records the reviewer's own
// verdict, saving after each. The report shows the agreement rate, numbers
// only.
const fs = require('fs');
const readline = require('readline');
const { VERDICTS } = require('./judge');
const { UsageError } = require('./errors');

const REVIEWER_RE = /^[A-Za-z0-9._-]{1,32}$/;
const KEYS = Object.freeze({ c: 'correct', p: 'partial', i: 'incorrect', a: 'abstained' });

function describeRow(r, position, total) {
  const lines = ['', `[${position}/${total}] ${r.adapter} - ${r.kind} - ${r.questionId}`, `Q: ${r.question}`, `Reference: ${r.reference}`];
  if (r.acceptableAnswers?.length) lines.push(`Also accept: ${r.acceptableAnswers.join(' | ')}`);
  lines.push('Reply:', r.reply, `Judge: ${r.verdict}${r.reason ? ` - ${r.reason}` : ''}`);
  return `${lines.join('\n')}\n`;
}

async function reviewSpotChecks({ rows, reviewer, input, output, onSave }) {
  if (!REVIEWER_RE.test(reviewer || '')) throw new UsageError('--reviewer <initials> is required (letters, digits, . _ -)');
  const rl = readline.createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : value.trim();
  };
  const current = rows.map((r) => ({ ...r }));
  const pending = current.map((r, i) => i).filter((i) => !VERDICTS.includes(current[i].humanVerdict));
  const counts = { reviewed: 0, skipped: 0, stopped: false };
  try {
    for (let n = 0; n < pending.length; n++) {
      const i = pending[n];
      output.write(describeRow(current[i], n + 1, pending.length));
      for (;;) {
        const cmd = await ask('Your verdict: [c]orrect [p]artial [i]ncorrect [a]bstained  [s]kip  [q]uit > ');
        if (cmd === null || cmd === 'q') {
          counts.stopped = true;
          return counts;
        }
        if (cmd === 's') {
          counts.skipped += 1;
          break;
        }
        if (KEYS[cmd]) {
          current[i] = { ...current[i], humanVerdict: KEYS[cmd], reviewer: `human:${reviewer}` };
          onSave(current);
          counts.reviewed += 1;
          break;
        }
        output.write('Type c, p, i, a, s or q.\n');
      }
    }
    return counts;
  } finally {
    rl.close();
  }
}

function agreement(rows) {
  const reviewed = rows.filter((r) => VERDICTS.includes(r.humanVerdict));
  const agreed = reviewed.filter((r) => r.humanVerdict === r.verdict).length;
  return { sampled: rows.length, reviewed: reviewed.length, agreed, rate: reviewed.length ? agreed / reviewed.length : null };
}

function readSpotChecks(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

module.exports = { reviewSpotChecks, agreement, readSpotChecks };
