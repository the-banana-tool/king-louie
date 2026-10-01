// src/history/embedders/vectors.js
// Vector plumbing shared by the store, the embedders and the worker protocol.
const os = require('os');
const { EmbedError } = require('../embed-errors');

// The longest text sent to an embedder. text-embedding-3-* take 8,191
// tokens; the local models truncate at 512 tokens themselves. 6,000
// characters stays under the first at one character per token (the same
// limit as LongHaul's embed cache).
const MAX_EMBED_CHARS = 6000;
const LITTLE_ENDIAN = os.endianness() === 'LE';

function embedInput(text) {
  const s = String(text ?? '');
  const cut = s.length > MAX_EMBED_CHARS ? s.slice(0, MAX_EMBED_CHARS) : s;
  return cut.trim() ? cut : ' ';
}

// Unit length, so cosine is a dot product. A zero vector (a text with nothing
// the model reads) stays zero: it is close to nothing.
function unit(values) {
  const v = Float32Array.from(values || []);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  if (!v.length || !Number.isFinite(sum)) throw new EmbedError('EMBED_FAILED', 'the embedder returned an empty or non-finite vector');
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

// The dot product of b with b.length values of a from aOffset (a matrix row,
// without a subarray per row); for unit vectors, their cosine.
function dot(a, b, aOffset = 0) {
  let sum = 0;
  for (let i = 0; i < b.length; i++) sum += a[aOffset + i] * b[i];
  return sum;
}

// Little-endian float32, as the embeddings table stores it (spec §4.1).
function vecToBlob(vec) {
  const out = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) out.writeFloatLE(vec[i], i * 4);
  return out;
}

// node:sqlite hands a BLOB back as a Uint8Array.
function blobToVec(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const n = Math.floor(u8.byteLength / 4);
  if (LITTLE_ENDIAN) return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + n * 4));
  const view = new DataView(u8.buffer, u8.byteOffset, n * 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

module.exports = { MAX_EMBED_CHARS, embedInput, unit, dot, vecToBlob, blobToVec };
