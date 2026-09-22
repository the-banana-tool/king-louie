// Plain-Node implementations of the ports createCore() needs.
const { JsonFileStore } = require('../platform/json-file-store');
const { ensureServicePaths } = require('../platform/paths');
const { resolveMasterKey } = require('../platform/master-key');
const { createAesGcmCipher } = require('../platform/cipher');
const { createHeadlessPrompter } = require('../platform/prompter');

function buildServicePorts({ dataDir, chatDataDefaults = {} }) {
  const paths = ensureServicePaths(dataDir);
  const { key, source } = resolveMasterKey({ dataDir: paths.dataDir });
  return {
    paths,
    store: new JsonFileStore({ dir: paths.dataDir, name: 'chat-data', defaults: chatDataDefaults }),
    vaultStore: new JsonFileStore({ dir: paths.dataDir, name: 'config' }),
    cipher: createAesGcmCipher(key),
    prompter: createHeadlessPrompter(),
    masterKeySource: source
  };
}

module.exports = { buildServicePorts };
