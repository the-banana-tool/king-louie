// The writer half of `king-louie-service import --from` (fleet stage 7 Task
// 9, fix round 1, C1). The admin CLI runs as root/Administrator; the data dir
// belongs to the service account, which controls every name in it. So the
// CLI splits the way the desktop bridge does: the privileged parent only
// reads the desktop profile (the R51 safe reader), and this child builds the
// core and runs DesktopImporter. On POSIX the parent spawns it with the data
// dir owner's { uid, gid }, so nothing here can write anywhere the service
// account couldn't already. Windows has no setuid: there the child runs as
// the Administrator and every importer write goes through a write guard
// (src/platform/write-guard.js) that refuses a link or junction anywhere
// below the data dir.
//
// The core built here is never started: createCore() alone builds `context`;
// only core.start() would launch MCP servers and hooks (fleet stage 7 part 2
// deviations). A dry run opens the stores read-only and never probes a
// directory: it creates, writes and deletes nothing.
//
// Requests arrive over stdin as JSON lines (src/service/commands/import-channel.js);
// stdout carries only the answers, so everything that would log to stdout
// is sent to stderr instead.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DesktopImporter, buildImportTargets } = require('../../migration/desktop-import');
const { createDesktopScope } = require('../../desktop-bridge/desktop-scope');
const { checkPath } = require('../../desktop-bridge/check-path');
const { restoreDataDirOwnership } = require('../ownership');
const { createWriteGuard } = require('../../platform/write-guard');

const NOT_THERE = Object.freeze({ ok: true, exists: false, isDirectory: false, readable: false, writable: false });
const UNVERIFIED_NOTE = 'not verified: a dry run does not open the directory';

// What a dry run uses instead of checkPath (fix round 1, I5): a stat and
// nothing else, so previewing an import never creates a probe file anywhere.
// Whether the service can actually read the directory is left unverified.
async function statOnlyCheckPath(target, { fsp = fs.promises } = {}) {
  if (typeof target !== 'string' || !target || target.includes('\0') || !path.isAbsolute(target)) return { ...NOT_THERE };
  let st;
  try {
    st = await fsp.stat(target);
  } catch {
    return { ...NOT_THERE };
  }
  return { ok: true, exists: true, isDirectory: st.isDirectory(), readable: true, writable: false, unverified: true };
}

function openCore(dataDir, onPathWritten, dryRun) {
  const { createCore } = require('../../core');
  const { CHAT_DATA_DEFAULTS } = require('../../core/settings');
  const { createHeadlessPrompter } = require('../../platform/prompter');
  if (dryRun) {
    const { JsonFileStore } = require('../../platform/json-file-store');
    const { createAesGcmCipher } = require('../../platform/cipher');
    // Read-only: no ensureServicePaths (no logs/cache dirs), no
    // resolveMasterKey (no master.key / key-check file). Constructing a
    // JsonFileStore writes nothing and the data dir already exists (the
    // parent refuses one that doesn't). The cipher never encrypts or
    // decrypts anything while planning (the CLI reports every secret
    // needs-desktop), so a throwaway in-memory key satisfies createCore.
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
// anything reads from it if the file is missing; a dry run's presence check
// reads the file directly instead.
function readOnlyMemoryHas(dataDir) {
  const ids = new Set();
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'memory-store.json'), 'utf8'));
    if (doc && Array.isArray(doc.entries)) {
      for (const e of doc.entries) if (e && typeof e.id === 'string') ids.add(e.id);
    }
  } catch { /* nothing on disk yet: nothing is present */ }
  return (id) => ids.has(id);
}

const isInside = (parent, child) => {
  const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const rel = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
};

