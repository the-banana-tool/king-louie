// src/ipc/import-picks.js
// The file an import reads is chosen in a dialog the main process opens
// (owner ruling R-H4-3). The renderer is told a token and the file's base
// name; it never names a path, and no import channel opens one it sent.
// The tokens live here, in the main process, for one host: the standalone
// handlers and the attached host each build one.
const crypto = require('crypto');
const path = require('path');
const { parseImport, previewImport, MAX_BATCH_MESSAGES, MAX_BATCH_CHARS } = require('../history/import-chats');
const { createLogger } = require('../logging');

const log = createLogger('history-import');

const MAX_PICKS = 8;
const PICK_TTL_MS = 15 * 60 * 1000;
const NO_FILE = Object.freeze({ ok: false, error: 'Choose the file again.', code: 'IMPORT_NO_FILE' });
const UNREADABLE = Object.freeze({ ok: false, error: 'The file could not be read. Choose it again.', code: 'IMPORT_UNREADABLE' });

// Runs a step that opens the picked file. A file-system error (the file was
// moved, deleted or locked since it was picked) carries the path in its
// message, and the renderer is never told the path: the reply is a fixed
// sentence, and the log gets the system's code only. Every other error is
// the importer's or the store's own and is thrown on.
async function readingPickedFile(step) {
  try {
    return await step();
  } catch (err) {
    if (!err || !err.syscall) throw err;
    log.warn(`A picked import file could not be read (${typeof err.code === 'string' ? err.code : 'no code'}).`);
    return { ...UNREADABLE };
  }
}

// The dialog both hosts open. Returns a function that answers the chosen
// path, or null when the dialog was cancelled or the host has no dialog.
function createPickImportFile({ dialog = null, getWindow = () => null, env = process.env } = {}) {
  return async () => {
    // The e2e suite cannot drive a native dialog: under KL_TEST_MODE, and
    // only then, KL_TEST_IMPORT_FILE is the file "picked". Without
    // KL_TEST_MODE the variable is ignored.
    if (env && env.KL_TEST_MODE && typeof env.KL_TEST_IMPORT_FILE === 'string' && env.KL_TEST_IMPORT_FILE) {
      return env.KL_TEST_IMPORT_FILE;
    }
    if (!dialog || typeof dialog.showOpenDialog !== 'function') return null;
    const options = {
      title: 'Import a conversation',
      properties: ['openFile'],
      filters: [{ name: 'Conversations', extensions: ['jsonl', 'json', 'md', 'markdown'] }]
    };
    const win = typeof getWindow === 'function' ? getWindow() : null;
    const live = win && !(typeof win.isDestroyed === 'function' && win.isDestroyed()) ? win : null;
    const result = await (live ? dialog.showOpenDialog(live, options) : dialog.showOpenDialog(options));
    return !result || result.canceled || !result.filePaths || result.filePaths.length === 0 ? null : result.filePaths[0];
  };
}

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

// Attached mode (owner ruling R-H4-3): the desktop opens and parses the
// picked file here, in its own main process, and the service stores what it
// is sent. A batch is at most 200 messages and half the service's size cap
// (import-chats.js), so a sender that keeps to them is never refused for size.
const SEND_BATCH_MESSAGES = 200;
const SEND_BATCH_CHARS = MAX_BATCH_CHARS / 2;
const BUSY = Object.freeze({ ok: false, error: 'Another import is running.', code: 'IMPORT_BUSY' });
const MESSAGE_TOO_LARGE = Object.freeze({
  ok: false, code: 'IMPORT_MESSAGE_TOO_LARGE', error: 'One message of this conversation is too large to send to the service.'
});

