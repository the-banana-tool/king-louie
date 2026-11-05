// `king-louie-service features set <name> on|off [--data-dir DIR]` (R-RW-20).
// Rewrites one key of `features` in <configDir>/service.json and keeps every other.
// The service reads that file once at start, so it refuses while the node runs.
const fs = require('fs');
const path = require('path');
const { adminConfigDir } = require('../../platform/paths');
const { DEFAULT_FEATURES } = require('../config');
const { stopFirstText } = require('./stop');
const { writeKeepingOwnership } = require('./desktop');

const USAGE = `Usage: king-louie-service features set <name> on|off [--data-dir DIR]\nFeatures: ${Object.keys(DEFAULT_FEATURES).join(', ')}\n`;
const VALUES = { on: true, off: false };

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The file as an object, {} when there is none yet (a personal node may have none),
// or null when what is there cannot be kept.
function readServiceFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed) && (parsed.features === undefined || isPlainObject(parsed.features))) return parsed;
  } catch {
    // Said below, for this and the wrong shape alike.
  }
  return null;
}

async function runFeaturesCommand({ sub, arg, arg2, dataDir, io, deps = {} }) {
  if (sub !== 'set' || !Object.hasOwn(DEFAULT_FEATURES, String(arg)) || !Object.hasOwn(VALUES, String(arg2))) {
    if (sub === 'set' && arg !== undefined && !Object.hasOwn(DEFAULT_FEATURES, String(arg))) io.stderr.write(`Unknown feature "${arg}".\n`);
    io.stderr.write(USAGE);
    return 2;
  }
  const pid = deps.runningServicePid ? deps.runningServicePid(dataDir) : require('./io').runningServicePid(dataDir);
  if (pid) {
    io.stderr.write(`${stopFirstText(pid, dataDir)}\n`);
    return 1;
  }
  const file = path.join(deps.configDir || adminConfigDir({ dataDir }), 'service.json');
  const service = readServiceFile(file);
  if (service === null) {
    io.stderr.write(`${file} is not a service.json this command can keep: fix it by hand. Nothing was written.\n`);
    return 1;
  }
  const value = VALUES[arg2];
  // Past here the service would refuse to start (config.js).
  if (value && arg === 'remoteWindow' && service.profile !== undefined && service.profile !== 'agent') {
    io.stderr.write('remoteWindow needs profile: agent. Nothing was written.\n');
    return 1;
  }
  if (value && arg === 'desktopBridge' && service.profile === 'runbook') {
    io.stderr.write('desktopBridge needs profile: agent. Nothing was written.\n');
    return 1;
  }
  const features = service.features || {};
  const was = Object.hasOwn(features, arg) ? features[arg] : DEFAULT_FEATURES[arg];
  if (Object.hasOwn(features, arg) && was === value) {
    io.stdout.write(`features.${arg} is already ${value}.\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeKeepingOwnership(file, `${JSON.stringify({ ...service, features: { ...features, [arg]: value } }, null, 2)}\n`);
  io.stdout.write(`features.${arg}: ${was} -> ${value}\n`);
  io.stdout.write('Start the service for this to take effect.\n');
  return 0;
}

module.exports = { runFeaturesCommand };
