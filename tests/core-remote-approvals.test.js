// tests/core-remote-approvals.test.js
//
// Drives the gateway "agent:message" path end to end (gateway event →
// agentExecutorAdapter → createAgentRuntime → ToolExecutor) with a fake
// provider that asks for one approval-requiring tool, and checks whether the
// remote approvalHandler that a chat channel would attach is honoured.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const { addSink } = require('../src/logging');

const FAKE_PROVIDER = 'kl-test-approval-fake';
const PROBE_TOOL = 'KlTestApprovalProbe';
// The built-in code-writer agent carries autoApproveTools: ['Bash', ...], so
// Bash is the tool that exercises the agent-config grant path.
const AGENT_AUTO_APPROVED_TOOL = 'Bash';

let probeRuns = 0;
// Which tool the fake provider asks for; the Bash cases swap it.
let requestedTool = PROBE_TOOL;

class FakeProvider {
  constructor() { this.calls = 0; }
  async sendMessageWithTools() {
    this.calls += 1;
    if (this.calls === 1) {
      const parameters = requestedTool === PROBE_TOOL ? {} : { command: 'echo hi' };
      return { type: 'tool_use', toolName: requestedTool, toolUseId: 'call_1', parameters };
    }
    return { type: 'text', content: 'finished' };
  }
  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }
}

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

before(() => {
  ProviderFactory.registerProvider(FAKE_PROVIDER, FakeProvider);
});
after(() => {
  ProviderFactory._registry.delete(FAKE_PROVIDER);
});

function buildCore(remoteApprovals, extraDeps = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-approvals-'));
  tempDirs.push(dataDir);
  const deps = {
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
  };
  if (remoteApprovals !== undefined) deps.remoteApprovals = remoteApprovals;
  Object.assign(deps, extraDeps);
  return createCore(deps);
}

async function driveGatewayMessage(core, agentId = 'main') {
  const tiers = { provider: FAKE_PROVIDER, model: 'fake' };
  const settings = core.getSettings();
  core.context.setSettings({
    ...settings,
    activeProvider: FAKE_PROVIDER,
    inference: { ...settings.inference, llmRouting: { enabled: false }, tierMap: { fast: tiers, standard: tiers, smart: tiers } }
  });
  core.saveProviderToken(FAKE_PROVIDER, 'fake-token-123456');
  await core.start();
  if (!toolRegistry.get(PROBE_TOOL)) {
    toolRegistry.register(new Tool({
      name: PROBE_TOOL,
      description: 'Test-only tool that requires approval.',
      parameters: { type: 'object', properties: {} },
      requiresApproval: true,
      execute: async () => { probeRuns += 1; return { ok: true }; }
    }));
  }
  const gateway = core.context.getGatewayServer();
  const session = core.context.getSessionManager().getOrCreateSession('test-session', 'main', { channel: 'test', peer: 'p', label: 'test' });
  const handlerCalls = [];
  const response = new Promise((resolve) => gateway.once('agent:response', resolve));
  gateway.emit('agent:message', {
    agentId,
    sessionKey: session.key,
    message: {
      runId: 'run-1',
      message: 'please run the probe',
      approvalHandler: async (req) => { handlerCalls.push(req.toolName); return true; }
    }
  });
  const res = await response;
  await core.shutdown();
  return { res, handlerCalls };
}

describe('createCore remoteApprovals', () => {
  it("'deny' ignores a remote approvalHandler, so an approval-requiring tool is denied", async () => {
    const before = probeRuns;
    const { res, handlerCalls } = await driveGatewayMessage(buildCore('deny'));
    assert.strictEqual(res.error, undefined, `agent run failed: ${res.error}`);
    assert.deepStrictEqual(handlerCalls, [], 'the remote approvalHandler must never be consulted');
    assert.strictEqual(probeRuns, before, 'the approval-requiring tool must not run');
  });

  it("'allow' (the default) honours the remote approvalHandler, as the Electron app always has", async () => {
    const before = probeRuns;
    const { res, handlerCalls } = await driveGatewayMessage(buildCore(undefined));
    assert.strictEqual(res.error, undefined, `agent run failed: ${res.error}`);
    assert.deepStrictEqual(handlerCalls, [PROBE_TOOL]);
    assert.strictEqual(probeRuns, before + 1);
  });

  it('rejects an unknown remoteApprovals value', () => {
    assert.throws(() => buildCore('sometimes'), /remoteApprovals/);
  });
});