// The messages as the batches to send, or null when one message alone is
// more than the service takes in a call. A message over the batch size goes
// in a batch of its own.
function planImportBatches(messages, { maxMessages = SEND_BATCH_MESSAGES, maxChars = SEND_BATCH_CHARS, hardChars = MAX_BATCH_CHARS } = {}) {
  const batches = [];
  let batch = [];
  let chars = 2; // the list's brackets
  for (const message of messages) {
    const size = JSON.stringify(message).length;
    if (size + 2 > hardChars) return null;
    if (batch.length && (batch.length >= maxMessages || chars + size + 1 > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 2;
    }
    batch.push(message);
    chars += size + 1;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// A reply of the service that is not the one a step needs, as this commit's
// own reply: the service's code and sentence when it gave them.
function refusedReply(reply) {
  const r = reply && typeof reply === 'object' ? reply : {};
  return {
    ok: false,
    code: typeof r.code === 'string' && r.code ? r.code : 'IMPORT_FAILED',
    error: typeof r.error === 'string' && r.error ? r.error : 'The local service did not store this conversation.'
  };
}

// invoke(channel, args) → the service's reply (the attached host's
// proxyInvoke: an unreachable or too-old service is a reply, not a throw).
// Nothing is written on the desktop, and the path stays here: the service is
// told the file's base name, its hash and the parsed chat.
function createAttachedImport({ picks, invoke, parse = parseImport, preview = previewImport } = {}) {
  let running = false;

  return {
    async preview(payload) {
      const { token, pattern } = importRequest(payload);
      const filePath = picks.pathFor(token);
      if (!filePath) return { ...NO_FILE };
      const read = await readingPickedFile(() => preview(filePath, { pattern }));
      if (read.ok === false) return read;
      const { sourceHash, importerVersion: _version, ...shown } = read;
      const looked = await invoke('history:import.lookup', [{ sourceHash }]);
      if (!looked || looked.ok !== true) {
        // Not reachable (or too old to say): the owner still sees the file.
        return { ok: true, untrustedText: true, ...shown, existingChatId: null, serviceUnreachable: true };
      }
      const existing = typeof looked.existingChatId === 'string' && looked.existingChatId ? looked.existingChatId : null;
      return { ok: true, untrustedText: true, ...shown, existingChatId: existing };
    },

    async commit(payload) {
      const { token, pattern } = importRequest(payload);
      const filePath = picks.pathFor(token);
      if (!filePath) return { ...NO_FILE };
      if (running) return { ...BUSY };
      running = true;
      try {
        const parsed = await readingPickedFile(() => parse(filePath, { pattern }));
        if (parsed.ok === false) return parsed;
        const { kind, messages } = parsed;
        if (!Array.isArray(messages) || !messages.length) {
          return { ok: false, code: 'IMPORT_INVALID', error: 'This file has no messages to import.' };
        }
        const batches = planImportBatches(messages);
        if (!batches) return { ...MESSAGE_TOO_LARGE };

        const begun = await invoke('history:import.begin', [{
          kind,
          importerVersion: parsed.importerVersion,
          sourceHash: parsed.sourceHash,
          sourceName: sourceBaseName(path.basename(filePath)),
          chat: parsed.chat,
          total: messages.length
        }]);
        if (!begun || begun.ok !== true) return refusedReply(begun);
        if (typeof begun.existingChatId === 'string' && begun.existingChatId) {
          picks.spend(token);
          return { ok: true, chatId: begun.existingChatId, imported: false, kind };
        }
        const { importId } = begun;
        if (typeof importId !== 'string' || !importId) return refusedReply(null);

        // A call that fails ends the commit. The service removes the half
        // chat itself: at once for a refused batch; for a connection that
        // went away, when it sees it go, at the next begin of this file, or
        // after 30 minutes without a call.
        for (const batch of batches) {
          const appended = await invoke('history:import.append', [{ importId, messages: batch }]);
          if (!appended || appended.ok !== true) return refusedReply(appended);
        }
        const finished = await invoke('history:import.finish', [{ importId }]);
        if (!finished || finished.ok !== true || typeof finished.chatId !== 'string') return refusedReply(finished);
        picks.spend(token);
        return { ok: true, chatId: finished.chatId, imported: true, messages: finished.messages, kind };
      } finally {
        running = false;
      }
    }
  };
}

module.exports = {
  createImportPicks, createPickImportFile, createAttachedImport, planImportBatches,
  importRequest, sourceBaseName, readingPickedFile, NO_FILE, UNREADABLE, MAX_PICKS, PICK_TTL_MS, SEND_BATCH_MESSAGES, SEND_BATCH_CHARS
};
