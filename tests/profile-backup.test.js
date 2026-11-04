// tests/profile-backup.test.js
// The old profile, found and backed up (attach stage 2, spec §6.5). The real
// profile holds real cases and chats, so what matters most here: a store the
// reader refuses is never read as an empty profile, the source is never
// changed, and a backup that cannot be proved is refused.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { seedChat, downgradeToVersion1 } = require('./helpers/history-fixture');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const {
  detectOldProfile, backupProfile, backupDirFor, readBackupManifest, EXCLUDED_DIRS
} = require('../src/migration/profile-backup');
const { snapshotHistoryFile } = require('../src/migration/desktop-history');

const FIXED = Date.parse('2026-11-03T12:00:00.000Z');
const NO_WAIT = [1, 1];

const roots = [];
afterEach(() => {
  closeOpenHistoryStores();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function tempParent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-backup-'));
  roots.push(dir);
  return dir;
}
function emptyProfile() {
  const dir = path.join(tempParent(), 'king-louie');
  fs.mkdirSync(dir);
  return dir;
}
function put(root, rel, text = 'data') {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
function seedStore(root, { close = true } = {}) {
  const store = HistoryStore.open(path.join(root, 'history.sqlite'));
  seedChat(store, { id: 'chat-a', title: 'Lakeside lot', messages: [
    { sender: 'user', text: 'first' }, { sender: 'assistant', text: 'second' }, { sender: 'user', text: 'third' }
  ] });
  seedChat(store, { id: 'chat-b', title: 'Other', messages: [
    { sender: 'user', text: 'fourth' }, { sender: 'assistant', text: 'fifth' }
  ] });
  if (close) store.close();
  return store;
}
function fullProfile() {
  const root = emptyProfile();
  seedStore(root);
  put(root, 'chat-data.json', JSON.stringify({ settings: { theme: 'dark' } }));
  put(root, 'cases/x/.kl/budget.json', '{"usd":1}');
  put(root, 'cases/x/logs/notes.txt', 'a case folder named logs is not the cache');
  put(root, 'cases/x/sources/history.sqlite', 'a document that happens to have the name');
  put(root, 'Cache/data_0', 'cache');
  put(root, 'Network/Cookies', 'chromium');
  put(root, 'logs/app.log', 'log');
  return root;
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function treeHashes(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(root, p)] = sha(p);
    }
  };
  walk(root);
  return out;
}
const destFor = (root) => path.join(path.dirname(root), 'king-louie.backup-test');
function countsIn(file) {
  const store = HistoryStore.open(file, { readonly: true, allowOlderSchema: true, immutable: true });
  try {
    const chats = store.listChats();
    return { chats: chats.length, messages: chats.reduce((n, c) => n + c.messageCount, 0) };
  } finally {
    store.close();
  }
}
const appendTo = (store, chatId, id) => store.appendMessage(chatId, { id, sender: 'user', text: `later ${id}`, timestamp: '2026-01-02T09:00:00.000Z' }, { updatedAt: '2026-01-02T09:00:00.000Z' });
const isBackupFailed = (dest) => (err) => {
  assert.strictEqual(err.code, 'BACKUP_FAILED');
  assert.strictEqual(err.dest, dest);
  return true;
};

describe('EXCLUDED_DIRS', () => {
  it('names the spec\'s nine caches, and no store', () => {
    for (const name of ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'blob_storage', 'Session Storage', 'Local Storage', 'Service Worker', 'logs']) {
      assert.ok(EXCLUDED_DIRS.includes(name), name);
    }
    for (const store of ['cases', 'memory', 'cron', 'models', 'executors', 'contact', 'skills', 'workflows', 'browser-profiles', 'tool-results']) {
      assert.ok(!EXCLUDED_DIRS.includes(store), store);
    }
  });

  it('leaves out Network, whose Cookies file a running Electron holds locked', () => {
    assert.ok(EXCLUDED_DIRS.includes('Network'));
  });
});

