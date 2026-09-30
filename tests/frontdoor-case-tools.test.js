// tests/frontdoor-case-tools.test.js
// Cases stage 7, wave 4 (spec §3.8; program §4.19, R53): the case tools on
// the front door through F4's tool extensions (ScopeRegistry, FleetRouter)
// and on agent nodes through NodeFleetService.registerMethod. The router and
// the node are F4's real classes over tests/helpers/fake-node.js.
//
// Ruling T16-Q2 (default until the owner decides): the front door serves the
// read tools only, under cases:read. answer_question is not registered on
// the front door, on the router or on the node, and cases:write is not a
// scope the front door knows.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { registerFrontDoorCaseTools, CASE_SCOPES, CASE_TOOL_SCOPE } = require('../src/cases/mcp-tool-definitions');
const { registerNodeCaseMethods } = require('../src/mcp/case-tools');
const { createFleetScopeRegistry } = require('../src/frontdoor/oauth/scopes');
const { FleetRouter } = require('../src/frontdoor/router/router');
const { JobCache } = require('../src/frontdoor/router/job-cache');
const { createFakeNode, createFakeHub, createFakeRegistry } = require('./helpers/fake-node');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };

const READ_TOOLS = ['list_cases', 'open_case', 'get_orientation', 'list_questions', 'get_presence'];
const GRANT_ID = `gr_${'a'.repeat(22)}`;
const grant = (entries, machineIds = {}) => ({ grant_id: GRANT_ID, client_id: `dcr_${'b'.repeat(22)}`, client_name: 'Example Client', scopes: entries, machine_ids: machineIds });
const READ = grant([{ scope: 'cases:read', machines: null }]);
// What a client would hold if cases:write existed: it must still reach nothing.
const BOTH = grant([{ scope: 'cases:read', machines: null }, { scope: 'cases:write', machines: null }]);
// A stand-in for core.context.getContact() with no ladder entries.
const PRESENCE = {
  ladderState: () => ({}),
  presenceStatus: () => ({ presentChannel: null, away: false, quiet: false, timeZoneSource: 'host', signals: { desktop: null, mobile: null, channels: {} }, ladder: { runsHere: true } })
};
const fdOrigin = (scopes) => ({ kind: 'frontdoor', grant_id: GRANT_ID, client_id: `dcr_${'b'.repeat(22)}`, client_name: 'Example Client', scopes, mcp_session: null });

async function caseFixture() {
  const rt = new CaseRuntime({ root: tmp('kl-fd-cases-') });
  const meta = await rt.createCase({ title: 'Lakeside lot' });
  rt.store.updateMeta(meta.id, { status: 'active' });
  const ask = (record) => rt.createQuestion(meta.id, { kind: 'question', urgency: 'low', ...record }, { charge: false });
  const q = {
    plain: ask({ text: 'Which listing photo should lead?' }),
    failure: ask({ urgency: 'high', text: 'Upload failed; how to proceed?', payload: { type: 'direction', failure: 'journal/x-failure.md' } }),
    direction: ask({ urgency: 'high', text: 'Which way now?', payload: { type: 'direction' } }),
    review: ask({
      text: '2 facts proposed from payoff-letter.pdf (doc-3fa1c2d4e5f6).',
      options: [{ id: 'a', label: 'Accept the 2 that passed every check' }, { id: 'c', label: 'Reject all' }],
      payload: { type: 'ingest:review', docId: 'doc-3fa1c2d4e5f6', mcpAnswerable: false }
    })
  };
  return { rt, meta, q };
}

