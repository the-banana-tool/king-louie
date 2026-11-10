// Writes open-swe-traces.parquet (SNAPPY) and open-swe-traces.zstd.parquet
// (ZSTD) from open-swe-traces.jsonl, in the column
// shapes nvidia/Open-SWE-Traces ships (messages a list of structs with nested
// tool_calls). Run once from the repository root and commit the output:
//   npm exec --yes --package hyparquet-writer@0.17.0 -- node tests/fixtures/longhaul-converters/make-parquet.mjs
// hyparquet-writer is not a dependency: npm exec fetches the pinned 0.17.0.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// npm exec puts the package's bin dir on PATH, not on the resolver's paths.
async function loadWriter() {
  try {
    return await import('hyparquet-writer');
  } catch {
    const binDir = process.env.PATH.split(process.platform === 'win32' ? ';' : ':').find((p) => /[\\/]_npx[\\/]/.test(p));
    if (!binDir) throw new Error('run through npm exec --package hyparquet-writer@0.17.0');
    const require = createRequire(join(dirname(binDir), 'noop.js'));
    return import(pathToFileURL(require.resolve('hyparquet-writer')).href);
  }
}

const { parquetWriteFile } = await loadWriter();

const rows = readFileSync(join(here, 'open-swe-traces.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));

const str = (name) => ({ name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' });
const int = (name, type) => ({ name, type, repetition_type: 'OPTIONAL' });
const group = (name, n, extra = {}) => ({ name, repetition_type: 'OPTIONAL', num_children: n, ...extra });
const list = (name) => [group(name, 1, { converted_type: 'LIST' }), { name: 'list', repetition_type: 'REPEATED', num_children: 1 }];

const schema = [
  { name: 'root', num_children: 10 },
  str('instance_id'),
  str('repo'),
  str('license'),
  str('language'),
  str('trajectory_id'),
  ...list('messages'),
  group('element', 4),
  str('role'),
  str('content'),
  str('reasoning_content'),
  ...list('tool_calls'),
  group('element', 3),
  group('function', 2),
  str('arguments'),
  str('name'),
  str('id'),
  str('type'),
  ...list('tools'),
  str('element'),
  int('resolved', 'INT32'),
  group('metadata', 3),
  str('category'),
  group('teacher_model', 2),
  str('name'),
  { name: 'enable_thinking', type: 'BOOLEAN', repetition_type: 'OPTIONAL' },
  group('reference_patch', 3),
  str('patch'),
  int('num_modified_files', 'INT64'),
  int('num_modified_lines', 'INT64'),
  str('hf_dataset_name')
];

const names = ['instance_id', 'repo', 'license', 'language', 'trajectory_id', 'messages', 'tools', 'resolved', 'metadata', 'hf_dataset_name'];
const int64 = (m) => ({
  ...m,
  reference_patch: {
    ...m.reference_patch,
    num_modified_files: BigInt(m.reference_patch.num_modified_files),
    num_modified_lines: BigInt(m.reference_patch.num_modified_lines)
  }
});
const columnData = names.map((name) => ({
  name,
  data: rows.map((r) => (name === 'metadata' ? int64(r.metadata) : r[name]))
}));

// Three rows per group, so a reader must walk more than one row group.
parquetWriteFile({ filename: join(here, 'open-swe-traces.parquet'), columnData, schema, rowGroupSize: 3, statistics: false });
// The same rows ZSTD-compressed (as nebius/SWE-rebench-openhands-trajectories
// ships), through node's zlib (Node 22.15 or later).
const sized = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
parquetWriteFile({
  filename: join(here, 'open-swe-traces.zstd.parquet'),
  columnData,
  schema,
  rowGroupSize: 3,
  statistics: false,
  codec: 'ZSTD',
  compressors: { ZSTD: (input) => sized(zlib.zstdCompressSync(input)) }
});
console.log(`wrote ${rows.length} rows, twice`);
