const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-store-'));

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
