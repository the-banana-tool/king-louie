// Reads SNI and ALPN out of a TLS ClientHello before anything answers it
// (fleet stage 4 §3.2), so the front door can pick a TLS setup per name: a
// server-wide requestCert would make browsers visiting mcp. show a client
// certificate picker. This parser faces the internet: every length is
// checked against what is actually there, the total is capped at 16 KiB,
// and anything malformed is a ClientHelloError — never another exception.
const MAX_HELLO_BYTES = 16384;
const HELLO_TIMEOUT_MS = 5000;
const RECORD_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXT_SERVER_NAME = 0x0000;
const EXT_ALPN = 0x0010;

class ClientHelloError extends Error {
  constructor(message) {
    super(`malformed ClientHello: ${message}`);
    this.name = 'ClientHelloError';
    this.code = 'malformed';
  }
}

const bad = (message) => { throw new ClientHelloError(message); };

// A cursor that refuses to read past its end.
function reader(buf, start, end) {
  let pos = start;
  const need = (n) => { if (n < 0 || pos + n > end) bad(`length ${n} runs past the data`); };
  return {
    get pos() { return pos; },
    get left() { return end - pos; },
    u8() { need(1); return buf[pos++]; },
    u16() { need(2); const v = buf.readUInt16BE(pos); pos += 2; return v; },
    u24() { need(3); const v = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2]; pos += 3; return v; },
    bytes(n) { need(n); const v = buf.subarray(pos, pos + n); pos += n; return v; },
    skip(n) { need(n); pos += n; }
  };
}

// The handshake bytes carried by the records in `buf`, including the part of
// a record that has not all arrived yet. Walking stops once the first
// handshake message is whole: records after it (0-RTT early data) are not
// the hello's. `complete` is false when the walk ran out of data.
function handshakeBytes(buf) {
  const parts = [];
  let have = 0;
  let wanted = Infinity; // 4 + the handshake body length, once its header is in
  let off = 0;
  let complete = true;
  while (off < buf.length && have < wanted) {
    if (buf.length - off < 5) { complete = false; break; }
    if (buf[off] !== RECORD_HANDSHAKE) bad(`record type ${buf[off]} is not a handshake`);
    if (buf[off + 1] !== 0x03) bad('record version is not TLS');
    const len = buf.readUInt16BE(off + 3);
    if (len === 0 || len > MAX_HELLO_BYTES) bad(`record length ${len}`);
    const avail = Math.min(len, buf.length - off - 5);
    parts.push(buf.subarray(off + 5, off + 5 + avail));
    have += avail;
    if (have > MAX_HELLO_BYTES) bad('handshake over 16 KiB');
    if (wanted === Infinity && have >= 4) {
      const head = parts.length === 1 ? parts[0] : Buffer.concat(parts, 4);
      wanted = 4 + ((head[1] << 16) | (head[2] << 8) | head[3]);
    }
    if (avail < len) { complete = false; break; }
    off += 5 + len;
  }
  if (off >= buf.length && have < wanted) complete = false;
  return { bytes: parts.length === 1 ? parts[0] : Buffer.concat(parts), complete };
}

// A DNS host name: printable ASCII without spaces, no empty label (so no
// leading, doubled or trailing dot), returned lower-cased.
function hostName(value) {
  if (value.length === 0 || value.length > 255) bad('host name length');
  for (const b of value) if (b < 0x21 || b > 0x7e) bad('host name is not printable ASCII');
  const name = value.toString('ascii').toLowerCase();
  if (name.split('.').some((label) => label.length === 0)) bad('host name has an empty label');
  return name;
}

function parseServerName(data) {
  const r = reader(data, 0, data.length);
  const listLen = r.u16();
  if (listLen !== r.left) bad('server_name list length');
  let name = null;
  while (r.left > 0) {
    const type = r.u8();
    const len = r.u16();
    const value = r.bytes(len);
    if (type === 0) {
      if (name !== null) bad('two host names');
      name = hostName(value);
    }
  }
  return name;
}

