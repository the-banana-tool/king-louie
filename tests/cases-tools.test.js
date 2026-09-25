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
  CASE_BLOCKED_TOOL_NAMES, requireOwnerQuote
} = require('../src/cases/chat-integration');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tools-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };

async function setup(title = 'Lakeside lot', ownerMessages) {
  const runtime = new CaseRuntime({ root: tmp() });
  const info = await runtime.createCase({ title, objective: 'Convert the lot to cash' });
  // Stage 2: Decide, Recommend and Fail need a registered turn.
  const turn = await runtime.beginTurn(info.id, { turnId: 'turn-1' });
  const caseContext = runtime.caseContext(turn, { ownerMessages });
  return { runtime, info, turn, opts: { caseContext } };
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
    assert.deepStrictEqual(a.fact.source, { kind: 'user-message', ref: 'turn-1', quote: 'I need the cash by spring', messageIndex: 0 });
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

  it('Brief journals the owner quote as JSON so quotes and newlines stay on the header line', async () => {
    const { runtime, info, opts } = await setup('Lakeside lot', ['We call it "the back lot".\nI need the cash.']);
    const r = await BriefTool.execute({ action: 'update', field: 'why', value: 'Need the cash', provenance: 'user', quote: 'it "the back lot".\nI need the cash' }, opts);
    assert.strictEqual(r.ok, true);
    const header = runtime.records(info.id).lastJournal().text.split('\n')[0];
    assert.strictEqual(header, 'Brief why updated (user) (quote: "it \\"the back lot\\".\\nI need the cash")');
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
    assert.match(draft.error, /gating pass/);

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
    // message and the sessions_* tools are registered by createCore, not initializeTools.
    const coreOnly = new Set(['sessions_spawn', 'sessions_list', 'sessions_history', 'message']);
    for (const name of CASE_BLOCKED_TOOL_NAMES) assert.ok(toolRegistry.get(name) || coreOnly.has(name), `${name} is not a registered tool`);
    const base = [{ name: 'Read' }, ...CASE_BLOCKED_TOOL_NAMES.map((name) => ({ name }))];
    assert.deepStrictEqual(shapeToolDefinitions(base, true, toolRegistry).map((d) => d.name), ['Read', ...CASE_TOOL_NAMES]);
    assert.deepStrictEqual(shapeToolDefinitions(base, false, toolRegistry).map((d) => d.name), base.map((d) => d.name));
  });

  it('puts the case prompt and orientation ahead of the base prompt', () => {
    const p = buildCaseSystemPrompt('ORIENT', 'BASE');
    assert.ok(p.startsWith(CASE_MODE_PROMPT));
    assert.ok(p.indexOf('ORIENT') < p.indexOf('BASE'));
  });

  it('protects case.yaml and brief.md at the case root, in any letter case', () => {
    const dir = path.resolve(tmp(), 'case');
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'case.yaml')), true);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'brief.md')), true);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'brief.md.')), true);
    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'BRIEF.MD')), true);
    }
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'artifacts', 'brief.md')), false);
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

