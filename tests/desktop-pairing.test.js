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
const protocol = require('../src/desktop-bridge/protocol');

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

describe('wire protocol frame parsing', () => {
  it('parseFrame accepts only a string or a Buffer, and only an integer maxBytes', () => {
    assert.deepStrictEqual(protocol.parseFrame('{"t":"ping"}', 4096), { frame: { t: 'ping' } });
    assert.deepStrictEqual(protocol.parseFrame(Buffer.from('{"t":"ping"}'), 4096), { frame: { t: 'ping' } });
    // Not a string or a Buffer: fails closed rather than risking a wrong
    // size or throwing out of Buffer.from on something it can't coerce.
    assert.deepStrictEqual(protocol.parseFrame(new ArrayBuffer(10), 4096), { error: 'malformed' });
    assert.deepStrictEqual(protocol.parseFrame(new Uint8Array([1, 2, 3]), 4096), { error: 'malformed' });
    assert.deepStrictEqual(protocol.parseFrame({ t: 'ping' }, 4096), { error: 'malformed' });
    assert.deepStrictEqual(protocol.parseFrame(null, 4096), { error: 'malformed' });
    // A missing/non-integer maxBytes fails closed instead of comparing
    // against undefined/NaN, which would let anything through.
    assert.deepStrictEqual(protocol.parseFrame('{"t":"ping"}'), { error: 'malformed' });
    assert.deepStrictEqual(protocol.parseFrame('{"t":"ping"}', NaN), { error: 'malformed' });
    assert.deepStrictEqual(protocol.parseFrame('{"t":"ping"}', '4096'), { error: 'malformed' });
    assert.deepStrictEqual(protocol.parseFrame('{"t":"ping"}', Infinity), { error: 'malformed' });
  });

  it('peekFrameId slices a Buffer to 256 bytes before decoding it, not after', () => {
    // A multi-megabyte tail that, if fully decoded first, would still
    // exercise the regex correctly but at the cost of decoding all of it —
    // this is a correctness check that slicing-then-decoding still finds
    // the id, sized like the 64 MiB frameBytes limit to make the point.
    const huge = Buffer.concat([Buffer.from('{"t":"invoke","id":42,"rest":"'), Buffer.alloc(2 * 1024 * 1024, 0x41)]);
    assert.strictEqual(protocol.peekFrameId(huge), 42);
    assert.strictEqual(protocol.peekFrameId(Buffer.from('{"t":"call","id":7}')), 7);
    assert.strictEqual(protocol.peekFrameId(Buffer.from('{"t":"result","id":1}')), null);
    assert.strictEqual(protocol.peekFrameId('{"t":"invoke","id":9}'), 9);
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

  it('rejects C1 controls and bidi override/isolate characters, not just C0/DEL', () => {
    assert.throws(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'bad\u0085label' }), /control characters/);
    assert.throws(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'bad\u009flabel' }), /control characters/);
    assert.throws(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'bad\u202elabel' }), /control characters/);
    assert.throws(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'bad\u2066label' }), /control characters/);
    assert.doesNotThrow(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'ordinary label' }));
  });

  it('rejects zero-width/formatting characters and line/paragraph separators (fix round 1)', () => {
    for (const ch of ['\u061c', '\u200b', '\u200f', '\u2028', '\u2029', '\ufeff']) {
      assert.throws(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: `bad${ch}label` }), /control characters/);
    }
  });

  it('builds a default label that always fits 64 bytes for a non-ASCII username, on a code-point boundary', () => {
    const label = pairing.defaultDeviceLabel('日本語ユーザー名'.repeat(5));
    assert.ok(Buffer.byteLength(label, 'utf8') <= 64);
    // Round-trips cleanly: a split multi-byte sequence would decode as U+FFFD
    // and no longer match the original string.
    assert.strictEqual(Buffer.from(label, 'utf8').toString('utf8'), label);
    assert.match(label, /'s desktop$/);
  });

  it('builds a default label that never splits a surrogate pair', () => {
    const label = pairing.defaultDeviceLabel('😀'.repeat(30));
    assert.ok(Buffer.byteLength(label, 'utf8') <= 64);
    assert.strictEqual(Buffer.from(label, 'utf8').toString('utf8'), label);
  });

  it('caps the total pairing request length before splitting it', () => {
    const huge = `klpair1.${'x'.repeat(10000)}`;
    assert.throws(() => pairing.decodePairRequest(huge), (e) => e.code === 'MALFORMED_REQUEST' && /longer than/.test(e.message));
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
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: 18796 });
    assert.deepStrictEqual(record, {
      v: 1, nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex'), host: '127.0.0.1', port: 18796, protocol: 1
    });
    assert.deepStrictEqual(pairing.parseBridgeFile(JSON.stringify(record)), {
      nodeId: identity.nodeId, publicKey: record.publicKey, host: '127.0.0.1', port: 18796, protocol: 1
    });
    assert.throws(() => pairing.parseBridgeFile(JSON.stringify({ ...record, nodeId: 'kl-aaaaaaaaaaaaaaaa' })), /nodeId does not match/);
    assert.throws(() => pairing.parseBridgeFile(JSON.stringify({ ...record, host: '0.0.0.0' })), /127\.0\.0\.1/);
    assert.throws(() => pairing.parseBridgeFile(JSON.stringify({ ...record, port: 0 })), (e) => e.code === 'BRIDGE_FILE_INVALID');
    assert.strictEqual(deriveNodeId(record.publicKey), record.nodeId);
  });

  it('requires publicKey to be exactly 88 lowercase hex characters', () => {
    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: 18796 });
    assert.strictEqual(record.publicKey.length, 88);
    assert.throws(
      () => pairing.parseBridgeFile(JSON.stringify({ ...record, publicKey: record.publicKey.toUpperCase() })),
      (e) => e.code === 'BRIDGE_FILE_INVALID' && /88 lowercase hex/.test(e.message)
    );
    assert.throws(
      () => pairing.parseBridgeFile(JSON.stringify({ ...record, publicKey: record.publicKey.slice(0, -2) })),
      (e) => e.code === 'BRIDGE_FILE_INVALID' && /88 lowercase hex/.test(e.message)
    );
    assert.throws(
      () => pairing.parseBridgeFile(JSON.stringify({ ...record, publicKey: `${record.publicKey.slice(0, -2)}zz` })),
      (e) => e.code === 'BRIDGE_FILE_INVALID' && /88 lowercase hex/.test(e.message)
    );
    assert.throws(
      () => pairing.parseBridgeFile(JSON.stringify({ ...record, publicKey: 123 })),
      (e) => e.code === 'BRIDGE_FILE_INVALID' && /88 lowercase hex/.test(e.message)
    );
  });

  it('finds the file beside the default service data dir unless KL_DESKTOP_BRIDGE_FILE says otherwise', () => {
    assert.strictEqual(pairing.bridgeFilePath({ env: {}, platform: 'linux' }), '/etc/king-louie/desktop-bridge.json');
    assert.strictEqual(pairing.bridgeFilePath({ env: {}, platform: 'darwin' }), '/Library/Application Support/KingLouie/config/desktop-bridge.json');
    assert.strictEqual(pairing.bridgeFilePath({ env: { ProgramData: 'C:\\ProgramData' }, platform: 'win32' }), 'C:\\ProgramData\\KingLouie\\config\\desktop-bridge.json');
    assert.strictEqual(pairing.bridgeFilePath({ env: { KL_DESKTOP_BRIDGE_FILE: '/srv/kl/config/desktop-bridge.json' }, platform: 'linux' }), '/srv/kl/config/desktop-bridge.json');
  });
});

