// tests/renderer-history-settings.test.js
// Static checks on the History and recall pane (recall spec §14) and the
// recall line's retrieval word (§7): wording per state, text set with
// textContent only, the channels in preload, the controls in index.html.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const src = read('renderer.js');
const html = read('index.html');
const preload = read('preload.js');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: History and recall pane', () => {
  it('says what each state means', () => {
    const f = new Function(`${block('function historyEmbedderStatusText(', '\nfunction stopHistoryStatusPoll(')}; return historyEmbedderStatusText;`)();
    assert.strictEqual(f({ state: 'off' }), 'Off: recall uses keyword search only.');
    assert.strictEqual(f({ state: 'starting' }), 'Loading the embedding model…');
    assert.strictEqual(f({ state: 'downloading', download: { loaded: 25, total: 100 } }), 'Downloading the embedding model: 25%');
    assert.strictEqual(f({ state: 'ready' }, { embedded: 30, pending: 10 }), 'Ready. Embedding the history: 75% (10 chunks to go)');
    assert.strictEqual(f({ state: 'ready' }, { embedded: 40, pending: 0 }), 'Ready. All history is embedded.');
    assert.strictEqual(f({ state: 'unavailable', error: 'fetch failed' }), 'Not available, keyword search only: fetch failed');
    assert.strictEqual(f({ state: 'disabled', error: 'the embedding worker kept crashing' }), 'Stopped for this session, keyword search only: the embedding worker kept crashing');
  });

  it('sets text with textContent only, and opens with the tab', () => {
    const pane = block('function historyEmbedderStatusText(', '\nfunction wireHistorySettings(');
    assert.doesNotMatch(pane, /innerHTML/);
    assert.match(pane, /textContent/);
    assert.match(block('function switchSettingsTab(', '\nfunction sortSettingsNavOptions('), /tabName === 'history'/);
  });

  it('index.html has the tab and its controls', () => {
    assert.match(html, /<option value="history">History and recall<\/option>/);
    assert.match(html, /data-tab="history"/);
    for (const id of ['history-embedder-kind', 'history-rerank-search', 'history-embedder-model', 'history-ollama-url', 'history-ollama-model',
      'history-openai-model', 'history-rerank-turn', 'history-embedder-save-btn', 'history-embedder-retry-btn', 'history-embedder-rebuild-btn', 'history-embedder-status']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /sends chat text to OpenAI/);
  });

  it('preload exposes the four embedder channels', () => {
    for (const ch of ['history:embedder.status', 'history:embedder.save', 'history:embedder.rebuild', 'history:embedder.retry']) {
      assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${ch.replace('.', '\\.')}'`), ch);
    }
  });
});
