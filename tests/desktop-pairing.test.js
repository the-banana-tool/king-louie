// tests/desktop-pairing.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { base32Encode, NodeIdentity, deriveNodeId } = require('../src/mesh/node-identity');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pairing-')); dirs.push(d); return d; };
const newRawKey = () => keys.rawFromPublicKeyObject(crypto.generateKeyPairSync('ed25519').publicKey);

describe('device keys', () => {
  it('derives kld- ids as base32(sha256(raw))[0..16]', () => {
    const raw = Buffer.alloc(32, 7);
    const expected = `kld-${base32Encode(crypto.createHash('sha256').update(raw).digest()).slice(0, 16)}`;
    assert.strictEqual(keys.deriveDeviceId(raw, 'kld-'), expected);
    assert.match(expected, /^kld-[a-z2-7]{16}$/);
  });

  it("matches F3's device-id-ed25519 vector when it exists", (t) => {
    const file = path.join(__dirname, 'vectors', 'approval-v1', 'device-id-ed25519.json');
    if (!fs.existsSync(file)) { t.skip('fleet stage 3 vectors are not merged yet'); return; }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(doc) ? doc : (Array.isArray(doc.cases) ? doc.cases : [doc]);
    for (const e of entries) {
      assert.strictEqual(keys.deriveDeviceId(keys.fromB64url(e.input.raw), e.input.prefix), e.expect.device_id);
    }
  });

  it('converts a raw key to SPKI and verifies signatures', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = keys.rawFromPublicKeyObject(publicKey);
    assert.strictEqual(raw.length, 32);
    assert.deepStrictEqual(keys.ed25519RawToSpki(raw), publicKey.export({ type: 'spki', format: 'der' }));
    const sig = crypto.sign(null, Buffer.from('hello'), privateKey);
    assert.strictEqual(keys.verifyWithRawKey(raw, Buffer.from('hello'), sig), true);
    assert.strictEqual(keys.verifyWithRawKey(raw, Buffer.from('hellO'), sig), false);
    assert.strictEqual(keys.verifyWithSpkiHex(keys.ed25519RawToSpki(raw).toString('hex'), Buffer.from('hello'), sig), true);
    assert.throws(() => keys.ed25519RawToSpki(Buffer.alloc(31)));
  });

  it('decodes base64url strictly and groups fingerprints', () => {
    assert.deepStrictEqual(keys.fromB64url('AQID'), Buffer.from([1, 2, 3]));
    assert.throws(() => keys.fromB64url('AQ+D'));
    assert.throws(() => keys.fromB64url('AQID='));
    assert.strictEqual(keys.fingerprintGroups('kld-abcdefghijklmnop'), 'abcd efgh ijkl mnop');
    assert.strictEqual(keys.fingerprintGroups('kl-abcdefghijklmnop'), 'abcd efgh ijkl mnop');
  });

  it('rejects a non-canonical base64url string even when every character is in the alphabet', () => {
    // 'AR' decodes to the same single byte as the canonical 'AQ' (the last 4
    // bits of 'R' are non-zero padding bits), so it must be refused even
    // though both characters are individually valid base64url.
    assert.strictEqual(Buffer.from('AR', 'base64url').toString('base64url'), 'AQ');
    assert.throws(() => keys.fromB64url('AR'), (e) => e.message === 'not canonical base64url');
    assert.doesNotThrow(() => keys.fromB64url('AQ'));
  });

  it('verifyWithRawKey never throws and only accepts a 32-byte key with a 64-byte signature', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = keys.rawFromPublicKeyObject(publicKey);
    const sig = crypto.sign(null, Buffer.from('hello'), privateKey);
    assert.strictEqual(keys.verifyWithRawKey(Buffer.alloc(31), Buffer.from('hello'), sig), false);
    assert.strictEqual(keys.verifyWithRawKey(Buffer.alloc(33), Buffer.from('hello'), sig), false);
    assert.strictEqual(keys.verifyWithRawKey(raw, Buffer.from('hello'), Buffer.alloc(63)), false);
    assert.strictEqual(keys.verifyWithRawKey(raw, Buffer.from('hello'), Buffer.alloc(65)), false);
    assert.strictEqual(keys.verifyWithRawKey(raw, Buffer.from('hello'), Buffer.alloc(0)), false);
    assert.strictEqual(keys.verifyWithRawKey(null, Buffer.from('hello'), sig), false);
    assert.strictEqual(keys.verifyWithRawKey('not a buffer at all', Buffer.from('hello'), sig), false);
    assert.strictEqual(keys.verifyWithRawKey(raw, Buffer.from('hello'), 'not a buffer at all'), false);
  });

  it('verifyWithSpkiHex never throws and only accepts an Ed25519 SPKI key', () => {
    const { publicKey: ed, privateKey } = crypto.generateKeyPairSync('ed25519');
    const sig = crypto.sign(null, Buffer.from('hello'), privateKey);
    const edHex = ed.export({ type: 'spki', format: 'der' }).toString('hex');
    assert.strictEqual(keys.verifyWithSpkiHex(edHex, Buffer.from('hello'), sig), true);

    const { publicKey: rsa } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaHex = rsa.export({ type: 'spki', format: 'der' }).toString('hex');
    assert.strictEqual(keys.verifyWithSpkiHex(rsaHex, Buffer.from('hello'), sig), false);

    assert.strictEqual(keys.verifyWithSpkiHex('not hex at all', Buffer.from('hello'), sig), false);
    assert.strictEqual(keys.verifyWithSpkiHex(`${edHex}f`, Buffer.from('hello'), sig), false);
    assert.strictEqual(keys.verifyWithSpkiHex('', Buffer.from('hello'), sig), false);
    assert.strictEqual(keys.verifyWithSpkiHex(null, Buffer.from('hello'), sig), false);
    assert.strictEqual(keys.verifyWithSpkiHex(edHex, Buffer.from('hello'), Buffer.alloc(10)), false);
  });
});

