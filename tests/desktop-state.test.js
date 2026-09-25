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
  service: { nodeId: 'kl-abc', publicKey: 'ab', port: 18796, pairedAt: '2026-09-23T14:02:11Z' }
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

const validPendingPair = () => ({
  deviceId: 'kld-abcdefghijklmnop',
  publicKey: 'x',
  privateKeySealed: 'y',
  label: 'desk',
  request: 'klpair1.kld-abcdefghijklmnop.raw.label'
});

describe('desktop state: setPendingPair gets the same guard as setPairing (fix round 1)', () => {
  it('accepts a record with only privateKeySealed', () => {
    const state = openState();
    state.setPendingPair(validPendingPair());
    assert.strictEqual(state.pendingPair.privateKeySealed, 'y');
  });

  it('refuses a record carrying a raw privateKey field, and stores nothing', () => {
    const state = openState();
    const record = { ...validPendingPair(), privateKey: 'RAW PRIVATE KEY MATERIAL' };
    assert.throws(() => state.setPendingPair(record));
    assert.strictEqual(state.pendingPair, null);
  });

  it('refuses a record without privateKeySealed, and stores nothing', () => {
    const state = openState();
    const record = validPendingPair();
    delete record.privateKeySealed;
    assert.throws(() => state.setPendingPair(record));
    assert.strictEqual(state.pendingPair, null);
  });

  it('still accepts null, the way pairCancel/pairConfirm/unpair clear it', () => {
    const state = openState();
    state.setPendingPair(validPendingPair());
    assert.ok(state.pendingPair);
    state.setPendingPair(null);
    assert.strictEqual(state.pendingPair, null);
  });

  it('does not clobber a previously stored valid pending pair when a later call is refused', () => {
    const state = openState();
    state.setPendingPair(validPendingPair());
    assert.throws(() => state.setPendingPair({ ...validPendingPair(), privateKey: 'leak' }));
    assert.strictEqual(state.pendingPair.privateKeySealed, 'y');
  });
});

describe('desktop state: pendingServiceCommand (fix round 2, Task 16 review)', () => {
  it('is null by default, and clears back to null', () => {
    const state = openState();
    assert.strictEqual(state.pendingServiceCommand, null);
    state.setPendingServiceCommand({ command: 'king-louie-service desktop unpair kld-abc' });
    assert.ok(state.pendingServiceCommand);
    state.setPendingServiceCommand(null);
    assert.strictEqual(state.pendingServiceCommand, null);
  });

  it('stamps an `at` timestamp when none is given', () => {
    const state = openState();
    state.setPendingServiceCommand({ command: 'x' });
    assert.strictEqual(state.pendingServiceCommand.command, 'x');
    assert.ok(Date.parse(state.pendingServiceCommand.at));
  });

  it('refuses a missing or empty command', () => {
    const state = openState();
    assert.throws(() => state.setPendingServiceCommand({}));
    assert.throws(() => state.setPendingServiceCommand({ command: '' }));
  });

  // The bug this closes: `notify()` (and, in attached mode, a relaunch)
  // can happen before the renderer ever paints the reply that carried the
  // command, so the command must survive in the state a fresh controller
  // reads, not just in that one reply.
  it('survives a repaint (a fresh read of the same state) and a new controller built over the same state', () => {
    const dir = tmp();
    const first = openDesktopState(dir, fakeSafeStorage(), { storeFactory });
    first.setPendingServiceCommand({ command: 'king-louie-service desktop unpair kld-abc' });

    const rebuilt = openDesktopState(dir, fakeSafeStorage(), { storeFactory });
    assert.strictEqual(rebuilt.pendingServiceCommand.command, 'king-louie-service desktop unpair kld-abc');
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
