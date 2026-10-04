'use strict';
// The built-in adapters (benchmark spec §7) that stage B0 ships.
const { UsageError } = require('../errors');
const { createSlidingWindowAdapter } = require('./sliding-window');
const { createOracleAdapter } = require('./oracle');
const { createFullHistoryAdapter } = require('./full-history');
const { createRealCompactionAdapter } = require('./real-compaction');
const { createSummarizeCompactAdapter } = require('./summarize-compact');

// The whole-message experiment B0 left open (measured facts; recall spec
// §6.7): taking a small message whole and pairing a tool call with its result
// raised evidence recall 0.352 -> 0.494 but left containment flat. B3's
// answer accuracy decides it; the run's summary prints the comparison
// (scoring.js COMPARISONS). These two settings win over --recall.
const WHOLE_MESSAGES = Object.freeze({ completeMessageTokens: 800, pairToolMessages: true });

const FACTORIES = {
  // Loaded on use: it opens node:sqlite, which the other adapters never need.
  'kl-recall': (config) => require('./kl-recall').createKlRecallAdapter(config),
  // H3 probes (need `longhaul embed` first): fused, and cosine alone.
  'kl-recall-vec': (config) => require('./kl-recall-vec').createKlRecallVecAdapter(config),
  'kl-recall-vec-only': (config) => require('./kl-recall-vec').createKlRecallVecAdapter({ ...config, vectorOnly: true }),
  // H3 probe: step 6 rerank (local cross-encoder, cached scores) over BM25
  // candidates, and over BM25 fused with cosine.
  'kl-recall-rerank': (config) => require('./kl-recall-rerank').createKlRecallRerankAdapter(config),
  'kl-recall-vec-rerank': (config) => require('./kl-recall-rerank').createKlRecallRerankAdapter({ ...config, candidates: 'fused' }),
  // Step 6 by typesafe.ai's Jev (batched by default, or pointwise) over BM25
  // or fused candidates; scores cached under private/rerank (unpriced).
  'kl-recall-jev-rerank': (config) => require('./kl-recall-jev-rerank').createKlRecallJevRerankAdapter(config),
  'kl-recall-vec-jev-rerank': (config) => require('./kl-recall-jev-rerank').createKlRecallJevRerankAdapter({ ...config, candidates: 'fused' }),
  'kl-recall-whole': (config) => require('./kl-recall').createKlRecallAdapter({
    ...config, name: 'kl-recall-whole', recall: { ...(config.recall || {}), ...WHOLE_MESSAGES }
  }),
  // Long-context baseline, frontier tier only (spec §8.1).
  'full-history': (config) => createFullHistoryAdapter(config),
  // What Claude Code had: its own compaction summaries (sessions with compactions only).
  'real-compaction': (config) => createRealCompactionAdapter(config),
  // Compaction baseline: a summarizer model every compactEveryTokens (answer stage only).
  'summarize-compact': (config) => createSummarizeCompactAdapter(config),
  'sliding-window': createSlidingWindowAdapter,
  oracle: createOracleAdapter
};

function adapterNames() {
  return Object.keys(FACTORIES).sort();
}

function createAdapter(name, config = {}) {
  const factory = FACTORIES[name];
  if (!factory) throw new UsageError(`Unknown adapter "${name}". Known: ${adapterNames().join(', ')}`);
  return factory(config);
}

module.exports = { createAdapter, adapterNames, WHOLE_MESSAGES };
