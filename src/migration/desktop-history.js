// src/migration/desktop-history.js
// Desktop import (fleet stage 7 §3.8) reads a profile's chats from its
// history.sqlite (recall spec stage H1). The file is checked with the safe
// reader's checkFile and snapshotted with node:sqlite's online backup API into
// a private temp folder, which is then opened and read. The backup reads a
// consistent snapshot even while the desktop app is writing (WAL included),
// which a byte copy of the file and its WAL cannot promise.
//
// A plain read-only open of a WAL database leaves -wal and -shm files beside
// it (SQLite needs its shared-memory index), and the desktop never writes into
// an old profile's store (attach stage 2 §6.5). So a store at rest, its WAL
// empty or absent, is opened immutable, which creates nothing, and is checked
// afterwards for a writer that came along meanwhile. Only a store with a WAL to
// read gets the plain read-only open: then the -wal is already there, it is not
// changed, and at most a missing -shm is made, which the next open rebuilds
// anyway.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite = require('node:sqlite');
const { HistoryStore, DERIVED_CHAT_KEYS } = require('../history');

function forImport(chat) {
  const out = { ...chat };
  for (const key of DERIVED_CHAT_KEYS) delete out[key];
  out.messages = (chat.messages || []).map(({ seq: _seq, ...message }) => message);
  return out;
}

const sizeOf = (file) => {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
};

// What says whether anything wrote to the store: the main file's size and
// mtime and how much its WAL and rollback journal hold.
function storeMark(file) {
  const main = fs.statSync(file);
  return `${main.size}:${main.mtimeMs}:${sizeOf(`${file}-wal`)}:${sizeOf(`${file}-journal`)}`;
}
const storeAtRest = (file) => sizeOf(`${file}-wal`) === 0 && sizeOf(`${file}-journal`) === 0;

const OPEN_OPTIONS = { readonly: true, allowOlderSchema: true };

function countChats(store) {
  const chats = store.listChats();
  return { chats: chats.length, messages: chats.reduce((n, c) => n + c.messageCount, 0) };
}

// A path SQLite will not take as a URI (a UNC share): the plain open instead.
function openImmutable(file) {
  try {
    return HistoryStore.open(file, { ...OPEN_OPTIONS, immutable: true });
  } catch (err) {
    if (/unable to open/i.test(err.message)) return null;
    throw err;
  }
}

async function backUpFrom(store, out, backup) {
  try {
    await backup(store.db, out);
    return countChats(store);
  } finally {
    store.close();
  }
}

// Snapshots the store at `file` into `out` and answers the store's own chat
// and message counts, read right after the backup. Throws what the open or the
// backup threw: a schema the reader refuses, a locked or corrupt file.
async function snapshotHistoryFile(file, out, { backup = sqlite.backup } = {}) {
  if (storeAtRest(file)) {
    const mark = storeMark(file);
    const store = openImmutable(file);
    if (store) {
      const counts = await backUpFrom(store, out, backup);
      if (storeMark(file) === mark) return counts;
      // Something wrote while an immutable connection was reading (immutable
      // takes no locks): that read proves nothing. SQLite's own locks now.
      fs.rmSync(out, { force: true });
    }
  }
  return backUpFrom(HistoryStore.open(file, OPEN_OPTIONS), out, backup);
}

async function readHistoryChats({ reader, tmpRoot = os.tmpdir(), backup = sqlite.backup }) {
  const attention = [];
  const checked = reader.checkFile('history.sqlite');
  if (!checked.ok) {
    if (!checked.missing) attention.push({ category: 'source', key: 'history.sqlite', note: checked.reason });
    return { found: false, chats: [], attention };
  }
  if (typeof backup !== 'function') {
    // node:sqlite's backup() arrived in Node.js 22.16 and 23.8; closing the
    // desktop app would not help.
    attention.push({
      category: 'source',
      key: 'history.sqlite',
      note: `could not be read: importing chats from history.sqlite needs Node.js 22.16 or later (23.8 or later on Node 23), and this is ${process.versions.node}; upgrade Node.js and import again`
    });
    return { found: true, chats: [], attention };
  }
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'kl-import-history-'));
  let snapshot = null;
  try {
    const file = path.join(dir, 'history.sqlite');
    // An H1 desktop's file is schema 1: read as it is, never upgraded (only
    // chats and messages are read).
    await snapshotHistoryFile(checked.path, file, { backup });
    snapshot = HistoryStore.open(file, { ...OPEN_OPTIONS, immutable: true });
    return { found: true, chats: snapshot.listChats({ messages: true }).map(forImport), attention };
  } catch (err) {
    attention.push({
      category: 'source',
      key: 'history.sqlite',
      note: `could not be read (${err.message}); close King Louie on the desktop and import again`
    });
    return { found: true, chats: [], attention };
  } finally {
    if (snapshot) snapshot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { readHistoryChats, snapshotHistoryFile, countChats };
