// Plain-Node implementations of the ports createCore() needs.
const { JsonFileStore } = require('../platform/json-file-store');
const { ensureServicePaths } = require('../platform/paths');
const { resolveMasterKey } = require('../platform/master-key');
const { createAesGcmCipher } = require('../platform/cipher');
const { createHeadlessPrompter } = require('../platform/prompter');

// `onPathWritten` receives every path these ports create or write inside the
// data dir, including later store writes. The admin CLI collects them so it
// can hand exactly those back to the data dir's owner when it runs as root
// (src/service/ownership.js); everything else ignores it.
function buildServicePorts({ dataDir, chatDataDefaults = {}, onPathWritten = null }) {
  const record = onPathWritten || (() => {});
  const paths = ensureServicePaths(dataDir, { onPath: record });
  const { key, source } = resolveMasterKey({ dataDir: paths.dataDir, onPath: record });
  return {
    paths,
    store: new JsonFileStore({ dir: paths.dataDir, name: 'chat-data', defaults: chatDataDefaults, onWrite: record }),
    vaultStore: new JsonFileStore({ dir: paths.dataDir, name: 'config', onWrite: record }),
    cipher: createAesGcmCipher(key),
    prompter: createHeadlessPrompter(),
    masterKeySource: source
  };
}

module.exports = { buildServicePorts };
