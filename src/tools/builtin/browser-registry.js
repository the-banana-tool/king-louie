// The browsers the browser tools drive, one per run. A run's key is its take
// policy's `browserKey` (`take:<take_id>`, set when a take runs), else
// `default`. Only setBrowser gives a key a browser of its own; a key with
// none registered resolves to the default browser, so the owner's chat and
// every run without a take share it, as they shared the old singleton.

const PlaywrightBrowser = require('../../browser/playwright-browser');

const DEFAULT_KEY = 'default';

const registry = { default: null, byKey: new Map() };
// Name of the profile backing each key's running browser, if any.
const activeProfiles = new Map();

function browserKeyOf(context) {
  const key = context && context.takePolicy && context.takePolicy.current
    && context.takePolicy.current.browserKey;
  return key || DEFAULT_KEY;
}

// The key whose browser a run drives: its own key when a browser is
// registered under it, else the default.
function resolvedKeyOf(context) {
  const key = browserKeyOf(context);
  return key !== DEFAULT_KEY && registry.byKey.has(key) ? key : DEFAULT_KEY;
}

function getBrowser(context) {
  const key = resolvedKeyOf(context);
  if (key !== DEFAULT_KEY) return registry.byKey.get(key);
  if (!registry.default) registry.default = new PlaywrightBrowser();
  return registry.default;
}

function setBrowser(key, browser) {
  if (key === DEFAULT_KEY) registry.default = browser;
  else registry.byKey.set(key, browser);
}

function removeBrowser(key) {
  if (key === DEFAULT_KEY) registry.default = null;
  else registry.byKey.delete(key);
  activeProfiles.delete(key);
}

function activeProfileOf(key) {
  return activeProfiles.has(key) ? activeProfiles.get(key) : null;
}

function setActiveProfile(key, name) {
  if (name == null) activeProfiles.delete(key);
  else activeProfiles.set(key, name);
}

// Every browser in the registry (the default first), for cleanup.
function allBrowsers() {
  const list = [];
  if (registry.default) list.push(registry.default);
  for (const b of registry.byKey.values()) list.push(b);
  return list;
}

// For tests: forget every browser and profile (stops nothing).
function reset() {
  registry.default = null;
  registry.byKey.clear();
  activeProfiles.clear();
}

module.exports = {
  DEFAULT_KEY,
  registry,
  browserKeyOf,
  resolvedKeyOf,
  getBrowser,
  setBrowser,
  removeBrowser,
  activeProfileOf,
  setActiveProfile,
  allBrowsers,
  reset,
};
