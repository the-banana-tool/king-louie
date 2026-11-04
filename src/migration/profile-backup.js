// src/migration/profile-backup.js
// The one-time move (attach stage 2 spec §6.5, C-8): finds the desktop's old
// standalone profile and backs it up before anything moves. Electron-free. The
// profile is the owner's real cases and chats, so it is only ever read:
// `history.sqlite` through the snapshot, every other file by copyFile and two
// hashes. Any doubt refuses (BACKUP_FAILED), the half-made directory left in
// place and named, and the move does not begin.
//
// Everything that can take long is asynchronous, for the desktop's main
// process. Reading every message runs in a child (old-profile-read.js); the
// snapshot's own counts here are one query on a store with no message loaded.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite = require('node:sqlite');
const { createLogger } = require('../logging');
const { shown } = require('../service/commands/io');
const { writeFileAtomic } = require('../approvals/approver-store');
const { resolveCasesRoot } = require('../cases/case-runtime');
const { readHistoryChats, snapshotHistoryFile, openSnapshot, countChats } = require('./desktop-history');
const { createSafeReader, readDesktopSource } = require('./desktop-source');
const { settingsWouldMove } = require('./desktop-import');

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
// Under browser-profiles/<name> and browser-profiles/<name>/<profile>: Chromium's
// caches, which it rebuilds and which were most of a real profile's 800 MB. Only
// these names: Network, Local Storage and the rest hold the owner's logins there.
const BROWSER_CACHE_DIRS = Object.freeze([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache', 'blob_storage'
]);
const BROWSER_PROFILE_LEVELS = /^browser-profiles\/[^/]+(\/[^/]+)?$/;
const STORE_FILE = 'history.sqlite';
// Top level only as well: a document under a case may have the name.
const STORE_FILES = new Set([STORE_FILE, `${STORE_FILE}-wal`, `${STORE_FILE}-shm`, `${STORE_FILE}-journal`]);
const MANIFEST = 'backup.json';
// Written first and removed last, so a directory a refused or cut-off try left
// behind cannot be taken for a good backup.
const UNFINISHED = 'UNFINISHED';
const UNFINISHED_TEXT = 'This King Louie backup did not finish and is not a good copy of the profile. It can be deleted.\n';
// What a running King Louie writes, checked unchanged after the copy. Not
// -shm, which any reader (this one included) may touch, and not Chromium's
// files, which change whatever anyone does.
const WATCHED_FILES = Object.freeze([STORE_FILE, `${STORE_FILE}-wal`, `${STORE_FILE}-journal`, 'chat-data.json', 'config.json']);
const EMPTY_WHEN_IDLE = new Set([`${STORE_FILE}-wal`, `${STORE_FILE}-journal`]);
const WATCHED_DIR = 'cases';
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
  if (err.code === 'ENOENT') return 'it is no longer there';
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
      if (BROWSER_PROFILE_LEVELS.test(rel) && BROWSER_CACHE_DIRS.includes(entry.name) && !entry.isFile()) continue;
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

// rel -> size and mtime of everything a running King Louie would write.
async function watchedMarks(root, io) {
  const marks = new Map();
  const note = (rel, stat) => marks.set(rel, `${stat.size}:${stat.mtimeMs}`);
  const lstatOrNull = (file) => io.lstat(file).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  for (const rel of WATCHED_FILES) {
    const stat = await lstatOrNull(path.join(root, rel));
    // An empty -wal is the same as none: our own plain open can leave one.
    if (stat && !(EMPTY_WHEN_IDLE.has(rel) && stat.size === 0)) note(rel, stat);
  }
  const walk = async (rel) => {
    const entries = await io.readdir(path.join(root, ...rel.split('/')), { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(childRel);
      } else {
        const stat = await lstatOrNull(path.join(root, ...childRel.split('/')));
        if (stat) note(childRel, stat);
      }
    }
  };
  await walk(WATCHED_DIR);
  return marks;
}

