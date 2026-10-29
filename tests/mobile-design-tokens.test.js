'use strict';
// The Android app wears the desktop's design tokens (spec
// docs/superpowers/specs/2026-10-28-android-app-slim-design.md §11, R-AN-8).
// styles.css's first `:root` block is the source; Tokens.kt's `KlTokens`
// must follow it, one `val` per token, and the theme is dark only. A change
// to the desktop palette fails here until Tokens.kt follows.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_MAIN = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main');
const KOTLIN_DIR = path.join(APP_MAIN, 'kotlin', 'com', 'example', 'kinglouie');
const TOKENS_KT = path.join(KOTLIN_DIR, 'Tokens.kt');
const THEME_KT = path.join(KOTLIN_DIR, 'Theme.kt');

// Not carried to Android (§11.1): Compose has its own motion, and the font
// stacks are not on Android (§11.3).
const EXCLUDED = new Set(['--transition', '--font-sans', '--font-mono']);

function camel(cssName) {
  return cssName.replace(/^--/, '').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseCssRoot() {
  const css = stripCssComments(fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8'));
  const m = css.match(/:root\s*\{([^}]*)\}/);
  assert.ok(m, 'styles.css has a :root block');
  const tokens = new Map();
  for (const decl of m[1].split(';')) {
    const d = decl.trim();
    if (!d) continue;
    const i = d.indexOf(':');
    tokens.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return tokens;
}

function hex2(n) {
  return n.toString(16).padStart(2, '0').toUpperCase();
}

/** A CSS value as { kind: 'color', argb } or { kind: 'dp', value }, or null. */
function cssValue(value) {
  let m = value.match(/^#([0-9a-fA-F]{6})$/);
  if (m) return { kind: 'color', argb: ('FF' + m[1]).toUpperCase() };
  m = value.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    const a = Math.round(Number(m[4]) * 255);
    return { kind: 'color', argb: [a, r, g, b].map(hex2).join('') };
  }
  m = value.match(/^(\d+(?:\.\d+)?)px$/);
  if (m) return { kind: 'dp', value: Number(m[1]) };
  return null;
}

function kotlinInt(s) {
  return /^0x/i.test(s) ? parseInt(s.slice(2), 16) : parseInt(s, 10);
}

function stripKotlinComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every `val` in Tokens.kt, as name -> [parsed values]. */
function parseTokensKt() {
  const kt = stripKotlinComments(fs.readFileSync(TOKENS_KT, 'utf8'));
  const vals = new Map();
  const add = (name, v) => {
    if (!vals.has(name)) vals.set(name, []);
    vals.get(name).push(v);
  };
  for (const m of kt.matchAll(/\bval\s+(\w+)\s*(?::\s*[\w.]+\s*)?=\s*([^\n]+)/g)) {
    const [, name, rhs] = m;
    let r;
    if ((r = rhs.match(/^Color\(\s*0x([0-9a-fA-F]{8})\s*\)/))) {
      add(name, { kind: 'color', argb: r[1].toUpperCase() });
    } else if ((r = rhs.match(/^Color\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/))) {
      const [red, green, blue, alpha] = r.slice(1).map(kotlinInt);
      add(name, { kind: 'color', argb: [alpha, red, green, blue].map(hex2).join('') });
    } else if ((r = rhs.match(/^(\d+(?:\.\d+)?)\.dp\b/))) {
      add(name, { kind: 'dp', value: Number(r[1]) });
    } else {
      add(name, { kind: 'other', text: rhs.trim() });
    }
  }
  return vals;
}

function kotlinFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...kotlinFiles(p));
    else if (e.name.endsWith('.kt')) out.push(p);
  }
  return out;
}

