// tests/ingest-deps.test.js
// Cases stage 7 adds unpdf and pdf-lib (spec §14). Both must stay pure JS:
// no install scripts, no native binaries, no native canvas pulled in.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const packages = lock.packages || {};

// The lockfile entry npm would resolve `name` to from the package at `from`.
function resolveEntry(from, name) {
  let dir = from;
  for (;;) {
    const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
    if (packages[key]) return key;
    if (!dir) return null;
    const cut = dir.lastIndexOf('/node_modules/');
    dir = cut === -1 ? '' : dir.slice(0, cut);
  }
}

// Every lockfile entry installed because of `roots` (dependencies only; an
// optional peer that is not installed has no entry).
function closure(roots) {
  const seen = new Set();
  const stack = roots.map((r) => resolveEntry('', r)).filter(Boolean);
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = packages[key];
    for (const dep of Object.keys({ ...(entry.dependencies || {}), ...(entry.optionalDependencies || {}) })) {
      const found = resolveEntry(key, dep);
      if (found) stack.push(found);
    }
  }
  return [...seen];
}

function nativeFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return nativeFiles(full);
    return e.name.endsWith('.node') ? [full] : [];
  });
}

describe('ingest dependencies (cases stage 7)', () => {
  it('declares unpdf and pdf-lib as runtime dependencies', () => {
    assert.ok(pkg.dependencies.unpdf, 'unpdf missing from dependencies');
    assert.ok(pkg.dependencies['pdf-lib'], 'pdf-lib missing from dependencies');
  });

  it('has no install scripts and no native binaries under unpdf and pdf-lib', () => {
    const keys = closure(['unpdf', 'pdf-lib']);
    assert.ok(keys.includes('node_modules/unpdf') && keys.includes('node_modules/pdf-lib'), `closure was ${keys.join(', ')}`);
    for (const key of keys) {
      assert.notStrictEqual(packages[key].hasInstallScript, true, `${key} has an install script`);
      assert.deepStrictEqual(nativeFiles(path.join(ROOT, key)), [], `${key} ships a .node binary`);
    }
  });

  it('has no native canvas installed (unpdf lists @napi-rs/canvas only as an optional peer)', () => {
    const native = Object.keys(packages).filter((k) => /(^|\/)node_modules\/(@napi-rs\/canvas|canvas)$/.test(k));
    assert.deepStrictEqual(native, []);
    assert.strictEqual(packages['node_modules/unpdf'].peerDependenciesMeta?.['@napi-rs/canvas']?.optional, true);
  });

  it('loads both through require', () => {
    assert.strictEqual(typeof require('unpdf').extractText, 'function');
    assert.strictEqual(typeof require('pdf-lib').PDFDocument.load, 'function');
  });
});

describe('settings.cases.ingest', () => {
  const { mergeSettings } = require('../src/core/settings');
  const { INGEST_DEFAULTS, mergeIngestSettings, resolveIngestSettings } = require('../src/cases/ingest/settings');

  it('carries the defaults and merges key by key', () => {
    assert.deepStrictEqual(mergeSettings({}).cases.ingest, JSON.parse(JSON.stringify(INGEST_DEFAULTS)));
    const partial = mergeSettings({ cases: { ingest: { maxPages: 50, vision: { provider: 'gemini' }, entities: { spanNames: true } } } }).cases.ingest;
    assert.deepStrictEqual(
      [partial.maxPages, partial.maxBytes, partial.vision, partial.entities.spanNames],
      [50, 52428800, undefined, true]
    );
  });

  it('repairs invalid values to the defaults', () => {
    const r = resolveIngestSettings({ maxBytes: -1, textQualityThreshold: 3, chunkChars: 'x', vision: { provider: ' OpenAI ', model: ' m ' } });
    assert.strictEqual(r.maxBytes, 52428800);
    assert.strictEqual(r.textQualityThreshold, 0.6);
    assert.strictEqual(r.chunkChars, 12000);
    assert.strictEqual(r.vision, undefined, 'the OCR model is the profile\'s vision role now (models spec §13)');
    assert.strictEqual(r.entities.spanNames, false);
  });

  it('never lets a limit turn off (zero, negative, Infinity, NaN all fall back)', () => {
    for (const bad of [0, -5, Infinity, -Infinity, NaN, '0']) {
      const r = resolveIngestSettings({ maxBytes: bad, maxPages: bad, maxVisionPagesPerDoc: bad, chunkChars: bad, maxExtractChars: bad, maxProposalsPerDoc: bad });
      assert.strictEqual(r.maxBytes, INGEST_DEFAULTS.maxBytes, `maxBytes for ${bad}`);
      assert.strictEqual(r.maxPages, INGEST_DEFAULTS.maxPages, `maxPages for ${bad}`);
      assert.strictEqual(r.maxVisionPagesPerDoc, INGEST_DEFAULTS.maxVisionPagesPerDoc, `maxVisionPagesPerDoc for ${bad}`);
      assert.strictEqual(r.chunkChars, INGEST_DEFAULTS.chunkChars, `chunkChars for ${bad}`);
      assert.strictEqual(r.maxExtractChars, INGEST_DEFAULTS.maxExtractChars, `maxExtractChars for ${bad}`);
      assert.strictEqual(r.maxProposalsPerDoc, INGEST_DEFAULTS.maxProposalsPerDoc, `maxProposalsPerDoc for ${bad}`);
    }
  });

  it('treats a "__proto__" key in settings as inert (null-prototype merge)', () => {
    // Simulates untrusted settings JSON where "__proto__" is a genuine own
    // property (JSON.parse never triggers the accessor), not object-literal
    // prototype-setting syntax.
    const evil = JSON.parse('{"__proto__":{"polluted":"yes"},"maxPages":9}');
    const evilVision = JSON.parse('{"__proto__":{"polluted":"yes"},"provider":"openai"}');

    const merged = mergeIngestSettings({}, evil);
    assert.strictEqual(merged.maxPages, 9);
    assert.strictEqual(Object.getPrototypeOf(merged), Object.prototype);
    assert.deepStrictEqual(Object.keys(merged).includes('__proto__'), false);
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);

    const resolved = resolveIngestSettings({ ...evil, vision: evilVision });
    assert.strictEqual(resolved.maxPages, 9);
    assert.strictEqual(resolved.vision, undefined);
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);
  });
});
