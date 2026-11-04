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
  return readDesktopSource({ userDataDir, reader: createSafeReader({ root: userDataDir }), decrypt: (s) => s, hosting: 'personal' });
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

describe('a value already there plans as already there', () => {
  const defaults = mergeSettings(DEFAULT_SETTINGS);

  it('a setting equal to the node\'s is skip-present, whether the desktop stored it whole or in part', async () => {
    const { importer } = await nodeService();
    const source = profile({ settings: { voice: defaults.voice, notifications: {}, templateVariables: defaults.templateVariables, cases: { root: '' } } });
    const plan = await planOf(importer, source.inventory);
    for (const key of ['voice', 'notifications', 'templateVariables', 'cases']) assert.strictEqual(itemOf(plan, 'settings', key).action, 'skip-present', key);
  });

  it('one that differs is new, lands, and is skip-present on the next plan, which writes nothing', async () => {
    const { core, importer } = await nodeService();
    const source = profile({ settings: { templateVariables: { name: 'Example Owner' } } });
    const first = await planOf(importer, source.inventory);
    assert.strictEqual(itemOf(first, 'settings', 'templateVariables').action, 'new');
    for (const batch of planBatches(first.items, source)) await importer.apply({ planId: first.planId, batch });
    const report = await importer.finish({ planId: first.planId });
    assert.deepStrictEqual(report.failures, []);
    assert.strictEqual(core.context.getSettings().templateVariables.name, 'Example Owner');
    const again = await planOf(importer, source.inventory);
    assert.strictEqual(itemOf(again, 'settings', 'templateVariables').action, 'skip-present');
    assert.strictEqual(itemOf(again, 'settings', 'templateVariables').note, null);
    assert.strictEqual([...planBatches(again.items, source)].flat().filter((e) => e.category === 'settings').length, 0);
    assert.strictEqual((await importer.finish({ planId: again.planId })).failures.length, 0);
  });

  it('a desktop setting equal to the default, on a node that changed it, is left alone and says so plainly', async () => {
    const { core, importer } = await nodeService();
    core.context.setSettings({ ...core.context.getSettings(), templateVariables: { name: 'Set on the node' } });
    const source = profile({ settings: { templateVariables: {} } });
    assert.strictEqual(itemOf(await planOf(importer, source.inventory), 'settings', 'templateVariables').action, 'skip-present');
    assert.strictEqual(core.context.getSettings().templateVariables.name, 'Set on the node');
  });

  it('a desktop with no model profiles, against the one a node\'s first start made, is already there', async () => {
    const { importer } = await nodeService();
    const source = profile({ settings: { models: {} } });
    assert.strictEqual(itemOf(await planOf(importer, source.inventory), 'settings', 'models').action, 'skip-present');
  });

  it('the user profile: equal is skip-present, different is new and then skip-present', async () => {
    const empty = await nodeService();
    const blank = profile({ settings: {}, userProfile: { name: '', role: '', goals: [], preferences: {}, projectContext: '' } });
    assert.strictEqual(itemOf(await planOf(empty.importer, blank.inventory), 'userProfile', 'userProfile').action, 'skip-present');

    const { importer } = await nodeService();
    const filled = profile({ settings: {}, userProfile: { name: 'Example Owner', goals: ['ship'] } });
    const first = await planOf(importer, filled.inventory);
    assert.strictEqual(itemOf(first, 'userProfile', 'userProfile').action, 'new');
    for (const batch of planBatches(first.items, filled)) await importer.apply({ planId: first.planId, batch });
    await importer.finish({ planId: first.planId });
    assert.strictEqual(itemOf(await planOf(importer, filled.inventory), 'userProfile', 'userProfile').action, 'skip-present');
  });

  it('an inventory that sends no digest plans as it did', async () => {
    const { importer } = await nodeService();
    const plan = await planOf(importer, { settingsKeys: ['voice'], userProfile: true });
    assert.strictEqual(itemOf(plan, 'settings', 'voice').action, 'new');
    assert.strictEqual(itemOf(plan, 'userProfile', 'userProfile').action, 'new');
  });
});

describe('what the node rebuilds', () => {
  it('search over old chats is said to fill in over time, with no counts', async () => {
    const { importer } = await nodeService();
    const note = itemOf(await planOf(importer, { excluded: Object.keys(EXCLUDED) }), 'excluded', 'embeddings').note;
    assert.match(note, /fills in over time/);
    assert.match(note, /first start/);
    assert.doesNotMatch(note, /\d/);
    assert.doesNotMatch(note, /are rebuilt/);
  });

  it('a fleet import keeps its line', async () => {
    const { importer } = await nodeService({ hosting: 'service' });
    assert.strictEqual(itemOf(await planOf(importer, { excluded: Object.keys(EXCLUDED) }), 'excluded', 'embeddings').note, EXCLUDED.embeddings);
  });
});

