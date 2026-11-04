// tests/desktop-bridge-allowlist.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const {
  classifyChannel, servedChannels, isRendererEvent, isTimeoutExempt, channelTimeoutMs, LONG_CHANNEL_TIMEOUT_MS, PROMPT_EVENTS, RENDERER_EVENTS, PROXIED_DOMAINS,
  PERSONAL_PROXIED_DOMAINS, ATTACHED_UNAVAILABLE_TABS, unavailableTabsFor
} = require('../src/desktop-bridge/allowlist');
const { listIpcChannels } = require('../src/ipc/channel-inventory');
const { registerDesktopHandlers, DESKTOP_METHODS } = require('../src/ipc/desktop-handlers');

describe('classifyChannel (spec §3.6, first match wins)', () => {
  const cases = {
    'desktop:status': 'local',
    'app:quitWindow': 'local',
    'wizard:getStatus': 'local',
    'chat:pickWorkingDirectory': 'prestep',
    'settings:addAllowedDirectory': 'prestep',
    'chat:speakLast': 'deny',
    'settings:testVoice': 'deny',
    'settings:mcpSave': 'deny',
    'settings:anthropicOAuthStart': 'deny',
    'chat:sendMessage': 'proxy',
    'settings:load': 'proxy',
    'case:list': 'proxy',
    'case:somethingC2Adds': 'proxy',
    'cron:run': 'proxy',
    'memory:list': 'proxy',
    'tool:approvalResponse': 'proxy',
    'usage:getDaily': 'proxy',
    'checkpoint:restore': 'proxy',
    'canvas:getState': 'proxy',
    'executors:list': 'proxy',
    'models:usable': 'proxy',
    'history:excerpts': 'proxy',
    'history:search': 'proxy',
    'history:scope.set': 'proxy',
    'history:links.get': 'proxy',
    'history:links.set': 'proxy',
    // Stage H4 (R-H4-3): the dialog's channels are answered on the desktop,
    // which opens and parses the file; the batch channels carry the parsed
    // chat to the service.
    'history:import.pick': 'local',
    'history:import.preview': 'local',
    'history:import.commit': 'local',
    'history:import.lookup': 'proxy',
    'history:import.begin': 'proxy',
    'history:import.append': 'proxy',
    'history:import.finish': 'proxy',
    'agent:userResponse': 'proxy',
    'agent:executeWithDeps': 'deny',
    'hooks:list': 'deny',
    'skill:list': 'deny',
    'webhook:list': 'deny',
    'mesh:peers': 'deny',
    'channel:list': 'deny',
    'gateway:status': 'deny',
    'workflow:run': 'deny',
    'task:list': 'deny',
    'apps:list': 'deny',
    'diagnostics:run': 'deny',
    'sessions:list': 'deny'
  };
  for (const [channel, route] of Object.entries(cases)) {
    it(`${channel} → ${route}`, () => assert.strictEqual(classifyChannel(channel), route));
  }

  it('R-H4-3: pick, preview and commit are local; begin, append, finish and lookup are proxied', () => {
    for (const ch of [IPC.HISTORY_IMPORT_PICK, IPC.HISTORY_IMPORT_PREVIEW, IPC.HISTORY_IMPORT_COMMIT]) {
      assert.strictEqual(classifyChannel(ch), 'local', ch);
    }
    for (const ch of [IPC.HISTORY_IMPORT_BEGIN, IPC.HISTORY_IMPORT_APPEND, IPC.HISTORY_IMPORT_FINISH, IPC.HISTORY_IMPORT_LOOKUP]) {
      assert.strictEqual(classifyChannel(ch), 'proxy', ch);
    }
    // Nothing else in the history domain is answered on the desktop.
    const local = Object.values(IPC).filter((ch) => typeof ch === 'string' && ch.startsWith('history:') && classifyChannel(ch) === 'local');
    assert.deepStrictEqual(local.sort(), ['history:import.commit', 'history:import.pick', 'history:import.preview']);
  });

  it('proxies every case channel C2 registers', () => {
    const caseChannels = Object.values(IPC).filter((ch) => typeof ch === 'string' && ch.startsWith('case:'));
    for (const ch of ['case:questions', 'case:answerQuestion', 'case:acknowledgeBriefing', 'case:setStatus', 'case:budget', 'case:grantBudget']) {
      assert.ok(caseChannels.includes(ch), ch);
    }
    for (const ch of caseChannels) assert.strictEqual(classifyChannel(ch), 'proxy', ch);
  });

  // Cases stage 8: progress, the owner's scope actions and "Check now" run
  // on the service when the desktop is attached. They ride the case domain.
  it('proxies the stage-8 progress channels, each with the default timeout', () => {
    assert.deepStrictEqual([IPC.CASE_PROGRESS, IPC.CASE_CONFIRM_SCOPE, IPC.CASE_VERIFY_NOW], ['case:progress', 'case:confirmScope', 'case:verifyNow']);
    for (const ch of ['case:progress', 'case:confirmScope', 'case:verifyNow']) {
      assert.strictEqual(classifyChannel(ch), 'proxy', ch);
      assert.strictEqual(isTimeoutExempt(ch), false, ch);
      assert.strictEqual(channelTimeoutMs(ch, 120000), 120000, ch);
    }
    assert.deepStrictEqual(servedChannels({ handle: ['case:verifyNow', 'case:progress', 'case:confirmScope'] }).handle, ['case:verifyNow', 'case:progress', 'case:confirmScope']);
    // The check command (R-C8-3): named on the service, under its admin's policy.
    assert.strictEqual(IPC.CASE_SET_CHECK, 'case:setCheck');
    assert.strictEqual(classifyChannel('case:setCheck'), 'proxy');
  });

  it('lists the proxied domains', () => {
    assert.deepStrictEqual([...PROXIED_DOMAINS], ['chat', 'settings', 'case', 'cron', 'memory', 'tool', 'usage', 'checkpoint', 'canvas', 'executors', 'contact', 'contactPolicy', 'presence', 'models', 'history']);
  });

  it('defaults to deny for anything that is not an allow-listed channel', () => {
    for (const channel of ['', null, 123, '__proto__', 'constructor']) {
      assert.strictEqual(classifyChannel(channel), 'deny', String(channel));
    }
  });
});

