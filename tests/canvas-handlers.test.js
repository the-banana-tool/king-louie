const { describe, it } = require('node:test');
const assert = require('node:assert');

const { registerCanvasHandlers } = require('../src/ipc/canvas-handlers');

function setup(chats) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const store = { chats: chats.map((c) => ({ ...c })) };
  registerCanvasHandlers(ipcMain, {
    getChats: () => store.chats,
    setChats: (next) => { store.chats = next; }
  });
  return { handlers, store };
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
});
