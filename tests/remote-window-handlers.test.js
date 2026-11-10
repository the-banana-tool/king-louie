// tests/remote-window-handlers.test.js
// What the node's own handlers do for a remote window's event (remote window
// plan R-RW-9, R-RW-11 to R-RW-13, and the audit round of Task 1): a local event
// is untouched by every one of them.
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
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry, initializeTools } = require('../src/tools');
const ToolExecutor = require('../src/execution/tool-executor');
const { markRemoteWindowEvent, markLocalDesktopEvent } = require('../src/core/origin');
const { registerHandlers } = require('../src/ipc/register');
const { listIpcChannels } = require('../src/ipc/channel-inventory');
const { registerSettingsHandlers } = require('../src/ipc/settings-handlers');
const { registerContactHandlers } = require('../src/ipc/contact-handlers');
const { registerSkillHandlers } = require('../src/ipc/skill-handlers');
const registerCheckpoint = require('../src/ipc/checkpoint-handlers');
const { REMOTE_CLASSES } = require('../src/desktop-bridge/remote-classes');
const { CaseRuntime } = require('../src/cases');
const { createCaseToolHandler, REMOTE_WINDOW_CHANNEL } = require('../src/mcp/case-tools');
const { chatHarness } = require('./helpers/chat-harness');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
initializeTools();
const DEVICE = 'kld-abcdefghijklmnop';
const remoteEvent = () => markRemoteWindowEvent({ sender: { send() {}, isDestroyed: () => false } }, { deviceId: DEVICE });
const localEvent = () => markLocalDesktopEvent({ sender: { send() {}, isDestroyed: () => false } }, { deviceId: DEVICE });
const dirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const recorder = () => {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn), removeHandler() {} };
};
after(() => { closeOpenHistoryStores(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('chat:addMessage from a remote window', () => {
  const harness = () => chatHarness({ provider: {} });
  const add = (h, event, payload) => {
    const ipc = recorder();
    require('../src/ipc/chat-handlers').registerChatHandlers(ipc, h.context);
    return ipc.handlers.get('chat:addMessage')(event, { chatId: h.chat.id, ...payload });
  };

  it('adds a user or an assistant row', async () => {
    for (const sender of ['user', 'assistant']) {
      const h = harness();
      const before = h.chat.messages.length;
      await add(h, remoteEvent(), { sender, text: 'A note for this chat' });
      assert.strictEqual(h.chat.messages.length, before + 1, sender);
      assert.strictEqual(h.chat.messages.at(-1).sender, sender);
    }
  });

  it('refuses any other sender and adds nothing', async () => {
    for (const sender of ['status', 'toolUse', 'toolResult', 'system', 'error', undefined]) {
      const h = harness();
      const before = h.chat.messages.length;
      const out = await add(h, remoteEvent(), { sender, text: 'x' });
      assert.deepStrictEqual([out.ok, out.code], [false, 'REMOTE_MESSAGE_REFUSED'], String(sender));
      assert.strictEqual(h.chat.messages.length, before);
    }
  });

  it('refuses free metadata and adds nothing', async () => {
    for (const extra of [{ question: { id: 'q-1' } }, { context: {} }, { author: 'client' }, { workflowScaffolding: true }, { meta: { action: 'convertToCase' } }]) {
      const h = harness();
      const before = h.chat.messages.length;
      const out = await add(h, remoteEvent(), { sender: 'user', text: 'x', ...extra });
      assert.deepStrictEqual([out.ok, out.code], [false, 'REMOTE_MESSAGE_REFUSED'], JSON.stringify(extra));
      assert.strictEqual(h.chat.messages.length, before);
    }
  });

  it('a local event keeps its senders and its metadata', async () => {
    const h = harness();
    await add(h, localEvent(), { sender: 'status', text: 'x', workflowScaffolding: true });
    assert.strictEqual(h.chat.messages.at(-1).sender, 'status');
    assert.strictEqual(h.chat.messages.at(-1).workflowScaffolding, true);
  });
});

describe('chat:sendMessage takes the sandbox from the chat for a remote event', () => {
  const sendWith = async ({ event, stored, payload }) => {
    const seen = [];
    const h = chatHarness({
      provider: { name: 'openai', sendMessage: async () => ({ text: 'ok', content: 'ok' }), sendMessageWithTools: async () => ({ text: 'ok', content: 'ok', toolCalls: [] }), streamMessage: async () => ({ text: 'ok', content: 'ok' }), streamMessageWithTools: async () => ({ text: 'ok', content: 'ok', toolCalls: [] }) },
      chat: { id: 'chat-1', title: 'Chat', messages: [], ...(stored === undefined ? {} : { sandboxMode: stored }) },
      overrides: {
        createToolExecutorWithApprovals: async (_event, _env, _req, options) => {
          seen.push(options.useSandbox);
          const EventEmitter = require('events');
          const executor = new EventEmitter();
          executor.allowedDirectories = [];
          executor.execute = async () => ({ ok: true });
          return executor;
        }
      }
    });
    if (event === 'remote') markRemoteWindowEvent(h.event, { deviceId: DEVICE });
    if (event === 'local') markLocalDesktopEvent(h.event, { deviceId: DEVICE });
    await h.send({ agentMode: true, ...payload });
    return seen[0];
  };

  it('a payload cannot turn the sandbox off', async () => {
    assert.strictEqual(await sendWith({ event: 'remote', stored: true, payload: { sandboxMode: false } }), true);
    assert.strictEqual(await sendWith({ event: 'remote', stored: undefined, payload: { sandboxMode: false } }), true, 'nothing stored is on');
  });

  it('a chat stored with it off runs off, whatever the payload says', async () => {
    assert.strictEqual(await sendWith({ event: 'remote', stored: false, payload: { sandboxMode: true } }), false);
    assert.strictEqual(await sendWith({ event: 'remote', stored: false, payload: {} }), false);
  });

  it('a local event still takes the payload', async () => {
    assert.strictEqual(await sendWith({ event: 'local', stored: true, payload: { sandboxMode: false } }), false);
    assert.strictEqual(await sendWith({ event: 'local', stored: false, payload: { sandboxMode: true } }), true);
  });
});

describe('settings for a remote event', () => {
  const settings = {
    webSearch: { provider: 'brave', brave: { apiKey: 'canary-web-key', extra: 1 }, tavily: { apiKey: 'canary-tavily-key' } },
    imageGeneration: { default: 'fal', fal: { apiKey: 'canary-image-key', model: 'm-1' } },
    mcpServers: {
      one: { command: 'node', args: ['server.js', '--token=canary-arg', '${vault:mcp.one}'], env: { TOKEN: 'canary-env', REF: '${vault:mcp.two}', MIXED: 'a${vault:mcp.two}', COUNT: 3 }, cwd: '/srv/one' }
    }
  };
  const handlers = () => {
    const ipc = recorder();
    registerSettingsHandlers(ipc, {
      safeStorage: { isEncryptionAvailable: () => true }, getApiTokens: () => ({}), getApiStatus: () => ({}), getSettings: () => settings,
      setSettings() {}, getUserProfile: () => ({}), getVoiceSettings: () => ({}), hasStoredElevenLabsToken: () => false, hasStoredTelegramToken: () => false,
      getTelegramBridge: () => null, listHookDefinitions: () => [], normalizeTemplateVariables: (v) => v, getMcpManager: () => null, providerLabels: {}
    });
    return ipc.handlers;
  };

  it('settings:mcpList keeps vault references and hides every other env value and arg', async () => {
    const out = await handlers().get('settings:mcpList')(remoteEvent());
    const server = out.servers[0];
    assert.deepStrictEqual(server.args, ['(hidden)', '(hidden)', '${vault:mcp.one}']);
    assert.deepStrictEqual(server.env, { TOKEN: '(hidden)', REF: '${vault:mcp.two}', MIXED: '(hidden)', COUNT: '(hidden)' });
    assert.strictEqual(server.command, 'node');
    assert.doesNotMatch(JSON.stringify(out), /canary/);
  });

  it('settings:mcpList is byte-identical for a local event and an unmarked one', async () => {
    const expected = JSON.stringify({ ok: true, servers: [{ name: 'one', command: 'node', args: settings.mcpServers.one.args, env: settings.mcpServers.one.env, cwd: '/srv/one', connected: false, tools: [] }] });
    for (const event of [localEvent(), {}]) assert.strictEqual(JSON.stringify(await handlers().get('settings:mcpList')(event)), expected);
  });

  it('settings:load strips webSearch and imageGeneration keys and keeps the rest', async () => {
    const reply = await handlers().get('settings:load')(remoteEvent());
    assert.strictEqual(reply.ok, true);
    assert.doesNotMatch(JSON.stringify(reply), /canary/);
    const out = reply.data;
    assert.strictEqual(out.webSearch.provider, 'brave');
    assert.strictEqual(out.webSearch.brave.extra, 1);
    assert.strictEqual(out.imageGeneration.fal.model, 'm-1');
    assert.ok(!('apiKey' in out.webSearch.brave));
    // The window is told a key exists, never what it is (settings redesign Task 10).
    assert.strictEqual(out.webSearch.brave.hasKey, true);
    assert.strictEqual(out.imageGeneration.fal.hasKey, true);
    assert.ok(!('hasKey' in out.webSearch), 'only a section that holds a key gets hasKey');
    assert.strictEqual(settings.webSearch.brave.apiKey, 'canary-web-key', 'the stored settings are untouched');
  });

  it('settings:load is unchanged for a local event', async () => {
    const { data } = await handlers().get('settings:load')(localEvent());
    assert.strictEqual(data.webSearch, settings.webSearch);
    assert.strictEqual(data.imageGeneration, settings.imageGeneration);
  });
});

describe('presence:heartbeat from a remote window', () => {
  it('is accepted and does not count', async () => {
    const beats = [];
    const ipc = recorder();
    registerContactHandlers(ipc, { getContact: () => ({ heartbeat: (p) => { beats.push(p); return { ok: true }; } }), getMainWindow: () => null });
    const out = await ipc.handlers.get('presence:heartbeat')(remoteEvent(), { focused: true, lastInputAt: new Date().toISOString() });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.counted, false);
    assert.deepStrictEqual(beats, [], 'the presence the ladder reads never heard it');
    await ipc.handlers.get('presence:heartbeat')(localEvent(), { focused: true });
    assert.strictEqual(beats.length, 1, 'a local desktop still counts');
  });
});

describe('skill:install from a remote window', () => {
  it('refuses a relative path', async () => {
    const ipc = recorder();
    registerSkillHandlers(ipc, {
      skillRegistry: { listSkills: () => [], getSkill: () => null, getPinnableSkills: () => [] },
      getSkillLoader: () => ({ skillsDirectory: '/fake/skills' })
    });
    for (const url of ['./evil', '../evil', '.\\\\evil', '~/evil']) {
      const out = await ipc.handlers.get('skill:install')(remoteEvent(), { url });
      assert.deepStrictEqual([out.ok, out.code], [false, 'RELATIVE_PATH'], url);
    }
  });
});

describe('checkpoints from a remote window', () => {
  const SHA = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const inside = path.resolve(os.tmpdir(), 'kl-allowed');
  const chatDir = path.resolve(os.tmpdir(), 'kl-chat-dir');
  const hostDir = path.resolve(os.tmpdir(), 'kl-host-dir');
  const outside = path.resolve(os.tmpdir(), 'kl-somewhere-else');
  const build = () => {
    const calls = [];
    const manager = {
      enabled: true,
      list: async (dir) => { calls.push(['list', dir]); return [{ id: SHA, message: 'turn', createdAt: 'x' }]; },
      changes: async (dir, id) => { calls.push(['changes', dir, id]); return [{ status: 'M', path: 'a.txt' }]; },
      restore: async (dir, id) => { calls.push(['restore', dir, id]); return { restoredTo: id }; }
    };
    const ipc = recorder();
    registerCheckpoint.registerCheckpointHandlers(ipc, {
      getCheckpointManager: () => manager, getWorkingDirectory: () => hostDir,
      getSettings: () => ({ allowedDirectories: [inside] }), listChats: () => [{ id: 'chat-1', workingDirectory: chatDir }]
    });
    return { calls, handlers: ipc.handlers };
  };

  it('checkpoint:list reads an allowed directory, a chat\'s, or the host\'s', async () => {
    for (const workingDirectory of [inside, path.join(inside, 'sub'), chatDir, undefined]) {
      const { handlers } = build();
      const out = await handlers.get('checkpoint:list')(remoteEvent(), { workingDirectory });
      assert.strictEqual(out.ok, true, String(workingDirectory));
    }
  });

  it('checkpoint:list refuses a directory outside them, without asking the manager', async () => {
    const { handlers, calls } = build();
    for (const workingDirectory of [outside, `${inside}-sibling`, path.join(inside, '..', 'kl-other'), '', 7]) {
      const out = await handlers.get('checkpoint:list')(remoteEvent(), { workingDirectory });
      if (workingDirectory === '') { assert.strictEqual(out.ok, true, 'nothing named is the host\'s directory'); continue; }
      assert.deepStrictEqual([out.ok, out.code], [false, 'REMOTE_PATH_REFUSED'], String(workingDirectory));
      assert.deepStrictEqual(out.checkpoints, []);
    }
    assert.ok(calls.every(([, dir]) => dir === hostDir));
  });

  it('checkpoint:changes refuses an id that is not a commit, so no git option gets through', async () => {
    const { handlers, calls } = build();
    for (const checkpointId of ['--output=planted', '--no-index', `${SHA}^`, 'HEAD', SHA.slice(0, 39), SHA.toUpperCase()]) {
      const out = await handlers.get('checkpoint:changes')(remoteEvent(), { workingDirectory: inside, checkpointId });
      assert.deepStrictEqual([out.ok, out.code], [false, 'CHECKPOINT_NOT_HERE'], checkpointId);
    }
    assert.deepStrictEqual(calls, []);
  });

  it('checkpoint:changes answers only for a checkpoint of that directory', async () => {
    const { handlers } = build();
    const mine = await handlers.get('checkpoint:changes')(remoteEvent(), { workingDirectory: inside, checkpointId: SHA });
    assert.deepStrictEqual(mine.changes, [{ status: 'M', path: 'a.txt' }]);
    const another = await handlers.get('checkpoint:changes')(remoteEvent(), { workingDirectory: inside, checkpointId: OTHER });
    assert.deepStrictEqual([another.ok, another.code, another.changes], [false, 'CHECKPOINT_NOT_HERE', []]);
    const away = await handlers.get('checkpoint:changes')(remoteEvent(), { workingDirectory: outside, checkpointId: SHA });
    assert.deepStrictEqual([away.ok, away.code], [false, 'REMOTE_PATH_REFUSED']);
  });

  it('checkpoint:restore, phone class, still takes only a commit id', async () => {
    const { handlers, calls } = build();
    const out = await handlers.get('checkpoint:restore')(remoteEvent(), { workingDirectory: inside, checkpointId: '--output=planted' });
    assert.deepStrictEqual([out.ok, out.code], [false, 'CHECKPOINT_NOT_HERE']);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual((await handlers.get('checkpoint:restore')(remoteEvent(), { workingDirectory: inside, checkpointId: SHA })).ok, true);
  });

  it('a local event keeps every form it had', async () => {
    const { handlers, calls } = build();
    assert.strictEqual((await handlers.get('checkpoint:list')(localEvent(), { workingDirectory: outside })).ok, true);
    assert.strictEqual((await handlers.get('checkpoint:changes')(localEvent(), { workingDirectory: outside, checkpointId: 'abc' })).ok, true);
    assert.deepStrictEqual(calls.map(([kind]) => kind), ['list', 'changes']);
  });
});

describe('a spoken answer from a remote turn', () => {
  const PROBE = 'KlRemoteOwnerProbe';
  before(() => {
    if (toolRegistry.get(PROBE)) return;
    toolRegistry.register(new Tool({ name: PROBE, description: 'Test-only.', parameters: { type: 'object', properties: {} }, requiresApproval: true, execute: async () => ({ ok: true }) }));
  });

  async function fixture() {
    const rt = new CaseRuntime({ root: tmp('kl-remote-cases-') });
    const lot = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    rt.store.updateMeta(lot.id, { status: 'active' });
    const ask = (record) => rt.createQuestion(lot.id, { kind: 'question', urgency: 'normal', payload: { type: 'ask' }, ...record }, { charge: false });
    const q = {
      photo: ask({ text: 'Which listing photo should lead?', options: [{ id: 'a', label: 'Lake view' }, { id: 'b', label: 'Road view' }] }),
      grant: ask({ text: 'Raise the usd budget?', payload: { type: 'budget-grant', mcpAnswerable: false } })
    };
    return { rt, lot, q, handler: createCaseToolHandler({ getRuntime: () => rt, channel: REMOTE_WINDOW_CHANNEL }) };
  }
  // The options a remote turn's executor gets: the seam's, and the turn's text.
  const executor = (handler, ownerTurnText, extra = {}) => new ToolExecutor({
    workingDirectory: tmp('kl-remote-cwd-'), requireApproval: true, useSandbox: false,
    denyAutoApproval: true, remoteWindowTurn: true, ownerTurnText,
    approvalRequester: async () => false,
    extraToolOptions: { caseManagement: handler, origin: { client: 'remote-window', deviceId: DEVICE, session: 'chat-1', job_id: null } },
    ...extra
  });

  it('is answered, with user provenance and the channel remote-window', async () => {
    const { rt, lot, q, handler } = await fixture();
    const out = await executor(handler, 'the lakeside one, go with Lake view please').execute('answer_question', { case: lot.id, question_id: q.photo.id, option_id: 'a', quote: 'go with Lake view' });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    const record = rt.questions(lot.id).get(q.photo.id);
    assert.strictEqual(record.answer.channel, 'remote-window');
    const fact = rt.ledger(lot.id).query({ provenance: 'user' }).find((f) => f.source && f.source.channel === 'remote-window');
    assert.ok(fact, 'a fact recorded on that channel');
    assert.strictEqual(fact.provenance, 'user');
  });

  it('a quote that is not in the typed words is refused', async () => {
    const { lot, q, handler } = await fixture();
    const out = await executor(handler, 'the road one I think').execute('answer_question', { case: lot.id, question_id: q.photo.id, option_id: 'a', quote: 'go with Lake view' });
    assert.deepStrictEqual([out.ok, out.code], [false, 'quote_not_found']);
  });

  it('a pressed question stays pressed', async () => {
    const { rt, lot, q, handler } = await fixture();
    const out = await executor(handler, 'yes raise the budget now').execute('answer_question', { case: lot.id, question_id: q.grant.id, text: 'yes raise it', quote: 'yes raise the budget' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(rt.questions(lot.id).get(q.grant.id).answer || null, null);
  });

  it('with no typed words it is not_owner, and a run without the host\'s mark is not_owner too', async () => {
    const { lot, q, handler } = await fixture();
    const args = { case: lot.id, question_id: q.photo.id, option_id: 'a', quote: 'go with Lake view' };
    const noText = await executor(handler, null).execute('answer_question', args);
    assert.deepStrictEqual([noText.success, noText.code], [false, 'not_owner']);
    const closed = await executor(handler, 'go with Lake view please', { remoteWindowTurn: false }).execute('answer_question', args);
    assert.deepStrictEqual([closed.success, closed.code], [false, 'not_owner']);
    const passed = await executor(handler, 'go with Lake view please', { remoteWindowTurn: 'yes' }).execute('answer_question', args);
    assert.deepStrictEqual([passed.success, passed.code], [false, 'not_owner'], 'only true opens it');
  });

  it('remote-window is no press and no document review', () => {
    const contact = fs.readFileSync(path.join(__dirname, '../src/cases/ingest/index.js'), 'utf8');
    assert.match(contact, /channel === 'remote-window'/);
  });

  it('a Brief criterion quoted from a remote turn records its channel', () => {
    const text = fs.readFileSync(path.join(__dirname, '../src/tools/builtin/case-tools.js'), 'utf8');
    assert.match(text, /channel: ctx\.ownerChannel \|\| 'in-app-chat'/);
  });

  describe('every lift stays closed', () => {
    const ask = () => { const asked = []; return { asked, approvalRequester: async (tool) => { asked.push(tool); return false; } }; };

    it('the always-approve list', async () => {
      const { asked, approvalRequester } = ask();
      let consulted = 0;
      const out = await executor(null, 'run the probe', { approvalRequester, shouldAutoApprove: async () => { consulted += 1; return true; } }).execute(PROBE, {});
      assert.strictEqual(consulted, 0);
      assert.deepStrictEqual(asked, [PROBE]);
      assert.strictEqual(out.success, false);
    });

    it('an allow rule', async () => {
      const { asked, approvalRequester } = ask();
      const out = await executor(null, 'run the probe', { approvalRequester, getPermissionRules: () => [{ tool: PROBE, pattern: '*', action: 'allow' }] }).execute(PROBE, {});
      assert.deepStrictEqual(asked, [PROBE]);
      assert.strictEqual(out.success, false);
    });

    it('autoApproveTools', async () => {
      const { asked, approvalRequester } = ask();
      const out = await executor(null, 'run the probe', { approvalRequester }).execute(PROBE, {}, { autoApproveTools: [PROBE] });
      assert.deepStrictEqual(asked, [PROBE]);
      assert.strictEqual(out.success, false);
    });

    it('ownerQuote on an acting browser call', async () => {
      const { asked, approvalRequester } = ask();
      const out = await executor(null, 'please click the buy button now', { approvalRequester }).execute('BrowserPage', { action: 'click', selector: '#buy', ownerQuote: 'click the buy button' });
      assert.deepStrictEqual(asked, ['BrowserPage'], 'the phone is asked, the quote lifts nothing');
      assert.strictEqual(out.success, false);
    });
  });
});

describe('a remote run on a real core', () => {
  const core = {};
  const asked = [];
  before(async () => {
    const dataDir = tmp('kl-remote-core-');
    core.core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: {
        chats: [], activeChatId: null,
        apiTokens: { openai: 'canary-provider-token' }, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} }
      } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals: 'phone',
      phoneApprover: { ttlMs: 1000, isAvailable: () => true, requestApproval: async (tool, _params, metadata) => { asked.push([tool, metadata.origin && metadata.origin.client]); return false; } }
    });
    await core.core.start();
    const { context } = core.core;
    context.setSettings({
      ...context.getSettings(),
      webSearch: { provider: 'brave', brave: { apiKey: 'canary-web-key' } },
      imageGeneration: { default: 'fal', fal: { apiKey: 'canary-image-key' } },
      mcpServers: { one: { command: 'node', args: ['--token=canary-arg'], env: { TOKEN: 'canary-env' } } }
    });
    // An unknown chat counts as private, which refuses the detached tools first.
    context.createChat({ id: 'chat-1', title: 'Chat', messages: [] });
  });
  after(async () => { await core.core.shutdown().catch(() => {}); closeOpenHistoryStores(); });

  it('a child inherits the remote origin: its calls reach the phone, and it may not start another', async () => {
    const parent = await core.core.context.createToolExecutorWithApprovals(remoteEvent(), null, null, { chatId: 'chat-1' });
    assert.strictEqual(parent.origin.client, 'remote-window');
    const requester = parent._rethreadedRequester();
    assert.strictEqual(requester.origin.client, 'remote-window');
    const child = await core.core.context.createToolExecutorWithApprovals(null, null, requester, { origin: requester.origin });
    assert.strictEqual(child.denyAutoApproval, true);
    asked.length = 0;
    await child.execute('Bash', { command: 'echo never' });
    await child.execute('SpawnAgent', { task: 'x' });
    assert.deepStrictEqual(asked, [['Bash', 'remote-window'], ['SpawnAgent', 'remote-window']]);
  });

  it('each tool that outlives the turn goes to the phone before it runs', async () => {
    const parent = await core.core.context.createToolExecutorWithApprovals(remoteEvent(), null, null, { chatId: 'chat-1' });
    for (const name of ['BackgroundTask', 'SpawnAgent', 'Cron', 'RemoteDispatch', 'TaskStatus', 'sessions_spawn', 'message']) {
      if (!toolRegistry.get(name)) continue;
      asked.length = 0;
      const out = await parent.execute(name, { action: { RemoteDispatch: 'dispatch', message: 'send' }[name] || 'list', peer: 'x', message: 'x', task: 'x', prompt: 'x', agentId: 'x', to: 'x', channel: 'x', text: 'x' });
      assert.deepStrictEqual(asked, [[name, 'remote-window']], `${name}: ${JSON.stringify(out)}`);
      assert.strictEqual(out.success, false, name);
    }
  });

  it('a spoken tool gets the remote channel, through the seam', async () => {
    const executor = await core.core.context.createToolExecutorWithApprovals(remoteEvent(), null, null, { chatId: 'chat-1', ownerTurnText: 'go with the lake view' });
    assert.strictEqual(executor.remoteWindowTurn, true);
    assert.strictEqual(executor.denyAutoApproval, true);
    assert.strictEqual(executor.extraToolOptions.caseManagement.channel, 'remote-window');
    const local = await core.core.context.createToolExecutorWithApprovals(localEvent(), null, null, { chatId: 'chat-1', ownerTurnText: 'go with the lake view' });
    assert.strictEqual(local.extraToolOptions.caseManagement.channel, 'in-app-chat');
  });

  it('no read reply carries an apiKey value, a provider token, a secret env or arg, or a stored skill setting', async () => {
    const SKILL_SECRET = 'canary-skill-setting';
    const context = core.core.context;
    context.skillRegistry.skills.set('kl-test-secret-skill', {
      id: 'kl-test-secret-skill', name: 'Secret skill', description: 'Test-only.', getMetadata: () => ({ id: 'kl-test-secret-skill', name: 'Secret skill', description: 'Test-only.' }), getCommands: () => [], getSettings: () => ({ token: SKILL_SECRET }), getSettingsSchema: () => [{ key: 'token', type: 'string' }], _enabled: true
    });
    const ipc = recorder();
    // The context a host hands the handlers: the core's, with its cipher's face.
    registerHandlers(ipc, { ...context, safeStorage: { isEncryptionAvailable: () => true } });
    // The seeds are really there: a local event reads them.
    const seeded = JSON.stringify([await ipc.handlers.get('settings:load')(localEvent()), await ipc.handlers.get('settings:mcpList')(localEvent()), await ipc.handlers.get('skill:listWithSettings')(localEvent())]);
    for (const canary of ['canary-web-key', 'canary-image-key', 'canary-env', 'canary-arg', SKILL_SECRET]) assert.ok(seeded.includes(canary), `${canary}: ${seeded.slice(0, 600)}`);
    const inventory = listIpcChannels();
    const readChannels = Object.entries(REMOTE_CLASSES).filter(([name, cls]) => cls === 'read' && [...inventory.handle, ...inventory.on].includes(name)).map(([name]) => name);
    assert.ok(readChannels.includes('settings:load') && readChannels.includes('settings:mcpList') && readChannels.includes('skill:list'));
    const ran = [];
    for (const channel of readChannels) {
      const handler = ipc.handlers.get(channel);
      if (!handler) continue;
      for (const args of [{ skillId: 'kl-test-secret-skill', chatId: 'chat-1' }]) {
        let reply;
        try {
          const timer = { id: null };
          reply = await Promise.race([handler(remoteEvent(), args), new Promise((resolve) => { timer.id = setTimeout(() => resolve('(timed out)'), 5000); })]);
          clearTimeout(timer.id);
        } catch (err) {
          reply = { threw: err.message };
        }
        ran.push(channel);
        assert.doesNotMatch(JSON.stringify(reply) || '', /canary/, channel);
      }
    }
    assert.ok(ran.length > 40, `the sweep ran ${ran.length} channels`);
    context.skillRegistry.skills.delete('kl-test-secret-skill');
  });
});
