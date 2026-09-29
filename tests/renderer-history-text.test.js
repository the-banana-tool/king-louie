// tests/renderer-history-text.test.js
// Static checks on the recall line (recall spec §7): its wording, and that
// excerpt text (untrusted) is set with textContent, never parsed as HTML.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: the recall line', () => {
  it('reads like the spec, and says BM25', () => {
    const fns = block('function formatCompactTokens(', '\nfunction renderRecallLine(');
    const { formatCompactTokens, recallLineText } = new Function(`${fns}; return { formatCompactTokens, recallLineText };`)();
    assert.strictEqual(formatCompactTokens(950), '950');
    assert.strictEqual(formatCompactTokens(1850), '1.9K');
    assert.strictEqual(formatCompactTokens(412000), '412K');
    assert.strictEqual(formatCompactTokens(2200000), '2.2M');
    assert.strictEqual(recallLineText({ recalledExcerpts: 3, estTokens: { recalled: 1850 }, fullHistoryEstTokens: 412000 }),
      'recalled 3 excerpts · about 1.9K tokens · from 412K tokens of history · BM25');
    assert.strictEqual(recallLineText({ recalledExcerpts: 1, estTokens: { recalled: 40 }, fullHistoryEstTokens: 900 }),
      'recalled 1 excerpt · about 40 tokens · from 900 tokens of history · BM25');
  });

  it('renders under assistant messages with provenance, excerpts as text', () => {
    const add = block('function addMessage(sender, text, metadata = {})', '\nasync function loadChats()');
    assert.match(add, /metadata\?\.context/);
    assert.match(add, /renderRecallLine\(/);
    const line = block('function renderRecallLine(', '\n}\n');
    assert.doesNotMatch(line, /innerHTML/);
    assert.match(line, /textContent/);
    assert.match(line, /window\.electron\.history\.excerpts\(/);
    assert.match(src, /context: message\?\.context/);
    assert.match(src, /seq: message\?\.seq/);
    assert.match(preload, /ipcRenderer\.invoke\('history:excerpts'/);
  });
});
