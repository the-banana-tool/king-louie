// tests/history-ipc-import.test.js
// Import IPC (recall spec §12, stage H4; owner ruling R-H4-3): the file is
// picked in the main process and named to the renderer only by a token; the
// batch channels take a chat that is already parsed, never a path, and hold
// it to the same key lists and caps as a local import.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const IPC = require('../src/ipc/constants');
const { registerHistoryHandlers } = require('../src/ipc/history-handlers');
const { createImportPicks } = require('../src/ipc/import-picks');
const { createImportGate, hashFile, parseImport } = require('../src/history/import-chats');
const { setLogLevel } = require('../src/logging');
const { openTempStore, seedChat } = require('./helpers/history-fixture');

setLogLevel('fatal');

const FIXTURES = path.join(__dirname, 'fixtures', 'history');
const CLAUDE_CODE = path.join(FIXTURES, 'claude-code-session.jsonl');
const MARKDOWN = path.join(FIXTURES, 'markdown-transcript.md');
const KING_LOUIE = path.join(FIXTURES, 'king-louie-chat.json');
const HASH = 'c'.repeat(64);
const MINUTE = 60 * 1000;

describe('createImportPicks', () => {
  it('names a picked file by a token and its base name; a cancelled dialog gives nothing', async () => {
    const answers = [MARKDOWN, null, '', 42];
    const picks = createImportPicks({ pickFile: async () => answers.shift() });
    const first = await picks.pick();
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.untrustedText, true);
    assert.match(first.token, /^[0-9a-f]{32}$/);
    assert.strictEqual(first.name, 'markdown-transcript.md');
    assert.deepStrictEqual(Object.keys(first).sort(), ['name', 'ok', 'token', 'untrustedText'], 'no path in the reply');
    assert.strictEqual(picks.pathFor(first.token), MARKDOWN);
    for (let i = 0; i < 3; i += 1) assert.deepStrictEqual(await picks.pick(), { ok: false, canceled: true });
    assert.strictEqual(picks.pathFor('no-such-token'), null);
    assert.strictEqual(picks.pathFor(undefined), null);
    assert.strictEqual(picks.pathFor({ toString: () => first.token }), null);
    picks.spend(first.token);
    assert.strictEqual(picks.pathFor(first.token), null);
  });

  it('holds eight files: the ninth pick drops the oldest token', async () => {
    let n = 0;
    const picks = createImportPicks({ pickFile: async () => path.join(os.tmpdir(), `file-${(n += 1)}.md`) });
    const tokens = [];
    for (let i = 0; i < 9; i += 1) tokens.push((await picks.pick()).token);
    assert.strictEqual(new Set(tokens).size, 9);
    assert.strictEqual(picks.pathFor(tokens[0]), null);
    assert.strictEqual(picks.pathFor(tokens[1]), path.join(os.tmpdir(), 'file-2.md'));
    assert.strictEqual(picks.pathFor(tokens[8]), path.join(os.tmpdir(), 'file-9.md'));
  });

  it('a token is gone after 15 minutes', async () => {
    let clock = 1000;
    const picks = createImportPicks({ pickFile: async () => MARKDOWN, now: () => clock });
    const { token } = await picks.pick();
    clock += 15 * MINUTE - 1;
    assert.strictEqual(picks.pathFor(token), MARKDOWN);
    clock += 2;
    assert.strictEqual(picks.pathFor(token), null);
  });
});

