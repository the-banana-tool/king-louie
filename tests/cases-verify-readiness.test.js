// tests/cases-verify-readiness.test.js
// Cases stage 8, Task 6: the ready-to-close list (spec §6.4) and
// CaseRuntime.progress, on a real runtime in a temp root. Jobs, envelopes,
// the plan, ingest records and the case-type snapshot are plain files under
// .kl/, as the stores read them.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { closeReadiness, readinessFingerprint, ITEM_IDS } = require('../src/cases/verify/readiness');
const { confirmAll } = require('./helpers/case-scope');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ready-')); dirs.push(d); return d; };
const NOW = new Date('2026-10-21T09:00:00.000Z');
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const CANARY = 'ZEBRA-CANARY-7731';

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const kl = (dir, ...rest) => path.join(dir, '.kl', ...rest);
const snapshot = (dir) => {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === '.git') continue;
      if (e.isDirectory()) walk(next);
      else out[next] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, next))).digest('hex');
    }
  };
  walk('');
  return out;
};

// An active case with one confirmed criterion and a confirmed objective.
async function world({ type = 'general', title = 'Lakeside lot' } = {}) {
  const rt = new CaseRuntime({ root: tmp(), now: () => NOW, getSettings: () => ({ cases: { timeZone: 'UTC' } }) });
  const info = await rt.createCase({ title, type, objective: 'Sell the Lakeside lot', objectiveBy: 'owner' });
  rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
  if (type === 'software-repo') rt.brief(info.id).update('repo', 'https://github.com/example/phone-agent.git', { provenance: 'user' });
  await rt.applyScopeAction(info.id, { action: 'add', text: 'Signed contract at or above the floor', by: 'owner-action' });
  rt.completeGating(info.id);
  const item = (id) => rt.closeReadiness(info.id).items.find((i) => i.id === id);
  return { rt, id: info.id, dir: info.dir, item };
}

// A sourced fact and a verification record citing it: sc-001 is met.
function meet(rt, id, criterion = 'sc-001') {
  const fact = rt.ledger(id).assert({ stmt: 'The contract was signed at 81,000', subject: 'contract', attr: `signed-${criterion}`, value: 81000, source: src });
  const row = rt.scopeView(id).criteria.find((r) => r.id === criterion);
  rt.verification(id).addRecord({ criterion, criterionHash: row.hash, evidence: [fact.id], note: 'Signed.', turnId: 'turn-1', model: 'example-provider:example-model' });
  return fact;
}

