// tests/desktop-import.test.js — the import engine (fleet stage 7 §3.8).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { addSink } = require('../src/logging');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { checkPath } = require('../src/desktop-bridge/check-path');
const { DesktopImporter, buildImportTargets, MAX_BATCH_BYTES } = require('../src/migration/desktop-import');
const { MemoryManager, MemoryStore } = require('../src/memory');

const SECRET = 'sk-example-SECRET-0123456789';
const VAULT_SECRET = 'ghp_exampleVAULTsecret42';
const dirs = [];
const cores = [];
let savedCasesRoot;

before(() => { savedCasesRoot = process.env.KL_CASES_ROOT; });
after(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
});
const tmp = (p = 'kl-import-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

async function service({ cipher = createAesGcmCipher(crypto.randomBytes(32)), now } = {}) {
  const dataDir = tmp();
  process.env.KL_CASES_ROOT = path.join(dataDir, 'cases');
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
  });
  cores.push(core);
  await core.start();
  core.context.getCronScheduler().pause?.();
  const targets = await buildImportTargets({ context: core.context, dataDir });
  const importer = new DesktopImporter({
    context: core.context, targets, dataDir, cipher, checkPath,
    scope: createDesktopScope({ dataDir, context: core.context }),
    ...(now ? { now } : {})
  });
  return { core, dataDir, importer };
}

function desktopFixture(overrides = {}) {
  const workDir = tmp('kl-import-wd-');
  const chat = (id, updatedAt, title = `Chat ${id}`) => ({ id, title, createdAt: '2026-09-01T10:00:00Z', updatedAt, messages: [{ id: `${id}-m1`, sender: 'user', text: 'hello', timestamp: updatedAt }] });
  const values = {
    settings: { inference: { activeTier: 'smart' }, voice: { enabled: true }, hooks: { enabled: false } },
    userProfile: { name: 'Example Owner', goals: ['ship'] },
    chats: { c1: chat('c1', '2026-09-20T10:00:00Z'), c2: { ...chat('c2', '2026-09-20T11:00:00Z'), workingDirectory: path.join(workDir, 'gone') } },
    memory: { 'm-1': { id: 'm-1', type: 'preference', content: 'likes tea', source: 'desk', created: '2026-01-02T03:04:05.000Z', lastAccessed: '2026-01-03T03:04:05.000Z', metadata: {} } },
    cron: { cron_1: { id: 'cron_1', name: 'daily', schedule: { kind: 'cron', expr: '0 9 * * *' }, enabled: true, payload: { message: 'report' } } },
    cases: { 'lakeside-lot': [{ relPath: 'case.yaml', b64: Buffer.from('title: Lakeside lot\n').toString('base64'), mode: 0o644 }, { relPath: '.kl/lock', b64: Buffer.from('lock').toString('base64'), mode: 0o644 }, { relPath: 'notes/a.md', b64: Buffer.from('# A\n').toString('base64'), mode: 0o644 }] },
    providerTokens: { anthropic: SECRET },
    vault: { github: VAULT_SECRET },
    ...overrides
  };
  const inventory = {
    installId: 'install-0001',
    sourceVersion: '26.9.0',
    chats: Object.values(values.chats).map((c) => ({ id: c.id, updatedAt: c.updatedAt, title: c.title })),
    settingsKeys: Object.keys(values.settings),
    userProfile: true,
    permissionRules: [{ tool: 'Bash', pattern: 'git *', action: 'allow' }],
    alwaysApprove: ['Read'],
    providerTokens: Object.keys(values.providerTokens).concat(['__telegram_bot_token']),
    searchKeys: [],
    imageKeys: [],
    vault: Object.keys(values.vault),
    anthropicOAuth: false,
    memory: Object.keys(values.memory),
    cron: Object.values(values.cron).map((j) => ({ id: j.id, name: j.name })),
    cases: Object.keys(values.cases).map((dir) => ({ dir, files: values.cases[dir].length, bytes: 30 })),
    customCasesRoot: null,
    allowedDirectories: [workDir],
    excluded: ['mesh.identity', 'settings.hooks'],
    secrets: 'included'
  };
  const valueOf = (category, key) => {
    switch (category) {
      case 'settings': return values.settings[key];
      case 'userProfile': return values.userProfile;
      case 'permissionRule': { const [tool, pattern, action] = key.split('|'); return { tool, pattern, action }; }
      case 'alwaysApprove': return true;
      case 'allowedDirectory': return key;
      case 'chat': return values.chats[key];
      case 'memory': return values.memory[key];
      case 'cron': return values.cron[key];
      case 'providerToken': return values.providerTokens[key];
      case 'vault': return values.vault[key];
      default: return null;
    }
  };
  return { inventory, values, valueOf, workDir };
}