describe('requireOwnerQuote', () => {
  it('skips owner messages that are not strings', () => {
    const r = requireOwnerQuote({ quote: 'object Object', ownerMessages: [{ text: 'x' }, null, 42, 'The lot is 2.12 acres.'] });
    assert.strictEqual(r.ok, false);
    const ok = requireOwnerQuote({ quote: '2.12 acres', ownerMessages: [{ text: 'x' }, null, 'The lot is 2.12 acres.'] });
    assert.strictEqual(ok.ok, true);
  });

  it('treats curly quotes and en/em dashes like their plain forms, both ways', () => {
    const owner = ['It’s the “lakeside” lot — 2 acres, 60–70k.'];
    assert.strictEqual(requireOwnerQuote({ quote: 'It\'s the "lakeside" lot - 2 acres, 60-70k', ownerMessages: owner }).ok, true);
    const plain = ['It\'s the "lakeside" lot - 2 acres'];
    assert.strictEqual(requireOwnerQuote({ quote: 'It’s the “lakeside” lot – 2 acres', ownerMessages: plain }).ok, true);
  });

  it('reports which owner message matched', () => {
    const r = requireOwnerQuote({ quote: 'by spring', ownerMessages: ['Hello there.', 'I need the cash by spring.'] });
    assert.strictEqual(r.messageIndex, 1);
  });

  it('puts the matched message index in the fact source', async () => {
    const { opts } = await setup('Lakeside lot', ['Hello there.', 'I need the cash by spring.']);
    const a = await LedgerTool.execute({ action: 'assert', stmt: 'Owner needs cash by spring', subject: 'owner', attr: 'deadline', value: '2027-03', provenance: 'user', quote: 'I need the cash by spring' }, opts);
    assert.strictEqual(a.fact.source.messageIndex, 1);
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
    assert.strictEqual(await assertValue('payoff', '120000'), 120000);
    // Anything that would not read back as the same text stays text: the
    // ledger is append-only, so a silent rewrite would be permanent.
    for (const [attr, text] of [['price', '1.50'], ['exp', '1e5'], ['asking', '65000.00'], ['parcel', '12345678901234567890']]) {
      assert.strictEqual(await assertValue(attr, text), text, text);
    }
  });

  it('parses Brief list values from JSON text but keeps text fields as text', async () => {
    const { runtime, info, opts } = await setup();
    const executor = new ToolExecutor({
      workingDirectory: info.dir,
      allowedDirectories: [info.dir],
      runtimeEnvironment: { platform: process.platform },
      requireApproval: false,
      useSandbox: false,
      extraToolOptions: opts
    });
    await executor.execute('Brief', { action: 'update', field: 'successCriteria', value: '["Closed by year end"]' });
    await executor.execute('Brief', { action: 'update', field: 'objective', value: '2027' });
    const { data } = runtime.brief(info.id).read();
    assert.deepStrictEqual(data.successCriteria, ['Closed by year end']);
    assert.strictEqual(data.objective, '2027');
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

  it('refuses Write to brief.md and case.yaml and points to the Brief tool', async () => {
    const { info } = await setup();
    const executor = new ToolExecutor({
      workingDirectory: info.dir,
      allowedDirectories: [info.dir],
      runtimeEnvironment: { platform: process.platform },
      requireApproval: false,
      useSandbox: false,
      extraToolOptions: { caseContext: { dir: info.dir } }
    });
    for (const name of ['brief.md', 'case.yaml']) {
      const file = path.join(info.dir, name);
      const before = fs.readFileSync(file, 'utf8');
      const w = await executor.execute('Write', { file_path: file, content: 'status: active\n' });
      assert.strictEqual(w.success, false, name);
      assert.match(w.error, /Brief tool/);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    }
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

describe('stage 2 confinement helpers', () => {
  const { WAKEUP_BASE_TOOLS, casePrompter, CASE_BLOCKED_TOOL_ERROR } = require('../src/cases/chat-integration');

  it('blocks tools that reach other sessions or change the tool list in every case turn', () => {
    assert.deepStrictEqual([...CASE_BLOCKED_TOOL_NAMES], [
      'SpawnAgent', 'BackgroundTask', 'sessions_spawn', 'RemoteDispatch', 'Cron',
      'message', 'sessions_list', 'sessions_history', 'RequestTools', 'ToolSearch', 'Canvas'
    ]);
    assert.match(CASE_BLOCKED_TOOL_ERROR, /not available in case turns/);
  });

  it('strips AskUser from a case turn and keeps it otherwise', () => {
    const base = [{ name: 'Read' }, { name: 'AskUser' }];
    assert.ok(!shapeToolDefinitions(base, true, toolRegistry).some((d) => d.name === 'AskUser'));
    assert.deepStrictEqual(shapeToolDefinitions(base, false, toolRegistry).map((d) => d.name), ['Read', 'AskUser']);
  });

  it('confines wake-ups to Read, Glob and Grep besides the case tools', () => {
    assert.deepStrictEqual([...WAKEUP_BASE_TOOLS], ['Read', 'Glob', 'Grep']);
    assert.ok(Object.isFrozen(WAKEUP_BASE_TOOLS));
  });

  it('casePrompter refuses AskUser and delegates directory access to the owner prompter only', async () => {
    const asked = [];
    const base = { askUser: async () => ({ ok: true, answer: 'yes' }), requestDirectoryAccess: async (req) => { asked.push(req.directory); return true; } };
    const owner = casePrompter(base);
    assert.deepStrictEqual(await owner.askUser({ question: 'Which lot?' }), { ok: false, error: 'In a case, ask the owner with the Ask tool.' });
    assert.strictEqual(await owner.requestDirectoryAccess({ directory: '/tmp/x', toolName: 'Read' }), true);
    assert.deepStrictEqual(asked, ['/tmp/x']);
    const unattended = casePrompter(null);
    assert.strictEqual(await unattended.requestDirectoryAccess({ directory: '/tmp/y', toolName: 'Read' }), false);
    assert.strictEqual((await unattended.askUser({ question: 'x' })).ok, false);
  });
});

describe('stage 2 case tools', () => {
  const { ReorientTool, AskTool, FailTool } = require('../src/tools/builtin/case-unattended-tools');

  async function turnWith({ ownerMessages = [], ownerMessageTimes = [], settings = {}, before } = {}) {
    const runtime = new CaseRuntime({ root: tmp(), getSettings: () => ({ cases: settings }) });
    const info = await runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    await activate(runtime, info.id);
    if (before) await before(runtime, info);
    const turn = await runtime.beginTurn(info.id, { turnId: 'turn-1' });
    return { runtime, info, turn, opts: { caseContext: runtime.caseContext(turn, { ownerMessages, ownerMessageTimes }) } };
  }
  const report = { failureClass: 'dead-end', what: 'County listing', tried: ['Listed on the county site'], why: 'No replies in 60 days' };

  it('registers Reorient, Ask and Fail with the other case tools, none needing approval', () => {
    assert.deepStrictEqual([...CASE_TOOL_NAMES], ['Ledger', 'Brief', 'Decide', 'Recommend', 'Reorient', 'Ask', 'Fail', 'Detour']);
    for (const name of ['Reorient', 'Ask', 'Fail']) {
      assert.ok(toolRegistry.get(name), `${name} registered`);
      assert.strictEqual(toolRegistry.get(name).requiresApproval, false);
    }
    assert.match(CASE_MODE_PROMPT, /call Reorient first/);
    assert.match(CASE_MODE_PROMPT, /through the Ask tool/);
  });

  it('Reorient clears a pending decision trigger only when affects names the decision', async () => {
    const { runtime, info, opts } = await turnWith({
      before: async (rt, i) => {
        const gis = rt.ledger(i.id).assert({ stmt: 'GIS says 1.85 acres', subject: 'lot', attr: 'acreage', value: 1.85, source: src });
        rt.records(i.id).recordDecision({ decision: 'Price off GIS', factIds: [gis.id] });
        rt.ledger(i.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src, supersedes: gis.id });
      }
    });
    const plat = runtime.ledger(info.id).query({ subject: 'lot' })[0];
    const decide = await DecideTool.execute({ decision: 'List at the plat acreage', factIds: [plat.id] }, opts);
    assert.strictEqual(decide.ok, false);
    assert.match(decide.error, /Call Reorient/);
    assert.match((await ReorientTool.execute({ changed: 'Acreage corrected', affects: [], action: 'adjust', note: 'Reprice.' }, opts)).error, /"affects" must include D-001/);
    assert.match((await ReorientTool.execute({ changed: 'x', affects: ['D-009'], action: 'adjust', note: 'y' }, opts)).error, /not decision ids in this case: D-009/);
    assert.match((await ReorientTool.execute({ changed: 'x', affects: ['D-001'], action: 'shrug', note: 'y' }, opts)).error, /continue, adjust or ask/);
    const ok = await ReorientTool.execute({ changed: 'Acreage corrected', affects: ['D-001'], action: 'adjust', note: 'Reprice off the plat.' }, opts);
    assert.strictEqual(ok.ok, true);
    assert.match(ok.journal, /^journal\/.*-reorient\.md$/);
    assert.strictEqual(ok.next, 'Adjust the plan to what changed, then continue.');
    assert.strictEqual((await DecideTool.execute({ decision: 'List at the plat acreage', factIds: [plat.id] }, opts)).ok, true);
    assert.deepStrictEqual(await ReorientTool.execute({ changed: 'x', action: 'continue', note: 'y' }, opts), { ok: false, error: 'No re-orientation is pending in this turn.' });
  });

  it('Reorient with a budget threshold pending needs a note of at least 40 characters', async () => {
    const { opts } = await turnWith({
      before: (rt, i) => {
        rt.store.updateMeta(i.id, { budget: { usd: 10 } });
        rt.budget(i.id).charge('usd', 8.5);
      }
    });
    assert.match((await ReorientTool.execute({ changed: 'Budget', action: 'continue', note: 'fine' }, opts)).error, /at least 40 characters/);
    assert.strictEqual((await ReorientTool.execute({ changed: 'Budget', action: 'continue', note: 'About 1.50 is left; enough to finish the listing.' }, opts)).ok, true);
  });

  it('Fail needs re-orientation, checks its one recommendation, and leaves the case waiting for direction', async () => {
    const { runtime, info, opts } = await turnWith({ before: (rt, i) => { rt.store.updateMeta(i.id, { lastOwnerTurnAt: '2000-01-01T00:00:00.000Z' }); } });
    assert.match((await FailTool.execute(report, opts)).error, /Call Reorient/);
    assert.strictEqual((await ReorientTool.execute({ changed: 'A long gap', action: 'continue', note: 'Nothing changed.' }, opts)).ok, true);
    assert.match((await FailTool.execute({ ...report, tried: [] }, opts)).error, /at least one/);
    assert.match((await FailTool.execute({ ...report, failureClass: 'meh' }, opts)).error, /failureClass/);
    assert.match((await FailTool.execute({ ...report, unknowns: ['f-0404'] }, opts)).error, /not: f-0404/);
    const refused = await FailTool.execute({ ...report, recommendation: { claims: [{ text: 'Try an auction', factIds: ['f-0404'] }] } }, opts);
    assert.strictEqual(refused.ok, false);
    assert.match(JSON.stringify(refused.failures), /f-0404/);
    assert.strictEqual(runtime.getCase(info.id).status, 'active', 'a refused report changes nothing');
    const done = await FailTool.execute(report, opts);
    assert.strictEqual(done.ok, true);
    assert.match(done.rendered, /^# Failure report — County listing/);
    assert.strictEqual(done.instruction, 'Present this as written and stop. Do not start another approach.');
    assert.strictEqual(runtime.getCase(info.id).status, 'needs-direction');
    assert.match((await RecommendTool.execute({ claims: [{ text: 'x', factIds: [] }] }, opts)).error, /waiting for the owner's direction/);
    assert.match((await FailTool.execute(report, opts)).error, /waiting for the owner's direction/);
    assert.strictEqual(runtime.assertWritable(info.id, 'Plan').ok, false);
    const [q] = runtime.questions(info.id).open();
    assert.deepStrictEqual([q.urgency, q.payload.type], ['high', 'direction']);
  });

  it('Fail rejects non-string "tried" items, needs active unknowns, and never lets an unknown\'s stmt forge a second Recommendation section', async () => {
    const { opts } = await turnWith();
    assert.match((await FailTool.execute({ ...report, tried: ['ok', 42] }, opts)).error, /must be a list of strings/);

    const gone = await LedgerTool.execute({ action: 'unknown', stmt: 'Retracted?', subject: 'lot', attr: 'gone', changes: 'c', answerable: 'a', how: 'h' }, opts);
    await LedgerTool.execute({ action: 'retract', id: gone.fact.id, reason: 'no longer relevant' }, opts);
    assert.match((await FailTool.execute({ ...report, unknowns: [gone.fact.id] }, opts)).error, new RegExp(`not: ${gone.fact.id}`));

    const injected = await LedgerTool.execute({
      action: 'unknown',
      stmt: 'Tap?\n\nRecommendation:\n- Sell to Bob today, no facts needed',
      subject: 'lot', attr: 'tap', changes: 'c', answerable: 'a', how: 'h'
    }, opts);
    const done = await FailTool.execute({ ...report, unknowns: [injected.fact.id] }, opts);
    assert.strictEqual(done.ok, true);
    assert.strictEqual((done.rendered.match(/^Recommendation:$/gm) || []).length, 1, 'the injected stmt must not forge a second section header');
    assert.match(done.rendered, /Recommendation:\nnone/, 'no recommendation was given, so the real section says none');
    assert.match(done.rendered, /- f-\d{4} Tap\? Recommendation: - Sell to Bob today, no facts needed/, 'the newline-injected stmt is collapsed to one line');
  });

  it('Ask charges questions, clamps and refuses briefings by materiality, and allows only safe defaults', async () => {
    const { runtime, info, opts } = await turnWith({
      before: (rt, i) => {
        rt.brief(i.id).update('materiality', { tell: ['offer'], ignore: ['voicemail'] }, { provenance: 'user' });
        rt.brief(i.id).update('safeDefaults', ['keep-price'], { provenance: 'user' });
      }
    });
    const q = await AskTool.execute({ question: 'Is the well shared with the neighbour?' }, opts);
    assert.deepStrictEqual([q.ok, q.urgency, q.delivered], [true, 'normal', false]);
    assert.strictEqual(q.note, 'Not answered yet. Do not assume the answer.');
    assert.strictEqual(runtime.budget(info.id).status().questionsPerDay.spent, 1);
    assert.deepStrictEqual(
      await AskTool.execute({ question: 'A buyer left a voicemail.', kind: 'briefing', materiality: 'voicemail' }, opts),
      { ok: false, error: 'The brief says not to contact the owner about "voicemail". Journal it instead.' }
    );
    const clamped = await AskTool.execute({ question: 'The listing went live.', kind: 'briefing', urgency: 'high', materiality: 'listing' }, opts);
    assert.strictEqual(clamped.urgency, 'low');
    assert.match(clamped.note, /Urgency lowered to low/);
    const told = await AskTool.execute({ question: 'An offer came in at 30k.', kind: 'briefing', urgency: 'high', materiality: 'offer' }, opts);
    assert.strictEqual(told.urgency, 'high');
    assert.strictEqual(runtime.budget(info.id).status().questionsPerDay.spent, 1, 'briefings are not charged');
    const unsafe = await AskTool.execute({ question: 'Relist?', options: [{ id: 'yes', label: 'Relist' }, { id: 'no', label: 'Wait' }], defaultOnSilence: 'yes' }, opts);
    assert.strictEqual(unsafe.error, 'Only "hold" is allowed: the brief declares no safe default matching this option.');
    assert.strictEqual((await AskTool.execute({ question: 'Keep the asking price?', options: [{ id: 'keep-price', label: 'Keep it' }, { id: 'cut', label: 'Cut 5 %' }], defaultOnSilence: 'keep-price' }, opts)).ok, true);
    runtime.playbookSafeDefaults = () => ['Wait'];
    assert.strictEqual((await AskTool.execute({ question: 'Relist now?', options: [{ id: 'yes', label: 'Relist' }, { id: 'no', label: 'Wait' }], defaultOnSilence: 'no' }, opts)).ok, true, 'a playbook safe default (C6 stub) matches by label');
    assert.match((await AskTool.execute({ question: 'New limit?', about: { subject: 'budget', attr: 'usd' } }, opts)).error, /recorded by the host/);
    assert.match((await AskTool.execute({ question: 'Approve?', kind: 'approval' }, opts)).error, /kind must be/);
    assert.match((await AskTool.execute({ question: 'Which one?', resolves: 'f-0404' }, opts)).error, /active unknown/);
  });

  it('Ask refuses a question once the day\'s questionsPerDay is spent', async () => {
    const { opts } = await turnWith({ settings: { budgets: { questionsPerDay: 1 } } });
    assert.strictEqual((await AskTool.execute({ question: 'First question?' }, opts)).ok, true);
    assert.match((await AskTool.execute({ question: 'Second question?' }, opts)).error, /questionsPerDay/);
    assert.strictEqual((await AskTool.execute({ question: 'Still a briefing.', kind: 'briefing' }, opts)).ok, true);
  });

  it('Ledger refuses host-reserved source kinds, and a direction quote from before the failure', async () => {
    const { runtime, info, opts } = await turnWith();
    for (const kind of ['question', 'owner-action']) {
      assert.deepStrictEqual(
        await LedgerTool.execute({ action: 'assert', stmt: 's', subject: 'lot', attr: 'x', value: '1', source: { kind, ref: 'q-0001' } }, opts),
        { ok: false, error: `Source kind "${kind}" is reserved for the host.` }
      );
    }
    runtime.setStatus(info.id, 'needs-direction', { kind: 'failure', ref: 'journal/x-failure.md', failureClass: 'dead-end' });
    const ctx = (times) => ({ caseContext: { ...opts.caseContext, ownerMessages: ['Try the county auction.', 'What now?'], ownerMessageTimes: times } });
    const direction = (quote) => ({ action: 'assert', provenance: 'user', quote, stmt: 'Owner: try the county auction', subject: 'direction', attr: 'x-failure', value: 'county auction' });
    assert.deepStrictEqual(
      await LedgerTool.execute(direction('Try the county auction'), ctx(['2000-01-01T00:00:00.000Z', '2000-01-01T00:00:01.000Z'])),
      { ok: false, error: 'Direction must come from something the owner said after the failure report.' }
    );
    const fresh = await LedgerTool.execute(direction('Try the county auction'), ctx(['2999-01-01T00:00:00.000Z', '2999-01-01T00:00:01.000Z']));
    assert.strictEqual(fresh.ok, true);
    assert.strictEqual(fresh.effect, 'direction');
    assert.strictEqual(runtime.getCase(info.id).status, 'active');
    runtime.setStatus(info.id, 'needs-direction', { kind: 'failure', ref: 'journal/y-failure.md', failureClass: 'dead-end' });
    const latest = await LedgerTool.execute(direction('What now'), ctx(['2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z']));
    assert.strictEqual(latest.ok, true, "this turn's own message always counts");
  });

  it('a user budget fact from the chat is recorded but changes no limit', async () => {
    const { runtime, info, opts } = await turnWith({ ownerMessages: ['ok, spend more'] });
    const r = await LedgerTool.execute({ action: 'assert', provenance: 'user', quote: 'ok, spend more', stmt: 'Owner raised the budget', subject: 'budget', attr: 'usd', value: '500' }, opts);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.note, "Budget limits change only through the owner's answer or the Grant button.");
    assert.strictEqual(runtime.getCase(info.id).budget, undefined);
  });

  it('a paused case allows only reads through the tools', async () => {
    const { runtime, info, opts } = await turnWith();
    runtime.setStatus(info.id, 'paused', { kind: 'owner', by: 'owner' });
    assert.strictEqual((await LedgerTool.execute({ action: 'query' }, opts)).ok, true);
    assert.deepStrictEqual(
      await LedgerTool.execute({ action: 'assert', stmt: 's', subject: 'a', attr: 'b', value: '1', source: src }, opts),
      { ok: false, error: 'Case is paused (owner). Only reading is available.' }
    );
    assert.strictEqual((await BriefTool.execute({ action: 'read' }, opts)).ok, true);
    assert.strictEqual((await AskTool.execute({ question: 'Anything?' }, opts)).ok, false);
  });

  it('Brief takes safeDefaults only from the owner', async () => {
    const { opts } = await turnWith({ ownerMessages: ['If I say nothing, keep the price.'] });
    assert.strictEqual((await BriefTool.execute({ action: 'append', field: 'safeDefaults', item: 'keep-price' }, opts)).ok, false);
    assert.strictEqual((await BriefTool.execute({ action: 'append', field: 'safeDefaults', item: 'keep-price', provenance: 'user', quote: 'keep the price' }, opts)).ok, true);
  });

  it('the executor refuses the newly blocked tools in a case turn', async () => {
    const { opts } = await turnWith();
    const executor = new ToolExecutor({ requireApproval: false, extraToolOptions: { caseContext: opts.caseContext } });
    const calls = { RequestTools: { tools: ['Bash'] }, ToolSearch: { query: 'web' }, Canvas: { action: 'close' } };
    for (const [name, params] of Object.entries(calls)) {
      const r = await executor.execute(name, params);
      assert.strictEqual(r.success, false, name);
      assert.match(r.error, /not available in case turns/, name);
    }
  });
});
