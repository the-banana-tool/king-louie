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
const git = require('../src/cases/git');

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

// Mirrors DesktopImporter's own isSkippedCaseFile (fix round 1, C1), so a
// fixture's declared files/bytes count matches what will actually land —
// otherwise every case import would be flagged 'short' (fix round 1, M8)
// purely because of a lock file or git internal the importer always drops.
const isSkippedForCount = (rel) => {
  const segs = rel.toLowerCase().split('/');
  if (segs.length === 2 && segs[0] === '.kl' && segs[1] === 'lock') return true;
  if (segs[0] === '.git' && segs[1] === 'config' && segs.length === 2) return true;
  if (segs[0] === '.git' && segs[1] === 'hooks') return true;
  if (segs[0] === '.kl' && segs[1] === 'no-hooks') return true;
  return false;
};
const caseInventoryEntry = (dir, files) => {
  const kept = files.filter((f) => !isSkippedForCount(f.relPath));
  return { dir, files: kept.length, bytes: kept.reduce((n, f) => n + Buffer.from(f.b64, 'base64').length, 0) };
};

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
    cases: Object.keys(values.cases).map((dir) => caseInventoryEntry(dir, values.cases[dir])),
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

  // Fix round 1, C1: an imported case must never be able to run a command
  // as the service account. .git/config (fsmonitor, a clean filter),
  // .git/hooks/** and .kl/no-hooks/** are all blocked from ever landing, and
  // the case's git config is recreated fresh by the service after landing.
  it('imports a case carrying hooks, a dangerous config and .kl/no-hooks content without any of them, and commitAll runs no imported hook', async () => {
    const { dataDir, importer } = await service();
    const files = [
      { relPath: 'case.yaml', b64: Buffer.from('title: Lakeside lot\n').toString('base64'), mode: 0o644 },
      { relPath: 'notes/a.md', b64: Buffer.from('# A\n').toString('base64'), mode: 0o644 },
      // A hook that would abort any commit if it ever ran (git aborts a
      // commit whose pre-commit hook exits non-zero).
      { relPath: '.git/hooks/pre-commit', b64: Buffer.from('#!/bin/sh\nexit 1\n').toString('base64'), mode: 0o755 },
      // A config that would run an arbitrary command on `git status`/`add`.
      { relPath: '.git/config', b64: Buffer.from('[core]\n\tfsmonitor = "exit 1"\n[filter "evil"]\n\tclean = "exit 1"\n').toString('base64'), mode: 0o644 },
      // The empty directory the *service's own* hooksPath override points
      // at — importable content here would defeat that override.
      { relPath: '.kl/no-hooks/pre-commit', b64: Buffer.from('#!/bin/sh\nexit 1\n').toString('base64'), mode: 0o755 }
    ];
    const inventory = {
      installId: 'install-c1', sourceVersion: '26.9.0', chats: [], settingsKeys: [], userProfile: false,
      permissionRules: [], alwaysApprove: [], providerTokens: [], searchKeys: [], imageKeys: [], vault: [],
      anthropicOAuth: false, memory: [], cron: [],
      cases: [caseInventoryEntry('lakeside-lot', files)],
      customCasesRoot: null, allowedDirectories: [], excluded: [], secrets: 'included'
    };
    const plan = await importer.plan({ installId: inventory.installId, inventory });
    assert.strictEqual(actionOf(plan, 'case', 'lakeside-lot'), 'new');
    const batch = files.map((f) => ({ category: 'case', key: 'lakeside-lot', value: { ...f, offset: 0 } }));
    const applied = await importer.apply({ planId: plan.planId, batch });
    assert.ok(applied.results.every((r) => r.ok), JSON.stringify(applied.results));
    const report = await importer.finish({ planId: plan.planId });
    assert.deepStrictEqual(report.failures, []);
    assert.ok(!report.attention.some((a) => a.category === 'case'), JSON.stringify(report.attention));

    const caseDir = path.join(dataDir, 'cases', 'lakeside-lot');
    assert.strictEqual(fs.existsSync(path.join(caseDir, '.git', 'hooks', 'pre-commit')), false, 'the hook was not imported');
    assert.strictEqual(fs.existsSync(path.join(caseDir, '.kl', 'no-hooks', 'pre-commit')), false, 'the no-hooks payload was not imported');
    const config = fs.readFileSync(path.join(caseDir, '.git', 'config'), 'utf8');
    assert.ok(!/fsmonitor/i.test(config), 'the imported fsmonitor setting was not applied');
    assert.ok(!/evil/i.test(config), 'the imported filter was not applied');
    assert.strictEqual(fs.readFileSync(path.join(caseDir, 'notes', 'a.md'), 'utf8'), '# A\n');

    // Even with a hook physically present (placed directly, bypassing the
    // importer entirely) the service's own -c core.hooksPath override must
    // still keep it from running: if it ran, `exit 1` would abort the
    // commit and commitAll would throw instead of returning a hash.
    fs.mkdirSync(path.join(caseDir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(caseDir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(caseDir, 'facts.jsonl'), '');
    assert.ok(await git.commitAll(caseDir, 'first'), 'the commit succeeded, so no imported or planted hook, config or filter ran');
  });

  // Fix round 1, I2: the import plan's own present-check normalizes both
  // sides, matching desktop-scope's addDirectory/getSettings.
  it('normalizes an allowed directory before comparing, so a re-spelled service directory plans as already present', async () => {
    const { core, importer } = await service();
    const dir = tmp();
    core.context.setSettings({ ...core.context.getSettings(), allowedDirectories: [`${dir}${path.sep}`] });
    const fx = desktopFixture({});
    fx.inventory.allowedDirectories = [dir];
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    assert.strictEqual(actionOf(plan, 'allowedDirectory', dir), 'skip-present');
  });

  // Fix round 1, I3: an imported rule is owned by the desktop, not the
  // service, so the desktop can remove it again through the normal scope.
  it('the desktop can remove a permission rule it imported', async () => {
    const { core, importer } = await service();
    const fx = desktopFixture();
    await runImport(importer, fx);
    assert.ok(core.context.getPermissionRules().some((r) => r.tool === 'Bash' && r.pattern === 'git *' && r.action === 'allow'));
    assert.doesNotThrow(() => importer.scope.removePermissionRule('Bash', 'git *', 'allow'));
    assert.ok(!core.context.getPermissionRules().some((r) => r.tool === 'Bash' && r.pattern === 'git *' && r.action === 'allow'));
  });

  // Fix round 1, I4: apply() re-checks live state for every write, not just
  // what plan() saw — a new chat, a cron job, a secret and the profile are
  // each written only if still absent by the time the batch actually lands.
  it('apply skips instead of overwriting when the service gained the same chat, cron job, secret or profile after the plan', async () => {
    const { core, importer } = await service();
    const fx = desktopFixture();
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });

    core.context.setChats([...core.context.getChats(), { id: 'c1', title: 'Collision', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', messages: [] }]);
    await core.context.getCronScheduler().addJob({ id: 'cron_1', name: 'race', schedule: { kind: 'cron', expr: '0 0 * * *' }, enabled: true, payload: {} });
    const tokens = { ...core.context.getApiTokens() };
    tokens.anthropic = core.context.encryptToken('sk-race');
    core.context.setApiTokens(tokens);
    core.context.vault.set('github', 'race-secret');
    core.context.updateUserProfile({ name: 'Race Owner' });

    const batch = [];
    for (const item of plan.items) {
      if (!['new', 'update', 'copy'].includes(item.action)) continue;
      if (item.category === 'case') { for (const f of fx.values.cases[item.key]) batch.push({ category: 'case', key: item.key, value: { ...f, offset: 0 } }); continue; }
      batch.push({ category: item.category, key: item.key, value: fx.valueOf(item.category, item.key) });
    }
    const { results } = await importer.apply({ planId: plan.planId, batch });

    const chatResult = results.find((r) => r.category === 'chat' && r.key === 'c1');
    assert.match(chatResult.note, /added to the service/);
    assert.strictEqual(core.context.getChats().find((c) => c.id === 'c1').title, 'Collision', 'the racing chat is untouched');

    const cronResult = results.find((r) => r.category === 'cron' && r.key === 'cron_1');
    assert.match(cronResult.note, /added to the service/);
    assert.strictEqual(core.context.getCronScheduler().listJobs().find((j) => j.id === 'cron_1').name, 'race');

    const tokenResult = results.find((r) => r.category === 'providerToken' && r.key === 'anthropic');
    assert.match(tokenResult.note, /added to the service/);
    assert.strictEqual(core.context.decryptToken(core.context.getApiTokens().anthropic), 'sk-race');

    const vaultResult = results.find((r) => r.category === 'vault' && r.key === 'github');
    assert.match(vaultResult.note, /added to the service/);
    assert.strictEqual(core.context.vault.get('github'), 'race-secret');

    const profileResult = results.find((r) => r.category === 'userProfile' && r.key === 'userProfile');
    assert.match(profileResult.note, /set on the service/);
    assert.strictEqual(core.context.getUserProfile().name, 'Race Owner');
  });

  it('a chat update becomes attention, not an overwrite, when the service copy changed after the plan', async () => {
    const { core, importer } = await service();
    const fx = desktopFixture();
    await runImport(importer, fx);
    const edited = desktopFixture();
    edited.values.chats.c1 = { ...fx.values.chats.c1, updatedAt: '2026-09-21T10:00:00Z', title: 'Chat c1 edited' };
    edited.inventory.chats = [{ id: 'c1', updatedAt: edited.values.chats.c1.updatedAt, title: edited.values.chats.c1.title }];
    const plan = await importer.plan({ installId: edited.inventory.installId, inventory: edited.inventory });
    assert.strictEqual(actionOf(plan, 'chat', 'c1'), 'update');
    // The service changes c1 again before the batch is applied.
    core.context.setChats(core.context.getChats().map((c) => (c.id === 'c1' ? { ...c, updatedAt: '2026-09-22T00:00:00Z', title: 'Changed on service' } : c)));
    const { results } = await importer.apply({ planId: plan.planId, batch: [{ category: 'chat', key: 'c1', value: edited.values.chats.c1 }] });
    const r = results.find((x) => x.category === 'chat' && x.key === 'c1');
    assert.strictEqual(r.ok, true);
    assert.match(r.note, /changed on the service/);
    assert.strictEqual(core.context.getChats().find((c) => c.id === 'c1').title, 'Changed on service', 'not overwritten');
    const report = await importer.finish({ planId: plan.planId });
    assert.ok(report.attention.some((a) => a.category === 'chat' && a.key === 'c1'));
  });

  // Fix round 1, M7: leading-dot case dirs, Windows reserved device names
  // and trailing dots/spaces are all refused, for the case dir name and for
  // every path segment inside a case file.
  it('rejects a leading-dot case dir, a reserved device name, a trailing dot, and the same inside a case file path', async () => {
    const { importer } = await service();
    const inventory = {
      installId: 'install-m7', sourceVersion: '26.9.0', chats: [], settingsKeys: [], userProfile: false,
      permissionRules: [], alwaysApprove: [], providerTokens: [], searchKeys: [], imageKeys: [], vault: [],
      anthropicOAuth: false, memory: [], cron: [],
      cases: [
        { dir: '.git', files: 1, bytes: 1 },
        { dir: 'CON', files: 1, bytes: 1 },
        { dir: 'notes.', files: 1, bytes: 1 },
        { dir: 'lakeside-lot', files: 1, bytes: 1 }
      ],
      customCasesRoot: null, allowedDirectories: [], excluded: [], secrets: 'included'
    };
    const plan = await importer.plan({ installId: inventory.installId, inventory });
    assert.strictEqual(actionOf(plan, 'case', '.git'), 'needs-attention');
    assert.strictEqual(actionOf(plan, 'case', 'CON'), 'needs-attention');
    assert.strictEqual(actionOf(plan, 'case', 'notes.'), 'needs-attention');
    assert.strictEqual(actionOf(plan, 'case', 'lakeside-lot'), 'new');

    const { results } = await importer.apply({
      planId: plan.planId,
      batch: [
        { category: 'case', key: 'lakeside-lot', value: { relPath: 'CON.txt', b64: 'eA==', mode: 0o644, offset: 0 } },
        { category: 'case', key: 'lakeside-lot', value: { relPath: 'notes.', b64: 'eA==', mode: 0o644, offset: 0 } }
      ]
    });
    assert.ok(results.every((r) => r.ok === false && /reserved device name|trailing dot/.test(r.error)), JSON.stringify(results));
  });

  // Fix round 1, M8: a case that lands with fewer files or bytes than the
  // inventory promised is reported as attention, not plain ok — the batch
  // may have been cut short without the caller noticing.
  it('reports a short case delivery as attention, not ok', async () => {
    const { importer } = await service();
    const allFiles = [
      { relPath: 'case.yaml', b64: Buffer.from('title: Lakeside lot\n').toString('base64'), mode: 0o644 },
      { relPath: 'notes/a.md', b64: Buffer.from('# A\n').toString('base64'), mode: 0o644 }
    ];
    const inventory = {
      installId: 'install-m8', sourceVersion: '26.9.0', chats: [], settingsKeys: [], userProfile: false,
      permissionRules: [], alwaysApprove: [], providerTokens: [], searchKeys: [], imageKeys: [], vault: [],
      anthropicOAuth: false, memory: [], cron: [],
      cases: [caseInventoryEntry('lakeside-lot', allFiles)],
      customCasesRoot: null, allowedDirectories: [], excluded: [], secrets: 'included'
    };
    const plan = await importer.plan({ installId: inventory.installId, inventory });
    const short = allFiles.filter((f) => f.relPath !== 'notes/a.md'); // one file never arrives
    const batch = short.map((f) => ({ category: 'case', key: 'lakeside-lot', value: { ...f, offset: 0 } }));
    const applied = await importer.apply({ planId: plan.planId, batch });
    assert.ok(applied.results.every((r) => r.ok));
    const report = await importer.finish({ planId: plan.planId });
    assert.deepStrictEqual(report.failures, []);
    const attention = report.attention.find((a) => a.category === 'case' && a.key === 'lakeside-lot');
    assert.ok(attention, JSON.stringify(report.attention));
    assert.match(attention.note, /incomplete/);
  });

  // Fix round 1, M10: searchKey/imageKey names are allow-listed the way
  // provider token names are — an unknown name never reaches 'new'.
  it('excludes an unrecognized searchKey or imageKey name instead of planning it for import', async () => {
    const { importer } = await service();
    const fx = desktopFixture({});
    fx.inventory.searchKeys = ['brave', 'not-a-real-provider'];
    fx.inventory.imageKeys = ['fal', 'not-a-real-provider'];
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    assert.strictEqual(actionOf(plan, 'searchKey', 'brave'), 'new');
    assert.strictEqual(actionOf(plan, 'searchKey', 'not-a-real-provider'), 'skip-excluded');
    assert.strictEqual(actionOf(plan, 'imageKey', 'fal'), 'new');
    assert.strictEqual(actionOf(plan, 'imageKey', 'not-a-real-provider'), 'skip-excluded');
  });

  // Fix round 1, M9: a staging directory left behind by a process that
  // exited between apply() and finish() is swept up the next time a
  // DesktopImporter is constructed against the same cases root.
  it('cleans up an orphaned staging directory at construction', async () => {
    const { core, dataDir } = await service();
    const casesRoot = path.join(dataDir, 'cases');
    const orphan = path.join(casesRoot, '.import-orphan1234');
    fs.mkdirSync(path.join(orphan, 'some-case'), { recursive: true });
    fs.writeFileSync(path.join(orphan, 'some-case', 'case.yaml'), 'title: Orphan\n');
    // eslint-disable-next-line no-new
    new DesktopImporter({
      context: core.context, targets: (await buildImportTargets({ context: core.context, dataDir })), dataDir, checkPath,
      scope: createDesktopScope({ dataDir, context: core.context })
    });
    assert.strictEqual(fs.existsSync(orphan), false);
  });

  // Fix round 1, M6: isInside compares the first path segment, not a raw
  // string prefix — a file literally named with a leading ".." is a normal
  // file inside the case, not an escape.
  it('imports a case file whose name literally starts with two dots', async () => {
    const { dataDir, importer } = await service();
    const inventory = {
      installId: 'install-m6', sourceVersion: '26.9.0', chats: [], settingsKeys: [], userProfile: false,
      permissionRules: [], alwaysApprove: [], providerTokens: [], searchKeys: [], imageKeys: [], vault: [],
      anthropicOAuth: false, memory: [], cron: [],
      cases: [{ dir: 'lakeside-lot', files: 1, bytes: 3 }],
      customCasesRoot: null, allowedDirectories: [], excluded: [], secrets: 'included'
    };
    const plan = await importer.plan({ installId: inventory.installId, inventory });
    const { results } = await importer.apply({
      planId: plan.planId,
      batch: [{ category: 'case', key: 'lakeside-lot', value: { relPath: '..notes.md', b64: Buffer.from('hi\n').toString('base64'), mode: 0o644, offset: 0 } }]
    });
    assert.strictEqual(results[0].ok, true, JSON.stringify(results));
    await importer.finish({ planId: plan.planId });
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'cases', 'lakeside-lot', '..notes.md'), 'utf8'), 'hi\n');
  });
});