describe('the words on a personal node', () => {
  const excluded = Object.keys(EXCLUDED);
  // The node's service.json and the Local service pane are their real names.
  const saysFleet = (text) => /\bservice\b/.test(String(text).replace(/service\.json/g, '').replace(/Local service/g, ''));

  it('no stays-behind line sends the owner to "the service"', async () => {
    const { importer } = await nodeService();
    const plan = await planOf(importer, { excluded, settingsKeys: ['activeProvider', 'providerModels', 'inference'], modelProfileIds: ['p1'] });
    for (const item of plan.items) assert.ok(!saysFleet(item.note), `${item.category} ${item.key}: ${item.note}`);
  });

  it('with profiles moving, the old model settings are said to be replaced by them', async () => {
    const { importer } = await nodeService();
    const plan = await planOf(importer, { excluded, modelProfileIds: ['p1'] });
    const note = itemOf(plan, 'excluded', 'settings.activeProvider').note;
    assert.match(note, /profile/);
    assert.doesNotMatch(note, /set the models up/i);
  });

  it('with no profile to move, the same line says to set the models up on the node', async () => {
    const { importer } = await nodeService();
    const plan = await planOf(importer, { excluded, modelProfileIds: [] });
    assert.match(itemOf(plan, 'excluded', 'settings.inference').note, /Settings > Models on the node/);
  });

  it('a directory the node cannot read says the node', async () => {
    const { importer } = await nodeService();
    const plan = await planOf(importer, { allowedDirectories: [path.join(tmp(), 'gone')] });
    assert.match(plan.items.find((i) => i.category === 'allowedDirectory').note, /the node cannot read/);
  });

  it('a fleet import keeps its words', async () => {
    const { importer } = await nodeService({ hosting: 'service' });
    const plan = await planOf(importer, { excluded });
    for (const key of excluded) assert.strictEqual(itemOf(plan, 'excluded', key).note, EXCLUDED[key], key);
    const dir = await planOf(importer, { allowedDirectories: [path.join(tmp(), 'gone')] });
    assert.match(dir.items.find((i) => i.category === 'allowedDirectory').note, /the service cannot read/);
  });
});

describe('a refusal on a personal node says the node', () => {
  it('a kept rule and a system job', async () => {
    const { core, importer } = await nodeService();
    const rule = { tool: 'Bash', pattern: 'git *', action: 'allow' };
    const plan = await planOf(importer, { permissionRules: [rule], cron: [{ id: 'sys', name: 'sys' }] });
    importer.scope.addPermissionRule = () => false;
    const { results } = await importer.apply({ planId: plan.planId, batch: [
      { category: 'permissionRule', key: 'Bash|git *|allow', value: rule },
      { category: 'cron', key: 'sys', value: { id: 'sys', system: true } }
    ] });
    assert.match(results[0].note, /kept the node's rule/);
    assert.match(results[1].error, /the node makes its own/);
    assert.ok(core);
  });

  it('a fleet import keeps its words', async () => {
    const { importer } = await nodeService({ hosting: 'service' });
    const rule = { tool: 'Bash', pattern: 'git *', action: 'allow' };
    const plan = await planOf(importer, { permissionRules: [rule] });
    importer.scope.addPermissionRule = () => false;
    const { results } = await importer.apply({ planId: plan.planId, batch: [{ category: 'permissionRule', key: 'Bash|git *|allow', value: rule }] });
    assert.match(results[0].note, /kept the service's rule/);
  });
});

describe('what a digest is sent for', () => {
  const profileFor = (chatData, hosting) => {
    const userDataDir = tmp();
    fs.writeFileSync(path.join(userDataDir, 'chat-data.json'), JSON.stringify(chatData));
    return readDesktopSource({ userDataDir, reader: createSafeReader({ root: userDataDir }), decrypt: (s) => s, hosting });
  };
  const chatData = { settings: { voice: {}, models: {}, channels: {}, hooks: {}, mcpServers: {} }, userProfile: { name: 'Example Owner' } };

  it('a service target gets digests of what it can take, and no more', () => {
    assert.deepStrictEqual(Object.keys(profileFor(chatData).inventory.settingDigests), ['voice']);
  });

  it('a personal target gets the settings it also carries', () => {
    assert.deepStrictEqual(Object.keys(profileFor(chatData, 'personal').inventory.settingDigests).sort(), ['channels', 'hooks', 'mcpServers', 'models', 'voice']);
  });

  it('a one-case inventory carries none', () => {
    const { filterInventoryToCase } = require('../src/migration/case-filter');
    const source = profileFor(chatData, 'personal');
    source.inventory.cases = [{ dir: 'lakeside-lot' }];
    const out = filterInventoryToCase({
      inventory: source.inventory,
      getValue: () => null,
      caseFiles: () => [{ relPath: 'case.yaml', read: () => ({ ok: true, data: Buffer.from('id: case-lot\nslug: lakeside-lot\ntitle: Lakeside lot\n') }) }],
      caseRef: 'lakeside-lot'
    }).inventory;
    assert.ok(!('settingDigests' in out));
    assert.ok(!('userProfileDigest' in out));
  });
});

describe('a case the walker holds back names the target', () => {
  for (const [hosting, word] of [['personal', 'node'], ['service', 'service']]) {
    it(`says the ${word}`, () => {
      const userDataDir = tmp();
      fs.writeFileSync(path.join(userDataDir, 'chat-data.json'), JSON.stringify({ settings: {} }));
      const dir = path.join(userDataDir, 'cases', 'lakeside-lot');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'case.yaml'), 'id: case-lot\nslug: lakeside-lot\ntitle: Lakeside lot\n');
      fs.writeFileSync(path.join(dir, 'aux.txt'), 'x');
      const { attention } = readDesktopSource({ userDataDir, reader: createSafeReader({ root: userDataDir }), decrypt: (s) => s, hosting });
      const held = attention.find((a) => a.wholeCase === true);
      assert.match(held.note, new RegExp(`file the ${word} cannot store`));
    });
  }
});

