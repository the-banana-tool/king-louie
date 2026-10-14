// tests/cases-verify-after-reply.test.js
// Cases stage 8, owner ruling R-C8-11 (2026-10-13): the verify pass runs
// after the reply. The turn commits and releases the case at once; the pass
// makes its model call with no lock held and lands in a system action of
// its own. No network and no model: the router is a stub whose verify reply
// is a promise the test settles.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { CaseRuntime } = require('../src/cases');
const { withCaseProfile } = require('./helpers/profile-settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-after-reply-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const HEADING = '## Verification (written by King Louie)';
const metrics = (costUsd) => ({ provider: 'openai', model: 'judge-model', inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd });
const verdict = (...criteria) => ({ type: 'text', content: JSON.stringify({ criteria }), llmMetrics: metrics(0.02) });
const met = (id, ...evidence) => ({ id, status: 'met', evidence, note: 'The record shows it.' });
const unmet = (id) => ({ id, status: 'unmet', evidence: [], note: 'Nothing recorded shows it.' });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const commits = async (dir) => Number((await git.git(dir, ['rev-list', '--count', 'HEAD'])).trim());
const lastCommit = async (dir) => (await git.git(dir, ['log', '-1', '--format=%s'])).trim();

// An active case with two confirmed criteria (sc-001, sc-002) on a runtime
// whose router answers a verify call with whatever `script.reply` gives:
// a reply, a promise of one, or a function of the call.
async function world({ settings = {}, reply = null } = {}) {
  const clock = { now: new Date('2026-10-21T09:00:00.000Z') };
  const calls = [];
  const events = [];
  const notes = [];
  const script = { reply };
  const router = {
    async routeTargets(targets, messages, opts) {
      calls.push({ targets, messages, opts });
      return typeof script.reply === 'function' ? script.reply({ targets, messages, opts }) : script.reply;
    }
  };
  const tracker = { record: (e) => { events.push(e); return { provider: e.provider, model: e.model, totalTokens: e.totalTokens, cost: e.costUsd }; } };
  const rt = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => withCaseProfile({ cases: { timeZone: 'UTC', ...settings } }),
    host: { inferenceRouter: router, getUsageTracker: () => tracker, notify: (event, payload) => notes.push([event, payload]) }
  });
  const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot', objectiveBy: 'owner' });
  const id = info.id;
  rt.brief(id).update('why', 'Need the cash', { provenance: 'user' });
  await rt.applyScopeAction(id, { action: 'add', text: 'Signed contract at or above the floor', by: 'owner-action' });
  await rt.applyScopeAction(id, { action: 'add', text: 'Closed within 90 days', by: 'owner-action' });
  rt.completeGating(id);
  notes.length = 0;
  let n = 0;
  // Each turn a minute after the last, so its journal entry sorts after it.
  const begin = (opts = {}) => {
    n += 1;
    clock.now = new Date(clock.now.getTime() + 60000);
    return rt.beginTurn(id, { turnId: `turn-${n}`, ...opts });
  };
  const fact = (turn, over = {}) => rt.ledger(id).assert({
    stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, source: src, addedBy: turn.turnId, ...over
  });
  const row = (criterion) => rt.progressView(id).criteria.find((r) => r.id === criterion);
  const file = () => rt.verification(id).read();
  const journals = () => fs.readdirSync(path.join(info.dir, 'journal')).filter((f) => f.endsWith('.md')).sort()
    .map((f) => [f.replace(/^[\d-]+-/, '').replace(/\.md$/, ''), fs.readFileSync(path.join(info.dir, 'journal', f), 'utf8')]);
  const locked = () => fs.existsSync(path.join(info.dir, '.kl', 'lock'));
  const progressNotes = () => notes.filter(([event, p]) => event === 'case:changed' && p.what === 'progress').length;
  const spent = () => rt.budget(id).status().usd.spent;
  // A turn that writes a sourced fact and closes the way the send path does.
  const changedTurn = async (over = {}) => {
    const turn = await begin();
    const f = fact(turn, over);
    const committed = await rt.endTurn(turn, { summary: 'wrote', journal: 'Recorded the signed contract.', verify: true });
    return { turn, f, committed };
  };
  return { rt, id, dir: info.dir, clock, calls, events, notes, script, begin, fact, row, file, journals, locked, progressNotes, spent, changedTurn };
}

