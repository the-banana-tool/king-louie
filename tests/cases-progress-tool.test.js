// tests/cases-progress-tool.test.js
// Cases stage 8 (spec §6.2, §6.4, §6.7; R-C8-1, R-C8-2, R-C8-4): the
// Progress tool and its two questions. The model proposes; it never
// confirms a criterion, sets a state or closes a case. No network and no
// model: the router is a stub that returns a scripted reply.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { initializeTools, toolRegistry } = require('../src/tools');
const { ProgressTool } = require('../src/tools/builtin/case-progress-tool');
const { answerClass, PRESSED_TYPES } = require('../src/cases/mcp-tool-definitions');
const { scopeQuestionText, closeQuestionText, PRESS_CHANNELS } = require('../src/cases/verify/questions');
const { readinessFingerprint } = require('../src/cases/verify/readiness');
const { CASE_TOOL_NAMES, CASE_MODE_PROMPT } = require('../src/cases/chat-integration');
const { withCaseProfile } = require('./helpers/profile-settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-progress-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const HIDDEN = '(text hidden: not one plain line)';
const FIRST = 'Signed contract at or above the floor';
const metrics = { provider: 'openai', model: 'judge-model', inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.02 };
const verdict = (...criteria) => ({ type: 'text', content: JSON.stringify({ criteria }), llmMetrics: metrics });

// A case with a confirmed objective and one confirmed criterion (sc-001),
// active unless `gate` is false. `proposed` strings are added as the model's.
async function world({ settings = {}, reply = null, gate = true, proposed = [], objectiveBy = 'owner' } = {}) {
  const clock = { now: new Date('2026-10-21T09:00:00.000Z') };
  const calls = [];
  const router = {
    async routeTargets(targets, messages, opts) {
      calls.push({ targets, messages, opts });
      return typeof reply === 'function' ? reply() : reply;
    }
  };
  const tracker = { record: (e) => ({ provider: e.provider, model: e.model, totalTokens: e.totalTokens, cost: e.costUsd }) };
  const rt = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => withCaseProfile({ cases: { timeZone: 'UTC', ...settings } }),
    host: { inferenceRouter: router, getUsageTracker: () => tracker }
  });
  const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot', ...(objectiveBy ? { objectiveBy } : {}) });
  const id = info.id;
  rt.brief(id).update('why', 'Need the cash', { provenance: 'user' });
  if (gate) {
    await rt.applyScopeAction(id, { action: 'add', text: FIRST, by: 'owner-action' });
    rt.completeGating(id);
  }
  for (const text of proposed) rt.brief(id).append('successCriteria', text, { provenance: 'model' });
  let n = 0;
  let turn = null;
  const begin = async () => {
    n += 1;
    clock.now = new Date(clock.now.getTime() + 60000);
    turn = await rt.beginTurn(id, { turnId: `turn-${n}` });
    return turn;
  };
  const end = async () => {
    if (turn && rt.turns.get(id) === turn) await rt.endTurn(turn, { summary: 'test' });
    turn = null;
  };
  // The tool options of the running turn, or of no turn at all.
  const opts = () => ({ caseContext: turn ? rt.caseContext(turn, { ownerMessages: [] }) : { caseId: id, runtime: rt, turnId: 'turn-none', ownerMessages: [] } });
  const run = (params) => ProgressTool.execute(params, opts());
  // A sourced fact and a verification record citing it: `criterion` is met.
  const meet = (criterion = 'sc-001') => {
    const fact = rt.ledger(id).assert({ stmt: `Evidence for ${criterion}`, subject: 'evidence', attr: criterion, value: 1, source: src });
    const row = rt.scopeView(id).criteria.find((r) => r.id === criterion);
    rt.verification(id).addRecord({ criterion, criterionHash: row.hash, evidence: [fact.id], note: 'Recorded.', turnId: 'turn-0', model: 'example-provider:example-model' });
    return fact;
  };
  const open = (type) => rt.questions(id).open().filter((q) => q.payload?.type === type);
  const journals = () => fs.readdirSync(path.join(info.dir, 'journal')).filter((f) => f.endsWith('.md')).sort();
  return { rt, id, dir: info.dir, clock, calls, begin, end, run, opts, meet, open, journals };
}

