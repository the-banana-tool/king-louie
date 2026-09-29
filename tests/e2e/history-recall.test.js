// tests/e2e/history-recall.test.js
// Recall end to end (spec §13): a chat with 50 seeded messages on a temp
// data dir (H1's migration moves them into history.sqlite and chunks
// them); a new message is answered from the tail plus recalled excerpts,
// the reply carries `context`, and the recall line renders and opens.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, readHistoryChats } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';

function seededChat() {
  const messages = [];
  for (let i = 1; i <= 50; i += 1) {
    messages.push({
      id: `seed-${i}`,
      sender: i % 2 ? 'user' : 'assistant',
      text: i === 3 ? GATE : `Seeded note ${i} about the weekly grocery list and the garden hose timer.`,
      timestamp: new Date(Date.parse('2026-03-01T09:00:00.000Z') + i * 60000).toISOString()
    });
  }
  return { id: 'chat-seeded', title: 'Seeded chat', createdAt: '2026-03-01T09:00:00.000Z', updatedAt: '2026-03-01T10:00:00.000Z', agentMode: false, sandboxMode: true, messages };
}

describe('E2E: recall', () => {
  let ctx;
  let server;

  before(async () => {
    server = await startFakeLlmServer();
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          activeChatId: 'chat-seeded',
          chats: [seededChat()],
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

  it('answers from the tail plus recalled excerpts and shows the recall line', async () => {
    await waitFor(ctx, `document.querySelectorAll('.message').length > 5`, 20000);
    await evaluate(ctx, `(() => {
      const input = document.getElementById('user-input');
      input.value = 'What was the side gate code at the Lakeside lot?';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    const lineText = await waitFor(ctx, `(() => { const all = document.querySelectorAll('.message.assistant .message-recall-toggle'); return all.length ? all[all.length - 1].textContent : null; })()`, 30000);
    assert.match(lineText, /^recalled \d+ excerpts? · about .+ tokens · from .+ tokens of history · BM25$/);

    const chat = readHistoryChats(ctx).find((c) => c.id === 'chat-seeded');
    const last = chat.messages[chat.messages.length - 1];
    assert.strictEqual(last.sender, 'assistant');
    const context = last.context;
    assert.ok(context, 'the reply carries context');
    assert.deepStrictEqual(context.tail, { fromSeq: 43, toSeq: 50 });
    assert.ok(context.recalledChunkIds.length > 0);
    assert.strictEqual(context.embedder, 'none');
    assert.strictEqual(context.scope, 'chat');

    const sent = server.requests.filter((r) => r.provider === 'ollama' && r.body && Array.isArray(r.body.messages)).pop();
    assert.ok(sent, 'the provider was called');
    assert.ok(sent.body.messages.length <= 10, `sent ${sent.body.messages.length} messages`);
    const system = sent.body.messages.find((m) => m.role === 'system');
    assert.ok(system && system.content.includes('<recalled_history>') && system.content.includes('4417'));

    await evaluate(ctx, `(() => { const all = document.querySelectorAll('.message.assistant .message-recall-toggle'); all[all.length - 1].click(); return true; })()`);
    const drawer = await waitFor(ctx, `(() => { const all = document.querySelectorAll('.message.assistant .recall-drawer'); const t = all.length ? all[all.length - 1].textContent : ''; return t.includes('4417') ? t : null; })()`, 15000);
    assert.match(drawer, /\[#3 · user · /);
  });
});
