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
