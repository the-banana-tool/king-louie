// src/gui/keys.js
// The Key tool's grammar (fleet stage 5 spec §3.8): `mod(+mod)*+key` or
// `key`, with shell-level and clipboard shortcuts denied. There is no
// clipboard op anywhere in the helper protocol either.
//
// What is denied because it leaves the leased app (deniedReason, and the
// LEAVES_THE_APP table the tests walk; second security review, finding 6):
//   everywhere  alt+tab, alt+escape, ctrl+escape, ctrl+shift+escape, every
//               ctrl+alt chord (ctrl+alt+delete, the Linux terminal, lock,
//               log-out, workspace and console chords among them)
//   Windows     every chord with the Windows key
//   Linux       every chord with Super; alt+F1 (launcher), alt+F2 (run
//               prompt), alt+F3 (Xfce's app finder), alt+space (KDE's run
//               prompt), ctrl+F1 to F12 (workspaces on Xfce and KDE; also
//               KDE's desktop grid and show-desktop), alt+insert and
//               alt+delete (Xfce adds and removes a workspace)
//   macOS       meta+space (Spotlight; with alt, Finder's search), meta+tab,
//               meta+alt+escape (Force Quit), meta+shift+Q (log out; with
//               alt, at once), ctrl+meta+Q (lock), meta+H and meta+alt+H
//               (hide), ctrl+arrow and ctrl+digit (Mission Control, Spaces),
//               ctrl+F2 to F8 (keyboard focus out of the app), F11 (Show
//               Desktop), meta+shift+3/4/5 (screenshots)
// What remains, known and not denied: keys that close, quit or minimize the
// leased app or its window (alt+F4, meta+Q, meta+W, meta+M, alt+space then
// N on Windows, the window keys alt+F4 to F12 on Linux); F1 and other keys
// with which an app opens another app itself (help in a browser); the
// macOS input-source and emoji chords (ctrl+space, ctrl+meta+space) and
// meta+alt+D (the Dock); a global shortcut the user or an installed program
// added (a drop-down terminal on F12, say); a tiling window manager set up
// with alt as its own modifier (every alt chord is then its command); and
// modifier-only chords, which the grammar cannot express. Whenever a key
// does move the focus off the leased apps, the check after the input sees
// it and the lease is suspended.
const { GuiError } = require('./errors');

const MODIFIERS = Object.freeze(['ctrl', 'alt', 'shift', 'meta']);
const NAMED = Object.freeze(['enter', 'tab', 'escape', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'space']);
const PUNCT = Object.freeze(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);
const ARROWS = ['up', 'down', 'left', 'right'];
// US layout: what shift makes of a digit or punctuation key (only the typed
// buffer uses it, to see characters spelled one press at a time).
const SHIFTED = Object.freeze({
  1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~'
});

function isKeyName(k) {
  return /^[a-z0-9]$/.test(k) || /^f([1-9]|1[0-9]|2[0-4])$/.test(k) || NAMED.includes(k) || PUNCT.includes(k);
}

const has = (mods, ...wanted) => wanted.every((m) => mods.includes(m));
const only = (mods, ...wanted) => mods.length === wanted.length && has(mods, ...wanted);
const FUNCTION_1_TO_12 = /^f([1-9]|1[0-2])$/;

