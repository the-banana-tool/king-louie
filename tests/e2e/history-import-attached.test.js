// tests/e2e/history-import-attached.test.js — history stage H4, owner ruling
// R-H4-3: attached, the desktop parses the picked file and the service stores
// the chat.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/history-import-attached.test.js
//
// A test cannot drive a native open-file dialog, so the app takes
// KL_TEST_IMPORT_FILE as the picked path, only under KL_TEST_MODE (which
// every e2e launch sets; see createPickImportFile in src/ipc/import-picks.js).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { launchAttached, closeApp, evaluate, waitFor } = require('./helpers');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'history', 'markdown-transcript.md');
const TITLE = 'Lakeside lot planning';

describe('E2E: importing a conversation while attached', { timeout: 240000 }, () => {
  let ctx;

  before(async () => {
    ctx = await launchAttached({ env: { KL_TEST_IMPORT_FILE: FIXTURE } });
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('R-H4-3: the picked transcript becomes a chat in the service, found by search', async () => {
    const picked = JSON.parse(await evaluate(ctx, `window.electron.history.pickImport().then((r) => JSON.stringify(r))`));
    assert.strictEqual(picked.ok, true);
    assert.strictEqual(picked.name, 'markdown-transcript.md');
    assert.ok(!JSON.stringify(picked).includes('fixtures'), 'the renderer is never told the path');
    const token = JSON.stringify(picked.token);

    const preview = JSON.parse(await evaluate(ctx, `window.electron.history.previewImport({ token: ${token} }).then((r) => JSON.stringify(r))`));
    assert.strictEqual(preview.ok, true);
    assert.strictEqual(preview.kind, 'markdown-transcript');
    assert.strictEqual(preview.title, TITLE);
    assert.strictEqual(preview.existingChatId, null);
    assert.strictEqual(preview.serviceUnreachable, undefined);

    const committed = JSON.parse(await evaluate(ctx, `window.electron.history.commitImport({ token: ${token} }).then((r) => JSON.stringify(r))`));
    assert.strictEqual(committed.ok, true, JSON.stringify(committed));
    assert.strictEqual(committed.imported, true);
    assert.strictEqual(committed.messages, 20);
    const chatId = JSON.stringify(committed.chatId);

    // The chat is the service's: the chat list comes over the bridge.
    const list = await evaluate(ctx, `window.electron.chat.load().then((r) => JSON.stringify(r))`);
    assert.ok(list.includes(committed.chatId), 'the imported chat is in the chat list');
    assert.ok(list.includes(TITLE), 'with the transcript\'s title');

    const found = JSON.parse(await evaluate(ctx, `window.electron.history.search({ chatId: ${chatId}, query: 'culvert' }).then((r) => JSON.stringify(r))`));
    assert.strictEqual(found.ok, true, JSON.stringify(found));
    assert.ok(found.excerpts.length > 0);
    assert.ok(found.excerpts.some((e) => /culvert/i.test(e.text)));

    // The same file again is the same chat, and its token was spent.
    const spent = JSON.parse(await evaluate(ctx, `window.electron.history.commitImport({ token: ${token} }).then((r) => JSON.stringify(r))`));
    assert.strictEqual(spent.code, 'IMPORT_NO_FILE');
    const again = JSON.parse(await evaluate(ctx, `window.electron.history.pickImport().then((p) => window.electron.history.commitImport({ token: p.token })).then((r) => JSON.stringify(r))`));
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.imported, false);
    assert.strictEqual(again.chatId, committed.chatId);
  });

  // The same dialog and menu as on a standalone desktop, over the bridge.
  const pickNext = (file) => ctx.electronApp.evaluate((_electron, f) => { process.env.KL_TEST_IMPORT_FILE = f; }, file);
  const importDialog = () => evaluate(ctx, `(() => {
    const d = document.getElementById('import-chat-dialog');
    const shown = (el) => (el && !el.hidden ? el.textContent : '');
    const commit = document.getElementById('import-chat-commit-btn');
    return {
      hidden: d.hidden,
      rows: Object.fromEntries([...d.querySelectorAll('.import-chat-row')].map((r) => [r.querySelector('.import-chat-label').textContent, r.querySelector('.import-chat-value')?.textContent ?? ''])),
      state: shown(document.getElementById('import-chat-state')),
      error: shown(document.getElementById('import-chat-error')),
      commit: { hidden: commit.hidden, disabled: commit.disabled }
    };
  })()`);
  const serviceChats = async () => JSON.parse(await evaluate(ctx, `window.electron.history.getLinks({ chatId: appState.activeChatId }).then((r) => JSON.stringify(r))`));

  it('the import dialog, attached: a Claude Code session is previewed here and stored by the service', async () => {
    await pickNext(path.join(__dirname, '..', 'fixtures', 'history', 'claude-code-session.jsonl'));
    await evaluate(ctx, `document.getElementById('import-chat-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('import-chat-dialog').hidden`, 20000);
    const shown = await importDialog();
    assert.strictEqual(shown.rows.File, 'claude-code-session.jsonl');
    assert.strictEqual(shown.rows.Kind, 'Claude Code session');
    assert.strictEqual(shown.rows.Length, '2 turns');
    assert.strictEqual(shown.state, '');
    assert.deepStrictEqual(shown.commit, { hidden: false, disabled: false });

    await evaluate(ctx, `document.getElementById('import-chat-commit-btn').click(); true`);
    await waitFor(ctx, `document.getElementById('import-chat-dialog').hidden`, 30000);
    // The new chat is selected, and it is the service's.
    const title = JSON.stringify(shown.rows.Title);
    await waitFor(ctx, `(() => { const c = appState.chats.find((x) => x.id === appState.activeChatId); return c && c.title === ${title}; })()`, 20000);
    const list = await evaluate(ctx, `window.electron.chat.load().then((r) => JSON.stringify(r))`);
    assert.ok(list.includes(shown.rows.Title));
    assert.ok(list.includes(TITLE), 'beside the transcript imported before');
  });

  it('scope and links, attached: the menu and "Link chats…" act on the store of the service', async () => {
    const asker = await evaluate(ctx, `appState.activeChatId`);
    const before = await serviceChats();
    assert.strictEqual(before.ok, true, JSON.stringify(before));
    assert.strictEqual(before.effectiveScope, 'chat');
    const other = before.candidates.find((c) => c.title === TITLE);
    assert.ok(other && other.allowed, 'the Markdown transcript can be linked');

    await evaluate(ctx, `openContextMenu({ chatId: ${JSON.stringify(asker)}, x: 40, y: 40 }); true`);
    await waitFor(ctx, `!document.querySelector('#chat-context-menu [data-action="link-chats"]').disabled`, 15000);
    await evaluate(ctx, `document.querySelector('#chat-context-menu [data-action="link-chats"]').click(); true`);
    await waitFor(ctx, `!document.getElementById('link-chats-dialog').hidden`, 15000);
    await evaluate(ctx, `(() => {
      document.querySelector('#link-chats-list input[value=' + JSON.stringify(${JSON.stringify(other.id)}) + ']').checked = true;
      document.getElementById('link-chats-save-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `document.getElementById('link-chats-dialog').hidden`, 15000);
    const notice = await waitFor(ctx, `[...document.querySelectorAll('.kl-notice')].map((n) => n.textContent).find((t) => t.includes('linked chats')) || null`, 15000);
    assert.strictEqual(notice, 'This chat now recalls from its linked chats.');

    const after = await serviceChats();
    assert.strictEqual(after.scope, 'linked');
    assert.strictEqual(after.effectiveScope, 'linked');
    assert.deepStrictEqual(after.links.map((l) => l.id), [other.id]);

    await evaluate(ctx, `openContextMenu({ chatId: ${JSON.stringify(asker)}, x: 40, y: 40 }); true`);
    const item = await waitFor(ctx, `(() => { const i = document.querySelector('#chat-context-menu [data-scope="linked"]'); return i.getAttribute('aria-checked') === 'true' ? i.textContent : null; })()`, 15000);
    assert.strictEqual(item, 'Recall from: linked chats (1)');
    await evaluate(ctx, `closeContextMenu(); true`);

    // The service searches what the scope allows: the linked chat's text.
    const found = JSON.parse(await evaluate(ctx, `window.electron.history.search({ chatId: ${JSON.stringify(asker)}, query: 'culvert' }).then((r) => JSON.stringify(r))`));
    assert.strictEqual(found.ok, true, JSON.stringify(found));
    assert.ok(found.excerpts.some((e) => /culvert/i.test(e.text) && e.chatTitle === TITLE), 'an excerpt of the linked chat, named by its title');
  });

  it('with the service gone the dialog still previews the file, and says the chat cannot be imported now', async () => {
    await ctx.service.kill();
    await waitFor(ctx, `window.electron.desktop.status().then((s) => s.view !== 'attached-connected')`, 30000);
    await pickNext(path.join(__dirname, '..', 'fixtures', 'history', 'king-louie-chat.json'));
    await evaluate(ctx, `document.getElementById('import-chat-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('import-chat-dialog').hidden`, 30000);
    const shown = await importDialog();
    assert.strictEqual(shown.rows.Kind, 'King Louie export');
    assert.strictEqual(shown.rows.Title, 'Lakeside lot survey');
    assert.strictEqual(shown.state, 'The service is not reachable; the preview is shown, but the chat cannot be imported now.');
    assert.deepStrictEqual(shown.commit, { hidden: false, disabled: true });
    await evaluate(ctx, `document.getElementById('import-chat-cancel-btn').click(); true`);
    await waitFor(ctx, `document.getElementById('import-chat-dialog').hidden`, 15000);
  });
});
