'use strict';
// kl-recall-llm-rerank / kl-recall-vec-llm-rerank (local inference spec
// 2026-10-13 §11.3; R-LI-14): a probe, not a candidate system.
// kl-recall-rerank (BM25 or fused candidates, the same top rerank.topM) with
// a local model in place of the cross-encoder, so the two are compared on
// the same candidates:
//   pointwise (default): one call per chunk (prompts/rerank-llm-pointwise-v1.md),
//     the reply read as a whole number 0 to 10; anything else scores 0 and
//     is counted as unparsed.
//   listwise: one call per batch of 20 numbered chunks
//     (prompts/rerank-llm-listwise-v1.md), the reply read as passage numbers,
//     best first; the chunks it leaves out keep their fused order after the
//     ones it named, and a later batch never outranks an earlier one. A
//     reply that names no passage of its batch is counted as unparsed.
// Scores are cached by RerankCache under
// LONGHAUL_HOME/private/rerank/<session>/<model>-<hash>-llm-<mode>/, where
// the hash is over the client (provider, model, base URL, digest) and the
// prompt, so another server, digest or prompt never reuses a score. The
// pair hash covers the query, so a rewritten query is scored afresh. The
// answer stage and its dry run are cache-only (LOCAL_CALLS_MISSING): the
// Retriever keeps the fused order on a reranker failure, so the refusal is
// remembered and thrown from context(), as the Jev adapters do.
const { createKlRecallRerankAdapter } = require('./kl-recall-rerank');
const { requireLocalClient, localCallsMissing, localModelLabel, median } = require('../local-client');
const { loadPrompt, fillTemplate } = require('../prompts');
const { stableStringify } = require('../model-cache');
const { sha256Text } = require('../files');
const { withRetries } = require('../retry');
const { UsageError } = require('../errors');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/llm-rerank');

const LLM_RERANK_MODES = Object.freeze(['pointwise', 'listwise']);
const POINTWISE_MAX_TOKENS = 4;
const LISTWISE_MAX_TOKENS = 128;
const LISTWISE_BATCH = 20;

// A whole number 0 to 10, or null.
function parsePointwise(text) {
  const m = /^\s*(\d{1,2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 10 ? n : null;
}

// The 1-based passage numbers a listwise reply names, best first: each once,
// only 1 to n.
function parseListwise(text, n) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\d+/g)) {
    const k = Number(m[0]);
    if (k >= 1 && k <= n && !out.includes(k)) out.push(k);
  }
  return out;
}

// A model id as a cache directory name allows it (rerank.js MODEL_RE).
const safeName = (s) => String(s || 'model').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 60);

function createKlRecallLlmRerankAdapter({ local = null, llmRerankMode = 'pointwise', candidates = 'bm25', ...rest } = {}) {
  const name = candidates === 'fused' ? 'kl-recall-vec-llm-rerank' : 'kl-recall-llm-rerank';
  if (!LLM_RERANK_MODES.includes(llmRerankMode)) {
    throw new UsageError(`--llm-rerank-mode must be ${LLM_RERANK_MODES.join(' or ')}, got ${JSON.stringify(llmRerankMode)}`);
  }
  const client = requireLocalClient(local, name);
  const prompt = loadPrompt(llmRerankMode === 'listwise' ? 'rerankListwise' : 'rerankPointwise');
  const identity = sha256Text(stableStringify({
    provider: client.provider, model: client.model, baseUrl: client.baseUrl ?? null, digest: client.digest ?? null, promptSha256: prompt.sha256
  })).slice(0, 12);
  const rerankModel = `${safeName(client.model)}-${identity}-llm-${llmRerankMode}`;
  const counts = { calls: 0, unparsed: 0, ms: [] };
  let fatal = null;

  const ask = async (text, maxTokens) => {
    const t0 = Date.now();
    const reply = await withRetries(() => client.complete(text, { maxTokens }), local.retry || {});
    counts.calls += 1;
    counts.ms.push(Date.now() - t0);
    return String(reply?.text ?? '');
  };

  // Called by the cached reranker on a cache miss only.
  const scorer = {
    async score(query, texts) {
      if (fatal) throw fatal;
      if (local.cachedOnly === true) {
        fatal = localCallsMissing(name, `the local rerank of ${texts.length} candidates`);
        throw fatal;
      }
      try {
        if (llmRerankMode === 'pointwise') {
          const scores = [];
          for (const passage of texts) {
            const n = parsePointwise(await ask(fillTemplate(prompt.text, { query, passage }), POINTWISE_MAX_TOKENS));
            if (n === null) counts.unparsed += 1;
            scores.push(n ?? 0);
          }
          return scores;
        }
        // Listwise: a batch's named passages above its others, and every
        // batch above the next, so the fused order holds where the model
        // said nothing.
        const scores = new Array(texts.length).fill(0);
        const batches = Math.ceil(texts.length / LISTWISE_BATCH);
        for (let b = 0; b < batches; b += 1) {
          const batch = texts.slice(b * LISTWISE_BATCH, (b + 1) * LISTWISE_BATCH);
          const passages = batch.map((t, i) => `[${i + 1}]\n${t}`).join('\n\n');
          const reply = await ask(fillTemplate(prompt.text, { query, passages }), LISTWISE_MAX_TOKENS);
          const named = parseListwise(reply, batch.length);
          // A reply that names no passage of the batch is counted (it keeps the fused order).
          if (!named.length) counts.unparsed += 1;
          const top = (batches - b) * 100;
          batch.forEach((_, i) => {
            const rank = named.indexOf(i + 1);
            scores[b * LISTWISE_BATCH + i] = rank >= 0 ? top + 50 - rank : top + 20 - i;
          });
        }
        return scores;
      } catch (err) {
        if (err instanceof UsageError && !fatal) fatal = err;
        log.warn('the local rerank failed; this question keeps the fused order', { code: err?.code || 'error' });
        throw err;
      }
    }
  };

  const inner = createKlRecallRerankAdapter({ ...rest, candidates, rerankModel, scorer });
  return {
    name,
    stats: inner.stats,
    scorer,
    get modelClient() { return client; },
    localUse: { client, prompts: { [llmRerankMode === 'listwise' ? 'rerankListwise' : 'rerankPointwise']: { file: prompt.file, sha256: prompt.sha256 } } },
    describe() {
      return {
        ...inner.describe(), name, reranker: `local ${localModelLabel(client)} (${llmRerankMode})`, rerankCache: rerankModel,
        llmRerankMode, localModel: localModelLabel(client), localDigest: client.digest ?? null, rerankPromptSha256: prompt.sha256
      };
    },
    ...(inner.missingQuestionVectors ? { missingQuestionVectors: (session, questions) => inner.missingQuestionVectors(session, questions) } : {}),
    prepare: (session, options) => inner.prepare(session, options),
    async context(handle, args) {
      const out = await inner.context(handle, args);
      if (fatal) throw fatal;
      return out;
    },
    release: (handle) => inner.release(handle),
    close: () => inner.close(),
    // Numbers only, for adapter-stats.json.
    runStats() {
      return {
        mode: llmRerankMode, calls: counts.calls, cacheHits: inner.stats.hits, callMsMedian: median(counts.ms), callMsP90: median(counts.ms, 0.9),
        unparsed: counts.unparsed, rerank: { ...inner.stats }
      };
    }
  };
}

module.exports = { createKlRecallLlmRerankAdapter, parsePointwise, parseListwise, LLM_RERANK_MODES, LISTWISE_BATCH };