describe('renderer events', () => {
  it('forwards chat, canvas and prompt events and case:changed only among case events', () => {
    for (const ch of ['chat:messageChunk', 'chat:updated', 'canvas:executeJs', 'tool:approvalRequired', 'agent:askUser', 'backgroundTask:completed', 'case:changed']) {
      assert.strictEqual(isRendererEvent(ch), true, ch);
    }
    for (const ch of ['workflow:progress', 'task:created', 'mesh:ready', 'desktop:statusChanged', 'case:statusChanged', 'case:list', 'case:answerQuestion']) {
      assert.strictEqual(isRendererEvent(ch), false, ch);
    }
    for (const ch of PROMPT_EVENTS) assert.ok(RENDERER_EVENTS.has(ch));
    assert.deepStrictEqual([...PROMPT_EVENTS].sort(), ['agent:askUser', 'tool:approvalRequired', 'tool:directoryAccessRequired']);
  });

  it('exempts only long-running calls from the 120 s timeout', () => {
    for (const ch of ['chat:sendMessage', 'tool:execute', 'cron:run']) assert.strictEqual(isTimeoutExempt(ch), true, ch);
    // Cases stage 7 replaced the case:ingest* placeholder with bounded long timeouts.
    for (const ch of ['chat:load', 'case:list', 'settings:load', 'case:ingestFiles', 'case:ingestRecord', 'case:ingestFile']) assert.strictEqual(isTimeoutExempt(ch), false, ch);
  });

  // Ruling T14-bridgetimeout: the long playbook/case channels get a 10-minute,
  // still bounded, timeout; nothing new becomes unbounded.
  it('gives the long playbook channels a bounded 10-minute timeout', () => {
    assert.strictEqual(LONG_CHANNEL_TIMEOUT_MS, 10 * 60 * 1000);
    for (const ch of ['case:create', 'case:addPlaybook', 'case:checkPlaybookUpdates', 'case:updatePlaybook', 'case:applyPlaybookProposal', 'case:ingestFiles', 'case:ingestExtract', 'case:reviewProposal', 'case:acceptVerified']) {
      assert.strictEqual(channelTimeoutMs(ch, 120000), LONG_CHANNEL_TIMEOUT_MS, ch);
      assert.strictEqual(isTimeoutExempt(ch), false, ch);
    }
    for (const ch of ['case:playbooks', 'case:removePlaybook', 'case:rejectPlaybookProposal', 'chat:load', 'case:sources', 'case:ingestRecord']) assert.strictEqual(channelTimeoutMs(ch, 120000), 120000, ch);
    for (const ch of ['chat:sendMessage']) assert.strictEqual(channelTimeoutMs(ch, 120000), 0, ch);
  });
});