async function runImport(importer, fx) {
  const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
  const batch = [];
  for (const item of plan.items) {
    if (!['new', 'update', 'copy'].includes(item.action)) continue;
    if (item.category === 'case') { for (const f of fx.values.cases[item.key]) batch.push({ category: 'case', key: item.key, value: { ...f, offset: 0 } }); continue; }
    batch.push({ category: item.category, key: item.key, value: fx.valueOf(item.category, item.key) });
  }
  const applied = await importer.apply({ planId: plan.planId, batch });
  const report = await importer.finish({ planId: plan.planId });
  return { plan, applied, report };
}

const actionOf = (plan, category, key) => plan.items.find((i) => i.category === category && i.key === key)?.action;

describe('MemoryManager.importEntry', () => {
  it('keeps id and timestamps and imports an id once', () => {
    const dir = tmp();
    const mm = new MemoryManager({ store: new MemoryStore({ storageFile: path.join(dir, 'memory.json') }) });
    const entry = { id: 'm-7', type: 'success', content: 'deploy worked', created: '2026-01-01T00:00:00.000Z', lastAccessed: '2026-01-02T00:00:00.000Z' };
    assert.deepStrictEqual(mm.importEntry(entry), { imported: true });
    const stored = mm.store.getById('m-7');
    assert.strictEqual(stored.created, entry.created);
    assert.strictEqual(stored.lastAccessed, entry.lastAccessed);
    assert.deepStrictEqual(mm.importEntry({ ...entry, content: 'changed' }), { imported: false });
    assert.strictEqual(mm.store.getById('m-7').content, 'deploy worked');
    assert.throws(() => mm.importEntry({ content: 'no id' }), /needs an id/);
  });
});

