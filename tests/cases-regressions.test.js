// tests/cases-regressions.test.js
// Each scenario replays a failure pattern from the cases spec (§1.1) with
// invented data, and pins the behaviour that would have prevented it.
//
// provenance "user" facts (Ledger assert) and owner-only Brief fields (why,
// hardConstraints, alreadyTried) require a "quote" that actually appears in
// one of the host-supplied owner messages, caseContext.ownerMessages. openCase
// below carries whatever invented owner lines each scenario needs; every
// provenance:"user" call in this file supplies a quote drawn from them.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { LedgerTool, BriefTool, DecideTool, RecommendTool } = require('../src/tools/builtin/case-tools');
const { AskTool, FailTool } = require('../src/tools/builtin/case-unattended-tools');
const { withCaseProfile } = require('./helpers/profile-settings');
const { confirmAll } = require('./helpers/case-scope');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-regress-')); dirs.push(d); return d; };
const web = { kind: 'url', ref: 'https://listings.example.org/search?q=lakeside' };

async function openCase(runtime, title, { active = true, ownerMessages = [] } = {}) {
  const info = await runtime.createCase({ title, objective: 'Convert the property to cash' });
  if (active) {
    runtime.brief(info.id).update('why', 'Cash is needed for another repair', { provenance: 'user' });
    runtime.brief(info.id).append('successCriteria', 'Closed within 90 days', { provenance: 'model' });
    confirmAll(runtime, info.id);
    runtime.completeGating(info.id);
  }
  // Stage 2: Decide and Recommend need a registered turn (requireReoriented).
  const turn = await runtime.beginTurn(info.id, { turnId: 'turn-1' });
  return { info, turn, opts: { caseContext: runtime.caseContext(turn, { ownerMessages }) } };
}

describe('F1: a guess never becomes a fact', () => {
  it('an ambiguous noun is recorded as an unknown, and a recommendation built on the guess is refused', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { info, opts } = await openCase(runtime, 'Lakeside lot', {
      ownerMessages: ['I must move 12 Birch and this lot.']
    });
    const said = await LedgerTool.execute({ action: 'assert', provenance: 'user', quote: 'I must move 12 Birch and this lot.', stmt: 'Owner: I must move 12 Birch and this lot', subject: 'owner', attr: 'must-sell', value: ['12 Birch', 'lakeside lot'] }, opts);
    const guess = await LedgerTool.execute({ action: 'infer', stmt: '12 Birch is a stand of timber', subject: '12-birch', attr: 'kind', value: 'timber', basis: [said.fact.id] }, opts);

    const rec = await RecommendTool.execute({ claims: [{ text: 'Sell the timber to a mill', factIds: [guess.fact.id] }] }, opts);
    assert.strictEqual(rec.ok, false);
    assert.match(JSON.stringify(rec.failures), /inferred/);

    const unknown = await LedgerTool.execute({ action: 'unknown', stmt: 'What is 12 Birch?', subject: '12-birch', attr: 'kind', changes: 'Which asset is being sold', answerable: 'owner', how: 'Ask the owner', loadBearing: true }, opts);
    assert.strictEqual(unknown.ok, true, 'an inference does not block recording the honest unknown');
    const orientation = runtime.orientation(info.id);
    assert.ok(orientation.indexOf('What is 12 Birch?') < orientation.indexOf('## Facts'), 'the unknown heads the orientation');
  });
});

describe('F2: the load-bearing question gets asked instead of assumed', () => {
  it('recommending an "untried" channel is refused while the listing history is unknown', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { opts } = await openCase(runtime, 'Lakeside lot', {
      ownerMessages: ['Three agents listed it on the MLS over three years and we got one low offer.']
    });
    const online = await LedgerTool.execute({ action: 'assert', stmt: 'No online listing for the lot today', subject: 'lot', attr: 'online-listing', value: 'none', source: web }, opts);
    const history = await LedgerTool.execute({ action: 'unknown', stmt: 'Has the lot been listed before, and how?', subject: 'lot', attr: 'listing-history', changes: 'Which channels are actually untried', answerable: 'owner', how: 'Ask the owner', loadBearing: true }, opts);

    const refused = await RecommendTool.execute({ claims: [{ text: 'List it online; that channel has never been tried', factIds: [online.fact.id, history.fact.id] }] }, opts);
    assert.strictEqual(refused.ok, false);
    assert.match(JSON.stringify(refused.failures), new RegExp(history.fact.id));

    const answer = await LedgerTool.execute({ action: 'assert', provenance: 'user', quote: 'Three agents listed it on the MLS over three years and we got one low offer.', stmt: 'Three agents listed it on the MLS over three years; one low offer', subject: 'lot', attr: 'listing-history', value: 'mls-3-agents-3-years', supersedes: history.fact.id }, opts);
    const accepted = await RecommendTool.execute({ claims: [{ text: 'Do not pay for a fourth MLS listing', factIds: [answer.fact.id] }] }, opts);
    assert.strictEqual(accepted.ok, true);
  });

  it('the model cannot supply the owner\'s reasons, so gating and recommendations stay closed', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { opts } = await openCase(runtime, 'Lakeside lot', {
      active: false,
      ownerMessages: ['The owner said the lot has been sitting for years.']
    });
    const why = await BriefTool.execute({ action: 'update', field: 'why', value: 'Probably wants to maximise price', provenance: 'model' }, opts);
    assert.strictEqual(why.ok, false);
    // Controller ruling (Task 8): provenance "user" is not a free pass either
    // — the quote must actually appear in an owner message. A quote the
    // model invented, that is not in ownerMessages, is refused the same way.
    const whyUnquoted = await BriefTool.execute({ action: 'update', field: 'why', value: 'Probably wants to maximise price', provenance: 'user', quote: 'Probably wants to maximise price' }, opts);
    assert.strictEqual(whyUnquoted.ok, false);
    const gate = await BriefTool.execute({ action: 'completeGating' }, opts);
    assert.strictEqual(gate.ok, false);
    assert.match(gate.error, /why/);
    const f = await LedgerTool.execute({ action: 'assert', stmt: 'Six lots ask 36k–60k per acre', subject: 'market', attr: 'asks', source: web }, opts);
    const rec = await RecommendTool.execute({ claims: [{ text: 'List at 35k per acre', factIds: [f.fact.id] }] }, opts);
    assert.strictEqual(rec.ok, false);
  });
});

