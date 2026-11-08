// The seal between a window and a node, inside the socket a front door splices
// (window-v1, R-RW-1, R-RW-2; docs/protocol/window-v1.md is the written form and
// tests/vectors/window-v1 the bytes). The front door reads nothing past the clear
// hello_w, and can change nothing without one side closing.
//
//   hello_w = 0x01 ‖ 0x01 ‖ eW (32) ‖ device_id (20) ‖ pub_dev (32)
//   hello_n = 0x02 ‖ eN (32) ‖ node_id (19) ‖ pub_node (32) ‖ sig_node (64)
//   auth_w  = 0x03 ‖ sig_dev (64)
//   sig_node over "kl-window-v1\nnode\n" ‖ session ‖ hello_w ‖ hello_n[0..83]
//   sig_dev  over "kl-window-v1\nwindow\n" ‖ session ‖ hello_w ‖ hello_n
//   k_w2n, k_n2w = HKDF-SHA256(X25519(eW, eN), SHA-256(session ‖ hello_w ‖ hello_n), "kl-window-v1 w2n" | "… n2w", 32)
//   record  = 0x10 ‖ counter (8) ‖ ChaCha20-Poly1305(key, 0x00000000 ‖ counter, plaintext, aad = 0x01 ‖ dir ‖ counter)
//   plaintext = kind (1) ‖ len (4) ‖ bytes ‖ zeros, to a multiple of 256 or 4096
//
// `session` is the 32 bytes the base64url session id decodes to. Every field is
// fixed width, so the concatenations cannot be read two ways.
//
// One seal is one session on one message transport: `next` takes one WebSocket
// message, once each, in order. The seal owns the one ordered writer: every message
// it makes reaches `write` in the tick it was made, so a counter's order is the
// wire's, however the caller awaits. A failure closes for good with one code per
// stage (4401 before ready, 4400 after) and one reason, and sends nothing, so an
// unauthenticated peer learns only that it failed. The window's `node_key_changed` is its own, for its tab; it
// says nothing the peer did not send. A record's `len` is read only after its tag
// holds, and a wire length is checked before anything is opened.
//
// Only a close record is authenticated: a socket's close code is a drop, whatever it
// says. A host builds a seal with `write` and `onClose`, sends frames only through
// createFrameSender, and sets SOCKET_OPTIONS and PRE_READY_BYTES on the socket.
//
// An injected `ephemeral` is for vectors only (tests/window-seal.test.js walks src/).
const crypto = require('crypto');
const { deriveDeviceId, fromB64url, verifyWithRawKey } = require('./keys');
const { CLOSE, LIMITS } = require('./protocol');
const { createLogger } = require('../logging');

const log = createLogger('window-seal');

const VERSION = 1;
const RECORD_MAX = 1048576;
const PAD_SMALL = 256;
const PAD_LARGE = 4096;
// A frame under this pads to PAD_SMALL, any other to PAD_LARGE.
const PAD_SPLIT = 65536;
const PING_MS = 20000;
const SILENCE_MS = 60000;

const FRAME_MAX = LIMITS.frameBytes;
const PLAIN_HEAD = 5;
const RECORD_HEAD = 9;
const TAG_BYTES = 16;
const paddedSize = (len, multiple) => Math.ceil((PLAIN_HEAD + len) / multiple) * multiple;
const RECORD_MIN = RECORD_HEAD + PAD_SMALL + TAG_BYTES;
const RECORD_WIRE_MAX = RECORD_HEAD + paddedSize(RECORD_MAX, PAD_LARGE) + TAG_BYTES;

const HELLO_W = Object.freeze({ type: 0x01, bytes: 86, eph: 2, id: 34, key: 54 });
const HELLO_N = Object.freeze({ type: 0x02, bytes: 148, eph: 1, id: 33, key: 52, signed: 84 });
const AUTH_W = Object.freeze({ type: 0x03, bytes: 65 });
const RECORD_TYPE = 0x10;
const KIND = Object.freeze({ final: 0x00, more: 0x01, ping: 0x20, pong: 0x21, close: 0x30 });
const DIR = Object.freeze({ w2n: 0x00, n2w: 0x01 });
const KEY_BYTES = 32;
const SIG_BYTES = 64;
const COUNTER_MAX = (1n << 64n) - 1n;
// No frame, no key: the handshake's deadline, on both roles.
const HANDSHAKE_TIMEOUT = 4408;
// What a device with no record may send, whole, until it is promoted (R-RW-36).
const ENROLL_FRAME_MAX = LIMITS.preAuthFrameBytes;
// What a host sets on a sealed socket, and the raw bytes it takes before ready.
const SOCKET_OPTIONS = Object.freeze({ maxPayload: RECORD_WIRE_MAX, perMessageDeflate: false });
const PRE_READY_BYTES = LIMITS.preAuthSocketBytes;

