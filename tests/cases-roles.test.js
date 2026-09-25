// tests/cases-roles.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { addSink } = require('../src/logging');
const { resolveRole, providerFamily, tierTarget, NO_RETRY, ROLES, DEFAULT_ROLES } = require('../src/cases/roles');

const settings = (over = {}) => ({
  activeProvider: 'openai',
  inference: {
    tierMap: {
      fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      standard: { provider: 'openai', model: 'gpt-4o-mini' },
      smart: { provider: 'anthropic', model: 'claude-sonnet-4' }
    }
  },
  ...over
});

function captureWarnings(fn) {
  const lines = [];
  const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
  try { return { value: fn(), lines }; } finally { remove(); }
}

describe('resolveRole', () => {
  it('names five roles with the spec defaults', () => {
    assert.deepStrictEqual([...ROLES], ['orient', 'classify', 'draft', 'judge', 'verify']);
    assert.deepStrictEqual(DEFAULT_ROLES.judge, { tier: 'smart' });
    assert.deepStrictEqual(DEFAULT_ROLES.orient, { tier: 'fast' });
  });

  it('resolves a tier through the tier map, falling back to the active provider', () => {
    assert.deepStrictEqual(resolveRole('orient', { settings: settings() }), { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'fast' });
    assert.deepStrictEqual(tierTarget('smart', { activeProvider: 'Gemini' }), { provider: 'gemini', model: '', tier: 'smart' });
    assert.deepStrictEqual(tierTarget('bogus', settings()), { provider: 'openai', model: 'gpt-4o-mini', tier: 'standard' });
  });

  it('prefers case.yaml roles over settings.cases.roles over the defaults', () => {
    const s = settings({ cases: { roles: { judge: { tier: 'standard' } } } });
    assert.deepStrictEqual(resolveRole('judge', { settings: s }), { provider: 'openai', model: 'gpt-4o-mini', tier: 'standard' });
    const caseMeta = { roles: { judge: { provider: 'OpenRouter', model: 'mistralai/mistral-large' } } };
    assert.deepStrictEqual(resolveRole('judge', { settings: s, caseMeta }), { provider: 'openrouter', model: 'mistralai/mistral-large', tier: 'standard' });
    assert.deepStrictEqual(resolveRole('draft', { settings: s, caseMeta: { roles: { draft: { provider: 'openai', tier: 'fast' } } } }), { provider: 'openai', model: '', tier: 'fast' });
    assert.throws(() => resolveRole('boss', { settings: s }), /Unknown case role "boss"/);
  });

  it('treats an openrouter model prefix as its provider family', () => {
    assert.strictEqual(providerFamily('openrouter', 'anthropic/claude-3.5-sonnet'), 'anthropic');
    assert.strictEqual(providerFamily('OpenAI', 'gpt-4o'), 'openai');
    assert.strictEqual(providerFamily('openrouter', 'auto'), 'openrouter');
  });

  it('moves verify to another provider family when judge and verify would match', () => {
    const { value, lines } = captureWarnings(() => resolveRole('verify', { settings: settings() }));
    assert.deepStrictEqual(value, { provider: 'openai', model: 'gpt-4o-mini', tier: 'standard' });
    assert.deepStrictEqual(lines, []);
  });

  it('skips a candidate whose provider has no token, and falls back to the judge with a warning', () => {
    const noOpenai = captureWarnings(() => resolveRole('verify', { settings: settings(), hasToken: (p) => p !== 'openai' }));
    assert.deepStrictEqual(noOpenai.value, { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'fast' });
    const none = captureWarnings(() => resolveRole('verify', { settings: settings(), hasToken: () => false }));
    assert.deepStrictEqual(none.value, { provider: 'anthropic', model: 'claude-sonnet-4', tier: 'smart' });
    assert.ok(none.lines.some((l) => l.includes("verify falls back to the judge's provider family (anthropic)")), none.lines.join('\n'));
  });

  it('honours an explicit case.yaml verify with a warning when it matches the judge family', () => {
    const caseMeta = { roles: { verify: { provider: 'anthropic', model: 'claude-haiku-4' } } };
    const { value, lines } = captureWarnings(() => resolveRole('verify', { settings: settings(), caseMeta }));
    assert.deepStrictEqual(value, { provider: 'anthropic', model: 'claude-haiku-4', tier: 'standard' });
    assert.ok(lines.some((l) => /same provider family as judge/.test(l)), lines.join('\n'));
  });

  it('NO_RETRY aborts every failure without waiting', () => {
    assert.deepStrictEqual(NO_RETRY.plan(new Error('503')), { action: 'abort', reason: 'routed', waitMs: 0 });
  });
});

describe('roleModel and routedProvider', () => {
  const { after } = require('node:test');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { CaseRuntime } = require('../src/cases');
  const roots = [];
  after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });
  const root = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-roles-')); roots.push(d); return d; };

  it('roleModel prefers case.yaml roles over settings', async () => {
    const rt = new CaseRuntime({ root: root(), getSettings: () => ({ ...settings(), cases: { roles: { judge: { tier: 'standard' } } } }) });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    assert.deepStrictEqual(rt.roleModel(info.id, 'judge'), { provider: 'openai', model: 'gpt-4o-mini', tier: 'standard' });
    rt.store.updateMeta(info.id, { roles: { judge: { provider: 'gemini', model: 'gemini-2.0-pro' } } });
    assert.deepStrictEqual(rt.roleModel(info.id, 'judge'), { provider: 'gemini', model: 'gemini-2.0-pro', tier: 'standard' });
  });

  it('routedProvider sends every call through routeWithFallback with the target, refreshing the token once', async () => {
    const calls = [];
    const router = { routeWithFallback: async (tier, messages, opts) => { calls.push({ tier, opts }); return { type: 'text', content: 'ok' }; } };
    const host = { inferenceRouter: router, resolveInference: async (sel) => { calls.push({ resolve: sel }); } };
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings(), host });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const controller = new AbortController();
    const turn = { caseId: info.id, turnId: 't1', signal: controller.signal };
    const orient = rt.routedProvider(turn, { role: 'orient' });
    assert.deepStrictEqual([orient.getProviderName(), orient.getDefaultModel()], ['groq', 'llama-3.3-70b-versatile']);
    await orient.sendMessage([{ role: 'user', content: 'x' }], { systemPrompt: 'S' });
    await orient.streamMessageWithTools([], [{ name: 'Read' }], {}, () => {});
    assert.strictEqual(calls.filter((c) => c.resolve).length, 1);
    assert.deepStrictEqual(calls[0], { resolve: { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'fast' } });
    assert.strictEqual(calls[1].tier, 'fast');
    assert.deepStrictEqual(calls[1].opts.target, { provider: 'groq', model: 'llama-3.3-70b-versatile' });
    assert.strictEqual(calls[1].opts.systemPrompt, 'S');
    assert.strictEqual(calls[1].opts.abortSignal, controller.signal);
    assert.deepStrictEqual(calls[2].opts.tools, [{ name: 'Read' }]);
    assert.strictEqual(typeof calls[2].opts.onChunk, 'function');
    const owner = rt.routedProvider(turn, { target: { provider: 'OpenAI', model: 'gpt-4o' }, tier: 'smart' });
    await owner.sendMessageWithTools([], [{ name: 'Ledger' }], {});
    assert.deepStrictEqual([calls.at(-1).tier, calls.at(-1).opts.target], ['smart', { provider: 'openai', model: 'gpt-4o' }]);
    assert.throws(() => new CaseRuntime({ root: root() }).routedProvider(turn, { role: 'judge' }), /inference router/);
  });
});