describe('pairing request', () => {
  it('round-trips', () => {
    const raw = newRawKey();
    const text = pairing.encodePairRequest({ publicKeyRaw: raw, label: "owner's desktop" });
    assert.match(text, /^klpair1\.kld-[a-z2-7]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const req = pairing.decodePairRequest(text);
    assert.strictEqual(req.deviceId, keys.deriveDeviceId(raw, 'kld-'));
    assert.deepStrictEqual(req.publicKeyRaw, raw);
    assert.strictEqual(req.publicKey, keys.toB64url(raw));
    assert.strictEqual(req.label, "owner's desktop");
  });

  it('refuses a tampered id, a bad prefix, control characters and long labels', () => {
    const text = pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'desk' });
    const parts = text.split('.');
    const otherId = keys.deriveDeviceId(newRawKey(), 'kld-');
    assert.throws(() => pairing.decodePairRequest([parts[0], otherId, parts[2], parts[3]].join('.')), /does not match the public key/);
    assert.throws(() => pairing.decodePairRequest(['klpair2', ...parts.slice(1)].join('.')), (e) => e.code === 'MALFORMED_REQUEST');
    assert.throws(() => pairing.decodePairRequest(`${text}.extra`), (e) => e.code === 'MALFORMED_REQUEST');
    assert.throws(() => pairing.decodePairRequest([parts[0], parts[1], `${parts[2]}AA`, parts[3]].join('.')), (e) => e.code === 'MALFORMED_REQUEST');
    assert.throws(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'bad\u0007label' }), /control characters/);
    assert.throws(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'x'.repeat(65) }), /64 bytes/);
    const bell = [parts[0], parts[1], parts[2], keys.toB64url(Buffer.from('bad\u0007'))].join('.');
    assert.throws(() => pairing.decodePairRequest(bell), /control characters/);
  });

  it('builds a default label from the OS user', () => {
    assert.strictEqual(pairing.defaultDeviceLabel('alex'), "alex's desktop");
  });
});

