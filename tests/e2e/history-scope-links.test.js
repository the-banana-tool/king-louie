// tests/e2e/history-scope-links.test.js — history stage H4 (recall spec
// §10.1): the chat menu's "Recall from" items and "Link chats…", driven as
// the owner drives them, and a reply that recalls from a linked chat.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/history-scope-links.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, readHistoryChats } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';
const at = (minute) => new Date(Date.parse('2026-03-01T09:00:00.000Z') + minute * 60000).toISOString();

function chat(id, title, texts, extra = {}) {
  return {
    id, title, createdAt: at(0), updatedAt: at(30), agentMode: false, sandboxMode: true, ...extra,
    messages: texts.map((text, i) => ({ id: `${id}-m${i + 1}`, sender: i % 2 ? 'assistant' : 'user', text, timestamp: at(i + 1) }))
  };
}

const CHATS = [
  chat('chat-asker', 'Site visit plan', ['Help me plan the site visit for next week.', 'Happy to. Which day suits you?']),
  chat('chat-notes', 'Lot notes', [GATE, 'Noted, the code is 4417.', 'The culvert sits under the north fence.', 'Understood.']),
  chat('chat-case', 'Permit paperwork', ['The permit office opens at nine.', 'Noted.'], { caseId: 'permit-paperwork' }),
  chat('chat-bridge', '\u{1F4F1} Telegram: Visitor (15550100)', ['Hello from the phone.', 'Hello.'])
];

// The menu as the owner sees it.
const MENU = `(() => {
  const menu = document.getElementById('chat-context-menu');
  const items = [...menu.querySelectorAll('[data-action="recall-scope"]')];
  const note = document.getElementById('chat-recall-pin-note');
  return {
    hidden: menu.hidden,
    items: items.map((i) => ({ scope: i.dataset.scope, text: i.textContent, checked: i.getAttribute('aria-checked'), disabled: i.disabled })),
    linkDisabled: menu.querySelector('[data-action="link-chats"]').disabled,
    note: note.hidden ? '' : note.textContent
  };
})()`;