describe('detectOldProfile', () => {
  it('empty dir is not found', async () => {
    const res = await detectOldProfile(emptyProfile());
    assert.deepStrictEqual(res, { found: false, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: null, customCasesRoot: null, customCases: 0 });
  });

  it('a directory that is not there is not found', async () => {
    const res = await detectOldProfile(path.join(tempParent(), 'nothing-here'));
    assert.strictEqual(res.found, false);
    assert.strictEqual(res.schemaProblem, null);
  });

  it('a profile with a store is found with counts', async () => {
    const root = emptyProfile();
    seedStore(root);
    put(root, 'cases/mvcase-1/.kl/budget.json', '{}');
    const res = await detectOldProfile(root);
    assert.strictEqual(res.found, true);
    assert.strictEqual(res.chats, 2);
    assert.strictEqual(res.messages, 5);
    assert.strictEqual(res.cases, 1);
    assert.ok(res.bytes >= fs.statSync(path.join(root, 'history.sqlite')).size);
    assert.strictEqual(res.schemaProblem, null);
  });

  it('counts a chat still in chat-data.json, and that file alone is a profile', async () => {
    const root = emptyProfile();
    put(root, 'chat-data.json', JSON.stringify({ chats: [{ id: 'old-1', title: 'Old', messages: [{ id: 'm', sender: 'user', text: 'hi' }, { id: 'n', sender: 'assistant', text: 'yes' }] }] }));
    const res = await detectOldProfile(root);
    assert.strictEqual(res.found, true);
    assert.strictEqual(res.chats, 1);
    assert.strictEqual(res.messages, 2);
  });

  it('chat-data.json with a case root is found; with only settings it is not', async () => {
    const withRoot = emptyProfile();
    put(withRoot, 'chat-data.json', JSON.stringify({ settings: { cases: { root: 'D:\\elsewhere' } } }));
    assert.strictEqual((await detectOldProfile(withRoot)).found, true);
    const bare = emptyProfile();
    put(bare, 'chat-data.json', JSON.stringify({ settings: { theme: 'dark' } }));
    assert.strictEqual((await detectOldProfile(bare)).found, false);
  });

  it('a case folder with nothing else is found', async () => {
    const root = emptyProfile();
    put(root, 'cases/mvcase-1/brief.md', 'x');
    const res = await detectOldProfile(root);
    assert.strictEqual(res.found, true);
    assert.strictEqual(res.cases, 1);
  });

  it('store the reader refuses is found with schemaProblem (a file holding text)', async () => {
    const root = emptyProfile();
    put(root, 'history.sqlite', 'this is not a database, it is a sentence long enough to be read as a header');
    const res = await detectOldProfile(root);
    assert.strictEqual(res.found, true);
    assert.ok(res.schemaProblem, 'names the problem');
    assert.strictEqual(res.chats, 0);
    assert.deepStrictEqual(fs.readdirSync(root), ['history.sqlite'], 'a refused store gets no -wal or -shm either');
  });

  it('a store of a newer schema is found with schemaProblem', async () => {
    const root = emptyProfile();
    seedStore(root);
    const raw = new sqlite.DatabaseSync(path.join(root, 'history.sqlite'));
    raw.exec('UPDATE schema_version SET version = 9999');
    raw.close();
    const before = sha(path.join(root, 'history.sqlite'));
    const res = await detectOldProfile(root);
    assert.strictEqual(res.found, true);
    assert.ok(res.schemaProblem);
    assert.deepStrictEqual(fs.readdirSync(root), ['history.sqlite'], 'a refused store gets no -wal or -shm either');
    assert.strictEqual(sha(path.join(root, 'history.sqlite')), before);
  });

  it('a store of an older schema is read, not refused', async () => {
    const root = emptyProfile();
    seedStore(root);
    const raw = new sqlite.DatabaseSync(path.join(root, 'history.sqlite'));
    downgradeToVersion1(raw);
    raw.close();
    const res = await detectOldProfile(root);
    assert.strictEqual(res.schemaProblem, null);
    assert.strictEqual(res.chats, 2);
    assert.strictEqual(res.messages, 5);
  });

  it('a history.sqlite the safe reader refuses is found, never an empty profile', async () => {
    const root = emptyProfile();
    fs.mkdirSync(path.join(root, 'history.sqlite'));
    const res = await detectOldProfile(root);
    assert.strictEqual(res.found, true);
    assert.ok(res.schemaProblem);
  });

  it('a store another process holds locked is found with schemaProblem', async () => {
    const root = emptyProfile();
    seedStore(root);
    const holder = new sqlite.DatabaseSync(path.join(root, 'history.sqlite'));
    holder.exec('PRAGMA locking_mode = EXCLUSIVE');
    holder.exec("UPDATE chats SET title = 'held' WHERE id = 'chat-a'");
    try {
      const res = await detectOldProfile(root);
      assert.strictEqual(res.found, true);
      assert.ok(res.schemaProblem, 'a locked store is a problem, not an empty one');
    } finally {
      holder.close();
    }
  });

  it('a chat-data.json that is not JSON is a problem, never an empty profile', async () => {
    const root = emptyProfile();
    put(root, 'chat-data.json', '{ "chats": [ cut off');
    const res = await detectOldProfile(root);
    assert.strictEqual(res.found, true);
    assert.ok(res.schemaProblem);
  });

  it('a reader that throws is a problem, never an empty profile', async () => {
    const root = emptyProfile();
    const res = await detectOldProfile(root, { readHistory: async () => { throw new Error('boom'); } });
    assert.strictEqual(res.found, true);
    assert.match(res.schemaProblem, /boom/);
  });

  it('shows a problem through shown: no control or bidi characters', async () => {
    const root = emptyProfile();
    const res = await detectOldProfile(root, {
      readHistory: async () => ({ found: true, chats: [], attention: [{ category: 'source', key: 'history.sqlite', note: 'bad\u202Etext\nsecond line' }] })
    });
    assert.ok(res.schemaProblem);
    assert.ok(!/[\u202E\n]/.test(res.schemaProblem));
  });

  it('takes the reader it is given', async () => {
    const root = emptyProfile();
    const calls = [];
    const reader = {
      root,
      readFile: () => ({ ok: false, missing: true }),
      checkFile: () => ({ ok: false, missing: true }),
      listDir: () => ({ dirs: [], refused: [] }),
      listFiles: () => ({ files: [], refused: [] })
    };
    const res = await detectOldProfile(root, { reader, readHistory: async (args) => { calls.push(args.reader); return { found: false, chats: [], attention: [] }; } });
    assert.strictEqual(calls[0], reader);
    assert.strictEqual(res.found, false);
  });
});

