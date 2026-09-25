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

// Where Node would resolve `name` required from the package at `parentPath`:
// its own node_modules, then each enclosing package's, up to the root.
// e.g. from node_modules/qrcode/node_modules/yargs, "cliui" is looked for in
// .../yargs/node_modules, then node_modules/qrcode/node_modules, then node_modules.
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
      for (const dep of Object.keys({ ...(entry.dependencies || {}), ...(entry.optionalDependencies || {}) })) {
        const [depWhere, depEntry] = entryFor(dep, where);
        assert.ok(depEntry, `${dep} (needed by ${where}) is in the lockfile`);
        queue.push([depWhere, depEntry]);
      }
    }
    assert.ok(seen.size >= 2);
    // Every package nested under qrcode is reached (so the walk resolved
    // them the way Node does, not to a same-named package at the root).
    for (const key of Object.keys(lock.packages).filter((k) => k.startsWith('node_modules/qrcode/node_modules/'))) {
      assert.ok(seen.has(key), `${key} was not visited`);
    }
  });

  it('resolves like Node: nearest enclosing node_modules first', () => {
    // Today's lockfile nests cliui under qrcode (yargs 15 needs an older
    // cliui than the root's); the walk must find that copy.
    assert.ok(lock.packages['node_modules/qrcode/node_modules/cliui'], 'lockfile layout changed; update this test');
    assert.equal(entryFor('cliui', 'node_modules/qrcode/node_modules/yargs')[0], 'node_modules/qrcode/node_modules/cliui');
    assert.equal(entryFor('dijkstrajs', 'node_modules/qrcode')[0], 'node_modules/dijkstrajs');
  });

  it('renders a terminal QR code for a kl1: payload', async () => {
    const QRCode = require('qrcode');
    const text = await QRCode.toString('kl1:eyJ0Ijoia2wucmVsYXkifQ', { type: 'terminal', small: true });
    assert.ok(text.split('\n').length > 10);
  });
});
