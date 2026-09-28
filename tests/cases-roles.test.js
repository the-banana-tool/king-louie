// tests/cases-roles.test.js
// Case roles on model roles (spec 2026-09-27 §6.4, §8, §13 step 4): orient
// and classify on utility, draft on worker, judge and verify on main, verify
// on another provider family; tier names read as the mapped role.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { addSink } = require('../src/logging');
const { resolveCaseRole, caseRoleSpec, providerFamily, NO_RETRY, ROLES, DEFAULT_ROLES, CASE_ROLE_TO_MODEL_ROLE } = require('../src/cases/roles');
const { createTurnModels } = require('../src/models/resolver');
const { CaseRuntime } = require('../src/cases');
const { profileSettings } = require('./helpers/profile-settings');

const t = (provider, model) => ({ provider, model, effort: null });
const usable = () => ({ usable: true, reasons: [], notes: [] });
const models = (roles, { explain = usable, mainOverride = null } = {}) => createTurnModels({
  profile: { id: 'p-1', name: 'Work', kind: 'user', roles: { main: [], worker: [], utility: [], ...roles } },
  mainOverride,
  explain
});
const work = () => models({
  main: [t('anthropic', 'claude-sonnet-4-5'), t('openai', 'gpt-5.5')],
  worker: [t('openai', 'gpt-5.4')],
  utility: [t('groq', 'llama-3.3-70b')]
});

function captureWarnings(fn) {
  const lines = [];
  const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
  try { return { value: fn(), lines }; } finally { remove(); }
}

describe('case roles', () => {
  it('map onto model roles', () => {
    assert.deepStrictEqual([...ROLES], ['orient', 'classify', 'draft', 'judge', 'verify']);
    assert.deepStrictEqual({ ...CASE_ROLE_TO_MODEL_ROLE }, { orient: 'utility', classify: 'utility', draft: 'worker', judge: 'main', verify: 'main' });
    assert.deepStrictEqual(DEFAULT_ROLES.judge, { role: 'main' });
    const m = work();
    assert.strictEqual(resolveCaseRole('orient', { turnModels: m }).provider, 'groq');
    assert.strictEqual(resolveCaseRole('classify', { turnModels: m }).model, 'llama-3.3-70b');
    assert.strictEqual(resolveCaseRole('draft', { turnModels: m }).model, 'gpt-5.4');
    const judge = resolveCaseRole('judge', { turnModels: m });
    assert.deepStrictEqual([judge.caseRole, judge.modelRole, judge.provider, judge.model, judge.targets.length], ['judge', 'main', 'anthropic', 'claude-sonnet-4-5', 2]);
  });

  it('read tier names as the mapped role, with case.yaml over settings over the default', () => {
    assert.deepStrictEqual(caseRoleSpec('judge', { settings: { cases: { roles: { judge: { tier: 'standard' } } } } }), { modelRole: 'worker', explicit: null });
    assert.deepStrictEqual(
      caseRoleSpec('orient', { caseMeta: { roles: { orient: { tier: 'smart' } } }, settings: { cases: { roles: { orient: { tier: 'standard' } } } } }),
      { modelRole: 'main', explicit: null }
    );
    assert.deepStrictEqual(caseRoleSpec('draft', { caseMeta: { roles: { draft: { role: 'utility' } } } }), { modelRole: 'utility', explicit: null });
    const explicit = resolveCaseRole('judge', { turnModels: work(), caseMeta: { roles: { judge: { provider: 'OpenRouter', model: 'mistralai/mistral-large' } } } });
    assert.deepStrictEqual([explicit.provider, explicit.model, explicit.targets.length], ['openrouter', 'mistralai/mistral-large', 1]);
    const { value, lines } = captureWarnings(() => caseRoleSpec('draft', { caseMeta: { roles: { draft: { provider: 'openai', tier: 'fast' } } } }));
    assert.deepStrictEqual(value, { modelRole: 'utility', explicit: null });
    assert.ok(lines.some((l) => /names the provider openai with no model/.test(l)), lines.join('\n'));
    assert.throws(() => caseRoleSpec('boss', {}), /Unknown case role "boss"/);
  });

  it('ask for tool calling on orient and judge only', () => {
    const seen = [];
    const m = models({ main: [t('openai', 'gpt-5.5')], utility: [t('groq', 'x')] }, { explain: (_p, model, { needs }) => { seen.push([model, needs]); return usable(); } });
    resolveCaseRole('orient', { turnModels: m });
    resolveCaseRole('judge', { turnModels: m });
    resolveCaseRole('draft', { turnModels: m });
    assert.deepStrictEqual(seen, [['x', { toolCall: true }], ['gpt-5.5', { toolCall: true }], ['gpt-5.5', {}]]);
  });

  it('treat an openrouter model prefix as its provider family', () => {
    assert.strictEqual(providerFamily('openrouter', 'anthropic/claude-3.5-sonnet'), 'anthropic');
    assert.strictEqual(providerFamily('OpenAI', 'gpt-4o'), 'openai');
    assert.strictEqual(providerFamily('openrouter', 'auto'), 'openrouter');
  });

  it('verify takes the first main model of another provider family than judge', () => {
    const { value, lines } = captureWarnings(() => resolveCaseRole('verify', { turnModels: work() }));
    assert.deepStrictEqual([value.caseRole, value.provider, value.model, value.targets.length], ['verify', 'openai', 'gpt-5.5', 1]);
    assert.deepStrictEqual(lines, []);
  });

  it('verify falls back to the judge with a warning when main has one family only', () => {
    const m = models({ main: [t('anthropic', 'claude-sonnet-4-5'), t('anthropic', 'claude-opus-4-1')] });
    const { value, lines } = captureWarnings(() => resolveCaseRole('verify', { turnModels: m }));
    assert.deepStrictEqual([value.caseRole, value.provider, value.model], ['verify', 'anthropic', 'claude-sonnet-4-5']);
    assert.ok(lines.some((l) => l.includes("verify falls back to the judge's provider family (anthropic)")), lines.join('\n'));
  });

  it('honours an explicit case.yaml verify with a warning when it matches the judge family', () => {
    const caseMeta = { roles: { verify: { provider: 'anthropic', model: 'claude-haiku-4-5' } } };
    const { value, lines } = captureWarnings(() => resolveCaseRole('verify', { turnModels: work(), caseMeta }));
    assert.deepStrictEqual([value.provider, value.model], ['anthropic', 'claude-haiku-4-5']);
    assert.ok(lines.some((l) => /same provider family as judge/.test(l)), lines.join('\n'));
  });

  // fix round 1: judge can still answer through an explicit case.yaml
  // target even when the plain main role has nothing usable; verify has
  // no target of its own then, so it takes judge's instead of throwing.
  it('verify falls back to judge\'s target when main itself has no usable model', () => {
    const explain = (p, model) => (p === 'openai' && model === 'gpt-4o' ? usable() : { usable: false, reasons: ['No token saved.'], notes: [] });
    const m = models({}, { explain });
    const caseMeta = { roles: { judge: { provider: 'openai', model: 'gpt-4o' } } };
    const { value, lines } = captureWarnings(() => resolveCaseRole('verify', { turnModels: m, caseMeta }));
    assert.deepStrictEqual([value.caseRole, value.provider, value.model], ['verify', 'openai', 'gpt-4o']);
    assert.ok(lines.some((l) => l.includes('verify falls back to judge\'s target')), lines.join('\n'));
  });

  it('an unusable case main override fails the resolve with the reason', () => {
    const explain = (p) => (p === 'groq' ? { usable: false, reasons: ['No token saved for Groq.'], notes: [] } : usable());
    const m = models({ main: [t('openai', 'gpt-5.5')] }, { explain, mainOverride: t('groq', 'llama-3.3-70b') });
    assert.throws(() => resolveCaseRole('judge', { turnModels: m }), (err) => err.code === 'MAIN_OVERRIDE_UNUSABLE' && /No token saved for Groq/.test(err.message));
  });

  it('NO_RETRY aborts every failure without waiting', () => {
    assert.deepStrictEqual(NO_RETRY.plan(new Error('503')), { action: 'abort', reason: 'routed', waitMs: 0 });
  });
});

