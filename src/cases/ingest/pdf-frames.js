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
// returns null to accept, or a value that is passed to onError. onFrame gets
// a null-prototype header and the payload (a Buffer the reader never reuses).
// After the first error the reader drops everything.
class FrameReader {
  constructor({ limit, onFrame, onError, headerMax = HEADER_MAX_BYTES }) {
    this.limit = limit;
    this.onFrame = onFrame;
    this.onError = onError;
    this.headerMax = headerMax;
    this.chunks = [];
    this.have = 0;
    this.need = null;
    this.dead = false;
  }

  fail(reason) {
    if (this.dead) return;
    this.dead = true;
    this.chunks = [];
    this.have = 0;
    this.onError(reason);
  }

  take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.have);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.have = rest.length;
    return all.subarray(0, n);
  }

  push(chunk) {
    if (this.dead) return;
    this.chunks.push(chunk);
    this.have += chunk.length;
    while (!this.dead) {
      if (this.need === null) {
        if (this.have < 4) return;
        const length = this.take(4).readUInt32BE(0);
        if (length < 4) return this.fail(new FrameError('frame shorter than its header length'));
        const verdict = this.limit(length);
        if (verdict != null) return this.fail(verdict);
        this.need = length;
      }
      if (this.have < this.need) return;
      const body = Buffer.from(this.take(this.need));
      this.need = null;
      const headerLength = body.readUInt32BE(0);
      if (headerLength > this.headerMax || headerLength > body.length - 4) return this.fail(new FrameError('bad header length'));
      let header;
      try {
        header = JSON.parse(body.subarray(4, 4 + headerLength).toString('utf8'));
      } catch {
        return this.fail(new FrameError('header is not JSON'));
      }
      if (!header || typeof header !== 'object' || Array.isArray(header)) return this.fail(new FrameError('header is not an object'));
      this.onFrame(Object.assign(Object.create(null), header), body.subarray(4 + headerLength));
    }
  }

  end() {
    if (this.dead) return;
    if (this.have > 0 || this.need !== null) this.fail(new FrameError('partial frame at end of stream'));
  }
}

module.exports = { encodeFrame, FrameReader, FrameError, HEADER_MAX_BYTES, LIMITS };
