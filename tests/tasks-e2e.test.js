// The dentist task end to end (tasks spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md
// §1, §7): a client's run_task through the real FleetRouter and NodeFleetService to a node with a
// real core, agent loop, ToolExecutor, task policy, TaskManager, LeaseManager, PhoneApprover and
// PushQueue. What is fake: the model (a scripted provider under the real adapter), the phone (it
// signs real envelopes), the relay link, and the browser (a stand-in tool with the real tool's name,
// so a click still takes the real approval path; no Chromium, no network).
const { describe, it, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { open } = require('../src/approvals/envelope');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { createCore } = require('../src/core');
const { FleetToolHandler } = require('../src/fleet/fleet-tools');
const { NodeFleetService } = require('../src/fleet/node-fleet-service');
const { FleetRouter } = require('../src/frontdoor/router/router');
const { JobCache } = require('../src/frontdoor/router/job-cache');
const { createFleetScopeRegistry } = require('../src/frontdoor/oauth/scopes');
const { parseGuiConfig } = require('../src/gui/config');
const { LeaseManager } = require('../src/gui/leases');
const { PushQueue } = require('../src/gui/push-queue');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const { createNodeTasks } = require('../src/tasks/wiring');
const { toolRegistry } = require('../src/tools');
const { Tool } = require('../src/tools/tool-schema');
const browserRegistry = require('../src/tools/builtin/browser-registry');
const { setLogLevel } = require('../src/logging');
const { createSealPolicy } = require('../src/approvals/seal-policy');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { approverStoreWith } = require('./helpers/approver-set');
const { createFakeNode, createFakeHub, createFakeRegistry } = require('./helpers/fake-node');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { profileSettings, everyRole } = require('./helpers/profile-settings');

setLogLevel('fatal');

const FAKE = 'kl-test-tasks-e2e';
const NODE_NAME = 'node-a';
const DENTIST = 'Find a dentist for my child within 45 minutes of Lakeside, with good reviews for children';
const GRANTED_PAGE = 'https://www.reviews.example.com/lakeside/dentists';
const OFF_LIST_PAGE = 'https://directions.example.net/route';
const TABLE = [
  '| Name | Phone | Why |',
  '| --- | --- | --- |',
  '| Lakeside Family Dental | +15550100 | Children\'s dentist, 30 minutes away; reviews.example.com rates it 4.9 from parents |',
  '| Harbor Kids Dentistry | +15550101 | 40 minutes away; reviews.example.com says it is good with nervous children |',
].join('\n');
const PROPOSAL = { sites: ['*.reviews.example.com'], allows: ['browser-act'], minutes: 20, usd: 2 };
const LOOK_ONLY = { sites: [], allows: [], minutes: 10, usd: 2 };

const grantRecord = (id, scopes) => ({ grant_id: id, client_id: `dcr_${'b'.repeat(22)}`, client_name: 'Example Client', scopes: scopes.map((scope) => ({ scope, machines: null })), machine_ids: {} });
const GRANT = grantRecord(`gr_${'a'.repeat(22)}`, ['fleet:delegate', 'fleet:read', 'fleet:unsafe']);
const SECOND_GRANT = grantRecord(`gr_${'c'.repeat(22)}`, ['fleet:read']);
const nap = () => new Promise((resolve) => { setTimeout(resolve, 5); });
// Long enough for a call the model just made to reach the tool, if nothing holds it.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 50); });

// A step: what one model call answers. A plain value is the reply; a function is awaited first.
const browser = (parameters) => ({ type: 'tool_use', toolName: 'BrowserPage', toolUseId: crypto.randomUUID(), parameters });
const said = (content) => ({ type: 'text', content });
// Until the turn is stopped, as a real request would be.
const hangs = async (options) => {
  await new Promise((resolve) => {
    if (options.abortSignal.aborted) resolve();
    else options.abortSignal.addEventListener('abort', resolve, { once: true });
  });
  throw Object.assign(new Error('aborted'), { name: 'AbortError' });
};

// One world for one test; a provider and a tool are process-wide, so `world` is what they read.
let world = null;

class ScriptedProvider {
  async sendMessageWithTools(messages, tools, options = {}) {
    world.turnMessages.push(messages);
    const step = world.turns.shift();
    if (step === undefined) throw new Error('the script ran out of model turns');
    return typeof step === 'function' ? step(options) : step;
  }

  async streamMessage(messages, options, onChunk) {
    const answer = world.proposals.shift();
    if (answer === undefined) throw new Error('the script ran out of proposals');
    const text = JSON.stringify(answer);
    onChunk(text);
    return { content: text };
  }

  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: JSON.stringify(response.parameters) } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) },
    ];
  }
}

