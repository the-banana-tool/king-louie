// tests/models-suggester.test.js
// The King Louie profile's picking rules (spec 2026-09-27 §7.1) and its
// proposals (§7.2): fixed candidates give fixed picks.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const S = require('../src/models/suggester');

const c = (provider, model, {
  input, output, intelligence = null, agentic = null, toolCall = true, context = 400000,
  imageInput = false, imageOutput = false, textOutput = true, local = false, efforts = []
} = {}) => ({
  provider, model, name: model,
  cost: input === undefined ? null : { input, output },
  scores: { intelligence, agentic },
  toolCall, imageInput, imageOutput, textOutput, context, local, efforts
});

// Blended rates (3 parts input to 1 output): big 11.25, sonnet 6, pro
// 3.4375, mini 0.6875, fast 0.0625, nano 0.1375, image 13.75, local 0.
const CANDIDATES = [
  c('openai', 'big', { input: 5, output: 30, intelligence: 60, agentic: 50, imageInput: true, efforts: ['none', 'low', 'medium', 'high'] }),
  c('anthropic', 'sonnet', { input: 3, output: 15, intelligence: 55, agentic: 48, imageInput: true }),
  c('google', 'pro', { input: 1.25, output: 10, intelligence: 58, agentic: 44, imageInput: true }),
  c('openai', 'mini', { input: 0.25, output: 2, intelligence: 40, agentic: 42, efforts: ['minimal', 'low', 'medium', 'high'] }),
  c('groq', 'fast', { input: 0.05, output: 0.1, intelligence: 32, toolCall: false, context: 128000 }),
  c('openai', 'nano', { input: 0.05, output: 0.4, intelligence: 25, agentic: 20 }),
  c('openai', 'image', { input: 5, output: 40, textOutput: false, imageOutput: true, toolCall: false }),
  c('xai', 'unpriced', { intelligence: 90, agentic: 90 }),
  c('mistral', 'unscored', { input: 0.01, output: 0.01 }),
  c('ollama', 'local', { input: 0, output: 0, local: true })
];

const ids = (list) => list.map((t) => `${t.provider}/${t.model}${t.effort ? `@${t.effort}` : ''}`);

describe('King Louie settings', () => {
  it('default to the spec\'s values and merge key by key', () => {
    assert.deepStrictEqual(S.mergeKingLouieSettings(undefined), { ...S.KING_LOUIE_DEFAULTS, blend: { input: 3, output: 1 } });
    const merged = S.mergeKingLouieSettings({ bandPoints: 5, blend: { output: 2 }, autoAccept: 'yes' });
    assert.deepStrictEqual([merged.bandPoints, merged.blend, merged.autoAccept, merged.workerAgenticRatio], [5, { input: 3, output: 2 }, false, 0.8]);
  });

  it('price by a blended rate, and pick the lowest effort offered', () => {
    assert.strictEqual(S.blendedRate({ input: 5, output: 30 }, { input: 3, output: 1 }), 11.25);
    assert.strictEqual(S.blendedRate(null), null);
    assert.strictEqual(S.lowestEffort(['high', 'low', 'minimal']), 'minimal');
    assert.strictEqual(S.lowestEffort([]), null);
  });

  it('read a candidate from its catalog entry; an unknown model has no price', () => {
    const entry = { name: 'Big', cost: { input: 5, output: 30 }, scores: { intelligence: 60, agentic: 50, source: 'artificial-analysis' }, toolCall: true, input: ['text', 'image'], output: ['text'], limits: { context: 400000 }, local: false, reasoning: { efforts: ['low'] } };
    assert.deepStrictEqual(S.candidateFromEntry({ provider: 'openai', model: 'big', name: 'big' }, entry), {
      provider: 'openai', model: 'big', name: 'Big', cost: { input: 5, output: 30 }, scores: { intelligence: 60, agentic: 50 },
      toolCall: true, imageInput: true, textOutput: true, imageOutput: false, context: 400000, local: false, efforts: ['low']
    });
    assert.strictEqual(S.candidateFromEntry({ provider: 'openai', model: 'x', name: 'x' }, null).cost, null);
  });
});

