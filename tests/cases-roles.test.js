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