describe('F5: existing state is checked before claiming something is missing', () => {
  it('asking for a document another case already holds surfaces that case', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const inventory = await runtime.createCase({ title: 'Household inventory' });
    runtime.ledger(inventory.id).assert({ stmt: 'Payoff letter for the house loan, good through the 7th', subject: 'house-loan', attr: 'payoff', value: 120000, category: 'financial', source: { kind: 'document', ref: 'sources/payoff-letter.pdf' } });
    const { opts } = await openCase(runtime, 'House sale');
    const r = await LedgerTool.execute({ action: 'unknown', stmt: 'Need the house loan payoff letter', subject: 'house-loan', attr: 'payoff', changes: 'Net proceeds at every price', answerable: 'owner', how: 'Ask the owner to order a payoff letter' }, opts);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.similarInOtherCases.map((m) => m.caseTitle), ['Household inventory']);
    assert.match(r.note, /Check them before asking the owner/);
    // Cases stage 5: the hit comes from the index, which redacts the financial fact.
    assert.strictEqual(r.similarInOtherCases[0].stmt, '(private fact in "Household inventory" — open that case to see it)');
    assert.ok(!JSON.stringify(r).includes('good through the 7th'));
  });
});

describe('F6: state survives compaction and restarts', () => {
  it('a fresh runtime sees the facts and decisions, and a correction flags the decision that cited the old fact', async () => {
    const root = tmp();
    const first = new CaseRuntime({ root });
    const { info, opts } = await openCase(first, 'Lakeside lot');
    const gis = await LedgerTool.execute({ action: 'assert', stmt: 'County GIS polygon computes 1.85 acres', subject: 'lot', attr: 'acreage', value: 1.85, unit: 'acre', source: { kind: 'api', ref: 'gis-parcel-layer' } }, opts);
    await DecideTool.execute({ decision: 'Quote price per acre on the GIS acreage', factIds: [gis.fact.id] }, opts);

    const second = new CaseRuntime({ root });
    const opts2 = { caseContext: { runtime: second, caseId: info.id, turnId: 'turn-2', dir: info.dir, ownerMessages: [] } };
    await LedgerTool.execute({ action: 'assert', stmt: 'Recorded plat says 2.120 acres', subject: 'lot', attr: 'acreage', value: 2.12, unit: 'acre', source: { kind: 'call', ref: 'sources/clerk-call.json' }, supersedes: gis.fact.id }, opts2);

    const orientation = second.orientation(info.id);
    assert.match(orientation, /Recorded plat says 2\.120 acres/);
    assert.match(orientation, /D-001[^\n]*now superseded/);
  });
});

describe('F4: a dead end becomes one failure report and a question, not a new plan', () => {
  it('Fail with one recommendation waits for direction; Recommend, Fail and Plan are refused; an answer resumes', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { info, turn, opts } = await openCase(runtime, 'Lakeside lot');
    const f = (await LedgerTool.execute({ action: 'assert', stmt: 'An auction house takes rural lots', subject: 'market', attr: 'auction', value: 'yes', source: web }, opts)).fact;
    const failed = await FailTool.execute({
      failureClass: 'dead-end',
      what: 'County listing',
      tried: ['Listed on the county site for 60 days'],
      why: 'No buyer replied',
      recommendation: { claims: [{ text: 'Try a land auction', factIds: [f.id] }] }
    }, opts);
    assert.strictEqual(failed.ok, true);
    assert.match(failed.rendered, /Recommendation:\n- Try a land auction/);
    assert.strictEqual(runtime.getCase(info.id).status, 'needs-direction');
    const [q] = runtime.questions(info.id).open();
    assert.deepStrictEqual([q.urgency, q.payload.type, q.payload.mcpAnswerable], ['high', 'direction', false]);
    assert.strictEqual((await RecommendTool.execute({ claims: [{ text: 'Try a land auction', factIds: [f.id] }] }, opts)).ok, false);
    assert.strictEqual((await FailTool.execute({ failureClass: 'dead-end', what: 'Another idea', tried: ['x'], why: 'y' }, opts)).ok, false);
    assert.strictEqual(runtime.assertWritable(info.id, 'Plan').ok, false);
    await runtime.endTurn(turn, {});
    await runtime.answerQuestion(info.id, q.id, { channel: 'in-app', text: 'Go with the auction' });
    assert.strictEqual(runtime.getCase(info.id).status, 'active');
  });
});

describe('F9: the brief decides what reaches the owner', () => {
  it('an ignored briefing is refused; an urgent briefing without a tell tag is stored low and lands in the panel', async () => {
    const events = [];
    const runtime = new CaseRuntime({ root: tmp(), host: { notify: (_e, p) => events.push(p) } });
    const { info, opts } = await openCase(runtime, 'Lakeside lot');
    runtime.brief(info.id).update('materiality', { tell: ['offer'], ignore: ['voicemail'] }, { provenance: 'user' });
    const ignored = await AskTool.execute({ question: 'A buyer left a voicemail.', kind: 'briefing', materiality: 'voicemail' }, opts);
    assert.strictEqual(ignored.ok, false);
    const r = await AskTool.execute({ question: 'The listing went live.', kind: 'briefing', urgency: 'high' }, opts);
    assert.strictEqual(r.urgency, 'low');
    assert.strictEqual(runtime.questions(info.id).get(r.questionId).urgency, 'low');
    assert.ok(events.some((p) => p.questionId === r.questionId && p.attention === 'panel'));
  });
});

