// src/service/commands/history.js
// `king-louie-service history import <file>` (recall spec §10.2, §12; stage
// H4, owner ruling R-H4-4): one conversation file (a Claude Code session, a
// Markdown transcript, a King Louie chat export) becomes a chat in the data
// dir's history store.
//
// It runs only as the account that owns the data dir, with the service
// stopped, and never as root or Administrator: what an administrator writes
// there is theirs, and the service could not use it. It builds no core: the
// store is opened directly, so nothing moves out of chat-data.json and no
// embedder starts. An imported chat's chunks stay on this machine (R-H4-2),
// and an import never writes into an existing chat (R-H4-8).
//
// Windows residual: src/ cannot read a folder's owner there without the ACL
// cmdlets it avoids, so the owner is not checked. An elevated prompt is
// refused; otherwise the operating system decides (an account that cannot
// write the data dir fails to open the store). A service installed under
// LOCAL SERVICE therefore has no CLI import: its owner imports from the
// attached desktop.
//
// CLI output goes to io.stdout and io.stderr on purpose.
const fs = require('fs');
const path = require('path');
const { isAdmin: defaultIsAdmin } = require('./admin-check');

const HISTORY_USAGE = 'Usage: king-louie-service history import <file> [--pattern ID] [--data-dir DIR]\n';

const KIND_NAMES = Object.freeze({
  'claude-code-jsonl': 'a Claude Code session',
  'markdown-transcript': 'a Markdown transcript',
  'king-louie-json': 'a King Louie chat export'
});

// Text from the file (a title, a pattern label, an importer's sentence that
// names the file) on the administrator's terminal: every control, bidi and
// line-separator character is shown as "?", so a title cannot redraw the
// line it is on or add one that reads as this program's own.
const UNPRINTABLE_RANGES = Object.freeze([
  [0x00, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2028, 0x2029], [0x2066, 0x2069]
]);
const unprintable = (codePoint) => UNPRINTABLE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
const plain = (value) => Array.from(
  String(value === null || value === undefined ? '' : value),
  (ch) => (unprintable(ch.codePointAt(0)) ? '?' : ch)
).join('');

// How many chats chat-data.json still holds: 0 when there is no such file
// or its list is empty, null when the file is there and cannot be read as
// one (the caller refuses).
function chatsLeftInJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err && err.code === 'ENOENT' ? 0 : null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.chats === undefined) return 0;
  return Array.isArray(data.chats) ? data.chats.length : null;
}

