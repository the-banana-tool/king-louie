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
const { addSink } = require('../src/logging');
const { loadServiceConfig } = require('../src/service/config');

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

  // The desktop reads the owner's own settings; autoUpdate counts only === true.
  it('desktop: reads settings.playbooks from the owner settings', () => {
    const core = createCore(makeDeps());
    const manager = core.context.getPlaybookManager();
    assert.deepStrictEqual(manager.settings(), { sources: [], autoUpdate: false });
    const settings = core.context.getSettings();
    core.context.setSettings({ ...settings, playbooks: { sources: ['https://example.com/playbooks/'], autoUpdate: 'true' } });
    assert.deepStrictEqual(manager.settings(), { sources: ['https://example.com/playbooks/'], autoUpdate: false });
    core.context.setSettings({ ...settings, playbooks: { sources: [], autoUpdate: true } });
    assert.strictEqual(manager.settings().autoUpdate, true);
  });

  // Ruling T14-admin: in service mode only the admin service.json block
  // counts; data-dir settings for these keys are ignored, with one warning.
  it('service: honours the admin playbooks block and ignores the data-dir settings', (t) => {
    const warnings = [];
    t.after(addSink((r) => { if (r.level === 'warn' && /settings\.playbooks/.test(r.message)) warnings.push(r.message); }));
    const admin = { sources: ['https://example.com/admin/'], autoUpdate: true };
    const core = createCore(makeDeps({ isService: true, playbooksConfig: admin }));
    const manager = core.context.getPlaybookManager();
    const settings = core.context.getSettings();
    core.context.setSettings({ ...settings, playbooks: { sources: ['path:/', 'https://example.com/data-dir/'], autoUpdate: false } });
    assert.deepStrictEqual(manager.settings(), admin);
    assert.deepStrictEqual(manager.settings(), admin);
    assert.strictEqual(warnings.length, 1, 'warned once');

    // No admin block: nothing allowed, no auto-update, whatever the data dir says.
    const bare = createCore(makeDeps({ isService: true }));
    bare.context.setSettings({ ...bare.context.getSettings(), playbooks: { sources: ['path:/'], autoUpdate: true } });
    assert.deepStrictEqual(bare.context.getPlaybookManager().settings(), { sources: [], autoUpdate: false });
  });

  it('run.js passes the admin block to createCore as playbooksConfig', () => {
    const run = fs.readFileSync(path.join(ROOT, 'src', 'service', 'run.js'), 'utf8');
    assert.match(run, /playbooksConfig: playbooks \?\? \{ sources: \[\], autoUpdate: false \}/);
    assert.match(run, /playbooks: config\.playbooks/);
  });

  // Ruling M3: the desktop's createCore call lives in src/ipc/standalone-host.js.
  it('both hosts pass examplesDir', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'src', 'ipc', 'standalone-host.js'), 'utf8'), /examplesDir: path\.join\(appDir, 'examples', 'playbooks'\)/);
    assert.match(fs.readFileSync(path.join(ROOT, 'src', 'service', 'run.js'), 'utf8'), /examplesDir: path\.join\(__dirname, '\.\.', '\.\.', 'examples', 'playbooks'\)/);
  });
});

// Ruling T14-admin: the admin service.json "playbooks" block.
describe('service.json playbooks block', () => {
  const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  function load(adminCfg, dataCfg = null) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbsvc-'));
    tempDirs.push(root);
    const admin = path.join(root, 'config');
    const data = path.join(root, 'data');
    fs.mkdirSync(admin);
    fs.mkdirSync(data);
    if (process.platform !== 'win32') fs.chmodSync(admin, 0o755);
    if (adminCfg) {
      fs.writeFileSync(path.join(admin, 'service.json'), JSON.stringify(adminCfg), { mode: 0o644 });
      if (process.platform !== 'win32') fs.chmodSync(path.join(admin, 'service.json'), 0o644);
    }
    if (dataCfg) fs.writeFileSync(path.join(data, 'service.json'), JSON.stringify(dataCfg));
    return loadServiceConfig(data, {}, { adminConfigDir: admin, geteuid: () => -1, adminUid: selfUid });
  }
  const abs = path.resolve(os.tmpdir(), 'playbooks');

  it('defaults to nothing allowed and no auto-update', () => {
    assert.deepStrictEqual(load(null).playbooks, { sources: [], autoUpdate: false });
  });

  it('reads a valid block', () => {
    const cfg = load({ playbooks: { sources: ['https://example.com/playbooks/', 'ssh://git@example.com/pb', `path:${abs}`], autoUpdate: true } });
    assert.deepStrictEqual(cfg.playbooks, { sources: ['https://example.com/playbooks/', 'ssh://git@example.com/pb', `path:${abs}`], autoUpdate: true });
  });

  it('refuses unknown keys and bad entries, naming the key', () => {
    assert.throws(() => load({ playbooks: { sources: [], extra: 1 } }), /unknown key "playbooks\.extra"/);
    assert.throws(() => load({ playbooks: [] }), /"playbooks" must be an object/);
    assert.throws(() => load({ playbooks: { sources: 'https://example.com/' } }), /playbooks\.sources must be a list/);
    for (const bad of [7, '', 'relative/dir', 'path:relative', 'path:\\\\host\\share', 'path://host/share', 'http://example.com/pb', 'https://example.com/a\nb', 'https://example.com/\u202e']) {
      assert.throws(() => load({ playbooks: { sources: [bad] } }), /playbooks\.sources\[0\] must be path:<absolute folder> or an https\/ssh URL prefix/, JSON.stringify(bad));
    }
    assert.throws(() => load({ playbooks: { autoUpdate: 'true' } }), /playbooks\.autoUpdate must be true or false/);
  });

  it('ignores a playbooks block in the service-writable data-dir service.json', () => {
    const cfg = load(null, { playbooks: { sources: [`path:${abs}`], autoUpdate: true } });
    assert.deepStrictEqual(cfg.playbooks, { sources: [], autoUpdate: false });
  });
});