function deniedReason({ mods, key }, platform) {
  if (has(mods, 'alt') && key === 'tab') return 'alt+tab switches apps';
  if (has(mods, 'ctrl', 'alt')) return 'ctrl+alt shortcuts belong to the system';
  if (has(mods, 'ctrl', 'shift') && key === 'escape') return 'ctrl+shift+escape opens the task manager';
  if (has(mods, 'ctrl') && key === 'escape') return 'ctrl+escape opens the start menu';
  if (has(mods, 'alt') && key === 'escape') return 'alt+escape switches windows';
  if ((has(mods, 'ctrl') || has(mods, 'meta')) && ['c', 'v', 'x'].includes(key)) return 'clipboard shortcuts are not allowed';
  if ((has(mods, 'shift') || has(mods, 'ctrl')) && key === 'insert') return 'clipboard shortcuts are not allowed';
  if (has(mods, 'shift') && key === 'delete') return 'clipboard shortcuts are not allowed';
  if (platform !== 'darwin' && has(mods, 'meta')) return 'the Windows/Super key is not allowed';
  if (platform === 'linux') {
    // Second review finding 6. These are the desktop's, not the app's, on
    // GNOME, KDE, Xfce, MATE or Cinnamon.
    if (has(mods, 'alt') && key === 'f1') return 'alt+F1 opens the desktop\'s launcher';
    if (has(mods, 'alt') && key === 'f2') return 'alt+F2 opens the run prompt';
    if (has(mods, 'alt') && key === 'f3') return 'alt+F3 opens the application finder';
    if (has(mods, 'alt') && key === 'space') return 'alt+space opens the run prompt on KDE';
    if (has(mods, 'ctrl') && FUNCTION_1_TO_12.test(key)) return 'ctrl+F1 to F12 switch workspaces';
    if (has(mods, 'alt') && (key === 'insert' || key === 'delete')) return 'alt+insert and alt+delete add and remove a workspace';
  }
  if (platform === 'darwin') {
    if (has(mods, 'meta') && key === 'space') return 'meta+space opens Spotlight';
    if (has(mods, 'meta') && key === 'tab') return 'meta+tab switches apps';
    if (has(mods, 'meta', 'alt') && key === 'escape') return 'meta+alt+escape opens Force Quit';
    if (has(mods, 'ctrl', 'meta') && key === 'q') return 'ctrl+meta+q locks the screen';
    // Second review finding 6.
    if (has(mods, 'meta', 'shift') && key === 'q') return 'meta+shift+q logs out';
    if ((only(mods, 'meta') || only(mods, 'alt', 'meta')) && key === 'h') return 'meta+h hides the app';
    if (key === 'f11') return 'F11 shows the desktop';
    if (has(mods, 'ctrl') && /^[0-9]$/.test(key)) return 'ctrl+digit switches to another desktop';
    if (has(mods, 'ctrl') && ARROWS.includes(key)) return 'ctrl+arrow switches Spaces';
    // Keyboard navigation that leaves the app: the menu bar (F2), the Dock
    // (F3), the next window of any app (F4), the toolbar (F5), a floating
    // window (F6), the focus mode (F7) and the status menus (F8).
    if (has(mods, 'ctrl') && /^f[2-8]$/.test(key)) return 'ctrl+F2 to F8 move the keyboard focus out of the app';
    if (has(mods, 'meta', 'shift') && ['3', '4', '5'].includes(key)) return 'meta+shift+3/4/5 take screenshots';
  }
  return null;
}

function parseKeys(keys, platform = process.platform) {
  if (typeof keys !== 'string' || keys.length < 1 || keys.length > 64) throw new GuiError('key_invalid', 'keys must be 1–64 characters');
  const parts = keys.toLowerCase().split('+');
  // The reasons never repeat what was passed (R-F5-16): a string that is not
  // a key name is whatever the model wrote there, and a tool's error text is
  // audited (exec.result) and so reaches the relay's mirror.
  if (parts.some((p) => p === '')) throw new GuiError('key_invalid', 'keys must be mod+key or one key name');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!isKeyName(key)) throw new GuiError('key_invalid', 'unknown key name (a letter, a digit, f1 to f24, a named key such as enter, or a punctuation key)');
  for (const m of mods) if (!MODIFIERS.includes(m)) throw new GuiError('key_invalid', `unknown modifier (use ${MODIFIERS.join(', ')})`);
  if (new Set(mods).size !== mods.length) throw new GuiError('key_invalid', 'a modifier is repeated');
  const combo = { mods: MODIFIERS.filter((m) => mods.includes(m)), key };
  const denied = deniedReason(combo, platform);
  if (denied) throw new GuiError('key_denied', denied);
  return combo;
}

