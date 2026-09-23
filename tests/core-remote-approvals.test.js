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

function buildCore(remoteApprovals) {
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
