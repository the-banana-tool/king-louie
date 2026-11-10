'use strict';
// Settings redesign, style foundations (spec
// docs/superpowers/specs/2026-11-09-settings-redesign-design.md §5.8): one
// button set, the classes later tasks draw with, no `data:` URI in the CSS
// (CSP), and no CSS variable used that nothing declares.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

const css = stripComments(read('styles.css'));
const html = read('index.html');

// Every selector list in the stylesheet, at top level or inside an @media.
function selectorLists(text) {
  const lists = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(text))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    lists.push(sel.split(',').map((s) => s.trim().replace(/\s+/g, ' ')));
  }
  return lists;
}

const lists = selectorLists(css);
const allSelectors = new Set(lists.flat());

describe('settings style foundations', () => {
  it('has no data: URI in styles.css', () => {
    assert.ok(!css.includes('data:'), 'styles.css must not hold a data: URI (CSP)');
  });

  it('defines .btn-sm exactly once', () => {
    const own = lists.filter((l) => l.length === 1 && l[0] === '.btn-sm');
    assert.equal(own.length, 1, `.btn-sm rules: ${own.length}`);
  });

  for (const sel of [
    '.switch',
    '.settings-sidebar',
    '.settings-nav-item.is-active',
    '.settings-where.tone-unreachable',
    '.status-pill.is-failing',
    '.settings-modal [hidden]',
  ]) {
    it(`defines ${sel}`, () => {
      assert.ok(allSelectors.has(sel), `missing selector ${sel}`);
    });
  }

  it('banner tones: amber standalone (spec §5.2), development apart from it and from grey', () => {
    const rule = (sel) => {
      const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`));
      assert.ok(m, `rule ${sel}`);
      return m[1].replace(/\s+/g, ' ').trim();
    };
    const desktop = rule('.settings-where.tone-desktop');
    const dev = rule('.settings-where.tone-dev');
    const grey = rule('.settings-where.tone-unreachable');
    assert.match(desktop, /color: var\(--warning\)/);
    assert.notEqual(dev, desktop);
    assert.notEqual(dev, grey);
  });

  it('uses only declared CSS variables, or gives a fallback', () => {
    const declared = new Set();
    for (const m of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) declared.add(m[1]);
    const undeclared = new Set();
    for (const text of [css, html]) {
      for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)) {
        if (m[2] === ',') continue;
        if (!declared.has(m[1])) undeclared.add(m[1]);
      }
    }
    assert.deepEqual([...undeclared].sort(), []);
  });
});
