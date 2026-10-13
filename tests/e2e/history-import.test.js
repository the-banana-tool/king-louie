// tests/e2e/history-import.test.js — history stage H4 (recall spec §10.2):
// the import dialog on a standalone desktop, for each of the three kinds of
// file, a file already imported, and the refusals.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/history-import.test.js
//
// A test cannot drive a native open-file dialog, so the app takes
// KL_TEST_IMPORT_FILE as the picked path, only under KL_TEST_MODE (see
// createPickImportFile in src/ipc/import-picks.js). It is read at each pick,
// so a test names its file by setting it in the app's main process.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor, readHistoryChats } = require('./helpers');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'history');
const WARNING = 'This conversation becomes a chat that recall can search. If it contains passwords or keys, they become searchable too, and can be shown to the chat model. Its text is never sent to an embedding service or to typesafe.ai.';

// The dialog as the owner sees it.
const DIALOG = `(() => {
  const d = document.getElementById('import-chat-dialog');
  const shown = (el) => (el && !el.hidden ? el.textContent : '');
  const commit = document.getElementById('import-chat-commit-btn');
  const open = document.getElementById('import-chat-open-btn');
  return {
    hidden: d.hidden,
    rows: Object.fromEntries([...d.querySelectorAll('.import-chat-row')].map((r) => [r.querySelector('.import-chat-label').textContent, r.querySelector('.import-chat-value')?.textContent ?? r.querySelector('select')?.value ?? ''])),
    senders: [...d.querySelectorAll('.import-chat-sample')].map((s) => s.previousElementSibling.textContent),
    samples: [...d.querySelectorAll('.import-chat-sample')].map((s) => s.textContent),
    headings: [...d.querySelectorAll('.import-chat-heading')].map((s) => s.textContent),
    warning: shown(document.getElementById('import-chat-warning')),
    noCase: shown(document.getElementById('import-chat-no-case')),
    state: shown(document.getElementById('import-chat-state')),
    error: shown(document.getElementById('import-chat-error')),
    commit: { hidden: commit.hidden, disabled: commit.disabled, text: commit.textContent },
    openHidden: open.hidden
  };
})()`;