describe('desktop-devices.json', () => {
  const device = () => {
    const raw = newRawKey();
    return { deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), label: 'web-01 desk', pairedAt: '2026-09-23T14:02:11Z' };
  };

  it('upserts, finds and removes devices', () => {
    const a = device();
    const b = device();
    let doc = pairing.upsertDevice(pairing.emptyDevices(), a);
    doc = pairing.upsertDevice(doc, b);
    doc = pairing.upsertDevice(doc, { ...a, label: 'renamed' });
    assert.strictEqual(doc.devices.length, 2);
    assert.strictEqual(pairing.findDevice(doc, a.deviceId).label, 'renamed');
    const out = pairing.removeDevice(doc, b.deviceId);
    assert.strictEqual(out.removed, true);
    assert.strictEqual(pairing.findDevice(out.doc, b.deviceId), null);
    assert.strictEqual(pairing.removeDevice(out.doc, b.deviceId).removed, false);
    assert.deepStrictEqual(pairing.parseDevices(JSON.stringify(out.doc)), out.doc);
  });

  it('refuses a wrong version, a mismatched key and duplicates', () => {
    const a = device();
    assert.throws(() => pairing.parseDevices(JSON.stringify({ v: 2, devices: [] })), (e) => e.code === 'DEVICES_FILE_INVALID');
    assert.throws(() => pairing.validateDevices({ v: 1, devices: [{ ...a, publicKey: device().publicKey }] }), /does not match/);
    assert.throws(() => pairing.validateDevices({ v: 1, devices: [a, a] }), /duplicate/);
    assert.throws(() => pairing.parseDevices('not json'), (e) => e.code === 'DEVICES_FILE_INVALID');
  });
});

describe('desktop-bridge.json', () => {
  it('records the node key as DER SPKI hex and checks nodeId', () => {
    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: 18795 });
    assert.deepStrictEqual(record, {
      v: 1, nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex'), host: '127.0.0.1', port: 18795, protocol: 1
    });
    assert.deepStrictEqual(pairing.parseBridgeFile(JSON.stringify(record)), {
      nodeId: identity.nodeId, publicKey: record.publicKey, host: '127.0.0.1', port: 18795, protocol: 1
    });
    assert.throws(() => pairing.parseBridgeFile(JSON.stringify({ ...record, nodeId: 'kl-aaaaaaaaaaaaaaaa' })), /nodeId does not match/);
    assert.throws(() => pairing.parseBridgeFile(JSON.stringify({ ...record, host: '0.0.0.0' })), /127\.0\.0\.1/);
    assert.throws(() => pairing.parseBridgeFile(JSON.stringify({ ...record, port: 0 })), (e) => e.code === 'BRIDGE_FILE_INVALID');
    assert.strictEqual(deriveNodeId(record.publicKey), record.nodeId);
  });

  it('finds the file beside the default service data dir unless KL_DESKTOP_BRIDGE_FILE says otherwise', () => {
    assert.strictEqual(pairing.bridgeFilePath({ env: {}, platform: 'linux' }), '/etc/king-louie/desktop-bridge.json');
    assert.strictEqual(pairing.bridgeFilePath({ env: {}, platform: 'darwin' }), '/Library/Application Support/KingLouie/config/desktop-bridge.json');
    assert.strictEqual(pairing.bridgeFilePath({ env: { ProgramData: 'C:\\ProgramData' }, platform: 'win32' }), 'C:\\ProgramData\\KingLouie\\config\\desktop-bridge.json');
    assert.strictEqual(pairing.bridgeFilePath({ env: { KL_DESKTOP_BRIDGE_FILE: '/srv/kl/config/desktop-bridge.json' }, platform: 'linux' }), '/srv/kl/config/desktop-bridge.json');
  });
});

describe('bridge-file trust (POSIX)', { skip: process.platform === 'win32' ? 'POSIX ownership' : false }, () => {
  const setup = (mode = 0o644) => {
    const dir = path.join(tmp(), 'config');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const file = path.join(dir, 'desktop-bridge.json');
    fs.writeFileSync(file, '{}', { mode });
    fs.chmodSync(file, mode);
    return file;
  };

  it('refuses a file owned by an ordinary user outside test mode', (t) => {
    if (process.getuid() === 0) { t.skip('running as root'); return; }
    const out = pairing.checkBridgeFileTrust(setup(), { env: {}, platform: 'linux' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'BRIDGE_FILE_UNTRUSTED');
    assert.match(out.error, /is not owned by an administrator; refusing to trust it\./);
  });

  it('accepts the current uid only with KL_TEST_MODE=1 and KL_DESKTOP_BRIDGE_FILE', () => {
    const file = setup();
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file }, platform: 'linux' }).ok, true);
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: { KL_TEST_MODE: '1' }, platform: 'linux' }).ok, process.getuid() === 0);
  });

  it('refuses a group-writable file and a symlink even in test mode', () => {
    const writable = setup(0o664);
    assert.strictEqual(pairing.checkBridgeFileTrust(writable, { env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: writable }, platform: 'linux' }).ok, false);
    const real = setup();
    const link = path.join(path.dirname(real), 'link.json');
    fs.symlinkSync(real, link);
    assert.strictEqual(pairing.checkBridgeFileTrust(link, { env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: link }, platform: 'linux' }).ok, false);
  });

  it('reads a trusted file and reports a missing one', () => {
    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    const file = setup();
    fs.writeFileSync(file, JSON.stringify(pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: 18795 })));
    const env = { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file };
    const out = pairing.readTrustedBridgeFile(file, { env, platform: 'linux' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.record.nodeId, identity.nodeId);
    const missing = pairing.readTrustedBridgeFile(path.join(path.dirname(file), 'nope.json'), { env, platform: 'linux' });
    assert.strictEqual(missing.code, 'BRIDGE_FILE_MISSING');
  });
});