function parseAlpn(data) {
  const r = reader(data, 0, data.length);
  const listLen = r.u16();
  if (listLen !== r.left || listLen === 0) bad('ALPN list length');
  const out = [];
  while (r.left > 0) {
    const len = r.u8();
    if (len === 0) bad('empty ALPN protocol');
    const value = r.bytes(len);
    for (const b of value) if (b < 0x20 || b > 0x7e) bad('ALPN protocol is not printable');
    out.push(value.toString('ascii'));
  }
  return out;
}

function parseClientHello(buf) {
  if (!Buffer.isBuffer(buf)) bad('not a buffer');
  if (buf.length > MAX_HELLO_BYTES + 5 * 8) bad('over 16 KiB');
  const { bytes, complete } = handshakeBytes(buf);
  if (bytes.length < 4) return { incomplete: true };
  if (bytes[0] !== HANDSHAKE_CLIENT_HELLO) bad(`handshake type ${bytes[0]} is not a ClientHello`);
  const bodyLen = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  if (bodyLen < 38 || bodyLen > MAX_HELLO_BYTES) bad(`ClientHello length ${bodyLen}`);
  if (bytes.length < 4 + bodyLen) {
    if (complete && buf.length >= MAX_HELLO_BYTES) bad('over 16 KiB');
    return { incomplete: true };
  }
  const r = reader(bytes, 4, 4 + bodyLen);
  r.skip(2); // legacy_version
  r.skip(32); // random
  const sessionIdLen = r.u8();
  if (sessionIdLen > 32) bad('session id length');
  r.skip(sessionIdLen);
  const suitesLen = r.u16();
  if (suitesLen < 2 || suitesLen % 2 !== 0) bad('cipher suites length');
  r.skip(suitesLen);
  const compLen = r.u8();
  if (compLen < 1) bad('compression methods length');
  r.skip(compLen);
  let serverName = null;
  let alpn = [];
  if (r.left > 0) {
    const extLen = r.u16();
    if (extLen !== r.left) bad('extensions length');
    const seen = new Set();
    while (r.left > 0) {
      const type = r.u16();
      const len = r.u16();
      const data = r.bytes(len);
      if (seen.has(type)) bad(`extension ${type} twice`);
      seen.add(type);
      if (type === EXT_SERVER_NAME) serverName = parseServerName(data);
      else if (type === EXT_ALPN) alpn = parseAlpn(data);
    }
  }
  return { serverName, alpn };
}

function peekError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Resolves with the parsed hello and every byte read, which are unshifted
// back onto the paused socket for the TLSSocket that wraps it. Rejects past
// `maxBytes` or `timeoutMs`, on a parse error, error or close; it never
// destroys the socket (the caller does). Every path removes its listeners
// and clears its timer.
function peekClientHello(socket, { maxBytes = MAX_HELLO_BYTES, timeoutMs = HELLO_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(peekError('closed', 'closed before a ClientHello arrived'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    let timer = null;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes) {
        finish(new ClientHelloError(`over ${maxBytes} bytes`));
        return;
      }
      const buffer = Buffer.concat(chunks, size);
      let result;
      try {
        result = parseClientHello(buffer);
      } catch (err) {
        finish(err);
        return;
      }
      if (result.incomplete) return;
      socket.pause();
      socket.removeListener('data', onData);
      socket.unshift(buffer);
      finish(null, { hello: result, buffer });
    };
    const onClose = () => finish(peekError('closed', 'closed before a ClientHello arrived'));
    const onError = (err) => finish(peekError('closed', `socket error before a ClientHello arrived: ${err && err.message}`));
    timer = setTimeout(() => finish(peekError('timeout', `ClientHello timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

module.exports = { parseClientHello, peekClientHello, ClientHelloError, MAX_HELLO_BYTES, HELLO_TIMEOUT_MS };
