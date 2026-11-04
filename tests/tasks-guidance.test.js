'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { TASK_GUIDANCE, parseStuck } = require('../src/context/system-sections');

describe('TASK_GUIDANCE', () => {
  it('says what a task turn needs', () => {
    assert.match(TASK_GUIDANCE, /STUCK:/);
    assert.match(TASK_GUIDANCE, /table/);
    assert.match(TASK_GUIDANCE, /each row|per row/);
    assert.match(TASK_GUIDANCE, /where each fact came from/);
    assert.match(TASK_GUIDANCE, /never ask for approval in text/);
    assert.match(TASK_GUIDANCE, /signed-in browser/);
    assert.match(TASK_GUIDANCE, /owner acting/);
    assert.match(TASK_GUIDANCE, /snapshot/);
    assert.match(TASK_GUIDANCE, /reading/);
  });
  it('has no refusal list: "never" only in the approval sentence', () => {
    const hits = TASK_GUIDANCE.match(/never/gi) || [];
    assert.strictEqual(hits.length, 1);
    assert.doesNotMatch(TASK_GUIDANCE, /do not|must not|don't|forbidden/i);
  });
  it('is short', () => {
    assert.ok(TASK_GUIDANCE.length < 1500);
  });
});

describe('parseStuck', () => {
  it('returns the last paragraph when it starts STUCK:', () => {
    assert.strictEqual(parseStuck('Tried.\n\nSTUCK: need a login'), 'STUCK: need a login');
  });
  it('returns null for the word without the colon', () => {
    assert.strictEqual(parseStuck('STUCK is a word'), null);
  });
  it('returns null when the STUCK paragraph is not last', () => {
    assert.strictEqual(parseStuck('STUCK: x\n\nThen I found it.'), null);
  });
  it('handles CRLF and trailing whitespace', () => {
    assert.strictEqual(parseStuck('Tried.\r\n\r\nSTUCK: need a login\r\nmore\r\n  \r\n'), 'STUCK: need a login\nmore');
  });
  it('handles a lone STUCK paragraph and non-strings', () => {
    assert.strictEqual(parseStuck('STUCK: a'), 'STUCK: a');
    assert.strictEqual(parseStuck(null), null);
    assert.strictEqual(parseStuck(''), null);
  });
  it('requires STUCK: at the start of the paragraph', () => {
    assert.strictEqual(parseStuck('Tried.\n\nI am STUCK: here'), null);
  });
});
