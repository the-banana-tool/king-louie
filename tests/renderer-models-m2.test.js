// tests/renderer-models-m2.test.js
// Static checks on the renderer for models M2 (spec 2026-09-27 §11): the API
// keys tab holds keys only, the Models tab replaces the Inference and Smart
// Routing tabs, and model-derived text is set as text, never parsed as HTML.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function block(start, end = '\nfunction ') {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: settings tabs for models M2', () => {
  it('has an API keys tab and a Models tab, and no Inference or Smart Routing tab', () => {
    assert.match(html, /<option value="providers">API keys<\/option>/);
    assert.match(html, /<option value="models">Models<\/option>/);
    assert.doesNotMatch(html, /value="inference"|value="routing"|data-tab="inference"|data-tab="routing"/);
    assert.doesNotMatch(html, /llm-routing|smart-routing|inference-tier/);
    assert.match(html, /data-tab="models"/);
    for (const id of ['models-profile-list', 'models-profile-editor', 'models-new-profile-btn', 'models-catalog-status', 'models-catalog-fetch', 'models-catalog-refresh-hours', 'models-catalog-overrides', 'models-save-catalog-btn', 'models-test-all-btn']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
  });

  it('keeps model choice off the API keys tab', () => {
    const card = block('function renderProviderCard(providerKey, provider)');
    assert.doesNotMatch(card, /set-active|modelProvider|listModels|active-provider-badge/);
    assert.doesNotMatch(src, /setActiveProvider|setProviderModel|saveSmartRouting|saveLlmRouting|renderSmartRoutingRules|renderInferenceTierDetails/);
    assert.doesNotMatch(src, /\['\/fast', '\/standard', '\/smart'\]/);
    assert.doesNotMatch(src, /switch inference tier/);
  });

  it('builds the profile list, editor and picker from the models channels, as text', () => {
    assert.match(block('async function loadModelProfiles()'), /window\.electron\.models\.profiles\(\)/);
    const list = block('function renderModelProfileList()');
    assert.match(list, /migration/);
    const entry = block('function renderRoleEntry(role, entry, index, count)');
    assert.match(entry, /is-unusable/);
    assert.match(entry, /reasons\.join/);
    const picker = block('async function openModelPicker(role, block)');
    assert.match(picker, /window\.electron\.models\.picker\(/);
    for (const fn of [list, entry, picker, block('function renderProfileEditor()')]) {
      assert.doesNotMatch(fn, /innerHTML\s*=\s*(?!'')/, 'model and profile text is never parsed as HTML');
      assert.doesNotMatch(fn, /\bconfirm\(|\balert\(|\bprompt\(/, 'no native dialogs');
    }
    assert.match(block('async function saveProfileDraft()'), /window\.electron\.models\.saveProfile\(/);
  });

  it('saves the catalog settings through their own channel', () => {
    assert.match(src, /window\.electron\.models\.saveCatalogSettings\(/);
  });
});
