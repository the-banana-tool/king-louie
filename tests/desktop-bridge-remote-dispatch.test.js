// tests/desktop-bridge-remote-dispatch.test.js
// Remote window plan, task 3 (R-RW-7, R-RW-8, R-RW-11 to R-RW-13, R-RW-19): what a
// remote window's frames do on the node. Served first, then the class, then the
// payload's class; the phone gates what acts; a drop stops nothing.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { canonicalize, sha256b64url } = require('../src/platform/jcs');
const ProviderFactory = require('../src/providers/provider-factory');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const { registerHandlers } = require('../src/ipc/register');
const { createBridgeDispatcher } = require('../src/desktop-bridge/bridge-dispatcher');
const { WINDOW_ARGS_INLINE_MAX, WINDOW_LEAF_MAX } = require('../src/desktop-bridge/window-cards');
const { toolCardParams } = require('../src/approvals/hidden-card');
const { createConnection } = require('../src/desktop-bridge/connection');
const { currentConnection } = require('../src/desktop-bridge/run-context');
const { REMOTE_CLASSES } = require('../src/desktop-bridge/remote-classes');
const { MESSAGES } = require('../src/desktop-bridge/protocol');
const {
  isLocalDesktopEvent, isRemoteWindowEvent, localDesktopDeviceId, remoteWindowDeviceId, remoteWindowApproved
} = require('../src/core/origin');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { open } = require('../src/approvals/envelope');
const { toolAction } = require('../src/approvals/messages');
const { screenshotDir } = require('../src/browser/screenshot-store');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { profileSettings, everyRole } = require('./helpers/profile-settings');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const PROBE = 'KlTestRemoteDispatchProbe';
const STOPPED_ROW = MESSAGES.DESKTOP_DISCONNECTED_RUN;
let probeRuns = 0;
const realOpenAI = ProviderFactory._registry.get('openai');
// What the next model calls answer; with nothing scripted, a plain reply.
const script = [];
class FakeProvider {
  async listModels() { return ['fake']; }
  async sendMessage() { return 'A title'; }
  async sendMessageWithTools() { return script.shift() || { type: 'text', content: 'finished' }; }
  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }
}
const cipher = createAesGcmCipher(crypto.randomBytes(32));

// requestApproval records what it was asked and answers as scripted; an approval
// gets a request id, as PhoneApprover#requestApproval gives one.
function fakePhone(decide = () => true) {
  const calls = [];
  let issued = 0;
  return {
    ttlMs: 300000,
    calls,
    isAvailable: () => true,
    requestApproval: async (toolName, parameters, metadata) => {
      calls.push({ toolName, parameters, metadata });
      const answer = await decide(toolName, parameters, metadata);
      if (answer === true) { issued += 1; metadata.request_id = `req-${issued}`; }
      return answer;
    }
  };
}

function makeCore(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-dispatch-'));
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher,
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    remoteApprovals: 'deny',
    ...extra
  });
  core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: 'openai', model: 'fake' })));
  core.saveProviderToken('openai', 'fake-token-123456');
  return { core, dataDir };
}

let core;
let dataDir;
let phoneCore;
let phoneCoreDir;
const toolPhone = fakePhone();

before(async () => {
  ProviderFactory.registerProvider('openai', FakeProvider);
  toolRegistry.register(new Tool({
    name: PROBE,
    description: 'Test-only tool that requires approval.',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async () => { probeRuns += 1; return { ok: true }; }
  }));
  ({ core, dataDir } = makeCore());
  await core.start();
  ({ core: phoneCore, dataDir: phoneCoreDir } = makeCore({ remoteApprovals: 'phone', phoneApprover: toolPhone }));
  await phoneCore.start();
});

after(async () => {
  await core.shutdown().catch(() => {});
  await phoneCore.shutdown().catch(() => {});
  if (realOpenAI) ProviderFactory.registerProvider('openai', realOpenAI);
  closeOpenHistoryStores();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(phoneCoreDir, { recursive: true, force: true });
});

const deviceId = (seed) => `kld-${seed.padEnd(16, 'a').slice(0, 16)}`;

function connection({ remote = true, device = 'remotewindow', label = 'Field laptop' } = {}) {
  const sent = [];
  const conn = createConnection({ deviceId: deviceId(device), label, remote, send: (f) => sent.push(f) });
  conn.sent = sent;
  return conn;
}

function makeDispatcher({ phone = fakePhone(), overrides = {}, listeners = {}, patchContext = null, coreOverride = null, hosting = 'personal', approvals = undefined } = {}) {
  const attached = new Set();
  const dispatcher = createBridgeDispatcher({
    core: coreOverride || core,
    cipher,
    dataDir,
    approvals: approvals === undefined ? (phone ? { phoneApprover: phone } : null) : approvals,
    account: 'LOCAL SERVICE',
    hosting,
    getServiceInfo: () => ({ version: '26.9.0' }),
    getConnection: () => currentConnection(),
    getConnections: () => [...attached],
    registerHandlers: (ipc, ctx) => {
      registerHandlers(ipc, ctx);
      for (const [channel, fn] of Object.entries(overrides)) ipc.handle(channel, fn);
      for (const [channel, fn] of Object.entries(listeners)) ipc.on(channel, fn);
      if (patchContext) patchContext(ctx);
    }
  });
  return { dispatcher, phone, use: (...conns) => { for (const c of conns) attached.add(c); }, leave: (c) => attached.delete(c) };
}

const invoke = (dispatcher, conn, id, channel, ...args) => dispatcher.handleFrame(conn, { t: 'invoke', id, channel, args });
const resultFor = (conn, id) => conn.sent.find((f) => f.t === 'result' && f.id === id);
const asked = (conn, channel = 'agent:askUser') => conn.sent.filter((f) => f.t === 'event' && f.channel === channel);
const waitFor = async (fn, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => { setTimeout(r, 5); });
  }
  throw new Error('waitFor timed out');
};
const newChat = (id) => {
  core.context.createChat({ id, title: id, createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z', messages: [] });
  return id;
};

describe('the remote event', () => {
  it('a remote connection\'s event is remote-window, never local, with its device id', async () => {
    let seen = null;
    const { dispatcher, use } = makeDispatcher({ overrides: { 'chat:load': async (event) => { seen = event; return { ok: true }; } } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:load');
    assert.strictEqual(isRemoteWindowEvent(seen), true);
    assert.strictEqual(isLocalDesktopEvent(seen), false);
    assert.strictEqual(remoteWindowDeviceId(seen), a.deviceId);
    assert.strictEqual(remoteWindowApproved(seen), null);
  });

  it('a local connection\'s event stays local, and it is never gated', async () => {
    let seen = null;
    const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'chat:delete': async (event) => { seen = event; return { ok: true }; } } });
    const a = connection({ remote: false, device: 'localwindow' });
    use(a);
    await invoke(dispatcher, a, 1, 'chat:delete', 'c-any');
    assert.strictEqual(isLocalDesktopEvent(seen), true);
    assert.strictEqual(localDesktopDeviceId(seen), a.deviceId);
    assert.deepStrictEqual(phone.calls, []);
  });
});

describe('the order: served, class, payload class', () => {
  it('a read and an ordinary channel run with no approval asked', async () => {
    let runs = 0;
    const run = async () => { runs += 1; return { ok: true }; };
    const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'chat:load': run, 'chat:rename': run } });
    const a = connection();
    use(a);
    assert.strictEqual(REMOTE_CLASSES['chat:load'], 'read');
    assert.strictEqual(REMOTE_CLASSES['chat:rename'], 'ordinary');
    await invoke(dispatcher, a, 1, 'chat:load');
    await invoke(dispatcher, a, 2, 'chat:rename', { chatId: 'c', name: 'Lakeside lot' });
    assert.strictEqual(runs, 2);
    assert.deepStrictEqual(phone.calls, []);
  });

  it('a channel the fleet does not serve stays refused, whatever class the table gives it', async () => {
    let runs = 0;
    const { dispatcher, phone, use } = makeDispatcher({ hosting: 'service', overrides: { 'hooks:list': async () => { runs += 1; return { ok: true }; }, 'skill:install': async () => { runs += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'hooks:list');
    await invoke(dispatcher, a, 2, 'skill:install', { source: 'C:\\example' });
    assert.strictEqual(resultFor(a, 1).code, 'CHANNEL_NOT_PROXIED');
    assert.strictEqual(resultFor(a, 2).code, 'CHANNEL_NOT_PROXIED');
    assert.strictEqual(runs, 0);
    assert.deepStrictEqual(phone.calls, [], 'nobody is asked for what is not served');
  });

  it('the payload raises the class: case:create with playbooks goes to the phone', async () => {
    let runs = 0;
    const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'case:create': async () => { runs += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'case:create', { title: 'Lakeside lot' });
    assert.deepStrictEqual(phone.calls, [], 'with nothing to raise it, ordinary');
    await invoke(dispatcher, a, 2, 'case:create', { title: 'Lakeside lot', playbooks: [] });
    assert.strictEqual(phone.calls.length, 1);
    assert.strictEqual(runs, 2);
  });

  it('remotePayloadClass reads the core\'s context: leaving a local-only profile is phone', async () => {
    let runs = 0;
    const settings = { models: { profiles: [{ id: 'p-local', localOnly: ['main'], roles: {} }, { id: 'p-hosted', roles: {} }], defaultProfileId: 'p-local' } };
    const chats = { 'c-local': { id: 'c-local', profileId: 'p-local' } };
    const spyCore = { ...core, context: { ...core.context, getSettings: () => settings, getChat: (id) => chats[id] || null } };
    const { dispatcher, phone, use } = makeDispatcher({
      coreOverride: spyCore,
      overrides: {
        'models:setChatProfile': async () => { runs += 1; return { ok: true }; },
        'models:removeProfile': async () => { runs += 1; return { ok: true }; }
      }
    });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'models:removeProfile', { id: 'p-hosted' });
    assert.deepStrictEqual(phone.calls, [], 'a hosted profile is ordinary, so the context was read');
    await invoke(dispatcher, a, 2, 'models:removeProfile', { id: 'p-local' });
    assert.strictEqual(phone.calls.length, 1);
    await invoke(dispatcher, a, 3, 'models:setChatProfile', { chatId: 'c-local', profileId: 'p-hosted' });
    assert.strictEqual(phone.calls.length, 2);
    assert.strictEqual(runs, 3);
  });

  it('a local channel is REMOTE_LOCAL_ONLY; a press is REMOTE_PRESS', async () => {
    let runs = 0;
    const run = async () => { runs += 1; return { ok: true }; };
    const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'models:local.add': run, 'case:answerQuestion': run, 'case:verifyNow': run } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'models:local.add', {});
    await invoke(dispatcher, a, 2, 'case:answerQuestion', {});
    await invoke(dispatcher, a, 3, 'case:verifyNow', { caseId: 'no-such-case' });
    assert.deepStrictEqual(resultFor(a, 1).value, { ok: false, code: 'REMOTE_LOCAL_ONLY', error: MESSAGES.REMOTE_LOCAL_ONLY });
    assert.deepStrictEqual(resultFor(a, 2).value, { ok: false, code: 'REMOTE_PRESS', error: MESSAGES.REMOTE_PRESS });
    assert.strictEqual(resultFor(a, 3).value.code, 'REMOTE_PRESS');
    assert.strictEqual(runs, 0);
    assert.deepStrictEqual(phone.calls, []);
  });

  it('a served channel with no class is refused and does not run', async () => {
    let runs = 0;
    const phone = fakePhone();
    // Served as the chat domain is, with no entry in the class table.
    const listed = createBridgeDispatcher({
      core, cipher, dataDir, approvals: { phoneApprover: phone }, hosting: 'personal',
      getConnection: () => currentConnection(),
      getConnections: () => [],
      listChannels: () => ({ handle: ['chat:someNewChannel'], on: [] }),
      registerHandlers: (ipc) => { ipc.handle('chat:someNewChannel', async () => { runs += 1; return { ok: true }; }); }
    });
    assert.deepStrictEqual(listed.served.handle, ['chat:someNewChannel']);
    const a = connection();
    await invoke(listed, a, 1, 'chat:someNewChannel');
    assert.strictEqual(resultFor(a, 1).value.code, 'REMOTE_LOCAL_ONLY');
    assert.strictEqual(runs, 0);
    assert.deepStrictEqual(phone.calls, []);
  });
});

