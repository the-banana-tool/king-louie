// src/session/backends/index.js
// Which OS backend the session helper uses (fleet stage 5 spec §3.3).
// Linux: Wayland first, so XWayland's DISPLAY never selects X11.
const fs = require('fs');
const { execFileSync } = require('child_process');

function defaultXdpyinfoOk(env) {
  if (!fs.existsSync('/usr/bin/xdpyinfo')) return false;
  try {
    execFileSync('/usr/bin/xdpyinfo', [], { stdio: 'ignore', env, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function selectBackend({ platform = process.platform, env = process.env, xdpyinfoOk = defaultXdpyinfoOk } = {}) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform !== 'linux') return null;
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) return 'wayland';
  if (env.DISPLAY && xdpyinfoOk(env)) return 'x11';
  return null;
}

function loadBackend(name, { env = process.env, log } = {}) {
  switch (name) {
    case 'windows': return require('./windows').createWindowsBackend({ env, log });
    case 'macos': return require('./macos').createMacosBackend({ env, log });
    case 'x11': return require('./x11').createX11Backend({ env, log });
    case 'wayland': return require('./wayland').createWaylandBackend({ env, log });
    default: return null;
  }
}

function NO_BACKEND_REPORT(reason) {
  return { capabilities: [], probes: [{ check: 'desktop', ok: false, hint: reason }], displays: [], limits: [], locked: false };
}

module.exports = { selectBackend, loadBackend, NO_BACKEND_REPORT };
