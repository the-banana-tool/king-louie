// src/gui/screen-host-browser.js
// A personal node started at boot (`run --screen-host app`, boot-node-tray
// plan Task 6) runs as an S4U task outside the owner's desktop: Chrome there
// cannot unlock the owner's cookie encryption, so a saved profile must never
// be opened by this process. Every persistent PlaywrightBrowser#start goes
// through this launcher instead (browser-registry's setScreenHostLauncher):
// King Louie in the owner's session runs the gui.browser Chrome on the profile
// (the session-v1 launch_browser op, the same one a fleet take uses) and the
// node attaches over CDP. Before the app connects, a saved profile is refused.
const path = require('path');
const { GuiError } = require('./errors');
const { NO_BROWSER_REMEDY } = require('./config');
const { CHROME_FLAGS } = require('../browser/chrome-flags');
const { validProfileName } = require('../browser/profile-dirs');

const SCREEN_HOST_MISSING = 'Saved logins are available after you log in';

const folded = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

// profilesRoot: <dataDir>/browser-profiles, the directory resolveProfileDir
// gives the browser tools on this node (ctx.userDataPath is the data dir).
function createScreenHostLauncher({ broker, guiConfig, profilesRoot }) {
  if (!broker || !broker.channel) throw new Error('a screen host launcher needs the GUI broker');
  if (typeof profilesRoot !== 'string' || !profilesRoot) throw new Error('a screen host launcher needs the profiles root');
  return {
    async launch({ userDataPath, headless = false } = {}) {
      // Only a profile the screen host would open under the same name: a directory directly
      // under the profiles root (the app puts the profile at <its root>/<name>).
      const profile = typeof userDataPath === 'string' && userDataPath ? path.basename(userDataPath) : null;
      if (!profile || !validProfileName(profile) || folded(path.dirname(userDataPath)) !== folded(profilesRoot)) {
        throw new GuiError('invalid_params', `on this node a saved browser profile lives under ${profilesRoot}; pass "profile" instead of "userDataPath"`);
      }
      const cfg = guiConfig || {};
      const app = cfg.browser && cfg.apps && Object.hasOwn(cfg.apps, cfg.browser) ? cfg.apps[cfg.browser] : null;
      if (!app || !app.path) throw new GuiError('invalid_params', `no browser in node.yaml (gui.browser): ${NO_BROWSER_REMEDY}`);
      if (!broker.channel.connected) throw new GuiError('screen_host_missing', SCREEN_HOST_MISSING);
      const launched = await broker.launchBrowser({ exe: app.path, profile, args: [...CHROME_FLAGS, ...(headless ? ['--headless=new'] : [])] }, {});
      const port = launched && launched.cdp && launched.cdp.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GuiError('browser_launch_failed', 'the screen host gave no debugging port');
      return { cdpUrl: `http://127.0.0.1:${port}`, pid: Number.isInteger(launched.pid) ? launched.pid : null };
    }
  };
}

// `--screen-host app` with desktop apps off (gui not enabled, or a GUI that could not be set
// up): no app can ever serve the screen, and this process still opens no saved profile.
function refusingScreenHostLauncher() {
  return {
    async launch() {
      throw new GuiError('screen_host_missing', `${SCREEN_HOST_MISSING} with King Louie in your session, and desktop apps are on in node.yaml (gui: enabled: true)`);
    }
  };
}

module.exports = { createScreenHostLauncher, refusingScreenHostLauncher, SCREEN_HOST_MISSING };
