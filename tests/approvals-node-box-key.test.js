// The node's box key (sealed phones, R-SP-3): generated once, its private half
// under the host cipher beside the Ed25519 key, and nothing else in the
// identity record moved by adding it.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { MeshIdentity, saveIdentity, loadIdentity, IDENTITY_STORE_KEY } = require('../src/mesh/mesh-identity');
const { NodeIdentity, getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
const { generateBoxKey, createBox } = require('../src/approvals/node-box-key');
const { readNodeIdentity } = require('../src/service/commands/session');
const { isDeviceJwk, open, seal } = require('../src/approvals/envelope');
const { sealContent, openSealed } = require('../src/approvals/seal');
const { createFakePhone, testNodeIdentity, KEYS } = require('./helpers/fake-phone');

const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-box-key-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JsonFileStore({ dir, name: 'chat-data' });
  return { dir, store, cipher: createAesGcmCipher(crypto.randomBytes(32)) };
}

// A record as a build from before this change wrote it.
function recordWithoutBox({ store, cipher }) {
  saveIdentity(store, new NodeIdentity({ nodeName: 'web-01', displayName: 'web-01', capabilities: ['gui'] }), cipher);
  return store.get(IDENTITY_STORE_KEY);
}

// What the service's start does; every other path loads without filling.
const fill = (store, cipher) => getOrGenerateNodeIdentity(store, cipher, 'web-01', { fillBox: true });

const hasKey = (value, key) => {
  if (!value || typeof value !== 'object') return false;
  return Object.hasOwn(value, key) || Object.values(value).some((v) => hasKey(v, key));
};

const ephemeralFor = (jwk) => {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    epk: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') },
    secret: ecdh.computeSecret(point)
  };
};

describe('a box', () => {
  it('generateBoxKey gives a P-256 JWK of exactly the public fields, and a private half that agrees', () => {
    const { jwk, d } = generateBoxKey();
    assert.equal(isDeviceJwk(jwk), true);
    const box = createBox(jwk, d);
    assert.deepEqual(box.jwk, jwk);
    const { epk, secret } = ephemeralFor(jwk);
    const agreed = box.agree(epk);
    assert.equal(Buffer.isBuffer(agreed), true);
    assert.equal(agreed.length, 32);
    assert.deepEqual(agreed, secret);
    assert.equal(hasKey(box, 'd'), false);
    assert.equal(JSON.stringify(box).includes(d), false);
  });

  it('createBox refuses a private half that is not this public key\'s, and does not quote it', () => {
    const a = generateBoxKey();
    const b = generateBoxKey();
    assert.throws(() => createBox(a.jwk, b.d), (err) => /box key/.test(err.message) && !err.message.includes(b.d));
    assert.throws(() => createBox(a.jwk, 'not-a-scalar'), /box key/);
    assert.throws(() => createBox(null, a.d), /box key/);
  });
});

