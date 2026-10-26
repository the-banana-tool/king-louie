'use strict';
// The generated app icons (scripts/build-icons.js) are what the installers
// and the mobile projects ship: each must be there, the size its platform
// expects, and (for iOS and Google Play) without an alpha channel.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p));

function pngInfo(buf) {
  assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG', 'not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf.readUInt8(25) };
}

function icoSizes(buf) {
  assert.strictEqual(buf.readUInt16LE(2), 1, 'not an ICO');
  const n = buf.readUInt16LE(4);
  return Array.from({ length: n }, (_, i) => {
    const w = buf.readUInt8(6 + i * 16);
    return w === 0 ? 256 : w;
  }).sort((a, b) => a - b);
}

function icnsTypes(buf) {
  assert.strictEqual(buf.toString('ascii', 0, 4), 'icns', 'not an ICNS');
  assert.strictEqual(buf.readUInt32BE(4), buf.length, 'icns length');
  const types = {};
  let off = 8;
  while (off < buf.length) {
    const type = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    types[type] = pngInfo(buf.subarray(off + 8, off + len)).width;
    off += len;
  }
  return types;
}

describe('app icons', () => {
  it('desktop PNGs are square at their named size', () => {
    for (const size of [16, 32, 48, 64, 128, 256, 512]) {
      const info = pngInfo(read(`icons/icon-${size}x${size}.png`));
      assert.deepStrictEqual([info.width, info.height], [size, size]);
    }
    assert.strictEqual(pngInfo(read('icons/icon.png')).width, 512);
    assert.strictEqual(pngInfo(read('favicon.png')).width, 48);
  });

  it('Windows ICO and the favicon hold the expected sizes', () => {
    assert.deepStrictEqual(icoSizes(read('icons/icon.ico')), [16, 24, 32, 48, 64, 128, 256]);
    assert.deepStrictEqual(icoSizes(read('favicon.ico')), [16, 32, 48]);
  });

  it('macOS ICNS holds every size from 16 to 1024 with the retina entries', () => {
    assert.deepStrictEqual(icnsTypes(read('icons/icon.icns')), {
      icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
      ic11: 32, ic12: 64, ic13: 256, ic14: 512,
    });
  });

  it('iOS icons are 1024 and the light one is opaque', () => {
    const dir = 'mobile/ios/App/Assets.xcassets/AppIcon.appiconset';
    const contents = JSON.parse(read(`${dir}/Contents.json`));
    const files = contents.images.map((i) => i.filename).sort();
    assert.deepStrictEqual(files, ['AppIcon-dark.png', 'AppIcon-tinted.png', 'AppIcon.png']);
    for (const f of files) assert.strictEqual(pngInfo(read(`${dir}/${f}`)).width, 1024, f);
    assert.strictEqual(pngInfo(read(`${dir}/AppIcon.png`)).colorType, 2, 'AppIcon.png must have no alpha');
    assert.strictEqual(pngInfo(read(`${dir}/AppIcon-dark.png`)).colorType, 6, 'the dark icon is a transparent glyph');
  });

  it('Android adaptive layers exist at every density, and the Play icon is opaque', () => {
    const res = 'mobile/android/app/src/main/res';
    const densities = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
    for (const [name, px] of Object.entries(densities)) {
      assert.strictEqual(pngInfo(read(`${res}/mipmap-${name}/ic_launcher_foreground.png`)).width, px, name);
      assert.strictEqual(pngInfo(read(`${res}/mipmap-${name}/ic_launcher_background.png`)).width, px, name);
    }
    for (const xml of ['ic_launcher', 'ic_launcher_round']) {
      const text = read(`${res}/mipmap-anydpi-v26/${xml}.xml`).toString();
      assert.match(text, /<background android:drawable="@mipmap\/ic_launcher_background"/);
      assert.match(text, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"/);
      assert.match(text, /<monochrome android:drawable="@drawable\/ic_launcher_monochrome"/);
    }
    assert.ok(fs.existsSync(path.join(ROOT, res, 'drawable/ic_launcher_monochrome.xml')));
    const play = pngInfo(read('mobile/android/app/src/main/ic_launcher-playstore.png'));
    assert.deepStrictEqual([play.width, play.colorType], [512, 2]);
    const manifest = read('mobile/android/app/src/main/AndroidManifest.xml').toString();
    assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
    assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  });
});
