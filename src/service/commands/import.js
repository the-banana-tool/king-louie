// king-louie-service import --from <userData> [--data-dir DIR] [--dry-run]
// (fleet stage 7 §3.8). Root/Administrator only, service stopped. Secrets
// are reported needs-desktop: safeStorage ciphertext opens only in the
// desktop user's session.
// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
//
// A `--dry-run` must create or write nothing under --data-dir (a fresh data
// dir is left exactly as it was, including the logs/cache dirs and the
// master-key file). openCore therefore never provisions the data dir for a
// dry run: it skips ensureServicePaths/resolveMasterKey (buildServicePorts'
// job for a real import) and opens the stores read-only instead, with a
// throwaway in-memory cipher plan() never actually uses. Either way, the
// core returned here is never started — createCore() alone builds `context`
// synchronously; only core.start() would launch MCP servers and hooks, and
// doing that as root is exactly what this command must not do (fleet stage
// 7 part 2 deviations). buildImportTargets({ offline: true }) writes memory,
// cron and the user profile straight through their own stores instead.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readDesktopSource, createSafeReader, planBatches } = require('../../migration/desktop-source');
const { DesktopImporter, buildImportTargets } = require('../../migration/desktop-import');
const { createDesktopScope } = require('../../desktop-bridge/desktop-scope');
const { checkPath } = require('../../desktop-bridge/check-path');
const { restoreDataDirOwnership } = require('../ownership');
const { isAdmin: defaultIsAdmin } = require('./admin-check');

const IMPORT_USAGE = 'Usage: king-louie-service import --from <desktop user-data dir> [--data-dir DIR] [--dry-run]\n';

function defaultOpenCore(dataDir, onPathWritten, dryRun) {
  const { createCore } = require('../../core');
  const { CHAT_DATA_DEFAULTS } = require('../../core/settings');
  const { createHeadlessPrompter } = require('../../platform/prompter');
  if (dryRun) {
    const { JsonFileStore } = require('../../platform/json-file-store');
    const { createAesGcmCipher } = require('../../platform/cipher');
    // Read-only: no ensureServicePaths (no logs/cache dirs), no
    // resolveMasterKey (no master.key / key-check file). Constructing a
    // JsonFileStore writes nothing (its own contract) and only mkdirs a
    // dataDir that must already exist for this command to run at all. The
    // cipher never actually encrypts or decrypts anything during planning
    // (secrets are always reported needs-desktop for the CLI), so a
    // throwaway in-memory key is enough to satisfy createCore's shape check.
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: CHAT_DATA_DEFAULTS });
    const vaultStore = new JsonFileStore({ dir: dataDir, name: 'config' });
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    return { core: createCore({ paths: { dataDir }, store, vaultStore, cipher, prompter: createHeadlessPrompter() }), cipher };
  }
  const { buildServicePorts } = require('../ports');
  const ports = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS, onPathWritten });
  return { core: createCore(ports), cipher: ports.cipher };
}

// MemoryStore.load() writes a fresh default document the first time
// anything reads from it if the file is missing (src/memory/memory-store.js)
// — fine for a real import (the file is expected to exist afterwards
// regardless), but exactly the write a dry run must not cause. Read the
// file directly instead, without ever constructing a MemoryStore.
function readOnlyMemoryHas(dataDir) {
  const memoryFile = path.join(dataDir, 'memory', 'memory-store.json');
  let ids = new Set();
  try {
    const doc = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    if (doc && Array.isArray(doc.entries)) {
      for (const e of doc.entries) if (e && typeof e.id === 'string') ids.add(e.id);
    }
  } catch { /* nothing on disk yet — nothing is present */ }
  return (id) => ids.has(id);
}

function printPlan(io, plan, attention) {
  for (const item of plan.items) {
    io.stdout.write(`  ${item.action.padEnd(16)} ${item.category} ${item.key}${item.note ? `  (${item.note})` : ''}\n`);
  }
  for (const a of attention) io.stdout.write(`  ${'needs-attention'.padEnd(16)} ${a.category} ${a.key}  (${a.note})\n`);
  io.stdout.write(`${Object.entries(plan.counts).filter(([, n]) => n).map(([a, n]) => `${a}: ${n}`).join(', ')}\n`);
}

function printReport(io, report, skipped) {
  io.stdout.write(`Imported. ${Object.entries(report.counts).filter(([, n]) => n).map(([a, n]) => `${a}: ${n}`).join(', ')}\n`);
  for (const f of report.failures) io.stdout.write(`  failed ${f.category} ${f.key}: ${f.error}\n`);
  for (const s of skipped) io.stdout.write(`  not read ${s.category} ${s.key}: ${s.error}\n`);
  for (const a of report.attention) io.stdout.write(`  needs attention ${a.category} ${a.key}: ${a.note}\n`);
  for (const note of report.notes) io.stdout.write(`${note}\n`);
}

async function runImportCommand({ flags = {}, dataDir, io, deps = {} }) {
  const platform = deps.platform || process.platform;
  const isAdmin = deps.isAdmin || (() => defaultIsAdmin({ platform }));
  const runningServicePid = deps.runningServicePid || (() => null);
  const openCore = deps.openCore || defaultOpenCore;
  if (!flags.from) {
    io.stderr.write(IMPORT_USAGE);
    return 2;
  }
  if (!(await isAdmin())) {
    io.stderr.write(`import writes ${dataDir}; run it as root/an administrator.\n`);
    return 1;
  }
  if (runningServicePid(dataDir)) {
    io.stderr.write(`Stop the service before importing into ${dataDir}.\n`);
    return 1;
  }
  const dryRun = Boolean(flags.dryRun);
  const from = path.resolve(flags.from);
  let source;
  try {
    source = readDesktopSource({ userDataDir: from, reader: createSafeReader({ root: from, platform }), decrypt: null, secrets: 'needs-desktop' });
  } catch (err) {
    io.stderr.write(`Cannot read ${from}: ${err.message}\n`);
    return 1;
  }
  const written = [];
  const record = (p) => written.push(p);
  try {
    const { core, cipher } = openCore(dataDir, record, dryRun);
    const targets = await buildImportTargets({ context: core.context, dataDir, offline: true });
    if (dryRun) {
      // See readOnlyMemoryHas above: never let the real target's .has()
      // run and create memory-store.json just by being asked a question.
      targets.memory = { ...targets.memory, has: readOnlyMemoryHas(dataDir) };
    } else {
      written.push(...targets.writtenPaths);
    }
    const importer = new DesktopImporter({
      context: core.context,
      targets,
      dataDir,
      cipher,
      checkPath,
      scope: createDesktopScope({ dataDir, context: core.context, onPathWritten: record }),
      onPathWritten: record
    });
    const plan = await importer.plan({ installId: source.installId, inventory: source.inventory, source: 'cli' });
    printPlan(io, plan, source.attention);
    if (dryRun) {
      io.stdout.write('Dry run: nothing was written.\n');
      return 0;
    }
    const skipped = [];
    for (const batch of planBatches(plan.items, source, { skipped })) {
      await importer.apply({ planId: plan.planId, batch });
    }
    const report = await importer.finish({ planId: plan.planId });
    printReport(io, report, skipped);
    return report.failures.length ? 1 : 0;
  } finally {
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
}

module.exports = { runImportCommand, IMPORT_USAGE };
