// tests/desktop-state.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { openDesktopState } = require('../src/ipc/desktop-state');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-state-')); dirs.push(d); return d; };
const storeFactory = ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults });
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^sealed:/, '')
});

function openState(safeStorage = fakeSafeStorage()) {
  return openDesktopState(tmp(), safeStorage, { storeFactory });
}

const validPairing = () => ({
  deviceId: 'kld-abcdefghijklmnop',
  publicKey: 'x',
  privateKeySealed: 'y',
  label: 'desk',
  service: { nodeId: 'kl-abc', publicKey: 'ab', port: 18795, pairedAt: '2026-09-23T14:02:11Z' }
});

describe('desktop state: setPairing guards', () => {
  it('accepts a record with only privateKeySealed', () => {
    const state = openState();
    state.setPairing(validPairing());
    assert.strictEqual(state.pairing.privateKeySealed, 'y');
  });

  it('refuses a record carrying a raw privateKey field, and stores nothing', () => {
    const state = openState();
    const record = { ...validPairing(), privateKey: 'RAW PRIVATE KEY MATERIAL' };
    assert.throws(() => state.setPairing(record));
    assert.strictEqual(state.pairing, null);
  });

  it('refuses a record without privateKeySealed, and stores nothing', () => {
    const state = openState();
    const record = validPairing();
    delete record.privateKeySealed;
    assert.throws(() => state.setPairing(record));
    assert.strictEqual(state.pairing, null);
  });

  it('refuses a record whose privateKeySealed is not a non-empty string, and stores nothing', () => {
    const state = openState();
    assert.throws(() => state.setPairing({ ...validPairing(), privateKeySealed: '' }));
    assert.throws(() => state.setPairing({ ...validPairing(), privateKeySealed: 123 }));
    assert.strictEqual(state.pairing, null);
  });

  it('does not clobber a previously stored valid pairing when a later call is refused', () => {
    const state = openState();
    state.setPairing(validPairing());
    assert.throws(() => state.setPairing({ ...validPairing(), privateKey: 'leak' }));
    assert.strictEqual(state.pairing.privateKeySealed, 'y');
  });
});

describe('desktop state: seal() rejects non-strings', () => {
  it('seals a real string', () => {
    const state = openState();
    const sealed = state.seal('-----BEGIN PRIVATE KEY-----');
    assert.strictEqual(state.unseal(sealed), '-----BEGIN PRIVATE KEY-----');
  });

  it('throws on undefined instead of sealing the string "undefined"', () => {
    const state = openState();
    assert.throws(() => state.seal(undefined));
  });

  it('throws on non-string values (number, object, null)', () => {
    const state = openState();
    assert.throws(() => state.seal(123));
    assert.throws(() => state.seal({ pem: 'x' }));
    assert.throws(() => state.seal(null));
  });
});
