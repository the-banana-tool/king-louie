// The IPC half of the channel configuration surface: the desktop owner must
// be able to see who was refused, allowlist them, and name the chat that
// channel approvals are sent to. Wave 3's rules must survive all of it.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const C = require('../src/ipc/constants');
const AllowlistManager = require('../src/channels/allowlist-manager');
const { registerChannelHandlers } = require('../src/ipc/channel-handlers');

function harness(initialSettings = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const storeData = {};
  const store = {
    get: (key, fallback) => (key in storeData ? storeData[key] : fallback),
    set: (key, value) => { storeData[key] = value; }
  };
  let settings = { ...initialSettings };
  const allowlistManager = new AllowlistManager(store);

  registerChannelHandlers(ipcMain, {
    getStore: () => store,
    getAllowlistManager: () => allowlistManager,
    getSettings: () => settings,
    setSettings: (next) => { settings = next; }
  });

  return {
    allowlistManager,
    storeData,
    getSettings: () => settings,
    invoke: (channel, payload) => handlers.get(channel)({}, payload),
    handlers
  };
}

describe('channel IPC handlers — allowlist', () => {
  let h;
  beforeEach(() => { h = harness(); });

  it('registers every channel constant', () => {
    for (const key of ['CHANNEL_ACCESS_GET', 'CHANNEL_ACCESS_ALLOW', 'CHANNEL_ACCESS_REMOVE', 'CHANNEL_SET_APPROVAL_TARGET']) {
      assert.ok(C[key], `missing IPC constant ${key}`);
      assert.ok(h.handlers.has(C[key]), `no handler for ${key}`);
    }
  });

  it('reports an unconfigured channel as denying everyone', async () => {
    const res = await h.invoke(C.CHANNEL_ACCESS_GET, { channel: 'telegram' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.defaultPolicy, 'deny');
    assert.deepStrictEqual(res.data.users, []);
    assert.deepStrictEqual(res.data.groups, []);
    assert.strictEqual(res.data.approvalChatId, '');
  });

  it('adds and removes a user id', async () => {
    const added = await h.invoke(C.CHANNEL_ACCESS_ALLOW, { channel: 'telegram', kind: 'user', id: ' 4242 ' });
    assert.deepStrictEqual(added.data.users, ['4242']);
    assert.strictEqual(h.allowlistManager.isAllowed('telegram', '4242', null), true);

    const removed = await h.invoke(C.CHANNEL_ACCESS_REMOVE, { channel: 'telegram', kind: 'user', id: '4242' });
    assert.deepStrictEqual(removed.data.users, []);
    assert.strictEqual(h.allowlistManager.isAllowed('telegram', '4242', null), false);
  });

  it('adds and removes a group id', async () => {
    const added = await h.invoke(C.CHANNEL_ACCESS_ALLOW, { channel: 'discord', kind: 'group', id: 'chan-9' });
    assert.deepStrictEqual(added.data.groups, ['chan-9']);
    const removed = await h.invoke(C.CHANNEL_ACCESS_REMOVE, { channel: 'discord', kind: 'group', id: 'chan-9' });
    assert.deepStrictEqual(removed.data.groups, []);
  });

  it('surfaces a refused sender and clears it once allowed', async () => {
    h.allowlistManager.isAllowed('telegram', '99', null);
    const before = await h.invoke(C.CHANNEL_ACCESS_GET, { channel: 'telegram' });
    assert.strictEqual(before.data.recentRefusals.length, 1);
    assert.strictEqual(before.data.recentRefusals[0].senderId, '99');

    const after = await h.invoke(C.CHANNEL_ACCESS_ALLOW, { channel: 'telegram', kind: 'user', id: '99' });
    assert.deepStrictEqual(after.data.recentRefusals, []);
  });

  it('refuses an unknown channel', async () => {
    const res = await h.invoke(C.CHANNEL_ACCESS_GET, { channel: 'irc' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Unknown channel "irc"/);
  });

  it('refuses an empty or missing id', async () => {
    for (const id of ['', '   ', undefined, null]) {
      const res = await h.invoke(C.CHANNEL_ACCESS_ALLOW, { channel: 'telegram', kind: 'user', id });
      assert.strictEqual(res.ok, false, `id ${JSON.stringify(id)} should be refused`);
      assert.match(res.error, /id is required/);
    }
  });

  it('refuses an unknown kind', async () => {
    const res = await h.invoke(C.CHANNEL_ACCESS_ALLOW, { channel: 'telegram', kind: 'admin', id: '1' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /kind must be "user" or "group"/);
  });

  it('offers no way to re-open the channel to everyone', async () => {
    // Wave 3's fix. Nothing the renderer can send may set default: allow.
    await h.invoke(C.CHANNEL_ACCESS_ALLOW, { channel: 'telegram', kind: 'user', id: '1', default: 'allow' });
    await h.invoke(C.CHANNEL_ACCESS_ALLOW, { channel: 'telegram', kind: 'user', id: '2', defaultPolicy: 'allow' });
    assert.strictEqual(h.allowlistManager.getPolicy('telegram').default, 'deny');
    assert.strictEqual(h.allowlistManager.isAllowed('telegram', 'a-stranger', null), false);
  });
});

describe('channel IPC handlers — approval target', () => {
  it('stores the approval chat id under the channel settings the bridge reads', async () => {
    const h = harness();
    const res = await h.invoke(C.CHANNEL_SET_APPROVAL_TARGET, { channel: 'telegram', approvalChatId: ' 555 ' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.approvalChatId, '555');
    // src/channels/telegram-bridge.js reads getChannelSettings().approvalChatId
    assert.strictEqual(h.getSettings().channels.telegram.approvalChatId, '555');
  });

  it('keeps the rest of the channel settings intact', async () => {
    const h = harness({ channels: { telegram: { requireMention: true }, discord: { requireMention: false } } });
    await h.invoke(C.CHANNEL_SET_APPROVAL_TARGET, { channel: 'telegram', approvalChatId: '7' });
    const s = h.getSettings();
    assert.strictEqual(s.channels.telegram.requireMention, true);
    assert.strictEqual(s.channels.discord.requireMention, false);
  });

  it('clears the target with an empty value, which means approvals are denied again', async () => {
    const h = harness({ channels: { telegram: { approvalChatId: '555' } } });
    const res = await h.invoke(C.CHANNEL_SET_APPROVAL_TARGET, { channel: 'telegram', approvalChatId: '' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.approvalChatId, '');
    assert.strictEqual(h.getSettings().channels.telegram.approvalChatId, '');
  });

  it('refuses an unknown channel', async () => {
    const h = harness();
    const res = await h.invoke(C.CHANNEL_SET_APPROVAL_TARGET, { channel: 'irc', approvalChatId: '1' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Unknown channel "irc"/);
  });

  it('reports the configured target back through the get handler', async () => {
    const h = harness({ channels: { discord: { approvalChatId: 'owner-chan' } } });
    const res = await h.invoke(C.CHANNEL_ACCESS_GET, { channel: 'discord' });
    assert.strictEqual(res.data.approvalChatId, 'owner-chan');
  });

  it('falls back to an allowlist manager built from the store when the core exposes none', async () => {
    // Older context shapes only carry getStore(); the handler must still work.
    const handlers = new Map();
    const data = {};
    const store = { get: (k, f) => (k in data ? data[k] : f), set: (k, v) => { data[k] = v; } };
    let settings = {};
    registerChannelHandlers({ handle: (c, fn) => handlers.set(c, fn) }, {
      getStore: () => store,
      getSettings: () => settings,
      setSettings: (n) => { settings = n; }
    });
    const res = await handlers.get(C.CHANNEL_ACCESS_ALLOW)({}, { channel: 'telegram', kind: 'user', id: '5' });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(data.channelAllowlists.telegram.users, ['5']);
  });
});
