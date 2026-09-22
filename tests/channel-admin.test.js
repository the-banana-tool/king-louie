// The management surface for the security fixes that landed in wave 3:
// an unconfigured chat channel denies every sender, and a channel approval
// goes only to an explicitly configured owner target. Both are correct and
// both need a way in, or the owner's own messages stay refused.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const AllowlistManager = require('../src/channels/allowlist-manager');

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (key, fallback) => (key in data ? data[key] : fallback),
    set: (key, value) => { data[key] = value; },
    _data: data
  };
}

describe('AllowlistManager recent refusals', () => {
  it('records a refused sender so the owner can see who to add', () => {
    const manager = new AllowlistManager(makeStore());
    assert.strictEqual(manager.isAllowed('telegram', '4242', null), false);

    const refused = manager.listRecentRefusals('telegram');
    assert.strictEqual(refused.length, 1);
    assert.strictEqual(refused[0].senderId, '4242');
    assert.strictEqual(refused[0].groupId, null);
    assert.strictEqual(refused[0].count, 1);
  });

  it('records the group id when the refusal came from a group', () => {
    const manager = new AllowlistManager(makeStore());
    manager.isAllowed('discord', 'u-1', 'chan-9');
    const [entry] = manager.listRecentRefusals('discord');
    assert.strictEqual(entry.senderId, 'u-1');
    assert.strictEqual(entry.groupId, 'chan-9');
  });

  it('counts repeats instead of adding a row per message', () => {
    const manager = new AllowlistManager(makeStore());
    for (let i = 0; i < 50; i += 1) manager.isAllowed('telegram', '7', null);
    const refused = manager.listRecentRefusals('telegram');
    assert.strictEqual(refused.length, 1);
    assert.strictEqual(refused[0].count, 50);
  });

  it('keeps the journal bounded so a flood of fresh ids cannot grow it', () => {
    const manager = new AllowlistManager(makeStore(), { refusalCapacity: 5 });
    for (let i = 0; i < 500; i += 1) manager.isAllowed('telegram', `id-${i}`, null);
    const refused = manager.listRecentRefusals('telegram');
    assert.strictEqual(refused.length, 5);
    // Newest first, and the oldest were evicted.
    assert.strictEqual(refused[0].senderId, 'id-499');
    assert.ok(!refused.some((e) => e.senderId === 'id-0'));
  });

  it('never writes the journal to the store', () => {
    const store = makeStore();
    const manager = new AllowlistManager(store);
    manager.isAllowed('telegram', 'stranger', null);
    // A stranger messaging in a loop must not be able to grow a file on disk.
    assert.deepStrictEqual(Object.keys(store._data), []);
  });

  it('scopes the journal per channel', () => {
    const manager = new AllowlistManager(makeStore());
    manager.isAllowed('telegram', 'tg-1', null);
    manager.isAllowed('discord', 'dc-1', null);
    assert.deepStrictEqual(manager.listRecentRefusals('telegram').map((e) => e.senderId), ['tg-1']);
    assert.deepStrictEqual(manager.listRecentRefusals('discord').map((e) => e.senderId), ['dc-1']);
  });

  it('records nothing for an allowed sender', () => {
    const manager = new AllowlistManager(makeStore());
    manager.addUser('telegram', '42');
    assert.strictEqual(manager.isAllowed('telegram', '42', null), true);
    assert.deepStrictEqual(manager.listRecentRefusals('telegram'), []);
  });

  it('drops a refusal once the sender is allowed, so the prompt clears', () => {
    const manager = new AllowlistManager(makeStore());
    manager.isAllowed('telegram', '42', null);
    assert.strictEqual(manager.listRecentRefusals('telegram').length, 1);
    manager.addUser('telegram', '42');
    assert.deepStrictEqual(manager.listRecentRefusals('telegram'), []);
  });

  it('drops a refusal once its group is allowed', () => {
    const manager = new AllowlistManager(makeStore());
    manager.isAllowed('discord', 'u-1', 'chan-9');
    manager.addGroup('discord', 'chan-9');
    assert.deepStrictEqual(manager.listRecentRefusals('discord'), []);
  });

  it('still denies by default after the journal changes', () => {
    // Guard rail for wave 3's fix: the journal must not have re-opened it.
    const manager = new AllowlistManager(makeStore());
    assert.strictEqual(manager.isAllowed('telegram', 'anyone', null), false);
    assert.strictEqual(manager.getPolicy('telegram').default, 'deny');
  });
});