describe('the source is never touched', () => {
  it('finding and backing up a store at rest creates no -wal or -shm and leaves its hash', async () => {
    const root = fullProfile();
    const file = path.join(root, 'history.sqlite');
    const before = sha(file);
    const entries = fs.readdirSync(root).sort();
    await detectOldProfile(root);
    assert.deepStrictEqual(fs.readdirSync(root).sort(), entries, 'detect adds nothing');
    assert.strictEqual(sha(file), before);
    await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED });
    assert.deepStrictEqual(fs.readdirSync(root).sort(), entries, 'backup adds nothing');
    assert.strictEqual(sha(file), before);
  });

  it('backs up the whole tree with the source byte for byte unchanged', async () => {
    const root = fullProfile();
    const before = treeHashes(root);
    await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED });
    assert.deepStrictEqual(treeHashes(root), before);
  });

  it('a live -wal is in the snapshot, and neither it nor the store changes', async () => {
    const root = emptyProfile();
    const live = seedStore(root, { close: false });
    live.db.exec('PRAGMA wal_autocheckpoint = 0');
    appendTo(live, 'chat-a', 'only-in-wal');
    const file = path.join(root, 'history.sqlite');
    const wal = `${file}-wal`;
    assert.ok(fs.statSync(wal).size > 0, 'the message is in the WAL');
    const [mainBefore, walBefore] = [sha(file), sha(wal)];

    const res = await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED });
    assert.deepStrictEqual(res.history, { chats: 2, messages: 6 });
    assert.deepStrictEqual(countsIn(path.join(destFor(root), 'history.sqlite')), { chats: 2, messages: 6 });
    assert.strictEqual(sha(file), mainBefore);
    assert.strictEqual(sha(wal), walBefore);
    live.close();
  });

  it('a -wal a crash left behind is in the snapshot and unchanged', async () => {
    const liveRoot = emptyProfile();
    const live = seedStore(liveRoot, { close: false });
    live.db.exec('PRAGMA wal_autocheckpoint = 0');
    appendTo(live, 'chat-a', 'only-in-wal');
    const root = emptyProfile();
    for (const name of ['history.sqlite', 'history.sqlite-wal']) fs.copyFileSync(path.join(liveRoot, name), path.join(root, name));
    live.close();
    const [mainBefore, walBefore] = [sha(path.join(root, 'history.sqlite')), sha(path.join(root, 'history.sqlite-wal'))];

    const found = await detectOldProfile(root);
    assert.strictEqual(found.messages, 6);
    const res = await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED });
    assert.deepStrictEqual(res.history, { chats: 2, messages: 6 });
    assert.strictEqual(sha(path.join(root, 'history.sqlite')), mainBefore);
    assert.strictEqual(sha(path.join(root, 'history.sqlite-wal')), walBefore);
  });

  const writesOnFirstCall = (root) => {
    const state = { calls: 0 };
    state.backup = async (db, out) => {
      state.calls += 1;
      await sqlite.backup(db, out);
      if (state.calls === 1) {
        const writer = HistoryStore.open(path.join(root, 'history.sqlite'));
        appendTo(writer, 'chat-a', 'written-meanwhile');
        writer.close();
      }
    };
    return state;
  };

  it('a store written during the snapshot is snapshotted again through SQLite', async () => {
    const root = emptyProfile();
    seedStore(root);
    const out = path.join(path.dirname(root), 'snapshot.sqlite');
    const state = writesOnFirstCall(root);
    const counts = await snapshotHistoryFile(path.join(root, 'history.sqlite'), out, { backup: state.backup });
    assert.strictEqual(state.calls, 2);
    assert.deepStrictEqual(counts, { chats: 2, messages: 6 });
    assert.deepStrictEqual(countsIn(out), { chats: 2, messages: 6 });
  });

  it('a backup whose store was written during the snapshot is refused', async () => {
    const root = emptyProfile();
    seedStore(root);
    const dest = destFor(root);
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED, backup: writesOnFirstCall(root).backup }), (err) => {
      isBackupFailed(dest)(err);
      assert.ok(err.message.includes('history.sqlite'));
      assert.match(err.message, /close any other King Louie/);
      return true;
    });
  });
});

describe('backupDirFor', () => {
  it('names the directory beside the profile, from the clock', () => {
    const root = path.join(os.tmpdir(), 'somewhere', 'king-louie');
    assert.strictEqual(backupDirFor(root, FIXED), path.join(os.tmpdir(), 'somewhere', 'king-louie.backup-20261103T120000000Z'));
    assert.strictEqual(backupDirFor(root, new Date(FIXED)), path.join(os.tmpdir(), 'somewhere', 'king-louie.backup-20261103T120000000Z'));
    assert.strictEqual(backupDirFor(root, () => FIXED), path.join(os.tmpdir(), 'somewhere', 'king-louie.backup-20261103T120000000Z'));
  });
});

