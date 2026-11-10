'use strict';
// Human spot-checks of the judge (benchmark spec §8 step 4). An answer-stage
// run writes a seeded tenth of its judgments to
// LONGHAUL_HOME/private/spot-checks/<runId>.jsonl (they quote questions and
// replies). `longhaul spot-check` shows each one (question, references,
// reply, the judge's verdict and reason) and records the reviewer's own
// verdict, saving after each. The report shows the agreement rate, numbers
// only. A compaction-loss run's sample (spec §9) holds a fact with both of
// its judgments (summary kept it, a later message needed it); the reviewer
// agrees with both or gives both of their own.
const readline = require('readline');
const { VERDICTS } = require('./judge');
const { UsageError } = require('./errors');
const { readJsonl } = require('./files');

const REVIEWER_RE = /^[A-Za-z0-9._-]{1,32}$/;
const KEYS = Object.freeze({ c: 'correct', p: 'partial', i: 'incorrect', a: 'abstained' });
const COMPACTION_KIND = 'compaction-loss';
const PRESERVED_KEYS = Object.freeze({ p: 'preserved', r: 'partial', l: 'lost' });
const NEEDED_KEYS = Object.freeze({ n: 'needed', u: 'not-needed' });
const PRESERVED = Object.values(PRESERVED_KEYS);
const NEEDED = Object.values(NEEDED_KEYS);

const isCompaction = (r) => r.kind === COMPACTION_KIND;
const isReviewed = (r) => (isCompaction(r)
  ? PRESERVED.includes(r.humanPreserved) && NEEDED.includes(r.humanNeeded)
  : VERDICTS.includes(r.humanVerdict));

// The reviewed text (question, references, reply, reason) is shown as it is,
// whatever its characters; the ASCII rule covers the CLI's own text.
function describeRow(r, position, total) {
  const lines = ['', `[${position}/${total}] ${r.adapter} - ${r.kind} - ${r.questionId}`, `Q: ${r.question}`, `Reference: ${r.reference}`];
  if (r.acceptableAnswers?.length) lines.push(`Also accept: ${r.acceptableAnswers.join(' | ')}`);
  lines.push('Reply:', r.reply, `Judge: ${r.verdict}${r.reason ? ` - ${r.reason}` : ''}`);
  return `${lines.join('\n')}\n`;
}

function describeCompactionRow(r, position, total, { evidence, summary }) {
  const shown = (text) => (typeof text === 'string' ? text : '(not available)');
  const n = r.needed || {};
  const neededLine = `Needed judge: ${n.verdict}${n.noCandidates ? ' (no later message matched)' : ''}${n.seqs?.length ? ` (#${n.seqs.join(', #')})` : ''}`
    + `${n.reason ? ` - ${n.reason}` : ''}`;
  return `${['', `[${position}/${total}] ${r.adapter} - ${r.factKind} - ${r.factId}`, `Fact: ${r.fact}`, `Quote: ${r.quote}`,
    `Evidence #${r.evidenceSeq}:`, shown(evidence), `Summary #${r.summarySeq}:`, shown(summary),
    `Summary judge: ${r.preserved?.verdict}${r.preserved?.reason ? ` - ${r.preserved.reason}` : ''}`, neededLine].join('\n')}\n`;
}

// y takes both judgments as the reviewer's own; two letters give the
// reviewer's own (summary, then later need). Null for anything else.
function compactionAnswer(cmd, r) {
  if (cmd === 'y') return { humanPreserved: r.preserved?.verdict, humanNeeded: r.needed?.verdict };
  if (cmd?.length !== 2 || !PRESERVED_KEYS[cmd[0]] || !NEEDED_KEYS[cmd[1]]) return null;
  return { humanPreserved: PRESERVED_KEYS[cmd[0]], humanNeeded: NEEDED_KEYS[cmd[1]] };
}

async function reviewSpotChecks({ rows, reviewer, input, output, onSave, textOf = null }) {
  if (!REVIEWER_RE.test(reviewer || '')) throw new UsageError('--reviewer <initials> is required (letters, digits, . _ -)');
  const rl = readline.createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : value.trim();
  };
  const current = rows.map((r) => ({ ...r }));
  const pending = current.map((r, i) => i).filter((i) => !isReviewed(current[i]));
  const counts = { reviewed: 0, skipped: 0, stopped: false };
  try {
    for (let n = 0; n < pending.length; n++) {
      const i = pending[n];
      if (isCompaction(current[i])) {
        const r = current[i];
        output.write(describeCompactionRow(r, n + 1, pending.length, textOf ? await textOf(r) : {}));
        for (;;) {
          const cmd = await ask(`The judges said ${r.preserved?.verdict} and ${r.needed?.verdict}. [y] agree with both, or your own two: `
            + 'summary [p]reserved [r] partial [l]ost, then later [n]eeded [u]nneeded (like lu)  [s]kip  [q]uit > ');
          if (cmd === null || cmd === 'q') {
            counts.stopped = true;
            return counts;
          }
          if (cmd === 's') {
            counts.skipped += 1;
            break;
          }
          const own = compactionAnswer(cmd, r);
          if (own) {
            current[i] = { ...r, ...own, reviewer: `human:${reviewer}` };
            onSave(current);
            counts.reviewed += 1;
            break;
          }
          output.write('Type y, two letters (p, r or l, then n or u), s or q.\n');
        }
        continue;
      }
      output.write(describeRow(current[i], n + 1, pending.length));
      for (;;) {
        const cmd = await ask(`The judge said ${current[i].verdict}. [y] agree, or your own verdict: [c]orrect [p]artial [i]ncorrect [a]bstained  [s]kip  [q]uit > `);
        if (cmd === null || cmd === 'q') {
          counts.stopped = true;
          return counts;
        }
        if (cmd === 's') {
          counts.skipped += 1;
          break;
        }
        // y records the judge's verdict as the reviewer's own.
        const verdict = cmd === 'y' ? current[i].verdict : KEYS[cmd];
        if (verdict) {
          current[i] = { ...current[i], humanVerdict: verdict, reviewer: `human:${reviewer}` };
          onSave(current);
          counts.reviewed += 1;
          break;
        }
        output.write('Type y, c, p, i, a, s or q.\n');
      }
    }
    return counts;
  } finally {
    rl.close();
  }
}

const preservedAgrees = (r) => r.humanPreserved === r.preserved?.verdict;
const neededAgrees = (r) => r.humanNeeded === r.needed?.verdict;
const agrees = (r) => (isCompaction(r) ? preservedAgrees(r) && neededAgrees(r) : r.humanVerdict === r.verdict);

function agreement(rows) {
  const reviewed = rows.filter(isReviewed);
  const agreed = reviewed.filter(agrees).length;
  return { sampled: rows.length, reviewed: reviewed.length, agreed, rate: reviewed.length ? agreed / reviewed.length : null };
}

// agreement() of a compaction-loss sample, with each judge's agreement apart.
function compactionAgreement(rows) {
  const reviewed = rows.filter((r) => isCompaction(r) && isReviewed(r));
  return { ...agreement(rows), preservedAgreed: reviewed.filter(preservedAgrees).length, neededAgreed: reviewed.filter(neededAgrees).length };
}

const readSpotChecks = (file) => readJsonl(file);

module.exports = { reviewSpotChecks, agreement, compactionAgreement, readSpotChecks, isCompaction };
