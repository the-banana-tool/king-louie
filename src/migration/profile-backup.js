// src/migration/profile-backup.js
// The one-time move (attach stage 2 spec §6.5, C-8): finds the desktop's old
// standalone profile and backs it up before anything moves. Electron-free. The
// profile is the owner's real cases and chats, so it is only ever read:
// `history.sqlite` through the snapshot, every other file by copyFile and two
// hashes. Any doubt refuses (BACKUP_FAILED), the half-made directory left in
// place and named, and the move does not begin.
//
// Everything that can take long is asynchronous, for the desktop's main
// process. The reader's own SQLite reads are synchronous; a large store's
// counts hold the loop for as long as the desktop import's plan does.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite = require('node:sqlite');
const { HistoryStore } = require('../history');
const { createLogger } = require('../logging');
const { shown } = require('../service/commands/io');
const { writeFileAtomic } = require('../approvals/approver-store');
const { readHistoryChats, snapshotHistoryFile, countChats } = require('./desktop-history');
const { createSafeReader, readDesktopSource } = require('./desktop-source');

const log = createLogger('profile-backup');

// Top level only: a case's own `logs` folder and a repository's .git/logs are
// data. The last three are spec §11's check against a real profile: Electron
// writes those two Dawn caches rather than DawnCache, and while it runs it
// holds Network/Cookies locked, so copying `Network` from the running desktop
// fails every time. Extend this list only with what is never a store.
const EXCLUDED_DIRS = Object.freeze([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'blob_storage', 'Session Storage', 'Local Storage', 'Service Worker', 'logs',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'Network'
]);
const STORE_FILE = 'history.sqlite';
// Top level only as well: a document under a case may have the name.
const STORE_FILES = new Set([STORE_FILE, `${STORE_FILE}-wal`, `${STORE_FILE}-shm`]);
const MANIFEST = 'backup.json';
// What another program holding a file looks like on Windows (antivirus for a
// moment, Chrome for as long as it runs).
const HELD_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);
const RETRY_DELAYS_MS = Object.freeze([250, 750, 2000]);
const PROGRESS_EVERY_MS = 200;

class Refusal extends Error {}

const clockValue = (now) => new Date(typeof now === 'function' ? now() : now);

function backupDirFor(userDataDir, now = Date.now) {
  const stamp = clockValue(now).toISOString().replace(/[-:.]/g, '');
  return path.join(path.dirname(path.resolve(userDataDir)), `king-louie.backup-${stamp}`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function whyFailed(err) {
  if (err instanceof Refusal) return err.message;
  if (err.code === 'ENOSPC') return 'the disk is full';
  if (HELD_CODES.has(err.code)) return `another program has it open (${err.code}); close Chrome or whatever else is using it and try again`;
  return shown(err.code || err.message);
}

function describedAs(rel, err) {
  return new Refusal(`${shown(rel)}: ${whyFailed(err)}`);
}

// The profile's files, with no store file and no excluded directory. Lists
// first, so a link is refused before anything is written. `strict` false
// (detect, which only adds up sizes) passes over what strict refuses.
async function listProfile(root, io, { strict = true, withStore = false } = {}) {
  const files = [];
  const dirs = [];
  const walk = async (rel) => {
    const abs = rel ? path.join(root, ...rel.split('/')) : root;
    let entries;
    try {
      entries = await io.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || !strict) return;
      throw describedAs(rel || '.', err);
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = path.join(abs, entry.name);
      if (!rel && EXCLUDED_DIRS.includes(entry.name) && !entry.isFile()) continue;
      let stat;
      try {
        stat = await io.lstat(child);
      } catch (err) {
        if (err.code === 'ENOENT' || !strict) continue;
        throw describedAs(childRel, err);
      }
      // A junction and any other reparse point come back as a link too.
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        if (strict) throw new Refusal(`${shown(childRel)} is a link, and the backup follows no link out of the profile`);
        continue;
      }
      if (stat.isDirectory()) {
        dirs.push(childRel);
        await walk(childRel);
      } else if (stat.isFile()) {
        if (!rel && STORE_FILES.has(entry.name) && !withStore) continue;
        files.push({ rel: childRel, abs: child, size: stat.size });
      } else if (strict) {
        throw new Refusal(`${shown(childRel)} is not a regular file`);
      }
    }
  };
  await walk('');
  return { files, dirs };
}

function hashFile(file, io) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const stream = io.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
    stream.on('end', () => resolve({ bytes, sha256: hash.digest('hex') }));
  });
}

// A copy read-only like its source (git objects are) has to be made writable
// before a retry can replace it.
async function removeCopy(file, io) {
  try {
    await io.chmod(file, 0o666);
  } catch { /* not there */ }
  await io.rm(file, { force: true });
}