describe('the phone gate', () => {
  it('a phone channel asks the phone with { channel, args } and runs only on approve; a deny is PHONE_DENIED and the handler never ran', async () => {
    const answers = [false, true];
    const ran = [];
    const { dispatcher, phone, use } = makeDispatcher({
      phone: fakePhone(() => answers.shift()),
      overrides: { 'chat:delete': async (event, chatId) => { ran.push([chatId, remoteWindowApproved(event)]); return { ok: true }; } }
    });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:delete', 'c-doomed');
    assert.deepStrictEqual(resultFor(a, 1).value, { ok: false, code: 'PHONE_DENIED', error: MESSAGES.PHONE_DENIED });
    assert.deepStrictEqual(ran, []);
    assert.strictEqual(phone.calls[0].toolName, 'Window');
    assert.deepStrictEqual(phone.calls[0].parameters, { channel: 'chat:delete', args: ['c-doomed'] });
    assert.deepStrictEqual(phone.calls[0].metadata.origin, { client: 'remote-window', deviceId: a.deviceId, session: null, job_id: null });

    await invoke(dispatcher, a, 2, 'chat:delete', 'c-doomed');
    assert.deepStrictEqual(ran, [['c-doomed', 'req-1']]);
    assert.strictEqual(resultFor(a, 2).value.ok, true);
  });

  it('every approved call asks again: an approval is for one call', async () => {
    let runs = 0;
    const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'chat:delete': async () => { runs += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:delete', 'c-same');
    await invoke(dispatcher, a, 2, 'chat:delete', 'c-same');
    assert.strictEqual(phone.calls.length, 2);
    assert.strictEqual(runs, 2);
  });

  it('a timed-out approval runs nothing and answers plainly', async () => {
    let runs = 0;
    const { dispatcher, use } = makeDispatcher({ phone: fakePhone(() => 'timeout'), overrides: { 'chat:delete': async () => { runs += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:delete', 'c-any');
    assert.strictEqual(resultFor(a, 1).value.code, 'PHONE_DENIED');
    assert.strictEqual(runs, 0);
  });

  it('an approval with no request id runs nothing', async () => {
    let runs = 0;
    const phone = { ttlMs: 1000, calls: [], requestApproval: async () => true };
    const { dispatcher, use } = makeDispatcher({ phone, overrides: { 'chat:delete': async () => { runs += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:delete', 'c-any');
    assert.strictEqual(resultFor(a, 1).value.ok, false);
    assert.strictEqual(runs, 0);
  });

  it('an approver that throws runs nothing', async () => {
    let runs = 0;
    const phone = { ttlMs: 1000, requestApproval: async () => { throw new Error('link down'); } };
    const { dispatcher, use } = makeDispatcher({ phone, overrides: { 'chat:delete': async () => { runs += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:delete', 'c-any');
    assert.strictEqual(resultFor(a, 1).value.code, 'NO_PHONE');
    assert.strictEqual(runs, 0);
  });

  it('the arguments are read once: what changes while the phone is asked does not reach the handler', async () => {
    const frame = { t: 'invoke', id: 1, channel: 'settings:saveUserProfile', args: [{ profile: { name: 'original', nested: { n: 1 } } }] };
    let received = null;
    const { dispatcher, use } = makeDispatcher({
      phone: fakePhone((_tool, parameters) => {
        // The frame's object and the approver's copy, both written to mid-approval.
        frame.args[0].profile.name = 'changed by the frame';
        frame.args[0].profile.nested.n = 2;
        frame.args.push('one more');
        parameters.args[0].profile.name = 'changed by the approver';
        return true;
      }),
      overrides: { 'settings:saveUserProfile': async (_event, ...args) => { received = args; return { ok: true }; } }
    });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, frame);
    assert.deepStrictEqual(received, [{ profile: { name: 'original', nested: { n: 1 } } }]);
  });

  it('a call method\'s parameters are read once too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-once-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-elsewhere-'));
    const frame = { t: 'call', id: 1, method: 'bridge.addAllowedDirectory', params: { path: dir } };
    const { dispatcher, use } = makeDispatcher({ phone: fakePhone(() => { frame.params.path = elsewhere; return true; }) });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, frame);
    const dirs = resultFor(a, 1).value.allowedDirectories;
    assert.ok(dirs.includes(dir));
    assert.ok(!dirs.includes(elsewhere));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('the bulk channel is asked as names, sizes and a keyed hash; the handler gets the bytes that were hashed; other bytes ask again', async () => {
    const received = [];
    const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'case:ingestFiles': async (_event, ...args) => { received.push(args); return { ok: true }; } } });
    const a = connection();
    use(a);
    const files = (fill) => [{ caseId: 'case-1', files: [{ name: 'deed.pdf', mime: 'application/pdf', base64: fill.repeat(300 * 1024) }] }];
    await invoke(dispatcher, a, 1, 'case:ingestFiles', ...files('AAAA'));
    const card = phone.calls[0].parameters;
    assert.strictEqual(card.channel, 'case:ingestFiles');
    assert.strictEqual(card.caseId, 'case-1');
    assert.deepStrictEqual(card.files, [{ name: 'deed.pdf', bytes: 900 * 1024 }], 'the size is read from the bytes');
    assert.strictEqual(card.bytes, Buffer.byteLength(canonicalize(files('AAAA'))));
    assert.match(card.args_sha256, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!JSON.stringify(card).includes('AAAA'));
    assert.deepStrictEqual(received[0], files('AAAA'));
    await invoke(dispatcher, a, 2, 'case:ingestFiles', ...files('BBBB'));
    assert.strictEqual(phone.calls.length, 2, 'asked again');
    assert.deepStrictEqual(received[1], files('BBBB'));
    assert.strictEqual(WINDOW_ARGS_INLINE_MAX, 65536);
  });

  it('a small upload takes the same card, and a size the window states is not an accepted key', async () => {
    const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'case:ingestFiles': async () => ({ ok: true }) } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'case:ingestFiles', { caseId: 'case-1', files: [{ name: 'a.txt', base64: 'QUJD', bytes: 1 }] });
    assert.deepStrictEqual(phone.calls[0].parameters.files, [{ name: 'a.txt', bytes: 3 }]);
    await invoke(dispatcher, a, 2, 'case:ingestFiles', { caseId: 'case-1', files: [{ name: 'a.txt', base64: 'QUJD' }] });
    assert.deepStrictEqual(phone.calls[1].parameters.files, [{ name: 'a.txt', bytes: 3 }]);
  });

  it('the hash is keyed per call: the same short value never gives the same mark', async () => {
    const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'settings:vaultStore': async () => ({ ok: true }) } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'settings:vaultStore', { key: 'a.key', value: '1234' });
    await invoke(dispatcher, a, 2, 'settings:vaultStore', { key: 'a.key', value: '1234' });
    const [one, two] = phone.calls.map((c) => c.parameters.args_sha256);
    assert.notStrictEqual(one, two);
    assert.notStrictEqual(one, sha256b64url(canonicalize([{ key: 'a.key', value: '1234' }])));
  });

  describe('what a card may hide (R-RW-30, R-RW-32)', () => {
    const SECRET = 'invented-secret-value';
    const CASES = [
      ['settings:vaultStore', { key: 'a.key', value: SECRET }, { key: 'a.key' }],
      ['settings:vaultUpdate', { oldKey: 'a.key', newKey: 'b.key', value: SECRET }, { oldKey: 'a.key', newKey: 'b.key' }],
      ['settings:saveProvider', { provider: 'openai', token: SECRET, clear: false }, { provider: 'openai', clear: false }],
      ['settings:saveWebSearchKey', { provider: 'brave', apiKey: SECRET }, { provider: 'brave' }],
      ['settings:saveImageGenKey', { provider: 'fal', apiKey: SECRET }, { provider: 'fal' }],
      ['settings:saveElevenLabsKey', { apiKey: SECRET, clear: false }, { clear: false }],
      ['history:jev.saveKey', { key: SECRET }, {}],
      ['settings:mcpSave', { name: 'files', oldName: 'old', server: { command: 'npx', args: ['--token', SECRET], env: { API_TOKEN: SECRET }, cwd: 'C:\\example' } }, { name: 'files', oldName: 'old', command: 'npx', env_names: ['API_TOKEN'] }],
      ['settings:runLlmCommand', { command: `/llm add openai ${SECRET}` }, { verb: 'add' }],
      ['webhook:update', { id: 'wh-1', messageTemplate: SECRET, name: SECRET }, { id: 'wh-1', fields: ['messageTemplate', 'name'] }],
      ['skill:saveSettings', { skillId: 'std', settings: { apiKey: SECRET, depth: 3 } }, { skillId: 'std', setting_names: ['apiKey', 'depth'] }],
      ['settings:saveTemplateVariables', { templateVariables: { TOKEN: SECRET } }, { variable_names: ['TOKEN'] }],
      ['settings:saveNotifications', { notifications: { enabled: true, ntfy: { server: 'https://ntfy.example.com', topic: SECRET } } }, { notifications: { enabled: true, ntfy: { server: 'https://ntfy.example.com' } } }],
      ['tool:execute', { toolName: 'Vault', parameters: { action: 'store', key: 'a.key', value: SECRET } }, { tool: 'Vault', action: 'store', key: 'a.key' }]
    ];
    for (const [channel, payload, shown] of CASES) {
      it(`${channel} shows what it shows and never the value; the handler gets the value`, async () => {
        let received = null;
        const { dispatcher, phone, use } = makeDispatcher({ overrides: { [channel]: async (_event, ...args) => { received = args; return { ok: true }; } } });
        const a = connection();
        use(a);
        await invoke(dispatcher, a, 1, channel, payload);
        const { args_sha256: mark, bytes, ...card } = phone.calls[0].parameters;
        assert.deepStrictEqual(card, { channel, ...shown });
        assert.match(mark, /^[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(bytes, Buffer.byteLength(canonicalize([payload])));
        assert.ok(!JSON.stringify(phone.calls[0].parameters).includes(SECRET), 'the value is on no card');
        assert.deepStrictEqual(received, [payload]);
      });
    }

    it('on a fleet node a channel verb of /llm is refused before anyone is asked', async () => {
      const { dispatcher, phone, use } = makeDispatcher({ hosting: 'service' });
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'settings:runLlmCommand', { command: `/llm telegram add ${SECRET}` });
      assert.strictEqual(resultFor(a, 1).value.code, 'CHANNELS_NOT_PROXIED');
      assert.deepStrictEqual(phone.calls, []);
    });

    it('tool:execute of any other tool stays inline', async () => {
      const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'tool:execute': async () => ({ ok: true }) } });
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'tool:execute', { toolName: 'Read', parameters: { file_path: 'a.txt' } });
      assert.deepStrictEqual(phone.calls[0].parameters, { channel: 'tool:execute', args: [{ toolName: 'Read', parameters: { file_path: 'a.txt' } }] });
    });

    it('the seam hides a Vault store the same way, and only that', () => {
      const card = toolCardParams('Vault', { action: 'store', key: 'a.key', value: SECRET });
      assert.deepStrictEqual(Object.keys(card).sort(), ['action', 'args_sha256', 'bytes', 'key']);
      assert.ok(!JSON.stringify(card).includes(SECRET));
      const read = { file_path: 'a.txt' };
      assert.strictEqual(toolCardParams('Read', read), read);
    });

    it('a chat turn\'s Vault call reaches the phone with no value', async () => {
      const seen = [];
      const phone = { ttlMs: 1000, isAvailable: () => true, requestApproval: async (tool, parameters) => { seen.push([tool, parameters]); return false; } };
      const { approvalSeam } = require('../src/approvals/executor-options');
      const { markRemoteWindowEvent } = require('../src/core/origin');
      const seam = approvalSeam({ remoteApprovals: 'phone', event: markRemoteWindowEvent({}, { deviceId: deviceId('remotewindow') }), executorOptions: { chatId: 'c' }, phoneApprover: phone });
      await seam.toolExecutorOptions.approvalRequester('Vault', { action: 'store', key: 'a.key', value: SECRET }, {});
      assert.strictEqual(seen[0][0], 'Vault');
      assert.ok(!JSON.stringify(seen[0][1]).includes(SECRET));
      assert.strictEqual(seen[0][1].key, 'a.key');
    });

    it('URL userinfo is stripped from the card, and the handler gets the URL as sent', async () => {
      const URLS = [
        ['models:setOllamaBaseUrl', { baseUrl: `http://me:${SECRET}@ollama.example.com:11434` }, 'http://ollama.example.com:11434'],
        ['history:embedder.save', { embedder: { kind: 'ollama', ollama: { baseUrl: `http://me:${SECRET}@ollama.example.com` } } }, 'http://ollama.example.com'],
        ['skill:install', { url: `https://me:${SECRET}@git.example.com/skill.git` }, 'https://git.example.com/skill.git'],
        ['case:addPlaybook', { caseId: 'case-1', source: `https://${SECRET}@git.example.com/p.git` }, 'https://git.example.com/p.git'],
        ['case:create', { title: 'Lakeside lot', playbooks: [{ source: `https://${SECRET}@git.example.com/p.git` }] }, 'https://git.example.com/p.git']
      ];
      for (const [channel, payload, clean] of URLS) {
        let received = null;
        const { dispatcher, phone, use } = makeDispatcher({ overrides: { [channel]: async (_event, ...args) => { received = args; return { ok: true }; } } });
        const a = connection();
        use(a);
        await invoke(dispatcher, a, 1, channel, payload);
        const card = JSON.stringify(phone.calls[0].parameters);
        assert.ok(!card.includes(SECRET), channel);
        assert.ok(card.includes(clean), channel);
        assert.ok(phone.calls[0].parameters.args_sha256, `${channel}: what runs differs from what shows, so the hash says so`);
        assert.deepStrictEqual(received, [payload], channel);
      }
    });

    it('a URL with no userinfo is shown as it is, inline', async () => {
      const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'skill:install': async () => ({ ok: true }) } });
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'skill:install', { url: 'https://git.example.com/skill.git' });
      assert.deepStrictEqual(phone.calls[0].parameters, { channel: 'skill:install', args: [{ url: 'https://git.example.com/skill.git' }] });
    });
  });

  describe('a card cannot be padded (R-RW-32)', () => {
    const PAD = 'x'.repeat(70000);
    const padded = [
      ['settings:mcpSave', { name: 'files', server: { command: 'evil.exe' } }],
      ['cron:add', { name: 'nightly', schedule: { kind: 'every', everyMs: 60000 }, payload: { kind: 'agentTurn', message: 'go' } }],
      ['skill:install', { url: 'https://git.example.com/evil.git' }]
    ];
    for (const [channel, payload] of padded) {
      it(`${channel} with a padding key is refused and nobody is asked`, async () => {
        let runs = 0;
        const { dispatcher, phone, use } = makeDispatcher({ overrides: { [channel]: async () => { runs += 1; return { ok: true }; } } });
        const a = connection();
        use(a);
        await invoke(dispatcher, a, 1, channel, { ...payload, pad: PAD });
        assert.strictEqual(resultFor(a, 1).value.ok, false);
        assert.ok(['REMOTE_ARGS_TOO_LARGE', 'REMOTE_ARGS_INVALID'].includes(resultFor(a, 1).value.code), String(resultFor(a, 1).value.code));
        assert.deepStrictEqual(phone.calls, []);
        assert.strictEqual(runs, 0);
      });

      it(`${channel} with a small key that sorts first is refused too`, async () => {
        const { dispatcher, phone, use } = makeDispatcher({ overrides: { [channel]: async () => ({ ok: true }) } });
        const a = connection();
        use(a);
        await invoke(dispatcher, a, 1, channel, { ...payload, '!lead': 'y'.repeat(100) });
        assert.strictEqual(resultFor(a, 1).value.code, 'REMOTE_ARGS_INVALID');
        assert.deepStrictEqual(phone.calls, []);
      });
    }

    it('any other phone channel over the limit is REMOTE_ARGS_TOO_LARGE, and at the limit goes inline', async () => {
      const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'workflow:plan': async () => ({ ok: true }) } });
      const a = connection();
      use(a);
      const leaves = (bytes) => {
        const names = ['a', 'b', 'c', 'd', 'e'];
        const left = bytes - Buffer.byteLength(canonicalize([Object.fromEntries(names.map((n) => [n, '']))]));
        const each = Math.floor(left / names.length);
        return Object.fromEntries(names.map((n, i) => [n, 'z'.repeat(i === 0 ? left - each * (names.length - 1) : each)]));
      };
      const atLimit = leaves(WINDOW_ARGS_INLINE_MAX);
      assert.strictEqual(Buffer.byteLength(canonicalize([atLimit])), WINDOW_ARGS_INLINE_MAX);
      await invoke(dispatcher, a, 1, 'workflow:plan', atLimit);
      assert.deepStrictEqual(phone.calls[0].parameters, { channel: 'workflow:plan', args: [atLimit] });
      await invoke(dispatcher, a, 2, 'workflow:plan', { ...atLimit, more: 'z' });
      assert.strictEqual(resultFor(a, 2).value.code, 'REMOTE_ARGS_TOO_LARGE');
      assert.strictEqual(phone.calls.length, 1);
    });

    it('a leaf over the cap is refused, a value or a key, even in a shape nobody listed', async () => {
      const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'workflow:plan': async () => ({ ok: true }) } });
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'workflow:plan', { goal: 'g'.repeat(WINDOW_LEAF_MAX + 1) });
      await invoke(dispatcher, a, 2, 'workflow:plan', { ['g'.repeat(WINDOW_LEAF_MAX + 1)]: 'x' });
      await invoke(dispatcher, a, 3, 'workflow:plan', { goal: 'g'.repeat(WINDOW_LEAF_MAX) });
      assert.strictEqual(resultFor(a, 1).value.code, 'REMOTE_ARGS_TOO_LARGE');
      assert.strictEqual(resultFor(a, 2).value.code, 'REMOTE_ARGS_TOO_LARGE');
      assert.strictEqual(phone.calls.length, 1);
    });

    it('a second positional argument on a listed channel is refused', async () => {
      const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'skill:install': async () => ({ ok: true }) } });
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'skill:install', { url: 'https://git.example.com/s.git' }, 'y'.repeat(100));
      assert.strictEqual(resultFor(a, 1).value.code, 'REMOTE_ARGS_INVALID');
      assert.deepStrictEqual(phone.calls, []);
    });

    it('a hidden channel\'s shown field cannot be the padding', async () => {
      const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'settings:vaultStore': async () => ({ ok: true }) } });
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'settings:vaultStore', { key: 'k'.repeat(WINDOW_LEAF_MAX + 1), value: 'v' });
      assert.strictEqual(resultFor(a, 1).value.code, 'REMOTE_ARGS_TOO_LARGE');
      assert.deepStrictEqual(phone.calls, []);
    });
  });

  it('large arguments are read once as well: the handler gets what was hashed, not the frame as it is now', async () => {
    const base64 = 'QUJD'.repeat(40000);
    const frame = { t: 'invoke', id: 1, channel: 'case:ingestFiles', args: [{ caseId: 'case-1', files: [{ name: 'a.txt', base64 }] }] };
    let received = null;
    const { dispatcher, use } = makeDispatcher({
      phone: fakePhone(() => { frame.args[0].files[0].base64 = 'swapped'; return true; }),
      overrides: { 'case:ingestFiles': async (_event, ...args) => { received = args; return { ok: true }; } }
    });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, frame);
    assert.deepStrictEqual(received, [{ caseId: 'case-1', files: [{ name: 'a.txt', base64 }] }]);
  });

  it('arguments that have no canonical form are refused before anyone is asked', async () => {
    let runs = 0;
    const { dispatcher, phone, use } = makeDispatcher({ overrides: { 'chat:delete': async () => { runs += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:delete', 'lone \ud800 surrogate');
    assert.strictEqual(resultFor(a, 1).value.ok, false);
    assert.strictEqual(resultFor(a, 1).value.code, 'REMOTE_ARGS_INVALID');
    assert.deepStrictEqual(phone.calls, []);
    assert.strictEqual(runs, 0);
  });

  it('no approver at all is NO_PHONE', async () => {
    let runs = 0;
    const { dispatcher, use } = makeDispatcher({ phone: null, overrides: { 'chat:delete': async () => { runs += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:delete', 'c-any');
    assert.deepStrictEqual(resultFor(a, 1).value, { ok: false, code: 'NO_PHONE', error: MESSAGES.NO_PHONE });
    assert.strictEqual(runs, 0);
  });

  it('every t:call method takes the same path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-call-'));
    const answers = [false, true];
    const { dispatcher, phone, use } = makeDispatcher({ phone: fakePhone(() => answers.shift()) });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'call', id: 1, method: 'bridge.status', params: {} });
    assert.deepStrictEqual(resultFor(a, 1).value, { version: '26.9.0' });
    assert.deepStrictEqual(phone.calls, [], 'a read asks nobody');

    await dispatcher.handleFrame(a, { t: 'call', id: 2, method: 'bridge.addAllowedDirectory', params: { path: dir } });
    assert.strictEqual(resultFor(a, 2).value.code, 'PHONE_DENIED');
    assert.deepStrictEqual(phone.calls[0].parameters, { channel: 'bridge.addAllowedDirectory', args: { path: dir } });

    await dispatcher.handleFrame(a, { t: 'call', id: 3, method: 'bridge.addAllowedDirectory', params: { path: dir } });
    assert.ok(resultFor(a, 3).value.allowedDirectories.includes(dir));

    await dispatcher.handleFrame(a, { t: 'call', id: 4, method: 'import.plan', params: {} });
    assert.strictEqual(resultFor(a, 4).value.code, 'REMOTE_LOCAL_ONLY');

    await dispatcher.handleFrame(a, { t: 'call', id: 5, method: 'bridge.someNewMethod', params: {} });
    assert.strictEqual(resultFor(a, 5).value.code, 'REMOTE_LOCAL_ONLY', 'unknown, refused');
    assert.strictEqual(phone.calls.length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bridge.setWorkingDirectory hands the handler an event that carries the approval', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-wd-'));
    let seen = null;
    const { dispatcher, use } = makeDispatcher({ overrides: { 'chat:setWorkingDirectory': async (event) => { seen = event; return { ok: true }; } } });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'call', id: 1, method: 'bridge.setWorkingDirectory', params: { chatId: 'c', path: dir } });
    assert.strictEqual(remoteWindowApproved(seen), 'req-1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('on the real PhoneApprover', () => {
    const fakeLink = () => {
      const link = { submitted: [], on() {}, off() {}, isConnected: () => true, canDeliver: () => ({ ok: true }), status: async () => {}, submit: async (env) => { link.submitted.push(env); } };
      return link;
    };
    const ledger = () => ({ entries: [], append: async function append(e) { this.entries.push(e); return e; } });
    const stores = [];
    after(() => { for (const s of stores) s.cleanup(); });

    it('the card is the channel and the window; the approval gives its request id; a deny is audited', async () => {
      const device = createFakePhone({ name: 'Phone 1' });
      const store = await approverStoreWith([device.approverRecord()]);
      stores.push(store);
      const link = fakeLink();
      const audit = ledger();
      const approver = new PhoneApprover({ identity: testNodeIdentity(), approverStore: store, link, auditLedger: audit, ttlMs: 60000 });
      const seen = [];
      const { dispatcher, use } = makeDispatcher({ phone: approver, overrides: { 'chat:delete': async (event) => { seen.push(remoteWindowApproved(event)); return { ok: true }; } } });
      const a = connection({ label: 'Field laptop' });
      use(a);

      const running = invoke(dispatcher, a, 1, 'chat:delete', 'c-real');
      await waitFor(() => link.submitted.length === 1);
      const { message } = open(link.submitted[0]);
      assert.strictEqual(message.action.summary, 'chat:delete from Field laptop');
      assert.strictEqual(message.action.name, 'Window');
      assert.strictEqual(message.action.kind, 'tool');
      assert.strictEqual(message.action.cwd, null);
      assert.deepStrictEqual(message.action.params, { channel: 'chat:delete', args: ['c-real'] });
      assert.deepStrictEqual(message.origin, { client: 'remote-window', session: null, job_id: null, deviceId: a.deviceId }, 'the card names the window that asked');
      assert.ok(audit.entries.some((e) => e.kind === 'approval.request' && open(e.data.envelope).message.origin.deviceId === a.deviceId), 'and so does the audit');
      assert.strictEqual((await approver.handleResponse(device.respond(link.submitted[0], 'approve'))).accepted, true);
      await running;
      assert.deepStrictEqual(seen, [message.request_id]);

      const denied = invoke(dispatcher, a, 2, 'chat:delete', 'c-real');
      await waitFor(() => link.submitted.length === 2);
      await approver.handleResponse(device.respond(link.submitted[1], 'deny'));
      await denied;
      assert.strictEqual(resultFor(a, 2).value.code, 'PHONE_DENIED');
      assert.strictEqual(seen.length, 1);
      await waitFor(() => audit.entries.some((e) => e.kind === 'approval.outcome' && e.data.state === 'denied'));
      approver.stop();
    });

    it('a folder card names the window, in its summary and its origin', async () => {
      const device = createFakePhone({ name: 'Phone 1' });
      const store = await approverStoreWith([device.approverRecord()]);
      stores.push(store);
      const link = fakeLink();
      const approver = new PhoneApprover({ identity: testNodeIdentity(), approverStore: store, link, auditLedger: ledger(), ttlMs: 60000 });
      let ctxRef = null;
      const { dispatcher, use } = makeDispatcher({
        phone: approver,
        overrides: { 'chat:sendMessage': async () => { await ctxRef.prompter.requestDirectoryAccess({ directory: 'C:\\example\\lot', toolName: 'Read' }); return { ok: true }; } },
        patchContext: (ctx) => { ctxRef = ctx; }
      });
      const a = connection({ label: 'Field laptop' });
      use(a);
      const running = invoke(dispatcher, a, 1, 'chat:sendMessage', { chatId: 'c-any', message: 'go' });
      await waitFor(() => link.submitted.length === 1);
      const { message } = open(link.submitted[0]);
      assert.strictEqual(message.action.name, 'AllowDirectory');
      assert.match(message.action.summary, /^From Field laptop: /);
      assert.strictEqual(message.origin.deviceId, a.deviceId);
      approver.stop();
      await running;
    });

    it('a window whose label is not one plain line is not named on the card', async () => {
      const device = createFakePhone({ name: 'Phone 1' });
      const store = await approverStoreWith([device.approverRecord()]);
      stores.push(store);
      const link = fakeLink();
      const approver = new PhoneApprover({ identity: testNodeIdentity(), approverStore: store, link, auditLedger: ledger(), ttlMs: 60000 });
      const { dispatcher, use } = makeDispatcher({ phone: approver, overrides: { 'chat:delete': async () => ({ ok: true }) } });
      const a = connection({ label: 'Field\nlaptop \u202Eevil' });
      use(a);
      const running = invoke(dispatcher, a, 1, 'chat:delete', 'c-real');
      await waitFor(() => link.submitted.length === 1);
      assert.strictEqual(open(link.submitted[0]).message.action.summary, 'chat:delete from a window (name hidden)');
      approver.stop();
      await running;
    });

    it('a long label is cut at 120 characters', async () => {
      const seen = [];
      const phone = fakePhone((_tool, parameters, metadata) => { seen.push(toolAction('Window', parameters, null, metadata.cardNote).summary); return false; });
      const { dispatcher, use } = makeDispatcher({ phone });
      const a = connection({ label: 'x'.repeat(300) });
      use(a);
      await invoke(dispatcher, a, 1, 'chat:delete', 'c-real');
      assert.strictEqual(Array.from(seen[0]).length, 120);
      assert.ok(seen[0].startsWith('chat:delete from xxx'));
    });

    it('the note is the whole summary of a Window card, and any other tool keeps its pattern', () => {
      assert.strictEqual(toolAction('Window', { channel: 'chat:delete', args: [] }, null, 'chat:delete from Field laptop').summary, 'chat:delete from Field laptop');
      assert.match(toolAction('Bash', { command: 'npm test' }, null, 'Sandbox off').summary, /^Sandbox off: Bash/);
    });

    it('no phone enrolled: nothing runs, the answer is NO_PHONE', async () => {
      const store = await approverStoreWith([]);
      stores.push(store);
      const approver = new PhoneApprover({ identity: testNodeIdentity(), approverStore: store, link: fakeLink(), auditLedger: ledger(), ttlMs: 60000 });
      let runs = 0;
      const { dispatcher, use } = makeDispatcher({ phone: approver, overrides: { 'chat:delete': async () => { runs += 1; return { ok: true }; } } });
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'chat:delete', 'c-real');
      assert.strictEqual(resultFor(a, 1).value.code, 'NO_PHONE');
      assert.match(resultFor(a, 1).value.error, /no enrolled device/);
      assert.strictEqual(runs, 0);
      approver.stop();
    });

    it('sealing with nobody to seal to: nothing runs, and the answer says no_sealed_recipient', async () => {
      const device = createFakePhone({ name: 'Phone 1' });
      const store = await approverStoreWith([device.approverRecord()]);
      stores.push(store);
      const sealPolicy = { sealing: () => true, canSeal: () => false, whyNot: () => 'no phone can read a sealed approval' };
      const link = fakeLink();
      const approver = new PhoneApprover({ identity: testNodeIdentity(), approverStore: store, link, auditLedger: ledger(), ttlMs: 60000, sealPolicy });
      let runs = 0;
      const { dispatcher, use } = makeDispatcher({ phone: approver, overrides: { 'chat:delete': async () => { runs += 1; return { ok: true }; } } });
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'chat:delete', 'c-real');
      assert.strictEqual(resultFor(a, 1).value.code, 'NO_PHONE');
      assert.match(resultFor(a, 1).value.error, /no_sealed_recipient/);
      assert.deepStrictEqual(link.submitted, []);
      assert.strictEqual(runs, 0);
      approver.stop();
    });
  });
});