async function runHistoryCommand({ sub, arg, extra, flags = {}, dataDir, io, deps = {} }) {
  // No fail-open default: a caller that forgets this would write a running
  // service's store underneath it.
  if (typeof deps.runningServicePid !== 'function') throw new TypeError('runHistoryCommand needs deps.runningServicePid');
  const platform = deps.platform || process.platform;
  const isAdmin = deps.isAdmin || (() => defaultIsAdmin({ platform }));
  // The effective uid: it is the one new files would belong to.
  const getuid = deps.getuid || (() => (typeof process.geteuid === 'function' ? process.geteuid() : -1));
  const statDataDir = deps.statDataDir || fs.lstatSync;

  if (sub !== 'import' || typeof arg !== 'string' || !arg || extra !== undefined) {
    io.stderr.write(HISTORY_USAGE);
    return 2;
  }
  const target = path.resolve(dataDir);
  const posix = platform !== 'win32';

  // 1. Never as root or Administrator.
  if (await isAdmin()) {
    let owner = '';
    if (posix) {
      try {
        const { uid } = statDataDir(target);
        if (Number.isInteger(uid)) owner = ` ${target} belongs to uid ${uid}.`;
      } catch { /* the refusal stands without the owner */ }
    }
    io.stderr.write(`Run this as the account that owns ${target}, not as root or Administrator: an import written by an administrator would leave files the service cannot use.${owner}\n`);
    return 1;
  }

  // The data dir must be there already, as a real directory: this command
  // creates the history store in it, never the dir, and follows no link.
  let dirStat;
  try {
    dirStat = statDataDir(target);
  } catch (err) {
    io.stderr.write(err && err.code === 'ENOENT'
      ? `The data dir ${target} does not exist.\n`
      : `Cannot check the data dir ${target}: ${plain(err && err.message)}\n`);
    return 1;
  }
  const isLink = typeof dirStat.isSymbolicLink === 'function' && dirStat.isSymbolicLink();
  const isDir = typeof dirStat.isDirectory !== 'function' || dirStat.isDirectory();
  if (isLink || !isDir) {
    io.stderr.write(`The data dir ${target} is not a directory (links are refused).\n`);
    return 1;
  }

  // 2. POSIX: only the data dir's owner. (Windows: see the top of this file.)
  if (posix) {
    if (!Number.isInteger(dirStat.uid)) {
      io.stderr.write(`The owner of ${target} could not be read; this runs only as the account that owns it.\n`);
      return 1;
    }
    if (getuid() !== dirStat.uid) {
      io.stderr.write(`${target} belongs to uid ${dirStat.uid}; run this as that account.\n`);
      return 1;
    }
  }

  // 3. A running service holds the store.
  const pid = deps.runningServicePid(dataDir);
  if (pid) {
    io.stderr.write(`${require('./stop').stopFirstText(pid, dataDir)}\n`);
    return 1;
  }

  // 4. The file.
  const filePath = path.resolve(arg);
  let isFile = false;
  try {
    isFile = fs.statSync(filePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    io.stderr.write(`No such file: ${plain(filePath)}\n`);
    return 1;
  }

  // Required here: every profile's CLI loads this file's caller.
  const { HistoryStore, MIGRATION_MARKER, previewImport, importChat, sweepUnfinishedImports } = require('../../history');
  const pattern = typeof flags.pattern === 'string' && flags.pattern ? flags.pattern : undefined;

  // Read once before anything is opened: a file no importer takes, or a
  // pattern that does not fit, creates no store.
  let preview;
  try {
    preview = await previewImport(filePath, { pattern });
  } catch (err) {
    io.stderr.write(`${plain((err && err.message) || err)}\n`);
    return 1;
  }

  // 5. Chats still in chat-data.json (a data dir from before the history
  // store that the service has not started on since, or chats that could
  // not be moved). The service's move takes a chat it finds in the store
  // under a JSON chat's id for that chat, and this command builds no core
  // to know those ids, so it waits for the move. Checked before a store is
  // created; a store that exists is asked for its marker below.
  const dbPath = path.join(target, 'history.sqlite');
  const pending = chatsLeftInJson(path.join(target, 'chat-data.json'));
  const waitForMove = () => {
    const what = pending === null
      ? 'chat-data.json in this data dir could not be read'
      : `${pending} chat${pending === 1 ? ' is' : 's are'} still in chat-data.json in this data dir`;
    io.stderr.write(`${what}, and the service has not finished moving chats into the history store. Start the service once first, stop it, then run this again. If chats stay in chat-data.json after that (the app's chat list says how many could not be moved), import from the desktop app instead.\n`);
    return 1;
  };
  if (pending !== 0 && !fs.existsSync(dbPath)) return waitForMove();

  let store;
  try {
    // A data dir that was never started has no history.sqlite: it is created
    // at the current schema, as the service would.
    store = HistoryStore.open(dbPath);
    if (pending !== 0 && !store.getMeta(MIGRATION_MARKER)) return waitForMove();
    // What a crash in the middle of an earlier import left.
    sweepUnfinishedImports(store);
    const out = await importChat({ store, filePath, pattern });
    const chatId = plain(out.chatId);
    if (!out.imported) {
      io.stdout.write(`Already imported as ${chatId}.\n`);
      return 0;
    }
    const ref = store.chatRef(out.chatId);
    const title = plain(ref && typeof ref.title === 'string' ? ref.title : preview.title);
    const kind = KIND_NAMES[out.kind] || plain(out.kind);
    io.stdout.write(`Imported ${kind}: "${title}", ${out.messages} message${out.messages === 1 ? '' : 's'}.\n`);
    io.stdout.write(`Chat id: ${chatId}\n`);
    if (out.kind === 'markdown-transcript' && typeof preview.pattern === 'string') {
      const fits = Array.isArray(preview.patterns) ? preview.patterns : [];
      const named = (p) => `${plain(p.id)} (${plain(p.label)})`;
      const used = fits.find((p) => p.id === preview.pattern) || { id: preview.pattern, label: '' };
      io.stdout.write(`Heading pattern: ${used.label ? named(used) : plain(used.id)}.\n`);
      const others = fits.filter((p) => p.id !== preview.pattern);
      if (!pattern && others.length) {
        io.stdout.write(`Other patterns that fit this file: ${others.map(named).join(', ')}. To use one, delete this chat in the app and import the file again with --pattern <id>.\n`);
      }
    }
    return 0;
  } catch (err) {
    io.stderr.write(`${plain((err && err.message) || err)}\n`);
    return 1;
  } finally {
    if (store) {
      try { store.close(); } catch { /* already closed */ }
    }
  }
}

module.exports = { runHistoryCommand, HISTORY_USAGE };
