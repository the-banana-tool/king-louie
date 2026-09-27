// The local stdio MCP server (F2 §5.5): JSON-RPC framing over stdin/stdout.
// The tools are FleetToolHandler's (src/fleet/fleet-tools.js, fleet stage 4
// §3.7). `handler` is a FleetToolHandler, or — for `mcp` when the service
// runs on this data dir (R24) — a CourierFleetClient that sends every call
// to the service's own handler.
const readline = require('readline');
const { createLogger } = require('../logging');
const { FleetToolHandler, MCP_TOOLS, ToolError, untrustedOutput, STDIO_ORIGIN } = require('../fleet/fleet-tools');
const { version: SERVER_VERSION } = require('../../package.json');

const log = createLogger('stdio-mcp-server');

class StdioMcpServer {
  constructor(options = {}) {
    this.handler = options.handler || new FleetToolHandler({
      nodeConfig: options.nodeConfig,
      runbookEngine: options.runbookEngine,
      jobManager: options.jobManager,
      approver: options.approver,
      auditLedger: options.auditLedger,
      delegateSessions: options.delegateSessions,
      gui: options.gui,
      workingDirectory: options.workingDirectory,
      caseTools: options.caseTools || null
    });
    this.nodeConfig = this.handler.nodeConfig || options.nodeConfig || null;
    this.stdin = options.stdin || process.stdin;
    this.stdout = options.stdout || process.stdout;
  }

  get jobManager() {
    return this.handler.jobManager;
  }

  get jobRuns() {
    return this.handler.jobRuns;
  }

  get runbookEngine() {
    return this.handler.runbookEngine;
  }

  start() {
    const rl = readline.createInterface({
      input: this.stdin,
      terminal: false
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (err) {
        log.warn(`Unparseable JSON-RPC message: ${err.message}`);
        // JSON-RPC 2.0: a request that cannot be parsed has no usable id.
        this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      this.handleMessage(message).catch((err) => {
        log.error(`Failed to handle JSON-RPC message: ${err.message}`);
      });
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
          serverInfo: { name: 'king-louie', version: SERVER_VERSION }
        }
      });
    }

    if (method === 'ping') {
      return this.send({ jsonrpc: '2.0', id, result: {} });
    }

    if (method === 'tools/list') {
      // The handler's list (the fleet tools, then the case tools where it
      // has them); a handler without listTools serves the fleet tools.
      let tools = MCP_TOOLS;
      if (typeof this.handler.listTools === 'function') {
        try {
          tools = await this.handler.listTools();
        } catch (err) {
          log.warn(`Listing tools failed: ${err.message}`);
        }
      }
      return this.send({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};
      try {
        const result = await this.executeToolCall(toolName, args);
        return this.send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        });
      } catch (err) {
        // A coded error goes back as JSON so a client can branch on `error`
        // (and read retry_after) without parsing prose.
        const text = err instanceof ToolError
          ? JSON.stringify({ error: err.code, message: err.message, ...err.data }, null, 2)
          : `Error: ${err.message}`;
        return this.send({
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text }] }
        });
      }
    }

    return this.send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }

  executeToolCall(toolName, args = {}) {
    return this.handler.call(toolName, args, { origin: STDIO_ORIGIN });
  }

  runRunbook(args) {
    return this.handler.runRunbook(args, STDIO_ORIGIN);
  }
}

module.exports = StdioMcpServer;
module.exports.MCP_TOOLS = MCP_TOOLS;
module.exports.ToolError = ToolError;
module.exports.untrustedOutput = untrustedOutput;
