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

  it('a needs-node window is grey and read-only whatever its stored mode (final review 1)', () => {
    const expected = { tone: 'unreachable', text: 'Not connected to King Louie Node yet: finish setup on Node & connection', readOnly: true };
    for (const mode of ['standalone', 'attached', undefined]) {
      assert.deepEqual(settingsBanner({ mode, launch: { why: 'needs-node' } }), expected);
    }
    assert.deepEqual(settingsBanner({ mode: 'attached', view: 'attached-connected', launch: { why: 'needs-node' } }), expected);
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
    const body = block('function applySettingsInert(');
    assert.match(body, /\.settings-tab-content/);
    assert.match(body, /inert/);
    assert.match(body, /service/);
    assert.match(block('function setSettingsReadOnly('), /applySettingsInert\(true\)/);
  });

  it('read-only to editable re-reads the settings before lifting inert (final review 2)', () => {
    const body = block('function setSettingsReadOnly(');
    // Not re-read since the outage: stay inert, then re-read.
    const pending = body.slice(body.indexOf('if (!settingsNeedReload)'));
    const keepInert = pending.indexOf('applySettingsInert(true)');
    assert.ok(keepInert >= 0 && pending.indexOf('rereadSettingsAfterOutage()') > keepInert, 'stays inert while it re-reads');
    // The re-read lifts only after a load that succeeded, reloading the shown page first.
    const reread = block('function rereadSettingsAfterOutage(');
    const load = reread.indexOf('await loadSettings()');
    const ok = reread.indexOf('if (loaded)');
    const reshow = reread.indexOf('switchSettingsTab(appState.settingsTab');
    const lift = reread.indexOf('applySettingsInert(false)');
    assert.ok(load >= 0 && ok > load && reshow > ok && lift > reshow, 'lifts only after a good load, page reloaded first');
    // loadSettings says whether it loaded.
    const loadBody = block('async function loadSettings(');
    assert.match(loadBody, /return true;/);
    assert.match(loadBody, /return false;/);
  });

  it('dims inert pages', () => {
    assert.match(read('styles.css'), /\.settings-tab-content\[inert\]\s*\{[^}]*opacity/);
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

// Final re-review, item 1: a failed re-read after an outage is retried on one
// timer, 3 s, 6 s, 12 s, then stops with a line beside the banner. The block
// runs in a vm with fake timers and a fake loadSettings.
describe('re-reading settings after an outage: one timer, capped', () => {
  const vm = require('vm');
  const src = read('renderer.js');
  const start = src.indexOf('const SETTINGS_RELOAD_RETRY_MS');
  const end = src.indexOf('function markUnavailableTabs(');
  const code = src.slice(start, end);

  function harness({ loads }) {
    const timers = new Map();
    let nextId = 1;
    const errorEl = { textContent: '', hidden: true };
    const panes = [{ dataset: { tab: 'notifications' }, inert: false }, { dataset: { tab: 'service' }, inert: false }];
    let calls = 0;
    const ctx = {
      document: {
        querySelectorAll: () => panes,
        getElementById: (id) => (id === 'settings-reload-error' ? errorEl : null),
      },
      dom: { settingsDrawer: { hidden: false } },
      appState: { settingsTab: 'notifications' },
      switchSettingsTab: () => {},
      settingsLog: { warn: () => {} },
      loadSettings: async () => { calls += 1; return loads(calls); },
      setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
      clearTimeout: (id) => { timers.delete(id); },
    };
    vm.createContext(ctx);
    vm.runInContext(`${code}\nthis.api = { setSettingsReadOnly, resetSettingsReloadRetries };`, ctx);
    const settle = () => new Promise((r) => setImmediate(r));
    const fire = async () => {
      assert.equal(timers.size, 1, 'exactly one retry timer');
      const [[id, t]] = [...timers];
      timers.delete(id);
      t.fn();
      await settle();
      return t.ms;
    };
    return { ctx, api: ctx.api, timers, errorEl, panes, calls: () => calls, settle, fire };
  }

  it('retries after 3, 6 and 12 s on a single timer, then gives up with a line', async () => {
    const h = harness({ loads: () => false });
    h.api.setSettingsReadOnly(true);
    h.api.setSettingsReadOnly(false);
    await h.settle();
    assert.equal(h.calls(), 1);
    // A repaint while a retry is armed does not start another chain.
    h.api.setSettingsReadOnly(false);
    h.api.setSettingsReadOnly(false);
    await h.settle();
    assert.equal(h.calls(), 1);
    assert.equal(h.timers.size, 1);
    assert.equal(await h.fire(), 3000);
    assert.equal(await h.fire(), 6000);
    assert.equal(await h.fire(), 12000);
    assert.equal(h.calls(), 4);
    assert.equal(h.timers.size, 0, 'stops after the cap');
    assert.equal(h.errorEl.hidden, false);
    assert.equal(h.errorEl.textContent, "Couldn't load settings from the node. Close and reopen Settings to try again.");
    assert.equal(h.panes[0].inert, true, 'pages stay read-only');
    assert.equal(h.panes[1].inert, false, 'Node & connection stays usable');
    // Repaints after giving up start nothing.
    h.api.setSettingsReadOnly(false);
    await h.settle();
    assert.equal(h.calls(), 4);
    // Reopening Settings starts the count again.
    h.api.resetSettingsReloadRetries();
    assert.equal(h.errorEl.hidden, true);
    h.api.setSettingsReadOnly(false);
    await h.settle();
    assert.equal(h.calls(), 5);
    assert.equal(h.timers.size, 1);
  });

  it('a read-only status clears the armed timer; a success clears everything and lifts', async () => {
    const h = harness({ loads: (n) => n >= 2 });
    h.api.setSettingsReadOnly(true);
    h.api.setSettingsReadOnly(false);
    await h.settle();
    assert.equal(h.timers.size, 1);
    h.api.setSettingsReadOnly(true);
    assert.equal(h.timers.size, 0, 'read-only clears the timer');
    h.api.setSettingsReadOnly(false);
    await h.settle();
    assert.equal(h.calls(), 2);
    assert.equal(h.timers.size, 0);
    assert.equal(h.panes[0].inert, false, 'lifted after a good read');
    assert.equal(h.errorEl.hidden, true);
  });

  it('closed Settings does not re-read or retry; it re-reads on opening', async () => {
    const h = harness({ loads: () => false });
    h.api.setSettingsReadOnly(true);
    h.ctx.dom.settingsDrawer.hidden = true;
    h.api.setSettingsReadOnly(false);
    await h.settle();
    assert.equal(h.calls(), 0);
    h.ctx.dom.settingsDrawer.hidden = false;
    h.api.setSettingsReadOnly(false);
    await h.settle();
    assert.equal(h.calls(), 1);
    h.ctx.dom.settingsDrawer.hidden = true;
    await h.fire();
    assert.equal(h.calls(), 1, 'a timer that fires with Settings closed does not read');
    assert.equal(h.timers.size, 0);
  });
});