describe('listIpcChannels', () => {
  it('records the registered inventory, including desktop:*', () => {
    const inv = listIpcChannels();
    assert.ok(inv.handle.length > 100, `expected >100 handle channels, got ${inv.handle.length}`);
    for (const ch of Object.keys(DESKTOP_METHODS)) assert.ok(inv.handle.includes(ch), ch);
    assert.ok(inv.handle.includes('chat:load'));
    assert.ok(inv.on.includes('tool:approvalResponse'));
    assert.ok(inv.on.includes('agent:userResponse'));
    assert.strictEqual(listIpcChannels(), inv, 'memoized');
  });

  it('R-H4-3: a service serves the batch import channels and never the three that open a picked file', () => {
    const inv = listIpcChannels();
    const served = servedChannels(inv).handle;
    for (const ch of ['history:import.pick', 'history:import.preview', 'history:import.commit']) {
      assert.ok(inv.handle.includes(ch), `${ch} is registered`);
      assert.ok(!served.includes(ch), `${ch} is not served over the bridge`);
    }
    for (const ch of ['history:import.lookup', 'history:import.begin', 'history:import.append', 'history:import.finish', 'history:links.get']) {
      assert.ok(served.includes(ch), `${ch} is served over the bridge`);
    }
  });

  it('classifies every channel into exactly one route', () => {
    const inv = listIpcChannels();
    for (const ch of [...inv.handle, ...inv.on]) {
      assert.ok(['local', 'prestep', 'proxy', 'deny'].includes(classifyChannel(ch)), ch);
    }
  });

  it('serves only proxy channels', () => {
    const served = servedChannels(listIpcChannels());
    assert.ok(served.handle.includes('chat:sendMessage'));
    assert.ok(served.on.includes('agent:userResponse'));
    for (const ch of ['chat:pickWorkingDirectory', 'desktop:status', 'hooks:list', 'settings:mcpList', 'wizard:getStatus']) {
      assert.ok(!served.handle.includes(ch), ch);
    }
  });
});

