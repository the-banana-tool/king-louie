'use strict';
// `longhaul compaction-loss`: what each real compaction's summary kept, lost,
// and which lost facts the rest of the session needed (benchmark spec §9).
// A private session's text goes to a remote model only with --send-private,
// checked before any client is built. Prints counts, rates and cost only.
const path = require('path');
const { runCompactionStudy, assertMaySend, readManifest, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } = require('../compaction/study');
const { clientFor, positiveInt } = require('./run');
const { createFakeModels } = require('../fake-models');
const { formatEstimate, DEFAULT_MAX_USD } = require('../cost');
const { validateModelName, embedderFromEnv, createEmbedClient, localModelsDir } = require('../embeddings');
const { UsageError } = require('../errors');
const { fixed, usd } = require('../format');

const USAGE = [
  'Usage: longhaul compaction-loss --sessions <id,...> --author-provider <p> --author-model <m> --judge-provider <p> --judge-model <m>',
  '  [--author-base-url <url>] [--judge-base-url <url>] [--facts-per-window 10] [--candidates 8] [--seed 1]',
  '  [--embed-provider openai|local --embed-model <m>] [--concurrency 6] [--max-usd 50] [--allow-unpriced] [--dry-run] [--send-private] [--fake-models]'
].join('\n');

const ROLE_OPTIONS = ['author-provider', 'author-model', 'author-base-url', 'judge-provider', 'judge-model', 'judge-base-url'];

