// src/cases/ingest/pdf-frames.js
// The wire format between openPdf and its worker (ruling T3b-frames). There is
// no Node IPC channel: requests go on the child's stdin and replies come back
// on its fd 3, both as frames of
//   u32 BE length of what follows | u32 BE header length | JSON header | payload
// The reader checks the declared length before it keeps any byte of the body,
// so the child cannot make the parent buffer more than the caller allows.
// Plain Node, no parser: the parent loads this module, and so does the worker.
const MB = 1024 * 1024;

// A reply header is a few small fields; anything larger is not a reply.
const HEADER_MAX_BYTES = 4096;

// Reply payload caps, at the Task 5 vision limits (IMAGE_MAX_BYTES,
// MAX_DOCUMENT_SIZE_BYTES) for the page copy and the page image.
const LIMITS = Object.freeze({
  pageTextBytes: 2 * MB,
  pagePdfBytes: 10 * MB,
  pageImageBytes: 5 * MB,
  // One byte per page (the rotation in quarter turns) in the open reply.
  pages: 100000
});

function encodeFrame(header, payload = null) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const body = payload ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength) : Buffer.alloc(0);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(4 + json.length + body.length, 0);
  prefix.writeUInt32BE(json.length, 4);
  return body.length ? [prefix, json, body] : [Buffer.concat([prefix, json])];
}

class FrameError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'FrameError';
  }
}

// push(chunk) as bytes arrive, end() at end of stream. `limit(length)` is
// asked about each frame's declared length before its body is kept: it
// returns null to accept, or a value that is passed to onError. An accepted
// frame gets one Buffer of exactly its declared size, and every chunk is
// copied into it and dropped, so a frame dripped one byte per write costs its
// own size, not a chunk object per byte. onFrame gets a null-prototype header
// and the payload (a view of that Buffer, never reused). After the first
// error the reader drops everything.
class FrameReader {
  constructor({ limit, onFrame, onError, headerMax = HEADER_MAX_BYTES }) {
    this.limit = limit;
    this.onFrame = onFrame;
    this.onError = onError;
    this.headerMax = headerMax;
    this.prefix = Buffer.alloc(4);
    this.prefixFilled = 0;
    this.body = null;
    this.filled = 0;
    this.dead = false;
  }

  fail(reason) {
    if (this.dead) return;
    this.dead = true;
    this.body = null;
    this.onError(reason);
  }

  push(chunk) {
    let at = 0;
    while (!this.dead && at < chunk.length) {
      if (this.body === null) {
        const n = Math.min(4 - this.prefixFilled, chunk.length - at);
        chunk.copy(this.prefix, this.prefixFilled, at, at + n);
        this.prefixFilled += n;
        at += n;
        if (this.prefixFilled < 4) return;
        this.prefixFilled = 0;
        const length = this.prefix.readUInt32BE(0);
        if (length < 4) return this.fail(new FrameError('frame shorter than its header length'));
        const verdict = this.limit(length);
        if (verdict != null) return this.fail(verdict);
        this.body = Buffer.alloc(length);
        this.filled = 0;
      }
      const n = Math.min(this.body.length - this.filled, chunk.length - at);
      chunk.copy(this.body, this.filled, at, at + n);
      this.filled += n;
      at += n;
      if (this.filled === this.body.length) {
        const body = this.body;
        this.body = null;
        this.frame(body);
      }
    }
  }

  frame(body) {
    const headerLength = body.readUInt32BE(0);
    if (headerLength > this.headerMax || headerLength > body.length - 4) return this.fail(new FrameError('bad header length'));
    let header;
    try {
      header = JSON.parse(body.subarray(4, 4 + headerLength).toString('utf8'));
    } catch {
      return this.fail(new FrameError('header is not JSON'));
    }
    if (!header || typeof header !== 'object' || Array.isArray(header)) return this.fail(new FrameError('header is not an object'));
    return this.onFrame(Object.assign(Object.create(null), header), body.subarray(4 + headerLength));
  }

  end() {
    if (this.dead) return;
    if (this.prefixFilled > 0 || this.body !== null) this.fail(new FrameError('partial frame at end of stream'));
  }
}

module.exports = { encodeFrame, FrameReader, FrameError, HEADER_MAX_BYTES, LIMITS };
