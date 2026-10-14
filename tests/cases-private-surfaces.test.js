// tests/cases-private-surfaces.test.js
// A private case's text stays out of the surfaces that would hand it to a
// model outside the case (local inference spec 2026-10-13 §8.2, §8.5;
// R-LI-24, R-LI-32): the cross-case index redacts its hits for a case that
// is not private (a disclosable fact, the brief's title and objective, and
// the case title on the hit), the management tools give id, title and
// status only (MCP always, the chat's own tools unless the asking chat is
// private), and the envelope and delta cards say the send leaves the
// owner's hardware. Executors work as now. No core, no network: real
// CaseRuntimes on temp roots, marked through CaseRuntime#markPrivate.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { createCaseToolHandler } = require('../src/mcp/case-tools');
const { MANAGEMENT_TOOLS } = require('../src/tools/builtin/management-tools');
const { findDuplicates } = require('../src/cases/gates');
const { envelopeQuestionText, deltaQuestionText, renderEnvelopeQuestion } = require('../src/cases/executors/envelope');
const envelopeOps = require('../src/cases/executors/envelope-ops');
const { submitJob } = require('../src/cases/executors/submit');
const { egressPolicy } = require('../src/models/egress');
const fx = require('./helpers/executor-fixtures');
const { confirmAll } = require('./helpers/case-scope');
const { HAS_GIT } = require('./helpers/ingest-harness');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  fx.cleanup();
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-private-surfaces-')); dirs.push(d); return d; };
const web = { kind: 'url', ref: 'https://records.example.org/survey' };
const PRIVATE_LINE = 'This case is private. This send leaves your hardware.';

