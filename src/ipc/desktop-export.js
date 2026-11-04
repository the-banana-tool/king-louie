// The desktop half of import (fleet stage 7 §3.8): read this profile's own
// stores as plain JSON through the safe reader (never electron-store, which
// would write defaults), decrypt secrets in memory with safeStorage, and send
// them only inside import.apply batches over the authenticated bridge.
const { createSafeReader, readDesktopSource, planBatches } = require('../migration/desktop-source');
const { readHistoryApart } = require('../migration/old-profile-read');
const { createSafeStorageCipher } = require('../platform/cipher');
const { secureStorageUsable } = require('./desktop-state');
const path = require('path');
const { git } = require('../cases/git');

const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
// A failed import.apply with one of these codes means no later batch can
// land either (the plan is gone, or so is the connection): stop sending.
const STOP_CODES = new Set(['PLAN_EXPIRED', 'SERVICE_UNREACHABLE', 'CANCELLED']);

// finish sets up every case's repository before it answers, one git run after
// another: a default-sized bound would read a slow finish as a dead node.
const FINISH_TIMEOUT_MS = 10 * 60 * 1000;

const failuresFor = (batch, error, code) => batch.map((e) => ({
  category: e.category, key: e.key, ok: false, error, ...(code ? { code } : {})
}));

// Whether a case's tree matches its HEAD, with plumbing that writes no index into
// the old profile: `git status` rewrites it, and the hardened runner passes no
// --no-optional-locks. The asynchronous twin of the CLI's sourceChanges (import.js),
// for the desktop's main process: diff-index does not refresh, so an all-zero id
// is a changed stat, and is hashed (hash-object without -w writes nothing).
async function caseIsClean(dir) {
  const fields = (await git(dir, ['diff-index', '-z', 'HEAD', '--'])).split('\0');
  const statOnly = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].replace(/^:/, '').split(' ');
    const [, , headSha, workSha, status] = meta;
    if (status !== 'M' || !/^0+$/.test(workSha || '') || meta[0] !== meta[1]) return false;
    statOnly.push({ rel: fields[i + 1], headSha });
  }
  if (statOnly.length) {
    const hashes = (await git(dir, ['hash-object', '--', ...statOnly.map((s) => s.rel)])).trim().split(/\r?\n/);
    if (statOnly.some((s, n) => hashes[n] !== s.headSha)) return false;
  }
  return (await git(dir, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').every((rel) => !rel);
}

// For the plan's words and the comparison a retry makes: clean true or false, or
// no key when git cannot say. Here and not in the walker, which is synchronous and
// also serves the CLI.
async function addCaseCleanliness(source, userDataDir) {
  for (const entry of source.inventory.cases) {
    if (!entry.head) continue;
    try {
      entry.clean = await caseIsClean(path.join(userDataDir, 'cases', entry.dir));
    } catch { /* unknown: a retry treats it as not clean */ }
  }
  return source;
}

async function loadDesktopSource({ userDataDir, safeStorage, platform = process.platform, customRootEmpty = false, maxMessageBytes, readHistory = () => readHistoryApart({ userDataDir }) }) {
  const usable = secureStorageUsable(safeStorage, platform);
  const cipher = usable ? createSafeStorageCipher(safeStorage) : null;
  const reader = createSafeReader({ root: userDataDir, platform });
  const history = await readHistory();
  return addCaseCleanliness(readDesktopSource({
    userDataDir,
    reader,
    decrypt: cipher ? (encrypted) => cipher.decryptString(encrypted) : null,
    secrets: usable ? 'included' : 'unavailable',
    history,
    customRootEmpty,
    ...(maxMessageBytes ? { maxMessageBytes } : {})
  }), userDataDir);
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
  for (const batch of planBatches(plan.items, source, { skipped, chatParts: plan.chatParts === true })) {
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
    report = await client.call('import.finish', { planId: plan.planId }, { timeoutMs: FINISH_TIMEOUT_MS });
  } catch (err) {
    throw fatal || err;
  }
  return { ...report, skipped, sendFailures };
}

module.exports = { loadDesktopSource, planImport, applyImport };
