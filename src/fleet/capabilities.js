// What a node says it can do (tasks spec §4.2): its declared list from
// node.yaml, then what is detected, as plain strings in fleet.hello,
// describe_machine and list_machines. The runbook profile loads this file, so
// it requires nothing that profile may not load; the agent's probes require
// theirs when asked.
const fs = require('fs');

const MAX_CAPABILITIES = 32; // the router keeps this many, of at most this length (cleanHello)
const MAX_LENGTH = 64;
const LOGINS_PROFILE = 'king-louie';
const OS_NAMES = Object.freeze({ win32: 'windows', darwin: 'macos', linux: 'linux' });

// A value, or a probe for one. A probe that throws found nothing.
function read(value) {
  try {
    return typeof value === 'function' ? value() : value;
  } catch {
    return null;
  }
}

function detectCapabilities({ nodeConfig = {}, hosting = nodeConfig.hosting, gui = null, profileDirs = null, localModelServers = null,
  chromiumRunnable = null, platform = process.platform } = {}) {
  const helperUp = Boolean(gui) && gui.available === true;
  const profiles = read(profileDirs);
  const servers = read(localModelServers);
  const declared = Array.isArray(nodeConfig.capabilities) ? nodeConfig.capabilities : [];
  const detected = [
    helperUp && 'gui',
    (hosting === 'personal' || helperUp) && 'interactive',
    Array.isArray(profiles) && profiles.includes(LOGINS_PROFILE) && 'browser:logins',
    read(chromiumRunnable) === true && 'browser:headless',
    nodeConfig.profile === 'agent' && 'shell',
    Array.isArray(servers) && servers.some((s) => s && s.usable === true) && 'local-models',
    Object.hasOwn(OS_NAMES, platform) && `os:${OS_NAMES[platform]}`
  ].filter(Boolean);
  const fit = (c) => typeof c === 'string' && c.length > 0 && c.length <= MAX_LENGTH;
  return [...new Set([...declared.filter(fit), ...detected])].slice(0, MAX_CAPABILITIES);
}

// The real probes of an agent node, read each time but for Chromium's, whose
// answer does not change while the node runs. Nothing here starts a browser.
function agentCapabilityProbes({ core, dataDir, hosting }) {
  let chromium = null;
  return {
    hosting,
    profileDirs: () => {
      // eslint-disable-next-line global-require -- agent profile only (src/browser/ is off the runbook graph)
      const { profilesRoot } = require('../browser/profile-dirs');
      return fs.readdirSync(profilesRoot({ userDataPath: dataDir }));
    },
    localModelServers: () => core.context.getLocalServers().list(),
    chromiumRunnable: () => {
      if (chromium === null) {
        // eslint-disable-next-line global-require -- agent profile only
        chromium = require('../browser/playwright-browser').chromiumInstalled();
      }
      return chromium;
    }
  };
}

module.exports = { detectCapabilities, agentCapabilityProbes, MAX_CAPABILITIES };
