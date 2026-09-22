const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { restoreDataDirOwnership } = require('../src/service/ownership');

const created = [];
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-owner-')); created.push(d); return d; };

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX only (hard links, symlinks, lchown)' : false };

function recorder() {
  const warnings = [];
  const noop = () => {};
  return {
    warnings,
    log: { warn: (message, meta) => warnings.push({ message, meta }), info: noop, debug: noop, error: noop },
    warnedAbout: (p) => warnings.some((w) => w.meta && w.meta.path === p)
  };
}

// A fake fs over a flat { absolutePath: node } map. A node is
// { uid, gid?, dir?, link?, nlink?, ino?, onOpen? }; `onOpen` stands in for an
// entry that was swapped between the lstat and the open.
const DATA_DIR = path.resolve(path.join(os.tmpdir(), 'kl-fake-data'));
const under = (...parts) => path.join(DATA_DIR, ...parts);

function fakeFs(tree, { fds = false } = {}) {
  const entries = new Map();
  for (const [p, node] of Object.entries(tree)) entries.set(path.resolve(p), { ...node, path: path.resolve(p) });

  const chowned = [];
  const node = (p) => {
    const n = entries.get(path.resolve(p));
    if (!n) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return n;
  };
  const toStat = (n) => ({
    uid: n.uid,
    gid: n.gid === undefined ? n.uid + 1 : n.gid,
    ino: n.ino === undefined ? 1 : n.ino,
    dev: 1,
    nlink: n.nlink === undefined ? 1 : n.nlink,
    isDirectory: () => Boolean(n.dir),
    isSymbolicLink: () => Boolean(n.link)
  });

  const base = {
    chowned,
    lstatSync: (p) => toStat(node(p)),
    lchownSync: (p, uid, gid) => { chowned.push([node(p).path, uid, gid]); }
  };
  if (!fds) return base;

  // Spelled out rather than borrowed from fs.constants so the descriptor path
  // is exercised on Windows too, where fs.constants has no O_NOFOLLOW.
  const constants = { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_DIRECTORY: 0x200 };
  const open = new Map();
  let nextFd = 10;
  return {
    ...base,
    constants,
    openSync: (p, flags) => {
      const n = node(p);
      if (n.link && (flags & constants.O_NOFOLLOW)) {
        throw Object.assign(new Error(`ELOOP: ${p}`), { code: 'ELOOP' });
      }
      const fd = nextFd;
      nextFd += 1;
      open.set(fd, n);
      return fd;
    },
    fstatSync: (fd) => toStat(open.get(fd).onOpen || open.get(fd)),
    fchownSync: (fd, uid, gid) => { chowned.push([open.get(fd).path, uid, gid]); },
    closeSync: (fd) => { open.delete(fd); },
    openCount: () => open.size
  };
}