function firstMoved(before, after) {
  for (const [rel, mark] of before) if (after.get(rel) !== mark) return rel;
  for (const rel of after.keys()) if (!before.has(rel)) return rel;
  return null;
}

// The cases root the runtime would use, when it is not the profile's own
// `cases` folder: the setting, else KL_CASES_ROOT (resolveCasesRoot). The move
// carries only that folder, so anything elsewhere has to be dealt with first.
function customRootOf(root, settingRoot, env) {
  const settings = settingRoot ? { cases: { root: settingRoot } } : {};
  const resolved = path.resolve(resolveCasesRoot({ settings, env, dataDir: root }));
  return path.relative(path.join(root, WATCHED_DIR), resolved) === '' ? null : resolved;
}

// How many case directories a custom root holds, and whether it is there at all.
// Only a folder that exists and reads with none is 0: a root that is gone may be a
// drive not plugged in, with every case on it, so it is null like one that cannot
// be read, and customCasesMissing says which. A link may be a case, so it counts.
async function readCaseRoot(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return { customCases: entries.filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).length, customCasesMissing: false };
  } catch (err) {
    return { customCases: null, customCasesMissing: err.code === 'ENOENT' };
  }
}

const NO_CASE_ROOT = Object.freeze({ customCases: 0, customCasesMissing: false });

