// tests/egress-resolver.test.js
// The egress policy in the resolver (spec 2026-10-13-local-inference-design.md
// §7.1, §7.2 item 1, §7.3; R-LI-8, R-LI-22, R-LI-30, R-LI-31): under a policy
// a role's targets are local models the guarantee accepts, borrowing happens
// only among them, and nothing resolves to a hosted model.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTurnModels, NoUsableModelError } = require('../src/models/resolver');
const { EGRESS_REASONS, egressPolicy, normalizePolicy, isLocalProvider, targetAllowed, refusalCode } = require('../src/models/egress');

const t = (provider, model, effort = null) => ({ provider, model, effort });

const OPENAI = t('openai', 'gpt-5.4-mini');
const ANTHROPIC = t('anthropic', 'claude-sonnet-4-5');
const OLLAMA = t('ollama', 'qwen3:8b');
const LOCAL = t('local', 'workstation/qwen3:8b');
const LOCAL_2 = t('local', 'workstation/llama3.2:3b');
const LAN = t('local', 'lan-box/qwen3:8b');
const LAN_REASON = 'LAN box answers over plain http on your network.';

// Every target is usable unless listed. `seen` records what explain was asked.
function explainer(unusable = {}, { images = [] } = {}) {
  const seen = [];
  const explain = (provider, model, { needs = {} } = {}) => {
    seen.push(`${provider}/${model}`);
    const reasons = [];
    if (unusable[`${provider}/${model}`]) reasons.push(unusable[`${provider}/${model}`]);
    if (needs.imageInput && !images.includes(`${provider}/${model}`)) reasons.push(`${model} takes no image input.`);
    return { usable: reasons.length === 0, reasons, notes: [] };
  };
  return { explain, seen };
}

// The registry's answer: workstation/ is guarantee-grade, lan-box/ is cost-only.
const isGuaranteeTarget = (target) => {
  if (target.provider !== 'local') return false;
  if (target.model.startsWith('workstation/')) return true;
  if (target.model.startsWith('lan-box/')) return LAN_REASON;
  return false;
};

const profile = (roles, extra = {}) => ({ id: 'p-1', name: 'Work', kind: 'user', roles: { main: [], worker: [], utility: [], ...roles }, ...extra });
const PRIVATE = egressPolicy({ reason: 'private-chat', chatId: 'c-1' });

function models(roles, options = {}) {
  const { explain, seen } = options.explainer || explainer();
  const m = createTurnModels({ profile: profile(roles), explain, isGuaranteeTarget, ...options, explainer: undefined });
  return Object.assign(Object.create(m), { seen });
}

