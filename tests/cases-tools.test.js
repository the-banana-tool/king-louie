// tests/cases-tools.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeTools, toolRegistry } = require('../src/tools');
const ToolExecutor = require('../src/execution/tool-executor');
const { CaseRuntime } = require('../src/cases');
const { LedgerTool, BriefTool, DecideTool, RecommendTool } = require('../src/tools/builtin/case-tools');
const {
  CASE_TOOL_NAMES, CASE_MODE_PROMPT, shapeToolDefinitions, buildCaseSystemPrompt, isProtectedCasePath
} = require('../src/cases/chat-integration');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tools-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };

async function setup(title = 'Lakeside lot') {
  const runtime = new CaseRuntime({ root: tmp() });
  const info = await runtime.createCase({ title, objective: 'Convert the lot to cash' });
  const caseContext = { runtime, caseId: info.id, turnId: 'turn-1', dir: info.dir };
  return { runtime, info, opts: { caseContext } };
}

async function activate(runtime, id) {
  runtime.brief(id).update('why', 'Need the cash', { provenance: 'user' });
  runtime.brief(id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
  runtime.completeGating(id);
}

describe('case tools', () => {
  it('are registered and refuse to run without a case', async () => {
    for (const name of CASE_TOOL_NAMES) assert.ok(toolRegistry.get(name), `${name} registered`);
    const r = await LedgerTool.execute({ action: 'query' }, {});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not attached to a case/);
  });

  it('Ledger asserts, infers, queries and fills in a user-message source', async () => {
    const { opts } = await setup();
    const a = await LedgerTool.execute({ action: 'assert', stmt: 'Owner needs cash by spring', subject: 'owner', attr: 'deadline', value: '2027-03', provenance: 'user' }, opts);
    assert.strictEqual(a.ok, true);
    assert.deepStrictEqual(a.fact.source, { kind: 'user-message', ref: 'turn-1' });
    assert.strictEqual(a.fact.addedBy, 'turn-1');
    const i = await LedgerTool.execute({ action: 'infer', stmt: 'Owner is motivated', subject: 'owner', attr: 'motivation', value: 'high', basis: [a.fact.id] }, opts);
    assert.strictEqual(i.fact.provenance, 'inferred');
    const bad = await LedgerTool.execute({ action: 'assert', stmt: 'Guess', subject: 'lot', attr: 'x', value: 1 }, opts);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /source/);
    const q = await LedgerTool.execute({ action: 'query', filter: { subject: 'owner' } }, opts);
    assert.strictEqual(q.facts.length, 2);
  });

  it('Ledger unknown refuses exact duplicates and surfaces other cases', async () => {
    const { runtime, opts } = await setup('Lakeside lot');
    const other = await runtime.createCase({ title: 'Household inventory' });
    runtime.ledger(other.id).assert({ stmt: 'Payoff quote for the house loan', subject: 'house-loan', attr: 'payoff', value: 120000, source: src, category: 'financial' });
    const u = await LedgerTool.execute({ action: 'unknown', stmt: 'What is the house loan payoff?', subject: 'house-loan', attr: 'payoff', changes: 'Net proceeds', answerable: 'owner', how: 'Ask for the payoff letter' }, opts);
    assert.strictEqual(u.ok, true);
    assert.deepStrictEqual(u.similarInOtherCases.map((m) => m.caseTitle), ['Household inventory']);
    const again = await LedgerTool.execute({ action: 'unknown', stmt: 'Payoff?', subject: 'house-loan', attr: 'payoff', changes: 'c', answerable: 'owner', how: 'ask' }, opts);
    assert.strictEqual(again.ok, false);
    assert.match(again.error, /already has/);
  });

  it('Brief reads, refuses owner-only fields from the model, journals updates and completes gating', async () => {
    const { runtime, info, opts } = await setup();
    const read = await BriefTool.execute({ action: 'read' }, opts);
    assert.deepStrictEqual(read.missingForGating, ['why', 'successCriteria']);
    const refused = await BriefTool.execute({ action: 'update', field: 'why', value: 'I think they need cash', provenance: 'model' }, opts);
    assert.strictEqual(refused.ok, false);
    await BriefTool.execute({ action: 'update', field: 'why', value: 'Need the cash', provenance: 'user', reason: 'Owner said so' }, opts);
    await BriefTool.execute({ action: 'append', field: 'successCriteria', item: 'Closed by year end' }, opts);
    const done = await BriefTool.execute({ action: 'completeGating' }, opts);
    assert.deepStrictEqual(done, { ok: true, status: 'active' });
    assert.match(runtime.records(info.id).lastJournal().file, /-brief/);
  });

  it('Decide records a decision and marks cited facts load-bearing', async () => {
    const { runtime, info, opts } = await setup();
    const f = runtime.ledger(info.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    const d = await DecideTool.execute({ decision: 'Price per acre off the plat', factIds: [f.id], alternatives: ['GIS acreage'] }, opts);
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.decision.id, 'D-001');
    assert.strictEqual(runtime.ledger(info.id).view().facts.get(f.id).loadBearing, true);
    const missing = await DecideTool.execute({ decision: 'x', factIds: ['f-0404'] }, opts);
    assert.strictEqual(missing.ok, false);
  });

  it('Recommend is refused on a draft case and on inferred support, and renders unknowns first when it passes', async () => {
    const { runtime, info, opts } = await setup();
    const f = runtime.ledger(info.id).assert({ stmt: 'Six active lots ask 36k–60k per acre', subject: 'market', attr: 'asks', value: null, source: src });
    const draft = await RecommendTool.execute({ claims: [{ text: 'List at 35k per acre', factIds: [f.id] }] }, opts);
    assert.strictEqual(draft.ok, false);
    assert.match(JSON.stringify(draft.failures), /gating/i);

    await activate(runtime, info.id);
    const inf = runtime.ledger(info.id).infer({ stmt: 'Buyers are investors', subject: 'market', attr: 'buyers', value: 'investors', basis: [f.id] });
    const refused = await RecommendTool.execute({ claims: [{ text: 'Target investors', factIds: [inf.id] }] }, opts);
    assert.strictEqual(refused.ok, false);

    runtime.ledger(info.id).unknown({ stmt: 'Is there a water tap?', subject: 'lot', attr: 'tap', changes: 'Buyer cost', answerable: 'utility', how: 'Call', loadBearing: true });
    const ok = await RecommendTool.execute({ claims: [{ text: 'List at 35k per acre', factIds: [f.id] }] }, opts);
    assert.strictEqual(ok.ok, true);
    assert.ok(ok.rendered.indexOf('Is there a water tap?') < ok.rendered.indexOf('List at 35k per acre'), 'unknowns first');
    assert.strictEqual(runtime.ledger(info.id).view().facts.get(f.id).loadBearing, true);
  });
});

