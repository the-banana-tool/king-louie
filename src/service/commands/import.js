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
const { readHistoryChats } = require('../../migration/desktop-history');
const { spawnWriter, printable } = require('./import-channel');
const { isAdmin: defaultIsAdmin } = require('./admin-check');
const { resolveMasterKeyReadOnly } = require('../../platform/master-key');
const { filterInventoryToCase } = require('../../migration/case-filter');

const IMPORT_USAGE = 'Usage: king-louie-service import --from <desktop user-data dir> [--case <case dir or id>] [--yes] [--data-dir DIR] [--dry-run]\n';
const DESKTOP_STEP = 'In the desktop app, open the case and choose "Moved elsewhere" so it is worked in one place.';
const CASE_QUESTION = 'Copy this case to the node? [y/N] ';

// The primary group of `uid`, from id(1) (fix round 2, N2). Absolute paths
// only, the uid passed as one argument after `--`; /usr/bin/id first, then
// /bin/id. Throws when neither gives a number: the caller refuses rather than
// guess a group.
function primaryGroupOf(uid, { spawnSync = require('child_process').spawnSync } = {}) {
  const problems = [];
  for (const exe of ['/usr/bin/id', '/bin/id']) {
    const out = spawnSync(exe, ['-g', '--', String(uid)], { encoding: 'utf8', timeout: 10000 });
    if (out.error) { problems.push(`${exe}: ${out.error.code || out.error.message}`); continue; }
    const text = String(out.stdout || '').trim();
    if (out.status === 0 && /^\d+$/.test(text)) return Number(text);
    problems.push(`${exe}: ${String(out.stderr || '').trim() || `exit ${out.status}`}`);
    break;
  }
  throw new Error(`cannot resolve the primary group of uid ${uid} (${problems.join('; ')})`);
}

// The { uid, gid } the writer child drops to, or null for no drop: only
// when this process is root on POSIX and the data dir belongs to someone
// else. A root-owned data dir is written as root (the service account does
// not control it); Windows has no setuid (the write guard applies instead).
// The gid is the owner's primary group, not the data dir's group (fix round
// 2, N2): the macOS installer leaves the directory's group as admin/wheel.
function writerIdentity(dataDir, {
  platform = process.platform,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  lstat = fs.lstatSync,
  primaryGid = (uid) => primaryGroupOf(uid)
} = {}) {
  if (platform === 'win32') return null;
  if (getuid() !== 0) return null;
  const st = lstat(dataDir);
  if (st.uid === 0) return null;
  return { uid: st.uid, gid: primaryGid(st.uid) };
}

// EOF at the prompt counts as a decline; the answer is resolved before the
// interface closes (the pattern of desktop pair's prompt).
function defaultConfirm(io, question) {
  return new Promise((resolve) => {
    let answered = false;
    const rl = require('readline').createInterface({ input: io.stdin, output: io.stdout });
    rl.question(question, (answer) => {
      answered = true;
      resolve(/^y(es)?$/i.test(String(answer).trim()));
      rl.close();
    });
    rl.on('close', () => {
      if (!answered) resolve(false);
    });
  });
}

const firstLine = (text) => String(text || '').split(/\r?\n/)[0];
const ZERO_SHA = /^0+$/;

// The paths of the desktop's case that differ from its HEAD (tracked
// changes, staged or not, and untracked files git does not ignore), found
// with plumbing that never writes the desktop's .git/index: `git status`
// refreshes and rewrites the index, and runGitSync cannot pass
// --no-optional-locks or GIT_OPTIONAL_LOCKS. diff-index does not refresh,
// so a file whose stat changed but whose content did not is reported with
// an all-zero worktree id; those are hashed (hash-object without -w writes
// nothing) and kept only when the content really differs.
function sourceChanges(git, dir) {
  const changed = [];
  const statOnly = [];
  const fields = git(dir, ['diff-index', '-z', 'HEAD', '--']).split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].replace(/^:/, '').split(' ');
    const rel = fields[i + 1];
    if (!rel) break;
    const [, , headSha, workSha, status] = meta;
    if (status === 'M' && ZERO_SHA.test(workSha || '') && meta[0] === meta[1]) statOnly.push({ rel, headSha });
    else changed.push(rel);
  }
  if (statOnly.length) {
    const hashes = git(dir, ['hash-object', '--', ...statOnly.map((s) => s.rel)]).trim().split(/\r?\n/);
    statOnly.forEach((s, n) => { if (hashes[n] !== s.headSha) changed.push(s.rel); });
  }
  for (const rel of git(dir, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0')) {
    if (rel) changed.push(rel);
  }
  return changed;
}

