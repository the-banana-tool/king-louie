// A reply held open in an attached window (remote window plan, task 2 fix round). Whatever arrives
// meanwhile, a refused send or resend, another window's row or chat:updated, leaves Stop and the
// streaming node where they are. The other window's events are sent from the main process: a real
// second renderer is Task 16's.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/attached-held-reply.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchAttached, closeApp, evaluate, waitFor, click, fill } = require('./helpers');

const REFUSAL = 'A reply is still running in this chat.';
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const pressEnter = (ctx) => evaluate(ctx, `document.getElementById('user-input').dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true, cancelable: true })); true`);
const fromAnotherWindow = (ctx, channel, payload) => ctx.electronApp.evaluate(({ BrowserWindow }, [ch, p]) => {
  BrowserWindow.getAllWindows()[0].webContents.send(ch, p);
}, [channel, payload]);
const stillHeld = (ctx) => evaluate(ctx, `({
  connected: window.__held.isConnected,
  streaming: window.__held.classList.contains('streaming'),
  stop: !document.getElementById('stop-btn').hidden,
  active: appState.activeResponses.has(appState.activeChatId),
  text: window.__held.textContent
})`);
const assertHeld = async (ctx, what) => {
  const held = await stillHeld(ctx);
  assert.strictEqual(held.connected, true, `${what}: the streaming node is in the view`);
  assert.strictEqual(held.streaming, true, `${what}: it is still streaming`);
  assert.strictEqual(held.stop, true, `${what}: Stop is showing`);
  assert.strictEqual(held.active, true, `${what}: the reply is still active`);
  assert.match(held.text, /Holding/, what);
};
const userRows = (ctx) => evaluate(ctx, `[...document.querySelectorAll('#chat-messages .message.user')].map((el) => el.textContent)`);