describe('CaseRuntime model roles', () => {
  const roots = [];
  after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });
  const root = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-roles-')); roots.push(d); return d; };
  const settings = () => profileSettings({}, {
    main: [t('anthropic', 'claude-sonnet-4-5'), t('openai', 'gpt-5.5')],
    worker: [t('openai', 'gpt-5.4')],
    utility: [t('groq', 'llama-3.3-70b')],
    vision: [t('openai', 'gpt-5.5')]
  });

  it('roleModel resolves through the profile, case.yaml roles winning', async () => {
    const rt = new CaseRuntime({ root: root(), getSettings: () => ({ ...settings(), cases: { roles: { judge: { tier: 'standard' } } } }) });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const judge = rt.roleModel(info.id, 'judge');
    assert.deepStrictEqual([judge.provider, judge.model], ['openai', 'gpt-5.4']);
    rt.store.updateMeta(info.id, { roles: { judge: { provider: 'gemini', model: 'gemini-2.5-pro' } } });
    assert.strictEqual(rt.roleModel(info.id, 'judge').model, 'gemini-2.5-pro');
    assert.deepStrictEqual(rt.visionTarget(info.id).targets, [{ provider: 'openai', model: 'gpt-5.5', effort: null }]);
    assert.deepStrictEqual(rt.visionTarget(info.id).skipped, []);
  });

  // fix round 1: visionTarget names why, not just that nothing was found.
  it('visionTarget names every skipped target and its reason, for a profile with only text-only models', async () => {
    const textOnly = createTurnModels({
      profile: { id: 'p-1', name: 'Work', kind: 'user', roles: { main: [t('openai', 'gpt-5.4')], worker: [], utility: [] } },
      explain: (_p, model, { needs } = {}) => (needs.imageInput ? { usable: false, reasons: [`${model} takes no image input.`], notes: [] } : usable())
    });
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings(), host: { snapshotModels: () => textOnly } });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const vt = rt.visionTarget(info.id);
    assert.deepStrictEqual(vt.targets, []);
    assert.strictEqual(vt.skipped.length, 1);
    assert.deepStrictEqual(vt.skipped[0].target, t('openai', 'gpt-5.4'));
    assert.match(vt.skipped[0].reasons[0], /takes no image input/);
  });

  it('follows case.yaml\'s profile and main override, and the host\'s snapshot when it has one', async () => {
    const other = { id: 'p-other', name: 'Other', kind: 'user', roles: { main: [t('xai', 'grok-4.3')], worker: [], utility: [] } };
    const s = settings();
    s.models.profiles.push(other);
    const rt = new CaseRuntime({ root: root(), getSettings: () => s });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    rt.store.updateMeta(info.id, { profile: 'p-other' });
    assert.strictEqual(rt.roleModel(info.id, 'judge').provider, 'xai');
    rt.store.updateMeta(info.id, { mainOverride: t('openai', 'gpt-5.4') });
    assert.strictEqual(rt.roleModel(info.id, 'judge').model, 'gpt-5.4');
    const asked = [];
    const hosted = new CaseRuntime({
      root: root(),
      getSettings: () => s,
      host: { snapshotModels: (req) => { asked.push(req); return createTurnModels({ profile: other, explain: usable }); } }
    });
    const b = await hosted.createCase({ title: 'Other lot' });
    assert.strictEqual(hosted.roleModel(b.id, 'draft').model, 'grok-4.3');
    assert.deepStrictEqual(asked, [{ caseId: b.id, chatId: null }]);
  });

  it('beginTurn freezes the models: a later case.yaml change applies to the next turn', async () => {
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings() });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const turn = await rt.beginTurn(info.id, { turnId: 't1', source: 'owner', ownerMessage: 'x', chatId: 'chat-1' });
    try {
      rt.store.updateMeta(info.id, { mainOverride: t('xai', 'grok-4.3') });
      assert.strictEqual(rt.roleModel(info.id, 'judge', { turn }).provider, 'anthropic');
      assert.strictEqual(rt.roleModel(info.id, 'judge').provider, 'xai');
    } finally {
      await rt.endTurn(turn, { summary: 'done' });
    }
  });

  it('routedProvider sends every call through routeTargets with the role\'s list and the turn signal', async () => {
    const calls = [];
    const router = { routeTargets: async (targets, messages, opts) => { calls.push({ targets, opts }); return { type: 'text', content: 'ok' }; } };
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings(), host: { inferenceRouter: router } });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const controller = new AbortController();
    const turn = { caseId: info.id, turnId: 't1', signal: controller.signal };
    const orient = rt.routedProvider(turn, { role: 'orient' });
    assert.deepStrictEqual([orient.getProviderName(), orient.getDefaultModel()], ['groq', 'llama-3.3-70b']);
    await orient.sendMessage([{ role: 'user', content: 'x' }], { systemPrompt: 'S' });
    await orient.streamMessageWithTools([], [{ name: 'Read' }], {}, () => {});
    assert.deepStrictEqual(calls[0].targets, [t('groq', 'llama-3.3-70b')]);
    assert.strictEqual(calls[0].opts.systemPrompt, 'S');
    assert.strictEqual(calls[0].opts.abortSignal, controller.signal);
    assert.deepStrictEqual(calls[1].opts.tools, [{ name: 'Read' }]);
    assert.strictEqual(typeof calls[1].opts.onChunk, 'function');
    await rt.routedProvider(turn, { role: 'judge' }).sendMessageWithTools([], [{ name: 'Ledger' }], {});
    assert.deepStrictEqual(calls.at(-1).targets, [t('anthropic', 'claude-sonnet-4-5'), t('openai', 'gpt-5.5')]);
    await rt.routedProvider(turn, { targets: [t('openai', 'gpt-5.4')] }).sendMessageWithTools([], [{ name: 'Ledger' }], {});
    assert.deepStrictEqual(calls.at(-1).targets, [t('openai', 'gpt-5.4')]);
    await rt.routedProvider(turn, { target: { provider: 'OpenAI', model: 'gpt-4o' } }).sendMessage([], {});
    assert.deepStrictEqual(calls.at(-1).targets, [t('openai', 'gpt-4o')]);
    assert.throws(() => new CaseRuntime({ root: root() }).routedProvider(turn, { role: 'judge' }), /inference router/);
  });

  it('setModelChoice writes profile and mainOverride to case.yaml and nothing else', async () => {
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings() });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const updated = await rt.setModelChoice(info.id, { mainOverride: t('openai', 'gpt-5.5') });
    assert.deepStrictEqual(updated.mainOverride, t('openai', 'gpt-5.5'));
    await rt.setModelChoice(info.id, { profile: 'p-test', mainOverride: null });
    assert.deepStrictEqual([rt.getCase(info.id).profile, rt.getCase(info.id).mainOverride], ['p-test', null]);
    await assert.rejects(rt.setModelChoice(info.id, { status: 'done' }), /needs profile or mainOverride/);
  });
});
