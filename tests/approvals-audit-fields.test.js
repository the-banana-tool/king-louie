// What a tool call leaves in the mirrored ledger (sealed phones, R-SP-7, and the
// ruling after Task 5's review): the tool's name, the tier, the ids. No parameter,
// no error text, no client, and the parameters' mark only under a key the node holds.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { approvalSeam } = require('../src/approvals/executor-options');
const { paramsHmac, auditOriginOf, auditError } = require('../src/approvals/audit-fields');
const { createSealPolicy } = require('../src/approvals/seal-policy');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const ToolExecutor = require('../src/execution/tool-executor');
const { FleetToolHandler } = require('../src/fleet/fleet-tools');
const { toolRegistry } = require('../src/tools');
const { Tool } = require('../src/tools/tool-schema');
const { canonicalize } = require('../src/platform/jcs');
const { setLogLevel } = require('../src/logging');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

setLogLevel('fatal');

const stores = [];
const dirs = [];
after(() => {
  for (const s of stores) s.cleanup();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const PARAM = 'planted-parameter-value-7731';
const FAILURE = 'planted-error-text-of-the-command';
const CLIENT = 'Planted Client Name';
const SESSION = 'planted-session-id';
const TOOL = 'kl-test-audit-tool';
const plainSha = (params) => crypto.createHash('sha256').update(canonicalize(params)).digest('base64url');
const settle = () => new Promise((resolve) => { setTimeout(resolve, 10); });

// Everything an entry holds, an envelope's payload read as text too.
function allText(entries) {
  const decoded = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.payload === 'string') decoded.push(Buffer.from(v.payload, 'base64url').toString('utf8'));
      Object.values(v).forEach(walk);
    }
  };
  walk(entries);
  return `${JSON.stringify(entries)}\n${decoded.join('\n')}`;
}

function ledgerFor(identity = null) {
  const entries = [];
  return { identity, entries, append: async (e) => { entries.push(e); return e; } };
}

function registerTool(execute) {
  toolRegistry.register(new Tool({ name: TOOL, description: 'test', requiresApproval: true, parameters: { type: 'object', properties: {} }, execute }));
}

afterEach(() => { toolRegistry.unregister(TOOL); });

// A real ToolExecutor on the real seam, over a real PhoneApprover that seals.
async function sealedCall({ execute, identity = testNodeIdentity({ box: true }), origin = { client: CLIENT, session: SESSION, job_id: 'job-9' } } = {}) {
  const phone = createFakePhone({ boxKey: true });
  const store = await approverStoreWith([phone.approverRecord({ boxKey: true })]);
  stores.push(store);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-audit-fields-'));
  dirs.push(dataDir);
  const ledger = ledgerFor(identity);
  const submitted = [];
  const link = { isConnected: () => true, canDeliver: () => ({ ok: true }), submit: async (env) => { submitted.push(env); }, status: async () => {} };
  const approver = new PhoneApprover({ identity, approverStore: store, link, auditLedger: ledger, sealPolicy: createSealPolicy({ approverStore: store, identity, dataDir }) });
  registerTool(execute);
  const seam = approvalSeam({ remoteApprovals: 'phone', executorOptions: { origin }, phoneApprover: approver, auditLedger: ledger, nodePolicy: { allowed_roots: [dataDir], remote_sessions: { always_confirm: [], deny: [] } } });
  const executor = new ToolExecutor({ ...seam.toolExecutorOptions, workingDirectory: dataDir });
  seam.attach(executor);
  const running = executor.execute(TOOL, { command: PARAM });
  for (let i = 0; i < 400 && submitted.length === 0; i += 1) await settle();
  assert.equal(submitted.length, 1, 'the call reached the phone');
  await approver.handleResponse(phone.respond(submitted[0], 'approve'));
  const result = await running;
  await settle();
  approver.stop();
  return { result, entries: ledger.entries, identity };
}

