// tests/cases-verify-evidence.test.js
// Cases stage 8 (spec §6.5, §6.9, §6.10; R-C8-9): what a turn wrote, and
// which tool results may go to the verify pass.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { JobStore } = require('../src/cases/executors/job-store');
const {
  CASE_EVIDENCE_TOOLS, toolResultRow, collectTurnEvidence, registerEvidenceSource, turnMarks
} = require('../src/cases/verify/evidence');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-evidence-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const NOW = new Date('2026-10-21T09:00:00.000Z');

async function world() {
  const rt = new CaseRuntime({ root: tmp(), now: () => NOW, getSettings: () => ({ cases: { timeZone: 'UTC' } }) });
  const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot', objectiveBy: 'owner' });
  return { rt, id: info.id, dir: info.dir };
}

describe('toolResultRow', () => {
  it('names the five case tools whose results may be kept', () => {
    assert.deepStrictEqual([...CASE_EVIDENCE_TOOLS], ['Ledger', 'Decide', 'Executor', 'Ingest', 'Progress']);
  });

  it('only case-tool results are kept', async () => {
    for (const name of ['Bash', 'WebFetch', 'WebSearch', 'Read', 'Brief', 'Ask', 'ledger', '']) {
      assert.strictEqual(toolResultRow(name, { action: 'x' }, { ok: true, output: 'CANARY' }), null, name);
    }
    assert.deepStrictEqual(
      toolResultRow('Ledger', { action: 'assert' }, { ok: true, fact: { id: 'f-0001' } }),
      { tool: 'Ledger', action: 'assert', ok: true, text: '{"ok":true,"fact":{"id":"f-0001"}}' }
    );
    assert.deepStrictEqual(toolResultRow('Decide', {}, { ok: false, error: 'no' }), { tool: 'Decide', action: null, ok: false, text: '{"ok":false,"error":"no"}' });
    // Handed straight to the collector, the others are dropped again.
    const { rt, id } = await world();
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    const got = collectTurnEvidence(rt, turn, {
      toolResults: [
        { tool: 'Bash', action: null, ok: true, text: 'CANARY from the shell' },
        { tool: 'WebFetch', action: null, ok: true, text: 'CANARY from a page' },
        { tool: 'Read', action: null, ok: true, text: 'CANARY from a file' },
        { tool: 'Ledger', action: 'query', ok: true, text: 'two facts' },
        'not a row',
        null
      ]
    });
    assert.deepStrictEqual(got.toolResults, [{ tool: 'Ledger', action: 'query', ok: true, text: 'two facts' }]);
    assert.ok(!JSON.stringify(got).includes('CANARY'));
    await rt.endTurn(turn, { summary: 'read' });
  });

  it('cuts one result to 1,000 characters and all of them to 4,000', async () => {
    const row = toolResultRow('Ledger', { action: 'query' }, { ok: true, text: 'x'.repeat(5000) });
    assert.strictEqual(row.text.length, 1000);
    // A result that cannot be turned into JSON is kept as fixed words.
    const loop = {};
    loop.self = loop;
    assert.strictEqual(toolResultRow('Ledger', {}, loop).text, '(result could not be read)');
    assert.ok(toolResultRow('Ledger', { action: 'a\nb'.repeat(40) }, { ok: true }).action.length <= 40);

    const { rt, id } = await world();
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    const big = (n) => ({ tool: 'Ledger', action: 'query', ok: true, text: String(n).repeat(3000) });
    const got = collectTurnEvidence(rt, turn, { toolResults: [big(1), big(2), big(3), big(4), big(5), big(6)] });
    assert.ok(got.toolResults.every((r) => r.text.length <= 1000));
    assert.strictEqual(got.toolResults.reduce((n, r) => n + r.text.length, 0), 4000);
    assert.strictEqual(got.toolResults.length, 4);
    await rt.endTurn(turn, { summary: 'read' });
  });
});

