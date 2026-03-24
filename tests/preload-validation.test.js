const { describe, it } = require('node:test');
const assert = require('node:assert');

// We'll run the preload script in a mocked environment
const vm = require('vm');
const fs = require('fs');
const path = require('path');

describe('Preload Validation', () => {
  // Setup environment for preload script
  const sandbox = {
    require: (module) => {
      if (module === 'electron') {
        return {
          contextBridge: {
            exposeInMainWorld: (apiKey, api) => {
              sandbox.exposedApi = api;
            }
          },
          ipcRenderer: {
            invoke: async () => ({ ok: true }),
            on: () => {},
            send: () => {},
            removeListener: () => {}
          }
        };
      }
      return require(module);
    },
    console,
    Date
  };

  const context = vm.createContext(sandbox);
  const preloadCode = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  vm.runInContext(preloadCode, context);

  const api = sandbox.exposedApi;

  describe('chat.sendMessage', () => {
    it('requires payload to be an object', () => {
      assert.throws(() => api.chat.sendMessage(), /Invalid payload: expected object/);
    });
    it('requires chatId to be a string', () => {
      assert.throws(() => api.chat.sendMessage({}), /Invalid chatId: expected string/);
    });
    it('requires message to be a string', () => {
      assert.throws(() => api.chat.sendMessage({ chatId: '123' }), /Invalid message: expected string/);
    });
    it('requires message to have length > 0', () => {
      assert.throws(() => api.chat.sendMessage({ chatId: '123', message: '   ' }), /Invalid message: must be at least 1 character\(s\)/);
    });
    it('allows valid payload', async () => {
      await assert.doesNotReject(api.chat.sendMessage({ chatId: '123', message: 'hello' }));
    });
  });

  describe('chat.addMessage', () => {
    it('requires payload to be an object', () => {
      assert.throws(() => api.chat.addMessage(), /Invalid payload: expected object/);
    });
    it('requires chatId to be a string', () => {
      assert.throws(() => api.chat.addMessage({}), /Invalid chatId: expected string/);
    });
    it('requires text to be a string', () => {
      assert.throws(() => api.chat.addMessage({ chatId: '123' }), /Invalid text: expected string/);
    });
    it('requires sender to be valid', () => {
      assert.throws(() => api.chat.addMessage({ chatId: '123', text: 'hi', sender: 'alien' }), /Invalid sender: must be one of user, assistant, system, tool/);
    });
    it('allows valid payload', async () => {
      await assert.doesNotReject(api.chat.addMessage({ chatId: '123', text: 'hi', sender: 'user' }));
    });
  });

  describe('chat.rename', () => {
    it('requires payload to be an object', () => {
      assert.throws(() => api.chat.rename(), /Invalid payload: expected object/);
    });
    it('requires chatId to be a string', () => {
      assert.throws(() => api.chat.rename({}), /Invalid chatId: expected string/);
    });
    it('requires name to be a string', () => {
      assert.throws(() => api.chat.rename({ chatId: '123' }), /Invalid name: expected string/);
    });
    it('requires name to have length > 0', () => {
      assert.throws(() => api.chat.rename({ chatId: '123', name: '   ' }), /Invalid name: must be at least 1 character\(s\)/);
    });
    it('requires name to be 200 characters or fewer', () => {
      assert.throws(() => api.chat.rename({ chatId: '123', name: 'a'.repeat(201) }), /Invalid name: must be 200 characters or fewer/);
    });
    it('allows valid payload', async () => {
      await assert.doesNotReject(api.chat.rename({ chatId: '123', name: 'new name' }));
    });
  });

  describe('chat.remove (delete)', () => {
    it('requires chatId to be a string', () => {
      assert.throws(() => api.chat.remove(), /Invalid chatId: expected string/);
      assert.throws(() => api.chat.remove({ chatId: '123' }), /Invalid chatId: expected string/);
    });
    it('allows valid payload', async () => {
      await assert.doesNotReject(api.chat.remove('123'));
    });
  });

  describe('memory.capture', () => {
    it('requires payload to be an object', () => {
      assert.throws(() => api.memory.capture(), /Invalid payload: expected object/);
    });
    it('requires type to be a string', () => {
      assert.throws(() => api.memory.capture({}), /Invalid type: expected string/);
    });
    it('requires content to be a string', () => {
      assert.throws(() => api.memory.capture({ type: 'fact' }), /Invalid content: expected string/);
    });
    it('requires content to have length > 0', () => {
      assert.throws(() => api.memory.capture({ type: 'fact', content: '  ' }), /Invalid content: must be at least 1 character\(s\)/);
    });
    it('allows valid payload', async () => {
      await assert.doesNotReject(api.memory.capture({ type: 'fact', content: 'hello' }));
    });
  });

  describe('memory.delete', () => {
    it('requires payload to be an object', () => {
      assert.throws(() => api.memory.delete(), /Invalid payload: expected object/);
    });
    it('requires id to be a string', () => {
      assert.throws(() => api.memory.delete({}), /Invalid id: expected string/);
    });
    it('allows valid payload', async () => {
      await assert.doesNotReject(api.memory.delete({ id: '123' }));
    });
  });

  describe('agent.execute', () => {
    it('requires payload to be an object', () => {
      assert.throws(() => api.agent.execute(), /Invalid payload: expected object/);
    });
    it('requires agentId to be a string', () => {
      assert.throws(() => api.agent.execute({}), /Invalid agentId: expected string/);
    });
    it('requires message to be a string', () => {
      assert.throws(() => api.agent.execute({ agentId: '123' }), /Invalid message: expected string/);
    });
    it('allows valid payload', async () => {
      await assert.doesNotReject(api.agent.execute({ agentId: '123', message: 'hello' }));
    });
  });

  describe('hooks.setEnabled', () => {
    it('requires payload to be an object', () => {
      assert.throws(() => api.hooks.setEnabled(), /Invalid payload: expected object/);
    });
    it('requires hookId to be a string', () => {
      assert.throws(() => api.hooks.setEnabled({}), /Invalid hookId: expected string/);
    });
    it('requires enabled to be a boolean', () => {
      assert.throws(() => api.hooks.setEnabled({ hookId: '123' }), /Invalid enabled: expected boolean/);
      assert.throws(() => api.hooks.setEnabled({ hookId: '123', enabled: 'true' }), /Invalid enabled: expected boolean/);
    });
    it('allows valid payload', async () => {
      await assert.doesNotReject(api.hooks.setEnabled({ hookId: '123', enabled: true }));
    });
  });

});
