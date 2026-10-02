'use strict';
// `longhaul verify --session <id> --reviewer <initials> [--web [--port <n>] [--no-open]]`
const fs = require('fs');
const path = require('path');
const { loadSession, sessionDir, validateSessionId } = require('../session-format');
const { KINDS, isVerified, readQuestions, writeQuestions, questionsFile, rejectedFile: rejectedPath } = require('../questions');
const { verifyLoop } = require('../verify');
const { checkReviewer } = require('../review');
const { UsageError } = require('../errors');

const USAGE = 'Usage: longhaul verify --session <id> --reviewer <initials> [--web [--port <n>] [--no-open]]';

function parsePort(raw) {
  if (raw === undefined) return 0;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) throw new UsageError('--port must be a whole number from 0 to 65535');
  return Number(raw);
}

// The web reviewer runs until the page's Quit button or Ctrl-C.
async function runWeb(ctx, values, review) {
  const { startVerifyWeb, openBrowser } = require('../verify-web');
  const web = await startVerifyWeb({ ...review, port: parsePort(values.port) });
  const onSigint = () => { web.stop(); };
  process.once('SIGINT', onSigint);
  try {
    ctx.stdout.write(`Review at ${web.url}\n`);
    ctx.stdout.write('Keep this terminal open; Quit on the page or Ctrl-C ends the review.\n');
    if (!values['no-open']) openBrowser(web.url);
    return await web.done;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

module.exports = {
  options: {
    session: { type: 'string' },
    reviewer: { type: 'string' },
    web: { type: 'boolean' },
    port: { type: 'string' },
    'no-open': { type: 'boolean' }
  },
  async run(ctx, values) {
    if (!values.session || !values.reviewer) throw new UsageError(USAGE);
    if (!values.web && (values.port !== undefined || values['no-open'])) throw new UsageError(`--port and --no-open go with --web.\n${USAGE}`);
    validateSessionId(values.session);
    checkReviewer(values.reviewer);
    if (values.web) parsePort(values.port);
    const dir = sessionDir(ctx.home.root, values.session);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new UsageError(`No session "${values.session}"; import it first.`);
    const session = await loadSession(dir);
    const file = questionsFile(ctx.home.root, values.session);
    const rejectedFile = rejectedPath(ctx.home.root, values.session);
    const questions = await readQuestions(file);
    if (!questions.some((q) => q.verifiedBy == null)) {
      ctx.stdout.write(`Nothing to verify for ${values.session}.\n`);
      return 0;
    }
    const review = {
      session, questions, reviewer: values.reviewer, now: ctx.now,
      onSave(current, rejected) {
        writeQuestions(file, current);
        if (rejected) fs.appendFileSync(rejectedFile, `${JSON.stringify(rejected)}\n`);
      }
    };
    const counts = values.web
      ? await runWeb(ctx, values, review)
      : await verifyLoop({ ...review, input: ctx.stdin, output: ctx.stdout });
    const final = await readQuestions(file);
    const verified = final.filter(isVerified);
    const byKind = KINDS.map((k) => `${k} ${verified.filter((q) => q.kind === k).length}`).join(', ');
    ctx.stdout.write(`\n${counts.accepted} accepted, ${counts.edited} edited, ${counts.rejected} rejected, ${counts.skipped} skipped${counts.stopped ? ' (stopped)' : ''}.\n`);
    ctx.stdout.write(`verified for ${values.session}: ${verified.length} (${byKind}); ${final.length - verified.length} still unverified.\n`);
    return 0;
  }
};
