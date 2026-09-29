'use strict';
// `longhaul author --session <id> --provider <p> --model <m> [--base-url <url>] [--count 60] [--seed 1] [--send-private]`
// A private session's spans go to the model provider only with
// --send-private (owner decision 2026-09-29); without it the command refuses
// before it builds a model client, so nothing leaves the machine.
const fs = require('fs');
const path = require('path');
const { loadSession, sessionDir, validateSessionId } = require('../session-format');
const { readQuestions, writeQuestions, questionsFile, authorLogFile } = require('../questions');
const { planAuthoring } = require('../sampling');
const { authorCandidates, DEFAULT_PROMPT } = require('../author');
const { createModelClient } = require('../model');
const { positiveInt } = require('./run');
const { UsageError } = require('../errors');

const USAGE = 'Usage: longhaul author --session <id> --provider <provider> --model <model> [--base-url <url>] [--count 60] [--seed 1] [--send-private]';

module.exports = {
  options: {
    session: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    count: { type: 'string' },
    seed: { type: 'string' },
    'send-private': { type: 'boolean' }
  },
  async run(ctx, values) {
    if (!values.session || !values.provider || !values.model) throw new UsageError(USAGE);
    validateSessionId(values.session);
    const count = values.count ? positiveInt(values.count, 'count') : 60;
    const seed = values.seed ? positiveInt(values.seed, 'seed') : 1;
    const dir = sessionDir(ctx.home.root, values.session);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new UsageError(`No session "${values.session}"; import it first.`);

    const session = await loadSession(dir);
    if (session.manifest.private && values['send-private'] !== true) {
      throw new UsageError(
        `Session ${values.session} is private: authoring would send spans of it to ${values.provider} (${values.model}). `
        + 'Pass --send-private to allow that.',
        'PRIVATE_SESSION'
      );
    }
    const client = createModelClient({
      provider: values.provider, model: values.model, env: ctx.env,
      options: values['base-url'] ? { baseUrl: values['base-url'] } : {}
    });
    if (session.manifest.private) {
      ctx.stderr.write(`note: spans of private session ${values.session} are sent to ${values.provider} (${values.model}) to author questions (--send-private).\n`);
    }

    const file = questionsFile(ctx.home.root, values.session);
    const existing = await readQuestions(file);
    const plan = planAuthoring(session.index, { count, seed, excludeSeqs: existing.flatMap((q) => q.evidenceSeqs || []) });
    const out = await authorCandidates({ session, plan, client, sessionId: values.session, existing });
    writeQuestions(file, [...existing, ...out.candidates]);

    const rejected = {};
    for (const r of out.rejected) rejected[r.reason] = (rejected[r.reason] || 0) + 1;
    const logLine = {
      at: ctx.now().toISOString(), prompt: path.basename(DEFAULT_PROMPT), promptSha256: out.promptSha256,
      provider: client.provider, model: client.model, seed, count,
      planned: plan.items.length, shortfall: plan.shortfall.length, written: out.candidates.length, rejected
    };
    fs.appendFileSync(authorLogFile(ctx.home.root, values.session), `${JSON.stringify(logLine)}\n`);

    ctx.stdout.write(`authored ${out.candidates.length} candidates for ${values.session}: ${plan.items.length} planned, `
      + `${plan.shortfall.length} short of the target, ${out.rejected.length} rejected\n`);
    for (const [reason, n] of Object.entries(rejected)) ctx.stdout.write(`  rejected ${reason}: ${n}\n`);
    ctx.stdout.write(`next: longhaul verify --session ${values.session} --reviewer <initials>\n`);
    return 0;
  }
};
