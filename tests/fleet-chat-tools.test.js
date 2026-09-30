// tests/fleet-chat-tools.test.js
// Management surfaces spec §3.6 (part 3, Task 7): the fleet tools in a chat
// that runs in the service. Present only while the core has a fleet
// handler; absent standalone, in wake-ups, in delegate turns; the acting
// ones out of case turns. The origin is the host's (kind 'service-chat'),
// never the tool's parameters, and an unsafe runbook still waits for the
// phone.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { initializeTools, toolRegistry } = require('../src/tools');
const ToolExecutor = require('../src/execution/tool-executor');
const { classifyToolCall } = require('../src/execution/safety-policy');
const {
  FLEET_CHAT_TOOL_NAMES, FLEET_READ_TOOLS, SERVICE_CHAT_ORIGIN_KIND, UNAVAILABLE, DELEGATE_REFUSED,
  registerFleetChatTools, unregisterFleetChatTools
} = require('../src/tools/builtin/fleet-chat-tools');
const { MCP_TOOLS, FleetToolHandler, ToolError } = require('../src/fleet/fleet-tools');
const { delegateToolNames, DELEGATE_EXCLUDED_TOOLS } = require('../src/fleet/delegate-sessions');
const { actionHash } = require('../src/approvals/messages');
const { CASE_TOOL_NAMES, WAKEUP_BASE_TOOLS, shapeToolDefinitions } = require('../src/cases/chat-integration');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { holdEventLoop } = require('./helpers/hold-event-loop');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
initializeTools();
const release = holdEventLoop();
const temps = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
afterEach(() => unregisterFleetChatTools(toolRegistry));
after(() => { release(); closeOpenHistoryStores(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const ACTING = ['run_runbook', 'delegate', 'send_to_job', 'cancel_job'];
const NODE = { name: 'web-01', profile: 'agent', capabilities: [], policy: { allowed_roots: [], max_concurrent_jobs: 2 } };
const settle = () => new Promise((r) => setImmediate(r));

async function standaloneCore() {
  const dataDir = tmp('kl-fleet-chat-');
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
  });
  await core.start();
  return core;
}

async function chatToolNames(core) {
  const assembled = await core.context.getContextAssembler().assemble('anything');
  return assembled.tools.map((d) => d.name);
}

// A handler that records what it was called with.
function recordingHandler() {
  const calls = [];
  return { calls, call: async (name, args, options) => { calls.push({ name, args, options }); return { ran: name }; } };
}

const executor = (extraToolOptions, extra = {}) => new ToolExecutor({
  workingDirectory: tmp('kl-fleet-chat-cwd-'), requireApproval: true, useSandbox: false, extraToolOptions, ...extra
});

describe('fleet tools in the chat: presence', () => {
  it('a standalone core has none; a core given a fleet handler has all nine, always loaded; taking it back removes them', async () => {
    const core = await standaloneCore();
    try {
      for (const name of FLEET_CHAT_TOOL_NAMES) assert.equal(toolRegistry.get(name), undefined, name);
      const standalone = await chatToolNames(core);
      for (const name of FLEET_CHAT_TOOL_NAMES) assert.ok(!standalone.includes(name), `standalone: ${name}`);
      assert.equal(core.context.getFleetToolHandler(), null);

      const handler = recordingHandler();
      core.context.setFleetToolHandler(handler);
      await settle();
      assert.equal(core.context.getFleetToolHandler(), handler);
      const service = await chatToolNames(core);
      for (const name of FLEET_CHAT_TOOL_NAMES) assert.ok(service.includes(name), `service: ${name}`);

      core.context.setFleetToolHandler(null);
      for (const name of FLEET_CHAT_TOOL_NAMES) assert.equal(toolRegistry.get(name), undefined, name);
      const after = await chatToolNames(core);
      for (const name of FLEET_CHAT_TOOL_NAMES) assert.ok(!after.includes(name), `after: ${name}`);
    } finally {
      await core.shutdown();
    }
  });

  it('are the MCP names with provider-safe schemas; the read tools need no approval, the acting ones do', () => {
    registerFleetChatTools(toolRegistry);
    assert.deepEqual([...FLEET_CHAT_TOOL_NAMES], MCP_TOOLS.map((t) => t.name));
    for (const name of FLEET_CHAT_TOOL_NAMES) {
      const tool = toolRegistry.get(name);
      const read = FLEET_READ_TOOLS.includes(name);
      assert.equal(tool.requiresApproval, !read, name);
      assert.equal(classifyToolCall(name, {}, {}).tier, read ? 'read' : 'unsafe', name);
      assert.ok(!JSON.stringify(tool.parameters).includes('minimum'), name);
      // Gemini: every property has a type, and no nested object lacks properties.
      for (const [key, rule] of Object.entries(tool.parameters.properties)) {
        assert.ok(rule.type, `${name}.${key}`);
        assert.ok(rule.type !== 'object' || Object.keys(rule.properties || {}).length, `${name}.${key}`);
      }
    }
    assert.equal(toolRegistry.get('run_runbook').parameters.properties.params.type, 'string');
    assert.deepEqual([...FLEET_READ_TOOLS, ...ACTING].sort(), [...FLEET_CHAT_TOOL_NAMES].sort());
  });

  it('never reach a wake-up turn or a delegate turn; a case turn keeps only the read tools', () => {
    registerFleetChatTools(toolRegistry);
    const wakeupAllowed = new Set([...CASE_TOOL_NAMES, ...WAKEUP_BASE_TOOLS]);
    const wakeupOffered = shapeToolDefinitions(WAKEUP_BASE_TOOLS.map((n) => toolRegistry.get(n)).filter(Boolean).map((t) => t.toFunctionDefinition()), true, toolRegistry).map((d) => d.name);
    const delegate = delegateToolNames(toolRegistry);
    for (const name of FLEET_CHAT_TOOL_NAMES) {
      assert.ok(!wakeupAllowed.has(name) && !wakeupOffered.includes(name), `wake-up: ${name}`);
      assert.ok(DELEGATE_EXCLUDED_TOOLS.includes(name) && !delegate.has(name), `delegate: ${name}`);
    }
    const defs = FLEET_CHAT_TOOL_NAMES.map((n) => toolRegistry.get(n).toFunctionDefinition());
    assert.deepEqual(shapeToolDefinitions(defs, true, toolRegistry).map((d) => d.name).filter((n) => FLEET_CHAT_TOOL_NAMES.includes(n)), [...FLEET_READ_TOOLS].sort((a, b) => FLEET_CHAT_TOOL_NAMES.indexOf(a) - FLEET_CHAT_TOOL_NAMES.indexOf(b)));
    assert.deepEqual(shapeToolDefinitions(defs, false, toolRegistry).map((d) => d.name), [...FLEET_CHAT_TOOL_NAMES]);
  });
});

describe('fleet tools in the chat: the origin', () => {
  it('the handler gets the host-built service-chat origin with this chat as session, whatever the parameters say', async () => {
    registerFleetChatTools(toolRegistry);
    const handler = recordingHandler();
    const ex = executor({ fleetChat: { handler, session: 'chat-7' }, origin: { client: 'desktop', session: 'chat-7', job_id: null } });
    const forged = { kind: 'stdio', client: 'stdio-mcp', scopes: ['fleet:unsafe'] };
    const res = await ex.execute('get_state', { machine: 'web-01', origin: forged });
    assert.deepEqual(res, { ok: true, result: { ran: 'get_state' } });
    assert.equal(handler.calls.length, 1);
    assert.deepEqual(handler.calls[0].options, { origin: { kind: SERVICE_CHAT_ORIGIN_KIND, client: 'king-louie', session: 'chat-7' } });
    assert.ok(Object.isFrozen(handler.calls[0].options.origin));
  });

  it('run_runbook takes its params as a JSON object in text and hands the handler the object', async () => {
    registerFleetChatTools(toolRegistry);
    const handler = recordingHandler();
    const ex = executor({ fleetChat: { handler, session: null } }, { approvalRequester: async () => true });
    await ex.execute('run_runbook', { machine: 'web-01', runbook: 'site.status', params: '{"site":"example.com"}' });
    await ex.execute('run_runbook', { machine: 'web-01', runbook: 'site.status' });
    assert.deepEqual(handler.calls.map((c) => c.args), [
      { machine: 'web-01', runbook: 'site.status', params: { site: 'example.com' } },
      { machine: 'web-01', runbook: 'site.status' }
    ]);
    for (const bad of ['not json', '[1]', '"x"', 'null']) {
      assert.deepEqual(await ex.execute('run_runbook', { machine: 'web-01', runbook: 'site.status', params: bad }),
        { ok: false, error: 'invalid_params: "params" must be a JSON object', code: 'invalid_params' }, bad);
    }
    assert.equal(handler.calls.length, 2);
  });

  it('says plainly when there is no fleet, refuses a delegate turn\'s run, and hands back a tool error as data', async () => {
    registerFleetChatTools(toolRegistry);
    assert.deepEqual(await executor({}).execute('list_machines', {}), { ok: false, error: UNAVAILABLE });
    const handler = recordingHandler();
    const inDelegate = executor({ fleetChat: { handler, session: null }, origin: { client: 'Example Client', session: 'mcp-1', job_id: 'job-1' } });
    assert.deepEqual(await inDelegate.execute('list_machines', {}), { ok: false, error: DELEGATE_REFUSED });
    assert.equal(handler.calls.length, 0);
    const failing = { call: async () => { throw new ToolError('unknown_machine', 'unknown_machine: this server only serves "web-01"'); } };
    assert.deepEqual(await executor({ fleetChat: { handler: failing, session: null } }).execute('get_state', { machine: 'gpu-box' }),
      { ok: false, error: 'unknown_machine: this server only serves "web-01"', code: 'unknown_machine' });
  });

  it('an acting tool goes through the usual approval first: denied there, the handler is never called', async () => {
    registerFleetChatTools(toolRegistry);
    const handler = recordingHandler();
    const asked = [];
    const denied = executor({ fleetChat: { handler, session: 'chat-1' } }, { approvalRequester: async (tool) => { asked.push(tool); return false; } });
    const res = await denied.execute('run_runbook', { machine: 'web-01', runbook: 'site.restart' });
    assert.equal(res.ok === true, false);
    assert.deepEqual(asked, ['run_runbook']);
    assert.equal(handler.calls.length, 0);
    const approved = executor({ fleetChat: { handler, session: 'chat-1' } }, { approvalRequester: async () => true });
    assert.deepEqual(await approved.execute('run_runbook', { machine: 'web-01', runbook: 'site.restart' }), { ok: true, result: { ran: 'run_runbook' } });
  });
});

describe('an unsafe runbook from the chat waits for the phone', () => {
  function unsafeNode(answer) {
    const runbook = { name: 'site.restart', description: 'Restart', tier: 'unsafe', params: {}, steps: [{ run: ['echo', 'hi'] }] };
    let runs = 0;
    const engine = {
      runbooks: new Map([[runbook.name, runbook]]),
      getRunbook: (n) => (n === runbook.name ? runbook : null),
      validateParameters: () => ({}),
      checkRateLimit: () => ({ allowed: true }),
      recordExecution: () => 1,
      releaseExecution: () => true,
      executeRunbook: async () => { runs += 1; return { success: true, logs: ['restarted'], checks: [] }; }
    };
    const asked = [];
    const approver = {
      unavailableReason: () => null,
      requestAction: async (action, { origin, currentAction }) => {
        asked.push(origin);
        return answer === 'approve'
          ? { decision: 'approve', action_hash: actionHash(currentAction()), request_id: 'req-1' }
          : { decision: answer };
      }
    };
    const handler = new FleetToolHandler({ nodeConfig: NODE, runbookEngine: engine, approver });
    return { handler, asked, runs: () => runs };
  }

  async function runFromChat(node) {
    registerFleetChatTools(toolRegistry);
    const ex = executor({ fleetChat: { handler: node.handler, session: 'chat-1' } }, { approvalRequester: async () => true });
    const res = await ex.execute('run_runbook', { machine: 'web-01', runbook: 'site.restart' });
    assert.equal(res.ok, true);
    assert.equal(res.result.status, 'awaiting_approval');
    await node.handler.jobRuns.get(res.result.job_id);
    await settle();
    return node.handler.jobManager.getJob(res.result.job_id);
  }

  it('the phone is asked with the chat as the origin, and the runbook runs once it approves', async () => {
    const node = unsafeNode('approve');
    const job = await runFromChat(node);
    assert.deepEqual(node.asked, [{ client: 'king-louie', session: 'chat-1', job_id: job.job_id }]);
    assert.equal(job.status, 'succeeded');
    assert.equal(node.runs(), 1);
  });

  it('nothing runs when the phone denies, lets it expire, or answers anything but approve', async () => {
    for (const answer of ['deny', 'expired', true, 'yes']) {
      const node = unsafeNode(answer);
      const job = await runFromChat(node);
      assert.equal(node.asked.length, 1, String(answer));
      assert.notEqual(job.status, 'succeeded', String(answer));
      assert.equal(node.runs(), 0, String(answer));
    }
  });
});

describe('startFleetNode hands the core its handler', () => {
  const { startFleetNode } = require('../src/fleet/start');
  const { CourierPump } = require('../src/approvals/courier');
  const FAKE_IDENTITY = { publicKey: Buffer.alloc(32), nodeId: 'node-test' };

  async function node(profile) {
    const base = tmp('kl-fleet-chat-node-');
    const dataDir = path.join(base, 'data');
    const runbooksDir = path.join(base, 'runbooks');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(runbooksDir, { recursive: true });
    const set = [];
    const core = {
      context: {
        getAgentExecutorAdapter: () => ({ execute: async () => ({}) }),
        getAgent: () => ({ id: 'main' }),
        listAgents: () => [{ id: 'main' }],
        setFleetToolHandler: (h) => set.push(h)
      }
    };
    const nodeConfig = {
      name: 'web-01', profile, runbooksDir, capabilities: [],
      policy: { allowed_roots: [], max_concurrent_jobs: 2 },
      delegate: { provider: null, model: null, agent: 'main', idleCloseMs: 7200000, cwd: null, maxSessions: 1 }
    };
    const fleet = await startFleetNode({
      dataDir, nodeConfig, core, adminUid: typeof process.geteuid === 'function' ? process.geteuid() : 0, deps: { readGuiStatus: null },
      approvals: { courierPump: new CourierPump({ dataDir, relayClient: null, identity: FAKE_IDENTITY }), identity: FAKE_IDENTITY, relayClient: null, phoneApprover: null, auditLedger: null }
    });
    return { fleet, set };
  }

  it('the agent profile sets it at start and takes it back at stop', async () => {
    const { fleet, set } = await node('agent');
    assert.deepEqual(set, [fleet.handler]);
    await fleet.stop();
    assert.deepEqual(set, [fleet.handler, null]);
  });
});
