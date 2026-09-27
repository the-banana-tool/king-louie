// tests/helpers/models-fixture.js
// A Catalog loaded from the small fixture catalog in tests/fixtures/models/
// instead of the bundled snapshot, so exact-value tests never change when the
// snapshot is regenerated. Its fetch refuses: unit tests never touch the
// network.
const path = require('path');
const { Catalog } = require('../../src/models/catalog');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'models');

const noNetwork = async (url) => {
  throw new Error(`unit tests never touch the network (tried ${url})`);
};

function fixtureCatalog({ cacheDir = null, getSettings = () => ({}), fetch = noNetwork, now } = {}) {
  return new Catalog().load({ snapshotDir: FIXTURE_DIR, cacheDir, getSettings, fetch, ...(now ? { now } : {}) });
}

module.exports = { FIXTURE_DIR, fixtureCatalog };