describe('backupProfile', () => {
  it('backup copies files and snapshots the store', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    const res = await backupProfile({ userDataDir: root, dest, now: FIXED, appVersion: '9.9.9' });

    assert.strictEqual(res.dest, dest);
    assert.deepStrictEqual(res.history, { chats: 2, messages: 5 });
    for (const rel of ['chat-data.json', 'cases/x/.kl/budget.json', 'cases/x/logs/notes.txt', 'cases/x/sources/history.sqlite']) {
      assert.strictEqual(sha(path.join(dest, rel)), sha(path.join(root, rel)), rel);
    }
    assert.ok(!fs.existsSync(path.join(dest, 'history.sqlite-wal')));
    assert.ok(!fs.existsSync(path.join(dest, 'history.sqlite-shm')));
    for (const gone of ['Cache', 'Network', 'logs']) assert.ok(!fs.existsSync(path.join(dest, gone)), gone);

    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'backup.json'), 'utf8'));
    assert.strictEqual(manifest.v, 1);
    assert.strictEqual(manifest.from, root);
    assert.strictEqual(manifest.at, '2026-11-03T12:00:00.000Z');
    assert.strictEqual(manifest.appVersion, '9.9.9');
    assert.deepStrictEqual(manifest.history, { chats: 2, messages: 5 });
    const onDisk = treeHashes(dest);
    delete onDisk['backup.json'];
    assert.deepStrictEqual(
      Object.fromEntries(manifest.files.map((f) => [f.path.split('/').join(path.sep), f.sha256])),
      onDisk,
      'lists every file, with its hash'
    );
    for (const f of manifest.files) assert.strictEqual(f.bytes, fs.statSync(path.join(dest, f.path)).size, f.path);
    assert.strictEqual(res.files, manifest.files.length);
    assert.strictEqual(res.bytes, manifest.files.reduce((n, f) => n + f.bytes, 0));
    assert.deepStrictEqual(countsIn(path.join(dest, 'history.sqlite')), { chats: 2, messages: 5 });
  });

  it('a profile with no store backs up its files', async () => {
    const root = emptyProfile();
    put(root, 'chat-data.json', '{}');
    const res = await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED });
    assert.deepStrictEqual(res.history, { chats: 0, messages: 0 });
    assert.ok(!fs.existsSync(path.join(destFor(root), 'history.sqlite')));
  });

  it('a store of an older schema is backed up, not upgraded', async () => {
    const root = emptyProfile();
    seedStore(root);
    const raw = new sqlite.DatabaseSync(path.join(root, 'history.sqlite'));
    downgradeToVersion1(raw);
    raw.close();
    const res = await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED });
    assert.deepStrictEqual(res.history, { chats: 2, messages: 5 });
  });

  it('a case repository copies whole: .git, its logs, its empty directories', async () => {
    const root = emptyProfile();
    const repo = path.join(root, 'cases', 'mvcase-1');
    fs.mkdirSync(repo, { recursive: true });
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
    git(repo, 'init', '--quiet');
    put(repo, 'brief.md', 'the Lakeside lot');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'first');
    const head = git(repo, 'rev-parse', 'HEAD');

    const dest = destFor(root);
    await backupProfile({ userDataDir: root, dest, now: FIXED });
    const copy = path.join(dest, 'cases', 'mvcase-1');
    assert.ok(fs.existsSync(path.join(copy, '.git', 'logs', 'HEAD')), 'a logs folder below the top level stays');
    assert.ok(fs.statSync(path.join(copy, '.git', 'refs', 'tags')).isDirectory(), 'an empty directory stays');
    assert.strictEqual(git(copy, 'rev-parse', 'HEAD'), head);
    git(copy, 'fsck', '--full', '--no-progress');
    assert.strictEqual(git(copy, 'status', '--porcelain'), '');
  });

  it('dest exists is refused, and nothing is written', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    fs.mkdirSync(dest);
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED }), isBackupFailed(dest));
    assert.deepStrictEqual(fs.readdirSync(dest), []);
  });

  it('dest inside the profile is refused', async () => {
    const root = fullProfile();
    const dest = path.join(root, 'backup-here');
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED }), isBackupFailed(dest));
    assert.ok(!fs.existsSync(dest));
  });

  it('a copy whose size differs is refused: the half-made directory named, the source unchanged', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    const before = treeHashes(root);
    const fsImpl = {
      copyFile: async (from, to) => {
        fs.copyFileSync(from, to);
        if (path.basename(from) === 'budget.json') fs.truncateSync(to, 2);
      }
    };
    await assert.rejects(
      backupProfile({ userDataDir: root, dest, now: FIXED, fsImpl, retryDelaysMs: NO_WAIT }),
      (err) => {
        isBackupFailed(dest)(err);
        assert.ok(err.message.includes(dest), 'names the directory');
        assert.ok(err.message.includes('budget.json'), 'names the file');
        return true;
      }
    );
    assert.deepStrictEqual(treeHashes(root), before);
    assert.ok(fs.statSync(dest).isDirectory(), 'the half-made directory stays');
    assert.ok(!fs.existsSync(path.join(dest, 'backup.json')), 'no manifest for a failed backup');
  });

  it('a file that keeps changing under the copy is refused', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    const fsImpl = {
      copyFile: async (from, to) => {
        fs.copyFileSync(from, to);
        if (path.basename(from) === 'chat-data.json') fs.appendFileSync(from, ' ');
      }
    };
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED, fsImpl, retryDelaysMs: NO_WAIT }), isBackupFailed(dest));
  });

  it('same size, other bytes is refused', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    const fsImpl = {
      copyFile: async (from, to) => {
        fs.copyFileSync(from, to);
        if (path.basename(from) === 'budget.json') fs.writeFileSync(to, 'x'.repeat(fs.statSync(from).size));
      }
    };
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED, fsImpl, retryDelaysMs: NO_WAIT }), isBackupFailed(dest));
  });

  it('a file open for a moment (antivirus) is tried again', async () => {
    const root = fullProfile();
    let tries = 0;
    const fsImpl = {
      copyFile: async (from, to, mode) => {
        if (path.basename(from) === 'budget.json' && (tries += 1) === 1) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
        return fs.promises.copyFile(from, to, mode);
      }
    };
    await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED, fsImpl, retryDelaysMs: NO_WAIT });
    assert.strictEqual(tries, 2);
    assert.ok(fs.existsSync(path.join(destFor(root), 'cases', 'x', '.kl', 'budget.json')));
  });

  it('a retry over a read-only copy works (git objects are read-only)', async () => {
    const root = emptyProfile();
    const file = put(root, 'cases/x/.git/objects/ab/cd', 'object');
    fs.chmodSync(file, 0o444);
    let tries = 0;
    const fsImpl = {
      copyFile: async (from, to, mode) => {
        await fs.promises.copyFile(from, to, mode);
        if (path.basename(from) === 'cd' && (tries += 1) === 1) {
          fs.chmodSync(to, 0o666);
          fs.truncateSync(to, 1);
          fs.chmodSync(to, 0o444);
        }
      }
    };
    await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED, fsImpl, retryDelaysMs: NO_WAIT });
    assert.strictEqual(tries, 2);
    assert.strictEqual(fs.readFileSync(path.join(destFor(root), 'cases', 'x', '.git', 'objects', 'ab', 'cd'), 'utf8'), 'object');
    fs.chmodSync(file, 0o666);
  });

  it('a file that stays locked (Chrome running) is refused, naming the file and what to do', async () => {
    const root = fullProfile();
    put(root, 'browser-profiles/king-louie/Network/Cookies', 'held');
    const dest = destFor(root);
    const fsImpl = {
      copyFile: async (from, to, mode) => {
        if (from.includes('browser-profiles')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
        return fs.promises.copyFile(from, to, mode);
      }
    };
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED, fsImpl, retryDelaysMs: NO_WAIT }), (err) => {
      isBackupFailed(dest)(err);
      assert.ok(err.message.includes('browser-profiles/king-louie/Network/Cookies'));
      assert.match(err.message, /another program/);
      return true;
    });
  });

  it('a failure that retrying cannot help is refused at once', async () => {
    const root = fullProfile();
    let tries = 0;
    const fsImpl = { copyFile: async () => { tries += 1; throw Object.assign(new Error('ENOSPC: no space'), { code: 'ENOSPC' }); } };
    await assert.rejects(backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED, fsImpl, retryDelaysMs: NO_WAIT }), (err) => {
      assert.strictEqual(err.code, 'BACKUP_FAILED');
      assert.match(err.message, /disk is full/);
      return true;
    });
    assert.strictEqual(tries, 1);
  });

  it('a file gone before its copy is no failure, and the manifest says so', async () => {
    const root = fullProfile();
    const passing = put(root, 'DIPS-journal', 'chromium removes this at any moment');
    const fsImpl = {
      copyFile: async (from, to, mode) => {
        if (from === passing) fs.rmSync(passing, { force: true });
        return fs.promises.copyFile(from, to, mode);
      }
    };
    const res = await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED, fsImpl, retryDelaysMs: NO_WAIT });
    const manifest = await readBackupManifest(res.dest);
    assert.ok(manifest, 'still a whole backup');
    assert.deepStrictEqual(manifest.vanished, ['DIPS-journal']);
    assert.ok(!manifest.files.some((f) => f.path === 'DIPS-journal'));
  });

  it('a junction inside the profile is refused, and not followed out of it', { skip: process.platform !== 'win32' }, async () => {
    const root = fullProfile();
    const outside = path.join(path.dirname(root), 'outside');
    put(outside, 'secret.txt', 'not in the profile');
    fs.symlinkSync(outside, path.join(root, 'cases', 'x', 'jump'), 'junction');
    const dest = destFor(root);
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED }), (err) => {
      isBackupFailed(dest)(err);
      assert.ok(err.message.includes('cases/x/jump'));
      return true;
    });
    assert.ok(!fs.existsSync(dest), 'refused before anything is written');
  });

  it('a link inside the profile is refused', async (t) => {
    const root = fullProfile();
    const outside = put(path.dirname(root), 'outside.txt', 'not in the profile');
    try {
      fs.symlinkSync(outside, path.join(root, 'cases', 'x', 'link.txt'));
    } catch (err) {
      if (err.code === 'EPERM') return t.skip('symlinks need privilege here');
      throw err;
    }
    const dest = destFor(root);
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED }), isBackupFailed(dest));
    assert.ok(!fs.existsSync(dest));
  });

  it('a snapshot whose counts differ from the reader\'s is refused', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    const backup = async (db, out) => {
      await sqlite.backup(db, out);
      const raw = new sqlite.DatabaseSync(out);
      raw.exec("DELETE FROM chats WHERE id = 'chat-b'");
      raw.close();
    };
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED, backup }), (err) => {
      isBackupFailed(dest)(err);
      assert.match(err.message, /chats/);
      return true;
    });
  });

  it('a store that will not open is refused', async () => {
    const root = emptyProfile();
    put(root, 'history.sqlite', 'this is not a database, it is a sentence long enough to be read as a header');
    await assert.rejects(backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED }), isBackupFailed(destFor(root)));
  });

  it('a Node without the backup call is refused, naming what is needed', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED, backup: null }), (err) => {
      isBackupFailed(dest)(err);
      assert.match(err.message, /Node/);
      return true;
    });
  });

  it('a name with hidden characters reaches the refusal through shown', async () => {
    const root = fullProfile();
    const odd = put(root, 'cases/x/odd\u202Ename.txt', 'x');
    const fsImpl = {
      copyFile: async (from, to, mode) => {
        if (from === odd) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        return fs.promises.copyFile(from, to, mode);
      }
    };
    await assert.rejects(backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED, fsImpl, retryDelaysMs: NO_WAIT }), (err) => {
      assert.strictEqual(err.code, 'BACKUP_FAILED');
      assert.ok(!err.message.includes('\u202E'));
      return true;
    });
  });

  it('says how it is going, and a listener that throws changes nothing', async () => {
    const root = fullProfile();
    const seen = [];
    const res = await backupProfile({
      userDataDir: root,
      dest: destFor(root),
      now: FIXED,
      onProgress: (p) => { seen.push(p); throw new Error('a closed window'); }
    });
    assert.ok(seen.length >= 2);
    assert.strictEqual(seen[0].phase, 'snapshot');
    const last = seen[seen.length - 1];
    assert.strictEqual(last.phase, 'done');
    assert.strictEqual(last.files, res.files);
    assert.strictEqual(last.bytes, res.bytes);
  });
});

