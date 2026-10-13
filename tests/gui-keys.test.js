// tests/gui-keys.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseKeys, printableChar, isEnter, checkButton, checkClickModifiers } = require('../src/gui/keys');

const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

describe('parseKeys', () => {
  it('reads keys and modifier combinations, case-insensitively', () => {
    assert.deepEqual(parseKeys('enter', 'win32'), { mods: [], key: 'enter' });
    assert.deepEqual(parseKeys('Shift+Ctrl+S', 'win32'), { mods: ['ctrl', 'shift'], key: 's' });
    assert.deepEqual(parseKeys('f24', 'linux'), { mods: [], key: 'f24' });
    assert.deepEqual(parseKeys('ctrl+/', 'linux'), { mods: ['ctrl'], key: '/' });
    assert.deepEqual(parseKeys('meta+s', 'darwin'), { mods: ['meta'], key: 's' });
  });

  it('refuses what is not in the grammar as key_invalid', () => {
    for (const k of ['', 'hyper+a', 'ctrl+', '+a', 'f25', 'ctrl+ctrl+a', 'printscreen', 'a'.repeat(65), 'ctrl++']) {
      assert.equal(code(() => parseKeys(k, 'win32')), 'key_invalid', k);
    }
  });

  it('denies shell-level shortcuts everywhere', () => {
    for (const k of ['alt+tab', 'shift+alt+tab', 'ctrl+alt+delete', 'ctrl+alt+t', 'ctrl+shift+escape', 'ctrl+escape', 'alt+escape']) {
      for (const p of ['win32', 'darwin', 'linux']) assert.equal(code(() => parseKeys(k, p)), 'key_denied', `${k} on ${p}`);
    }
  });

  it('denies every clipboard chord, with extra modifiers too', () => {
    for (const k of ['ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+shift+v', 'shift+insert', 'ctrl+insert', 'shift+delete', 'alt+ctrl+shift+c']) {
      assert.equal(code(() => parseKeys(k, 'win32')), 'key_denied', k);
    }
    for (const k of ['meta+c', 'meta+v', 'meta+x', 'meta+shift+v']) assert.equal(code(() => parseKeys(k, 'darwin')), 'key_denied', k);
  });

  it('denies meta on Windows and Linux, and the macOS system chords', () => {
    assert.equal(code(() => parseKeys('meta+r', 'win32')), 'key_denied');
    assert.equal(code(() => parseKeys('meta+l', 'linux')), 'key_denied');
    for (const k of ['meta+space', 'meta+tab', 'meta+alt+escape', 'ctrl+meta+q', 'ctrl+up', 'ctrl+right', 'meta+shift+3', 'meta+shift+4', 'meta+shift+5']) {
      assert.equal(code(() => parseKeys(k, 'darwin')), 'key_denied', k);
    }
    assert.deepEqual(parseKeys('ctrl+up', 'win32'), { mods: ['ctrl'], key: 'up' }, 'ctrl+up is macOS-only');
  });
});

// Security review finding 7: on macOS ctrl+F2..F8 move the keyboard focus
// out of the app (menu bar, Dock, the window toolbar, the next window, the
// floating window, the status menus).
describe('macOS keyboard routes that leave the app', () => {
  it('denies ctrl+f2 through ctrl+f8 on darwin, with extra modifiers too, and nowhere else', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      assert.equal(code(() => parseKeys(`ctrl+f${n}`, 'darwin')), 'key_denied', `ctrl+f${n}`);
      assert.equal(code(() => parseKeys(`ctrl+shift+f${n}`, 'darwin')), 'key_denied', `ctrl+shift+f${n}`);
      assert.equal(code(() => parseKeys(`ctrl+f${n}`, 'win32')), null);
      assert.equal(code(() => parseKeys(`ctrl+f${n}`, 'linux')), null);
      assert.equal(code(() => parseKeys(`f${n}`, 'darwin')), null, 'the bare function key is the app\'s');
    }
    assert.equal(code(() => parseKeys('ctrl+f1', 'darwin')), null);
    assert.equal(code(() => parseKeys('ctrl+f9', 'darwin')), null);
    assert.equal(code(() => parseKeys('ctrl+f20', 'darwin')), null);
  });
});

describe('printableChar and isEnter', () => {
  it('knows which presses type a character', () => {
    assert.equal(printableChar(parseKeys('a', 'linux')), 'a');
    assert.equal(printableChar(parseKeys('shift+a', 'linux')), 'A');
    assert.equal(printableChar(parseKeys('shift+1', 'linux')), '!');
    assert.equal(printableChar(parseKeys('space', 'linux')), ' ');
    assert.equal(printableChar(parseKeys('ctrl+a', 'linux')), null);
    assert.equal(printableChar(parseKeys('enter', 'linux')), null);
    assert.equal(isEnter(parseKeys('shift+enter', 'linux')), true);
  });
});

// Security review finding 13a: a click's modifiers go through the key
// grammar's deny list too.
describe('checkClickModifiers', () => {
  it('denies meta on Windows and Linux and ctrl+alt everywhere, as for a key', () => {
    for (const platform of ['win32', 'linux']) {
      assert.equal(code(() => checkClickModifiers(['meta'], platform)), 'key_denied', platform);
      assert.equal(code(() => checkClickModifiers(['shift', 'meta'], platform)), 'key_denied', platform);
    }
    for (const platform of ['win32', 'linux', 'darwin']) {
      assert.equal(code(() => checkClickModifiers(['ctrl', 'alt'], platform)), 'key_denied', platform);
      assert.equal(code(() => checkClickModifiers(['ctrl'], platform)), null, platform);
      assert.equal(code(() => checkClickModifiers(['shift'], platform)), null, platform);
      assert.equal(code(() => checkClickModifiers(['ctrl', 'shift'], platform)), null, platform);
      assert.equal(code(() => checkClickModifiers([], platform)), null, platform);
    }
    assert.equal(code(() => checkClickModifiers(['meta'], 'darwin')), null, 'a command-click is ordinary on macOS');
  });

  it('refuses what is not a modifier, and a repeated one', () => {
    assert.equal(code(() => checkClickModifiers(['hyper'], 'win32')), 'key_invalid');
    assert.equal(code(() => checkClickModifiers(['ctrl', 'ctrl'], 'win32')), 'key_invalid');
    assert.equal(code(() => checkClickModifiers('ctrl', 'win32')), 'key_invalid');
  });
});

describe('checkButton', () => {
  it('refuses a middle click on Linux only', () => {
    assert.equal(code(() => checkButton('middle', 'linux')), 'middle_click_denied');
    assert.equal(code(() => checkButton('middle', 'win32')), null);
    assert.equal(code(() => checkButton('left', 'linux')), null);
  });
});
