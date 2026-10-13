// tests/history-import-limits.test.js
// Size bounds on an import (stage H4 review, finding 2): one check of the
// file's size before any importer runs, for every format; a line of a JSONL
// session that is too long is refused, not grown; and a King Louie export is
// read and parsed once.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openTempStore } = require('./helpers/history-fixture');
const {
  parseImport, previewImport, importChat, MAX_IMPORT_BYTES, MAX_IMPORT_LINE_CHARS
} = require('../src/history/import-chats');
const { readJsonlLines } = require('../src/history/importers/jsonl-lines');
const { IMPORTERS, detectImporter, claimImporter } = require('../src/history/importers');
const markdown = require('../src/history/importers/markdown-transcript');

const FIXTURES = path.join(__dirname, 'fixtures', 'history');
const CLAUDE_CODE = path.join(FIXTURES, 'claude-code-session.jsonl');
const MARKDOWN = path.join(FIXTURES, 'markdown-transcript.md');
const KING_LOUIE = path.join(FIXTURES, 'king-louie-chat.json');
const FILES = [CLAUDE_CODE, MARKDOWN, KING_LOUIE];

const open = [];
const dirs = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-import-limits-'));
  dirs.push(dir);
  return dir;
}
function temp() {
  const t = openTempStore();
  open.push(t);
  return t.store;
}
async function refusal(promise, code) {
  let caught = null;
  await assert.rejects(promise, (err) => { caught = err; return true; });
  assert.strictEqual(caught.code, code, `${caught.code}: ${caught.message}`);
  return caught;
}
// The reads of file contents made while fn runs (hashing streams the file
// and is not counted).
async function countingReads(fn) {
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => { reads += 1; return real(...args); };
  try {
    await fn();
  } finally {
    fs.readFileSync = real;
  }
  return reads;
}

describe('an import file has a size limit', () => {
  it('the numbers: 128 MB a file, 32M characters a line, above the largest session seen (37 MB)', () => {
    assert.strictEqual(MAX_IMPORT_BYTES, 128 * 1024 * 1024);
    assert.strictEqual(MAX_IMPORT_LINE_CHARS, 32 * 1024 * 1024);
    assert.ok(MAX_IMPORT_BYTES > 3 * 37 * 1024 * 1024);
    // The Markdown importer keeps its own, lower, limit.
    assert.ok(markdown.MAX_BYTES <= MAX_IMPORT_BYTES);
  });

  it('every format is refused IMPORT_TOO_LARGE before an importer opens the file', async () => {
    for (const file of FILES) {
      const size = fs.statSync(file).size;
      for (const run of [
        () => parseImport(file, { maxFileBytes: size - 1 }),
        () => previewImport(file, { maxFileBytes: size - 1 })
      ]) {
        let err = null;
        const reads = await countingReads(async () => { err = await refusal(run(), 'IMPORT_TOO_LARGE'); });
        assert.strictEqual(reads, 0, `${path.basename(file)}: nothing was read`);
        assert.ok(!err.message.includes(FIXTURES) && !err.message.includes(path.dirname(file)), 'no path in the message');
        assert.match(err.message, /MB/);
      }
      // At the limit it is read.
      assert.strictEqual((await previewImport(file, { maxFileBytes: size })).kind.length > 0, true);
    }
  });

  it('importChat refuses the file and writes nothing', async () => {
    const store = temp();
    await refusal(importChat({ store, filePath: KING_LOUIE, maxFileBytes: 10 }), 'IMPORT_TOO_LARGE');
    assert.deepStrictEqual(store.listChats(), []);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM imports').get().n, 0);
  });

  it('a limit that is not a number is the default, never no limit', async () => {
    for (const maxFileBytes of [undefined, null, NaN, Infinity, -1, '10']) {
      assert.strictEqual((await previewImport(MARKDOWN, { maxFileBytes })).kind, 'markdown-transcript');
    }
  });

  it('a folder is refused, with no path', async () => {
    const dir = tmpDir();
    const folder = path.join(dir, 'session.jsonl');
    fs.mkdirSync(folder);
    const err = await refusal(previewImport(folder), 'IMPORT_NOT_A_FILE');
    assert.ok(!err.message.includes(dir));
  });
});

