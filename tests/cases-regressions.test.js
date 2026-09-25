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

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-regress-')); dirs.push(d); return d; };
const web = { kind: 'url', ref: 'https://listings.example.org/search?q=lakeside' };

async function openCase(runtime, title, { active = true, ownerMessages = [] } = {}) {
  const info = await runtime.createCase({ title, objective: 'Convert the property to cash' });
  if (active) {
    runtime.brief(info.id).update('why', 'Cash is needed for another repair', { provenance: 'user' });
    runtime.brief(info.id).append('successCriteria', 'Closed within 90 days', { provenance: 'model' });
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
      host: { inferenceRouter: { routeWithFallback: async () => { routed += 1; return '{"changed": true}'; } }, notify: () => {} }
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
