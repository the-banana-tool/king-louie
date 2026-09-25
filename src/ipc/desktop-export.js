// The desktop half of import (fleet stage 7 §3.8): read this profile's own
// stores as plain JSON through the safe reader (never electron-store, which
// would write defaults), decrypt secrets in memory with safeStorage, and send
// them only inside import.apply batches over the authenticated bridge.
const { createSafeReader, readDesktopSource, planBatches } = require('../migration/desktop-source');
const { createSafeStorageCipher } = require('../platform/cipher');
const { secureStorageUsable } = require('./desktop-state');

const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);

function loadDesktopSource({ userDataDir, safeStorage, platform = process.platform }) {
  const usable = secureStorageUsable(safeStorage, platform);
  const cipher = usable ? createSafeStorageCipher(safeStorage) : null;
  return readDesktopSource({
    userDataDir,
    reader: createSafeReader({ root: userDataDir, platform }),
    decrypt: cipher ? (encrypted) => cipher.decryptString(encrypted) : null,
    secrets: usable ? 'included' : 'unavailable'
  });
}

async function planImport({ client, source }) {
  return client.call('import.plan', { installId: source.installId, inventory: source.inventory });
}

async function applyImport({ client, plan, source, onProgress = () => {} }) {
  const skipped = [];
  const sendFailures = [];
  const total = plan.items.filter((i) => WRITE_ACTIONS.has(i.action)).length;
  const done = new Set();
  for (const batch of planBatches(plan.items, source, { skipped })) {
    let results;
    try {
      ({ results } = await client.call('import.apply', { planId: plan.planId, batch }));
    } catch (err) {
      results = batch.map((e) => ({ category: e.category, key: e.key, ok: false, error: err.message }));
    }
    for (const r of results) {
      if (!r.ok) sendFailures.push(r);
      done.add(`${r.category}:${r.key}`);
    }
    onProgress({ sent: Math.min(done.size, total), total });
  }
  onProgress({ sent: total, total });
  const report = await client.call('import.finish', { planId: plan.planId });
  return { ...report, skipped, sendFailures };
}

module.exports = { loadDesktopSource, planImport, applyImport };