describe('a sealed tool call through the real seam', () => {
  it('leaves no parameter, no error text and no client in any ledger entry', async () => {
    const { result, entries } = await sealedCall({ execute: async () => ({ success: false, error: `the command said: ${FAILURE} ${PARAM}` }) });
    assert.equal(result.success, false);
    const kinds = entries.map((e) => e.kind);
    for (const kind of ['tier.decision', 'approval.request', 'exec.start', 'exec.result']) assert.ok(kinds.includes(kind), kind);
    const text = allText(entries);
    for (const planted of [PARAM, FAILURE, CLIENT, SESSION]) assert.ok(!text.includes(planted), `${planted} is in the ledger`);

    const data = (kind) => entries.find((e) => e.kind === kind).data;
    assert.deepEqual(Object.keys(data('tier.decision')).sort(), ['job_id', 'origin', 'params_hmac', 'reason', 'tier', 'tool']);
    assert.deepEqual([data('tier.decision').tool, data('tier.decision').tier, data('tier.decision').job_id], [TOOL, 'unsafe', 'job-9']);
    assert.deepEqual(data('tier.decision').origin, { kind: 'remote' });
    assert.deepEqual(data('exec.start'), { kind: 'tool', name: TOOL, request_id: null, job_id: 'job-9', origin: { kind: 'remote' } });
    const expectedChars = `the command said: ${FAILURE} ${PARAM}`.length;
    assert.deepEqual(data('exec.result'), { kind: 'tool', name: TOOL, request_id: null, job_id: 'job-9', origin: { kind: 'remote' }, ok: false, exit_status: null, error: { error_chars: expectedChars } });
  });

  it('a code goes as the code', async () => {
    const { entries } = await sealedCall({ execute: async () => ({ success: false, code: 'rate_limited', error: FAILURE }) });
    const { data } = entries.find((e) => e.kind === 'exec.result');
    assert.equal(data.error, 'rate_limited');
    assert.ok(!allText(entries).includes(FAILURE));
  });

  it('a call that succeeds records no error', async () => {
    const { entries } = await sealedCall({ execute: async () => ({ success: true, out: PARAM }) });
    const { data } = entries.find((e) => e.kind === 'exec.result');
    assert.deepEqual([data.ok, data.error], [true, null]);
    assert.ok(!allText(entries).includes(PARAM));
  });
});