// A remote origin that picks the built-in code-writer agent used to get Bash
// for free: the agent's autoApproveTools granted approval before the gate the
// null approval requester guards. Bash is stubbed for this file so the test
// never runs a real shell command.
describe('createCore remoteApprovals vs an agent with autoApproveTools', () => {
  let realBash;
  let bashRuns = 0;

  before(() => {
    realBash = toolRegistry.get(AGENT_AUTO_APPROVED_TOOL);
    toolRegistry.register(new Tool({
      name: AGENT_AUTO_APPROVED_TOOL,
      description: 'Test-only stand-in for the real shell tool.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      requiresApproval: true,
      execute: async () => { bashRuns += 1; return { ok: true }; }
    }));
    requestedTool = AGENT_AUTO_APPROVED_TOOL;
  });
  after(() => {
    requestedTool = PROBE_TOOL;
    if (realBash) toolRegistry.register(realBash);
  });

  it("'deny' denies a tool the code-writer agent's autoApproveTools would have granted", async () => {
    const before = bashRuns;
    const { res, handlerCalls } = await driveGatewayMessage(buildCore('deny'), 'code-writer');
    assert.strictEqual(res.error, undefined, `agent run failed: ${res.error}`);
    assert.deepStrictEqual(handlerCalls, [], 'the remote approvalHandler must never be consulted');
    assert.strictEqual(bashRuns, before, 'autoApproveTools must not bypass remoteApprovals: deny');
  });

  it("'allow' still lets the agent's autoApproveTools grant approval, as before", async () => {
    const before = bashRuns;
    const { res } = await driveGatewayMessage(buildCore('allow'), 'code-writer');
    assert.strictEqual(res.error, undefined, `agent run failed: ${res.error}`);
    assert.strictEqual(bashRuns, before + 1);
  });
});

// ── Fleet stage 3: remoteApprovals 'phone' and the desktop seam (R49) ───────
const { markLocalDesktopEvent } = require('../src/core/origin');

const DENIED_TOOL = 'KlTestNodePolicyDenied';
const CAPTURE_TOOL = 'KlTestCaptureRequester';
let capturedRequester = null;
let capturedOptions = null;

function phoneDeps({ available = true, answer = true } = {}) {
  const calls = [];
  const audit = [];
  const phoneApprover = {
    ttlMs: 300000,
    isAvailable: () => available,
    requestApproval: async (toolName, parameters, metadata) => { calls.push({ toolName, origin: metadata.origin }); return answer; }
  };
  const auditLedger = { append: async (entry) => { audit.push(entry); return entry; } };
  const nodePolicy = { allowed_roots: [os.tmpdir()], remote_sessions: { always_confirm: [], deny: [`${DENIED_TOOL}*`] } };
  return { calls, audit, deps: { phoneApprover, auditLedger, nodePolicy } };
}

function desktopEvent() {
  const sent = [];
  const event = markLocalDesktopEvent({ sender: { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false } }, { deviceId: 'kld-testdesktop00001' });
  return { event, sent };
}

async function answerDialog(core, sent, approved) {
  for (let i = 0; i < 200 && !sent.some((s) => s.channel === 'tool:approvalRequired'); i += 1) await new Promise((r) => setTimeout(r, 5));
  const request = sent.find((s) => s.channel === 'tool:approvalRequired');
  assert.ok(request, 'the on-screen dialog was asked');
  core.context.pendingApprovalResolvers.get(request.payload.approvalId).resolve(approved);
}

// Wires FAKE_PROVIDER as every tier's provider, the same way
// driveGatewayMessage does, so a child run created off-gateway (via
// agentExecutorAdapter.execute directly) can still resolve a provider.
function configureFakeProvider(core) {
  const tiers = { provider: FAKE_PROVIDER, model: 'fake' };
  const settings = core.getSettings();
  core.context.setSettings({
    ...settings,
    activeProvider: FAKE_PROVIDER,
    inference: { ...settings.inference, llmRouting: { enabled: false }, tierMap: { fast: tiers, standard: tiers, smart: tiers } }
  });
  core.saveProviderToken(FAKE_PROVIDER, 'fake-token-123456');
}

