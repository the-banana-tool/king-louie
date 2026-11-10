// tests/renderer-settings-shell.test.js
// Static checks on the Settings drawer's shell (settings redesign spec §5.1):
// a grouped sidebar with search replaces the dropdown, no pane is active in
// the markup, and Settings opens on the page last shown.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\r\n').join('\n');
const src = read('renderer.js');
const html = read('index.html');

function block(start, end = '\nfunction ') {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('settings shell: index.html', () => {
  it('has the sidebar, the search box and the local servers page, and no dropdown', () => {
    assert.match(html, /id="settings-sidebar"/);
    assert.match(html, /id="settings-search"/);
    assert.match(html, /data-tab="local-servers"/);
    assert.doesNotMatch(html, /settings-nav-select/);
  });

  it('marks no pane active in the markup', () => {
    const panes = html.match(/<div class="settings-tab-content[^"]*"/g) || [];
    assert.ok(panes.length > 10, 'panes found');
    for (const p of panes) assert.doesNotMatch(p, /\bactive\b/, p);
  });

  it('loads settings-nav.js before renderer.js', () => {
    const nav = html.indexOf('<script src="renderer-helpers/settings-nav.js"></script>');
    const renderer = html.indexOf('<script src="renderer.js"></script>');
    assert.ok(nav > 0, 'settings-nav.js loaded');
    assert.ok(renderer > nav, 'before renderer.js');
  });
});

describe('settings shell: renderer.js', () => {
  it('switchSettingsTab sets the active item, remembers the page and hides sections', () => {
    const body = block('function switchSettingsTab(', 'function renderSettingsNav(');
    assert.ok(body.includes("classList.toggle('is-active'"), 'is-active');
    assert.ok(body.includes('kl-settings-last-tab'), 'remembers the page');
    assert.ok(body.includes('hiddenSections('), 'hides sections');
  });

  it('openSettingsDrawer opens on the remembered page', () => {
    assert.ok(block('function openSettingsDrawer(').includes('switchSettingsTab(resolveInitialTab('));
  });

  it('closing the drawer flushes pending autosaves', () => {
    assert.ok(block('function setSettingsDrawer(').includes('flushSettingsAutosaves()'));
  });

  it('has no dropdown sorter', () => {
    assert.doesNotMatch(src, /sortSettingsNavOptions/);
    assert.doesNotMatch(src, /settingsNavSelect/);
  });

  it('draws the sidebar from the visible groups, labels as text', () => {
    const nav = block('function renderSettingsNav(');
    assert.match(nav, /visibleGroups\(SETTINGS_GROUPS/);
    assert.doesNotMatch(nav, /innerHTML\s*=\s*(?!'')/);
    assert.match(nav, /textContent/);
  });
});

// Task 4 (spec §5.3): Commands, Workflows and Mesh leave Settings, and memory
// gets its own panel beside the gear.
describe('settings shell: pages that leave Settings', () => {
  it('index.html has no commands, workflows or mesh pane', () => {
    assert.doesNotMatch(html, /data-tab="commands"/);
    assert.doesNotMatch(html, /data-tab="workflows"/);
    assert.doesNotMatch(html, /data-tab="mesh"/);
    assert.doesNotMatch(html, /data-tab="memory"/);
  });

  it('memory has its own panel, opened by a button beside the gear', () => {
    assert.match(html, /id="memory-panel"/);
    assert.match(html, /id="open-memory-btn"/);
    // The panel is its own overlay, so it ends where the next overlay starts.
    const panelAt = html.indexOf('id="memory-panel"');
    const next = html.indexOf('class="settings-overlay"', panelAt);
    const panelEnd = next < 0 ? html.indexOf('<script', panelAt) : next;
    const listAt = html.indexOf('id="memory-list"');
    assert.ok(listAt > panelAt && listAt < panelEnd, '#memory-list inside #memory-panel');
    assert.match(html, /class="settings-overlay" id="memory-panel" hidden>\s*<div class="settings-modal memory-modal"/);
    const gear = html.indexOf('id="open-settings-btn"');
    const brain = html.indexOf('id="open-memory-btn"');
    assert.ok(Math.abs(brain - gear) < 400, 'beside the gear');
  });

  it('the mesh indicator does not open Settings', () => {
    assert.doesNotMatch(src, /switchSettingsTab\(\s*'(mesh|workflows|commands|memory)'\s*\)/);
    let at = src.indexOf('meshIndicatorBtn.addEventListener');
    while (at >= 0) {
      const slice = src.slice(at, src.indexOf('});', at));
      assert.doesNotMatch(slice, /switchSettingsTab|openSettingsDrawer/);
      at = src.indexOf('meshIndicatorBtn.addEventListener', at + 1);
    }
  });

  it('the memory button opens the panel and loads the entries', () => {
    const at = src.indexOf('openMemoryBtn.addEventListener');
    assert.ok(at >= 0, 'handler found');
    const body = block('function openMemoryPanel(');
    assert.match(body, /loadMemoryEntries\(\)/);
  });

  it('loadSettings no longer loads memory, workflows or mesh', () => {
    const body = block('async function loadSettings(');
    assert.doesNotMatch(body, /loadMemoryEntries|loadWorkflows|loadMeshStatus/);
  });
});
