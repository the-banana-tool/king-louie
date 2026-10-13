// tests/gui-keys.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseKeys, printableChar, isEnter, checkButton } = require('../src/gui/keys');

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

describe('checkButton', () => {
  it('refuses a middle click on Linux only', () => {
    assert.equal(code(() => checkButton('middle', 'linux')), 'middle_click_denied');
    assert.equal(code(() => checkButton('middle', 'win32')), null);
    assert.equal(code(() => checkButton('left', 'linux')), null);
  });
});
