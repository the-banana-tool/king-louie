const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const AllowlistManager = require('../src/channels/allowlist-manager');
const TelegramBridge = require('../src/channels/telegram-bridge');
const DiscordChannel = require('../src/channels/discord-bridge');

// An approval that is never answered stays pending for two minutes; race it so a
// regression reports as a failed assertion instead of a hung test file.
function settled(promise, ms = 400) {
  return Promise.race([
    promise,
    new Promise((resolve) => { setTimeout(() => resolve('PENDING'), ms).unref?.(); })
  ]);
}

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (key, fallback) => (key in data ? data[key] : fallback),
    set: (key, value) => { data[key] = value; }
  };
}

function makeSessionManager() {
  return {
    buildSessionKey: (agentId, channel, chatId) => `agent:${agentId}:${channel}:${chatId}`,
    getOrCreateSession: (key) => ({ key }),
    addMessage: () => {},
    listSessions: () => [],
    clearSession: () => false
  };
}

function makeGateway() {
  const gw = new EventEmitter();
  gw.sent = [];
  gw.sendToAgent = async (agentId, sessionKey, message) => {
    gw.sent.push({ agentId, sessionKey, message });
  };
  return gw;
}

function makeTelegram(options = {}) {
  const bridge = new TelegramBridge({
    token: 'test-token',
    gatewayServer: makeGateway(),
    sessionManager: makeSessionManager(),
    ...options
  });
  bridge.sent = [];
  bridge.sendMessage = async (chatId, text, extra = {}) => {
    bridge.sent.push({ chatId: String(chatId), text: String(text), extra });
    return { message_id: bridge.sent.length };
  };
  bridge.answerCallbackQuery = async () => {};
  return bridge;
}

function telegramMessage(senderId, text = 'hello', chatId = senderId) {
  return {
    chat: { id: chatId, type: 'private' },
    from: { id: senderId, username: `user${senderId}` },
    text
  };
}

function makeDiscord(options = {}) {
  const bridge = new DiscordChannel({
    token: 'test-token',
    gatewayServer: makeGateway(),
    sessionManager: makeSessionManager(),
    ...options
  });
  bridge.sent = [];
  bridge.sendMessage = async (chatId, text, extra = {}) => {
    bridge.sent.push({ chatId: String(chatId), text: String(text), extra });
    return { id: bridge.sent.length };
  };
  return bridge;
}

function discordMessage(userId, text = 'hello', channelId = `dm-${userId}`) {
  return {
    author: { id: String(userId), username: `user${userId}`, bot: false },
    content: text,
    guildId: null,
    channelId: String(channelId),
    channel: { name: '' },
    reference: null,
    mentions: { users: [], has: () => false },
    attachments: { forEach: () => {} },
    thread: null
  };
}

describe('AllowlistManager default policy', () => {
  it('denies an unknown sender on a channel that has never been configured', () => {
    const manager = new AllowlistManager(makeStore());
    assert.strictEqual(manager.getPolicy('telegram').default, 'deny');
    assert.strictEqual(manager.isAllowed('telegram', '999', null), false);
    assert.strictEqual(manager.isAllowed('discord', '999', null), false);
  });

  it('still honours an explicit allow-all policy the owner wrote', () => {
    const manager = new AllowlistManager(makeStore({
      channelAllowlists: { telegram: { default: 'allow', users: [], groups: [] } }
    }));
    assert.strictEqual(manager.isAllowed('telegram', '999', null), true);
  });

  it('setPolicy does not silently widen a policy with no explicit default', () => {
    const manager = new AllowlistManager(makeStore());
    const policy = manager.setPolicy('telegram', { users: ['1'] });
    assert.strictEqual(policy.default, 'deny');
    assert.strictEqual(manager.isAllowed('telegram', '1', null), true);
    assert.strictEqual(manager.isAllowed('telegram', '2', null), false);
  });

  it('addUser on a fresh channel admits that user and nobody else', () => {
    const manager = new AllowlistManager(makeStore());
    manager.addUser('telegram', '42');
    assert.strictEqual(manager.isAllowed('telegram', '42', null), true);
    assert.strictEqual(manager.isAllowed('telegram', '43', null), false);
  });
});

