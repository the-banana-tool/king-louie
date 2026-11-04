// tests/desktop-bridge-remote-classes.test.js
// Remote window plan, R-RW-11: every channel and call method has one class, read
// from what the code really serves, so a new channel fails here until someone
// classes it. A name with no class is refused at run time: remoteClassOf says null.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { listIpcChannels } = require('../src/ipc/channel-inventory');
const { servedChannels, classifyChannel } = require('../src/desktop-bridge/allowlist');
const {
  CLASSES, REMOTE_CLASSES, CALL_METHODS, PRESS_CHANNELS_REMOTE, remoteClassOf, remotePayloadClass, assertComplete
} = require('../src/desktop-bridge/remote-classes');

const ROOT = path.join(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const inventory = listIpcChannels();
const allChannels = [...inventory.handle, ...inventory.on];

// In the table ahead of the code: the tasks that register them come later in
// this plan (the window's node channels).
// Nothing else may be unknown to the served lists.
const TABLED_AHEAD = new Set([
  'desktop:nodes', 'desktop:addFrontDoor', 'desktop:listFrontDoorNodes', 'desktop:addRemoteNode',
  'desktop:forgetNode', 'desktop:enrollRemote', 'desktop:remoteStatus', 'desktop:nodeRemoteWindow'
]);

// The t:'call' methods, read from the dispatcher's own switch.
function dispatcherCallMethods() {
  const text = source('src/desktop-bridge/bridge-dispatcher.js');
  const start = text.indexOf('async function callMethod(');
  const end = text.indexOf('async function onCall(');
  assert.ok(start !== -1 && end > start, 'the dispatcher still has callMethod and onCall');
  return [...text.slice(start, end).matchAll(/case '([^']+)':/g)].map((m) => m[1]);
}

// The elements of one `const NAME = Object.freeze([...])` in a source file.
function frozenList(file, name) {
  const match = source(file).match(new RegExp(`const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`));
  assert.ok(match, `${file} still declares ${name}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('every name has a class', () => {
  for (const hosting of ['personal', 'service']) {
    it(`every channel served under '${hosting}'`, () => {
      const served = servedChannels(inventory, { hosting });
      assert.ok(served.handle.length > 100, 'the served list is the real one');
      assert.ok(served.on.includes('agent:userResponse'));
      const missing = [...served.handle, ...served.on].filter((ch) => remoteClassOf(ch) === null);
      assert.deepStrictEqual(missing, []);
    });
  }

  it('every channel the window answers itself is local', () => {
    const windows = allChannels.filter((ch) => ['local', 'prestep'].includes(classifyChannel(ch, { hosting: 'personal' })));
    assert.ok(windows.includes('app:quitWindow'));
    assert.ok(windows.includes('history:import.pick'));
    assert.ok(windows.includes('desktop:status'));
    assert.ok(windows.includes('wizard:getStatus'));
    assert.ok(windows.includes('chat:pickWorkingDirectory'));
    const wrong = windows.filter((ch) => remoteClassOf(ch) !== 'local');
    assert.deepStrictEqual(wrong, []);
  });

  it('every on channel', () => {
    assert.ok(inventory.on.length > 0);
    assert.deepStrictEqual(inventory.on.filter((ch) => remoteClassOf(ch) === null), []);
  });

  it('CALL_METHODS is what the dispatcher serves, and each has a class', () => {
    const methods = dispatcherCallMethods();
    assert.ok(methods.length > 0);
    assert.deepStrictEqual([...CALL_METHODS].sort(), [...methods].sort());
    assert.deepStrictEqual(methods.filter((m) => remoteClassOf(m) === null), []);
  });

  it('every class in the table is one of CLASSES', () => {
    assert.deepStrictEqual([...CLASSES], ['read', 'ordinary', 'phone', 'local']);
    for (const [name, cls] of Object.entries(REMOTE_CLASSES)) assert.ok(CLASSES.includes(cls), `${name}: ${cls}`);
  });
});

describe('nothing in the table is unknown', () => {
  it('each name is a registered channel, a call method, or tabled ahead by this plan', () => {
    const known = new Set([...allChannels, ...dispatcherCallMethods()]);
    const unknown = Object.keys(REMOTE_CLASSES).filter((name) => !known.has(name) && !TABLED_AHEAD.has(name));
    assert.deepStrictEqual(unknown, []);
  });

  it('nothing the node denies every window is in the table', () => {
    const denied = allChannels.filter((ch) => classifyChannel(ch, { hosting: 'personal' }) === 'deny');
    assert.ok(denied.includes('mesh:status'));
    assert.deepStrictEqual(denied.filter((ch) => remoteClassOf(ch) !== null), []);
  });

  it('every name tabled ahead has a class', () => {
    for (const name of TABLED_AHEAD) assert.notStrictEqual(remoteClassOf(name), null, name);
  });
});

describe('an unknown name fails closed', () => {
  it('has no class', () => {
    for (const name of ['chat:someNewChannel', 'bridge.someNewMethod', 'mesh:status', 'agent:execute', 'settings:anthropicOAuthStart', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, undefined, 7, {}, ['chat:load']]) {
      assert.strictEqual(remoteClassOf(name), null, String(name));
    }
  });

  it('a prefix that only starts like a window channel is not one', () => {
    for (const name of ['desktop', 'wizard', 'xdesktop:status', 'DESKTOP:status']) assert.strictEqual(remoteClassOf(name), null, name);
  });

  it('a desktop: or wizard: channel not yet written is local, never served', () => {
    assert.strictEqual(remoteClassOf('desktop:someNewAction'), 'local');
    assert.strictEqual(remoteClassOf('wizard:someNewStep'), 'local');
  });

  it('assertComplete names what has no class and passes a full list', () => {
    assert.doesNotThrow(() => assertComplete(['chat:load', 'bridge.status', 'desktop:status']));
    assert.throws(() => assertComplete(['chat:load', 'chat:someNewChannel', 'mesh:status']), /chat:someNewChannel, mesh:status/);
  });

  it('the exported lists cannot be changed', () => {
    assert.ok(Object.isFrozen(CLASSES));
    assert.ok(Object.isFrozen(REMOTE_CLASSES));
    assert.ok(Object.isFrozen(CALL_METHODS));
    assert.ok(Object.isFrozen(PRESS_CHANNELS_REMOTE));
    assert.throws(() => { 'use strict'; REMOTE_CLASSES['skill:install'] = 'read'; }, TypeError);
    assert.strictEqual(remoteClassOf('skill:install'), 'phone');
  });
});

describe('the classes that gate something', () => {
  it('the channels that run code, write files or return secrets are phone', () => {
    for (const name of ['skill:install', 'settings:mcpSave', 'hooks:reload', 'webhook:get', 'workflow:run', 'apps:add', 'channel:accessAllow', 'cron:add', 'settings:vaultStore', 'checkpoint:restore', 'case:ingestFiles', 'bridge.setWorkingDirectory', 'bridge.addAllowedDirectory', 'chat:markPrivate', 'tool:execute']) {
      assert.strictEqual(remoteClassOf(name), 'phone', name);
    }
  });

  it('every served webhook: and hooks: channel but the list is phone (they return secrets or run code)', () => {
    const served = servedChannels(inventory, { hosting: 'personal' }).handle;
    const webhook = served.filter((ch) => ch.startsWith('webhook:'));
    assert.ok(webhook.length > 0);
    assert.deepStrictEqual(webhook.filter((ch) => remoteClassOf(ch) !== 'phone'), []);
    const hooks = served.filter((ch) => ch.startsWith('hooks:') && ch !== 'hooks:list');
    assert.ok(hooks.length > 0);
    assert.deepStrictEqual(hooks.filter((ch) => remoteClassOf(ch) !== 'phone'), []);
  });

  it('R-RW-13: both private marks are phone; the NOT_LOCAL_DESKTOP gates and models:local.* stay local', () => {
    assert.strictEqual(remoteClassOf('chat:markPrivate'), 'phone');
    assert.strictEqual(remoteClassOf('case:markPrivate'), 'phone');
    for (const name of ['case:confirmScope', 'case:verifyNow', 'case:setCheck']) assert.strictEqual(remoteClassOf(name), 'local', name);
    const local = allChannels.filter((ch) => ch.startsWith('models:local.') && ch !== 'models:local.list');
    assert.ok(local.length > 0);
    assert.deepStrictEqual(local.filter((ch) => remoteClassOf(ch) !== 'local'), []);
  });

  it('PRESS_CHANNELS_REMOTE is the presses, each local', () => {
    assert.deepStrictEqual([...PRESS_CHANNELS_REMOTE].sort(), [
      'case:acknowledgeBriefing', 'case:answerQuestion', 'case:confirmScope', 'case:grantBudget', 'case:resolveDetour',
      'case:setCheck', 'case:verifyNow', 'tool:approvalResponse', 'tool:directoryAccessResponse'
    ]);
    for (const name of PRESS_CHANNELS_REMOTE) assert.strictEqual(remoteClassOf(name), 'local', name);
  });
});

describe('the audit round: what the first table had too low', () => {
  const PHONE_NOW = [
    'tool:removePermissionRule', 'chat:setSandboxMode', 'settings:saveDefaults', 'case:checkPlaybookUpdates', 'case:attach',
    'case:reviewProposal', 'settings:saveNotifications', 'settings:saveUserProfile', 'settings:saveTemplateVariables',
    'memory:capture', 'models:saveCatalogSettings', 'checkpoint:setEnabled', 'skill:checkUpdates', 'chat:delete',
    'chat:truncateFrom', 'memory:clear', 'skill:getSettings', 'skill:listWithSettings'
  ];
  for (const name of PHONE_NOW) {
    it(`${name} is phone`, () => assert.strictEqual(remoteClassOf(name), 'phone'));
  }

  it('settings:mcpList and settings:load stay read, the handlers redact them', () => {
    assert.strictEqual(remoteClassOf('settings:mcpList'), 'read');
    assert.strictEqual(remoteClassOf('settings:load'), 'read');
  });

  it('chat:addMessage stays ordinary, its handler holds the sender and the metadata', () => {
    assert.strictEqual(remoteClassOf('chat:addMessage'), 'ordinary');
  });

  it('tool:execute is phone, with a dispatcher gate of its own', () => {
    assert.strictEqual(remoteClassOf('tool:execute'), 'phone');
    assert.doesNotMatch(source('src/desktop-bridge/remote-classes.js'), /needs no gate/);
  });
});

describe('remotePayloadClass', () => {
  const LOCAL_ONLY = { id: 'p-local', localOnly: ['main'], roles: {} };
  const HOSTED = { id: 'p-hosted', roles: {} };
  const chats = { 'chat-local': { id: 'chat-local', profileId: 'p-local' }, 'chat-hosted': { id: 'chat-hosted', profileId: 'p-hosted' }, 'chat-default': { id: 'chat-default' }, 'chat-case': { id: 'chat-case', caseId: 'case-1' } };
  const context = (defaultProfileId = 'p-hosted') => ({
    getSettings: () => ({ models: { profiles: [HOSTED, LOCAL_ONLY], defaultProfileId } }),
    getChat: (id) => chats[id] || null
  });

  it('answers the table for every channel with no payload rule', () => {
    for (const name of ['chat:load', 'chat:sendMessage', 'skill:install', 'app:quitWindow']) assert.strictEqual(remotePayloadClass(name, [{}], context()), remoteClassOf(name), name);
    assert.strictEqual(remotePayloadClass('chat:someNewChannel', [{}], context()), null);
    assert.strictEqual(remotePayloadClass('__proto__', [{}], context()), null);
  });

  it('case:create is phone with playbooks or acceptBudgetRaises present, even empty or false', () => {
    assert.strictEqual(remotePayloadClass('case:create', [{ title: 'Lakeside lot' }], context()), 'ordinary');
    for (const payload of [{ playbooks: ['example:one'] }, { playbooks: [] }, { acceptBudgetRaises: true }, { acceptBudgetRaises: false }]) {
      assert.strictEqual(remotePayloadClass('case:create', [{ title: 'Lakeside lot', ...payload }], context()), 'phone', JSON.stringify(payload));
    }
  });

  it('a payload that is not an object raises nothing and breaks nothing', () => {
    for (const args of [undefined, null, [], [null], ['text'], 'text']) assert.strictEqual(remotePayloadClass('case:create', args, context()), 'ordinary');
  });

  it('models:removeProfile is phone for a profile with localOnly', () => {
    assert.strictEqual(remotePayloadClass('models:removeProfile', [{ id: 'p-local' }], context()), 'phone');
    assert.strictEqual(remotePayloadClass('models:removeProfile', [{ id: 'p-hosted' }], context()), 'ordinary');
    assert.strictEqual(remotePayloadClass('models:removeProfile', [{ id: 'p-unknown' }], context()), 'ordinary');
  });

  it('models:setDefaultProfile is phone when the default it leaves has localOnly', () => {
    assert.strictEqual(remotePayloadClass('models:setDefaultProfile', [{ id: 'p-hosted' }], context('p-local')), 'phone');
    assert.strictEqual(remotePayloadClass('models:setDefaultProfile', [{ id: 'p-local' }], context('p-local')), 'ordinary', 'it leaves nothing');
    assert.strictEqual(remotePayloadClass('models:setDefaultProfile', [{ id: 'p-local' }], context('p-hosted')), 'ordinary');
  });

  it('models:setChatProfile is phone when the chat leaves a profile with localOnly, its own or the default', () => {
    assert.strictEqual(remotePayloadClass('models:setChatProfile', [{ chatId: 'chat-local', profileId: 'p-hosted' }], context()), 'phone');
    assert.strictEqual(remotePayloadClass('models:setChatProfile', [{ chatId: 'chat-local', profileId: null }], context()), 'phone');
    assert.strictEqual(remotePayloadClass('models:setChatProfile', [{ chatId: 'chat-default', profileId: 'p-hosted' }], context('p-local')), 'phone');
    assert.strictEqual(remotePayloadClass('models:setChatProfile', [{ chatId: 'chat-hosted', profileId: 'p-local' }], context()), 'ordinary');
    assert.strictEqual(remotePayloadClass('models:setChatProfile', [{ chatId: 'chat-local', profileId: 'p-local' }], context()), 'ordinary', 'it leaves nothing');
  });

  it('what cannot be read is phone: no context, a reader that throws, an unknown chat, a case chat', () => {
    const cases = [
      ['models:removeProfile', { id: 'p-hosted' }], ['models:setDefaultProfile', { id: 'p-hosted' }],
      ['models:setChatProfile', { chatId: 'chat-hosted', profileId: 'p-local' }]
    ];
    const throwing = { getSettings: () => { throw new Error('closed'); }, getChat: () => { throw new Error('closed'); } };
    for (const [channel, payload] of cases) {
      assert.strictEqual(remotePayloadClass(channel, [payload]), 'phone', `${channel}, no context`);
      assert.strictEqual(remotePayloadClass(channel, [payload], throwing), 'phone', `${channel}, throws`);
    }
    assert.strictEqual(remotePayloadClass('models:setChatProfile', [{ chatId: 'chat-none', profileId: 'p-local' }], context()), 'phone');
    assert.strictEqual(remotePayloadClass('models:setChatProfile', [{ chatId: 'chat-case', profileId: 'p-local' }], context()), 'phone', 'a case keeps its choice in case.yaml');
  });

  it('never lowers a class', () => {
    assert.strictEqual(remotePayloadClass('case:setStatus', [{}], context()), 'phone');
    assert.strictEqual(remotePayloadClass('case:verifyNow', [{ playbooks: [] }], context()), 'local');
  });
});

describe('remote-window is no press', () => {
  const lists = [
    ['src/cases/contact.js', 'APP_ANSWER_CHANNELS'],
    ['src/cases/detours/router.js', 'PRESS_CHANNELS'],
    ['src/cases/verify/questions.js', 'PRESS_CHANNELS']
  ];
  for (const [file, name] of lists) {
    it(`${name} in ${file} has no remote-window`, () => {
      const channels = frozenList(file, name);
      assert.ok(channels.includes('in-app'), 'the list was read');
      assert.ok(!channels.includes('remote-window'));
    });
  }
});