describe('restoreDataDirOwnership', () => {
  it('is a no-op when not running as root', () => {
    const f = fakeFs({ [DATA_DIR]: { uid: 990, dir: true }, [under('a.json')]: { uid: 0 } });
    assert.deepStrictEqual(restoreDataDirOwnership(DATA_DIR, [under('a.json')], { getuid: () => 1000, fsImpl: f }), []);
    assert.deepStrictEqual(f.chowned, []);
  });

  it('is a no-op for a root-owned data dir', () => {
    const f = fakeFs({ [DATA_DIR]: { uid: 0, dir: true }, [under('a.json')]: { uid: 0 } });
    assert.deepStrictEqual(restoreDataDirOwnership(DATA_DIR, [under('a.json')], { getuid: () => 0, fsImpl: f }), []);
    assert.deepStrictEqual(f.chowned, []);
  });

  it('chowns the listed paths to the data dir owner uid/gid', () => {
    const f = fakeFs({
      [DATA_DIR]: { uid: 990, gid: 991, dir: true },
      [under('config.json')]: { uid: 0, ino: 2 },
      [under('key-check')]: { uid: 0, ino: 3 },
      [under('logs')]: { uid: 0, ino: 4, dir: true }
    }, { fds: true });
    const listed = [under('config.json'), under('key-check'), under('logs')];

    const changed = restoreDataDirOwnership(DATA_DIR, listed, { getuid: () => 0, fsImpl: f });

    assert.deepStrictEqual(changed, listed);
    assert.deepStrictEqual(f.chowned, listed.map((p) => [p, 990, 991]));
    assert.strictEqual(f.openCount(), 0, 'every descriptor it opened must be closed');
  });

  it('leaves a root-owned path in the data dir alone when it is not in the list', () => {
    const f = fakeFs({
      [DATA_DIR]: { uid: 990, gid: 991, dir: true },
      [under('config.json')]: { uid: 0, ino: 2 },
      [under('planted-by-the-service-account')]: { uid: 0, ino: 3 }
    }, { fds: true });

    const changed = restoreDataDirOwnership(DATA_DIR, [under('config.json')], { getuid: () => 0, fsImpl: f });

    assert.deepStrictEqual(changed, [under('config.json')]);
    assert.deepStrictEqual(f.chowned, [[under('config.json'), 990, 991]]);
  });

  it('skips a hard-linked regular file and warns, naming the path', () => {
    const hardLink = under('hard-linked');
    const f = fakeFs({
      [DATA_DIR]: { uid: 990, gid: 991, dir: true },
      [hardLink]: { uid: 0, ino: 2, nlink: 2 }
    }, { fds: true });
    const { log, warnings, warnedAbout } = recorder();

    const changed = restoreDataDirOwnership(DATA_DIR, [hardLink], { getuid: () => 0, fsImpl: f, log });

    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(f.chowned, []);
    assert.ok(warnedAbout(hardLink), `expected a warning naming ${hardLink}; got ${JSON.stringify(warnings)}`);
    assert.match(warnings.map((w) => w.message).join(' '), /hard-link/i);
  });

  it('refuses a listed path that escapes the data dir', () => {
    const outside = path.resolve(path.join(os.tmpdir(), 'kl-fake-elsewhere', 'shadow'));
    const f = fakeFs({ [DATA_DIR]: { uid: 990, gid: 991, dir: true }, [outside]: { uid: 0, ino: 2 } }, { fds: true });
    const { log, warnedAbout } = recorder();

    const changed = restoreDataDirOwnership(DATA_DIR, [outside], { getuid: () => 0, fsImpl: f, log });

    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(f.chowned, []);
    assert.ok(warnedAbout(outside));
  });

  it('does not chown when the entry was swapped between the lstat and the open', () => {
    const swapped = under('swapped');
    const f = fakeFs({
      [DATA_DIR]: { uid: 990, gid: 991, dir: true },
      // lstat sees inode 2; by the time it is opened it is a different file.
      [swapped]: { uid: 0, ino: 2, onOpen: { uid: 0, ino: 99 } }
    }, { fds: true });
    const { log, warnedAbout } = recorder();

    const changed = restoreDataDirOwnership(DATA_DIR, [swapped], { getuid: () => 0, fsImpl: f, log });

    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(f.chowned, []);
    assert.ok(warnedAbout(swapped));
    assert.strictEqual(f.openCount(), 0);
  });

  it('chowns a symlink itself rather than following it (fake ELOOP on O_NOFOLLOW)', () => {
    const link = under('link');
    const f = fakeFs({
      [DATA_DIR]: { uid: 990, gid: 991, dir: true },
      [link]: { uid: 0, ino: 2, link: true }
    }, { fds: true });

    const changed = restoreDataDirOwnership(DATA_DIR, [link], { getuid: () => 0, fsImpl: f });

    assert.deepStrictEqual(changed, [link]);
    assert.deepStrictEqual(f.chowned, [[link, 990, 991]], 'lchown on the link, never a chown on its target');
  });

  it('ignores a listed path that no longer exists', () => {
    const f = fakeFs({ [DATA_DIR]: { uid: 990, gid: 991, dir: true } }, { fds: true });
    assert.deepStrictEqual(restoreDataDirOwnership(DATA_DIR, [under('gone')], { getuid: () => 0, fsImpl: f }), []);
    assert.deepStrictEqual(f.chowned, []);
  });

  it('never throws for a missing data dir (real fs)', () => {
    const missing = path.join(tmp(), 'missing');
    assert.deepStrictEqual(restoreDataDirOwnership(missing, [path.join(missing, 'a')], { getuid: () => 0 }), []);
  });
});

