// king-louie-service import --from <userData> [--data-dir DIR] [--dry-run]
// (fleet stage 7 §3.8). Root/Administrator only, service stopped. Secrets
// are reported needs-desktop: safeStorage ciphertext opens only in the
// desktop user's session.
// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
//
// Reader and writer are split (Task 9 fix round 1, C1), the way the desktop
// bridge splits them. This process may be root, and the data dir belongs to
// the service account, which controls every name inside it: a root write
// there is a root write wherever a planted link points. So this process
// never opens the data dir. It reads the desktop profile through the R51
// safe reader and drives plan/apply/finish; a child
// (./import-writer.js) builds the core and runs DesktopImporter, talking
// JSON lines over stdio (./import-channel.js). On POSIX, run as root against
// a data dir owned by someone else, the child is spawned with that owner's
// { uid, gid }. Windows has no setuid: the child runs as the Administrator,
// and every importer write goes through a write guard instead (see
// src/platform/write-guard.js for what that does and does not close).
//
// The child reports its uid; a POSIX child that is not the uid it was spawned
// with is refused before anything is planned. Every plan item it returns is
// treated as untrusted: a case is read only if this process's own inventory
// listed it, and text that is printed is stripped of control characters.
const fs = require('fs');
const path = require('path');
const { readDesktopSource, createSafeReader, planBatches } = require('../../migration/desktop-source');
const { spawnWriter, printable } = require('./import-channel');
const { isAdmin: defaultIsAdmin } = require('./admin-check');

const IMPORT_USAGE = 'Usage: king-louie-service import --from <desktop user-data dir> [--data-dir DIR] [--dry-run]\n';

// The { uid, gid } the writer child drops to, or null for no drop: only
// when this process is root on POSIX and the data dir belongs to someone
// else. A root-owned data dir is written as root (the service account does
// not control it); Windows has no setuid (the write guard applies instead).
function writerIdentity(dataDir, {
  platform = process.platform,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  lstat = fs.lstatSync
} = {}) {
  if (platform === 'win32') return null;
  if (getuid() !== 0) return null;
  const st = lstat(dataDir);
  if (st.uid === 0) return null;
  return { uid: st.uid, gid: st.gid };
}

function printPlan(io, plan, attention) {
  for (const item of plan.items) {
    io.stdout.write(printable(`  ${String(item.action).padEnd(16)} ${item.category} ${item.key}${item.note ? `  (${item.note})` : ''}`) + '\n');
  }
  for (const a of attention) io.stdout.write(printable(`  ${'needs-attention'.padEnd(16)} ${a.category} ${a.key}  (${a.note})`) + '\n');
  const counts = plan.counts && typeof plan.counts === 'object' ? plan.counts : {};
  io.stdout.write(printable(Object.entries(counts).filter(([, n]) => n).map(([a, n]) => `${a}: ${n}`).join(', ')) + '\n');
}

function printReport(io, report, skipped) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const counts = report.counts && typeof report.counts === 'object' ? report.counts : {};
  io.stdout.write(printable(`Imported. ${Object.entries(counts).filter(([, n]) => n).map(([a, n]) => `${a}: ${n}`).join(', ')}`) + '\n');
  for (const f of arr(report.failures)) io.stdout.write(printable(`  failed ${f.category} ${f.key}: ${f.error}`) + '\n');
  for (const s of skipped) io.stdout.write(printable(`  not read ${s.category} ${s.key}: ${s.error}`) + '\n');
  for (const a of arr(report.attention)) io.stdout.write(printable(`  needs attention ${a.category} ${a.key}: ${a.note}`) + '\n');
  for (const note of arr(report.notes)) io.stdout.write(`${printable(note)}\n`);
}

// Only plan items this process can vouch for are driven into batches: a
// case must be one the inventory listed (anything else would have the
// safe reader open whatever the writer names inside the desktop profile).
function trustedItems(items, inventory) {
  const cases = new Set(inventory.cases.map((c) => c.dir));
  return (Array.isArray(items) ? items : []).filter((item) => item && typeof item.category === 'string' && typeof item.key === 'string'
    && (item.category !== 'case' || cases.has(item.key)));
}

