// tests/cases-create-objective.test.js
// Cases stage 8, owner ruling 2026-10-13 (N3): the new-case form has an
// Objective field. What the owner types there is the case's objective,
// confirmed from the start (origin owner-create); left empty, the case has
// no objective and the model's first one reads proposed, as before. This
// file also pins how every caller of CaseRuntime.createCase ends up, so no
// other path gets a confirmed objective by naming one.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const IPC = require('../src/ipc/constants');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const { CaseRuntime } = require('../src/cases');
const { createCaseToolHandler } = require('../src/mcp/case-tools');
const { CASE_MCP_TOOLS } = require('../src/cases/mcp-tool-definitions');
const { markLocalDesktopEvent } = require('../src/core/origin');
const { historyContext } = require('./helpers/history-context');

const ROOT = path.join(__dirname, '..');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-create-objective-'));
  dirs.push(root);
  const runtime = new CaseRuntime({ root });
  const history = historyContext([{ id: 'chat-1', title: 'Chat', messages: [] }]);
  const handlers = new Map();
  registerCaseHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getCaseRuntime: () => runtime, ...history });
  // The host marks every IPC event before a handler sees it.
  const create = (payload) => handlers.get(IPC.CASE_CREATE)(markLocalDesktopEvent({}), payload);
  const createUnmarked = (payload) => handlers.get(IPC.CASE_CREATE)({}, payload);
  const objective = (id) => runtime.scopeView(id).objective;
  return { runtime, create, createUnmarked, objective };
}

const refusal = async (promise) => {
  try {
    const value = await promise;
    return value && value.ok === false ? value : assert.fail(`expected a refusal, got ${JSON.stringify(value)}`);
  } catch (err) {
    return err;
  }
};

describe('case:create with the form\'s objective', () => {
  it('records what the owner typed, trimmed, as the confirmed objective', async () => {
    const { runtime, create, objective } = setup();
    const made = await create({ title: 'Lakeside lot', objective: '  Convert the lot to cash  ', chatId: 'chat-1' });
    assert.strictEqual(made.ok, true);
    const o = objective(made.case.id);
    assert.deepStrictEqual([o.text, o.state, o.origin, o.confirmed.by], ['Convert the lot to cash', 'confirmed', 'owner-create', 'owner-create']);
    assert.strictEqual(runtime.brief(made.case.id).read().data.objective, 'Convert the lot to cash');
    // The ready-to-close list no longer asks the owner to confirm it.
    const item = runtime.progress(made.case.id).readiness.items.find((i) => i.id === 'objective-confirmed');
    assert.strictEqual(item.state, 'ok');
  });

  it('an empty field is as before: no objective, and the model\'s first one reads proposed', async () => {
    const { runtime, create, objective } = setup();
    for (const payload of [{ title: 'Roof quotes' }, { title: 'Fence repair', objective: undefined }]) {
      const made = await create(payload);
      assert.strictEqual(made.ok, true);
      assert.strictEqual(objective(made.case.id), null);
      assert.strictEqual(runtime.brief(made.case.id).read().data.objective, '');
    }
    const id = runtime.listCases()[0].id;
    await runtime.systemAction(id, 'model objective', async () => {
      runtime.writeScope(id, { field: 'objective', value: 'Get three roof quotes', origin: 'model', addedBy: 'turn-1' });
    });
    assert.deepStrictEqual([objective(id).state, objective(id).origin], ['proposed', 'model']);
  });

  it('holds the objective to the same rules as any other: text, not blank, at most 2,000 characters', async () => {
    const { runtime, create } = setup();
    const refused = [
      [{ title: 'Lakeside lot', objective: 7 }, /objective/],
      [{ title: 'Lakeside lot', objective: '   ' }, /objective/],
      [{ title: 'Lakeside lot', objective: ['Sell the lot'] }, /objective/],
      [{ title: 'Lakeside lot', objective: 'x'.repeat(2001) }, /at most 2000 characters/]
    ];
    for (const [payload, re] of refused) {
      const r = await create(payload);
      assert.strictEqual(r.ok, false, JSON.stringify(payload).slice(0, 80));
      assert.match(r.error, re);
    }
    assert.deepStrictEqual(runtime.listCases(), [], 'a refused form creates nothing');
    assert.strictEqual((await create({ title: 'Lakeside lot', objective: 'x'.repeat(2000) })).ok, true);
  });

  it('the similar-case check reads the objective, and the owner\'s "Create anyway" keeps it confirmed', async () => {
    const { create, objective } = setup();
    assert.strictEqual((await create({ title: 'Lakeside lot', objective: 'Sell the lakeside lot for cash this year' })).ok, true);
    const again = await create({ title: 'Parcel sale', objective: 'Sell the lakeside lot for cash this year' });
    assert.deepStrictEqual([again.ok, again.code], [false, 'SIMILAR_CASES']);
    const forced = await create({ title: 'Parcel sale', objective: 'Sell the lakeside lot for cash this year', force: true });
    assert.strictEqual(forced.ok, true);
    assert.deepStrictEqual([objective(forced.case.id).state, objective(forced.case.id).origin], ['confirmed', 'owner-create']);
  });

  it('the form cannot say who gave the objective, and only the app\'s own window confirms one', async () => {
    const { create, createUnmarked, objective } = setup();
    const claimed = await create({ title: 'Permit filing', objective: 'File the county permit', objectiveBy: 'detour', confirmed: false });
    assert.deepStrictEqual([objective(claimed.case.id).state, objective(claimed.case.id).origin], ['confirmed', 'owner-create']);
    const none = await create({ title: 'Roof quotes', objectiveBy: 'owner' });
    assert.strictEqual(objective(none.case.id), null);
    // An event the host did not mark is not the owner's form: never confirmed.
    const elsewhere = await createUnmarked({ title: 'Dock repair', objective: 'Fix the dock before winter' });
    assert.strictEqual(elsewhere.ok, true);
    assert.deepStrictEqual([objective(elsewhere.case.id).state, objective(elsewhere.case.id).origin], ['proposed', 'model']);
  });
});

