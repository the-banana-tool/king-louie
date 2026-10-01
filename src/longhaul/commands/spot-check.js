'use strict';
// `longhaul spot-check --run <runId> --reviewer <initials>`
const fs = require('fs');
const { reviewSpotChecks, agreement, readSpotChecks } = require('../spot-check');
const { spotCheckFile } = require('../answer-stage');
const { RUN_ID_RE } = require('../run');
const { writeFileAtomic } = require('../files');
const { UsageError } = require('../errors');

module.exports = {
  options: { run: { type: 'string' }, reviewer: { type: 'string' } },
  async run(ctx, values) {
    if (!values.run || !values.reviewer) throw new UsageError('Usage: longhaul spot-check --run <runId> --reviewer <initials>');
    if (!RUN_ID_RE.test(values.run)) throw new UsageError(`--run takes a run id like 20260930T101500Z-1a2b, got ${JSON.stringify(values.run)}`);
    const file = spotCheckFile(ctx.home, values.run);
    if (!fs.existsSync(file)) throw new UsageError(`No spot-check sample for run ${values.run}; answer-stage runs write one.`);
    const counts = await reviewSpotChecks({
      rows: readSpotChecks(file), reviewer: values.reviewer, input: ctx.stdin, output: ctx.stdout,
      onSave: (rows) => writeFileAtomic(file, (write) => { for (const r of rows) write(`${JSON.stringify(r)}\n`); })
    });
    const a = agreement(readSpotChecks(file));
    ctx.stdout.write(`\n${counts.reviewed} reviewed, ${counts.skipped} skipped${counts.stopped ? ' (stopped)' : ''}. `
      + `Judge agreement: ${a.agreed}/${a.reviewed}${a.rate === null ? '' : ` (${a.rate.toFixed(3)})`} of ${a.sampled} sampled.\n`);
    return 0;
  }
};
