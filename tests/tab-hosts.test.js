const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('tab-hosts', () => {
  describe('createTabHosts', () => {
    it('routes channels for two senders to two hosts', () => {
      const { createTabHosts } = require('../src/ipc/tab-hosts');

      const hosts = new Map();
      const events = [];

      const ipcMain = {
        handleCalls: {},
        onCalls: {},
        handle: function(channel, handler) {
          this.handleCalls[channel] = handler;
        },
        on: function(channel, handler) {
          this.onCalls[channel] = handler;
        }
      };

      const inventory = {
        handle: [
          { channel: 'test:invoke1' },
          { channel: 'test:invoke2' }
        ],
        on: [
          { channel: 'test:event1' },
          { channel: 'test:event2' }
        ]
      };

      const tabHosts = createTabHosts({ ipcMain, inventory });

      // Add two hosts for two web contents IDs
      const host1 = {
        invoke: async (channel, args) => ({ result: 'host1', channel }),
        on: (channel, handler) => {
          events.push({ host: 'host1', channel });
        },
        send: () => {},
        start: async () => {},
        shutdown: async () => {}
      };

      const host2 = {
        invoke: async (channel, args) => ({ result: 'host2', channel }),
        on: (channel, handler) => {
          events.push({ host: 'host2', channel });
        },
        send: () => {},
        start: async () => {},
        shutdown: async () => {}
      };

      tabHosts.add(1, host1);
      tabHosts.add(2, host2);

      // Simulate a handle call from sender 1
      const event1 = { sender: { id: 1 } };
      assert.ok(ipcMain.handleCalls['test:invoke1'], 'handler should be registered');
      assert.ok(ipcMain.onCalls['test:event1'], 'on handler should be registered');

      // Should be able to route by sender ID
      const host = tabHosts.hostOf(event1);
      assert.strictEqual(host, host1, 'should return host1 for sender 1');

      const host2Check = tabHosts.hostOf({ sender: { id: 2 } });
      assert.strictEqual(host2Check, host2, 'should return host2 for sender 2');
    });

    it('refuses unknown sender', () => {
      const { createTabHosts } = require('../src/ipc/tab-hosts');

      const ipcMain = {
        handleCalls: {},
        onCalls: {},
        handle: function() {},
        on: function() {}
      };

      const inventory = { handle: [], on: [] };
      const tabHosts = createTabHosts({ ipcMain, inventory });

      const event = { sender: { id: 999 } };
      const host = tabHosts.hostOf(event);
      assert.strictEqual(host, null, 'should return null for unknown sender');
    });

    it('removes a host from routing', () => {
      const { createTabHosts } = require('../src/ipc/tab-hosts');

      const ipcMain = {
        handleCalls: {},
        onCalls: {},
        handle: function() {},
        on: function() {}
      };

      const inventory = { handle: [], on: [] };
      const tabHosts = createTabHosts({ ipcMain, inventory });

      const host1 = { invoke: async () => ({}) };
      tabHosts.add(1, host1);
      assert.strictEqual(tabHosts.hostOf({ sender: { id: 1 } }), host1);

      tabHosts.remove(1);
      assert.strictEqual(tabHosts.hostOf({ sender: { id: 1 } }), null);
    });

    it('routes on channels the same way as handle channels', () => {
      const { createTabHosts } = require('../src/ipc/tab-hosts');

      const ipcMain = {
        handleCalls: {},
        onCalls: {},
        handle: function(channel, handler) {
          this.handleCalls[channel] = handler;
        },
        on: function(channel, handler) {
          this.onCalls[channel] = handler;
        }
      };

      const inventory = {
        handle: [{ channel: 'test:invoke' }],
        on: [{ channel: 'test:on' }]
      };

      const tabHosts = createTabHosts({ ipcMain, inventory });

      const host1 = {
        invoke: async () => ({}),
        on: (channel, handler) => {},
        send: () => {},
        start: async () => {},
        shutdown: async () => {}
      };

      tabHosts.add(1, host1);

      // Verify that both handle and on channels are registered
      assert.ok(ipcMain.handleCalls['test:invoke']);
      assert.ok(ipcMain.onCalls['test:on']);
    });
  });

  describe('createTabHost', () => {
    it('creates a host from entry and deps', async () => {
      const { createTabHost } = require('../src/ipc/tab-hosts');

      const entry = {
        kind: 'local',
        label: 'Local Chat'
      };

      const deps = {
        app: {},
        ipcMain: {},
        clientFactory: null
      };

      const host = createTabHost({ entry, deps });

      assert.ok(host, 'should create a host');
      assert.ok(host.invoke, 'host should have invoke method');
      assert.ok(host.on, 'host should have on method');
      assert.ok(host.send, 'host should have send method');
      assert.ok(host.start, 'host should have start method');
      assert.ok(host.shutdown, 'host should have shutdown method');
      assert.ok(host.status, 'host should have status method');
      assert.ok(host.onStatus, 'host should have onStatus method');
    });
  });
});