// The node's browser, as far as a task can tell: a page with a url. A click on `#directions` follows
// a link off the granted site.
const stubBrowserTool = () => new Tool({
  name: 'BrowserPage',
  description: 'test',
  parameters: { type: 'object', properties: {} },
  requiresApproval: true,
  execute: async (params) => {
    world.ran.push(`${params.action} ${params.url || params.selector || ''}`.trim());
    if (params.action === 'navigate') world.page.url = params.url;
    if (params.action === 'click' && params.selector === '#directions') world.page.url = OFF_LIST_PAGE;
    return { success: true, url: world.page.url };
  },
});

// The relay link, for the approver, the leases and the push queue alike.
class FakeLink extends EventEmitter {
  constructor() {
    super();
    this.leaseSends = [];
    this.approvals = [];
    this.pushes = [];
  }

  isConnected() { return true; }
  canDeliver() { return { ok: true }; }
  registerMethod() {}
  async send(envelope) { this.leaseSends.push(envelope); return { ok: true }; }
  async submit(envelope) { this.approvals.push(envelope); }
  async status() {}
  async pushNotify(params) { this.pushes.push(params); return { ok: true }; }
  cards() { return this.leaseSends.filter((e) => open(e).message.type === 'kl.lease.request'); }
  taskEnded(id) { return this.pushes.filter((p) => p.kind === 'task_ended' && p.id === id); }
}

// What the phones show of a card (taskLines in Lease.kt and its Swift twin), from the signed message.
function phoneLines(message, nodeName) {
  const { name, sites, allows, max_minutes: minutes, usd } = message.lease;
  const may = { 'browser-act': 'click and type in your signed-in browser', logins: 'sign in with saved logins', shell: 'run shell commands', 'files-write': 'write files' };
  return [
    `Task: ${name}`,
    ...(sites.length ? [`Sites: ${sites.join(', ')}`] : []),
    allows.length ? `May: ${allows.map((a) => may[a]).join(', ')}` : 'May: read only',
    `For: ${minutes} minutes`,
    `Spend up to $${usd}`,
    `Node: ${nodeName}`,
  ];
}

async function until(what, check) {
  for (let i = 0; i < 2000; i += 1) {
    const value = await check();
    if (value) return value;
    await nap();
  }
  throw new Error(`never happened: ${what}`);
}

class World {
  // sealed: the phone holds a box key and the node seals (sealed phones, R-SP-5).
  constructor({ sealed = false } = {}) {
    Object.assign(this, { sealed, canSeal: null, turns: [], proposals: [], turnMessages: [], ran: [], audit: [], page: { url: 'about:blank' } });
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tasks-e2e-'));
    this.cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tasks-e2e-cache-'));
    this.cipherKey = crypto.randomBytes(32);
    this.phone = createFakePhone({ name: 'Owner phone', boxKey: sealed });
    this.identity = testNodeIdentity({ nodeName: NODE_NAME, box: sealed });
    this.link = new FakeLink();
    this.ledger = { append: async (entry) => { this.audit.push(entry); return entry; } };
    this.nodeConfig = {
      name: NODE_NAME, profile: 'agent', capabilities: [], nodeId: this.identity.nodeId,
      policy: { allowed_roots: [this.dataDir], remote_sessions: { always_confirm: [], deny: [] } },
      delegate: { agent: 'main', provider: null, model: null },
    };
    this.up = null;
  }

  async start() {
    this.approvers = await approverStoreWith([this.phone.approverRecord({ boxKey: this.sealed })]);
    this.fleetNode = createFakeNode({ name: NODE_NAME, profile: 'agent' });
    this.fleetNode.service.stop();
    const nodes = [this.fleetNode];
    this.hub = createFakeHub(nodes);
    this.router = new FleetRouter({
      registry: createFakeRegistry(nodes), nodeHub: this.hub, cache: new JobCache({ file: path.join(this.cacheDir, 'node-status.json') }),
      scopeRegistry: createFleetScopeRegistry(), timeoutMs: 30000,
    });
    this.router.attach();
    await this.bootNode();
  }