describe('egress', () => {
  it('egressPolicy is frozen and refuses an unknown reason', () => {
    assert.deepStrictEqual([...EGRESS_REASONS], ['private-chat', 'private-case', 'local-only-role', 'unknown-mark']);
    assert.ok(Object.isFrozen(EGRESS_REASONS));
    const policy = egressPolicy({ reason: 'private-chat', chatId: 'c-1' });
    assert.deepStrictEqual(policy, { localOnly: true, reason: 'private-chat', chatId: 'c-1', caseId: null });
    assert.ok(Object.isFrozen(policy));
    assert.deepStrictEqual(egressPolicy({ reason: 'private-case', caseId: 'k-1' }), { localOnly: true, reason: 'private-case', chatId: null, caseId: 'k-1' });
    assert.deepStrictEqual(egressPolicy({ reason: 'local-only-role', role: 'utility' }), { localOnly: true, reason: 'local-only-role', chatId: null, caseId: null, role: 'utility' });
    for (const bad of [{ reason: 'public' }, { reason: '' }, {}, undefined, null]) {
      assert.throws(() => egressPolicy(bad), /reason/);
    }
  });

  it('normalizePolicy: nothing is no policy; anything unreadable is the unknown-mark policy', () => {
    assert.strictEqual(normalizePolicy(null), null);
    assert.strictEqual(normalizePolicy(undefined), null);
    assert.strictEqual(normalizePolicy(PRIVATE), PRIVATE);
    assert.deepStrictEqual(normalizePolicy({ localOnly: true, reason: 'private-case', chatId: null, caseId: 'k-1' }), egressPolicy({ reason: 'private-case', caseId: 'k-1' }));
    for (const odd of [false, 0, '', true, 'private-chat', {}, { localOnly: false, reason: 'private-chat' }, { localOnly: true, reason: 'nope' }, { localOnly: true }, []]) {
      const policy = normalizePolicy(odd);
      assert.strictEqual(policy.localOnly, true, JSON.stringify(odd));
      assert.strictEqual(policy.reason, 'unknown-mark', JSON.stringify(odd));
    }
  });

  it('isLocalProvider is the local provider key and nothing else', () => {
    assert.strictEqual(isLocalProvider('local'), true);
    for (const p of ['ollama', 'openai', 'Local', 'local ', 'lmstudio', '', null, undefined, {}]) assert.strictEqual(isLocalProvider(p), false, String(p));
  });

  it('targetAllowed: no policy allows everything; a policy allows only a guarantee-grade local target', () => {
    assert.strictEqual(targetAllowed(null, OPENAI, isGuaranteeTarget), true);
    assert.strictEqual(targetAllowed(undefined, OPENAI, null), true);
    assert.strictEqual(targetAllowed(PRIVATE, LOCAL, isGuaranteeTarget), true);
    assert.strictEqual(targetAllowed(PRIVATE, OPENAI, isGuaranteeTarget), 'openai/gpt-5.4-mini is not a local model and this chat is private.');
    assert.strictEqual(targetAllowed(egressPolicy({ reason: 'private-case', caseId: 'k-1' }), OPENAI, isGuaranteeTarget), 'openai/gpt-5.4-mini is not a local model and this case is private.');
    assert.strictEqual(targetAllowed(egressPolicy({ reason: 'local-only-role', role: 'utility' }), OPENAI, isGuaranteeTarget), 'openai/gpt-5.4-mini is not a local model and utility is local-only.');
    assert.match(targetAllowed(egressPolicy({ reason: 'unknown-mark' }), OPENAI, isGuaranteeTarget), /^openai\/gpt-5\.4-mini is not a local model and /);
    assert.strictEqual(targetAllowed(PRIVATE, LAN, isGuaranteeTarget), LAN_REASON);
    assert.match(targetAllowed(PRIVATE, OLLAMA, isGuaranteeTarget), /^ollama\/qwen3:8b is not a local model/);
  });

  it('targetAllowed fails closed', () => {
    const refuses = (value) => assert.strictEqual(typeof value, 'string');
    // No registry to ask: every target is refused.
    refuses(targetAllowed(PRIVATE, LOCAL, null));
    refuses(targetAllowed(PRIVATE, LOCAL, undefined));
    refuses(targetAllowed(PRIVATE, LOCAL));
    // A registry that does not say exactly true.
    for (const answer of [false, undefined, null, 1, 'true', {}, '']) refuses(targetAllowed(PRIVATE, LOCAL, () => answer));
    refuses(targetAllowed(PRIVATE, LOCAL, () => { throw new Error('registry unreadable'); }));
    // A registry that vouches for a hosted provider is not believed.
    refuses(targetAllowed(PRIVATE, OPENAI, () => true));
    refuses(targetAllowed(PRIVATE, OLLAMA, () => true));
    // Something that is not a policy made by egressPolicy still restricts.
    for (const odd of [false, 0, '', {}, { localOnly: false }, 'private']) refuses(targetAllowed(odd, OPENAI, isGuaranteeTarget));
    // A target that is not a target.
    for (const target of [null, undefined, {}, { provider: 'local' }, 'local/workstation/qwen3:8b']) refuses(targetAllowed(PRIVATE, target, () => true));
  });

  it('refusalCode', () => {
    assert.strictEqual(refusalCode(PRIVATE), 'PRIVATE_NO_LOCAL_MODEL');
    assert.strictEqual(refusalCode(egressPolicy({ reason: 'private-case', caseId: 'k-1' })), 'PRIVATE_NO_LOCAL_MODEL');
    assert.strictEqual(refusalCode(egressPolicy({ reason: 'unknown-mark' })), 'PRIVATE_NO_LOCAL_MODEL');
    assert.strictEqual(refusalCode(egressPolicy({ reason: 'local-only-role', role: 'utility' })), 'LOCAL_ONLY_ROLE_NO_MODEL');
    assert.strictEqual(refusalCode({}), 'PRIVATE_NO_LOCAL_MODEL');
  });
});

