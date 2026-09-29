// tests/history-jsonl-lines.test.js
// JSONL is split on '\n' only: node:readline also splits on U+2028/U+2029,
// which JSON.stringify leaves raw inside strings (LongHaul Review Focus 1).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readJsonlLines } = require('../src/history/importers/jsonl-lines');
const { tmpDir } = require('./helpers/longhaul-helpers');

async function collect(file, opts) {
  const out = [];
  for await (const l of readJsonlLines(file, opts)) out.push(l);
  return out;
}

describe('readJsonlLines', () => {
  const dir = tmpDir();
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

  it('keeps U+2028 and U+2029 inside one line', async () => {
    const rec = { text: 'a b c' };
    const file = write('sep.jsonl', `${JSON.stringify(rec)}\n${JSON.stringify({ n: 2 })}\n`);
    const lines = await collect(file);
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(JSON.parse(lines[0].line), rec);
    assert.deepStrictEqual(lines.map((l) => l.lineNo), [1, 2]);
  });

  it('strips CRLF and a leading BOM, skips blank lines, and yields a last line with no newline', async () => {
    const file = write('crlf.jsonl', '﻿{"a":1}\r\n\r\n{"b":2}\r\n{"c":3}');
    const lines = await collect(file);
    assert.deepStrictEqual(lines.map((l) => l.line), ['{"a":1}', '{"b":2}', '{"c":3}']);
    assert.deepStrictEqual(lines.map((l) => l.lineNo), [1, 3, 4]);
  });

  it('reassembles lines and multibyte characters split across read chunks', async () => {
    const recs = [{ t: 'é'.repeat(50) }, { t: '日本語'.repeat(20) }, { t: 'x' }];
    const file = write('chunks.jsonl', `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const lines = await collect(file, { highWaterMark: 7 });
    assert.deepStrictEqual(lines.map((l) => JSON.parse(l.line)), recs);
  });

  it('reads a 3 MB line intact', async () => {
    const file = write('big.jsonl', `${JSON.stringify({ t: 'y'.repeat(3_000_000) })}\n{"after":true}\n`);
    const lines = await collect(file);
    assert.strictEqual(JSON.parse(lines[0].line).t.length, 3_000_000);
    assert.deepStrictEqual(JSON.parse(lines[1].line), { after: true });
  });
});
