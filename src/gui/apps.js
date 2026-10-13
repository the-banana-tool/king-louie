// src/gui/apps.js
// The app allowlist (fleet stage 5 spec §3.4): what LaunchApp may start and
// at what tier, and which process images count as "the leased app" in the
// foreground. Shared with the helper (assertPathsUnchanged at spawn).
const fs = require('fs');
const path = require('path');
const { patternMatch } = require('../execution/tool-patterns');
const { realResolve, isPathUnderRoots } = require('../platform/path-roots');
const { GuiError } = require('./errors');

const LOOKALIKE = /[\u0000\u2215\u2216\uFF0F\uFF3C]/;
const MAX_APP = 1024;
const MAX_ITEM = 4096;

const pathImpl = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const caseInsensitive = (platform) => platform === 'win32' || platform === 'darwin';
const hasDotDot = (p) => String(p).split(/[\\/]/).includes('..');

function isAbsoluteFor(p, platform) {
  return platform === 'win32' ? /^[A-Za-z]:\\/.test(p) : p.startsWith('/');
}

function stringArray(value, max, where) {
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== 'string' || v.length > MAX_ITEM)) {
    throw new GuiError('invalid_params', `"${where}" must be at most ${max} strings of at most ${MAX_ITEM} characters`);
  }
  return value;
}

function resolveLaunch(guiConfig, policy, request = {}, { platform = process.platform, statSync = fs.statSync, realpath = realResolve } = {}) {
  const { app, args = [], files = [] } = request;
  if (typeof app !== 'string' || app.length < 1 || app.length > MAX_APP) throw new GuiError('invalid_params', '"app" must be 1–1024 characters');
  stringArray(args, 32, 'args');
  stringArray(files, 16, 'files');
  for (const v of [app, ...args, ...files]) {
    if (LOOKALIKE.test(v)) throw new GuiError('invalid_params', 'null bytes and slash lookalikes are not allowed');
  }

  const resolvedFiles = files.map((f) => {
    if (!isAbsoluteFor(f, platform) || hasDotDot(f)) throw new GuiError('invalid_params', `a file must be an absolute path without "..": ${f}`);
    try {
      statSync(f);
    } catch {
      throw new GuiError('file_not_found', f);
    }
    return realpath(f);
  });

  const entry = Object.hasOwn(guiConfig.apps, app) ? guiConfig.apps[app] : null;
  if (entry) {
    try {
      statSync(entry.path);
    } catch {
      throw new GuiError('file_not_found', entry.path);
    }
    const exe = realpath(entry.path);
    const argsOk = args.every((a) => entry.args.some((glob) => patternMatch(glob, a)));
    const roots = (policy && policy.allowed_roots) || [];
    const filesOk = resolvedFiles.every((f) => isPathUnderRoots(f, roots));
    let reason = 'allowlisted';
    if (!argsOk) reason = 'args_not_allowlisted';
    else if (!filesOk) reason = 'file_outside_allowed_roots';
    return {
      tier: argsOk && filesOk ? 'routine' : 'unsafe',
      reason,
      appId: entry.id,
      exe,
      argv: [...args],
      match: [exe, ...entry.processes],
      files: resolvedFiles
    };
  }

  // Not an app id in gui.apps. Owner ruling R-F5-14 (2026-10-13): only an
  // allowlisted app can be launched. A path outside the allowlist used to
  // resolve as an unsafe launch for the phone to approve; it is now refused
  // outright and nobody is asked. (An allowlisted app with an argument
  // outside its globs, or a file outside allowed_roots, is still unsafe and
  // still goes to the phone, above.) A relative path or one with ".." keeps
  // its own error: it was never a launchable name.
  if (!isAbsoluteFor(app, platform) || hasDotDot(app)) {
    throw new GuiError('invalid_params', '"app" must be an allowlisted app id (an absolute path is no longer accepted)');
  }
  throw new GuiError('app_not_allowlisted', 'only an app listed under gui.apps in node.yaml can be launched; call ListApps for the ids');
}

// `*` and `?` only; everything else literal. Anchored.
function globRegex(pattern) {
  const source = String(pattern).split('').map((ch) => {
    if (ch === '*') return '.*';
    if (ch === '?') return '.';
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${source}$`);
}

function imageMatches(image, patterns, platform = process.platform) {
  if (typeof image !== 'string' || image === '') return false;
  const impl = pathImpl(platform);
  const norm = (s) => (caseInsensitive(platform) ? String(s).toLowerCase() : String(s));
  const img = norm(image);
  for (const raw of patterns || []) {
    const p = norm(raw);
    const bare = !/[\\/]/.test(p);
    const target = bare ? norm(impl.basename(image)) : img;
    if (globRegex(p).test(target)) return true;
    if (platform === 'darwin' && /\.app$/.test(p) && !/[*?]/.test(p) && img.startsWith(`${p}/`)) return true;
  }
  return false;
}

function matchSetFor(guiConfig, appIds, { realpath = realResolve } = {}) {
  const out = [];
  for (const id of appIds) {
    const app = guiConfig.apps[id];
    if (!app) continue;
    let real = app.path;
    try {
      real = realpath(app.path);
    } catch {
      real = app.path;
    }
    for (const p of [real, ...app.processes]) if (!out.includes(p)) out.push(p);
  }
  return out;
}

function assertPathsUnchanged({ exe, files = [] }, { realpath = fs.realpathSync.native, platform = process.platform } = {}) {
  const same = (a, b) => (caseInsensitive(platform) ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const p of [exe, ...files]) {
    let now;
    try {
      now = realpath(p);
    } catch {
      throw new GuiError('path_changed', `${p} no longer exists`);
    }
    if (!same(now, p)) throw new GuiError('path_changed', `${p} now resolves to ${now}`);
  }
}

module.exports = { resolveLaunch, imageMatches, matchSetFor, assertPathsUnchanged, globRegex };
