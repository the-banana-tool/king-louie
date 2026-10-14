// Cases stage 8 (plan Task 12): IPC to read a case's progress and for the
// owner's own scope actions (the panel's and the card's buttons).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const IPC = require('../src/ipc/constants');
const { CaseRuntime } = require('../src/cases');
const { markLocalDesktopEvent } = require('../src/core/origin');
const { confirmAll } = require('./helpers/case-scope');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup({ cases = {}, caseChecks = null } = {}) {
  const { registerCaseProgressHandlers } = require('../src/ipc/case-progress-handlers');
  const { registerCaseUnattendedHandlers } = require('../src/ipc/case-unattended-handlers');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-progress-ipc-'));
  dirs.push(root);
  const runtime = new CaseRuntime({
    root,
    getSettings: () => ({ cases: { timeZone: 'UTC', ...cases } }),
    host: { interactive: () => true, notify: () => {}, ...(caseChecks ? { caseChecks } : {}) }
  });
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  const context = { getCaseRuntime: () => runtime };
  registerCaseProgressHandlers(ipcMain, context);
  registerCaseUnattendedHandlers(ipcMain, context);
  // The host marks every IPC event before a handler sees it.
  const call = (channel, payload) => handlers.get(channel)(markLocalDesktopEvent({}), payload);
  const callUnmarked = (channel, payload) => handlers.get(channel)({}, payload);
  return { runtime, handlers, call, callUnmarked };
}

// An active case: one confirmed criterion and the objective confirmed, then
// two criteria the model proposed.
async function openCase(runtime, { proposals = ['Deed recorded with the county', 'Funds received in escrow'] } = {}) {
  const info = await runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash', force: true });
  runtime.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
  runtime.brief(info.id).append('successCriteria', 'Signed contract at 80,000 or more', { provenance: 'model' });
  confirmAll(runtime, info.id);
  runtime.completeGating(info.id);
  for (const text of proposals) runtime.brief(info.id).append('successCriteria', text, { provenance: 'model' });
  return runtime.getCase(info.id);
}

// Every file under a case dir (but .git), with its bytes.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const rowsOf = (reply) => Object.fromEntries(reply.criteria.map((r) => [r.text, r]));