describe('closeReadiness', () => {
  it('lists the items in order, each with whose it is, and is ready only when all are ok or n/a', async () => {
    const { rt, id } = await world();
    let r = rt.closeReadiness(id);
    assert.deepStrictEqual(r.items.map((i) => i.id), [...ITEM_IDS]);
    assert.deepStrictEqual(ITEM_IDS, [
      'objective-confirmed', 'criteria-confirmed', 'criteria-met', 'unknowns-resolved', 'questions-answered', 'jobs-settled',
      'plan-settled', 'envelopes-closed', 'detours-settled', 'documents-reviewed', 'tree-clean', 'branch-merged'
    ]);
    assert.strictEqual(r.computedAt, NOW.toISOString());
    assert.deepStrictEqual(Object.fromEntries(r.items.map((i) => [i.id, i.state])), {
      'objective-confirmed': 'ok', 'criteria-confirmed': 'ok', 'criteria-met': 'open', 'unknowns-resolved': 'ok', 'questions-answered': 'ok',
      'jobs-settled': 'ok', 'plan-settled': 'ok', 'envelopes-closed': 'ok', 'detours-settled': 'ok', 'documents-reviewed': 'ok', 'tree-clean': 'n/a', 'branch-merged': 'n/a'
    });
    assert.deepStrictEqual(Object.fromEntries(r.items.map((i) => [i.id, i.by])), {
      'objective-confirmed': 'owner', 'criteria-confirmed': 'owner', 'criteria-met': 'case', 'unknowns-resolved': 'either', 'questions-answered': 'owner',
      'jobs-settled': 'case', 'plan-settled': 'case', 'envelopes-closed': 'owner', 'detours-settled': 'owner', 'documents-reviewed': 'owner', 'tree-clean': 'either', 'branch-merged': 'either'
    });
    assert.strictEqual(r.ready, false);
    for (const i of r.items) {
      assert.deepStrictEqual(Object.keys(i), ['id', 'state', 'by', 'count', 'refs', 'fix', 'note'], i.id);
      if (i.state === 'ok' || i.state === 'n/a') assert.deepStrictEqual([i.count, i.refs, i.fix], [0, [], null], i.id);
    }
    meet(rt, id);
    r = rt.closeReadiness(id);
    assert.strictEqual(r.items.find((i) => i.id === 'criteria-met').state, 'ok');
    assert.strictEqual(r.ready, true);
  });

  it('objective-confirmed and criteria-confirmed are the owner\'s', async () => {
    const rt = new CaseRuntime({ root: tmp(), now: () => NOW });
    const info = await rt.createCase({ title: 'Roof quotes' });
    const item = (name) => rt.closeReadiness(info.id).items.find((i) => i.id === name);
    assert.deepStrictEqual([item('objective-confirmed').state, item('objective-confirmed').fix], ['open', 'Owner: give the case an objective in the case panel.']);
    assert.deepStrictEqual([item('criteria-confirmed').state, item('criteria-confirmed').count, item('criteria-confirmed').fix], ['open', 0, 'Owner: add or confirm a success criterion in the case panel.']);
    assert.strictEqual(item('criteria-met').state, 'n/a');

    rt.brief(info.id).update('objective', 'Three roof quotes', { provenance: 'model' });
    rt.brief(info.id).update('successCriteria', ['Three written quotes', 'A start date'], { provenance: 'model' });
    assert.deepStrictEqual([item('objective-confirmed').state, item('objective-confirmed').fix], ['open', 'Owner: confirm the objective in the case panel.']);
    assert.deepStrictEqual(item('criteria-confirmed'), {
      id: 'criteria-confirmed', state: 'open', by: 'owner', count: 2, refs: ['sc-001', 'sc-002'], fix: 'Owner: confirm or drop 2 proposed criteria (sc-001, sc-002).', note: null
    });

    const view = rt.scopeView(info.id);
    await rt.applyScopeAction(info.id, { action: 'confirm', target: 'sc-001', hash: view.criteria[0].hash, by: 'owner-action' });
    // One confirmed, one still proposed: open until none is proposed.
    assert.deepStrictEqual([item('criteria-confirmed').state, item('criteria-confirmed').fix], ['open', 'Owner: confirm or drop 1 proposed criterion (sc-002).']);
    confirmAll(rt, info.id);
    assert.strictEqual(item('criteria-confirmed').state, 'ok');
    assert.strictEqual(item('objective-confirmed').state, 'ok');
  });

  it('criteria-met names each confirmed criterion that is not met, with its state', async () => {
    const { rt, id, item } = await world();
    await rt.applyScopeAction(id, { action: 'add', text: 'Closed within 90 days', by: 'owner-action' });
    await rt.applyScopeAction(id, { action: 'add', text: 'Buyer pays the closing costs', by: 'owner-action' });
    const fact = meet(rt, id, 'sc-001');
    meet(rt, id, 'sc-002');
    assert.deepStrictEqual(item('criteria-met'), {
      id: 'criteria-met', state: 'open', by: 'case', count: 1, refs: ['sc-003'],
      fix: 'Case: sc-003 is unmet. Record the evidence as facts; the verify pass reads them.', note: null
    });
    rt.ledger(id).retract(fact.id, 'The buyer withdrew');
    assert.deepStrictEqual([item('criteria-met').count, item('criteria-met').refs, item('criteria-met').fix], [2, ['sc-001', 'sc-003'],
      'Case: sc-001 is stale, sc-003 is unmet. Record the evidence as facts; the verify pass reads them.']);
    // A proposed criterion is not counted here.
    rt.brief(id).append('successCriteria', 'Survey on file', { provenance: 'model' });
    assert.strictEqual(item('criteria-met').count, 2);
    // A view handed in is the one that is used.
    const handed = closeReadiness(rt, id, { view: { objective: { state: 'confirmed' }, criteria: [{ id: 'sc-001', scope: 'confirmed', state: 'failing' }], counts: {} } });
    assert.strictEqual(handed.items.find((i) => i.id === 'criteria-met').fix, 'Case: sc-001 is failing. Record the evidence as facts; the verify pass reads them.');
  });

  it('unknowns-resolved counts active load-bearing unknowns only', async () => {
    const { rt, id, item } = await world();
    const ledger = rt.ledger(id);
    ledger.unknown({ stmt: 'Is there a lien?', subject: 'lot', attr: 'lien', changes: 'The price', answerable: 'web', how: 'County records', loadBearing: false });
    assert.strictEqual(item('unknowns-resolved').state, 'ok');
    const u = ledger.unknown({ stmt: 'Who holds the deed?', subject: 'lot', attr: 'deed', changes: 'Who signs', answerable: 'owner', how: 'Ask', loadBearing: true });
    assert.deepStrictEqual(item('unknowns-resolved'), {
      id: 'unknowns-resolved', state: 'open', by: 'either', count: 1, refs: [u.id],
      fix: `Resolve or retract 1 load-bearing unknown (${u.id}). The owner can answer it; the case can source it.`, note: null
    });
    ledger.retract(u.id, 'Not needed');
    assert.strictEqual(item('unknowns-resolved').state, 'ok');
  });

  it('questions-answered counts open questions, never the close proposal itself', async () => {
    const { rt, id, item } = await world();
    const q1 = rt.createQuestion(id, { kind: 'question', urgency: 'normal', text: 'Is the floor still 75,000?', payload: { type: 'ask', key: 'floor' } }, { charge: false });
    const q2 = rt.createQuestion(id, { kind: 'question', urgency: 'normal', text: 'May I list it?', payload: { type: 'ask', key: 'list' } }, { charge: false });
    rt.createQuestion(id, {
      kind: 'question', urgency: 'normal', text: 'Mark the case done?', options: [{ id: 'done', label: 'Mark done' }, { id: 'keep', label: 'Keep working' }],
      payload: { type: 'close-proposal', key: 'close-proposal', mcpAnswerable: false }
    }, { charge: false });
    assert.strictEqual(rt.questions(id).open().length, 3);
    assert.deepStrictEqual(item('questions-answered'), {
      id: 'questions-answered', state: 'open', by: 'owner', count: 2, refs: [q1.id, q2.id], fix: `Owner: answer 2 open questions (${q1.id}, ${q2.id}).`, note: null
    });
    await rt.answerQuestion(id, q1.id, { channel: 'in-app', text: 'Yes' });
    assert.strictEqual(item('questions-answered').fix, `Owner: answer 1 open question (${q2.id}).`);
    await rt.answerQuestion(id, q2.id, { channel: 'in-app', text: 'Yes' });
    assert.strictEqual(item('questions-answered').state, 'ok');
  });

  it('jobs-settled is open for a job outside the terminal states', async () => {
    const { dir, item } = await world();
    writeJson(kl(dir, 'jobs', 'job-0001.json'), { id: 'job-0001', executorId: 'phone-agent', state: 'done' });
    writeJson(kl(dir, 'jobs', 'job-0002.json'), { id: 'job-0002', executorId: 'phone-agent', state: 'cancelled' });
    assert.strictEqual(item('jobs-settled').state, 'ok');
    writeJson(kl(dir, 'jobs', 'job-0003.json'), { id: 'job-0003', executorId: 'phone-agent', state: 'running' });
    assert.deepStrictEqual(item('jobs-settled'), {
      id: 'jobs-settled', state: 'open', by: 'case', count: 1, refs: ['job-0003'], fix: 'Case: job-0003 is still open. Wait for it or cancel it.', note: null
    });
    writeJson(kl(dir, 'jobs', 'job-0004.json'), { id: 'job-0004', executorId: 'phone-agent', state: 'no-such-state' });
    assert.deepStrictEqual([item('jobs-settled').count, item('jobs-settled').fix], [2, 'Case: job-0003, job-0004 are still open. Wait for them or cancel them.']);
  });

  it('plan-settled is ok with no plan or a settled one, and counts the steps not finished', async () => {
    const { dir, item } = await world();
    assert.strictEqual(item('plan-settled').state, 'ok');
    const plan = (status, states) => writeJson(kl(dir, 'plan.json'), { id: 'plan-001', status, steps: states.map((state, n) => ({ id: `s${n + 1}`, title: 'A step', state })) });
    for (const status of ['done', 'rejected', 'superseded']) {
      plan(status, ['done', 'pending']);
      assert.strictEqual(item('plan-settled').state, 'ok', status);
    }
    plan('approved', ['done', 'pending', 'in-flight', 'cancelled']);
    assert.deepStrictEqual(item('plan-settled'), {
      id: 'plan-settled', state: 'open', by: 'case', count: 2, refs: ['plan-001'], fix: 'Case: the plan has 2 steps not finished.', note: null
    });
    plan('proposed', ['pending']);
    assert.deepStrictEqual([item('plan-settled').state, item('plan-settled').fix], ['open', 'Case: the plan has 1 step not finished.']);
    plan('approved', []);
    assert.deepStrictEqual([item('plan-settled').state, item('plan-settled').fix], ['open', 'Case: the plan is not settled.']);
    writeJson(kl(dir, 'plan.json'), ['not', 'a', 'plan']);
    assert.strictEqual(item('plan-settled').state, 'unknown');
  });

  it('envelopes-closed counts a requested or an active envelope, not an expired one', async () => {
    const { dir, item } = await world();
    for (const [n, status] of ['expired', 'revoked', 'rejected', 'exhausted', 'tampered'].entries()) {
      writeJson(kl(dir, 'envelopes', `env-0${n + 1}.json`), { id: `env-0${n + 1}`, status });
    }
    assert.strictEqual(item('envelopes-closed').state, 'ok');
    writeJson(kl(dir, 'envelopes', 'env-06.json'), { id: 'env-06', status: 'active' });
    assert.deepStrictEqual(item('envelopes-closed'), {
      id: 'envelopes-closed', state: 'open', by: 'owner', count: 1, refs: ['env-06'], fix: 'Owner: env-06 is still active. Revoke it or let it expire.', note: null
    });
    writeJson(kl(dir, 'envelopes', 'env-07.json'), { id: 'env-07', status: 'requested' });
    assert.deepStrictEqual([item('envelopes-closed').count, item('envelopes-closed').refs, item('envelopes-closed').fix], [2, ['env-06', 'env-07'],
      'Owner: env-06 is still active. Revoke it or let it expire. env-07 waits for your approval. Approve or reject it.']);
  });

  it('detours-settled is open while a routing proposal waits', async () => {
    const { rt, id, item } = await world();
    assert.strictEqual(item('detours-settled').state, 'ok');
    const p = await rt.detours.propose(id, { summary: 'Book a piano tuner for the living room', reason: 'Unrelated errand', source: 'detour-tool', blocks: true });
    assert.strictEqual(p.ok, true);
    assert.ok(rt.getCase(id).related.some((r) => r.id === `pending:${p.detour.id}`));
    assert.deepStrictEqual(item('detours-settled'), {
      id: 'detours-settled', state: 'open', by: 'owner', count: 1, refs: [p.questionId], fix: `Owner: answer the routing question ${p.questionId}.`, note: null
    });
    await rt.answerQuestion(id, p.questionId, { channel: 'in-app', optionId: 'decline' });
    await rt.detours.resolve(id, p.detour.id, { optionId: 'decline', by: 'in-app' });
    assert.strictEqual(item('detours-settled').state, 'ok');
  });

  it('documents-reviewed counts ingest proposals with no review', async () => {
    const { dir, item } = await world();
    const docId = 'doc-0123456789ab';
    const record = (proposals) => writeJson(kl(dir, 'ingest', `${docId}.json`), { docId, proposals });
    record([{ id: 'p-001', review: { action: 'accept' } }]);
    assert.strictEqual(item('documents-reviewed').state, 'ok');
    record([{ id: 'p-001', review: { action: 'accept' } }, { id: 'p-002' }, { id: 'p-003', review: null }, 'not a proposal']);
    assert.deepStrictEqual(item('documents-reviewed'), {
      id: 'documents-reviewed', state: 'open', by: 'owner', count: 2, refs: [], fix: 'Owner: 2 document proposals wait for review.', note: null
    });
    record([{ id: 'p-002' }]);
    assert.strictEqual(item('documents-reviewed').fix, 'Owner: 1 document proposal waits for review.');
  });

  it('tree-clean and branch-merged apply to a software-repo case and read the snapshot', async () => {
    const { rt, id, dir, item } = await world({ type: 'software-repo', title: 'Phone agent maintenance' });
    const snap = (state, extra = {}) => {
      if (rt._typeSnapshots instanceof Map) rt._typeSnapshots.delete(id);
      writeJson(kl(dir, 'case-type.json'), { type: 'software-repo', fetchedAt: NOW.toISOString(), stale: false, state: { repo: 'x', branch: 'fix-polling', head: 'abc1234', dirty: 0, openPrs: [], ...state }, notes: [], ...extra });
    };
    fs.rmSync(kl(dir, 'case-type.json'), { force: true });
    if (rt._typeSnapshots instanceof Map) rt._typeSnapshots.delete(id);
    assert.deepStrictEqual([item('tree-clean').state, item('branch-merged').state], ['unknown', 'unknown']);
    assert.strictEqual(item('tree-clean').fix, 'The repository state is not known yet. It is read at the start of a turn.');

    snap({});
    assert.deepStrictEqual([item('tree-clean').state, item('branch-merged').state], ['ok', 'ok']);
    snap({}, { stale: true });
    assert.deepStrictEqual([item('tree-clean').state, item('branch-merged').state], ['unknown', 'unknown']);

    snap({ dirty: 4 });
    assert.deepStrictEqual(item('tree-clean'), {
      id: 'tree-clean', state: 'open', by: 'either', count: 4, refs: [], fix: 'The repository has 4 uncommitted changes. Commit or discard them.', note: null
    });
    snap({ dirty: 1 });
    assert.strictEqual(item('tree-clean').fix, 'The repository has 1 uncommitted change. Commit or discard it.');
    snap({ dirty: null });
    assert.strictEqual(item('tree-clean').state, 'unknown');

    snap({ openPrs: null });
    assert.deepStrictEqual([item('tree-clean').state, item('branch-merged').state], ['ok', 'unknown']);
    // Only a PR whose head is the branch the repository is on is counted.
    snap({ openPrs: [{ number: 12, title: `${CANARY} fix`, headRefName: 'fix-polling' }, { number: 14, title: 'Other', headRefName: 'docs' }, { number: 15, title: 'Another', headRefName: 'fix-polling-2' }] });
    assert.deepStrictEqual(item('branch-merged'), {
      id: 'branch-merged', state: 'open', by: 'either', count: 1, refs: ['#12'], fix: 'PR #12 from this branch is still open. Merge or close it.', note: '2 other open PRs are not counted.'
    });
    snap({ openPrs: [{ number: 14, title: 'Other', headRefName: 'docs' }] });
    assert.deepStrictEqual([item('branch-merged').state, item('branch-merged').count, item('branch-merged').note], ['ok', 0, '1 other open PR is not counted.']);
    snap({ branch: null, openPrs: [{ number: 14, title: 'Other', headRefName: 'docs' }] });
    assert.strictEqual(item('branch-merged').state, 'unknown');
  });

  it('fix never carries case text', async () => {
    const rt = new CaseRuntime({ root: tmp(), now: () => NOW, getSettings: () => ({ cases: { timeZone: 'UTC' } }) });
    const info = await rt.createCase({ title: `Lot ${CANARY}`, type: 'software-repo', objective: `Sell ${CANARY}` });
    const { id, dir } = info;
    rt.brief(id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(id).update('repo', 'https://github.com/example/phone-agent.git', { provenance: 'user' });
    await rt.applyScopeAction(id, { action: 'add', text: `Signed ${CANARY} contract`, by: 'owner-action' });
    rt.brief(id).append('successCriteria', `Proposed ${CANARY} thing`, { provenance: 'model' });
    rt.completeGating(id);
    rt.ledger(id).unknown({ stmt: `Who is ${CANARY}?`, subject: CANARY, attr: CANARY, changes: CANARY, answerable: 'owner', how: CANARY, loadBearing: true });
    rt.createQuestion(id, { kind: 'question', urgency: 'normal', text: `What about ${CANARY}?`, payload: { type: 'ask', key: CANARY } }, { charge: false });
    await rt.detours.propose(id, { summary: `Book ${CANARY} a piano tuner`, reason: `${CANARY} errand`, source: 'detour-tool' });
    // Stores read ids from file names; what a file says of itself is not shown.
    writeJson(kl(dir, 'jobs', 'job-0001.json'), { id: CANARY, executorId: CANARY, state: CANARY, note: CANARY });
    writeJson(kl(dir, 'envelopes', 'env-01.json'), { id: CANARY, status: 'active', intent: CANARY });
    writeJson(kl(dir, 'plan.json'), { id: CANARY, status: CANARY, steps: [{ id: CANARY, title: CANARY, state: CANARY }] });
    writeJson(kl(dir, 'ingest', 'doc-0123456789ab.json'), { docId: 'doc-0123456789ab', proposals: [{ id: CANARY, stmt: CANARY }] });
    writeJson(kl(dir, 'case-type.json'), {
      type: 'software-repo', fetchedAt: NOW.toISOString(), stale: false, notes: [CANARY],
      state: { repo: CANARY, branch: CANARY, head: CANARY, dirty: 3, openPrs: [{ number: CANARY, title: CANARY, headRefName: CANARY }, { number: 7, title: CANARY, headRefName: CANARY }] }
    });
    const r = rt.closeReadiness(id);
    assert.deepStrictEqual(r.items.filter((i) => i.state === 'ok' || i.state === 'n/a').map((i) => i.id), []);
    assert.strictEqual(r.ready, false);
    for (const i of r.items) {
      assert.ok(typeof i.fix === 'string' && i.fix.length > 0, i.id);
      assert.ok(!JSON.stringify(i).includes(CANARY), `${i.id}: ${JSON.stringify(i)}`);
      assert.ok(!/[\r\n]/.test(i.fix), i.id);
    }
    assert.ok(!rt.progress(id).summary.includes(CANARY));
  });

  it('a read that throws makes that item unknown, never the whole list', async () => {
    const { rt, id, dir } = await world();
    meet(rt, id);
    fs.rmSync(kl(dir, 'jobs'), { recursive: true, force: true });
    fs.writeFileSync(kl(dir, 'jobs'), 'not a directory');
    rt.questions = () => { throw new Error(`boom ${CANARY}`); };
    const r = rt.closeReadiness(id);
    assert.deepStrictEqual(r.items.filter((i) => i.state === 'unknown').map((i) => [i.id, i.fix]), [
      ['questions-answered', 'King Louie could not read this; the log says why.'],
      ['jobs-settled', 'King Louie could not read this; the log says why.']
    ]);
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.items.find((i) => i.id === 'criteria-met').state, 'ok');
    assert.ok(!JSON.stringify(r).includes(CANARY));
  });
});

