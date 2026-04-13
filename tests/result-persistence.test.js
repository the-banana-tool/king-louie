const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ResultPersistence = require('../src/execution/result-persistence');

describe('ResultPersistence', () => {
  let baseDir;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-result-persist-'));
  });

  afterEach(() => {
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('persistIfLarge', () => {
    it('passes through small content untouched', () => {
      const p = new ResultPersistence({ baseDir, thresholdChars: 100 });
      assert.strictEqual(p.persistIfLarge('short', { sessionId: 's1' }), 'short');
    });

    it('persists oversized content and returns a preview marker', () => {
      const p = new ResultPersistence({ baseDir, thresholdChars: 100 });
      const big = 'X'.repeat(5000);
      const preview = p.persistIfLarge(big, { sessionId: 's1', toolName: 'Read' });
      assert.match(preview, /\[persisted: /);
      assert.match(preview, /5000 chars/);
      assert.ok(preview.length < big.length, `preview ${preview.length} should be < ${big.length}`);
      // The persisted file actually exists.
      const sessionDir = path.join(baseDir, 's1');
      const files = fs.readdirSync(sessionDir);
      assert.strictEqual(files.length, 1);
      const persisted = fs.readFileSync(path.join(sessionDir, files[0]), 'utf8');
      assert.strictEqual(persisted, big);
    });

    it('falls back to head-only preview when no baseDir configured', () => {
      const p = new ResultPersistence({ thresholdChars: 100 });
      const big = 'Y'.repeat(500);
      const preview = p.persistIfLarge(big, { sessionId: 's1', toolName: 'Read' });
      assert.match(preview, /persistence unavailable/);
      assert.ok(preview.includes('Y'.repeat(500).slice(0, 500)) || preview.includes('YYY'));
    });

    it('sanitizes session ids to safe filenames', () => {
      const p = new ResultPersistence({ baseDir, thresholdChars: 50 });
      p.persistIfLarge('Z'.repeat(200), { sessionId: '../weird/../id', toolName: 'X' });
      const dirs = fs.readdirSync(baseDir);
      assert.strictEqual(dirs.length, 1);
      assert.ok(!dirs[0].includes('..'));
      assert.ok(!dirs[0].includes('/'));
    });
  });

  describe('persistResultObject', () => {
    it('returns object unchanged when serialized form fits', () => {
      const p = new ResultPersistence({ baseDir, thresholdChars: 1000 });
      const obj = { ok: true, content: 'small' };
      assert.strictEqual(p.persistResultObject(obj, { sessionId: 's' }), obj);
    });

    it('persists the heaviest string field of an oversized result', () => {
      const p = new ResultPersistence({ baseDir, thresholdChars: 200 });
      const obj = {
        ok: true,
        message: 'short',
        content: 'A'.repeat(500)
      };
      const result = p.persistResultObject(obj, { sessionId: 's', toolName: 'Read' });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.message, 'short');
      assert.match(result.content, /\[persisted:/);
      // The original heavy field is intact in the persisted file.
      const dir = path.join(baseDir, 's');
      const files = fs.readdirSync(dir);
      const persisted = fs.readFileSync(path.join(dir, files[0]), 'utf8');
      assert.strictEqual(persisted, 'A'.repeat(500));
    });

    it('falls back to whole-blob persistence when no dominant field exists', () => {
      const p = new ResultPersistence({ baseDir, thresholdChars: 200 });
      // Many small strings — none dominates, but the JSON is large.
      const obj = {};
      for (let i = 0; i < 50; i++) obj[`f${i}`] = 'x'.repeat(20);
      const result = p.persistResultObject(obj, { sessionId: 's', toolName: 'Bash' });
      assert.strictEqual(result._persistedFullPayload, true);
      assert.match(result._persistedNote, /persisted/);
    });

    it('passes through non-objects', () => {
      const p = new ResultPersistence({ baseDir });
      assert.strictEqual(p.persistResultObject('string', {}), 'string');
      assert.strictEqual(p.persistResultObject(null, {}), null);
      assert.strictEqual(p.persistResultObject(42, {}), 42);
    });
  });
});
