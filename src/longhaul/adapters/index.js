'use strict';
// The built-in adapters (benchmark spec §7) that stage B0 ships.
const { UsageError } = require('../errors');
const { createSlidingWindowAdapter } = require('./sliding-window');
const { createOracleAdapter } = require('./oracle');

const FACTORIES = {
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