describe('the restart offer on a retry', () => {
  const MCP = { mcpServers: { files: { command: 'example-mcp' } } };
  async function nodeWith(bootId) {
    const made = await nodeService();
    const fresh = (boot = bootId) => new DesktopImporter({
      context: made.core.context,
      targets: made.importer.targets,
      dataDir: made.importer.dataDir,
      checkPath,
      cipher: made.importer.cipher,
      scope: made.importer.scope,
      hosting: 'personal',
      ...(boot ? { bootId: boot } : {})
    });
    return { ...made, fresh };
  }
  const personalProfile = (chatData) => {
    const userDataDir = tmp();
    fs.writeFileSync(path.join(userDataDir, 'chat-data.json'), JSON.stringify(chatData));
    return readDesktopSource({ userDataDir, reader: createSafeReader({ root: userDataDir }), decrypt: (s) => s, hosting: 'personal' });
  };
  async function tryMove(importer, source, { finish = true } = {}) {
    const plan = await planOf(importer, source.inventory);
    let wrote = 0;
    for (const batch of planBatches(plan.items, source)) {
      wrote += batch.length;
      await importer.apply({ planId: plan.planId, batch });
    }
    return { plan, wrote, report: finish ? await importer.finish({ planId: plan.planId }) : null };
  }

  it('an MCP server landed on the first try is still offered when the retry writes nothing', async () => {
    const { fresh } = await nodeWith();
    const source = personalProfile({ settings: MCP });
    const first = await tryMove(fresh(), source);
    assert.strictEqual(first.report.needsRestart, true);
    const retry = await tryMove(fresh(), source);
    assert.strictEqual(itemOf(retry.plan, 'settings', 'mcpServers').action, 'skip-present');
    assert.strictEqual(retry.wrote, 0);
    assert.strictEqual(retry.report.needsRestart, true);
    assert.ok(retry.report.notes.some((n) => /next starts/.test(n)), JSON.stringify(retry.report.notes));
  });

  it('a bot token landed before a cut-off that never reached finish is offered too', async () => {
    const { fresh } = await nodeWith();
    const source = personalProfile({ settings: {}, apiTokens: { __telegram_bot_token: 'bot-value' } });
    await tryMove(fresh(), source, { finish: false });
    const retry = await tryMove(fresh(), source);
    assert.strictEqual(itemOf(retry.plan, 'channelToken', '__telegram_bot_token').action, 'skip-present');
    assert.strictEqual(retry.report.needsRestart, true);
  });

  it('a retry where none of those moved offers nothing', async () => {
    const { fresh } = await nodeWith();
    const source = personalProfile({ settings: { templateVariables: { name: 'Example Owner' } } });
    await tryMove(fresh(), source);
    const retry = await tryMove(fresh(), source);
    assert.strictEqual(retry.report.needsRestart, undefined);
  });

  it('what the node already had, this desktop not having moved it, offers nothing', async () => {
    const { core, fresh } = await nodeWith();
    core.context.setApiTokens({ ...core.context.getApiTokens(), __telegram_bot_token: core.context.encryptToken('the-node-own') });
    const source = personalProfile({ settings: { mcpServers: {} }, apiTokens: { __telegram_bot_token: 'bot-value' } });
    const { plan, report } = await tryMove(fresh(), source);
    assert.strictEqual(itemOf(plan, 'channelToken', '__telegram_bot_token').action, 'skip-present');
    assert.strictEqual(report.needsRestart, undefined);
  });

  it('a node that has started since the landing runs them already, so nothing is offered', async () => {
    const { fresh } = await nodeWith('boot-1');
    const source = personalProfile({ settings: MCP });
    await tryMove(fresh(), source);
    const retry = await tryMove(fresh('boot-2'), source);
    assert.strictEqual(retry.report.needsRestart, undefined);
  });
});
