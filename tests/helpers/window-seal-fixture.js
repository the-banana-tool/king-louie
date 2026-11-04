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
  const first = await window.next(null);
  const second = await node.next(first.out[0]);
  const third = await window.next(second.out[0]);
  const fourth = await node.next(third.out[0]);
  return { helloW: first.out[0], helloN: second.out[0], authW: third.out[0], windowResult: third, nodeResult: fourth };
}

// Two ends that keep message boundaries and order, as a binary WebSocket does:
// { send(bytes), close(code, reason), on('data' | 'close') }.
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
    from.send = (bytes) => {
      if (from.closed) return;
      from.sent.push(bytes);
      setImmediate(() => { if (!to.closed) to.emit('data', bytes); });
    };
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

module.exports = { KEYS, sessionIdOf, ephemeralOf, windowKey, nodeKey, lookupOf, runHandshake, createTransportPair };
