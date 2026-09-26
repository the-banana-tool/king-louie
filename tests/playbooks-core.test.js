// tests/playbooks-core.test.js
// Host wiring for playbooks (cases stage 6 spec §6, §7): the settings
// namespace, createCore's manager and the examplesDir each host passes.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { mergeSettings } = require('../src/core/settings');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { PlaybookManager, resolvePlaybookSettings } = require('../src/cases/playbooks');

const ROOT = path.join(__dirname, '..');
const tempDirs = [];
afterEach(() => { while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true }); });

function makeDeps(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbcore-'));
  tempDirs.push(dataDir);
  return {
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    ui: { send: () => {} },
    builtinSkillsDir: path.join(ROOT, 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    ...extra
  };
}

describe('playbooks settings', () => {
  it('defaults to no allowed sources and no auto-update', () => {
    assert.deepStrictEqual(mergeSettings({}).playbooks, { sources: [], autoUpdate: false });
    const partial = resolvePlaybookSettings(mergeSettings({ playbooks: { sources: ['https://example.com/playbooks/', 7] } }).playbooks);
    assert.deepStrictEqual(partial, { sources: ['https://example.com/playbooks/'], autoUpdate: false });
  });
});

describe('createCore playbooks wiring', () => {
  it('puts a PlaybookManager on the case runtime and exposes it', () => {
    const core = createCore(makeDeps({ examplesDir: path.join(ROOT, 'examples', 'playbooks') }));
    const manager = core.context.getPlaybookManager();
    assert.ok(manager instanceof PlaybookManager);
    assert.strictEqual(core.context.getCaseRuntime().playbooks, manager);
    assert.deepStrictEqual(manager.listExamples().map((e) => e.name), ['contractor-quotes', 'medical-scheduling', 'property-sale']);
    assert.ok(core.context.getCaseRuntime().hooks.some((h) => h.name === 'playbooks'), 'the turn-start hook is registered');
  });

  it('works without examples', () => {
    const core = createCore(makeDeps());
    assert.deepStrictEqual(core.context.getPlaybookManager().listExamples(), []);
  });

  // Ruling M14: settings.playbooks stays in settings in every mode; the
  // manager reads the core's own settings (the service's in attached mode).
  // autoUpdate counts only when it is === true.
  it('reads settings.playbooks through the core settings, in service mode too', () => {
    const core = createCore(makeDeps({ isService: true }));
    const manager = core.context.getPlaybookManager();
    assert.deepStrictEqual(manager.settings(), { sources: [], autoUpdate: false });
    const settings = core.context.getSettings();
    core.context.setSettings({ ...settings, playbooks: { sources: ['https://example.com/playbooks/'], autoUpdate: 'true' } });
    assert.deepStrictEqual(manager.settings(), { sources: ['https://example.com/playbooks/'], autoUpdate: false });
    core.context.setSettings({ ...settings, playbooks: { sources: [], autoUpdate: true } });
    assert.strictEqual(manager.settings().autoUpdate, true);
  });

  // Ruling M3: the desktop's createCore call lives in src/ipc/standalone-host.js.
  it('both hosts pass examplesDir', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'src', 'ipc', 'standalone-host.js'), 'utf8'), /examplesDir: path\.join\(appDir, 'examples', 'playbooks'\)/);
    assert.match(fs.readFileSync(path.join(ROOT, 'src', 'service', 'run.js'), 'utf8'), /examplesDir: path\.join\(__dirname, '\.\.', '\.\.', 'examples', 'playbooks'\)/);
  });
});