// One session per child. `guard` is true when this child did not drop
// privileges (Windows, or a root-owned data dir on POSIX).
function createWriterSession({ env = process.env, getuid = () => (typeof process.getuid === 'function' ? process.getuid() : null) } = {}) {
  const written = [];
  const record = (p) => written.push(p);
  let state = null;

  const need = () => {
    if (!state) throw Object.assign(new Error('the import writer was not opened'), { code: 'BAD_REQUEST' });
    return state;
  };

  return {
    async open({ dataDir, dryRun = false, guard = true }) {
      if (state) throw Object.assign(new Error('the import writer is already open'), { code: 'BAD_REQUEST' });
      if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Object.assign(new Error('dataDir must be an absolute path'), { code: 'BAD_REQUEST' });
      const envRoot = typeof env.KL_CASES_ROOT === 'string' && env.KL_CASES_ROOT ? path.resolve(env.KL_CASES_ROOT) : null;
      const writeGuard = guard ? createWriteGuard({ anchors: [dataDir, envRoot].filter(Boolean) }) : null;
      const { core, cipher } = openCore(dataDir, record, dryRun);
      const targets = await buildImportTargets({ context: core.context, dataDir, offline: true, writeGuard });
      if (dryRun) {
        targets.memory = { ...targets.memory, has: readOnlyMemoryHas(dataDir) };
      } else {
        written.push(...targets.writtenPaths);
      }
      const importer = new DesktopImporter({
        context: core.context,
        targets,
        dataDir,
        cipher,
        checkPath: dryRun ? statOnlyCheckPath : checkPath,
        scope: createDesktopScope({ dataDir, context: core.context, onPathWritten: record, writeGuard }),
        onPathWritten: record,
        cleanupStaging: !dryRun,
        writeGuard
      });
      state = { dataDir, dryRun, importer };
      const casesRoot = importer.casesRoot();
      let casesRootWritable = true;
      if (writeGuard) {
        try { writeGuard.check(path.join(casesRoot, '.probe')); } catch { casesRootWritable = false; }
      }
      return { uid: getuid(), casesRoot, casesRootInDataDir: isInside(dataDir, casesRoot), casesRootWritable };
    },

    async plan({ installId, inventory }) {
      const { importer, dryRun } = need();
      const plan = await importer.plan({ installId, inventory, source: 'cli' });
      if (dryRun) {
        for (const item of plan.items) {
          if (item.category === 'allowedDirectory' && item.action === 'new') item.note = item.note ? `${item.note}; ${UNVERIFIED_NOTE}` : UNVERIFIED_NOTE;
        }
      }
      return plan;
    },

    async apply({ planId, batch }) {
      const { importer, dryRun } = need();
      if (dryRun) throw Object.assign(new Error('a dry run writes nothing'), { code: 'BAD_REQUEST' });
      return importer.apply({ planId, batch });
    },

    async finish({ planId }) {
      const { importer, dryRun } = need();
      if (dryRun) throw Object.assign(new Error('a dry run writes nothing'), { code: 'BAD_REQUEST' });
      return importer.finish({ planId });
    },

    // The ownership backstop: a no-op unless this child is root, which it
    // is only when it did not drop (a root-owned data dir, where there is
    // nothing to hand back). The paths are the ones this process wrote.
    async close() {
      if (state && !state.dryRun) restoreDataDirOwnership(state.dataDir, written);
      return {};
    },

    written
  };
}

function main() {
  // stdout is the channel: route console output that would land there to stderr.
  for (const m of ['log', 'info', 'debug']) console[m] = (...args) => console.error(...args);
  const { serveWriter } = require('./import-channel');
  const session = createWriterSession();
  serveWriter({
    input: process.stdin,
    output: process.stdout,
    handlers: { open: session.open, plan: session.plan, apply: session.apply, finish: session.finish, close: session.close },
    // Exit once the answers already written have flushed: the never-started
    // core may hold timers that would otherwise keep this process alive.
    onClosed: () => { process.stdout.write('', () => process.exit(0)); }
  });
}

if (require.main === module) main();

module.exports = { createWriterSession, statOnlyCheckPath, UNVERIFIED_NOTE };