describe('readinessFingerprint', () => {
  it('changes when one state changes and not when only computedAt does', async () => {
    const { rt, id } = await world();
    const a = rt.closeReadiness(id);
    const later = new CaseRuntime({ root: rt.root, now: () => new Date('2026-10-22T10:00:00.000Z') }).closeReadiness(id);
    assert.notStrictEqual(a.computedAt, later.computedAt);
    assert.match(readinessFingerprint(a), /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(readinessFingerprint(a), readinessFingerprint(later));
    assert.strictEqual(readinessFingerprint(a), readinessFingerprint({ items: [...a.items].reverse() }), 'order does not matter');
    // The same states with other counts and refs are the same list for this purpose.
    assert.strictEqual(readinessFingerprint(a), readinessFingerprint({ items: a.items.map((i) => ({ id: i.id, state: i.state })) }));
    meet(rt, id);
    const b = rt.closeReadiness(id);
    assert.notStrictEqual(readinessFingerprint(a), readinessFingerprint(b));
  });
});

describe('CaseRuntime.progress', () => {
  it('joins the scope, the computed states, the list and the abandoned approaches', async () => {
    const { rt, id } = await world();
    rt.brief(id).append('successCriteria', 'Survey on file', { provenance: 'model' });
    const fact = meet(rt, id);
    rt.abandoned(id).abandon({ approach: 'Listing on the county site', why: 'No buyer replied in 60 days' }, { facts: new Map(), decisions: [] });
    const p = rt.progress(id);
    assert.deepStrictEqual(Object.keys(p), ['scope', 'view', 'readiness', 'summary', 'abandoned', 'closed']);
    assert.strictEqual(p.closed, null);
    assert.deepStrictEqual(p.view.criteria.map((c) => [c.id, c.scope, c.state]), [['sc-001', 'confirmed', 'met'], ['sc-002', 'proposed', null]]);
    assert.deepStrictEqual(p.view.criteria[0].evidence.map((e) => [e.id, e.holds, e.provenance]), [[fact.id, true, 'sourced']]);
    assert.deepStrictEqual(p.scope.criteria.map((c) => c.id), ['sc-001', 'sc-002']);
    assert.strictEqual(p.summary, '1 of 1 confirmed criteria met · 1 proposed (not counted) · not ready to close (1 open)');
    assert.deepStrictEqual(p.readiness.items.filter((i) => i.state === 'open').map((i) => i.id), ['criteria-confirmed']);
    assert.deepStrictEqual(p.abandoned.map((r) => r.id), ['ab-0001']);
    // Recomputed on every read: the cited fact is retracted.
    rt.ledger(id).retract(fact.id, 'The buyer withdrew');
    assert.deepStrictEqual([rt.progress(id).view.criteria[0].state, rt.progress(id).view.counts.stale], ['stale', 1]);
  });

  it('a cached state is never believed', async () => {
    const { rt, id, dir } = await world();
    writeJson(kl(dir, 'verification.json'), { version: 1, nextRecord: 1, records: [], opinions: {}, cache: { states: { 'sc-001': 'met' } }, passes: null, declinedClose: null, closed: null });
    assert.strictEqual(rt.progress(id).view.criteria[0].state, 'unmet');
  });

  it('of a case with no stage files writes nothing', async () => {
    const rt = new CaseRuntime({ root: tmp(), now: () => NOW });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const brief = rt.brief(info.id);
    brief.update('objective', 'Sell the Lakeside lot', { provenance: 'model' });
    brief.update('successCriteria', ['Signed contract at or above the floor'], { provenance: 'model' });
    const before = snapshot(info.dir);
    assert.deepStrictEqual(Object.keys(before).filter((f) => /scope|verification|abandoned/.test(f)), []);
    const p = rt.progress(info.id);
    rt.closeReadiness(info.id);
    rt.verification(info.id).read();
    rt.abandoned(info.id).active();
    assert.strictEqual(p.summary, '0 of 0 confirmed criteria met · 1 proposed (not counted) · not ready to close (2 open)');
    assert.deepStrictEqual(p.view.criteria.map((c) => [c.id, c.scope, c.origin, c.state]), [['sc-001', 'proposed', 'legacy', null]]);
    assert.deepStrictEqual(p.abandoned, []);
    assert.deepStrictEqual(snapshot(info.dir), before);
  });

  it('returns what a closed case was frozen with and computes nothing', async () => {
    const { rt, id } = await world();
    const fact = meet(rt, id);
    const live = rt.progress(id);
    rt.verification(id).freeze({ at: NOW.toISOString(), status: 'done', summary: live.summary, criteria: live.view.criteria, readiness: live.readiness });
    // Still open: the frozen record is not used.
    assert.strictEqual(rt.progress(id).closed, null);
    rt.setStatus(id, 'done', { kind: 'owner', by: 'owner' });
    rt.ledger(id).retract(fact.id, 'Changed after the close');
    const p = rt.progress(id);
    assert.strictEqual(p.closed.frozen, true);
    assert.deepStrictEqual([p.closed.status, p.closed.summary, p.closed.criteria[0].state], ['done', live.summary, 'met']);
    assert.deepStrictEqual([p.view, p.readiness, p.scope], [null, null, null]);
    assert.strictEqual(p.summary, live.summary);
  });

  it('a case closed before this stage has no frozen record: closed is null and the view is computed from what is there', async () => {
    const { rt, id } = await world();
    // As an older version left it: the status changed and nothing was frozen.
    rt.store.updateMeta(id, { status: 'done' });
    const p = rt.progress(id);
    assert.strictEqual(p.closed, null);
    assert.deepStrictEqual(p.view.criteria.map((c) => c.state), ['unmet']);
  });
});