describe('DesktopImporter', () => {
  it('plans every category against a fresh service', async () => {
    const { importer } = await service();
    const fx = desktopFixture();
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    assert.strictEqual(actionOf(plan, 'settings', 'inference'), 'new');
    assert.strictEqual(actionOf(plan, 'settings', 'hooks'), 'skip-excluded');
    assert.strictEqual(actionOf(plan, 'userProfile', 'userProfile'), 'new');
    assert.strictEqual(actionOf(plan, 'permissionRule', 'Bash|git *|allow'), 'new');
    assert.strictEqual(actionOf(plan, 'alwaysApprove', 'Read'), 'new');
    assert.strictEqual(actionOf(plan, 'allowedDirectory', fx.workDir), 'new');
    assert.strictEqual(actionOf(plan, 'chat', 'c1'), 'new');
    assert.strictEqual(actionOf(plan, 'memory', 'm-1'), 'new');
    assert.strictEqual(actionOf(plan, 'cron', 'cron_1'), 'new');
    assert.strictEqual(actionOf(plan, 'case', 'lakeside-lot'), 'new');
    assert.strictEqual(actionOf(plan, 'providerToken', 'anthropic'), 'new');
    assert.strictEqual(actionOf(plan, 'providerToken', '__telegram_bot_token'), 'skip-excluded');
    assert.strictEqual(actionOf(plan, 'vault', 'github'), 'new');
    assert.strictEqual(actionOf(plan, 'excluded', 'mesh.identity'), 'skip-excluded');
    assert.strictEqual(plan.items[plan.items.length - 1].category, 'excluded');
    assert.ok(plan.counts.new >= 12);
  });

  it('imports, lands cases through the staging dir, and a rerun gives skip-present', async () => {
    const { core, dataDir, importer } = await service();
    const fx = desktopFixture();
    const first = await runImport(importer, fx);
    assert.deepStrictEqual(first.report.failures, []);
    assert.strictEqual(core.context.getSettings().inference.activeTier, 'smart');
    assert.ok(core.context.getChats().some((c) => c.id === 'c1'));
    const c2 = core.context.getChats().find((c) => c.id === 'c2');
    assert.strictEqual(c2.workingDirectory, null, 'an unreadable working directory is dropped');
    assert.ok(first.report.attention.some((a) => a.category === 'chat' && a.key === 'c2'));
    assert.strictEqual(core.context.vault.get('github'), VAULT_SECRET);
    assert.strictEqual(core.context.decryptToken(core.context.getApiTokens().anthropic), SECRET);
    const job = core.context.getCronScheduler().listJobs().find((j) => j.id === 'cron_1');
    assert.strictEqual(job.enabled, false, 'cron jobs arrive disabled');
    assert.strictEqual(first.report.cronDisabled, 1);
    const caseDir = path.join(dataDir, 'cases', 'lakeside-lot');
    assert.strictEqual(fs.readFileSync(path.join(caseDir, 'notes', 'a.md'), 'utf8'), '# A\n');
    assert.strictEqual(fs.existsSync(path.join(caseDir, '.kl', 'lock')), false, 'the case lock is skipped');
    assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'cases')).filter((n) => n.startsWith('.import-')), []);
    const again = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    for (const item of again.items) {
      assert.ok(!['new', 'update', 'copy'].includes(item.action), `${item.category}:${item.key} is ${item.action}`);
    }
    assert.strictEqual(actionOf(again, 'chat', 'c1'), 'skip-present');
    assert.strictEqual(actionOf(again, 'case', 'lakeside-lot'), 'skip-present');
  });

  it('rerun after standalone use: update in place, a copy when both changed, new chats come across', async () => {
    const { core, importer } = await service();
    const fx = desktopFixture();
    await runImport(importer, fx);
    // Used standalone again: c1 edited on the desktop, a new c3.
    const edited = desktopFixture();
    edited.values.chats.c1 = { ...fx.values.chats.c1, updatedAt: '2026-09-21T10:00:00Z', title: 'Chat c1 edited' };
    edited.values.chats.c3 = { ...fx.values.chats.c1, id: 'c3', updatedAt: '2026-09-21T12:00:00Z', title: 'Chat c3' };
    edited.inventory.chats = Object.values(edited.values.chats).map((c) => ({ id: c.id, updatedAt: c.updatedAt, title: c.title }));
    const second = await runImport(importer, edited);
    assert.strictEqual(actionOf(second.plan, 'chat', 'c1'), 'update');
    assert.strictEqual(actionOf(second.plan, 'chat', 'c3'), 'new');
    assert.strictEqual(core.context.getChats().find((c) => c.id === 'c1').title, 'Chat c1 edited');
    // Now both sides change c1.
    core.context.setChats(core.context.getChats().map((c) => (c.id === 'c1' ? { ...c, updatedAt: '2026-09-22T09:00:00Z' } : c)));
    const third = desktopFixture();
    third.values.chats.c1 = { ...edited.values.chats.c1, updatedAt: '2026-09-22T10:00:00Z' };
    third.inventory.chats = [{ id: 'c1', updatedAt: '2026-09-22T10:00:00Z', title: 'Chat c1 edited' }];
    const out = await runImport(importer, third);
    const copyItem = out.plan.items.find((i) => i.category === 'chat' && i.key === 'c1');
    assert.strictEqual(copyItem.action, 'copy');
    const copy = core.context.getChats().find((c) => c.id === copyItem.targetKey);
    assert.strictEqual(copy.title, 'Chat c1 edited (from desktop)');
    const fourth = await importer.plan({ installId: third.inventory.installId, inventory: third.inventory });
    assert.strictEqual(actionOf(fourth, 'chat', 'c1'), 'skip-present', 'the manifest now follows the copy');
  });

  it('never writes a secret into a plan, report, log line or the manifest', async () => {
    const { dataDir, importer } = await service();
    const lines = [];
    const remove = addSink((record) => lines.push(record.line));
    let out;
    try {
      out = await runImport(importer, desktopFixture());
    } finally {
      remove();
    }
    const manifest = fs.readFileSync(path.join(dataDir, 'imports', 'desktop-install-0001.json'), 'utf8');
    for (const text of [JSON.stringify(out.plan), JSON.stringify(out.applied), JSON.stringify(out.report), manifest, lines.join('\n')]) {
      assert.ok(!text.includes(SECRET), 'provider token leaked');
      assert.ok(!text.includes(VAULT_SECRET), 'vault secret leaked');
    }
  });

  it('rejects case paths that escape, and a symlinked staging dir', async (t) => {
    const { dataDir, importer } = await service();
    const fx = desktopFixture();
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    const bad = ['../x', '/etc/x', 'C:/x', 'a/../../x', 'a\u0000b'];
    const { results } = await importer.apply({ planId: plan.planId, batch: bad.map((relPath) => ({ category: 'case', key: 'lakeside-lot', value: { relPath, b64: 'eA==', mode: 0o644, offset: 0 } })) });
    assert.ok(results.every((r) => r.ok === false && /escapes|not allowed/.test(r.error)), JSON.stringify(results));
    const staging = path.join(dataDir, 'cases', `.import-${plan.planId}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      fs.symlinkSync(tmp(), path.join(staging, 'lakeside-lot'), 'dir');
    } catch (err) {
      t.skip(`cannot create a symlink here (${err.code})`);
      return;
    }
    const linked = await importer.apply({ planId: plan.planId, batch: [{ category: 'case', key: 'lakeside-lot', value: { relPath: 'case.yaml', b64: 'eA==', mode: 0o644, offset: 0 } }] });
    assert.strictEqual(linked.results[0].ok, false);
    assert.match(linked.results[0].error, /link/);
  });

  it('fails secrets, not the rest, when the service cipher is unavailable', async () => {
    const { core, importer } = await service({ cipher: { isEncryptionAvailable: () => false } });
    const out = await runImport(importer, desktopFixture());
    const failed = out.report.failures.map((f) => `${f.category}:${f.key}`).sort();
    assert.deepStrictEqual(failed, ['providerToken:anthropic', 'vault:github']);
    assert.ok(out.report.failures.every((f) => f.error === 'Encryption unavailable in the service.'));
    assert.deepStrictEqual(out.report.secretsMissing.map((s) => s.key).sort(), ['anthropic', 'github']);
    assert.ok(core.context.getChats().some((c) => c.id === 'c1'));
  });

  it('expires a plan after 30 minutes and when its connection closes', async () => {
    let clock = Date.parse('2026-09-23T10:00:00Z');
    const { importer } = await service({ now: () => new Date(clock) });
    const fx = desktopFixture();
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory, connectionId: 7 });
    clock += 31 * 60 * 1000;
    await assert.rejects(importer.apply({ planId: plan.planId, batch: [] }), (err) => err.code === 'PLAN_EXPIRED');
    const second = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory, connectionId: 8 });
    importer.expireConnection(8);
    await assert.rejects(importer.finish({ planId: second.planId }), (err) => err.code === 'PLAN_EXPIRED');
  });

  it('refuses a batch over 2 MiB and items the plan did not schedule', async () => {
    const { importer } = await service();
    const fx = desktopFixture();
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    const huge = [{ category: 'chat', key: 'c1', value: { id: 'c1', messages: [], blob: 'x'.repeat(MAX_BATCH_BYTES) } }];
    await assert.rejects(importer.apply({ planId: plan.planId, batch: huge }), (err) => err.code === 'BATCH_TOO_LARGE');
    const { results } = await importer.apply({ planId: plan.planId, batch: [{ category: 'settings', key: 'hooks', value: {} }] });
    assert.deepStrictEqual(results, [{ category: 'settings', key: 'hooks', ok: false, error: 'not planned for import' }]);
  });
});