describe('case-mode helpers', () => {
  it('adds case tools only when a case is attached', () => {
    const base = [{ name: 'Read' }, { name: 'Ledger' }];
    assert.deepStrictEqual(shapeToolDefinitions(base, false, toolRegistry).map((d) => d.name), ['Read']);
    assert.deepStrictEqual(shapeToolDefinitions(base, true, toolRegistry).map((d) => d.name), ['Read', ...CASE_TOOL_NAMES]);
  });

  it('puts the case prompt and orientation ahead of the base prompt', () => {
    const p = buildCaseSystemPrompt('ORIENT', 'BASE');
    assert.ok(p.startsWith(CASE_MODE_PROMPT));
    assert.ok(p.indexOf('ORIENT') < p.indexOf('BASE'));
  });

  it('protects facts.jsonl and .kl/ but nothing else', () => {
    const dir = path.resolve(tmp(), 'case');
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'facts.jsonl')), true);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, '.kl', 'decisions.jsonl')), true);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'artifacts', 'sheet.md')), false);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, '..', 'facts.jsonl')), false);
    assert.strictEqual(isProtectedCasePath(null, path.join(dir, 'facts.jsonl')), false);
  });
});

describe('ToolExecutor ledger write guard', () => {
  it('refuses Write, Edit and MultiEdit on protected case files', async () => {
    const { info } = await setup();
    const executor = new ToolExecutor({
      workingDirectory: info.dir,
      allowedDirectories: [info.dir],
      runtimeEnvironment: { platform: process.platform },
      requireApproval: false,
      useSandbox: false,
      extraToolOptions: { caseContext: { dir: info.dir } }
    });
    const factsPath = path.join(info.dir, 'facts.jsonl');
    const before = fs.readFileSync(factsPath, 'utf8');
    const w = await executor.execute('Write', { file_path: factsPath, content: '{"kind":"fact"}\n' });
    assert.strictEqual(w.success, false);
    assert.match(w.error, /Ledger tool/);
    const e = await executor.execute('Edit', { file_path: path.join(info.dir, '.kl', 'x.json'), old_string: 'a', new_string: 'b' });
    assert.strictEqual(e.success, false);
    const m = await executor.execute('MultiEdit', { edits: [{ file_path: factsPath, old_string: 'a', new_string: 'b' }] });
    assert.strictEqual(m.success, false);
    assert.strictEqual(fs.readFileSync(factsPath, 'utf8'), before);
  });
});
