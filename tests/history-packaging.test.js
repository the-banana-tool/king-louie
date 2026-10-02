// tests/history-packaging.test.js
// The local model runtime ships with the app (recall spec §12 package.json
// row): exact versions, onnxruntime-node unpacked from the asar (a .node file
// cannot load from inside it), each platform without the others' binaries,
// and no build pattern that would drop src/models (the model catalog).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ORT = 'node_modules/onnxruntime-node/bin/napi-v*';

describe('packaging the local model runtime', () => {
  it('pins @huggingface/transformers and onnxruntime-node', () => {
    assert.strictEqual(pkg.dependencies['@huggingface/transformers'], '4.3.0');
    assert.strictEqual(pkg.dependencies['onnxruntime-node'], '1.30.0');
  });

  it('unpacks onnxruntime-node (and sharp when transformers brought it)', () => {
    assert.ok(pkg.build.asarUnpack.includes('node_modules/onnxruntime-node/**'));
    if (fs.existsSync(path.join(root, 'node_modules', 'sharp'))) {
      assert.ok(pkg.build.asarUnpack.includes('node_modules/sharp/**'));
      assert.ok(pkg.build.asarUnpack.includes('node_modules/@img/**'));
    }
  });

  it('each platform build leaves out the other platforms\' onnxruntime binaries', () => {
    // One top-level pattern with electron-builder's ${platform} macro
    // (win32, darwin, linux). A platform-level `files` list replaces the
    // top-level one in electron-builder 26: its exclusions are lost and .git,
    // tests and src/longhaul go into the asar. So no platform block has one.
    const pattern = `!${ORT}/!(\${platform})/**`;
    assert.ok(pkg.build.files.includes(pattern), pattern);
    for (const p of ['win', 'mac', 'linux']) assert.strictEqual(pkg.build[p].files, undefined, `build.${p}.files`);
    const binary = (platform) => `node_modules/onnxruntime-node/bin/napi-v6/${platform}/x64/onnxruntime_binding.node`;
    for (const platform of ['win32', 'darwin', 'linux']) {
      const glob = pattern.slice(1).replace('${platform}', platform);
      for (const other of ['win32', 'darwin', 'linux']) {
        assert.strictEqual(path.posix.matchesGlob(binary(other), glob), other !== platform, `${platform} build, ${other} binary`);
      }
    }
  });

  it('never excludes a models folder: src/models is the model catalog, and model files live in the data dir', () => {
    const all = [...pkg.build.files, ...['win', 'mac', 'linux'].flatMap((p) => pkg.build[p].files || [])];
    assert.deepStrictEqual(all.filter((p) => p.startsWith('!') && /(^|\/)models(\/|$)/.test(p.replace(/^!/, ''))), []);
  });

  it('the runtime resolves from the app root, where the worker requires it', () => {
    assert.ok(require.resolve('@huggingface/transformers', { paths: [root] }));
    assert.ok(require.resolve('onnxruntime-node', { paths: [root] }));
  });
});
