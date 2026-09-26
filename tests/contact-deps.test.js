// tests/contact-deps.test.js — cases stage 4 §14 and program §3: the three
// new dependencies and everything they pull in are pure JS: no install
// scripts, no node-gyp, no platform-specific binary packages.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NEW_DEPS = ['nodemailer', 'imapflow', 'mailparser'];

// npm lockfile v2/v3: a dependency of the package at `from` resolves to the
// nearest <ancestor>/node_modules/<name> entry.
function resolve(name, from) {
  let base = from;
  for (;;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (lock.packages[key]) return key;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i === -1 ? '' : base.slice(0, i);
  }
}

function closure(roots) {
  const seen = new Set();
  const queue = roots.map((n) => resolve(n, ''));
  while (queue.length) {
    const key = queue.shift();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = lock.packages[key];
    for (const dep of Object.keys({ ...(entry.dependencies || {}), ...(entry.optionalDependencies || {}) })) {
      const found = resolve(dep, key);
      assert.ok(found, `${dep} (needed by ${key}) is missing from package-lock.json`);
      queue.push(found);
    }
  }
  return [...seen];
}

describe('contact dependencies', () => {
  it('package.json names nodemailer, imapflow and mailparser', () => {
    for (const name of NEW_DEPS) assert.ok(pkg.dependencies[name], `${name} is a dependency`);
  });

  it('the three are pinned to exact versions (no range) and the lockfile agrees', () => {
    const PINNED = { nodemailer: '10.0.10', imapflow: '2.0.7', mailparser: '3.9.28' };
    for (const [name, version] of Object.entries(PINNED)) {
      assert.strictEqual(pkg.dependencies[name], version, `${name} is pinned to ${version}`);
      assert.strictEqual(lock.packages[''].dependencies[name], version, `lockfile root pins ${name}`);
      assert.strictEqual(lock.packages[`node_modules/${name}`].version, version, `lockfile installs ${name}@${version}`);
    }
  });

  it('lockfile: no install scripts, node-gyp or platform binaries anywhere in their closure', () => {
    const keys = closure(NEW_DEPS);
    assert.ok(keys.length >= NEW_DEPS.length);
    for (const key of keys) {
      const entry = lock.packages[key];
      assert.notStrictEqual(entry.hasInstallScript, true, `${key} has an install script`);
      assert.notStrictEqual(entry.gypfile, true, `${key} builds with node-gyp`);
      assert.strictEqual(entry.os, undefined, `${key} is platform-specific (os)`);
      assert.strictEqual(entry.cpu, undefined, `${key} is platform-specific (cpu)`);
      assert.doesNotMatch(key, /(darwin|linux|win32|android|freebsd)-(x64|arm64|ia32|arm)/, `${key} looks like a prebuilt binary package`);
    }
  });

  it('installed packages ship no .node binaries', () => {
    for (const key of closure(NEW_DEPS)) {
      const dir = path.join(ROOT, key);
      if (!fs.existsSync(dir)) continue;
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) {
            if (e.name !== 'node_modules') stack.push(path.join(d, e.name));
          } else {
            assert.ok(!e.name.endsWith('.node'), `${path.join(d, e.name)} is a native binary`);
          }
        }
      }
    }
  });
});
