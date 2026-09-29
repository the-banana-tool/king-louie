// src/migration/desktop-history.js
// Desktop import (fleet stage 7 §3.8) reads a profile's chats from its
// history.sqlite (recall spec stage H1). The file is checked with the safe
// reader's checkFile, opened read-only, and snapshotted with node:sqlite's
// online backup API into a private temp folder, which is then opened and
// read. The backup reads a consistent snapshot even while the desktop app
// is writing (WAL included), which a byte copy of the file and its WAL
// cannot promise. A read-only open of a WAL database can leave its -wal and
// -shm files beside it (SQLite needs its shared-memory index); run as root,
// SQLite gives them the database file's owner, and the desktop's next open
// uses them as usual.
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
  let source = null;
  let snapshot = null;
  try {
    const file = path.join(dir, 'history.sqlite');
    source = HistoryStore.open(checked.path, { readonly: true });
    await backup(source.db, file);
    source.close();
    source = null;
    snapshot = HistoryStore.open(file, { readonly: true });
    return { found: true, chats: snapshot.listChats({ messages: true }).map(forImport), attention };
  } catch (err) {
    attention.push({
      category: 'source',
      key: 'history.sqlite',
      note: `could not be read (${err.message}); close King Louie on the desktop and import again`
    });
    return { found: true, chats: [], attention };
  } finally {
    if (source) source.close();
    if (snapshot) snapshot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { readHistoryChats };