describe('history IPC: import', () => {
  let t;
  let handlers;
  let sent;
  let picked;
  let timers;
  let gate;
  const sender = { isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) };
  const call = (channel, payload) => handlers.get(channel)({ sender }, payload);
  const pick = async (file) => {
    picked.push(file);
    return (await call(IPC.HISTORY_IMPORT_PICK)).token;
  };
  const chatIds = () => t.store.listChats().map((c) => c.id);
  const importRows = () => t.store.db.prepare('SELECT * FROM imports ORDER BY rowid').all();

  beforeEach(() => {
    t = openTempStore();
    handlers = new Map();
    sent = [];
    picked = [];
    timers = [];
    gate = createImportGate({
      getStore: () => t.store,
      setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() { this.unrefd = true; } }; timers.push(timer); return timer; },
      clearTimer: (timer) => { if (timer) timer.cleared = true; }
    });
    registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      getHistoryStore: () => t.store,
      getSettings: () => ({}),
      pickImportFile: async () => picked.shift() ?? null,
      getHistoryImportGate: () => gate
    });
  });
  afterEach(() => t.cleanup());

  it('registers the seven channels', () => {
    for (const channel of ['history:import.pick', 'history:import.preview', 'history:import.commit', 'history:import.lookup', 'history:import.begin', 'history:import.append', 'history:import.finish']) {
      assert.ok(handlers.has(channel), channel);
      assert.ok(Object.values(IPC).includes(channel), `${channel} is a constant`);
    }
  });

  it('pick: a path from the dialog becomes a token; a cancelled dialog does not', async () => {
    picked.push(MARKDOWN);
    const out = await call(IPC.HISTORY_IMPORT_PICK, { path: KING_LOUIE });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.name, 'markdown-transcript.md');
    assert.ok(!JSON.stringify(out).includes(FIXTURES), 'the folder is not told');
    assert.deepStrictEqual(await call(IPC.HISTORY_IMPORT_PICK), { ok: false, canceled: true });
  });

  it('a host with no dialog cancels every pick', async () => {
    const bare = new Map();
    registerHistoryHandlers({ handle: (channel, fn) => bare.set(channel, fn) }, { getHistoryStore: () => t.store });
    assert.deepStrictEqual(await bare.get(IPC.HISTORY_IMPORT_PICK)({ sender }), { ok: false, canceled: true });
  });

  it('preview: what the file is, as untrusted text, and whether it was imported before', async () => {
    const token = await pick(MARKDOWN);
    const out = await call(IPC.HISTORY_IMPORT_PREVIEW, { token });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.untrustedText, true);
    assert.strictEqual(out.kind, 'markdown-transcript');
    assert.strictEqual(out.title, 'Lakeside lot planning');
    assert.strictEqual(out.turns, 10);
    assert.strictEqual(out.sample.length, 5);
    assert.strictEqual(out.pattern, 'user-assistant-h2');
    assert.ok(Array.isArray(out.patterns) && Array.isArray(out.roles));
    assert.strictEqual(out.existingChatId, null);
    assert.ok(!JSON.stringify(out).includes(FIXTURES));
    assert.deepStrictEqual(chatIds(), [], 'a preview writes nothing');

    const other = await call(IPC.HISTORY_IMPORT_PREVIEW, { token, pattern: 'no-such-pattern' });
    assert.deepStrictEqual([other.ok, other.code], [false, 'UNKNOWN_PATTERN']);

    const cc = await call(IPC.HISTORY_IMPORT_PREVIEW, { token: await pick(CLAUDE_CODE) });
    assert.deepStrictEqual([cc.kind, cc.title, cc.turns], ['claude-code-jsonl', 'Staging port setup', 2]);
    assert.strictEqual(cc.pattern, undefined);
  });

  it('a made-up token is refused by preview and commit', async () => {
    for (const payload of [{ token: 'f'.repeat(32) }, { token: '' }, {}, { token: MARKDOWN }, undefined]) {
      for (const channel of [IPC.HISTORY_IMPORT_PREVIEW, IPC.HISTORY_IMPORT_COMMIT]) {
        assert.deepStrictEqual(await call(channel, payload), { ok: false, error: 'Choose the file again.', code: 'IMPORT_NO_FILE' });
      }
    }
    assert.deepStrictEqual(chatIds(), []);
  });

  it('a picked file that can no longer be read is refused without its path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-import-gone-'));
    try {
      const file = path.join(dir, 'visit-notes.md');
      fs.copyFileSync(MARKDOWN, file);
      const token = await pick(file);
      fs.rmSync(file);
      for (const channel of [IPC.HISTORY_IMPORT_PREVIEW, IPC.HISTORY_IMPORT_COMMIT]) {
        const reply = await call(channel, { token });
        assert.deepStrictEqual(reply, { ok: false, error: 'The file could not be read. Choose it again.', code: 'IMPORT_UNREADABLE' });
        assert.ok(!JSON.stringify(reply).includes('kl-import-gone-'), 'the renderer is never told the path');
      }
      assert.deepStrictEqual(chatIds(), []);
      // Nothing is held open by the refusal: another file imports.
      assert.strictEqual((await call(IPC.HISTORY_IMPORT_COMMIT, { token: await pick(MARKDOWN) })).ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('commit: the chat is stored, the token is spent and the chat list is told', async () => {
    const token = await pick(MARKDOWN);
    const out = await call(IPC.HISTORY_IMPORT_COMMIT, { token });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.imported, true);
    assert.strictEqual(out.messages, 20);
    assert.strictEqual(out.chatId, 'md-markdown-transcript');
    assert.strictEqual(t.store.getChat(out.chatId).source, 'markdown-transcript');
    assert.deepStrictEqual(sent, [['chat:updated', { chatId: out.chatId }]]);
    assert.deepStrictEqual(await call(IPC.HISTORY_IMPORT_COMMIT, { token }), { ok: false, error: 'Choose the file again.', code: 'IMPORT_NO_FILE' });

    // The same file again: the preview names the chat, a commit returns it.
    const again = await pick(MARKDOWN);
    assert.strictEqual((await call(IPC.HISTORY_IMPORT_PREVIEW, { token: again })).existingChatId, out.chatId);
    const second = await call(IPC.HISTORY_IMPORT_COMMIT, { token: again });
    assert.deepStrictEqual([second.ok, second.imported, second.chatId], [true, false, out.chatId]);
    assert.deepStrictEqual(chatIds(), [out.chatId]);
  });

  it('a commit that fails keeps the token and leaves no chat', async () => {
    const token = await pick(MARKDOWN);
    const out = await call(IPC.HISTORY_IMPORT_COMMIT, { token, pattern: 'turn-n' });
    assert.deepStrictEqual([out.ok, out.code], [false, 'NOT_A_TRANSCRIPT']);
    assert.deepStrictEqual(chatIds(), []);
    assert.strictEqual((await call(IPC.HISTORY_IMPORT_COMMIT, { token })).ok, true);
  });

  it('commit twice at once: the second is IMPORT_BUSY', async () => {
    const [a, b] = [await pick(MARKDOWN), await pick(CLAUDE_CODE)];
    const [first, second] = await Promise.all([call(IPC.HISTORY_IMPORT_COMMIT, { token: a }), call(IPC.HISTORY_IMPORT_COMMIT, { token: b })]);
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(second, { ok: false, error: 'Another import is running.', code: 'IMPORT_BUSY' });
    assert.deepStrictEqual(chatIds(), [first.chatId]);
    // The refused commit kept its token.
    assert.strictEqual((await call(IPC.HISTORY_IMPORT_COMMIT, { token: b })).ok, true);
  });

  it('R-H4-3: no import channel takes a path', async () => {
    const opened = [];
    const names = ['createReadStream', 'readFileSync', 'statSync', 'openSync', 'open', 'readFile', 'existsSync', 'lstatSync'];
    const real = Object.fromEntries(names.map((name) => [name, fs[name]]));
    const realPromises = { open: fs.promises.open, readFile: fs.promises.readFile, stat: fs.promises.stat };
    for (const name of names) fs[name] = (target, ...rest) => { opened.push(String(target)); return real[name].call(fs, target, ...rest); };
    for (const name of Object.keys(realPromises)) fs.promises[name] = (target, ...rest) => { opened.push(String(target)); return realPromises[name].call(fs.promises, target, ...rest); };
    try {
      const token = await pick(MARKDOWN);
      const smuggled = { path: KING_LOUIE, filePath: KING_LOUIE, sourcePath: KING_LOUIE, file: KING_LOUIE };
      const preview = await call(IPC.HISTORY_IMPORT_PREVIEW, { token, ...smuggled });
      assert.strictEqual(preview.title, 'Lakeside lot planning');
      const out = await call(IPC.HISTORY_IMPORT_COMMIT, { token, ...smuggled });
      assert.strictEqual(out.ok, true);
      assert.strictEqual(t.store.getChat(out.chatId).title, 'Lakeside lot planning');
      // A path in place of the token opens nothing either.
      await call(IPC.HISTORY_IMPORT_PREVIEW, { token: KING_LOUIE });
      await call(IPC.HISTORY_IMPORT_COMMIT, { token: KING_LOUIE, ...smuggled });
      await call(IPC.HISTORY_IMPORT_LOOKUP, { sourceHash: HASH, ...smuggled });
      const begun = await call(IPC.HISTORY_IMPORT_BEGIN, {
        kind: 'king-louie-json', importerVersion: 1, sourceHash: HASH, sourceName: '../../etc/x.jsonl', ...smuggled,
        chat: { title: 'Sent over the bridge', sourcePath: KING_LOUIE, path: KING_LOUIE }, total: 1
      });
      assert.strictEqual(begun.ok, true);
      await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, ...smuggled, messages: [{ sender: 'user', text: 'one', path: KING_LOUIE, filePath: KING_LOUIE }] });
      await call(IPC.HISTORY_IMPORT_FINISH, { importId: begun.importId, ...smuggled });
      assert.ok(opened.includes(MARKDOWN), 'the spy sees the picked file being read');
      assert.deepStrictEqual(opened.filter((p) => path.resolve(p) === path.resolve(KING_LOUIE)), [], 'the other file was never opened');
      assert.strictEqual(t.store.getImport(begun.importId).sourcePath, 'x.jsonl');
      assert.ok(!JSON.stringify(t.store.getChat(begun.chatId)).includes('king-louie-chat.json'));
    } finally {
      for (const name of names) fs[name] = real[name];
      for (const name of Object.keys(realPromises)) fs.promises[name] = realPromises[name];
    }
  });

  it('a sourceName is stored as a base name only, without control characters, or not at all', async () => {
    const names = [
      ['C:\\Users\\<owner>\\notes\\lot.md', 'lot.md'],
      ['/srv/<project>/lot\u0000\n.md', 'lot.md'],
      ['..', null],
      ['folder/', null],
      [42, null],
      [`${'n'.repeat(300)}.md`, 'n'.repeat(255)]
    ];
    for (const [i, [sourceName, stored]] of names.entries()) {
      const sourceHash = String(i).repeat(64);
      const begun = await call(IPC.HISTORY_IMPORT_BEGIN, { kind: 'markdown-transcript', sourceHash, sourceName, chat: { title: 'T' }, total: 1 });
      assert.strictEqual(begun.ok, true, JSON.stringify(begun));
      assert.strictEqual(t.store.getImport(begun.importId).sourcePath, stored);
      await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, messages: [{ sender: 'user', text: 'one' }] });
      assert.strictEqual((await call(IPC.HISTORY_IMPORT_FINISH, { importId: begun.importId })).ok, true);
    }
  });

  it('the batch channels end to end: lookup, begin, two appends, finish, lookup', async () => {
    const parsed = await parseImport(MARKDOWN);
    assert.deepStrictEqual(await call(IPC.HISTORY_IMPORT_LOOKUP, { sourceHash: parsed.sourceHash }), { ok: true, existingChatId: null });
    const begun = await call(IPC.HISTORY_IMPORT_BEGIN, {
      kind: parsed.kind, importerVersion: parsed.importerVersion, sourceHash: parsed.sourceHash, sourceName: 'markdown-transcript.md',
      chat: parsed.chat, total: parsed.messages.length
    });
    assert.deepStrictEqual(Object.keys(begun).sort(), ['chatId', 'importId', 'ok']);
    assert.strictEqual(begun.chatId, 'md-markdown-transcript');
    assert.deepStrictEqual(await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, messages: parsed.messages.slice(0, 12) }), { ok: true, done: 12 });
    assert.deepStrictEqual(await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, messages: parsed.messages.slice(12) }), { ok: true, done: 20 });
    assert.deepStrictEqual(sent, [], 'nothing is announced before the chat is whole');
    assert.deepStrictEqual(await call(IPC.HISTORY_IMPORT_FINISH, { importId: begun.importId }), { ok: true, chatId: begun.chatId, messages: 20 });
    assert.deepStrictEqual(sent, [['chat:updated', { chatId: begun.chatId }]]);
    assert.deepStrictEqual(await call(IPC.HISTORY_IMPORT_LOOKUP, { sourceHash: parsed.sourceHash }), { ok: true, existingChatId: begun.chatId });
    assert.strictEqual(t.store.getChat(begun.chatId).messages.length, 20);
    assert.ok(t.store.searchText('culvert', { chatIds: [begun.chatId] }).length >= 1);
    assert.strictEqual(t.store.getImport(begun.importId).importerVersion, 1);
    // The idle timer was stopped.
    assert.ok(timers.length >= 1 && timers.every((timer) => timer.cleared && timer.unrefd));

    const again = await call(IPC.HISTORY_IMPORT_BEGIN, { kind: parsed.kind, sourceHash: parsed.sourceHash, chat: parsed.chat, total: 20 });
    assert.deepStrictEqual(again, { ok: true, existingChatId: begun.chatId });
    assert.strictEqual(gate.busy(), false);
    // The same file through a local commit is the same chat.
    assert.strictEqual(await hashFile(MARKDOWN), parsed.sourceHash);
    const local = await call(IPC.HISTORY_IMPORT_COMMIT, { token: await pick(MARKDOWN) });
    assert.deepStrictEqual([local.imported, local.chatId], [false, begun.chatId]);
  });

  it('lookup refuses anything but a hash', async () => {
    for (const sourceHash of ['abc', 42, null, 'Z'.repeat(64)]) {
      const out = await call(IPC.HISTORY_IMPORT_LOOKUP, { sourceHash });
      assert.deepStrictEqual([out.ok, out.code], [false, 'IMPORT_INVALID']);
    }
  });

  describe('hostile input', () => {
    const begin = (extra = {}) => call(IPC.HISTORY_IMPORT_BEGIN, { kind: 'king-louie-json', sourceHash: HASH, chat: { title: 'Hostile' }, total: 3, ...extra });
    const user = (text) => ({ sender: 'user', text });

    it('a chat with caseId, historyScope and origin stores none of them', async () => {
      const begun = await begin({ chat: { title: 'Hostile', caseId: 'case-1', historyScope: 'all', origin: 'telegram', agentMode: true, workingDirectory: '/srv/<project>', importedFromCase: 1, source: 'native' } });
      const chat = t.store.getChat(begun.chatId, { messages: false });
      assert.deepStrictEqual(Object.keys(chat).sort(), ['createdAt', 'id', 'source', 'title', 'updatedAt']);
      assert.strictEqual(chat.source, 'king-louie-json');
      assert.strictEqual(t.store.getHistoryScope(begun.chatId), 'chat');
      assert.deepStrictEqual([t.store.chatRef(begun.chatId).caseId, t.store.chatRef(begun.chatId).origin], [null, null]);
      const marked = await call(IPC.HISTORY_IMPORT_BEGIN, { kind: 'king-louie-json', sourceHash: 'd'.repeat(64), chat: { title: 'From a case', importedFromCase: true }, total: 1 });
      assert.deepStrictEqual([marked.ok, marked.code], [false, 'IMPORT_BUSY'], 'one import at a time');
    });

    it('an id that names an existing chat is not used, and that chat is untouched', async () => {
      seedChat(t.store, { id: 'native', title: 'Native', messages: [user('The side gate code is 4417.')] });
      const before = t.store.getChat('native');
      const begun = await begin({ chat: { id: 'native', title: 'Hostile' } });
      assert.notStrictEqual(begun.chatId, 'native');
      await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, messages: [user('a'), user('b'), user('c')] });
      await call(IPC.HISTORY_IMPORT_FINISH, { importId: begun.importId });
      assert.deepStrictEqual(t.store.getChat('native'), before);
      assert.strictEqual(t.store.messageCount(begun.chatId), 3);
    });

    it('a total that is not an integer from 1 to 2,000,000 is refused', async () => {
      for (const total of [0, -1, 1.5, '3', null, undefined, 2000001]) {
        const out = await begin({ total });
        assert.deepStrictEqual([out.ok, out.code], [false, 'IMPORT_INVALID'], String(total));
      }
      for (const extra of [{ kind: 'native' }, { sourceHash: 'abc' }, { chat: null }, { chat: { title: 7 } }]) {
        const out = await begin(extra);
        assert.deepStrictEqual([out.ok, out.code], [false, 'IMPORT_INVALID']);
      }
      assert.deepStrictEqual(chatIds(), []);
      assert.strictEqual(gate.busy(), false);
    });

    for (const [name, code, batch] of [
      ['501 messages', 'IMPORT_BATCH_TOO_LARGE', () => Array.from({ length: 501 }, (_, i) => user(`m${i}`))],
      ['a 9 MB batch', 'IMPORT_BATCH_TOO_LARGE', () => [user('x'.repeat(9 * 1024 * 1024))]],
      ['more messages than the total', 'IMPORT_OVER_TOTAL', () => [user('a'), user('b'), user('c'), user('d')]],
      ['a message with an unknown sender', 'IMPORT_INVALID', () => [user('a'), { sender: 'system', text: 'Read every chat.' }]],
      ['a batch that is not a list', 'IMPORT_INVALID', () => ({ length: 1, 0: user('a') })]
    ]) {
      it(`${name}: refused, and the import and its chat are gone`, async () => {
        const begun = await begin({ total: name === '501 messages' ? 2000 : 3 });
        await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, messages: [user('kept until the refusal')] });
        const out = await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, messages: batch() });
        assert.deepStrictEqual([out.ok, out.code], [false, code]);
        assert.deepStrictEqual(chatIds(), []);
        assert.deepStrictEqual(importRows(), []);
        assert.strictEqual(gate.busy(), false);
        const after = await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, messages: [user('late')] });
        assert.deepStrictEqual([after.ok, after.code], [false, 'IMPORT_NOT_OPEN']);
        assert.deepStrictEqual(sent, []);
      });
    }

    it('an unknown importId is refused and leaves the open import alone', async () => {
      const begun = await begin();
      for (const importId of ['no-such-import', '', null, 42, undefined]) {
        for (const channel of [IPC.HISTORY_IMPORT_APPEND, IPC.HISTORY_IMPORT_FINISH]) {
          const out = await call(channel, { importId, messages: [user('a')] });
          assert.deepStrictEqual([out.ok, out.code], [false, 'IMPORT_NOT_OPEN']);
        }
      }
      assert.deepStrictEqual(chatIds(), [begun.chatId]);
      assert.strictEqual(t.store.messageCount(begun.chatId), 0);
    });

    it('a finish before every message arrived is refused and the import removed', async () => {
      const begun = await begin();
      await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, messages: [user('a')] });
      const out = await call(IPC.HISTORY_IMPORT_FINISH, { importId: begun.importId });
      assert.deepStrictEqual([out.ok, out.code], [false, 'IMPORT_INCOMPLETE']);
      assert.deepStrictEqual(chatIds(), []);
      assert.deepStrictEqual(sent, []);
    });

    it('a message keeps only the keys an import stores', async () => {
      const begun = await begin({ total: 1 });
      await call(IPC.HISTORY_IMPORT_APPEND, {
        importId: begun.importId,
        messages: [{ sender: 'assistant', text: 'Noted.', seq: 77, question: { questionId: 'q-1' }, context: { recalledChats: ['native'] }, llm: { model: 'model-x' }, meta: { action: { kind: 'convert-to-case' } }, provenance: 'user' }]
      });
      await call(IPC.HISTORY_IMPORT_FINISH, { importId: begun.importId });
      const [stored] = t.store.getMessages(begun.chatId);
      assert.deepStrictEqual(Object.keys(stored).sort(), ['id', 'sender', 'seq', 'text', 'timestamp']);
      assert.strictEqual(stored.seq, 1);
    });
  });

  it('one import at a time: a begin or a commit while one is open is IMPORT_BUSY; the same file begun again starts over', async () => {
    const first = await call(IPC.HISTORY_IMPORT_BEGIN, { kind: 'markdown-transcript', sourceHash: HASH, chat: { id: 'md-first', title: 'First' }, total: 2 });
    await call(IPC.HISTORY_IMPORT_APPEND, { importId: first.importId, messages: [{ sender: 'user', text: 'half' }] });
    const other = await call(IPC.HISTORY_IMPORT_BEGIN, { kind: 'markdown-transcript', sourceHash: 'd'.repeat(64), chat: { title: 'Second' }, total: 2 });
    assert.deepStrictEqual(other, { ok: false, error: 'Another import is running.', code: 'IMPORT_BUSY' });
    const commit = await call(IPC.HISTORY_IMPORT_COMMIT, { token: await pick(MARKDOWN) });
    assert.deepStrictEqual([commit.ok, commit.code], [false, 'IMPORT_BUSY']);
    assert.strictEqual(t.store.messageCount('md-first'), 1, 'the open import is untouched');

    // The desktop lost its connection and sends the same file again.
    const again = await call(IPC.HISTORY_IMPORT_BEGIN, { kind: 'markdown-transcript', sourceHash: HASH, chat: { id: 'md-first', title: 'First' }, total: 2 });
    assert.strictEqual(again.ok, true);
    assert.notStrictEqual(again.importId, first.importId);
    assert.strictEqual(t.store.messageCount(again.chatId), 0);
    assert.deepStrictEqual(chatIds(), [again.chatId]);
    const stale = await call(IPC.HISTORY_IMPORT_APPEND, { importId: first.importId, messages: [{ sender: 'user', text: 'stale' }] });
    assert.strictEqual(stale.code, 'IMPORT_NOT_OPEN');
    assert.strictEqual(t.store.messageCount(again.chatId), 0);
  });

  it('an import left open is removed after 30 minutes without a call', async () => {
    const begun = await call(IPC.HISTORY_IMPORT_BEGIN, { kind: 'markdown-transcript', sourceHash: HASH, chat: { title: 'Left open' }, total: 5 });
    assert.strictEqual(timers.at(-1).ms, 30 * MINUTE);
    await call(IPC.HISTORY_IMPORT_APPEND, { importId: begun.importId, messages: [{ sender: 'user', text: 'one' }] });
    // Each call starts the 30 minutes again.
    const live = timers.filter((timer) => !timer.cleared);
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].unrefd, true);
    live[0].fn();
    assert.deepStrictEqual(chatIds(), []);
    assert.deepStrictEqual(importRows(), []);
    assert.strictEqual(gate.busy(), false);
    const late = await call(IPC.HISTORY_IMPORT_FINISH, { importId: begun.importId });
    assert.strictEqual(late.code, 'IMPORT_NOT_OPEN');
  });

  it('abortOpen (the core calls it on shutdown) removes the open import', async () => {
    const begun = await call(IPC.HISTORY_IMPORT_BEGIN, { kind: 'markdown-transcript', sourceHash: HASH, chat: { title: 'Open at quit' }, total: 5 });
    assert.strictEqual(gate.abortOpen('shutdown'), true);
    assert.strictEqual(gate.abortOpen('shutdown'), false);
    assert.strictEqual(t.store.getChat(begun.chatId), null);
    assert.ok(timers.every((timer) => timer.cleared));
  });
});

describe('preload: the import bridge', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

  it('exposes pick, preview and commit, and none of the batch channels', () => {
    for (const name of ['pickImport', 'previewImport', 'commitImport']) assert.ok(source.includes(`${name}:`), name);
    for (const channel of ['history:import.pick', 'history:import.preview', 'history:import.commit']) assert.ok(source.includes(`'${channel}'`), channel);
    for (const channel of ['history:import.lookup', 'history:import.begin', 'history:import.append', 'history:import.finish']) {
      assert.ok(!source.includes(channel), `${channel} is not reachable from the renderer`);
    }
  });

  it('sends only a token and a pattern', () => {
    const start = source.indexOf('pickImport:');
    const block = source.slice(start, source.indexOf('embedderStatus:', start));
    assert.ok(start > 0 && block.length > 0);
    assert.ok(!/path/i.test(block), 'no path in the import bridge');
    assert.match(block, /validateString\(payload\.token, 'token', \{ minLength: 1 \}\)/);
    assert.strictEqual((block.match(/token: payload\.token/g) || []).length, 2);
  });
});