describe('desktop:* handlers', () => {
  const record = () => {
    const handlers = new Map();
    return { handlers, ipc: { handle: (ch, fn) => { assert.ok(!handlers.has(ch), `duplicate ${ch}`); handlers.set(ch, fn); }, on() {} } };
  };

  it('defines a constant for every channel', () => {
    assert.strictEqual(IPC.DESKTOP_STATUS, 'desktop:status');
    assert.strictEqual(IPC.DESKTOP_STATUS_CHANGED, 'desktop:statusChanged');
    assert.strictEqual(IPC.DESKTOP_IMPORT_PROGRESS, 'desktop:importProgress');
    assert.deepStrictEqual(Object.keys(DESKTOP_METHODS).sort(), [
      'desktop:attach', 'desktop:detach', 'desktop:dismissServiceCommand', 'desktop:importApply', 'desktop:importPlan',
      'desktop:nodeInstall', 'desktop:nodeInstallPreview', 'desktop:nodeStart',
      'desktop:pairCancel', 'desktop:pairConfirm', 'desktop:pairRestartConfirm', 'desktop:pairStart', 'desktop:retry',
      'desktop:standaloneOnce', 'desktop:status', 'desktop:unpair'
    ]);
  });

  it('personal-node channels (spec §11): constants, methods, local and never served', () => {
    const expected = {
      DESKTOP_NODE_START: ['desktop:nodeStart', 'nodeStart'],
      DESKTOP_NODE_INSTALL_PREVIEW: ['desktop:nodeInstallPreview', 'nodeInstallPreview'],
      DESKTOP_NODE_INSTALL: ['desktop:nodeInstall', 'nodeInstall'],
      DESKTOP_PAIR_RESTART_CONFIRM: ['desktop:pairRestartConfirm', 'pairRestartConfirm']
    };
    const inv = listIpcChannels();
    const served = servedChannels(inv).handle;
    for (const [key, [channel, method]] of Object.entries(expected)) {
      assert.strictEqual(IPC[key], channel, key);
      assert.strictEqual(DESKTOP_METHODS[channel], method, channel);
      assert.strictEqual(classifyChannel(channel), 'local', channel);
      assert.ok(inv.handle.includes(channel), `${channel} is registered`);
      assert.ok(!served.includes(channel), `${channel} is not served over the bridge`);
    }
    assert.ok(!PROXIED_DOMAINS.includes('desktop'), 'desktop is not a proxied domain');
  });

  it('answers ATTACHED_UNAVAILABLE without a desktop controller', async () => {
    const { handlers, ipc } = record();
    registerDesktopHandlers(ipc, {});
    assert.deepStrictEqual(await handlers.get('desktop:status')({}), { ok: false, code: 'ATTACHED_UNAVAILABLE', error: 'Not available here.' });
  });

  it('calls the controller and wraps plain values and errors', async () => {
    const { handlers, ipc } = record();
    registerDesktopHandlers(ipc, {
      desktopBridge: {
        status: async () => ({ ok: true, view: 'unpaired' }),
        detach: async (payload) => payload,
        pairStart: async () => { throw Object.assign(new Error('no secure storage'), { code: 'SECURE_STORAGE_UNAVAILABLE' }); }
      }
    });
    assert.deepStrictEqual(await handlers.get('desktop:status')({}), { ok: true, view: 'unpaired' });
    assert.deepStrictEqual(await handlers.get('desktop:detach')({}, { confirmed: true }), { ok: true, data: { confirmed: true } });
    assert.deepStrictEqual(await handlers.get('desktop:pairStart')({}), { ok: false, code: 'SECURE_STORAGE_UNAVAILABLE', error: 'no secure storage' });
    assert.strictEqual((await handlers.get('desktop:attach')({})).code, 'ATTACHED_UNAVAILABLE');
  });

  it('still returns {ok:false} when the controller throws a null or undefined', async () => {
    const { handlers, ipc } = record();
    registerDesktopHandlers(ipc, {
      desktopBridge: {
        // eslint-disable-next-line no-throw-literal
        status: async () => { throw null; },
        // eslint-disable-next-line no-throw-literal
        detach: async () => { throw undefined; }
      }
    });
    assert.deepStrictEqual(await handlers.get('desktop:status')({}), { ok: false, code: 'DESKTOP_ERROR', error: 'null' });
    assert.deepStrictEqual(await handlers.get('desktop:detach')({}), { ok: false, code: 'DESKTOP_ERROR', error: 'undefined' });
  });
});