// F4's router and two fake nodes (web-01 runbook, gpu-box agent), with the
// case tools registered on both sides the way startup does it.
async function frontDoor(rt) {
  const web = createFakeNode({ name: 'web-01', profile: 'runbook' });
  const gpu = createFakeNode({ name: 'gpu-box', profile: 'agent' });
  const nodes = [web, gpu];
  const hub = createFakeHub(nodes);
  const scopeRegistry = createFleetScopeRegistry();
  const router = new FleetRouter({ registry: createFakeRegistry(nodes), nodeHub: hub, cache: new JobCache({ file: path.join(tmp('kl-fd-router-'), 'node-status.json') }), scopeRegistry });
  router.attach();
  registerFrontDoorCaseTools({ scopeRegistry, router });
  registerNodeCaseMethods(gpu.service, { getRuntime: () => rt, getContact: () => PRESENCE });
  for (const n of nodes) assert.deepStrictEqual(await hub.fromNode(n.nodeId, 'fleet.hello', n.hello()), { ok: true });
  await router.whenIdle();
  hub.calls.length = 0;
  const call = (name, args, scopes, g = READ) => router.callTool(name, args, { grant: g, scopes, session: 's-1' });
  return { web, gpu, hub, scopeRegistry, router, call };
}

describe('front-door case tools', () => {
  it('registers cases:read with its grant-screen text and its routed read tools; cases:write is not a front-door scope', () => {
    const scopeRegistry = createFleetScopeRegistry();
    const tools = [];
    registerFrontDoorCaseTools({ scopeRegistry, router: { registerTool: (def, opts) => tools.push([def, opts]) } });
    assert.deepStrictEqual({ ...scopeRegistry.get('cases:read') }, {
      name: 'cases:read', tools: READ_TOOLS, requires: null,
      description: 'Read case lists, briefs, questions and orientation, including private facts.'
    });
    assert.strictEqual(scopeRegistry.has('cases:write'), false, 'withheld pending the owner (T16-Q2)');
    assert.deepStrictEqual(READ_TOOLS.map((t) => scopeRegistry.requiredScopeFor(t)), READ_TOOLS.map(() => 'cases:read'));
    assert.strictEqual(scopeRegistry.requiredScopeFor('answer_question'), null, 'the MCP endpoint answers "Unknown tool"');
    assert.ok(!scopeRegistry.toolsFor(['cases:read', 'cases:write']).has('answer_question'));
    assert.deepStrictEqual(scopeRegistry.supported(['fleet:read']), ['fleet:read'], 'registered is not enabled: scopes_enabled decides');
    assert.deepStrictEqual(tools.map(([d, o]) => [d.name, o.scope]), READ_TOOLS.map((t) => [t, 'cases:read']));
    const [listDef, listOpts] = tools[0];
    assert.deepStrictEqual(listOpts.route({}), { fanout: true });
    assert.deepStrictEqual(listDef.inputSchema.required || [], []);
    const byName = Object.fromEntries(tools.map(([d, o]) => [d.name, [d, o]]));
    for (const name of ['open_case', 'get_orientation']) {
      const [def, opts] = byName[name];
      assert.deepStrictEqual(def.inputSchema.required, ['machine', 'case']);
      assert.strictEqual(def.inputSchema.additionalProperties, false);
      assert.deepStrictEqual(opts.route({ machine: 'web-01', case: 'lakeside-lot' }), { machine: 'web-01' });
    }
    // get_presence names the machine; list_questions fans out unless it names one.
    const [presenceDef, presenceOpts] = byName.get_presence;
    assert.deepStrictEqual(presenceDef.inputSchema.required, ['machine']);
    assert.deepStrictEqual(presenceOpts.route({ machine: 'gpu-box' }), { machine: 'gpu-box' });
    const [questionsDef, questionsOpts] = byName.list_questions;
    assert.deepStrictEqual(questionsDef.inputSchema.required, []);
    assert.deepStrictEqual(Object.keys(questionsDef.inputSchema.properties), ['machine', 'case']);
    assert.deepStrictEqual(questionsOpts.route({}), { fanout: true });
    assert.deepStrictEqual(questionsOpts.route({ machine: 'gpu-box', case: 'lakeside-lot' }), { machine: 'gpu-box' });
    assert.throws(() => questionsOpts.route({ case: 'lakeside-lot' }), /with a machine/);
    assert.deepStrictEqual({ ...CASE_TOOL_SCOPE }, Object.fromEntries(READ_TOOLS.map((t) => [t, 'cases:read'])));
    assert.ok(Object.isFrozen(CASE_SCOPES) && Object.isFrozen(CASE_TOOL_SCOPE));
  });

  it('is one of the front door\'s tool extensions, and its module loads nothing (the front door runs no agent code)', () => {
    const extensions = require('../src/frontdoor/tool-extensions');
    assert.ok(extensions.includes(registerFrontDoorCaseTools));
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'cases', 'mcp-tool-definitions.js'), 'utf8');
    assert.doesNotMatch(source, /require\(/);
  });

  it('a front-door client lists, opens and reads the orientation through the router, on the mcp-frontdoor channel', async () => {
    const { rt, meta, q } = await caseFixture();
    const t = await frontDoor(rt);
    const listed = await t.call('list_cases', {}, ['cases:read']);
    assert.deepStrictEqual(listed.rows.map((r) => [r.id, r.machine]), [[meta.id, 'gpu-box']]);
    // Titles are model-authorable (ruling T12-titles): wrapped.
    assert.strictEqual(listed.rows[0].data.untrusted_output, true);
    assert.strictEqual(listed.rows[0].data.data.title, 'Lakeside lot');
    assert.strictEqual(listed.rows[0].title, undefined);
    assert.deepStrictEqual(listed.unreachable, [], 'the runbook node is never asked');
    const open = await t.call('open_case', { machine: 'gpu-box', case: meta.id }, ['cases:read']);
    assert.strictEqual(open.data.untrusted_output, true);
    assert.strictEqual(open.data.data.title, 'Lakeside lot');
    // mcp-frontdoor: failure reports and status-changing questions are not
    // answerable here, and no MCP channel reviews a document.
    const byId = Object.fromEntries(open.data.data.questions.map((x) => [x.id, x.answerableHere]));
    assert.deepStrictEqual([byId[q.plain.id], byId[q.failure.id], byId[q.direction.id], byId[q.review.id]], [true, false, false, false]);
    const orientation = await t.call('get_orientation', { machine: 'gpu-box', case: meta.id }, ['cases:read']);
    assert.strictEqual(orientation.untrusted_output, true);
    assert.strictEqual(typeof orientation.data.text, 'string');
    assert.deepStrictEqual(t.hub.calls.map((c) => c.method), ['cases.list_cases', 'cases.open_case', 'cases.get_orientation']);
  });

  it('a cases:read grant lists the questions across machines or on one, and reads the presence of a machine', async () => {
    const { rt, meta, q } = await caseFixture();
    const t = await frontDoor(rt);
    const all = await t.call('list_questions', {}, ['cases:read']);
    assert.deepStrictEqual(all.unreachable, [], 'the runbook node is never asked');
    assert.deepStrictEqual(all.rows.map((r) => [r.questionId, r.machine, r.answer]), [
      [q.plain.id, 'gpu-box', 'spoken'], [q.failure.id, 'gpu-box', 'pressed'], [q.direction.id, 'gpu-box', 'pressed'], [q.review.id, 'gpu-box', 'pressed']
    ]);
    assert.strictEqual(all.rows[0].data.untrusted_output, true);
    assert.strictEqual(all.rows[0].data.data.caseTitle, 'Lakeside lot');
    const one = await t.call('list_questions', { machine: 'gpu-box', case: meta.id }, ['cases:read']);
    assert.deepStrictEqual(one.map((r) => r.questionId), all.rows.map((r) => r.questionId));
    const presence = await t.call('get_presence', { machine: 'gpu-box' }, ['cases:read']);
    assert.deepStrictEqual(presence, { presentChannel: null, away: false, quiet: false, timeZoneSource: 'host', signals: { desktop: null, mobile: null, channels: {} }, ladderRunsHere: true });
    assert.strictEqual((await t.call('list_questions', { case: meta.id }, ['cases:read'])).error.code, 'invalid_params');
    assert.strictEqual((await t.call('get_presence', { machine: 'gpu-box' }, ['fleet:read'])).error.code, 'insufficient_scope');
    assert.deepStrictEqual(t.hub.calls.map((c) => c.method), ['cases.list_questions', 'cases.list_questions', 'cases.get_presence']);
  });

  it('answer_question is not on the front door: a client holding cases:write reaches nothing, and the node has no such method', async () => {
    const { rt, meta, q } = await caseFixture();
    const t = await frontDoor(rt);
    const args = { machine: 'gpu-box', case: meta.id, question_id: q.plain.id, text: 'The lake view' };
    assert.ok(!t.router.toolDefinitions().some((d) => d.name === 'answer_question'));
    const atRouter = await t.call('answer_question', args, ['cases:read', 'cases:write'], BOTH);
    assert.deepStrictEqual(atRouter.error, { code: 'invalid_params', message: 'invalid_params: no such tool' });
    assert.deepStrictEqual(t.hub.calls, [], 'nothing reached the node');
    const atNode = await t.gpu.service.dispatch('cases.answer_question', { origin: fdOrigin(['cases:read', 'cases:write']), ...args });
    assert.strictEqual(atNode.error.code, 'unknown_method');
    assert.ok(!t.gpu.service.extra.has('cases.answer_question'));
    assert.strictEqual(rt.questions(meta.id).get(q.plain.id).answer, null);
  });

  it('reading needs cases:read at the router and again on the node; a link call without a front-door grant is refused', async () => {
    const { rt, meta } = await caseFixture();
    const t = await frontDoor(rt);
    const atRouter = await t.call('open_case', { machine: 'gpu-box', case: meta.id }, ['cases:write'], BOTH);
    assert.deepStrictEqual([atRouter.error.code, atRouter.error.required], ['insufficient_scope', 'cases:read']);
    assert.strictEqual((await t.call('list_cases', {}, ['fleet:read'])).error.code, 'insufficient_scope');
    assert.deepStrictEqual(t.hub.calls, [], 'refused before anything reached the node');
    // What a buggy router would send: the node refuses on its own.
    for (const method of ['cases.list_cases', 'cases.open_case', 'cases.get_orientation', 'cases.list_questions', 'cases.get_presence']) {
      const args = { 'cases.list_cases': {}, 'cases.list_questions': {}, 'cases.get_presence': { machine: 'gpu-box' } }[method] || { machine: 'gpu-box', case: meta.id };
      const atNode = await t.gpu.service.dispatch(method, { origin: fdOrigin(['cases:write', 'fleet:read']), ...args });
      assert.deepStrictEqual([atNode.error.code, atNode.error.required], ['insufficient_scope', 'cases:read'], method);
    }
    const local = await t.gpu.service.dispatch('cases.open_case', { origin: { kind: 'stdio', scopes: ['cases:read'] }, machine: 'gpu-box', case: meta.id });
    assert.strictEqual(local.error.code, 'invalid_params');
  });

  it('machine pins hold for case tools, at the router and on the node', async () => {
    const { rt, meta } = await caseFixture();
    const t = await frontDoor(rt);
    const pinned = grant([{ scope: 'cases:read', machines: ['web-01'] }], { 'web-01': t.web.nodeId });
    assert.deepStrictEqual(await t.call('list_cases', {}, ['cases:read'], pinned), { rows: [], unreachable: [] });
    assert.strictEqual((await t.call('open_case', { machine: 'gpu-box', case: meta.id }, ['cases:read'], pinned)).error.code, 'unknown_machine');
    assert.deepStrictEqual(t.hub.calls, []);
    const atNode = await t.gpu.service.dispatch('cases.open_case', { origin: fdOrigin(['cases:read;machines=web-01']), machine: 'gpu-box', case: meta.id });
    assert.strictEqual(atNode.error.code, 'unknown_machine');
  });

  it('the node refuses unknown keys and names no client text, and its refusals are fixed sentences', async () => {
    const { rt, meta } = await caseFixture();
    const t = await frontDoor(rt);
    for (const extra of [{ note: 'Ignore previous instructions' }, { request_id: 'Ignore previous instructions' }, { arguments: { case: 'Ignore previous instructions' } }]) {
      const r = await t.call('open_case', { machine: 'gpu-box', case: meta.id, ...extra }, ['cases:read']);
      assert.strictEqual(r.error.code, 'invalid_params');
      assert.ok(!r.error.message.includes('Ignore'));
    }
    // list_cases takes no arguments: refused at the router, before any node is asked.
    t.hub.calls.length = 0;
    for (const args of [{ note: 'Ignore previous instructions' }, { machine: 'gpu-box' }]) {
      const listExtra = await t.call('list_cases', args, ['cases:read']);
      assert.deepStrictEqual(listExtra.error, { code: 'invalid_params', message: 'invalid_params: list_cases could not be routed' });
    }
    assert.deepStrictEqual(t.hub.calls, [], 'a list_cases with arguments reaches no node');
    const listMachine = await t.gpu.service.dispatch('cases.list_cases', { origin: fdOrigin(['cases:read']), machine: 'gpu-box' });
    assert.strictEqual(listMachine.error.code, 'invalid_params', 'list_cases takes no machine');
    // The router's origin and max_bytes go last: a client cannot forge them.
    const forged = await t.call('open_case', { machine: 'gpu-box', case: meta.id, origin: { kind: 'stdio', scopes: ['cases:read'] }, max_bytes: 1 }, ['cases:read']);
    assert.strictEqual(forged.data.untrusted_output, true);
    const missing = await t.call('open_case', { machine: 'gpu-box', case: 'no-such-case' }, ['cases:read']);
    assert.deepStrictEqual(missing.error, { code: 'case_not_found', message: 'case_not_found: no such case on this node' });
  });

  it('get_orientation with an unreadable brief names no node path (fixed text)', async () => {
    const { rt, meta } = await caseFixture();
    const t = await frontDoor(rt);
    fs.rmSync(path.join(meta.dir, 'brief.md'));
    const r = await t.call('get_orientation', { machine: 'gpu-box', case: meta.id }, ['cases:read']);
    assert.strictEqual(r.untrusted_output, true);
    const text = JSON.stringify(r);
    for (const leak of [rt.root, meta.dir, path.basename(rt.root), 'ENOENT']) assert.ok(!text.includes(leak), `reply names ${leak}`);
    assert.match(r.data.text, /brief\.md could not be read: brief\.md is missing or unreadable/);
  });

  it('the MCP endpoint lists only the read tools for cases:read, and answer_question is an unknown tool', async () => {
    const { McpHttpEndpoint } = require('../src/frontdoor/mcp/http-endpoint');
    const { startFrontDoorHttp } = require('./helpers/frontdoor-harness');
    const { request } = require('./helpers/oauth-test-client');
    const { MCP_TOOLS } = require('../src/fleet/tool-definitions');
    const extra = [];
    const calls = [];
    const router = {
      registerTool: (def) => extra.push(def),
      toolDefinitions: () => [...MCP_TOOLS, ...extra],
      isTerminal: () => true,
      callTool: async (name) => { calls.push(name); return { rows: [], unreachable: [] }; },
      watchJob: () => () => {}
    };
    const h = await startFrontDoorHttp({
      scopesEnabled: ['fleet:read', 'cases:read'],
      mcp: ({ tokens, grants, scopeRegistry }) => {
        registerFrontDoorCaseTools({ scopeRegistry, router });
        return new McpHttpEndpoint({ mcpHost: 'mcp.kl.example.com', resourceUrl: 'https://mcp.kl.example.com/mcp', tokens, grants, scopeRegistry, router });
      }
    });
    try {
      const token = (await h.connect({ scopes: [{ scope: 'cases:read', machines: null }], scope: 'cases:read' })).tokens.access_token;
      assert.ok(token, 'a cases:read grant was issued');
      const rpc = (message, session = null) => request(h.base, {
        method: 'POST', path: '/mcp', json: message,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...(session ? { 'mcp-session-id': session } : {}) }
      });
      const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
      const session = init.headers['mcp-session-id'];
      const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
      assert.deepStrictEqual(list.json.result.tools.map((x) => x.name).sort(), [...READ_TOOLS].sort());
      const answer = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'answer_question', arguments: { machine: 'gpu-box', case: 'lakeside-lot', question_id: 'q-0001', text: 'x' } } }, session);
      assert.deepStrictEqual(answer.json.error, { code: -32602, message: 'Unknown tool' });
      const listed = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_cases', arguments: {} } }, session);
      assert.deepStrictEqual(JSON.parse(listed.json.result.content[0].text), { rows: [], unreachable: [] });
      assert.deepStrictEqual(calls, ['list_cases'], 'answer_question never reached the router');
    } finally {
      await h.stop();
    }
  });

  it('a reply over max_bytes is refused as too_large, never cut (ruling T16-Q1)', async () => {
    const stub = { getCase: () => ({ id: 'c-1', slug: 'lakeside-lot' }), orientation: () => 'x'.repeat(600 * 1024) };
    const t = await frontDoor(stub);
    const r = await t.call('get_orientation', { machine: 'gpu-box', case: 'lakeside-lot' }, ['cases:read']);
    assert.strictEqual(r.error.code, 'too_large');
    assert.ok(!JSON.stringify(r).includes('xxxx'));
  });

  it('startFleetNode registers the read methods under cases:read on an agent node with a front-door link', async () => {
    const { startFleetNode } = require('../src/fleet/start');
    const { CourierPump } = require('../src/approvals/courier');
    const { rt } = await caseFixture();
    const dataDir = tmp('kl-fd-node-');
    const configDir = tmp('kl-fd-node-config-');
    fs.mkdirSync(path.join(configDir, 'runbooks'));
    const registered = [];
    const relay = { registerMethod: (name) => registered.push(name), on: () => {}, off: () => {}, call: async () => ({}), notify: () => {} };
    const identity = { publicKey: Buffer.alloc(32), nodeId: 'node-test' };
    const core = {
      context: {
        getAgentExecutorAdapter: () => ({ execute: async () => ({}) }),
        getAgent: () => ({ id: 'main' }),
        listAgents: () => [{ id: 'main' }],
        getCaseRuntime: () => rt
      }
    };
    const fleet = await startFleetNode({
      dataDir, core, adminUid: typeof process.geteuid === 'function' ? process.geteuid() : 0, deps: { readGuiStatus: null },
      nodeConfig: {
        name: 'gpu-box', profile: 'agent', capabilities: [], runbooksDir: path.join(configDir, 'runbooks'),
        policy: { allowed_roots: [], max_concurrent_jobs: 2 },
        delegate: { provider: null, model: null, agent: 'main', idleCloseMs: 7200000, cwd: null, maxSessions: 4 }
      },
      approvals: { courierPump: new CourierPump({ dataDir, relayClient: null, identity }), identity, relayClient: relay, phoneApprover: null, auditLedger: null }
    });
    try {
      assert.deepStrictEqual([...fleet.fleetService.extra].map(([name, v]) => [name, v.scope]), READ_TOOLS.map((t) => [`cases.${t}`, 'cases:read']));
      assert.ok(registered.includes('cases.get_orientation'), 'the link methods are on the relay client');
      assert.ok(!registered.includes('cases.answer_question'));
    } finally {
      await fleet.stop();
    }
  });

  it('a runbook node with a front-door link registers no case methods', async () => {
    const { startFleetNode } = require('../src/fleet/start');
    const { CourierPump } = require('../src/approvals/courier');
    const dataDir = tmp('kl-fd-rb-');
    const configDir = tmp('kl-fd-rb-config-');
    fs.mkdirSync(path.join(configDir, 'runbooks'));
    const relay = { registerMethod: () => {}, on: () => {}, off: () => {}, call: async () => ({}), notify: () => {} };
    const identity = { publicKey: Buffer.alloc(32), nodeId: 'node-test' };
    const fleet = await startFleetNode({
      dataDir, core: null, adminUid: typeof process.geteuid === 'function' ? process.geteuid() : 0, deps: { readGuiStatus: null },
      nodeConfig: { name: 'web-01', profile: 'runbook', capabilities: [], runbooksDir: path.join(configDir, 'runbooks'), policy: { allowed_roots: [], max_concurrent_jobs: 2 } },
      approvals: { courierPump: new CourierPump({ dataDir, relayClient: null, identity }), identity, relayClient: relay, phoneApprover: null, auditLedger: null }
    });
    try {
      assert.strictEqual(fleet.fleetService.extra.size, 0);
    } finally {
      await fleet.stop();
    }
  });
});