// WCAG 2 relative luminance and contrast; a translucent colour is
// composited over the opaque surface it is drawn on.
function channels(argb) {
  const n = parseInt(argb, 16);
  return { a: ((n >>> 24) & 255) / 255, r: (n >>> 16) & 255, g: (n >>> 8) & 255, b: n & 255 };
}
function over(top, bottom) {
  const t = channels(top);
  const b = channels(bottom);
  assert.equal(b.a, 1, 'a backdrop is opaque');
  const mix = (x, y) => Math.round(x * t.a + y * (1 - t.a));
  return 'FF' + [mix(t.r, b.r), mix(t.g, b.g), mix(t.b, b.b)].map(hex2).join('');
}
function luminance(argb) {
  const { r, g, b } = channels(argb);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg, bg) {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('mobile design tokens (Android follows styles.css :root)', () => {
  const css = parseCssRoot();

  it('the :root block has the tokens the spec names, and each value parses', () => {
    assert.ok(css.has('--bg-base'));
    for (const [name, value] of css) {
      if (EXCLUDED.has(name)) continue;
      assert.ok(cssValue(value), `${name}: ${value} is a hex, rgba or px value`);
    }
    for (const name of EXCLUDED) assert.ok(css.has(name), `${name} is still in :root (else drop it from the excluded set)`);
  });

  it('a worked example: rgba alpha rounds to a byte, a px is a dp', () => {
    assert.deepEqual(cssValue('rgba(137,180,250,0.08)'), { kind: 'color', argb: '1489B4FA' });
    assert.deepEqual(cssValue('rgba(137,180,250,0.06)'), { kind: 'color', argb: '0F89B4FA' });
    assert.deepEqual(cssValue('#1e1e2e'), { kind: 'color', argb: 'FF1E1E2E' });
    assert.deepEqual(cssValue('14px'), { kind: 'dp', value: 14 });
  });

  it('every CSS token has exactly one KlTokens val of the same value, and no other val', () => {
    const vals = parseTokensKt();
    const expected = new Set();
    for (const [name, value] of css) {
      if (EXCLUDED.has(name)) continue;
      const kt = camel(name);
      expected.add(kt);
      const found = vals.get(kt);
      assert.ok(found, `Tokens.kt has val ${kt} (${name})`);
      assert.equal(found.length, 1, `Tokens.kt has exactly one val ${kt}`);
      assert.deepEqual(found[0], cssValue(value), `${kt} equals ${name} (${value})`);
    }
    for (const name of vals.keys()) assert.ok(expected.has(name), `Tokens.kt val ${name} has a CSS token`);
  });

  it('every pair a person reads is at least 4.5:1', () => {
    const c = (name) => cssValue(css.get(name)).argb;
    const pairs = [
      // [label, foreground, background]
      ['textPrimary on bgBase', c('--text-primary'), c('--bg-base')],
      ['textSecondary on bgBase', c('--text-secondary'), c('--bg-base')],
      ['accent on bgBase', c('--accent'), c('--bg-base')],
      ['bgBase on accent', c('--bg-base'), c('--accent')],
      ['bgBase on error', c('--bg-base'), c('--error')],
      ['warning on bgBase', c('--warning'), c('--bg-base')],
      ['error on bgBase', c('--error'), c('--bg-base')],
      ['success on bgBase', c('--success'), c('--bg-base')],
      ['textPrimary on bgSurface', c('--text-primary'), c('--bg-surface')],
      ['textSecondary on bgSurface', c('--text-secondary'), c('--bg-surface')],
      ['textPrimary on bgElevated', c('--text-primary'), c('--bg-elevated')],
      ['textSecondary on bgElevated', c('--text-secondary'), c('--bg-elevated')],
      ['textPrimary on bgOverlay', c('--text-primary'), c('--bg-overlay')],
      ['textPrimary on bgSidebar', c('--text-primary'), c('--bg-sidebar')],
      ['textPrimary on errorBg over bgElevated', c('--text-primary'), over(c('--error-bg'), c('--bg-elevated'))],
      ['error on errorBg over bgElevated', c('--error'), over(c('--error-bg'), c('--bg-elevated'))],
      ['warning on warningBg over bgBase', c('--warning'), over(c('--warning-bg'), c('--bg-base'))],
      ['textPrimary on infoBg over bgBase', c('--text-primary'), over(c('--info-bg'), c('--bg-base'))],
      ['textPrimary on accentSurface over bgBase', c('--text-primary'), over(c('--accent-surface'), c('--bg-base'))],
      ['textPrimary on successBg over bgSurface', c('--text-primary'), over(c('--success-bg'), c('--bg-surface'))],
    ];
    for (const [label, fg, bg] of pairs) {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 4.5, `${label}: ${ratio.toFixed(2)}:1 is below 4.5:1`);
    }
    // textMuted is not readable text (§11.1): it is under 4.5:1 on bgBase,
    // which is why no Text may wear it.
    assert.ok(contrast(c('--text-muted'), c('--bg-base')) < 4.5);
  });

  it('no Text in the app uses textMuted except where marked // disabled', () => {
    for (const file of kotlinFiles(KOTLIN_DIR)) {
      const base = path.basename(file);
      if (base === 'Tokens.kt' || base === 'Theme.kt') continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Code only: a comment may name textMuted.
        const code = /^\s*\*/.test(line) ? '' : line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
        if (/\btextMuted\b/.test(code) && !/\/\/\s*disabled\b/.test(line)) {
          assert.fail(`${base}:${i + 1} uses textMuted without // disabled`);
        }
      });
    }
  });

  it('the theme is dark only', () => {
    const theme = fs.readFileSync(THEME_KT, 'utf8');
    for (const word of ['lightColorScheme', 'dynamicDarkColorScheme', 'dynamicLightColorScheme', 'isSystemInDarkTheme']) {
      assert.ok(!theme.includes(word), `Theme.kt does not contain ${word}`);
    }
    assert.match(theme, /fun\s+KingLouieTheme\s*\(\s*content\s*:/, 'KingLouieTheme takes only its content');
    assert.ok(!fs.existsSync(path.join(APP_MAIN, 'res', 'values-night')), 'res/values-night/ does not exist');
    const themes = fs.readFileSync(path.join(APP_MAIN, 'res', 'values', 'themes.xml'), 'utf8');
    const m = themes.match(/<color\s+name="kl_window">\s*(#[0-9A-Fa-f]{8})\s*<\/color>/);
    assert.ok(m, 'themes.xml defines kl_window');
    assert.equal(m[1].toUpperCase(), '#' + cssValue(css.get('--bg-base')).argb, 'kl_window is #FF plus --bg-base');
    assert.match(themes, /parent="android:Theme\.Material\.NoActionBar"/, 'the window theme is the dark Material one');
  });

  it('no Kotlin file but Tokens.kt writes a Color(0x...) literal', () => {
    // QrScanner.kt and the QR image may keep black and white; today they use
    // android.graphics.Color's constants, not literals.
    const allowed = new Set(['Tokens.kt', 'QrScanner.kt']);
    for (const file of kotlinFiles(path.join(APP_MAIN, 'kotlin'))) {
      const base = path.basename(file);
      if (allowed.has(base)) continue;
      const code = stripKotlinComments(fs.readFileSync(file, 'utf8'));
      const m = code.match(/\bColor\(\s*0x[0-9a-fA-F]+/);
      assert.ok(!m, `${base} writes a colour literal (${m && m[0]}); take it from KlTokens`);
    }
  });
});