describe('E2E: importing a conversation', { timeout: 240000 }, () => {
  let ctx;
  let tmp;

  const pickNext = (file) => ctx.electronApp.evaluate((_electron, f) => { process.env.KL_TEST_IMPORT_FILE = f; }, file);
  const dialog = () => evaluate(ctx, DIALOG);
  const closed = () => waitFor(ctx, `document.getElementById('import-chat-dialog').hidden`, 30000);
  const openDialog = async (file) => {
    // A dialog an earlier, failed test left open would hide this one's file.
    await evaluate(ctx, `document.getElementById('import-chat-dialog').hidden || document.getElementById('import-chat-cancel-btn').click(); true`);
    await closed();
    await pickNext(file);
    await evaluate(ctx, `document.getElementById('import-chat-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('import-chat-dialog').hidden`, 20000);
    return dialog();
  };
  const click = (id) => evaluate(ctx, `document.getElementById(${JSON.stringify(id)}).click(); true`);
  const activeChat = async () => JSON.parse(await evaluate(ctx, `(() => {
    const c = appState.chats.find((x) => x.id === appState.activeChatId);
    return JSON.stringify(c ? { id: c.id, title: c.title, messages: Array.isArray(c.messages) ? c.messages.length : null } : null);
  })()`));
  // Imports one fixture through the dialog and returns the chat it became.
  const importThroughDialog = async (file) => {
    const before = new Set(readHistoryChats(ctx).map((c) => c.id));
    await click('import-chat-commit-btn');
    await closed();
    await waitFor(ctx, `!${JSON.stringify([...before])}.includes(appState.activeChatId) && !!appState.activeChatId`, 20000);
    const chat = await activeChat();
    const stored = readHistoryChats(ctx).find((c) => c.id === chat.id);
    assert.ok(stored, `the chat imported from ${path.basename(file)} is in the store`);
    return { chat, stored };
  };

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-import-'));
    ctx = await launchApp();
  });

  after(async () => {
    if (ctx) await closeApp(ctx);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a Claude Code session: the preview, the warning, and the chat it becomes', async () => {
    const file = path.join(FIXTURES, 'claude-code-session.jsonl');
    const shown = await openDialog(file);
    assert.strictEqual(shown.rows.File, 'claude-code-session.jsonl');
    assert.strictEqual(shown.rows.Kind, 'Claude Code session');
    assert.strictEqual(shown.rows.Length, '2 turns');
    assert.ok(shown.rows.Title);
    assert.strictEqual(shown.warning, WARNING);
    assert.strictEqual(shown.noCase, 'An imported chat cannot be attached to a case.');
    assert.strictEqual(shown.error, '');
    assert.strictEqual(shown.state, '');
    assert.deepStrictEqual(shown.commit, { hidden: false, disabled: false, text: 'Import' });
    assert.strictEqual(shown.openHidden, true);
    assert.strictEqual(shown.senders[0], 'User');
    assert.ok(shown.samples[0].includes('staging port'));
    assert.ok(shown.senders.every((w) => ['User', 'Assistant', 'Tool call', 'Tool result', 'Status'].includes(w)), shown.senders.join(', '));

    const { chat, stored } = await importThroughDialog(file);
    assert.strictEqual(chat.title, shown.rows.Title);
    assert.strictEqual(stored.source, 'claude-code-jsonl');
    assert.strictEqual(stored.messages.length, 7);
    const drawn = await waitFor(ctx, `document.querySelectorAll('#chat-messages .message').length`, 15000);
    assert.ok(drawn > 0, 'the imported chat is drawn');
  });

  it('a King Louie export', async () => {
    const file = path.join(FIXTURES, 'king-louie-chat.json');
    const shown = await openDialog(file);
    assert.strictEqual(shown.rows.Kind, 'King Louie export');
    assert.strictEqual(shown.rows.Title, 'Lakeside lot survey');
    assert.strictEqual(shown.warning, WARNING);
    assert.strictEqual(shown.commit.disabled, false);

    const { chat, stored } = await importThroughDialog(file);
    assert.strictEqual(chat.title, 'Lakeside lot survey');
    assert.strictEqual(stored.source, 'king-louie-json');
    // An import never takes the id in the file (R-H4-8 and Decision 11).
    assert.notStrictEqual(stored.id, 'chat-fixture-1');
    assert.strictEqual(stored.llmTotals, undefined, 'chat fields outside the fixed list stay in the file');
  });

  it('a Markdown transcript shows its headings; the same file again opens the chat it became', async () => {
    const file = path.join(FIXTURES, 'markdown-transcript.md');
    const shown = await openDialog(file);
    assert.strictEqual(shown.rows.Kind, 'Markdown transcript');
    assert.strictEqual(shown.rows.Title, 'Lakeside lot planning');
    assert.strictEqual(shown.rows.Length, '10 turns');
    assert.ok(shown.rows.Headings, 'the heading pattern is shown');
    assert.ok(shown.headings.some((h) => h.includes('User')));
    const { chat } = await importThroughDialog(file);

    // Move away, then pick the same file.
    await evaluate(ctx, `document.getElementById('new-chat-btn').click(); true`);
    await waitFor(ctx, `appState.activeChatId !== ${JSON.stringify(chat.id)}`, 15000);
    const again = await openDialog(file);
    assert.strictEqual(again.state, 'This file was already imported.');
    assert.strictEqual(again.commit.hidden, true);
    assert.strictEqual(again.openHidden, false);
    const count = readHistoryChats(ctx).length;
    await click('import-chat-open-btn');
    await closed();
    await waitFor(ctx, `appState.activeChatId === ${JSON.stringify(chat.id)}`, 15000);
    assert.strictEqual(readHistoryChats(ctx).length, count, 'no second chat');
  });

  it('a file that is no transcript: the dialog names it, says why, and offers no Import', async () => {
    const file = path.join(tmp, 'shopping-list.md');
    fs.writeFileSync(file, '# Shopping\n\n- hose timer\n- garden twine\n');
    const count = readHistoryChats(ctx).length;
    const shown = await openDialog(file);
    assert.strictEqual(shown.rows.File, 'shopping-list.md');
    assert.strictEqual(shown.rows.Kind, undefined, 'no preview');
    assert.strictEqual(shown.error, 'This file is not a Claude Code session, a Markdown transcript or a King Louie chat export.');
    assert.strictEqual(shown.commit.disabled, true);
    assert.strictEqual(shown.warning, WARNING);
    // A click on a disabled Import does nothing.
    await click('import-chat-commit-btn');
    await click('import-chat-cancel-btn');
    await closed();
    assert.strictEqual(readHistoryChats(ctx).length, count);
  });

  it('a commit that is refused leaves the dialog open with the reason', async () => {
    const file = path.join(tmp, 'visit-notes.md');
    fs.writeFileSync(file, `${fs.readFileSync(path.join(FIXTURES, 'markdown-transcript.md'), 'utf8')}\n## User\n\nOne more question about the twine.\n\n## Assistant\n\nIt is in the shed.\n`);
    const count = readHistoryChats(ctx).length;
    const shown = await openDialog(file);
    assert.strictEqual(shown.commit.disabled, false);
    assert.strictEqual(shown.rows.Length, '11 turns');
    // The file goes away between the preview and the click.
    fs.rmSync(file);
    await click('import-chat-commit-btn');
    await waitFor(ctx, `!document.getElementById('import-chat-error').hidden`, 20000);
    const refused = await dialog();
    assert.strictEqual(refused.hidden, false);
    // A file-system error names the path; the renderer is never told it.
    assert.strictEqual(refused.error, 'The file could not be read. Choose it again.');
    assert.deepStrictEqual(refused.commit, { hidden: false, disabled: false, text: 'Import' });
    assert.strictEqual(readHistoryChats(ctx).length, count, 'nothing was stored');
    await click('import-chat-cancel-btn');
    await closed();
  });

  it("R-H4-7: an imported chat is refused a case in the attach flow, before any case exists", async () => {
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
    assert.strictEqual(refusal, "An imported chat cannot be attached to a case; its messages are not verified as the owner's.");
    const cases = JSON.parse(await evaluate(ctx, `window.electron.cases.list().then((r) => JSON.stringify(r))`));
    assert.deepStrictEqual(cases.cases, [], 'no case was created');
    assert.ok(!readHistoryChats(ctx).some((c) => c.caseId), 'no chat was given a case');
    await evaluate(ctx, `document.querySelector('#chat-case-new-dialog .btn:not(.btn-primary)').click(); true`);
    await waitFor(ctx, `!document.getElementById('chat-case-new-dialog')`, 15000);
  });
});
