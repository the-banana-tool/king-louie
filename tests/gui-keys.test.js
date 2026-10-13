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
  it('denies ctrl+f2 through ctrl+f8 on darwin, with extra modifiers too, and not on Windows', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      assert.equal(code(() => parseKeys(`ctrl+f${n}`, 'darwin')), 'key_denied', `ctrl+f${n}`);
      assert.equal(code(() => parseKeys(`ctrl+shift+f${n}`, 'darwin')), 'key_denied', `ctrl+shift+f${n}`);
      assert.equal(code(() => parseKeys(`ctrl+f${n}`, 'win32')), null);
      // (Linux denies ctrl+F1 to F12 for a reason of its own: workspaces; second review finding 6.)
      assert.equal(code(() => parseKeys(`f${n}`, 'darwin')), null, 'the bare function key is the app\'s');
    }
    assert.equal(code(() => parseKeys('ctrl+f1', 'darwin')), null);
    assert.equal(code(() => parseKeys('ctrl+f9', 'darwin')), null);
    assert.equal(code(() => parseKeys('ctrl+f20', 'darwin')), null);
  });
});

// Second security review, finding 6: chords the grammar still allowed that
// leave the leased app: a launcher, a run prompt, another workspace, a
// log-out, another app in front.
describe('second review finding 6: chords that leave the leased app', () => {
  const denied = (k, p) => assert.equal(code(() => parseKeys(k, p)), 'key_denied', `${k} on ${p}`);
  const allowed = (k, p) => assert.equal(code(() => parseKeys(k, p)), null, `${k} on ${p}`);

  it('Linux: the launcher, the run prompt and the app finder (alt+F1, alt+F2, alt+F3, alt+space), with extra modifiers too', () => {
    for (const k of ['alt+f1', 'alt+f2', 'alt+f3', 'alt+space', 'shift+alt+f2', 'alt+shift+f1', 'shift+alt+space']) denied(k, 'linux');
    // The same keys are the app's on Windows and macOS (alt+space is the window's own menu on Windows).
    for (const k of ['alt+f1', 'alt+f2', 'alt+f3', 'alt+space']) { allowed(k, 'win32'); allowed(k, 'darwin'); }
    // Window operations on the leased window itself stay.
    for (const k of ['alt+f4', 'alt+f7', 'alt+f8', 'alt+f10', 'f2', 'f1', 'shift+f10', 'alt+f']) allowed(k, 'linux');
  });

  it('Linux: workspace keys (ctrl+F1 to F12, alt+insert, alt+delete)', () => {
    for (let n = 1; n <= 12; n += 1) { denied(`ctrl+f${n}`, 'linux'); denied(`ctrl+shift+f${n}`, 'linux'); }
    denied('alt+insert', 'linux');
    denied('alt+delete', 'linux');
    allowed('ctrl+f13', 'linux');
    for (const k of ['f5', 'shift+f5', 'insert', 'delete', 'ctrl+delete']) allowed(k, 'linux');
    for (const k of ['ctrl+f4', 'ctrl+f5', 'alt+insert', 'alt+delete']) allowed(k, 'win32');
  });

  it('macOS: log out (meta+shift+Q, and with alt), lock (meta+ctrl+Q), hide (meta+H), Show Desktop (F11), Desktop N (ctrl+digit)', () => {
    for (const k of ['meta+shift+q', 'meta+alt+shift+q', 'shift+meta+q', 'meta+ctrl+q', 'ctrl+meta+q', 'ctrl+shift+meta+q']) denied(k, 'darwin');
    for (const k of ['meta+h', 'meta+alt+h', 'f11', 'shift+f11', 'meta+f11', 'ctrl+1', 'ctrl+9', 'ctrl+0', 'ctrl+shift+2']) denied(k, 'darwin');
    // What is the app's own stays: quit and close, minimize, the other function keys.
    for (const k of ['meta+q', 'meta+w', 'meta+m', 'meta+shift+h', 'meta+`', 'f10', 'f12', 'meta+1', '1', 'h', 'q', 'shift+q']) allowed(k, 'darwin');
    // And none of it is denied where it means something else.
    for (const k of ['f11', 'ctrl+h', 'ctrl+1', 'ctrl+shift+q']) { allowed(k, 'win32'); allowed(k, 'linux'); }
  });

  it('every modifier-and-key pair that leaves the app on some desktop is denied there, by one table', () => {
    const { LEAVES_THE_APP } = require('../src/gui/keys');
    assert.deepEqual(Object.keys(LEAVES_THE_APP).sort(), ['darwin', 'linux', 'win32']);
    for (const [platform, chords] of Object.entries(LEAVES_THE_APP)) {
      assert.ok(chords.length > 0, platform);
      for (const chord of chords) denied(chord, platform);
    }
    // What was denied before is in the table too, so the list is in one place.
    for (const k of ['alt+tab', 'ctrl+alt+delete', 'ctrl+shift+escape', 'ctrl+escape', 'alt+escape']) {
      for (const p of ['win32', 'linux', 'darwin']) assert.ok(LEAVES_THE_APP[p].includes(k), `${k} for ${p}`);
    }
    for (const k of ['meta+space', 'meta+tab', 'meta+alt+escape', 'ctrl+up', 'ctrl+f2', 'meta+shift+3']) assert.ok(LEAVES_THE_APP.darwin.includes(k), k);
    assert.ok(LEAVES_THE_APP.win32.includes('meta+r') && LEAVES_THE_APP.linux.includes('meta+l'));
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
