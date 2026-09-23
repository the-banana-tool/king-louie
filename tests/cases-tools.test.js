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
  CASE_TOOL_NAMES, CASE_MODE_PROMPT, shapeToolDefinitions, buildCaseSystemPrompt, isProtectedCasePath,
  CASE_BLOCKED_TOOL_NAMES
} = require('../src/cases/chat-integration');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tools-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };

async function setup(title = 'Lakeside lot', ownerMessages) {
  const runtime = new CaseRuntime({ root: tmp() });
  const info = await runtime.createCase({ title, objective: 'Convert the lot to cash' });
  const caseContext = { runtime, caseId: info.id, turnId: 'turn-1', dir: info.dir, ownerMessages };
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
    const { opts } = await setup('Lakeside lot', ['I need the cash by spring, no later than March 2027.']);
    const a = await LedgerTool.execute({ action: 'assert', stmt: 'Owner needs cash by spring', subject: 'owner', attr: 'deadline', value: '2027-03', provenance: 'user', quote: 'I need the cash by spring' }, opts);
    assert.strictEqual(a.ok, true);
    assert.deepStrictEqual(a.fact.source, { kind: 'user-message', ref: 'turn-1', quote: 'I need the cash by spring' });
    assert.strictEqual(a.fact.addedBy, 'turn-1');
    const i = await LedgerTool.execute({ action: 'infer', stmt: 'Owner is motivated', subject: 'owner', attr: 'motivation', value: 'high', basis: [a.fact.id] }, opts);
    assert.strictEqual(i.fact.provenance, 'inferred');
    const bad = await LedgerTool.execute({ action: 'assert', stmt: 'Guess', subject: 'lot', attr: 'x', value: 1 }, opts);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /source/);
    const q = await LedgerTool.execute({ action: 'query', filter: { subject: 'owner' } }, opts);
    assert.strictEqual(q.facts.length, 2);
  });

  it('Ledger assert with provenance user is refused without a matching owner quote', async () => {
    const noMessages = await setup('Lakeside lot');
    const a = await LedgerTool.execute({ action: 'assert', stmt: 'Owner needs cash', subject: 'owner', attr: 'deadline', value: '2027-03', provenance: 'user', quote: 'I need the cash' }, noMessages.opts);
    assert.strictEqual(a.ok, false);
    assert.match(a.error, /owner/i);

    const withMessages = await setup('Lakeside lot', ['The lot has a shed near the road.']);
    const b = await LedgerTool.execute({ action: 'assert', stmt: 'Owner needs cash', subject: 'owner', attr: 'deadline', value: '2027-03', provenance: 'user', quote: 'I need the cash' }, withMessages.opts);
    assert.strictEqual(b.ok, false);
    assert.match(b.error, /quote/i);

    const shortQuote = await LedgerTool.execute({ action: 'assert', stmt: 'Owner needs cash', subject: 'owner', attr: 'deadline', value: '2027-03', provenance: 'user', quote: 'ok' }, withMessages.opts);
    assert.strictEqual(shortQuote.ok, false);
    assert.match(shortQuote.error, /3 characters/);

    const noQuote = await LedgerTool.execute({ action: 'assert', stmt: 'Owner needs cash', subject: 'owner', attr: 'deadline', value: '2027-03', provenance: 'user' }, withMessages.opts);
    assert.strictEqual(noQuote.ok, false);
  });

  it('Ledger refuses a user-message source on any provenance but user', async () => {
    const { runtime, info, opts } = await setup('Lakeside lot', ['I need the cash by spring.']);
    for (const provenance of [undefined, 'sourced', 'external-agent']) {
      const r = await LedgerTool.execute({ action: 'assert', stmt: 'Owner needs cash by spring', subject: 'owner', attr: 'deadline', value: '2027-03', provenance, source: { kind: 'user-message', ref: 'turn-1' } }, opts);
      assert.strictEqual(r.ok, false, String(provenance));
      assert.match(r.error, /provenance "user".*quote/);
    }
    assert.strictEqual(runtime.ledger(info.id).view().facts.size, 0);
    assert.doesNotMatch(LedgerTool.parameters.properties.source.description || '', /user-message/);
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
    const { runtime, info, opts } = await setup('Lakeside lot', ['I need the cash from selling this lot.']);
    const read = await BriefTool.execute({ action: 'read' }, opts);
    assert.deepStrictEqual(read.missingForGating, ['why', 'successCriteria']);
    const refused = await BriefTool.execute({ action: 'update', field: 'why', value: 'I think they need cash', provenance: 'model' }, opts);
    assert.strictEqual(refused.ok, false);
    await BriefTool.execute({ action: 'update', field: 'why', value: 'Need the cash', provenance: 'user', reason: 'Owner said so', quote: 'I need the cash' }, opts);
    await BriefTool.execute({ action: 'append', field: 'successCriteria', item: 'Closed by year end' }, opts);
    const done = await BriefTool.execute({ action: 'completeGating' }, opts);
    assert.deepStrictEqual(done, { ok: true, status: 'active' });
    assert.match(runtime.records(info.id).lastJournal().file, /-brief/);
  });

  it('Brief owner-only fields with provenance user are refused without a matching owner quote, and stay refused for the model', async () => {
    const { opts } = await setup('Lakeside lot', ['I have already tried listing it myself.']);
    const noQuote = await BriefTool.execute({ action: 'update', field: 'hardConstraints', value: ['No sale below cost'], provenance: 'user' }, opts);
    assert.strictEqual(noQuote.ok, false);
    assert.match(noQuote.error, /quote/i);

    const nonMatching = await BriefTool.execute({ action: 'append', field: 'alreadyTried', item: 'Listed with an agent', provenance: 'user', quote: 'nothing like this appears anywhere' }, opts);
    assert.strictEqual(nonMatching.ok, false);

    const matching = await BriefTool.execute({ action: 'append', field: 'alreadyTried', item: 'Listed it myself', provenance: 'user', quote: 'I have already tried listing it myself' }, opts);
    assert.strictEqual(matching.ok, true);

    const modelOnly = await BriefTool.execute({ action: 'update', field: 'hardConstraints', value: ['No sale below cost'], provenance: 'model' }, opts);
    assert.strictEqual(modelOnly.ok, false);
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

  it('drops tools that start child runs from a case turn, and keeps them otherwise', () => {
    assert.ok(CASE_BLOCKED_TOOL_NAMES.includes('SpawnAgent'));
    assert.ok(CASE_BLOCKED_TOOL_NAMES.includes('BackgroundTask'));
    for (const name of CASE_BLOCKED_TOOL_NAMES) assert.ok(toolRegistry.get(name) || name === 'sessions_spawn', `${name} is not a registered tool`);
    const base = [{ name: 'Read' }, ...CASE_BLOCKED_TOOL_NAMES.map((name) => ({ name }))];
    assert.deepStrictEqual(shapeToolDefinitions(base, true, toolRegistry).map((d) => d.name), ['Read', ...CASE_TOOL_NAMES]);
    assert.deepStrictEqual(shapeToolDefinitions(base, false, toolRegistry).map((d) => d.name), base.map((d) => d.name));
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

describe('isProtectedCasePath hardening', () => {
  it('is case-insensitive on win32/darwin, case-sensitive elsewhere', () => {
    const dir = path.resolve(tmp(), 'case-ci');
    const expectFold = process.platform === 'win32' || process.platform === 'darwin';
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'FACTS.JSONL')), expectFold);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, '.KL', 'x')), expectFold);
  });

  it('strips an NTFS alternate-data-stream suffix from a segment', () => {
    const dir = path.resolve(tmp(), 'case-ads');
    assert.strictEqual(isProtectedCasePath(dir, `${path.join(dir, 'facts.jsonl')}::$DATA`), true);
  });

  it('strips trailing dots and spaces from the protected segment', () => {
    const dir = path.resolve(tmp(), 'case-trail');
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, '.kl ', 'x')), true);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, '.kl.', 'x')), true);
  });

  it('strips a \\\\?\\ long-path prefix before comparing', { skip: process.platform !== 'win32' }, () => {
    const dir = path.resolve(tmp(), 'case-long');
    const longPath = `\\\\?\\${path.join(dir, 'facts.jsonl')}`;
    assert.strictEqual(isProtectedCasePath(dir, longPath), true);
  });

  it('resolves a symlink/junction into the case dir before comparing', (t) => {
    const root = tmp();
    const dir = path.join(root, 'case-target');
    fs.mkdirSync(dir);
    const link = path.join(root, 'case-link');
    try {
      fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot create a symlink/junction in this environment: ${err.message}`);
      return;
    }
    assert.strictEqual(isProtectedCasePath(dir, path.join(link, 'facts.jsonl')), true);
  });
});

describe('case tool values through the executor', () => {
  it('accepts real numbers and lists, and parses JSON text for numbers and lists', async () => {
    const { info, opts } = await setup();
    const executor = new ToolExecutor({
      workingDirectory: info.dir,
      allowedDirectories: [info.dir],
      runtimeEnvironment: { platform: process.platform },
      requireApproval: false,
      useSandbox: false,
      extraToolOptions: opts
    });
    const assertValue = async (attr, value) => {
      const r = await executor.execute('Ledger', { action: 'assert', stmt: `Lot ${attr}`, subject: 'lot', attr, value, source: src });
      assert.strictEqual(r.success !== false && r.result?.ok !== false, true, JSON.stringify(r));
      return (r.result || r).fact.value;
    };
    assert.strictEqual(await assertValue('acreage', 1.85), 1.85);
    assert.strictEqual(await assertValue('acreage-text', '2.12'), 2.12);
    assert.deepStrictEqual(await assertValue('owners', '["A. Owner", "B. Owner"]'), ['A. Owner', 'B. Owner']);
    assert.deepStrictEqual(await assertValue('neighbours', ['north', 'south']), ['north', 'south']);
    assert.strictEqual(await assertValue('closing', '2027-03'), '2027-03');
    assert.strictEqual(await assertValue('zip', '02134'), '02134');
    assert.strictEqual(await assertValue('flag', 'true'), 'true');
  });
});

describe('ToolExecutor child runs in case turns', () => {
  const makeExecutor = (dir, extraToolOptions) => new ToolExecutor({
    workingDirectory: dir,
    allowedDirectories: [dir],
    runtimeEnvironment: { platform: process.platform },
    requireApproval: false,
    useSandbox: false,
    extraToolOptions
  });

  it('refuses SpawnAgent and BackgroundTask when a case is attached', async () => {
    const { info } = await setup();
    const executor = makeExecutor(info.dir, { caseContext: { dir: info.dir } });
    for (const [name, params] of [['SpawnAgent', { task: 'Price the Lakeside lot' }], ['BackgroundTask', { task: 'Price the Lakeside lot' }]]) {
      const r = await executor.execute(name, params);
      assert.strictEqual(r.success, false, name);
      assert.match(r.error, /not available in case turns/, name);
    }
  });

  it('leaves SpawnAgent alone when no case is attached', async () => {
    const { info } = await setup();
    const r = await makeExecutor(info.dir, {}).execute('SpawnAgent', { task: 'Price the Lakeside lot' });
    assert.doesNotMatch(String(r.error || ''), /case turns/);
  });
});

describe('ToolExecutor ledger write guard', () => {
  it('refuses Write, Edit and MultiEdit on protected case files', async () => {
    const { info } = await setup();
    const factsPath = path.join(info.dir, 'facts.jsonl');
    // Give both protected targets real content containing the Edit/MultiEdit
    // old_string, so these checks would actually succeed (proving they
    // exercise the guard) if the guard were removed.
    fs.writeFileSync(factsPath, 'a\n');
    const klFile = path.join(info.dir, '.kl', 'probe.json');
    fs.writeFileSync(klFile, 'a\n');
    const executor = new ToolExecutor({
      workingDirectory: info.dir,
      allowedDirectories: [info.dir],
      runtimeEnvironment: { platform: process.platform },
      requireApproval: false,
      useSandbox: false,
      extraToolOptions: { caseContext: { dir: info.dir } }
    });
    const before = fs.readFileSync(factsPath, 'utf8');
    const beforeKl = fs.readFileSync(klFile, 'utf8');
    const w = await executor.execute('Write', { file_path: factsPath, content: '{"kind":"fact"}\n' });
    assert.strictEqual(w.success, false);
    assert.match(w.error, /Ledger tool/);
    const e = await executor.execute('Edit', { file_path: klFile, old_string: 'a', new_string: 'b' });
    assert.strictEqual(e.success, false);
    assert.match(e.error, /Ledger tool/);
    const m = await executor.execute('MultiEdit', { edits: [{ file_path: factsPath, old_string: 'a', new_string: 'b' }] });
    assert.strictEqual(m.success, false);
    assert.match(m.error, /Ledger tool/);
    assert.strictEqual(fs.readFileSync(factsPath, 'utf8'), before);
    assert.strictEqual(fs.readFileSync(klFile, 'utf8'), beforeKl);
  });

  it('refuses a case-insensitive bypass like FACTS.JSONL on a case-insensitive filesystem', async () => {
    const { info } = await setup();
    const factsPath = path.join(info.dir, 'facts.jsonl');
    fs.writeFileSync(factsPath, 'a\n');
    const executor = new ToolExecutor({
      workingDirectory: info.dir,
      allowedDirectories: [info.dir],
      runtimeEnvironment: { platform: process.platform },
      requireApproval: false,
      useSandbox: false,
      extraToolOptions: { caseContext: { dir: info.dir } }
    });
    const before = fs.readFileSync(factsPath, 'utf8');
    const upperPath = path.join(info.dir, 'FACTS.JSONL');
    const w = await executor.execute('Write', { file_path: upperPath, content: 'x\n' });
    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.strictEqual(w.success, false);
      assert.match(w.error, /Ledger tool/);
    } else {
      // Not a real bypass on a case-sensitive filesystem: a distinct file.
      fs.rmSync(upperPath, { force: true });
    }
    assert.strictEqual(fs.readFileSync(factsPath, 'utf8'), before);
  });
});
