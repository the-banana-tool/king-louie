// tests/helpers/fake-node.js
//
// A front-door-side view of fleet nodes without sockets: each node is a real
// NodeFleetService (so its own scope re-check, request_id dedupe and
// max_bytes paging run) over an in-memory handler; the hub is the NodeHub
// subset the router uses. The real mesh path is covered end to end in
// tests/frontdoor-e2e.test.js.
const { EventEmitter } = require('events');
const { NodeFleetService } = require('../../src/fleet/node-fleet-service');
const { ToolError } = require('../../src/fleet/tool-definitions');
const { LinkRpcError } = require('../../src/approvals/link-rpc');
const { rawEd25519 } = require('../../src/frontdoor/protocol/messages');
const { testNodeIdentity } = require('./fake-phone');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'denied', 'expired']);
const DEFAULT_RUNBOOKS = [
  { name: 'site.status', description: 'Status', tier: 'read', params: {} },
  { name: 'site.restart', description: 'Restart', tier: 'unsafe', params: {} }
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeHandler({ name, profile, runbooks }) {
  const jobManager = new EventEmitter();
  const jobs = new Map();
  let n = 0;
  const handler = {
    jobManager,
    jobs,
    calls: [],
    runbookEngine: {
      runbooks: new Map(runbooks.map((r) => [r.name, r])),
      getRunbook: (x) => runbooks.find((r) => r.name === x) || null
    },
    // Like FleetToolHandler: a delegate job is visible only to the grant
    // that started it (ruling T11-owner).
    getJobOrThrow(id, origin = null) {
      const job = jobs.get(id);
      const owner = origin && typeof origin.grant_id === 'string' ? origin.grant_id : null;
      if (!job || (job.kind === 'delegate' && job.owner !== owner)) throw new ToolError('job_not_found', `job_not_found: no job "${id}" on this node`);
      return job;
    },
    async call(tool, args = {}, { origin } = {}) {
      handler.calls.push({ tool, args, origin });
      if (tool === 'describe_machine') return { name, profile, capabilities: [], allowed_roots: [], max_concurrent_jobs: 2, runbooks };
      if (tool === 'get_state') {
        return {
          machine: name,
          running_jobs: [...jobs.values()]
            .filter((j) => !TERMINAL.has(j.status) && (j.kind !== 'delegate' || (origin && j.owner === origin.grant_id)))
            .map((j) => ({ job_id: j.job_id, status: j.status, ...(j.kind === 'delegate' ? { kind: 'delegate', session: j.session } : {}) })),
          not_collected: ['gpu', 'services', 'last_update']
        };
      }
      if (tool === 'run_runbook' || tool === 'delegate') {
        n += 1;
        const job = {
          job_id: `job-${n}`,
          kind: tool === 'delegate' ? 'delegate' : 'runbook',
          runbook: tool === 'delegate' ? null : args.runbook,
          status: tool === 'delegate' ? 'running' : 'queued',
          ...(tool === 'delegate' ? { session: 'turn', owner: origin ? origin.grant_id : null } : {}),
          logs: [],
          result: null,
          updated_at: new Date().toISOString()
        };
        jobs.set(job.job_id, job);
        return { job_id: job.job_id, status: job.status };
      }
      if (tool === 'cancel_job') {
        const job = handler.getJobOrThrow(args.job_id, origin);
        job.status = 'cancelled';
        return { success: true, job_id: job.job_id, status: job.status };
      }
      if (tool === 'send_to_job') {
        const job = handler.getJobOrThrow(args.job_id, origin);
        return { job_id: job.job_id, status: job.status };
      }
      throw new ToolError('invalid_params', `invalid_params: the fake node has no ${tool}`);
    }
  };
  return handler;
}

function createFakeNode({ name = 'web-01', profile = 'runbook', runbooks = DEFAULT_RUNBOOKS } = {}) {
  const identity = testNodeIdentity({ nodeName: name });
  const handler = fakeHandler({ name, profile, runbooks });
  const service = new NodeFleetService({ handler, relayClient: null, nodeConfig: { name, profile, capabilities: [], nodeId: identity.nodeId }, version: '0.0.0-test' }).start();
  const record = {
    node_id: identity.nodeId,
    node_name: name,
    profile,
    public_key: rawEd25519(identity.publicKey),
    tls_fingerprint: 'a'.repeat(64),
    source: 'console',
    accepted_at: new Date().toISOString(),
    signed: null
  };
  return {
    nodeId: identity.nodeId,
    name,
    identity,
    record,
    handler,
    service,
    hello: () => ({
      node_id: identity.nodeId,
      name,
      profile,
      capabilities: [],
      catalog_digest: service.catalogDigest(),
      boot_id: service.bootId,
      version: '0.0.0-test'
    })
  };
}

function createFakeHub(nodes) {
  const handlers = new Map();
  const connections = new EventEmitter();
  const hub = {
    calls: [],
    slowMs: new Map(),
    offline: new Set(),
    onNodeMessage(method, fn) {
      handlers.set(method, fn);
    },
    onConnection(fn) {
      connections.on('connection', fn);
    },
    // The node runs the call at once; only its answer is late when slowMs is
    // set, which is how a real timed-out call that did start looks.
    async rpc(nodeId, method, params = {}, { timeoutMs = 10000 } = {}) {
      const node = nodes.find((n) => n.nodeId === nodeId);
      if (!node || hub.offline.has(nodeId)) throw new LinkRpcError('offline', `${nodeId} is not connected`);
      hub.calls.push({ nodeId, method, params });
      const work = (async () => {
        const result = await node.service.dispatch(method, JSON.parse(JSON.stringify(params)));
        const delay = hub.slowMs.get(nodeId) || 0;
        if (delay) await sleep(delay);
        return result;
      })();
      let timer;
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new LinkRpcError('timeout', `${method} to ${nodeId} timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        return await Promise.race([work, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    notify() {},
    async fromNode(nodeId, method, params) {
      const fn = handlers.get(method);
      if (!fn) throw new Error(`no handler for ${method}`);
      return fn(params, { nodeId });
    },
    setOnline(nodeId, online) {
      if (online) hub.offline.delete(nodeId);
      else hub.offline.add(nodeId);
      connections.emit('connection', { nodeId, connected: online });
    }
  };
  return hub;
}

function createFakeRegistry(nodes) {
  const status = new Map();
  const find = (pred) => {
    const n = nodes.find(pred);
    return n ? n.record : null;
  };
  return {
    list: () => nodes.map((n) => n.record),
    byId: (id) => find((n) => n.nodeId === id),
    byName: (name) => find((n) => n.name === name),
    presence: (id) => status.get(id) || null,
    markOnline(id, hello = {}) {
      const prev = status.get(id);
      const bootChanged = Boolean(prev && prev.boot_id && hello.boot_id && prev.boot_id !== hello.boot_id);
      status.set(id, { online: true, last_seen: new Date().toISOString(), boot_id: hello.boot_id || null, hello });
      return { bootChanged };
    },
    markOffline(id) {
      status.set(id, { ...(status.get(id) || {}), online: false, last_seen: new Date().toISOString() });
    }
  };
}

module.exports = { createFakeNode, createFakeHub, createFakeRegistry, fakeHandler, DEFAULT_RUNBOOKS };