describe('the gates the handlers keep', () => {
  it('chat:markPrivate from a remote connection asks the phone, and on approve the mark is written (remoteWindowApproved on the event)', async () => {
    const answers = [false, true];
    const { dispatcher, phone, use } = makeDispatcher({ phone: fakePhone(() => answers.shift()) });
    const chatId = newChat('c-private');
    const store = core.context.getHistoryStore();
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:markPrivate', { chatId, confirm: true });
    assert.strictEqual(resultFor(a, 1).value.code, 'PHONE_DENIED');
    assert.notStrictEqual(store.isPrivate(chatId), true);
    await invoke(dispatcher, a, 2, 'chat:markPrivate', { chatId, confirm: true });
    assert.strictEqual(resultFor(a, 2).value.ok, true);
    assert.strictEqual(resultFor(a, 2).value.marked, true);
    assert.strictEqual(store.isPrivate(chatId), true);
    assert.strictEqual(phone.calls.length, 2);
  });

  it('presence:heartbeat from a remote connection is accepted and does not count', async () => {
    const presence = () => JSON.stringify(core.context.getContact()?.presenceStatus?.() ?? null);
    const before = presence();
    const { dispatcher, phone, use } = makeDispatcher();
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'presence:heartbeat', { focused: true });
    assert.deepStrictEqual(resultFor(a, 1).value, { ok: true, counted: false });
    assert.deepStrictEqual(phone.calls, []);
    assert.strictEqual(presence(), before);
  });

  it('tool:approvalResponse from a remote connection is dropped and never answers a prompt', async () => {
    const answered = [];
    const { dispatcher, use } = makeDispatcher({
      listeners: {
        'tool:approvalResponse': (_e, p) => answered.push(p),
        'tool:directoryAccessResponse': (_e, p) => answered.push(p)
      }
    });
    const a = connection();
    use(a);
    // Even an id this connection somehow holds.
    a.prompts.approvals.add('appr-1');
    a.prompts.directory.add('dir-1');
    await dispatcher.handleFrame(a, { t: 'send', channel: 'tool:approvalResponse', args: [{ approvalId: 'appr-1', approved: true }] });
    await dispatcher.handleFrame(a, { t: 'send', channel: 'tool:directoryAccessResponse', args: [{ requestId: 'dir-1', approved: true }] });
    assert.deepStrictEqual(answered, []);
    assert.ok(a.prompts.approvals.has('appr-1'), 'nothing was consumed');
  });

  it('a local window\'s on-screen approval cannot be answered from a remote one', async () => {
    const { dispatcher, use } = makeDispatcher();
    const local = connection({ remote: false, device: 'localwindow' });
    const remote = connection();
    use(local, remote);
    const before = probeRuns;
    const running = invoke(dispatcher, local, 1, 'tool:execute', { toolName: PROBE, parameters: {} });
    const prompt = await waitFor(() => asked(local, 'tool:approvalRequired')[0]);
    assert.deepStrictEqual(asked(remote, 'tool:approvalRequired'), []);
    await dispatcher.handleFrame(remote, { t: 'send', channel: 'tool:approvalResponse', args: [{ approvalId: prompt.payload.approvalId, approved: true }] });
    await new Promise((r) => { setTimeout(r, 30); });
    assert.strictEqual(probeRuns, before);
    await dispatcher.handleFrame(local, { t: 'send', channel: 'tool:approvalResponse', args: [{ approvalId: prompt.payload.approvalId, approved: false }] });
    await running;
    assert.strictEqual(probeRuns, before);
  });

  it('tool:execute from a remote connection sends the tool approval to the phone, not tool:approvalRequired', async () => {
    const before = probeRuns;
    const gate = fakePhone();
    const { dispatcher, use } = makeDispatcher({ coreOverride: phoneCore, phone: gate });
    const a = connection();
    use(a);
    toolPhone.calls.length = 0;
    await invoke(dispatcher, a, 1, 'tool:execute', { toolName: PROBE, parameters: {} });
    assert.deepStrictEqual(gate.calls.map((c) => c.toolName), ['Window'], 'the channel call, at the dispatcher');
    assert.deepStrictEqual(gate.calls[0].parameters, { channel: 'tool:execute', args: [{ toolName: PROBE, parameters: {} }] });
    assert.deepStrictEqual(toolPhone.calls.map((c) => c.toolName), [PROBE], 'the tool, at the seam');
    assert.strictEqual(toolPhone.calls[0].metadata.origin.client, 'remote-window');
    assert.deepStrictEqual(asked(a, 'tool:approvalRequired'), []);
    assert.strictEqual(probeRuns, before + 1);
    assert.strictEqual(resultFor(a, 1).value.ok, true);
  });

  it('tool:execute with the channel call denied never builds the tool', async () => {
    const before = probeRuns;
    const gate = fakePhone(() => false);
    const { dispatcher, use } = makeDispatcher({ coreOverride: phoneCore, phone: gate });
    const a = connection();
    use(a);
    toolPhone.calls.length = 0;
    await invoke(dispatcher, a, 1, 'tool:execute', { toolName: PROBE, parameters: {} });
    assert.strictEqual(resultFor(a, 1).value.code, 'PHONE_DENIED');
    assert.deepStrictEqual(toolPhone.calls, []);
    assert.strictEqual(probeRuns, before);
  });

  it('tool:execute on a node that does not send tools to the phone answers false for the tool, with no dialog', async () => {
    const before = probeRuns;
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'tool:execute', { toolName: PROBE, parameters: {} });
    assert.deepStrictEqual(asked(a, 'tool:approvalRequired'), []);
    assert.strictEqual(resultFor(a, 1).value.data.deniedBy, 'user');
    assert.strictEqual(probeRuns, before);
  });
});

