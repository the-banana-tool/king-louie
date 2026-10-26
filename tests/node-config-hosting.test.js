// tests/node-config-hosting.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadNodeConfig } = require('../src/service/node-config');

const EUID = typeof process.geteuid === 'function' ? process.geteuid() : 0;
const POSIX = process.platform !== 'win32';

// <root>/config/node.yaml, admin-owned the way the loader wants it: the test's
// own uid stands in for root, the dir is 0755 and the file 0644.
function withAdminDir(yaml, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-hosting-'));
  try {
    const dir = path.join(root, 'config');
    fs.mkdirSync(dir);
    if (POSIX) fs.chmodSync(dir, 0o755);
    const file = path.join(dir, 'node.yaml');
    fs.writeFileSync(file, yaml, 'utf8');
    if (POSIX) fs.chmodSync(file, 0o644);
    return fn(dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const load = (dir) => loadNodeConfig({ adminConfigDir: dir, geteuid: () => EUID, adminUid: EUID });

const emptyDirs = [];
function emptyTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-hosting-empty-'));
  emptyDirs.push(dir);
  return dir;
}
after(() => { for (const dir of emptyDirs) fs.rmSync(dir, { recursive: true, force: true }); });

describe('node.yaml hosting', () => {
  it('defaults to service', () => withAdminDir('name: n\nprofile: agent\n', (dir) => assert.equal(load(dir).hosting, 'service')));
  it('accepts personal on an agent node', () => withAdminDir('name: n\nprofile: agent\nhosting: personal\n', (dir) => assert.equal(load(dir).hosting, 'personal')));
  it('refuses any other value', () => withAdminDir('name: n\nprofile: agent\nhosting: laptop\n', (dir) => assert.throws(() => load(dir), /hosting must be "service" or "personal"/)));
  it('refuses personal on a runbook or frontdoor node', () => {
    withAdminDir('name: n\nprofile: runbook\nhosting: personal\n', (dir) => assert.throws(() => load(dir), /hosting: personal needs profile: agent/));
    withAdminDir('name: n\nprofile: frontdoor\nhosting: personal\n', (dir) => assert.throws(() => load(dir), /hosting: personal needs profile: agent/));
  });
  it('a missing node.yaml gives hosting service', () => assert.equal(loadNodeConfig({ adminConfigDir: emptyTempDir() }).hosting, 'service'));
});