describe('getOrGenerateNodeIdentity and the box key', () => {
  it('a fresh identity has a box key, and a second load returns the same one', () => {
    const f = fresh();
    const first = fill(f.store, f.cipher);
    assert.equal(isDeviceJwk(first.box.jwk), true);
    const second = fill(new JsonFileStore({ dir: f.dir, name: 'chat-data' }), f.cipher);
    assert.deepEqual(second.box.jwk, first.box.jwk);
    const { epk } = ephemeralFor(first.box.jwk);
    assert.deepEqual(second.box.agree(epk), first.box.agree(epk));
  });

  it('holds the private half under the cipher: the stored record has no d, in clear or as a key', () => {
    const f = fresh();
    const identity = fill(f.store, f.cipher);
    const onDisk = fs.readFileSync(path.join(f.dir, 'chat-data.json'), 'utf8');
    const record = JSON.parse(onDisk).mesh.identity;
    assert.deepEqual(record.boxKeyJwk, identity.box.jwk);
    assert.equal(typeof record.encryptedBoxKey, 'string');
    assert.equal(hasKey(record, 'd'), false);
    assert.equal(hasKey(record, 'boxKeyD'), false);
    assert.equal(onDisk.includes(identity.boxKeyD), false);
    assert.equal(f.cipher.decryptString(record.encryptedBoxKey), identity.boxKeyD);
  });

  it('an identity with no box key gets one and nothing else in the record moves', () => {
    const f = fresh();
    const before = recordWithoutBox(f);
    const identity = fill(f.store, f.cipher);
    const afterRecord = f.store.get(IDENTITY_STORE_KEY);
    const { boxKeyJwk, encryptedBoxKey, ...rest } = afterRecord;
    assert.deepEqual(rest, before, 'the Ed25519 and TLS fields, ciphertext included, are as they were');
    assert.deepEqual(boxKeyJwk, identity.box.jwk);
    assert.equal(typeof encryptedBoxKey, 'string');
    assert.equal(identity.publicKey.toString('hex'), before.publicKey);
    assert.equal(identity.peerId, before.peerId);
    const signature = identity.sign('data');
    assert.equal(MeshIdentity.verify('data', signature, before.publicKey), true);
    // And it stays that key.
    assert.deepEqual(fill(f.store, f.cipher).box.jwk, identity.box.jwk);
    assert.deepEqual(f.store.get(IDENTITY_STORE_KEY), afterRecord);
  });

  it('does not write when the record already holds a box key', () => {
    const f = fresh();
    fill(f.store, f.cipher);
    const file = path.join(f.dir, 'chat-data.json');
    const before = fs.readFileSync(file);
    const writes = [];
    const store = new JsonFileStore({ dir: f.dir, name: 'chat-data', onWrite: (p) => writes.push(p) });
    fill(store, f.cipher);
    assert.deepEqual(writes, []);
    assert.deepEqual(fs.readFileSync(file), before);
  });

  it('with no cipher a plaintext identity still loads, with no box and the record untouched', () => {
    const f = fresh();
    const plain = new MeshIdentity({ displayName: 'web-01' }).serialize();
    f.store.set(IDENTITY_STORE_KEY, plain);
    const unavailable = { isEncryptionAvailable: () => false, encryptString() { throw new Error('no'); }, decryptString() { throw new Error('no'); } };
    const identity = fill(f.store, unavailable);
    assert.equal(identity.box, null);
    assert.equal(identity.peerId, plain.peerId);
    assert.deepEqual(f.store.get(IDENTITY_STORE_KEY), plain);
  });

  it('a store that cannot be written leaves the identity whole, with no box, and a later load makes one', () => {
    const f = fresh();
    recordWithoutBox(f);
    const reader = new JsonFileStore({ dir: f.dir, name: 'chat-data' });
    const before = reader.get(IDENTITY_STORE_KEY);
    const readOnly = { get: (...a) => reader.get(...a), set() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    const identity = fill(readOnly, f.cipher);
    assert.equal(identity.box, null, 'never a key that the next start would not have');
    assert.equal(identity.boxKeyD, undefined);
    assert.equal(identity.publicKey.toString('hex'), before.publicKey);
    assert.equal(isDeviceJwk(fill(reader, f.cipher).box.jwk), true);
  });

  it('a box key that will not decrypt, or is not its public key\'s, refuses and leaves the record alone', () => {
    const f = fresh();
    fill(f.store, f.cipher);
    const good = f.store.get(IDENTITY_STORE_KEY);
    f.store.set(IDENTITY_STORE_KEY, { ...good, encryptedBoxKey: createAesGcmCipher(crypto.randomBytes(32)).encryptString('x') });
    const bad = f.store.get(IDENTITY_STORE_KEY);
    assert.throws(() => fill(f.store, f.cipher), /mesh private key/);
    assert.deepEqual(f.store.get(IDENTITY_STORE_KEY), bad);
    const other = generateBoxKey();
    f.store.set(IDENTITY_STORE_KEY, { ...good, encryptedBoxKey: f.cipher.encryptString(other.d) });
    const mismatched = f.store.get(IDENTITY_STORE_KEY);
    assert.throws(() => fill(f.store, f.cipher), /box key/);
    assert.deepEqual(f.store.get(IDENTITY_STORE_KEY), mismatched);
  });
});

describe('only the service start fills', () => {
  it('any other load of a record with no box key gets box null and writes nothing', () => {
    const f = fresh();
    recordWithoutBox(f);
    const file = path.join(f.dir, 'chat-data.json');
    const bytes = fs.readFileSync(file);
    const writes = [];
    const store = new JsonFileStore({ dir: f.dir, name: 'chat-data', onWrite: (p) => writes.push(p) });
    const identity = getOrGenerateNodeIdentity(store, f.cipher, 'web-01');
    assert.equal(identity.box, null);
    assert.deepEqual(writes, []);
    assert.deepEqual(fs.readFileSync(file), bytes);
  });

  it('a first identity made by any other path has no box key either, and the start fills it', () => {
    const f = fresh();
    const cli = getOrGenerateNodeIdentity(f.store, f.cipher, 'web-01');
    assert.equal(cli.box, null);
    assert.equal(Object.hasOwn(f.store.get(IDENTITY_STORE_KEY), 'encryptedBoxKey'), false);
    const started = fill(f.store, f.cipher);
    assert.equal(started.nodeId, cli.nodeId);
    assert.equal(isDeviceJwk(started.box.jwk), true);
  });

  it('any other load of a record with a box key has it', () => {
    const f = fresh();
    const started = fill(f.store, f.cipher);
    assert.deepEqual(getOrGenerateNodeIdentity(new JsonFileStore({ dir: f.dir, name: 'chat-data' }), f.cipher, 'web-01').box.jwk, started.box.jwk);
  });

  it('the fill re-reads the record and adopts a key already there, with no write', () => {
    const f = fresh();
    recordWithoutBox(f);
    const stale = new JsonFileStore({ dir: f.dir, name: 'chat-data' });
    assert.equal(Object.hasOwn(stale.get(IDENTITY_STORE_KEY), 'boxKeyJwk'), false, 'this instance has read the record');
    const first = fill(f.store, f.cipher);
    const file = path.join(f.dir, 'chat-data.json');
    const bytes = fs.readFileSync(file);
    const second = fill(stale, f.cipher);
    assert.deepEqual(second.box.jwk, first.box.jwk);
    assert.deepEqual(fs.readFileSync(file), bytes);
  });

  it('a stale instance\'s later ordinary set neither loses nor replaces the key', () => {
    const f = fresh();
    recordWithoutBox(f);
    const stale = new JsonFileStore({ dir: f.dir, name: 'chat-data' });
    assert.equal(Object.hasOwn(stale.get(IDENTITY_STORE_KEY), 'boxKeyJwk'), false);
    const first = fill(f.store, f.cipher);
    const stored = f.store.get(IDENTITY_STORE_KEY);
    stale.set('settings.anything', 1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(f.dir, 'chat-data.json'), 'utf8'));
    assert.equal(onDisk.settings.anything, 1);
    assert.deepEqual(onDisk.mesh.identity, stored);
    assert.deepEqual(fill(new JsonFileStore({ dir: f.dir, name: 'chat-data' }), f.cipher).box.jwk, first.box.jwk);
  });

  it('a stale instance does not bring in the box key of another identity', () => {
    const f = fresh();
    recordWithoutBox(f);
    const stale = new JsonFileStore({ dir: f.dir, name: 'chat-data' });
    const held = stale.get(IDENTITY_STORE_KEY);
    saveIdentity(f.store, new NodeIdentity({ nodeName: 'other' }), f.cipher);
    fill(f.store, f.cipher);
    stale.set('settings.anything', 1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(f.dir, 'chat-data.json'), 'utf8'));
    assert.equal(onDisk.mesh.identity.publicKey, held.publicKey);
    assert.equal(Object.hasOwn(onDisk.mesh.identity, 'encryptedBoxKey'), false);
  });

  it('only the service\'s start paths ask for a fill', () => {
    const root = path.join(__dirname, '..', 'src');
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(root);
    const asking = files.filter((f) => /fillBox: true/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
    assert.deepEqual(asking, ['approvals/service-wiring.js', 'frontdoor/profile.js', 'service/run.js']);
    const wiring = fs.readFileSync(path.join(root, 'approvals', 'service-wiring.js'), 'utf8');
    assert.equal(wiring.match(/fillBox: true/g).length, 1);
    const mcp = wiring.slice(wiring.indexOf('async function startMcpApprovals'));
    assert.equal(mcp.includes('fillBox'), false);
  });
});