async function startedPhoneCore(options) {
  const phone = phoneDeps(options);
  const core = buildCore('phone', phone.deps);
  await core.start();
  for (const [name, execute] of [
    [PROBE_TOOL, async () => { probeRuns += 1; return { ok: true }; }],
    [DENIED_TOOL, async () => ({ ok: true })],
    [CAPTURE_TOOL, async (_p, opts) => { capturedRequester = opts.approvalRequester; capturedOptions = opts; return { ok: true }; }]
  ]) {
    toolRegistry.register(new Tool({
      name, description: 'test', parameters: { type: 'object', properties: {} }, requiresApproval: name === PROBE_TOOL, execute
    }));
  }
  return { core, ...phone };
}

// Fleet stage 7 (a separate branch) already put the non-phone half of this
// seam directly into create-core.js. approvalSeam must give exactly the same
// 'allow'/'deny' results, so whichever branch merges second can reconcile
// create-core onto the other's formulas without a behaviour change.
describe('approvalSeam matches the fleet stage 7 formulas for allow/deny', () => {
  const { approvalSeam } = require('../src/approvals/executor-options');
  const { markLocalDesktopEvent, markLocalRequester } = require('../src/core/origin');

  it("gives the same 'allow'/'deny' local/denyAutoApproval results for a local event, a local requester, and neither", () => {
    const localEvent = markLocalDesktopEvent({ sender: {} }, { deviceId: 'kld-x' });
    const localRequester = markLocalRequester(() => {});
    const remoteRequester = () => {};

    for (const remoteApprovals of ['allow', 'deny']) {
      // A local (marked) event, with an unmarked remote requester handed in.
      let seam = approvalSeam({ remoteApprovals, event: localEvent, approvalRequester: remoteRequester });
      assert.equal(seam.local, true, `${remoteApprovals}/local-event: local`);
      assert.equal(seam.toolExecutorOptions.denyAutoApproval, false, `${remoteApprovals}/local-event: denyAutoApproval`);
      assert.equal(
        seam.toolExecutorOptions.approvalRequester,
        remoteApprovals === 'allow' ? remoteRequester : null,
        `${remoteApprovals}/local-event: approvalRequester`
      );

      // A marked (local) requester, no event.
      seam = approvalSeam({ remoteApprovals, event: null, approvalRequester: localRequester });
      assert.equal(seam.local, true, `${remoteApprovals}/local-requester: local`);
      assert.equal(seam.toolExecutorOptions.denyAutoApproval, false, `${remoteApprovals}/local-requester: denyAutoApproval`);
      assert.equal(seam.toolExecutorOptions.approvalRequester, localRequester, `${remoteApprovals}/local-requester: approvalRequester`);

      // Neither marked: a remote run.
      seam = approvalSeam({ remoteApprovals, event: null, approvalRequester: remoteRequester });
      assert.equal(seam.local, false, `${remoteApprovals}/remote: local`);
      assert.equal(seam.toolExecutorOptions.denyAutoApproval, remoteApprovals !== 'allow', `${remoteApprovals}/remote: denyAutoApproval`);
      assert.equal(
        seam.toolExecutorOptions.approvalRequester,
        remoteApprovals === 'allow' ? remoteRequester : null,
        `${remoteApprovals}/remote: approvalRequester`
      );
    }
  });
});