describe('bridge-file trust (Windows rules, injected inspector)', () => {
  const file = 'C:\\ProgramData\\KingLouie\\config\\desktop-bridge.json';
  const inspector = (entries, me = 'S-1-5-21-1-2-3-1001') => () => ({ me, entries });

  it('accepts SYSTEM or Administrators as owner of the file and its directory', () => {
    const out = pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-32-544', link: false }, { owner: 'S-1-5-18', link: false }]) });
    assert.deepStrictEqual(out, { ok: true });
  });

  it('refuses a user-owned directory, a reparse point and (outside test mode) the current user', () => {
    const user = 'S-1-5-21-1-2-3-1001';
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: user, link: false }, { owner: 'S-1-5-18', link: false }]) }).code, 'BRIDGE_FILE_UNTRUSTED');
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-18', link: true }, { owner: 'S-1-5-18', link: false }]) }).code, 'BRIDGE_FILE_UNTRUSTED');
    const testEnv = { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file };
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: testEnv, platform: 'win32', inspectOwners: inspector([{ owner: user, link: false }, { owner: user, link: false }]) }).ok, true);
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-18', link: false }, null]) }).code, 'BRIDGE_FILE_MISSING');
  });

  it('exports the installers handle-based inspector', () => {
    assert.match(require('../src/service/installers').WINDOWS_INSPECT_CSHARP, /public static class KlFsInspect/);
  });

  // Injects execFile rather than shelling out to a real powershell.exe: this
  // exercises inspectWindowsOwners' own argv-building and output-parsing
  // (the part that is actually ours) without depending on the local machine's
  // real SIDs, on PowerShell being installed, or on running elevated/unelevated
  // — deterministic and safe to run from any agent shell, on any platform.
  it('drives PowerShell with the paths in an env var and parses "me"/owner/link lines', () => {
    const f = path.join(tmp(), 'probe.json');
    fs.writeFileSync(f, '{}');
    const dir = path.dirname(f);
    let capturedCmd;
    let capturedArgs;
    let capturedOptions;
    const execFile = (cmd, args, options) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedOptions = options;
      return 'me S-1-5-21-1-2-3-1001\nS-1-5-18 plain\nS-1-5-18 plain\n';
    };
    const out = pairing.inspectWindowsOwners([dir, f], { execFile, env: {} });
    assert.strictEqual(out.me, 'S-1-5-21-1-2-3-1001');
    assert.deepStrictEqual(out.entries, [{ owner: 'S-1-5-18', link: false }, { owner: 'S-1-5-18', link: false }]);
    assert.match(capturedCmd, /powershell\.exe$/i);
    assert.deepStrictEqual(capturedArgs.slice(0, 2), ['-NoProfile', '-NonInteractive']);
    assert.strictEqual(capturedOptions.env.KL_INSPECT_PATHS, [dir, f].join('\n'));
    assert.strictEqual(capturedOptions.encoding, 'utf8');
  });

  it('parses a missing path and a reparse point from the injected transcript', () => {
    const execFile = () => 'me S-1-5-21-1-2-3-1001\nmissing\nS-1-5-18 link\n';
    const out = pairing.inspectWindowsOwners(['C:\\gone', 'C:\\link'], { execFile, env: {} });
    assert.deepStrictEqual(out.entries, [null, { owner: 'S-1-5-18', link: true }]);
  });
});
