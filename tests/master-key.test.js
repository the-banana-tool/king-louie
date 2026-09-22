const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveMasterKey, MASTER_KEY_CREDENTIAL } = require('../src/platform/master-key');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mk-'));

describe('resolveMasterKey', () => {
  it('prefers a systemd credential', () => {
    const credDir = tmp();
    const hex = 'ab'.repeat(32);
    fs.writeFileSync(path.join(credDir, MASTER_KEY_CREDENTIAL), hex);
    const r = resolveMasterKey({ platform: 'linux', dataDir: tmp(), env: { CREDENTIALS_DIRECTORY: credDir } });
    assert.strictEqual(r.source, 'systemd-credential');
    assert.strictEqual(r.key.toString('hex'), hex);
  });

  it('creates then reuses a private key file on posix', { skip: process.platform === 'win32' }, () => {
    const dataDir = tmp();
    const a = resolveMasterKey({ platform: process.platform, dataDir, env: {} });
    const b = resolveMasterKey({ platform: process.platform, dataDir, env: {} });
    assert.strictEqual(a.source, 'key-file');
    assert.ok(a.key.equals(b.key));
    assert.strictEqual(fs.statSync(path.join(dataDir, 'master.key')).mode & 0o077, 0);
  });

  it('refuses a key file readable by others', { skip: process.platform === 'win32' }, () => {
    const dataDir = tmp();
    fs.writeFileSync(path.join(dataDir, 'master.key'), 'cd'.repeat(32), { mode: 0o644 });
    fs.chmodSync(path.join(dataDir, 'master.key'), 0o644);
    assert.throws(() => resolveMasterKey({ platform: process.platform, dataDir, env: {} }), /permissions/);
  });

  it('wraps the key with DPAPI on Windows (fake DPAPI)', () => {
    const dataDir = tmp();
    const dpapi = { protect: (b) => Buffer.concat([Buffer.from('P:'), b]), unprotect: (b) => b.subarray(2) };
    const a = resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi });
    const b = resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi });
    assert.strictEqual(a.source, 'dpapi');
    assert.ok(a.key.equals(b.key));
    assert.ok(fs.readFileSync(path.join(dataDir, 'master.key.dpapi')).subarray(0, 2).equals(Buffer.from('P:')));
  });

  it('round-trips real DPAPI', { skip: process.platform !== 'win32' }, () => {
    const { createPowerShellDpapi } = require('../src/platform/master-key');
    const dpapi = createPowerShellDpapi();
    const secret = Buffer.from('0123456789abcdef');
    assert.ok(dpapi.unprotect(dpapi.protect(secret)).equals(secret));
  });
});
