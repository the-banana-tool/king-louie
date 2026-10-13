// src/ipc/import-picks.js
// The file an import reads is chosen in a dialog the main process opens
// (owner ruling R-H4-3). The renderer is told a token and the file's base
// name; it never names a path, and no import channel opens one it sent.
// The tokens live here, in the main process, for one host: the standalone
// handlers and the attached host each build one.
const crypto = require('crypto');
const path = require('path');

const MAX_PICKS = 8;
const PICK_TTL_MS = 15 * 60 * 1000;
const NO_FILE = Object.freeze({ ok: false, error: 'Choose the file again.', code: 'IMPORT_NO_FILE' });

// pickFile() → the chosen path, or null when the dialog was cancelled.
function createImportPicks({ pickFile, now = Date.now } = {}) {
  const picks = new Map(); // token → { path, at }, oldest first

  const expire = () => {
    const cutoff = now() - PICK_TTL_MS;
    for (const [token, entry] of picks) if (entry.at < cutoff) picks.delete(token);
  };

  return {
    async pick() {
      const picked = typeof pickFile === 'function' ? await pickFile() : null;
      if (typeof picked !== 'string' || !picked) return { ok: false, canceled: true };
      expire();
      while (picks.size >= MAX_PICKS) picks.delete(picks.keys().next().value);
      const token = crypto.randomBytes(16).toString('hex');
      picks.set(token, { path: picked, at: now() });
      // The base name is the file's own: untrusted text for the renderer.
      return { ok: true, untrustedText: true, token, name: path.basename(picked) };
    },
    pathFor(token) {
      expire();
      const entry = typeof token === 'string' && token ? picks.get(token) : null;
      return entry ? entry.path : null;
    },
    spend(token) {
      if (typeof token === 'string') picks.delete(token);
    }
  };
}

// What a renderer's preview or commit call may say: the token and, for a
// Markdown transcript, the heading pattern. Every other key is ignored.
function importRequest(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return {
    token: typeof p.token === 'string' ? p.token : '',
    pattern: typeof p.pattern === 'string' && p.pattern ? p.pattern : undefined
  };
}

// Only a file's own name is recorded with an import that arrived parsed:
// never a directory, no control characters, at most 255 characters.
function sourceBaseName(name) {
  if (typeof name !== 'string') return null;
  const base = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim().slice(0, 255);
  return base && base !== '.' && base !== '..' ? base : null;
}

module.exports = { createImportPicks, importRequest, sourceBaseName, NO_FILE, MAX_PICKS, PICK_TTL_MS };