describe('case progress IPC', () => {
  it('registers case:progress and case:confirmScope', () => {
    const { handlers } = setup();
    assert.deepStrictEqual([IPC.CASE_PROGRESS, IPC.CASE_CONFIRM_SCOPE], ['case:progress', 'case:confirmScope']);
    for (const ch of [IPC.CASE_PROGRESS, IPC.CASE_CONFIRM_SCOPE]) assert.ok(handlers.has(ch), ch);
  });

  it('case:progress gives the computed progress as untrusted text, each evidence entry with its provenance', async () => {
    const { runtime, call } = setup();
    const c = await openCase(runtime);
    const confirmed = runtime.scopeView(c.id).criteria.find((r) => r.state === 'confirmed');
    const fact = runtime.ledger(c.id).assert({
      stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, provenance: 'sourced', source: { kind: 'document', ref: 'sources/contract.pdf' }
    });
    runtime.verification(c.id).addRecord({ criterion: confirmed.id, criterionHash: confirmed.hash, evidence: [fact.id], note: 'Signed.', turnId: 'turn-1', model: 'example-provider:example-model' });
    runtime.abandoned(c.id).abandon({ approach: 'Sell through an auction house', why: 'The fee was a fifth of the price' });

    const r = await call(IPC.CASE_PROGRESS, { caseId: c.id });
    assert.deepStrictEqual([r.ok, r.untrustedText, r.frozen, r.check, r.caseStatus], [true, true, false, null, 'active']);
    assert.deepStrictEqual(Object.keys(r).sort(), ['abandoned', 'at', 'caseStatus', 'check', 'criteria', 'frozen', 'objective', 'ok', 'readiness', 'summary', 'untrustedText']);
    assert.deepStrictEqual([r.objective.text, r.objective.state, typeof r.objective.hash], ['Convert the lot to cash', 'confirmed', 'string']);
    assert.match(r.summary, /^1 of 1 confirmed criteria met · 2 proposed \(not counted\) · not ready to close/);
    const rows = rowsOf(r);
    const met = rows['Signed contract at 80,000 or more'];
    assert.deepStrictEqual([met.id, met.scope, met.state, typeof met.hash], [confirmed.id, 'confirmed', 'met', 'string']);
    assert.strictEqual(met.evidence.length, 1);
    assert.deepStrictEqual(Object.keys(met.evidence[0]).sort(), ['holds', 'id', 'label', 'provenance', 'sourceKind']);
    assert.deepStrictEqual([met.evidence[0].id, met.evidence[0].holds, met.evidence[0].provenance, met.evidence[0].sourceKind], [fact.id, true, 'sourced', 'document']);
    const proposed = rows['Deed recorded with the county'];
    assert.deepStrictEqual([proposed.scope, proposed.state, proposed.evidence], ['proposed', null, []]);
    assert.strictEqual(r.readiness.ready, false);
    assert.ok(r.readiness.items.length > 0);
    assert.ok(r.readiness.items.every((i) => typeof i.id === 'string' && typeof i.state === 'string' && typeof i.by === 'string'));
    assert.strictEqual(r.abandoned.count, 1);
    assert.deepStrictEqual(r.abandoned.records.map((a) => [a.id, a.approach, a.why]), [['ab-0001', 'Sell through an auction house', 'The fee was a fifth of the price']]);
  });

  it('a read changes no file and takes no lock, even on a case that was never tracked', async () => {
    const { runtime, call } = setup();
    const info = await runtime.createCase({ title: 'Roof quotes', force: true });
    runtime.brief(info.id).update('objective', 'Get three roof quotes', { provenance: 'model' });
    runtime.brief(info.id).append('successCriteria', 'Three written quotes', { provenance: 'model' });
    const dir = runtime.getCase(info.id).dir;
    fs.rmSync(path.join(dir, '.kl', 'scope.json'), { force: true });
    // Another turn holds the case: a read still answers.
    const lock = path.join(dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other', pid: process.ppid, at: new Date().toISOString() }));
    const before = snapshot(dir);
    try {
      const r = await call(IPC.CASE_PROGRESS, { caseId: info.id });
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.criteria.map((row) => [row.scope, row.origin]), [['proposed', 'legacy']]);
      assert.deepStrictEqual(snapshot(dir), before);
    } finally {
      fs.rmSync(lock, { force: true });
    }
    assert.strictEqual((await call(IPC.CASE_PROGRESS, {})).ok, false);
    assert.strictEqual((await call(IPC.CASE_PROGRESS, { caseId: 'nope' })).ok, false);
  });

  it('case:confirmScope confirms one criterion with the hash it was shown, as an owner action in the app', async () => {
    const { runtime, call } = setup();
    const c = await openCase(runtime);
    const row = rowsOf(await call(IPC.CASE_PROGRESS, { caseId: c.id }))['Deed recorded with the county'];
    const r = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'confirm', target: row.id, hash: row.hash });
    assert.deepStrictEqual([r.ok, r.progress.ok, r.progress.untrustedText], [true, true, true]);
    assert.deepStrictEqual([rowsOf(r.progress)['Deed recorded with the county'].scope, rowsOf(r.progress)['Funds received in escrow'].scope], ['confirmed', 'proposed']);
    const stored = runtime.scopeView(c.id).criteria.find((x) => x.id === row.id);
    assert.deepStrictEqual([stored.state, stored.confirmed.by, stored.confirmed.channel], ['confirmed', 'owner-action', 'in-app']);
  });

  it('confirms all-proposed, drops, edits and adds', async () => {
    const { runtime, call } = setup();
    const c = await openCase(runtime);
    let p = await call(IPC.CASE_PROGRESS, { caseId: c.id });
    const proposed = p.criteria.filter((x) => x.scope === 'proposed');
    const all = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'confirm', target: 'all-proposed', hash: Object.fromEntries(proposed.map((x) => [x.id, x.hash])) });
    assert.strictEqual(all.ok, true);
    assert.ok(all.progress.criteria.every((x) => x.scope === 'confirmed'));

    const deed = rowsOf(all.progress)['Deed recorded with the county'];
    const dropped = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'drop', target: deed.id, hash: deed.hash });
    assert.strictEqual(dropped.ok, true);
    assert.deepStrictEqual(dropped.progress.criteria.map((x) => x.text), ['Signed contract at 80,000 or more', 'Funds received in escrow']);

    const funds = rowsOf(dropped.progress)['Funds received in escrow'];
    const edited = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'edit', target: funds.id, hash: funds.hash, text: 'Funds received in the escrow account' });
    assert.strictEqual(edited.ok, true);
    const now = rowsOf(edited.progress)['Funds received in the escrow account'];
    assert.deepStrictEqual([now.scope, now.origin], ['confirmed', 'owner-action']);

    const added = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'add', text: 'Keys handed over' });
    assert.strictEqual(added.ok, true);
    assert.deepStrictEqual([rowsOf(added.progress)['Keys handed over'].scope, rowsOf(added.progress)['Keys handed over'].origin], ['confirmed', 'owner-action']);

    const objective = added.progress.objective;
    const rewritten = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'edit', target: 'objective', hash: objective.hash, text: 'Sell the lot for cash' });
    assert.deepStrictEqual([rewritten.ok, rewritten.progress.objective.text, rewritten.progress.objective.state], [true, 'Sell the lot for cash', 'confirmed']);
    p = await call(IPC.CASE_PROGRESS, { caseId: c.id });
    assert.deepStrictEqual(p.criteria.map((x) => x.text), ['Signed contract at 80,000 or more', 'Funds received in the escrow account', 'Keys handed over']);
  });

  it('refuses with the store\'s code: an old hash, an unknown id, bad text, a duplicate, the limit', async () => {
    const { runtime, call } = setup();
    const c = await openCase(runtime);
    const row = rowsOf(await call(IPC.CASE_PROGRESS, { caseId: c.id }))['Deed recorded with the county'];
    // The first locked write of a case adds its scope record; take the
    // snapshot after one.
    await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'confirm', target: 'sc-999', hash: row.hash });
    const before = snapshot(c.dir);
    const refused = [
      [{ action: 'confirm', target: row.id, hash: 'sha256:0000' }, 'SCOPE_STALE'],
      [{ action: 'confirm', target: 'all-proposed', hash: { [row.id]: row.hash } }, 'SCOPE_STALE'],
      [{ action: 'confirm', target: 'sc-999', hash: row.hash }, 'CRITERION_NOT_FOUND'],
      [{ action: 'add', text: 'ok' }, 'CRITERION_INVALID'],
      [{ action: 'add', text: 'Two\nlines of text' }, 'CRITERION_INVALID'],
      [{ action: 'add', text: 'deed recorded with the county' }, 'CRITERION_DUPLICATE'],
      [{ action: 'edit', target: 'objective', text: '   ' }, 'CRITERION_INVALID'],
      [{ action: 'edit', target: 'objective', text: 'x'.repeat(2001) }, 'CRITERION_INVALID']
    ];
    for (const [payload, code] of refused) {
      const r = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, ...payload });
      assert.deepStrictEqual([r.ok, r.code, typeof r.error], [false, code, 'string'], JSON.stringify(payload));
    }
    assert.deepStrictEqual(snapshot(c.dir), before, 'a refusal writes nothing');
    for (let i = 0; i < 9; i += 1) {
      assert.strictEqual((await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'add', text: `Extra criterion number ${i}` })).ok, true);
    }
    const over = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'add', text: 'One criterion too many' });
    assert.deepStrictEqual([over.ok, over.code], [false, 'CRITERION_LIMIT']);
  });

  it('refuses a bad action, target, hash or text before the runtime is called, and takes nothing else from the renderer', async () => {
    const { runtime, call } = setup();
    const c = await openCase(runtime);
    const row = rowsOf(await call(IPC.CASE_PROGRESS, { caseId: c.id }))['Deed recorded with the county'];
    const seen = [];
    const original = runtime.applyScopeAction.bind(runtime);
    runtime.applyScopeAction = (id, opts) => {
      seen.push(opts);
      return original(id, opts);
    };
    const bad = [
      { action: 'approve', target: row.id, hash: row.hash },
      { action: 'confirm', target: 'sc-1', hash: row.hash },
      { action: 'confirm', target: 'everything', hash: row.hash },
      { action: 'confirm', hash: row.hash },
      { action: 'confirm', target: ['sc-002'], hash: row.hash },
      { action: 'confirm', target: row.id },
      { action: 'confirm', target: row.id, hash: { [row.id]: row.hash } },
      { action: 'confirm', target: 'all-proposed', hash: row.hash },
      { action: 'confirm', target: 'all-proposed', hash: { [row.id]: 7 } },
      { action: 'drop', target: 'objective', hash: row.hash },
      { action: 'edit', target: row.id, hash: row.hash },
      { action: 'edit', target: 'all-proposed', text: 'Deed recorded' },
      { action: 'add', text: 7 },
      { action: 'add' }
    ];
    for (const payload of bad) {
      const r = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, ...payload });
      assert.strictEqual(r.ok, false, JSON.stringify(payload));
      assert.strictEqual(typeof r.error, 'string');
    }
    assert.strictEqual((await call(IPC.CASE_CONFIRM_SCOPE, { action: 'confirm', target: row.id, hash: row.hash })).ok, false);
    assert.strictEqual((await call(IPC.CASE_CONFIRM_SCOPE, null)).ok, false);
    assert.deepStrictEqual(seen, [], 'the runtime was never called');

    // by, channel, quote and factId are the host's: the renderer cannot name them.
    const ok = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'confirm', target: row.id, hash: row.hash, by: 'owner-quote', channel: 'mobile', quote: 'yes', factId: 'f-0001', force: true, state: 'met' });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(seen, [{ action: 'confirm', target: row.id, hash: row.hash, text: null, by: 'owner-action', channel: 'in-app' }]);
    assert.strictEqual(rowsOf(ok.progress)['Deed recorded with the county'].state, 'unmet', 'a confirmed criterion starts unmet whatever the renderer sent');
  });

  it('refuses an event the host did not mark as the local desktop', async () => {
    const { runtime, call, callUnmarked } = setup();
    const c = await openCase(runtime);
    const row = rowsOf(await call(IPC.CASE_PROGRESS, { caseId: c.id }))['Deed recorded with the county'];
    const r = await callUnmarked(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'confirm', target: row.id, hash: row.hash });
    assert.deepStrictEqual([r.ok, r.code], [false, 'NOT_LOCAL_DESKTOP']);
    assert.strictEqual(runtime.scopeView(c.id).criteria.find((x) => x.id === row.id).state, 'proposed');
  });

  it('says the case is busy while another process holds its lock', async () => {
    const { runtime, call } = setup();
    const c = await openCase(runtime);
    const row = rowsOf(await call(IPC.CASE_PROGRESS, { caseId: c.id }))['Deed recorded with the county'];
    const lock = path.join(c.dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other', pid: process.ppid, at: new Date().toISOString() }));
    try {
      assert.deepStrictEqual(
        await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'confirm', target: row.id, hash: row.hash }),
        { ok: false, code: 'CASE_BUSY', error: 'Case is busy with a wake-up; try again in a minute.' }
      );
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });

  it('refuses a closed case: its scope is read-only', async () => {
    const { runtime, call } = setup();
    const c = await openCase(runtime);
    const row = rowsOf(await call(IPC.CASE_PROGRESS, { caseId: c.id }))['Deed recorded with the county'];
    runtime.setStatus(c.id, 'done', { kind: 'owner', by: 'owner' });
    const r = await call(IPC.CASE_CONFIRM_SCOPE, { caseId: c.id, action: 'confirm', target: row.id, hash: row.hash });
    assert.deepStrictEqual([r.ok, r.code], [false, 'CASE_CLOSED']);
  });

  it('case:setStatus done is never refused for an open item', async () => {
    const { runtime, call } = setup();
    const c = await openCase(runtime);
    const before = await call(IPC.CASE_PROGRESS, { caseId: c.id });
    assert.strictEqual(before.readiness.ready, false);
    assert.ok(before.criteria.some((x) => x.state === 'unmet') && before.criteria.some((x) => x.scope === 'proposed'));
    const r = await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'done' });
    assert.deepStrictEqual([r.ok, r.case.status], [true, 'done']);
  });

  // Cases stage 8 (plan Task 15; R-C8-3): the check command of a
  // software-repo case, named in the panel. Nothing here runs anything.
  describe('case:setCheck and the check part of case:progress', () => {
    const CHECK_ON = { cases: { softwareRepo: { check: { enabled: true } } } };
    async function repoCase(runtime, { repo = undefined } = {}) {
      const local = repo === undefined ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-progress-repo-'))) : repo;
      if (repo === undefined) dirs.push(local);
      const info = await runtime.createCase({ title: 'Lakeside lot site', type: 'software-repo', objective: 'Ship the Lakeside lot site', force: true });
      runtime.brief(info.id).update('why', 'The listing goes live in spring', { provenance: 'user' });
      runtime.brief(info.id).update('repo', local, { provenance: 'user' });
      runtime.brief(info.id).append('successCriteria', 'The test suite passes', { provenance: 'model' });
      confirmAll(runtime, info.id);
      runtime.completeGating(info.id);
      return { ...runtime.getCase(info.id), repo: local };
    }

    it('is registered, and case:progress has no check for a case that is not a software-repo one', async () => {
      const { runtime, handlers, call } = setup(CHECK_ON);
      assert.strictEqual(IPC.CASE_SET_CHECK, 'case:setCheck');
      assert.ok(handlers.has(IPC.CASE_SET_CHECK));
      const general = await openCase(runtime);
      assert.strictEqual((await call(IPC.CASE_PROGRESS, { caseId: general.id })).check, null);
      const r = await call(IPC.CASE_SET_CHECK, { caseId: general.id, command: 'npm test' });
      assert.deepStrictEqual([r.ok, r.code], [false, 'CHECK_NOT_SOFTWARE_REPO']);
    });

    it('names the command as the owner, asks one pressed question, and shows it waiting until the press', async () => {
      const { runtime, call } = setup(CHECK_ON);
      const c = await repoCase(runtime);
      assert.deepStrictEqual((await call(IPC.CASE_PROGRESS, { caseId: c.id })).check, { enabled: true, reason: null, command: null, approved: false, lastRun: null });
      const r = await call(IPC.CASE_SET_CHECK, { caseId: c.id, command: ' npm test ', by: 'question', channel: 'mobile' });
      assert.strictEqual(r.ok, true, r.error);
      assert.deepStrictEqual(r.check, { enabled: true, reason: null, command: 'npm test', approved: false, lastRun: null });
      assert.strictEqual(runtime.brief(c.id).read().data.check, 'npm test');
      const open = runtime.questions(c.id).open().filter((q) => q.payload?.type === 'check-approve');
      assert.deepStrictEqual(open.map((q) => q.id), [r.questionId]);
      assert.ok(open[0].text.split('\n').includes(`Runs in: ${c.repo}`));
      // Setting it approved nothing, whatever the payload said.
      assert.strictEqual(runtime.checks(c.id).read().approved.length, 0);
      // The case is committed and unlocked.
      assert.strictEqual(fs.existsSync(path.join(c.dir, '.kl', 'lock')), false);

      await runtime.answerQuestion(c.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
      assert.strictEqual((await call(IPC.CASE_PROGRESS, { caseId: c.id })).check.approved, true);
      // A run is shown by id and result only.
      runtime.checks(c.id).addRun({ hash: 'sha256:x', head: 'abc123', dirty: 0, result: 'fail', exitCode: 1, timedOut: false, ms: 12, turnId: 'turn-1' });
      const shown = (await call(IPC.CASE_PROGRESS, { caseId: c.id })).check.lastRun;
      assert.deepStrictEqual([shown.id, shown.result, shown.head, shown.dirty], ['chk-0001', 'fail', 'abc123', 0]);
      assert.deepStrictEqual(Object.keys(shown).sort(), ['at', 'dirty', 'head', 'id', 'result']);

      // Another command withdraws the approval and asks again.
      const changed = await call(IPC.CASE_SET_CHECK, { caseId: c.id, command: 'npm run check' });
      assert.deepStrictEqual([changed.ok, changed.check.command, changed.check.approved], [true, 'npm run check', false]);
      assert.strictEqual(runtime.questions(c.id).open().filter((q) => q.payload?.type === 'check-approve').length, 1);

      // "Stop running it": every approval is withdrawn and the open question is closed.
      await runtime.answerQuestion(c.id, changed.questionId, { channel: 'in-app', optionId: 'approve' });
      assert.strictEqual((await call(IPC.CASE_PROGRESS, { caseId: c.id })).check.approved, true);
      const stopped = await call(IPC.CASE_SET_CHECK, { caseId: c.id, approved: false });
      assert.deepStrictEqual([stopped.ok, stopped.check.command, stopped.check.approved], [true, 'npm run check', false]);
      assert.strictEqual(runtime.checks(c.id).read().approved.length, 0);
    });

    it('is refused, with nothing written: off, a bad command, no local repository, a closed case, an unmarked event, a bad payload', async () => {
      const off = setup();
      const offCase = await repoCase(off.runtime);
      assert.deepStrictEqual((await off.call(IPC.CASE_PROGRESS, { caseId: offCase.id })).check, { enabled: false, reason: 'CHECK_DISABLED', command: null, approved: false, lastRun: null });
      const before = snapshot(offCase.dir);
      const d = await off.call(IPC.CASE_SET_CHECK, { caseId: offCase.id, command: 'npm test' });
      assert.deepStrictEqual([d.ok, d.code], [false, 'CHECK_DISABLED']);
      assert.deepStrictEqual(snapshot(offCase.dir), before);

      // A service: the data dir's setting is not the administrator's.
      const service = setup({ ...CHECK_ON, caseChecks: { isService: true, enabled: false } });
      const serviceCase = await repoCase(service.runtime);
      const s = await service.call(IPC.CASE_SET_CHECK, { caseId: serviceCase.id, command: 'npm test' });
      assert.deepStrictEqual([s.ok, s.code], [false, 'CHECK_SERVICE_OFF']);
      assert.strictEqual((await service.call(IPC.CASE_PROGRESS, { caseId: serviceCase.id })).check.reason, 'CHECK_SERVICE_OFF');

      const { runtime, call, callUnmarked } = setup(CHECK_ON);
      const c = await repoCase(runtime);
      const start = snapshot(c.dir);
      for (const command of ['make check', 'npm test; rm -rf x', 'npm install', 'npx cowsay', 'npm test --script-shell=x']) {
        const r = await call(IPC.CASE_SET_CHECK, { caseId: c.id, command });
        assert.deepStrictEqual([r.ok, r.code], [false, 'CHECK_INVALID'], command);
      }
      const unmarked = await callUnmarked(IPC.CASE_SET_CHECK, { caseId: c.id, command: 'npm test' });
      assert.deepStrictEqual([unmarked.ok, unmarked.code], [false, 'NOT_LOCAL_DESKTOP']);
      for (const payload of [{}, { caseId: c.id }, { caseId: c.id, command: 7 }, { caseId: c.id, approved: true }, { caseId: c.id, command: 'npm test', approved: true }]) {
        assert.strictEqual((await call(IPC.CASE_SET_CHECK, payload)).ok, false, JSON.stringify(payload));
      }
      assert.deepStrictEqual(snapshot(c.dir), start);

      const remote = await repoCase(runtime, { repo: 'https://git.example.com/lakeside/site.git' });
      const u = await call(IPC.CASE_SET_CHECK, { caseId: remote.id, command: 'npm test' });
      assert.deepStrictEqual([u.ok, u.code], [false, 'CHECK_NO_LOCAL_REPO']);

      runtime.setStatus(c.id, 'done', { kind: 'owner', by: 'owner' });
      const closed = await call(IPC.CASE_SET_CHECK, { caseId: c.id, command: 'npm test' });
      assert.deepStrictEqual([closed.ok, closed.code], [false, 'CASE_CLOSED']);
      assert.strictEqual((await call(IPC.CASE_PROGRESS, { caseId: c.id })).check, null);
    });
  });

  it('after done the reply\'s progress is the frozen record, and so is every later read', async () => {
    const { runtime, call } = setup();
    const c = await openCase(runtime);
    const paused = await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'paused' });
    assert.deepStrictEqual([paused.progress.ok, paused.progress.frozen], [true, false]);
    await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'active' });
    const open = await call(IPC.CASE_PROGRESS, { caseId: c.id });
    const r = await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'done' });
    assert.deepStrictEqual([r.progress.ok, r.progress.untrustedText, r.progress.frozen, r.progress.caseStatus], [true, true, true, 'done']);
    assert.strictEqual(typeof r.progress.at, 'string');
    assert.strictEqual(r.progress.summary, open.summary);
    assert.deepStrictEqual(r.progress.criteria.map((x) => [x.id, x.text, x.scope, x.state]), open.criteria.map((x) => [x.id, x.text, x.scope, x.state]));
    assert.strictEqual(r.progress.objective, null);
    const later = await call(IPC.CASE_PROGRESS, { caseId: c.id });
    assert.deepStrictEqual(later, r.progress);
    // A case closed before progress was tracked has no record: not frozen.
    fs.rmSync(path.join(c.dir, '.kl', 'verification.json'), { force: true });
    const untracked = await call(IPC.CASE_PROGRESS, { caseId: c.id });
    assert.deepStrictEqual([untracked.ok, untracked.frozen, untracked.caseStatus], [true, false, 'done']);
  });
});
