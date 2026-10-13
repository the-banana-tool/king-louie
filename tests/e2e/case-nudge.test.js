// tests/e2e/case-nudge.test.js — history stage H4 (recall spec §9; owner
// ruling R-H4-5): a long chat with no case is offered a case once, by a
// status row with a button; nothing is said to the model.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/case-nudge.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { launchApp, closeApp, evaluate, waitFor, readHistoryChats } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

const NUDGE = 'This chat is getting long. If it is about a task with decisions worth keeping, you can turn it into a case.';
const at = (minute) => new Date(Date.parse('2026-03-01T09:00:00.000Z') + minute * 60000).toISOString();

const SEEDED = {
  id: 'chat-long', title: 'Spring opening', createdAt: at(0), updatedAt: at(10), agentMode: false, sandboxMode: true,
  messages: [
    { id: 'm1', sender: 'user', text: 'We open the Lakeside lot in spring.', timestamp: at(1) },
    { id: 'm2', sender: 'assistant', text: 'Good. What needs doing first?', timestamp: at(2) },
    { id: 'm3', sender: 'user', text: 'The culvert and the parking permits.', timestamp: at(3) },
    { id: 'm4', sender: 'assistant', text: 'Noted, both.', timestamp: at(4) }
  ]
};

// The nudge rows on screen.
const NUDGES = `JSON.stringify([...document.querySelectorAll('#chat-messages .case-nudge')].map((row) => {
  const button = row.querySelector('.case-nudge-btn');
  return { text: row.querySelector('.case-nudge-text').textContent, button: button.textContent, hidden: button.hidden, disabled: button.disabled };
}))`;

describe('E2E: the case nudge', { timeout: 240000, skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let server;

  const nudges = async () => JSON.parse(await evaluate(ctx, NUDGES));
  const send = (text) => evaluate(ctx, `(() => {
    const input = document.getElementById('user-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input'));
    document.getElementById('send-btn').click();
    return true;
  })()`);
  const modelRequests = () => server.requests.filter((r) => r.provider === 'ollama' && r.body && Array.isArray(r.body.messages));

  before(async () => {
    server = await startFakeLlmServer();
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          activeChatId: 'chat-long',
          chats: [SEEDED],
          settings: {
            history: { caseNudgeAfterUserTurns: 3 },
            models: {
              ollama: { baseUrl: `${server.url}/ollama` },
              profiles: [{ id: 'p-local', name: 'Local', kind: 'user', roles: { main: [{ provider: 'ollama', model: 'test-model', effort: null }], worker: [], utility: [] } }],
              defaultProfileId: 'p-local'
            }
          }
        }
      }
    });
    await waitFor(ctx, `document.querySelectorAll('#chat-messages .message').length >= 4`, 20000);
  });

  after(async () => {
    if (ctx) await closeApp(ctx);
    if (server) await server.close();
  });

  it('the third user message brings one row with a button, under the reply', async () => {
    assert.deepStrictEqual(await nudges(), [], 'no row below the threshold');
    await send('Who holds the side gate code?');
    await waitFor(ctx, `document.querySelectorAll('#chat-messages .case-nudge').length > 0`, 30000);
    assert.deepStrictEqual(await nudges(), [{ text: NUDGE, button: 'Make this a case', hidden: false, disabled: false }]);

    const chat = readHistoryChats(ctx).find((c) => c.id === 'chat-long');
    const last = chat.messages[chat.messages.length - 1];
    assert.strictEqual(last.sender, 'status');
    assert.strictEqual(last.meta.action, 'convertToCase');
    assert.strictEqual(chat.messages[chat.messages.length - 2].sender, 'assistant');
    assert.ok(chat.caseNudgedAt, 'the chat is marked');
  });

  it('while a reply runs the button is off; the next turn tells the model nothing and adds no second row', async () => {
    const before = modelRequests().length;
    server.setHold(true);
    await send('And the parking permits?');
    await waitFor(ctx, `(document.querySelector('.message.assistant.streaming .message-content')?.textContent || '').includes('Hello')`, 30000);
    const during = await nudges();
    assert.strictEqual(during.length, 1);
    assert.deepStrictEqual([during[0].hidden, during[0].disabled], [false, true], 'offered, but not while a reply runs');
    await evaluate(ctx, `document.querySelector('.case-nudge-btn').click(); true`);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('chat-case-new-dialog')`), false, 'a click on it opens nothing');

    const closedBefore = server.closedCount();
    await evaluate(ctx, `document.getElementById('stop-btn').click(); true`);
    await server.waitForClosedStream(closedBefore + 1, 10000);
    server.setHold(false);
    await waitFor(ctx, `(() => { const b = document.querySelector('.case-nudge-btn'); return b && !b.disabled; })()`, 20000);
    assert.strictEqual((await nudges()).length, 1, 'never a second row');

    const sent = modelRequests().slice(before);
    assert.ok(sent.length > 0, 'the turn reached the model');
    for (const request of sent) {
      const body = JSON.stringify(request.body);
      assert.ok(!body.includes('getting long') && !body.includes('convertToCase') && !body.includes('turn it into a case'), 'the nudge is not in the prompt');
    }
  });

  it('the button opens "New case" for this chat; once the chat has a case the button is gone', async () => {
    await evaluate(ctx, `document.querySelector('.case-nudge-btn').click(); true`);
    await waitFor(ctx, `!!document.getElementById('chat-case-new-input')`, 20000);
    assert.strictEqual(await evaluate(ctx, `document.getElementById('chat-info-popover').hidden`), false, 'the chat info is open at its case section');
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-input').value = 'Lakeside lot spring opening';
      document.getElementById('chat-case-new-confirm').click();
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('chat-case-new-dialog')`, 30000);
    await waitFor(ctx, `(() => { const s = document.getElementById('chat-case-select'); return s && s.value && s.value !== '__new__'; })()`, 30000);

    const chat = readHistoryChats(ctx).find((c) => c.id === 'chat-long');
    assert.ok(chat.caseId, 'the chat has the case');
    await waitFor(ctx, `[...document.querySelectorAll('.case-nudge-btn')].every((b) => b.hidden)`, 15000);
    const after = await nudges();
    assert.ok(after.length <= 1);
    for (const row of after) assert.strictEqual(row.hidden, true, 'no button for a chat that has a case');
  });
});
