// src/gui/keys.js
// The Key tool's grammar (fleet stage 5 spec §3.8): `mod(+mod)*+key` or
// `key`, with shell-level and clipboard shortcuts denied. There is no
// clipboard op anywhere in the helper protocol either.
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
  if (platform === 'darwin') {
    if (has(mods, 'meta') && key === 'space') return 'meta+space opens Spotlight';
    if (has(mods, 'meta') && key === 'tab') return 'meta+tab switches apps';
    if (has(mods, 'meta', 'alt') && key === 'escape') return 'meta+alt+escape opens Force Quit';
    if (has(mods, 'ctrl', 'meta') && key === 'q') return 'ctrl+meta+q locks the screen';
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

module.exports = { parseKeys, printableChar, isEnter, checkButton, checkClickModifiers, MODIFIERS };