// The case the owner named, from the source alone (personal node spec §9):
// which directory and chats move, what the repository's head is, and the
// refusals that must come before anything is written: the node already has
// that directory (CASE_EXISTS), the desktop's copy is not a git repository
// (CASE_NOT_A_REPO) or one git refuses (GIT_UNSAFE_CONFIG), or it has
// uncommitted changes (CASE_DIRTY). Returns { refusal } or { selection }.
function selectCase({ source, from, target, caseRef, reader, git }) {
  let filtered;
  try {
    filtered = filterInventoryToCase({ inventory: source.inventory, getValue: source.getValue, caseFiles: source.caseFiles, caseRef });
  } catch (err) {
    if (!err.code) throw err;
    return { refusal: `${err.code}: ${err.message}` };
  }
  const { caseDir, caseId, chatIds, meta } = filtered;
  const nodeDir = path.join(target, 'cases', caseDir);
  if (fs.existsSync(nodeDir)) {
    return { refusal: `CASE_EXISTS: the node already has a case at ${nodeDir}; nothing was written.` };
  }
  const sourceDir = path.join(from, 'cases', caseDir);
  const gitHead = reader.checkFile(path.join('cases', caseDir, '.git', 'HEAD'));
  if (!gitHead.ok) {
    return { refusal: `CASE_NOT_A_REPO: ${sourceDir} has no .git/HEAD${gitHead.reason ? ` (${gitHead.reason})` : ''}, so its history cannot move; nothing was written.` };
  }
  let head;
  try {
    head = git(sourceDir, ['rev-parse', 'HEAD']).trim();
  } catch (err) {
    if (err && err.code === 'GIT_UNSAFE_CONFIG') return { refusal: `GIT_UNSAFE_CONFIG: ${firstLine(err.message)}; nothing was written.` };
    return { refusal: `CASE_NOT_A_REPO: git cannot read the head of ${sourceDir} (${firstLine(err.message)}); nothing was written.` };
  }
  // A case with uncommitted changes would land on the node just as dirty and
  // fail the verify after the copy, so it is refused here, before anything
  // is written.
  let dirty;
  try {
    dirty = sourceChanges(git, sourceDir);
  } catch (err) {
    if (err && err.code === 'GIT_UNSAFE_CONFIG') return { refusal: `GIT_UNSAFE_CONFIG: ${firstLine(err.message)}; nothing was written.` };
    return { refusal: `CASE_NOT_A_REPO: git cannot read the state of ${sourceDir} (${firstLine(err.message)}); nothing was written.` };
  }
  if (dirty.length) {
    const shown = dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? ', ...' : '');
    return { refusal: `CASE_DIRTY: the case at ${sourceDir} has ${dirty.length} uncommitted change(s) (${shown}). Quit the desktop app, or let its turn finish, so the case commits, then run this again; nothing was written.` };
  }
  const messages = chatIds.reduce((n, id) => {
    const chat = source.getValue('chat', id);
    return n + (chat && Array.isArray(chat.messages) ? chat.messages.length : 0);
  }, 0);
  return {
    selection: {
      inventory: filtered.inventory,
      caseDir,
      caseId,
      chatIds: new Set(chatIds),
      title: String(meta.title || caseDir),
      status: String(meta.status || 'unknown'),
      chats: chatIds.length,
      messages,
      head
    }
  };
}

