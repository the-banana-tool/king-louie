// src/session/recorder.js
// Demo takes (spec 2026-10-24 §9): the helper, which runs as the user,
// finds the user's ffmpeg once at startup. The service runs as LOCAL
// SERVICE and cannot see the user's PATH. The answer goes to the service in
// every probe report as `recorder: { ffmpeg: <absolute path> | null }`.
const fs = require('fs');
const path = require('path');

const isFileDefault = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

// Walks PATH in order, like Windows would, for `ffmpeg.exe`. No shell, no
// `where`. A relative PATH entry (the current directory, say) is skipped,
// and so is `.exe` when PATHEXT leaves it out. Windows only in D1.
function findFfmpeg({ platform = process.platform, env = process.env, isFile = isFileDefault } = {}) {
  if (platform !== 'win32') return null;
  const pathVar = env.PATH || env.Path || '';
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase());
  if (!exts.includes('.exe')) return null;
  for (const raw of String(pathVar).split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!/^[A-Za-z]:[\\/]/.test(dir) && !/^\\\\[^\\]/.test(dir)) continue;
    const candidate = path.win32.join(dir, 'ffmpeg.exe');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

module.exports = { findFfmpeg };