describe('writeFileAtomic', () => {
  it('writes the file with the requested content and mode, atomically', () => {
    const file = path.join(tmp(), 'out.json');
    pairing.writeFileAtomic(file, '{"a":1}', 0o600);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1}');
    // No leftover temp file: the rename either succeeded and left only the
    // final name, or writeFileAtomic cleaned up after itself on failure.
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['out.json']);
  });

  it('overwrites an existing file at the same path', () => {
    const file = path.join(tmp(), 'out.json');
    pairing.writeFileAtomic(file, 'first');
    pairing.writeFileAtomic(file, 'second');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'second');
  });

  it('opens the temp file exclusively (wx) and fsyncs it before renaming', () => {
    const file = path.join(tmp(), 'out.json');
    const calls = [];
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    fs.openSync = (target, flags, mode) => {
      calls.push({ fn: 'open', target, flags, mode });
      return originalOpen(target, flags, mode);
    };
    fs.fsyncSync = (fd) => {
      calls.push({ fn: 'fsync', fd });
      return originalFsync(fd);
    };
    try {
      pairing.writeFileAtomic(file, 'content', 0o600);
    } finally {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalFsync;
    }
    const open = calls.find((c) => c.fn === 'open');
    assert.ok(open, 'fs.openSync was not called');
    assert.strictEqual(open.flags, 'wx');
    assert.strictEqual(open.mode, 0o600);
    const fsyncIndex = calls.findIndex((c) => c.fn === 'fsync');
    assert.ok(fsyncIndex > -1, 'fs.fsyncSync was not called');
    assert.strictEqual(fsyncIndex, calls.indexOf(open) + 1, 'fsync must happen right after the write, before rename');
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

  it('refuses a file owned by an ordinary user outside test mode', async (t) => {
    if (process.getuid() === 0) { t.skip('running as root'); return; }
    const out = await pairing.checkBridgeFileTrust(setup(), { env: {}, platform: 'linux' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'BRIDGE_FILE_UNTRUSTED');
    assert.match(out.error, /is not owned by an administrator; refusing to trust it\./);
  });

  it('accepts the current uid only with KL_TEST_MODE=1 and KL_DESKTOP_BRIDGE_FILE', async () => {
    const file = setup();
    assert.strictEqual((await pairing.checkBridgeFileTrust(file, { env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file }, platform: 'linux' })).ok, true);
    assert.strictEqual((await pairing.checkBridgeFileTrust(file, { env: { KL_TEST_MODE: '1' }, platform: 'linux' })).ok, process.getuid() === 0);
  });

  it('refuses a group-writable file and a symlink even in test mode', async () => {
    const writable = setup(0o664);
    assert.strictEqual((await pairing.checkBridgeFileTrust(writable, { env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: writable }, platform: 'linux' })).ok, false);
    const real = setup();
    const link = path.join(path.dirname(real), 'link.json');
    fs.symlinkSync(real, link);
    assert.strictEqual((await pairing.checkBridgeFileTrust(link, { env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: link }, platform: 'linux' })).ok, false);
  });

  it('reads a trusted file and reports a missing one', async () => {
    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    const file = setup();
    fs.writeFileSync(file, JSON.stringify(pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: 18796 })));
    const env = { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file };
    const out = await pairing.readTrustedBridgeFile(file, { env, platform: 'linux' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.record.nodeId, identity.nodeId);
    const missing = await pairing.readTrustedBridgeFile(path.join(path.dirname(file), 'nope.json'), { env, platform: 'linux' });
    assert.strictEqual(missing.code, 'BRIDGE_FILE_MISSING');
  });
});

