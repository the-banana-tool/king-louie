// tests/cases-verify-now.test.js
// Cases stage 8, owner ruling 2026-10-13 (N2): the case panel's "Check now"
// runs the verify pass on the owner's press. It is counted and skipped like
// any pass, is refused while the case is closed or busy, and no tool and no
// MCP surface reaches it. No network and no model: the router is a stub.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const IPC = require('../src/ipc/constants');
const { CaseRuntime } = require('../src/cases');
const { markLocalDesktopEvent } = require('../src/core/origin');
const { withCaseProfile } = require('./helpers/profile-settings');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-verify-now-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const metrics = (costUsd) => ({ provider: 'openai', model: 'judge-model', inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd });
const verdict = (...criteria) => ({ type: 'text', content: JSON.stringify({ criteria }), llmMetrics: metrics(0.02) });
const met = (id, ...evidence) => ({ id, status: 'met', evidence, note: 'The record shows it.' });
const unmet = (id) => ({ id, status: 'unmet', evidence: [], note: 'Nothing recorded shows it.' });

// An active case with one confirmed criterion (sc-001) and a sourced fact
// (f-0001), on a runtime whose router returns `script.reply`, with the
// progress IPC registered on it.
async function world({ settings = {}, reply = null } = {}) {
  const { registerCaseProgressHandlers } = require('../src/ipc/case-progress-handlers');
  const clock = { now: new Date('2026-10-21T09:00:00.000Z') };
  const calls = [];
  const notified = [];
  const script = { reply };
  const router = {
    async routeTargets(targets, messages, opts) {
      calls.push({ targets, messages, opts });
      return typeof script.reply === 'function' ? script.reply({ targets, messages, opts }) : script.reply;
    }
  };
  const tracker = { record: (e) => ({ provider: e.provider, model: e.model, totalTokens: e.totalTokens, cost: e.costUsd }) };
  const rt = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => withCaseProfile({ cases: { timeZone: 'UTC', ...settings } }),
    host: { inferenceRouter: router, getUsageTracker: () => tracker, notify: (event, payload) => notified.push({ event, ...payload }) }
  });
  const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot', objectiveBy: 'owner' });
  const id = info.id;
  rt.brief(id).update('why', 'Need the cash', { provenance: 'user' });
  await rt.applyScopeAction(id, { action: 'add', text: 'Signed contract at or above the floor', by: 'owner-action' });
  rt.completeGating(id);
  const fact = rt.ledger(id).assert({ stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, source: src });
  await rt.systemAction(id, 'fixture', async () => {});
  const handlers = new Map();
  registerCaseProgressHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getCaseRuntime: () => rt });
  const press = (payload = { caseId: id }) => handlers.get(IPC.CASE_VERIFY_NOW)(markLocalDesktopEvent({}), payload);
  const pressUnmarked = (payload = { caseId: id }) => handlers.get(IPC.CASE_VERIFY_NOW)({}, payload);
  const row = (criterion = 'sc-001') => rt.progressView(id).criteria.find((r) => r.id === criterion);
  return { rt, id, dir: info.dir, clock, calls, notified, script, fact, press, pressUnmarked, row };
}