function maxUsdOf(raw) {
  if (raw === undefined) return DEFAULT_MAX_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--max-usd must be a positive number, got ${JSON.stringify(raw)}`);
  return n;
}

function concurrencyOf(raw) {
  if (raw === undefined) return DEFAULT_CONCURRENCY;
  const n = positiveInt(raw, 'concurrency');
  if (n > MAX_CONCURRENCY) throw new UsageError(`--concurrency must be from 1 to ${MAX_CONCURRENCY}, got ${JSON.stringify(raw)}`);
  return n;
}

module.exports = {
  options: {
    sessions: { type: 'string' },
    'author-provider': { type: 'string' },
    'author-model': { type: 'string' },
    'author-base-url': { type: 'string' },
    'judge-provider': { type: 'string' },
    'judge-model': { type: 'string' },
    'judge-base-url': { type: 'string' },
    'facts-per-window': { type: 'string' },
    candidates: { type: 'string' },
    seed: { type: 'string' },
    'embed-provider': { type: 'string' },
    'embed-model': { type: 'string' },
    concurrency: { type: 'string' },
    'max-usd': { type: 'string' },
    'allow-unpriced': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'send-private': { type: 'boolean' },
    'fake-models': { type: 'boolean' }
  },
  // deps (tests only): providerInstances { author, judge }, catalog, retry,
  // embedder (an embeddings provider instance), runner (an EmbedRunner the
  // caller owns), signals, exit, clock.
  async run(ctx, values, _positionals, deps = {}) {
    if (!values.sessions) throw new UsageError(USAGE);
    const sessionIds = [...new Set(values.sessions.split(',').map((s) => s.trim()).filter(Boolean))];
    const fake = values['fake-models'] === true;
    if (fake && ROLE_OPTIONS.some((k) => values[k] !== undefined)) throw new UsageError('--fake-models replaces the author and judge models; name no model with it.');
    if (!fake && !['author', 'judge'].every((r) => values[`${r}-provider`] && values[`${r}-model`])) throw new UsageError(USAGE);
    if (Boolean(values['embed-provider']) !== Boolean(values['embed-model'])) throw new UsageError('--embed-provider and --embed-model go together.');
    const embedNamed = values['embed-provider'] ? { provider: values['embed-provider'], model: validateModelName(values['embed-model']) } : null;
    const options = {
      factsPerWindow: values['facts-per-window'] ? positiveInt(values['facts-per-window'], 'facts-per-window') : 10,
      candidates: values.candidates ? positiveInt(values.candidates, 'candidates') : 8,
      seed: values.seed ? positiveInt(values.seed, 'seed') : 1,
      maxUsd: maxUsdOf(values['max-usd']),
      concurrency: concurrencyOf(values.concurrency),
      progress: (line) => ctx.stderr.write(line),
      allowUnpriced: values['allow-unpriced'] === true,
      dryRun: values['dry-run'] === true,
      sendPrivate: values['send-private'] === true,
      onPlan: ({ estimate, counts, maxUsd }) => {
        ctx.stdout.write(`plan: ${counts.facts} facts in ${counts.windows} windows\n`);
        ctx.stdout.write(formatEstimate(estimate, { maxUsd }));
      }
    };

    // Before any client exists: unknown sessions, then the private check.
    const manifests = sessionIds.map((id) => readManifest(ctx.home.root, id));
    const remote = [
      ...(fake ? [] : ['author', 'judge'].map((r) => `${values[`${r}-provider`]}/${values[`${r}-model`]}`)),
      ...(embedNamed && embedNamed.provider !== 'local' ? [`${embedNamed.provider}/${embedNamed.model}`] : [])
    ];
    const sent = assertMaySend({ manifests, remote, sendPrivate: options.sendPrivate, dryRun: options.dryRun });

    const models = fake ? createFakeModels() : null;
    const clients = {
      author: fake ? models.author : clientFor(ctx, values, 'author', deps),
      judge: fake ? models.judge : clientFor(ctx, values, 'judge', deps)
    };
    let runner = null;
    if (embedNamed) {
      const isLocal = embedNamed.provider === 'local';
      if (isLocal && !deps.embedder) runner = deps.runner || new (require('../../history/embed-runner').EmbedRunner)({ idleUnref: true });
      const embedder = embedderFromEnv({
        provider: embedNamed.provider, env: ctx.env, providerInstance: deps.embedder || null, runner, modelsDir: localModelsDir(ctx.home.private)
      });
      clients.embed = { ...createEmbedClient({ embedder, model: embedNamed.model, wait: deps.retry?.wait }), provider: embedNamed.provider, local: isLocal };
    }
    if (sent.length) ctx.stderr.write(`note: spans, summaries and later messages of private session(s) ${sent.join(', ')} are sent to ${[...new Set(remote)].sort().join(', ')} (--send-private).\n`);

    let result;
    try {
      result = await runCompactionStudy({
        home: ctx.home, sessionIds, clients, options,
        deps: { now: ctx.now, catalog: deps.catalog, retry: deps.retry, signals: deps.signals, exit: deps.exit, clock: deps.clock }
      });
    } finally {
      if (runner && !deps.runner) await runner.stop();
    }
    if (result.dryRun) {
      ctx.stdout.write('dry run: no model was called and no run was written.\n');
      return 0;
    }
    ctx.stdout.write(`run ${result.runId} -> ${result.dir}\n`);
    for (const s of result.config.skipped) ctx.stdout.write(`skipped ${s.sessionId}${s.summarySeq ? ` #${s.summarySeq}` : ''}: ${s.reason}\n`);
    const f = (x) => fixed(x, 3, '-');
    for (const [id, s] of [...Object.entries(result.summary.sessions), ['all', result.summary.all]]) {
      ctx.stdout.write(`${id}: ${s.windows} windows, ${s.facts} facts (${s.judged} judged, ${s.rejected} rejected, ${s.errors} errors)  `
        + `preserved ${f(s.preservedRate)}  partial ${f(s.partialRate)}  lost ${f(s.lostRate)}  needed ${f(s.neededRate)}  `
        + `lost and needed ${f(s.lostAndNeededRate)}  median ratio ${fixed(s.ratio.median, 1, '-')}\n`);
    }
    const sp = result.spend;
    ctx.stdout.write(`spent ${usd(sp.spentUsd)} on ${sp.calls} calls (${sp.unpricedCalls} unpriced); estimate ${usd(sp.estimateUsd, 'unknown')}\n`);
    if (result.spotChecks.n) ctx.stdout.write(`spot-check sample: ${result.spotChecks.n} facts; review them with longhaul spot-check --run ${result.runId} --reviewer <initials>\n`);
    ctx.stdout.write(`summary: ${path.join(result.dir, 'summary.md')}\n`);
    if (sp.overBudget) {
      ctx.stderr.write(`STOPPED AT THE CAP ($${options.maxUsd}): the remaining facts are recorded as over-budget errors. Run again to finish; cached calls cost nothing.\n`);
      return 1;
    }
    return 0;
  }
};