describe('bridge-file trust (Windows rules, injected inspector)', () => {
  const file = 'C:\\ProgramData\\KingLouie\\config\\desktop-bridge.json';
  const inspector = (entries, me = 'S-1-5-21-1-2-3-1001') => () => ({ me, entries });

  it('accepts SYSTEM or Administrators as owner of the file and its directory', async () => {
    const out = await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-32-544', link: false }, { owner: 'S-1-5-18', link: false }]) });
    assert.deepStrictEqual(out, { ok: true });
  });

  it('refuses a user-owned directory, a reparse point and (outside test mode) the current user', async () => {
    const user = 'S-1-5-21-1-2-3-1001';
    assert.strictEqual((await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: user, link: false }, { owner: 'S-1-5-18', link: false }]) })).code, 'BRIDGE_FILE_UNTRUSTED');
    assert.strictEqual((await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-18', link: true }, { owner: 'S-1-5-18', link: false }]) })).code, 'BRIDGE_FILE_UNTRUSTED');
    const testEnv = { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file };
    assert.strictEqual((await pairing.checkBridgeFileTrust(file, { env: testEnv, platform: 'win32', inspectOwners: inspector([{ owner: user, link: false }, { owner: user, link: false }]) })).ok, true);
    assert.strictEqual((await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-18', link: false }, null]) })).code, 'BRIDGE_FILE_MISSING');
  });

  it('exports the installers handle-based inspector', () => {
    assert.match(require('../src/service/installers').WINDOWS_INSPECT_CSHARP, /public static class KlFsInspect/);
  });

  // The brief's original test: a real powershell.exe process running the
  // real Add-Type/C# glue, proving the script text is actually valid
  // PowerShell and the C# actually compiles and runs — something no amount
  // of injected-execFile testing below can prove. Kept alongside the
  // injected tests, not instead of them (round 1 fix: this was dropped by
  // mistake, see task-2-report.md).
  it('reads a real owner through PowerShell as a normal user', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
    const f = path.join(tmp(), 'probe.json');
    fs.writeFileSync(f, '{}');
    const out = pairing.inspectWindowsOwners([path.dirname(f), f]);
    assert.match(out.me, /^S-1-5-/);
    assert.strictEqual(out.entries.length, 2);
    assert.match(out.entries[1].owner, /^S-1-5-/);
    assert.strictEqual(out.entries[1].link, false);
  });

  it('refuses (never throws) when the inspector reports no entries, or fewer than asked about', async () => {
    const empty = await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([]) });
    assert.strictEqual(empty.ok, false);
    assert.strictEqual(empty.code, 'BRIDGE_FILE_UNTRUSTED');
    const short = await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-18', link: false }]) });
    assert.strictEqual(short.ok, false);
    assert.strictEqual(short.code, 'BRIDGE_FILE_UNTRUSTED');
  });

  it('refuses (never throws) when the inspector returns a non-array entries', async () => {
    const notArray = () => ({ me: 'S-1-5-21-1-2-3-1001', entries: undefined });
    await assert.doesNotReject(() => pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: notArray }));
    const out = await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: notArray });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'BRIDGE_FILE_UNTRUSTED');

    const stringEntries = () => ({ me: 'S-1-5-21-1-2-3-1001', entries: 'not an array' });
    await assert.doesNotReject(() => pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: stringEntries }));
    assert.strictEqual((await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: stringEntries })).ok, false);

    const noReport = () => undefined;
    await assert.doesNotReject(() => pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: noReport }));
    assert.strictEqual((await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: noReport })).ok, false);
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

  // Final review I2: the desktop's trust read must not block the Electron
  // main process for the ~1.5 s PowerShell takes. The async inspector drives
  // a callback-style execFile, and the event loop keeps turning meanwhile.
  it('the async inspector uses a callback execFile and never blocks the event loop', async () => {
    let captured;
    let finish;
    const execFile = (cmd, args, options, callback) => {
      captured = { cmd, args, options };
      finish = () => callback(null, 'me S-1-5-21-1-2-3-1001\nS-1-5-18 plain\nS-1-5-18 link\n');
    };
    const pending = pairing.inspectWindowsOwnersAsync(['C:\\dir', 'C:\\dir\\f.json'], { execFile, env: {} });
    let loopTurned = false;
    await new Promise((resolve) => setImmediate(() => { loopTurned = true; resolve(); }));
    assert.strictEqual(loopTurned, true);
    finish();
    const out = await pending;
    assert.deepStrictEqual(out, { me: 'S-1-5-21-1-2-3-1001', entries: [{ owner: 'S-1-5-18', link: false }, { owner: 'S-1-5-18', link: true }] });
    assert.match(captured.cmd, /powershell\.exe$/i);
    assert.strictEqual(captured.options.env.KL_INSPECT_PATHS, 'C:\\dir\nC:\\dir\\f.json');
  });

  it('the async inspector rejects on a PowerShell failure and the trust check refuses', async () => {
    const execFile = (cmd, args, options, callback) => setImmediate(() => callback(new Error('exit 1')));
    await assert.rejects(pairing.inspectWindowsOwnersAsync(['C:\\x'], { execFile, env: {} }), /exit 1/);
    const inspectOwners = (paths, opts) => pairing.inspectWindowsOwnersAsync(paths, { ...opts, execFile });
    const out = await pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners });
    assert.strictEqual(out.code, 'BRIDGE_FILE_UNTRUSTED');
  });

  it('checkBridgeFileTrust and readTrustedBridgeFile return promises', () => {
    const inspectOwners = () => ({ me: 'x', entries: [{ owner: 'S-1-5-18', link: false }, null] });
    const a = pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners });
    const b = pairing.readTrustedBridgeFile(file, { env: {}, platform: 'win32', inspectOwners });
    assert.ok(a instanceof Promise);
    assert.ok(b instanceof Promise);
    return Promise.all([a, b]);
  });

  it('reads a real owner through PowerShell asynchronously', { skip: process.platform !== 'win32' ? 'Windows only' : false }, async () => {
    const f = path.join(tmp(), 'probe.json');
    fs.writeFileSync(f, '{}');
    const out = await pairing.inspectWindowsOwnersAsync([path.dirname(f), f]);
    assert.match(out.me, /^S-1-5-/);
    assert.strictEqual(out.entries.length, 2);
    assert.strictEqual(out.entries[1].link, false);
  });
});