describe('F12: spending stops at the budget and only the owner raises it', () => {
  it('pauses at 100 % of usd, refuses writes, ignores a quoted "ok", skips wake-ups, and resumes on an answered limit', async () => {
    let routed = 0;
    const runtime = new CaseRuntime({
      root: tmp(),
      host: { inferenceRouter: { routeTargets: async () => { routed += 1; return '{"changed": true}'; } }, notify: () => {} }
    });
    const { info, turn, opts } = await openCase(runtime, 'Lakeside lot', { ownerMessages: ['ok, go ahead'] });
    runtime.store.updateMeta(info.id, { budget: { usd: 1 } });
    const quoted = await LedgerTool.execute({ action: 'assert', provenance: 'user', quote: 'ok, go ahead', stmt: 'Owner raised the budget', subject: 'budget', attr: 'usd', value: '500' }, opts);
    assert.strictEqual(quoted.ok, true);
    assert.match(quoted.note, /only through the owner's answer or the Grant button/);
    assert.strictEqual(runtime.getCase(info.id).budget.usd, 1);

    runtime.usageHook(turn)({ provider: 'openai', model: 'gpt-4o', totalTokens: 1000, cost: 1.1 });
    const meta = runtime.getCase(info.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind], ['paused', 'budget']);
    const grantQ = runtime.questions(info.id).open().find((q) => q.payload.type === 'budget-grant');
    assert.ok(grantQ);
    assert.strictEqual((await LedgerTool.execute({ action: 'assert', stmt: 's', subject: 'lot', attr: 'x', value: '1', source: web }, opts)).ok, false);
    assert.strictEqual((await LedgerTool.execute({ action: 'query' }, opts)).ok, true);
    await runtime.endTurn(turn, {});

    const wakeup = runtime.wakeups(info.id).register({ kind: 'retry', at: new Date(Date.now() - 60000).toISOString(), payload: { key: 'f12' } });
    await runtime.runDueWakeups(new Date());
    assert.strictEqual(routed, 0, 'a paused case runs no wake-up');
    assert.ok(runtime.wakeups(info.id).list().some((w) => w.id === wakeup));

    await runtime.answerQuestion(info.id, grantQ.id, { channel: 'in-app', text: '2' });
    const after = runtime.getCase(info.id);
    assert.deepStrictEqual([after.status, after.budget.usd], ['active', 2]);
  });

  it('a limit lowered below spend pauses the case on the next turn', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { info, turn } = await openCase(runtime, 'Lakeside lot');
    runtime.budget(info.id).charge('usd', 5);
    await runtime.endTurn(turn, {});
    runtime.store.updateMeta(info.id, { budget: { usd: 4 } });
    const next = await runtime.beginTurn(info.id, { turnId: 'turn-2' });
    const meta = runtime.getCase(info.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.statusReason.ref], ['paused', 'budget', 'usd']);
    assert.ok(runtime.questions(info.id).open().some((q) => q.payload.type === 'budget-grant'));
    await runtime.endTurn(next, {});
  });
});

