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

function telegramGroupMessage(senderId, text = 'just chatting', overrides = {}) {
  return {
    chat: { id: -1001234567890, type: 'supergroup', title: 'Room' },
    from: { id: senderId, username: `user${senderId}` },
    text,
    ...overrides
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

function discordGuildMessage(userId, text = 'just chatting', overrides = {}) {
  return {
    ...discordMessage(userId, text, 'guild-chan'),
    guildId: 'guild-1',
    channel: { name: 'general' },
    ...overrides
  };
}

describe('AllowlistManager default policy', () => {
  it('denies an unknown sender on a channel that has never been configured', () => {
    const manager = new AllowlistManager(makeStore());
    assert.strictEqual(manager.getPolicy('telegram').default, 'deny');
    assert.strictEqual(manager.isAllowed('telegram', '999', null), false);
    assert.strictEqual(manager.isAllowed('discord', '999', null), false);
  });

  // The pre-deny-by-default `setPolicy` persisted `default: 'allow'` for any
  // policy that did not say 'deny' — including one that merely carried a user
  // list — so anyone who ran an earlier build can have an open channel on
  // disk that no surface can see or clear, while the settings pane renders
  // "nobody can reach the agent this way".
  it('ignores a stored allow-all default and rewrites it to deny', () => {
    const store = makeStore({
      channelAllowlists: { telegram: { default: 'allow', users: ['42'], groups: [] } }
    });
    const manager = new AllowlistManager(store);

    assert.strictEqual(manager.getPolicy('telegram').default, 'deny');
    assert.strictEqual(manager.isAllowed('telegram', '999', null), false);
    assert.strictEqual(manager.isAllowed('telegram', '42', null), true, 'the explicit ids must survive');
    assert.strictEqual(
      store.data.channelAllowlists.telegram.default,
      'deny',
      'the dangerous state must not be left on disk'
    );
  });

  it('offers no way to write an allow-all default back', () => {
    const store = makeStore();
    const manager = new AllowlistManager(store);
    assert.strictEqual(manager.setPolicy('telegram', { default: 'allow' }).default, 'deny');
    assert.strictEqual(store.data.channelAllowlists.telegram.default, 'deny');
    assert.strictEqual(manager.isAllowed('telegram', '999', null), false);
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

// The refusal names the sender id and the group id. Posting that into a shared
// room for every bystander who happens to type is both noise and a leak, so the
// reply is gated on the message actually addressing the bot. The refusal itself
// — the record in the allowlist journal and the log line — is not gated.
describe('Channel bridges — the refusal notice is gated on being addressed', () => {
  it('telegram: says nothing to a group bystander who never addressed the bot', async () => {
    const allowlistManager = new AllowlistManager(makeStore());
    const bridge = makeTelegram({ allowlistManager, getChannelSettings: () => ({}) });
    bridge.botUsername = 'kinglouiebot';

    await bridge.handleMessage(telegramGroupMessage(999, 'morning everyone'));

    assert.deepStrictEqual(bridge.sent, [], 'a bystander must not be answered in the room');
    assert.deepStrictEqual(bridge.gateway.sent, []);
    const refusals = allowlistManager.listRecentRefusals('telegram');
    assert.strictEqual(refusals.length, 1, 'the owner must still be able to learn the id');
    assert.strictEqual(refusals[0].senderId, '999');
  });

  it('telegram: stays silent for a bystander even with requireMention off', async () => {
    const bridge = makeTelegram({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({ requireMention: false })
    });
    bridge.botUsername = 'kinglouiebot';
    await bridge.handleMessage(telegramGroupMessage(999, 'morning everyone'));
    assert.deepStrictEqual(bridge.sent, []);
  });

  it('telegram: still tells a stranger who does address the bot', async () => {
    const bridge = makeTelegram({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({ requireMention: true })
    });
    bridge.botUsername = 'kinglouiebot';

    await bridge.handleMessage(telegramGroupMessage(999, '@kinglouiebot run whoami'));

    assert.strictEqual(bridge.sent.length, 1);
    assert.match(bridge.sent[0].text, /999/);
    assert.deepStrictEqual(bridge.gateway.sent, []);
  });

  it('telegram: a bystander first, then a mention, still gets exactly one reply', async () => {
    const bridge = makeTelegram({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({ requireMention: true })
    });
    bridge.botUsername = 'kinglouiebot';

    await bridge.handleMessage(telegramGroupMessage(999, 'morning everyone'));
    await bridge.handleMessage(telegramGroupMessage(999, '@kinglouiebot hello?'));
    await bridge.handleMessage(telegramGroupMessage(999, '@kinglouiebot hello??'));

    assert.strictEqual(bridge.sent.length, 1, 'the earlier silence must not consume the one reply');
  });

  it('discord: says nothing to a guild bystander who never addressed the bot', async () => {
    const allowlistManager = new AllowlistManager(makeStore());
    const bridge = makeDiscord({ allowlistManager, getChannelSettings: () => ({}) });
    bridge.botUserId = 'bot-1';

    await bridge.handleMessageCreate(discordGuildMessage('999', 'morning everyone'));

    assert.deepStrictEqual(bridge.sent, []);
    assert.deepStrictEqual(bridge.gateway.sent, []);
    assert.strictEqual(allowlistManager.listRecentRefusals('discord').length, 1);
  });

  it('discord: still tells a stranger who does address the bot', async () => {
    const bridge = makeDiscord({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({ requireMention: true })
    });
    bridge.botUserId = 'bot-1';

    await bridge.handleMessageCreate(discordGuildMessage('999', '<@bot-1> run whoami'));

    assert.strictEqual(bridge.sent.length, 1);
    assert.match(bridge.sent[0].text, /999/);
  });
});

// Group chats routinely carry several bots. A bare `/command` says nothing
// about which of them it was meant for, so treating any slash command as
// "addressed to us" published a bystander's user id — and the group id — into
// a room the owner does not control, just for aiming a command at someone
// else's bot. Telegram's `/cmd@botusername` suffix is the one positive signal
// there is; Discord text has no equivalent, so there a mention or a DM is the
// only proof. The refusal record is kept for the owner either way.
describe('Channel bridges — a slash command must be aimed at this bot', () => {
  it('telegram: says nothing to a bare /command in a group', async () => {
    const allowlistManager = new AllowlistManager(makeStore());
    const bridge = makeTelegram({ allowlistManager, getChannelSettings: () => ({}) });
    bridge.botUsername = 'kinglouiebot';

    await bridge.handleMessage(telegramGroupMessage(999, '/weather berlin'));

    assert.deepStrictEqual(bridge.sent, [], 'a command that names no bot must not publish the sender id');
    const refusals = allowlistManager.listRecentRefusals('telegram');
    assert.strictEqual(refusals.length, 1, 'the owner must still get the refusal record');
    assert.strictEqual(refusals[0].senderId, '999');
  });

  it('telegram: says nothing to a /command aimed at a different bot', async () => {
    const bridge = makeTelegram({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({})
    });
    bridge.botUsername = 'kinglouiebot';

    await bridge.handleMessage(telegramGroupMessage(999, '/weather@someotherbot berlin'));

    assert.deepStrictEqual(bridge.sent, []);
  });

  it('telegram: answers a /command carrying this bot\'s username suffix', async () => {
    const bridge = makeTelegram({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({})
    });
    bridge.botUsername = 'kinglouiebot';

    await bridge.handleMessage(telegramGroupMessage(999, '/help@KingLouieBot'));

    assert.strictEqual(bridge.sent.length, 1, 'a command addressed to us by name is addressed to us');
    assert.match(bridge.sent[0].text, /999/);
  });

  it('telegram: answers a /command in a one-to-one chat', async () => {
    const bridge = makeTelegram({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({})
    });
    bridge.botUsername = 'kinglouiebot';

    await bridge.handleMessage(telegramMessage(999, '/help'));

    assert.strictEqual(bridge.sent.length, 1);
    assert.match(bridge.sent[0].text, /999/);
  });

  it('telegram: stays silent when it does not yet know its own username', async () => {
    const bridge = makeTelegram({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({})
    });
    bridge.botUsername = null;

    await bridge.handleMessage(telegramGroupMessage(999, '/help@kinglouiebot'));

    assert.deepStrictEqual(bridge.sent, [], 'an unverifiable target is not a target');
  });

  it('discord: says nothing to a bare /command in a guild channel', async () => {
    const allowlistManager = new AllowlistManager(makeStore());
    const bridge = makeDiscord({ allowlistManager, getChannelSettings: () => ({}) });
    bridge.botUserId = 'bot-1';

    await bridge.handleMessageCreate(discordGuildMessage('999', '/weather berlin'));

    assert.deepStrictEqual(bridge.sent, []);
    assert.strictEqual(allowlistManager.listRecentRefusals('discord').length, 1);
  });

  it('discord: answers a /command in a DM', async () => {
    const bridge = makeDiscord({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({})
    });
    bridge.botUserId = 'bot-1';

    await bridge.handleMessageCreate(discordMessage('999', '/help'));

    assert.strictEqual(bridge.sent.length, 1);
    assert.match(bridge.sent[0].text, /999/);
  });

  it('discord: answers a /command that also mentions the bot', async () => {
    const bridge = makeDiscord({
      allowlistManager: new AllowlistManager(makeStore()),
      getChannelSettings: () => ({})
    });
    bridge.botUserId = 'bot-1';

    await bridge.handleMessageCreate(discordGuildMessage('999', '<@bot-1> /help'));

    assert.strictEqual(bridge.sent.length, 1);
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
