const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * MCPClient — Model Context Protocol client with stdio transport.
 *
 * Implements the MCP JSON-RPC 2.0 protocol to communicate with MCP servers
 * over stdin/stdout. Handles initialization, tool listing, and tool execution.
 *
 * MCP protocol flow:
 *  1. Spawn server process (stdio transport)
 *  2. Send initialize request → receive capabilities
 *  3. Send initialized notification
 *  4. List tools → register in King Louie's ToolRegistry
 *  5. Execute tools by proxying calls to the MCP server
 *
 * Reference: https://modelcontextprotocol.io/specification
 */
class MCPClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.name = config.name || 'mcp-server';
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.cwd = config.cwd || process.cwd();

    this._process = null;
    this._buffer = '';
    this._requestId = 0;
    this._pendingRequests = new Map(); // id → { resolve, reject, timer }
    this._serverCapabilities = null;
    this._serverInfo = null;
    this._connected = false;
    this._tools = []; // Cached tool list from server
    this._timeoutMs = config.timeoutMs || 30000;
  }

  get connected() {
    return this._connected;
  }

  get tools() {
    return this._tools;
  }

  get serverCapabilities() {
    return this._serverCapabilities;
  }

  /**
   * Connect to the MCP server: spawn process, initialize, list tools.
   */
  async connect() {
    if (this._connected) return;

    await this._spawnProcess();
    await this._initialize();
    await this._listTools();

    this._connected = true;
    this.emit('connected', { name: this.name, tools: this._tools });
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect() {
    if (!this._connected) return;

    // Reject all pending requests
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP client disconnecting'));
    }
    this._pendingRequests.clear();

    if (this._process) {
      try {
        this._process.kill('SIGTERM');
        // Give it a moment to exit gracefully
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (this._process && !this._process.killed) {
              this._process.kill('SIGKILL');
            }
            resolve();
          }, 3000);
          this._process.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch {
        // Process may already be dead
      }
      this._process = null;
    }

    this._connected = false;
    this._tools = [];
    this.emit('disconnected', { name: this.name });
  }

  /**
   * Call a tool on the MCP server.
   * @param {string} toolName
   * @param {object} arguments_ - tool input arguments
   * @returns {Promise<object>} tool result
   */
  async callTool(toolName, arguments_ = {}) {
    if (!this._connected) {
      throw new Error(`MCP server "${this.name}" is not connected`);
    }

    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: arguments_
    });

    // MCP tool results have { content: [{type, text}], isError }
    if (result.isError) {
      const errorText = (result.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return { ok: false, error: errorText || 'MCP tool returned an error' };
    }

    const textContent = (result.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    return { ok: true, result: textContent };
  }

  // ─── Private methods ──────────────────────────────────────────────────

  _spawnProcess() {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...this.env };

      this._process = spawn(this.command, this.args, {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      });

      this._process.stdout.on('data', (data) => this._onData(data));
      this._process.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          this.emit('stderr', { name: this.name, message: msg });
        }
      });

      this._process.on('error', (err) => {
        this.emit('error', { name: this.name, error: err });
        reject(err);
      });

      this._process.on('exit', (code, signal) => {
        this._connected = false;
        this.emit('exit', { name: this.name, code, signal });
      });

      // Give the process a moment to start
      setTimeout(resolve, 100);
    });
  }

  _onData(data) {
    this._buffer += data.toString();

    // MCP uses Content-Length header framing (like LSP)
    while (this._buffer.length > 0) {
      const headerEnd = this._buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this._buffer.substring(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);

      if (!contentLengthMatch) {
        // No Content-Length header — try parsing as raw JSON lines
        const lineEnd = this._buffer.indexOf('\n');
        if (lineEnd === -1) break;

        const line = this._buffer.substring(0, lineEnd).trim();
        this._buffer = this._buffer.substring(lineEnd + 1);
        if (line) this._parseMessage(line);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;

      if (this._buffer.length < bodyStart + contentLength) break;

      const body = this._buffer.substring(bodyStart, bodyStart + contentLength);
      this._buffer = this._buffer.substring(bodyStart + contentLength);

      this._parseMessage(body);
    }
  }

  _parseMessage(body) {
    try {
      const msg = JSON.parse(body);
      if ('id' in msg && this._pendingRequests.has(msg.id)) {
        // Response to a request we sent
        const pending = this._pendingRequests.get(msg.id);
        this._pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);

        if (msg.error) {
          pending.reject(new Error(msg.error.message || `MCP error ${msg.error.code}`));
        } else {
          pending.resolve(msg.result);
        }
      } else if (msg.method) {
        // Notification or request from server
        this.emit('notification', { method: msg.method, params: msg.params });
      }
    } catch (err) {
      this.emit('parseError', { body, error: err });
    }
  }

  _sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      });

      const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method} (${this._timeoutMs}ms)`));
      }, this._timeoutMs);

      this._pendingRequests.set(id, { resolve, reject, timer });

      try {
        this._process.stdin.write(frame);
      } catch (err) {
        this._pendingRequests.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _sendNotification(method, params) {
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    });
    const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    try {
      this._process.stdin.write(frame);
    } catch {
      // Server may have exited
    }
  }

  async _initialize() {
    const result = await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'king-louie',
        version: '1.0.0'
      }
    });

    this._serverCapabilities = result.capabilities || {};
    this._serverInfo = result.serverInfo || {};

    // Send initialized notification
    this._sendNotification('notifications/initialized', {});

    return result;
  }

  async _listTools() {
    if (!this._serverCapabilities.tools) {
      this._tools = [];
      return;
    }

    const result = await this._sendRequest('tools/list', {});
    this._tools = result.tools || [];
    return this._tools;
  }
}

module.exports = MCPClient;
