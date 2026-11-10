// tests/models-placeholder-key.test.js
// The hint a failing provider key gets when it looks like a placeholder
// (settings redesign spec §5.5, §7.2). The hint never repeats the key.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { placeholderKeyHint } = require('../src/models/placeholder-key');

const COUNTING = 'it contains a counting run of digits';
const WORDS = 'it contains placeholder words';
const REPEATED = 'it is mostly one repeated character';

describe('placeholderKeyHint', () => {
  it('flags a counting run of six digits', () => {
    assert.strictEqual(placeholderKeyHint('sk-abc1234567890'), COUNTING);
    assert.strictEqual(placeholderKeyHint('key-456789'), COUNTING);
    assert.strictEqual(placeholderKeyHint('sk-012345'), COUNTING);
  });

  it('does not flag five ascending digits or a descending run', () => {
    assert.strictEqual(placeholderKeyHint('sk-q12345z'), null);
    assert.strictEqual(placeholderKeyHint('sk-q987654z'), null);
  });

  it('flags placeholder words, case-insensitively', () => {
    assert.strictEqual(placeholderKeyHint('sk-your-key-here'), WORDS);
    for (const t of ['EXAMPLE-key', 'a-Placeholder', 'sk-xxxx-9f3a', 'ChangeMe', 'TEST-KEY-9f3a']) {
      assert.strictEqual(placeholderKeyHint(t), WORDS, t);
    }
  });

  it('flags eight or more of one character in a row', () => {
    assert.strictEqual(placeholderKeyHint('aaaaaaaaaaaa'), REPEATED);
    assert.strictEqual(placeholderKeyHint('sk-00000000'), REPEATED);
    assert.strictEqual(placeholderKeyHint('sk-0000000'), null);
  });

  it('first match wins', () => {
    assert.strictEqual(placeholderKeyHint('your-123456'), COUNTING);
    assert.strictEqual(placeholderKeyHint('your-aaaaaaaa'), WORDS);
  });

  it('leaves a realistic random key alone', () => {
    assert.strictEqual(placeholderKeyHint('sk-or-v1-9f3a7c2e81b4d6f0'), null);
  });

  it('returns null for null, empty and non-strings', () => {
    assert.strictEqual(placeholderKeyHint(null), null);
    assert.strictEqual(placeholderKeyHint(undefined), null);
    assert.strictEqual(placeholderKeyHint(''), null);
    assert.strictEqual(placeholderKeyHint(12345678), null);
  });

  it('never returns any part of the key', () => {
    for (const t of ['sk-abc1234567890', 'sk-your-key-here', 'aaaaaaaaaaaa', '123456']) {
      const hint = placeholderKeyHint(t);
      assert.ok(hint === null || [COUNTING, WORDS, REPEATED].includes(hint));
      assert.ok(!String(hint).includes('123456'));
    }
  });
});