const NODE_DOMAIN = Buffer.from('kl-window-v1\nnode\n', 'ascii');
const WINDOW_DOMAIN = Buffer.from('kl-window-v1\nwindow\n', 'ascii');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function sealError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function';

const asBytes = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
};

function rawKey(value, what) {
  const bytes = asBytes(value);
  if (!bytes || bytes.length !== KEY_BYTES) throw sealError('SEAL_INVALID', `${what} is 32 raw bytes`);
  return Buffer.from(bytes);
}

function sessionBytes(sessionId) {
  let raw = null;
  try {
    raw = fromB64url(sessionId);
  } catch {
    raw = null;
  }
  if (!raw || raw.length !== KEY_BYTES) throw sealError('SEAL_INVALID', 'a session id is 32 bytes of canonical base64url');
  return raw;
}

function newEphemeral(given) {
  const key = given === null || given === undefined
    ? crypto.generateKeyPairSync('x25519').privateKey
    : crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, rawKey(given, 'an ephemeral key')]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { key, publicRaw: Buffer.from(spki.subarray(X25519_SPKI_PREFIX.length)) };
}

// null for a key that gives no secret: OpenSSL refuses the all-zero output of a
// low-order point, and the check here does not rest on that.
function agree(privateKey, peerRaw) {
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, peerRaw]), format: 'der', type: 'spki' });
    const secret = crypto.diffieHellman({ privateKey, publicKey });
    return secret.length === KEY_BYTES && !secret.equals(Buffer.alloc(KEY_BYTES)) ? secret : null;
  } catch {
    return null;
  }
}

function deriveKeys(secret, session, helloW, helloN) {
  const salt = crypto.createHash('sha256').update(session).update(helloW).update(helloN).digest();
  const expand = (label) => Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from(`kl-window-v1 ${label}`, 'ascii'), KEY_BYTES));
  const keys = { w2n: expand('w2n'), n2w: expand('n2w') };
  secret.fill(0);
  return keys;
}

// The counter after `counter`, or null when none is left: a direction ends there.
function advanceCounter(counter) {
  return counter === COUNTER_MAX ? null : counter + 1n;
}

function counterBytes(counter) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(counter);
  return bytes;
}
const nonceOf = (counter) => Buffer.concat([Buffer.alloc(4), counter]);
const aadOf = (dir, counter) => Buffer.concat([Buffer.from([VERSION, dir]), counter]);

// One key and one counter per direction; holds the only copies of the keys.
class RecordCipher {
  #sendKey;
  #recvKey;
  #sendDir;
  #recvDir;
  #sendCounter = 0n;
  #recvCounter = 0n;

  constructor({ sendKey, recvKey, sendDir, recvDir }) {
    this.#sendKey = sendKey;
    this.#recvKey = recvKey;
    this.#sendDir = sendDir;
    this.#recvDir = recvDir;
  }

