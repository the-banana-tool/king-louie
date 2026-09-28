// tests/renderer-models-text.test.js
// Static checks on the renderer for models M1 (spec 2026-09-27 §11, §18):
// the chat info popover lists only usable models, a stopped reply is marked,
// and model-derived text is set as text, never parsed as HTML.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: models M1', () => {
  it('the header\'s main switcher lists usable models from the chat\'s view, not a hardcoded provider list', () => {
    const render = block('function renderChatModels(view)', '\nfunction ');
    assert.doesNotMatch(render, /providerDisplayNames/);
    assert.match(src, /window\.electron\.models\.chatView\(/);
    assert.doesNotMatch(block('function renderChatInfoPopover()', '\nfunction '), /window\.electron\.settings\.listModels\(/);
  });

  it('marks a stopped reply, as text', () => {
    const add = block('function addMessage(sender, text, metadata = {})', '\nasync function loadChats()');
    assert.match(add, /message-stopped-marker/);
    assert.match(add, /metadata\?\.stopped/);
    assert.match(add, /partial usage/);
    assert.match(add, /unpriced/);
  });

  it('keeps a stopped reply with no text visible', () => {
    assert.match(src, /if \(!displayText && !message\.stopped\) return;/);
  });

  it('shows catalog status, Refresh now, Test all and the Ollama address', () => {
    for (const id of ['models-catalog-status', 'models-refresh-catalog-btn', 'models-test-all-btn']) assert.match(html, new RegExp(`id="${id}"`));
    const models = block('/* --- Models M1: catalog status, Test all, the Ollama address --- */', '\nfunction closeContextMenu()');
    assert.doesNotMatch(models, /innerHTML\s*=\s*[^'"\s]/, 'catalog and status text is set with textContent');
    assert.match(src, /dataset\.action = 'save-ollama-url'/);
    assert.match(src, /window\.electron\.models\.onStatusChanged\(/);
  });
});