function settingRootFrom(root, reader = createSafeReader({ root })) {
  const read = reader.readFile('chat-data.json');
  if (!read.ok) return null;
  try {
    const value = JSON.parse(read.data.toString('utf8'))?.settings?.cases?.root;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
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
    // Not a plain read-only open, which would leave -wal and -shm in the backup.
    const snapshot = openSnapshot(file);
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

const ROOM_MARGIN_BYTES = 64 * 1024 * 1024;
const asSize = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// Before anything is written: a full disk is otherwise found minutes in, with a
// half-made directory to delete. A disk that will not say goes on: ENOSPC still refuses.
async function assertRoom({ root, dest, totalBytes, io }) {
  let free;
  try {
    const fsStat = await io.statfs(path.dirname(dest));
    free = Number(fsStat.bavail) * Number(fsStat.bsize);
  } catch {
    return;
  }
  if (!Number.isFinite(free)) return;
  let store = 0;
  for (const name of STORE_FILES) store += await io.lstat(path.join(root, name)).then((s) => s.size, () => 0);
  const needs = totalBytes + store;
  if (needs + ROOM_MARGIN_BYTES > free) throw new Refusal(`there is not enough room on the disk: the backup needs ${asSize(needs)}, with ${asSize(ROOM_MARGIN_BYTES)} to spare, and ${asSize(free)} is free. Free some space and try again`);
}

// { dest, bytes, files (a count), history: { chats, messages }, customCasesRoot,
// customCases }, or throws BACKUP_FAILED with err.dest. Writes only under
// `dest`. A write to a King Louie store from the first listing to the end of
// the copy refuses: the files would be from different moments. A custom cases
// root is outside the profile, so it is recorded, not copied. An onProgress listener
// gets { phase: 'snapshot' | 'copy' | 'done', files, totalFiles, bytes,
// totalBytes, path } (path through shown), at most every 200 ms while copying.
async function backupProfile({
  userDataDir, dest, now = Date.now, backup = sqlite.backup, appVersion = null,
  fsImpl = {}, onProgress = null, retryDelaysMs = RETRY_DELAYS_MS, env = process.env
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
    const outside = inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside);
    if (!outside) throw new Refusal('the backup directory is inside the profile');
    const rootStat = await io.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Refusal('the profile is not a directory (a link is refused)');
    if (await io.lstat(dest).then(() => true, () => false)) throw new Refusal(`${shown(dest)} already exists`);

    const marks = await watchedMarks(root, io);
    const { files, dirs } = await listProfile(root, io);
    const totalFiles = files.length;
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    await assertRoom({ root, dest, totalBytes, io });

    try {
      await io.mkdir(dest); // not recursive: fails if it appeared since the check
    } catch (err) {
      if (err.code === 'ENOENT') throw new Refusal(`the folder that would hold the backup, ${shown(path.dirname(dest))}, does not exist`);
      throw err;
    }
    made = true;
    await io.writeFile(path.join(dest, UNFINISHED), UNFINISHED_TEXT);

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

    const moved = firstMoved(marks, await watchedMarks(root, io));
    if (moved) throw new Refusal(`${shown(moved)} changed while the backup ran; close any other King Louie and try again`);

    const customCasesRoot = customRootOf(root, settingRootFrom(root), env);
    const { customCases, customCasesMissing } = customCasesRoot ? await readCaseRoot(customCasesRoot) : NO_CASE_ROOT;
    const manifest = {
      v: 1,
      from: root,
      at: clockValue(now).toISOString(),
      files: listed,
      history,
      appVersion,
      customCasesRoot,
      customCases,
      ...(vanished.length ? { vanished } : {})
    };
    writeFileAtomic(path.join(dest, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await io.rm(path.join(dest, UNFINISHED));
    say({ phase: 'done', files: listed.length, totalFiles: listed.length, bytes, totalBytes: bytes, path: '' });
    log.info('profile backed up', { files: listed.length, bytes, chats: history.chats, messages: history.messages });
    return { dest, bytes, files: listed.length, history, customCasesRoot, customCases, customCasesMissing };
  } catch (err) {
    const where = made
      ? `The unfinished copy is at ${shown(dest)}, marked by its ${UNFINISHED} file; it is no good as a backup and can be deleted once you have looked at it.`
      : 'Nothing was written.';
    const out = new Error(`The profile could not be backed up: ${whyFailed(err)}. Nothing in the profile was changed. ${where}`);
    out.code = 'BACKUP_FAILED';
    out.dest = dest;
    log.warn('profile backup refused', { made });
    throw out;
  }
}

// The manifest of a backup that is still whole by the sizes and hashes it
// recorded, or null: an UNFINISHED marker, no backup.json, one that is not a
// manifest, a listed file gone, a different size or other bytes, a listed path
// that leaves the backup. Sizes first, so a file gone answers without hashing.
// A large backup takes seconds to hash: onProgress gets { phase: 'check', files,
// totalFiles, bytes, totalBytes, path: '' }, at most every 200 ms, and always at
// the end of a read that holds.
async function readBackupManifest(dest, { onProgress = null } = {}) {
  if (await fs.promises.lstat(path.join(dest, UNFINISHED)).then(() => true, () => false)) return null;
  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(path.join(dest, MANIFEST), 'utf8'));
  } catch {
    return null;
  }
  if (!manifest || manifest.v !== 1 || !Array.isArray(manifest.files) || !manifest.history) return null;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !Number.isInteger(entry.bytes) || typeof entry.sha256 !== 'string') return null;
    if (entry.path.split(/[\\/]/).some((seg) => !seg || seg === '.' || seg === '..') || path.isAbsolute(entry.path)) return null;
    try {
      const stat = await fs.promises.lstat(path.join(dest, ...entry.path.split('/')));
      if (!stat.isFile() || stat.size !== entry.bytes) return null;
    } catch {
      return null;
    }
  }
  const totalFiles = manifest.files.length;
  const totalBytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
  const say = (files, bytes) => {
    if (!onProgress) return;
    try {
      onProgress({ phase: 'check', files, totalFiles, bytes, totalBytes, path: '' });
    } catch (err) {
      log.warn('a backup progress listener threw', { error: shown(err.message) });
    }
  };
  let files = 0;
  let bytes = 0;
  let lastSaid = 0;
  for (const entry of manifest.files) {
    try {
      const { sha256 } = await hashFile(path.join(dest, ...entry.path.split('/')), { createReadStream: fs.createReadStream });
      if (sha256 !== entry.sha256) return null;
    } catch {
      return null;
    }
    files += 1;
    bytes += entry.bytes;
    if (Date.now() - lastSaid >= PROGRESS_EVERY_MS) {
      lastSaid = Date.now();
      say(files, bytes);
    }
  }
  say(files, bytes);
  return manifest;
}

