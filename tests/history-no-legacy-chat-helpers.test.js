// tests/history-no-legacy-chat-helpers.test.js
// getChats()/setChats() loaded or rewrote every chat at once. They were
// removed in history stage H1 (recall spec §4.4); chats are reached through
// explicit store calls. Keep them out of src/.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('no whole-collection chat helpers', () => {
  it('no file under src/ calls getChats( or setChats(', () => {
    const offenders = walk(SRC)
      .filter((file) => /\b(getChats|setChats)\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    assert.deepStrictEqual(offenders, []);
  });

  it('the old chat stores are deleted', () => {
    for (const name of ['chat-history-store.js', 'sqlite-chat-history-store.js']) {
      assert.ok(!fs.existsSync(path.join(SRC, 'history', name)), `${name} is still there`);
    }
  });
});
