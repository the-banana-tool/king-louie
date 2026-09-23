const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { createLogger } = require('../logging');
const { JobManager } = require('../runbooks/runbook-engine');

const log = createLogger('stdio-mcp-server');

const MCP_TOOLS = [
  {
    name: 'list_machines',
    description: 'List all machines in the King Louie fleet (or the local machine).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'describe_machine',
    description: "Describe a machine's capabilities, policy, and available runbooks.",
    inputSchema: {
      type: 'object',
      properties: { machine: { type: 'string' } }
    }
  },
  {
    name: 'get_state',
    description: 'Get current state of a machine: CPU, memory, disk, running jobs and last boot. GPU, services and last update are not collected yet (listed in not_collected).',
    inputSchema: {
      type: 'object',
      properties: { machine: { type: 'string' } }
    }
  },
  {
    name: 'run_runbook',
    description: 'Run a named runbook on a machine.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string' },
        runbook: { type: 'string' },
        params: { type: 'object' }
      },
      required: ['machine', 'runbook']
    }
  },
  {
    name: 'delegate',
    description: 'Delegate a multi-turn agent session on an agent-profile machine.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string' },
        task: { type: 'string' },
        cwd: { type: 'string' }
      },
      required: ['machine', 'task']
    }
  },
  {
    name: 'send_to_job',
    description: 'Send a follow-up message to an active job or delegation.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        message: { type: 'string' }
      },
      required: ['job_id', 'message']
    }
  },
  {
    name: 'get_job',
    description: 'Get status, timing, result, and evidence for a job.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id']
    }
  },
  {
    name: 'get_job_logs',
    description: 'Get logs and transcripts for a job.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        since: { type: 'string' },
        tail: { type: 'integer' }
      },
      required: ['job_id']
    }
  },
  {
    name: 'cancel_job',
    description: 'Cancel an active or queued job.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id']
    }
  }
];

// Free and total space for each allowed root, or for the filesystem holding
// the home directory when no roots are configured. A root that cannot be
// read reports its error instead of disappearing from the list.
function diskState(allowedRoots) {
  const targets = Array.isArray(allowedRoots) && allowedRoots.length
    ? allowedRoots
    : [path.parse(os.homedir()).root];
  return targets.map((p) => {
    try {
      const st = fs.statfsSync(p);
      return { path: p, free_bytes: st.bavail * st.bsize, total_bytes: st.blocks * st.bsize };
    } catch (err) {
      return { path: p, error: err.code || err.message };
    }
  });
}

class StdioMcpServer {
  constructor(options = {}) {
    this.nodeConfig = options.nodeConfig || { name: 'local-node', profile: 'agent', capabilities: [], policy: {} };
    this.runbookEngine = options.runbookEngine || null;
    this.jobManager = options.jobManager
      || new JobManager({ maxConcurrentJobs: this.nodeConfig.policy?.max_concurrent_jobs ?? Infinity });
    this.stdin = options.stdin || process.stdin;
    this.stdout = options.stdout || process.stdout;
  }

