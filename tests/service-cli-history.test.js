// tests/service-cli-history.test.js
// `king-louie-service history import <file>` (history stage H4, owner ruling
// R-H4-4): it runs only as the data dir's owner with the service stopped,
// and never as root or Administrator. No core, no network, no model.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { main } = require('../src/service/cli');
const { runHistoryCommand } = require('../src/service/commands/history');
const { HistoryStore, previewImport } = require('../src/history');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const FIXTURES = path.join(__dirname, 'fixtures', 'history');
// A terminal escape and a right-to-left override, as a hostile title would carry.
const ESC = String.fromCharCode(27);
const RLO = String.fromCodePoint(0x202e);
const MARKDOWN = path.join(FIXTURES, 'markdown-transcript.md');
const CLAUDE_CODE = path.join(FIXTURES, 'claude-code-session.jsonl');
const KING_LOUIE = path.join(FIXTURES, 'king-louie-chat.json');

function io() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdin: Readable.from(['']),
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) }
  };
}

const dirs = [];
after(() => {
  closeOpenHistoryStores();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix = 'kl-svc-history-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const sqlite = (dir) => path.join(dir, 'history.sqlite');

// The account that owns the data dir, not elevated, service stopped.
const dirStat = (uid) => ({ uid, isDirectory: () => true, isSymbolicLink: () => false });
const OWNER = { isAdmin: () => false, platform: 'linux', getuid: () => 1001, statDataDir: () => dirStat(1001), runningServicePid: () => null };

async function run({ file = MARKDOWN, sub = 'import', flags = {}, dataDir = tmp(), deps = {}, extra } = {}) {
  const t = io();
  const code = await runHistoryCommand({ sub, arg: file, extra, flags, dataDir, io: t, deps: { ...OWNER, ...deps } });
  return { code, out: t.out.join(''), err: t.err.join(''), dataDir };
}

function chatsIn(dataDir) {
  const store = HistoryStore.open(sqlite(dataDir), { readonly: true });
  try {
    return store.listChats({ messages: true });
  } finally {
    store.close();
  }
}

describe('service CLI — history import: who may run it', () => {
  it('R-H4-4: refused as root', async () => {
    const opened = [];
    const r = await run({
      deps: { isAdmin: () => true, platform: 'linux', getuid: () => 0, statDataDir: (d) => { opened.push(d); return dirStat(1001); } }
    });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.out, '');
    assert.strictEqual(
      r.err,
      `Run this as the account that owns ${r.dataDir}, not as root or Administrator: an import written by an administrator would leave files the service cannot use. ${r.dataDir} belongs to uid 1001.\n`
    );
    assert.ok(!fs.existsSync(sqlite(r.dataDir)), 'nothing was opened or written');
    assert.deepStrictEqual(fs.readdirSync(r.dataDir), []);
  });

  it('R-H4-4: refused as Administrator', async () => {
    const r = await run({
      deps: { isAdmin: () => true, platform: 'win32', getuid: () => { throw new Error('not asked on Windows'); }, statDataDir: () => { throw new Error('not asked on Windows'); } }
    });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(
      r.err,
      `Run this as the account that owns ${r.dataDir}, not as root or Administrator: an import written by an administrator would leave files the service cannot use.\n`
    );
    assert.deepStrictEqual(fs.readdirSync(r.dataDir), []);
    // The check is made before anything else, whatever the file is.
    const missing = await run({ file: path.join(tmp(), 'none.md'), deps: { isAdmin: () => true, platform: 'win32' } });
    assert.strictEqual(missing.code, 1);
    assert.match(missing.err, /not as root or Administrator/);
  });

  it('R-H4-4: refused when the data dir belongs to another account', async () => {
    const r = await run({ deps: { getuid: () => 1002, statDataDir: () => dirStat(1001) } });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.err, `${r.dataDir} belongs to uid 1001; run this as that account.\n`);
    assert.strictEqual(r.out, '');
    assert.deepStrictEqual(fs.readdirSync(r.dataDir), []);
    // An owner that cannot be read is a refusal too, never a pass.
    const unread = await run({ deps: { getuid: () => 1001, statDataDir: () => dirStat(undefined) } });
    assert.strictEqual(unread.code, 1);
    assert.match(unread.err, /owner .* could not be read/);
    assert.deepStrictEqual(fs.readdirSync(unread.dataDir), []);
  });

  it('R-H4-4: refused while the service runs', async () => {
    const r = await run({ deps: { runningServicePid: () => 4417 } });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.err, `The service is running (pid 4417) on ${r.dataDir}. Stop it first, run this again, then start it.\n`);
    assert.deepStrictEqual(fs.readdirSync(r.dataDir), []);
    // Through the real CLI and the real pidfile.
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));
    const t = io();
    const code = await main(['history', 'import', MARKDOWN, '--data-dir', dir], t);
    assert.strictEqual(code, 1);
    assert.ok(!fs.existsSync(sqlite(dir)));
  });

  it('on Windows the owner is not checked: only elevation refuses', async () => {
    const r = await run({ deps: { platform: 'win32', getuid: () => { throw new Error('not asked'); }, statDataDir: () => dirStat(0) } });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(chatsIn(r.dataDir).length, 1);
  });

  it('a data dir or a file that does not exist is refused, and nothing is created', async () => {
    const gone = path.join(tmp(), 'no-such-data-dir');
    const a = await run({ dataDir: gone, deps: { statDataDir: fs.lstatSync } });
    assert.strictEqual(a.code, 1);
    assert.strictEqual(a.err, `The data dir ${gone} does not exist.\n`);
    assert.ok(!fs.existsSync(gone));
    const file = path.join(tmp(), 'none.md');
    const b = await run({ file });
    assert.strictEqual(b.code, 1);
    assert.strictEqual(b.err, `No such file: ${file}\n`);
    assert.deepStrictEqual(fs.readdirSync(b.dataDir), []);
    const c = await run({ file: tmp() });
    assert.strictEqual(c.code, 1);
    assert.match(c.err, /^No such file: /);
    // A data dir that is a file, or a link, is not written through.
    const notDir = await run({ deps: { statDataDir: () => ({ uid: 1001, isDirectory: () => false, isSymbolicLink: () => false }) } });
    assert.strictEqual(notDir.code, 1);
    assert.match(notDir.err, /is not a directory \(links are refused\)/);
    const link = await run({ deps: { statDataDir: () => ({ uid: 1001, isDirectory: () => false, isSymbolicLink: () => true }) } });
    assert.strictEqual(link.code, 1);
    assert.deepStrictEqual(fs.readdirSync(link.dataDir), []);
  });
});

