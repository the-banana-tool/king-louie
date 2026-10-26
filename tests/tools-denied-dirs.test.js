// Personal node (R-PN-1): the service runs as the owner, so the OS no longer
// keeps the file tools out of the owner's admin files. A denied directory is
// refused to every path-gated tool, whatever the working directory and
// allowedDirectories say, and so is the directory itself.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const {
  isPathAllowed,
  describePathDenial,
  isProtectedSecretPath,
  registerDeniedDir,
  clearDeniedDirs,
  isDeniedPath
} = require('../src/tools/utils');

const readTool = require('../src/tools/builtin/read-tool');
const writeTool = require('../src/tools/builtin/write-tool');
const editTool = require('../src/tools/builtin/edit-tool');
const multiEditTool = require('../src/tools/builtin/multi-edit-tool');
const grepTool = require('../src/tools/builtin/grep-tool');
const globTool = require('../src/tools/builtin/glob-tool');

const isWindows = process.platform === 'win32';
const DENIAL = /may not touch on this node/;

let root;
let cfg;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-denied-'));
  cfg = path.join(root, 'config');
  fs.mkdirSync(path.join(cfg, 'approvers'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'node.yaml'), 'name: DENIED_MARKER\n');
  fs.writeFileSync(path.join(cfg, 'approvers', 'a.json'), '{"k":"DENIED_MARKER"}');
  fs.mkdirSync(path.join(root, 'config2'));
  fs.writeFileSync(path.join(root, 'config2', 'f.txt'), 'sibling DENIED_MARKER\n');
  clearDeniedDirs();
});

