'use strict';
// `longhaul spot-check --run <runId> --reviewer <initials>`
const fs = require('fs');
const { reviewSpotChecks, agreement, compactionAgreement, readSpotChecks, isCompaction } = require('../spot-check');
const { spotCheckFile } = require('../answer-stage');
const { RUN_ID_RE } = require('../run');
const { loadSession, sessionDir, messageText } = require('../session-format');
const { writeFileAtomic } = require('../files');
const { UsageError } = require('../errors');

// A compaction row's evidence message and summary, read from the session
// (terminal only); a session that is gone shows them as not available.
function sessionTexts(home) {
  const sessions = new Map();
  return async (row) => {
    if (!sessions.has(row.sessionId)) {
      sessions.set(row.sessionId, await loadSession(sessionDir(home.root, row.sessionId)).catch(() => null));
    }
    const session = sessions.get(row.sessionId);
    const text = (seq) => {
      const m = session?.index.get(seq);
      return m ? messageText(m) : null;
    };
    return { evidence: text(row.evidenceSeq), summary: text(row.summarySeq) };
  };
}

module.exports = {
  options: { run: { type: 'string' }, reviewer: { type: 'string' } },
  async run(ctx, values) {
    if (!values.run || !values.reviewer) throw new UsageError('Usage: longhaul spot-check --run <runId> --reviewer <initials>');
    if (!RUN_ID_RE.test(values.run)) throw new UsageError(`--run takes a run id like 20260930T101500Z-1a2b, got ${JSON.stringify(values.run)}`);
    const file = spotCheckFile(ctx.home, values.run);
    if (!fs.existsSync(file)) throw new UsageError(`No spot-check sample for run ${values.run}; answer-stage and compaction-loss runs write one.`);
    const counts = await reviewSpotChecks({
      rows: readSpotChecks(file), reviewer: values.reviewer, input: ctx.stdin, output: ctx.stdout, textOf: sessionTexts(ctx.home),
      onSave: (rows) => writeFileAtomic(file, (write) => { for (const r of rows) write(`${JSON.stringify(r)}\n`); })
    });
    const rows = readSpotChecks(file);
    const a = agreement(rows);
    ctx.stdout.write(`\n${counts.reviewed} reviewed, ${counts.skipped} skipped${counts.stopped ? ' (stopped)' : ''}. `
      + `Judge agreement: ${a.agreed}/${a.reviewed}${a.rate === null ? '' : ` (${a.rate.toFixed(3)})`} of ${a.sampled} sampled.\n`);
    if (rows.some(isCompaction)) {
      const c = compactionAgreement(rows);
      ctx.stdout.write(`Summary judge ${c.preservedAgreed}/${c.reviewed}, needed judge ${c.neededAgreed}/${c.reviewed}.\n`);
    }
    return 0;
  }
};