describe('a remote drop', () => {
  const heldRun = () => {
    const runs = new Map();
    const stopped = [];
    return {
      runs,
      stopped,
      overrides: { 'chat:sendMessage': async (event, { chatId }) => new Promise((resolve) => { runs.set(chatId, { event, resolve }); }) },
      patchContext: (ctx) => { ctx.stopRunForEvent = (event) => { stopped.push(event); return true; }; }
    };
  };

  it('a remote drop stops no run and appends no row; a local drop keeps stage 2\'s behaviour', async () => {
    const held = heldRun();
    const { dispatcher, use } = makeDispatcher(held);
    const chatId = newChat('c-remote-drop');
    const a = connection();
    use(a);
    const running = invoke(dispatcher, a, 1, 'chat:sendMessage', { chatId, message: 'go' });
    await waitFor(() => held.runs.get(chatId));
    a.markGone();
    await dispatcher.onDisconnect(a);
    assert.deepStrictEqual(held.stopped, []);
    assert.deepStrictEqual(core.context.getChat(chatId).messages.filter((m) => m.text === STOPPED_ROW), []);
    assert.strictEqual(a.cleaned, true);
    held.runs.get(chatId).resolve({ ok: true });
    await running;

    const heldLocal = heldRun();
    const local = makeDispatcher(heldLocal);
    const localChat = newChat('c-local-drop');
    const b = connection({ remote: false, device: 'localwindow' });
    local.use(b);
    const localRun = invoke(local.dispatcher, b, 1, 'chat:sendMessage', { chatId: localChat, message: 'go' });
    await waitFor(() => heldLocal.runs.get(localChat));
    b.markGone();
    await local.dispatcher.onDisconnect(b);
    assert.strictEqual(heldLocal.stopped.length, 1);
    assert.strictEqual(core.context.getChat(localChat).messages.at(-1).text, STOPPED_ROW);
    heldLocal.runs.get(localChat).resolve({ ok: true });
    await localRun;
  });

  it('after a drop the run\'s events reach the same device\'s new connection', async () => {
    const held = heldRun();
    const { dispatcher, use, leave } = makeDispatcher(held);
    const chatId = newChat('c-remote-events');
    const a = connection();
    use(a);
    const running = invoke(dispatcher, a, 1, 'chat:sendMessage', { chatId, message: 'go' });
    await waitFor(() => held.runs.get(chatId));
    const { event } = held.runs.get(chatId);
    a.markGone();
    await dispatcher.onDisconnect(a);
    leave(a);
    assert.strictEqual(event.sender.isDestroyed(), true, 'no window left');
    const back = connection();
    use(back);
    assert.strictEqual(event.sender.isDestroyed(), false);
    event.sender.send('chat:messageComplete', { chatId, responseId: 'r1' });
    assert.ok(back.sent.some((f) => f.channel === 'chat:messageComplete'));
    held.runs.get(chatId).resolve({ ok: true });
    await running;
  });

  it('a stop from the new connection still stops the run', async () => {
    let stops = 0;
    const { dispatcher, use } = makeDispatcher({ overrides: { 'chat:stopResponse': async () => { stops += 1; return { ok: true }; } } });
    const back = connection();
    use(back);
    await invoke(dispatcher, back, 1, 'chat:stopResponse', { chatId: 'c-any' });
    assert.strictEqual(stops, 1);
  });

  describe('ask_user', () => {
    // A run the window started that asks; the handler's own context is the prompter.
    const asking = () => {
      const answers = new Map();
      let ctxRef = null;
      return {
        answers,
        overrides: {
          'chat:sendMessage': async (_event, { chatId, question }) => {
            answers.set(chatId, await ctxRef.prompter.askUser({ question }));
            return { ok: true };
          }
        },
        patchContext: (ctx) => { ctxRef = ctx; }
      };
    };

    it('goes to the run\'s own window and no other', async () => {
      const run = asking();
      const { dispatcher, use } = makeDispatcher(run);
      const a = connection();
      const other = connection({ device: 'otherwindow' });
      const local = connection({ remote: false, device: 'localwindow' });
      use(a, other, local);
      const running = invoke(dispatcher, a, 1, 'chat:sendMessage', { chatId: 'c-ask-own', question: 'Which lot?' });
      const shown = await waitFor(() => asked(a)[0]);
      assert.strictEqual(shown.payload.question, 'Which lot?');
      assert.deepStrictEqual(asked(other), []);
      assert.deepStrictEqual(asked(local), []);
      await dispatcher.handleFrame(other, { t: 'send', channel: 'agent:userResponse', args: [{ requestId: shown.payload.requestId, response: 'not mine' }] });
      await dispatcher.handleFrame(a, { t: 'send', channel: 'agent:userResponse', args: [{ requestId: shown.payload.requestId, response: 'the north one' }] });
      await running;
      assert.deepStrictEqual(run.answers.get('c-ask-own'), { ok: true, response: 'the north one' });
    });

    it('an askUser pending on a dropped remote connection is sent again to that device\'s next connection and its answer lands', async () => {
      const run = asking();
      const { dispatcher, use, leave } = makeDispatcher(run);
      const a = connection();
      use(a);
      const running = invoke(dispatcher, a, 1, 'chat:sendMessage', { chatId: 'c-ask-back', question: 'Which lot?' });
      const shown = await waitFor(() => asked(a)[0]);
      a.markGone();
      await dispatcher.onDisconnect(a);
      leave(a);
      assert.deepStrictEqual(dispatcher.pendingAskUserByDevice.get(a.deviceId), [{ chatId: 'c-ask-back', payload: shown.payload }]);

      const stranger = connection({ device: 'otherwindow' });
      use(stranger);
      dispatcher.replayPrompts(stranger);
      assert.deepStrictEqual(asked(stranger), [], 'another device\'s window gets nothing');

      const back = connection();
      use(back);
      await invoke(dispatcher, back, 2, 'chat:load');
      assert.deepStrictEqual(asked(back).map((f) => f.payload), [shown.payload], 'its first frame brings the prompt back');
      await invoke(dispatcher, back, 3, 'chat:load');
      assert.strictEqual(asked(back).length, 1, 'once');
      assert.strictEqual(dispatcher.pendingAskUserByDevice.has(a.deviceId), false);

      await dispatcher.handleFrame(back, { t: 'send', channel: 'agent:userResponse', args: [{ requestId: shown.payload.requestId, response: 'the north one' }] });
      await running;
      assert.deepStrictEqual(run.answers.get('c-ask-back'), { ok: true, response: 'the north one' });
    });

    it('a connection that replaces its own device\'s old one gets the prompt when the old one is cleaned up after', async () => {
      const run = asking();
      const { dispatcher, use, leave } = makeDispatcher(run);
      const a = connection();
      use(a);
      const running = invoke(dispatcher, a, 1, 'chat:sendMessage', { chatId: 'c-ask-replace', question: 'Which lot?' });
      const shown = await waitFor(() => asked(a)[0]);
      const back = connection();
      use(back);
      leave(a);
      a.markGone();
      await dispatcher.onDisconnect(a);
      assert.deepStrictEqual(asked(back).map((f) => f.payload), [shown.payload]);
      await dispatcher.handleFrame(back, { t: 'send', channel: 'agent:userResponse', args: [{ requestId: shown.payload.requestId, response: 'yes' }] });
      await running;
    });

    it('asked with the window away: it waits for the device, and a second drop keeps it', async () => {
      const run = asking();
      const { dispatcher, use, leave } = makeDispatcher(run);
      const a = connection();
      use(a);
      const release = {};
      const gate = new Promise((resolve) => { release.go = resolve; });
      let ctxRef = null;
      const later = makeDispatcher({
        overrides: { 'chat:sendMessage': async () => { await gate; const answer = await ctxRef.prompter.askUser({ question: 'Late one?' }); run.answers.set('late', answer); return { ok: true }; } },
        patchContext: (ctx) => { ctxRef = ctx; }
      });
      later.use(a);
      const running = invoke(later.dispatcher, a, 1, 'chat:sendMessage', { chatId: 'c-late', message: 'go' });
      a.markGone();
      await later.dispatcher.onDisconnect(a);
      later.leave(a);
      leave(a);
      release.go();
      await waitFor(() => later.dispatcher.pendingAskUserByDevice.get(a.deviceId));
      assert.deepStrictEqual(asked(a), [], 'the gone window is not written to');
      assert.strictEqual(later.dispatcher.pendingAskUserByDevice.get(a.deviceId)[0].chatId, 'c-late');

      const first = connection();
      later.use(first);
      await later.dispatcher.handleFrame(first, { t: 'call', id: 2, method: 'bridge.status', params: {} });
      assert.strictEqual(asked(first).length, 1);
      first.markGone();
      await later.dispatcher.onDisconnect(first);
      later.leave(first);

      const second = connection();
      later.use(second);
      later.dispatcher.replayPrompts(second);
      const shown = asked(second)[0];
      assert.ok(shown);
      await later.dispatcher.handleFrame(second, { t: 'send', channel: 'agent:userResponse', args: [{ requestId: shown.payload.requestId, response: 'yes' }] });
      await running;
      assert.deepStrictEqual(run.answers.get('late'), { ok: true, response: 'yes' });
    });

    it('with no return it times out at five minutes, and nothing is left behind', async (t) => {
      const run = asking();
      const { dispatcher, use, leave } = makeDispatcher(run);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const a = connection();
      use(a);
      const running = invoke(dispatcher, a, 1, 'chat:sendMessage', { chatId: 'c-ask-gone', question: 'Which lot?' });
      for (let i = 0; i < 20 && asked(a).length === 0; i += 1) await new Promise((r) => { setImmediate(r); });
      assert.strictEqual(asked(a).length, 1);
      a.markGone();
      await dispatcher.onDisconnect(a);
      leave(a);
      assert.strictEqual(dispatcher.pendingAskUserByDevice.get(a.deviceId).length, 1);
      t.mock.timers.tick(5 * 60 * 1000);
      await running;
      assert.deepStrictEqual(run.answers.get('c-ask-gone'), { ok: false, error: 'User did not respond within 5 minutes.' });
      assert.strictEqual(dispatcher.pendingAskUserByDevice.has(a.deviceId), false);
      const back = connection();
      use(back);
      dispatcher.replayPrompts(back);
      assert.deepStrictEqual(asked(back), [], 'an ended question does not come back');
    });

    it('a local window\'s pending ask ends on its drop, as stage 2 left it', async () => {
      const run = asking();
      const { dispatcher, use } = makeDispatcher(run);
      const b = connection({ remote: false, device: 'localwindow' });
      use(b);
      const running = invoke(dispatcher, b, 1, 'chat:sendMessage', { chatId: 'c-ask-local', question: 'Which lot?' });
      await waitFor(() => asked(b)[0]);
      b.markGone();
      await dispatcher.onDisconnect(b);
      await running;
      assert.deepStrictEqual(run.answers.get('c-ask-local'), { ok: false, error: 'The desktop disconnected.' });
    });
  });

  describe('requestDirectoryAccess', () => {
    const directoryRun = (results) => {
      let ctxRef = null;
      return {
        overrides: {
          'chat:sendMessage': async () => {
            results.push(await ctxRef.prompter.requestDirectoryAccess({ directory: 'C:\\example\\lot', toolName: 'Read' }));
            return { ok: true };
          }
        },
        patchContext: (ctx) => { ctxRef = ctx; }
      };
    };

    it('a remote run\'s requestDirectoryAccess asks the phone for AllowDirectory and is false with no phone', async () => {
      const results = [];
      const answers = [true, false];
      const phone = fakePhone(() => answers.shift());
      const { dispatcher, use } = makeDispatcher({ phone, ...directoryRun(results) });
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'chat:sendMessage', { chatId: 'c-dir', message: 'go' });
      await invoke(dispatcher, a, 2, 'chat:sendMessage', { chatId: 'c-dir', message: 'go' });
      assert.deepStrictEqual(results, [true, false]);
      assert.strictEqual(phone.calls[0].toolName, 'AllowDirectory');
      assert.deepStrictEqual(phone.calls[0].parameters, { directory: 'C:\\example\\lot', toolName: 'Read' });
      assert.strictEqual(phone.calls[0].metadata.origin.client, 'remote-window');
      assert.deepStrictEqual(asked(a, 'tool:directoryAccessRequired'), []);

      const noPhoneResults = [];
      const none = makeDispatcher({ phone: null, ...directoryRun(noPhoneResults) });
      none.use(a);
      await invoke(none.dispatcher, a, 3, 'chat:sendMessage', { chatId: 'c-dir', message: 'go' });
      assert.deepStrictEqual(noPhoneResults, [false]);

      const unavailable = [];
      const off = makeDispatcher({ phone: fakePhone(() => 'unavailable'), ...directoryRun(unavailable) });
      off.use(a);
      await invoke(off.dispatcher, a, 4, 'chat:sendMessage', { chatId: 'c-dir', message: 'go' });
      assert.deepStrictEqual(unavailable, [false]);
    });

    it('a local run keeps the on-screen question', async () => {
      const results = [];
      const { dispatcher, phone, use } = makeDispatcher({ ...directoryRun(results), hosting: 'personal' });
      const b = connection({ remote: false, device: 'localwindow' });
      use(b);
      const running = invoke(dispatcher, b, 1, 'chat:sendMessage', { chatId: 'c-dir-local', message: 'go' });
      await waitFor(() => asked(b, 'tool:directoryAccessRequired')[0]);
      assert.deepStrictEqual(phone.calls, []);
      b.markGone();
      await dispatcher.onDisconnect(b);
      await running;
      assert.deepStrictEqual(results, [false]);
    });
  });
});

