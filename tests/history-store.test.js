const { describe, it } = require('node:test');
const assert = require('node:assert');
const { JsonChatHistoryStore } = require('../src/history');

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    get(key, fallback) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback; },
    set(key, value) { data[key] = value; },
    data
  };
}

describe('JsonChatHistoryStore', () => {
  it('lists metadata without messages and can fetch one chat with messages', () => {
    const store = memoryStore({
      chats: [
        { id: 'c1', title: 'One', messages: [{ id: 'm1', sender: 'user', text: 'hi' }] },
        { id: 'c2', title: 'Two', messages: [{ id: 'm2', sender: 'assistant', text: 'hello' }] }
      ]
    });
    const history = new JsonChatHistoryStore({ store });

    assert.deepStrictEqual(history.listChats(), [
      { id: 'c1', title: 'One' },
      { id: 'c2', title: 'Two' }
    ]);
    assert.deepStrictEqual(history.getChat('c1').messages, [{ id: 'm1', sender: 'user', text: 'hi' }]);
  });

  it('updates and appends through the existing JSON chats array', () => {
    const store = memoryStore({ chats: [{ id: 'c1', title: 'One', messages: [] }] });
    const history = new JsonChatHistoryStore({ store });

    assert.strictEqual(history.updateChat('c1', { title: 'Renamed' }).title, 'Renamed');
    const updated = history.appendMessage('c1', { id: 'm1', sender: 'user', text: 'hello', timestamp: '2026-09-29T12:00:00.000Z' });

    assert.strictEqual(updated.title, 'Renamed');
    assert.strictEqual(updated.updatedAt, '2026-09-29T12:00:00.000Z');
    assert.deepStrictEqual(store.data.chats[0].messages.map((m) => m.id), ['m1']);
  });
});