// After the copy: the node's repository has the source's head and a clean
// tree, and the node holds as many chats and messages of the case as the
// desktop did. The node's history store is opened read-only.
function verifyCase({ selection, caseDirOnNode, historyFile, git, openHistory }) {
  const problems = [];
  let head = null;
  let clean = false;
  try {
    head = git(caseDirOnNode, ['rev-parse', 'HEAD']).trim();
    const status = git(caseDirOnNode, ['status', '--porcelain']).trim();
    clean = status === '';
    if (!clean) {
      const lines = status.split(/\r?\n/);
      problems.push(`the node's tree is not clean (${lines.length} changed path(s): ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', ...' : ''})`);
    }
  } catch (err) {
    problems.push(`git cannot read the node's copy (${firstLine(err.message)})`);
  }
  if (head !== null && head !== selection.head) problems.push(`the node's head is ${head}, the desktop's ${selection.head}`);
  let chats = 0;
  let messages = 0;
  try {
    const store = openHistory(historyFile);
    try {
      for (const c of store.listChats()) {
        if (c.caseId !== selection.caseId) continue;
        chats += 1;
        messages += Number(c.messageCount) || 0;
      }
    } finally {
      store.close();
    }
  } catch (err) {
    problems.push(`the node's chats cannot be read (${firstLine(err.message)})`);
  }
  if (chats !== selection.chats) problems.push(`the node has ${chats} chat(s) of the case, the desktop ${selection.chats}`);
  if (messages !== selection.messages) problems.push(`the node has ${messages} message(s) in them, the desktop ${selection.messages}`);
  return { head, clean, chats, messages, problems };
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
  // Read-only (fix round 2, N1): never creates a key, never writes a file.
  const resolveKey = deps.resolveMasterKey || ((dir, ownerUid) => resolveMasterKeyReadOnly({ platform, dataDir: dir, dataDirOwnerUid: ownerUid }));
  const openWriter = deps.openWriter || ((opts) => spawnWriter({ ...opts, spawn: deps.spawn || require('child_process').spawn }));
  if (!flags.from || (flags.case !== undefined && (typeof flags.case !== 'string' || !flags.case.trim()))) {
    io.stderr.write(IMPORT_USAGE);
    return 2;
  }
  const caseRef = flags.case === undefined ? null : flags.case.trim();
  const dryRun = Boolean(flags.dryRun);
  // --yes answers only the case move's question (personal node spec §9).
  if (flags.yes && !caseRef) {
    io.stderr.write('Flag "--yes" is only valid for "import" with "--case".\n');
    return 2;
  }
  const isTTY = deps.isTTY ? deps.isTTY() : Boolean(io && io.stdin && io.stdin.isTTY);
  if (caseRef && !dryRun && !flags.yes && !isTTY) {
    io.stderr.write('Refusing to copy a case without confirmation on a non-interactive terminal; pass --yes.\n');
    return 2;
  }
  // A case move under hosting: personal runs as the owner, with no
  // elevation (spec §9); every other import, and a case move on a service
  // node, still needs root/an administrator.
  let personal = false;
  if (caseRef) {
    try {
      const nodeCfg = (deps.loadNodeConfig || ((dir) => require('../node-config').loadNodeConfig({ dataDir: dir })))(dataDir);
      personal = Boolean(nodeCfg) && nodeCfg.hosting === 'personal';
    } catch (err) {
      io.stderr.write(`Cannot read the node's configuration: ${printable(err.message)}\n`);
      return 1;
    }
  }
  if (!personal && !(await isAdmin())) {
    io.stderr.write(`import writes ${dataDir}; run it as root/an administrator.\n`);
    return 1;
  }
  if (deps.runningServicePid(dataDir)) {
    io.stderr.write(`Stop the service before importing into ${dataDir}.\n`);
    return 1;
  }
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
  let reader;
  try {
    reader = createSafeReader({ root: from, platform });
    const history = await readHistoryChats({ reader });
    source = readDesktopSource({ userDataDir: from, reader, decrypt: null, secrets: 'needs-desktop', history });
  } catch (err) {
    io.stderr.write(`Cannot read ${from}: ${err.message}\n`);
    return 1;
  }
  const git = deps.runGitSync || ((cwd, args) => require('../../cases/git').runGitSync(cwd, args));
  let selection = null;
  if (caseRef) {
    let picked;
    try {
      picked = selectCase({ source, from, target, caseRef, reader, git });
    } catch (err) {
      io.stderr.write(`Cannot read ${from}: ${printable(err.message)}\n`);
      return 1;
    }
    if (picked.refusal) {
      io.stderr.write(`${printable(picked.refusal)}\n`);
      return 2;
    }
    selection = picked.selection;
  }
  const inventory = selection ? selection.inventory : source.inventory;

  let identity;
  try {
    identity = identityFor(target);
  } catch (err) {
    io.stderr.write(`Cannot find the owner of ${target}: ${err.message}\n`);
    return 1;
  }
  // The case move rebuilds and reads the landed repository's index with git
  // run by this process. As root on POSIX, against a data dir another
  // account owns, that would leave a root-owned .git/index in a directory
  // the service account controls, which the writer split exists to avoid.
  if (selection && identity) {
    io.stderr.write(`import --case runs git in the copied case as this process; run it as the account that owns ${target}, not as root. Nothing was written.\n`);
    return 2;
  }
  // The writer never resolves the key itself (fix round 2, N1): as the
  // service account it can't read the root-only credential, and resolving
  // would mint and write a new key. This process resolves it read-only and
  // sends it down the channel, never in argv, the environment or a log line.
  let masterKey = null;
  if (!dryRun) {
    let resolved;
    try {
      resolved = resolveKey(target, platform === 'win32' ? null : dirStat.uid);
    } catch (err) {
      io.stderr.write(`Cannot read the master key for ${target}: ${err.message}\n`);
      return 1;
    }
    if (!resolved || !Buffer.isBuffer(resolved.key) || resolved.key.length !== 32) {
      io.stderr.write(`${target} has no master key yet; start the service once first, then import.\n`);
      return 1;
    }
    masterKey = resolved.key.toString('hex');
  }
  let writer;
  try {
    writer = openWriter({ dataDir: target, identity, onStderr: (s) => io.stderr.write(s) });
  } catch (err) {
    io.stderr.write(`Import failed: ${printable(err.message)}\n`);
    return 1;
  }
  let writerClosed = false;
  const closeWriter = async () => {
    if (writerClosed) return;
    writerClosed = true;
    await writer.close();
  };
  try {
    const info = (await writer.request('open', { dataDir: target, dryRun, guard: !identity, ...(masterKey ? { masterKey } : {}) })) || {};
    masterKey = null;
    if (identity && !(Number.isInteger(info.uid) && info.uid === identity.uid)) {
      throw new Error(`the import writer runs as uid ${String(info.uid)}, not ${identity.uid}; nothing was imported`);
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
    const plan = await writer.request('plan', { installId: source.installId, inventory });
    printPlan(io, plan, attention);
    let items = trustedItems(plan.items, inventory);
    if (selection) {
      // Only this case and its chats are driven, whatever the writer planned.
      items = items.filter((item) => (item.category === 'case' && item.key === selection.caseDir)
        || (item.category === 'chat' && selection.chatIds.has(item.key)));
      const caseItem = items.find((item) => item.category === 'case');
      if (!caseItem || caseItem.action !== 'new') {
        io.stderr.write(printable(`CASE_EXISTS: the node already has a case at ${selection.caseDir}${caseItem && caseItem.note ? ` (${caseItem.note})` : ''}; no case file or chat was written.`) + '\n');
        return 2;
      }
      io.stdout.write(printable(`Will copy case ${selection.title} (${selection.caseId}, ${selection.status}): ${selection.chats} chats, ${selection.messages} messages, head ${selection.head}`) + '\n');
    }
    if (dryRun) {
      io.stdout.write('Dry run: nothing was written.\n');
      return 0;
    }
    if (selection && !flags.yes) {
      const ask = deps.confirm || ((question) => defaultConfirm(io, question));
      if (!(await ask(CASE_QUESTION))) {
        io.stdout.write('Not copied: no case file or chat was written.\n');
        return 1;
      }
    }
    const skipped = [];
    for (const batch of planBatches(items, source, { skipped })) {
      await writer.request('apply', { planId: plan.planId, batch });
    }
    const report = await writer.request('finish', { planId: plan.planId });
    printReport(io, report || {}, skipped);
    const failed = Boolean((report && Array.isArray(report.failures) && report.failures.length) || skipped.length);
    if (!selection) return failed ? 1 : 0;
    // The writer (and the core it holds) is closed before the node's store
    // and repository are read.
    await closeWriter();
    const casesRoot = typeof info.casesRoot === 'string' ? info.casesRoot : path.join(target, 'cases');
    const caseDirOnNode = path.join(casesRoot, selection.caseDir);
    // The importer copies a case's .git objects, refs and HEAD but never its
    // index (isAllowedUnderDotGit), so the landed repository has an empty
    // index: every file reads as deleted and untracked, and the case's next
    // commit would find nothing to commit. The index is rebuilt from HEAD
    // (only .git/index is written; no working file is touched), so a copy
    // whose files are HEAD's reads clean, as the desktop's did.
    let indexProblem = null;
    try {
      git(caseDirOnNode, ['read-tree', 'HEAD']);
    } catch (err) {
      indexProblem = `the node's index could not be rebuilt from HEAD (${firstLine(err.message)})`;
    }
    if (deps.afterCopy) deps.afterCopy(caseDirOnNode);
    const openHistory = deps.openHistory || ((file) => require('../../history').HistoryStore.open(file, { readonly: true }));
    const result = verifyCase({ selection, caseDirOnNode, historyFile: path.join(target, 'history.sqlite'), git, openHistory });
    if (indexProblem) result.problems.unshift(indexProblem);
    io.stdout.write(printable(`desktop: head ${selection.head}, ${selection.chats} chats / ${selection.messages} messages`) + '\n');
    io.stdout.write(printable(`node: head ${result.head || 'unreadable'}, ${result.clean ? 'clean' : 'not clean'}, ${result.chats} chats / ${result.messages} messages`) + '\n');
    if (result.problems.length) {
      io.stderr.write(printable(`VERIFY_MISMATCH: ${result.problems.join('; ')}. The copy on the node is kept; the desktop's case is unchanged. `
        + `To try again, with the node stopped, remove the node's case directory ${caseDirOnNode} and the node's ${result.chats} chat(s) with caseId ${selection.caseId}, then run this command again `
        + '(a chat left on the node is imported again under a new id, and the counts can then never match).') + '\n');
      return 1;
    }
    if (failed) return 1;
    io.stdout.write(`${DESKTOP_STEP}\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`Import failed: ${printable(err.message)}\n`);
    return 1;
  } finally {
    await closeWriter();
  }
}

module.exports = { runImportCommand, writerIdentity, primaryGroupOf, IMPORT_USAGE, DESKTOP_STEP };
