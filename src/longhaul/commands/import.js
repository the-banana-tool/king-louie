'use strict';
// `longhaul import <session.jsonl|chat.json> [--id <id>] [--public --license <spdx>] [--force]`
const path = require('path');
const { importSession } = require('../importing');
const { UsageError } = require('../errors');

module.exports = {
  options: {
    id: { type: 'string' },
    license: { type: 'string' },
    public: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false }
  },
  async run(ctx, values, positionals) {
    if (positionals.length !== 1) {
      throw new UsageError('Usage: longhaul import <session.jsonl|chat.json> [--id <id>] [--public --license <spdx>] [--force]');
    }
    const out = await importSession(ctx.home, path.resolve(ctx.cwd, positionals[0]), {
      id: values.id, license: values.license, publicSession: values.public, force: values.force
    });
    const m = out.manifest;
    if (out.status === 'unchanged') {
      ctx.stdout.write(`${m.sessionId}: already imported from this file; nothing to do.\n`);
      return 0;
    }
    ctx.stdout.write(`imported ${m.sessionId}: ${m.messages} messages, ${m.humanMessages} from the user, ${m.toolCalls} tool calls, `
      + `${m.compactions.length} compactions, ~${m.estTokens} estimated tokens (${m.private ? 'private' : m.license})\n`);
    if (m.unmapped || m.badLines) {
      ctx.stdout.write(`note: ${m.unmapped} unmapped records kept as status messages, ${m.badLines} unreadable lines skipped\n`);
    }
    return 0;
  }
};
