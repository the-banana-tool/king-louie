// tests/renderer-history-rerank.test.js
// The reranker in the UI (recall spec §7, §14): the recall line says
// "reranked" when one ran, the pane says what Jev is doing and what it
// sends, saving it needs the confirmation, the key field is cleared and
// never filled from the host, and the send path copies the provenance.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const src = read('renderer.js');
const html = read('index.html');
const preload = read('preload.js');
const chat = read('src/ipc/chat-handlers.js');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: the reranker', () => {
  it('the recall line says reranked when a reranker ran', () => {
    const line = new Function(`${block('function formatCompactTokens(', '\nfunction renderRecallLine(')}; return recallLineText;`)();
    const base = { recalledExcerpts: 3, estTokens: { recalled: 1900 }, fullHistoryEstTokens: 412000 };
    assert.match(line({ ...base, embedder: 'local:Xenova/all-MiniLM-L6-v2', reranker: 'jev:jev-1.13.0' }), / · BM25 \+ vectors · reranked$/);
    assert.match(line({ ...base, embedder: 'none', reranker: 'local:Xenova/ms-marco-MiniLM-L-6-v2' }), / · BM25 · reranked$/);
    assert.match(line({ ...base, embedder: 'none', reranker: null, rerankSkipped: 'no typesafe.ai key is saved' }), / · BM25$/);
    assert.match(line({ ...base, embedder: 'none' }), / · BM25$/);
  });

  it('says what Jev is doing, with tokens and no price', () => {
    const f = new Function(`${block('function historyRerankStatusText(', '\nfunction stopHistoryStatusPoll(')}; return historyRerankStatusText;`)();
    assert.strictEqual(f(undefined), 'Reranking runs on this computer.');
    assert.strictEqual(f({ kind: 'local', state: 'off' }), 'Reranking runs on this computer.');
    assert.strictEqual(f({ kind: 'jev', state: 'not-started' }), 'Jev starts with the app’s background checks.');
    assert.strictEqual(f({ kind: 'jev', state: 'no-key' }), 'Jev is chosen, but no typesafe.ai key is saved: results keep their order.');
    assert.strictEqual(f({ kind: 'jev', state: 'refused', error: 'typesafe.ai refused the key (401); save a new key or press Retry' }),
      'Jev is paused, results keep their order: typesafe.ai refused the key (401); save a new key or press Retry');
    assert.strictEqual(f({ kind: 'jev', state: 'failing', error: 'typesafe.ai failed (HTTP 500)', tokens: 120 }),
      'Jev failed last time, results kept their order: typesafe.ai failed (HTTP 500). 120 tokens sent this session (price unknown).');
    assert.strictEqual(f({ kind: 'jev', state: 'ready', model: 'jev-1.13.0', tokens: 2400 }),
      'Jev is ready (jev-1.13.0). 2400 tokens sent this session (price unknown).');
    assert.doesNotMatch(f({ kind: 'jev', state: 'ready', tokens: 5 }), /\$/);
  });

  it('the pane: the choice, the one plain sentence, the confirmation and the key field', () => {
    for (const id of ['history-rerank-kind', 'history-rerank-jev-confirm', 'history-rerank-jev-note', 'history-jev-key',
      'history-jev-key-save-btn', 'history-jev-key-clear-btn', 'history-rerank-status']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /<option value="local">On this computer \(cross-encoder\)<\/option>/);
    assert.match(html, /<option value="jev">typesafe\.ai Jev \(hosted, opt-in\)<\/option>/);
    assert.match(html, /For every chat, case chats included, Jev sends your new message and about 100 excerpts of this chat to typesafe\.ai each time it reranks\./);
    assert.match(html, /<input id="history-jev-key"[^>]*type="password"/);
  });

  it('text by textContent only; the key field is cleared at once and never filled; saving sends the confirmation', () => {
    const pane = block('function historyRerankStatusText(', '\nfunction wireHistorySettings(');
    assert.doesNotMatch(pane, /innerHTML/);
    assert.match(pane, /textContent = historyRerankStatusText\(/);
    assert.strictEqual((pane.match(/'history-jev-key'/g) || []).length, 1, 'read in one place only');
    assert.match(pane, /input\.value = '';/);
    assert.match(pane, /confirmJev: document\.getElementById\('history-rerank-jev-confirm'\)\.checked/);
    assert.match(pane, /kind: document\.getElementById\('history-rerank-kind'\)\.value/);
    const wire = block('function wireHistorySettings(', '\nif (document.readyState');
    assert.match(wire, /on\('history-jev-key-save-btn', saveHistoryJevKey\)/);
    assert.match(wire, /on\('history-jev-key-clear-btn', clearHistoryJevKey\)/);
  });

  it('preload exposes the key channels; the send path copies the provenance', () => {
    for (const ch of ['history:jev.saveKey', 'history:jev.clearKey']) {
      assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${ch.replace('.', '\\.')}'`), ch);
    }
    assert.match(chat, /reranker: built\.stats\.reranker \?\? null/);
    assert.match(chat, /rerankSkipped: built\.stats\.rerankSkipped \?\? null/);
  });
});