afterEach(() => {
  clearDeniedDirs();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('denied directories', () => {
  it('a path under a denied dir is refused for read, write, edit, glob and grep', async () => {
    registerDeniedDir(cfg);
    assert.equal(isPathAllowed(path.join(cfg, 'node.yaml'), root, []), false);
    assert.equal(isPathAllowed(path.join(cfg, 'node.yaml'), os.tmpdir(), [root]), false);
    assert.match(describePathDenial(path.join(cfg, 'approvers', 'a.json'), root, []), DENIAL);
    assert.equal(
      describePathDenial(path.join(cfg, 'approvers', 'a.json'), root, []),
      `${path.join(cfg, 'approvers', 'a.json')} is inside a directory King Louie's tools may not touch on this node`
    );

    await assert.rejects(
      () => readTool.execute({ file_path: path.join(cfg, 'node.yaml') }, { workingDirectory: root }),
      DENIAL
    );
    await assert.rejects(
      () => writeTool.execute({ file_path: path.join(cfg, 'new.yaml'), content: 'x' }, { workingDirectory: root }),
      DENIAL
    );
    assert.equal(fs.existsSync(path.join(cfg, 'new.yaml')), false);
    await assert.rejects(
      () => editTool.execute(
        { file_path: path.join(cfg, 'node.yaml'), old_string: 'DENIED_MARKER', new_string: 'x' },
        { workingDirectory: root }
      ),
      DENIAL
    );
    const multi = await multiEditTool.execute(
      { edits: [{ file_path: path.join(cfg, 'node.yaml'), old_string: 'DENIED_MARKER', new_string: 'x' }] },
      { workingDirectory: root }
    );
    assert.match(JSON.stringify(multi), DENIAL);
    assert.match(fs.readFileSync(path.join(cfg, 'node.yaml'), 'utf8'), /DENIED_MARKER/);

    // Rooted at the denied dir: refused outright.
    const grepIn = await grepTool.execute({ pattern: '.', path: cfg }, { workingDirectory: root });
    assert.equal(grepIn.ok, false);
    assert.match(grepIn.error, DENIAL);
    const globIn = await globTool.execute({ pattern: '**/*', cwd: path.join(cfg, 'approvers') }, { workingDirectory: root });
    assert.equal(globIn.ok, false);
    assert.match(globIn.error, DENIAL);

    // Rooted above it: the walk skips what is inside, and finds the sibling.
    const grepAbove = await grepTool.execute({ pattern: 'DENIED_MARKER', path: root }, { workingDirectory: root });
    assert.equal(grepAbove.ok, true);
    const grepBody = JSON.stringify(grepAbove.matches);
    assert.ok(!grepBody.includes('node.yaml') && !grepBody.includes('a.json'), grepBody);
    assert.ok(grepBody.includes('f.txt'), grepBody);
    const globAbove = await globTool.execute({ pattern: '**/*', cwd: root }, { workingDirectory: root });
    assert.equal(globAbove.ok, true);
    const names = globAbove.files.map((f) => path.basename(f.path || f));
    assert.ok(!names.includes('node.yaml') && !names.includes('a.json'), names.join(','));
    // The default listing is 'all': the denied dir and its subdir are not named either.
    assert.ok(!names.includes('config') && !names.includes('approvers'), names.join(','));
    assert.ok(names.includes('f.txt') && names.includes('config2'), names.join(','));
  });

  it('the denied dir itself is refused; a sibling with the same prefix is not', () => {
    registerDeniedDir(cfg);
    assert.equal(isDeniedPath(cfg), true);
    assert.equal(isDeniedPath(path.join(cfg, 'approvers')), true);
    assert.equal(isDeniedPath(path.join(root, 'config2', 'f.txt')), false);
    assert.equal(isDeniedPath(root), false);
    assert.equal(isPathAllowed(path.join(root, 'config2', 'f.txt'), root, []), true);
    assert.equal(describePathDenial(path.join(root, 'config2', 'f.txt'), root, []), null);
  });

  it('matches case-insensitively on win32, at a separator', { skip: isWindows ? false : 'win32 spelling' }, () => {
    registerDeniedDir('D:\\x\\config');
    assert.equal(isDeniedPath('D:\\x\\config'), true);
    assert.equal(isDeniedPath('D:\\x\\config2\\f'), false);
    assert.equal(isDeniedPath('d:\\X\\CONFIG\\node.yaml'), true);
    assert.equal(isDeniedPath('D:/x/config/approvers'), true);
  });

  it('a link into a denied dir is refused (realpath)', (t) => {
    registerDeniedDir(cfg);
    const link = path.join(root, 'peek');
    try {
      fs.symlinkSync(cfg, link, isWindows ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot make a directory link here: ${err.code}`);
      return;
    }
    assert.equal(isDeniedPath(link), true);
    assert.equal(isDeniedPath(path.join(link, 'node.yaml')), true);
    assert.equal(isPathAllowed(path.join(link, 'node.yaml'), root, []), false);
  });

  it('Write through a link into a denied dir is refused when several levels are missing', async (t) => {
    registerDeniedDir(cfg);
    const link = path.join(root, 'peek');
    try {
      fs.symlinkSync(cfg, link, isWindows ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot make a directory link here: ${err.code}`);
      return;
    }
    const target = path.join(link, 'new', 'sub', 'x.json');
    assert.equal(isDeniedPath(target), true);
    assert.equal(isPathAllowed(target, root, []), false);
    assert.match(describePathDenial(target, root, []), DENIAL);
    await assert.rejects(
      () => writeTool.execute({ file_path: target, content: '{}' }, { workingDirectory: root }),
      DENIAL
    );
    assert.equal(fs.existsSync(path.join(cfg, 'new')), false);
  });

  it('a path whose missing segments sit under a link resolves through the link', (t) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-denied-out-'));
    const link = path.join(root, 'out-link');
    try {
      try {
        fs.symlinkSync(outside, link, isWindows ? 'junction' : 'dir');
      } catch (err) {
        t.skip(`cannot make a directory link here: ${err.code}`);
        return;
      }
      // isPathWithin sees the real place too: a working dir of `root` does not
      // reach a file three levels under a link that leaves it.
      assert.equal(isPathAllowed(path.join(link, 'a', 'b', 'c.txt'), root, []), false);
      assert.equal(isPathAllowed(path.join(link, 'a', 'b', 'c.txt'), outside, []), true);
    } finally {
      try { fs.rmSync(link, { recursive: false, force: true }); } catch { /* best effort */ }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a denied dir registered through a link is denied by its real path', (t) => {
    const link = path.join(root, 'cfg-link');
    try {
      fs.symlinkSync(cfg, link, isWindows ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot make a directory link here: ${err.code}`);
      return;
    }
    registerDeniedDir(link);
    assert.equal(isDeniedPath(path.join(cfg, 'node.yaml')), true);
  });

  it('a denied dir that does not exist yet is denied by its spelling', () => {
    const later = path.join(root, 'later');
    registerDeniedDir(later);
    assert.equal(isDeniedPath(path.join(later, 'x.json')), true);
    assert.equal(isPathAllowed(path.join(later, 'x.json'), root, []), false);
  });

  it('nothing is denied once cleared, and the secret check is unchanged for ordinary paths', () => {
    registerDeniedDir(cfg);
    clearDeniedDirs();
    assert.equal(isDeniedPath(path.join(cfg, 'node.yaml')), false);
    assert.equal(isPathAllowed(path.join(cfg, 'node.yaml'), root, []), true);
    assert.equal(isProtectedSecretPath(path.join(cfg, 'node.yaml')), false);
  });

  it('createCore({ deniedDirs }) registers them', async () => {
    const { createCore } = require('../src/core');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-denied-core-'));
    const core = createCore({
      paths: { dataDir },
      store: makeMemoryStore(),
      vaultStore: makeMemoryStore(),
      cipher: { isEncryptionAvailable: () => false, encryptString: (x) => x, decryptString: (x) => x },
      deniedDirs: [cfg]
    });
    try {
      assert.equal(isDeniedPath(path.join(cfg, 'node.yaml')), true);
      assert.equal(isDeniedPath(path.join(root, 'config2', 'f.txt')), false);
    } finally {
      await core.shutdown?.();
      closeOpenHistoryStores();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function makeMemoryStore() {
  const data = {};
  return {
    get: (k, fallback) => (k in data ? data[k] : fallback),
    set: (k, v) => { data[k] = v; },
    has: (k) => k in data,
    delete: (k) => { delete data[k]; }
  };
}
