const { EventEmitter } = require('events');
const MCPClient = require('./mcp-client');
const { Tool } = require('../tools/tool-schema');

/**
 * MCPManager — manages multiple MCP server connections and registers their
 * tools into King Louie's ToolRegistry.
 *
 * Configuration format (in settings):
 * {
 *   mcpServers: {
 *     "my-server": {
 *       command: "npx",
 *       args: ["-y", "@some/mcp-server"],
 *       env: { "API_KEY": "..." }
 *     }
 *   }
 * }
 *
 * Each MCP tool is wrapped as a King Louie Tool with:
 *  - Name prefixed: "mcp__<serverName>__<toolName>"
 *  - Schema from MCP inputSchema
 *  - Execution proxied through MCPClient.callTool()
 */
class MCPManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._clients = new Map(); // serverName → MCPClient
    this._toolRegistry = options.toolRegistry || null;
    this._registeredTools = new Map(); // toolName → serverName
  }

  get clients() {
    return this._clients;
  }

  /**
   * Get the status of all configured MCP servers.
   */
  getStatus() {
    const status = {};
    for (const [name, client] of this._clients) {
      status[name] = {
        connected: client.connected,
        tools: client.tools.map(t => t.name),
        serverInfo: client._serverInfo || null
      };
    }
    return status;
  }

  /**
   * Connect to all configured MCP servers.
   * @param {object} serverConfigs - { serverName: { command, args, env, cwd } }
   */
  async connectAll(serverConfigs = {}) {
    const results = [];

    for (const [name, config] of Object.entries(serverConfigs)) {
      try {
        await this.connectServer(name, config);
        results.push({ name, status: 'connected', tools: this._clients.get(name)?.tools?.length || 0 });
      } catch (err) {
        console.error(`[mcp-manager] Failed to connect to "${name}":`, err.message);
        results.push({ name, status: 'failed', error: err.message });
      }
    }

    return results;
  }

  /**
   * Connect to a single MCP server and register its tools.
   */
  async connectServer(name, config) {
    // Disconnect existing if reconnecting
    if (this._clients.has(name)) {
      await this.disconnectServer(name);
    }

    const client = new MCPClient({
      name,
      command: config.command,
      args: config.args || [],
      env: config.env || {},
      cwd: config.cwd,
      timeoutMs: config.timeoutMs || 30000
    });

    client.on('error', (evt) => {
      console.error(`[mcp:${name}] Error:`, evt.error?.message);
      this.emit('serverError', { name, error: evt.error });
    });

    client.on('exit', (evt) => {
      console.warn(`[mcp:${name}] Exited with code ${evt.code}`);
      this._unregisterTools(name);
      this.emit('serverExit', { name, code: evt.code });
    });

    client.on('stderr', (evt) => {
      this.emit('serverLog', { name, message: evt.message });
    });

    this._clients.set(name, client);

    await client.connect();
    this._registerTools(name, client);

    this.emit('serverConnected', {
      name,
      tools: client.tools.map(t => t.name)
    });
  }

  /**
   * Disconnect from a single MCP server.
   */
  async disconnectServer(name) {
    const client = this._clients.get(name);
    if (!client) return;

    this._unregisterTools(name);
    await client.disconnect();
    this._clients.delete(name);
  }

  /**
   * Disconnect from all MCP servers.
   */
  async disconnectAll() {
    const names = Array.from(this._clients.keys());
    await Promise.all(names.map(name => this.disconnectServer(name)));
  }

  /**
   * Register MCP server tools into King Louie's ToolRegistry.
   */
  _registerTools(serverName, client) {
    if (!this._toolRegistry) return;

    for (const mcpTool of client.tools) {
      const toolName = `mcp__${serverName}__${mcpTool.name}`;

      // Convert MCP inputSchema to King Louie tool parameters
      const parameters = mcpTool.inputSchema || { type: 'object', properties: {} };

      const tool = new Tool({
        name: toolName,
        description: `[MCP: ${serverName}] ${mcpTool.description || mcpTool.name}`,
        parameters,
        requiresApproval: true, // MCP tools need approval by default
        concurrencySafe: false, // Conservative: assume side effects
        execute: async (params) => {
          try {
            return await client.callTool(mcpTool.name, params);
          } catch (err) {
            return { ok: false, error: err.message };
          }
        }
      });

      this._toolRegistry.register(tool);
      this._registeredTools.set(toolName, serverName);
    }
  }

  /**
   * Unregister all tools from a given server.
   */
  _unregisterTools(serverName) {
    if (!this._toolRegistry) return;

    for (const [toolName, sName] of this._registeredTools) {
      if (sName === serverName) {
        // ToolRegistry doesn't have unregister — delete from the internal map
        this._toolRegistry.tools?.delete(toolName);
        this._registeredTools.delete(toolName);
      }
    }
  }
}

module.exports = MCPManager;
