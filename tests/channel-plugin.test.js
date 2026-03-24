const { describe, it } = require('node:test');
const assert = require('node:assert');

const { ChannelPlugin, ChannelRegistry } = require('../src/channels/channel-plugin');

describe('ChannelPlugin base class', () => {
  it('stores id, label, capabilities', () => {
    const plugin = new ChannelPlugin({ id: 'test', label: 'Test', capabilities: ['send'] });
    assert.strictEqual(plugin.id, 'test');
    assert.strictEqual(plugin.label, 'Test');
    assert.deepStrictEqual(plugin.capabilities, ['send']);
  });

  it('throws on unimplemented required methods', async () => {
    const plugin = new ChannelPlugin({ id: 'test', label: 'Test' });
    await assert.rejects(() => plugin.initialize({}));
    await assert.rejects(() => plugin.shutdown());
    assert.throws(() => plugin.normalizeTarget('x'));
    await assert.rejects(() => plugin.send('x', 'msg'));
  });

  it('has default implementations for optional methods', async () => {
    const plugin = new ChannelPlugin({ id: 'test', label: 'Test' });
    const targets = await plugin.listTargets();
    assert.deepStrictEqual(targets, []);
    const groups = await plugin.listGroups();
    assert.deepStrictEqual(groups, []);
    assert.deepStrictEqual(plugin.getStatus(), { connected: false });
    assert.strictEqual(plugin.supportsGroups(), false);
    assert.strictEqual(plugin.getMentionPattern(), null);
  });
});

describe('ChannelRegistry', () => {
  it('registers and retrieves channels', () => {
    const registry = new ChannelRegistry();
    const plugin = new ChannelPlugin({ id: 'test', label: 'Test' });
    registry.register(plugin);
    assert.strictEqual(registry.get('test'), plugin);
  });

  it('lists all registered channels', () => {
    const registry = new ChannelRegistry();
    registry.register(new ChannelPlugin({ id: 'a', label: 'A' }));
    registry.register(new ChannelPlugin({ id: 'b', label: 'B' }));
    assert.strictEqual(registry.list().length, 2);
  });

  it('initializeAll handles individual failures gracefully', async () => {
    const registry = new ChannelRegistry();
    let initialized = false;
    class GoodPlugin extends ChannelPlugin {
      async initialize() { initialized = true; }
      async shutdown() {}
      normalizeTarget(t) { return t; }
      async send() {}
    }
    class BadPlugin extends ChannelPlugin {
      async initialize() { throw new Error('fail'); }
      async shutdown() {}
      normalizeTarget(t) { return t; }
      async send() {}
    }
    registry.register(new BadPlugin({ id: 'bad', label: 'Bad' }));
    registry.register(new GoodPlugin({ id: 'good', label: 'Good' }));
    await registry.initializeAll({});
    assert.ok(initialized, 'Good plugin should still initialize even if bad one fails');
  });
});
