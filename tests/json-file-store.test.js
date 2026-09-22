const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');

// Every temp dir this file creates is removed once all tests have run.
const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-store-')); createdTempDirs.push(d); return d; };

const posixOnly = process.platform === 'win32' ? 'POSIX-only (needs symlinks and real mode bits)' : false;

describe('JsonFileStore', () => {
  it('supports electron-store get/set semantics including dot paths and defaults', () => {
    const dir = tmp();
    const s = new JsonFileStore({ dir, name: 'chat-data', defaults: { chats: [], settings: { a: 1 } } });
    assert.deepStrictEqual(s.get('chats'), []);
    assert.strictEqual(s.get('missing', 'fallback'), 'fallback');
    s.set('mesh.identity', { id: 'x' });
    assert.deepStrictEqual(s.get('mesh.identity'), { id: 'x' });
    assert.deepStrictEqual(s.get('mesh'), { identity: { id: 'x' } });
    s.set({ activeChatId: 'c1' });
    assert.strictEqual(s.get('activeChatId'), 'c1');
    assert.strictEqual(s.has('mesh.identity'), true);
    s.delete('mesh.identity');
    assert.strictEqual(s.has('mesh.identity'), false);
    assert.strictEqual(s.path, path.join(dir, 'chat-data.json'));
  });

  it('persists across instances and writes privately', () => {
    const dir = tmp();
    new JsonFileStore({ dir }).set('k', 'v');
    assert.strictEqual(new JsonFileStore({ dir }).get('k'), 'v');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.join(dir, 'config.json')).mode & 0o077, 0);
    }
  });

  it('returns copies, not live references', () => {
    const s = new JsonFileStore({ dir: tmp() });
    s.set('obj', { n: 1 });
    s.get('obj').n = 2;
    assert.strictEqual(s.get('obj').n, 1);
  });
});

// The admin CLI (`token set` / `vault set`) runs as root against a data dir
// the *service account* owns, so every name inside it is attacker-controlled.
// A pid-derived temp name opened with the default 'w' flag let that account
// pre-plant one symlink per possible pid and have root write the store's
// contents — which it also partly chooses, via config.json — through the link.
describe('JsonFileStore: hostile data dir (temp-file write)', () => {
  it('opens its temp file exclusively, under an unpredictable name', (t) => {
    const dir = tmp();
    const s = new JsonFileStore({ dir });
    t.mock.method(fs, 'openSync');
    s.set('a', 1);
    s.set('b', 2);
    const temps = fs.openSync.mock.calls
      .map((c) => c.arguments)
      .filter(([p]) => String(p).endsWith('.tmp'));
    assert.strictEqual(temps.length, 2, 'each save must open exactly one temp file');
    for (const [p, flags] of temps) {
      assert.strictEqual(flags, 'wx', 'the temp file must be created exclusively (O_CREAT|O_EXCL)');
      assert.match(path.basename(String(p)), /^config\.json\.[0-9a-f]{16}\.tmp$/, 'the temp name must be random, not pid-derived');
    }
    assert.notStrictEqual(temps[0][0], temps[1][0], 'each save must use a fresh temp name');
  });

  it('never writes through a symlink planted at the old pid-derived temp name', { skip: posixOnly }, () => {
    const dir = tmp();
    const canaryDir = tmp();
    const canary = path.join(canaryDir, 'authorized_keys');
    fs.symlinkSync(canary, path.join(dir, `config.json.${process.pid}.tmp`));
    new JsonFileStore({ dir }).set('k', 'v');
    assert.ok(!fs.existsSync(canary), 'the store must not have been written through the planted symlink');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).k, 'v');
  });

  it('does not inherit the mode of a file pre-planted at the temp name', { skip: posixOnly }, () => {
    const dir = tmp();
    const planted = path.join(dir, `config.json.${process.pid}.tmp`);
    fs.writeFileSync(planted, 'squatted', { mode: 0o666 });
    fs.chmodSync(planted, 0o666);
    new JsonFileStore({ dir }).set('k', 'v');
    assert.strictEqual(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
  });

  it('unlinks and retries once when the name it picked is already taken', (t) => {
    const dir = tmp();
    const s = new JsonFileStore({ dir });
    // Pin the "random" suffix so the pre-planted squat is exactly the name
    // the first attempt picks; the retry then picks the same name again.
    const fixed = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    t.mock.method(crypto, 'randomBytes', (n) => fixed.subarray(0, n));
    const squatted = path.join(dir, `config.json.${fixed.subarray(0, 8).toString('hex')}.tmp`);
    fs.writeFileSync(squatted, 'squatted');
    s.set('k', 'v');
    assert.strictEqual(new JsonFileStore({ dir }).get('k'), 'v');
    assert.ok(!fs.existsSync(squatted), 'the temp file must be renamed away, not left behind');
  });
});
