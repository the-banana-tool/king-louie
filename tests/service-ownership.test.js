const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { restoreDataDirOwnership } = require('../src/service/ownership');

const created = [];
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-owner-')); created.push(d); return d; };

// A fake fs over an in-memory tree: { name: { uid, dir?: {...}, link? } }.
function fakeFs(rootPath, rootUid, tree) {
  const lookup = new Map();
  const add = (p, node) => {
    lookup.set(p, node);
    if (node.dir) for (const [name, child] of Object.entries(node.dir)) add(path.join(p, name), child);
  };
  add(rootPath, { uid: rootUid, dir: tree });
  const chowned = [];
  return {
    chowned,
    readdirSync: (p) => Object.keys(lookup.get(p).dir),
    lstatSync: (p) => {
      const n = lookup.get(p);
      if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { uid: n.uid, gid: n.uid + 1, isDirectory: () => Boolean(n.dir) && !n.link };
    },
    lchownSync: (p, uid, gid) => chowned.push([path.relative(rootPath, p), uid, gid])
  };
}

describe('restoreDataDirOwnership', () => {
  it('is a no-op when not running as root', () => {
    const f = fakeFs('/data', 990, { 'a.json': { uid: 0 } });
    assert.deepStrictEqual(restoreDataDirOwnership('/data', { getuid: () => 1000, fsImpl: f }), []);
    assert.deepStrictEqual(f.chowned, []);
  });

  it('is a no-op for a root-owned data dir', () => {
    const f = fakeFs('/data', 0, { 'a.json': { uid: 0 } });
    assert.deepStrictEqual(restoreDataDirOwnership('/data', { getuid: () => 0, fsImpl: f }), []);
  });

  it('chowns only root-owned entries, recursively, to the data dir owner, without descending into links', () => {
    const f = fakeFs('/data', 990, {
      'chat-data.json': { uid: 0 },
      'config.json': { uid: 990 },
      logs: { uid: 0, dir: { 'service.log': { uid: 0 } } },
      linked: { uid: 0, link: true, dir: { 'outside.txt': { uid: 0 } } }
    });
    restoreDataDirOwnership('/data', { getuid: () => 0, fsImpl: f });
    const got = f.chowned.map(([p, u, g]) => [p.split(path.sep).join('/'), u, g]).sort();
    assert.deepStrictEqual(got, [['chat-data.json', 990, 991], ['linked', 990, 991], ['logs', 990, 991], ['logs/service.log', 990, 991]]);
  });

  it('never throws for a missing data dir (real fs)', () => {
    assert.deepStrictEqual(restoreDataDirOwnership(path.join(tmp(), 'missing'), { getuid: () => 0 }), []);
  });
});