async function activeCase(rt, title, objective) {
  const info = await rt.createCase({ title, objective, force: true });
  rt.brief(info.id).update('why', 'The owner asked for it', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', objective, { provenance: 'model' });
  confirmAll(rt, info.id);
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

// Three open cases on one root: a private one with a disclosable fact, an
// ordinary one and a second private one.
async function world() {
  const rt = new CaseRuntime({ root: tmp(), getSettings: () => ({ cases: { timeZone: 'UTC' } }) });
  const lake = await activeCase(rt, 'Lakeside lot survey', 'File the Lakeside lot survey with the county');
  rt.ledger(lake.id).assert({ stmt: 'The Lakeside lot survey was filed with the county recorder', subject: 'survey', attr: 'filed', value: 'yes', source: web, disclosable: true });
  await rt.markPrivate(lake.id);
  const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door');
  const barn = await activeCase(rt, 'Barn roof repair', 'Repair the barn roof before winter');
  await rt.markPrivate(barn.id);
  return { rt, lake, door, barn };
}
const searchFrom = (rt, forCaseId, text) => rt.index.search({ text, forCaseId, excludeCaseId: forCaseId });

describe('the cross-case index and a private case', { skip: HAS_GIT ? false : 'git is not on PATH' }, () => {
  it('a private case\'s disclosable fact, its title and its objective are redacted for a case that is not private', async () => {
    const { rt, lake, door } = await world();
    const hits = searchFrom(rt, door.id, 'Lakeside lot survey filed county').filter((h) => h.caseId === lake.id);
    assert.ok(hits.some((h) => h.kind === 'fact') && hits.some((h) => h.kind === 'brief'), JSON.stringify(hits));
    for (const h of hits) {
      assert.strictEqual(h.text, null, `${h.kind} ${h.id}`);
      assert.strictEqual(h.redacted, true);
      assert.strictEqual(h.title, null, 'the case title is not on the hit either');
    }
    // With no asking case at all, the same.
    for (const h of rt.index.search({ text: 'Lakeside lot survey filed county' }).filter((x) => x.caseId === lake.id)) {
      assert.deepStrictEqual([h.text, h.redacted, h.title], [null, true, null]);
    }
  });

  it('between two private cases, and for the case itself, today\'s rule applies', async () => {
    const { rt, lake, barn } = await world();
    const fromBarn = searchFrom(rt, barn.id, 'Lakeside lot survey filed county').filter((h) => h.caseId === lake.id);
    const fact = fromBarn.find((h) => h.kind === 'fact');
    assert.match(fact.text, /^The Lakeside lot survey was filed with the county recorder/);
    assert.strictEqual(fact.title, 'Lakeside lot survey');
    assert.ok(fromBarn.some((h) => h.kind === 'brief' && h.id === 'title' && h.text === 'Lakeside lot survey'));
    const own = rt.index.search({ text: 'Lakeside lot survey filed county', forCaseId: lake.id }).filter((h) => h.caseId === lake.id && h.kind === 'fact');
    assert.match(own[0].text, /^The Lakeside lot survey was filed with the county recorder/);
  });

  it('an ordinary case\'s hits are unchanged for a private one', async () => {
    const { rt, lake, door } = await world();
    const hits = searchFrom(rt, lake.id, 'Rear door quotes written').filter((h) => h.caseId === door.id && h.kind === 'brief');
    assert.ok(hits.some((h) => h.id === 'title' && h.text === 'Rear door quotes' && h.title === 'Rear door quotes'));
  });

  it('a redacted hit still counts as a duplicate by the two-token rule, and names no title', async () => {
    const { rt, door } = await world();
    const crossCaseHits = rt.index.search({ text: 'survey filed county recorder', kinds: ['fact'], forCaseId: door.id, excludeCaseId: door.id });
    const dups = findDuplicates({ subject: 'survey', attr: 'status', text: 'survey filed county recorder', facts: new Map(), crossCaseHits });
    assert.strictEqual(dups.similar.length, 1);
    assert.strictEqual(dups.similar[0].caseTitle, null);
    assert.doesNotMatch(dups.similar[0].stmt, /Lakeside/);
    assert.match(dups.similar[0].stmt, /private/);
  });

  it('a private case is not offered to a case that is not private, by name, key or similar title', async () => {
    const { rt, lake, door, barn } = await world();
    const rows = rt.index.searchCases({ text: 'Lakeside lot survey county', forCaseId: door.id, excludeCaseId: door.id });
    assert.ok(!rows.some((r) => r.caseId === lake.id), JSON.stringify(rows));
    assert.ok(rt.index.searchCases({ text: 'Lakeside lot survey county', forCaseId: barn.id, excludeCaseId: barn.id }).some((r) => r.caseId === lake.id));
    assert.ok(!rt.index.openCaseHeads({ forCaseId: door.id }).some((h) => h.caseId === lake.id));
    assert.ok(rt.index.openCaseHeads({ forCaseId: barn.id }).some((h) => h.caseId === lake.id));
    // The owner's own create check still sees every open case (its list
    // goes to the owner; the management tools give id, title and status).
    await assert.rejects(rt.createCase({ title: 'Lakeside lot survey', objective: 'File the Lakeside lot survey with the county' }), (err) => err.code === 'SIMILAR_CASES' && err.similar.some((s) => s.caseId === lake.id));
  });
});

describe('the management tools and a private case (R-LI-32)', { skip: HAS_GIT ? false : 'git is not on PATH' }, () => {
  const handler = (rt, channel) => createCaseToolHandler({ getRuntime: () => rt, channel });

  for (const channel of ['mcp-stdio', 'mcp-frontdoor', 'in-app-chat']) {
    it(`R-LI-32: open_case and get_orientation on a private case give id, title and status only (${channel})`, async () => {
      const { rt, lake } = await world();
      const h = handler(rt, channel);
      for (const tool of ['open_case', 'get_orientation', 'list_questions', 'list_envelopes', 'list_playbooks']) {
        const out = await h.call(tool, { case: lake.id });
        assert.deepStrictEqual(Object.keys(out).sort(), ['data', 'id', 'private', 'status'], `${tool}: ${JSON.stringify(out)}`);
        assert.deepStrictEqual([out.id, out.status, out.private], [lake.id, 'active', true]);
        assert.deepStrictEqual(out.data.data, { title: 'Lakeside lot survey' });
        assert.strictEqual(out.data.untrusted_output, true);
        assert.doesNotMatch(JSON.stringify(out), /county recorder|File the Lakeside/);
      }
    });
  }

  it('R-LI-32: from a private asking chat the chat\'s own tools give the whole case', async () => {
    const { rt, lake } = await world();
    const h = handler(rt, 'in-app-chat');
    const open = await h.call('open_case', { case: lake.id }, { askerIsPrivate: true });
    assert.strictEqual(open.private, true);
    assert.ok(open.counts, 'the whole case');
    const orientation = await h.call('get_orientation', { case: lake.id }, { askerIsPrivate: true });
    assert.match(orientation.data.text, /county recorder/);
    // An MCP channel never takes the word of a caller.
    const mcp = await handler(rt, 'mcp-stdio').call('get_orientation', { case: lake.id }, { askerIsPrivate: true });
    assert.doesNotMatch(JSON.stringify(mcp), /county recorder/);
  });

  it('the chat tool reads the asking chat\'s mark from its turn\'s models, never from a parameter', async () => {
    const { rt, lake } = await world();
    const tool = MANAGEMENT_TOOLS.find((t) => t.name === 'get_orientation');
    const caseManagement = handler(rt, 'in-app-chat');
    const ordinary = await tool.execute({ case: lake.id }, { caseManagement, turnModels: { egress: null } });
    assert.doesNotMatch(JSON.stringify(ordinary), /county recorder/);
    const marked = await tool.execute({ case: lake.id }, { caseManagement, turnModels: { egress: egressPolicy({ reason: 'private-chat', chatId: 'chat-1' }) } });
    assert.match(JSON.stringify(marked), /county recorder/);
    const forged = await tool.execute({ case: lake.id, askerIsPrivate: true }, { caseManagement, turnModels: { egress: null } });
    assert.doesNotMatch(JSON.stringify(forged), /county recorder/);
  });

  it('list_cases marks a private case and keeps id, title and status; list_questions leaves out its questions', async () => {
    const { rt, lake, door } = await world();
    rt.createQuestion(lake.id, { kind: 'question', text: 'Which surveyor filed the plat?', urgency: 'normal' }, { charge: false });
    rt.createQuestion(door.id, { kind: 'question', text: 'Which door style do you want?', urgency: 'normal' }, { charge: false });
    const h = handler(rt, 'mcp-stdio');
    const rows = await h.call('list_cases', {});
    const row = rows.find((r) => r.id === lake.id);
    assert.deepStrictEqual(Object.keys(row).sort(), ['data', 'id', 'private', 'status']);
    assert.deepStrictEqual([row.status, row.private, row.data.data.title], ['active', true, 'Lakeside lot survey']);
    const other = rows.find((r) => r.id === door.id);
    assert.strictEqual(other.private, undefined);
    assert.strictEqual(other.data.data.title, 'Rear door quotes');
    const questions = await h.call('list_questions', {});
    assert.ok(questions.some((q) => q.caseId === door.id));
    assert.ok(!questions.some((q) => q.caseId === lake.id));
    const fromPrivate = await handler(rt, 'in-app-chat').call('list_cases', {}, { askerIsPrivate: true });
    const full = fromPrivate.find((r) => r.id === lake.id);
    assert.strictEqual(full.private, true);
    assert.ok('openQuestions' in full, 'a private asker gets the whole row');
  });

  // Review fix, item 2: was "still answers". Over MCP a private case gives
  // id, title and status only, so answering it there is refused too.
  it('answer_question on a private case over mcp-stdio is refused private_case', async () => {
    const { rt, lake } = await world();
    const q = rt.createQuestion(lake.id, { kind: 'question', text: 'Which listing photo should lead?', options: [{ id: 'a', label: 'Lake view' }, { id: 'b', label: 'Road view' }], urgency: 'normal' }, { charge: false });
    await assert.rejects(handler(rt, 'mcp-stdio').call('answer_question', { case: lake.id, question_id: q.id, option_id: 'a', quote: 'Lead with the lake view' }), (err) => err.code === 'private_case');
    assert.strictEqual(rt.questions(lake.id).get(q.id).answer, null);
  });
});

describe('the approval cards of a private case (R-LI-24)', () => {
  const env = {
    id: 'env-01', executor: 'fake-agent', intent: 'Ask three brokers for a listing quote',
    caps: { usd: 20, contacts: 3, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30', tz: 'UTC' },
    channels: [], recipients: { allow: ['+15550100'] }, facts: [], rules: ['Never mention the asking price']
  };
  const deltas = [{ kind: 'recipient', value: '+15550102', text: 'adds recipient +15550102' }];

  it('R-LI-24: the envelope card and the delta card carry the line, after the host lines and before the wording', () => {
    const card = envelopeQuestionText(env, { caseTitle: 'Lakeside lot', private: true }).split('\n');
    const at = card.indexOf(PRIVATE_LINE);
    assert.ok(at > 0, card.join('\n'));
    assert.strictEqual(card[at - 1], 'Facts it may disclose (0): none');
    assert.strictEqual(card[at + 1], 'The wording below was written by the assistant or comes from the case ledger:');
    const delta = deltaQuestionText(env, deltas, { private: true }).split('\n');
    const d = delta.indexOf(PRIVATE_LINE);
    assert.strictEqual(delta[d - 1], '- adds recipient +15550102');
    assert.match(delta[d + 1], /^Intent: /);
    assert.ok(renderEnvelopeQuestion(env, { private: true }).includes(PRIVATE_LINE));
  });

  it('an ordinary case\'s cards are as before, byte for byte', () => {
    assert.strictEqual(envelopeQuestionText(env, { caseTitle: 'Lakeside lot', private: false }), envelopeQuestionText(env, { caseTitle: 'Lakeside lot' }));
    assert.ok(!envelopeQuestionText(env, { caseTitle: 'Lakeside lot' }).includes('private'));
    assert.strictEqual(deltaQuestionText(env, deltas, { private: false }), deltaQuestionText(env, deltas, {}));
    assert.ok(!deltaQuestionText(env, deltas, {}).includes('private'));
  });

  it('R-LI-24: an executor submits in a private case: the card says so, and the gated payload goes out as now', { skip: HAS_GIT ? false : 'git is not on PATH' }, async () => {
    const e = fx.setupExecutors();
    const ctl = fx.withFakeAgent(e, 'fake-agent');
    const meta = await fx.activeCase(e.runtime);
    await e.runtime.markPrivate(meta.id);
    const acres = e.runtime.ledger(meta.id).assert({ stmt: 'Lot size is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, unit: 'acres', provenance: 'sourced', source: { kind: 'url', ref: 'https://records.example.org/lot' } });
    const r = await envelopeOps.requestEnvelope(e.registry, { caseId: meta.id }, {
      executor: 'fake-agent', intent: 'Ask brokers for a listing quote', recipients: { allow: ['+15550100'] },
      facts: [acres.id], rules: [], caps: { usd: 20, contacts: 3, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30' }
    });
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(e.runtime.questions(meta.id).get(r.questionId).text.split('\n').includes(PRIVATE_LINE));
    await e.runtime.answerQuestion(meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    envelopeOps.syncEnvelopes(e.registry, meta.id);
    await fx.openTurn(e.runtime, meta.id);
    const sent = await submitJob(e.registry, { caseId: meta.id, turnId: 'turn-1' }, {
      executor: 'fake-agent', envelopeId: r.envelopeId,
      payload: JSON.stringify({ recipients: [{ address: '+1 555 0100', name: 'Harbor Realty' }], text: `Hello, calling about the lot of {{${acres.id}}}.`, attemptsPerContact: 1 })
    });
    assert.strictEqual(sent.ok, true, sent.error);
    const [, jobView] = ctl.calls.find((c) => c[0] === 'submit');
    assert.strictEqual(jobView.payload.text, 'Hello, calling about the lot of 2.12 acres.');
  });
});

// Review fixes (plan "Review fixes", items 1 and 2).
describe('review fixes: the write tools and a private case', { skip: HAS_GIT ? false : 'git is not on PATH' }, () => {
  const handler = (rt, channel) => createCaseToolHandler({ getRuntime: () => rt, channel });
  const refusal = async (p) => { try { await p; } catch (err) { return err; } assert.fail('expected a refusal'); };
  const QUOTE = 'Please start a case to fix the gutter';
  const args = { title: 'Gutter fix', objective: 'fix the gutter', quote: QUOTE };

  it('item 1: create_case from a private chat creates a private case', async () => {
    const rt = new CaseRuntime({ root: tmp(), getSettings: () => ({ cases: { timeZone: 'UTC' } }) });
    const r = await handler(rt, 'in-app-chat').call('create_case', args, { ownerTurnText: QUOTE, askerIsPrivate: true });
    assert.strictEqual(rt.isPrivate(r.case_id), true);
  });

  it('item 1: the chat tool reads the mark from the turn\'s models', async () => {
    const rt = new CaseRuntime({ root: tmp(), getSettings: () => ({ cases: { timeZone: 'UTC' } }) });
    const tool = MANAGEMENT_TOOLS.find((t) => t.name === 'create_case');
    const caseManagement = handler(rt, 'in-app-chat');
    const marked = await tool.execute(args, { caseManagement, ownerTurnText: QUOTE, turnModels: { egress: egressPolicy({ reason: 'private-chat', chatId: 'chat-1' }) } });
    assert.strictEqual(marked.ok, true, marked.error);
    assert.strictEqual(rt.isPrivate(marked.result.case_id), true);
    const plain = await tool.execute({ ...args, title: 'Fence paint', objective: 'paint the fence', quote: 'Please start a case to paint the fence' }, { caseManagement, ownerTurnText: 'Please start a case to paint the fence', turnModels: { egress: null } });
    assert.strictEqual(plain.ok, true, plain.error);
    assert.strictEqual(rt.isPrivate(plain.result.case_id), false);
  });

  it('item 1: an ordinary chat and MCP create an ordinary case, whatever a caller says', async () => {
    const rt = new CaseRuntime({ root: tmp(), getSettings: () => ({ cases: { timeZone: 'UTC' } }) });
    const a = await handler(rt, 'in-app-chat').call('create_case', args, { ownerTurnText: QUOTE });
    assert.strictEqual(rt.isPrivate(a.case_id), false);
    const b = await handler(rt, 'mcp-stdio').call('create_case', { ...args, title: 'Shed roof', objective: 'fix the shed roof', quote: 'start a case to fix the shed roof' }, { askerIsPrivate: true });
    assert.strictEqual(rt.isPrivate(b.case_id), false);
  });

  const question = (rt, id) => rt.createQuestion(id, { kind: 'question', text: 'Which listing photo should lead?', options: [{ id: 'a', label: 'Lake view' }, { id: 'b', label: 'Road view' }], urgency: 'normal' }, { charge: false });

  for (const channel of ['mcp-stdio', 'mcp-frontdoor', 'in-app-chat']) {
    it(`item 2: answer_question on a private case is refused before the question is read (${channel})`, async () => {
      const { rt, lake } = await world();
      const q = question(rt, lake.id);
      // A quote that names no option would have listed the labels.
      const e = await refusal(handler(rt, channel).call('answer_question', { case: lake.id, question_id: q.id, option_id: 'a', quote: 'the first one please' }, { ownerTurnText: 'the first one please' }));
      assert.strictEqual(e.code, 'private_case');
      assert.doesNotMatch(JSON.stringify({ m: e.message, d: e.data }), /Lake view|Road view|listing photo/);
      const unknown = await refusal(handler(rt, channel).call('answer_question', { case: lake.id, question_id: 'q-9999', text: 'yes', quote: 'yes go ahead now' }, { ownerTurnText: 'yes go ahead now' }));
      assert.strictEqual(unknown.code, 'private_case', 'no question_not_found oracle');
      assert.strictEqual(rt.questions(lake.id).get(q.id).answer, null);
    });

    it(`item 2: revoke_envelope and cancel_case_job on a private case are refused before anything is read (${channel})`, async () => {
      const { rt, lake } = await world();
      const h = createCaseToolHandler({ getRuntime: () => rt, channel, getExecutorRegistry: () => ({ revokeEnvelope: async () => ({ ok: true }), cancelJob: async () => ({ ok: true }) }) });
      const env = await refusal(h.call('revoke_envelope', { case: lake.id, envelope: 'env-01', quote: 'revoke that envelope now' }, { ownerTurnText: 'revoke that envelope now' }));
      assert.strictEqual(env.code, 'private_case');
      const job = await refusal(h.call('cancel_case_job', { case: lake.id, job: 'job-0001', quote: 'cancel that job now' }, { ownerTurnText: 'cancel that job now' }));
      assert.strictEqual(job.code, 'private_case');
    });
  }

  it('item 2: from a private asking chat the chat\'s own answer_question answers a private case', async () => {
    const { rt, lake } = await world();
    const q = question(rt, lake.id);
    const r = await handler(rt, 'in-app-chat').call('answer_question', { case: lake.id, question_id: q.id, option_id: 'a', quote: 'Lead with the lake view' }, { ownerTurnText: 'Lead with the lake view', askerIsPrivate: true });
    assert.strictEqual(r.question_id, q.id);
    assert.strictEqual(rt.questions(lake.id).get(q.id).answer.channel, 'in-app-chat');
  });

  it('item 2: an ordinary case still answers over mcp-stdio', async () => {
    const { rt, door } = await world();
    const q = question(rt, door.id);
    const r = await handler(rt, 'mcp-stdio').call('answer_question', { case: door.id, question_id: q.id, option_id: 'a', quote: 'Lead with the lake view' });
    assert.strictEqual(r.question_id, q.id);
  });
});
