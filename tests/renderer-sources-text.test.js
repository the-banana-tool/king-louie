// tests/renderer-sources-text.test.js
// Cases stage 7: the case panel's Sources section shows file names,
// statements, quotes, verify notes and reasons, all document- or
// model-derived, as plain text only. A static check over the block between
// the stage-7 marker and the stage-2 marker that follows it.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MARKER = '/* --- Cases stage 7: sources';
const END = '/* --- Cases stage 2: status';

function sourcesBlock() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = src.indexOf(MARKER);
  const end = src.indexOf(END, start);
  assert.ok(start >= 0 && end > start, 'the stage-7 block is found');
  return src.slice(start, end);
}

describe('renderer sources section text', () => {
  it('never parses text as HTML: innerHTML only clears, no insertAdjacentHTML, outerHTML, DOMParser or marked', () => {
    const block = sourcesBlock();
    const uses = block.match(/\.innerHTML\s*=[^;\n]*/g) || [];
    assert.ok(uses.length > 0, 'the block clears its containers');
    for (const use of uses) assert.match(use, /^\.innerHTML\s*=\s*''$/, use);
    assert.doesNotMatch(block, /innerHTML\s*\+=/);
    assert.doesNotMatch(block, /insertAdjacentHTML|outerHTML|DOMParser|createContextualFragment|document\.write/);
    assert.doesNotMatch(block, /\bmarked\b/);
  });

  it('never builds a link, a source URL or code from data', () => {
    const block = sourcesBlock();
    assert.doesNotMatch(block, /\.(href|src|srcdoc|action|formAction)\s*=/);
    assert.doesNotMatch(block, /setAttribute\(\s*['"`](href|src|srcdoc|on\w+|style)/i);
    assert.doesNotMatch(block, /\beval\(|new Function\(|\.on\w+\s*=/);
  });

  it('keeps accept-all and user-fact supersede behind a confirm, and accept-all for owner files only', () => {
    const block = sourcesBlock();
    const acceptAll = block.indexOf('acceptVerified(');
    assert.ok(acceptAll > 0, 'accept-all is wired');
    assert.ok(block.lastIndexOf('showConfirmDialog(', acceptAll) > block.lastIndexOf('function ', acceptAll), 'accept-all asks first');
    assert.match(block, /OWNER_ORIGINS|owner-drop/);
    assert.match(block, /provenance === 'user'[\s\S]{0,400}showConfirmDialog\(/);
  });
});
