'use strict';
// `longhaul verify --session <id> --reviewer <initials>`
const fs = require('fs');
const path = require('path');
const { loadSession, sessionDir, validateSessionId } = require('../session-format');
const { KINDS, isVerified, readQuestions, writeQuestions, questionsFile, rejectedFile: rejectedPath } = require('../questions');
const { verifyLoop } = require('../verify');
const { UsageError } = require('../errors');

module.exports = {
  options: { session: { type: 'string' }, reviewer: { type: 'string' } },
  async run(ctx, values) {
    if (!values.session || !values.reviewer) throw new UsageError('Usage: longhaul verify --session <id> --reviewer <initials>');
    validateSessionId(values.session);
    const dir = sessionDir(ctx.home.root, values.session);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new UsageError(`No session "${values.session}"; import it first.`);
    const session = await loadSession(dir);
    const file = questionsFile(ctx.home.root, values.session);
    const rejectedFile = rejectedPath(ctx.home.root, values.session);
    const questions = await readQuestions(file);
    if (!questions.some((q) => q.verifiedBy === null)) {
      ctx.stdout.write(`Nothing to verify for ${values.session}.\n`);
      return 0;
    }
    const counts = await verifyLoop({
      session, questions, reviewer: values.reviewer, input: ctx.stdin, output: ctx.stdout, now: ctx.now,
      onSave(current, rejected) {
        writeQuestions(file, current);
        if (rejected) fs.appendFileSync(rejectedFile, `${JSON.stringify(rejected)}\n`);
      }
    });
    const final = await readQuestions(file);
    const verified = final.filter(isVerified);
    const byKind = KINDS.map((k) => `${k} ${verified.filter((q) => q.kind === k).length}`).join(', ');
    ctx.stdout.write(`\n${counts.accepted} accepted, ${counts.edited} edited, ${counts.rejected} rejected, ${counts.skipped} skipped${counts.stopped ? ' (stopped)' : ''}.\n`);
    ctx.stdout.write(`verified for ${values.session}: ${verified.length} (${byKind}); ${final.length - verified.length} still unverified.\n`);
    return 0;
  }
};
