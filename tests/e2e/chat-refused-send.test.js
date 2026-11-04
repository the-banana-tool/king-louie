// A send the main process refuses (a task's turn holds the chat: CHAT_BUSY) stores nothing, so the
// window must say so where it stays, and give the words back. A failed turn has stored its row and
// its error, and must show that error once.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, fill, click } = require('./helpers');

const REFUSAL = 'A task is still running in this chat. Send your message when it has finished.';
const errorBubbles = `[...document.querySelectorAll('#chat-messages .message.assistant')].filter((el) => el.textContent.includes('Error') || el.textContent.includes('${REFUSAL}')).length`;
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('E2E: a send that fails or is refused', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click()`);
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('a failed turn (no usable model) shows its error once and does not give the words back', async () => {
    await click(ctx, '#new-chat-btn');
    await pause(300);
    await fill(ctx, '#user-input', 'Find the survey date');
    await click(ctx, '#send-btn');
    await waitFor(ctx, `${errorBubbles} > 0`);
    await pause(800);
    assert.strictEqual(await evaluate(ctx, errorBubbles), 1);
    assert.strictEqual(await evaluate(ctx, `document.getElementById('user-input').value`), '');
  });

  it('a refused send keeps its bubble and gives the words back', async () => {
    await ctx.electronApp.evaluate(({ ipcMain }, error) => {
      ipcMain.removeHandler('chat:sendMessage');
      ipcMain.handle('chat:sendMessage', () => ({ ok: false, code: 'CHAT_BUSY', error }));
    }, REFUSAL);
    await click(ctx, '#new-chat-btn');
    await pause(300);
    await fill(ctx, '#user-input', 'Hold the deposit');
    await click(ctx, '#send-btn');
    await waitFor(ctx, `document.getElementById('chat-messages').textContent.includes(${JSON.stringify(REFUSAL)})`);
    await pause(800);
    assert.strictEqual(await evaluate(ctx, errorBubbles), 1, 'still there, once');
    assert.strictEqual(await evaluate(ctx, `document.getElementById('user-input').value`), 'Hold the deposit');
    assert.strictEqual(await evaluate(ctx, `[...document.querySelectorAll('#chat-messages .message.user')].some((el) => el.textContent.includes('Hold the deposit'))`), false, 'no row of them');
  });
});