describe('what else reads or writes the record', () => {
  it('the mesh keeps the box key through a load and a save', () => {
    const f = fresh();
    const node = fill(f.store, f.cipher);
    const mesh = loadIdentity(f.store, f.cipher);
    mesh.displayName = 'renamed';
    saveIdentity(f.store, mesh, f.cipher);
    const record = f.store.get(IDENTITY_STORE_KEY);
    assert.equal(record.displayName, 'renamed');
    assert.equal(hasKey(record, 'boxKeyD'), false);
    assert.deepEqual(fill(f.store, f.cipher).box.jwk, node.box.jwk);
  });

  it('a mesh identity loaded before the box key existed does not wipe it when it saves', () => {
    // Mesh start and the service's identity load share one store, in either order.
    const f = fresh();
    recordWithoutBox(f);
    const stale = loadIdentity(f.store, f.cipher);
    const node = fill(f.store, f.cipher);
    stale.displayName = 'renamed';
    saveIdentity(f.store, stale, f.cipher);
    const record = f.store.get(IDENTITY_STORE_KEY);
    assert.equal(record.displayName, 'renamed');
    assert.deepEqual(record.boxKeyJwk, node.box.jwk);
    assert.deepEqual(fill(f.store, f.cipher).box.jwk, node.box.jwk);
  });

  it('saving another identity does not take over the box key stored for this one', () => {
    const f = fresh();
    fill(f.store, f.cipher);
    saveIdentity(f.store, new MeshIdentity({ displayName: 'other' }), f.cipher);
    const record = f.store.get(IDENTITY_STORE_KEY);
    assert.equal(Object.hasOwn(record, 'boxKeyJwk'), false);
    assert.equal(Object.hasOwn(record, 'encryptedBoxKey'), false);
  });

  it('a record with no box key serializes as it did', () => {
    const f = fresh();
    const record = recordWithoutBox(f);
    assert.equal(Object.hasOwn(record, 'boxKeyJwk'), false);
    assert.equal(Object.hasOwn(record, 'encryptedBoxKey'), false);
    assert.equal(Object.hasOwn(new MeshIdentity({ displayName: 'x' }).serialize(), 'boxKeyD'), false);
    assert.equal(new NodeIdentity({ nodeName: 'web-01' }).box, null);
  });

  it('readNodeIdentity reads the same id and key with or without a box key, and writes nothing', () => {
    const f = fresh();
    const before = recordWithoutBox(f);
    const file = path.join(f.dir, 'chat-data.json');
    const without = readNodeIdentity(f.dir, f.cipher);
    assert.equal(without.publicKey, before.publicKey);
    assert.equal(Object.hasOwn(f.store.get(IDENTITY_STORE_KEY), 'boxKeyJwk'), false, 'a read-only caller fills nothing');
    const identity = fill(f.store, f.cipher);
    const bytes = fs.readFileSync(file);
    assert.deepEqual(readNodeIdentity(f.dir, f.cipher), without);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(identity.nodeId, without.nodeId);
  });
});

