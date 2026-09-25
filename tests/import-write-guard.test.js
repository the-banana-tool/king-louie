// tests/import-write-guard.test.js — the Windows half of Task 9 fix round 1
// (C1): with no setuid on Windows, `import --from` writes the data dir as an
// Administrator, so every write path the importer uses refuses a link or
// junction anywhere below the data dir, and temp files are created with 'wx'
// under unpredictable names. Junctions need no privilege on Windows, so these
// run for real there; on POSIX the 'junction' type makes a plain symlink.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWriteGuard } = require('../src/platform/write-guard');
const { MemoryStore } = require('../src/memory');
const CronStore = require('../src/cron/cron-store');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { writeFileAtomic } = require('../src/desktop-bridge/pairing');
const { DesktopImporter } = require('../src/migration/desktop-import');
const { restoreDataDirOwnership } = require('../src/service/ownership');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'kl-guard-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const junction = (target, link) => fs.symlinkSync(target, link, 'junction');

const fakeContext = (settings = {}) => ({ getSettings: () => settings, getPermissionRules: () => [], addPermissionRule: () => {}, setSettings: () => {} });

describe('createWriteGuard', () => {
  it('allows plain directories and paths that do not exist yet', () => {
    const dataDir = tmp();
    fs.mkdirSync(path.join(dataDir, 'memory'));
    const guard = createWriteGuard({ anchors: [dataDir] });
    guard.check(path.join(dataDir, 'memory', 'memory-store.json'));
    guard.check(path.join(dataDir, 'not', 'yet', 'there.json'));
  });

  it('refuses a junction anywhere below the anchor', () => {
    const dataDir = tmp();
    const outside = tmp();
    junction(outside, path.join(dataDir, 'memory'));
    const guard = createWriteGuard({ anchors: [dataDir] });
    assert.throws(() => guard.check(path.join(dataDir, 'memory', 'memory-store.json')), (err) => err.code === 'UNSAFE_WRITE_PATH' && /link or junction/.test(err.message));
    fs.mkdirSync(path.join(dataDir, 'a'));
    junction(outside, path.join(dataDir, 'a', 'b'));
    assert.throws(() => guard.check(path.join(dataDir, 'a', 'b', 'c', 'd.json')), /link or junction/);
  });

  it('refuses a path outside every anchor, and an anchor that is itself a link', () => {
    const dataDir = tmp();
    const guard = createWriteGuard({ anchors: [dataDir] });
    assert.throws(() => guard.check(path.join(tmp(), 'x.json')), /outside/);
    assert.throws(() => guard.check(path.join(dataDir, '..', 'x.json')), /outside/);
    const linked = path.join(tmp(), 'linked-data');
    junction(dataDir, linked);
    assert.throws(() => createWriteGuard({ anchors: [linked] }).check(path.join(linked, 'x.json')), /link or junction/);
  });
});

describe('MemoryStore.save', () => {
  it('writes through an unpredictable temp name, so a squatted .tmp does not break or steer it', () => {
    const dir = tmp();
    const storageFile = path.join(dir, 'memory', 'memory-store.json');
    fs.mkdirSync(path.join(storageFile + '.tmp'), { recursive: true });
    const store = new MemoryStore({ storageFile });
    store.insert({ id: 'm-1', content: 'likes tea' });
    assert.strictEqual(JSON.parse(fs.readFileSync(storageFile, 'utf8')).entries[0].id, 'm-1');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(storageFile)).filter((n) => n !== 'memory-store.json.tmp' && n !== 'memory-store.json'), []);
  });

  it('with a write guard, refuses a junctioned memory directory and writes nothing through it', () => {
    const dataDir = tmp();
    const outside = tmp();
    junction(outside, path.join(dataDir, 'memory'));
    const store = new MemoryStore({ storageFile: path.join(dataDir, 'memory', 'memory-store.json'), writeGuard: createWriteGuard({ anchors: [dataDir] }) });
    assert.throws(() => store.insert({ id: 'm-1', content: 'x' }), /link or junction/);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });
});

describe('CronStore.save', () => {
  it('writes through an unpredictable temp name, so a squatted Date.now() name does not break it', async (t) => {
    const dir = tmp();
    const storageFile = path.join(dir, 'cron', 'jobs.json');
    t.mock.method(Date, 'now', () => 1234);
    fs.mkdirSync(`${storageFile}.tmp.1234`, { recursive: true });
    const store = new CronStore(storageFile);
    await store.add({ id: 'cron_1', name: 'daily' });
    assert.ok(JSON.parse(fs.readFileSync(storageFile, 'utf8')).cron_1);
  });

  it('with a write guard, refuses a junctioned cron directory and writes nothing through it', async () => {
    const dataDir = tmp();
    const outside = tmp();
    junction(outside, path.join(dataDir, 'cron'));
    const store = new CronStore(path.join(dataDir, 'cron', 'jobs.json'), { writeGuard: createWriteGuard({ anchors: [dataDir] }) });
    await assert.rejects(store.add({ id: 'cron_1', name: 'daily' }), /link or junction/);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });
});