describe('cases stage 3 regressions', () => {
  const fx3 = require('./helpers/executor-fixtures');
  const planOps3 = require('../src/cases/executors/plan-ops');
  const envelopeOps3 = require('../src/cases/executors/envelope-ops');
  const { submitJob: submit3 } = require('../src/cases/executors/submit');
  const { gateLeaves: gate3 } = require('../src/cases/gates');
  const { turnStartHook: hook3 } = require('../src/cases/executors/turn-hook');
  const { writeJsonAtomic: writeJson3 } = require('../src/cases/executors/util');
  after(fx3.cleanup);

  async function world({ title = 'Lakeside lot', env = null } = {}) {
    const e = env || fx3.setupExecutors();
    const ctl = env ? null : fx3.withFakeAgent(e);
    const meta = await fx3.activeCase(e.runtime, { title });
    return { env: e, ctl, meta, reg: e.registry, rt: e.runtime, ctx: { caseId: meta.id, turnId: 'turn-1' } };
  }
  async function envelopeFor(w, over = {}) {
    const r = await envelopeOps3.requestEnvelope(w.reg, w.ctx, {
      executor: 'fake-agent', intent: 'Ask brokers for a listing quote', recipients: { allow: ['+15550100', '+15550101'] },
      facts: [], caps: { usd: 20, contacts: 3, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30' }, ...over
    });
    await w.rt.answerQuestion(w.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    envelopeOps3.syncEnvelopes(w.reg, w.meta.id);
    return r.envelopeId;
  }
  const payload3 = (recipients, over = {}) => JSON.stringify({ recipients: recipients.map((address) => ({ address })), text: 'Hello, we would like a listing quote for the lot.', ...over });
  const FORMS = Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, title: `File permit form ${i + 1}`, executor: 'owner', capability: 'web-form', quantity: 1, unit: 'forms' }));

  it('F3: owner labor is never assumed', async () => {
    const w = await world();
    w.rt.brief(w.meta.id).update('resources', { executors: ['browser', 'owner'], ownerLabor: [] }, { provenance: 'model' });
    const r = await planOps3.proposePlan(w.reg, w.ctx, { summary: 'File the permits', steps: JSON.stringify(FORMS) });
    assert.deepStrictEqual([...new Set(r.steps.map((s) => `${s.executor}:${s.check.status}`))], ['browser:rewritten']);
    writeJson3(path.join(w.meta.dir, '.kl', 'executors.json'), { browser: { override: { disabled: true } } });
    const held = await planOps3.proposePlan(w.reg, w.ctx, { summary: 'File the permits', steps: JSON.stringify(FORMS) });
    assert.deepStrictEqual([...new Set(held.steps.map((s) => `${s.executor}:${s.check.status}`))], ['owner:needs-consent']);
    const asked = w.rt.questions(w.meta.id).get(held.questionId).text;
    for (const f of FORMS) assert.ok(asked.includes(f.title), `the owner sees ${f.id}`);
    assert.match((await submit3(w.reg, w.ctx, { executor: 'owner', payload: JSON.stringify({ text: 'File the forms' }) })).error, /the owner has not agreed/);
  });

  it('F7: no invented or private constraints', async () => {
    const w = await world();
    const L = w.rt.ledger(w.meta.id);
    const due = L.assert({ stmt: 'Offers are due 2026-11-21', subject: 'sale', attr: 'offer-deadline', value: '2026-11-21', provenance: 'sourced', source: { kind: 'url', ref: 'https://auctions.example.com/lot' } });
    L.assert({ stmt: 'Lowest acceptable price', subject: 'sale', attr: 'floor', value: 98000, unit: 'USD', provenance: 'user', category: 'financial', source: { kind: 'question', ref: 'q-0099' } });
    const facts = L.view().facts;
    const invented = gate3({ text: 'Offers are due by Friday November 14' }, { facts, mode: 'message' });
    assert.ok(invented.blocked.every((b) => b.reason === 'unsourced-constraint') && invented.blocked.length > 0);
    const sourced = gate3({ text: `Offers are due by {{${due.id}}}.` }, { facts, mode: 'message' });
    assert.deepStrictEqual([sourced.ok, sourced.rendered.text], [true, 'Offers are due by 2026-11-21.']);
    const pasted = gate3({ text: 'We cannot go below 98000 dollars.' }, { facts, mode: 'message' });
    assert.ok(pasted.blocked.some((b) => b.reason === 'non-disclosable'));
  });

  it('F11: deltas name only the difference', async () => {
    const w = await world();
    const extra = w.rt.ledger(w.meta.id).assert({ stmt: 'Zoned R-1', subject: 'lot', attr: 'zoning', value: 'R-1', provenance: 'sourced', source: { kind: 'url', ref: 'https://records.example.org/zoning' } });
    const envelopeId = await envelopeFor(w);
    const trimmed = await submit3(w.reg, w.ctx, { executor: 'fake-agent', envelopeId, payload: payload3(['+15550100']) });
    assert.strictEqual(trimmed.ok, true, trimmed.error);
    const before = w.rt.questions(w.meta.id).open().length;
    const wider = await submit3(w.reg, w.ctx, { executor: 'fake-agent', envelopeId, payload: payload3(['+15550101', '+15550102'], { facts: [extra.id] }) });
    assert.deepStrictEqual([wider.needsApproval, wider.deltas], [true, ['adds recipient +15550102', `discloses ${extra.id} "Zoned R-1"`]]);
    assert.strictEqual(w.rt.questions(w.meta.id).open().length, before + 1);
  });

  it('F10: ops lessons carry over, private ones do not', async () => {
    const a = await world();
    const L = a.rt.ledger(a.meta.id);
    const shared = L.assert({ stmt: 'fake-agent drops calls longer than ten minutes', subject: 'ops', attr: 'fake-agent/call-length', value: '10m', provenance: 'sourced', source: { kind: 'url', ref: 'https://errands.example.com/docs' } });
    a.reg.opsMemory.afterAssert(shared, { caseId: a.meta.id, caseTitle: a.meta.title, facts: L.view().facts });
    const secret = L.assert({ stmt: 'fake-agent account is under the owner\'s personal card', subject: 'ops', attr: 'fake-agent/billing', value: 'card', provenance: 'sourced', category: 'personal', source: { kind: 'url', ref: 'https://errands.example.com/billing' } });
    a.reg.opsMemory.afterAssert(secret, { caseId: a.meta.id, caseTitle: a.meta.title, facts: L.view().facts });
    const b = await world({ title: 'Harbor cottage', env: a.env });
    b.rt.brief(b.meta.id).update('resources', { executors: ['fake-agent'], ownerLabor: [] }, { provenance: 'model' });
    const notes = (await hook3(b.reg, { caseId: b.meta.id })).notes.join('\n');
    assert.match(notes, /^> fake-agent drops calls longer than ten minutes {2}— Lakeside lot, 2026-/m);
    assert.doesNotMatch(notes, /personal card/);
  });

  it('F5: duplicate jobs', async () => {
    const a = await world();
    const envA = await envelopeFor(a);
    assert.strictEqual((await submit3(a.reg, a.ctx, { executor: 'fake-agent', envelopeId: envA, payload: payload3(['+15550100']) })).ok, true);
    assert.match((await submit3(a.reg, a.ctx, { executor: 'fake-agent', envelopeId: envA, payload: payload3(['+15550100']) })).error, /^this duplicates job-0001/);
    const b = await world({ title: 'Harbor cottage', env: a.env });
    const envB = await envelopeFor(b);
    const other = await submit3(b.reg, b.ctx, { executor: 'fake-agent', envelopeId: envB, payload: payload3(['+15550100']) });
    assert.deepStrictEqual([other.ok, other.note], [true, `also contacted by case "Lakeside lot" (${a.meta.id})`]);
  });
});

