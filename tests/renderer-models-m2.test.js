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

describe('renderer: the chat header and Retry with…', () => {
  it('has the profile picker and main switcher in the header', () => {
    for (const id of ['chat-models-switcher', 'chat-profile-select', 'chat-main-select', 'chat-main-override-marker']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
  });

  it('fills them from the chat\'s own view, as text', () => {
    assert.match(block('async function refreshChatModels()'), /window\.electron\.models\.chatView\(/);
    const render = block('function renderChatModels(view)');
    assert.match(render, /view\.choices/);
    assert.match(render, /__reset__/);
    assert.doesNotMatch(render, /innerHTML\s*=\s*(?!'')/);
    assert.match(block('async function switchMainModel(target)'), /window\.electron\.models\.setMainOverride\(/);
  });

  it('the popover keeps its cost information and loses its tier, provider and model controls', () => {
    const popover = block('function renderChatInfoPopover()');
    assert.match(popover, /Estimated cost/);
    assert.doesNotMatch(popover, /setInferenceTier|setTierProviderModel|tierSelect|chat-info-provider-select|chat-info-model-select/);
    assert.doesNotMatch(src, /getActiveInferenceTier|formatInferenceTierLabel/);
    assert.doesNotMatch(block('function renderChatMessages()'), /Tier/);
  });

  it('Retry with… truncates, then switches main, then re-sends', () => {
    const resend = block('async function resendFromIndex(chatId, msgIndex, { beforeSend = null } = {})');
    const truncate = resend.indexOf('window.electron.chat.truncateFrom(');
    const before = resend.indexOf('beforeSend()');
    const send = resend.indexOf('window.electron.chat.sendMessage(');
    assert.ok(truncate > 0 && before > truncate && send > before, 'truncate → switch → send');
    assert.match(block('async function retryWith(target)'), /switchMainModel\(target\)/);
    assert.match(block('function renderRetryControl()'), /retry-with-btn/);
  });

  it('an unusable override error offers the profile\'s main in one click', () => {
    const i = src.indexOf('window.electron.chat.onMessageError(');
    const handler = src.slice(i, src.indexOf('\n}));', i));
    assert.match(handler, /use-profile-main/);
    assert.match(handler, /switchMainModel\(null\)/);
    assert.match(handler, /open-models/);
  });

  it('disables the header selects while a turn is running for this chat (fix round 1)', () => {
    assert.match(block('function setResponseActive(active, chatId)'), /applyChatModelsGate\(\)/);
    const gate = block('function applyChatModelsGate()');
    assert.match(gate, /activeResponses\.has\(appState\.activeChatId\)/);
    assert.match(gate, /chatProfileSelect\.disabled = busy/);
    assert.match(gate, /chatMainSelect\.disabled = busy/);
    assert.match(block('function renderChatModels(view)'), /applyChatModelsGate\(\)/);
    // A stray programmatic change event (not just user interaction with a
    // disabled control) is guarded too, and reverts to the served state.
    const profileHandler = block("dom.chatProfileSelect.addEventListener('change'", '\n}');
    assert.match(profileHandler, /activeResponses\.has\(chatId\)/);
    assert.match(profileHandler, /renderChatModels\(appState\.chatModels\)/);
    const mainHandler = block("dom.chatMainSelect.addEventListener('change'", '\n}');
    assert.match(mainHandler, /activeResponses\.has\(chatId\)/);
  });
});