describe('the Progress tool', () => {
  it('is a case tool that asks for no approval, and its prompt lines are static', () => {
    assert.strictEqual(toolRegistry.get('Progress'), ProgressTool);
    assert.strictEqual(ProgressTool.requiresApproval, false);
    assert.strictEqual(CASE_TOOL_NAMES[CASE_TOOL_NAMES.length - 1], 'Progress');
    assert.deepStrictEqual(ProgressTool.parameters.properties.action.enum, ['status', 'abandoned', 'abandon', 'askScope', 'proposeDone', 'verify']);
    // No parameter confirms a criterion, sets a state or forces anything.
    assert.deepStrictEqual(Object.keys(ProgressTool.parameters.properties).sort(),
      ['action', 'approach', 'decisionIds', 'factIds', 'note', 'tried', 'why', 'withdraw']);
    for (const line of [
      '- Success criteria you add are proposals until the owner confirms them; ask with Progress askScope.',
      '- You cannot mark a criterion met. Record the evidence as facts; King Louie checks them at the end of the turn.',
      '- When you drop an approach, record it with Progress abandon. Do not retry an approach the orientation lists as abandoned without a new fact.'
    ]) assert.ok(CASE_MODE_PROMPT.split('\n').includes(line), line);
    const r = ProgressTool.execute({ action: 'status' }, {});
    return r.then((out) => assert.match(out.error, /not attached to a case/));
  });

  it('each action is allowed in the statuses of the spec table', async () => {
    const abandon = { action: 'abandon', approach: 'Cold-calling listing agents', why: 'All three declined the lot' };
    const refused = (r, re) => { assert.strictEqual(r.ok, false); assert.match(r.error, re); assert.strictEqual(r.code, undefined); };
    const reads = async (w) => {
      assert.strictEqual((await w.run({ action: 'status' })).ok, true);
      assert.strictEqual((await w.run({ action: 'abandoned' })).ok, true);
    };

    const draft = await world({ gate: false, objectiveBy: null });
    await draft.begin();
    await reads(draft);
    assert.strictEqual((await draft.run(abandon)).ok, true);
    assert.strictEqual((await draft.run({ action: 'askScope' })).ok, true);
    refused(await draft.run({ action: 'proposeDone' }), /draft/);
    assert.strictEqual((await draft.run({ action: 'verify' })).code, 'VERIFY_NOT_ON_REQUEST');
    await draft.end();

    const active = await world({ proposed: ['Title search is clean'] });
    await active.begin();
    await reads(active);
    assert.strictEqual((await active.run(abandon)).ok, true);
    assert.strictEqual((await active.run({ action: 'askScope' })).ok, true);
    assert.strictEqual((await active.run({ action: 'proposeDone' })).code, 'NOT_READY');
    await active.end();

    const waiting = await world({ proposed: ['Title search is clean'] });
    waiting.rt.setStatus(waiting.id, 'needs-direction', { kind: 'failure', ref: 'journal/x-failure.md' });
    await waiting.begin();
    await reads(waiting);
    assert.strictEqual((await waiting.run(abandon)).ok, true);
    assert.strictEqual((await waiting.run({ action: 'askScope' })).ok, true);
    refused(await waiting.run({ action: 'proposeDone' }), /owner's direction/);
    await waiting.end();

    for (const [status, re] of [['paused', /paused/], ['done', /done/], ['abandoned', /abandoned/]]) {
      const w = await world({ proposed: ['Title search is clean'] });
      w.rt.setStatus(w.id, status, { kind: 'owner', by: 'owner' });
      await reads(w);
      for (const params of [abandon, { action: 'askScope' }, { action: 'proposeDone' }, { action: 'verify' }]) refused(await w.run(params), re);
      assert.deepStrictEqual(w.rt.abandoned(w.id).list().records, []);
      assert.deepStrictEqual(w.open('scope-confirm'), []);
    }
  });

  it('proposeDone is refused while a re-orientation is pending, and with no turn', async () => {
    const w = await world();
    w.meet();
    assert.match((await w.run({ action: 'proposeDone' })).error, /No case turn is running/);
    const turn = await w.begin();
    turn.reorientPending = true;
    turn.triggers = [{ kind: 'criterion-regressed', key: 'k', blocking: true, detail: 'sc-001 changed.' }];
    assert.match((await w.run({ action: 'proposeDone' })).error, /Re-orientation is required first/);
    assert.deepStrictEqual(w.open('close-proposal'), []);
    turn.reorientPending = false;
    await w.end();
  });

  it('status gives the computed view as untrusted output; a closed case gives its frozen record', async () => {
    const w = await world({ proposed: ['Title search is clean'] });
    const fact = w.meet();
    await w.begin();
    const r = await w.run({ action: 'status' });
    assert.strictEqual(r.untrusted_output, true);
    assert.match(r.summary, /^1 of 1 confirmed criteria met · 1 proposed \(not counted\) · not ready to close \(\d+ open\)$/);
    assert.deepStrictEqual([r.objective.text, r.objective.state], ['Sell the Lakeside lot', 'confirmed']);
    assert.deepStrictEqual(r.criteria.map((c) => [c.id, c.scope, c.state, c.text]), [['sc-001', 'confirmed', 'met', FIRST], ['sc-002', 'proposed', null, 'Title search is clean']]);
    assert.deepStrictEqual(r.criteria[0].evidence.map((e) => [e.id, e.holds, e.provenance]), [[fact.id, true, 'sourced']]);
    assert.strictEqual(r.readiness.ready, false);
    assert.ok(r.readiness.items.some((i) => i.id === 'criteria-confirmed' && i.state === 'open' && /sc-002/.test(i.fix)));
    await w.end();
    w.rt.setStatus(w.id, 'done', { kind: 'owner', by: 'owner' });
    const closed = await w.run({ action: 'status' });
    assert.deepStrictEqual([closed.ok, closed.frozen, closed.status, closed.untrusted_output], [true, true, 'done', true]);
    assert.strictEqual(closed.summary, r.summary);
    assert.deepStrictEqual(closed.criteria.map((c) => [c.id, c.state]), [['sc-001', 'met'], ['sc-002', null]]);
  });
});

describe('Progress abandon', () => {
  it('writes the record and one journal entry whose first line holds ids only', async () => {
    const w = await world();
    const fact = w.rt.ledger(w.id).assert({ stmt: 'Three agents declined', subject: 'agents', attr: 'declined', value: 3, source: src });
    w.rt.records(w.id).recordDecision({ decision: 'Stop cold-calling', factIds: [fact.id], alternatives: [] });
    const decisionId = w.rt.records(w.id).decisions()[0].id;
    await w.begin();
    const before = w.journals();
    const r = await w.run({
      action: 'abandon', approach: 'Cold-calling listing agents from the county directory', why: 'All three declined a lot under two acres',
      tried: ['Called three agents on 2026-10-08'], factIds: [fact.id], decisionIds: [decisionId]
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([r.record.id, r.record.turnId, r.record.factIds, r.record.decisionIds], ['ab-0001', 'turn-1', [fact.id], [decisionId]]);
    assert.deepStrictEqual(w.rt.abandoned(w.id).active().map((x) => x.approach), ['Cold-calling listing agents from the county directory']);
    const added = w.journals().filter((f) => !before.includes(f));
    assert.strictEqual(added.length, 1);
    assert.match(added[0], /-abandon\.md$/);
    const text = fs.readFileSync(path.join(w.dir, 'journal', added[0]), 'utf8');
    // The first line is what the cross-case index reads: ids only.
    assert.strictEqual(text.split('\n')[0], `Abandoned approach ab-0001 recorded (facts ${fact.id}; decisions ${decisionId}).`);
    assert.match(text, /Cold-calling listing agents from the county directory/);
    assert.match(text, /All three declined a lot under two acres/);

    const again = await w.run({ action: 'abandon', approach: 'cold-calling listing agents from the county directory', why: 'It failed again' });
    assert.deepStrictEqual([again.ok, again.code], [false, 'ALREADY_ABANDONED']);
    assert.match(again.error, /ab-0001/);
    for (const bad of [
      { approach: 'Mailing every owner on the lake', why: 'No reply', factIds: ['f-9999'] },
      { approach: 'Mailing every owner on the lake', why: 'No reply', decisionIds: ['D-999'] },
      { approach: 'Two\nlines', why: 'No reply at all' },
      { approach: 'Mailing every owner on the lake' }
    ]) {
      const refused = await w.run({ action: 'abandon', ...bad });
      assert.deepStrictEqual([refused.ok, refused.code], [false, 'ABANDON_INVALID'], JSON.stringify(bad));
    }
    assert.strictEqual(w.rt.abandoned(w.id).list().records.length, 1);
    assert.strictEqual(w.journals().length, before.length + 1);
    await w.end();
  });

  it('withdraw appends a line; abandoned lists every record with the withdrawn ones marked', async () => {
    const w = await world();
    await w.begin();
    await w.run({ action: 'abandon', approach: 'Cold-calling listing agents', why: 'All three declined the lot' });
    await w.run({ action: 'abandon', approach: 'Listing the lot at auction', why: 'The reserve was not met' });
    const before = w.journals();
    const r = await w.run({ action: 'abandon', withdraw: 'ab-0001', why: 'A new agent opened an office nearby' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([r.record.id, r.record.withdrawn.why], ['ab-0001', 'A new agent opened an office nearby']);
    const added = w.journals().filter((f) => !before.includes(f));
    assert.strictEqual(added.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(w.dir, 'journal', added[0]), 'utf8').split('\n')[0], 'Abandoned approach ab-0001 withdrawn.');
    const list = await w.run({ action: 'abandoned' });
    assert.deepStrictEqual([list.ok, list.untrusted_output], [true, true]);
    assert.deepStrictEqual(list.records.map((x) => [x.id, x.approach, Boolean(x.withdrawn)]), [['ab-0001', 'Cold-calling listing agents', true], ['ab-0002', 'Listing the lot at auction', false]]);
    const missing = await w.run({ action: 'abandon', withdraw: 'ab-0009', why: 'It never existed here' });
    assert.deepStrictEqual([missing.ok, missing.code], [false, 'ABANDON_INVALID']);
    // The file only grew: three lines, none rewritten.
    assert.strictEqual(fs.readFileSync(path.join(w.dir, '.kl', 'abandoned.jsonl'), 'utf8').trim().split('\n').length, 3);
    await w.end();
  });
});

describe('Progress askScope', () => {
  const THREE = ['Buyer financing is confirmed in writing', 'Title search is clean', 'Both owners of record have signed'];

  it('refuses when nothing is proposed', async () => {
    const w = await world();
    await w.begin();
    const r = await w.run({ action: 'askScope' });
    assert.deepStrictEqual([r.ok, r.code], [false, 'SCOPE_NOTHING_PROPOSED']);
    assert.deepStrictEqual(w.open('scope-confirm'), []);
    await w.end();
  });

  it('asks one question with the two options and the hashed entries; a second call names the open one', async () => {
    const w = await world({ proposed: THREE });
    await w.begin();
    const r = await w.run({ action: 'askScope' });
    assert.strictEqual(r.ok, true);
    const [q] = w.open('scope-confirm');
    assert.strictEqual(r.questionId, q.id);
    assert.deepStrictEqual([q.kind, q.urgency, q.defaultOnSilence], ['question', 'normal', 'hold']);
    assert.deepStrictEqual(q.options, [{ id: 'all', label: 'Confirm all' }, { id: 'none', label: 'Drop all' }]);
    const rows = w.rt.scopeView(w.id).criteria.filter((c) => c.state !== 'confirmed');
    assert.deepStrictEqual(q.payload.entries, rows.map((c) => ({ id: c.id, hash: c.hash })));
    assert.deepStrictEqual([q.payload.key, q.payload.disclosable, q.payload.objective, q.payload.turnId, q.payload.mcpAnswerable], ['scope-confirm', false, null, 'turn-1', true]);
    assert.deepStrictEqual(q.text.split('\n'), [
      'Case: Lakeside lot',
      'Confirm these success criteria? They count for nothing until you confirm them.',
      `1. sc-002: ${THREE[0]}`,
      `2. sc-003: ${THREE[1]}`,
      `3. sc-004: ${THREE[2]}`
    ]);
    // Charged: the model asked.
    assert.strictEqual(w.rt.budget(w.id).status().questionsPerDay.spent, 1);
    const again = await w.run({ action: 'askScope' });
    assert.deepStrictEqual([again.ok, again.code], [false, 'SCOPE_QUESTION_OPEN']);
    assert.match(again.error, new RegExp(q.id));
    assert.strictEqual(w.open('scope-confirm').length, 1);
    await w.end();
  });

  it('scope-confirm is a spoken question', async () => {
    const w = await world({ proposed: THREE });
    await w.begin();
    await w.run({ action: 'askScope' });
    assert.strictEqual(answerClass(w.open('scope-confirm')[0]), 'spoken');
    assert.strictEqual(PRESSED_TYPES.has('scope-confirm'), false);
    await w.end();
  });

  it('a proposed objective is asked about too, and the daily allowance holds the question', async () => {
    const w = await world({ gate: false, objectiveBy: null });
    await w.begin();
    assert.strictEqual((await w.run({ action: 'askScope' })).ok, true);
    const [q] = w.open('scope-confirm');
    assert.deepStrictEqual(q.payload.entries, []);
    assert.strictEqual(q.payload.objective, w.rt.scopeView(w.id).objective.hash);
    assert.deepStrictEqual(q.text.split('\n').slice(1), [
      'Confirm the objective? You have not confirmed it yet.',
      '"Drop all" leaves the objective as it is; edit it in the case panel.',
      'Objective: Sell the Lakeside lot'
    ]);
    await w.end();

    const spent = await world({ proposed: THREE });
    spent.rt.store.updateMeta(spent.id, { budget: { questionsPerDay: 1 } });
    spent.rt.budget(spent.id).charge('questionsPerDay', 1, {});
    await spent.begin();
    const held = await spent.run({ action: 'askScope' });
    assert.strictEqual(held.ok, false);
    assert.strictEqual(held.error, 'The daily question allowance (questionsPerDay) is spent. Record what you need as an unknown and ask again tomorrow.');
    await spent.end();
  });

  it('answering "all" in the owner\'s words confirms exactly the entries that were shown', async () => {
    const w = await world({ proposed: THREE });
    await w.begin();
    const { questionId } = await w.run({ action: 'askScope' });
    await w.end();
    const res = await w.rt.answerQuestion(w.id, questionId, { channel: 'in-app-chat', optionId: 'all', quote: 'confirm all three please' });
    assert.strictEqual(res.fact.disclosable, false);
    assert.strictEqual(res.fact.stmt, `Owner answered ${questionId} (scope): Confirm all`);
    const rows = w.rt.scopeView(w.id).criteria;
    assert.deepStrictEqual(rows.map((r) => r.state), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
    for (const row of rows.slice(1)) {
      assert.deepStrictEqual([row.origin, row.confirmed.by, row.confirmed.channel, row.confirmed.quote, row.confirmed.factId],
        ['file', 'question', 'in-app-chat', 'confirm all three please', res.fact.id]);
    }
    assert.deepStrictEqual(res.effect, { applied: 'scope', confirmed: ['sc-002', 'sc-003', 'sc-004'], dropped: [], skipped: [] });
  });

  it('a criterion reworded after the question was asked is skipped and noted', async () => {
    const w = await world({ proposed: THREE });
    await w.begin();
    const { questionId } = await w.run({ action: 'askScope' });
    // The model rewords one proposal and adds another before the answer.
    const list = w.rt.scopeView(w.id).criteria.map((r) => r.text);
    list[2] = 'Title search is clean and insured';
    w.rt.writeScope(w.id, { field: 'successCriteria', value: [...list, 'Sold above asking'], origin: 'model', addedBy: 'turn-1' });
    await w.end();
    const res = await w.rt.answerQuestion(w.id, questionId, { channel: 'in-app', optionId: 'all' });
    const rows = w.rt.scopeView(w.id).criteria;
    assert.deepStrictEqual(rows.map((r) => [r.text, r.state]), [
      [FIRST, 'confirmed'], [THREE[0], 'confirmed'], ['Title search is clean and insured', 'proposed'], [THREE[2], 'confirmed'], ['Sold above asking', 'proposed']
    ]);
    assert.deepStrictEqual(res.effect.skipped, ['sc-003']);
    const notes = w.rt.questions(w.id).get(questionId).notes.map((n) => n.text);
    assert.deepStrictEqual(notes, ['Not applied to sc-003: the words changed after this was asked. Confirm or drop what is there now in the case panel.']);
  });

  it('a free-text answer confirms nothing and says how to answer', async () => {
    const w = await world({ proposed: THREE });
    await w.begin();
    const { questionId } = await w.run({ action: 'askScope' });
    await w.end();
    const res = await w.rt.answerQuestion(w.id, questionId, { channel: 'mcp-stdio', text: 'yes those look right to me', quote: 'yes those look right to me' });
    assert.deepStrictEqual(w.rt.scopeView(w.id).criteria.map((r) => r.state), ['confirmed', 'proposed', 'proposed', 'proposed']);
    assert.strictEqual(res.effect.applied, false);
    assert.deepStrictEqual(w.rt.questions(w.id).get(questionId).notes.map((n) => n.text),
      ['Answer with "Confirm all" or "Drop all", or use the buttons beside each criterion in the case panel.']);
  });

  it('"none" removes the proposed strings from brief.md and keeps the confirmed one', async () => {
    const w = await world({ proposed: THREE });
    await w.begin();
    const { questionId } = await w.run({ action: 'askScope' });
    await w.end();
    const res = await w.rt.answerQuestion(w.id, questionId, { channel: 'in-app', optionId: 'none' });
    assert.deepStrictEqual(res.effect, { applied: 'scope', confirmed: [], dropped: ['sc-002', 'sc-003', 'sc-004'], skipped: [] });
    assert.deepStrictEqual(w.rt.brief(w.id).read().data.successCriteria, [FIRST]);
    const brief = fs.readFileSync(path.join(w.dir, 'brief.md'), 'utf8');
    for (const text of THREE) assert.ok(!brief.includes(text), text);
    assert.deepStrictEqual(w.rt.scopeView(w.id).removed.map((r) => r.id), ['sc-002', 'sc-003', 'sc-004']);
  });

  it('the objective is confirmed with "all" only while its words are the ones shown, and never dropped', async () => {
    const w = await world({ gate: false, objectiveBy: null });
    await w.begin();
    const { questionId } = await w.run({ action: 'askScope' });
    await w.end();
    await w.rt.answerQuestion(w.id, questionId, { channel: 'mobile', optionId: 'all' });
    const objective = w.rt.scopeView(w.id).objective;
    assert.deepStrictEqual([objective.state, objective.confirmed.by, objective.confirmed.channel], ['confirmed', 'question', 'mobile']);

    const other = await world({ gate: false, objectiveBy: null });
    await other.begin();
    const asked = await other.run({ action: 'askScope' });
    await other.end();
    const res = await other.rt.answerQuestion(other.id, asked.questionId, { channel: 'in-app', optionId: 'none' });
    assert.strictEqual(other.rt.brief(other.id).read().data.objective, 'Sell the Lakeside lot');
    assert.strictEqual(other.rt.scopeView(other.id).objective.state, 'proposed');
    assert.deepStrictEqual(res.effect.dropped, []);
  });

  // Review finding 1 (2026-10-14): a scope answer confirms the objective
  // only from a press (in-app, mobile) or from King Louie's chat, where the
  // quote was checked in the owner's turn. An answer over MCP or a contact
  // channel is recorded and leaves the objective proposed. Criteria are as
  // R-C8-2 says (a spoken answer with a quote confirms them), unchanged.
  it('the objective is confirmed by a scope answer only from a press or the checked chat; other channels confirm the criteria alone', async () => {
    const answer = async (channel, quote) => {
      const w = await world({ gate: false, objectiveBy: null, proposed: THREE });
      await w.begin();
      const { questionId } = await w.run({ action: 'askScope' });
      await w.end();
      const res = await w.rt.answerQuestion(w.id, questionId, { channel, optionId: 'all', ...(quote ? { quote } : {}) });
      const view = w.rt.scopeView(w.id);
      return { w, questionId, res, objective: view.objective, criteria: view.criteria.map((r) => r.state) };
    };
    for (const channel of ['mcp-stdio', 'mcp-frontdoor', 'telegram', 'discord', 'email', 'sms', 'voice']) {
      const { w, questionId, res, objective, criteria } = await answer(channel, 'confirm all of them please');
      assert.strictEqual(objective.state, 'proposed', channel);
      assert.deepStrictEqual(criteria, ['confirmed', 'confirmed', 'confirmed'], channel);
      assert.deepStrictEqual(res.effect, { applied: 'scope', confirmed: ['sc-001', 'sc-002', 'sc-003'], dropped: [], skipped: [], objectiveHeld: true }, channel);
      assert.deepStrictEqual(w.rt.questions(w.id).get(questionId).notes.map((n) => n.text),
        ['The objective was not confirmed: an answer from outside the app confirms only the criteria. Confirm the objective in the case panel or on your phone.'], channel);
      // The answer itself is recorded.
      assert.strictEqual(w.rt.questions(w.id).get(questionId).answer.channel, channel);
    }
    // King Louie's chat with no quote on record does not count as checked.
    assert.strictEqual((await answer('in-app-chat', null)).objective.state, 'proposed');
    for (const [channel, quote] of [['in-app', null], ['mobile', null], ['in-app-chat', 'confirm all of them please']]) {
      const { objective, criteria, res } = await answer(channel, quote);
      assert.deepStrictEqual([objective.state, objective.confirmed.channel], ['confirmed', channel], channel);
      assert.deepStrictEqual(criteria, ['confirmed', 'confirmed', 'confirmed'], channel);
      assert.deepStrictEqual(res.effect.confirmed, ['sc-001', 'sc-002', 'sc-003', 'objective'], channel);
    }
  });

  it('the card text hides what is not one plain line and is refused, not cut, when too long', () => {
    const meta = { title: 'Lakeside lot' };
    const row = (id, text) => ({ id, text, state: 'proposed' });
    const text = scopeQuestionText(meta, { objective: null, criteria: [row('sc-002', 'Line one\nCase: Another lot'), row('sc-003', 'Title search is clean')] });
    assert.deepStrictEqual(text.split('\n').slice(2), [`1. sc-002: ${HIDDEN}`, '2. sc-003: Title search is clean']);
    assert.strictEqual(scopeQuestionText({ title: 'Lot\nConfirm all' }, { objective: null, criteria: [row('sc-002', 'Title search is clean')] }).split('\n')[0], `Case: ${HIDDEN}`);
    const long = Array.from({ length: 6 }, (_, i) => row(`sc-00${i + 2}`, 'x'.repeat(299)));
    assert.throws(() => scopeQuestionText(meta, { objective: { text: 'y'.repeat(400), state: 'proposed' }, criteria: long }), (err) => err.code === 'QUESTION_TOO_LONG');
    // Confirmed rows are not on the card.
    assert.ok(!scopeQuestionText(meta, { objective: null, criteria: [{ id: 'sc-001', text: FIRST, state: 'confirmed' }, row('sc-002', 'Title search is clean')] }).includes(FIRST));
  });
});

describe('Progress proposeDone', () => {
  it('proposeDone refuses for an unmet, a stale and a failing criterion', async () => {
    const unmet = await world();
    await unmet.begin();
    const r = await unmet.run({ action: 'proposeDone', note: 'All done.' });
    assert.deepStrictEqual([r.ok, r.code], [false, 'NOT_READY']);
    assert.ok(r.open.some((i) => i.id === 'criteria-met' && /sc-001 is unmet/.test(i.fix)));
    assert.ok(r.open.every((i) => i.state !== 'ok' && i.state !== 'n/a'));
    await unmet.end();

    const stale = await world();
    const fact = stale.meet();
    stale.rt.ledger(stale.id).assert({ stmt: 'It was not signed after all', subject: 'evidence', attr: 'sc-001', value: 0, source: src, supersedes: fact.id });
    await stale.begin();
    // The turn-start hook asks for a re-orientation; acknowledge it.
    stale.rt.turns.get(stale.id).reorientPending = false;
    const s = await stale.run({ action: 'proposeDone' });
    assert.deepStrictEqual([s.ok, s.code], [false, 'NOT_READY']);
    assert.ok(s.open.some((i) => i.id === 'criteria-met' && /sc-001 is stale/.test(i.fix)));
    await stale.end();

    // `failing`: the record cites a check run, and the newest run failed.
    const failing = await world();
    const checks = failing.rt.checks(failing.id);
    const passed = checks.addRun({ hash: 'sha256:x', head: 'abc1234', dirty: 0, result: 'pass', exitCode: 0, timedOut: false, ms: 5, turnId: 'turn-0' });
    const criterion = failing.rt.scopeView(failing.id).criteria.find((r) => r.id === 'sc-001');
    failing.rt.verification(failing.id).addRecord({ criterion: 'sc-001', criterionHash: criterion.hash, evidence: [passed.id], note: 'The suite passed.', turnId: 'turn-0', model: 'example-provider:example-model' });
    checks.addRun({ hash: 'sha256:x', head: 'abc1234', dirty: 0, result: 'fail', exitCode: 1, timedOut: false, ms: 5, turnId: 'turn-0' });
    assert.deepStrictEqual(failing.rt.progressView(failing.id).criteria.find((c) => c.id === 'sc-001').reasons, ['the newest check run (chk-0002) failed']);
    await failing.begin();
    const f = await failing.run({ action: 'proposeDone' });
    assert.deepStrictEqual([f.ok, f.code], [false, 'NOT_READY']);
    assert.ok(f.open.some((i) => i.id === 'criteria-met' && /sc-001 is failing/.test(i.fix)));
    await failing.end();

    for (const w of [unmet, stale, failing]) assert.deepStrictEqual(w.open('close-proposal'), []);
  });

  it('refuses with NO_CONFIRMED_CRITERIA when nothing is confirmed', async () => {
    const w = await world({ gate: false, proposed: ['Title search is clean'] });
    w.rt.store.updateMeta(w.id, { status: 'active' });
    await w.begin();
    const r = await w.run({ action: 'proposeDone' });
    assert.deepStrictEqual([r.ok, r.code], [false, 'NO_CONFIRMED_CRITERIA']);
    await w.end();
  });

  it('with every confirmed criterion met it asks one pressed question that shows the list', async () => {
    const w = await world({ proposed: ['Title search is clean'] });
    w.meet();
    await w.begin();
    const before = w.rt.progress(w.id);
    const r = await w.run({ action: 'proposeDone', note: 'The contract is signed and recorded.' });
    assert.strictEqual(r.ok, true);
    const [q] = w.open('close-proposal');
    assert.strictEqual(r.questionId, q.id);
    assert.strictEqual(answerClass(q), 'pressed');
    assert.deepStrictEqual(q.options, [{ id: 'done', label: 'Mark done' }, { id: 'keep', label: 'Keep working' }]);
    assert.deepStrictEqual([q.kind, q.urgency, q.defaultOnSilence], ['question', 'normal', 'hold']);
    assert.deepStrictEqual(
      [q.payload.key, q.payload.mcpAnswerable, q.payload.disclosable, q.payload.fingerprint, q.payload.turnId],
      ['close-proposal', false, false, readinessFingerprint(before.readiness), 'turn-1']
    );
    const lines = q.text.split('\n');
    assert.deepStrictEqual(lines.slice(0, 3), ['Case: Lakeside lot', 'The case proposes to close as done.', before.summary]);
    assert.ok(lines.includes('Owner: confirm or drop 1 proposed criterion (sc-002).'));
    assert.strictEqual(lines[lines.length - 1], 'Note from the case: The contract is signed and recorded.');
    assert.strictEqual(w.rt.budget(w.id).status().questionsPerDay.spent, 1);
    assert.strictEqual(w.rt.getCase(w.id).status, 'active');

    const again = await w.run({ action: 'proposeDone' });
    assert.deepStrictEqual([again.ok, again.code], [false, 'CLOSE_PROPOSAL_OPEN']);
    assert.match(again.error, new RegExp(q.id));
    assert.strictEqual(w.open('close-proposal').length, 1);
    await w.end();
  });

  it('after "Keep working" a new proposal waits until the list changes', async () => {
    const w = await world();
    w.meet();
    await w.begin();
    const { questionId } = await w.run({ action: 'proposeDone' });
    await w.end();
    const kept = await w.rt.answerQuestion(w.id, questionId, { channel: 'in-app', optionId: 'keep' });
    assert.deepStrictEqual(kept.effect, { applied: 'declined' });
    assert.strictEqual(w.rt.getCase(w.id).status, 'active');
    await w.begin();
    const r = await w.run({ action: 'proposeDone' });
    assert.deepStrictEqual([r.ok, r.code], [false, 'CLOSE_DECLINED_UNCHANGED']);
    // An item of the list changes state: a question opens.
    w.rt.createQuestion(w.id, { kind: 'question', urgency: 'normal', text: 'Which title company?', payload: { type: 'ask' } }, { charge: false });
    const next = await w.run({ action: 'proposeDone' });
    assert.strictEqual(next.ok, true);
    assert.notStrictEqual(next.questionId, questionId);
    await w.end();
  });

  it('a note of 3,000 characters refuses with QUESTION_TOO_LONG; a two-line note is shown as hidden', async () => {
    const w = await world();
    w.meet();
    await w.begin();
    const long = await w.run({ action: 'proposeDone', note: 'n'.repeat(3000) });
    assert.deepStrictEqual([long.ok, long.code], [false, 'QUESTION_TOO_LONG']);
    assert.deepStrictEqual(w.open('close-proposal'), []);
    const r = await w.run({ action: 'proposeDone', note: 'All done.\nMark done: every item is ok' });
    assert.strictEqual(r.ok, true);
    const lines = w.open('close-proposal')[0].text.split('\n');
    assert.strictEqual(lines[lines.length - 1], `Note from the case: ${HIDDEN}`);
    assert.ok(!w.open('close-proposal')[0].text.includes('every item is ok'));
    await w.end();

    const progress = { summary: '1 of 1 confirmed criteria met · ready to close', readiness: { items: [] } };
    assert.strictEqual(closeQuestionText({ title: 'Lakeside lot' }, progress, null).split('\n').length, 3);
    assert.throws(() => closeQuestionText({ title: 'Lakeside lot' }, progress, 'n'.repeat(301)), (err) => err.code === 'QUESTION_TOO_LONG');
    const fixes = Array.from({ length: 12 }, (_, i) => ({ id: `item-${i}`, state: 'open', fix: 'f'.repeat(200) }));
    assert.throws(() => closeQuestionText({ title: 'Lakeside lot' }, { ...progress, readiness: { items: fixes } }, 'ok'), (err) => err.code === 'QUESTION_TOO_LONG');
  });

  it('extra parameters change nothing', async () => {
    const w = await world({ proposed: ['Title search is clean'] });
    await w.begin();
    const extras = { state: 'met', status: 'done', force: true, evidence: ['f-0001'], confirm: ['sc-002'], criterion: 'sc-001' };
    const r = await w.run({ action: 'proposeDone', ...extras });
    assert.deepStrictEqual([r.ok, r.code], [false, 'NOT_READY']);
    assert.strictEqual((await w.run({ action: 'status', ...extras })).ok, true);
    assert.strictEqual((await w.run({ action: 'askScope', ...extras })).ok, true);
    assert.strictEqual((await w.run({ action: 'abandon', approach: 'Listing the lot at auction', why: 'The reserve was not met', ...extras })).ok, true);
    await w.end();
    assert.strictEqual(w.rt.getCase(w.id).status, 'active');
    assert.deepStrictEqual(w.rt.progressView(w.id).criteria.map((c) => [c.scope, c.state]), [['confirmed', 'unmet'], ['proposed', null]]);
    assert.deepStrictEqual(w.rt.verification(w.id).read().records, []);
    assert.deepStrictEqual(w.open('close-proposal'), []);
    const unknown = await w.run({ action: 'setState', ...extras });
    assert.strictEqual(unknown.ok, false);
  });
});

describe('the answer to a close proposal', () => {
  async function proposed() {
    const w = await world();
    const fact = w.meet();
    await w.begin();
    const { questionId } = await w.run({ action: 'proposeDone', note: 'Signed and recorded.' });
    await w.end();
    return { w, questionId, fact };
  }

  it('a press is in-app or mobile', () => {
    assert.deepStrictEqual([...PRESS_CHANNELS], ['in-app', 'mobile']);
    assert.ok(Object.isFrozen(PRESS_CHANNELS));
    assert.ok(PRESSED_TYPES.has('close-proposal') && PRESSED_TYPES.has('check-approve'));
  });

  it('"Mark done" pressed in the app or on the phone closes the case as the owner', async () => {
    for (const channel of ['in-app', 'mobile']) {
      const { w, questionId } = await proposed();
      const res = await w.rt.answerQuestion(w.id, questionId, { channel, optionId: 'done' });
      const meta = w.rt.getCase(w.id);
      assert.deepStrictEqual([meta.status, meta.statusReason.by, meta.statusReason.kind, meta.statusReason.ref], ['done', 'owner', 'owner', res.fact.id], channel);
      assert.strictEqual(meta.statusReason.note, `close proposal ${questionId}; open at close: none`);
      assert.deepStrictEqual(res.effect, { applied: 'done' });
      assert.strictEqual(res.fact.disclosable, false);
      assert.strictEqual(w.rt.progress(w.id).closed.frozen, true);
    }
  });

  it('the same answer from a channel that is not a press is not applied', async () => {
    for (const channel of ['in-app-chat', 'mcp-stdio', 'mcp-frontdoor', 'telegram']) {
      const { w, questionId } = await proposed();
      const res = await w.rt.answerQuestion(w.id, questionId, { channel, optionId: 'done', quote: 'yes mark it done' });
      assert.strictEqual(w.rt.getCase(w.id).status, 'active', channel);
      assert.strictEqual(res.effect.applied, false);
      assert.deepStrictEqual(w.rt.questions(w.id).get(questionId).notes.map((n) => n.text),
        ['Not applied: a case is closed only by the button on this question in the app, or on the paired phone.']);
      assert.strictEqual(w.rt.verification(w.id).read().closed, null);
    }
  });

  it("the owner's press closes a case that is not ready", async () => {
    const { w, questionId, fact } = await proposed();
    const newer = w.rt.ledger(w.id).assert({ stmt: 'It was not signed after all', subject: 'evidence', attr: 'sc-001', value: 0, source: src, supersedes: fact.id });
    assert.strictEqual(w.rt.progressView(w.id).criteria[0].state, 'stale');
    await w.rt.answerQuestion(w.id, questionId, { channel: 'in-app', optionId: 'done' });
    const meta = w.rt.getCase(w.id);
    assert.strictEqual(meta.status, 'done');
    assert.strictEqual(meta.statusReason.note, `close proposal ${questionId}; open at close: criteria-met (sc-001)`);
    const closed = w.rt.progress(w.id).closed;
    assert.deepStrictEqual(closed.criteria.map((c) => [c.id, c.state]), [['sc-001', 'stale']]);
    assert.match(closed.criteria[0].reasons[0], new RegExp(`${fact.id} was superseded by ${newer.id}`));
  });

  it('a free-text answer closes nothing', async () => {
    const { w, questionId } = await proposed();
    const res = await w.rt.answerQuestion(w.id, questionId, { channel: 'in-app', text: 'done' });
    assert.strictEqual(w.rt.getCase(w.id).status, 'active');
    assert.strictEqual(res.effect.applied, false);
  });
});

describe('Progress verify', () => {
  it('is refused unless cases.verify.when is request', async () => {
    const w = await world({ reply: verdict() });
    w.meet();
    await w.begin();
    const r = await w.run({ action: 'verify' });
    assert.deepStrictEqual([r.ok, r.code], [false, 'VERIFY_NOT_ON_REQUEST']);
    assert.strictEqual(w.calls.length, 0);
    await w.end();
  });

  it('runs the pass over the whole record on request, and proposeDone runs it first', async () => {
    let fact = null;
    const w = await world({
      settings: { verify: { when: 'request' } },
      reply: () => verdict({ id: 'sc-001', status: 'met', evidence: [fact.id], note: 'The record shows it.' })
    });
    fact = w.rt.ledger(w.id).assert({ stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, source: src });
    assert.match((await w.run({ action: 'verify' })).error, /No case turn is running/);
    await w.begin();
    assert.strictEqual((await w.run({ action: 'proposeDone' })).ok, true, 'the pass ran first and its verdict was accepted');
    assert.strictEqual(w.calls.length, 1);
    assert.strictEqual(w.rt.progressView(w.id).criteria[0].state, 'met');
    const r = await w.run({ action: 'verify' });
    assert.deepStrictEqual([r.ok, r.ran, r.skipped, r.accepted, r.notAccepted, r.disagreed], [true, true, null, 0, 0, 0]);
    assert.strictEqual(w.calls.length, 2);
    assert.match(r.summary, /^1 of 1 confirmed criteria met/);
    await w.end();
  });
});
