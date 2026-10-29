'use strict';

// Where a named browser profile lives: <userDataPath>/browser-profiles/<name>. One definition for
// the browser tools (the context's userDataPath) and a personal node's take (the node's data dir),
// so the take's profile-in-use check and the tools speak of the same directory.

const path = require('path');

function validProfileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

function profilesRoot(context) {
  if (!context || !context.userDataPath) {
    throw new Error('Profile actions require userDataPath in tool context (are you running inside Electron?).');
  }
  return path.join(context.userDataPath, 'browser-profiles');
}

function resolveProfileDir(context, name) {
  if (!validProfileName(name)) {
    throw new Error(`Invalid profile name "${name}". Use 1–64 chars of [A-Za-z0-9_-].`);
  }
  return path.join(profilesRoot(context), name);
}

module.exports = { validProfileName, profilesRoot, resolveProfileDir };
