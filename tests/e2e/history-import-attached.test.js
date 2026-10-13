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
const { launchAttached, closeApp, evaluate } = require('./helpers');

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
});
