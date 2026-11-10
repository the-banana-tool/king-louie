// src/gui/personal-screen-host.js
// A personal node started at boot (`run --screen-host app`) runs outside the
// owner's desktop, so it serves its screen work through the King Louie app in
// his session (boot-node-tray spec §5.2, plan D-2). The node listens with the
// kl-session-v1 HelperChannel on an owner-only named pipe and writes the
// pipe's name and a fresh key to <dataDir>/session/personal-helper.json, which
// the app reads before every connect. A new start writes a new pipe and key;
// a stop removes the file. Electron-free.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensurePrivateDir } = require('../platform/paths');

const PERSONAL_HELPER_FILE = 'session/personal-helper.json';
const MAX_FILE_BYTES = 4096;
const FILE_KEYS = Object.freeze(['endpoint', 'node_id', 'secret', 'user', 'v']);
const KEY_HEX_RE = /^[0-9a-f]{64}$/;
const PIPE_RE = /^\\\\\.\\pipe\\king-louie-personal-[0-9a-f]{16}$/;

const helperFilePath = (dataDir) => path.join(dataDir, ...PERSONAL_HELPER_FILE.split('/'));
const pipeName = (hex) => `\\\\.\\pipe\\king-louie-personal-${hex}`;

class PersonalHelperFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersonalHelperFileError';
    this.code = 'PERSONAL_HELPER_FILE_INVALID';
  }
}

// Writes the file 0o600 (a temp file in the same private directory, then a
// rename), and returns what HelperChannel's readSecret answers with.
function writePersonalHelperFile({ dataDir, nodeId, user, randomBytes = crypto.randomBytes }) {
  if (typeof nodeId !== 'string' || !nodeId) throw new TypeError('writePersonalHelperFile needs a nodeId');
  if (typeof user !== 'string' || !user) throw new TypeError('writePersonalHelperFile needs a user');
  const file = helperFilePath(dataDir);
  ensurePrivateDir(path.dirname(file));
  const key = Buffer.from(randomBytes(32));
  if (key.length !== 32) throw new Error('randomBytes gave the wrong length');
  const endpoint = pipeName(Buffer.from(randomBytes(8)).toString('hex'));
  const text = `${JSON.stringify({ v: 1, endpoint, secret: key.toString('hex'), node_id: nodeId, user })}\n`;
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { endpoint, secret: key, nodeId, sessionUser: user, mtimeMs: fs.statSync(file).mtimeMs };
}

// The app's reader (and the tests'): a regular file, not a link, at most
// 4096 bytes, holding exactly the five keys. Throws PersonalHelperFileError
// (or ENOENT's own error when the file is not there) and never quotes the
// file's contents.
function readPersonalHelperFile({ dataDir }) {
  const file = helperFilePath(dataDir);
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) throw new PersonalHelperFileError(`${file} is a link`);
  if (!st.isFile()) throw new PersonalHelperFileError(`${file} is not a regular file`);
  if (st.size > MAX_FILE_BYTES) throw new PersonalHelperFileError(`${file} is larger than ${MAX_FILE_BYTES} bytes`);
  const raw = fs.readFileSync(file);
  if (raw.length > MAX_FILE_BYTES) throw new PersonalHelperFileError(`${file} is larger than ${MAX_FILE_BYTES} bytes`);
  let record;
  try {
    record = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PersonalHelperFileError(`${file} is not JSON`);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new PersonalHelperFileError(`${file} is not an object`);
  const keys = Object.keys(record).sort();
  if (keys.length !== FILE_KEYS.length || keys.some((k, i) => k !== FILE_KEYS[i])) throw new PersonalHelperFileError(`${file} does not hold exactly ${FILE_KEYS.join(', ')}`);
  if (record.v !== 1) throw new PersonalHelperFileError(`${file} has an unknown version`);
  if (typeof record.endpoint !== 'string' || !PIPE_RE.test(record.endpoint)) throw new PersonalHelperFileError(`${file} names no King Louie pipe`);
  if (typeof record.secret !== 'string' || !KEY_HEX_RE.test(record.secret)) throw new PersonalHelperFileError(`${file} holds no valid key`);
  if (typeof record.node_id !== 'string' || !record.node_id || record.node_id.length > 256) throw new PersonalHelperFileError(`${file} holds no node id`);
  if (typeof record.user !== 'string' || !record.user || record.user.length > 256) throw new PersonalHelperFileError(`${file} holds no user`);
  return { endpoint: record.endpoint, secret: Buffer.from(record.secret, 'hex'), nodeId: record.node_id, sessionUser: record.user, mtimeMs: st.mtimeMs };
}

// Removes the file; one already gone is fine.
function removePersonalHelperFile({ dataDir }) {
  fs.rmSync(helperFilePath(dataDir), { force: true });
}

module.exports = {
  PERSONAL_HELPER_FILE, PersonalHelperFileError,
  helperFilePath, writePersonalHelperFile, readPersonalHelperFile, removePersonalHelperFile
};