// Cases stage 5 (docs/superpowers/specs/2026-09-23-cases-stage5-detours.md §10).
describe('F4-detour: off-objective work is routed, not done inline', () => {
  const { execFileSync } = require('child_process');
  const { DetourTool } = require('../src/tools/builtin/detour-tool');
  const { registerDetourHandlers } = require('../src/ipc/detour-handlers');
  const IPC = require('../src/ipc/constants');
  const { DetourLog } = require('../src/cases/detours/log');
  const MOCK = '{"onCase":false,"confidence":0.9,"reason":"Fixing the phone agent\'s code does not collect quotes"}';

  it('refuses the patch, proposes the phone agent case, links both cases, and leaves the repository alone', async () => {
    const repo = tmp();
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'status.js'), 'module.exports = { poll: () => "completed" };\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const headBefore = git('rev-parse', 'HEAD');

    const runtime = new CaseRuntime({
      root: tmp(),
      getSettings: () => withCaseProfile({}),
      host: { inferenceRouter: { routeTargets: async () => MOCK }, interactive: () => true }
    });
    const door = await runtime.createCase({ title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door' });
    runtime.brief(door.id).update('why', 'Rain gets in under the door', { provenance: 'user' });
    runtime.brief(door.id).append('successCriteria', 'Three written quotes', { provenance: 'model' });
    confirmAll(runtime, door.id);
    runtime.completeGating(door.id);
    const phone = await runtime.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent reporting call status correctly' });
    runtime.brief(phone.id).update('why', 'Dropped calls show as completed', { provenance: 'user' });
    runtime.brief(phone.id).append('successCriteria', 'Status polling reports dropped calls', { provenance: 'model' });
    runtime.brief(phone.id).update('repo', repo, { provenance: 'user' });
    confirmAll(runtime, phone.id);
    runtime.completeGating(phone.id);
    const phoneTurn = await runtime.beginTurn(phone.id, { turnId: 'wakeup-1', source: 'wakeup' });
    await runtime.endTurn(phoneTurn, { summary: 'looked at the repository' });

    const turn = await runtime.beginTurn(door.id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'Also fix the phone agent status polling that drops calls' });
    const gate = await runtime.detourGate(door.id, { source: 'executor', serves: 'fix dropped-call status', text: 'Patch status polling in the phone agent', turnId: 'turn-1' });
    assert.strictEqual(gate.ok, false);
    assert.match(gate.error, /^This work looks like a detour from the case objective \("Three written quotes for the rear door"\): Fixing the phone agent's code does not collect quotes\. Do not do it in this case\. Call Detour with action "propose"/);

    const opts = { caseContext: runtime.caseContext(turn, { ownerMessages: ['Also fix the phone agent status polling that drops calls'] }) };
    const proposed = await DetourTool.execute({ action: 'propose', summary: 'Patch status polling in the phone agent', reason: "Fixing the phone agent's code does not collect quotes" }, opts);
    assert.strictEqual(proposed.options[0].label, 'Attach to "Phone agent maintenance" (active)');

    await runtime.runOwnerMessageHooks(turn);
    await runtime.runOwnerMessageHooks(turn);
    const fromOwner = new DetourLog(door.dir).rows().filter((r) => r.type === 'proposal' && r.source === 'owner-message');
    assert.strictEqual(fromOwner.length, 1, 'the same owner message yields one proposal');
    await runtime.endTurn(turn, { summary: 'quotes and a detour' });

    const handlers = new Map();
    registerDetourHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getCaseRuntime: () => runtime });
    const resolved = await handlers.get(IPC.CASE_RESOLVE_DETOUR)({}, { caseId: door.id, detourId: proposed.detourId, optionId: 'attach-1' });
    assert.deepStrictEqual([resolved.ok, resolved.linkedCaseId], [true, phone.id]);
    assert.ok(runtime.getCase(door.id).related.some((r) => r.id === phone.id && r.relation === 'related'));
    assert.ok(runtime.getCase(phone.id).related.some((r) => r.id === door.id && r.relation === 'related'));
    assert.strictEqual(runtime.getCase(door.id).status, 'active');

    assert.strictEqual(git('rev-parse', 'HEAD'), headBefore);
    assert.strictEqual(git('status', '--porcelain'), '');
  });
});

describe('F5-cross-case: one index answers every duplicate check without leaking', () => {
  const { AskTool } = require('../src/tools/builtin/case-unattended-tools');
  const { DetourRouter } = require('../src/cases/detours/router');

  it('similar case creation, routing, Ask and unknowns all go through the index', async () => {
    const runtime = new CaseRuntime({ root: tmp(), host: { interactive: () => true } });
    const site = await runtime.createCase({ title: 'Website redesign', objective: 'Refresh the public website' });
    runtime.ledger(site.id).assert({ stmt: 'The hosting contract renews on 1 November for 240 dollars', subject: 'hosting', attr: 'renewal', value: 240, category: 'financial', source: { kind: 'document', ref: 'sources/hosting.pdf' } });
    runtime.records(site.id).writeJournal('plan', '# Plan\n\nMove the booking page to the static generator');
    runtime.createQuestion(site.id, { kind: 'question', text: 'Which hosting plan should the new booking site use?', urgency: 'low' });

    await assert.rejects(runtime.createCase({ title: 'Redesign the website' }), (err) => err.code === 'SIMILAR_CASES' && err.similar[0].caseId === site.id);

    const shop = await runtime.createCase({ title: 'Shop opening', objective: 'Open the pop-up shop on Saturday' });
    const routed = await new DetourRouter({ runtime }).propose(shop.id, { summary: 'redesign the website homepage', reason: 'Not the shop' });
    assert.strictEqual(routed.detour.options[0].label, 'Attach to "Website redesign" (draft)');

    const turn = await runtime.beginTurn(shop.id, { turnId: 'turn-1' });
    const asked = await AskTool.execute({ question: 'Which hosting plan should the new booking site use?' }, { caseContext: runtime.caseContext(turn) });
    assert.strictEqual(asked.ok, true);
    assert.match(asked.note, /A similar question is open in case "Website redesign"\./);
    assert.ok(!JSON.stringify(asked).includes('240'));

    const unknown = await LedgerTool.execute({ action: 'unknown', stmt: 'When does the hosting contract renew?', subject: 'hosting', attr: 'renewal', changes: 'Budget', answerable: 'owner', how: 'Ask' }, { caseContext: runtime.caseContext(turn) });
    assert.deepStrictEqual(unknown.similarInOtherCases.map((m) => [m.caseTitle, m.stmt]), [['Website redesign', '(private fact in "Website redesign" — open that case to see it)']]);
    assert.ok(!JSON.stringify(unknown).includes('240 dollars'));
    await runtime.endTurn(turn, { summary: 'x' });
  });
});