describe('TurnModels under an egress policy', () => {
  it('no policy: every existing resolution is unchanged', () => {
    const customRoles = [{ id: 'legal-drafting', description: '', needs: {}, fallback: 'worker' }];
    const roles = { main: [OPENAI, LOCAL], worker: [], utility: [], vision: [], imageGeneration: [] };
    const m = createTurnModels({ profile: profile(roles), customRoles, explain: explainer({}, { images: ['openai/gpt-5.4-mini'] }).explain });
    const base = { skipped: [], borrowedFrom: null, override: false, explicit: false, useSettings: false, egress: null };
    assert.strictEqual(m.egress, null);
    for (const role of ['main', 'worker', 'utility', 'vision', 'imageGeneration', 'legal-drafting']) assert.strictEqual(m.egressFor(role), null);
    assert.deepStrictEqual(m.resolve('main'), { role: 'main', targets: [OPENAI, LOCAL], ...base });
    assert.deepStrictEqual(m.resolve('worker'), { role: 'worker', targets: [OPENAI, LOCAL], ...base, borrowedFrom: 'main' });
    assert.deepStrictEqual(m.resolve('utility'), { role: 'utility', targets: [OPENAI, LOCAL], ...base, borrowedFrom: 'main' });
    assert.deepStrictEqual(m.resolve('vision'), { role: 'vision', targets: [OPENAI], ...base, borrowedFrom: 'main' });
    assert.deepStrictEqual(m.resolve('imageGeneration'), { role: 'imageGeneration', targets: [], ...base, useSettings: true });
    assert.deepStrictEqual(m.resolve('legal-drafting'), { role: 'legal-drafting', targets: [OPENAI, LOCAL], ...base, borrowedFrom: 'main' });
    assert.deepStrictEqual(m.resolve('main', { explicit: ANTHROPIC }), { role: 'main', targets: [ANTHROPIC], ...base, explicit: true });
    assert.deepStrictEqual(m.candidatesFor('utility'), [OPENAI, LOCAL]);

    const over = createTurnModels({ profile: profile(roles), mainOverride: ANTHROPIC, explain: explainer().explain });
    assert.deepStrictEqual(over.resolve('main'), { role: 'main', targets: [ANTHROPIC], ...base, override: true });
    assert.deepStrictEqual(over.resolve('worker').targets, [OPENAI, LOCAL]);

    // Without a policy the registry is never asked, and its absence changes nothing.
    const asked = [];
    const quiet = createTurnModels({ profile: profile(roles), explain: explainer().explain, isGuaranteeTarget: (x) => { asked.push(x); return true; } });
    quiet.resolve('main');
    quiet.resolve('utility');
    quiet.candidatesFor('worker');
    assert.deepStrictEqual(asked, []);

    // The errors are today's.
    const none = createTurnModels({ profile: profile({}), explain: explainer().explain });
    assert.throws(() => none.mustResolve('main'), (err) => err.code === 'NO_USABLE_MODEL' && /main has no models in the profile "Work"/.test(err.message));
    const bad = createTurnModels({ profile: profile(roles), mainOverride: ANTHROPIC, explain: explainer({ 'anthropic/claude-sonnet-4-5': 'No key.' }).explain });
    assert.throws(() => bad.mustResolve('main'), (err) => err.code === 'MAIN_OVERRIDE_UNUSABLE');
  });

  it('R-LI-8: a hosted target is skipped under a policy', () => {
    const m = models({ main: [OPENAI, LOCAL, ANTHROPIC, LOCAL_2] }, { egress: PRIVATE });
    const r = m.resolve('main');
    assert.deepStrictEqual(r.targets, [LOCAL, LOCAL_2], 'the order of the local targets is kept');
    assert.deepStrictEqual(r.skipped, [
      { target: OPENAI, reasons: ['openai/gpt-5.4-mini is not a local model and this chat is private.'] },
      { target: ANTHROPIC, reasons: ['anthropic/claude-sonnet-4-5 is not a local model and this chat is private.'] }
    ]);
    assert.strictEqual(r.egress, PRIVATE);
    assert.strictEqual(m.egress, PRIVATE);
    assert.strictEqual(m.egressFor('main'), PRIVATE);
    assert.strictEqual(m.egressFor('legal-drafting'), PRIVATE);
    assert.deepStrictEqual(m.seen, ['local/workstation/qwen3:8b', 'local/workstation/llama3.2:3b'], 'a dropped target is never put to explain');
    assert.deepStrictEqual(m.candidatesFor('main'), [LOCAL, LOCAL_2]);
    assert.deepStrictEqual(m.configuredFor('main'), [OPENAI, LOCAL, ANTHROPIC, LOCAL_2], 'the profile itself reads as it is');
  });

  it('R-LI-8: a local target that is not usable is skipped with its own reason, and nothing hosted takes its place', () => {
    const m = models({ main: [LOCAL, OPENAI] }, { egress: PRIVATE, explainer: explainer({ 'local/workstation/qwen3:8b': 'Workstation did not answer.' }) });
    const r = m.resolve('main');
    assert.deepStrictEqual(r.targets, []);
    assert.deepStrictEqual(r.skipped.map((s) => s.reasons[0]), ['openai/gpt-5.4-mini is not a local model and this chat is private.', 'Workstation did not answer.']);
    assert.throws(() => m.mustResolve('main'), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
  });

  it('R-LI-31: an ollama target is skipped under a policy', () => {
    const m = models({ main: [OLLAMA, LOCAL] }, { egress: PRIVATE, isGuaranteeTarget: () => true });
    const r = m.resolve('main');
    assert.deepStrictEqual(r.targets, [LOCAL]);
    assert.deepStrictEqual(r.skipped, [{ target: OLLAMA, reasons: ['ollama/qwen3:8b is not a local model and this chat is private.'] }]);
    const only = models({ main: [OLLAMA] }, { egress: PRIVATE, isGuaranteeTarget: () => true });
    assert.throws(() => only.mustResolve('main'), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
  });

  it('R-LI-30: a cost-only local target is skipped under a policy', () => {
    const m = models({ main: [LAN, LOCAL] }, { egress: PRIVATE });
    const r = m.resolve('main');
    assert.deepStrictEqual(r.targets, [LOCAL]);
    assert.deepStrictEqual(r.skipped, [{ target: LAN, reasons: [LAN_REASON] }]);
    const only = models({ main: [LAN] }, { egress: PRIVATE });
    assert.throws(() => only.mustResolve('main'), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL' && err.message.includes(LAN_REASON));
    // With no policy the same target is an ordinary one.
    assert.deepStrictEqual(models({ main: [LAN] }).resolve('main').targets, [LAN]);
  });

  it('R-LI-22: utility borrows a local worker, never a hosted one', () => {
    const a = models({ utility: [OPENAI], worker: [LOCAL], main: [ANTHROPIC] }, { egress: PRIVATE });
    const ra = a.resolve('utility');
    assert.deepStrictEqual([ra.targets, ra.borrowedFrom], [[LOCAL], 'worker']);
    assert.deepStrictEqual(ra.skipped, [{ target: OPENAI, reasons: ['openai/gpt-5.4-mini is not a local model and this chat is private.'] }]);
    assert.deepStrictEqual(a.candidatesFor('utility'), [LOCAL]);

    const b = models({ utility: [OPENAI], worker: [OPENAI], main: [ANTHROPIC, LOCAL] }, { egress: PRIVATE });
    const rb = b.resolve('utility');
    assert.deepStrictEqual([rb.targets, rb.borrowedFrom], [[LOCAL], 'main']);
    assert.strictEqual(rb.skipped.length, 3, 'every hosted target passed over is named');
    assert.deepStrictEqual(b.resolve('worker').targets, [LOCAL]);
    assert.strictEqual(b.resolve('worker').borrowedFrom, 'main');

    // Its own local model wins over a stronger role's.
    const c = models({ utility: [OPENAI, LOCAL_2], worker: [LOCAL], main: [LOCAL] }, { egress: PRIVATE });
    assert.deepStrictEqual([c.resolve('utility').targets, c.resolve('utility').borrowedFrom], [[LOCAL_2], null]);

    // An empty utility borrows too, and main never borrows from a weaker role.
    const d = models({ utility: [], worker: [LOCAL], main: [OPENAI] }, { egress: PRIVATE });
    assert.deepStrictEqual([d.resolve('utility').targets, d.resolve('utility').borrowedFrom], [[LOCAL], 'worker']);
    assert.deepStrictEqual(d.resolve('main').targets, []);
    assert.throws(() => d.mustResolve('main'), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
  });

  it('R-LI-22: a borrow under a policy takes main\'s own list, never the main override', () => {
    const m = models({ utility: [], worker: [], main: [LOCAL] }, { egress: PRIVATE, mainOverride: LOCAL_2 });
    assert.deepStrictEqual(m.resolve('utility').targets, [LOCAL]);
    assert.deepStrictEqual(m.resolve('main').targets, [LOCAL_2]);
  });

  it('no local target anywhere: resolve returns no targets and mustResolve throws PRIVATE_NO_LOCAL_MODEL', () => {
    const m = models({ utility: [OPENAI], worker: [ANTHROPIC], main: [OPENAI, OLLAMA, LAN] }, { egress: PRIVATE });
    for (const role of ['main', 'worker', 'utility', 'vision']) {
      const r = m.resolve(role);
      assert.deepStrictEqual(r.targets, [], role);
      assert.strictEqual(r.useSettings, false, role);
      assert.ok(r.skipped.length > 0, role);
      assert.deepStrictEqual(m.candidatesFor(role), [], role);
      assert.throws(() => m.mustResolve(role), (err) => {
        assert.ok(err instanceof NoUsableModelError);
        assert.strictEqual(err.code, 'PRIVATE_NO_LOCAL_MODEL');
        assert.strictEqual(err.role, role);
        assert.match(err.message, /This chat is private/);
        assert.match(err.message, /Nothing was sent to a hosted model\.$/);
        return true;
      });
    }
    assert.deepStrictEqual(m.seen, [], 'explain was never asked about a hosted target');
    const empty = models({}, { egress: PRIVATE });
    assert.throws(() => empty.mustResolve('main'), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL' && /Nothing was sent to a hosted model\.$/.test(err.message));
  });

  it('a private case and an unreadable mark are refused the same way', () => {
    const inCase = models({ main: [OPENAI] }, { egress: egressPolicy({ reason: 'private-case', caseId: 'k-1' }) });
    assert.throws(() => inCase.mustResolve('main'), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL' && /This case is private/.test(err.message));
    const unknown = models({ main: [OPENAI, LOCAL] }, { egress: egressPolicy({ reason: 'unknown-mark' }) });
    assert.deepStrictEqual(unknown.resolve('main').targets, [LOCAL]);
    // Something that is not a policy object is read as an unreadable mark, never as no policy.
    for (const odd of [true, 'private', {}, { localOnly: false }, 0, false, '']) {
      const m = models({ main: [OPENAI, LOCAL] }, { egress: odd });
      assert.strictEqual(m.egress.reason, 'unknown-mark', JSON.stringify(odd));
      assert.deepStrictEqual(m.resolve('main').targets, [LOCAL], JSON.stringify(odd));
    }
  });

  it('localOnly: a local-only role is filtered whatever the chat is, and the others are untouched', () => {
    const m = models({ utility: [OPENAI], worker: [ANTHROPIC], main: [OPENAI] }, { localOnly: ['utility'] });
    assert.strictEqual(m.egress, null);
    assert.strictEqual(m.egressFor('main'), null);
    assert.strictEqual(m.egressFor('worker'), null);
    assert.deepStrictEqual(m.egressFor('utility'), { localOnly: true, reason: 'local-only-role', chatId: null, caseId: null, role: 'utility' });
    assert.ok(Object.isFrozen(m.egressFor('utility')));

    const r = m.resolve('utility');
    assert.deepStrictEqual(r.targets, []);
    assert.strictEqual(r.egress.reason, 'local-only-role');
    assert.deepStrictEqual(r.skipped[0], { target: OPENAI, reasons: ['openai/gpt-5.4-mini is not a local model and utility is local-only.'] });
    assert.throws(() => m.mustResolve('utility'), (err) => {
      assert.strictEqual(err.code, 'LOCAL_ONLY_ROLE_NO_MODEL');
      assert.match(err.message, /utility is local-only/);
      assert.match(err.message, /Nothing was sent to a hosted model\.$/);
      return true;
    });

    assert.deepStrictEqual(m.resolve('main'), { role: 'main', targets: [OPENAI], skipped: [], borrowedFrom: null, override: false, explicit: false, useSettings: false, egress: null });
    assert.deepStrictEqual(m.resolve('worker').targets, [ANTHROPIC]);

    const filled = models({ utility: [OPENAI, LOCAL], main: [OPENAI] }, { localOnly: ['utility'] });
    assert.deepStrictEqual(filled.resolve('utility').targets, [LOCAL]);
    const borrows = models({ utility: [], worker: [OPENAI], main: [OPENAI, LOCAL] }, { localOnly: ['utility'] });
    assert.deepStrictEqual([borrows.resolve('utility').targets, borrows.resolve('utility').borrowedFrom], [[LOCAL], 'main']);
  });

  it('localOnly: a list that cannot be read makes every role local-only', () => {
    for (const odd of ['utility', { utility: true }, true, 7]) {
      const m = models({ main: [OPENAI, LOCAL] }, { localOnly: odd });
      assert.strictEqual(m.egressFor('main').reason, 'local-only-role', JSON.stringify(odd));
      assert.deepStrictEqual(m.resolve('main').targets, [LOCAL], JSON.stringify(odd));
    }
    for (const none of [undefined, null, []]) {
      assert.strictEqual(models({ main: [OPENAI] }, { localOnly: none }).egressFor('main'), null);
    }
  });

  it('a turn policy wins over localOnly for the code', () => {
    const m = models({ utility: [OPENAI], main: [OPENAI] }, { egress: PRIVATE, localOnly: ['utility'] });
    assert.strictEqual(m.egressFor('utility'), PRIVATE);
    assert.throws(() => m.mustResolve('utility'), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
  });

  it('the main override: a hosted override under a policy is skipped, with the private code', () => {
    const m = models({ main: [LOCAL] }, { egress: PRIVATE, mainOverride: OPENAI });
    const r = m.resolve('main');
    assert.deepStrictEqual(r.targets, [], 'the profile\'s own main does not stand in for a refused override');
    assert.strictEqual(r.override, true);
    assert.deepStrictEqual(r.skipped, [{ target: OPENAI, reasons: ['openai/gpt-5.4-mini is not a local model and this chat is private.'] }]);
    assert.deepStrictEqual(m.candidatesFor('main'), []);
    assert.throws(() => m.mustResolve('main'), (err) => {
      assert.strictEqual(err.code, 'PRIVATE_NO_LOCAL_MODEL');
      assert.notStrictEqual(err.code, 'MAIN_OVERRIDE_UNUSABLE');
      assert.match(err.message, /Nothing was sent to a hosted model\.$/);
      return true;
    });
    const local = models({ main: [OPENAI] }, { egress: PRIVATE, mainOverride: LOCAL });
    assert.deepStrictEqual([local.resolve('main').targets, local.resolve('main').override], [[LOCAL], true]);
  });

  it('an explicit hosted target under a policy is skipped', () => {
    const m = models({ main: [LOCAL] }, { egress: PRIVATE });
    const r = m.resolve('worker', { explicit: ANTHROPIC });
    assert.deepStrictEqual([r.targets, r.explicit], [[], true]);
    assert.deepStrictEqual(r.skipped, [{ target: ANTHROPIC, reasons: ['anthropic/claude-sonnet-4-5 is not a local model and this chat is private.'] }]);
    assert.throws(() => m.mustResolve('worker', { explicit: ANTHROPIC }), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
    assert.throws(() => m.mustResolve('worker', { explicit: LAN }), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
    assert.deepStrictEqual(m.resolve('worker', { explicit: LOCAL_2 }).targets, [LOCAL_2]);
    assert.deepStrictEqual(m.seen, ['local/workstation/llama3.2:3b']);
    // A local-only role refuses an explicit hosted model as well.
    const role = models({ utility: [LOCAL] }, { localOnly: ['utility'] });
    assert.throws(() => role.mustResolve('utility', { explicit: OPENAI }), (err) => err.code === 'LOCAL_ONLY_ROLE_NO_MODEL');
  });

  it('imageGeneration under a policy: no useSettings', () => {
    for (const roles of [{ main: [LOCAL] }, { main: [LOCAL], imageGeneration: [t('openai', 'gpt-image-1')] }, { main: [LOCAL], imageGeneration: [LOCAL] }]) {
      const m = models(roles, { egress: PRIVATE });
      const r = m.resolve('imageGeneration');
      assert.deepStrictEqual(r.targets, []);
      assert.strictEqual(r.useSettings, false);
      assert.strictEqual(r.skipped.length, 1);
      assert.deepStrictEqual(r.skipped[0].reasons, ['Image generation is not available in a private chat.']);
      assert.ok(r.skipped[0].target && r.skipped[0].target.provider && r.skipped[0].target.model);
      assert.deepStrictEqual(m.candidatesFor('imageGeneration'), []);
      assert.throws(() => m.mustResolve('imageGeneration'), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
      assert.throws(() => m.mustResolve('imageGeneration', { explicit: t('openai', 'gpt-image-1') }), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
      assert.deepStrictEqual(m.resolve('imageGeneration', { explicit: LOCAL }).targets, []);
    }
    const role = models({ main: [LOCAL] }, { localOnly: ['imageGeneration'] });
    assert.strictEqual(role.resolve('imageGeneration').useSettings, false);
    assert.throws(() => role.mustResolve('imageGeneration'), (err) => err.code === 'LOCAL_ONLY_ROLE_NO_MODEL');
  });

  it('vision under a policy: its own local models, else the first image-capable local model of a core role', () => {
    const images = { images: ['local/workstation/llama3.2:3b', 'openai/gpt-5.4-mini'] };
    const own = models({ vision: [OPENAI, LOCAL_2], main: [LOCAL] }, { egress: PRIVATE, explainer: explainer({}, images) });
    assert.deepStrictEqual([own.resolve('vision').targets, own.resolve('vision').borrowedFrom], [[LOCAL_2], null]);
    const borrowed = models({ vision: [OPENAI], utility: [OPENAI], worker: [LOCAL], main: [LOCAL_2] }, { egress: PRIVATE, explainer: explainer({}, images) });
    const r = borrowed.resolve('vision');
    assert.deepStrictEqual([r.targets, r.borrowedFrom], [[LOCAL_2], 'main']);
    assert.ok(!borrowed.seen.includes('openai/gpt-5.4-mini'));
    assert.deepStrictEqual(borrowed.candidatesFor('vision'), [LOCAL, LOCAL_2]);
    const none = models({ vision: [OPENAI], main: [LOCAL] }, { egress: PRIVATE, explainer: explainer({}, images) });
    assert.throws(() => none.mustResolve('vision'), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
  });

  it('a custom role under a policy: its own local models, else its fallback\'s, filtered the same way', () => {
    const customRoles = [
      { id: 'legal-drafting', description: '', needs: {}, fallback: 'worker' },
      { id: 'summaries', description: '', needs: {}, fallback: 'main' }
    ];
    const m = models({ 'legal-drafting': [OPENAI], summaries: [ANTHROPIC], worker: [OPENAI], main: [OPENAI, LOCAL] }, { egress: PRIVATE, customRoles, mainOverride: LOCAL_2 });
    const legal = m.resolve('legal-drafting');
    assert.deepStrictEqual([legal.role, legal.targets, legal.borrowedFrom], ['legal-drafting', [LOCAL], 'main']);
    assert.strictEqual(legal.egress, PRIVATE);
    assert.ok(legal.skipped.some((s) => s.target.provider === 'openai'));
    const sums = m.resolve('summaries');
    assert.deepStrictEqual([sums.role, sums.targets, sums.borrowedFrom], ['summaries', [LOCAL], 'main']);
    assert.deepStrictEqual(m.candidatesFor('legal-drafting'), [LOCAL]);
    assert.deepStrictEqual(m.candidatesFor('summaries'), [LOCAL]);

    // A local-only custom role keeps its policy through its fallback.
    const only = models({ worker: [OPENAI], main: [OPENAI] }, { localOnly: ['legal-drafting'], customRoles });
    assert.strictEqual(only.resolve('legal-drafting').egress.reason, 'local-only-role');
    assert.throws(() => only.mustResolve('legal-drafting'), (err) => err.code === 'LOCAL_ONLY_ROLE_NO_MODEL' && /legal-drafting is local-only/.test(err.message));
    assert.deepStrictEqual(only.resolve('worker').targets, [OPENAI]);
  });

  it('no isGuaranteeTarget given: every target is refused under a policy', () => {
    const { explain, seen } = explainer();
    const m = createTurnModels({ profile: profile({ main: [LOCAL, OPENAI], worker: [LOCAL_2] }), explain, egress: PRIVATE });
    for (const role of ['main', 'worker', 'utility', 'vision', 'imageGeneration']) {
      assert.deepStrictEqual(m.resolve(role).targets, [], role);
      assert.throws(() => m.mustResolve(role), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL', role);
    }
    assert.deepStrictEqual(m.resolve('main', { explicit: LOCAL }).targets, []);
    assert.deepStrictEqual(seen, []);
  });

  it('a registry that throws or hedges refuses the target', () => {
    for (const registry of [() => { throw new Error('unreadable'); }, () => undefined, () => 'yes', () => 1]) {
      const m = models({ main: [LOCAL] }, { egress: PRIVATE, isGuaranteeTarget: registry });
      assert.deepStrictEqual(m.resolve('main').targets, []);
      assert.strictEqual(m.resolve('main').skipped.length, 1);
    }
  });

  it('the snapshot is frozen: a policy cannot be taken off or swapped afterwards', () => {
    const m = createTurnModels({ profile: profile({ main: [OPENAI, LOCAL] }), explain: explainer().explain, isGuaranteeTarget, egress: PRIVATE });
    assert.ok(Object.isFrozen(m));
    assert.throws(() => { 'use strict'; m.egress = null; }, TypeError);
    assert.throws(() => { 'use strict'; m.egress.localOnly = false; }, TypeError);
    assert.deepStrictEqual(m.resolve('main').targets, [LOCAL]);
  });
});
