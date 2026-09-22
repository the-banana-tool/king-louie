const fs = require('fs');
const path = require('path');

const PROFILES = new Set(['agent', 'runbook']);
const DEFAULT_FEATURES = { gateway: false, webhooks: false, mesh: false, channels: true, appDiscovery: false };

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
  return {
    profile,
    features: { ...DEFAULT_FEATURES, ...(fileCfg.features || {}), ...(overrides.features || {}) }
  };
}

module.exports = { loadServiceConfig, PROFILES };