async function runImportCommand({ flags = {}, dataDir, io, deps = {} }) {
  // No fail-open default (I7): a caller that forgets this would import into
  // a running service's data dir underneath it.
  if (typeof deps.runningServicePid !== 'function') throw new TypeError('runImportCommand needs deps.runningServicePid');
  const platform = deps.platform || process.platform;
  const isAdmin = deps.isAdmin || (() => defaultIsAdmin({ platform }));
  const identityFor = deps.writerIdentity || ((dir) => writerIdentity(dir, { platform }));
  const openWriter = deps.openWriter || ((opts) => spawnWriter({ ...opts, spawn: deps.spawn || require('child_process').spawn }));
  if (!flags.from) {
    io.stderr.write(IMPORT_USAGE);
    return 2;
  }
  if (!(await isAdmin())) {
    io.stderr.write(`import writes ${dataDir}; run it as root/an administrator.\n`);
    return 1;
  }
  if (deps.runningServicePid(dataDir)) {
    io.stderr.write(`Stop the service before importing into ${dataDir}.\n`);
    return 1;
  }
  const dryRun = Boolean(flags.dryRun);
  const target = path.resolve(dataDir);
  // The data dir must already exist (I1): a dry run creates nothing, and a
  // real run needs its owner to know whom to write as.
  let dirStat;
  try {
    dirStat = fs.lstatSync(target);
  } catch (err) {
    io.stderr.write(err.code === 'ENOENT'
      ? `${target} does not exist. Install the service (or start it once) before importing into it.\n`
      : `Cannot check ${target}: ${err.message}\n`);
    return 1;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    io.stderr.write(`${target} is not a directory (links are refused).\n`);
    return 1;
  }
  const from = path.resolve(flags.from);
  let source;
  try {
    source = readDesktopSource({ userDataDir: from, reader: createSafeReader({ root: from, platform }), decrypt: null, secrets: 'needs-desktop' });
  } catch (err) {
    io.stderr.write(`Cannot read ${from}: ${err.message}\n`);
    return 1;
  }

  let identity;
  try {
    identity = identityFor(target);
  } catch (err) {
    io.stderr.write(`Cannot find the owner of ${target}: ${err.message}\n`);
    return 1;
  }
  let writer;
  try {
    writer = openWriter({ dataDir: target, identity, onStderr: (s) => io.stderr.write(s) });
  } catch (err) {
    io.stderr.write(`Import failed: ${printable(err.message)}\n`);
    return 1;
  }
  try {
    const info = (await writer.request('open', { dataDir: target, dryRun, guard: !identity })) || {};
    if (identity && typeof info.uid === 'number' && info.uid !== identity.uid) {
      throw new Error(`the import writer runs as uid ${info.uid}, not ${identity.uid}; nothing was imported`);
    }
    const attention = [...source.attention];
    if (typeof info.casesRoot === 'string' && info.casesRootInDataDir === false && !identity) {
      attention.push({
        category: 'case',
        key: info.casesRoot,
        note: info.casesRootWritable === false
          ? 'the cases root is outside the data dir and was not named by KL_CASES_ROOT; an administrator import does not write there, so cases are not copied'
          : 'the cases root is outside the data dir; files written there are not handed back to the service account, so check it can write them'
      });
    }
    const plan = await writer.request('plan', { installId: source.installId, inventory: source.inventory });
    printPlan(io, plan, attention);
    if (dryRun) {
      io.stdout.write('Dry run: nothing was written.\n');
      return 0;
    }
    const skipped = [];
    for (const batch of planBatches(trustedItems(plan.items, source.inventory), source, { skipped })) {
      await writer.request('apply', { planId: plan.planId, batch });
    }
    const report = await writer.request('finish', { planId: plan.planId });
    printReport(io, report || {}, skipped);
    return (report && Array.isArray(report.failures) && report.failures.length) || skipped.length ? 1 : 0;
  } catch (err) {
    io.stderr.write(`Import failed: ${printable(err.message)}\n`);
    return 1;
  } finally {
    await writer.close();
  }
}

module.exports = { runImportCommand, writerIdentity, IMPORT_USAGE };