describe('F2-late: a load-bearing question reaches the owner on day 1, not day 6', () => {
  const { ContactState } = require('../src/cases/contact-state');
  const { ContactRouter } = require('../src/cases/contact');
  const { Presence } = require('../src/cases/presence');
  const { LadderEngine } = require('../src/cases/ladder');
  const { defaultPolicy } = require('../src/cases/contact-format');
  const { TelephonyChannel } = require('../src/channels/telephony-channel');
  const { ContactRelayClient } = require('../src/channels/relay-client');
  const { startFakeRelay } = require('./helpers/fake-contact-relay');
  const { LoopbackChannel } = require('./helpers/loopback-channel');

  const T0 = Date.parse('2026-09-25T09:00:00Z');
  const at = (ms) => new Date(T0 + ms);
  const MIN = 60 * 1000;

  async function contactWorld(adapterList) {
    let now = at(0);
    const clock = () => now;
    const root = tmp();
    const data = tmp();
    const policy = defaultPolicy();
    policy.digest = null;
    const runtime = new CaseRuntime({ root, now: clock, getSettings: () => ({ cases: { timeZone: 'UTC' } }) });
    const state = new ContactState({ dir: path.join(data, 'contact'), clock });
    const adapters = new Map(adapterList);
    const presence = new Presence({ file: path.join(data, 'contact', 'presence.json'), getPolicy: () => policy, clock, interactive: () => false, isEnabled: (c) => adapters.has(c), getTimeZone: () => 'UTC' });
    const router = new ContactRouter({ state, runtime, adapters, presence, clock, getTimeZone: () => 'UTC' });
    for (const [id, a] of adapters) a.onContactReply((cid, answer, meta) => router.handleReply(id, cid, answer, meta));
    const ladder = new LadderEngine({ state, casesRoot: root, runtime, router, presence, getPolicy: () => policy, clock, dataDir: data });
    const info = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    const q = runtime.createQuestion(info.id, {
      kind: 'question', urgency: 'high', text: 'Has the lot been listed before, and how?', options: [{ id: 'a', label: 'Yes, on the MLS' }, { id: 'b', label: 'Never' }],
      payload: { type: 'ask', about: { subject: 'lot', attr: 'listing-history' } }
    }, { charge: false });
    return {
      runtime, state, router, ladder, info, q,
      tick: async (ms) => { now = at(ms); return ladder.tick(now); },
      entry: () => state.ladder().entries[`${info.id}/${q.id}`],
      ownerFact: () => [...runtime.ledger(info.id).view().facts.values()].find((f) => f.source?.kind === 'question' && f.source.ref === q.id) || null
    };
  }

  it('high: absent at T0+60 s, SMS at T0+15 min, a relay reply at T0+2 h becomes a user fact on day 1', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const sms = new TelephonyChannel({ kind: 'sms', relay: client, getConfig: () => ({ owner: '+15550100', from: '+15550199' }) });
      const w = await contactWorld([['sms', sms]]);
      await w.tick(60 * 1000);
      assert.deepStrictEqual(w.entry().attempts.map((a) => [a.channel, a.outcome]), [['present', 'absent']]);
      await w.tick(15 * MIN);
      assert.strictEqual(relay.sent().length, 1);
      const batchToken = w.entry().attempts[1].batchToken;
      assert.match(relay.sent()[0].body.text, new RegExp(`#${batchToken}`));
      relay.pushEvent({ id: 'ev-1', type: 'inbound', channel: 'sms', from: '+15550100', to: '+15550199', text: `#${batchToken} a`, at: at(120 * MIN).toISOString() });
      const { events } = await client.events(null);
      await w.tick(120 * MIN);
      await w.router.ingestRelayEvents('main', events);
      const fact = w.ownerFact();
      assert.ok(fact, 'the owner answer is a fact');
      assert.strictEqual(fact.provenance, 'user');
      assert.strictEqual(fact.value, 'Yes, on the MLS');
      assert.strictEqual(w.runtime.questions(w.info.id).get(w.q.id).answer.at.slice(0, 10), '2026-09-25', 'answered on day 1');
    } finally {
      await relay.close();
    }
  });

  it('normal: through the loopback adapter registered as telegram at T0+30 min', async () => {
    const telegram = new LoopbackChannel({ id: 'telegram', owner: '111' });
    const w = await contactWorld([['telegram', telegram]]);
    const record = w.runtime.questions(w.info.id).get(w.q.id);
    record.urgency = 'normal';
    fs.writeFileSync(path.join(w.runtime.getCase(w.info.id).dir, '.kl', 'questions', `${w.q.id}.json`), JSON.stringify(record));
    await w.tick(60 * 1000);
    await w.tick(29 * MIN);
    assert.strictEqual(telegram.sent.length, 0);
    await w.tick(30 * MIN);
    assert.strictEqual(telegram.sent.length, 1);
    await telegram.reply(w.entry().token, { optionIndex: 1 });
    assert.strictEqual(w.ownerFact().value, 'Never');
  });

  it('control: with no reachable channel the ladder ends exhausted and journaled on day 1', async () => {
    const w = await contactWorld([]);
    await w.tick(60 * 1000);
    await w.tick(15 * MIN);
    await w.tick(30 * MIN);
    assert.strictEqual(w.entry().exhausted, true);
    assert.strictEqual(w.entry().exhaustJournaled, true);
    const journal = fs.readdirSync(path.join(w.runtime.getCase(w.info.id).dir, 'journal')).filter((f) => f.endsWith('-question.md'));
    assert.ok(journal.some((f) => f.startsWith('2026-09-25')), 'journaled on day 1');
    assert.strictEqual(w.runtime.questions(w.info.id).get(w.q.id).answer, null, 'the question stays open; nothing is guessed');
  });
});