  start() {
    const rl = readline.createInterface({
      input: this.stdin,
      terminal: false
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const message = JSON.parse(trimmed);
        this.handleMessage(message);
      } catch (err) {
        log.warn(`Invalid JSON-RPC message: ${err.message}`);
      }
    });
  }

  send(response) {
    this.stdout.write(JSON.stringify(response) + '\n');
  }

  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // Notifications (no id)
    if (msg.id === undefined) return;

    const { id, method, params } = msg;

    if (method === 'initialize') {
      return this.send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'king-louie', version: '26.5.27' }
        }
      });
    }

    if (method === 'tools/list') {
      return this.send({
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS }
      });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};
      try {
        const result = await this.executeToolCall(toolName, args);
        return this.send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          }
        });
      } catch (err) {
        return this.send({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Error: ${err.message}` }]
          }
        });
      }
    }

    return this.send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }

  async executeToolCall(toolName, args = {}) {
    if (toolName === 'list_machines') {
      return [
        {
          name: this.nodeConfig.name,
          profile: this.nodeConfig.profile,
          capabilities: this.nodeConfig.capabilities,
          online: true,
          summary: `Node ${this.nodeConfig.name} (${this.nodeConfig.profile})`
        }
      ];
    }

    if (toolName === 'describe_machine') {
      const runbooksList = [];
      if (this.runbookEngine) {
        const runbooks = this.runbookEngine.loadRunbooks();
        for (const r of runbooks.values()) {
          runbooksList.push({
            name: r.name,
            description: r.description,
            tier: r.tier,
            params: r.params
          });
        }
      }
      return {
        name: this.nodeConfig.name,
        profile: this.nodeConfig.profile,
        capabilities: this.nodeConfig.capabilities,
        policy: this.nodeConfig.policy,
        runbooks: runbooksList
      };
    }

    if (toolName === 'get_state') {
      const cpus = os.cpus();
      const running = [...this.jobManager.jobs.values()]
        .filter((j) => j.status === 'queued' || j.status === 'running')
        .map((j) => ({ job_id: j.job_id, runbook: j.runbook, status: j.status, created_at: j.created_at }));
      return {
        machine: this.nodeConfig.name,
        cpu: { count: cpus.length, model: cpus[0]?.model || '', load_average: os.loadavg() },
        memory: { free_bytes: os.freemem(), total_bytes: os.totalmem() },
        disk: diskState(this.nodeConfig.policy?.allowed_roots),
        running_jobs: running,
        last_boot: new Date(Date.now() - os.uptime() * 1000).toISOString(),
        uptime_seconds: os.uptime(),
        platform: process.platform,
        arch: process.arch,
        // Listed rather than left out, so a caller can tell "not collected"
        // from "none": each needs a per-OS probe (nvidia-smi, systemctl/sc,
        // the package manager) that does not exist yet.
        not_collected: ['gpu', 'services', 'last_update']
      };
    }

    if (toolName === 'run_runbook') {
      if (!this.runbookEngine) {
        throw new Error('Runbook engine not configured on this node');
      }
      const runbook = this.runbookEngine.getRunbook(args.runbook);
      if (!runbook) {
        throw new Error(`Runbook "${args.runbook}" not found on node ${this.nodeConfig.name}`);
      }

      const job = this.jobManager.createJob({
        machine: this.nodeConfig.name,
        runbook: args.runbook,
        params: args.params || {},
        tier: runbook.tier
      });

      if (runbook.tier === 'unsafe') {
        return {
          job_id: job.job_id,
          status: 'awaiting_approval',
          message: 'Runbook tier is unsafe and requires phone approval signature.'
        };
      }

      this.jobManager.updateJob(job.job_id, { status: 'running' });
      try {
        const execRes = await this.runbookEngine.executeRunbook(args.runbook, args.params || {});
        if (execRes.success) {
          this.jobManager.updateJob(job.job_id, { status: 'succeeded', logs: execRes.logs });
          return { job_id: job.job_id, status: 'succeeded', logs: execRes.logs };
        }
        this.jobManager.updateJob(job.job_id, { status: 'failed', logs: execRes.logs, result: execRes.error });
        return { job_id: job.job_id, status: 'failed', error: execRes.error, logs: execRes.logs };
      } catch (err) {
        this.jobManager.updateJob(job.job_id, { status: 'failed', result: err.message });
        return { job_id: job.job_id, status: 'failed', error: err.message };
      }
    }

    if (toolName === 'delegate') {
      if (this.nodeConfig.profile === 'runbook') {
        throw new Error(`Capability unavailable: machine "${this.nodeConfig.name}" has profile "runbook" and does not support agent delegation`);
      }
      // No agent session is started here yet. Creating a job that only ever
      // says "running" would tell the caller work is under way when nothing
      // is, and would hold a max_concurrent_jobs slot for good.
      throw new Error('delegate is not implemented on this node yet: no agent session was started');
    }

    if (toolName === 'send_to_job') {
      const job = this.jobManager.getJob(args.job_id);
      if (!job) throw new Error(`Job "${args.job_id}" not found`);
      job.logs.push(`[user message]: ${args.message}`);
      return { success: true, job_id: args.job_id };
    }

    if (toolName === 'get_job') {
      const job = this.jobManager.getJob(args.job_id);
      if (!job) throw new Error(`Job "${args.job_id}" not found`);
      return job;
    }

    if (toolName === 'get_job_logs') {
      const job = this.jobManager.getJob(args.job_id);
      if (!job) throw new Error(`Job "${args.job_id}" not found`);
      let logs = job.logs || [];
      if (args.tail && Number.isInteger(args.tail)) {
        logs = logs.slice(-args.tail);
      }
      return { job_id: args.job_id, logs };
    }

    if (toolName === 'cancel_job') {
      const ok = this.jobManager.cancelJob(args.job_id);
      return { success: ok, job_id: args.job_id };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }
}

module.exports = StdioMcpServer;