describe('the fake phone and node', () => {
  it('testNodeIdentity({ box: true }) has a box, keys.json\'s for web-01; without it, none', () => {
    assert.equal(testNodeIdentity({ key: 'web-01' }).box, undefined);
    const fixed = testNodeIdentity({ key: 'web-01', box: true });
    assert.deepEqual(fixed.box.jwk, KEYS.nodes['web-01'].box.jwk);
    assert.equal(isDeviceJwk(testNodeIdentity({ box: true }).box.jwk), true);
  });

  it('createFakePhone({ boxKey: true }) opens what is sealed to it, and states and records its key', () => {
    const none = createFakePhone();
    assert.equal(none.boxJwk, undefined);
    assert.equal(createFakePhone({ seed: 'A', boxKey: true }).boxJwk.x, KEYS.devices.A_box.jwk.x);
    assert.equal(isDeviceJwk(createFakePhone({ seed: 'C', boxKey: true }).boxJwk), true);

    const phone = createFakePhone({ boxKey: true });
    const node = testNodeIdentity({ box: true });
    assert.deepEqual(phone.approverRecord({ boxKey: true }).box_key, phone.boxJwk);
    assert.deepEqual(phone.device({ boxKey: true }).box_key, phone.boxJwk);
    assert.equal(Object.hasOwn(phone.approverRecord(), 'box_key'), false);
    const statement = open(phone.boxStatement()).message;
    assert.equal(statement.type, 'kl.device.box_key');
    assert.deepEqual(statement.box_key, phone.boxJwk);

    const clear = {
      v: 1, type: 'kl.question.ask', node_id: node.nodeId, token: 'tok', kind: 'free', urgency: 'normal',
      expires_at: '2026-11-04T12:00:00.000Z', node_box: node.box.jwk
    };
    const content = { case_id: 'c-1', question_id: 'q-1', case_title: 'Lakeside lot', text: 'Which day?', options: null };
    const message = sealContent({ type: 'kl.question.ask', senderId: node.nodeId, clear, content, recipients: { [phone.deviceId]: phone.boxJwk, [node.nodeId]: node.box.jwk } });
    const envelope = seal(message, node.signer);
    assert.equal(phone.open(envelope, 'kl.question.ask').content.text, 'Which day?');
    assert.equal(phone.open(envelope, 'kl.question.ask').message.token, 'tok');
    assert.equal(openSealed({ type: 'kl.question.ask', message, recipientId: node.nodeId, agree: node.box.agree }).content.case_title, 'Lakeside lot');
    assert.throws(() => createFakePhone({ boxKey: true }).open(envelope, 'kl.question.ask'), (err) => err.reason === 'not_recipient');
    assert.throws(() => none.open(envelope, 'kl.question.ask'), /box key/);
  });
});