describe('at most 8 asks in flight per device (R-RW-32)', () => {
  it('the ninth is refused before anyone is asked; another device has its own; an answer frees one', async () => {
    const held = [];
    const phone = fakePhone(() => new Promise((resolve) => { held.push(resolve); }));
    let runs = 0;
    const { dispatcher, use } = makeDispatcher({ phone, overrides: { 'chat:delete': async () => { runs += 1; return { ok: true }; } } });
    const a = connection();
    const other = connection({ device: 'otherwindow' });
    use(a, other);
    const going = [];
    for (let id = 1; id <= 8; id += 1) going.push(invoke(dispatcher, a, id, 'chat:delete', `c-${id}`));
    await waitFor(() => phone.calls.length === 8);
    await invoke(dispatcher, a, 9, 'chat:delete', 'c-9');
    assert.deepStrictEqual(resultFor(a, 9).value, { ok: false, code: 'PHONE_BUSY', error: MESSAGES.PHONE_BUSY });
    assert.strictEqual(phone.calls.length, 8);

    going.push(invoke(dispatcher, other, 1, 'chat:delete', 'c-other'));
    await waitFor(() => phone.calls.length === 9);

    held.shift()(false);
    await going[0];
    going.push(invoke(dispatcher, a, 10, 'chat:delete', 'c-10'));
    await waitFor(() => phone.calls.length === 10);
    for (const answer of held) answer(false);
    await Promise.all(going);
    assert.strictEqual(runs, 0);
  });

  it('a folder request takes a place too, and is false at the limit', async () => {
    const held = [];
    const phone = fakePhone(() => new Promise((resolve) => { held.push(resolve); }));
    let ctxRef = null;
    const results = [];
    const { dispatcher, use } = makeDispatcher({
      phone,
      overrides: {
        'chat:delete': async () => ({ ok: true }),
        'chat:sendMessage': async () => { results.push(await ctxRef.prompter.requestDirectoryAccess({ directory: 'C:\\example\\lot', toolName: 'Read' })); return { ok: true }; }
      },
      patchContext: (ctx) => { ctxRef = ctx; }
    });
    const a = connection();
    use(a);
    const going = [];
    for (let id = 1; id <= 8; id += 1) going.push(invoke(dispatcher, a, id, 'chat:delete', `c-${id}`));
    await waitFor(() => phone.calls.length === 8);
    await invoke(dispatcher, a, 9, 'chat:sendMessage', { chatId: 'c-dir-full', message: 'go' });
    assert.deepStrictEqual(results, [false]);
    assert.strictEqual(phone.calls.length, 8);
    for (const answer of held) answer(false);
    await Promise.all(going);
  });
});

