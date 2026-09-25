// tests/helpers/stdio-mcp-client.js
// Starts a StdioMcpServer on in-memory streams and talks JSON-RPC to it the
// way an MCP client does over stdio. Shared by the fleet example tests and
// later fleet stages' tests.
const { PassThrough } = require('stream');
const StdioMcpServer = require('../../src/mcp/stdio-server');

function connectStdioMcp(options = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const server = new StdioMcpServer({ ...options, stdin, stdout });
  server.start();

  const waiters = new Map();
  let buffered = '';
  stdout.on('data', (chunk) => {
    buffered += chunk.toString();
    let nl;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const waiter = waiters.get(msg.id);
      if (waiter) {
        waiters.delete(msg.id);
        waiter(msg);
      }
    }
  });

  // Sends one JSON-RPC request and resolves with the response of the same id.
  function request(id, method, params, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`no response to ${method} (id ${id}) within ${timeoutMs} ms`));
      }, timeoutMs);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  let nextId = 1;
  async function callTool(name, args = {}) {
    const msg = await request(`tool-${nextId++}`, 'tools/call', { name, arguments: args });
    if (msg.error) throw new Error(`${name}: JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
    const text = msg.result.content[0].text;
    if (msg.result.isError) return { isError: true, text };
    return JSON.parse(text);
  }

  async function waitForJob(jobId, statuses, { timeoutMs = 15000 } = {}) {
    const wanted = Array.isArray(statuses) ? statuses : [statuses];
    const deadline = Date.now() + timeoutMs;
    let job = null;
    while (Date.now() < deadline) {
      job = await callTool('get_job', { job_id: jobId });
      if (!job.isError && wanted.includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`job ${jobId} did not reach ${wanted.join('/')} within ${timeoutMs} ms (last: ${JSON.stringify(job)})`);
  }

  async function close() {
    stdin.end();
    await Promise.allSettled([...server.jobRuns.values()]);
  }

  return { server, request, callTool, waitForJob, close };
}

module.exports = { connectStdioMcp };
