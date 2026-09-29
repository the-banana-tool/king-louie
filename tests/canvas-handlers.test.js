const { describe, it } = require('node:test');
const assert = require('node:assert');

const { registerCanvasHandlers } = require('../src/ipc/canvas-handlers');
const { historyContext } = require('./helpers/history-context');

function setup(chats) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const history = historyContext(chats.map((c) => ({ title: c.id, messages: [], ...c })));
  registerCanvasHandlers(ipcMain, history);
  return { handlers, history };
}

describe('canvas IPC handlers', () => {
  it('registers a canvas:close handler (renderer close button depends on it)', () => {
    const { handlers } = setup([]);
    assert.ok(handlers.has('canvas:close'), 'canvas:close must be registered');
  });

  it('canvas:close clears the persisted canvasState so it does not reappear', async () => {
    const { handlers, history } = setup([
      { id: 'c1', canvasState: { title: 'X', content: '<p>hi</p>', visible: true } },
      { id: 'c2', canvasState: { title: 'Y', content: '<p>keep</p>', visible: true } }
    ]);

    const result = await handlers.get('canvas:close')({}, { chatId: 'c1' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(history.getChat('c1', { messages: false }).canvasState, null);
    // Unrelated chats are untouched.
    assert.ok(history.getChat('c2', { messages: false }).canvasState);
  });

  it('canvas:close requires a chatId', async () => {
    const { handlers } = setup([]);
    const result = await handlers.get('canvas:close')({}, {});
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /chatId/);
  });

  it('reads and writes canvas state through the history store', async () => {
    const { handlers, history } = setup([
      { id: 'c1', canvasState: { title: 'Old', content: 'old' } }
    ]);

    const get = await handlers.get('canvas:getState')({}, { chatId: 'c1' });
    const set = await handlers.get('canvas:setState')({}, { chatId: 'c1', canvasState: { title: 'New', content: 'new' } });

    assert.strictEqual(get.ok, true);
    assert.strictEqual(get.canvasState.title, 'Old');
    assert.strictEqual(set.ok, true);
    const stored = history.getChat('c1', { messages: false });
    assert.strictEqual(stored.canvasState.title, 'New');
    assert.ok(stored.updatedAt);
  });
});
