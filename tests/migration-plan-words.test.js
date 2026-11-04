// tests/migration-plan-words.test.js — what a plan says on a personal node, and
// that a value already there plans as already there (attach stage 2 §6.5). A fleet
// import's own words stay as they were.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { checkPath } = require('../src/desktop-bridge/check-path');
const { DesktopImporter, buildImportTargets, EXCLUDED } = require('../src/migration/desktop-import');
const { createSafeReader, readDesktopSource, planBatches } = require('../src/migration/desktop-source');
const { DEFAULT_SETTINGS, mergeSettings } = require('../src/core/settings');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const dirs = [];
const cores = [];
const savedRoot = process.env.KL_CASES_ROOT;
after(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  closeOpenHistoryStores();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (savedRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedRoot;
});
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-planwords-'))); dirs.push(d); return d; };

async function nodeService({ hosting = 'personal' } = {}) {
  const dataDir = tmp();
  process.env.KL_CASES_ROOT = path.join(dataDir, 'cases');
  const cipher = createAesGcmCipher(crypto.randomBytes(32));
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher,
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
  });
  cores.push(core);
  await core.start();
  const importer = new DesktopImporter({
    context: core.context,
    targets: await buildImportTargets({ context: core.context, dataDir }),
    dataDir,
    checkPath,
    cipher,
    scope: createDesktopScope({ dataDir, context: core.context }),
    hosting
  });
  return { core, importer };
}

function profile(chatData) {
  const userDataDir = tmp();
  fs.writeFileSync(path.join(userDataDir, 'chat-data.json'), JSON.stringify(chatData));
  return readDesktopSource({ userDataDir, reader: createSafeReader({ root: userDataDir }), decrypt: (s) => s });
}
const planOf = (importer, inventory) => importer.plan({ installId: 'install-0001', inventory: { installId: 'install-0001', secrets: 'included', ...inventory } });
const itemOf = (plan, category, key) => plan.items.find((i) => i.category === category && i.key === key);

describe('settings that stay behind are named', () => {
  const STAYING = ['playbooks', 'executors', 'contactPolicy', 'contact'];

  it('each has a line of its own on a personal node, saying what it is', async () => {
    const { importer } = await nodeService();
    const plan = await planOf(importer, { settingsKeys: STAYING });
    const lines = STAYING.map((key) => itemOf(plan, 'settings', key));
    for (const item of lines) assert.strictEqual(item.action, 'skip-excluded', item.key);
    assert.strictEqual(new Set(lines.map((i) => i.note)).size, 4, 'no two read the same, so none is deduped away');
    assert.match(itemOf(plan, 'settings', 'playbooks').note, /^Playbook/);
    assert.match(itemOf(plan, 'settings', 'executors').note, /external agents/i);
    assert.match(itemOf(plan, 'settings', 'contactPolicy').note, /Settings > Contact/);
    assert.match(itemOf(plan, 'settings', 'contact').note, /service\.json/);
    for (const item of lines) assert.doesNotMatch(item.note, /managed on the service/);
  });

  it('a setting no table knows is still named', async () => {
    const { importer } = await nodeService();
    assert.match(itemOf(await planOf(importer, { settingsKeys: ['someOddKey'] }), 'settings', 'someOddKey').note, /someOddKey/);
  });

  it('a fleet import says what it always said', async () => {
    const { importer } = await nodeService({ hosting: 'service' });
    const plan = await planOf(importer, { settingsKeys: STAYING });
    for (const key of STAYING) assert.strictEqual(itemOf(plan, 'settings', key).note, 'this setting is managed on the service');
  });
});
