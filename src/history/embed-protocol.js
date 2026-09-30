// src/history/embed-protocol.js
// The wire format between EmbedRunner and embed-worker.js: one JSON object
// per line (JSON escapes every newline inside a string). Requests go on the
// worker's stdin; replies and progress events come back on its fd 3. stdout
// is not connected, so a library that prints cannot corrupt a reply.
// Vectors travel as base64 little-endian float32.
const { StringDecoder } = require('node:string_decoder');
const { vecToBlob, blobToVec } = require('./embedders/vectors');

// A reply of 8 vectors of 1,024 dims is about 44 KB; a request of 8 texts at
// most 6,000 characters each. Anything near this is a broken peer.
const MAX_LINE_CHARS = 64 * 1024 * 1024;

const encodeMessage = (msg) => `${JSON.stringify(msg)}\n`;

class LineReader {
  constructor({ onMessage, onError, maxLineChars = MAX_LINE_CHARS }) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.maxLineChars = maxLineChars;
    this.decoder = new StringDecoder('utf8');
    this.buf = '';
    this.dead = false;
  }

  push(chunk) {
    if (this.dead) return;
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl;
    while (!this.dead && (nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.fail(new Error('a line that is not JSON'));
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        this.fail(new Error('a line that is not a JSON object'));
        return;
      }
      this.onMessage(msg);
    }
    if (this.buf.length > this.maxLineChars) this.fail(new Error('a line over the size limit'));
  }

  fail(err) {
    if (this.dead) return;
    this.dead = true;
    this.buf = '';
    this.onError(err);
  }
}

const vecToBase64 = (vec) => vecToBlob(vec).toString('base64');
const base64ToVec = (s) => blobToVec(new Uint8Array(Buffer.from(String(s), 'base64')));

module.exports = { MAX_LINE_CHARS, encodeMessage, LineReader, vecToBase64, base64ToVec };
