const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Conf = require('conf').default;
const { withReadCache } = require('../src/platform/cached-store');

// electron-store is a thin subclass of conf that needs Electron; conf itself
// has the same read path (the `store` getter), so the cache is tested on it.
const CachedConf = withReadCache(Conf);

const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cached-store-')); createdTempDirs.push(d); return d; };
const make = (cwd, defaults = { chats: [], settings: { a: 1 } }) =>
  new CachedConf({ cwd, configName: 'chat-data', projectName: 'kl-test', projectVersion: '0.0.0', defaults });

// Counts reads of `file` while fn runs.
function countReads(file, fn) {
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...rest) {
    if (path.resolve(String(p)) === path.resolve(file)) reads += 1;
    return real.call(this, p, ...rest);
  };
  try { fn(); } finally { fs.readFileSync = real; }
  return reads;
}

describe('withReadCache', () => {
  it('parses the file once for repeated reads', () => {
    const s = make(tmp());
    s.set('settings', { a: 2 });
    s.get('settings');
    const reads = countReads(s.path, () => {
      for (let i = 0; i < 50; i++) { s.get('settings'); s.get('chats'); s.has('settings.a'); }
    });
    assert.strictEqual(reads, 0);
  });

  it('keeps the store API: dot paths, defaults, set, delete, clear', () => {
    const s = make(tmp());
    assert.deepStrictEqual(s.get('chats'), []);
    assert.strictEqual(s.get('missing', 'fallback'), 'fallback');
    s.set('mesh.identity', { id: 'x' });
    assert.deepStrictEqual(s.get('mesh'), { identity: { id: 'x' } });
    s.set({ activeChatId: 'c1' });
    assert.strictEqual(s.get('activeChatId'), 'c1');
    s.delete('mesh.identity');
    assert.strictEqual(s.has('mesh.identity'), false);
    s.clear();
    assert.strictEqual(s.get('activeChatId'), undefined);
    assert.deepStrictEqual(s.get('settings'), { a: 1 });
  });

  it('never lets a caller mutate the cached data through a returned value', () => {
    const s = make(tmp());
    s.set('settings', { a: 1, nested: { b: 1 } });
    const got = s.get('settings');
    got.a = 99;
    got.nested.b = 99;
    assert.deepStrictEqual(s.get('settings'), { a: 1, nested: { b: 1 } });
    const all = s.store;
    all.settings.a = 42;
    assert.strictEqual(s.get('settings.a'), 1);
  });

  it('sees a write made to the file by someone else', () => {
    const dir = tmp();
    const s = make(dir);
    assert.deepStrictEqual(s.get('settings'), { a: 1 });
    const body = JSON.parse(fs.readFileSync(s.path, 'utf8'));
    body.settings = { a: 7, longer: 'so the size differs too' };
    fs.writeFileSync(s.path, JSON.stringify(body));
    assert.deepStrictEqual(s.get('settings'), { a: 7, longer: 'so the size differs too' });
  });

  it('reads through a second instance on the same file', () => {
    const dir = tmp();
    const a = make(dir);
    const b = make(dir);
    a.get('settings');
    b.set('settings', { a: 3, from: 'b' });
    assert.deepStrictEqual(a.get('settings'), { a: 3, from: 'b' });
  });
});