describe('Stop while a turn waits on a remote question (a real run)', () => {
  const realRun = (id, message = 'go') => ({ t: 'invoke', id, channel: 'chat:sendMessage', args: [{ chatId: 'c-stop', message, agentMode: true }] });
  const running = async (dispatcher, conn, id) => {
    await invoke(dispatcher, conn, id, 'chat:running');
    return resultFor(conn, id).value.chatIds;
  };
  const settledSoon = (promise) => Promise.race([promise, new Promise((_, reject) => { setTimeout(() => reject(new Error('the run did not end')), 5000); })]);

  it('Stop ends a turn waiting on ask_user: the question is gone, the chat is idle, the next send runs', async () => {
    const chatId = 'c-stop';
    if (!core.context.getChat(chatId)) newChat(chatId);
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    const other = connection({ device: 'otherwindow', label: 'Desk at home' });
    use(a, other);
    script.push({ type: 'tool_use', toolName: 'AskUser', toolUseId: 'call_ask', parameters: { question: 'Which lot?' } });
    const first = dispatcher.handleFrame(a, realRun(1));
    const shown = await waitFor(() => asked(a)[0]);
    const line = other.sent.find((f) => f.channel === 'chat:questionWaiting');
    assert.deepStrictEqual(line.payload, { chatId, label: 'Field laptop' }, 'other windows are told who holds the question');
    assert.ok(!other.sent.some((f) => f.channel === 'agent:askUser'));
    assert.ok(!a.sent.some((f) => f.channel === 'chat:questionWaiting'));

    await invoke(dispatcher, a, 2, 'chat:stopResponse', { chatId });
    await settledSoon(first);
    assert.strictEqual(dispatcher.bridgeContext.pendingAskUserResolvers.has(shown.payload.requestId), false);
    assert.strictEqual(dispatcher.pendingAskUserByDevice.has(a.deviceId), false);
    assert.deepStrictEqual(await running(dispatcher, a, 3), []);

    await dispatcher.handleFrame(a, realRun(4, 'again'));
    assert.strictEqual(resultFor(a, 4).value.code, undefined);
    assert.strictEqual(resultFor(a, 4).value.ok, true);
  });

  it('Stop withdraws a folder card: the signal reaches the phone, and the turn ends', async () => {
    const chatId = 'c-stop';
    if (!core.context.getChat(chatId)) newChat(chatId);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-outside-'));
    const file = path.join(outside, 'a.txt');
    fs.writeFileSync(file, 'x');
    let withdrawn = false;
    const phone = fakePhone((tool, _params, metadata) => (tool !== 'AllowDirectory' ? true : new Promise((resolve) => {
      metadata.signal.addEventListener('abort', () => { withdrawn = true; resolve(false); }, { once: true });
    })));
    const { dispatcher, use } = makeDispatcher({ phone });
    const a = connection();
    use(a);
    const allowedBefore = core.context.getSettings().allowedDirectories;
    core.context.setSettings({ ...core.context.getSettings(), allowedDirectories: [dataDir] });
    script.push({ type: 'tool_use', toolName: 'Read', toolUseId: 'call_read', parameters: { file_path: file } });
    const first = dispatcher.handleFrame(a, { t: 'invoke', id: 1, channel: 'chat:sendMessage', args: [{ chatId, message: 'read it', agentMode: true }] });
    await waitFor(() => phone.calls.some((c) => c.toolName === 'AllowDirectory'));
    await invoke(dispatcher, a, 2, 'chat:stopResponse', { chatId });
    await settledSoon(first);
    assert.strictEqual(withdrawn, true);
    core.context.setSettings({ ...core.context.getSettings(), allowedDirectories: allowedBefore });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('the prompter takes a signal for the on-screen prompts too', async () => {
    const { createElectronPrompter } = require('../src/platform/electron-prompter');
    const asks = new Map();
    const dirs = new Map();
    const sent = [];
    const win = { isDestroyed: () => false, webContents: { send: (c, p) => sent.push([c, p]) } };
    const prompter = createElectronPrompter({ getWindow: () => win, pendingAskUserResolvers: asks, pendingDirectoryAccessResolvers: dirs });
    const stop = new AbortController();
    const ask = prompter.askUser({ question: 'Which?', signal: stop.signal });
    const dir = prompter.requestDirectoryAccess({ directory: 'C:\\example', toolName: 'Read', signal: stop.signal });
    assert.strictEqual(asks.size, 1);
    stop.abort();
    assert.deepStrictEqual(await ask, { ok: false, error: 'Stopped.' });
    assert.strictEqual(await dir, false);
    assert.strictEqual(asks.size, 0);
    assert.strictEqual(dirs.size, 0);
    assert.deepStrictEqual(await prompter.askUser({ question: 'Late?', signal: stop.signal }), { ok: false, error: 'Stopped.' });
    assert.strictEqual(await prompter.requestDirectoryAccess({ directory: 'C:\\example', toolName: 'Read', signal: stop.signal }), false);
    assert.strictEqual(sent.length, 2, 'an aborted run asks nothing more');
  });
});

describe('the two read channels', () => {
  it('chat:running lists the running chat', async () => {
    const { dispatcher, phone, use } = makeDispatcher();
    newChat('c-is-running');
    newChat('c-not-running');
    const realTask = core.context.isTaskChatRunning;
    core.context.isTaskChatRunning = (chatId) => chatId === 'c-is-running';
    const a = connection();
    use(a);
    await invoke(dispatcher, a, 1, 'chat:running');
    core.context.isTaskChatRunning = realTask;
    const { value } = resultFor(a, 1);
    assert.strictEqual(value.ok, true);
    assert.deepStrictEqual(value.chatIds, ['c-is-running']);
    assert.deepStrictEqual(phone.calls, []);
  });

  describe('chat:readScreenshot', () => {
    const name = `screenshot-${Date.now()}999.png`;
    const big = `screenshot-${Date.now()}998.png`;
    const dir = screenshotDir();
    const secret = path.join(os.tmpdir(), `kl-remote-secret-${process.pid}.png`);

    before(() => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), Buffer.from('png-bytes'));
      fs.writeFileSync(path.join(dir, big), Buffer.alloc(8 * 1024 * 1024 + 1));
      fs.writeFileSync(secret, 'not a screenshot');
    });
    after(() => {
      fs.rmSync(path.join(dir, name), { force: true });
      fs.rmSync(path.join(dir, big), { force: true });
      fs.rmSync(secret, { force: true });
    });

    const read = async (requested, id = 1) => {
      const { dispatcher, use } = makeDispatcher();
      const a = connection();
      use(a);
      await invoke(dispatcher, a, id, 'chat:readScreenshot', { path: requested });
      return resultFor(a, id).value;
    };
    const NOT = { ok: false, code: 'NOT_A_SCREENSHOT' };

    it('serves a file under the screenshot dir by its name, and asks nobody', async () => {
      const { dispatcher, phone, use } = makeDispatcher();
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'chat:readScreenshot', { path: name });
      const answer = resultFor(a, 1).value;
      assert.strictEqual(answer.ok, true);
      assert.strictEqual(answer.mime, 'image/png');
      assert.strictEqual(Buffer.from(answer.bytes, 'base64').toString(), 'png-bytes');
      assert.deepStrictEqual(phone.calls, []);
    });

    it('a full path is read for its base name only, from the screenshot dir', async () => {
      for (const form of [path.join(dir, name), `C:\\elsewhere\\${name}`, `/elsewhere/${name}`]) {
        const answer = await read(form);
        assert.strictEqual(answer.ok, true, form);
        assert.strictEqual(Buffer.from(answer.bytes, 'base64').toString(), 'png-bytes');
      }
    });

    it('refuses anything else', async () => {
      const relative = path.relative(dir, secret);
      for (const bad of [secret, relative, `..\\${path.basename(secret)}`, '../x.png', '..', '', 'screenshot-1.png.exe', 'screenshot-.png', 'SCREENSHOT-1.PNG', 'screenshot-1.png/', 'other.png', 'screenshot-1.jpg', 'screenshot-1000000000000.png', null, undefined, 7, {}, ['screenshot-1.png']]) {
        const answer = await read(bad);
        assert.strictEqual(answer.ok, false, String(bad));
        assert.strictEqual(answer.code, NOT.code, String(bad));
      }
    });

    it('refuses a file over 8 MiB', async () => {
      assert.strictEqual((await read(big)).code, NOT.code);
    });

    it('refuses a payload that is not an object', async () => {
      const { dispatcher, use } = makeDispatcher();
      const a = connection();
      use(a);
      await invoke(dispatcher, a, 1, 'chat:readScreenshot');
      await invoke(dispatcher, a, 2, 'chat:readScreenshot', 'screenshot-1.png');
      assert.strictEqual(resultFor(a, 1).value.code, NOT.code);
      assert.strictEqual(resultFor(a, 2).value.code, NOT.code);
    });

    it('refuses a link, even with a screenshot\'s name', { skip: process.platform === 'win32' ? 'needs a privilege the suite does not assume' : false }, async () => {
      const link = path.join(dir, `screenshot-${Date.now()}997.png`);
      fs.symlinkSync(secret, link);
      try {
        assert.strictEqual((await read(path.basename(link))).code, NOT.code);
      } finally {
        fs.rmSync(link, { force: true });
      }
    });
  });
});
