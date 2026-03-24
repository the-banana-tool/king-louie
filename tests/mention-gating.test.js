const { describe, it } = require('node:test');
const assert = require('node:assert');

const { shouldRespond } = require('../src/channels/mention-gating');
const AllowlistManager = require('../src/channels/allowlist-manager');

describe('shouldRespond', () => {
  it('always responds to DMs', () => {
    assert.ok(shouldRespond({ isGroup: false, requireMention: true, wasMentioned: false, isCommand: false, isReply: false }));
  });

  it('always responds to commands in groups', () => {
    assert.ok(shouldRespond({ isGroup: true, requireMention: true, wasMentioned: false, isCommand: true, isReply: false }));
  });

  it('always responds to replies in groups', () => {
    assert.ok(shouldRespond({ isGroup: true, requireMention: true, wasMentioned: false, isCommand: false, isReply: true }));
  });

  it('responds when mentioned in group', () => {
    assert.ok(shouldRespond({ isGroup: true, requireMention: true, wasMentioned: true, isCommand: false, isReply: false }));
  });

  it('skips non-mentioned messages in group when required', () => {
    assert.ok(!shouldRespond({ isGroup: true, requireMention: true, wasMentioned: false, isCommand: false, isReply: false }));
  });

  it('responds to all group messages when mention not required', () => {
    assert.ok(shouldRespond({ isGroup: true, requireMention: false, wasMentioned: false, isCommand: false, isReply: false }));
  });
});

describe('AllowlistManager', () => {
  function createStore() {
    const data = {};
    return {
      get(key, fallback) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
      },
      set(key, value) {
        data[key] = value;
      }
    };
  }

  it('allows all by default (default: allow)', () => {
    const mgr = new AllowlistManager(createStore());
    assert.ok(mgr.isAllowed('telegram', 'any-user', null));
  });

  it('blocks when default is deny and user not in allowlist', () => {
    const mgr = new AllowlistManager(createStore());
    mgr.setPolicy('telegram', { default: 'deny', users: ['allowed-user'], groups: [] });
    assert.ok(!mgr.isAllowed('telegram', 'blocked-user', null));
    assert.ok(mgr.isAllowed('telegram', 'allowed-user', null));
  });

  it('add and remove user from allowlist', () => {
    const mgr = new AllowlistManager(createStore());
    mgr.setPolicy('telegram', { default: 'deny', users: [], groups: [] });
    mgr.addUser('telegram', 'user1');
    assert.ok(mgr.isAllowed('telegram', 'user1', null));
    mgr.removeUser('telegram', 'user1');
    assert.ok(!mgr.isAllowed('telegram', 'user1', null));
  });

  it('persists policies', () => {
    const mgr = new AllowlistManager(createStore());
    mgr.setPolicy('discord', { default: 'deny', users: ['u1'], groups: ['g1'] });
    const policy = mgr.getPolicy('discord');
    assert.strictEqual(policy.default, 'deny');
    assert.ok(policy.users.includes('u1'));
    assert.ok(policy.groups.includes('g1'));
  });
});