  // The service starting on its data dir, as src/fleet/start.js and the GUI wire it. All that lives
  // past it is on disk.
  async bootNode() {
    const { identity, link, ledger, dataDir, nodeConfig, approvers } = this;
    let sealPolicy = null;
    if (this.sealed) {
      const real = createSealPolicy({ approverStore: approvers, identity, dataDir });
      sealPolicy = { ...real, canSeal: () => (this.canSeal === null ? real.canSeal() : this.canSeal), whyNot: () => 'no active phone holds a box key' };
    }
    const phoneApprover = new PhoneApprover({ identity, nodeName: NODE_NAME, approverStore: approvers, link, auditLedger: ledger, sealPolicy });
    const core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(this.cipherKey),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals: 'phone',
      phoneApprover,
      auditLedger: ledger,
      nodePolicy: nodeConfig.policy,
    });
    core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: FAKE, model: 'fake' })));
    core.saveProviderToken(FAKE, 'fake-token-123456');
    await core.start();
    // The core registers the real tool by now; a task's calls reach this one, through every real gate.
    toolRegistry.register(stubBrowserTool());
    browserRegistry.registry.default = { isRunning: true, page: { url: () => this.page.url } };
    const pushQueue = new PushQueue({ relayClient: link });
    pushQueue.start();
    const guiConfig = parseGuiConfig({ enabled: true, apps: { chrome: { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', processes: ['chrome.exe'] } } }, { platform: 'win32' });
    const leases = new LeaseManager({
      sealPolicy,
      approvals: { identity, approverStore: approvers, relayClient: link, phoneApprover }, guiConfig, nodeName: NODE_NAME, pushQueue, audit: ledger,
      jobOpen: (jobId) => jobId.startsWith('chat:') && Boolean(core.context.getChat(jobId.slice('chat:'.length), { messages: false })),
    });
    leases.start();
    const tasks = createNodeTasks({ core, nodeConfig, dataDir, leaseManager: leases, pushQueue, audit: ledger });
    await tasks.start();
    core.context.isTaskChatRunning = (chatId) => tasks.isChatRunning(chatId);
    const handler = new FleetToolHandler({ nodeConfig, tasks, auditLedger: ledger, approver: phoneApprover });
    const service = new NodeFleetService({ handler, relayClient: null, nodeConfig, version: '0.0.0-test' }).start();
    const { fleetNode, hub } = this;
    fleetNode.handler = handler;
    fleetNode.service = service;
    hub.setOnline(fleetNode.nodeId, true);
    await hub.fromNode(fleetNode.nodeId, 'fleet.hello', fleetNode.hello());
    await this.router.whenIdle();
    this.up = { core, phoneApprover, pushQueue, leases, tasks, service };
  }

  // In the host's order: tasks first, or a lease ending under a running turn reads as the task's end.
  async stopNode() {
    const { core, phoneApprover, pushQueue, leases, tasks, service } = this.up;
    this.up = null;
    this.hub.setOnline(this.fleetNode.nodeId, false);
    await tasks.stop();
    service.stop();
    leases.stop();
    pushQueue.stop();
    phoneApprover.stop();
    browserRegistry.registry.default = null;
    await core.shutdown();
    closeOpenHistoryStores();
  }

  async finish() {
    if (this.up) await this.stopNode();
    this.fleetNode.service.stop();
    this.approvers.cleanup();
    fs.rmSync(this.dataDir, { recursive: true, force: true });
    fs.rmSync(this.cacheDir, { recursive: true, force: true });
  }

  call(name, args, { scopes = GRANT.scopes.map((s) => s.scope), grant = GRANT } = {}) {
    return this.router.callTool(name, args, { grant, scopes, session: 's-1' });
  }

  async cardNumber(n) {
    await until(`card ${n} at the phone`, () => this.link.cards().length >= n);
    return this.link.cards()[n - 1];
  }

  // A card as the phone reads it.
  read(card) {
    return this.sealed ? this.phone.open(card, 'kl.lease.request').message : open(card).message;
  }

  press(card, decision = 'grant') {
    const minutes = this.read(card).lease.max_minutes;
    this.up.leases.onGrant(this.phone.leaseGrant(card, { decision, minutes, apps: [], signedAt: new Date().toISOString() }));
  }

  async approvalNumber(n) {
    await until(`tool approval ${n} at the phone`, () => this.link.approvals.length >= n);
    return this.link.approvals[n - 1];
  }

  answer(request, decision) {
    return this.up.phoneApprover.handleResponse(this.phone.respond(request, decision));
  }

  // get_task with wait_ms, resumed as a client does, until the state is one of these.
  async waitFor(taskId, states, options = {}) {
    let seen = null;
    return until(`${taskId} in ${states.join('/')}`, async () => {
      const view = await this.call('get_task', { task_id: taskId, seen_seq: seen, wait_ms: 200 }, options);
      assert.equal(view.error, undefined, JSON.stringify(view.error));
      seen = view.seq;
      return states.includes(view.state) ? view : null;
    });
  }

  ownId(taskId) {
    return taskId.split(':')[1];
  }
}

before(() => ProviderFactory.registerProvider(FAKE, ScriptedProvider));
after(() => ProviderFactory._registry.delete(FAKE));

let savedTool = null;
beforeEach(async () => {
  savedTool = toolRegistry.get('BrowserPage') || null;
  world = new World();
  await world.start();
});
afterEach(async () => {
  await world.finish();
  world = null;
  toolRegistry.unregister('BrowserPage');
  if (savedTool) toolRegistry.register(savedTool);
});

describe('the dentist task', () => {
  it('runs from one press to a table a second client can read', async () => {
    world.proposals.push(PROPOSAL);
    world.turns.push(
      browser({ action: 'navigate', url: GRANTED_PAGE }), // reading, before any press
      browser({ action: 'click', selector: '#first-result' }), // on a granted site: waits for the press
      browser({ action: 'click', selector: '#directions' }), // on a granted site; follows a link off it
      browser({ action: 'click', selector: '#start-route' }), // off the list: the phone's
      said(TABLE),
    );

    // No node named, and one node: it is placed there.
    const started = await world.call('run_task', { task: DENTIST });
    assert.equal(started.error, undefined, JSON.stringify(started.error));
    assert.ok(started.task_id.startsWith(`${NODE_NAME}:`), started.task_id);
    assert.equal(started.node, NODE_NAME);
    assert.deepEqual(started.placement, { by: 'only-node' });

    // The card, from the signed message, in the spec's lines.
    const card = await world.cardNumber(1);
    const { message } = open(card);
    assert.equal(message.lease.kind, 'task');
    assert.equal(message.lease.unattended, true);
    assert.deepEqual(phoneLines(message, NODE_NAME), [
      `Task: ${DENTIST.slice(0, 60).trim()}`,
      'Sites: *.reviews.example.com',
      'May: click and type in your signed-in browser',
      'For: 20 minutes',
      'Spend up to $2',
      `Node: ${NODE_NAME}`,
    ]);

    // The reading went ahead; the click waits, and nobody is asked for it.
    await until('the reading to run', () => world.ran.includes(`navigate ${GRANTED_PAGE}`));
    await until('the model to ask for the click', () => world.turnMessages.length >= 2);
    await settle();
    const out = await world.call('get_task', { task_id: started.task_id });
    assert.equal(out.state, 'awaiting_grant');
    assert.equal(out.grant, null);
    assert.deepEqual(world.ran, [`navigate ${GRANTED_PAGE}`]);

    // One press: both clicks on the granted site run with no prompt.
    world.press(card);
    await until('the clicks on the granted site', () => world.ran.includes('click #directions'));
    assert.deepEqual(world.ran.slice(1), ['click #first-result', 'click #directions']);

    // The off-list click is one signed tool approval over that exact action, and it waits.
    const request = await world.approvalNumber(1);
    assert.equal(world.link.approvals.length, 1, 'only the off-list click reached the phone');
    const asked = open(request).message;
    assert.equal(asked.action.kind, 'tool');
    assert.equal(asked.action.name, 'BrowserPage');
    assert.deepEqual(asked.action.params, { action: 'click', selector: '#start-route' });
    assert.ok(!world.ran.includes('click #start-route'));
    assert.equal((await world.call('get_task', { task_id: started.task_id })).state, 'running');
    await world.answer(request, 'approve');

    // The reply is the answer: done, and data to whoever reads it.
    const done = await world.waitFor(started.task_id, ['done']);
    assert.ok(world.ran.includes('click #start-route'));
    assert.equal(done.answer.text.untrusted_output, true);
    const answerText = done.answer.text.lines.join('\n');
    assert.ok(answerText.includes('+15550100') && answerText.includes('+15550101'), answerText);
    assert.ok(answerText.includes('reviews.example.com'), 'each reason says where it came from');
    assert.deepEqual(done.ended.reason, 'done');
    assert.equal(done.grant.by_device, world.phone.deviceId);
    assert.equal(done.grant.live, false, 'the grant died with the task');

    // The phone hears, content-free, once, and the lease is over.
    await until('task_ended', () => world.link.taskEnded(world.ownId(started.task_id)).length === 1);
    assert.deepEqual(Object.keys(world.link.taskEnded(world.ownId(started.task_id))[0]).sort(), ['except_device', 'expires_at', 'id', 'kind', 'to_device']);
    assert.equal(world.up.leases.find(message.lease_id).state, 'ended');

    // A second grant, with only fleet:read, reads it whole, and cannot act on it.
    const second = { grant: SECOND_GRANT, scopes: ['fleet:read'] };
    const read = await world.call('get_task', { task_id: started.task_id }, second);
    assert.equal(read.state, 'done');
    assert.equal(read.answer.text.lines.join('\n'), answerText);
    assert.deepEqual(read.text.lines, [DENTIST]);
    const listed = await world.call('list_tasks', {}, second);
    assert.deepEqual(listed.tasks.map((t) => t.task_id), [started.task_id]);
    assert.equal((await world.call('send_to_task', { task_id: started.task_id, message: 'and another one' }, second)).error.code, 'insufficient_scope');

    // The chat holds the client's words marked as the client's; the audit holds no words at all.
    const own = world.up.tasks.store.get(world.ownId(started.task_id));
    const rows = world.up.core.context.getMessages(own.chat_id);
    assert.equal(rows.find((r) => r.sender === 'user').author, 'client');
    assert.ok(rows.some((r) => r.sender === 'toolUse' && r.toolName === 'BrowserPage'));
    assert.deepEqual(world.audit.filter((e) => e.kind === 'task.requested').map((e) => e.data.node), [NODE_NAME]);
    assert.deepEqual(world.audit.filter((e) => e.kind === 'task.ended').map((e) => e.data.reason), ['done']);
    const taskEntries = JSON.stringify(world.audit.filter((e) => e.kind.startsWith('task.')));
    assert.ok(!taskEntries.includes('dentist') && !taskEntries.includes('reviews.example.com'), taskEntries);
    assert.equal(world.audit.filter((e) => e.kind === 'task.refused').length, 0, 'an approved call is no refusal');
    // The lease's entries say what the phone was asked.
    const granted = world.audit.find((e) => e.kind === 'lease.granted');
    assert.deepEqual([granted.data.kind, granted.data.allows, granted.data.usd], ['task', PROPOSAL.allows, PROPOSAL.usd]);
    assert.ok(!('name' in granted.data) && !('sites' in granted.data));
  });
});

describe('the dentist task on a node that seals', () => {
  beforeEach(async () => {
    await world.finish();
    world = new World({ sealed: true });
    await world.start();
  });

  it('runs the same from one press to its answer, and the relay reads none of it', async () => {
    world.proposals.push(PROPOSAL);
    world.turns.push(
      browser({ action: 'navigate', url: GRANTED_PAGE }),
      browser({ action: 'click', selector: '#first-result' }),
      browser({ action: 'click', selector: '#start-route-off-list', url: OFF_LIST_PAGE }),
      said(TABLE),
    );
    const started = await world.call('run_task', { task: DENTIST });
    assert.equal(started.state, 'requested');

    const card = await world.cardNumber(1);
    const signed = open(card).message;
    for (const key of ['lease', 'origin', 'salt']) assert.ok(!(key in signed), key);
    assert.ok(signed.sealed);
    const inClear = Buffer.from(card.payload, 'base64url').toString('utf8');
    for (const planted of ['dentist', 'reviews.example.com', 'browser-act', 'Example Client']) assert.ok(!inClear.includes(planted), planted);
    assert.deepEqual(phoneLines(world.read(card), NODE_NAME), [
      `Task: ${DENTIST.slice(0, 60).trim()}`,
      'Sites: *.reviews.example.com',
      'May: click and type in your signed-in browser',
      'For: 20 minutes',
      'Spend up to $2',
      `Node: ${NODE_NAME}`,
    ]);
    await until('the reading to run', () => world.ran.includes(`navigate ${GRANTED_PAGE}`));
    assert.ok(!world.ran.includes('click #first-result'), 'the click waits for the press');

    world.press(card);
    await until('the click on the granted site', () => world.ran.includes('click #first-result'));

    world.page.url = OFF_LIST_PAGE;
    const request = await world.approvalNumber(1);
    const asked = world.phone.open(request, 'kl.approval.request').message;
    assert.equal(asked.action.name, 'BrowserPage');
    await world.answer(request, 'approve');
    const done = await world.waitFor(started.task_id, ['done']);
    assert.ok(done.answer.text.lines.join('\n').includes('+15550100'));
    assert.equal(done.grant.by_device, world.phone.deviceId);

    const statuses = world.link.leaseSends.map((e) => open(e).message).filter((m) => m.type === 'kl.lease.status');
    assert.ok(statuses.length > 1);
    for (const m of statuses) {
      assert.ok(m.sealed);
      assert.ok(!('name' in m));
    }
    assert.ok(statuses.some((m) => m.state === 'ended'), 'the end is told');

    const ledger = JSON.stringify(world.audit);
    assert.ok(!ledger.includes('reviews.example.com') && !ledger.includes('Example Client') && !ledger.includes('#first-result') && !ledger.includes('dentist'), ledger);
    const tier = world.audit.find((e) => e.kind === 'tier.decision').data;
    assert.match(tier.params_hmac, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!('params_sha256' in tier));
  });

  it('a running task whose phones can no longer read it fails no_sealed_recipient, cut off, and the lease ends', async () => {
    world.proposals.push(PROPOSAL);
    world.turns.push(browser({ action: 'navigate', url: GRANTED_PAGE }), hangs);
    const started = await world.call('run_task', { task: DENTIST });
    const card = await world.cardNumber(1);
    world.press(card);
    await until('the turn to hang', () => world.turnMessages.length >= 2);
    world.canSeal = false;
    world.up.leases.checkGrantingDevices();
    const over = await world.waitFor(started.task_id, ['failed']);
    assert.equal(over.ended.reason, 'no_sealed_recipient');
    assert.equal(world.up.leases.find(open(card).message.lease_id).endReason, 'no_sealed_recipient');
    assert.equal(world.link.leaseSends.map((e) => open(e).message).filter((m) => m.type === 'kl.lease.status').pop().state, 'ended');
  });

  it('with nobody to seal to no card goes, and an acting call is refused at the approval, not sent', async () => {
    world.canSeal = false;
    world.proposals.push(PROPOSAL);
    world.turns.push(
      browser({ action: 'click', selector: '#first-result' }),
      said('I could not act on that page.'),
    );
    const started = await world.call('run_task', { task: DENTIST });
    await world.waitFor(started.task_id, ['done', 'failed']);
    assert.equal(world.link.cards().length, 0);
    assert.equal(world.link.approvals.length, 0);
    assert.ok(!world.ran.includes('click #first-result'));
  });
});

describe('a look-only task', () => {
  it('needs no press, reads anywhere, and one click is still the phone\'s', async () => {
    world.proposals.push(LOOK_ONLY);
    world.turns.push(
      browser({ action: 'navigate', url: OFF_LIST_PAGE }),
      browser({ action: 'click', selector: '#accept' }),
      said('The route takes 40 minutes.'),
    );
    const started = await world.call('run_task', { task: 'How long is the drive from Lakeside to Harbor?' });

    const request = await world.approvalNumber(1);
    assert.deepEqual(open(request).message.action.params, { action: 'click', selector: '#accept' });
    await world.answer(request, 'deny');

    const done = await world.waitFor(started.task_id, ['done']);
    assert.deepEqual(done.answer.text.lines, ['The route takes 40 minutes.']);
    assert.deepEqual(world.ran, [`navigate ${OFF_LIST_PAGE}`], 'the denied click did not run');
    assert.equal(world.link.cards().length, 0, 'no card');
    assert.equal(done.grant, null);
    assert.equal(done.proposal.lookOnly, true);
    assert.equal(done.spend.cap_usd, 2);
    await until('task_ended', () => world.link.taskEnded(world.ownId(started.task_id)).length === 1);

    // The audit says what was refused, by the tool and a code; never the parameters.
    await until('task.refused', () => world.audit.some((e) => e.kind === 'task.refused'));
    const refused = world.audit.filter((e) => e.kind === 'task.refused');
    assert.deepEqual(refused.map((e) => [e.data.tool, e.data.code]), [['BrowserPage', 'phone_denied']]);
    assert.ok(!JSON.stringify(refused).includes('#accept'));
  });
});

describe('cancel_task', () => {
  it('stops the turn and the lease at once, tells the phone, and frees the node', async () => {
    world.proposals.push(PROPOSAL);
    world.turns.push(hangs);
    const started = await world.call('run_task', { task: DENTIST });
    const card = await world.cardNumber(1);
    world.press(card);
    await until('the press to land', async () => (await world.call('get_task', { task_id: started.task_id })).grant);

    const blocked = await world.call('run_task', { task: 'Something else' });
    assert.equal(blocked.error.code, 'task_busy');

    const cancelled = await world.call('cancel_task', { task_id: started.task_id });
    assert.deepEqual([cancelled.state, cancelled.ended.reason], ['cancelled', 'cancelled']);
    assert.equal(world.up.leases.find(open(card).message.lease_id).state, 'ended');
    await until('task_ended', () => world.link.taskEnded(world.ownId(started.task_id)).length === 1);
    assert.equal((await world.call('send_to_task', { task_id: started.task_id, message: 'go on' })).error.code, 'invalid_params');

    // The turn has unwound, and another task can run.
    world.proposals.push(LOOK_ONLY);
    world.turns.push(said('Done.'));
    const next = await until('the node to be free', async () => {
      const view = await world.call('run_task', { task: 'Something else' });
      return view.error && view.error.code === 'task_busy' ? null : view;
    });
    assert.equal((await world.waitFor(next.task_id, ['done'])).state, 'done');
    assert.equal((await world.call('get_task', { task_id: started.task_id })).state, 'cancelled');
  });
});

describe('a restart', () => {
  it('leaves the task interrupted; send_to_task cards again, and it finishes', async () => {
    world.proposals.push(PROPOSAL);
    world.turns.push(browser({ action: 'navigate', url: GRANTED_PAGE }), hangs);
    const started = await world.call('run_task', { task: DENTIST });
    world.press(await world.cardNumber(1));
    await until('the turn to be under way', () => world.ran.includes(`navigate ${GRANTED_PAGE}`));

    await world.stopNode();
    await until('task_ended', () => world.link.taskEnded(world.ownId(started.task_id)).length === 1);
    assert.equal((await world.call('get_task', { task_id: started.task_id })).error.code, 'machine_offline');

    await world.bootNode();
    const read = await world.call('get_task', { task_id: started.task_id });
    assert.equal(read.state, 'interrupted');
    assert.deepEqual(read.text.lines, [DENTIST]);
    assert.equal(read.grant.live, false, 'a lease does not outlive its service');

    // No acting call until a new press; the card goes first, with a fresh scope.
    world.proposals.push(PROPOSAL);
    world.turns.push(browser({ action: 'click', selector: '#first-result' }), said(TABLE));
    const callsBefore = world.turnMessages.length;
    const sent = await world.call('send_to_task', { task_id: started.task_id, message: 'Please carry on from where you were' });
    assert.equal(sent.error, undefined, JSON.stringify(sent.error));
    const card = await world.cardNumber(2);
    assert.notEqual(open(card).message.lease_id, read.grant.lease_id);
    await until('the model to ask for the click', () => world.turnMessages.length > callsBefore);
    await settle();
    assert.equal(world.ran.includes('click #first-result'), false);
    world.press(card);

    const done = await world.waitFor(started.task_id, ['done']);
    assert.ok(world.ran.includes('click #first-result'));
    assert.ok(done.answer.text.lines.join('\n').includes('+15550100'));
    assert.equal(world.link.approvals.length, 0, 'the click was under the new press');

    // The same chat: the model saw the first words as well as the new ones.
    const lastTurn = JSON.stringify(world.turnMessages.at(-1));
    assert.ok(lastTurn.includes('Lakeside') && lastTurn.includes('carry on'), lastTurn.slice(0, 400));
    const own = world.up.tasks.store.get(world.ownId(started.task_id));
    assert.deepEqual(world.up.core.context.getMessages(own.chat_id).filter((r) => r.sender === 'user').map((r) => r.author), ['client', 'client']);
    await until('the second task_ended', () => world.link.taskEnded(world.ownId(started.task_id)).length === 2);
  });
});
