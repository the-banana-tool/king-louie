'use strict';
// The built-in adapters (benchmark spec §7) that stage B0 ships.
const { UsageError } = require('../errors');
const { createSlidingWindowAdapter } = require('./sliding-window');
const { createOracleAdapter } = require('./oracle');

const FACTORIES = {
  // Loaded on use: it opens node:sqlite, which the other adapters never need.
  'kl-recall': (config) => require('./kl-recall').createKlRecallAdapter(config),
  // H3 probes (need `longhaul embed` first): fused, and cosine alone.
  'kl-recall-vec': (config) => require('./kl-recall-vec').createKlRecallVecAdapter(config),
  'kl-recall-vec-only': (config) => require('./kl-recall-vec').createKlRecallVecAdapter({ ...config, vectorOnly: true }),
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

module.exports = { createAdapter, adapterNames };