describe('Check now: the owner asks for a verify pass', () => {
  it('runs the pass, accepts met on evidence that holds, and leaves the case committed and unlocked', async () => {
    const w = await world();
    w.script.reply = verdict(met('sc-001', w.fact.id));
    assert.strictEqual(IPC.CASE_VERIFY_NOW, 'case:verifyNow');
    const turnsBefore = w.rt.budget(w.id).status().turnsPerDay.spent || 0;
    w.notified.length = 0;
    const r = await w.press();
    assert.deepStrictEqual([r.ok, r.untrustedText, r.ran, r.accepted, r.notAccepted, r.disagreed], [true, true, true, 1, 0, 0]);
    assert.strictEqual(r.note, 'Checked: 1 criterion accepted as met.');
    assert.strictEqual(w.calls.length, 1);
    assert.strictEqual(w.row().state, 'met');
    assert.strictEqual(r.progress.criteria.find((c) => c.id === 'sc-001').state, 'met');
    // Counted like any pass, charged to the case, and not a turn of the day.
    assert.strictEqual(w.rt.verification(w.id).passesOn('2026-10-21'), 1);
    assert.strictEqual(w.rt.budget(w.id).status().usd.spent, 0.02);
    assert.strictEqual(w.rt.budget(w.id).status().turnsPerDay.spent || 0, turnsBefore);
    assert.strictEqual(w.rt.turns.size, 0);
    assert.strictEqual(fs.existsSync(path.join(w.dir, '.kl', 'lock')), false);
    assert.strictEqual(await git.isDirty(w.dir), false);
    // The panel is told: the check began and ended, and the progress changed.
    const mine = w.notified.filter((n) => n.event === 'case:changed' && n.caseId === w.id);
    assert.deepStrictEqual(mine.filter((n) => n.what === 'turn').map((n) => [n.running, n.source]), [[true, 'check'], [false, 'check']]);
    assert.ok(mine.some((n) => n.what === 'progress'));
  });

  it('says what it found: not accepted, nothing new, and a call that failed', async () => {
    const w = await world();
    w.script.reply = verdict(met('sc-001', 'f-0999'));
    const refusedEvidence = await w.press();
    assert.deepStrictEqual([refusedEvidence.ok, refusedEvidence.ran, refusedEvidence.accepted, refusedEvidence.notAccepted], [true, true, 0, 1]);
    assert.strictEqual(refusedEvidence.note, 'Checked: 1 criterion not accepted as met; its evidence does not hold.');
    assert.strictEqual(w.row().state, 'unmet');

    w.script.reply = verdict(unmet('sc-001'));
    const nothing = await w.press();
    assert.deepStrictEqual([nothing.ok, nothing.ran, nothing.note], [true, true, 'Checked: nothing new is met.']);

    w.script.reply = () => { throw new Error('PROVIDER-CANARY 500'); };
    const failed = await w.press();
    assert.deepStrictEqual([failed.ok, failed.ran, failed.accepted], [true, true, 0]);
    assert.strictEqual(failed.note, 'The check did not finish: the model call failed.');
    assert.doesNotMatch(JSON.stringify(failed.note), /CANARY/);
    assert.strictEqual(fs.existsSync(path.join(w.dir, '.kl', 'lock')), false);
  });

  it('is refused at the daily cap and past 80 % of the usd budget, with no call and nothing written', async () => {
    const capped = await world({ settings: { verify: { maxPassesPerDay: 1 } } });
    capped.script.reply = verdict(unmet('sc-001'));
    assert.strictEqual((await capped.press()).ok, true);
    const file = fs.readFileSync(path.join(capped.dir, '.kl', 'verification.json'), 'utf8');
    const over = await capped.press();
    assert.deepStrictEqual([over.ok, over.code], [false, 'VERIFY_DAILY_CAP']);
    assert.match(over.error, /limit of 1 verify pass a day is used/);
    assert.strictEqual(capped.calls.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(capped.dir, '.kl', 'verification.json'), 'utf8'), file);

    const spent = await world();
    spent.script.reply = verdict(unmet('sc-001'));
    spent.rt.store.updateMeta(spent.id, { budget: { usd: 1 } });
    spent.rt.budget(spent.id).charge('usd', 0.85);
    const r = await spent.press();
    assert.deepStrictEqual([r.ok, r.code], [false, 'VERIFY_USD_BUDGET']);
    assert.match(r.error, /80 % of its usd budget/);
    assert.strictEqual(spent.calls.length, 0);
  });

  it('is refused for a closed case, a case that is not running, a case with nothing confirmed, and when the pass is off', async () => {
    const paused = await world();
    paused.rt.setStatus(paused.id, 'paused', { kind: 'owner', by: 'owner' });
    const p = await paused.press();
    assert.deepStrictEqual([p.ok, p.code], [false, 'VERIFY_NOT_OPEN']);
    assert.match(p.error, /paused/);
    paused.rt.setStatus(paused.id, 'active', { kind: 'owner', by: 'owner' });
    paused.rt.setStatus(paused.id, 'done', { kind: 'owner', by: 'owner' });
    const d = await paused.press();
    assert.deepStrictEqual([d.ok, d.code], [false, 'CASE_CLOSED']);
    assert.strictEqual(paused.calls.length, 0);

    const off = await world({ settings: { verify: { when: 'off' } } });
    const o = await off.press();
    assert.deepStrictEqual([o.ok, o.code], [false, 'VERIFY_OFF']);

    const bare = await world();
    const only = bare.rt.scopeView(bare.id).criteria[0];
    await bare.rt.applyScopeAction(bare.id, { action: 'drop', target: only.id, hash: only.hash, by: 'owner-action' });
    const n = await bare.press();
    assert.deepStrictEqual([n.ok, n.code], [false, 'VERIFY_NO_CRITERIA']);
    assert.strictEqual(bare.calls.length, 0);

    // request mode: the button is the way to run one.
    const asked = await world({ settings: { verify: { when: 'request' } } });
    asked.script.reply = verdict(met('sc-001', asked.fact.id));
    assert.deepStrictEqual([(await asked.press()).accepted, asked.row().state], [1, 'met']);
  });

  it('is refused while a turn holds the case, and never stops that turn', async () => {
    const w = await world();
    w.script.reply = verdict(unmet('sc-001'));
    // A wake-up in this process: an owner message would pre-empt it; a check never does.
    const wakeup = await w.rt.beginTurn(w.id, { turnId: 'wake-1', source: 'wakeup' });
    const busy = await w.press();
    assert.deepStrictEqual(busy, { ok: false, code: 'CASE_BUSY', error: 'A turn is running in this case; check again when it ends.' });
    assert.strictEqual(wakeup.signal.aborted, false);
    assert.strictEqual(w.rt.turns.get(w.id), wakeup);
    await w.rt.endTurn(wakeup, { summary: 'woke' });

    // Another process holds the lock.
    const lock = path.join(w.dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other', pid: process.ppid, at: new Date().toISOString() }));
    try {
      const other = await w.press();
      assert.deepStrictEqual([other.ok, other.code], [false, 'CASE_BUSY']);
    } finally {
      fs.rmSync(lock, { force: true });
    }
    assert.strictEqual(w.calls.length, 0);
  });

  it('a second press while a check runs is refused, and an owner turn waits for it', async () => {
    const w = await world();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    w.script.reply = async () => { await gate; return verdict(unmet('sc-001')); };
    const keepAlive = setTimeout(() => {}, 30000);
    try {
      const first = w.press();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepStrictEqual(w.rt.runningTurn(w.id).source, 'check');
      const second = await w.press();
      assert.deepStrictEqual([second.ok, second.code], [false, 'CASE_BUSY']);
      await assert.rejects(() => w.rt.beginTurn(w.id, { turnId: 'turn-1' }), { code: 'CASE_BUSY' });
      release();
      assert.strictEqual((await first).ok, true);
      assert.strictEqual(w.calls.length, 1);
    } finally {
      clearTimeout(keepAlive);
    }
    const turn = await w.rt.beginTurn(w.id, { turnId: 'turn-2' });
    await w.rt.endTurn(turn, { summary: 'after' });
  });

  it('Stop from the chat, or pausing the case, ends a running check and nothing is recorded', async () => {
    for (const stop of ['stop', 'pause']) {
      const w = await world();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      w.script.reply = async () => { await gate; return verdict(met('sc-001', w.fact.id)); };
      const keepAlive = setTimeout(() => {}, 30000);
      try {
        let settled = null;
        const first = w.press().then((r) => { settled = r; return r; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (stop === 'stop') assert.strictEqual(w.rt.abortTurn(w.id, 'stopped by owner'), true);
        else w.rt.setStatus(w.id, 'paused', { kind: 'owner', by: 'owner' });
        // The call is still waiting on the gate; the check must end without it.
        for (let i = 0; i < 100 && !settled; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(settled, `${stop}: the check ended without waiting for the model`);
        release();
        const r = await first;
        assert.deepStrictEqual([r.ok, r.accepted, r.note], [true, 0, 'The check did not finish: the turn was stopped.'], stop);
        assert.strictEqual(w.row().state, 'unmet', stop);
        assert.strictEqual(w.rt.turns.size, 0);
        assert.strictEqual(fs.existsSync(path.join(w.dir, '.kl', 'lock')), false);
      } finally {
        release();
        clearTimeout(keepAlive);
      }
    }
  });

  it('does not hide a criterion that left met from the next turn', async () => {
    const w = await world();
    w.script.reply = verdict(met('sc-001', w.fact.id));
    await w.press();
    // A turn sees it met and writes the cache.
    const seen = await w.rt.beginTurn(w.id, { turnId: 'turn-1' });
    await w.rt.endTurn(seen, { summary: 'read', verify: true });
    // The fact is corrected; then the owner checks.
    w.rt.ledger(w.id).assert({ stmt: 'The contract was signed at 79,000', subject: 'contract', attr: 'signed', value: 79000, source: src, supersedes: w.fact.id });
    w.script.reply = verdict(unmet('sc-001'));
    const r = await w.press();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(w.row().state, 'stale');
    const next = await w.rt.beginTurn(w.id, { turnId: 'turn-2' });
    assert.ok(next.triggers.some((t) => t.kind === 'criterion-regressed'), 'the next turn still re-orients');
    await w.rt.endTurn(next, { summary: 'read' });
  });

  it('is the owner\'s press only: an unmarked event, a bad payload, and no tool or MCP path', async () => {
    const w = await world();
    w.script.reply = verdict(unmet('sc-001'));
    const r = await w.pressUnmarked();
    assert.deepStrictEqual([r.ok, r.code], [false, 'NOT_LOCAL_DESKTOP']);
    assert.strictEqual((await w.press({})).ok, false);
    assert.strictEqual((await w.press({ caseId: 'nope' })).ok, false);
    assert.strictEqual(w.calls.length, 0);
    // Only the runtime and the progress IPC name it.
    const naming = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && /verifyNow|CASE_VERIFY_NOW/.test(fs.readFileSync(p, 'utf8'))) naming.push(path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/'));
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    assert.deepStrictEqual(naming.sort(), ['src/cases/case-runtime.js', 'src/ipc/case-progress-handlers.js', 'src/ipc/constants.js']);
  });
});