describe("createCore remoteApprovals: 'phone'", () => {
  it("needs deps.phoneApprover", () => {
    assert.throws(() => buildCore('phone'), /remoteApprovals 'phone' needs deps.phoneApprover/);
  });

  // Task 13 review carry-over: these checks used to run inside
  // phoneExecutorOptions (on every ToolExecutor build); they now run once, at
  // createCore construction, so a direct test on createCore itself is needed
  // — the surrounding gateway-driven tests only exercise what happens once
  // construction has already succeeded.
  it('the ttlMs check throws once, at construction, for a non-finite or non-positive ttlMs', () => {
    const approverWith = (ttlMs) => ({ ttlMs, isAvailable: () => true, requestApproval: async () => true });
    for (const bad of [NaN, 0, -1, Infinity, -Infinity]) {
      assert.throws(
        () => buildCore('phone', { phoneApprover: approverWith(bad) }),
        new RegExp(`phoneApprover\\.ttlMs must be a finite positive number, got ${bad}`),
        `ttlMs=${bad}`
      );
    }
  });

  it('warns once, at construction, when phone mode has no nodePolicy or no auditLedger — not once per ToolExecutor build', async () => {
    const warnings = [];
    const unsubscribe = addSink((record) => {
      if (record.subsystem === 'approvals/executor-options' && record.level === 'warn') warnings.push(record.message);
    });
    try {
      const phoneApprover = { ttlMs: 300000, isAvailable: () => true, requestApproval: async () => true };
      const core = buildCore('phone', { phoneApprover });
      assert.equal(warnings.length, 2, warnings.join('\n'));
      assert.match(warnings[0], /without deps\.nodePolicy: node-policy tiers are not enforced/);
      assert.match(warnings[1], /without deps\.auditLedger: tier\.decision\/exec\.start\/exec\.result are not audited/);

      // Building more than one ToolExecutor off the same core (two agent
      // runs) must not repeat the warnings — they belong to construction,
      // which is the bug this check's move away from phoneExecutorOptions
      // fixed.
      if (!toolRegistry.get(PROBE_TOOL)) {
        toolRegistry.register(new Tool({
          name: PROBE_TOOL,
          description: 'Test-only tool that requires approval.',
          parameters: { type: 'object', properties: {} },
          requiresApproval: true,
          execute: async () => ({ ok: true })
        }));
      }
      const tiers = { provider: FAKE_PROVIDER, model: 'fake' };
      const settings = core.getSettings();
      core.context.setSettings({
        ...settings,
        activeProvider: FAKE_PROVIDER,
        inference: { ...settings.inference, llmRouting: { enabled: false }, tierMap: { fast: tiers, standard: tiers, smart: tiers } }
      });
      core.saveProviderToken(FAKE_PROVIDER, 'fake-token-123456');
      await core.start();
      try {
        const gateway = core.context.getGatewayServer();
        const session = core.context.getSessionManager().getOrCreateSession('ttlms-once-session', 'main', { channel: 'test', peer: 'p', label: 'test' });
        for (const runId of ['run-a', 'run-b']) {
          const response = new Promise((resolve) => gateway.once('agent:response', resolve));
          gateway.emit('agent:message', { agentId: 'main', sessionKey: session.key, message: { runId, message: 'please run the probe' } });
          await response;
        }
      } finally {
        // A started core (gateway/webhook servers, timers) must not leak
        // into later tests even if an assertion above throws first.
        await core.shutdown();
      }
      assert.equal(warnings.length, 2, warnings.join('\n'));
    } finally {
      unsubscribe();
    }
  });

  it('getPhoneApprover is the approver only in phone mode and only while it is available', () => {
    const on = phoneDeps();
    assert.equal(buildCore('phone', on.deps).context.getPhoneApprover(), on.deps.phoneApprover);
    assert.equal(buildCore('phone', phoneDeps({ available: false }).deps).context.getPhoneApprover(), null);
    assert.equal(buildCore('allow', phoneDeps().deps).context.getPhoneApprover(), null);
    assert.equal(buildCore('deny', phoneDeps().deps).context.getPhoneApprover(), null);
  });

  it('a remote run asks the phone, never the remote approvalHandler', async () => {
    const phone = phoneDeps({ answer: true });
    const before = probeRuns;
    const { res, handlerCalls } = await driveGatewayMessage(buildCore('phone', phone.deps));
    assert.strictEqual(res.error, undefined, `agent run failed: ${res.error}`);
    assert.deepEqual(handlerCalls, []);
    assert.deepEqual(phone.calls.map((c) => c.toolName), [PROBE_TOOL]);
    assert.equal(probeRuns, before + 1);
  });

  it("'unavailable' from the phone runs nothing", async () => {
    const phone = phoneDeps({ answer: 'unavailable' });
    const before = probeRuns;
    await driveGatewayMessage(buildCore('phone', phone.deps));
    assert.equal(phone.calls.length, 1);
    assert.equal(probeRuns, before);
  });

  it("a phone refusal's error text reaches the tool result (metadata is mutated, not spread)", async () => {
    // The phone-mode requester wrapper must set `metadata.origin` on the same
    // object it was handed, not `{...metadata, origin}` — otherwise a
    // `metadata.refusal` the approver writes never reaches ToolExecutor's
    // mapApprovalResult and the caller only ever sees the generic default.
    const auditLedger = { append: async () => {} };
    const nodePolicy = { allowed_roots: [os.tmpdir()], remote_sessions: { always_confirm: [], deny: [] } };
    const phoneApprover = {
      ttlMs: 300000,
      isAvailable: () => true,
      requestApproval: async (_toolName, _parameters, metadata) => {
        metadata.refusal = { deniedBy: 'audit', error: 'Audit ledger unavailable; nothing ran.' };
        return 'unavailable';
      }
    };
    const core = buildCore('phone', { phoneApprover, auditLedger, nodePolicy });
    await core.start();
    if (!toolRegistry.get(PROBE_TOOL)) {
      toolRegistry.register(new Tool({
        name: PROBE_TOOL, description: 'test', parameters: { type: 'object', properties: {} }, requiresApproval: true,
        execute: async () => { probeRuns += 1; return { ok: true }; }
      }));
    }
    try {
      const executor = await core.context.createToolExecutorWithApprovals(null, null, null, {});
      assert.deepEqual(await executor.execute(PROBE_TOOL, {}), {
        success: false, error: 'Audit ledger unavailable; nothing ran.', deniedBy: 'audit'
      });
    } finally {
      await core.shutdown();
    }
  });

  it('denyAutoApproval for every mode, local and remote', async () => {
    const { core } = await startedPhoneCore();
    try {
      const remote = await core.context.createToolExecutorWithApprovals(null, null, null, {});
      const local = await core.context.createToolExecutorWithApprovals(desktopEvent().event, null, null, {});
      assert.equal(remote.denyAutoApproval, true);
      assert.equal(local.denyAutoApproval, false);
      assert.equal(remote.approvalTimeoutMs, 315000);
      assert.equal(typeof remote.classifyCall, 'function');
      assert.equal(typeof local.classifyCall, 'function');
    } finally {
      await core.shutdown();
    }
    for (const [mode, expected] of [['allow', false], ['deny', true]]) {
      const other = buildCore(mode);
      await other.start();
      try {
        assert.equal((await other.context.createToolExecutorWithApprovals(null, null, null, {})).denyAutoApproval, expected, mode);
      } finally {
        await other.shutdown();
      }
    }
  });

  it('R49: a marked desktop event never reaches the phone, is answered on screen, still honours denied, and audits origin desktop', async () => {
    const { core, calls, audit } = await startedPhoneCore();
    try {
      const { event, sent } = desktopEvent();
      const executor = await core.context.createToolExecutorWithApprovals(event, null, null, { chatId: 'chat-1' });
      const before = probeRuns;
      const running = executor.execute(PROBE_TOOL, {});
      await answerDialog(core, sent, true);
      assert.equal((await running).ok, true);
      assert.equal(probeRuns, before + 1);
      assert.deepEqual(calls, [], 'the phone is never asked for a desktop run');
      assert.deepEqual(await executor.execute(DENIED_TOOL, {}), { success: false, error: 'Denied by node policy.', deniedBy: 'policy' });
      await new Promise((r) => setImmediate(r));
      const start = audit.find((e) => e.kind === 'exec.start');
      assert.deepEqual(start.data.origin, { client: 'desktop', deviceId: 'kld-testdesktop00001', session: 'chat-1', job_id: null });
      assert.ok(audit.some((e) => e.kind === 'tier.decision' && e.data.tier === 'denied'));
    } finally {
      await core.shutdown();
    }
  });

  it("R49: a child of a desktop run inherits the mark and is answered by the parent's dialog", async () => {
    const { core, calls } = await startedPhoneCore();
    try {
      const { event, sent } = desktopEvent();
      const parent = await core.context.createToolExecutorWithApprovals(event, null, null, {});
      await parent.execute(CAPTURE_TOOL, {});
      const child = await core.context.createToolExecutorWithApprovals(null, null, capturedRequester, {});
      const before = probeRuns;
      const running = child.execute(PROBE_TOOL, {});
      await answerDialog(core, sent, true);
      assert.equal((await running).ok, true);
      assert.equal(probeRuns, before + 1);
      assert.deepEqual(calls, []);
    } finally {
      await core.shutdown();
    }
  });

  it('an unmarked child in phone mode gets the phone, not the requester it was handed', async () => {
    const { core, calls } = await startedPhoneCore();
    try {
      let remoteAsked = 0;
      const child = await core.context.createToolExecutorWithApprovals(null, null, async () => { remoteAsked += 1; return true; }, {});
      await child.execute(PROBE_TOOL, {});
      assert.equal(remoteAsked, 0);
      assert.deepEqual(calls.map((c) => c.toolName), [PROBE_TOOL]);
      assert.equal(calls[0].origin.client, 'king-louie');
    } finally {
      await core.shutdown();
    }
  });

  it("a local event with an unmarked caller requester drops the requester and answers on screen (never the caller, never the phone)", async () => {
    const { core, calls } = await startedPhoneCore();
    try {
      const { event, sent } = desktopEvent();
      let remoteAsked = 0;
      const executor = await core.context.createToolExecutorWithApprovals(
        event, null, async () => { remoteAsked += 1; return true; }, { chatId: 'chat-1' }
      );
      const before = probeRuns;
      const running = executor.execute(PROBE_TOOL, {});
      await answerDialog(core, sent, true);
      assert.equal((await running).ok, true);
      assert.equal(probeRuns, before + 1);
      assert.equal(remoteAsked, 0, 'the unmarked caller requester must never be consulted');
      assert.deepEqual(calls, [], 'the phone must never be asked either');
    } finally {
      await core.shutdown();
    }
  });

  it('executorOptions.denyAutoApproval true forces denyAutoApproval even on a local run', async () => {
    const { core } = await startedPhoneCore();
    try {
      const { event } = desktopEvent();
      const local = await core.context.createToolExecutorWithApprovals(event, null, null, { denyAutoApproval: true });
      assert.equal(local.denyAutoApproval, true);
    } finally {
      await core.shutdown();
    }
  });

  it('an audit append that rejects does not crash the executor or the tool call', async () => {
    const auditLedger = { append: async () => { throw new Error('audit down'); } };
    const nodePolicy = { allowed_roots: [os.tmpdir()], remote_sessions: { always_confirm: [], deny: [] } };
    const phoneApprover = { ttlMs: 300000, isAvailable: () => true, requestApproval: async () => true };
    const core = buildCore('phone', { phoneApprover, auditLedger, nodePolicy });
    await core.start();
    if (!toolRegistry.get(PROBE_TOOL)) {
      toolRegistry.register(new Tool({
        name: PROBE_TOOL, description: 'test', parameters: { type: 'object', properties: {} }, requiresApproval: true,
        execute: async () => { probeRuns += 1; return { ok: true }; }
      }));
    }
    try {
      const executor = await core.context.createToolExecutorWithApprovals(null, null, null, {});
      const before = probeRuns;
      assert.deepEqual(await executor.execute(PROBE_TOOL, {}), { ok: true });
      assert.equal(probeRuns, before + 1);
      // Let the rejected append's own .catch settle so a broken test (one
      // that let the rejection go unhandled) would surface here.
      await new Promise((r) => setImmediate(r));
    } finally {
      await core.shutdown();
    }
  });

  // I2 (fix round 1): exec.start means "the tool is about to run" — it must
  // never be written for a call that was denied before reaching the tool.
  describe('exec.start only after every gate has passed', () => {
    it('a tier-denied call writes no exec.start', async () => {
      const { core, audit } = await startedPhoneCore();
      try {
        const executor = await core.context.createToolExecutorWithApprovals(null, null, null, {});
        await executor.execute(DENIED_TOOL, {});
        await new Promise((r) => setImmediate(r));
        assert.ok(audit.some((e) => e.kind === 'tier.decision' && e.data.tier === 'denied'));
        assert.ok(!audit.some((e) => e.kind === 'exec.start'), 'a tier-denied call must write no exec.start');
      } finally {
        await core.shutdown();
      }
    });

    it('a phone-denied call writes no exec.start', async () => {
      const { core, audit } = await startedPhoneCore({ answer: false });
      try {
        const executor = await core.context.createToolExecutorWithApprovals(null, null, null, {});
        const result = await executor.execute(PROBE_TOOL, {});
        assert.equal(result.success, false);
        await new Promise((r) => setImmediate(r));
        assert.ok(!audit.some((e) => e.kind === 'exec.start'), 'a phone-denied call must write no exec.start');
      } finally {
        await core.shutdown();
      }
    });

    it('an approved phone call writes exactly one exec.start, after approval.response', async () => {
      const audit = [];
      const auditLedger = { append: async (entry) => { audit.push(entry); return entry; } };
      const nodePolicy = { allowed_roots: [os.tmpdir()], remote_sessions: { always_confirm: [], deny: [] } };
      const phoneApprover = {
        ttlMs: 300000,
        isAvailable: () => true,
        // Mirrors the real PhoneApprover: it audits the phone's decision
        // itself before requestApproval resolves.
        requestApproval: async (toolName) => {
          await auditLedger.append({ kind: 'approval.response', data: { tool: toolName, decision: 'approve' } });
          return true;
        }
      };
      const core = buildCore('phone', { phoneApprover, auditLedger, nodePolicy });
      await core.start();
      if (!toolRegistry.get(PROBE_TOOL)) {
        toolRegistry.register(new Tool({
          name: PROBE_TOOL, description: 'test', parameters: { type: 'object', properties: {} }, requiresApproval: true,
          execute: async () => { probeRuns += 1; return { ok: true }; }
        }));
      }
      try {
        const executor = await core.context.createToolExecutorWithApprovals(null, null, null, {});
        const before = probeRuns;
        assert.deepEqual(await executor.execute(PROBE_TOOL, {}), { ok: true });
        assert.equal(probeRuns, before + 1);
        const execStarts = audit.filter((e) => e.kind === 'exec.start');
        assert.equal(execStarts.length, 1);
        const responseIndex = audit.findIndex((e) => e.kind === 'approval.response');
        const execStartIndex = audit.findIndex((e) => e.kind === 'exec.start');
        assert.ok(responseIndex >= 0, 'approval.response must have been audited');
        assert.ok(responseIndex < execStartIndex, 'exec.start must come after approval.response');
      } finally {
        await core.shutdown();
      }
    });
  });

  // I1 (fix round 1): a child of a running executor (SpawnAgent,
  // BackgroundTask, workflow runners — here driven directly through
  // agentExecutorAdapter.execute, the shared entry point they all use) must
  // inherit the parent's exact origin, not a freshly recomputed, poorer one
  // that has lost the deviceId or the session.
  describe("a child's origin (agentExecutorAdapter.execute -> createAgentRuntime -> createToolExecutorWithApprovals)", () => {
    afterEach(() => { requestedTool = PROBE_TOOL; });

    it("a child of a desktop run keeps client 'desktop' plus the parent's deviceId and session", async () => {
      const { core, audit } = await startedPhoneCore();
      try {
        configureFakeProvider(core);
        const { event, sent } = desktopEvent();
        const parent = await core.context.createToolExecutorWithApprovals(event, null, null, { chatId: 'chat-1' });
        await parent.execute(CAPTURE_TOOL, {});

        requestedTool = PROBE_TOOL;
        const before = probeRuns;
        const agent = capturedOptions.getAgent('main');
        const running = capturedOptions.agentExecutorAdapter.execute(
          agent, 'run the probe', { approvalRequester: capturedOptions.approvalRequester }
        );
        await answerDialog(core, sent, true);
        await running;
        assert.equal(probeRuns, before + 1);
        const start = audit.find((e) => e.kind === 'exec.start' && e.data.name === PROBE_TOOL);
        assert.ok(start, 'the child tool call was audited');
        assert.deepEqual(start.data.origin, {
          client: 'desktop', deviceId: 'kld-testdesktop00001', session: 'chat-1', job_id: null
        });
      } finally {
        await core.shutdown();
      }
    });

    it('a child of a remote run keeps its session', async () => {
      const { core, calls } = await startedPhoneCore();
      try {
        configureFakeProvider(core);
        const remote = await core.context.createToolExecutorWithApprovals(null, null, null, { chatId: 'chat-2' });
        await remote.execute(CAPTURE_TOOL, {});

        requestedTool = PROBE_TOOL;
        const before = probeRuns;
        const agent = capturedOptions.getAgent('main');
        await capturedOptions.agentExecutorAdapter.execute(
          agent, 'run the probe', { approvalRequester: capturedOptions.approvalRequester }
        );
        assert.equal(probeRuns, before + 1);
        assert.deepEqual(calls.map((c) => c.toolName), [PROBE_TOOL]);
        assert.deepEqual(calls[0].origin, { client: 'king-louie', session: 'chat-2', job_id: null });
      } finally {
        await core.shutdown();
      }
    });
  });
});
