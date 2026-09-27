// src/models/index.js
// The model subsystem (spec 2026-09-27): catalog, pricing and availability.
// Electron-free; tests/electron-boundary.test.js covers it.
const { Catalog, CATALOG_DEFAULTS, DEFAULT_SNAPSHOT_DIR } = require('./catalog');
const { priceWithCost } = require('./pricing');
const providerIds = require('./provider-ids');
const { Availability } = require('./availability');
const { discoverOllama } = require('./ollama');

let active = null;
let bundled = null;

// The catalog a provider prices against when none was injected: the core's
// once it has set one, else the bundled snapshot alone (never the network).
function getActiveCatalog() {
  if (active) return active;
  if (!bundled) bundled = new Catalog().load({});
  return bundled;
}

function setActiveCatalog(catalog) {
  active = catalog || null;
}

module.exports = {
  Catalog,
  CATALOG_DEFAULTS,
  DEFAULT_SNAPSHOT_DIR,
  priceWithCost,
  getActiveCatalog,
  setActiveCatalog,
  Availability,
  discoverOllama,
  ...providerIds
};