// Copies one file and proves it: the copy's bytes and hash against the
// source's, read again after the copy. Tries again while the file is held by
// another program or changing, then refuses. Answers null for a file that is
// no longer in the profile (Chromium's journals come and go): there is nothing
// of it to lose.
async function copyVerified(entry, to, io, delays) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (attempt > 0) await removeCopy(to, io);
      await io.copyFile(entry.abs, to);
      const [source, copy] = await Promise.all([hashFile(entry.abs, io), hashFile(to, io)]);
      if (source.bytes !== copy.bytes) throw new Refusal(`${shown(entry.rel)} copied as ${copy.bytes} bytes where the profile has ${source.bytes}`);
      if (source.sha256 !== copy.sha256) throw new Refusal(`${shown(entry.rel)} copied with a different SHA-256 from the profile's`);
      return { path: entry.rel, bytes: copy.bytes, sha256: copy.sha256 };
    } catch (err) {
      if (err.code === 'ENOENT' && !(await io.lstat(entry.abs).then(() => true, () => false))) {
        await removeCopy(to, io);
        return null;
      }
      const again = err instanceof Refusal || HELD_CODES.has(err.code);
      if (!again || attempt >= delays.length) throw err instanceof Refusal ? err : describedAs(entry.rel, err);
      log.debug('copy of a file tried again', { attempt: attempt + 1, code: err.code || 'differs' });
      await sleep(delays[attempt]);
    }
  }
}

async function snapshotStore({ userDataDir, dest, backup }) {
  const checked = createSafeReader({ root: userDataDir }).checkFile(STORE_FILE);
  if (checked.missing) return { history: { chats: 0, messages: 0 }, file: null };
  if (!checked.ok) throw new Refusal(shown(checked.reason));
  if (typeof backup !== 'function') {
    throw new Refusal(`snapshotting history.sqlite needs Node.js 22.16 or later, and this is ${shown(process.versions.node)}`);
  }
  const file = path.join(dest, STORE_FILE);
  let source;
  try {
    source = await snapshotHistoryFile(checked.path, file, { backup });
  } catch (err) {
    throw new Refusal(`history.sqlite could not be snapshotted (${shown(err.message)}); close any other King Louie and try again`);
  }
  let history;
  try {
    // Immutable: a read-only open would leave -wal and -shm in the backup.
    const snapshot = HistoryStore.open(file, { readonly: true, allowOlderSchema: true, immutable: true });
    try {
      history = countChats(snapshot);
    } finally {
      snapshot.close();
    }
  } catch (err) {
    throw new Refusal(`the snapshot of history.sqlite does not open (${shown(err.message)})`);
  }
  if (history.chats !== source.chats || history.messages !== source.messages) {
    throw new Refusal(`the snapshot of history.sqlite holds ${history.chats} chats and ${history.messages} messages where the store holds ${source.chats} and ${source.messages}; close any other King Louie and try again`);
  }
  return { history, file };
}

