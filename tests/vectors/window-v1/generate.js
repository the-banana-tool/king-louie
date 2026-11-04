#!/usr/bin/env node
// tests/vectors/window-v1/generate.js
//
// Rebuilds every window-v1 vector from keys.json.
//   node tests/vectors/window-v1/generate.js          write the files
//   node tests/vectors/window-v1/generate.js --check  exit 1 if any differ
//
// Everything is deterministic: Ed25519 and X25519 from fixed keys, ephemerals from
// sha('window epk ' + label). The handshake bytes and the keys are built here from
// the document, separately from src/, and the seal has to produce the same ones.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WindowSeal, RECORD_WIRE_MAX } = require('../../../src/desktop-bridge/window-seal');
const { KEYS, sessionIdOf, ephemeralOf, windowKey, nodeKey, lookupOf, runHandshake } = require('../../helpers/window-seal-fixture');

const DIR = __dirname;
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest();
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const NODE_DOMAIN = Buffer.from('kl-window-v1\nnode\n');
const WINDOW_DOMAIN = Buffer.from('kl-window-v1\nwindow\n');

const SESSION = sessionIdOf('window-v1');
const OTHER_SESSION = sessionIdOf('window-v1 another');
const EPH_W = ephemeralOf('window');
const EPH_N = ephemeralOf('node');
const OTHER_EPH_W = ephemeralOf('window, another session');
const OTHER_EPH_N = ephemeralOf('node, another session');

function x25519Public(raw) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(X25519_SPKI.length);
}
function x25519(rawPrivate, rawPublic) {
  return crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, rawPrivate]), format: 'der', type: 'pkcs8' }),
    publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, rawPublic]), format: 'der', type: 'spki' })
  });
}

function buildHandshake(sessionId, ephW, ephN, device = windowKey('A'), node = nodeKey('web-01')) {
  const session = Buffer.from(sessionId, 'base64url');
  const helloW = Buffer.concat([Buffer.from([0x01, 0x01]), x25519Public(ephW), Buffer.from(device.deviceId, 'ascii'), device.publicKey]);
  const head = Buffer.concat([Buffer.from([0x02]), x25519Public(ephN), Buffer.from(node.nodeId, 'ascii'), node.publicKey]);
  const nodeSigned = Buffer.concat([NODE_DOMAIN, session, helloW, head]);
  const sigNode = node.sign(nodeSigned);
  const helloN = Buffer.concat([head, sigNode]);
  const windowSigned = Buffer.concat([WINDOW_DOMAIN, session, helloW, helloN]);
  const sigDev = device.sign(windowSigned);
  const authW = Buffer.concat([Buffer.from([0x03]), sigDev]);
  const secret = x25519(ephW, x25519Public(ephN));
  const salt = sha256(Buffer.concat([session, helloW, helloN]));
  const expand = (label) => Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from(`kl-window-v1 ${label}`), 32));
  return { helloW, helloN, authW, nodeSigned, windowSigned, sigNode, sigDev, secret, salt, kW2n: expand('w2n'), kN2w: expand('n2w') };
}

// A record of any plaintext, under any key, for what no honest sender makes.
function rawRecord(key, dir, counter, plaintext) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, Buffer.concat([Buffer.alloc(4), c]), { authTagLength: 16 });
  cipher.setAAD(Buffer.concat([Buffer.from([0x01, dir]), c]));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([0x10]), c, body, cipher.getAuthTag()]);
}
function plaintextOf(kind, bytes, multiple) {
  const p = Buffer.alloc(Math.ceil((5 + bytes.length) / multiple) * multiple);
  p[0] = kind;
  p.writeUInt32BE(bytes.length, 1);
  bytes.copy(p, 5);
  return p;
}

const windowSeal = ({ session = SESSION, eph = EPH_W, pin = nodeKey('web-01').publicKey } = {}) => WindowSeal.window({ sessionId: session, ...windowKey('A'), pin, ephemeral: eph });
const nodeSeal = ({ session = SESSION, eph = EPH_N, lookup = lookupOf('A') } = {}) => WindowSeal.node({ sessionId: session, identity: nodeKey('web-01'), lookupDevice: lookup, ephemeral: eph });
async function livePair() {
  const window = windowSeal();
  const node = nodeSeal();
  await runHandshake(window, node);
  return { window, node };
}