describe('collectTurnEvidence', () => {
  it('finds the facts a turn wrote by addedBy and by the line mark', async () => {
    const { rt, id } = await world();
    const before = rt.ledger(id).assert({ stmt: 'The lot is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    assert.strictEqual(turn.marks.ledgerLines, 1);
    const mine = rt.ledger(id).assert({ stmt: 'The contract was signed', subject: 'contract', attr: 'signed', value: true, source: src, addedBy: 'turn-1' });
    // Written during the turn by an answered question: found by the mark.
    const answered = rt.ledger(id).assert({ stmt: 'The floor is 75,000', subject: 'price', attr: 'floor', value: 75000, source: src, addedBy: 'question:q-0001' });
    const got = collectTurnEvidence(rt, turn, {});
    assert.deepStrictEqual(got.facts.map((f) => f.id), [mine.id, answered.id]);
    assert.ok(!got.facts.some((f) => f.id === before.id));
    assert.strictEqual(got.facts[0].provenance, 'sourced');
    assert.deepStrictEqual(got.facts[0].source, src);
    assert.strictEqual(got.changed, true);
    await rt.endTurn(turn, { summary: 'wrote' });

    // A turn object with no marks finds only what carries its id.
    const bare = collectTurnEvidence(rt, { caseId: id, dir: turn.dir, turnId: 'turn-1' }, {});
    assert.deepStrictEqual(bare.facts.map((f) => f.id), [mine.id]);
    assert.deepStrictEqual(bare.decisions, []);
  });

  it('finds the decisions past the mark', async () => {
    const { rt, id } = await world();
    const fact = rt.ledger(id).assert({ stmt: 'The lot is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    rt.records(id).recordDecision({ decision: 'List the lot with an agent', factIds: [fact.id] });
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    assert.strictEqual(turn.marks.decisions, 1);
    rt.records(id).recordDecision({ decision: 'Accept the offer at 81,000', factIds: [fact.id] });
    const got = collectTurnEvidence(rt, turn, {});
    assert.deepStrictEqual(got.decisions.map((d) => [d.id, d.decision, d.factIds]), [['D-002', 'Accept the offer at 81,000', [fact.id]]]);
    assert.deepStrictEqual(got.facts, []);
    assert.strictEqual(got.changed, true);
    await rt.endTurn(turn, { summary: 'decided' });
  });

  it('changed is false for a turn that only read', async () => {
    const { rt, id } = await world();
    rt.ledger(id).assert({ stmt: 'The lot is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    const got = collectTurnEvidence(rt, turn, { toolResults: [{ tool: 'Ledger', action: 'query', ok: true, text: 'one fact' }] });
    assert.deepStrictEqual([got.changed, got.facts, got.decisions, got.executorResults, got.extra], [false, [], [], [], []]);
    assert.strictEqual(got.toolResults.length, 1);
    await rt.endTurn(turn, { summary: 'read' });
  });

  it('names the jobs whose results were recorded this turn, with the facts they produced', async () => {
    const { rt, id, dir } = await world();
    const jobs = path.join(dir, '.kl', 'jobs');
    fs.mkdirSync(jobs, { recursive: true });
    const job = (name, over) => fs.writeFileSync(path.join(jobs, `${name}.json`), JSON.stringify({ id: name, executor: 'phone-agent', state: 'running', recordsSaved: [], ...over }));
    job('job-0001', { recordsSaved: ['r-1'] });
    job('job-0002', {});
    assert.deepStrictEqual(new JobStore(dir).ids(), ['job-0001', 'job-0002']);
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    assert.strictEqual(turn.marks.jobRecords, 1);
    job('job-0002', { state: 'done', recordsSaved: ['r-7'] });
    const fact = rt.ledger(id).assert({
      stmt: 'phone-agent reported a quote of 400', subject: 'quote', attr: 'amount', value: 400, provenance: 'external-agent',
      source: { kind: 'api', ref: 'sources/phone-agent/job-0002/r-7.json' }, addedBy: 'turn-1'
    });
    const got = collectTurnEvidence(rt, turn, {});
    assert.deepStrictEqual(got.executorResults, [{ kind: 'executor-result', id: 'job-0002', text: 'phone-agent done', refs: [fact.id] }]);
    assert.strictEqual(got.changed, true);
    await rt.endTurn(turn, { summary: 'results' });
  });

  it('adds the rows of a registered extra source, and survives one that throws', async () => {
    const { rt, id } = await world();
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    const seen = [];
    const restore = [
      registerEvidenceSource('hand-off', (runtime, t) => {
        seen.push([runtime === rt, t.turnId]);
        return [{ kind: 'hand-off', id: 'h-0001', text: 'child run finished', refs: ['f-0001', 7] }, 'junk', { kind: 'hand-off' }];
      }),
      registerEvidenceSource('broken', () => { throw new Error('boom'); })
    ];
    try {
      const got = collectTurnEvidence(rt, turn, {});
      assert.deepStrictEqual(seen, [[true, 'turn-1']]);
      assert.deepStrictEqual(got.extra, [{ kind: 'hand-off', id: 'h-0001', text: 'child run finished', refs: ['f-0001'] }]);
      // An extra source's rows alone do not make the turn "changed".
      assert.strictEqual(got.changed, false);
    } finally {
      for (const r of restore) r();
    }
    await rt.endTurn(turn, { summary: 'read' });
  });
});

describe('turnMarks', () => {
  it('counts the ledger lines, the decisions and the recorded job results, and reads the snapshot', async () => {
    const { rt, id, dir } = await world();
    assert.deepStrictEqual(turnMarks(rt, id), { ledgerLines: 0, decisions: 0, jobRecords: 0, jobs: {}, head: null, dirty: null, states: {} });
    rt.ledger(id).assert({ stmt: 'The lot is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    fs.writeFileSync(path.join(dir, '.kl', 'case-type.json'), JSON.stringify({ fetchedAt: NOW.toISOString(), state: { head: '3f2a91c', dirty: 2 } }));
    const marks = turnMarks(rt, id);
    assert.deepStrictEqual([marks.ledgerLines, marks.head, marks.dirty], [1, '3f2a91c', 2]);
  });
});
