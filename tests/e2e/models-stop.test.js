// tests/e2e/models-stop.test.js
// Models M1 end to end (spec 2026-09-27 §16): a fresh profile shows the
// bundled catalog (KL_TEST_MODE keeps the live fetch off), and Stop during a
// streamed reply from a fake provider (Ollama pointed at a local server)
// cancels the request and keeps the partial reply, marked stopped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

describe('E2E: model catalog and Stop', () => {
  let ctx;
  let server;

  before(async () => {
    server = await startFakeLlmServer();
    server.setHold(true);
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
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

  it('a fresh profile shows the bundled snapshot catalog', async () => {
    await evaluate(ctx, `document.getElementById('open-settings-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    const text = await waitFor(ctx, `(() => { const t = document.getElementById('models-catalog-status')?.textContent || ''; return t.includes('bundled snapshot') ? t : null; })()`);
    assert.match(text, /\d+ models/);
    await evaluate(ctx, `document.getElementById('close-settings-btn').click(); true`);
  });

  it('Stop during a streamed reply cancels the request and keeps the partial reply, marked stopped', async () => {
    await evaluate(ctx, `(() => {
      const input = document.getElementById('user-input');
      input.value = 'Say hello';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `(document.querySelector('.message.assistant.streaming .message-content')?.textContent || '').includes('Hello')`, 30000);
    const before = server.closedCount();
    await evaluate(ctx, `document.getElementById('stop-btn').click(); true`);
    await server.waitForClosedStream(before + 1, 10000);
    await waitFor(ctx, `!!document.querySelector('.message.assistant .message-stopped-marker')`, 15000);

    const data = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'chat-data.json'), 'utf8'));
    const chat = data.chats.find((c) => c.id === data.activeChatId) || data.chats[0];
    const last = chat.messages[chat.messages.length - 1];
    assert.strictEqual(last.sender, 'assistant');
    assert.strictEqual(last.text, 'Hello');
    assert.strictEqual(last.stopped, true);
    assert.strictEqual(last.llm.calls[0].usagePartial, true);
    assert.strictEqual(last.llm.calls[0].costUsd, null);
    const sendVisible = await evaluate(ctx, `!document.getElementById('send-btn').hidden`);
    assert.strictEqual(sendVisible, true, 'Send comes back after Stop');
  });
});