describe('a JSONL line has a length limit', () => {
  const collect = async (file, opts) => {
    const out = [];
    for await (const l of readJsonlLines(file, opts)) out.push(l.line.length);
    return out;
  };

  it('readJsonlLines refuses a line over maxLineChars, wherever it ends', async () => {
    const dir = tmpDir();
    const long = JSON.stringify({ text: 'x'.repeat(5000) });
    const cases = {
      'middle.jsonl': `{"n":1}\n${long}\n{"n":3}\n`,
      'last.jsonl': `{"n":1}\n${long}`,
      'first.jsonl': `${long}\n{"n":2}\n`
    };
    for (const [name, text] of Object.entries(cases)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      for (const highWaterMark of [64, 1 << 20]) {
        const err = await refusal(collect(file, { maxLineChars: 1000, highWaterMark }), 'IMPORT_LINE_TOO_LONG');
        assert.ok(!err.message.includes(dir), 'no path in the message');
        assert.match(err.message, /line \d+/i);
      }
      assert.strictEqual((await collect(file, { maxLineChars: long.length })).length, name === 'last.jsonl' ? 2 : name === 'middle.jsonl' ? 3 : 2);
    }
  });

  it('a long unbroken line is refused before the whole of it is held', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'unbroken.jsonl');
    fs.writeFileSync(file, 'x'.repeat(400000));
    const real = fs.createReadStream;
    let bytes = 0;
    fs.createReadStream = (...args) => {
      const stream = real(...args);
      stream.on('data', (chunk) => { bytes += chunk.length; });
      return stream;
    };
    try {
      await refusal(collect(file, { maxLineChars: 1000, highWaterMark: 1024 }), 'IMPORT_LINE_TOO_LONG');
    } finally {
      fs.createReadStream = real;
    }
    assert.ok(bytes < 100000, `read ${bytes} bytes of 400000`);
  });

  it('with no limit given a line of any length is read, as LongHaul reads its sessions', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'long.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ text: 'y'.repeat(3 * 1024 * 1024) })}\n`);
    const lengths = await collect(file);
    assert.strictEqual(lengths.length, 1);
    assert.ok(lengths[0] > 3 * 1024 * 1024);
    // The importer LongHaul calls passes no limit either.
    const claudeCode = IMPORTERS.find((i) => i.kind === 'claude-code-jsonl');
    const session = path.join(dir, 'session.jsonl');
    const record = (type, text) => JSON.stringify({ type, uuid: `u-${type}`, sessionId: 'sess-long', timestamp: '2026-10-01T09:00:00.000Z', message: { role: type, content: text } });
    fs.writeFileSync(session, `${record('user', 'z'.repeat(40000))}\n${record('assistant', 'Noted.')}\n`);
    assert.strictEqual(await claudeCode.detect(session), true);
    assert.strictEqual((await claudeCode.parse(session)).messages.length, 2);
    assert.strictEqual((await detectImporter(session)).kind, 'claude-code-jsonl');
  });

  it('an import of a session with a line over the limit is refused IMPORT_LINE_TOO_LONG, in the first lines or later', async () => {
    const dir = tmpDir();
    const record = (type, text, n) => JSON.stringify({ type, uuid: `u-${n}`, sessionId: 'sess-line', timestamp: '2026-10-01T09:00:00.000Z', message: { role: type, content: text } });
    const early = path.join(dir, 'early.jsonl');
    fs.writeFileSync(early, `${record('user', 'z'.repeat(40000), 1)}\n${record('assistant', 'Noted.', 2)}\n`);
    const late = path.join(dir, 'late.jsonl');
    fs.writeFileSync(late, `${record('user', 'Hello.', 1)}\n${record('assistant', 'z'.repeat(40000), 2)}\n`);
    for (const file of [early, late]) {
      await refusal(previewImport(file, { maxLineChars: 5000 }), 'IMPORT_LINE_TOO_LONG');
      await refusal(parseImport(file, { maxLineChars: 5000 }), 'IMPORT_LINE_TOO_LONG');
      const store = temp();
      await refusal(importChat({ store, filePath: file, maxLineChars: 5000 }), 'IMPORT_LINE_TOO_LONG');
      assert.deepStrictEqual(store.listChats(), []);
      assert.strictEqual((await parseImport(file)).messages.length, 2);
    }
  });
});