// { dest, bytes, files (a count), history: { chats, messages } }, or throws
// BACKUP_FAILED with err.dest. Writes only under `dest`. An onProgress listener
// gets { phase: 'snapshot' | 'copy' | 'done', files, totalFiles, bytes,
// totalBytes, path } (path through shown), at most every 200 ms while copying.
async function backupProfile({
  userDataDir, dest, now = Date.now, backup = sqlite.backup, appVersion = null,
  fsImpl = {}, onProgress = null, retryDelaysMs = RETRY_DELAYS_MS
}) {
  const io = { ...fs.promises, createReadStream: fs.createReadStream, ...fsImpl };
  const root = path.resolve(userDataDir);
  let made = false;
  const say = (progress) => {
    if (!onProgress) return;
    try {
      onProgress(progress);
    } catch (err) {
      log.warn('a backup progress listener threw', { error: shown(err.message) });
    }
  };
  try {
    const inside = path.relative(root, path.resolve(dest));
    if (!inside || (!inside.startsWith('..') && !path.isAbsolute(inside))) throw new Refusal('the backup directory is inside the profile');
    const rootStat = await io.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Refusal('the profile is not a directory (a link is refused)');
    if (await io.lstat(dest).then(() => true, () => false)) throw new Refusal(`${shown(dest)} already exists`);

    const { files, dirs } = await listProfile(root, io);
    const totalFiles = files.length;
    const totalBytes = files.reduce((n, f) => n + f.size, 0);

    await io.mkdir(dest); // not recursive: fails if it appeared since the check
    made = true;

    say({ phase: 'snapshot', files: 0, totalFiles, bytes: 0, totalBytes, path: STORE_FILE });
    const { history, file: snapshot } = await snapshotStore({ userDataDir: root, dest, backup });

    for (const dir of dirs) await io.mkdir(path.join(dest, ...dir.split('/')), { recursive: true });

    const listed = [];
    const vanished = [];
    let bytes = 0;
    let lastSaid = 0;
    for (const entry of files) {
      const result = await copyVerified(entry, path.join(dest, ...entry.rel.split('/')), io, retryDelaysMs);
      if (result) {
        listed.push(result);
        bytes += result.bytes;
      } else {
        vanished.push(entry.rel);
      }
      if (Date.now() - lastSaid >= PROGRESS_EVERY_MS) {
        lastSaid = Date.now();
        say({ phase: 'copy', files: listed.length, totalFiles, bytes, totalBytes, path: shown(entry.rel) });
      }
    }
    if (snapshot) {
      const { bytes: size, sha256 } = await hashFile(snapshot, io);
      listed.push({ path: STORE_FILE, bytes: size, sha256 });
      bytes += size;
    }

    const manifest = {
      v: 1,
      from: root,
      at: clockValue(now).toISOString(),
      files: listed,
      history,
      appVersion,
      ...(vanished.length ? { vanished } : {})
    };
    writeFileAtomic(path.join(dest, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    say({ phase: 'done', files: listed.length, totalFiles: listed.length, bytes, totalBytes: bytes, path: '' });
    log.info('profile backed up', { files: listed.length, bytes, chats: history.chats, messages: history.messages });
    return { dest, bytes, files: listed.length, history };
  } catch (err) {
    const where = made ? `The unfinished copy is at ${shown(dest)}.` : 'Nothing was written.';
    const out = new Error(`The profile could not be backed up: ${whyFailed(err)}. Nothing in the profile was changed. ${where}`);
    out.code = 'BACKUP_FAILED';
    out.dest = dest;
    log.warn('profile backup refused', { made });
    throw out;
  }
}

// The manifest of a backup that is still whole by the sizes it recorded, or
// null: no backup.json, one that is not a manifest, a listed file gone or a
// different size, a listed path that leaves the backup.
async function readBackupManifest(dest) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(path.join(dest, MANIFEST), 'utf8'));
  } catch {
    return null;
  }
  if (!manifest || manifest.v !== 1 || !Array.isArray(manifest.files) || !manifest.history) return null;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !Number.isInteger(entry.bytes) || typeof entry.sha256 !== 'string') return null;
    if (entry.path.split('/').some((seg) => !seg || seg === '.' || seg === '..') || path.isAbsolute(entry.path)) return null;
    try {
      const stat = await fs.promises.lstat(path.join(dest, ...entry.path.split('/')));
      if (!stat.isFile() || stat.size !== entry.bytes) return null;
    } catch {
      return null;
    }
  }
  return manifest;
}

const STORE_PROBLEM_KEYS = new Set([STORE_FILE, 'chat-data.json']);

// { found, chats, messages, cases, bytes, schemaProblem }. Never throws, and
// never answers "nothing here" for a profile it could not read: a store or a
// chat-data.json the reader refuses is found, with schemaProblem saying why.
async function detectOldProfile(userDataDir, { readHistory = readHistoryChats, reader = null } = {}) {
  const nothing = { found: false, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: null };
  const problemOnly = (text) => ({ ...nothing, found: true, schemaProblem: shown(text, 400) });
  const root = path.resolve(userDataDir);
  let safe = reader;
  if (!safe) {
    try {
      safe = createSafeReader({ root });
    } catch (err) {
      if (err.code === 'ENOENT') return nothing;
      return problemOnly(err.message);
    }
  }
  let source;
  let history;
  try {
    history = await readHistory({ reader: safe });
    source = readDesktopSource({ userDataDir: root, reader: safe, secrets: 'needs-desktop', history });
  } catch (err) {
    return problemOnly(err.message);
  }
  const { inventory, attention, getValue } = source;
  const refused = attention.filter((a) => a.category === 'source' && STORE_PROBLEM_KEYS.has(a.key));
  const schemaProblem = refused.length ? shown(refused.map((a) => `${a.key}: ${a.note}`).join('; '), 400) : null;
  const messages = inventory.chats.reduce((n, c) => {
    const chat = getValue('chat', c.id);
    return n + (chat && Array.isArray(chat.messages) ? chat.messages.length : 0);
  }, 0);
  const found = Boolean(
    history.found || schemaProblem || inventory.chats.length || inventory.cases.length
    || inventory.customCasesRoot || attention.some((a) => a.category === 'case')
  );
  if (!found) return nothing;
  let bytes = 0;
  try {
    const { files } = await listProfile(root, { ...fs.promises }, { strict: false, withStore: true });
    bytes = files.reduce((n, f) => n + f.size, 0);
  } catch (err) {
    log.debug('profile size not read', { code: err.code });
  }
  return { found, chats: inventory.chats.length, messages, cases: inventory.cases.length, bytes, schemaProblem };
}

module.exports = { detectOldProfile, backupProfile, backupDirFor, readBackupManifest, EXCLUDED_DIRS };