describe('a custom cases root', () => {
  const outsideRoot = (root, names = []) => {
    const outside = path.join(path.dirname(root), 'cases-elsewhere');
    fs.mkdirSync(outside);
    for (const name of names) fs.mkdirSync(path.join(outside, name));
    return outside;
  };

  it('the setting is named, with the directories there', async () => {
    const root = emptyProfile();
    const outside = outsideRoot(root, ['mvcase-1', 'mvcase-2', '.index']);
    put(root, 'chat-data.json', JSON.stringify({ settings: { cases: { root: outside } } }));
    const res = await detectOldProfile(root, { env: {} });
    assert.strictEqual(res.found, true);
    assert.strictEqual(res.customCasesRoot, outside);
    assert.strictEqual(res.customCases, 2);
    assert.strictEqual(res.cases, 0);
  });

  it('a relative setting resolves under the profile, as the runtime does', async () => {
    const root = emptyProfile();
    put(root, 'chat-data.json', JSON.stringify({ settings: { cases: { root: 'mine' } } }));
    put(root, 'mine/mvcase-1/brief.md', 'x');
    const res = await detectOldProfile(root, { env: {} });
    assert.strictEqual(res.customCasesRoot, path.join(root, 'mine'));
    assert.strictEqual(res.customCases, 1);
  });

  it('KL_CASES_ROOT is honoured when no setting names a root', async () => {
    const root = emptyProfile();
    seedStore(root);
    const outside = outsideRoot(root, ['mvcase-1']);
    const res = await detectOldProfile(root, { env: { KL_CASES_ROOT: outside } });
    assert.strictEqual(res.customCasesRoot, outside);
    assert.strictEqual(res.customCases, 1);
  });

  it('KL_CASES_ROOT holding cases makes a profile found on its own; empty, it does not', async () => {
    const root = emptyProfile();
    const outside = outsideRoot(root);
    assert.strictEqual((await detectOldProfile(root, { env: { KL_CASES_ROOT: outside } })).found, false);
    fs.mkdirSync(path.join(outside, 'mvcase-1'));
    const res = await detectOldProfile(root, { env: { KL_CASES_ROOT: outside } });
    assert.strictEqual(res.found, true);
    assert.strictEqual(res.customCases, 1);
  });

  it('the profile\'s own cases folder is no custom root', async () => {
    const root = emptyProfile();
    seedStore(root);
    const res = await detectOldProfile(root, { env: { KL_CASES_ROOT: path.join(root, 'cases') } });
    assert.strictEqual(res.customCasesRoot, null);
    assert.strictEqual(res.customCases, 0);
  });

  it('a root that is not there counts 0; one that cannot be read counts null', async () => {
    const root = emptyProfile();
    const missing = path.join(path.dirname(root), 'not-there');
    put(root, 'chat-data.json', JSON.stringify({ settings: { cases: { root: missing } } }));
    assert.strictEqual((await detectOldProfile(root, { env: {} })).customCases, 0);
    const file = put(path.dirname(root), 'a-file', 'x');
    put(root, 'chat-data.json', JSON.stringify({ settings: { cases: { root: file } } }));
    assert.strictEqual((await detectOldProfile(root, { env: {} })).customCases, null);
  });

  it('the backup records it in the manifest and its answer, and says nothing when there is none', async () => {
    const root = emptyProfile();
    const outside = outsideRoot(root, ['mvcase-1']);
    put(root, 'chat-data.json', JSON.stringify({ settings: { cases: { root: outside } } }));
    const res = await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED, env: {} });
    assert.strictEqual(res.customCasesRoot, outside);
    assert.strictEqual(res.customCases, 1);
    const manifest = await readBackupManifest(destFor(root));
    assert.strictEqual(manifest.customCasesRoot, outside);
    assert.strictEqual(manifest.customCases, 1);

    const plain = fullProfile();
    await backupProfile({ userDataDir: plain, dest: destFor(plain), now: FIXED, env: {} });
    const none = await readBackupManifest(destFor(plain));
    assert.strictEqual(none.customCasesRoot, null);
    assert.strictEqual(none.customCases, 0);
  });
});