describe('a King Louie export is read once', () => {
  it('parseImport and previewImport read and parse the file once each', async () => {
    const realParse = JSON.parse;
    const size = fs.statSync(KING_LOUIE).size;
    for (const run of [() => parseImport(KING_LOUIE), () => previewImport(KING_LOUIE)]) {
      let parses = 0;
      JSON.parse = (text, ...rest) => {
        if (typeof text === 'string' && text.length > size / 2) parses += 1;
        return realParse(text, ...rest);
      };
      let reads;
      try {
        reads = await countingReads(run);
      } finally {
        JSON.parse = realParse;
      }
      assert.strictEqual(reads, 1, 'one read of the file');
      assert.strictEqual(parses, 1, 'one parse of the file');
    }
  });

  it('the case mark still comes from the file, and the result is what it was', async () => {
    const dir = tmpDir();
    const data = JSON.parse(fs.readFileSync(KING_LOUIE, 'utf8'));
    const withCase = path.join(dir, 'case-chat.json');
    fs.writeFileSync(withCase, JSON.stringify({ ...data, caseId: 'case-lakeside' }));
    const without = path.join(dir, 'plain-chat.json');
    const { caseId: _caseId, ...plain } = data;
    fs.writeFileSync(without, JSON.stringify(plain));
    assert.strictEqual((await parseImport(withCase)).chat.importedFromCase, true);
    assert.strictEqual((await parseImport(without)).chat.importedFromCase, undefined);
    const parsed = await parseImport(without);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['chat', 'importerVersion', 'kind', 'messages', 'sourceHash', 'stats']);
    assert.strictEqual(parsed.kind, 'king-louie-json');
    assert.strictEqual(parsed.messages.length, data.messages.length);
  });

  it('claimImporter gives the importer and what it loaded; detectImporter the importer alone', async () => {
    const claimed = await claimImporter(KING_LOUIE);
    assert.strictEqual(claimed.importer.kind, 'king-louie-json');
    assert.ok(claimed.loaded && Array.isArray(claimed.loaded.messages));
    assert.strictEqual((await claimImporter(MARKDOWN)).importer.kind, 'markdown-transcript');
    assert.strictEqual((await claimImporter(MARKDOWN)).loaded, undefined);
    assert.strictEqual(await claimImporter(path.join(FIXTURES, 'nothing-here.txt')), null);
    assert.strictEqual((await detectImporter(KING_LOUIE)).kind, 'king-louie-json');
  });

  it('a King Louie file over the limit is not read by its importer either', async () => {
    const kingLouie = IMPORTERS.find((i) => i.kind === 'king-louie-json');
    const size = fs.statSync(KING_LOUIE).size;
    const reads = await countingReads(async () => {
      assert.strictEqual(kingLouie.load(KING_LOUIE, { maxFileBytes: size - 1 }), null);
      assert.strictEqual(await kingLouie.detect(KING_LOUIE, { maxFileBytes: size - 1 }), false);
    });
    assert.strictEqual(reads, 0);
    assert.ok(kingLouie.load(KING_LOUIE, { maxFileBytes: size }));
  });
});
