const { describe, it } = require('node:test');
const assert = require('node:assert');
const DiscordChannel = require('../src/channels/discord-bridge');
const { ChannelPlugin } = require('../src/channels/channel-plugin');

describe('DiscordChannel', () => {
  const config = { token: 'mock-token' };

  it('extends ChannelPlugin', () => {
    const channel = new DiscordChannel(config);
    assert.ok(channel instanceof ChannelPlugin);
    assert.strictEqual(channel.id, 'discord');
  });

  it('normalizes DM target', () => {
    const channel = new DiscordChannel(config);
    const target1 = channel.normalizeTarget({ userId: '123' });
    const target2 = channel.normalizeTarget({ id: '123' });
    const target3 = channel.normalizeTarget({ channelId: '123' });
    assert.strictEqual(target1, '123');
    assert.strictEqual(target2, '123');
    assert.strictEqual(target3, '123');
  });

  it('supportsGroups returns true', () => {
    const channel = new DiscordChannel(config);
    assert.ok(channel.supportsGroups());
  });

  it('builds correct session key for DMs', () => {
    const key = DiscordChannel.buildSessionKey('123', null);
    assert.strictEqual(key, 'agent:main:discord:123');
  });

  it('builds correct session key for guild channels', () => {
    const key = DiscordChannel.buildSessionKey('123', { guildId: 'g1', channelId: 'c1' });
    assert.ok(key.includes('group'));
    assert.ok(key.includes('g1'));
  });

  it('splits long messages at 2000-char boundary', () => {
    const { splitMessage } = require('../src/channels/discord-adapter');
    const longMsg = 'x'.repeat(5000);
    const parts = splitMessage(longMsg, 2000);
    assert.ok(parts.length >= 3);
    parts.forEach(p => assert.ok(p.length <= 2000));
  });

  it('getMentionPattern returns regex', () => {
    const channel = new DiscordChannel(config);
    channel.botUserId = 'bot123';
    const pattern = channel.getMentionPattern();
    assert.ok(pattern instanceof RegExp || pattern === null);
  });

  it('respects requireMention setting in groups', () => {
    const { shouldRespond } = require('../src/channels/mention-gating');
    const result = shouldRespond({
      isGroup: true,
      requireMention: true,
      wasMentioned: false,
      isCommand: false,
      isReply: false
    });
    assert.ok(!result);
  });

  it('always responds to DMs', () => {
    const { shouldRespond } = require('../src/channels/mention-gating');
    const result = shouldRespond({
      isGroup: false,
      requireMention: true,
      wasMentioned: false,
      isCommand: false,
      isReply: false
    });
    assert.ok(result);
  });
});
