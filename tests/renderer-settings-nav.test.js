'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SETTINGS_GROUPS,
  visibleGroups,
  hiddenSections,
  matchSettings,
  resolveInitialTab,
} = require('../renderer-helpers/settings-nav');

const FLEET_UNAVAILABLE = ['mcp', 'channels', 'hooks', 'skills', 'webhooks', 'workflows', 'mesh', 'diagnostics', 'system-apps'];

const tabsOf = (group) => group.pages.map((p) => p.tab);
const byLabel = (groups, label) => groups.find((g) => g.label === label);
const pageCount = (groups) => groups.reduce((n, g) => n + g.pages.length, 0);

describe('settings navigation model', () => {
  it('groups match the spec', () => {
    const expected = [
      ['Models', [['Model profiles', 'models'], ['Providers & keys', 'providers'], ['Local servers', 'local-servers']]],
      ['Chats', [['New chats', 'general'], ['About you', 'profile'], ['History & recall', 'history'], ['Voice', 'voice']]],
      ['Reaching you', [['Notifications', 'notifications'], ['Contact ladder', 'contact'], ['Telegram & Discord', 'channels']]],
      ['Tools', [['MCP servers', 'mcp'], ['Skills', 'skills'], ['Permissions & hooks', 'permissions'], ['Scheduled jobs', 'scheduler'], ['Webhooks', 'webhooks'], ['Apps on this computer', 'system-apps']]],
      ['Security', [['Vault', 'vault']]],
      ['This computer', [['Node & connection', 'service'], ['Diagnostics', 'diagnostics']]],
    ];
    assert.deepEqual(
      SETTINGS_GROUPS.map((g) => [g.label, g.pages.map((p) => [p.label, p.tab])]),
      expected,
    );
    const perm = SETTINGS_GROUPS.flatMap((g) => g.pages).find((p) => p.tab === 'permissions');
    assert.deepEqual(perm.sections, ['permissions', 'hooks']);
    const allTabs = SETTINGS_GROUPS.flatMap((g) => g.pages.flatMap((p) => [p.tab, ...(p.sections || [])]));
    for (const gone of ['mesh', 'workflows', 'commands', 'memory']) {
      assert.ok(!allTabs.includes(gone), `${gone} must not be a page`);
    }
    for (const g of SETTINGS_GROUPS) {
      assert.equal(typeof g.id, 'string');
      for (const p of g.pages) assert.ok(Array.isArray(p.keywords));
    }
  });

  it('fleet attach hides', () => {
    const groups = visibleGroups(SETTINGS_GROUPS, FLEET_UNAVAILABLE);
    const tools = byLabel(groups, 'Tools');
    assert.deepEqual(tabsOf(tools), ['permissions', 'scheduler']);
    const perm = tools.pages.find((p) => p.tab === 'permissions');
    assert.deepEqual(hiddenSections(perm, FLEET_UNAVAILABLE), ['hooks']);
    assert.deepEqual(tabsOf(byLabel(groups, 'Reaching you')), ['notifications', 'contact']);
    assert.deepEqual(tabsOf(byLabel(groups, 'This computer')), ['service']);
  });

  it('a merged page goes only when every section is unavailable; empty groups drop', () => {
    const groups = visibleGroups(SETTINGS_GROUPS, ['permissions', 'hooks', 'vault']);
    const tools = byLabel(groups, 'Tools');
    assert.ok(!tabsOf(tools).includes('permissions'));
    assert.equal(byLabel(groups, 'Security'), undefined);
    assert.deepEqual(hiddenSections(byLabel(SETTINGS_GROUPS, 'Models').pages[0], ['hooks']), []);
  });

  it('personal attach hides nothing visible', () => {
    assert.equal(pageCount(visibleGroups(SETTINGS_GROUPS, ['mesh'])), pageCount(SETTINGS_GROUPS));
  });

  it('skill pages join Tools', () => {
    const groups = visibleGroups(SETTINGS_GROUPS, [], [{ tab: 'skill-x', label: 'X' }]);
    const tabs = tabsOf(byLabel(groups, 'Tools'));
    assert.equal(tabs[tabs.indexOf('skills') + 1], 'skill-x');
    assert.equal(pageCount(SETTINGS_GROUPS), 19, 'the source table is not changed');
  });

  it('search', () => {
    assert.equal(matchSettings('openrouter', SETTINGS_GROUPS)[0].tab, 'providers');
    assert.equal(matchSettings('quiet', SETTINGS_GROUPS)[0].tab, 'contact');
    assert.deepEqual(matchSettings('', SETTINGS_GROUPS), []);
    const hit = matchSettings('VOICE', SETTINGS_GROUPS)[0];
    assert.deepEqual(hit, { tab: 'voice', label: 'Voice', groupLabel: 'Chats' });
  });

  it('initial tab', () => {
    const all = visibleGroups(SETTINGS_GROUPS, []);
    const fleetVisible = visibleGroups(SETTINGS_GROUPS, FLEET_UNAVAILABLE);
    assert.equal(resolveInitialTab('mesh', all), 'models');
    assert.equal(resolveInitialTab('voice', all), 'voice');
    assert.equal(resolveInitialTab(null, all), 'models');
    assert.equal(resolveInitialTab('hooks', fleetVisible), 'models');
  });
});
