// tests/e2e/models-profiles.test.js
// Models M2 end to end (spec 2026-09-27 §16): the header shows the chat's
// profile and main model; switching main writes the override, says so in the
// chat, and the next send uses it; a new profile is made in the Models tab;
// Retry with… re-sends the last message on the chosen model. The provider is
// Ollama pointed at a local fake server; KL_TEST_MODE keeps fetches off.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

const readChat = (ctx) => {
  const data = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'chat-data.json'), 'utf8'));
  return data.chats.find((c) => c.id === 'chat-1');
};

// Polls the profile's chat file from the test process (a status message is
// persisted by the main process; how the renderer draws it is not the point).
async function waitUntil(fn, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fn()) return;
    } catch {
      // the file is being rewritten; read it again
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

describe('E2E: profiles, the main switcher and Retry with…', () => {
  let ctx;
  let server;

  before(async () => {
    server = await startFakeLlmServer();
    const now = new Date().toISOString();
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          activeChatId: 'chat-1',
          chats: [{ id: 'chat-1', title: 'Test chat', createdAt: now, updatedAt: now, messages: [] }],
          apiStatus: { ollama: { ok: true, message: 'Connected: 2 models.', checkedAt: now, models: ['test-model', 'vision-model'] } },
          settings: {
            models: {
              ollama: { baseUrl: `${server.url}/ollama` },
              profiles: [{ id: 'p-local', name: 'Local', kind: 'user', roles: { main: [{ provider: 'ollama', model: 'test-model', effort: null }], worker: [], utility: [] } }],
              defaultProfileId: 'p-local'
            }
          }
        }
      }
    });
    await waitFor(ctx, `!!document.getElementById('user-input')`);
  });

  after(async () => {
    if (ctx) await closeApp(ctx);
    if (server) await server.close();
  });

  it('shows the chat\'s profile and main model in the header', async () => {
    await waitFor(ctx, `!document.getElementById('chat-models-switcher').hidden`);
    const text = await waitFor(ctx, `(() => { const s = document.getElementById('chat-main-select'); const t = s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : ''; return t.includes('test-model') ? t : null; })()`);
    assert.match(text, /^Main: test-model/);
    const profile = await evaluate(ctx, `document.getElementById('chat-profile-select').selectedOptions[0].textContent`);
    assert.strictEqual(profile, 'Default profile (Local)');
  });

  it('switching main writes the override, says so, and the next send uses it', async () => {
    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-main-select');
      const opt = [...s.options].find((o) => o.value.includes('vision-model'));
      s.value = opt.value;
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('chat-main-override-marker').hidden`);
    await waitUntil(() => readChat(ctx).messages.some((m) => m.sender === 'status' && m.text === 'Main model switched from test-model to vision-model'));
    assert.deepStrictEqual(readChat(ctx).mainOverride, { provider: 'ollama', model: 'vision-model', effort: null });

    const before = server.requests.length;
    await evaluate(ctx, `(() => {
      const input = document.getElementById('user-input');
      input.value = 'Say hello';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `!!document.getElementById('retry-with-btn')`, 30000);
    const chatCalls = server.requests.slice(before).filter((r) => r.provider === 'ollama' && r.method === 'POST');
    assert.ok(chatCalls.length > 0, 'the fake Ollama answered');
    assert.strictEqual(chatCalls[chatCalls.length - 1].body.model, 'vision-model');
  });

  it('Retry with… re-sends the last message on the chosen model', async () => {
    const before = server.requests.length;
    await evaluate(ctx, `document.getElementById('retry-with-btn').click(); true`);
    await waitFor(ctx, `(document.getElementById('retry-with-select')?.options.length || 0) > 1`);
    await evaluate(ctx, `(() => {
      const s = document.getElementById('retry-with-select');
      const opt = [...s.options].find((o) => o.value.includes('"test-model"'));
      s.value = opt.value;
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `(() => { const s = document.getElementById('chat-main-select'); return s && s.options[s.selectedIndex] && s.options[s.selectedIndex].textContent.startsWith('Main: test-model'); })()`, 30000);
    await waitFor(ctx, `!!document.getElementById('retry-with-btn')`, 30000);
    const chat = readChat(ctx);
    assert.strictEqual(chat.messages.filter((m) => m.sender === 'user' && m.text === 'Say hello').length, 1, 'the message was re-sent, not duplicated');
    const chatCalls = server.requests.slice(before).filter((r) => r.provider === 'ollama' && r.method === 'POST');
    assert.strictEqual(chatCalls[chatCalls.length - 1].body.model, 'test-model');
  });

  it('disables the header selects while a turn is running, so a mid-turn pick cannot wipe the reply (fix round 1)', async () => {
    server.setHold(true);
    await evaluate(ctx, `(() => {
      const input = document.getElementById('user-input');
      input.value = 'Hold this one';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `(document.querySelector('.message.assistant.streaming .message-content')?.textContent || '').includes('Hello')`, 30000);
    const disabled = await evaluate(ctx, `document.getElementById('chat-profile-select').disabled === true && document.getElementById('chat-main-select').disabled === true`);
    assert.strictEqual(disabled, true, 'the header selects are disabled while the turn is running');

    // The select is disabled, but a stray programmatic change (not a real
    // click, which a disabled control refuses) is guarded in the handler
    // too: it must not call switchMainModel and wipe the live stream.
    const stillStreaming = await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-main-select');
      const opt = [...s.options].find((o) => o.value.includes('vision-model'));
      if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change')); }
      return !!document.querySelector('.message.assistant.streaming');
    })()`);
    assert.strictEqual(stillStreaming, true, 'the streaming node survives a stray change event mid-turn');

    const closedBefore = server.closedCount();
    await evaluate(ctx, `document.getElementById('stop-btn').click(); true`);
    await server.waitForClosedStream(closedBefore + 1, 10000);
    await waitFor(ctx, `document.getElementById('chat-profile-select').disabled === false && document.getElementById('chat-main-select').disabled === false`, 15000);
    server.setHold(false);
  });

  it('creates a profile in the Models tab', async () => {
    await evaluate(ctx, `document.getElementById('open-settings-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    await evaluate(ctx, `(() => { const s = document.getElementById('settings-nav-select'); s.value = 'models'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(ctx, `document.querySelectorAll('#models-profile-list .models-profile-card').length === 1`);
    await evaluate(ctx, `document.getElementById('models-new-profile-btn').click(); true`);
    await evaluate(ctx, `(() => { const i = document.getElementById('models-profile-name'); i.value = 'Second'; i.dispatchEvent(new Event('input')); return true; })()`);
    await evaluate(ctx, `document.querySelector('[data-add-role="main"]').click(); true`);
    await waitFor(ctx, `!!document.querySelector('.models-picker-item[data-model="test-model"]')`);
    await evaluate(ctx, `document.querySelector('.models-picker-item[data-model="test-model"]').click(); true`);
    await evaluate(ctx, `document.getElementById('models-profile-save-btn').click(); true`);
    await waitFor(ctx, `document.querySelectorAll('#models-profile-list .models-profile-card').length === 2`);
    const data = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'chat-data.json'), 'utf8'));
    const second = data.settings.models.profiles.find((p) => p.name === 'Second');
    assert.deepStrictEqual(second.roles.main, [{ provider: 'ollama', model: 'test-model', effort: null }]);
    await evaluate(ctx, `document.getElementById('close-settings-btn').click(); true`);
  });
});
