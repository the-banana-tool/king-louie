// tests/desktop-bridge-allowlist.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const {
  classifyChannel, servedChannels, isRendererEvent, isTimeoutExempt, PROMPT_EVENTS, RENDERER_EVENTS, PROXIED_DOMAINS
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

  it('lists the proxied domains', () => {
    assert.deepStrictEqual([...PROXIED_DOMAINS], ['chat', 'settings', 'case', 'cron', 'memory', 'tool', 'usage', 'checkpoint', 'canvas']);
  });

  it('defaults to deny for anything that is not an allow-listed channel', () => {
    for (const channel of ['', null, 123, '__proto__', 'constructor']) {
      assert.strictEqual(classifyChannel(channel), 'deny', String(channel));
    }
  });
});

describe('renderer events', () => {
  it('forwards chat, canvas and prompt events and any case event', () => {
    for (const ch of ['chat:messageChunk', 'chat:updated', 'canvas:executeJs', 'tool:approvalRequired', 'agent:askUser', 'backgroundTask:completed', 'case:statusChanged']) {
      assert.strictEqual(isRendererEvent(ch), true, ch);
    }
    for (const ch of ['workflow:progress', 'task:created', 'mesh:ready', 'desktop:statusChanged']) {
      assert.strictEqual(isRendererEvent(ch), false, ch);
    }
    for (const ch of PROMPT_EVENTS) assert.ok(RENDERER_EVENTS.has(ch));
    assert.deepStrictEqual([...PROMPT_EVENTS].sort(), ['agent:askUser', 'tool:approvalRequired', 'tool:directoryAccessRequired']);
  });

  it('exempts only long-running calls from the 120 s timeout', () => {
    for (const ch of ['chat:sendMessage', 'tool:execute', 'cron:run', 'case:ingestFile']) assert.strictEqual(isTimeoutExempt(ch), true, ch);
    for (const ch of ['chat:load', 'case:list', 'settings:load']) assert.strictEqual(isTimeoutExempt(ch), false, ch);
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
      'desktop:pairCancel', 'desktop:pairConfirm', 'desktop:pairStart', 'desktop:retry', 'desktop:standaloneOnce',
      'desktop:status', 'desktop:unpair'
    ]);
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
