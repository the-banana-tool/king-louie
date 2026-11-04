// A task's turn on the real browser tool (tasks spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md
// §4.5, §4.6): a real TaskManager, core, agent loop and ToolExecutor, the real BrowserPage on
// Playwright's bundled headless Chromium, under the real task policy, with a real LeaseManager and
// PhoneApprover. The model is scripted, the phone signs real envelopes, and the pages are fulfilled
// by the browser context's route, so nothing reaches the network.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { open } = require('../src/approvals/envelope');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { createCore } = require('../src/core');
const { parseGuiConfig } = require('../src/gui/config');
const { LeaseManager } = require('../src/gui/leases');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const { createNodeTasks } = require('../src/tasks/wiring');
const browserTool = require('../src/tools/builtin/browser-tool');
const { getBrowser } = require('../src/tools/builtin/browser-registry');
const { setLogLevel } = require('../src/logging');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { approverStoreWith } = require('./helpers/approver-set');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { profileSettings, everyRole } = require('./helpers/profile-settings');

setLogLevel('fatal');

const FAKE = 'kl-test-tasks-browser';
const NODE_NAME = 'node-a';
const SHOP = 'https://shop.example.com/';
const ROUTE = 'https://directions.example.net/route';
const PAGES = {
  [SHOP]: `<!DOCTYPE html><html><head><title>Shop</title></head><body>
    <button id="buy" onclick="window.bought = (window.bought || 0) + 1">Buy now</button>
    <a id="off" href="${ROUTE}">Directions</a></body></html>`,
  [ROUTE]: `<!DOCTYPE html><html><head><title>Route</title></head><body>
    <button id="start" onclick="window.started = (window.started || 0) + 1">Start route</button></body></html>`,
};
const PROPOSAL = { sites: ['shop.example.com'], allows: ['browser-act'], minutes: 20, usd: 2 };

const nap = () => new Promise((resolve) => { setTimeout(resolve, 5); });
async function until(what, check) {
  for (let i = 0; i < 2000; i += 1) {
    const value = await check();
    if (value) return value;
    await nap();
  }
  throw new Error(`never happened: ${what}`);
}

// One world per test; the provider is process-wide. A step is what one model call answers; a
// function gets the messages the model was sent, so a ref comes from what the model really saw.
let world = null;
const page = (parameters) => ({ type: 'tool_use', toolName: 'BrowserPage', toolUseId: crypto.randomUUID(), parameters });

class ScriptedProvider {
  async sendMessageWithTools(messages) {
    const step = world.turns.shift();
    if (step === undefined) throw new Error('the script ran out of model turns');
    return typeof step === 'function' ? step(messages) : step;
  }

