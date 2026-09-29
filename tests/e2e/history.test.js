// tests/e2e/history.test.js
// The real app moves a profile's chats into history.sqlite, keeps them
// across a restart, loads each chat's messages when it is opened, and says
// when the store will not open (recall spec §4.4, §11.1, §15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');

const T = '2026-09-28T10:00:00.000Z';
const chat = (id, title, lines) => ({
  id, title, createdAt: T, updatedAt: T,
  messages: lines.map(([sender, text], i) => ({ id: `${id}-m${i}`, sender, text, timestamp: T }))
});
const SEED_CHATS = [
  chat('chat-a', 'Lakeside lot', [['user', 'remember the blue folder'], ['assistant', 'Noted, the blue folder.']]),
  chat('chat-b', 'Second chat', [['user', 'what is example.com'], ['assistant', 'It is an example domain.']])
];
const MESSAGES_TEXT = "document.getElementById('chat-messages').textContent";

async function cleanup(ctx, dir) {
  if (ctx && !ctx.closed) {
    ctx.ownsDir = true;
    await closeApp(ctx);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('E2E: history store', () => {
  it('moves the profile\'s chats into history.sqlite and keeps them across a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-history-'));
    let ctx = null;
    try {
      ctx = await launchApp({
        userDataDir: dir,
        seed: { 'chat-data.json': { onboardingComplete: true, activeChatId: 'chat-b', chats: SEED_CHATS } }
      });
      await waitFor(ctx, "document.querySelectorAll('.chat-item').length === 2");
      await waitFor(ctx, `${MESSAGES_TEXT}.includes('example domain')`);

      await evaluate(ctx, "document.querySelector('.chat-item[data-chat-id=\"chat-a\"] .chat-item-title').click()");
      await waitFor(ctx, `${MESSAGES_TEXT}.includes('blue folder')`);
      assert.strictEqual(await evaluate(ctx, "Array.isArray(appState.chats.find((c) => c.id === 'chat-b').messages)"), false,
        'the chat left behind keeps no messages in the renderer');

      await closeApp(ctx);
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8'));
      assert.deepStrictEqual(data.chats, []);
      assert.ok(fs.existsSync(path.join(dir, 'history.sqlite')));
      assert.strictEqual(fs.readdirSync(dir).filter((f) => /^chat-data\.backup-.*\.json$/.test(f)).length, 1);

      ctx = await launchApp({ userDataDir: dir, seed: null });
      await waitFor(ctx, "document.querySelectorAll('.chat-item').length === 2");
      await waitFor(ctx, `${MESSAGES_TEXT}.includes('blue folder')`);
    } finally {
      await cleanup(ctx, dir);
    }
  });

  it('says chats are unavailable when history.sqlite will not open, and leaves chat-data.json alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-history-'));
    fs.writeFileSync(path.join(dir, 'history.sqlite'), 'invented text that is not a database '.repeat(40));
    let ctx = null;
    try {
      ctx = await launchApp({ userDataDir: dir, seed: { 'chat-data.json': { onboardingComplete: true, chats: SEED_CHATS } } });
      await waitFor(ctx, "(document.querySelector('.chat-list-error')?.textContent || '').includes('Chats are unavailable')");
      assert.strictEqual(await evaluate(ctx, "document.querySelectorAll('.chat-item').length"), 0);
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8'));
      assert.strictEqual(data.chats.length, 2);
      assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('chat-data.backup-')), []);
    } finally {
      await cleanup(ctx, dir);
    }
  });
});
