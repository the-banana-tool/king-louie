// src/gui/config.js
// node.yaml `gui:` (fleet stage 5 spec §4.4). Read only from the admin config
// dir by loadNodeConfig; a present but malformed key throws with its path,
// as everywhere else in node.yaml. Dependency-free (the runbook and
// front-door profiles load it through node-config.js).
const path = require('path');

const APP_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LOOKALIKE = /[\u0000\u2215\u2216\uFF0F\uFF3C]/;
const GUI_KEYS = Object.freeze({
  top: Object.freeze(['enabled', 'apps', 'screenshot', 'live_view', 'lease']),
  app: Object.freeze(['name', 'path', 'processes', 'args']),
  screenshot: Object.freeze(['max_width', 'quality']),
  live_view: Object.freeze(['interval_s', 'max_width', 'quality', 'max_frame_bytes']),
  lease: Object.freeze(['default_minutes', 'max_minutes', 'yield_ms', 'max_inputs_per_minute'])
});
// [min, max, default, camelCase name] per key.
const RANGES = Object.freeze({
  screenshot: { max_width: [320, 1920, 1280, 'maxWidth'], quality: [30, 90, 70, 'quality'] },
  live_view: {
    interval_s: [1, 5, 3, 'intervalS'], max_width: [320, 1280, 960, 'maxWidth'],
    quality: [30, 85, 60, 'quality'], max_frame_bytes: [32768, 184320, 184320, 'maxFrameBytes']
  },
  lease: {
    default_minutes: [1, 60, 15, 'defaultMinutes'], max_minutes: [1, 60, 60, 'maxMinutes'],
    yield_ms: [0, 10000, 2000, 'yieldMs'], max_inputs_per_minute: [10, 600, 120, 'maxInputsPerMinute']
  }
});
const SECTION_NAMES = { screenshot: 'screenshot', live_view: 'liveView', lease: 'lease' };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function defaultsFor(section) {
  const out = {};
  for (const [, [, , def, name]] of Object.entries(RANGES[section])) out[name] = def;
  return out;
}

const GUI_DEFAULTS = Object.freeze({
  screenshot: Object.freeze(defaultsFor('screenshot')),
  liveView: Object.freeze(defaultsFor('live_view')),
  lease: Object.freeze(defaultsFor('lease'))
});

function disabled() {
  return {
    enabled: false,
    apps: {},
    screenshot: { ...GUI_DEFAULTS.screenshot },
    liveView: { ...GUI_DEFAULTS.liveView },
    lease: { ...GUI_DEFAULTS.lease },
    warnings: []
  };
}

function parseGuiConfig(raw, { profile = 'agent', platform = process.platform, file = 'node.yaml' } = {}) {
  const invalid = (what) => new Error(`Invalid ${file}: ${what}`);
  const unknownKey = (keyPath, known) => new Error(`Invalid ${file}: unknown key "${keyPath}" (known: ${known.join(', ')})`);
  const checkKeys = (obj, known, prefix) => {
    for (const key of Object.keys(obj)) if (!known.includes(key)) throw unknownKey(`${prefix}${key}`, known);
  };

  // Neither profile runs a session helper (§3.4, Deviation 9).
  if (profile !== 'agent') return disabled();
  // Off until enabled (owner ruling R-F5-14, 2026-10-13): computer use
  // starts only when node.yaml says "gui: enabled: true". No block, an empty
  // block and a block that only lists apps all mean off; installing the
  // session helper enables nothing.
  const out = disabled();
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) throw invalid('gui must be a mapping');
  checkKeys(raw, GUI_KEYS.top, 'gui.');

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw invalid('gui.enabled must be true or false');
    out.enabled = raw.enabled === true;
  }

  for (const section of ['screenshot', 'live_view', 'lease']) {
    const value = raw[section];
    if (value === undefined) continue;
    if (!isPlainObject(value)) throw invalid(`gui.${section} must be a mapping`);
    checkKeys(value, GUI_KEYS[section], `gui.${section}.`);
    const target = out[SECTION_NAMES[section]];
    for (const [key, [min, max, , name]] of Object.entries(RANGES[section])) {
      if (value[key] === undefined) continue;
      if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) {
        throw invalid(`gui.${section}.${key} must be an integer from ${min} to ${max}`);
      }
      target[name] = value[key];
    }
  }
  if (out.lease.defaultMinutes > out.lease.maxMinutes) {
    throw invalid('gui.lease.default_minutes must not exceed gui.lease.max_minutes');
  }

  if (raw.apps !== undefined) {
    if (!isPlainObject(raw.apps)) throw invalid('gui.apps must be a mapping');
    for (const [id, value] of Object.entries(raw.apps)) {
      if (!APP_ID_RE.test(id)) throw invalid(`gui.apps.${id}: an app id must match ${APP_ID_RE}`);
      out.apps[id] = parseApp(id, value, { platform, invalid, checkKeys, warnings: out.warnings });
    }
  }
  return out;
}

function checkPath(value, where, platform, invalid, { exeOnly }) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${where} must be a non-empty string`);
  if (LOOKALIKE.test(value)) throw invalid(`${where} contains a null byte or a slash lookalike`);
  const absolute = platform === 'win32' ? /^[A-Za-z]:\\/.test(value) : value.startsWith('/');
  if (!absolute) throw invalid(`${where} must be an absolute path`);
  if (value.split(/[\\/]/).includes('..')) throw invalid(`${where} must not contain ".."`);
  if (exeOnly && platform === 'win32' && !/\.exe$/i.test(value)) throw invalid(`${where} must name an .exe on Windows`);
  return platform === 'win32' ? path.win32.normalize(value) : path.posix.normalize(value);
}

function stringList(value, where, max, invalid) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) throw invalid(`${where} must be a list of non-empty strings`);
  if (value.length > max) throw invalid(`${where} may have at most ${max} entries`);
  return [...value];
}

function parseApp(id, value, { platform, invalid, checkKeys, warnings }) {
  const where = `gui.apps.${id}`;
  const entry = typeof value === 'string' ? { path: value } : value;
  if (!isPlainObject(entry)) throw invalid(`${where} must be a path or a mapping`);
  checkKeys(entry, GUI_KEYS.app, `${where}.`);
  const appPath = checkPath(entry.path, `${where}.path`, platform, invalid, { exeOnly: true });
  let name = id;
  if (entry.name !== undefined) {
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 64) throw invalid(`${where}.name must be 1–64 characters`);
    name = entry.name.trim();
  }
  const processes = stringList(entry.processes, `${where}.processes`, 16, invalid).map((p) => {
    if (LOOKALIKE.test(p) || p.split(/[\\/]/).includes('..')) throw invalid(`${where}.processes: "${p}" contains "..", a null byte or a slash lookalike`);
    if (!/[\\/]/.test(p)) {
      warnings.push(`${where}.processes: "${p}" is a bare name; any process with that name matches (use an absolute path or glob when you can)`);
      return p;
    }
    return checkPath(p, `${where}.processes`, platform, invalid, { exeOnly: false });
  });
  const args = stringList(entry.args, `${where}.args`, 32, invalid);
  return { id, name, path: appPath, processes, args };
}

// What an administrator adds to node.yaml to turn desktop apps on.
const GUI_ENABLE_LINES = 'gui:\n  enabled: true';

module.exports = { parseGuiConfig, GUI_KEYS, GUI_DEFAULTS, APP_ID_RE, GUI_ENABLE_LINES };
