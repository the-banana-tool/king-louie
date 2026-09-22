const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createHeadlessPrompter, HEADLESS_ASK_USER_ERROR } = require('../src/platform/prompter');
const { createElectronPrompter } = require('../src/platform/electron-prompter');

describe('headless prompter', () => {
  it('refuses to ask questions', async () => {
    const p = createHeadlessPrompter();
    assert.deepStrictEqual(await p.askUser({ question: 'hi?' }), { ok: false, error: HEADLESS_ASK_USER_ERROR });
  });
  it('denies directory access', async () => {
    assert.strictEqual(await createHeadlessPrompter().requestDirectoryAccess({ directory: '/tmp', toolName: 'Read' }), false);
  });
});

describe('electron prompter', () => {
  function fakeWindow() {
    const sent = [];
    return { sent, webContents: { send: (ch, payload) => sent.push({ ch, payload }) }, isDestroyed: () => false };
  }

  it('sends agent:askUser and resolves with the renderer answer', async () => {
    const win = fakeWindow();
    const askMap = new Map();
    const p = createElectronPrompter({ getWindow: () => win, pendingAskUserResolvers: askMap, pendingDirectoryAccessResolvers: new Map() });
    const pending = p.askUser({ question: 'Proceed?' });
    assert.strictEqual(win.sent[0].ch, 'agent:askUser');
    const { requestId, question } = win.sent[0].payload;
    assert.strictEqual(question, 'Proceed?');
    askMap.get(requestId).resolve('yes');
    assert.deepStrictEqual(await pending, { ok: true, response: 'yes' });
  });

  it('returns an error when no window exists', async () => {
    const p = createElectronPrompter({ getWindow: () => null, pendingAskUserResolvers: new Map(), pendingDirectoryAccessResolvers: new Map() });
    assert.deepStrictEqual(await p.askUser({ question: 'q' }), { ok: false, error: 'No UI available to ask user.' });
    assert.strictEqual(await p.requestDirectoryAccess({ directory: '/x', toolName: 'Read' }), false);
  });

  it('sends tool:directoryAccessRequired and resolves with the decision', async () => {
    const win = fakeWindow();
    const dirMap = new Map();
    const p = createElectronPrompter({ getWindow: () => win, pendingAskUserResolvers: new Map(), pendingDirectoryAccessResolvers: dirMap });
    const pending = p.requestDirectoryAccess({ directory: '/data', toolName: 'Read' });
    const { requestId, directory, toolName } = win.sent[0].payload;
    assert.strictEqual(win.sent[0].ch, 'tool:directoryAccessRequired');
    assert.strictEqual(directory, '/data');
    assert.strictEqual(toolName, 'Read');
    dirMap.get(requestId).resolve(true);
    assert.strictEqual(await pending, true);
  });
});