describe('the verify pass runs after the reply (R-C8-11)', () => {
  it('endTurn commits and releases the case before the verify call settles; the states update when the pass lands', async () => {
    const w = await world();
    const gate = deferred();
    w.script.reply = () => gate.promise;
    const turn = await w.begin();
    const before = await commits(w.dir);
    const f = w.fact(turn);
    await w.rt.endTurn(turn, { summary: 'wrote', journal: 'Recorded the signed contract.', verify: true });
    // The turn is over: committed, unlocked, not dirty, and the pass is still out.
    assert.strictEqual(await commits(w.dir), before + 1);
    assert.strictEqual(w.locked(), false);
    assert.strictEqual(w.rt.runningTurn(w.id), null);
    assert.strictEqual(w.rt.verifyRunning(w.id), true);
    assert.strictEqual(await git.isDirty(w.dir), false);
    await tick();
    assert.strictEqual(w.calls.length, 1);
    assert.strictEqual(w.row('sc-001').state, 'unmet');
    assert.deepStrictEqual(w.journals().slice(-1), [['turn', 'Recorded the signed contract.\n']]);
    assert.strictEqual(w.progressNotes(), 0);
    // The pass was counted when the turn closed, before the call.
    assert.strictEqual(w.file().passes.count, 1);

    gate.resolve(verdict(met('sc-001', f.id), met('sc-002', 'f-0999')));
    await w.rt.verifyIdle(w.id);
    assert.strictEqual(w.rt.verifyRunning(w.id), false);
    assert.strictEqual(w.row('sc-001').state, 'met');
    assert.strictEqual(w.row('sc-002').state, 'unmet');
    assert.strictEqual(w.progressNotes(), 1);
    // Its own journal entry and its own commit; the turn's entry is as it was.
    assert.deepStrictEqual(w.journals().slice(-2), [
      ['turn', 'Recorded the signed contract.\n'],
      ['verification', `${HEADING}\n- Now met: sc-001 (${f.id}).\n- Verify pass: 1 accepted, 1 not accepted (sc-002: f-0999 is not in the ledger).\n`]
    ]);
    // Three commits: the turn, the charge (a system action of its own,
    // review finding 2) and the landing.
    assert.strictEqual(await commits(w.dir), before + 3);
    assert.strictEqual(await lastCommit(w.dir), 'turn-1: verify pass');
    assert.strictEqual((await git.git(w.dir, ['log', '-1', '--skip=1', '--format=%s'])).trim(), 'system: verify pass usage');
    assert.strictEqual(await git.isDirty(w.dir), false);
    assert.strictEqual(w.locked(), false);
    // Counted once and charged once.
    assert.strictEqual(w.file().passes.count, 1);
    assert.strictEqual(w.events.length, 1);
    assert.strictEqual(Math.round(w.spent() * 100) / 100, 0.02);
    // The orientation's last journal entry is still the turn's own.
    const next = await w.begin();
    assert.match(next.orientation, /## Last journal entry \(journal\/[\d-]+-turn\.md\)\nRecorded the signed contract\./);
    assert.match(next.orientation, /sc-001 \[met\]/);
    await w.rt.endTurn(next, { summary: 'read' });
  });

  it('a pass with nothing to say writes no journal entry; a turn that wrote nothing starts no pass', async () => {
    const w = await world({ reply: verdict(unmet('sc-001'), unmet('sc-002')) });
    await w.changedTurn();
    await w.rt.verifyIdle(w.id);
    assert.deepStrictEqual(w.journals().slice(-1), [['turn', 'Recorded the signed contract.\n']]);
    assert.strictEqual(await git.isDirty(w.dir), false);
    const turn = await w.begin();
    await w.rt.endTurn(turn, { summary: 'read', journal: 'Nothing new.', verify: true });
    assert.strictEqual(w.rt.verifyRunning(w.id), false);
    assert.strictEqual(w.calls.length, 1);
  });

  it('what the turn itself undid is still said first in the turn\'s own entry; the pass adds only what it found', async () => {
    const w = await world();
    let r = await w.changedTurn();
    w.script.reply = verdict(met('sc-001', r.f.id));
    r = await w.changedTurn({ subject: 'price', attr: 'paid', value: 81000, stmt: 'The buyer paid 81,000' });
    await w.rt.verifyIdle(w.id);
    const first = w.file().records[0].evidence[0];
    assert.strictEqual(w.row('sc-001').state, 'met');

    const turn = await w.begin();
    const corrected = w.fact(turn, { stmt: 'The contract was not signed after all', value: 0, supersedes: first });
    const closed = w.fact(turn, { subject: 'closing', attr: 'done', value: true, stmt: 'Closing happened on day 40' });
    w.script.reply = verdict(met('sc-002', closed.id));
    await w.rt.endTurn(turn, { summary: 'corrected', journal: 'Corrected the record.', verify: true });
    await w.rt.verifyIdle(w.id);
    assert.deepStrictEqual(w.journals().slice(-2), [
      ['turn', `${HEADING}\n- Now stale: sc-001 (${first} was superseded by ${corrected.id}).\n\nCorrected the record.\n`],
      ['verification', `${HEADING}\n- Now met: sc-002 (${closed.id}).\n- Verify pass: 1 accepted.\n`]
    ]);
  });

  it('a verdict that takes a criterion out of met is its own entry, and the next turn is told to re-orient', async () => {
    const w = await world();
    const { f } = await w.changedTurn();
    w.script.reply = verdict(met('sc-001', f.id));
    await w.changedTurn({ subject: 'price', attr: 'paid', value: 81000, stmt: 'The buyer paid 81,000' });
    await w.rt.verifyIdle(w.id);
    assert.strictEqual(w.row('sc-001').state, 'met');
    w.script.reply = verdict(unmet('sc-001'));
    await w.changedTurn({ subject: 'deed', attr: 'recorded', value: false, stmt: 'The deed is not recorded yet' });
    await w.rt.verifyIdle(w.id);
    assert.strictEqual(w.row('sc-001').state, 'stale');
    assert.deepStrictEqual(w.journals().slice(-1), [
      ['verification', `${HEADING}\n- Now stale: sc-001 (the verify pass of turn-3 no longer agrees).\n- Verify pass: no longer agrees that sc-001 is met.\n`]
    ]);
    const next = await w.begin();
    assert.strictEqual(next.reorientPending, true);
    assert.deepStrictEqual(next.triggers.filter((t) => t.kind === 'criterion-regressed').map((t) => t.blocking), [true]);
    assert.match(next.orientation, /sc-001 was met and is now stale: the verify pass of turn-3 no longer agrees\./);
    await w.rt.endTurn(next, { summary: 'read' });
  });

  it('a second turn starting mid-pass drops the pass: nothing of it is written, its call is stopped, and the next verified close runs the pass it is owed', async () => {
    const w = await world();
    const gate = deferred();
    w.script.reply = () => gate.promise;
    const { f } = await w.changedTurn();
    await tick();
    assert.strictEqual(w.calls.length, 1);
    // The owner writes again before the pass lands: no "busy", no wait.
    const second = await w.begin();
    assert.strictEqual(w.calls[0].opts.abortSignal.aborted, true);
    assert.strictEqual(w.rt.verifyRunning(w.id), false);
    // The first pass's verdict arrives while the second turn runs: dropped.
    gate.resolve(verdict(met('sc-001', f.id)));
    await w.rt.verifyIdle(w.id, { settled: true });
    assert.deepStrictEqual(w.file().records, []);
    assert.strictEqual(w.row('sc-001').state, 'unmet');
    assert.strictEqual(w.progressNotes(), 0);
    assert.ok(!w.journals().some(([kind]) => kind === 'verification'));
    // The call was made, so its usage is the case's all the same: once.
    assert.strictEqual(w.events.length, 1);
    assert.strictEqual(Math.round(w.spent() * 100) / 100, 0.02);
    // The second turn wrote nothing, and still closes with the pass the case
    // is owed, over the record as it is now.
    w.script.reply = verdict(met('sc-001', f.id));
    await w.rt.endTurn(second, { summary: 'read', journal: 'Looked again.', verify: true });
    await w.rt.verifyIdle(w.id);
    assert.strictEqual(w.calls.length, 2);
    assert.strictEqual(w.row('sc-001').state, 'met');
    assert.strictEqual(w.file().records[0].turnId, 'turn-2');
    assert.strictEqual(await git.isDirty(w.dir), false);
    // Nothing is owed any more.
    const third = await w.begin();
    await w.rt.endTurn(third, { summary: 'read', journal: 'Nothing new.', verify: true });
    assert.strictEqual(w.calls.length, 2);
  });

  it('a result is never applied over a newer record: a criterion reworded during the pass is skipped', async () => {
    const w = await world();
    const gate = deferred();
    w.script.reply = () => gate.promise;
    const { f } = await w.changedTurn();
    await tick();
    // An owner action in the panel (a system action, not a turn) while the model thinks.
    const row = w.rt.scopeView(w.id).criteria[0];
    await w.rt.applyScopeAction(w.id, { action: 'edit', target: row.id, hash: row.hash, text: 'Signed contract at or above 90,000', by: 'owner-action' });
    gate.resolve(verdict(met('sc-001', f.id)));
    await w.rt.verifyIdle(w.id);
    assert.deepStrictEqual(w.file().records, []);
    assert.ok(w.rt.progressView(w.id).criteria.every((r) => r.state !== 'met'));
    assert.strictEqual(await git.isDirty(w.dir), false);
  });

  it('a wake-up does not start on a case whose pass is in flight', async () => {
    const w = await world();
    const gate = deferred();
    w.script.reply = () => gate.promise;
    const { f } = await w.changedTurn();
    await tick();
    await assert.rejects(w.begin({ source: 'wakeup' }), (e) => e.code === 'CASE_BUSY');
    assert.strictEqual(w.rt.verifyRunning(w.id), true);
    assert.strictEqual(w.locked(), false);
    gate.resolve(verdict(met('sc-001', f.id)));
    await w.rt.verifyIdle(w.id);
    assert.strictEqual(w.row('sc-001').state, 'met');
    const turn = await w.begin({ source: 'wakeup' });
    await w.rt.endTurn(turn, { summary: 'wake-up quiet', journalKind: 'wakeup' });
  });

  it('shutdown mid-pass stops the call and is awaited: no verdict, no lock, nothing half-written', async () => {
    const w = await world();
    const gate = deferred();
    w.script.reply = ({ opts }) => new Promise((resolve, reject) => {
      opts.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      gate.promise.then(resolve);
    });
    await w.changedTurn();
    await tick();
    const head = await commits(w.dir);
    w.rt.beginShutdown();
    w.rt.abortUnattended();
    assert.strictEqual(w.calls[0].opts.abortSignal.aborted, true);
    await w.rt.verifyIdle();
    assert.strictEqual(w.rt.verifyRunning(w.id), false);
    w.rt.releaseAll();
    assert.deepStrictEqual(w.file().records, []);
    assert.deepStrictEqual(w.file().opinions, {});
    assert.strictEqual(w.locked(), false);
    assert.strictEqual(await commits(w.dir), head);
    assert.strictEqual(await git.isDirty(w.dir), false);
    assert.ok(!w.journals().some(([kind]) => kind === 'verification'));
    assert.strictEqual(w.progressNotes(), 0);
    // A verdict that arrives after shutdown began is not applied either.
    gate.resolve(verdict(met('sc-001', 'f-0001')));
    await tick();
    assert.deepStrictEqual(w.file().records, []);
  });

  it('a turn that closes after shutdown began starts no pass and counts none', async () => {
    const w = await world({ reply: verdict() });
    const turn = await w.begin();
    w.fact(turn);
    w.rt.beginShutdown();
    await w.rt.endTurn(turn, { summary: 'wrote', journal: 'Recorded.', verify: true });
    assert.strictEqual(w.rt.verifyRunning(w.id), false);
    assert.strictEqual(w.calls.length, 0);
    assert.strictEqual(w.file().passes, null);
  });

  it('a call that settles after the time limit is still charged, once, and its verdict is not applied', async () => {
    const w = await world({ settings: { verify: { timeoutMs: 40 } } });
    const gate = deferred();
    // A provider that does not honour the abort and answers late.
    w.script.reply = () => gate.promise;
    const keep = setTimeout(() => {}, 10000);
    try {
      const { f } = await w.changedTurn();
      const job = w.rt.verifyIdle(w.id);
      await job;
      assert.strictEqual(w.calls[0].opts.abortSignal.aborted, true);
      assert.deepStrictEqual(w.journals().slice(-1), [['verification', `${HEADING}\n- Verify pass: no usable verdict (timed out after 40 ms).\n`]]);
      assert.strictEqual(w.events.length, 0);
      assert.strictEqual(w.spent(), 0);
      gate.resolve(verdict(met('sc-001', f.id)));
      await w.rt.verifyIdle(w.id, { settled: true });
      assert.strictEqual(w.events.length, 1);
      assert.strictEqual(Math.round(w.spent() * 100) / 100, 0.02);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w.dir, '.kl', 'budget.json'), 'utf8')).usd.spent, 0.02);
      assert.deepStrictEqual(w.file().records, []);
      assert.strictEqual(w.row('sc-001').state, 'unmet');
      // The late charge is committed, not left for the next turn's "owner edits".
      assert.strictEqual(await git.isDirty(w.dir), false);
      assert.strictEqual(await lastCommit(w.dir), 'system: verify pass usage');
      assert.strictEqual(w.locked(), false);
      assert.strictEqual(w.file().passes.count, 1);
    } finally {
      clearTimeout(keep);
    }
  });

  // Review finding 2 (2026-10-14): the on-time charge of a pass after the
  // reply was written with no lock (and could pause the case and ask a
  // budget question outside any system action). Every charge of the pass
  // now goes through verifySystemAction: committed on its own, before the
  // landing, so a landing that is dropped leaves nothing uncommitted.
  it('the charge of a call that settled in time is a system action of its own: committed even when a turn then drops the landing', async () => {
    const w = await world();
    const gate = deferred();
    w.script.reply = () => gate.promise;
    const { f } = await w.changedTurn();
    await tick();
    const head = await commits(w.dir);
    // Hold the first commit after the reply, and start an owner turn then.
    const realCommit = w.rt._commit.bind(w.rt);
    const held = deferred();
    const letGo = deferred();
    const messages = [];
    w.rt._commit = async (...args) => {
      messages.push(String(args[1]));
      if (messages.length === 1) {
        held.resolve(String(args[1]));
        await letGo.promise;
      }
      return realCommit(...args);
    };
    gate.resolve(verdict(met('sc-001', f.id)));
    assert.strictEqual(await held.promise, 'system: verify pass usage');
    assert.strictEqual(w.locked(), true);
    const beginning = w.begin();
    await tick(30);
    letGo.resolve();
    const turn = await beginning;
    await w.rt.verifyIdle(w.id, { settled: true });
    // The landing was dropped by the turn: no record, no entry.
    assert.deepStrictEqual(w.file().records, []);
    assert.ok(!w.journals().some(([kind]) => kind === 'verification'));
    // The charge is committed, once, in its own commit, not as "owner edits".
    assert.strictEqual(w.events.length, 1);
    assert.strictEqual(Math.round(w.spent() * 100) / 100, 0.02);
    assert.strictEqual(await commits(w.dir), head + 1);
    assert.strictEqual((await git.git(w.dir, ['log', '-1', '--format=%s', '--', '.kl/budget.json'])).trim(), 'system: verify pass usage');
    assert.ok(!messages.includes('owner edits'), messages.join(' | '));
    await w.rt.endTurn(turn, { summary: 'read' });
    assert.strictEqual(await git.isDirty(w.dir), false);
    assert.strictEqual(w.events.length, 1);
  });

  it('a stopped call that reported partial usage is charged with it', async () => {
    const w = await world({ settings: { verify: { timeoutMs: 40 } } });
    w.script.reply = ({ opts }) => new Promise((_resolve, reject) => {
      opts.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
        name: 'AbortError', partialLlmMetrics: { ...metrics(0.01), usagePartial: true }
      })), { once: true });
    });
    const keep = setTimeout(() => {}, 10000);
    try {
      await w.changedTurn();
      await w.rt.verifyIdle(w.id, { settled: true });
      assert.deepStrictEqual(w.events.map((e) => [e.costUsd, e.usagePartial]), [[0.01, true]]);
      assert.strictEqual(Math.round(w.spent() * 100) / 100, 0.01);
      assert.strictEqual(await git.isDirty(w.dir), false);
    } finally {
      clearTimeout(keep);
    }
  });

  it('a pass that fails never touches the turn: the provider throws, the reply is not the shape', async () => {
    const w = await world();
    w.script.reply = () => { throw Object.assign(new Error('503 Service Unavailable'), { status: 503 }); };
    const first = await w.changedTurn();
    assert.match(String(first.committed), /^[0-9a-f]{7,}$/);
    await w.rt.verifyIdle(w.id);
    assert.deepStrictEqual(w.journals().slice(-1), [['verification', `${HEADING}\n- Verify pass: no usable verdict (the model call failed).\n`]]);
    w.script.reply = { type: 'text', content: 'I think it is done.', llmMetrics: metrics(0.02) };
    await w.changedTurn({ subject: 'price', attr: 'paid', value: 81000, stmt: 'The buyer paid 81,000' });
    await w.rt.verifyIdle(w.id);
    assert.deepStrictEqual(w.journals().slice(-1), [['verification', `${HEADING}\n- Verify pass: no usable verdict (the reply was not in the expected shape).\n`]]);
    assert.deepStrictEqual(w.file().records, []);
    assert.strictEqual(w.locked(), false);
    assert.strictEqual(await git.isDirty(w.dir), false);
  });

  it('a case closed while the model was thinking keeps the progress it closed with', async () => {
    const w = await world();
    const gate = deferred();
    w.script.reply = () => gate.promise;
    const { f } = await w.changedTurn();
    await tick();
    await w.rt.setStatus(w.id, 'done', { kind: 'owner', by: 'owner' });
    gate.resolve(verdict(met('sc-001', f.id)));
    await w.rt.verifyIdle(w.id);
    assert.deepStrictEqual(w.file().records, []);
    assert.deepStrictEqual(w.rt.progress(w.id).closed.criteria.map((r) => r.state), ['unmet', 'unmet']);
  });

  it('an owner turn that arrives while the pass is landing waits for it instead of being refused', async () => {
    const w = await world();
    const gate = deferred();
    w.script.reply = () => gate.promise;
    const { f } = await w.changedTurn();
    await tick();
    // Hold the landing inside its system action (its commit), and start a turn then.
    const realCommit = w.rt._commit.bind(w.rt);
    const inCommit = deferred();
    const letGo = deferred();
    w.rt._commit = async (...args) => {
      if (/verify pass$/.test(String(args[1]))) {
        inCommit.resolve();
        await letGo.promise;
      }
      return realCommit(...args);
    };
    gate.resolve(verdict(met('sc-001', f.id)));
    await inCommit.promise;
    assert.strictEqual(w.locked(), true);
    const beginning = w.begin();
    await tick(30);
    letGo.resolve();
    const turn = await beginning;
    assert.strictEqual(w.row('sc-001').state, 'met');
    assert.deepStrictEqual(turn.marks.states, { 'sc-001': 'met', 'sc-002': 'unmet' });
    await w.rt.endTurn(turn, { summary: 'read' });
    assert.strictEqual(await git.isDirty(w.dir), false);
  });
});
