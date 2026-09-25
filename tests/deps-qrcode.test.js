// tests/deps-qrcode.test.js
//
// Program §3: no new native npm dependency. `qrcode` (spec §14) and
// everything it pulls in must be pure JS: no install scripts, no node-gyp.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const lock = require(path.join(ROOT, 'package-lock.json'));

function entryFor(name, parentPath) {
  const nested = `${parentPath}/node_modules/${name}`;
  if (lock.packages[nested]) return [nested, lock.packages[nested]];
  const flat = `node_modules/${name}`;
  return lock.packages[flat] ? [flat, lock.packages[flat]] : [null, null];
}

describe('qrcode dependency', () => {
  it('is a runtime dependency', () => {
    assert.ok(pkg.dependencies && pkg.dependencies.qrcode, 'package.json dependencies.qrcode');
  });

  it('has no install scripts or native build anywhere in its tree', () => {
    const seen = new Set();
    const queue = [['node_modules/qrcode', lock.packages['node_modules/qrcode']]];
    assert.ok(queue[0][1], 'package-lock.json has node_modules/qrcode');
    while (queue.length) {
      const [where, entry] = queue.shift();
      if (seen.has(where)) continue;
      seen.add(where);
      assert.notEqual(entry.hasInstallScript, true, `${where} has an install script`);
      assert.notEqual(entry.gypfile, true, `${where} builds native code`);
      for (const dep of Object.keys(entry.dependencies || {})) {
        const [depWhere, depEntry] = entryFor(dep, where);
        assert.ok(depEntry, `${dep} (needed by ${where}) is in the lockfile`);
        queue.push([depWhere, depEntry]);
      }
    }
    assert.ok(seen.size >= 2);
  });

  it('renders a terminal QR code for a kl1: payload', async () => {
    const QRCode = require('qrcode');
    const text = await QRCode.toString('kl1:eyJ0Ijoia2wucmVsYXkifQ', { type: 'terminal', small: true });
    assert.ok(text.split('\n').length > 10);
  });
});
