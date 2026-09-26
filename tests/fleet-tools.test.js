// tests/fleet-tools.test.js — fleet stage 4 §3.7.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FleetToolHandler, ToolError, approvalOrigin, auditOrigin, STDIO_ORIGIN, MCP_TOOLS } = require('../src/fleet/fleet-tools');
const StdioMcpServer = require('../src/mcp/stdio-server');

const NODE = { name: 'web-01', profile: 'runbook', capabilities: [], policy: { allowed_roots: [], max_concurrent_jobs: 2 } };

function fakeEngine(result) {
  const runbook = { name: 'site.status', description: 'Status', tier: 'read', params: {} };
  return {
    runbooks: new Map([[runbook.name, runbook]]),
    getRunbook: (n) => (n === runbook.name ? runbook : null),
    validateParameters: () => ({}),
    checkRateLimit: () => ({ allowed: true }),
    recordExecution: () => 1,
    releaseExecution: () => true,
    executeRunbook: async () => result
  };
}

describe('origins', () => {
  it('maps a front-door origin to F3\'s exact approval origin', () => {
    const fd = { kind: 'frontdoor', client_id: 'dcr_x', client_name: 'x'.repeat(300), grant_id: 'gr_y', scopes: ['fleet:read'], mcp_session: 's-1' };
    assert.deepEqual(Object.keys(approvalOrigin(fd, 'job-1')), ['client', 'session', 'job_id']);
    assert.equal(Array.from(approvalOrigin(fd, 'job-1').client).length, 200);
    assert.equal(approvalOrigin(fd, 'job-1').session, 's-1');
    assert.deepEqual(approvalOrigin(STDIO_ORIGIN, null), { client: 'stdio-mcp', session: null, job_id: null });
    assert.deepEqual(auditOrigin(fd, null), { client: 'x'.repeat(200), session: 's-1', job_id: null, via: 'frontdoor', grant_id: 'gr_y', client_id: 'dcr_x' });
  });
});

describe('FleetToolHandler', () => {
  it('get_job carries the run\'s check evidence', async () => {
    const checks = [{ step_index: 0, check: { http_get: 'http://127.0.0.1:1/' }, ok: true, attempts: 1, status_code: 200, error: null, at: '2026-09-23T18:00:00.000Z' }];
    const h = new FleetToolHandler({ nodeConfig: NODE, runbookEngine: fakeEngine({ success: true, logs: ['ok'], checks }) });
    const { job_id: jobId } = await h.call('run_runbook', { machine: 'web-01', runbook: 'site.status' });
    await h.jobRuns.get(jobId);
    const job = await h.call('get_job', { job_id: jobId });
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(job.evidence, { checks });
    assert.deepEqual(job.output.lines, ['ok']);
  });

  it('delegate: capability_unavailable on a runbook node and on a standalone agent node', async () => {
    const runbookNode = new FleetToolHandler({ nodeConfig: NODE });
    await assert.rejects(runbookNode.call('delegate', { machine: 'web-01', task: 't' }), (err) => err instanceof ToolError
      && err.code === 'capability_unavailable' && err.message === 'capability_unavailable: delegate needs an agent-profile node');
    const agent = new FleetToolHandler({ nodeConfig: { ...NODE, profile: 'agent' } });
    await assert.rejects(agent.call('delegate', { machine: 'web-01', task: 't' }), /delegate needs the King Louie service running on this node \(not implemented/);
  });

  it('delegate and send_to_job go to the delegate sessions, with the caller\'s origin', async () => {
    const calls = [];
    const delegateSessions = {
      start: async (args) => { calls.push(['start', args]); return { job_id: 'job-d', status: 'running' }; },
      send: async (jobId, message, opts) => { calls.push(['send', jobId, message, opts.origin.kind]); return { job_id: jobId, status: 'running', session: 'turn' }; },
      cancel: (jobId) => { calls.push(['cancel', jobId]); return { success: true, job_id: jobId, status: 'cancelled' }; }
    };
    const h = new FleetToolHandler({ nodeConfig: { ...NODE, profile: 'agent' }, delegateSessions });
    const origin = { kind: 'frontdoor', client_id: 'dcr_x', client_name: 'Example Client', grant_id: 'gr_y', scopes: ['fleet:delegate'], mcp_session: 's' };
    assert.deepEqual(await h.call('delegate', { machine: 'web-01', task: 'train', cwd: '/srv' }, { origin }), { job_id: 'job-d', status: 'running' });
    const d = h.jobManager.createDelegateJob({ machine: 'web-01', task: 'x', cwd: '/srv' });
    await h.call('send_to_job', { job_id: d.job_id, message: 'go on' }, { origin });
    await h.call('cancel_job', { job_id: d.job_id }, { origin });
    assert.deepEqual(calls.map((c) => c[0]), ['start', 'send', 'cancel']);
    assert.deepEqual(calls[0][1], { task: 'train', cwd: '/srv', origin, request_id: null });
    assert.equal(calls[1][3], 'frontdoor');
  });

  it('adds the gui block to list_machines and describe_machine when a provider returns one', async () => {
    const h = new FleetToolHandler({ nodeConfig: NODE, gui: () => ({ available: true, capabilities: ['screenshot'] }) });
    assert.deepEqual((await h.call('list_machines'))[0].gui, { available: true, capabilities: ['screenshot'] });
    assert.deepEqual((await h.call('describe_machine', {})).gui, { available: true, capabilities: ['screenshot'] });
    const none = new FleetToolHandler({ nodeConfig: NODE, gui: () => null });
    assert.equal('gui' in (await none.call('describe_machine', {})), false);
  });
});

describe('StdioMcpServer over the handler', () => {
  it('delegates to a supplied handler and keeps the public surface', async () => {
    const seen = [];
    const handler = { nodeConfig: NODE, jobManager: null, jobRuns: new Map(), call: async (name, args, opts) => { seen.push([name, opts.origin]); return { ok: true }; } };
    const server = new StdioMcpServer({ handler });
    assert.deepEqual(await server.executeToolCall('get_state', {}), { ok: true });
    assert.deepEqual(seen, [['get_state', STDIO_ORIGIN]]);
    assert.equal(StdioMcpServer.MCP_TOOLS, MCP_TOOLS);
  });
});