describe('E2E: an attached window while a reply is held', { timeout: 240000 }, () => {
  let ctx;

  before(async () => {
    ctx = await launchAttached();
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('Enter, a resend and another window\'s events leave Stop and the stream alone', async () => {
    await click(ctx, '#new-chat-btn');
    await waitFor(ctx, `!!appState.activeChatId`);
    const chatId = await evaluate(ctx, `appState.activeChatId`);
    await fill(ctx, '#user-input', 'hold the reply please');
    await pressEnter(ctx);
    await waitFor(ctx, `document.querySelector('.message.streaming')?.textContent.includes('Holding')`, 30000);
    await evaluate(ctx, `window.__held = document.querySelector('.message.streaming'); true`);
    await assertHeld(ctx, 'to begin with');

    // Enter during the reply: the node refuses, and the words come back.
    await fill(ctx, '#user-input', 'a second thought');
    await pressEnter(ctx);
    await waitFor(ctx, `document.getElementById('chat-messages').textContent.includes(${JSON.stringify(REFUSAL)})`);
    await pause(300);
    await assertHeld(ctx, 'after Enter');
    assert.strictEqual(await evaluate(ctx, `document.getElementById('user-input').value`), 'a second thought');
    assert.ok(!(await userRows(ctx)).some((t) => t.includes('a second thought')), 'no row of them');
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('#chat-messages .chat-busy-refusal').length`), 1);

    // Again: one refusal on screen, not a pile.
    await pressEnter(ctx);
    await pause(300);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('#chat-messages .chat-busy-refusal').length`), 1);
    await assertHeld(ctx, 'after a second Enter');

    // Resend during the reply: refused before anything is removed.
    await evaluate(ctx, `document.getElementById('user-input').value = ''; true`);
    const index = await evaluate(ctx, `getActiveChat().messages.findIndex((m) => m.sender === 'user')`);
    await evaluate(ctx, `resendFromIndex(${JSON.stringify(chatId)}, ${index}); true`);
    await waitFor(ctx, `document.getElementById('user-input').value === 'hold the reply please'`);
    await assertHeld(ctx, 'after a resend');
    const stored = await evaluate(ctx, `window.electron.chat.get(${JSON.stringify(chatId)}).then((r) => (r.chat || r.data?.chat || r.data).messages.filter((m) => m.sender === 'user').map((m) => m.text))`);
    assert.deepStrictEqual(stored, ['hold the reply please']);

    // Another window's chat:updated: the list only, for now.
    await fromAnotherWindow(ctx, 'chat:updated', { chatId });
    await pause(400);
    await assertHeld(ctx, 'after chat:updated');

    // Another window's row, above the stream.
    await fromAnotherWindow(ctx, 'chat:rowAdded', { chatId, run: false, message: { id: 'row-from-b', sender: 'user', text: 'from the other window', timestamp: '2026-11-04T10:00:00Z' } });
    await waitFor(ctx, `[...document.querySelectorAll('#chat-messages .message.user')].some((el) => el.textContent.includes('from the other window'))`);
    await assertHeld(ctx, 'after a row');
    assert.strictEqual(await evaluate(ctx, `(() => { const rows = [...document.querySelectorAll('#chat-messages .message')]; return rows.findIndex((el) => el.textContent.includes('from the other window')) < rows.indexOf(window.__held); })()`), true, 'above the stream');

    // Another window renames this chat.
    await evaluate(ctx, `window.electron.chat.rename({ chatId: ${JSON.stringify(chatId)}, name: 'Renamed elsewhere' }).then(() => true)`);
    await fromAnotherWindow(ctx, 'chat:listChanged', { chatId, what: 'renamed' });
    await waitFor(ctx, `document.getElementById('chat-list').textContent.includes('Renamed elsewhere')`);
    await assertHeld(ctx, 'after a rename');

    // Stop still works; the chat:updated that came in is honoured when the reply ends.
    await click(ctx, '#stop-btn');
    await waitFor(ctx, `!document.querySelector('.message.streaming') && document.getElementById('stop-btn').hidden`, 30000);
    await waitFor(ctx, `![...document.querySelectorAll('#chat-messages .message.user')].some((el) => el.textContent.includes('from the other window'))`, 15000);
    assert.ok((await userRows(ctx)).some((t) => t.includes('hold the reply please')));
  });

  it('a send refused while the window did not know the chat was busy gives back the words and the attachments', async () => {
    const before = await evaluate(ctx, `appState.activeChatId`);
    await click(ctx, '#new-chat-btn');
    await waitFor(ctx, `appState.activeChatId !== ${JSON.stringify(before)}`);
    await fill(ctx, '#user-input', 'hold the reply please');
    await pressEnter(ctx);
    await waitFor(ctx, `document.querySelector('.message.streaming')?.textContent.includes('Holding')`, 30000);
    // As a window sees it when another window's run holds the chat: nothing running here.
    await evaluate(ctx, `appState.activeResponses.delete(appState.activeChatId); true`);
    await evaluate(ctx, `
      appState.pendingImages = [{ name: 'lot.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', previewUrl: 'blob:lot' }];
      appState.pendingDocuments = [{ name: 'deed.txt', mimeType: 'text/plain', base64: 'TGFrZXNpZGUgbG90', textContent: 'Lakeside lot' }];
      renderPendingImages();
      true`);
    await fill(ctx, '#user-input', 'with a picture');
    await pressEnter(ctx);
    await waitFor(ctx, `document.getElementById('chat-messages').textContent.includes(${JSON.stringify(REFUSAL)})`);
    assert.strictEqual(await evaluate(ctx, `document.getElementById('user-input').value`), 'with a picture');
    assert.deepStrictEqual(await evaluate(ctx, `appState.pendingImages.map((i) => [i.name, i.previewUrl])`), [['lot.png', 'blob:lot']]);
    assert.deepStrictEqual(await evaluate(ctx, `appState.pendingDocuments.map((d) => d.name)`), ['deed.txt']);
    assert.strictEqual(await evaluate(ctx, `document.getElementById('image-preview-list').hidden`), false);
    await evaluate(ctx, `appState.activeResponses.add(appState.activeChatId); clearPendingImages(); document.getElementById('user-input').value = ''; true`);
    await click(ctx, '#stop-btn');
    await waitFor(ctx, `document.getElementById('stop-btn').hidden`, 30000);
  });

  it('a window that comes to a chat part way through a turn shows it running and reads the rows when it ends', async () => {
    const before = await evaluate(ctx, `appState.activeChatId`);
    await click(ctx, '#new-chat-btn');
    await waitFor(ctx, `appState.activeChatId !== ${JSON.stringify(before)}`);
    const chatId = await evaluate(ctx, `appState.activeChatId`);
    await fill(ctx, '#user-input', 'hold the reply please');
    await pressEnter(ctx);
    await waitFor(ctx, `document.querySelector('.message.streaming')?.textContent.includes('Holding')`, 30000);

    // A fresh renderer on the same node: it missed the turn's start.
    await ctx.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.reload(); });
    await pause(1500);
    await waitFor(ctx, `typeof appState !== 'undefined' && appState.activeResponses.has(${JSON.stringify(chatId)})`, 30000);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
    await evaluate(ctx, `appState.activeChatId === ${JSON.stringify(chatId)} || handleSelectChat(${JSON.stringify(chatId)}); true`);
    await waitFor(ctx, `appState.activeChatId === ${JSON.stringify(chatId)} && !document.getElementById('stop-btn').hidden`);
    assert.strictEqual(await evaluate(ctx, `document.getElementById('send-btn').hidden`), true, 'Stop in place of Send');
    assert.ok(await evaluate(ctx, `[...document.querySelectorAll('#chat-list .chat-item.streaming')].length > 0`));

    await click(ctx, '#stop-btn');
    await waitFor(ctx, `document.getElementById('stop-btn').hidden && !appState.activeResponses.has(${JSON.stringify(chatId)})`, 30000);
    await waitFor(ctx, `[...document.querySelectorAll('#chat-messages .message.assistant')].some((el) => el.textContent.includes('Holding'))`, 15000);
  });

  it('a window whose open chat is deleted elsewhere says so and shows one that exists', async () => {
    const before = await evaluate(ctx, `appState.activeChatId`);
    await click(ctx, '#new-chat-btn');
    await waitFor(ctx, `appState.activeChatId !== ${JSON.stringify(before)}`);
    const doomed = await evaluate(ctx, `appState.activeChatId`);
    await evaluate(ctx, `window.electron.chat.remove(${JSON.stringify(doomed)}).then(() => true)`);
    await fromAnotherWindow(ctx, 'chat:listChanged', { chatId: doomed, what: 'deleted' });
    await waitFor(ctx, `appState.activeChatId !== ${JSON.stringify(doomed)}`);
    const notice = await waitFor(ctx, `document.querySelector('.kl-notice')?.textContent || ''`);
    assert.match(notice, /Another window deleted the chat you had open/);
    assert.ok(await evaluate(ctx, `!appState.chats.some((c) => c.id === ${JSON.stringify(doomed)})`));
  });
});