describe('F5-doc: a document in one case informs and guards another (cases stage 7)', () => {
  const { ingestHarness, cleanup: cleanupIngest } = require('./helpers/ingest-harness');
  const { payoffLetterPdf } = require('./helpers/ingest-fixtures');
  const { LedgerTool } = require('../src/tools/builtin/case-tools');
  const { after: afterAll } = require('node:test');

  afterAll(cleanupIngest);

  it('payoff letter in Lakeside lot: named on unknown, alsoInCases on drop, private in outbound text', async () => {
    const a = await ingestHarness({ title: 'Lakeside lot' });
    const bytes = await payoffLetterPdf();
    const stored = await a.svc.store(a.caseId, { name: 'payoff-letter.pdf', bytes, origin: { kind: 'owner-drop' } });
    await a.svc.drain();
    const { fact } = await a.svc.review(a.caseId, stored.docId, 'p-001', { action: 'accept' });
    assert.strictEqual(fact.id, 'f-0001');

    const b = await a.runtime.createCase({ title: 'Refinance 12 Birch' });
    a.runtime.store.updateMeta(b.id, { status: 'active' });
    const ctx = { caseContext: { runtime: a.runtime, caseId: b.id, turnId: 'turn-b', ownerMessages: [] } };
    const unknown = await LedgerTool.execute({
      action: 'unknown', stmt: 'Payoff amount for loan 0042-7781 is unknown', subject: 'refi', attr: 'payoff',
      changes: 'the refinance amount', answerable: 'the lender', how: 'ask for a payoff letter'
    }, ctx);
    assert.strictEqual(unknown.alsoKnownElsewhere.untrusted_output, true);
    assert.deepStrictEqual(unknown.alsoKnownElsewhere.hits.find((h) => h.kind === 'fact'), { caseId: a.caseId, title: 'Lakeside lot', kind: 'fact', id: 'f-0001', entity: 'id:00427781' });
    assert.ok(!JSON.stringify(unknown.alsoKnownElsewhere).includes('payoff-letter'));

    const dropped = await a.svc.store(b.id, { name: 'payoff-letter.pdf', bytes, origin: { kind: 'owner-drop' } });
    assert.deepStrictEqual(dropped.alsoInCases, [{ caseId: a.caseId, title: 'Lakeside lot' }]);
    await a.svc.drain();

    const payload = 'Please confirm the balance on loan 0042-7781 before closing.';
    const spans = a.runtime.entityIndex().nonDisclosableSpans(payload, { caseId: b.id });
    assert.deepStrictEqual(spans.map((s) => [s.span.text, s.entity]), [['0042-7781', 'id:00427781']]);
    const gates = require('../src/cases/gates');
    const r = gates.gateLeaves({ body: payload }, { facts: new Map(), mode: 'message', caseId: b.id, entityIndex: a.runtime.entityIndex() });
    assert.strictEqual(r.ok, false);
    assert.ok(r.blocked.some((x) => x.reason === 'non-disclosable-entity'));
  });
});