describe('E2E: what a chat recalls from', { timeout: 240000 }, () => {
  let ctx;
  let server;

  // Opens the menu on a chat and waits until history:links.get has painted
  // it (`settled` is a function of the menu, as source text).
  const openMenu = async (chatId, settled) => {
    await evaluate(ctx, `openContextMenu({ chatId: ${JSON.stringify(chatId)}, x: 40, y: 40 }); true`);
    await waitFor(ctx, `(() => { const m = ${MENU}; return (${settled})(m); })()`, 15000);
    return evaluate(ctx, MENU);
  };
  const closeMenu = () => evaluate(ctx, `closeContextMenu(); true`);
  const clickMenu = (selector) => evaluate(ctx, `document.querySelector('#chat-context-menu ${selector}').click(); true`);
  const dialog = () => evaluate(ctx, `(() => {
    const d = document.getElementById('link-chats-dialog');
    const error = document.getElementById('link-chats-error');
    return {
      hidden: d.hidden,
      error: error.hidden ? '' : error.textContent,
      rows: [...d.querySelectorAll('.link-chats-row')].map((row) => {
        const box = row.querySelector('input');
        return { id: box.value, title: row.querySelector('.link-chats-title').textContent, checked: box.checked, disabled: box.disabled, why: row.querySelector('.link-chats-refused')?.textContent || '' };
      })
    };
  })()`);

  before(async () => {
    server = await startFakeLlmServer();
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          activeChatId: 'chat-asker',
          chats: CHATS,
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
    await waitFor(ctx, `document.querySelectorAll('.chat-item').length === ${CHATS.length}`, 20000);
  });

  after(async () => {
    if (ctx) await closeApp(ctx);
    if (server) await server.close();
  });

  it('the menu marks "this chat" for a new chat and offers the wider scopes', async () => {
    const menu = await openMenu('chat-asker', '(m) => !m.items[0].disabled');
    assert.deepStrictEqual(menu.items, [
      { scope: 'chat', text: 'Recall from: this chat', checked: 'true', disabled: false },
      { scope: 'linked', text: 'Recall from: linked chats (0)', checked: 'false', disabled: false },
      { scope: 'all', text: 'Recall from: all chats', checked: 'false', disabled: false }
    ]);
    assert.strictEqual(menu.linkDisabled, false);
    assert.strictEqual(menu.note, '');
    await closeMenu();
  });

  it('a case chat and a bridge chat are pinned, and the menu says why', async () => {
    const caseMenu = await openMenu('chat-case', '(m) => m.note !== ""');
    assert.strictEqual(caseMenu.note, 'A case chat recalls only from itself.');
    assert.deepStrictEqual(caseMenu.items.map((i) => i.disabled), [false, true, true]);
    assert.strictEqual(caseMenu.items[0].checked, 'true');
    assert.strictEqual(caseMenu.linkDisabled, true);
    await closeMenu();

    const bridgeMenu = await openMenu('chat-bridge', '(m) => m.note !== ""');
    assert.strictEqual(bridgeMenu.note, 'A Telegram or Discord chat recalls only from itself.');
    assert.deepStrictEqual(bridgeMenu.items.map((i) => i.disabled), [false, true, true]);
    assert.strictEqual(bridgeMenu.linkDisabled, true);
    await closeMenu();
  });

  it('a chat whose links cannot be read is offered nothing, and the menu says so', async () => {
    const menu = await openMenu('chat-that-is-gone', '(m) => m.note !== ""');
    assert.strictEqual(menu.note, 'Chat not found.');
    assert.deepStrictEqual(menu.items.map((i) => i.disabled), [true, true, true]);
    assert.strictEqual(menu.linkDisabled, true);
    await closeMenu();
  });

  it('"Link chats…" lists the other chats; a case chat cannot be ticked, and a refused save stays on screen', async () => {
    await openMenu('chat-asker', '(m) => !m.linkDisabled');
    await clickMenu('[data-action="link-chats"]');
    await waitFor(ctx, `!document.getElementById('link-chats-dialog').hidden`, 15000);
    const shown = await dialog();
    const byId = Object.fromEntries(shown.rows.map((r) => [r.id, r]));
    assert.deepStrictEqual(Object.keys(byId).sort(), ['chat-bridge', 'chat-case', 'chat-notes']);
    assert.deepStrictEqual(byId['chat-notes'], { id: 'chat-notes', title: 'Lot notes', checked: false, disabled: false, why: '' });
    assert.deepStrictEqual(byId['chat-case'], { id: 'chat-case', title: 'Permit paperwork', checked: false, disabled: true, why: 'A case chat cannot be linked.' });
    // R-H4-7: a bridge chat may be linked explicitly.
    assert.strictEqual(byId['chat-bridge'].disabled, false);

    // The dialog never sends a box that is disabled. To see the refusal of
    // history:links.set on screen, the box is enabled by hand here (the page
    // altered, as only a test can): the save is refused and nothing is stored.
    await evaluate(ctx, `(() => {
      const box = document.querySelector('#link-chats-list input[value="chat-case"]');
      box.disabled = false;
      box.checked = true;
      document.getElementById('link-chats-save-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('link-chats-error').hidden`, 15000);
    const refused = await dialog();
    assert.strictEqual(refused.hidden, false, 'the dialog stays open');
    assert.strictEqual(refused.error, 'That chat cannot be linked.');
    const stored = JSON.parse(await evaluate(ctx, `window.electron.history.getLinks({ chatId: 'chat-asker' }).then((r) => JSON.stringify(r))`));
    assert.deepStrictEqual(stored.links, []);
    assert.strictEqual(stored.scope, 'chat');

    // The owner's real choice: the notes chat.
    await evaluate(ctx, `(() => {
      const refusedBox = document.querySelector('#link-chats-list input[value="chat-case"]');
      refusedBox.checked = false;
      refusedBox.disabled = true;
      document.querySelector('#link-chats-list input[value="chat-notes"]').checked = true;
      document.getElementById('link-chats-save-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `document.getElementById('link-chats-dialog').hidden`, 15000);
    const notice = await waitFor(ctx, `[...document.querySelectorAll('.kl-notice')].map((n) => n.textContent).find((t) => t.includes('linked chats')) || null`, 15000);
    assert.strictEqual(notice, 'This chat now recalls from its linked chats.');

    const menu = await openMenu('chat-asker', '(m) => m.items[1].checked === "true"');
    assert.strictEqual(menu.items[1].text, 'Recall from: linked chats (1)');
    assert.strictEqual(menu.items[0].checked, 'false');
    await closeMenu();
  });

  it('a reply recalls from the linked chat; the recall line names the scope and the drawer the chat', async () => {
    await evaluate(ctx, `(() => {
      const input = document.getElementById('user-input');
      input.value = 'What was the side gate code at the Lakeside lot?';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    const lineText = await waitFor(ctx, `(() => { const all = document.querySelectorAll('.message.assistant .message-recall-toggle'); return all.length ? all[all.length - 1].textContent : null; })()`, 30000);
    assert.match(lineText, /^recalled \d+ excerpts? · about .+ tokens · from .+ tokens of history · linked chats · BM25$/);

    const asker = readHistoryChats(ctx).find((c) => c.id === 'chat-asker');
    const last = asker.messages[asker.messages.length - 1];
    assert.strictEqual(last.sender, 'assistant');
    assert.strictEqual(last.context.scope, 'linked');
    assert.deepStrictEqual(last.context.recalledChats, ['chat-notes']);
    assert.ok(!last.context.scopePinned);

    const sent = server.requests.filter((r) => r.provider === 'ollama' && r.body && Array.isArray(r.body.messages)).pop();
    const system = sent.body.messages.find((m) => m.role === 'system');
    assert.ok(system.content.includes('[chat "Lot notes"'), 'the excerpt header names the other chat');
    assert.ok(system.content.includes('4417'));
    assert.ok(!system.content.includes('permit office'), 'the case chat is never read');

    await evaluate(ctx, `(() => { const all = document.querySelectorAll('.message.assistant .message-recall-toggle'); all[all.length - 1].click(); return true; })()`);
    const other = await waitFor(ctx, `(() => {
      const item = document.querySelector('.message.assistant .recall-drawer .recall-excerpt-other-chat');
      return item ? JSON.stringify({ header: item.querySelector('.recall-excerpt-header').textContent, text: item.querySelector('.recall-excerpt-text').textContent }) : null;
    })()`, 15000);
    const excerpt = JSON.parse(other);
    assert.match(excerpt.header, /^\[chat "Lot notes" · #\d+ · /);
    assert.ok(excerpt.text.includes('4417') || excerpt.text.includes('culvert'));
  });

  it('"Recall from: all chats" is one click, and "this chat" puts it back', async () => {
    await openMenu('chat-asker', '(m) => !m.items[2].disabled');
    await clickMenu('[data-scope="all"]');
    const all = await openMenu('chat-asker', '(m) => m.items[2].checked === "true"');
    assert.deepStrictEqual(all.items.map((i) => i.checked), ['false', 'false', 'true']);
    await clickMenu('[data-scope="chat"]');
    const back = await openMenu('chat-asker', '(m) => m.items[0].checked === "true"');
    // The link is kept; it is not read while the scope is "this chat".
    assert.strictEqual(back.items[1].text, 'Recall from: linked chats (1)');
    await closeMenu();
  });

  it("R-H4-1: the chat that read another chat is refused a case in the attach flow, before any case exists", async () => {
    await evaluate(ctx, `document.getElementById('chat-info-popover').hidden && document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.getElementById('chat-case-select')`, 20000);
    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      s.value = '__new__';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!!document.getElementById('chat-case-new-input')`, 20000);
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-input').value = 'Lakeside lot spring opening';
      document.getElementById('chat-case-new-confirm').click();
      return true;
    })()`);
    const refusal = await waitFor(ctx, `(() => { const e = document.getElementById('chat-case-new-error'); return e && !e.hidden ? e.textContent : null; })()`, 20000);
    assert.strictEqual(refusal, "This chat has read other chats, so it cannot be attached to a case. Start a new chat for the case.");
    const cases = JSON.parse(await evaluate(ctx, `window.electron.cases.list().then((r) => JSON.stringify(r))`));
    assert.deepStrictEqual(cases.cases, [], 'no case was created');
    assert.ok(!readHistoryChats(ctx).some((c) => c.caseId && c.id !== 'chat-case'), 'no chat was given a case');
    await evaluate(ctx, `document.querySelector('#chat-case-new-dialog .btn:not(.btn-primary)').click(); true`);
    await waitFor(ctx, `!document.getElementById('chat-case-new-dialog')`, 15000);
  });
});
