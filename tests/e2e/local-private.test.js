// tests/e2e/local-private.test.js — local inference L1 (spec 2026-10-13
// §15, plan Task 19), driven as the owner drives it: add a local server in
// Settings → Models, mark a chat private through the confirmation, see a
// turn with only a hosted model refused (with "Open Models") and nothing
// sent, place the local model in the profile, see the hosted model disabled
// in the chat's picker, get a reply from the local model with a "local"
// cost line, and find the mark still there after a relaunch.
//
// One fake server on 127.0.0.1 (tests/helpers/fake-llm-server.js) plays
// both sides: the built-in Ollama provider at `<url>/ollama` (hosted under
// the guarantee, R-LI-31) and the local server at `<url>/localbox`
// (OpenAI-compatible). The first path segment says which one a request was.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/local-private.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor, readHistoryChats } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (minute) => new Date(Date.parse('2026-03-01T09:00:00.000Z') + minute * 60000).toISOString();

const chat = (id, title, texts) => ({
  id, title, createdAt: at(0), updatedAt: at(30), agentMode: false, sandboxMode: true,
  messages: texts.map((text, i) => ({ id: `${id}-m${i + 1}`, sender: i % 2 ? 'assistant' : 'user', text, timestamp: at(i + 1) }))
});

describe('E2E: a private chat answers only from a local model (local inference L1)', { timeout: 300000 }, () => {
  let ctx;
  let server;
  let userDataDir;

  // Model calls the fake saw, by side.
  const completions = (side) => server.requests.filter((r) => r.provider === side && r.path.endsWith('/chat/completions'));
  // Waits until the fake has seen no new request for a while (a title call
  // can follow a reply).
  const settle = async (quietMs = 1500, timeoutMs = 20000) => {
    const start = Date.now();
    let seen = server.requests.length;
    let since = Date.now();
    while (Date.now() - start < timeoutMs) {
      await delay(200);
      if (server.requests.length !== seen) { seen = server.requests.length; since = Date.now(); }
      if (Date.now() - since >= quietMs) return;
    }
  };
  const send = (text) => evaluate(ctx, `(() => {
    const input = document.getElementById('user-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input'));
    document.getElementById('send-btn').click();
    return true;
  })()`);
  const metricsCount = () => evaluate(ctx, `document.querySelectorAll('.message-metrics-call').length`);
  const lastMetrics = () => evaluate(ctx, `(() => { const els = [...document.querySelectorAll('.message-metrics-call')]; return els.length ? els[els.length - 1].textContent : ''; })()`);
  const openSettingsModels = async () => {
    await evaluate(ctx, `document.getElementById('open-settings-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    await evaluate(ctx, `(() => { const s = document.getElementById('settings-nav-select'); s.value = 'models'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(ctx, `!!document.getElementById('models-local-add-btn')`, 15000);
  };
  const closeSettings = () => evaluate(ctx, `document.getElementById('close-settings-btn').click(); true`);
  const openChatMenu = async (chatId) => {
    await evaluate(ctx, `(() => {
      const item = document.querySelector('#chat-list .chat-item[data-chat-id=${JSON.stringify(chatId)}]');
      const r = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5 }));
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('chat-context-menu').hidden`);
  };
  const selectChat = async (chatId) => {
    await evaluate(ctx, `document.querySelector('#chat-list .chat-item[data-chat-id=${JSON.stringify(chatId)}]').click(); true`);
    await waitFor(ctx, `appState.activeChatId === ${JSON.stringify(chatId)}`);
  };
  const isPrivateShown = () => evaluate(ctx, `(() => ({
    badge: !!document.querySelector('.chat-private-badge'),
    line: document.getElementById('private-composer-line').hidden ? '' : document.getElementById('private-composer-line').textContent
  }))()`);

  before(async () => {
    server = await startFakeLlmServer();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-local-'));
    const now = new Date().toISOString();
    ctx = await launchApp({
      userDataDir,
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          activeChatId: 'chat-plans',
          chats: [
            chat('chat-plans', 'Garden plans', []),
            chat('chat-notes', 'Lot notes', ['The culvert sits under the north fence.', 'Noted.'])
          ],
          apiStatus: { ollama: { ok: true, message: 'Connected: 1 model.', checkedAt: now, models: ['test-model'] } },
          settings: {
            models: {
              ollama: { baseUrl: `${server.url}/ollama` },
              overrides: { 'ollama:test-model': { toolCall: true, limits: { context: 200000 } } },
              profiles: [{ id: 'p-main', name: 'Everyday', kind: 'user', roles: { main: [{ provider: 'ollama', model: 'test-model', effort: null }], worker: [], utility: [] } }],
              defaultProfileId: 'p-main'
            }
          }
        }
      }
    });
    await waitFor(ctx, `appState.activeChatId === 'chat-plans'`, 15000);
  });

  after(async () => {
    if (ctx) await closeApp(ctx);
    if (server) await server.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('adds a local server in Settings → Models: this machine, probed, tools yes', async () => {
    await openSettingsModels();
    await waitFor(ctx, `document.getElementById('models-local-list').textContent.includes('No local server yet.')`, 15000);
    await evaluate(ctx, `document.getElementById('models-local-add-btn').click(); true`);
    await waitFor(ctx, `!!document.querySelector('.models-local-add')`);
    const sentences = await evaluate(ctx, `[...document.querySelectorAll('.models-local-add .models-local-sentence')].map((p) => p.textContent)`);
    assert.ok(sentences.some((s) => /cannot tell whether this server sends your text on/.test(s)), JSON.stringify(sentences));
    await evaluate(ctx, `(() => {
      const card = document.querySelector('.models-local-add');
      const inputs = card.querySelectorAll('input[type="text"]');
      inputs[0].value = 'Workstation';
      card.querySelector('select').value = 'openai-compatible';
      inputs[1].value = ${JSON.stringify(`${server.url}/localbox`)};
      inputs[1].dispatchEvent(new Event('input'));
      [...card.querySelectorAll('button')].find((b) => b.textContent === 'Add').click();
      return true;
    })()`);
    await waitFor(ctx, `(() => { const c = document.querySelector('.models-local-card[data-server-id="workstation"]'); return c && c.textContent.includes('test-model') && c.textContent.includes('tools: yes'); })()`, 30000);
    const card = await evaluate(ctx, `document.querySelector('.models-local-card[data-server-id="workstation"]').textContent`);
    assert.match(card, /Workstation/);
    assert.match(card, /Pinned to 127\.0\.0\.1: this machine\./);
    assert.match(card, /private chats can use it/);
    assert.match(await evaluate(ctx, `document.getElementById('models-local-status').textContent`), /^Added\./);
    assert.ok(server.requests.some((r) => r.provider === 'localbox' && r.method === 'GET' && r.path === '/localbox/v1/models'), 'the server was listed');
    await closeSettings();
  });

  it('an ordinary chat\'s turn runs on the hosted model', async () => {
    const before = completions('ollama').length;
    const shown = await metricsCount();
    await send('What should I plant along the north fence?');
    await waitFor(ctx, `document.querySelectorAll('.message-metrics-call').length > ${shown}`, 30000);
    assert.ok(completions('ollama').length > before, 'the hosted side got the turn');
    assert.doesNotMatch(await lastMetrics(), /^local/);
    await settle();
  });

  it('"Make private…" in the chat menu says what was already sent; confirming marks the chat', async () => {
    await openChatMenu('chat-plans');
    const item = await evaluate(ctx, `(() => { const b = document.querySelector('#chat-context-menu [data-action="make-private"]'); return { text: b.textContent, disabled: b.disabled }; })()`);
    assert.deepStrictEqual(item, { text: 'Make private…', disabled: false });
    await evaluate(ctx, `document.querySelector('#chat-context-menu [data-action="make-private"]').click(); true`);
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal .confirm-dialog-before')`, 15000);
    const dialog = await evaluate(ctx, `(() => {
      const card = document.querySelector('.rename-chat-modal .rename-chat-card');
      return { lines: [...card.querySelectorAll('.confirm-dialog-before div')].map((d) => d.textContent), question: card.querySelector('p').textContent };
    })()`);
    assert.strictEqual(dialog.question, 'Make this chat private?');
    assert.ok(dialog.lines.includes('1 reply already sent text to a hosted model (ollama).'), JSON.stringify(dialog.lines));
    assert.ok(dialog.lines.some((l) => l.startsWith('main: ')), `the main role has no local model yet: ${JSON.stringify(dialog.lines)}`);
    assert.ok(dialog.lines.includes('What was already sent stays sent.'));
    assert.ok(dialog.lines.includes('This cannot be undone for this chat.'));
    await evaluate(ctx, `[...document.querySelectorAll('.rename-chat-modal button')].find((b) => b.textContent === 'Confirm').click(); true`);
    await waitFor(ctx, `!!document.querySelector('.chat-private-badge')`, 15000);
    const shown = await isPrivateShown();
    assert.strictEqual(shown.badge, true);
    assert.strictEqual(shown.line, 'Private: model calls stay on your hardware. Tools still send what they send.');
    const stored = readHistoryChats(ctx).find((c) => c.id === 'chat-plans');
    assert.ok(stored, 'the chat is in the store');
  });

  it('with only a hosted model, a turn is refused with its sentence and "Open Models", and nothing is sent', async () => {
    const before = completions('ollama').length;
    const localBefore = completions('localbox').length; // the probe's own calls
    await send('And what about the south side?');
    const text = await waitFor(ctx, `(() => { const b = [...document.querySelectorAll('.message-error-action')].pop(); return b ? b.closest('.message-content').querySelector('p').textContent : null; })()`, 30000);
    assert.match(text, /^This needs a local model, and none in the profile can take it\./);
    assert.strictEqual(await evaluate(ctx, `[...document.querySelectorAll('.message-error-action')].pop().textContent`), 'Open Models');
    await settle();
    // Still there after the chat is drawn again from the store.
    const redrawn = await evaluate(ctx, `(() => { const b = [...document.querySelectorAll('.message-error-action')].pop(); return b ? [b.textContent, b.closest('.message-content').querySelector('p').textContent] : null; })()`);
    assert.ok(redrawn && redrawn[0] === 'Open Models' && redrawn[1].startsWith('This needs a local model'), JSON.stringify(redrawn));
    assert.strictEqual(await evaluate(ctx, `[...document.querySelectorAll('.message.assistant .message-content p')].filter((p) => p.textContent.includes('Nothing was sent to a hosted model')).length`), 1, 'one error row, not two');
    assert.strictEqual(completions('ollama').length, before, 'no hosted request was made');
    assert.strictEqual(completions('localbox').length, localBefore);
  });

  it('"Open Models" leads to the profile, where the local model is placed in main', async () => {
    await evaluate(ctx, `[...document.querySelectorAll('.message-error-action')].pop().click(); true`);
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden && !!document.querySelector('#models-profile-list [data-profile-action="edit"][data-profile-id="p-main"]')`, 15000);
    await evaluate(ctx, `document.querySelector('#models-profile-list [data-profile-action="edit"][data-profile-id="p-main"]').click(); true`);
    await waitFor(ctx, `!!document.querySelector('.models-role-block[data-role="main"] button[data-add-role="main"]')`);
    await evaluate(ctx, `document.querySelector('.models-role-block[data-role="main"] button[data-add-role="main"]').click(); true`);
    const item = await waitFor(ctx, `(() => { const b = document.querySelector('.models-role-block[data-role="main"] .models-picker-item[data-provider="local"]'); return b ? { model: b.dataset.model, text: b.textContent } : null; })()`, 15000);
    assert.strictEqual(item.model, 'workstation/test-model');
    assert.match(item.text, /^test-model \(local · Workstation/);
    await evaluate(ctx, `document.querySelector('.models-role-block[data-role="main"] .models-picker-item[data-provider="local"]').click(); true`);
    await evaluate(ctx, `document.getElementById('models-profile-save-btn').click(); true`);
    await waitFor(ctx, `document.getElementById('models-profile-editor').hidden`, 15000);
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'chat-data.json'), 'utf8')).settings.models.profiles.find((p) => p.id === 'p-main');
    assert.deepStrictEqual(saved.roles.main.map((t) => `${t.provider}:${t.model}`), ['ollama:test-model', 'local:workstation/test-model']);
    await closeSettings();
  });

  it('in the private chat\'s picker the hosted model is disabled and the local one is offered', async () => {
    // The chat header is read again when the chat is drawn again (saving a
    // profile does not redraw it): the owner goes to another chat and back.
    await selectChat('chat-notes');
    await selectChat('chat-plans');
    await waitFor(ctx, `(() => { const s = document.getElementById('chat-main-select'); return s && s.options[0] && s.options[0].textContent === 'Main: test-model'; })()`, 15000);
    const options = await evaluate(ctx, `[...document.getElementById('chat-main-select').options].map((o) => ({ text: o.textContent, disabled: o.disabled }))`);
    assert.strictEqual(options[0].text, 'Main: test-model', JSON.stringify(options));
    const hosted = options.find((o) => o.text.includes(': not local'));
    assert.deepStrictEqual(hosted, { text: 'test-model (profile\'s main): not local', disabled: true });
    assert.ok(options.every((o) => !o.text.includes('Workstation') || !o.disabled), JSON.stringify(options));
  });

  it('a turn is answered by the local model, and its cost line says local', async () => {
    const hostedBefore = completions('ollama').length;
    const localBefore = completions('localbox').length;
    const shown = await metricsCount();
    await send('Which of those needs the least water?');
    await waitFor(ctx, `document.querySelectorAll('.message-metrics-call').length > ${shown}`, 30000);
    assert.match(await lastMetrics(), /^local · \d+ tokens · \$0/);
    await settle();
    assert.ok(completions('localbox').length > localBefore, 'the local server got the turn');
    assert.strictEqual(completions('ollama').length, hostedBefore, 'no hosted request');
    const last = completions('localbox').pop();
    assert.strictEqual(last.body.model, 'test-model');
  });

  it('an ordinary chat cannot link the private chat', async () => {
    await selectChat('chat-notes');
    await openChatMenu('chat-notes');
    await evaluate(ctx, `document.querySelector('#chat-context-menu [data-action="link-chats"]').click(); true`);
    await waitFor(ctx, `!document.getElementById('link-chats-dialog').hidden && !!document.querySelector('#link-chats-list input[value="chat-plans"]')`, 15000);
    const row = await evaluate(ctx, `(() => {
      const box = document.querySelector('#link-chats-list input[value="chat-plans"]');
      const r = box.closest('.link-chats-row');
      return { disabled: box.disabled, why: r.querySelector('.link-chats-refused')?.textContent || '' };
    })()`);
    assert.deepStrictEqual(row, { disabled: true, why: 'A private chat is read only by private chats.' });
    await evaluate(ctx, `document.getElementById('link-chats-cancel-btn').click(); true`);
    await selectChat('chat-plans');
  });

  it('nothing unmarks it, and the mark survives a relaunch', async () => {
    await openChatMenu('chat-plans');
    const items = await evaluate(ctx, `[...document.querySelectorAll('#chat-context-menu .context-menu-item')].filter((b) => !b.hidden).map((b) => ({ action: b.dataset.action, text: b.textContent, disabled: b.disabled }))`);
    const mark = items.find((i) => i.action === 'make-private');
    assert.deepStrictEqual(mark, { action: 'make-private', text: 'Private', disabled: true });
    assert.ok(!items.some((i) => /public|unmark|not private/i.test(i.text)), JSON.stringify(items));
    await evaluate(ctx, `closeContextMenu(); true`);

    const opts = ctx.launchOpts;
    await closeApp(ctx); // the profile dir is the test's, so it stays
    ctx = await launchApp({ ...opts, userDataDir, seed: null });
    await selectChat('chat-plans');
    await waitFor(ctx, `!!document.querySelector('.chat-private-badge')`, 15000);
    assert.strictEqual((await isPrivateShown()).line, 'Private: model calls stay on your hardware. Tools still send what they send.');
  });
});
