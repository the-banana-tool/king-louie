'use strict';
// The converters' row reader: a JSONL file, a parquet file or a directory of
// parquet files, read as rows with the dataset's own column names.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readRows, inputSha256 } = require('../src/longhaul/converters/rows');
const { tmpDir } = require('./helpers/longhaul-helpers');

const FIXTURES = path.join(__dirname, 'fixtures', 'longhaul-converters');
const JSONL = path.join(FIXTURES, 'open-swe-traces.jsonl');
const PARQUET = path.join(FIXTURES, 'open-swe-traces.parquet');

async function collect(input, options = {}) {
  const out = [];
  for await (const item of readRows(input, options)) out.push(item);
  return out;
}

const plain = (row) => JSON.parse(JSON.stringify(row));

describe('readRows', () => {
  it('yields the parquet fixture as the same rows, order and row numbers as its JSONL', async () => {
    const fromJsonl = await collect(JSONL);
    const fromParquet = await collect(PARQUET);
    assert.equal(fromJsonl.length, 8);
    assert.deepEqual(fromParquet.map((r) => r.rowNo), fromJsonl.map((r) => r.rowNo));
    for (let i = 0; i < fromJsonl.length; i++) assert.deepEqual(plain(fromParquet[i].row), plain(fromJsonl[i].row));
  });

  it('decodes only the columns asked for', async () => {
    const rows = await collect(PARQUET, { columns: ['repo'] });
    assert.equal(rows.length, 8);
    for (const { row } of rows) assert.deepEqual(Object.keys(row), ['repo']);
  });

  it('reads a directory of parquet files in name order, numbering rows across files', async () => {
    const dir = tmpDir();
    fs.copyFileSync(PARQUET, path.join(dir, 'a.parquet'));
    fs.copyFileSync(PARQUET, path.join(dir, 'b.parquet'));
    const rows = await collect(dir, { columns: ['instance_id'] });
    assert.equal(rows.length, 16);
    assert.deepEqual(rows.map((r) => r.rowNo), Array.from({ length: 16 }, (_, i) => i + 1));
    assert.deepEqual(rows.slice(8).map((r) => r.row), rows.slice(0, 8).map((r) => r.row));
  });

  it('yields an unparseable JSONL line as an error with its line number', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'broken.jsonl');
    const lines = fs.readFileSync(JSONL, 'utf8').split('\n').filter(Boolean);
    lines.splice(1, 0, '{"repo": "broken');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const rows = await collect(file);
    assert.equal(rows.length, 9);
    assert.equal(rows[1].rowNo, 2);
    assert.ok(rows[1].error);
    assert.equal(rows[1].row, undefined);
  });

  it('refuses any other extension', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'rows.csv');
    fs.writeFileSync(file, 'repo\n');
    await assert.rejects(collect(file), (err) => err.code === 'USAGE');
  });
});

describe('inputSha256', () => {
  it('hashes a directory by its files names and contents, so a rename changes it', async () => {
    const dir = tmpDir();
    fs.copyFileSync(PARQUET, path.join(dir, 'a.parquet'));
    fs.copyFileSync(PARQUET, path.join(dir, 'b.parquet'));
    const before = await inputSha256(dir);
    fs.renameSync(path.join(dir, 'b.parquet'), path.join(dir, 'c.parquet'));
    const after = await inputSha256(dir);
    assert.match(before, /^[0-9a-f]{64}$/);
    assert.notEqual(after, before);
  });

  it('is the file sha256 for a file', async () => {
    const { sha256File } = require('../src/longhaul/files');
    assert.equal(await inputSha256(JSONL), await sha256File(JSONL));
  });
});
