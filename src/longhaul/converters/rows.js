'use strict';
// Rows of a downloaded dataset, with the dataset's own column names: a JSONL
// file (one row per line), a parquet file, or a directory of parquet files
// read in name order. Parquet is decoded one row group at a time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { readJsonlLines } = require('../../history/importers/jsonl-lines');
const { sha256File, byCodeUnit } = require('../files');
const { UsageError } = require('../errors');

function inputKind(input) {
  let stat;
  try { stat = fs.statSync(input); } catch { throw new UsageError(`No such file or directory: ${path.basename(input)}`); }
  if (stat.isDirectory()) return 'dir';
  const ext = path.extname(input).toLowerCase();
  if (ext === '.jsonl') return 'jsonl';
  if (ext === '.parquet') return 'parquet';
  throw new UsageError(`${path.basename(input)}: expected a .parquet file, a directory of them, or a .jsonl file.`);
}

function parquetFiles(dir) {
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.parquet')
    .map((e) => e.name)
    .sort(byCodeUnit);
  if (names.length === 0) throw new UsageError(`${path.basename(dir)} holds no .parquet files.`);
  return names.map((name) => path.join(dir, name));
}

function project(row, columns) {
  if (!columns || !row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const c of columns) if (c in row) out[c] = row[c];
  return out;
}

function isList(element) {
  return element.converted_type === 'LIST' || element.logical_type?.type === 'LIST';
}

// What JSONL would hold: a null optional field is present as null (hyparquet
// leaves a null list out), and an INT64 is a number.
function plainValue(value, node) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value === undefined || value === null) return null;
  if (!node || !node.children.length) return value;
  if (isList(node.element)) {
    const item = node.children[0]?.children[0];
    return Array.isArray(value) ? value.map((v) => plainValue(v, item)) : value;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const child of node.children) out[child.element.name] = plainValue(value[child.element.name], child);
  return out;
}

// hyparquet decodes SNAPPY and uncompressed pages itself; the other codecs
// datasets ship come from Node's own zlib. Each gets the page's bytes and the
// header's uncompressed size, and hyparquet checks the length it gets back.
const asBytes = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
function zlibCompressors(z = zlib) {
  const out = {
    GZIP: (input, outputLength) => asBytes(z.gunzipSync(input, { maxOutputLength: Math.max(outputLength, 1) })),
    BROTLI: (input, outputLength) => asBytes(z.brotliDecompressSync(input, { maxOutputLength: Math.max(outputLength, 1) }))
  };
  if (typeof z.zstdDecompressSync === 'function') {
    out.ZSTD = (input, outputLength) => asBytes(z.zstdDecompressSync(input, { maxOutputLength: Math.max(outputLength, 1) }));
  }
  return out;
}

const BUILT_IN_CODECS = new Set(['UNCOMPRESSED', 'SNAPPY']);

// Refuse before decoding when a wanted column uses a codec nothing here reads.
function checkCodecs(file, metadata, wanted, compressors, nodeVersion = process.version) {
  const want = new Set(wanted);
  const codecs = new Set();
  for (const group of metadata.row_groups) {
    for (const chunk of group.columns) {
      const meta = chunk.meta_data;
      if (meta && want.has(meta.path_in_schema?.[0])) codecs.add(meta.codec);
    }
  }
  for (const codec of codecs) {
    if (BUILT_IN_CODECS.has(codec) || compressors[codec]) continue;
    if (codec === 'ZSTD') {
      throw new UsageError(`${path.basename(file)} is ZSTD-compressed parquet, which needs Node 22.15 or later (zlib.zstdDecompressSync); this is Node ${nodeVersion}.`);
    }
    throw new UsageError(`${path.basename(file)} uses the parquet compression codec ${codec}, which this reader does not support (it reads UNCOMPRESSED, SNAPPY, GZIP, BROTLI and ZSTD).`);
  }
}

async function* readParquetFile(file, columns, startRowNo, hyparquet, compressors) {
  const { asyncBufferFromFile, parquetMetadataAsync, parquetSchema, parquetReadObjects } = hyparquet;
  const buffer = await asyncBufferFromFile(file);
  const metadata = await parquetMetadataAsync(buffer);
  const top = new Map(parquetSchema(metadata).children.map((n) => [n.element.name, n]));
  const wanted = columns ? columns.filter((c) => top.has(c)) : [...top.keys()];
  checkCodecs(file, metadata, wanted, compressors);
  let rowNo = startRowNo;
  let rowStart = 0;
  for (const group of metadata.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    const rows = await parquetReadObjects({ file: buffer, metadata, columns: wanted, rowStart, rowEnd, compressors });
    for (const raw of rows) {
      const row = {};
      for (const c of wanted) row[c] = plainValue(raw[c], top.get(c));
      rowNo += 1;
      yield { rowNo, row };
    }
    rowStart = rowEnd;
  }
}

async function* readRows(input, { columns = null } = {}) {
  const kind = inputKind(input);
  if (kind === 'jsonl') {
    for await (const { line, lineNo } of readJsonlLines(input)) {
      let row;
      try { row = JSON.parse(line); } catch (err) {
        yield { rowNo: lineNo, error: err.message };
        continue;
      }
      yield { rowNo: lineNo, row: project(row, columns) };
    }
    return;
  }
  const hyparquet = await import('hyparquet');
  const compressors = zlibCompressors();
  let rowNo = 0;
  for (const file of kind === 'dir' ? parquetFiles(input) : [input]) {
    for await (const item of readParquetFile(file, columns, rowNo, hyparquet, compressors)) {
      rowNo = item.rowNo;
      yield item;
    }
  }
}

async function inputSha256(input) {
  if (inputKind(input) !== 'dir') return sha256File(input);
  const hash = crypto.createHash('sha256');
  for (const file of parquetFiles(input)) hash.update(`${path.basename(file)}\0${await sha256File(file)}\n`);
  return hash.digest('hex');
}

module.exports = { readRows, inputSha256, inputKind, zlibCompressors, checkCodecs };