// The same rules against a real filesystem: real nlink, real symlinks and a
// real O_NOFOLLOW open. Only the uid (0) and the two chown calls are faked,
// so the test needs neither root nor a real service account.
describe('restoreDataDirOwnership against a real tree', POSIX_ONLY, () => {
  const OWNER_UID = 990;
  const OWNER_GID = 991;

  // Real fs, except: the data dir looks owned by the service account and
  // everything under it looks root-created, and the chowns are recorded
  // instead of performed (they would need root).
  function rootLikeFs(dataDir) {
    const chowned = [];
    const fake = (st, p) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
      uid: path.resolve(p) === path.resolve(dataDir) ? OWNER_UID : 0,
      gid: path.resolve(p) === path.resolve(dataDir) ? OWNER_GID : 0
    });
    const byFd = new Map();
    return {
      chowned,
      constants: fs.constants,
      lstatSync: (p) => fake(fs.lstatSync(p), p),
      openSync: (p, flags) => { const fd = fs.openSync(p, flags); byFd.set(fd, p); return fd; },
      fstatSync: (fd) => fake(fs.fstatSync(fd), byFd.get(fd)),
      closeSync: (fd) => { byFd.delete(fd); fs.closeSync(fd); },
      fchownSync: (fd, uid, gid) => chowned.push([byFd.get(fd), uid, gid]),
      lchownSync: (p, uid, gid) => chowned.push([p, uid, gid])
    };
  }

  it('does not chown a real hard-linked file, and warns naming it', () => {
    const dir = tmp();
    const outside = path.join(tmp(), 'root-owned-system-file');
    fs.writeFileSync(outside, 'pretend this is a system file');
    const planted = path.join(dir, 'planted');
    fs.linkSync(outside, planted);          // the hard-link escalation
    const ours = path.join(dir, 'config.json');
    fs.writeFileSync(ours, '{}');

    const f = rootLikeFs(dir);
    const { log, warnedAbout } = recorder();
    const changed = restoreDataDirOwnership(dir, [planted, ours], { getuid: () => 0, fsImpl: f, log });

    assert.deepStrictEqual(changed, [ours]);
    assert.deepStrictEqual(f.chowned, [[ours, OWNER_UID, OWNER_GID]]);
    assert.ok(warnedAbout(planted), 'the skipped hard link must be named in a warning');
  });

  it('chowns a real symlink without touching its target', () => {
    const dir = tmp();
    const target = path.join(tmp(), 'target');
    fs.writeFileSync(target, 'keep my owner');
    const link = path.join(dir, 'link');
    fs.symlinkSync(target, link);

    const f = rootLikeFs(dir);
    const changed = restoreDataDirOwnership(dir, [link], { getuid: () => 0, fsImpl: f });

    assert.deepStrictEqual(changed, [link]);
    assert.deepStrictEqual(f.chowned, [[link, OWNER_UID, OWNER_GID]]);
    assert.ok(fs.existsSync(target), 'the target must still be there, untouched');
  });

  it('chowns a real directory it created and does not descend into it', () => {
    const dir = tmp();
    const logs = path.join(dir, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'not-ours.log'), 'planted');

    const f = rootLikeFs(dir);
    const changed = restoreDataDirOwnership(dir, [logs], { getuid: () => 0, fsImpl: f });

    assert.deepStrictEqual(changed, [logs]);
    assert.deepStrictEqual(f.chowned, [[logs, OWNER_UID, OWNER_GID]]);
  });
});