const STORE_PROBLEM_KEYS = new Set([STORE_FILE, 'chat-data.json']);

// Keys, a vault or settings the move would carry: a profile with only these is worth
// moving, or the owner enters every key again.
function holdsKeysOrSettings(reader) {
  const json = (rel) => {
    const read = reader.readFile(rel);
    if (!read.ok) return {};
    try {
      return JSON.parse(read.data.toString('utf8')) || {};
    } catch {
      return {};
    }
  };
  const chatData = json('chat-data.json');
  if (Object.values(chatData.apiTokens || {}).some(Boolean)) return true;
  if (chatData.anthropicOAuth && chatData.anthropicOAuth.accessToken) return true;
  const settings = chatData.settings && typeof chatData.settings === 'object' ? chatData.settings : {};
  const hasKey = (section) => Object.values(settings[section] || {}).some((v) => v && v.apiKey);
  if (hasKey('webSearch') || hasKey('imageGeneration')) return true;
  if (settingsWouldMove(settings)) return true;
  return Object.entries(json('config.json')).some(([k, v]) => k.startsWith('__vault_') && v);
}

// { found, chats, messages, cases, bytes, schemaProblem, customCasesRoot,
// customCases, customCasesMissing }. Never throws, and never answers "nothing here" for a profile
// it could not read: a store or a chat-data.json the reader refuses is found,
// with schemaProblem saying why. customCasesRoot (through shown) is a cases
// root outside the profile's own folder, which neither the backup nor the move
// carries; customCases is how many directories it holds, null when it is not
// there (customCasesMissing) or cannot be read.
async function detectOldProfile(userDataDir, { readHistory = readHistoryChats, reader = null, env = process.env } = {}) {
  const nothing = { found: false, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: null, customCasesRoot: null, customCases: 0, customCasesMissing: false };
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
  let settingRoot;
  let customCasesRoot;
  let customCases;
  let customCasesMissing;
  try {
    settingRoot = settingRootFrom(root, safe);
    customCasesRoot = customRootOf(root, settingRoot, env);
    ({ customCases, customCasesMissing } = customCasesRoot ? await readCaseRoot(customCasesRoot) : NO_CASE_ROOT);
    history = await readHistory({ reader: safe });
    // With the root empty the cases are the ones in the profile's own folder,
    // where the setup's screen tells the owner to put them.
    source = readDesktopSource({ userDataDir: root, reader: safe, secrets: 'needs-desktop', history, customRootEmpty: customCases === 0 });
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
  const keysOrSettings = holdsKeysOrSettings(safe);
  const found = Boolean(
    schemaProblem || inventory.chats.length || inventory.cases.length
    || settingRoot || (customCases !== 0 && !customCasesMissing) || attention.some((a) => a.category === 'case')
    || keysOrSettings
  );
  if (!found) return nothing;
  let bytes = 0;
  try {
    const { files } = await listProfile(root, { ...fs.promises }, { strict: false, withStore: true });
    bytes = files.reduce((n, f) => n + f.size, 0);
  } catch (err) {
    log.debug('profile size not read', { code: err.code });
  }
  return {
    found,
    chats: inventory.chats.length,
    messages,
    cases: inventory.cases.length,
    bytes,
    schemaProblem,
    customCasesRoot: customCasesRoot ? shown(customCasesRoot, 400) : null,
    customCases,
    customCasesMissing,
    ...(keysOrSettings ? { keysOrSettings: true } : {})
  };
}

module.exports = { detectOldProfile, backupProfile, backupDirFor, readBackupManifest, readCaseRoot, EXCLUDED_DIRS };
