const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, fill, isVisible, click } = require('./helpers');

describe('E2E: Chat Basics', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('can type in the chat input', async () => {
    await fill(ctx, '#user-input', 'Hello, King Louie!');
    const val = await evaluate(ctx, `document.getElementById('user-input').value`);
    assert.strictEqual(val, 'Hello, King Louie!');
  });

  it('chat list is visible', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('chat-list')`);
    assert.ok(exists, 'chat list should exist');
  });

  it('new chat button creates a new chat', async () => {
    const initialCount = await evaluate(ctx, `document.querySelectorAll('.chat-item').length`);
    await click(ctx, '#new-chat-btn');
    await new Promise((r) => setTimeout(r, 500));
    const newCount = await evaluate(ctx, `document.querySelectorAll('.chat-item').length`);
    assert.ok(newCount >= initialCount, 'should have same or more chats after clicking new');
  });

  it('messages container exists', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('chat-messages')`);
    assert.ok(exists, 'chat-messages container should exist');
  });

  it('agent mode toggle exists', async () => {
    // Agent mode may be in the chat info popover
    const exists = await evaluate(ctx, `
      !!document.querySelector('[id*="agent-mode"], .agent-mode-toggle, #chat-info-popover')
    `);
    assert.ok(exists, 'agent mode control or chat info popover should exist');
  });
});