describe('service CLI — history import: the import', () => {
  it('imports a Markdown transcript, and the same file twice is one chat', async () => {
    const r = await run({});
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(r.err, '');
    const chats = chatsIn(r.dataDir);
    assert.strictEqual(chats.length, 1);
    assert.strictEqual(chats[0].title, 'Lakeside lot planning');
    assert.strictEqual(chats[0].source, 'markdown-transcript');
    assert.strictEqual(chats[0].messages.length, 20);
    assert.match(r.out, /^Imported a Markdown transcript: "Lakeside lot planning", 20 messages\.$/m);
    assert.ok(r.out.includes(`Chat id: ${chats[0].id}\n`));
    assert.match(r.out, /^Heading pattern: user-assistant-h2 \(## User \/ ## Assistant\)\.$/m);
    assert.ok(!r.out.includes('Other patterns'));

    const again = await run({ dataDir: r.dataDir });
    assert.strictEqual(again.code, 0);
    assert.strictEqual(again.out, `Already imported as ${chats[0].id}.\n`);
    assert.strictEqual(chatsIn(r.dataDir).length, 1);
  });

  it('imports a Claude Code session and a King Louie export', async () => {
    const dataDir = tmp();
    const cc = await run({ file: CLAUDE_CODE, dataDir });
    assert.strictEqual(cc.code, 0, cc.err);
    assert.match(cc.out, /^Imported a Claude Code session: "Staging port setup", 7 messages\.$/m);
    assert.ok(!cc.out.includes('Heading pattern'));
    const kl = await run({ file: KING_LOUIE, dataDir });
    assert.strictEqual(kl.code, 0, kl.err);
    assert.match(kl.out, /^Imported a King Louie chat export: "Lakeside lot survey", \d+ messages\.$/m);
    const chats = chatsIn(dataDir);
    assert.deepStrictEqual(chats.map((c) => c.source).sort(), ['claude-code-jsonl', 'king-louie-json']);
    for (const chat of chats) {
      assert.strictEqual(chat.caseId ?? null, null);
      assert.ok(chat.messages.length > 0);
      assert.ok(cc.out.includes(`Chat id: ${chat.id}\n`) || kl.out.includes(`Chat id: ${chat.id}\n`));
    }
    // Searchable like a native chat: every message went through the store's insert path.
    const store = HistoryStore.open(sqlite(dataDir), { readonly: true });
    try {
      assert.ok(store.searchText('port', { chatIds: [chats.find((c) => c.source === 'claude-code-jsonl').id] }).length > 0);
    } finally {
      store.close();
    }
  });

  it('through the real CLI: a data dir never started gets its store, and an import left unfinished is removed first', async (t) => {
    const { isAdmin } = require('../src/service/commands/admin-check');
    if (isAdmin()) return t.skip('running elevated: the command refuses, as it should');
    const dir = tmp();
    const first = io();
    assert.strictEqual(await main(['history', 'import', MARKDOWN, '--data-dir', dir], first), 0, first.err.join(''));
    assert.match(first.out.join(''), /Imported a Markdown transcript/);
    // A crash in the middle of another import: its half chat goes at the next run.
    const store = HistoryStore.open(sqlite(dir));
    const { beginChatImport } = require('../src/history');
    const half = beginChatImport({ store, kind: 'markdown-transcript', sourceHash: 'ab'.repeat(32), chat: { title: 'Half a transcript' } });
    store.close();
    assert.strictEqual(chatsIn(dir).length, 2);
    const second = io();
    assert.strictEqual(await main(['history', 'import', `--data-dir=${dir}`, CLAUDE_CODE], second), 0, second.err.join(''));
    const chats = chatsIn(dir);
    assert.strictEqual(chats.length, 2);
    assert.ok(!chats.some((c) => c.id === half.chatId));
    return undefined;
  });

  it('--pattern is used and reported, and without it the others that fit are named', async () => {
    const dir = tmp();
    const file = path.join(dir, 'Lakeside lot turns.md');
    const lines = ['# Lakeside lot turns', ''];
    for (let i = 1; i <= 3; i += 1) {
      lines.push(`## Turn ${i}`, '', '### User', '', `Question ${i} about the culvert.`, '', '### Assistant', '', `Answer ${i}.`, '');
    }
    fs.writeFileSync(file, lines.join('\n'));
    const fits = (await previewImport(file)).patterns.map((p) => p.id);
    assert.ok(fits.length >= 2, `the test file fits more than one pattern: ${fits.join(', ')}`);

    const plain = await run({ file });
    assert.strictEqual(plain.code, 0, plain.err);
    assert.match(plain.out, new RegExp(`^Heading pattern: ${fits[0]} \\(`, 'm'));
    const others = plain.out.split('\n').find((l) => l.startsWith('Other patterns that fit this file'));
    assert.ok(others, plain.out);
    for (const id of fits.slice(1)) assert.ok(others.includes(id), id);
    assert.ok(others.includes('--pattern'));

    const chosen = await run({ file, flags: { pattern: fits[1] } });
    assert.strictEqual(chosen.code, 0, chosen.err);
    assert.match(chosen.out, new RegExp(`^Heading pattern: ${fits[1]} \\(`, 'm'));
    assert.ok(!chosen.out.includes('Other patterns'));

    const unknown = await run({ file, flags: { pattern: 'no-such-pattern' } });
    assert.strictEqual(unknown.code, 1);
    assert.match(unknown.err, /Unknown transcript pattern/);
    assert.deepStrictEqual(fs.readdirSync(unknown.dataDir), []);
    const unfit = await run({ file: MARKDOWN, flags: { pattern: 'turn-n' } });
    assert.strictEqual(unfit.code, 1);
    assert.match(unfit.err, /does not read as a transcript/);
  });

  it('a control character in a transcript title is printed as ?', async () => {
    const dir = tmp();
    const file = path.join(dir, 'notes.md');
    fs.writeFileSync(file, [`# Lakeside${ESC}[2J lot${RLO} notes`, '', '## User', '', 'Where is the culvert?', '', '## Assistant', '', 'Under the north fence.', '', '## User', '', 'Thanks.', '', '## Assistant', '', 'Any time.', ''].join('\n'));
    const r = await run({ file });
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(r.out.includes('"Lakeside?[2J lot? notes"'), r.out);
    assert.ok(!r.out.includes(ESC) && !r.out.includes(RLO));
    // The stored title is the file's own.
    assert.ok(chatsIn(r.dataDir)[0].title.includes(ESC));
  });

  it('a file no importer reads is refused with the importer\'s sentence, and no store is created', async () => {
    const dir = tmp();
    const file = path.join(dir, 'notes.md');
    fs.writeFileSync(file, '# Lakeside lot\n\nNo conversation here.\n');
    const r = await run({ file });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.out, '');
    assert.match(r.err, /not a Claude Code session, a Markdown transcript or a King Louie chat export/);
    assert.deepStrictEqual(fs.readdirSync(r.dataDir), []);
    const sub = path.join(dir, 'subagents');
    fs.mkdirSync(sub);
    fs.copyFileSync(CLAUDE_CODE, path.join(sub, 'agent-1.jsonl'));
    const agent = await run({ file: path.join(sub, 'agent-1.jsonl') });
    assert.strictEqual(agent.code, 1);
    assert.ok(agent.err.trim().length > 0);
    assert.deepStrictEqual(fs.readdirSync(agent.dataDir), []);
  });
});

describe('service CLI — history: usage', () => {
  const usage = async (argv) => {
    const t = io();
    const code = await main(argv, t);
    return { code, out: t.out.join(''), err: t.err.join('') };
  };

  it('usage errors exit 2 before any check', async () => {
    const dir = tmp();
    for (const argv of [
      ['history', '--data-dir', dir],
      ['history', 'import', '--data-dir', dir],
      ['history', 'reindex', '--data-dir', dir],
      ['history', 'status', MARKDOWN, '--data-dir', dir],
      ['history', 'import', MARKDOWN, CLAUDE_CODE, '--data-dir', dir]
    ]) {
      const r = await usage(argv);
      assert.strictEqual(r.code, 2, argv.join(' '));
      assert.match(r.err, /^Usage: king-louie-service history import <file> \[--pattern ID\] \[--data-dir DIR\]$/m);
      assert.strictEqual(r.out, '');
    }
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });

  it('--yes and --pattern are refused where they mean nothing', async () => {
    const dir = tmp();
    const yes = await usage(['history', 'import', MARKDOWN, '--yes', '--data-dir', dir]);
    assert.strictEqual(yes.code, 2);
    assert.match(yes.err, /Flag "--yes" is only valid for/);
    const pattern = await usage(['models', 'status', '--pattern', 'turn-n', '--data-dir', dir]);
    assert.strictEqual(pattern.code, 2);
    assert.match(pattern.err, /Flag "--pattern" is only valid for "history import"\./);
    const empty = await usage(['history', 'import', MARKDOWN, '--pattern', '--data-dir', dir]);
    assert.strictEqual(empty.code, 2);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });

  it('the help names the command and its Windows limit', async () => {
    const r = await usage(['help']);
    assert.match(r.out, /king-louie-service history import <file> \[--pattern ID\] \[--data-dir DIR\]/);
    assert.match(r.out, /"history import" .*never as root or Administrator/s);
    assert.match(r.out, /On Windows the data dir's owner is not checked/);
  });
});