describe('writes during the copy', () => {
  // Runs `act` once, right after the named file's copy.
  const afterCopyOf = (name, act) => {
    let done = false;
    return {
      copyFile: async (from, to, mode) => {
        await fs.promises.copyFile(from, to, mode);
        if (!done && path.basename(from) === name) {
          done = true;
          act();
        }
      }
    };
  };
  const refusedFor = async (root, fsImpl, named) => {
    const dest = destFor(root);
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED, fsImpl, retryDelaysMs: NO_WAIT }), (err) => {
      isBackupFailed(dest)(err);
      assert.ok(err.message.includes(named), err.message);
      assert.match(err.message, /close any other King Louie/);
      return true;
    });
    assert.strictEqual(await readBackupManifest(dest), null);
    assert.ok(!fs.existsSync(path.join(dest, 'backup.json')));
  };

  it('a store message and a case line after the snapshot: refused', async () => {
    const root = fullProfile();
    const facts = put(root, 'cases/x/facts.jsonl', '{"id":"f-0001"}\n');
    await refusedFor(root, afterCopyOf('facts.jsonl', () => {
      const writer = HistoryStore.open(path.join(root, 'history.sqlite'));
      appendTo(writer, 'chat-a', 'after-the-snapshot');
      writer.close();
      fs.appendFileSync(facts, '{"id":"f-0002"}\n');
    }), 'history.sqlite');
  });

  it('a case file changed after its copy: refused', async () => {
    const root = fullProfile();
    const facts = put(root, 'cases/x/facts.jsonl', '{"id":"f-0001"}\n');
    await refusedFor(root, afterCopyOf('facts.jsonl', () => fs.appendFileSync(facts, 'more\n')), 'cases/x/facts.jsonl');
  });

  it('chat-data.json changed after its copy: refused', async () => {
    const root = fullProfile();
    await refusedFor(root, afterCopyOf('chat-data.json', () => fs.appendFileSync(path.join(root, 'chat-data.json'), ' ')), 'chat-data.json');
  });

  it('config.json with the same size and a new mtime: refused', async () => {
    const root = fullProfile();
    const config = put(root, 'config.json', '{}');
    const later = new Date(Date.now() + 60000);
    await refusedFor(root, afterCopyOf('config.json', () => fs.utimesSync(config, later, later)), 'config.json');
  });

  it('a new file under cases/: refused', async () => {
    const root = fullProfile();
    await refusedFor(root, afterCopyOf('chat-data.json', () => put(root, 'cases/x/new.md', 'x')), 'cases/x/new.md');
  });

  it('a case file removed: refused', async () => {
    const root = fullProfile();
    const gone = put(root, 'cases/x/zz-last.md', 'x');
    await refusedFor(root, afterCopyOf('zz-last.md', () => fs.rmSync(gone)), 'cases/x/zz-last.md');
  });

  it('Chromium churning its own files is no refusal', async () => {
    const root = fullProfile();
    const dips = put(root, 'DIPS', 'chromium');
    const prefs = put(root, 'Preferences', '{}');
    const res = await backupProfile({
      userDataDir: root,
      dest: destFor(root),
      now: FIXED,
      fsImpl: afterCopyOf('DIPS', () => { fs.appendFileSync(dips, 'more'); fs.appendFileSync(prefs, ' '); })
    });
    assert.ok(res.files > 0);
    assert.ok(await readBackupManifest(destFor(root)));
  });
});