  seal(kind, bytes, multiple) {
    if (this.#sendCounter === null) return null;
    const counter = counterBytes(this.#sendCounter);
    this.#sendCounter = advanceCounter(this.#sendCounter);
    const plaintext = Buffer.alloc(paddedSize(bytes.length, multiple));
    plaintext[0] = kind;
    plaintext.writeUInt32BE(bytes.length, 1);
    bytes.copy(plaintext, PLAIN_HEAD);
    const cipher = crypto.createCipheriv('chacha20-poly1305', this.#sendKey, nonceOf(counter), { authTagLength: TAG_BYTES });
    cipher.setAAD(aadOf(this.#sendDir, counter));
    const body = cipher.update(plaintext);
    cipher.final();
    return Buffer.concat([Buffer.from([RECORD_TYPE]), counter, body, cipher.getAuthTag()]);
  }

  // The plaintext, or null. Length, type and counter are refused before any
  // allocation or work; final() checks the tag, and nothing leaves before it has.
  open(record) {
    const size = record.length;
    if (size < RECORD_MIN || size > RECORD_WIRE_MAX || (size - RECORD_HEAD - TAG_BYTES) % PAD_SMALL !== 0) return null;
    if (record[0] !== RECORD_TYPE || this.#recvCounter === null) return null;
    if (record.readBigUInt64BE(1) !== this.#recvCounter) return null;
    const counter = record.subarray(1, RECORD_HEAD);
    try {
      const decipher = crypto.createDecipheriv('chacha20-poly1305', this.#recvKey, nonceOf(counter), { authTagLength: TAG_BYTES });
      decipher.setAAD(aadOf(this.#recvDir, counter));
      decipher.setAuthTag(record.subarray(size - TAG_BYTES));
      const plaintext = decipher.update(record.subarray(RECORD_HEAD, size - TAG_BYTES));
      decipher.final();
      this.#recvCounter = advanceCounter(this.#recvCounter);
      return plaintext;
    } catch {
      return null;
    }
  }

  destroy() {
    this.#sendKey.fill(0);
    this.#recvKey.fill(0);
  }
}

const REASON = Object.freeze({ handshake: 'handshake', record: 'record', peer: 'peer', local: 'local', write: 'write', keyChanged: 'node_key_changed' });
const STATE = Object.freeze({ start: 'start', helloN: 'await-hello-n', helloW: 'await-hello-w', authW: 'await-auth-w', open: 'open' });

class SealSession {
  #role;
  #session;
  #ephemeral;
  #state;
  #busy = false;
  #close = null;
  #peer = null;
  #records = null;
  #run = null;
  #sending = false;
  #helloW = null;
  #helloN = null;
  // role 'window'
  #deviceId;
  #publicKey;
  #sign;
  #pin;
  // role 'node'
  #identity;
  #lookupDevice;
  #enrollUnknown;
  #enrolling = false;
  #claimed = null;
  #write;
  #onClose;
  #deadline;
  #clearTimer;
  #pongOut = false;

  constructor(fields) {
    this.#role = fields.role;
    this.#session = fields.session;
    this.#ephemeral = fields.ephemeral;
    this.#deviceId = fields.deviceId;
    this.#publicKey = fields.publicKey;
    this.#sign = fields.sign;
    this.#pin = fields.pin;
    this.#identity = fields.identity;
    this.#lookupDevice = fields.lookupDevice;
    this.#enrollUnknown = fields.enrollUnknown === true;
    this.#state = fields.role === 'window' ? STATE.start : STATE.helloW;
    this.#write = fields.write;
    this.#onClose = fields.onClose;
    this.#clearTimer = fields.clearTimer;
    this.#deadline = fields.setTimer(() => this.#closeOutside(HANDSHAKE_TIMEOUT, REASON.handshake), LIMITS.handshakeMs);
  }

  get ready() {
    return this.#state === STATE.open && this.#close === null;
  }

  // One message from the peer; on a window, null first, for hello_w. A signature
  // is the only await: nothing legitimate can arrive during one, since the other
  // side is waiting for what it signs. Past the handshake this runs to the end
  // before it returns, so records are taken in the order next() is called.
  async next(message) {
    if (this.#close) return this.#result();
    const bytes = asBytes(message);
    if (this.#state === STATE.open) return bytes ? this.#onRecord(bytes) : this.#fail(CLOSE.MALFORMED, REASON.record);
    if (this.#busy) return this.#failHandshake();
    if (this.#state === STATE.start) return message === null || message === undefined ? this.#start() : this.#failHandshake();
    if (!bytes) return this.#failHandshake();
    if (this.#state === STATE.helloN) return this.#onHelloN(bytes);
    if (this.#state === STATE.helloW) return this.#onHelloW(bytes);
    return this.#onAuthW(bytes);
  }

  // The host found the record a device with none has now: full limits from here on.
  promote() {
    this.#assertSendable();
    this.#enrolling = false;
  }

  // Lazily, one record each step, so a slow socket holds back the encryption too:
  // each step seals a record, hands it to `write`, and yields { size, written },
  // `written` being what `write` returned. createFrameSender is the caller. A ping
  // may be taken between two steps; another frame may not.
  records(frameBytes) {
    this.#assertSendable();
    if (this.#sending) throw sealError('SEAL_BUSY', 'a frame is still going');
    const frame = asBytes(frameBytes);
    if (!frame) throw sealError('SEAL_INVALID', 'a frame is bytes');
    if (frame.length > FRAME_MAX) throw sealError('PAYLOAD_TOO_LARGE', 'the frame is over the bridge limit');
    this.#sending = true;
    return this.#produce(frame);
  }

  ping() {
    this.#assertSendable();
    this.#sendOne(KIND.ping, Buffer.alloc(0), PAD_SMALL);
  }

  // Ends this side too: nothing goes or opens after it.
  closeRecord(code) {
    this.#assertSendable();
    if (!isCloseCode(code)) throw sealError('SEAL_INVALID', 'not a close code a socket can send');
    const body = Buffer.alloc(4);
    body.writeUInt32BE(code);
    this.#sendOne(KIND.close, body, PAD_SMALL);
    this.#end({ code, reason: REASON.local });
  }

  // The socket has gone: nothing goes or opens, no timer stays, and nobody is told.
  destroy() {
    if (!this.#close) this.#end({ code: CLOSE.GOING_AWAY, reason: REASON.local });
  }

  // A generator abandoned partway leaves #sending set: the peer holds half a
  // frame, and anything sent now would merge into it.
  * #produce(frame) {
    const multiple = frame.length < PAD_SPLIT ? PAD_SMALL : PAD_LARGE;
    let offset = 0;
    do {
      const piece = frame.subarray(offset, offset + RECORD_MAX);
      offset += piece.length;
      const more = offset < frame.length;
      if (!more) this.#sending = false;
      yield this.#sendOne(more ? KIND.more : KIND.final, piece, multiple);
    } while (offset < frame.length);
  }

  #assertSendable() {
    if (this.#close) throw sealError('SEAL_CLOSED', 'this session is closed');
    if (this.#state !== STATE.open) throw sealError('SEAL_NOT_READY', 'the handshake has not finished');
  }

  // Sealed and written in one tick: nothing can take a counter between the two.
  #sendOne(kind, bytes, multiple) {
    this.#assertSendable();
    const record = this.#records.seal(kind, bytes, multiple);
    if (record === null) {
      this.#end({ code: CLOSE.MALFORMED, reason: REASON.record });
      throw sealError('SEAL_CLOSED', 'this direction has no counter left');
    }
    return { size: record.length, written: this.#emit(record) };
  }

  // Every write's failure is observed here, whoever else watches it. A write that
  // gives no promise closes at once: every bound on what a seal writes rests on it.
  #emit(bytes) {
    let written;
    try {
      written = this.#write(bytes);
    } catch (err) {
      written = Promise.reject(err);
    }
    if (isThenable(written)) written.then(null, () => this.#closeOutside(CLOSE.GOING_AWAY, REASON.write));
    else this.#closeOutside(CLOSE.GOING_AWAY, REASON.write);
    return written;
  }

  // A close no next() call is there to return.
  #closeOutside(code, reason) {
    if (this.#close || (reason === REASON.handshake && this.#state === STATE.open)) return;
    this.#fail(code, reason);
    try {
      this.#onClose(this.#close);
    } catch (err) {
      // From a timer or a promise a throw here would end the process.
      log.error(`a seal's onClose threw: ${err.message}`);
    }
  }

  #result({ frames = [] } = {}) {
    return { frames, close: this.#close, ready: this.ready, peer: this.#peer };
  }

  #clearDeadline() {
    if (this.#deadline === null) return;
    this.#clearTimer(this.#deadline);
    this.#deadline = null;
  }

  // The first close stands.
  #end(close) {
    if (this.#close) return;
    this.#clearDeadline();
    this.#close = close;
    this.#run = null;
    this.#ephemeral = null;
    if (this.#records) this.#records.destroy();
  }

  #fail(code, reason) {
    if (!this.#close) this.#peer = null;
    this.#end({ code, reason });
    return this.#result();
  }

  #failHandshake(reason = REASON.handshake) {
    return this.#fail(CLOSE.BAD_SIGNATURE, reason);
  }

  #start() {
    const eph = this.#ephemeral.publicRaw;
    this.#helloW = Buffer.concat([Buffer.from([HELLO_W.type, VERSION]), eph, Buffer.from(this.#deviceId, 'ascii'), this.#publicKey]);
    this.#state = STATE.helloN;
    this.#emit(this.#helloW);
    return this.#result();
  }

  async #signed(signer, bytes) {
    this.#busy = true;
    let signature = null;
    try {
      signature = asBytes(await signer(bytes));
    } catch {
      signature = null;
    }
    this.#busy = false;
    if (this.#close || !signature || signature.length !== SIG_BYTES) return null;
    return signature;
  }

  #openRecords(keys) {
    const isWindow = this.#role === 'window';
    this.#records = new RecordCipher({
      sendKey: isWindow ? keys.w2n : keys.n2w,
      recvKey: isWindow ? keys.n2w : keys.w2n,
      sendDir: isWindow ? DIR.w2n : DIR.n2w,
      recvDir: isWindow ? DIR.n2w : DIR.w2n
    });
  }

  // The window: everything is checked before it signs, and auth_w is the last
  // thing the handshake does on this side.
  async #onHelloN(hello) {
    if (hello.length !== HELLO_N.bytes || hello[0] !== HELLO_N.type) return this.#failHandshake();
    const eph = hello.subarray(HELLO_N.eph, HELLO_N.id);
    const nodeId = hello.subarray(HELLO_N.id, HELLO_N.key).toString('latin1');
    const nodeKey = hello.subarray(HELLO_N.key, HELLO_N.signed);
    if (deriveDeviceId(nodeKey, 'kl-') !== nodeId) return this.#failHandshake();
    if (this.#pin && !this.#pin.equals(nodeKey)) return this.#failHandshake(REASON.keyChanged);
    // A peer that hands back this side's own key contributed no key of its own.
    if (eph.equals(this.#ephemeral.publicRaw)) return this.#failHandshake();
    const signed = Buffer.concat([NODE_DOMAIN, this.#session, this.#helloW, hello.subarray(0, HELLO_N.signed)]);
    if (!verifyWithRawKey(nodeKey, signed, hello.subarray(HELLO_N.signed))) return this.#failHandshake();
    const secret = agree(this.#ephemeral.key, eph);
    if (!secret) return this.#failHandshake();
    this.#ephemeral = null;
    const helloN = Buffer.from(hello);
    const signature = await this.#signed(this.#sign, Buffer.concat([WINDOW_DOMAIN, this.#session, this.#helloW, helloN]));
    if (!signature) {
      secret.fill(0);
      return this.#failHandshake();
    }
    this.#openRecords(deriveKeys(secret, this.#session, this.#helloW, helloN));
    this.#peer = { nodeId, publicKey: Buffer.from(helloN.subarray(HELLO_N.key, HELLO_N.signed)) };
    this.#state = STATE.open;
    this.#clearDeadline();
    this.#emit(Buffer.concat([Buffer.from([AUTH_W.type]), signature]));
    return this.#result();
  }

  // The node answers every well-formed hello alike, known device or not: whether a
  // device is enrolled is decided at auth_w, and said with the one code.
  async #onHelloW(hello) {
    if (hello.length !== HELLO_W.bytes || hello[0] !== HELLO_W.type || hello[1] !== VERSION) return this.#failHandshake();
    const eph = hello.subarray(HELLO_W.eph, HELLO_W.id);
    const deviceId = hello.subarray(HELLO_W.id, HELLO_W.key).toString('latin1');
    const deviceKey = hello.subarray(HELLO_W.key, HELLO_W.bytes);
    if (deriveDeviceId(deviceKey, 'kld-') !== deviceId) return this.#failHandshake();
    const secret = agree(this.#ephemeral.key, eph);
    if (!secret) return this.#failHandshake();
    const head = Buffer.concat([Buffer.from([HELLO_N.type]), this.#ephemeral.publicRaw, Buffer.from(this.#identity.nodeId, 'ascii'), this.#identity.publicKey]);
    this.#ephemeral = null;
    const helloW = Buffer.from(hello);
    const signature = await this.#signed((bytes) => this.#identity.sign(bytes), Buffer.concat([NODE_DOMAIN, this.#session, helloW, head]));
    if (!signature) {
      secret.fill(0);
      return this.#failHandshake();
    }
    this.#helloW = helloW;
    this.#helloN = Buffer.concat([head, signature]);
    this.#openRecords(deriveKeys(secret, this.#session, helloW, this.#helloN));
    this.#claimed = { deviceId, publicKey: Buffer.from(helloW.subarray(HELLO_W.key, HELLO_W.bytes)) };
    this.#state = STATE.authW;
    this.#emit(this.#helloN);
    return this.#result();
  }

  // Synchronous, so the window's first records, sent right behind auth_w, find
  // this done. A lookup that answers a promise cannot be read in time: unknown.
  #onAuthW(auth) {
    if (auth.length !== AUTH_W.bytes || auth[0] !== AUTH_W.type) return this.#failHandshake();
    const claimed = this.#claimed;
    const known = this.#lookup(claimed.deviceId);
    const signed = Buffer.concat([WINDOW_DOMAIN, this.#session, this.#helloW, this.#helloN]);
    if (this.#enrollUnknown) return this.#onAuthEnrolling(claimed, known, signed, auth.subarray(1));
    // The signature is checked for an unknown device too, so its time says nothing.
    const verified = verifyWithRawKey(known || claimed.publicKey, signed, auth.subarray(1));
    if (!known || !known.equals(claimed.publicKey) || !verified) return this.#failHandshake();
    this.#peer = claimed;
    this.#state = STATE.open;
    this.#clearDeadline();
    return this.#result();
  }

  // R-RW-36, a host's option: the key the window claimed proves itself first, and a
  // device with no record is told apart from one with a record by `enrolled`, so nothing
  // takes it for one. A stored key that differs is the one failure as ever.
  #onAuthEnrolling(claimed, known, signed, signature) {
    if (!verifyWithRawKey(claimed.publicKey, signed, signature)) return this.#failHandshake();
    if (known && !known.equals(claimed.publicKey)) return this.#failHandshake();
    this.#peer = { ...claimed, enrolled: Boolean(known) };
    this.#enrolling = !known;
    this.#state = STATE.open;
    this.#clearDeadline();
    return this.#result();
  }

  #lookup(deviceId) {
    try {
      const answer = this.#lookupDevice(deviceId);
      if (answer && typeof answer.then === 'function') {
        answer.then(null, () => {});
        return null;
      }
      const raw = asBytes(answer);
      return raw && raw.length === KEY_BYTES ? Buffer.from(raw) : null;
    } catch {
      return null;
    }
  }

  #onRecord(record) {
    const plaintext = this.#records.open(record);
    if (!plaintext) return this.#fail(CLOSE.MALFORMED, REASON.record);
    const kind = plaintext[0];
    const len = plaintext.readUInt32BE(1);
    const multiple = this.#paddingFor(kind, len);
    if (multiple === 0 || !hasExactPadding(plaintext, len, multiple)) return this.#fail(CLOSE.MALFORMED, REASON.record);
    const bytes = plaintext.subarray(PLAIN_HEAD, PLAIN_HEAD + len);
    if (kind === KIND.more) {
      if (!this.#run) this.#run = { parts: [], bytes: 0 };
      this.#run.parts.push(bytes);
      this.#run.bytes += len;
      return this.#result();
    }
    if (kind === KIND.final) {
      if (!this.#run) return this.#result({ frames: [bytes] });
      const frame = Buffer.concat([...this.#run.parts, bytes]);
      this.#run = null;
      return this.#result({ frames: [frame] });
    }
    if (kind === KIND.ping) return this.#onPing();
    if (kind === KIND.pong) return this.#result();
    const code = bytes.readUInt32BE(0);
    if (!isCloseCode(code)) return this.#fail(CLOSE.MALFORMED, REASON.record);
    this.#end({ code, reason: REASON.peer });
    return this.#result();
  }

  // At most one pong the socket has not taken: pings from a peer that reads nothing
  // cost no more than that.
  #onPing() {
    if (this.#pongOut) return this.#result();
    try {
      const { written } = this.#sendOne(KIND.pong, Buffer.alloc(0), PAD_SMALL);
      if (isThenable(written)) {
        this.#pongOut = true;
        const taken = () => { this.#pongOut = false; };
        written.then(taken, taken);
      }
      return this.#result();
    } catch {
      return this.#fail(CLOSE.MALFORMED, REASON.record);
    }
  }

  // The multiple this kind and length pad to, or 0 for what no sender makes. A
  // `more` fragment is always a whole RECORD_MAX and always leaves room for the
  // final one, so one frame has one encoding and a run past the limit is refused
  // before it is held.
  #paddingFor(kind, len) {
    if (this.#enrolling && (kind === KIND.more || (kind === KIND.final && len > ENROLL_FRAME_MAX))) return 0;
    if (kind === KIND.more) {
      const held = this.#run ? this.#run.bytes : 0;
      return len === RECORD_MAX && held + len < FRAME_MAX ? PAD_LARGE : 0;
    }
    if (kind === KIND.final) {
      if (len > RECORD_MAX) return 0;
      if (this.#run) return len > 0 && this.#run.bytes + len <= FRAME_MAX ? PAD_LARGE : 0;
      return len < PAD_SPLIT ? PAD_SMALL : PAD_LARGE;
    }
    if (kind === KIND.ping || kind === KIND.pong) return len === 0 ? PAD_SMALL : 0;
    if (kind === KIND.close) return len === 4 ? PAD_SMALL : 0;
    return 0;
  }
}

// The codes a WebSocket may send: ws.close throws on any other, and a peer's code
// reaches a socket's close.
function isCloseCode(code) {
  if (!Number.isInteger(code)) return false;
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

function hostFields({ write, onClose, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof write !== 'function') throw sealError('SEAL_INVALID', 'a seal writes');
  if (typeof onClose !== 'function') throw sealError('SEAL_INVALID', 'a seal says when it closes');
  return { write, onClose, setTimer, clearTimer };
}

function hasExactPadding(plaintext, len, multiple) {
  if (plaintext.length !== paddedSize(len, multiple)) return false;
  for (let i = PLAIN_HEAD + len; i < plaintext.length; i += 1) {
    if (plaintext[i] !== 0) return false;
  }
  return true;
}

const WindowSeal = Object.freeze({
  window({ sessionId, deviceId, publicKey, sign, pin = null, write, onClose, setTimer, clearTimer, ephemeral = null } = {}) {
    const key = rawKey(publicKey, 'a device key');
    if (deriveDeviceId(key, 'kld-') !== deviceId) throw sealError('SEAL_INVALID', 'the device id is not this key\'s');
    if (typeof sign !== 'function') throw sealError('SEAL_INVALID', 'a window signs');
    return new SealSession({
      role: 'window',
      session: sessionBytes(sessionId),
      deviceId,
      publicKey: key,
      sign,
      pin: pin === null ? null : rawKey(pin, 'a pin'),
      ephemeral: newEphemeral(ephemeral),
      ...hostFields({ write, onClose, setTimer, clearTimer })
    });
  },

  node({ sessionId, identity, lookupDevice, enrollUnknown = false, write, onClose, setTimer, clearTimer, ephemeral = null } = {}) {
    if (!identity || typeof identity.sign !== 'function') throw sealError('SEAL_INVALID', 'a node signs');
    if (typeof lookupDevice !== 'function') throw sealError('SEAL_INVALID', 'a node looks devices up');
    const key = rawKey(identity.publicKey, 'a node key');
    if (deriveDeviceId(key, 'kl-') !== identity.nodeId) throw sealError('SEAL_INVALID', 'the node id is not this key\'s');
    return new SealSession({
      role: 'node',
      session: sessionBytes(sessionId),
      identity: { nodeId: identity.nodeId, publicKey: key, sign: (bytes) => identity.sign(bytes) },
      lookupDevice,
      enrollUnknown,
      ephemeral: newEphemeral(ephemeral),
      ...hostFields({ write, onClose, setTimer, clearTimer })
    });
  }
});

// Sends whole frames through a seal with the socket's backpressure. The seal's
// `write` must return a promise that settles when the socket has taken the record
// (ws's send callback); one that returns anything else ends the sender
// SEND_NO_BACKPRESSURE, since nothing could then hold it back. At most `highWater` bytes of records are out at once, and a record is
// encrypted only when it may go, so a slow reader costs one frame's reference and
// the high water. Frames held behind that are bounded too: past `maxQueuedBytes`
// send refuses SEND_QUEUE_FULL, and the caller closes the session.
function createFrameSender({ seal, write, highWater = 4 * RECORD_WIRE_MAX, maxQueuedBytes = 2 * FRAME_MAX }) {
  if (write !== undefined) throw sealError('SEAL_INVALID', 'the seal holds the writer');
  const entries = [];
  // Every frame whose promise has not settled, written out or not.
  const unsettled = new Set();
  let queued = 0;
  let inFlight = 0;
  let failure = null;
  let pumping = false;
  let wake = null;

  const rouse = () => {
    if (!wake) return;
    const resume = wake;
    wake = null;
    resume();
  };
  const fail = (err) => {
    if (failure) return;
    failure = err;
    entries.length = 0;
    for (const entry of unsettled) entry.reject(err);
    unsettled.clear();
    rouse();
  };
  const settle = (entry) => {
    if (!entry.produced || entry.outstanding !== 0 || !unsettled.delete(entry)) return;
    entry.resolve();
  };

  function track(entry, { size, written }) {
    if (!isThenable(written)) {
      fail(sealError('SEND_NO_BACKPRESSURE', 'the writer gives no promise'));
      return;
    }
    entry.outstanding += 1;
    inFlight += size;
    written.then(() => {
      inFlight -= size;
      entry.outstanding -= 1;
      settle(entry);
      if (inFlight < highWater) rouse();
    }, fail);
  }

  async function pump() {
    pumping = true;
    try {
      while (entries.length > 0 && !failure) {
        const entry = entries[0];
        for (const step of seal.records(entry.frame)) {
          track(entry, step);
          while (inFlight >= highWater && !failure) {
            await new Promise((resolve) => { wake = resolve; });
          }
          // Before the generator is asked again: its next step seals and writes.
          if (failure) break;
        }
        if (failure) break;
        entries.shift();
        queued -= entry.frame.length;
        entry.frame = null;
        entry.produced = true;
        settle(entry);
      }
    } catch (err) {
      fail(err);
    }
    pumping = false;
  }

  return {
    send(frameBytes) {
      if (failure) return Promise.reject(failure);
      const frame = asBytes(frameBytes);
      if (!frame) return Promise.reject(sealError('SEAL_INVALID', 'a frame is bytes'));
      if (frame.length > FRAME_MAX) return Promise.reject(sealError('PAYLOAD_TOO_LARGE', 'the frame is over the bridge limit'));
      if (queued + frame.length > maxQueuedBytes) return Promise.reject(sealError('SEND_QUEUE_FULL', 'the peer is not reading'));
      queued += frame.length;
      const done = new Promise((resolve, reject) => {
        const entry = { frame, outstanding: 0, produced: false, resolve, reject };
        entries.push(entry);
        unsettled.add(entry);
      });
      if (!pumping) pump();
      return done;
    },
    stop() {
      fail(sealError('SEND_STOPPED', 'the sender stopped'));
    }
  };
}

// Ping after PING_MS of sending nothing; 1001 after SILENCE_MS of receiving
// nothing. The caller tells it `sent()` and `received()`, for every record, and
// `ping` must check the seal is ready. The timer is ref'd: a session that is
// open keeps the process up until its host stops it.
function startHeartbeat({ ping, onSilence, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let lastSent = now();
  let lastReceived = now();
  let timer = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const silence = () => {
    stop();
    onSilence({ code: CLOSE.GOING_AWAY, reason: 'silence' });
  };
  const schedule = () => {
    if (stopped) return;
    const due = Math.min(lastSent + PING_MS, lastReceived + SILENCE_MS);
    timer = setTimer(fire, Math.max(0, due - now()));
  };
  function fire() {
    timer = null;
    const at = now();
    if (at - lastReceived >= SILENCE_MS) {
      silence();
      return;
    }
    if (at - lastSent >= PING_MS) {
      lastSent = at;
      try {
        ping();
      } catch {
        // A seal that cannot ping has closed; nothing more will come.
        silence();
        return;
      }
    }
    schedule();
  }
  schedule();

  return {
    sent() { lastSent = now(); },
    received() { lastReceived = now(); },
    stop
  };
}

module.exports = {
  WindowSeal,
  VERSION,
  RECORD_MAX,
  RECORD_WIRE_MAX,
  PAD_SMALL,
  PAD_LARGE,
  PAD_SPLIT,
  PING_MS,
  SILENCE_MS,
  HANDSHAKE_TIMEOUT,
  ENROLL_FRAME_MAX,
  PRE_READY_BYTES,
  SOCKET_OPTIONS,
  advanceCounter,
  isCloseCode,
  createFrameSender,
  startHeartbeat
};
