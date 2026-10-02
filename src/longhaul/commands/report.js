'use strict';
// `longhaul report --runs <runId>[,<runId>...] [--id <name>] [--public]`
const { writeReport } = require('../report');
const { UsageError } = require('../errors');

module.exports = {
  options: { runs: { type: 'string' }, id: { type: 'string' }, public: { type: 'boolean', default: false } },
  async run(ctx, values) {
    if (!values.runs) throw new UsageError('Usage: longhaul report --runs <runId>[,<runId>...] [--id <name>] [--public]');
    const runIds = values.runs.split(',').map((s) => s.trim()).filter(Boolean);
    const out = writeReport(ctx.home, runIds, { id: values.id ?? null, publicOnly: values.public });
    ctx.stdout.write(`report ${out.id} -> ${out.dir}\n`);
    for (const f of out.files) ctx.stdout.write(`  ${f}\n`);
    return 0;
  }
};