const GIVEN = {
  session_id: SESSION,
  window: { key: 'A', device_id: KEYS.windows.A.id, public_key: b64(windowKey('A').publicKey), ephemeral: b64(EPH_W) },
  node: { key: 'web-01', node_id: KEYS.nodes['web-01'].id, public_key: b64(nodeKey('web-01').publicKey), ephemeral: b64(EPH_N) },
  pin: b64(nodeKey('web-01').publicKey)
};
const REFUSED = { code: 4401, reason: 'handshake' };
const RECORD_REFUSED = { code: 4400, reason: 'record' };

async function buildVectors() {
  const vectors = [];
  const add = (name, given, input, expect) => vectors.push({ name, consumers: ['node'], given: { ...GIVEN, ...given }, input, expect });
  const hs = buildHandshake(SESSION, EPH_W, EPH_N);

  // The seal has to produce what the document says, byte for byte.
  const live = await runHandshake(windowSeal(), nodeSeal());
  if (!live.helloW.equals(hs.helloW) || !live.helloN.equals(hs.helloN) || !live.authW.equals(hs.authW)) {
    throw new Error('the seal differs from the document');
  }

  add('handshake-ok', {}, { hello_w: b64(hs.helloW), hello_n: b64(hs.helloN), auth_w: b64(hs.authW) }, {
    node_signed: b64(hs.nodeSigned),
    window_signed: b64(hs.windowSigned),
    sig_node: b64(hs.sigNode),
    sig_dev: b64(hs.sigDev),
    shared_secret: b64(hs.secret),
    salt: b64(hs.salt),
    k_w2n: b64(hs.kW2n),
    k_n2w: b64(hs.kN2w)
  });

  const other = buildHandshake(OTHER_SESSION, EPH_W, EPH_N);
  add('handshake-wrong-session', { other_session_id: OTHER_SESSION }, {
    hello_w: b64(hs.helloW),
    hello_n_other_session: b64(other.helloN),
    auth_w: b64(hs.authW)
  }, { window_on_other_hello_n: REFUSED, node_on_other_session: REFUSED });

  add('handshake-wrong-node-key', { pin: b64(nodeKey('gpu-box').publicKey) }, { hello_w: b64(hs.helloW), hello_n: b64(hs.helloN) }, {
    close: { code: 4401, reason: 'node_key_changed' }, out: []
  });

  add('handshake-unknown-device', { known_devices: [] }, { hello_w: b64(hs.helloW), hello_n: b64(hs.helloN), auth_w: b64(hs.authW) }, {
    hello_n_answered: true,
    close: REFUSED,
    stored_other_key: { key: b64(windowKey('B').publicKey), close: REFUSED }
  });

  const reflectedHead = Buffer.concat([Buffer.from([0x02]), hs.helloW.subarray(2, 34), Buffer.from(GIVEN.node.node_id, 'ascii'), nodeKey('web-01').publicKey]);
  const reflectedSig = nodeKey('web-01').sign(Buffer.concat([NODE_DOMAIN, Buffer.from(SESSION, 'base64url'), hs.helloW, reflectedHead]));
  add('handshake-reflected', {}, {
    cases: [
      { name: 'hello_w back to the window', to: 'window', stage: 'hello', bytes: b64(hs.helloW) },
      { name: 'hello_n back to the node', to: 'node', stage: 'hello', bytes: b64(hs.helloN) },
      { name: 'hello_w again at auth', to: 'node', stage: 'auth', bytes: b64(hs.helloW) },
      { name: 'the window\'s own ephemeral, under a real node signature', to: 'window', stage: 'hello', bytes: b64(Buffer.concat([reflectedHead, reflectedSig])) }
    ]
  }, { close: REFUSED, out: [] });

  add('handshake-truncated', {}, {
    cases: [
      { name: 'hello_w short', to: 'node', stage: 'hello', bytes: b64(hs.helloW.subarray(0, 85)) },
      { name: 'hello_w long', to: 'node', stage: 'hello', bytes: b64(Buffer.concat([hs.helloW, Buffer.alloc(1)])) },
      { name: 'hello_w empty', to: 'node', stage: 'hello', bytes: '' },
      { name: 'hello_n short', to: 'window', stage: 'hello', bytes: b64(hs.helloN.subarray(0, 147)) },
      { name: 'hello_n without its signature', to: 'window', stage: 'hello', bytes: b64(hs.helloN.subarray(0, 84)) },
      { name: 'auth_w short', to: 'node', stage: 'auth', bytes: b64(hs.authW.subarray(0, 64)) }
    ]
  }, { close: REFUSED, out: [] });

  const { window: sender, node: nodeSender } = await livePair();
  const roundtrip = [{ bytes: 100, fill: 0x61, multiple: 256 }, { bytes: 70000, fill: 0x62, multiple: 4096 }, { bytes: 1572864, fill: 0x63, multiple: 4096 }];
  const frames = roundtrip.map((frame) => {
    const records = sender.wrap(Buffer.alloc(frame.bytes, frame.fill));
    return { ...frame, from: 'window', records: records.map((r) => ({ length: r.length, sha256: b64(sha256(r)) })) };
  });
  const back = nodeSender.wrap(Buffer.alloc(100, 0x64));
  frames.push({ bytes: 100, fill: 0x64, multiple: 256, from: 'node', records: back.map((r) => ({ length: r.length, sha256: b64(sha256(r)) })) });
  add('record-roundtrip', {}, { frames: frames.map(({ bytes, fill, from }) => ({ bytes, fill, from })) }, { frames: frames.map(({ multiple, records }) => ({ multiple, records })) });

  const pair = await livePair();
  const r0 = pair.window.wrap(Buffer.from('first frame'))[0];
  const r1 = pair.window.wrap(Buffer.from('second frame'))[0];
  const tampered = Buffer.from(r0);
  tampered[20] ^= 0x01;
  add('record-tampered', {}, { tampered: b64(tampered), later: b64(r1) }, { close: RECORD_REFUSED, frames: [] });
  add('record-replayed', {}, { first: b64(r0), replay: b64(r0) }, { first_frame: b64(Buffer.from('first frame')), close: RECORD_REFUSED });
  add('record-reordered', {}, { first_on_the_wire: b64(r1), second_on_the_wire: b64(r0) }, { close: RECORD_REFUSED, frames: [] });

  const small = plaintextOf(0x00, Buffer.from('frame'), 256);
  const otherHs = buildHandshake(OTHER_SESSION, OTHER_EPH_W, OTHER_EPH_N);
  add('record-wrong-key', {}, {
    cases: [
      { name: 'the other direction\'s key', bytes: b64(rawRecord(hs.kN2w, 0x00, 0, small)) },
      { name: 'the other direction\'s aad', bytes: b64(rawRecord(hs.kW2n, 0x01, 0, small)) },
      { name: 'another session\'s key', bytes: b64(rawRecord(otherHs.kW2n, 0x00, 0, small)) }
    ],
    control: b64(rawRecord(hs.kW2n, 0x00, 0, small))
  }, { close: RECORD_REFUSED, control_frame: b64(Buffer.from('frame')) });

  add('record-unknown-kind', {}, { record: b64(rawRecord(hs.kW2n, 0x00, 0, plaintextOf(0x7f, Buffer.alloc(0), 256))) }, { close: RECORD_REFUSED });

  const hugeLen = Buffer.alloc(256);
  hugeLen.writeUInt32BE(0xffffffff, 1);
  add('record-oversized', {}, {
    claimed_length: b64(rawRecord(hs.kW2n, 0x00, 0, hugeLen)),
    // Only a size: the bytes are 0x10, a zero counter and zeros, and nothing opens them.
    wire_bytes: RECORD_WIRE_MAX + 256
  }, { close: RECORD_REFUSED });

  const closing = await livePair();
  const closeRecord = closing.window.closeRecord(1000);
  add('close-record', {}, { record: b64(closeRecord), later: b64(rawRecord(hs.kW2n, 0x00, 1, small)) }, {
    plaintext: b64(plaintextOf(0x30, Buffer.from([0, 0, 3, 0xe8]), 256)),
    close: { code: 1000, reason: 'peer' },
    frames: []
  });

  return vectors;
}

function serialize(v) {
  return `${JSON.stringify(v, null, 2)}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const vectors = await buildVectors();
  let differ = 0;
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (current !== text) {
        differ += 1;
        process.stderr.write(`differs: ${v.name}.json\n`);
      }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

if (require.main === module) main();

module.exports = { buildVectors, serialize };