function printableChar({ mods, key }) {
  if (mods.some((m) => m !== 'shift')) return null;
  const shift = mods.includes('shift');
  if (key === 'space') return ' ';
  if (/^[a-z]$/.test(key)) return shift ? key.toUpperCase() : key;
  if (/^[0-9]$/.test(key) || PUNCT.includes(key)) return shift ? SHIFTED[key] : key;
  return null;
}

const isEnter = (combo) => combo.key === 'enter';

// A click's modifiers (security review finding 13a): the same names and the
// same deny list as a key's. Only the rules that turn on the modifiers alone
// can apply (the Windows/Super key, ctrl+alt); the rest name a key.
function checkClickModifiers(mods, platform = process.platform) {
  if (!Array.isArray(mods)) throw new GuiError('key_invalid', 'modifiers must be a list');
  for (const m of mods) if (!MODIFIERS.includes(m)) throw new GuiError('key_invalid', `unknown modifier "${m}"`);
  if (new Set(mods).size !== mods.length) throw new GuiError('key_invalid', 'a modifier is repeated');
  const ordered = MODIFIERS.filter((m) => mods.includes(m));
  const denied = deniedReason({ mods: ordered, key: 'click' }, platform);
  if (denied) throw new GuiError('key_denied', denied);
  return ordered;
}

function checkButton(button, platform = process.platform) {
  // X11 pastes the primary selection on a middle click (§3.8).
  if (button === 'middle' && platform === 'linux') throw new GuiError('middle_click_denied', 'a middle click pastes the primary selection on Linux');
}

// Chords that leave the leased app, per platform: every one is refused by
// parseKeys there (tests/gui-keys.test.js walks the table). A list for
// people and for that test; deniedReason is the rule.
const LEAVES_EVERYWHERE = ['alt+tab', 'shift+alt+tab', 'alt+escape', 'ctrl+escape', 'ctrl+shift+escape', 'ctrl+alt+delete', 'ctrl+alt+tab'];
const LEAVES_THE_APP = Object.freeze({
  win32: Object.freeze([...LEAVES_EVERYWHERE, 'meta+r', 'meta+l', 'meta+d', 'meta+e', 'meta+tab', 'meta+x', 'meta+s', 'ctrl+meta+d']),
  linux: Object.freeze([
    ...LEAVES_EVERYWHERE, 'meta+l', 'meta+a', 'meta+d', 'meta+tab', 'ctrl+alt+t', 'ctrl+alt+l', 'ctrl+alt+f1', 'ctrl+alt+left', 'ctrl+alt+backspace',
    'alt+f1', 'alt+f2', 'alt+f3', 'alt+space', 'alt+insert', 'alt+delete',
    'ctrl+f1', 'ctrl+f2', 'ctrl+f3', 'ctrl+f4', 'ctrl+f5', 'ctrl+f6', 'ctrl+f7', 'ctrl+f8', 'ctrl+f9', 'ctrl+f10', 'ctrl+f11', 'ctrl+f12'
  ]),
  darwin: Object.freeze([
    ...LEAVES_EVERYWHERE, 'meta+space', 'meta+alt+space', 'meta+tab', 'meta+shift+tab', 'meta+alt+escape', 'meta+shift+q', 'meta+alt+shift+q',
    'ctrl+meta+q', 'meta+h', 'meta+alt+h', 'ctrl+up', 'ctrl+down', 'ctrl+left', 'ctrl+right', 'ctrl+1', 'ctrl+2', 'ctrl+9',
    'ctrl+f2', 'ctrl+f3', 'ctrl+f4', 'ctrl+f5', 'ctrl+f6', 'ctrl+f7', 'ctrl+f8', 'f11', 'meta+shift+3', 'meta+shift+4', 'meta+shift+5'
  ])
});

module.exports = { parseKeys, printableChar, isEnter, checkButton, checkClickModifiers, MODIFIERS, LEAVES_THE_APP };