describe('pickRoles', () => {
  it('fixed candidates give fixed picks', () => {
    const { roles, reasons } = S.pickRoles(CANDIDATES, {});
    // main: big (50) and sonnet (48) are within 3 points; the cheaper wins.
    assert.deepStrictEqual(ids(roles.main), ['anthropic/sonnet', 'openai/big', 'google/pro']);
    // worker: agentic at least 0.8 × 48 and 128K context, cheapest first, spread.
    assert.deepStrictEqual(ids(roles.worker), ['openai/mini', 'google/pro', 'anthropic/sonnet']);
    // utility: intelligence at least 0.5 × 55, no tool need, lowest effort.
    assert.deepStrictEqual(ids(roles.utility), ['groq/fast', 'openai/mini@minimal', 'google/pro']);
    assert.deepStrictEqual(ids(roles.vision), ['google/pro', 'anthropic/sonnet', 'openai/big']);
    assert.deepStrictEqual(ids(roles.imageGeneration), ['openai/image']);
    assert.match(reasons.main[0], /sonnet: the cheapest of the 2 models within 3 points of the best agentic score \(50\)/);
    assert.match(reasons.worker[0], /at least 80% of main's \(48\)/);
    assert.match(reasons.utility[1], /at minimal effort/);
    for (const role of Object.keys(roles)) assert.strictEqual(reasons[role].length, roles[role].length, role);
  });

  it('never picks an unpriced or unscored model, nor a local one unless asked', () => {
    const all = Object.values(S.pickRoles(CANDIDATES, {}).roles).flat().map((t) => t.model);
    for (const never of ['unpriced', 'unscored', 'local']) assert.ok(!all.includes(never), never);
  });

  it('puts a local model with tool support first in utility when preferLocalUtility is on', () => {
    const { roles, reasons } = S.pickRoles(CANDIDATES, { preferLocalUtility: true });
    assert.deepStrictEqual(ids(roles.utility), ['ollama/local', 'groq/fast', 'openai/mini@minimal']);
    assert.match(reasons.utility[0], /local model with tool support/);
    // vision never takes the local preference.
    assert.ok(!roles.vision.some((t) => t.provider === 'ollama'));
  });

  it('follows its thresholds', () => {
    assert.deepStrictEqual(ids(S.pickRoles(CANDIDATES, { workerAgenticRatio: 0.95 }).roles.worker), ['anthropic/sonnet', 'openai/big']);
    assert.deepStrictEqual(ids(S.pickRoles(CANDIDATES, { bandPoints: 0 }).roles.main), ['openai/big', 'anthropic/sonnet', 'google/pro']);
    assert.deepStrictEqual(ids(S.pickRoles(CANDIDATES, { utilityIntelligenceRatio: 1 }).roles.utility), ['google/pro', 'anthropic/sonnet', 'openai/big@none']);
  });

  it('says why when nothing can be main', () => {
    const out = S.pickRoles(CANDIDATES.filter((x) => ['unpriced', 'unscored', 'local', 'fast'].includes(x.model)), {});
    assert.match(out.unavailable, /No usable model that calls tools has both a price and an agentic score/);
    assert.deepStrictEqual(S.pickRoles([], {}).unavailable, out.unavailable);
  });

  it('a main pick with no intelligence score leaves utility and vision empty, with a reason', () => {
    const { roles, reasons } = S.pickRoles([c('openai', 'agent-only', { input: 1, output: 2, agentic: 50, imageInput: true })], {});
    assert.deepStrictEqual(ids(roles.main), ['openai/agent-only']);
    assert.deepStrictEqual(ids(roles.worker), ['openai/agent-only']);
    assert.deepStrictEqual([roles.utility, roles.vision], [[], []]);
    assert.match(reasons.utility[0], /no intelligence score/);
    assert.match(reasons.vision[0], /No usable image-reading model qualifies/);
  });
});

describe('buildProposal', () => {
  const picks = S.pickRoles(CANDIDATES, {});
  const price = (t) => ({ fast: 0.15, sonnet: 2, 'agent-only': 0.4 })[t.model] ?? null;

  it('proposes every picked role on first run, with a stable id', () => {
    const p = S.buildProposal({ picks, current: null, price, nameOf: (t) => t.model.toUpperCase() });
    assert.deepStrictEqual(p.changes.map((x) => x.role), ['main', 'worker', 'utility', 'vision', 'imageGeneration']);
    assert.match(p.id, /^[0-9a-f]{16}$/);
    assert.strictEqual(p.id, S.proposalId(picks.roles));
    assert.strictEqual(p.upToDate, false);
    assert.deepStrictEqual(p.changes[0].to[0], { provider: 'anthropic', model: 'sonnet', effort: null, name: 'SONNET' });
  });

  it('lists only the roles that change, and nothing once accepted', () => {
    const current = { ...picks.roles, utility: [{ provider: 'openai', model: 'mini', effort: null }] };
    assert.deepStrictEqual(S.buildProposal({ picks, current, price }).changes.map((x) => x.role), ['utility']);
    const same = S.buildProposal({ picks, current: picks.roles, price });
    assert.deepStrictEqual([same.upToDate, same.id, same.changes], [true, null, []]);
  });

  it('estimates the monthly cost effect from recent usage, repriced', () => {
    const usage = {
      utility: { calls: 10, unpricedCalls: 0, cost: 0.5, usage: { input: 1e6, cachedInput: 0, cacheWrite: 0, output: 1e6, reasoning: 0 } },
      main: { calls: 4, unpricedCalls: 1, cost: 1, usage: { input: 10, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: 0 } }
    };
    const p = S.buildProposal({ picks, current: null, usage, price });
    const effect = (role) => p.changes.find((x) => x.role === role).costEffect;
    assert.deepStrictEqual(effect('utility'), { usd: -0.35, note: '10 calls in the last 30 days, repriced.' });
    assert.strictEqual(effect('main').usd, 1);
    assert.match(effect('main').note, /1 were unpriced, so their recorded cost is incomplete/);
    assert.deepStrictEqual(effect('worker'), { usd: null, note: 'No recorded calls in the last 30 days.' });
    assert.strictEqual(p.costEffect.usd, 0.65);
  });

  it('prices an empty proposed role on the role it borrows from', () => {
    const lean = S.pickRoles([c('openai', 'agent-only', { input: 1, output: 2, agentic: 50 })], {});
    const usage = { utility: { calls: 2, unpricedCalls: 0, cost: 0.1, usage: { input: 1, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 } } };
    const p = S.buildProposal({ picks: lean, current: { main: [], worker: [], utility: [{ provider: 'groq', model: 'fast', effort: null }] }, usage, price });
    assert.deepStrictEqual(p.changes.find((x) => x.role === 'utility').costEffect.usd, 0.3);
  });
});
