// src/session/backends/linux-common.js
// Shared pieces of the Linux backends (fleet stage 5 spec §3.3).
const fs = require('fs');
const { spawn } = require('child_process');
const { imageMatches } = require('../../gui/apps');
const { GuiError } = require('../../gui/errors');

function listProcesses({ match, readdir = fs.readdirSync, readlink = fs.readlinkSync }) {
  const out = [];
  for (const name of readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let image;
    try {
      image = readlink(`/proc/${name}/exe`);
    } catch {
      continue;
    }
    if (imageMatches(image, match, 'linux')) out.push({ pid: Number(name), image });
  }
  return out;
}

async function launchDetached({ exe, argv = [], files = [], spawnImpl = spawn }) {
  const child = spawnImpl(exe, [...argv, ...files], { detached: true, stdio: 'ignore', shell: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (err) => reject(new GuiError('file_not_found', err.message)));
  });
  child.unref();
  return { pid: child.pid };
}

// Width and height from a JPEG's first SOFn segment.
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const XDOTOOL_KEYS = Object.freeze({
  enter: 'Return', tab: 'Tab', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  space: 'space', '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash',
  ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'period', '/': 'slash', '`': 'grave'
});
const XDOTOOL_MODS = Object.freeze({ ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super' });

function keysym(key) {
  if (XDOTOOL_KEYS[key]) return XDOTOOL_KEYS[key];
  if (/^f\d+$/.test(key)) return key.toUpperCase();
  return key;
}

module.exports = { listProcesses, launchDetached, jpegSize, XDOTOOL_KEYS, XDOTOOL_MODS, keysym };