describe('desktop scope writes', () => {
  it('with a write guard, refuses a junctioned desktop directory', () => {
    const dataDir = tmp();
    const outside = tmp();
    junction(outside, path.join(dataDir, 'desktop'));
    const scope = createDesktopScope({ dataDir, context: fakeContext(), writeGuard: createWriteGuard({ anchors: [dataDir] }) });
    assert.throws(() => scope.addDirectory(path.resolve(tmp())), /link or junction/);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  it('writeFileAtomic does not use a pid/clock-derived temp name', (t) => {
    const dir = tmp();
    const file = path.join(dir, 'rules.json');
    t.mock.method(Date, 'now', () => 1234);
    fs.mkdirSync(`${file}.${process.pid}.1234.tmp`);
    writeFileAtomic(file, '{"v":1}');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"v":1}');
  });
});

describe('DesktopImporter with a write guard', () => {
  const plan = () => ({ planId: 'p1', caseFiles: new Map() });
  const item = { category: 'case', key: 'lakeside-lot', action: 'new' };
  const file = (relPath, text, offset = 0) => ({ relPath, mode: 0o644, offset, b64: Buffer.from(text).toString('base64') });

  it('refuses to write a case file when the cases root is a junction', () => {
    const dataDir = tmp();
    const outside = tmp();
    junction(outside, path.join(dataDir, 'cases'));
    const importer = new DesktopImporter({ context: fakeContext({ cases: { root: path.join(dataDir, 'cases') } }), targets: {}, dataDir, checkPath: null, writeGuard: createWriteGuard({ anchors: [dataDir] }) });
    assert.throws(() => importer.writeCaseFile(plan(), item, file('a.md', 'x')), /link or junction/);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  it('refuses a cases root outside every anchor (settings.cases.root is service-controlled)', () => {
    const dataDir = tmp();
    const elsewhere = tmp();
    const importer = new DesktopImporter({ context: fakeContext({ cases: { root: elsewhere } }), targets: {}, dataDir, checkPath: null, writeGuard: createWriteGuard({ anchors: [dataDir] }) });
    assert.throws(() => importer.writeCaseFile(plan(), item, file('a.md', 'x')), /outside/);
    assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  });

  it('does not sweep .import-* entries through a junctioned cases root', () => {
    const dataDir = tmp();
    const outside = tmp();
    fs.mkdirSync(path.join(outside, '.import-victim'));
    junction(outside, path.join(dataDir, 'cases'));
    // eslint-disable-next-line no-new
    new DesktopImporter({ context: fakeContext({ cases: { root: path.join(dataDir, 'cases') } }), targets: {}, dataDir, checkPath: null, writeGuard: createWriteGuard({ anchors: [dataDir] }) });
    assert.ok(fs.existsSync(path.join(outside, '.import-victim')));
  });

  it('writes and appends case files normally through plain directories', () => {
    const dataDir = tmp();
    const importer = new DesktopImporter({ context: fakeContext({ cases: { root: path.join(dataDir, 'cases') } }), targets: {}, dataDir, checkPath: null, writeGuard: createWriteGuard({ anchors: [dataDir] }) });
    const p = plan();
    importer.writeCaseFile(p, item, file('notes/a.md', 'hello '));
    importer.writeCaseFile(p, item, file('notes/a.md', 'world', 6));
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'cases', '.import-p1', 'lakeside-lot', 'notes', 'a.md'), 'utf8'), 'hello world');
  });
});

// I2: ensureRealDirs creates the cases root with a recursive mkdir; the root
// it creates (and any parent it had to create) is reported, so the ownership
// backstop can hand it back.
describe('ensureRealDirs reports the cases root it creates', () => {
  it('hands the new cases root back through the ownership backstop', () => {
    const dataDir = tmp();
    const root = path.join(dataDir, 'cases');
    const written = [];
    const importer = new DesktopImporter({ context: fakeContext({ cases: { root } }), targets: {}, dataDir, checkPath: null, onPathWritten: (p) => written.push(p) });
    importer.writeCaseFile({ planId: 'p1', caseFiles: new Map() }, { category: 'case', key: 'lakeside-lot', action: 'new' }, { relPath: 'a.md', mode: 0o644, offset: 0, b64: Buffer.from('x').toString('base64') });
    assert.ok(written.includes(root), 'the cases root is reported');
    const realLstat = fs.lstatSync;
    const fsImpl = {
      ...fs,
      constants: { ...fs.constants, O_NOFOLLOW: undefined },
      lstatSync: (p) => {
        const st = realLstat(p);
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: path.resolve(p) === path.resolve(dataDir) ? 1000 : 0, gid: 1000, nlink: 1 });
      },
      lchownSync: () => {}
    };
    const changed = restoreDataDirOwnership(dataDir, written, { getuid: () => 0, fsImpl, log: { warn: () => {} } });
    assert.ok(changed.includes(path.resolve(root)), 'the cases root is handed back');
  });
});