// Cases stage 8 (spec §1, §6; plan Task 17): a case says how far along it is
// from its record. The model's criteria count for nothing until the owner
// confirms them; a criterion is met only on evidence code checked; a fact
// that changes makes it stale and stops the model's close proposal; only the
// owner's press closes, and the list is frozen then. One case, one step per
// test. The verify pass runs after the reply (R-C8-11): its result lands in
// its own journal entry, and the test waits for it with verifyIdle. No
// network and no model: the router is a stub with a scripted reply.
describe('F8-progress: progress comes from the record, and only the owner closes', () => {
  const { ProgressTool } = require('../src/tools/builtin/case-progress-tool');
  const HEADING = '## Verification (written by King Louie)';
  const OWNER = ['We are done when the lot has closed within 90 days of listing. Yes, confirm both of those criteria.'];
  const metrics = { provider: 'openai', model: 'judge-model', inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.02 };
  const verdict = (...criteria) => ({ type: 'text', content: JSON.stringify({ criteria }), llmMetrics: metrics });
  const met = (id, ...evidence) => ({ id, status: 'met', evidence, note: 'The record shows it.' });
  const s = {};

  const begin = async () => {
    s.n += 1;
    s.clock.now = new Date(s.clock.now.getTime() + 60000);
    s.turn = await s.rt.beginTurn(s.id, { turnId: `turn-${s.n}` });
    s.opts = { caseContext: s.rt.caseContext(s.turn, { ownerMessages: OWNER }) };
    return s.turn;
  };
  const end = async (verify) => {
    await s.rt.endTurn(s.turn, { summary: 'test', journal: `Turn ${s.n}.`, verify });
    await s.rt.verifyIdle(s.id);
  };
  const row = (id) => s.rt.progressView(s.id).criteria.find((r) => r.id === id);
  const journals = () => {
    const dir = path.join(s.dir, 'journal');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
      .map((name) => [name.replace(/^[\d-]+-/, '').replace(/\.md$/, ''), fs.readFileSync(path.join(dir, name), 'utf8')]);
  };
  const lastJournal = (kind = null) => journals().filter(([k]) => !kind || k === kind).pop();
  const sourced = (stmt, value, over = {}) => LedgerTool.execute({ action: 'assert', provenance: 'sourced', stmt, subject: 'sale', attr: 'contract', value, source: { kind: 'url', ref: 'https://records.example.org/lakeside' }, ...over }, s.opts);

  it("the model's two criteria are proposed, and gating waits for the owner", async () => {
    s.clock = { now: new Date('2026-10-21T09:00:00.000Z') };
    s.n = 0;
    s.script = { reply: null };
    const router = { routeTargets: async () => (typeof s.script.reply === 'function' ? s.script.reply() : s.script.reply) };
    const tracker = { record: (e) => ({ provider: e.provider, model: e.model, totalTokens: e.totalTokens, cost: e.costUsd }) };
    s.rt = new CaseRuntime({
      root: tmp(),
      now: () => s.clock.now,
      getSettings: () => withCaseProfile({ cases: { timeZone: 'UTC' } }),
      host: { inferenceRouter: router, getUsageTracker: () => tracker }
    });
    const info = await s.rt.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash', objectiveBy: 'owner' });
    Object.assign(s, { id: info.id, dir: info.dir });
    s.rt.brief(s.id).update('why', 'Cash is needed for another repair', { provenance: 'user' });
    await begin();
    for (const item of ['Signed contract at or above the floor', 'Closed within 90 days of listing']) {
      const r = await BriefTool.execute({ action: 'append', field: 'successCriteria', item }, s.opts);
      assert.strictEqual(r.criterion.state, 'proposed');
    }
    assert.deepStrictEqual(s.rt.scopeView(s.id).criteria.map((r) => [r.id, r.state, r.origin]), [['sc-001', 'proposed', 'model'], ['sc-002', 'proposed', 'model']]);
    assert.throws(() => s.rt.completeGating(s.id), /no criterion is confirmed by the owner/);
    // A quote that is not the owner's own phrase confirms nothing.
    const paraphrase = await BriefTool.execute({ action: 'append', field: 'successCriteria', item: 'Sold inside three months', provenance: 'user', quote: 'closed within 90 days of listing' }, s.opts);
    assert.strictEqual(paraphrase.code, 'SCOPE_NOT_IN_QUOTE');
    assert.match(s.rt.progress(s.id).summary, /^0 of 0 confirmed criteria met · 2 proposed \(not counted\) · not ready to close/);
  });

  it('the owner confirms one by a press and one by a quoted answer; gating completes', async () => {
    const first = row('sc-001');
    await s.rt.applyScopeAction(s.id, { action: 'confirm', target: 'sc-001', hash: first.hash, by: 'owner-action', channel: 'in-app' });
    const asked = await ProgressTool.execute({ action: 'askScope' }, s.opts);
    assert.strictEqual(asked.ok, true);
    await end(false);
    const quote = 'Yes, confirm both of those criteria.';
    await s.rt.answerQuestion(s.id, asked.questionId, { channel: 'in-app-chat', optionId: 'all', quote });
    const rows = s.rt.scopeView(s.id).criteria;
    assert.deepStrictEqual(rows.map((r) => [r.id, r.state, r.confirmed.by]), [['sc-001', 'confirmed', 'owner-action'], ['sc-002', 'confirmed', 'question']]);
    assert.strictEqual(rows[1].confirmed.quote, quote);
    s.rt.completeGating(s.id);
    assert.strictEqual(s.rt.getCase(s.id).status, 'active');
    assert.deepStrictEqual(s.rt.progressView(s.id).criteria.map((r) => r.state), ['unmet', 'unmet']);
  });

  it('a turn records a sourced fact and the verify pass cites it: met, in a verification entry of its own', async () => {
    await begin();
    const f = await sourced('The contract was signed at 81,000', 81000);
    s.fact = f.fact;
    s.script.reply = verdict(met('sc-001', s.fact.id), met('sc-002', 'f-0999'));
    await end(true);
    assert.strictEqual(row('sc-001').state, 'met');
    assert.deepStrictEqual(row('sc-001').evidence.map((e) => e.id), [s.fact.id]);
    // Code refused the verdict that cites a fact the ledger does not hold.
    assert.strictEqual(row('sc-002').state, 'unmet');
    const [kind, text] = lastJournal();
    assert.strictEqual(kind, 'verification');
    assert.ok(text.startsWith(`${HEADING}\n- Now met: sc-001 (${s.fact.id}).`), text);
  });

  // The turn that supersedes the fact is told at its own close (the block
  // that heads its journal entry), and the cache then reads stale, so the
  // next turn start raises no criterion-regressed trigger for it: that
  // trigger is for a change between turns (cases-runtime.test.js pins it).
  it("a later turn supersedes the fact: stale, said at that turn's close, and the model cannot propose done", async () => {
    await begin();
    s.script.reply = verdict();
    const newer = await sourced('The buyer withdrew; the contract is void', 0, { supersedes: s.fact.id });
    s.voided = newer.fact;
    await end(true);
    assert.strictEqual(row('sc-001').state, 'stale');
    assert.match(row('sc-001').reasons.join(' '), new RegExp(`${s.fact.id} was superseded by ${s.voided.id}`));
    const [, entry] = lastJournal('turn');
    assert.ok(entry.startsWith(`${HEADING}
- Now stale: sc-001 (${s.fact.id} was superseded by ${s.voided.id}).`), entry);
    const turn = await begin();
    assert.deepStrictEqual(turn.triggers.filter((t) => t.kind === 'criterion-regressed'), []);
    assert.match(turn.orientation, /sc-001 \[stale\]/);
    const refused = await ProgressTool.execute({ action: 'proposeDone' }, s.opts);
    assert.deepStrictEqual([refused.ok, refused.code], [false, 'NOT_READY']);
    assert.ok(refused.open.some((i) => i.id === 'criteria-met' && /sc-001 is stale/.test(i.fix)));
  });

  it('new evidence and an accepted verdict make both met, and the model proposes done', async () => {
    const signed = await sourced('A second buyer signed at 83,500', 83500);
    const closed = await sourced('The sale closed 61 days after listing', 61, { attr: 'closed-after-days' });
    s.script.reply = verdict(met('sc-001', signed.fact.id), met('sc-002', closed.fact.id));
    await end(true);
    assert.deepStrictEqual(s.rt.progressView(s.id).criteria.map((r) => [r.id, r.state]), [['sc-001', 'met'], ['sc-002', 'met']]);
    await begin();
    const proposed = await ProgressTool.execute({ action: 'proposeDone', note: 'Both criteria are met on the record.' }, s.opts);
    assert.strictEqual(proposed.ok, true);
    s.closeQuestion = proposed.questionId;
    await end(false);
    // Proposing closes nothing.
    assert.strictEqual(s.rt.getCase(s.id).status, 'active');
  });

  it("the owner's press closes the case, and the list is frozen", async () => {
    const res = await s.rt.answerQuestion(s.id, s.closeQuestion, { channel: 'in-app', optionId: 'done' });
    assert.deepStrictEqual(res.effect, { applied: 'done' });
    const meta = s.rt.getCase(s.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.by], ['done', 'owner']);
    const p = s.rt.progress(s.id);
    assert.strictEqual(p.closed.frozen, true);
    assert.deepStrictEqual(p.closed.criteria.map((c) => [c.id, c.state]), [['sc-001', 'met'], ['sc-002', 'met']]);
    assert.strictEqual(p.view, null);
  });
});
