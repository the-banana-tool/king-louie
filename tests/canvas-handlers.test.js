const { describe, it } = require('node:test');
const assert = require('node:assert');

const { registerCanvasHandlers } = require('../src/ipc/canvas-handlers');

function setup(chats, { facade = false } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const store = { chats: chats.map((c) => ({ ...c })) };
  const context = {
    getChats: () => store.chats,
    setChats: (next) => { store.chats = next; }
  };
  if (facade) {
    context.calls = [];
    context.getChat = (chatId) => store.chats.find((c) => c.id === chatId) || null;
    context.updateChat = (chatId, patch) => {
      context.calls.push({ chatId, patch });
      store.chats = store.chats.map((chat) => (chat.id === chatId ? { ...chat, ...patch } : chat));
      return store.chats.find((chat) => chat.id === chatId) || null;
    };
  }
  registerCanvasHandlers(ipcMain, context);
  return { handlers, store, context };
}

describe('canvas IPC handlers', () => {
  it('registers a canvas:close handler (renderer close button depends on it)', () => {
    const { handlers } = setup([]);
    assert.ok(handlers.has('canvas:close'), 'canvas:close must be registered');
  });

  it('canvas:close clears the persisted canvasState so it does not reappear', async () => {
    const { handlers, store } = setup([
      { id: 'c1', canvasState: { title: 'X', content: '<p>hi</p>', visible: true } },
      { id: 'c2', canvasState: { title: 'Y', content: '<p>keep</p>', visible: true } }
    ]);

    const result = await handlers.get('canvas:close')({}, { chatId: 'c1' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(store.chats.find((c) => c.id === 'c1').canvasState, null);
    // Unrelated chats are untouched.
    assert.ok(store.chats.find((c) => c.id === 'c2').canvasState);
  });

  it('canvas:close requires a chatId', async () => {
    const { handlers } = setup([]);
    const result = await handlers.get('canvas:close')({}, {});
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /chatId/);
  });

  it('uses history facade methods when available', async () => {
    const { handlers, store, context } = setup([
      { id: 'c1', canvasState: { title: 'Old', content: 'old' } }
    ], { facade: true });

    const get = await handlers.get('canvas:getState')({}, { chatId: 'c1' });
    const set = await handlers.get('canvas:setState')({}, { chatId: 'c1', canvasState: { title: 'New', content: 'new' } });

    assert.strictEqual(get.ok, true);
    assert.strictEqual(get.canvasState.title, 'Old');
    assert.strictEqual(set.ok, true);
    assert.strictEqual(store.chats[0].canvasState.title, 'New');
    assert.deepStrictEqual(context.calls.map((c) => [c.chatId, Object.keys(c.patch).sort()]), [
      ['c1', ['canvasState', 'updatedAt']]
    ]);
  });
});
