// The desktop half of import (fleet stage 7 §3.8): read this profile's own
// stores as plain JSON through the safe reader (never electron-store, which
// would write defaults), decrypt secrets in memory with safeStorage, and send
// them only inside import.apply batches over the authenticated bridge.
const { createSafeReader, readDesktopSource, planBatches } = require('../migration/desktop-source');
const { createSafeStorageCipher } = require('../platform/cipher');
const { secureStorageUsable } = require('./desktop-state');

const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
// A failed import.apply with one of these codes means no later batch can
// land either (the plan is gone, or so is the connection): stop sending.
const STOP_CODES = new Set(['PLAN_EXPIRED', 'SERVICE_UNREACHABLE', 'CANCELLED']);

const failuresFor = (batch, error, code) => batch.map((e) => ({
  category: e.category, key: e.key, ok: false, error, ...(code ? { code } : {})
}));

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

// Robust to a malformed import.apply answer (no results array: every item
// in that batch is a failure) and to a fatal one (PLAN_EXPIRED or a closed
// connection: no more batches are sent). Failures keep the error's code.
// import.finish is always attempted so the service reports what it got; if
// that fails after a fatal apply error, the apply error is what's thrown.
async function applyImport({ client, plan, source, onProgress = () => {} }) {
  const skipped = [];
  const sendFailures = [];
  const total = plan.items.filter((i) => WRITE_ACTIONS.has(i.action)).length;
  const done = new Set();
  let fatal = null;
  for (const batch of planBatches(plan.items, source, { skipped })) {
    let results;
    try {
      const response = await client.call('import.apply', { planId: plan.planId, batch });
      results = response && Array.isArray(response.results)
        ? response.results.filter((r) => r && typeof r === 'object')
        : failuresFor(batch, 'The service sent no per-item results for this batch.', 'MALFORMED_RESPONSE');
    } catch (err) {
      const code = (err && err.code) || null;
      results = failuresFor(batch, (err && err.message) || String(err), code);
      if (STOP_CODES.has(code)) fatal = err;
    }
    for (const r of results) {
      if (r.ok !== true) sendFailures.push(r);
      done.add(`${r.category}:${r.key}`);
    }
    onProgress({ sent: Math.min(done.size, total), total });
    if (fatal) break;
  }
  onProgress({ sent: total, total });
  let report;
  try {
    report = await client.call('import.finish', { planId: plan.planId });
  } catch (err) {
    throw fatal || err;
  }
  return { ...report, skipped, sendFailures };
}

module.exports = { loadDesktopSource, planImport, applyImport };
