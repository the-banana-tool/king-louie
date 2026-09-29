'use strict';
// `longhaul synth --out <dir>`: write the synthetic fixture sessions and
// their questions in the data-root layout (sessions/, questions/). The
// committed copy lives in tests/fixtures/longhaul.
const path = require('path');
const { writeSyntheticRoot } = require('../synthetic');
const { UsageError } = require('../errors');

module.exports = {
  needsHome: false,
  options: { out: { type: 'string' } },
  async run(ctx, values) {
    if (!values.out) throw new UsageError('Usage: longhaul synth --out <dir>');
    const out = path.resolve(ctx.cwd, values.out);
    for (const s of writeSyntheticRoot(out)) {
      ctx.stdout.write(`${s.sessionId}: ${s.messages} messages, ~${s.estTokens} estimated tokens, ${s.questions} questions\n`);
    }
    return 0;
  }
};