  async streamMessage(messages, options, onChunk) {
    const text = JSON.stringify(PROPOSAL);
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

// The ref of a named element in the last tool result the model was sent.
function refIn(messages, label) {
  const last = messages.filter((m) => m.role === 'tool').at(-1);
  const line = JSON.parse(last.content).snapshot.split('\n').find((l) => l.includes(label));
  assert.ok(line, `no "${label}" in what the model saw: ${last.content}`);
  return `ref=${line.match(/\[ref=(\w+)\]/)[1]}`;
}

class FakeLink extends EventEmitter {
  constructor() {
    super();
    this.leaseSends = [];
    this.approvals = [];
  }

  isConnected() { return true; }
  canDeliver() { return { ok: true }; }
  registerMethod() {}
  async send(envelope) { this.leaseSends.push(envelope); return { ok: true }; }
  async submit(envelope) { this.approvals.push(envelope); }
  async status() {}
  async pushNotify() { return { ok: true }; }
  cards() { return this.leaseSends.filter((e) => open(e).message.type === 'kl.lease.request'); }
}

async function buildWorld() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tasks-browser-'));
  const phone = createFakePhone({ name: 'Owner phone' });
  const identity = testNodeIdentity({ nodeName: NODE_NAME });
  const link = new FakeLink();
  const approvers = await approverStoreWith([phone.approverRecord()]);
  const audit = { append: async (entry) => entry };
  const nodeConfig = {
    name: NODE_NAME, profile: 'agent', capabilities: [], nodeId: identity.nodeId,
    policy: { allowed_roots: [dataDir], remote_sessions: { always_confirm: [], deny: [] } },
    delegate: { agent: 'main', provider: null, model: null },
  };
  const phoneApprover = new PhoneApprover({ identity, nodeName: NODE_NAME, approverStore: approvers, link, auditLedger: audit });
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    remoteApprovals: 'phone',
    phoneApprover,
    auditLedger: audit,
    nodePolicy: nodeConfig.policy,
  });
  core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: FAKE, model: 'fake' })));
  core.saveProviderToken(FAKE, 'fake-token-123456');
  await core.start();
  const guiConfig = parseGuiConfig({ enabled: true, apps: { chrome: { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', processes: ['chrome.exe'] } } }, { platform: 'win32' });
  const leases = new LeaseManager({
    approvals: { identity, approverStore: approvers, relayClient: link, phoneApprover }, guiConfig, nodeName: NODE_NAME, audit,
    jobOpen: (jobId) => jobId.startsWith('chat:') && Boolean(core.context.getChat(jobId.slice('chat:'.length), { messages: false })),
  });
  leases.start();
  const tasks = createNodeTasks({ core, nodeConfig, dataDir, leaseManager: leases, audit });
  await tasks.start();
  return {
    turns: [], core, tasks, leases, link, phone, phoneApprover,
    press(card) {
      const { message } = open(card);
      leases.onGrant(phone.leaseGrant(card, { decision: 'grant', minutes: message.lease.max_minutes, apps: [], signedAt: new Date().toISOString() }));
    },
    answer: (request, decision) => phoneApprover.handleResponse(phone.respond(request, decision)),
    rows: (id) => core.context.getMessages(tasks.store.get(id).chat_id),
    async finish() {
      await tasks.stop();
      leases.stop();
      phoneApprover.stop();
      await core.shutdown();
      closeOpenHistoryStores();
      approvers.cleanup();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

before(() => ProviderFactory.registerProvider(FAKE, ScriptedProvider));
after(() => ProviderFactory._registry.delete(FAKE));

describe('a task on the real browser tool (headless Chromium)', () => {
  before(async () => {
    await browserTool._cleanup();
    // What a task would open is the owner's Chrome and the king-louie profile; a test never does.
    const started = await browserTool.execute({ action: 'start', headless: true, ephemeral: true });
    assert.equal(started.ok, true, started.error);
    await getBrowser().context.route('**/*', (route) => {
      const url = route.request().url();
      if (PAGES[url]) route.fulfill({ status: 200, contentType: 'text/html', body: PAGES[url] });
      else route.abort();
    });
  });
  after(() => browserTool._cleanup());
  beforeEach(async () => { world = await buildWorld(); });
  afterEach(async () => {
    await world.finish();
    world = null;
  });

  it('snapshot, then click ref=eN: on a granted site with no prompt, on an off-list page by the phone', async () => {
    let buyRef = null;
    let startRef = null;
    world.turns.push(
      page({ action: 'navigate', url: SHOP }),
      page({ action: 'snapshot' }),
      (messages) => {
        buyRef = refIn(messages, 'Buy now');
        return page({ action: 'click', selector: buyRef });
      },
      page({ action: 'click', selector: '#off' }),
      page({ action: 'snapshot' }),
      (messages) => {
        startRef = refIn(messages, 'Start route');
        return page({ action: 'click', selector: startRef });
      },
      { type: 'text', content: 'All done.' },
    );

    const view = await world.tasks.run({ text: 'Buy the thing, then start the route', origin: { kind: 'stdio' } });
    const card = await until('the card', () => world.link.cards()[0]);
    assert.deepEqual(open(card).message.lease.sites, PROPOSAL.sites);
    await until('the click to wait for the press', () => buyRef);
    await until('awaiting_grant', () => world.tasks.store.get(view.task_id).state === 'awaiting_grant');
    const browser = getBrowser();
    assert.equal(await browser.page.evaluate(() => window.bought || 0), 0, 'it waits for the press');

    world.press(card);
    await until('the click on the granted site', async () => (await browser.page.evaluate(() => window.bought || 0)) === 1 || browser.page.url() === ROUTE);
    const request = await until('the off-list click at the phone', () => world.link.approvals[0]);
    assert.equal(world.link.approvals.length, 1, 'nothing on the granted site reached the phone');
    assert.equal(browser.page.url(), ROUTE);

    // What the phone signs names the element: prepareParams ran before anyone was asked.
    const asked = open(request).message.action;
    assert.equal(asked.name, 'BrowserPage');
    assert.deepEqual(asked.params, { action: 'click', selector: startRef, ref_label: 'button "Start route"' });
    assert.equal(await browser.page.evaluate(() => window.started || 0), 0, 'it waits for the answer');

    await world.answer(request, 'approve');
    await until('the task to end', () => world.tasks.store.get(view.task_id).state === 'done');
    assert.equal(await browser.page.evaluate(() => window.started || 0), 1);

    const rec = world.tasks.store.get(view.task_id);
    assert.equal(rec.answer.text, 'All done.');
    const clicks = world.rows(view.task_id).filter((r) => r.sender === 'toolUse' && r.parameters && r.parameters.action === 'click');
    assert.deepEqual(clicks.map((r) => [r.parameters.selector, r.parameters.ref_label]), [
      [buyRef, 'button "Buy now"'],
      ['#off', undefined],
      [startRef, 'button "Start route"'],
    ]);
  });
});