describe('params_hmac (R-SP-7)', () => {
  const PARAMS = { command: 'ls' };

  it('holds no params_sha256, is keyed by the node, and is not the plain hash', () => {
    const a = testNodeIdentity({ box: true });
    const b = testNodeIdentity({ box: true });
    const one = paramsHmac(PARAMS, a);
    assert.match(one, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(paramsHmac({ command: 'ls' }, a), one, 'one node, one value');
    assert.notEqual(paramsHmac(PARAMS, b), one, 'two nodes, two values');
    assert.notEqual(one, plainSha(PARAMS));
    assert.notEqual(paramsHmac({ command: 'la' }, a), one);
  });

  it('is HMAC-SHA256 under HKDF(box scalar, info kl-audit-params-v1)', () => {
    const a = testNodeIdentity({ box: true });
    const key = a.box.deriveKey('kl-audit-params-v1');
    assert.equal(key.length, 32);
    assert.notDeepEqual(key, a.box.deriveKey('another use'));
    assert.equal(paramsHmac(PARAMS, a), crypto.createHmac('sha256', key).update(canonicalize(PARAMS)).digest('base64url'));
  });

  it('with no box on this process it writes null, never a plain hash', () => {
    const bare = testNodeIdentity({});
    assert.equal(paramsHmac(PARAMS, bare), null);
    assert.equal(paramsHmac(PARAMS, null), null);
  });

  it('a tier.decision from a process with no box says params_hmac: null, and no sha', async () => {
    const { entries } = await sealedCall({ execute: async () => ({ success: true }) });
    const { data } = entries.find((e) => e.kind === 'tier.decision');
    assert.ok(!('params_sha256' in data));
    assert.match(data.params_hmac, /^[A-Za-z0-9_-]{43}$/);

    const ledger = ledgerFor(testNodeIdentity({}));
    registerTool(async () => ({ success: true }));
    const seam = approvalSeam({ remoteApprovals: 'phone', executorOptions: { origin: { client: CLIENT, session: null, job_id: null } }, phoneApprover: { ttlMs: 1000, requestApproval: async () => true, isAvailable: () => true }, auditLedger: ledger, nodePolicy: { allowed_roots: [], remote_sessions: { always_confirm: [], deny: [] } } });
    const executor = new ToolExecutor(seam.toolExecutorOptions);
    seam.attach(executor);
    await executor.execute(TOOL, { command: PARAM });
    await settle();
    const bare = ledger.entries.find((e) => e.kind === 'tier.decision').data;
    assert.ok(!('params_sha256' in bare));
    assert.equal(bare.params_hmac, null);
  });

  it('an audit form of the parameters is what goes under the key (Type, Key)', async () => {
    const identity = testNodeIdentity({ box: true });
    const ledger = ledgerFor(identity);
    toolRegistry.register(new Tool({
      name: TOOL, description: 'test', requiresApproval: false, parameters: { type: 'object', properties: {} },
      auditParameters: () => ({ length: 5 }), execute: async () => ({ success: true })
    }));
    const seam = approvalSeam({ remoteApprovals: 'phone', executorOptions: { origin: { client: CLIENT, session: null, job_id: null } }, phoneApprover: { ttlMs: 1000, requestApproval: async () => true, isAvailable: () => true }, auditLedger: ledger, nodePolicy: { allowed_roots: [], remote_sessions: { always_confirm: [], deny: [] } } });
    const executor = new ToolExecutor(seam.toolExecutorOptions);
    seam.attach(executor);
    await executor.execute(TOOL, { text: 'hello' });
    await settle();
    assert.equal(ledger.entries.find((e) => e.kind === 'tier.decision').data.params_hmac, paramsHmac({ length: 5 }, identity));
  });
});

describe('auditOriginOf and auditError', () => {
  it('an origin is its kind and nothing a client named', () => {
    assert.deepEqual(auditOriginOf({ kind: 'frontdoor', client_name: CLIENT, client_id: 'dcr_x', grant_id: 'gr_y' }), { kind: 'frontdoor' });
    assert.deepEqual(auditOriginOf({ kind: 'stdio', client: 'stdio-mcp' }), { kind: 'stdio' });
    assert.deepEqual(auditOriginOf({ kind: 'service-chat', client: 'x' }), { kind: 'service-chat' });
    assert.deepEqual(auditOriginOf({ client: 'desktop', deviceId: 'kld-1', session: 'chat-1' }), { kind: 'desktop' });
    assert.deepEqual(auditOriginOf({ client: 'king-louie', session: 'chat-1', job_id: null }), { kind: 'node' });
    assert.deepEqual(auditOriginOf({ client: 'stdio-mcp', session: null }), { kind: 'stdio' });
    assert.deepEqual(auditOriginOf({ client: CLIENT, session: SESSION }), { kind: 'remote' });
    assert.deepEqual(auditOriginOf({ kind: CLIENT }), { kind: 'remote' }, 'a kind nobody knows is not repeated');
    assert.deepEqual(auditOriginOf(null), { kind: 'remote' });
  });

  it('an error is a code, or how long it was', () => {
    assert.equal(auditError({ code: 'take_ended', error: FAILURE }), 'take_ended');
    assert.deepEqual(auditError({ error: FAILURE }), { error_chars: FAILURE.length });
    assert.deepEqual(auditError({ code: 'not a code: quoted command', error: FAILURE }), { error_chars: FAILURE.length });
    assert.deepEqual(auditError({}), { error_chars: 0 });
    assert.deepEqual(auditError(null), { error_chars: 0 });
  });
});

describe('the runbook path (fleet-tools)', () => {
  const FD_ORIGIN = { kind: 'frontdoor', client_id: 'dcr_x', client_name: CLIENT, grant_id: 'gr_y', mcp_session: SESSION };
  const NODE = { name: 'web-01', profile: 'runbook', capabilities: [], policy: {} };

  it('request.inbound holds no parameter and no client', async () => {
    const identity = testNodeIdentity({ box: true });
    const ledger = ledgerFor(identity);
    const h = new FleetToolHandler({ nodeConfig: NODE, auditLedger: ledger });
    h.auditInbound('site.restart', { value: PARAM }, FD_ORIGIN, null);
    await settle();
    const inbound = ledger.entries.find((e) => e.kind === 'request.inbound').data;
    assert.deepEqual(Object.keys(inbound).sort(), ['job_id', 'method', 'name', 'origin', 'params_hmac']);
    assert.deepEqual(inbound.origin, { kind: 'frontdoor' });
    assert.equal(inbound.params_hmac, paramsHmac({ value: PARAM }, identity));
    const text = allText(ledger.entries);
    for (const planted of [PARAM, CLIENT, SESSION, 'dcr_x', 'gr_y']) assert.ok(!text.includes(planted), planted);
  });

  it('a runbook that fails records how long its error was, and one that throws a code records the code', async () => {
    const ledger = ledgerFor(testNodeIdentity({ box: true }));
    const jobs = { getSignal: () => null, isTerminal: () => false, updateJob: () => {}, markExecuting: () => {}, markSettled: () => {} };
    const h = new FleetToolHandler({ nodeConfig: NODE, auditLedger: ledger, jobManager: jobs });
    const run = (executeRunbook) => {
      h.runbookEngine = { releaseExecution: () => {}, executeRunbook };
      return h.executeJob('job-1', 'site.restart', {}, {}, { requestId: 'req-1', origin: FD_ORIGIN });
    };
    await run(async () => ({ success: false, error: FAILURE }));
    await run(async () => { throw Object.assign(new Error(FAILURE), { code: 'rate_limited' }); });
    await settle();
    const results = ledger.entries.filter((e) => e.kind === 'exec.result').map((e) => e.data);
    assert.deepEqual(results.map((d) => d.error), [{ error_chars: FAILURE.length }, 'rate_limited']);
    assert.deepEqual(ledger.entries.find((e) => e.kind === 'exec.start').data.origin, { kind: 'frontdoor' });
    const text = allText(ledger.entries);
    for (const planted of [FAILURE, CLIENT, SESSION]) assert.ok(!text.includes(planted), planted);
  });
});