describe('every caller of createCase and the objective it ends up with', () => {
  it('the runtime confirms only for objectiveBy "owner"; a detour\'s and anything else\'s is proposed', async () => {
    const { runtime, objective } = setup();
    const by = async (title, text, objectiveBy) => {
      const info = await runtime.createCase({ title, objective: text, force: true, ...(objectiveBy === undefined ? {} : { objectiveBy }) });
      const o = objective(info.id);
      return [o.state, o.origin];
    };
    assert.deepStrictEqual(await by('Lakeside lot', 'Convert the lot to cash', 'owner'), ['confirmed', 'owner-create']);
    assert.deepStrictEqual(await by('Roof quotes', 'Get three written roof quotes', 'detour'), ['proposed', 'detour']);
    assert.deepStrictEqual(await by('Permit filing', 'File the county building permit', undefined), ['proposed', 'model']);
    for (const [i, value] of ['model', 'owner-create', 'owner-action', 'user', true, { by: 'owner' }].entries()) {
      assert.deepStrictEqual(await by(`Errand ${i}`, `Deliver parcel number ${i} across town`, value), ['proposed', 'model'], String(value));
    }
  });

  it('create_case in the chat: confirmed only with the owner\'s own words this turn', async () => {
    const { runtime, objective } = setup();
    const h = createCaseToolHandler({ getRuntime: () => runtime, channel: 'in-app-chat' });
    const args = { title: 'Boat sale', objective: 'sell the boat', quote: 'start a case to sell the boat' };
    // No owner text, a quote the owner did not write, an objective outside the quote: nothing is created.
    assert.strictEqual((await refusal(h.call('create_case', args))).code, 'not_owner');
    assert.strictEqual((await refusal(h.call('create_case', args, { ownerTurnText: 'what is the weather like today' }))).code, 'quote_not_found');
    assert.strictEqual((await refusal(h.call('create_case', { ...args, objective: 'sell the boat and the trailer' }, { ownerTurnText: 'Please start a case to sell the boat.' }))).code, 'objective_not_in_quote');
    assert.deepStrictEqual(runtime.listCases(), []);
    const made = await h.call('create_case', args, { ownerTurnText: 'Please start a case to sell the boat.' });
    const o = objective(made.case_id);
    assert.deepStrictEqual([o.text, o.state, o.origin], ['sell the boat', 'confirmed', 'owner-create']);
    // The fact that says the owner said it carries the quote and the channel.
    const fact = runtime.ledger(made.case_id).view().facts.get(made.fact_id);
    assert.deepStrictEqual([fact.provenance, fact.source.channel, fact.source.quote], ['user', 'in-app-chat', 'start a case to sell the boat']);
  });

  // Spec §6.1's origins table: create_case holds the objective to the quote
  // on every channel. Over MCP the quote is recorded and not checked
  // (management surfaces, Q28): the grant's cases:manage scope is the gate.
  it('create_case over MCP: the objective must still be words from the quote; it is confirmed with the quote on record', async () => {
    for (const channel of ['mcp-stdio', 'mcp-frontdoor']) {
      const { runtime, objective } = setup();
      const h = createCaseToolHandler({ getRuntime: () => runtime, channel });
      assert.strictEqual((await refusal(h.call('create_case', { title: 'Shed', objective: 'build a shed', quote: 'a garden project please' }))).code, 'objective_not_in_quote');
      assert.strictEqual((await refusal(h.call('create_case', { title: 'Shed', objective: 'build a shed' }))).code, 'invalid_params');
      assert.deepStrictEqual(runtime.listCases(), [], channel);
      const made = await h.call('create_case', { title: 'Shed', objective: 'build a shed', quote: 'Build a shed by spring' });
      assert.deepStrictEqual([objective(made.case_id).state, objective(made.case_id).origin], ['confirmed', 'owner-create'], channel);
      const fact = runtime.ledger(made.case_id).view().facts.get(made.fact_id);
      assert.deepStrictEqual([fact.source.channel, fact.source.quote], [channel, 'Build a shed by spring']);
    }
  });

  it('no tool takes objectiveBy, and only the form, create_case and the detour router pass it', () => {
    const naming = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('objectiveBy')) naming.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepStrictEqual(naming.sort(), ['src/cases/case-runtime.js', 'src/cases/detours/router.js', 'src/ipc/case-handlers.js', 'src/mcp/case-tools.js']);
    // The callers of the runtime's createCase, each with what it passes.
    const calls = [];
    for (const file of naming) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of src.matchAll(/\.createCase\(\{[\s\S]*?\}\)/g)) calls.push([file, /objectiveBy: '(\w+)'/.exec(m[0])?.[1] || (/objectiveBy/.test(m[0]) ? 'host-decided' : null)]);
    }
    assert.deepStrictEqual(calls.sort(), [
      ['src/cases/detours/router.js', 'detour'],
      ['src/ipc/case-handlers.js', 'owner'],
      ['src/mcp/case-tools.js', 'owner']
    ]);
    // The form's objective is the owner's only when the event is the app's own.
    assert.match(fs.readFileSync(path.join(ROOT, 'src/ipc/case-handlers.js'), 'utf8'), /const ownForm = isLocalDesktopEvent\(event\);/);
    // create_case's schema has no such parameter (and no force).
    const schema = CASE_MCP_TOOLS.find((t) => t.name === 'create_case').inputSchema;
    assert.deepStrictEqual(Object.keys(schema.properties), ['title', 'objective', 'type', 'quote']);
    assert.strictEqual(schema.additionalProperties, false);
  });
});

