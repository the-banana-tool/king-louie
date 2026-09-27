// tests/deps-acme-client.test.js
//
// Program §3: no new native npm dependency. acme-client (fleet stage 4 §14)
// and everything it pulls in must be pure JS, pinned exactly: no install
// scripts, no node-gyp, no platform-specific (os/cpu) packages and no
// installed .node binaries (ruling M16, modelled on tests/contact-deps.test.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const PINNED = '5.4.0';

// npm lockfile v2/v3: a dependency of the package at `parentPath` resolves to
// the nearest <ancestor>/node_modules/<name> entry.
function entryFor(name, parentPath) {
  let base = parentPath;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[candidate]) return [candidate, lock.packages[candidate]];
    if (!base) return [null, null];
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

function closure() {
  const seen = new Map();
  const root = 'node_modules/acme-client';
  assert.ok(lock.packages[root], 'package-lock.json has node_modules/acme-client');
  const queue = [[root, lock.packages[root]]];
  while (queue.length) {
    const [where, entry] = queue.shift();
    if (seen.has(where)) continue;
    seen.set(where, entry);
    for (const dep of Object.keys({ ...(entry.dependencies || {}), ...(entry.optionalDependencies || {}) })) {
      const [depWhere, depEntry] = entryFor(dep, where);
      assert.ok(depEntry, `${dep} (needed by ${where}) is in the lockfile`);
      queue.push([depWhere, depEntry]);
    }
  }
  return seen;
}

describe('acme-client dependency', () => {
  it('is a runtime dependency pinned to an exact version ≥ 5.3', () => {
    const v = pkg.dependencies && pkg.dependencies['acme-client'];
    assert.match(v || '', /^\d+\.\d+\.\d+$/, 'no range: an exact version');
    const [major, minor] = v.split('.').map(Number);
    assert.ok(major > 5 || (major === 5 && minor >= 3), 'createAlpnCertificate needs ≥ 5.3');
  });

  it(`is pinned to ${PINNED} in package.json and the lockfile alike`, () => {
    assert.equal(pkg.dependencies['acme-client'], PINNED);
    assert.equal(lock.packages[''].dependencies['acme-client'], PINNED, 'lockfile root pins acme-client exactly');
    assert.equal(lock.packages['node_modules/acme-client'].version, PINNED, `lockfile installs acme-client@${PINNED}`);
  });

  it('has no install scripts, native build or platform-specific package anywhere in its tree', () => {
    const tree = closure();
    for (const [where, entry] of tree) {
      assert.notEqual(entry.hasInstallScript, true, `${where} has an install script`);
      assert.notEqual(entry.gypfile, true, `${where} builds native code`);
      assert.equal(entry.os, undefined, `${where} is platform-specific (os)`);
      assert.equal(entry.cpu, undefined, `${where} is platform-specific (cpu)`);
      assert.doesNotMatch(where, /(darwin|linux|win32|android|freebsd)-(x64|arm64|ia32|arm)/, `${where} looks like a prebuilt binary package`);
    }
    assert.ok(tree.size >= 5);
  });

  it('installed packages ship no .node binaries', () => {
    let walked = 0;
    for (const where of closure().keys()) {
      const dir = path.join(ROOT, where);
      if (!fs.existsSync(dir)) continue;
      walked += 1;
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          // Nested node_modules are closure entries of their own.
          if (e.isDirectory()) {
            if (e.name !== 'node_modules') stack.push(path.join(d, e.name));
          } else {
            assert.ok(!e.name.endsWith('.node'), `${path.join(d, e.name)} is a native binary`);
          }
        }
      }
    }
    assert.ok(walked >= 1, 'acme-client is installed');
  });

  it('exposes what the adapter uses', () => {
    const acme = require('acme-client');
    assert.equal(typeof acme.Client, 'function');
    assert.equal(typeof acme.setLogger, 'function');
    assert.equal(typeof acme.crypto.createCsr, 'function');
    assert.equal(typeof acme.crypto.createAlpnCertificate, 'function');
  });
});
