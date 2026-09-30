'use strict';
// `longhaul embed --session <id> --provider openai --model <m> [--batch 100]
//   [--base-url <url>] [--max-usd 1] [--send-private]`
// Embeds every chunk of a session (chunked exactly as kl-recall's store
// chunks it) and every question of its question set into the cache under
// LONGHAUL_HOME/private/embeddings/ (embeddings.js). Resumable: cached chunks
// and questions are skipped. A private session goes to the provider only with
// --send-private; without it the command refuses before any network call.
// Prints counts, tokens and cost only, never chunk or question text.
const fs = require('fs');
const path = require('path');
const { loadSession, sessionDir, validateSessionId } = require('../session-format');
const { readQuestions, questionsFile } = require('../questions');
const { createKlRecallAdapter } = require('../adapters/kl-recall');
const {
  EmbeddingCache, cacheDir, validateModelName, embedText, createEmbedClient, embedChunks, embedderFromEnv, priceTokens
} = require('../embeddings');
const { positiveInt } = require('./run');
const { removeStaleTmp } = require('../run');
const { UsageError } = require('../errors');

const USAGE = 'Usage: longhaul embed --session <id> --provider openai --model <model> [--batch 100] [--base-url <url>] [--max-usd 1] [--send-private]';
// Rough tokens for the estimate before any call: 3 characters a token errs
// high for prose and about right for code and JSON.
const EST_CHARS_PER_TOKEN = 3;

// The temp store's dir under LONGHAUL_HOME/tmp. It starts with kl-, so
// `run`'s startup cleanup removes one an interrupted embed left; embed itself
// removes stale kl-embed-* dirs at start (not a run's kl-* stores).
const TMP_PREFIX = 'kl-embed-';

const usd = (x) => `$${x.toFixed(4)}`;

module.exports = {
  options: {
    session: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    batch: { type: 'string' },
    'base-url': { type: 'string' },
    'max-usd': { type: 'string' },
    'send-private': { type: 'boolean' }
  },
  // deps (tests): providerInstance, catalog, wait.
  async run(ctx, values, _positionals, deps = {}) {
    if (!values.session || !values.provider || !values.model) throw new UsageError(USAGE);
    validateSessionId(values.session);
    const model = validateModelName(values.model);
    const batch = values.batch ? positiveInt(values.batch, 'batch') : 100;
    if (batch > 2048) throw new UsageError('--batch must be at most 2048 (the provider\'s per-request input limit).');
    const maxUsd = values['max-usd'] !== undefined ? Number(values['max-usd']) : 1;
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new UsageError(`--max-usd must be a positive number, got ${JSON.stringify(values['max-usd'])}`);
    const dir = sessionDir(ctx.home.root, values.session);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new UsageError(`No session "${values.session}"; import it first.`);

    const session = await loadSession(dir);
    if (session.manifest.private && values['send-private'] !== true) {
      throw new UsageError(
        `Session ${values.session} is private: embedding would send every chunk of it and its questions to ${values.provider} (${model}). `
        + 'Pass --send-private to allow that.',
        'PRIVATE_SESSION'
      );
    }
    const embedder = embedderFromEnv({ provider: values.provider, env: ctx.env, baseUrl: values['base-url'] || null, providerInstance: deps.providerInstance });
    const client = createEmbedClient({ embedder, model, wait: deps.wait });

    // The session's chunks as kl-recall's store makes them, in a temp store
    // under LONGHAUL_HOME/tmp (the session's text never leaves the home).
    removeStaleTmp(ctx.home.tmp, TMP_PREFIX);
    const tmpRoot = path.join(ctx.home.tmp, `${TMP_PREFIX}${process.pid}`);
    let base = null;
    let handle = null;
    try {
      fs.mkdirSync(tmpRoot, { recursive: true });
      base = createKlRecallAdapter({ tmpRoot });
      handle = await base.prepare(session);
      const chunks = handle.store.chunksOfChat(handle.chatId);
      const chunkSettings = handle.settings.history.chunk;
      const qFile = questionsFile(ctx.home.root, values.session);
      const questions = fs.existsSync(qFile) ? await readQuestions(qFile) : [];

      const cache = EmbeddingCache.open(cacheDir(ctx.home.private, values.session, model));
      cache.init({ model, provider: values.provider, dim: null, chunk: chunkSettings, sessionId: values.session });
      cache.setMeta({ chunksTotal: chunks.length });

      const todo = chunks.filter((c) => !cache.has(c.messageId, c.idx));
      const qTodo = questions.filter((q) => !cache.question(q.id, q.question));
      const estChars = todo.reduce((n, c) => n + embedText(c.text).text.length, 0) + qTodo.reduce((n, q) => n + String(q.question).length, 0);
      const estTokens = Math.ceil(estChars / EST_CHARS_PER_TOKEN);
      const estUsd = priceTokens(values.provider, model, estTokens, deps.catalog);
      ctx.stdout.write(`${values.session}: ${chunks.length} chunks (${chunks.length - todo.length} cached, ${todo.length} to embed), `
        + `${questions.length} questions (${qTodo.length} to embed); estimate ~${estTokens} tokens, `
        + `${estUsd === null ? 'price unknown' : `~${usd(estUsd)}`}\n`);
      if (estUsd !== null && estUsd > maxUsd) {
        throw new UsageError(`The estimate ${usd(estUsd)} is over --max-usd ${maxUsd}; nothing was sent.`, 'OVER_BUDGET');
      }
      if (session.manifest.private && (todo.length || qTodo.length)) {
        ctx.stderr.write(`note: chunks and questions of private session ${values.session} are sent to ${values.provider} (${model}) to embed them (--send-private).\n`);
      }

      let lastPrinted = 0;
      const out = await embedChunks({
        cache, client, chunks, batch,
        progress(done, total) {
          if (done === total || done - lastPrinted >= 1000) {
            lastPrinted = done;
            ctx.stdout.write(`  embedded ${done}/${total} chunks\n`);
          }
        }
      });

      let qTokens = 0;
      for (let i = 0; i < qTodo.length; i += batch) {
        const group = qTodo.slice(i, i + batch);
        const res = await client.embed(group.map((q) => embedText(q.question).text));
        const used = Number.isFinite(res.usage?.input) ? res.usage.input : 0;
        qTokens += used;
        group.forEach((q, j) => cache.addQuestion(q.id, q.question, res.vectors[j], { tokens: j === 0 ? used : 0 }));
      }

      const tokens = out.tokens + qTokens;
      const cost = priceTokens(values.provider, model, tokens, deps.catalog);
      ctx.stdout.write(`done: ${out.embedded} chunks (${out.truncated} truncated to ${cache.meta.maxChars} characters) and ${qTodo.length} questions embedded; `
        + `${cache.rows.length}/${chunks.length} chunks cached, dim ${cache.dim ?? '-'}\n`);
      ctx.stdout.write(`tokens ${tokens}; cost ${cost === null ? `unknown (the catalog has no price for ${values.provider}/${model})` : usd(cost)}\n`);
      return 0;
    } finally {
      try { if (handle) await base.release(handle); } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
    }
  }
};
