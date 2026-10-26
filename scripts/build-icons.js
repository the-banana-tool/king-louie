#!/usr/bin/env node
'use strict';
// Builds every app icon from `icons/src/icon.svg`.
//
//   node scripts/build-icons.js            (npm run icons:build)
//
// Rasterizes with the Chromium that Playwright ships (a devDependency), so no
// native image library is needed. What it writes:
//
//   icons/icon.png, icons/icon-<n>x<n>.png   Linux (electron-builder), 16 to 512
//   icons/icon.ico                            Windows, 16 to 256 (PNG entries)
//   icons/icon.icns                           macOS, Apple's inset tile, 16 to 1024
//   favicon.ico, favicon.png                  the BrowserWindow icon (main.js)
//   mobile/android/app/src/main/res/...       adaptive launcher layers per density
//   mobile/android/app/src/main/ic_launcher-playstore.png   Play listing, 512
//   mobile/ios/App/Assets.xcassets/AppIcon.appiconset/      1024 light, dark, tinted
//
// The three Android XML files and the monochrome vector are hand-written and
// kept in the repo; only the bitmaps are generated.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'icons', 'src', 'icon.svg');
const ANDROID_RES = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res');
const IOS_ICONSET = path.join(ROOT, 'mobile', 'ios', 'App', 'Assets.xcassets', 'AppIcon.appiconset');

const master = fs.readFileSync(SRC, 'utf8');

// --- variants ---------------------------------------------------------------

function stripSize(svg) {
  return svg.replace(/<svg([^>]*)>/, (m, a) => `<svg${a.replace(/\s(width|height)="[^"]*"/g, '')}>`);
}
function squareTile(svg) {
  // No rounded corners: iOS and Google Play apply their own mask.
  return svg.replace(/(<rect id="tile(?:-glow)?"[^>]*?)\srx="[^"]*"/g, '$1');
}
function noTile(svg) {
  return svg.replace(/<rect id="tile(?:-glow)?"[^>]*\/>\s*/g, '');
}
function inner(svg) {
  // Everything between the <svg> tags, for nesting in a wrapper.
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}
function wrap(content, transform, extraStyle = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
    `<g transform="${transform}"${extraStyle ? ` style="${extraStyle}"` : ''}>${content}</g></svg>`;
}

const variants = {
  // The desktop tile as drawn: rounded, transparent corners.
  tile: stripSize(master),
  // Full-bleed square, no transparency.
  square: stripSize(squareTile(master)),
  // Apple's macOS grid: the tile is 824 of the 1024 canvas, centred.
  mac: wrap(inner(master), 'translate(100 100) scale(0.8046875)'),
  // iOS dark: the system draws the background; the glyph alone, transparent.
  glyph: stripSize(noTile(master)),
  // iOS tinted: a grayscale glyph the system colours.
  tinted: wrap(inner(noTile(master)), '', 'filter: grayscale(1)'),
  // Android adaptive foreground: the glyph inside the 66/108 safe zone.
  // The art's own centre is about (545, 431), not the canvas centre.
  foreground: wrap(inner(noTile(master)), 'translate(512 512) scale(0.7) translate(-545 -431)'),
  // Android adaptive background: the tile's gradient, edge to edge.
  background: stripSize(squareTile(master)).replace(/<g id="art">[\s\S]*<\/g>\s*(?=<\/svg>)/, ''),
};

// --- rasterizer -------------------------------------------------------------

let browser;
let page;
async function render(svg, size, { opaque = false } = {}) {
  if (!browser) {
    browser = await chromium.launch();
    page = await browser.newPage({ deviceScaleFactor: 1 });
  }
  await page.setViewportSize({ width: size, height: size });
  const body = svg.replace(/<svg([^>]*)>/, (m, a) => `<svg${a} width="${size}" height="${size}" style="display:block">`);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${opaque ? '#000' : 'transparent'}">${body}</body></html>`);
  return page.screenshot({ omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
}

// --- containers -------------------------------------------------------------

function ico(entries) {
  // entries: [{ size, png }]; every image is stored as PNG, which Windows
  // reads for all sizes since Vista.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = [];
  const data = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
    data.push(png);
  }
  return Buffer.concat([header, ...dir, ...data]);
}

const ICNS_TYPES = {
  16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10',
};
const ICNS_RETINA = { 32: 'ic11', 64: 'ic12', 256: 'ic13', 512: 'ic14' }; // 16@2x … 256@2x

function icns(pngBySize) {
  const chunks = [];
  const add = (type, png) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(8 + png.length, 4);
    chunks.push(h, png);
  };
  for (const [size, type] of Object.entries(ICNS_TYPES)) add(type, pngBySize[size]);
  for (const [size, type] of Object.entries(ICNS_RETINA)) add(type, pngBySize[size]);
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

// --- outputs ----------------------------------------------------------------

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`${path.relative(ROOT, file)}  ${buf.length} bytes`);
}

async function main() {
  // Desktop: Linux PNGs and the Windows ICO from the rounded tile.
  const tile = {};
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) tile[size] = await render(variants.tile, size);
  for (const size of [16, 32, 48, 64, 128, 256, 512]) write(path.join(ROOT, 'icons', `icon-${size}x${size}.png`), tile[size]);
  write(path.join(ROOT, 'icons', 'icon.png'), tile[512]);
  write(path.join(ROOT, 'icons', 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: tile[size] }))));
  write(path.join(ROOT, 'favicon.ico'), ico([16, 32, 48].map((size) => ({ size, png: tile[size] }))));
  write(path.join(ROOT, 'favicon.png'), tile[48]);

  // macOS: the inset tile at every ICNS size.
  const mac = {};
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) mac[size] = await render(variants.mac, size);
  write(path.join(ROOT, 'icons', 'icon.icns'), icns(mac));

  // iOS: one 1024 image per appearance; the light one must be opaque.
  write(path.join(IOS_ICONSET, 'AppIcon.png'), await render(variants.square, 1024, { opaque: true }));
  write(path.join(IOS_ICONSET, 'AppIcon-dark.png'), await render(variants.glyph, 1024));
  write(path.join(IOS_ICONSET, 'AppIcon-tinted.png'), await render(variants.tinted, 1024));

  // Android: adaptive layers at 108dp per density, and the Play listing icon.
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [name, scale] of Object.entries(densities)) {
    const px = Math.round(108 * scale);
    write(path.join(ANDROID_RES, `mipmap-${name}`, 'ic_launcher_foreground.png'), await render(variants.foreground, px));
    write(path.join(ANDROID_RES, `mipmap-${name}`, 'ic_launcher_background.png'), await render(variants.background, px, { opaque: true }));
  }
  write(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'ic_launcher-playstore.png'), await render(variants.square, 512, { opaque: true }));

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