describe('an unfinished backup', () => {
  it('holds UNFINISHED from the start; a finished one does not', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    let seen = false;
    const backup = async (db, out) => {
      seen = fs.existsSync(path.join(dest, 'UNFINISHED'));
      await sqlite.backup(db, out);
    };
    await backupProfile({ userDataDir: root, dest, now: FIXED, backup });
    assert.strictEqual(seen, true);
    assert.ok(!fs.existsSync(path.join(dest, 'UNFINISHED')));
  });

  it('a refusal leaves the marker, says the copy can be deleted, and deletes nothing', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    const fsImpl = { copyFile: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED, fsImpl, retryDelaysMs: NO_WAIT }), (err) => {
      assert.match(err.message, /UNFINISHED/);
      assert.match(err.message, /can be deleted/);
      return true;
    });
    assert.ok(fs.existsSync(path.join(dest, 'UNFINISHED')));
    assert.ok(fs.existsSync(path.join(dest, 'history.sqlite')), 'nothing is removed');
  });

  it('readBackupManifest takes a marked directory for no backup', async () => {
    const root = fullProfile();
    const dest = destFor(root);
    await backupProfile({ userDataDir: root, dest, now: FIXED });
    fs.writeFileSync(path.join(dest, 'UNFINISHED'), 'x');
    assert.strictEqual(await readBackupManifest(dest), null);
  });
});

