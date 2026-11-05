// tests/helpers/window-seal-fixture.js
//
// The window-v1 test keys as the seal takes them, a session id from a label, a
// handshake run to the end, and an in-process pair of message transports.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const KEYS = require('../vectors/window-v1/keys.json');

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();

const sessionIdOf = (label) => sha(`window session ${label}`).toString('base64url');
const ephemeralOf = (label) => sha(`window epk ${label}`);

function signerFor(entry) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(entry.seed, 'hex')]), format: 'der', type: 'pkcs8' });
  return (bytes) => crypto.sign(null, bytes, key);
}

function windowKey(name = 'A') {
  const entry = KEYS.windows[name];
  return { deviceId: entry.id, publicKey: Buffer.from(entry.public_key, 'hex'), sign: signerFor(entry) };
}

function nodeKey(name = 'web-01') {
  const entry = KEYS.nodes[name];
  return { nodeId: entry.id, publicKey: Buffer.from(entry.public_key, 'hex'), sign: signerFor(entry) };
}

// A lookup that knows the given windows and nobody else.
function lookupOf(...names) {
  const known = new Map(names.map((name) => [KEYS.windows[name].id, Buffer.from(KEYS.windows[name].public_key, 'hex')]));
  return (deviceId) => known.get(deviceId) || null;
}

// Runs window and node to ready. The bytes on the wire come back for a test to
// replay or to compare.
async function runHandshake(window, node) {
  const first = await drive(window, null);
  const second = await drive(node, first.out[0]);
  const third = await drive(window, second.out[0]);
  const fourth = await drive(node, third.out[0]);
  return { helloW: first.out[0], helloN: second.out[0], authW: third.out[0], windowResult: third, nodeResult: fourth };
}

// A seal with a host that keeps what the seal writes in `seal.wire` and what it
// closes on in `seal.closes`, runs no handshake timer, and settles every write at
// once until `seal.redirect(fn)` hands writing to fn. `build` gets the host's options.
function sealed(build) {
  const wire = [];
  const closes = [];
  let writer = null;
  const seal = build({
    write: (bytes) => {
      if (writer) return writer(bytes);
      wire.push(bytes);
      return Promise.resolve();
    },
    onClose: (close) => closes.push(close),
    setTimer: () => 0,
    clearTimer: () => {}
  });
  seal.wire = wire;
  seal.closes = closes;
  seal.redirect = (fn) => { writer = fn; };
  return seal;
}

// One message in, and what the seal wrote for it.
async function drive(seal, bytes) {
  const result = await seal.next(bytes);
  return { ...result, out: seal.wire.splice(0) };
}
function sealFrame(seal, frame) {
  [...seal.records(frame)]; // eslint-disable-line no-unused-expressions
  return seal.wire.splice(0);
}
function pingRecord(seal) {
  seal.ping();
  return seal.wire.splice(0)[0];
}
function closeRecordOf(seal, code) {
  seal.closeRecord(code);
  return seal.wire.splice(0)[0];
}

// Two ends that keep message boundaries and order, as a binary WebSocket does:
// { send(bytes) -> Promise, close(code, reason), on('data' | 'close') }. The promise
// settles as ws's send callback would: when the socket has taken the bytes.
function createTransportPair() {
  const make = () => {
    const end = new EventEmitter();
    end.closed = false;
    end.sent = [];
    return end;
  };
  const a = make();
  const b = make();
  const wire = (from, to) => {
    from.send = (bytes) => new Promise((resolve, reject) => {
      if (from.closed) {
        reject(new Error('this end is closed'));
        return;
      }
      from.sent.push(bytes);
      setImmediate(() => {
        if (!to.closed) to.emit('data', bytes, true);
        resolve();
      });
    });
    from.close = (code, reason) => {
      if (from.closed) return;
      from.closed = true;
      from.emit('close', code, reason);
      setImmediate(() => {
        if (to.closed) return;
        to.closed = true;
        to.emit('close', code, reason);
      });
    };
  };
  wire(a, b);
  wire(b, a);
  return [a, b];
}

module.exports = { KEYS, sessionIdOf, ephemeralOf, windowKey, nodeKey, lookupOf, runHandshake, sealed, drive, sealFrame, pingRecord, closeRecordOf, createTransportPair };
