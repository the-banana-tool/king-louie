// tests/cases-detour-ipc.test.js
// Cases stage 5 IPC (spec §7): case:detours, case:resolveDetour,
// case:reindex, and case:create's similar-case refusal and force.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerDetourHandlers } = require('../src/ipc/detour-handlers');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const IPC = require('../src/ipc/constants');
const { CaseRuntime } = require('../src/cases');
const { historyContext } = require('./helpers/history-context');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-detour-ipc-'));
  dirs.push(root);
  const runtime = new CaseRuntime({ root, host: { interactive: () => true } });
  const history = historyContext([{ id: 'chat-1', title: 'Chat', messages: [] }]);
  const context = { getCaseRuntime: () => runtime, ...history };
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  registerCaseHandlers(ipcMain, context);
  registerDetourHandlers(ipcMain, context);
  return { runtime, handlers, call: (channel, payload) => handlers.get(channel)({}, payload) };
}

async function activeCase(runtime, title, objective) {
  const info = await runtime.createCase({ title, objective, force: true });
  runtime.brief(info.id).update('why', 'The owner asked for it', { provenance: 'user' });
  runtime.brief(info.id).append('successCriteria', objective, { provenance: 'model' });
  runtime.completeGating(info.id);
  return runtime.getCase(info.id);
}

const lockElsewhere = (dir) => fs.writeFileSync(path.join(dir, '.kl', 'lock'), JSON.stringify({ turnId: 'turn-9', pid: process.ppid, at: new Date().toISOString() }));