describe('the new-case form', () => {
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

  it('has an Objective field and sends what was typed on the first create and on "Create anyway"', () => {
    const start = renderer.indexOf("if (select.value === '__new__') {");
    const end = renderer.indexOf('const result = await window.electron.cases.attach({ chatId: chat.id, caseId: select.value || null });', start);
    assert.ok(start > 0 && end > start, 'the new-case branch is found');
    const form = renderer.slice(start, end);
    assert.match(form, /chat-case-new-objective/);
    const creates = form.split('\n').filter((line) => line.includes('window.electron.cases.create('));
    assert.strictEqual(creates.length, 2);
    for (const call of creates) assert.match(call, /\.\.\.objectiveField\(\)/, call);
    assert.match(creates[1], /force: true/);
    // An empty field sends no objective at all.
    assert.match(form, /objective \? \{ objective \} : \{\}/);
    assert.doesNotMatch(form, /innerHTML|insertAdjacentHTML/);
  });

  it('the preload checks the objective is text and sends the form as it is', async () => {
    let sent = null;
    const sandbox = {
      require: (mod) => {
        if (mod === 'electron') {
          return {
            contextBridge: { exposeInMainWorld: (name, api) => { sandbox.api = api; } },
            ipcRenderer: { invoke: async (channel, payload) => { sent = { channel, payload }; return { ok: true }; }, on: () => {}, send: () => {}, removeListener: () => {} }
          };
        }
        return mod.startsWith('.') ? require(path.join(ROOT, mod)) : require(mod);
      },
      console,
      Date
    };
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8'), vm.createContext(sandbox));
    assert.throws(() => sandbox.api.cases.create({ title: 'Lakeside lot', objective: 7 }), /Invalid objective: expected string/);
    await sandbox.api.cases.create({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    assert.deepStrictEqual([sent.channel, sent.payload.objective], ['case:create', 'Convert the lot to cash']);
    await sandbox.api.cases.create({ title: 'Roof quotes' });
    assert.strictEqual(Object.hasOwn(sent.payload, 'objective'), false);
  });
});
