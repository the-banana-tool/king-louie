// Plain-Node implementations of the ports createCore() needs.
const { JsonFileStore } = require('../platform/json-file-store');
const { ensureServicePaths } = require('../platform/paths');
const { resolveMasterKey, verifyKeyCheck } = require('../platform/master-key');
const { createAesGcmCipher } = require('../platform/cipher');
const { createHeadlessPrompter } = require('../platform/prompter');

// `onPathWritten` receives every path these ports create or write inside the
// data dir, including later store writes. The admin CLI collects them so it
// can hand exactly those back to the data dir's owner when it runs as root
// (src/service/ownership.js); everything else ignores it.
//
// `masterKey` is for the admin import's writer child (Task 9 fix round 2,
// N1): the root parent resolved the key read-only and handed it over. The
// child then never resolves, creates or writes a key; it only checks the
// key against the existing key-check, before it creates anything, and
// refuses on a missing or mismatched one.
function buildServicePorts({ dataDir, chatDataDefaults = {}, onPathWritten = null, masterKey = null }) {
  const record = onPathWritten || (() => {});
  let key;
  let source;
  if (masterKey) {
    key = masterKey;
    source = 'admin-cli';
    verifyKeyCheck({ dataDir, key, source, create: false });
  }
  const paths = ensureServicePaths(dataDir, { onPath: record });
  if (!masterKey) ({ key, source } = resolveMasterKey({ dataDir: paths.dataDir, onPath: record }));
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
