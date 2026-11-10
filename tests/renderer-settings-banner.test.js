'use strict';
// The Settings banner (settings redesign spec §5.2, §8.2, §8.3): which machine's
// settings the window is editing, and whether its pages may be changed now.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { settingsBanner, switchToNodeAction } = require('../renderer-helpers/settings-banner');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\r\n').join('\n');

describe('settingsBanner', () => {
  it('development standalone', () => {
    assert.deepEqual(settingsBanner({ mode: 'standalone', launch: { why: 'dev' } }),
      { tone: 'dev', text: 'Development standalone', readOnly: false });
  });

  it('any other standalone window edits this desktop only', () => {
    for (const why of ['once', 'platform', undefined]) {
      assert.deepEqual(settingsBanner({ mode: 'standalone', launch: why ? { why } : undefined }),
        { tone: 'desktop', text: 'Editing this desktop only, not your node', readOnly: false });
    }
  });

  it('attached and connected names the node', () => {
    assert.deepEqual(settingsBanner({ mode: 'attached', view: 'attached-connected', service: { nodeName: 'gpu-box', hosting: 'service' } }),
      { tone: 'node', text: 'Editing King Louie Node on gpu-box', readOnly: false });
  });

  it('attached and connected to a personal node says it runs as you', () => {
    assert.deepEqual(settingsBanner({ mode: 'attached', view: 'attached-connected', service: { nodeName: 'desk' }, pairing: { service: { hosting: 'personal' } } }),
      { tone: 'node', text: 'Editing King Louie Node on desk (running as you)', readOnly: false });
  });

  it('attached and starting is read-only', () => {
    assert.deepEqual(settingsBanner({ mode: 'attached', view: 'attached-starting', pairing: { service: { name: 'desk' } } }),
      { tone: 'unreachable', text: 'Starting desk…', readOnly: true });
  });

  it('attached and disconnected is grey and read-only (review focus 1)', () => {
    assert.deepEqual(settingsBanner({ mode: 'attached', view: 'attached-disconnected', node: { name: 'desk' } }),
      { tone: 'unreachable', text: "Can't reach desk: changes won't be saved until it's back", readOnly: true });
  });

  it('falls back to "your node" with no name anywhere', () => {
    assert.equal(settingsBanner({ mode: 'attached', view: 'paired' }).text, "Can't reach your node: changes won't be saved until it's back");
    assert.equal(settingsBanner({ mode: 'attached', view: 'attached-connected' }).text, 'Editing King Louie Node on your node');
  });

  it('handles no status at all', () => {
    assert.equal(settingsBanner(null).tone, 'desktop');
  });
});

describe('switchToNodeAction', () => {
  it('offers leave-standalone only for a standalone-once window on Windows', () => {
    assert.equal(switchToNodeAction({ mode: 'standalone', launch: { why: 'once' }, platform: 'win32' }), 'leave-standalone');
    assert.equal(switchToNodeAction({ mode: 'standalone', launch: { why: 'dev' }, platform: 'win32' }), null);
    assert.equal(switchToNodeAction({ mode: 'standalone', launch: { why: 'once' }, platform: 'linux' }), null);
    assert.equal(switchToNodeAction({ mode: 'attached', launch: { why: 'once' }, platform: 'win32' }), null);
    assert.equal(switchToNodeAction(null), null);
  });
});

describe('the renderer draws the banner as text (review focus 5)', () => {
  const src = read('renderer.js');
  const html = read('index.html');

  function block(start) {
    const i = src.indexOf(start);
    assert.ok(i >= 0, `found ${start}`);
    // The body ends at the next top-level line (a closing brace at column 0).
    const j = src.indexOf('\n}', i + start.length);
    assert.ok(j > i, `end of ${start}`);
    return src.slice(i, j);
  }

  it('paintSettingsBanner sets textContent and never innerHTML', () => {
    const body = block('function paintSettingsBanner(');
    assert.match(body, /\.textContent =/);
    assert.doesNotMatch(body, /innerHTML/);
    assert.match(body, /setSettingsReadOnly\(/);
  });

  it('setSettingsReadOnly makes every page but Node & connection inert', () => {
    const body = block('function setSettingsReadOnly(');
    assert.match(body, /\.settings-tab-content/);
    assert.match(body, /inert/);
    assert.match(body, /service/);
  });

  it('the banner is painted on each status and on opening Settings', () => {
    assert.match(block('async function refreshServiceStatus('), /paintSettingsBanner\(status\)/);
    assert.match(block('function openSettingsDrawer('), /paintSettingsBanner\(/);
  });

  it('a status that cannot be read after a good one turns an attached banner grey (review focus 1)', () => {
    const body = block('async function refreshServiceStatus(');
    const failed = body.slice(body.indexOf('if (!status || status.ok === false)'), body.indexOf('serviceStatusRead = true;'));
    assert.match(failed, /appState\.desktopStatus\.mode === 'attached'/);
    assert.match(failed, /paintSettingsBanner\(\{ \.\.\.appState\.desktopStatus, view: 'attached-disconnected' \}\)/);
  });

  it('index.html has the banner, the save state and loads the helper', () => {
    const header = html.slice(html.indexOf('<div class="settings-overlay" id="settings-drawer"'), html.indexOf('<div class="settings-sidebar">'));
    assert.match(header, /<div id="settings-where" class="settings-where"><\/div>/);
    assert.match(header, /<span id="settings-save-state"><\/span>/);
    assert.match(html, /<script src="renderer-helpers\/settings-banner\.js"><\/script>/);
  });
});
