const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultServiceDataDir, ensureServicePaths } = require('../src/platform/paths');

describe('service paths', () => {
  it('uses OS-appropriate system locations', () => {
    assert.strictEqual(defaultServiceDataDir({ platform: 'linux', env: {} }), '/var/lib/king-louie');
    assert.strictEqual(defaultServiceDataDir({ platform: 'darwin', env: {} }), '/Library/Application Support/KingLouie/data');
    assert.strictEqual(defaultServiceDataDir({ platform: 'win32', env: { ProgramData: 'D:\\PD' } }), 'D:\\PD\\KingLouie\\data');
    assert.strictEqual(defaultServiceDataDir({ platform: 'win32', env: {} }), 'C:\\ProgramData\\KingLouie\\data');
  });

  it('creates private data, logs and cache dirs', () => {
    const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-paths-')), 'data');
    const p = ensureServicePaths(base);
    for (const d of [p.dataDir, p.logsDir, p.cacheDir]) assert.ok(fs.statSync(d).isDirectory());
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(p.dataDir).mode & 0o077, 0);
  });
});