describe('detour IPC', () => {
  it('registers the three channels', () => {
    const { handlers } = setup();
    assert.deepStrictEqual([IPC.CASE_DETOURS, IPC.CASE_RESOLVE_DETOUR, IPC.CASE_REINDEX], ['case:detours', 'case:resolveDetour', 'case:reindex']);
    for (const ch of [IPC.CASE_DETOURS, IPC.CASE_RESOLVE_DETOUR, IPC.CASE_REINDEX]) assert.ok(handlers.has(ch), ch);
  });

  it('case:resolveDetour answers the routing question in-app, resolves, and is idempotent', async () => {
    const { runtime, call } = setup();
    const door = await activeCase(runtime, 'Rear door quotes', 'Three written quotes for the rear door');
    const phone = await activeCase(runtime, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    const p = await runtime.detours.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    const listed = await call(IPC.CASE_DETOURS, { caseId: door.id });
    assert.deepStrictEqual(listed.detours.map((d) => [d.id, d.status]), [['d-0001', 'proposed']]);
    const r = await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0001', optionId: 'attach-1' });
    assert.deepStrictEqual([r.ok, r.linkedCaseId, r.detour.status], [true, phone.id, 'attached']);
    const q = runtime.questions(door.id).get(p.questionId);
    assert.deepStrictEqual([q.answer.channel, q.answer.optionId], ['in-app', 'attach-1']);
    const again = await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0001', optionId: 'attach-1' });
    assert.deepStrictEqual([again.ok, again.existing], [true, true]);
    const after = await call(IPC.CASE_DETOURS, { caseId: door.id });
    assert.deepStrictEqual(after.related, [{ caseId: phone.id, title: 'Phone agent maintenance', status: 'active', relation: 'related', detour: 'd-0001' }]);
  });

  it('case:resolveDetour validates input and reports a retry question when the target closed', async () => {
    const { runtime, call } = setup();
    const door = await activeCase(runtime, 'Rear door quotes', 'Three written quotes for the rear door');
    const phone = await activeCase(runtime, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    await runtime.detours.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    assert.deepStrictEqual(await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0001', optionId: 'new', force: true }), { ok: false, error: 'force is not taken here: answer the similar-case question with "Create anyway".' });
    assert.deepStrictEqual(await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0404', optionId: 'decline' }), { ok: false, error: 'There is no detour d-0404 in this case.' });
    runtime.setStatus(phone.id, 'done', { kind: 'owner', by: 'owner' });
    const r = await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0001', optionId: 'attach-1' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Case "Phone agent maintenance" is done; pick another option.');
    assert.match(r.retryQuestionId, /^q-\d{4}$/);
  });

  it('case:resolveDetour: SIMILAR_CASES asks the pressed similar-case question, and its "Create anyway" button creates the case', async () => {
    const { runtime, handlers, call } = setup();
    const { registerCaseUnattendedHandlers } = require('../src/ipc/case-unattended-handlers');
    registerCaseUnattendedHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getCaseRuntime: () => runtime });
    const door = await activeCase(runtime, 'Rear door quotes', 'Three written quotes for the rear door');
    await runtime.detours.propose(door.id, { summary: 'Book a piano tuner for the living room', reason: 'Unrelated errand', blocks: true });
    const tuner = await runtime.createCase({ title: 'Book a piano tuner' });
    const refused = await call(IPC.CASE_RESOLVE_DETOUR, { caseId: door.id, detourId: 'd-0001', optionId: 'new' });
    assert.deepStrictEqual([refused.ok, refused.code], [false, 'SIMILAR_CASES']);
    assert.match(refused.error, /A similar case exists: "Book a piano tuner"/);
    assert.match(refused.retryQuestionId, /^q-\d{4}$/);
    const q = runtime.questions(door.id).get(refused.retryQuestionId);
    assert.deepStrictEqual([q.payload.type, q.options.map((o) => o.label)], ['detour-similar', ['Create anyway', 'Attach to "Book a piano tuner"']]);
    // The card's button: case:answerQuestion, channel in-app.
    const pressed = await call(IPC.CASE_ANSWER_QUESTION, { caseId: door.id, questionId: refused.retryQuestionId, optionId: 'create-anyway' });
    assert.deepStrictEqual([pressed.ok, pressed.effect.applied, pressed.effect.status], [true, 'detour', 'created']);
    const listed = await call(IPC.CASE_DETOURS, { caseId: door.id });
    assert.deepStrictEqual(listed.detours.map((d) => [d.id, d.status]), [['d-0001', 'superseded'], ['d-0002', 'created']]);
    assert.deepStrictEqual(runtime.questions(door.id).open().filter((x) => String(x.payload?.type).startsWith('detour')), []);
    const related = runtime.getCase(door.id).related;
    assert.ok(!related.some((x) => x.id.startsWith('pending:')), JSON.stringify(related));
    const createdId = related[0].id;
    assert.notStrictEqual(createdId, tuner.id);
    assert.deepStrictEqual(related.map((x) => [x.id, x.relation]), [[createdId, 'spawned'], [createdId, 'blocked-by']]);
    assert.strictEqual(runtime.getCase(createdId).title, 'Book a piano tuner for the living room');
  });


  it('case:detours returns busy without reconciling while another process holds the case', async () => {
    const { runtime, call } = setup();
    const door = await activeCase(runtime, 'Rear door quotes', 'Three written quotes for the rear door');
    await activeCase(runtime, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    const p = await runtime.detours.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    await runtime.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    lockElsewhere(door.dir);
    const r = await call(IPC.CASE_DETOURS, { caseId: door.id });
    assert.deepStrictEqual([r.ok, r.busy, r.detours[0].status], [true, true, 'proposed']);
    fs.rmSync(path.join(door.dir, '.kl', 'lock'));
    const next = await call(IPC.CASE_DETOURS, { caseId: door.id });
    assert.deepStrictEqual([next.busy, next.detours[0].status], [undefined, 'attached']);
  });

  it('case:reindex rebuilds the index', async () => {
    const { runtime, call } = setup();
    await activeCase(runtime, 'Rear door quotes', 'Three written quotes for the rear door');
    const r = await call(IPC.CASE_REINDEX, {});
    assert.deepStrictEqual([r.ok, r.cases], [true, 1]);
    assert.ok(r.docs >= 3 && Number.isFinite(r.ms));
    assert.ok(fs.existsSync(path.join(runtime.root, '.index', 'meta.json')));
  });

  it('case:create returns SIMILAR_CASES with the matches, and creates with force', async () => {
    const { call } = setup();
    const first = await call(IPC.CASE_CREATE, { title: 'Website redesign', objective: 'Refresh the public website' });
    const similar = await call(IPC.CASE_CREATE, { title: 'Redesign the website' });
    assert.deepStrictEqual([similar.ok, similar.code], [false, 'SIMILAR_CASES']);
    assert.deepStrictEqual(similar.similar, [{ caseId: first.case.id, title: 'Website redesign', status: 'draft', match: 'similar' }]);
    assert.strictEqual((await call(IPC.CASE_CREATE, { title: 'Redesign the website', force: 'true' })).error, 'force must be true or false.');
    const forced = await call(IPC.CASE_CREATE, { title: 'Redesign the website', force: true });
    assert.strictEqual(forced.ok, true);
    const unknown = await call(IPC.CASE_CREATE, { title: 'Mystery', type: 'land-sale' });
    assert.deepStrictEqual([unknown.ok, unknown.code], [false, 'UNKNOWN_CASE_TYPE']);
  });
});
