const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('service/config');

const PROFILES = new Set(['agent', 'runbook']);
// Chat channels are off by default: in stage 1 the service denies every
// remote approval, and stage 3 brings the phone approver that makes channels
// useful for unsafe work.
const DEFAULT_FEATURES = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false };
// Distinct from the Electron app's 18789/18790, so both hosts can run on one
// machine without fighting over the ports.
const DEFAULT_PORTS = { gateway: 18791, webhook: 18792 };

function validatePorts(ports, file) {
  if (ports === undefined) return {};
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) {
    throw new Error(`Invalid ${file}: "ports" must be an object`);
  }
  const out = {};
  for (const [name, value] of Object.entries(ports)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, name)) {
      throw new Error(`Invalid ${file}: ports.${name} is not a known port (expected ${Object.keys(DEFAULT_PORTS).join(', ')})`);
    }
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`Invalid ${file}: ports.${name} must be an integer from 1 to 65535`);
    }
    out[name] = value;
  }
  return out;
}

function loadServiceConfig(dataDir, overrides = {}) {
  let fileCfg = {};
  const file = path.join(dataDir, 'service.json');
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid ${file}: ${err.message}`);
    }
  }
  const profile = overrides.profile || fileCfg.profile || 'agent';
  if (!PROFILES.has(profile)) throw new Error(`Unknown profile "${profile}". Expected one of: ${[...PROFILES].join(', ')}`);
  const features = { ...DEFAULT_FEATURES, ...(fileCfg.features || {}), ...(overrides.features || {}) };
  // service.json is writable by the service account itself, and mesh binds a
  // non-loopback listener, so it cannot be turned on from there in stage 1.
  if (features.mesh) {
    log.warn('features.mesh is not supported in service mode yet; ignoring it and keeping mesh off');
    features.mesh = false;
  }
  return {
    profile,
    features,
    ports: { ...DEFAULT_PORTS, ...validatePorts(fileCfg.ports, file) }
  };
}

module.exports = { loadServiceConfig, PROFILES, DEFAULT_PORTS };