describe('Telegram bridge — unknown senders', () => {
  it('does not route an unknown sender to the agent', async () => {
    const bridge = makeTelegram({ allowlistManager: new AllowlistManager(makeStore()) });
    await bridge.handleMessage(telegramMessage(999, 'run whoami'));
    assert.deepStrictEqual(bridge.gateway.sent, []);
  });

  it('replies exactly once, with the sender id, however many messages arrive', async () => {
    const bridge = makeTelegram({ allowlistManager: new AllowlistManager(makeStore()) });
    for (let i = 0; i < 25; i += 1) {
      await bridge.handleMessage(telegramMessage(999, `probe ${i}`));
    }
    assert.strictEqual(bridge.sent.length, 1, 'an unknown sender must not be able to pump replies');
    assert.match(bridge.sent[0].text, /999/);
  });

  it('bounds the notified-sender set so a flood of new ids cannot grow it forever', async () => {
    const bridge = makeTelegram({ allowlistManager: new AllowlistManager(makeStore()) });
    for (let i = 0; i < 600; i += 1) {
      await bridge.handleMessage(telegramMessage(10000 + i, 'hi'));
    }
    assert.ok(bridge.unknownSenderNotified.size <= 256, `set grew to ${bridge.unknownSenderNotified.size}`);
  });

  it('routes an allowlisted sender normally', async () => {
    const allowlistManager = new AllowlistManager(makeStore());
    allowlistManager.addUser('telegram', '42');
    const bridge = makeTelegram({ allowlistManager });
    await bridge.handleMessage(telegramMessage(42, 'hello'));
    assert.strictEqual(bridge.gateway.sent.length, 1);
  });
});

describe('Telegram bridge — approval routing', () => {
  it('never sends the approval prompt to the chat that originated the request', async () => {
    const bridge = makeTelegram({ getChannelSettings: () => ({}) });
    const approved = await settled(bridge.createApprovalHandler('999')({ toolName: 'Bash', parameters: { command: 'id' } }));
    assert.strictEqual(approved, false, 'with no owner surface the approval must be denied');
    assert.deepStrictEqual(bridge.sent, [], 'nothing may be sent to the requester');
    assert.strictEqual(bridge.pendingApprovals.size, 0);
  });

  it('denies rather than self-approving when the owner surface is the requester', async () => {
    const bridge = makeTelegram({ getChannelSettings: () => ({ approvalChatId: '999' }) });
    const approved = await settled(bridge.createApprovalHandler('999')({ toolName: 'Bash', parameters: {} }));
    assert.strictEqual(approved, false);
    assert.deepStrictEqual(bridge.sent, []);
  });

  it('sends the prompt to the owner chat and accepts only the owner callback', async () => {
    const bridge = makeTelegram({ getChannelSettings: () => ({ approvalChatId: '42' }) });
    const pending = bridge.createApprovalHandler('999')({ toolName: 'Bash', parameters: {} });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(bridge.sent.length, 1);
    assert.strictEqual(bridge.sent[0].chatId, '42');
    const callbackData = bridge.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;

    // The requester tries to press the owner's Approve button.
    await bridge.handleCallbackQuery({ id: 'cb1', data: callbackData, message: { chat: { id: 999 } } });
    assert.strictEqual(bridge.pendingApprovals.size, 1, 'the requester must not resolve the approval');

    await bridge.handleCallbackQuery({ id: 'cb2', data: callbackData, message: { chat: { id: 42 } } });
    assert.strictEqual(await settled(pending), true);
  });
});

describe('Discord bridge — unknown senders and approval routing', () => {
  it('does not route an unknown sender and replies once with their id', async () => {
    const bridge = makeDiscord({ allowlistManager: new AllowlistManager(makeStore()) });
    await bridge.handleMessageCreate(discordMessage('999', 'run whoami'));
    await bridge.handleMessageCreate(discordMessage('999', 'again'));
    assert.deepStrictEqual(bridge.gateway.sent, []);
    assert.strictEqual(bridge.sent.length, 1);
    assert.match(bridge.sent[0].text, /999/);
  });

  it('never sends the approval prompt back to the requesting channel', async () => {
    const bridge = makeDiscord({ getChannelSettings: () => ({}) });
    const approved = await settled(bridge.createApprovalHandler('chan-1')({ toolName: 'Bash', parameters: {} }));
    assert.strictEqual(approved, false);
    assert.deepStrictEqual(bridge.sent, []);
    assert.strictEqual(bridge.pendingApprovals.size, 0);
  });

  it('sends the prompt to the owner channel and rejects an interaction from elsewhere', async () => {
    const bridge = makeDiscord({ getChannelSettings: () => ({ approvalChatId: 'owner-chan' }) });
    const pending = bridge.createApprovalHandler('chan-1')({ toolName: 'Bash', parameters: {} });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(bridge.sent.length, 1);
    assert.strictEqual(bridge.sent[0].chatId, 'owner-chan');
    const approvalId = [...bridge.pendingApprovals.keys()][0];

    const replies = [];
    const interaction = (channelId, suffix) => ({
      isButton: () => true,
      customId: `kl_a_${approvalId}_${suffix}`,
      channelId,
      reply: async (payload) => { replies.push(payload); }
    });

    await bridge.handleInteractionCreate(interaction('chan-1', 'y'));
    assert.strictEqual(bridge.pendingApprovals.size, 1, 'the requester must not resolve the approval');

    await bridge.handleInteractionCreate(interaction('owner-chan', 'y'));
    assert.strictEqual(await settled(pending), true);
  });
});