describe('the smaller refusals', () => {
  it('a hot journal beside the store is not copied', async () => {
    const root = fullProfile();
    put(root, 'history.sqlite-journal', '');
    await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED });
    assert.ok(!fs.existsSync(path.join(destFor(root), 'history.sqlite-journal')));
  });

  it('a dest named ..hidden inside the profile is refused', async () => {
    const root = fullProfile();
    const dest = path.join(root, '..hidden');
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED }), isBackupFailed(dest));
    assert.ok(!fs.existsSync(dest));
  });

  it('a dest beside the profile whose name starts with two dots is not inside it', async () => {
    const root = fullProfile();
    const dest = path.join(path.dirname(root), '..king-louie-backup');
    await backupProfile({ userDataDir: root, dest, now: FIXED });
    assert.ok(fs.existsSync(path.join(dest, 'backup.json')));
  });

  it('a missing parent of dest is said in words', async () => {
    const root = fullProfile();
    const dest = path.join(path.dirname(root), 'no-such-folder', 'backup');
    await assert.rejects(backupProfile({ userDataDir: root, dest, now: FIXED }), (err) => {
      isBackupFailed(dest)(err);
      assert.match(err.message, /does not exist/);
      assert.ok(!err.message.includes('ENOENT'));
      return true;
    });
  });

  it('where SQLite refuses the immutable URI (a UNC path), the backup takes the plain open', async () => {
    const root = fullProfile();
    const real = HistoryStore.open;
    HistoryStore.open = function open(file, options = {}) {
      if (options.immutable) throw new Error('unable to open database file');
      return real.call(this, file, options);
    };
    try {
      const res = await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED });
      assert.deepStrictEqual(res.history, { chats: 2, messages: 5 });
    } finally {
      HistoryStore.open = real;
    }
  });
});

describe('readBackupManifest', () => {
  async function made() {
    const root = fullProfile();
    await backupProfile({ userDataDir: root, dest: destFor(root), now: FIXED });
    return destFor(root);
  }

  it('reads a backup that is whole', async () => {
    const dest = await made();
    const manifest = await readBackupManifest(dest);
    assert.strictEqual(manifest.v, 1);
    assert.ok(manifest.files.length > 0);
  });

  it('answers null with no backup.json, or one that is not a manifest', async () => {
    const dest = await made();
    fs.writeFileSync(path.join(dest, 'backup.json'), '{"v":1}');
    assert.strictEqual(await readBackupManifest(dest), null);
    fs.writeFileSync(path.join(dest, 'backup.json'), 'not json');
    assert.strictEqual(await readBackupManifest(dest), null);
    fs.rmSync(path.join(dest, 'backup.json'));
    assert.strictEqual(await readBackupManifest(dest), null);
  });

  it('answers null when a listed file has the same size and other bytes', async () => {
    const dest = await made();
    const budget = path.join(dest, 'cases', 'x', '.kl', 'budget.json');
    const bytes = fs.readFileSync(budget);
    bytes[0] ^= 0xff;
    fs.writeFileSync(budget, bytes);
    assert.strictEqual(await readBackupManifest(dest), null);
  });

  it('answers null when a listed file is gone or a different size', async () => {
    const dest = await made();
    const budget = path.join(dest, 'cases', 'x', '.kl', 'budget.json');
    fs.appendFileSync(budget, ' ');
    assert.strictEqual(await readBackupManifest(dest), null);
    fs.rmSync(budget);
    assert.strictEqual(await readBackupManifest(dest), null);
  });

  for (const listed of ['../outside.txt', '..\\outside.txt', 'cases\\..\\..\\outside.txt']) {
    it(`refuses a listed path that leaves the backup: ${listed}`, async () => {
      const dest = await made();
      put(path.dirname(dest), 'outside.txt', 'x');
      const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'backup.json'), 'utf8'));
      manifest.files.push({ path: listed, bytes: 1, sha256: 'a'.repeat(64) });
      fs.writeFileSync(path.join(dest, 'backup.json'), JSON.stringify(manifest));
      assert.strictEqual(await readBackupManifest(dest), null);
    });
  }
});
