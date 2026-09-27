// tests/renderer-playbooks-text.test.js
// Cases stage 6: the renderer's playbook panel shows case and playbook text,
// which can quote package text, as plain text only. A static check over the
// block between the stage-6 marker and renderChatInfoPopover.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MARKER = '/* --- Cases stage 6: playbooks';
const END = 'function renderChatInfoPopover() {';

function playbookBlock() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = src.indexOf(MARKER);
  const end = src.indexOf(END, start);
  assert.ok(start >= 0 && end > start, 'the stage-6 block is found');
  return src.slice(start, end);
}

describe('renderer playbooks panel text', () => {
  it('never parses text as HTML: innerHTML only clears, no insertAdjacentHTML, outerHTML or marked', () => {
    const block = playbookBlock();
    const uses = block.match(/\.innerHTML\s*=[^;\n]*/g) || [];
    assert.ok(uses.length > 0, 'the block clears its container');
    for (const use of uses) assert.match(use, /^\.innerHTML\s*=\s*''$/, use);
    assert.doesNotMatch(block, /innerHTML\s*\+=/);
    assert.doesNotMatch(block, /insertAdjacentHTML|outerHTML|DOMParser|createContextualFragment|document\.write/);
    assert.doesNotMatch(block, /\bmarked\b/);
  });
});