// Attach stage 2 (spec 2026-11-03 §6.6, G-1, G-2, C-15): a personal node's owner
// is its administrator, so the window reaches the panes standalone had. The
// fleet's allowlist stays exactly what it was.
describe('allowlist under hosting', () => {
  const personal = { hosting: 'personal' };
  const service = { hosting: 'service' };
  const domain = (ch) => ch.slice(0, ch.indexOf(':'));
  const inv = listIpcChannels();
  const everyChannel = [...inv.handle, ...inv.on];
  const isPersonalOnly = (ch) => PERSONAL_PROXIED_DOMAINS.includes(domain(ch)) || ch.startsWith('settings:mcp');

  it('names the personal domains', () => {
    assert.deepStrictEqual([...PERSONAL_PROXIED_DOMAINS], ['hooks', 'skill', 'webhook', 'workflow', 'apps', 'diagnostics', 'channel']);
  });

  for (const name of ['hooks', 'skill', 'webhook', 'workflow', 'apps', 'diagnostics', 'channel']) {
    it(`every ${name}: channel is proxy under personal and deny under the fleet`, () => {
      const channels = everyChannel.filter((ch) => domain(ch) === name);
      assert.ok(channels.length > 0, `${name} has channels`);
      for (const ch of channels) {
        assert.strictEqual(classifyChannel(ch, personal), 'proxy', ch);
        assert.strictEqual(classifyChannel(ch, service), 'deny', ch);
        assert.strictEqual(classifyChannel(ch), 'deny', ch);
      }
    });
  }

  it('settings:mcp* is proxy under personal and deny under the fleet', () => {
    const channels = everyChannel.filter((ch) => ch.startsWith('settings:mcp'));
    assert.deepStrictEqual([...channels].sort(), ['settings:mcpDelete', 'settings:mcpList', 'settings:mcpReload', 'settings:mcpSave']);
    for (const ch of channels) {
      assert.strictEqual(classifyChannel(ch, personal), 'proxy', ch);
      assert.strictEqual(classifyChannel(ch, service), 'deny', ch);
      assert.strictEqual(classifyChannel(ch), 'deny', ch);
    }
  });

  it('stays denied under both: Anthropic OAuth, read-aloud, the mesh and the gateway', () => {
    const denied = everyChannel.filter((ch) => ch.startsWith('settings:anthropicOAuth') || ['mesh', 'gateway'].includes(domain(ch)));
    assert.ok(denied.includes('settings:anthropicOAuthStart'));
    for (const ch of [...denied, 'chat:speakLast', 'settings:testVoice']) {
      assert.strictEqual(classifyChannel(ch, personal), 'deny', ch);
      assert.strictEqual(classifyChannel(ch, service), 'deny', ch);
    }
  });

  it('only the exact word personal widens anything', () => {
    for (const hosting of [undefined, null, '', 'Personal', 'fleet', 1, true]) {
      assert.strictEqual(classifyChannel('hooks:list', { hosting }), 'deny', String(hosting));
      assert.strictEqual(classifyChannel('settings:mcpList', { hosting }), 'deny', String(hosting));
    }
  });

  it('local and prestep routes do not move under personal', () => {
    for (const ch of ['desktop:status', 'wizard:getStatus', 'app:quitWindow', 'history:import.pick']) assert.strictEqual(classifyChannel(ch, personal), 'local', ch);
    for (const ch of ['chat:pickWorkingDirectory', 'settings:addAllowedDirectory']) assert.strictEqual(classifyChannel(ch, personal), 'prestep', ch);
  });

  it('the fleet serves nothing new: every hosting but personal serves what no options serve', () => {
    const fleet = servedChannels(inv);
    assert.deepStrictEqual(servedChannels(inv, service), fleet);
    assert.deepStrictEqual(servedChannels(inv, { hosting: 'anything' }), fleet);
    assert.deepStrictEqual([...fleet.handle, ...fleet.on].filter(isPersonalOnly), []);
  });

  it('personal serves the fleet set plus exactly the personal domains and settings:mcp*', () => {
    const fleet = servedChannels(inv);
    const wide = servedChannels(inv, personal);
    const added = wide.handle.filter((ch) => !fleet.handle.includes(ch));
    assert.deepStrictEqual(added, inv.handle.filter(isPersonalOnly));
    for (const ch of fleet.handle) assert.ok(wide.handle.includes(ch), ch);
    assert.deepStrictEqual(wide.on.filter((ch) => !fleet.on.includes(ch)), inv.on.filter(isPersonalOnly));
  });

  it('unavailableTabsFor: the fleet\'s list, or the mesh alone under personal', () => {
    assert.deepStrictEqual([...unavailableTabsFor('service')], [...ATTACHED_UNAVAILABLE_TABS]);
    assert.deepStrictEqual([...unavailableTabsFor('personal')], ['mesh']);
    for (const hosting of [undefined, null, 'other']) assert.deepStrictEqual([...unavailableTabsFor(hosting)], [...ATTACHED_UNAVAILABLE_TABS]);
    assert.deepStrictEqual([...ATTACHED_UNAVAILABLE_TABS], ['mcp', 'channels', 'hooks', 'skills', 'webhooks', 'workflows', 'mesh', 'diagnostics', 'system-apps']);
  });

  it('a workflow\'s events reach the window under personal only', () => {
    for (const ch of ['workflow:created', 'workflow:started', 'workflow:completed', 'workflow:failed', 'workflow:paused', 'workflow:cancelled', 'workflow:task:started', 'workflow:task:completed', 'workflow:task:failed']) {
      assert.strictEqual(isRendererEvent(ch, personal), true, ch);
      assert.strictEqual(isRendererEvent(ch, service), false, ch);
      assert.strictEqual(isRendererEvent(ch), false, ch);
    }
    assert.strictEqual(isRendererEvent('mesh:peerConnected', personal), false);
    assert.strictEqual(isRendererEvent('chat:updated', personal), true);
  });

  it('a pane\'s call that can outlast the default timeout gets the long bound', () => {
    for (const ch of ['skill:install', 'skill:update', 'skill:checkUpdates', 'workflow:plan', 'workflow:planAndExecute', 'settings:mcpSave', 'settings:mcpReload']) {
      assert.strictEqual(channelTimeoutMs(ch, 120000), LONG_CHANNEL_TIMEOUT_MS, ch);
    }
  });
});
