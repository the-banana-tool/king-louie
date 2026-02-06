# King Louie Enhancement Plan: Tool-Oriented LLM System

## Executive Summary

This document outlines a phased approach to transform King Louie from a basic Electron chat application with simulated responses into a sophisticated tool-oriented LLM system modeled after Claude Code's architecture. The plan focuses on implementing real LLM integration, comprehensive tool support, agent orchestration, and extensibility.

---

## Current State Analysis

### What King Louie Has
✅ Electron desktop application shell (main.js, renderer.js, preload.js)
✅ Two-pane chat interface (sidebar + main content)
✅ Secure token storage (encrypted via Electron's safeStorage)
✅ Provider configuration infrastructure (OpenAI, Anthropic, GitHub Copilot)
✅ Chat persistence (electron-store)
✅ IPC communication architecture
✅ Settings management UI

### What's Missing
❌ **No actual LLM integration** - Only simulated responses
❌ **No tool/function calling framework** - Cannot execute tools or actions
❌ **No agent orchestration** - Simple request-response only
❌ **No streaming responses** - Hardcoded delays
❌ **No message formatting** - Plain text only (no markdown rendering)
❌ **No plugin/extension system** - Monolithic architecture
❌ **No task management** - Cannot track multi-step operations
❌ **No permission system** - No tool safety controls
❌ **No hook system** - No pre/post execution automation

---

## Architecture Comparison

| Feature | King Louie (Current) | Claude Code (Target) |
|---------|---------------------|----------------------|
| LLM Integration | None (simulated) | Multi-model with streaming |
| Tool System | None | 10+ built-in tools + MCP |
| Agent Architecture | N/A | Multi-agent orchestration |
| Permission System | N/A | 3-layer (manifest/command/hook) |
| Plugin Support | N/A | Full plugin architecture |
| Task Management | N/A | Complete lifecycle tracking |
| Workflow Orchestration | N/A | Serial + parallel execution |
| Security Hooks | N/A | Pre/post tool validation |
| Message Format | Plain text | Markdown + code blocks |
| Response Mode | Simulated | Streaming with SSE |

---

## Phased Implementation Plan

---

## **PHASE 1: Core LLM Integration** (Foundation)
**Timeline:** 2-3 weeks
**Priority:** CRITICAL

**Status Update (2026-02-05):** 🚧 In Progress (Core foundation implemented)

### Implementation Progress Notes
- Implemented provider abstraction layer and provider factory:
  - `src/providers/base-provider.js`
  - `src/providers/openai-provider.js`
  - `src/providers/anthropic-provider.js`
  - `src/providers/provider-factory.js`
- Replaced simulated response flow with real provider-backed streaming in `main.js` via `chat:sendMessage`
- Added streaming IPC events and preload wiring:
  - `chat:messageStart`, `chat:messageChunk`, `chat:messageComplete`, `chat:messageError`
- Added markdown rendering support in UI (assistant messages + streaming chunks)
- Added active provider and per-provider model settings persistence + UI controls
- Added fallback/error handling to prevent settings panel from silently failing

### Goals
- Replace simulated responses with real LLM API calls
- Implement streaming response handling
- Add markdown rendering for messages
- Create provider abstraction layer

### Implementation Tasks

#### 1.1 Provider Abstraction Layer
**File:** `src/providers/base-provider.js`

Create abstract class for all LLM providers:
```javascript
class BaseLLMProvider {
  constructor(apiKey) {}

  // Core methods to implement
  async sendMessage(messages, options) {}
  async streamMessage(messages, options, onChunk) {}
  async listModels() {}
  formatMessages(chatHistory) {} // Provider-specific formatting

  // Utility methods
  validateApiKey() {}
  getDefaultModel() {}
  getHeaders() {}
}
```

#### 1.2 OpenAI Provider Implementation
**File:** `src/providers/openai-provider.js`

```javascript
class OpenAIProvider extends BaseLLMProvider {
  async sendMessage(messages, options = {}) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || 'gpt-4',
        messages: this.formatMessages(messages),
        temperature: options.temperature || 0.7,
        stream: false
      })
    });
    return response.json();
  }

  async streamMessage(messages, options, onChunk) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || 'gpt-4',
        messages: this.formatMessages(messages),
        stream: true
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') break;

          const parsed = JSON.parse(data);
          const content = parsed.choices[0]?.delta?.content;
          if (content) onChunk(content);
        }
      }
    }
  }
}
```

#### 1.3 Anthropic Provider Implementation
**File:** `src/providers/anthropic-provider.js`

```javascript
class AnthropicProvider extends BaseLLMProvider {
  async sendMessage(messages, options = {}) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || 'claude-sonnet-4-5-20250929',
        messages: this.formatMessages(messages),
        max_tokens: options.max_tokens || 4096,
        stream: false
      })
    });
    return response.json();
  }

  formatMessages(chatHistory) {
    // Anthropic requires alternating user/assistant messages
    // System messages handled separately
    return chatHistory.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    }));
  }
}
```

#### 1.4 Provider Factory
**File:** `src/providers/provider-factory.js`

```javascript
class ProviderFactory {
  static async createProvider(providerType, apiKey) {
    switch (providerType) {
      case 'openai':
        return new OpenAIProvider(apiKey);
      case 'anthropic':
        return new AnthropicProvider(apiKey);
      case 'github':
        return new GitHubCopilotProvider(apiKey);
      default:
        throw new Error(`Unknown provider: ${providerType}`);
    }
  }
}
```

#### 1.5 Update Main Process Handler
**File:** `main.js` (modifications)

Replace simulated response with real LLM call:
```javascript
ipcMain.handle('chat:sendMessage', async (event, { chatId, message }) => {
  // Get active provider from settings
  const settings = store.get('settings.providers', {});
  const activeProvider = store.get('settings.activeProvider', 'openai');

  // Decrypt token
  const encryptedToken = settings[activeProvider]?.token;
  if (!encryptedToken) {
    throw new Error('No API token configured');
  }
  const apiKey = safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'));

  // Create provider
  const provider = await ProviderFactory.createProvider(activeProvider, apiKey);

  // Get chat history
  const chat = store.get('chats', []).find(c => c.id === chatId);

  // Stream response
  let fullResponse = '';
  const responseId = Date.now();

  await provider.streamMessage(
    chat.messages,
    { model: settings[activeProvider]?.model },
    (chunk) => {
      fullResponse += chunk;
      event.sender.send('chat:messageChunk', { chatId, responseId, chunk });
    }
  );

  // Save complete message
  return addMessageToChat(chatId, 'assistant', fullResponse);
});
```

#### 1.6 Add Markdown Rendering
**File:** `renderer.js` (modifications)

Install `marked` library:
```bash
npm install marked
```

Update message rendering:
```javascript
function renderMessage(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${message.sender}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  // Render markdown
  if (message.sender === 'assistant') {
    contentDiv.innerHTML = marked.parse(message.text);
  } else {
    contentDiv.textContent = message.text;
  }

  messageDiv.appendChild(contentDiv);
  return messageDiv;
}

// Handle streaming chunks
window.electron.onMessageChunk((data) => {
  const { chatId, responseId, chunk } = data;
  if (chatId !== activeChatId) return;

  let streamElement = document.querySelector(`[data-response-id="${responseId}"]`);
  if (!streamElement) {
    streamElement = document.createElement('div');
    streamElement.className = 'message assistant streaming';
    streamElement.dataset.responseId = responseId;
    chatContent.appendChild(streamElement);
  }

  streamElement.innerHTML = marked.parse(streamElement.textContent + chunk);
});
```

#### 1.7 Update Preload Script
**File:** `preload.js` (additions)

Add streaming support:
```javascript
contextBridge.exposeInMainWorld('electron', {
  // ... existing methods ...

  onMessageChunk: (callback) => {
    ipcRenderer.on('chat:messageChunk', (event, data) => callback(data));
  }
});
```

### Deliverables
- [x] Provider abstraction layer implemented
- [x] OpenAI provider with streaming support
- [x] Anthropic provider with streaming support
- [x] Markdown rendering in UI
- [x] Active provider selection in settings
- [x] Model selection per provider
- [x] Error handling for API failures
- [ ] Token usage tracking (optional)

### Testing Checklist
- [x] Successfully connect to OpenAI API
- [ ] Successfully connect to Anthropic API
- [x] Streaming responses display correctly
- [x] Markdown formatting renders properly
- [ ] Code blocks have syntax highlighting
- [x] Error messages display when API fails
- [x] Token encryption/decryption works
- [x] Chat history persists correctly

---

## **PHASE 2: Tool System Foundation** (Core Functionality)
**Timeline:** 3-4 weeks
**Priority:** HIGH

### Goals
- Implement function calling support
- Create tool definition framework
- Build core built-in tools (Bash, Read, Edit, Write)
- Add tool execution engine with safety controls

### Implementation Tasks

#### 2.1 Tool Definition Schema
**File:** `src/tools/tool-schema.js`

```javascript
class Tool {
  constructor(config) {
    this.name = config.name;                    // e.g., "Bash"
    this.description = config.description;      // What the tool does
    this.parameters = config.parameters;        // JSON Schema for parameters
    this.execute = config.execute;              // Async function
    this.requiresApproval = config.requiresApproval || false;
    this.dangerousPatterns = config.dangerousPatterns || [];
  }

  // Convert to OpenAI/Anthropic function format
  toFunctionDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters
    };
  }

  // Validate parameters before execution
  validateParameters(params) {
    // JSON Schema validation
  }

  // Check if command matches dangerous patterns
  isDangerous(params) {
    return this.dangerousPatterns.some(pattern =>
      pattern.test(JSON.stringify(params))
    );
  }
}
```

#### 2.2 Tool Registry
**File:** `src/tools/tool-registry.js`

```javascript
class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!(tool instanceof Tool)) {
      throw new Error('Must register Tool instance');
    }
    this.tools.set(tool.name, tool);
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return Array.from(this.tools.values());
  }

  // Get function definitions for LLM
  getFunctionDefinitions() {
    return this.list().map(tool => tool.toFunctionDefinition());
  }

  // Execute tool with safety checks
  async execute(name, parameters, options = {}) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);

    // Validate parameters
    tool.validateParameters(parameters);

    // Check if dangerous
    if (tool.isDangerous(parameters) && !options.bypassSafety) {
      throw new Error(`Dangerous operation detected: ${name}`);
    }

    // Execute
    return await tool.execute(parameters, options);
  }
}

// Global registry
const registry = new ToolRegistry();
module.exports = registry;
```

#### 2.3 Core Built-in Tools

**File:** `src/tools/builtin/bash-tool.js`

```javascript
const { Tool } = require('../tool-schema');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const BashTool = new Tool({
  name: 'Bash',
  description: 'Execute shell commands. Use for git operations, file system tasks, etc.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute'
      },
      description: {
        type: 'string',
        description: 'Human-readable description of what this command does'
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000)',
        default: 120000
      }
    },
    required: ['command']
  },
  requiresApproval: true,
  dangerousPatterns: [
    /rm\s+-rf\s+\/(?!home|tmp)/,  // Prevent dangerous rm commands
    /mkfs\./,                       // Filesystem formatting
    /dd\s+if=/,                     // Disk operations
    /:(){ :|:&};:/,                // Fork bomb
  ],

  async execute(params, options) {
    const { command, timeout = 120000 } = params;

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        cwd: options.cwd || process.cwd(),
        shell: true
      });

      return {
        success: true,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0
      };
    } catch (error) {
      return {
        success: false,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        exitCode: error.code || 1
      };
    }
  }
});

module.exports = BashTool;
```

**File:** `src/tools/builtin/read-tool.js`

```javascript
const { Tool } = require('../tool-schema');
const fs = require('fs').promises;
const path = require('path');

const ReadTool = new Tool({
  name: 'Read',
  description: 'Read file contents with optional line range',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to read'
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-indexed)'
      },
      limit: {
        type: 'number',
        description: 'Number of lines to read'
      }
    },
    required: ['file_path']
  },

  async execute(params, options) {
    const { file_path, offset, limit } = params;

    // Security: Prevent directory traversal
    const resolvedPath = path.resolve(file_path);
    const workingDir = options.workingDirectory || process.cwd();
    if (!resolvedPath.startsWith(workingDir)) {
      throw new Error('Access denied: Path outside working directory');
    }

    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');

      let startLine = offset ? offset - 1 : 0;
      let endLine = limit ? startLine + limit : lines.length;

      const selectedLines = lines.slice(startLine, endLine);

      // Format with line numbers (cat -n style)
      const formatted = selectedLines
        .map((line, idx) => `${startLine + idx + 1}\t${line}`)
        .join('\n');

      return {
        success: true,
        content: formatted,
        totalLines: lines.length,
        readLines: selectedLines.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
});

module.exports = ReadTool;
```

**File:** `src/tools/builtin/edit-tool.js`

```javascript
const { Tool } = require('../tool-schema');
const fs = require('fs').promises;
const path = require('path');

const EditTool = new Tool({
  name: 'Edit',
  description: 'Perform exact string replacements in files',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit'
      },
      old_string: {
        type: 'string',
        description: 'The exact text to replace (must be unique in file)'
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with'
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false)',
        default: false
      }
    },
    required: ['file_path', 'old_string', 'new_string']
  },
  requiresApproval: true,

  async execute(params, options) {
    const { file_path, old_string, new_string, replace_all = false } = params;

    // Security check
    const resolvedPath = path.resolve(file_path);
    const workingDir = options.workingDirectory || process.cwd();
    if (!resolvedPath.startsWith(workingDir)) {
      throw new Error('Access denied');
    }

    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');

      // Check if old_string exists
      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) {
        throw new Error('old_string not found in file');
      }

      if (occurrences > 1 && !replace_all) {
        throw new Error(`old_string appears ${occurrences} times. Use replace_all=true or provide more context to make it unique.`);
      }

      // Perform replacement
      const newContent = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string);

      await fs.writeFile(resolvedPath, newContent, 'utf-8');

      return {
        success: true,
        replacements: replace_all ? occurrences : 1,
        message: `Successfully replaced ${replace_all ? occurrences : 1} occurrence(s)`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
});

module.exports = EditTool;
```

**File:** `src/tools/builtin/write-tool.js`

```javascript
const { Tool } = require('../tool-schema');
const fs = require('fs').promises;
const path = require('path');

const WriteTool = new Tool({
  name: 'Write',
  description: 'Create or overwrite a file with content',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write'
      },
      content: {
        type: 'string',
        description: 'The content to write to the file'
      }
    },
    required: ['file_path', 'content']
  },
  requiresApproval: true,

  async execute(params, options) {
    const { file_path, content } = params;

    const resolvedPath = path.resolve(file_path);
    const workingDir = options.workingDirectory || process.cwd();
    if (!resolvedPath.startsWith(workingDir)) {
      throw new Error('Access denied');
    }

    try {
      // Create parent directories if needed
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

      // Write file
      await fs.writeFile(resolvedPath, content, 'utf-8');

      return {
        success: true,
        message: `Successfully wrote ${content.length} bytes to ${file_path}`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
});

module.exports = WriteTool;
```

#### 2.4 Tool Initialization
**File:** `src/tools/index.js`

```javascript
const toolRegistry = require('./tool-registry');

// Import built-in tools
const BashTool = require('./builtin/bash-tool');
const ReadTool = require('./builtin/read-tool');
const EditTool = require('./builtin/edit-tool');
const WriteTool = require('./builtin/write-tool');

// Register all built-in tools
function initializeTools() {
  toolRegistry.register(BashTool);
  toolRegistry.register(ReadTool);
  toolRegistry.register(EditTool);
  toolRegistry.register(WriteTool);
}

module.exports = {
  toolRegistry,
  initializeTools
};
```

#### 2.5 Update Provider Classes for Function Calling

**File:** `src/providers/openai-provider.js` (additions)

```javascript
class OpenAIProvider extends BaseLLMProvider {
  async sendMessageWithTools(messages, tools, options = {}) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || 'gpt-4',
        messages: this.formatMessages(messages),
        functions: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        })),
        function_call: 'auto',
        temperature: options.temperature || 0.7
      })
    });

    const data = await response.json();
    return this.parseToolResponse(data);
  }

  parseToolResponse(response) {
    const message = response.choices[0].message;

    if (message.function_call) {
      return {
        type: 'tool_use',
        toolName: message.function_call.name,
        parameters: JSON.parse(message.function_call.arguments),
        messageContent: message.content || ''
      };
    }

    return {
      type: 'text',
      content: message.content
    };
  }
}
```

**File:** `src/providers/anthropic-provider.js` (additions)

```javascript
class AnthropicProvider extends BaseLLMProvider {
  async sendMessageWithTools(messages, tools, options = {}) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || 'claude-sonnet-4-5-20250929',
        messages: this.formatMessages(messages),
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters
        })),
        max_tokens: options.max_tokens || 4096
      })
    });

    const data = await response.json();
    return this.parseToolResponse(data);
  }

  parseToolResponse(response) {
    const content = response.content;

    // Find tool use blocks
    const toolUse = content.find(block => block.type === 'tool_use');
    const textBlocks = content.filter(block => block.type === 'text');

    if (toolUse) {
      return {
        type: 'tool_use',
        toolName: toolUse.name,
        toolUseId: toolUse.id,
        parameters: toolUse.input,
        messageContent: textBlocks.map(b => b.text).join('\n')
      };
    }

    return {
      type: 'text',
      content: textBlocks.map(b => b.text).join('\n')
    };
  }
}
```

#### 2.6 Tool Execution Engine
**File:** `src/execution/tool-executor.js`

```javascript
const { toolRegistry } = require('../tools');
const { EventEmitter } = require('events');

class ToolExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workingDirectory = options.workingDirectory;
    this.requireApproval = options.requireApproval !== false;
  }

  async execute(toolName, parameters, options = {}) {
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    // Emit pre-execution event
    this.emit('preExecute', { toolName, parameters });

    // Check if approval required
    if (tool.requiresApproval && this.requireApproval) {
      const approved = await this.requestApproval(toolName, parameters);
      if (!approved) {
        return { success: false, error: 'User denied permission' };
      }
    }

    // Execute tool
    try {
      const result = await tool.execute(parameters, {
        workingDirectory: this.workingDirectory,
        ...options
      });

      this.emit('postExecute', { toolName, parameters, result });
      return result;
    } catch (error) {
      this.emit('error', { toolName, parameters, error });
      return { success: false, error: error.message };
    }
  }

  async requestApproval(toolName, parameters) {
    // This will trigger UI approval dialog
    return new Promise((resolve) => {
      this.emit('approvalRequired', { toolName, parameters, resolve });
    });
  }
}

module.exports = ToolExecutor;
```

#### 2.7 Update Main Process for Tool Execution
**File:** `main.js` (additions)

```javascript
const { initializeTools, toolRegistry } = require('./src/tools');
const ToolExecutor = require('./src/execution/tool-executor');

// Initialize tools on startup
app.whenReady().then(() => {
  initializeTools();
  createWindow();
});

// Tool execution handler
ipcMain.handle('tool:execute', async (event, { toolName, parameters }) => {
  const executor = new ToolExecutor({
    workingDirectory: process.cwd(),
    requireApproval: true
  });

  // Forward approval requests to renderer
  executor.on('approvalRequired', ({ toolName, parameters, resolve }) => {
    event.sender.send('tool:approvalRequired', { toolName, parameters });

    ipcMain.once('tool:approvalResponse', (_, { approved }) => {
      resolve(approved);
    });
  });

  return await executor.execute(toolName, parameters);
});

// Get available tools
ipcMain.handle('tool:list', async () => {
  return toolRegistry.getFunctionDefinitions();
});
```

#### 2.8 Update Preload Script
**File:** `preload.js` (additions)

```javascript
contextBridge.exposeInMainWorld('electron', {
  // ... existing methods ...

  tool: {
    list: () => ipcRenderer.invoke('tool:list'),
    execute: (toolName, parameters) =>
      ipcRenderer.invoke('tool:execute', { toolName, parameters }),
    onApprovalRequired: (callback) =>
      ipcRenderer.on('tool:approvalRequired', (event, data) => callback(data)),
    respondToApproval: (approved) =>
      ipcRenderer.send('tool:approvalResponse', { approved })
  }
});
```

#### 2.9 Tool Approval UI
**File:** `renderer.js` (additions)

```javascript
// Listen for tool approval requests
window.electron.tool.onApprovalRequired(({ toolName, parameters }) => {
  showToolApprovalDialog(toolName, parameters);
});

function showToolApprovalDialog(toolName, parameters) {
  const modal = document.createElement('div');
  modal.className = 'tool-approval-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Tool Execution Request</h3>
      <p><strong>Tool:</strong> ${toolName}</p>
      <p><strong>Parameters:</strong></p>
      <pre>${JSON.stringify(parameters, null, 2)}</pre>
      <div class="modal-actions">
        <button class="btn-approve">Approve</button>
        <button class="btn-deny">Deny</button>
      </div>
    </div>
  `;

  modal.querySelector('.btn-approve').addEventListener('click', () => {
    window.electron.tool.respondToApproval(true);
    modal.remove();
  });

  modal.querySelector('.btn-deny').addEventListener('click', () => {
    window.electron.tool.respondToApproval(false);
    modal.remove();
  });

  document.body.appendChild(modal);
}
```

#### 2.10 Agent Loop with Tool Support
**File:** `src/execution/agent-loop.js`

```javascript
class AgentLoop {
  constructor(provider, executor) {
    this.provider = provider;
    this.executor = executor;
    this.maxIterations = 10;
  }

  async run(messages, tools) {
    let iterations = 0;
    let conversationHistory = [...messages];

    while (iterations < this.maxIterations) {
      iterations++;

      // Get response from LLM
      const response = await this.provider.sendMessageWithTools(
        conversationHistory,
        tools
      );

      if (response.type === 'text') {
        // Final response - return to user
        return {
          type: 'complete',
          content: response.content,
          iterations
        };
      }

      if (response.type === 'tool_use') {
        // Execute tool
        const toolResult = await this.executor.execute(
          response.toolName,
          response.parameters
        );

        // Add tool use + result to conversation
        conversationHistory.push({
          role: 'assistant',
          content: response.messageContent,
          tool_calls: [{
            name: response.toolName,
            parameters: response.parameters
          }]
        });

        conversationHistory.push({
          role: 'tool',
          tool_name: response.toolName,
          content: JSON.stringify(toolResult)
        });

        // Continue loop
        continue;
      }
    }

    return {
      type: 'max_iterations',
      content: 'Maximum iterations reached',
      iterations
    };
  }
}

module.exports = AgentLoop;
```

### Deliverables
- [ ] Tool definition schema and registry
- [ ] Core tools: Bash, Read, Edit, Write
- [ ] Provider updates for function calling (OpenAI + Anthropic)
- [ ] Tool execution engine with safety checks
- [ ] Permission system (approval dialogs)
- [ ] Agent loop supporting tool calls
- [ ] Tool result display in UI
- [ ] Dangerous command detection

### Testing Checklist
- [ ] Bash tool executes commands successfully
- [ ] Read tool can read files with line ranges
- [ ] Edit tool performs string replacements
- [ ] Write tool creates/overwrites files
- [ ] Approval dialog appears for dangerous operations
- [ ] Tool results are properly formatted in chat
- [ ] Agent loop executes multi-step tool sequences
- [ ] Path traversal attacks are blocked
- [ ] Dangerous commands trigger warnings

---

## **PHASE 3: Agent Orchestration** (Advanced)
**Timeline:** 3-4 weeks
**Priority:** MEDIUM

### Goals
- Implement task management system
- Add multi-agent support (parallel + serial execution)
- Create agent definitions framework
- Build orchestrator for complex workflows

### Implementation Tasks

#### 3.1 Task Management System
**File:** `src/tasks/task-manager.js`

```javascript
const { EventEmitter } = require('events');

class Task {
  constructor(config) {
    this.id = config.id || Date.now().toString();
    this.subject = config.subject;
    this.description = config.description;
    this.activeForm = config.activeForm;
    this.status = 'pending'; // pending, in_progress, completed, deleted
    this.blocks = config.blocks || [];
    this.blockedBy = config.blockedBy || [];
    this.metadata = config.metadata || {};
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  canStart() {
    return this.blockedBy.length === 0 && this.status === 'pending';
  }
}

class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
  }

  create(config) {
    const task = new Task(config);
    this.tasks.set(task.id, task);
    this.emit('taskCreated', task);
    return task;
  }

  get(taskId) {
    return this.tasks.get(taskId);
  }

  list() {
    return Array.from(this.tasks.values());
  }

  update(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    Object.assign(task, updates);
    task.updatedAt = Date.now();

    this.emit('taskUpdated', task);
    return task;
  }

  markInProgress(taskId) {
    return this.update(taskId, { status: 'in_progress' });
  }

  markCompleted(taskId) {
    const task = this.update(taskId, { status: 'completed' });

    // Unblock dependent tasks
    this.tasks.forEach(t => {
      if (t.blockedBy.includes(taskId)) {
        t.blockedBy = t.blockedBy.filter(id => id !== taskId);
        this.emit('taskUnblocked', t);
      }
    });

    return task;
  }

  getAvailableTasks() {
    return this.list().filter(t => t.canStart());
  }
}

module.exports = { Task, TaskManager };
```

#### 3.2 Agent Definition Schema
**File:** `src/agents/agent-schema.js`

```javascript
class Agent {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.model = config.model || 'sonnet';
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools || [];
    this.temperature = config.temperature || 0.7;
    this.maxIterations = config.maxIterations || 10;
  }

  canUseTool(toolName) {
    if (this.allowedTools.includes('*')) return true;
    return this.allowedTools.includes(toolName);
  }

  getSystemMessage() {
    return {
      role: 'system',
      content: this.systemPrompt
    };
  }
}

module.exports = Agent;
```

#### 3.3 Agent Executor
**File:** `src/agents/agent-executor.js`

```javascript
const AgentLoop = require('../execution/agent-loop');

class AgentExecutor {
  constructor(provider, toolExecutor) {
    this.provider = provider;
    this.toolExecutor = toolExecutor;
  }

  async execute(agent, userMessage, options = {}) {
    // Build initial messages
    const messages = [
      agent.getSystemMessage(),
      { role: 'user', content: userMessage }
    ];

    // Filter tools based on agent permissions
    const availableTools = options.tools.filter(tool =>
      agent.canUseTool(tool.name)
    );

    // Create agent loop
    const loop = new AgentLoop(this.provider, this.toolExecutor);
    loop.maxIterations = agent.maxIterations;

    // Execute
    return await loop.run(messages, availableTools);
  }
}

module.exports = AgentExecutor;
```

#### 3.4 Multi-Agent Orchestrator
**File:** `src/agents/orchestrator.js`

```javascript
class AgentOrchestrator {
  constructor(agentExecutor) {
    this.agentExecutor = agentExecutor;
  }

  // Execute agents in parallel
  async executeParallel(agents, message, options) {
    const promises = agents.map(agent =>
      this.agentExecutor.execute(agent, message, options)
    );

    return await Promise.all(promises);
  }

  // Execute agents serially
  async executeSerial(agents, initialMessage, options) {
    const results = [];
    let currentMessage = initialMessage;

    for (const agent of agents) {
      const result = await this.agentExecutor.execute(
        agent,
        currentMessage,
        options
      );

      results.push(result);

      // Pass output as input to next agent
      currentMessage = result.content;
    }

    return results;
  }

  // Execute with task dependencies
  async executeWithDependencies(taskManager, agents, options) {
    const results = new Map();

    while (true) {
      const availableTasks = taskManager.getAvailableTasks();
      if (availableTasks.length === 0) break;

      // Execute available tasks in parallel
      const promises = availableTasks.map(async task => {
        const agent = agents.find(a => a.id === task.metadata.agentId);
        if (!agent) return;

        taskManager.markInProgress(task.id);

        const result = await this.agentExecutor.execute(
          agent,
          task.description,
          options
        );

        taskManager.markCompleted(task.id);
        results.set(task.id, result);
      });

      await Promise.all(promises);
    }

    return results;
  }
}

module.exports = AgentOrchestrator;
```

#### 3.5 Built-in Agents

**File:** `src/agents/builtin/code-explorer.js`

```javascript
const Agent = require('../agent-schema');

const CodeExplorerAgent = new Agent({
  id: 'code-explorer',
  name: 'Code Explorer',
  description: 'Explores codebase to understand structure and patterns',
  model: 'sonnet',
  allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
  systemPrompt: `You are a code exploration specialist. Your job is to:
1. Search for relevant files using Glob patterns
2. Read file contents to understand structure
3. Use Grep to find specific patterns
4. Analyze code organization and architecture
5. Provide comprehensive reports on your findings

Focus on understanding the codebase structure, not making changes.`
});

module.exports = CodeExplorerAgent;
```

**File:** `src/agents/builtin/code-writer.js`

```javascript
const Agent = require('../agent-schema');

const CodeWriterAgent = new Agent({
  id: 'code-writer',
  name: 'Code Writer',
  description: 'Writes and modifies code based on requirements',
  model: 'opus',
  allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob'],
  systemPrompt: `You are a code writing specialist. Your job is to:
1. Read existing code to understand context
2. Write new code following existing patterns
3. Edit files with precise string replacements
4. Test changes with appropriate commands
5. Ensure code quality and correctness

Always read files before editing them. Follow existing code style.`
});

module.exports = CodeWriterAgent;
```

#### 3.6 IPC Handlers for Agent System
**File:** `main.js` (additions)

```javascript
const { TaskManager } = require('./src/tasks/task-manager');
const AgentExecutor = require('./src/agents/agent-executor');
const AgentOrchestrator = require('./src/agents/orchestrator');

// Global instances
let taskManager;
let agentOrchestrator;

app.whenReady().then(() => {
  // ... existing initialization ...

  taskManager = new TaskManager();

  // Forward task events to renderer
  taskManager.on('taskCreated', task => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('task:created', task);
  });

  taskManager.on('taskUpdated', task => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('task:updated', task);
  });
});

// Task management handlers
ipcMain.handle('task:create', async (event, config) => {
  return taskManager.create(config);
});

ipcMain.handle('task:list', async () => {
  return taskManager.list();
});

ipcMain.handle('task:update', async (event, { taskId, updates }) => {
  return taskManager.update(taskId, updates);
});

// Agent execution handlers
ipcMain.handle('agent:execute', async (event, { agentId, message }) => {
  const agent = loadAgent(agentId); // Load agent definition
  const provider = await getActiveProvider();
  const executor = new AgentExecutor(provider, toolExecutor);

  return await executor.execute(agent, message, {
    tools: toolRegistry.getFunctionDefinitions()
  });
});

ipcMain.handle('agent:executeParallel', async (event, { agentIds, message }) => {
  const agents = agentIds.map(loadAgent);
  const provider = await getActiveProvider();
  const executor = new AgentExecutor(provider, toolExecutor);
  const orchestrator = new AgentOrchestrator(executor);

  return await orchestrator.executeParallel(agents, message, {
    tools: toolRegistry.getFunctionDefinitions()
  });
});
```

### Deliverables
- [ ] Task management system with dependencies
- [ ] Agent definition schema
- [ ] Agent executor with tool filtering
- [ ] Multi-agent orchestrator (parallel + serial)
- [ ] Built-in agents (code-explorer, code-writer)
- [ ] Task UI in sidebar
- [ ] Agent execution progress indicators
- [ ] Task dependency visualization

### Testing Checklist
- [ ] Tasks can be created with dependencies
- [ ] Task status updates correctly (pending → in_progress → completed)
- [ ] Blocked tasks don't execute until dependencies complete
- [ ] Agents execute with filtered tool permissions
- [ ] Parallel agent execution works correctly
- [ ] Serial agent execution passes outputs correctly
- [ ] Task list UI updates in real-time
- [ ] Agent results display properly

---

## **PHASE 4: Plugin System** (Extensibility)
**Timeline:** 2-3 weeks
**Priority:** MEDIUM

### Goals
- Create plugin architecture
- Implement plugin discovery and loading
- Add plugin manifest support
- Build example plugins

### Implementation Tasks

#### 4.1 Plugin Manifest Schema
**File:** `src/plugins/plugin-schema.js`

```javascript
class PluginManifest {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.version = config.version;
    this.description = config.description;
    this.author = config.author;

    // Components
    this.commands = config.commands || [];
    this.tools = config.tools || [];
    this.agents = config.agents || [];
    this.hooks = config.hooks || [];

    // Permissions
    this.permissions = config.permissions || {
      ask: [],
      allow: [],
      deny: []
    };

    // Dependencies
    this.dependencies = config.dependencies || {};
  }

  static fromJSON(data) {
    return new PluginManifest(data);
  }
}

module.exports = PluginManifest;
```

#### 4.2 Plugin Loader
**File:** `src/plugins/plugin-loader.js`

```javascript
const fs = require('fs').promises;
const path = require('path');
const PluginManifest = require('./plugin-schema');

class PluginLoader {
  constructor(pluginDir) {
    this.pluginDir = pluginDir;
    this.plugins = new Map();
  }

  async discover() {
    const entries = await fs.readdir(this.pluginDir, { withFileTypes: true });
    const pluginDirs = entries.filter(e => e.isDirectory());

    for (const dir of pluginDirs) {
      try {
        await this.load(dir.name);
      } catch (error) {
        console.error(`Failed to load plugin ${dir.name}:`, error);
      }
    }

    return Array.from(this.plugins.values());
  }

  async load(pluginId) {
    const pluginPath = path.join(this.pluginDir, pluginId);
    const manifestPath = path.join(pluginPath, 'plugin.json');

    // Read manifest
    const manifestData = await fs.readFile(manifestPath, 'utf-8');
    const manifest = PluginManifest.fromJSON(JSON.parse(manifestData));

    // Load components
    const plugin = {
      manifest,
      commands: await this.loadCommands(pluginPath, manifest.commands),
      tools: await this.loadTools(pluginPath, manifest.tools),
      agents: await this.loadAgents(pluginPath, manifest.agents),
      hooks: await this.loadHooks(pluginPath, manifest.hooks)
    };

    this.plugins.set(pluginId, plugin);
    return plugin;
  }

  async loadCommands(pluginPath, commandDefs) {
    const commands = [];

    for (const def of commandDefs) {
      const commandPath = path.join(pluginPath, 'commands', `${def.file}.md`);
      const content = await fs.readFile(commandPath, 'utf-8');

      commands.push({
        id: def.id,
        name: def.name,
        content,
        allowedTools: def.allowedTools || []
      });
    }

    return commands;
  }

  async loadTools(pluginPath, toolDefs) {
    const tools = [];

    for (const def of toolDefs) {
      const toolPath = path.join(pluginPath, 'tools', `${def.file}.js`);
      const Tool = require(toolPath);
      tools.push(Tool);
    }

    return tools;
  }

  async loadAgents(pluginPath, agentDefs) {
    const agents = [];

    for (const def of agentDefs) {
      const agentPath = path.join(pluginPath, 'agents', `${def.file}.md`);
      const content = await fs.readFile(agentPath, 'utf-8');

      // Parse YAML frontmatter + markdown
      const agent = this.parseAgentFile(content, def);
      agents.push(agent);
    }

    return agents;
  }

  async loadHooks(pluginPath, hookDefs) {
    const hooks = [];

    for (const def of hookDefs) {
      const hookPath = path.join(pluginPath, 'hooks', `${def.file}.js`);
      const hook = require(hookPath);
      hooks.push({ ...def, handler: hook });
    }

    return hooks;
  }

  parseAgentFile(content, def) {
    // Parse YAML frontmatter
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error('Invalid agent file format');

    const yaml = require('js-yaml');
    const frontmatter = yaml.load(match[1]);
    const systemPrompt = match[2].trim();

    return {
      id: def.id,
      name: frontmatter.name || def.name,
      description: frontmatter.description,
      model: frontmatter.model || 'sonnet',
      allowedTools: frontmatter.tools || [],
      systemPrompt
    };
  }

  get(pluginId) {
    return this.plugins.get(pluginId);
  }

  list() {
    return Array.from(this.plugins.values());
  }
}

module.exports = PluginLoader;
```

#### 4.3 Plugin Manager
**File:** `src/plugins/plugin-manager.js`

```javascript
const PluginLoader = require('./plugin-loader');
const toolRegistry = require('../tools/tool-registry');

class PluginManager {
  constructor(pluginDir) {
    this.loader = new PluginLoader(pluginDir);
    this.enabledPlugins = new Set();
  }

  async initialize() {
    await this.loader.discover();

    // Auto-enable all discovered plugins
    for (const plugin of this.loader.list()) {
      await this.enable(plugin.manifest.id);
    }
  }

  async enable(pluginId) {
    const plugin = this.loader.get(pluginId);
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

    // Register tools
    for (const tool of plugin.tools) {
      toolRegistry.register(tool);
    }

    // Register commands (handled by command system)
    // Register agents (handled by agent system)
    // Register hooks (handled by hook system)

    this.enabledPlugins.add(pluginId);
  }

  disable(pluginId) {
    this.enabledPlugins.delete(pluginId);

    // TODO: Unregister components
  }

  getEnabled() {
    return Array.from(this.enabledPlugins).map(id => this.loader.get(id));
  }
}

module.exports = PluginManager;
```

#### 4.4 Example Plugin Structure

**File:** `plugins/example-plugin/plugin.json`

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "description": "Example plugin demonstrating King Louie extensibility",
  "author": "Your Name",
  "commands": [
    {
      "id": "hello-world",
      "name": "Hello World",
      "file": "hello-world",
      "allowedTools": ["Bash"]
    }
  ],
  "tools": [
    {
      "id": "custom-tool",
      "file": "custom-tool"
    }
  ],
  "agents": [
    {
      "id": "example-agent",
      "name": "Example Agent",
      "file": "example-agent"
    }
  ],
  "hooks": [
    {
      "event": "PreToolUse",
      "file": "pre-tool-hook"
    }
  ],
  "permissions": {
    "ask": ["Bash"],
    "allow": ["Read"],
    "deny": ["Write"]
  }
}
```

**File:** `plugins/example-plugin/commands/hello-world.md`

```markdown
---
name: hello-world
description: Prints a hello world message
allowed-tools: Bash(echo:*)
---

## Instructions

Use the Bash tool to execute `echo "Hello, World!"` and return the result to the user.
```

**File:** `plugins/example-plugin/tools/custom-tool.js`

```javascript
const { Tool } = require('../../../src/tools/tool-schema');

const CustomTool = new Tool({
  name: 'CustomTool',
  description: 'Example custom tool from plugin',
  parameters: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Input string to process'
      }
    },
    required: ['input']
  },

  async execute(params) {
    return {
      success: true,
      output: `Processed: ${params.input.toUpperCase()}`
    };
  }
});

module.exports = CustomTool;
```

**File:** `plugins/example-plugin/agents/example-agent.md`

```markdown
---
name: Example Agent
description: Demonstrates agent capabilities
model: sonnet
tools:
  - Bash
  - Read
---

You are an example agent demonstrating King Louie's agent system.

Your goal is to help users understand how agents work by:
1. Executing simple tasks
2. Using tools appropriately
3. Providing clear explanations

Always be helpful and educational.
```

**File:** `plugins/example-plugin/hooks/pre-tool-hook.js`

```javascript
module.exports = async function preToolHook(context) {
  const { toolName, parameters } = context;

  // Log tool usage
  console.log(`[Plugin] About to execute: ${toolName}`);
  console.log(`[Plugin] Parameters:`, parameters);

  // Allow execution
  return { allowed: true };
};
```

#### 4.5 Update Main Process
**File:** `main.js` (additions)

```javascript
const PluginManager = require('./src/plugins/plugin-manager');
const path = require('path');

let pluginManager;

app.whenReady().then(async () => {
  // ... existing initialization ...

  // Initialize plugin system
  const pluginDir = path.join(app.getPath('userData'), 'plugins');
  pluginManager = new PluginManager(pluginDir);
  await pluginManager.initialize();

  console.log(`Loaded ${pluginManager.getEnabled().length} plugins`);
});

// Plugin management handlers
ipcMain.handle('plugin:list', async () => {
  return pluginManager.loader.list().map(p => p.manifest);
});

ipcMain.handle('plugin:enable', async (event, { pluginId }) => {
  await pluginManager.enable(pluginId);
});

ipcMain.handle('plugin:disable', async (event, { pluginId }) => {
  pluginManager.disable(pluginId);
});
```

### Deliverables
- [ ] Plugin manifest schema
- [ ] Plugin loader with component discovery
- [ ] Plugin manager with enable/disable
- [ ] Example plugin with all component types
- [ ] Plugin UI in settings
- [ ] Plugin installation system
- [ ] Plugin documentation

### Testing Checklist
- [ ] Plugins are discovered on startup
- [ ] Plugin components load correctly
- [ ] Plugin tools register with tool registry
- [ ] Plugin agents execute properly
- [ ] Plugin hooks fire at correct times
- [ ] Plugins can be enabled/disabled
- [ ] Multiple plugins work together
- [ ] Plugin permissions are enforced

---

## **PHASE 5: Hook System & Automation** (Advanced)
**Timeline:** 2 weeks
**Priority:** LOW

### Goals
- Implement event-driven hook system
- Add pre/post tool execution hooks
- Create session lifecycle hooks
- Build security validation hooks

### Implementation Tasks

#### 5.1 Hook Event System
**File:** `src/hooks/hook-system.js`

```javascript
const { EventEmitter } = require('events');

class HookSystem extends EventEmitter {
  constructor() {
    super();
    this.hooks = new Map();
  }

  register(event, hook) {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }

    this.hooks.get(event).push(hook);
  }

  async trigger(event, context) {
    const hooks = this.hooks.get(event) || [];

    for (const hook of hooks) {
      const result = await hook(context);

      // If any hook blocks, stop execution
      if (result && result.allowed === false) {
        return { allowed: false, reason: result.reason };
      }
    }

    return { allowed: true };
  }

  unregister(event, hook) {
    const hooks = this.hooks.get(event);
    if (!hooks) return;

    const index = hooks.indexOf(hook);
    if (index !== -1) {
      hooks.splice(index, 1);
    }
  }

  clear(event) {
    if (event) {
      this.hooks.delete(event);
    } else {
      this.hooks.clear();
    }
  }
}

// Global instance
const hookSystem = new HookSystem();

module.exports = hookSystem;
```

#### 5.2 Built-in Hooks

**File:** `src/hooks/builtin/security-hook.js`

```javascript
const hookSystem = require('../hook-system');

// Security patterns to detect
const SECURITY_PATTERNS = [
  {
    name: 'Command Injection',
    pattern: /eval\(|exec\(|system\(/i,
    severity: 'high',
    message: 'Potential command injection vulnerability detected'
  },
  {
    name: 'SQL Injection',
    pattern: /execute\s*\(\s*["']SELECT.*WHERE.*["']\s*\+/i,
    severity: 'high',
    message: 'Potential SQL injection vulnerability detected'
  },
  {
    name: 'XSS',
    pattern: /dangerouslySetInnerHTML|innerHTML\s*=/i,
    severity: 'medium',
    message: 'Potential XSS vulnerability detected'
  },
  {
    name: 'Hardcoded Secrets',
    pattern: /password\s*=\s*["'][^"']+["']|api_key\s*=\s*["'][^"']+["']/i,
    severity: 'high',
    message: 'Hardcoded credentials detected'
  }
];

async function securityHook(context) {
  const { toolName, parameters } = context;

  // Only check Edit/Write operations
  if (!['Edit', 'Write'].includes(toolName)) {
    return { allowed: true };
  }

  const content = parameters.content || parameters.new_string || '';
  const violations = [];

  // Check for security patterns
  for (const pattern of SECURITY_PATTERNS) {
    if (pattern.pattern.test(content)) {
      violations.push(pattern);
    }
  }

  if (violations.length > 0) {
    const messages = violations.map(v =>
      `⚠️ ${v.name} (${v.severity}): ${v.message}`
    ).join('\n');

    console.warn(`\n[SECURITY WARNING]\n${messages}\n`);

    // Don't block, just warn
    return { allowed: true, warnings: violations };
  }

  return { allowed: true };
}

// Register hook
hookSystem.register('PreToolUse', securityHook);

module.exports = securityHook;
```

**File:** `src/hooks/builtin/logging-hook.js`

```javascript
const hookSystem = require('../hook-system');
const fs = require('fs').promises;
const path = require('path');

async function loggingHook(context) {
  const { toolName, parameters } = context;

  const logEntry = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    parameters: JSON.stringify(parameters),
    event: 'PreToolUse'
  };

  // Append to log file
  const logPath = path.join(process.cwd(), 'king-louie.log');
  await fs.appendFile(logPath, JSON.stringify(logEntry) + '\n');

  return { allowed: true };
}

hookSystem.register('PreToolUse', loggingHook);
hookSystem.register('PostToolUse', loggingHook);

module.exports = loggingHook;
```

#### 5.3 Session Lifecycle Hooks

**File:** `src/hooks/builtin/session-hooks.js`

```javascript
const hookSystem = require('../hook-system');

async function sessionStartHook(context) {
  console.log('[Session] Starting new session...');

  // Initialize session state
  context.session = {
    startTime: Date.now(),
    toolsUsed: 0,
    messagesExchanged: 0
  };

  return { allowed: true };
}

async function sessionStopHook(context) {
  const duration = Date.now() - context.session.startTime;

  console.log(`[Session] Session ended after ${duration}ms`);
  console.log(`[Session] Tools used: ${context.session.toolsUsed}`);
  console.log(`[Session] Messages: ${context.session.messagesExchanged}`);

  return { allowed: true };
}

hookSystem.register('SessionStart', sessionStartHook);
hookSystem.register('SessionStop', sessionStopHook);

module.exports = { sessionStartHook, sessionStopHook };
```

#### 5.4 Update Tool Executor
**File:** `src/execution/tool-executor.js` (modifications)

```javascript
const hookSystem = require('../hooks/hook-system');

class ToolExecutor extends EventEmitter {
  async execute(toolName, parameters, options = {}) {
    const tool = toolRegistry.get(toolName);
    if (!tool) throw new Error(`Tool not found: ${toolName}`);

    // Trigger PreToolUse hooks
    const preResult = await hookSystem.trigger('PreToolUse', {
      toolName,
      parameters,
      tool
    });

    if (!preResult.allowed) {
      return {
        success: false,
        error: `Blocked by hook: ${preResult.reason}`,
        warnings: preResult.warnings
      };
    }

    // Display warnings if any
    if (preResult.warnings) {
      this.emit('warnings', preResult.warnings);
    }

    // ... existing approval check ...

    // Execute tool
    try {
      const result = await tool.execute(parameters, options);

      // Trigger PostToolUse hooks
      await hookSystem.trigger('PostToolUse', {
        toolName,
        parameters,
        result
      });

      return result;
    } catch (error) {
      await hookSystem.trigger('ToolError', {
        toolName,
        parameters,
        error
      });
      throw error;
    }
  }
}
```

#### 5.5 Hook Configuration UI

**File:** `renderer.js` (additions)

```javascript
async function loadHookSettings() {
  const hooks = await window.electron.hooks.list();

  const hookList = document.getElementById('hook-list');
  hookList.innerHTML = '';

  for (const hook of hooks) {
    const hookCard = document.createElement('div');
    hookCard.className = 'hook-card';
    hookCard.innerHTML = `
      <div class="hook-header">
        <h4>${hook.name}</h4>
        <label class="toggle">
          <input type="checkbox" ${hook.enabled ? 'checked' : ''}
                 data-hook-id="${hook.id}">
          <span class="slider"></span>
        </label>
      </div>
      <p>${hook.description}</p>
      <div class="hook-meta">
        <span>Event: ${hook.event}</span>
        <span>Plugin: ${hook.plugin || 'Built-in'}</span>
      </div>
    `;

    hookList.appendChild(hookCard);
  }

  // Add event listeners for toggles
  document.querySelectorAll('.hook-card input[type="checkbox"]').forEach(toggle => {
    toggle.addEventListener('change', async (e) => {
      const hookId = e.target.dataset.hookId;
      const enabled = e.target.checked;

      await window.electron.hooks.setEnabled(hookId, enabled);
    });
  });
}
```

### Deliverables
- [ ] Hook event system
- [ ] Security validation hooks
- [ ] Logging hooks
- [ ] Session lifecycle hooks
- [ ] Hook configuration UI
- [ ] Hook enable/disable functionality
- [ ] Hook documentation

### Testing Checklist
- [ ] PreToolUse hooks fire before tool execution
- [ ] PostToolUse hooks fire after tool execution
- [ ] Security hooks detect common vulnerabilities
- [ ] Hooks can block tool execution
- [ ] Session hooks track lifecycle
- [ ] Hooks can be enabled/disabled
- [ ] Multiple hooks execute in order
- [ ] Hook warnings display in UI

---

## **PHASE 6: Permission System** (Security)
**Timeline:** 2 weeks
**Priority:** MEDIUM

### Goals
- Implement multi-layer permission system
- Add tool-level permissions
- Create command-level restrictions
- Build permission profiles (sandbox modes)

### Implementation Tasks

#### 6.1 Permission Manager
**File:** `src/permissions/permission-manager.js`

```javascript
class PermissionManager {
  constructor() {
    this.globalPermissions = {
      ask: [],      // Always require approval
      allow: [],    // Always allow
      deny: []      // Always deny
    };

    this.commandPermissions = new Map(); // Command-specific
    this.pluginPermissions = new Map();  // Plugin-specific
  }

  setGlobalPermissions(permissions) {
    this.globalPermissions = { ...this.globalPermissions, ...permissions };
  }

  setCommandPermissions(commandId, permissions) {
    this.commandPermissions.set(commandId, permissions);
  }

  async checkPermission(toolName, parameters, context = {}) {
    // 1. Check global deny list
    if (this.isGloballyDenied(toolName, parameters)) {
      return {
        allowed: false,
        reason: 'Tool is globally denied'
      };
    }

    // 2. Check command-specific permissions
    if (context.commandId) {
      const commandCheck = this.checkCommandPermission(
        context.commandId,
        toolName,
        parameters
      );

      if (commandCheck.allowed === false) {
        return commandCheck;
      }
    }

    // 3. Check global allow list
    if (this.isGloballyAllowed(toolName, parameters)) {
      return { allowed: true, requiresApproval: false };
    }

    // 4. Check global ask list
    if (this.isInAskList(toolName, parameters)) {
      return { allowed: true, requiresApproval: true };
    }

    // 5. Default behavior (require approval)
    return { allowed: true, requiresApproval: true };
  }

  isGloballyDenied(toolName, parameters) {
    return this.matchesPatterns(this.globalPermissions.deny, toolName, parameters);
  }

  isGloballyAllowed(toolName, parameters) {
    return this.matchesPatterns(this.globalPermissions.allow, toolName, parameters);
  }

  isInAskList(toolName, parameters) {
    return this.matchesPatterns(this.globalPermissions.ask, toolName, parameters);
  }

  matchesPatterns(patterns, toolName, parameters) {
    for (const pattern of patterns) {
      if (this.matchesPattern(pattern, toolName, parameters)) {
        return true;
      }
    }
    return false;
  }

  matchesPattern(pattern, toolName, parameters) {
    // Format: "ToolName" or "ToolName(command:*)"
    if (typeof pattern === 'string') {
      const match = pattern.match(/^(\w+)(?:\(([^)]+)\))?$/);
      if (!match) return false;

      const [, patternTool, patternCommand] = match;

      // Check tool name
      if (patternTool !== '*' && patternTool !== toolName) {
        return false;
      }

      // Check command pattern if specified
      if (patternCommand && toolName === 'Bash') {
        return this.matchesCommandPattern(patternCommand, parameters.command);
      }

      return true;
    }

    return false;
  }

  matchesCommandPattern(pattern, command) {
    // Convert pattern to regex
    // "git commit:*" -> /^git commit.*/
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(command);
  }

  checkCommandPermission(commandId, toolName, parameters) {
    const permissions = this.commandPermissions.get(commandId);
    if (!permissions) {
      return { allowed: true, requiresApproval: true };
    }

    // Check if tool is in command's allowed list
    const allowedTools = permissions.allowedTools || [];

    for (const pattern of allowedTools) {
      if (this.matchesPattern(pattern, toolName, parameters)) {
        return { allowed: true, requiresApproval: false };
      }
    }

    // Not in allowed list - deny by default for commands with allowedTools
    if (allowedTools.length > 0) {
      return {
        allowed: false,
        reason: 'Tool not allowed by command permissions'
      };
    }

    return { allowed: true, requiresApproval: true };
  }
}

module.exports = PermissionManager;
```

#### 6.2 Permission Profiles
**File:** `src/permissions/profiles.js`

```javascript
const PERMISSION_PROFILES = {
  // Most restrictive - require approval for everything
  strict: {
    ask: ['*'],
    allow: [],
    deny: []
  },

  // Balanced - allow safe operations, ask for risky ones
  balanced: {
    ask: ['Bash', 'Edit', 'Write'],
    allow: ['Read', 'Glob', 'Grep'],
    deny: []
  },

  // Permissive - allow most things except destructive operations
  permissive: {
    ask: [],
    allow: ['*'],
    deny: [
      'Bash(rm -rf:*)',
      'Bash(mkfs:*)',
      'Bash(dd:*)',
      'Bash(format:*)'
    ]
  },

  // Sandbox - restrict to safe operations only
  sandbox: {
    ask: ['Bash(git:*)', 'Edit', 'Write'],
    allow: ['Read', 'Glob', 'Grep'],
    deny: [
      'Bash(rm:*)',
      'Bash(curl:*)',
      'Bash(wget:*)',
      'Bash(ssh:*)',
      'Bash(sudo:*)'
    ]
  }
};

module.exports = PERMISSION_PROFILES;
```

#### 6.3 Update Tool Executor with Permissions
**File:** `src/execution/tool-executor.js` (modifications)

```javascript
const PermissionManager = require('../permissions/permission-manager');

class ToolExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workingDirectory = options.workingDirectory;
    this.permissionManager = options.permissionManager || new PermissionManager();
  }

  async execute(toolName, parameters, options = {}) {
    const tool = toolRegistry.get(toolName);
    if (!tool) throw new Error(`Tool not found: ${toolName}`);

    // Check permissions
    const permissionCheck = await this.permissionManager.checkPermission(
      toolName,
      parameters,
      options.context || {}
    );

    if (!permissionCheck.allowed) {
      return {
        success: false,
        error: `Permission denied: ${permissionCheck.reason}`
      };
    }

    // Trigger PreToolUse hooks
    const preResult = await hookSystem.trigger('PreToolUse', {
      toolName,
      parameters,
      tool
    });

    if (!preResult.allowed) {
      return {
        success: false,
        error: `Blocked by hook: ${preResult.reason}`
      };
    }

    // Check if approval required
    if (permissionCheck.requiresApproval) {
      const approved = await this.requestApproval(toolName, parameters);
      if (!approved) {
        return { success: false, error: 'User denied permission' };
      }
    }

    // Execute tool
    // ... rest of existing implementation ...
  }
}
```

#### 6.4 Permission UI
**File:** `renderer.js` (additions)

```javascript
async function loadPermissionSettings() {
  const profiles = await window.electron.permissions.getProfiles();
  const currentProfile = await window.electron.permissions.getCurrentProfile();

  const profileSelect = document.getElementById('permission-profile');
  profileSelect.innerHTML = '';

  for (const [id, profile] of Object.entries(profiles)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id.charAt(0).toUpperCase() + id.slice(1);
    option.selected = id === currentProfile;
    profileSelect.appendChild(option);
  }

  profileSelect.addEventListener('change', async (e) => {
    await window.electron.permissions.setProfile(e.target.value);
    showNotification('Permission profile updated');
  });

  // Custom permissions editor
  const customPermissions = await window.electron.permissions.getCustom();

  document.getElementById('permissions-ask').value =
    customPermissions.ask.join('\n');
  document.getElementById('permissions-allow').value =
    customPermissions.allow.join('\n');
  document.getElementById('permissions-deny').value =
    customPermissions.deny.join('\n');
}

async function saveCustomPermissions() {
  const ask = document.getElementById('permissions-ask').value
    .split('\n')
    .filter(line => line.trim());
  const allow = document.getElementById('permissions-allow').value
    .split('\n')
    .filter(line => line.trim());
  const deny = document.getElementById('permissions-deny').value
    .split('\n')
    .filter(line => line.trim());

  await window.electron.permissions.setCustom({ ask, allow, deny });
  showNotification('Custom permissions saved');
}
```

### Deliverables
- [ ] Permission manager with multi-layer checks
- [ ] Permission profiles (strict, balanced, permissive, sandbox)
- [ ] Command-level permission enforcement
- [ ] Plugin-level permission isolation
- [ ] Permission UI in settings
- [ ] Custom permission editor
- [ ] Permission documentation

### Testing Checklist
- [ ] Global deny list blocks tools
- [ ] Global allow list bypasses approval
- [ ] Command permissions override global
- [ ] Permission profiles switch correctly
- [ ] Custom permissions save and load
- [ ] Denied tools show clear error messages
- [ ] Permission UI updates in real-time
- [ ] Sandbox mode restricts dangerous operations

---

## **PHASE 7: Advanced Features** (Polish)
**Timeline:** 2-3 weeks
**Priority:** LOW

### Goals
- Add streaming response display with proper rendering
- Implement code syntax highlighting
- Add file attachment support
- Create conversation export/import
- Build analytics and telemetry

### Implementation Tasks

#### 7.1 Enhanced Message Rendering

**File:** `renderer.js` (enhancements)

```javascript
// Install dependencies
// npm install marked highlight.js mermaid

const marked = require('marked');
const hljs = require('highlight.js');
const mermaid = require('mermaid');

// Configure marked with syntax highlighting
marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (err) {}
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true
});

// Initialize mermaid for diagrams
mermaid.initialize({
  startOnLoad: true,
  theme: 'default',
  securityLevel: 'loose'
});

function renderMessage(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${message.sender}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  if (message.sender === 'assistant') {
    // Render markdown with syntax highlighting
    contentDiv.innerHTML = marked.parse(message.text);

    // Process code blocks for copy button
    contentDiv.querySelectorAll('pre code').forEach(block => {
      const pre = block.parentElement;
      const copyButton = document.createElement('button');
      copyButton.className = 'copy-button';
      copyButton.textContent = 'Copy';
      copyButton.onclick = () => {
        navigator.clipboard.writeText(block.textContent);
        copyButton.textContent = 'Copied!';
        setTimeout(() => copyButton.textContent = 'Copy', 2000);
      };
      pre.appendChild(copyButton);
    });

    // Render mermaid diagrams
    contentDiv.querySelectorAll('code.language-mermaid').forEach(block => {
      const pre = block.parentElement;
      const mermaidDiv = document.createElement('div');
      mermaidDiv.className = 'mermaid';
      mermaidDiv.textContent = block.textContent;
      pre.replaceWith(mermaidDiv);
    });

    // Re-render mermaid
    mermaid.init(undefined, contentDiv.querySelectorAll('.mermaid'));
  } else {
    contentDiv.textContent = message.text;
  }

  messageDiv.appendChild(contentDiv);

  // Add metadata (timestamp, etc.)
  const metaDiv = document.createElement('div');
  metaDiv.className = 'message-meta';
  metaDiv.textContent = new Date(message.timestamp).toLocaleTimeString();
  messageDiv.appendChild(metaDiv);

  return messageDiv;
}
```

#### 7.2 File Attachment Support

**File:** `src/tools/builtin/attachment-tool.js`

```javascript
const { Tool } = require('../tool-schema');
const fs = require('fs').promises;
const path = require('path');

const AttachmentTool = new Tool({
  name: 'ReadAttachment',
  description: 'Read content from uploaded file attachments',
  parameters: {
    type: 'object',
    properties: {
      attachment_id: {
        type: 'string',
        description: 'ID of the attachment to read'
      }
    },
    required: ['attachment_id']
  },

  async execute(params, options) {
    const attachmentPath = options.attachments?.[params.attachment_id];
    if (!attachmentPath) {
      throw new Error('Attachment not found');
    }

    const content = await fs.readFile(attachmentPath, 'utf-8');

    return {
      success: true,
      content,
      filename: path.basename(attachmentPath)
    };
  }
});

module.exports = AttachmentTool;
```

**File:** `main.js` (additions)

```javascript
const { dialog } = require('electron');

// File attachment handler
ipcMain.handle('chat:attachFile', async (event, { chatId }) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Text Files', extensions: ['txt', 'md', 'js', 'py', 'json'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif'] }
    ]
  });

  if (result.canceled) return null;

  const attachments = [];

  for (const filePath of result.filePaths) {
    const attachment = {
      id: Date.now() + Math.random(),
      path: filePath,
      filename: path.basename(filePath),
      size: (await fs.stat(filePath)).size,
      mimeType: getMimeType(filePath)
    };

    attachments.push(attachment);
  }

  // Store attachments with chat
  const chats = store.get('chats', []);
  const chat = chats.find(c => c.id === chatId);
  if (chat) {
    chat.attachments = [...(chat.attachments || []), ...attachments];
    store.set('chats', chats);
  }

  return attachments;
});
```

#### 7.3 Conversation Export/Import

**File:** `main.js` (additions)

```javascript
// Export conversation
ipcMain.handle('chat:export', async (event, { chatId }) => {
  const chats = store.get('chats', []);
  const chat = chats.find(c => c.id === chatId);
  if (!chat) throw new Error('Chat not found');

  const result = await dialog.showSaveDialog({
    defaultPath: `conversation-${chat.title}-${Date.now()}.json`,
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'Markdown', extensions: ['md'] }
    ]
  });

  if (result.canceled) return;

  const ext = path.extname(result.filePath);

  if (ext === '.json') {
    await fs.writeFile(result.filePath, JSON.stringify(chat, null, 2));
  } else if (ext === '.md') {
    const markdown = convertChatToMarkdown(chat);
    await fs.writeFile(result.filePath, markdown);
  }

  return result.filePath;
});

// Import conversation
ipcMain.handle('chat:import', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'JSON', extensions: ['json'] }
    ]
  });

  if (result.canceled) return null;

  const content = await fs.readFile(result.filePaths[0], 'utf-8');
  const chat = JSON.parse(content);

  // Generate new ID
  chat.id = Date.now().toString();
  chat.timestamp = Date.now();

  // Add to chats
  const chats = store.get('chats', []);
  chats.unshift(chat);
  store.set('chats', chats);

  return chat;
});

function convertChatToMarkdown(chat) {
  let md = `# ${chat.title}\n\n`;
  md += `Created: ${new Date(chat.createdAt).toLocaleString()}\n\n`;
  md += `---\n\n`;

  for (const message of chat.messages) {
    const sender = message.sender === 'user' ? 'User' : 'Assistant';
    md += `## ${sender}\n\n`;
    md += `${message.text}\n\n`;
    md += `---\n\n`;
  }

  return md;
}
```

#### 7.4 Analytics & Telemetry

**File:** `src/analytics/analytics.js`

```javascript
class Analytics {
  constructor() {
    this.events = [];
    this.sessionStart = Date.now();
  }

  track(eventName, properties = {}) {
    const event = {
      name: eventName,
      timestamp: Date.now(),
      sessionTime: Date.now() - this.sessionStart,
      properties
    };

    this.events.push(event);

    // Emit for real-time processing
    this.emit(eventName, event);
  }

  getStats() {
    const stats = {
      totalEvents: this.events.length,
      sessionDuration: Date.now() - this.sessionStart,
      eventCounts: {},
      toolUsage: {},
      providerUsage: {}
    };

    for (const event of this.events) {
      // Count events by type
      stats.eventCounts[event.name] =
        (stats.eventCounts[event.name] || 0) + 1;

      // Count tool usage
      if (event.name === 'tool:executed') {
        const tool = event.properties.toolName;
        stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + 1;
      }

      // Count provider usage
      if (event.name === 'message:sent') {
        const provider = event.properties.provider;
        stats.providerUsage[provider] =
          (stats.providerUsage[provider] || 0) + 1;
      }
    }

    return stats;
  }

  emit(eventName, event) {
    // Override in subclass to send to external analytics service
    console.log(`[Analytics] ${eventName}`, event.properties);
  }
}

module.exports = Analytics;
```

**Usage in main.js:**

```javascript
const Analytics = require('./src/analytics/analytics');
const analytics = new Analytics();

// Track events
ipcMain.handle('chat:sendMessage', async (event, data) => {
  analytics.track('message:sent', {
    provider: data.provider,
    messageLength: data.message.length
  });

  // ... existing implementation ...
});

ipcMain.handle('tool:execute', async (event, data) => {
  const startTime = Date.now();
  const result = await executor.execute(data.toolName, data.parameters);

  analytics.track('tool:executed', {
    toolName: data.toolName,
    duration: Date.now() - startTime,
    success: result.success
  });

  return result;
});

// Get analytics
ipcMain.handle('analytics:getStats', async () => {
  return analytics.getStats();
});
```

### Deliverables
- [ ] Syntax highlighting for code blocks
- [ ] Copy button for code blocks
- [ ] Mermaid diagram rendering
- [ ] File attachment support
- [ ] Conversation export (JSON + Markdown)
- [ ] Conversation import
- [ ] Analytics tracking
- [ ] Stats dashboard

### Testing Checklist
- [ ] Code blocks display with syntax highlighting
- [ ] Copy button works correctly
- [ ] Mermaid diagrams render properly
- [ ] Files can be attached to messages
- [ ] Attachments are accessible by tools
- [ ] Conversations export correctly
- [ ] Exported conversations can be re-imported
- [ ] Analytics tracks events accurately
- [ ] Stats dashboard displays correctly

---

## **PHASE 8: Additional Tools** (Expansion)
**Timeline:** 2-3 weeks
**Priority:** LOW

### Goals
- Add remaining core tools from Claude Code
- Implement Glob (pattern file search)
- Implement Grep (content search)
- Implement WebFetch (URL content retrieval)
- Implement WebSearch (search engine integration)

### Implementation Tasks

#### 8.1 Glob Tool

**File:** `src/tools/builtin/glob-tool.js`

```javascript
const { Tool } = require('../tool-schema');
const glob = require('glob');
const { promisify } = require('util');
const globAsync = promisify(glob);

const GlobTool = new Tool({
  name: 'Glob',
  description: 'Search for files matching a pattern (e.g., "**/*.js")',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g., "**/*.js", "src/**/*.tsx")'
      },
      path: {
        type: 'string',
        description: 'Directory to search in (defaults to current directory)'
      }
    },
    required: ['pattern']
  },

  async execute(params, options) {
    const { pattern, path: searchPath } = params;
    const cwd = searchPath || options.workingDirectory || process.cwd();

    try {
      const files = await globAsync(pattern, {
        cwd,
        absolute: false,
        nodir: true,
        dot: false
      });

      // Sort by modification time (most recent first)
      const sortedFiles = files.sort((a, b) => {
        const statA = fs.statSync(path.join(cwd, a));
        const statB = fs.statSync(path.join(cwd, b));
        return statB.mtimeMs - statA.mtimeMs;
      });

      return {
        success: true,
        files: sortedFiles,
        count: sortedFiles.length,
        pattern,
        searchPath: cwd
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
});

module.exports = GlobTool;
```

#### 8.2 Grep Tool

**File:** `src/tools/builtin/grep-tool.js`

```javascript
const { Tool } = require('../tool-schema');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const GrepTool = new Tool({
  name: 'Grep',
  description: 'Search for patterns in file contents using regex',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for'
      },
      path: {
        type: 'string',
        description: 'File or directory to search in'
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "*.js")'
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output format: content (show matching lines), files_with_matches (just file paths), count (match counts)'
      },
      context: {
        type: 'number',
        description: 'Number of lines to show before and after each match'
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case insensitive search'
      }
    },
    required: ['pattern']
  },

  async execute(params, options) {
    const {
      pattern,
      path = '.',
      glob: globPattern,
      output_mode = 'files_with_matches',
      context,
      case_insensitive
    } = params;

    const cwd = options.workingDirectory || process.cwd();

    // Build ripgrep command (faster than grep)
    let command = `rg "${pattern}"`;

    if (case_insensitive) command += ' -i';
    if (globPattern) command += ` --glob "${globPattern}"`;
    if (context) command += ` -C ${context}`;

    if (output_mode === 'files_with_matches') {
      command += ' -l';
    } else if (output_mode === 'count') {
      command += ' -c';
    } else {
      command += ' -n'; // Show line numbers
    }

    command += ` ${path}`;

    try {
      const { stdout } = await execAsync(command, { cwd });

      return {
        success: true,
        output: stdout.trim(),
        pattern,
        mode: output_mode
      };
    } catch (error) {
      // Exit code 1 means no matches (not an error)
      if (error.code === 1) {
        return {
          success: true,
          output: '',
          pattern,
          mode: output_mode,
          matches: 0
        };
      }

      return {
        success: false,
        error: error.message
      };
    }
  }
});

module.exports = GrepTool;
```

#### 8.3 WebFetch Tool

**File:** `src/tools/builtin/webfetch-tool.js`

```javascript
const { Tool } = require('../tool-schema');
const TurndownService = require('turndown');
const turndown = new TurndownService();

const WebFetchTool = new Tool({
  name: 'WebFetch',
  description: 'Fetch content from a URL and convert to markdown',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'The URL to fetch'
      },
      prompt: {
        type: 'string',
        description: 'Optional prompt to process the content with AI'
      }
    },
    required: ['url']
  },

  async execute(params, options) {
    const { url, prompt } = params;

    try {
      // Fetch URL
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'KingLouie/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');

      // Handle different content types
      if (contentType?.includes('text/html')) {
        const html = await response.text();
        const markdown = turndown.turndown(html);

        // If prompt provided, process with LLM
        if (prompt && options.provider) {
          const result = await options.provider.sendMessage([
            { role: 'user', content: `${prompt}\n\nContent:\n${markdown}` }
          ]);

          return {
            success: true,
            url,
            content: result.content,
            processed: true
          };
        }

        return {
          success: true,
          url,
          content: markdown,
          processed: false
        };
      } else {
        const text = await response.text();

        return {
          success: true,
          url,
          content: text,
          contentType
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        url
      };
    }
  }
});

module.exports = WebFetchTool;
```

#### 8.4 WebSearch Tool

**File:** `src/tools/builtin/websearch-tool.js`

```javascript
const { Tool } = require('../tool-schema');

const WebSearchTool = new Tool({
  name: 'WebSearch',
  description: 'Search the web using a search engine',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
        minLength: 2
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include results from these domains'
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude results from these domains'
      }
    },
    required: ['query']
  },

  async execute(params, options) {
    const { query, allowed_domains, blocked_domains } = params;

    // Use DuckDuckGo API (no API key required)
    const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`;

    try {
      const response = await fetch(searchUrl);
      const data = await response.json();

      let results = data.RelatedTopics || [];

      // Filter by domains
      if (allowed_domains?.length > 0) {
        results = results.filter(r =>
          allowed_domains.some(domain => r.FirstURL?.includes(domain))
        );
      }

      if (blocked_domains?.length > 0) {
        results = results.filter(r =>
          !blocked_domains.some(domain => r.FirstURL?.includes(domain))
        );
      }

      // Format results
      const formatted = results.slice(0, 10).map(r => ({
        title: r.Text,
        url: r.FirstURL,
        snippet: r.Text
      }));

      return {
        success: true,
        query,
        results: formatted,
        count: formatted.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
});

module.exports = WebSearchTool;
```

### Deliverables
- [ ] Glob tool for file pattern matching
- [ ] Grep tool for content search
- [ ] WebFetch tool for URL content retrieval
- [ ] WebSearch tool for web searches
- [ ] Documentation for each tool
- [ ] Integration with provider system
- [ ] UI for tool results

### Testing Checklist
- [ ] Glob finds files matching patterns
- [ ] Glob respects path parameter
- [ ] Grep searches content with regex
- [ ] Grep output modes work correctly
- [ ] WebFetch retrieves and converts HTML
- [ ] WebFetch processes with AI when prompt provided
- [ ] WebSearch returns relevant results
- [ ] WebSearch domain filtering works
- [ ] All tools handle errors gracefully

---

## Implementation Priorities

### Must Have (MVP)
1. ✅ Phase 1: Core LLM Integration
2. ✅ Phase 2: Tool System Foundation
3. ✅ Phase 3: Agent Orchestration

### Should Have (Enhanced)
4. ✅ Phase 4: Plugin System
5. ✅ Phase 6: Permission System

### Nice to Have (Polish)
6. ✅ Phase 5: Hook System
7. ✅ Phase 7: Advanced Features
8. ✅ Phase 8: Additional Tools

---

## Estimated Timeline

- **Phase 1:** 2-3 weeks (Foundation)
- **Phase 2:** 3-4 weeks (Core Tools)
- **Phase 3:** 3-4 weeks (Orchestration)
- **Phase 4:** 2-3 weeks (Plugins)
- **Phase 5:** 2 weeks (Hooks)
- **Phase 6:** 2 weeks (Permissions)
- **Phase 7:** 2-3 weeks (Polish)
- **Phase 8:** 2-3 weeks (Additional Tools)

**Total: 18-25 weeks (4-6 months)**

For MVP (Phases 1-3): **8-11 weeks (2-3 months)**

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    KING LOUIE ARCHITECTURE                   │
└─────────────────────────────────────────────────────────────┘

┌────────────────┐          ┌─────────────────────────────────┐
│   Electron UI  │          │        Main Process             │
│   (Renderer)   │◄────────►│                                 │
│                │   IPC    │  ┌───────────────────────────┐  │
│  - Chat View   │          │  │    Provider Manager       │  │
│  - Settings    │          │  │  - OpenAI                 │  │
│  - Task List   │          │  │  - Anthropic              │  │
│  - Tool Approvals         │  │  - GitHub Copilot         │  │
└────────────────┘          │  └───────────────────────────┘  │
                            │                                 │
                            │  ┌───────────────────────────┐  │
                            │  │    Tool Registry          │  │
                            │  │  - Bash, Read, Edit       │  │
                            │  │  - Write, Glob, Grep      │  │
                            │  │  - WebFetch, WebSearch    │  │
                            │  └───────────────────────────┘  │
                            │                                 │
                            │  ┌───────────────────────────┐  │
                            │  │    Agent System           │  │
                            │  │  - Agent Executor         │  │
                            │  │  - Orchestrator           │  │
                            │  │  - Task Manager           │  │
                            │  └───────────────────────────┘  │
                            │                                 │
                            │  ┌───────────────────────────┐  │
                            │  │    Plugin Manager         │  │
                            │  │  - Plugin Loader          │  │
                            │  │  - Component Registry     │  │
                            │  └───────────────────────────┘  │
                            │                                 │
                            │  ┌───────────────────────────┐  │
                            │  │    Hook System            │  │
                            │  │  - Pre/Post Tool Hooks    │  │
                            │  │  - Security Validation    │  │
                            │  │  - Session Lifecycle      │  │
                            │  └───────────────────────────┘  │
                            │                                 │
                            │  ┌───────────────────────────┐  │
                            │  │    Permission Manager     │  │
                            │  │  - Global Permissions     │  │
                            │  │  - Command Permissions    │  │
                            │  │  - Permission Profiles    │  │
                            │  └───────────────────────────┘  │
                            └─────────────────────────────────┘
```

---

## Key Technical Decisions

### 1. Provider Abstraction
- Use abstract base class for all LLM providers
- Unified interface for sending messages and streaming
- Provider-specific formatting handled internally
- Easy to add new providers (Gemini, Mistral, etc.)

### 2. Tool Architecture
- Tools are self-contained modules with schema + execute function
- Central registry for tool discovery
- JSON Schema for parameter validation
- Consistent error handling across all tools

### 3. Agent System
- Agents defined with YAML frontmatter + markdown
- Tool permissions scoped per agent
- Agent loop handles multi-turn reasoning
- Orchestrator manages parallel/serial execution

### 4. Plugin System
- Plugins are self-contained directories
- Manifest-based component discovery
- Plugins can extend tools, agents, commands, hooks
- Hot-reloading not required (restart app)

### 5. Security
- Multi-layer permission system (global → command → plugin)
- Hook-based validation (security patterns)
- Dangerous command detection
- User approval for risky operations
- Sandbox profiles for restricted environments

---

## Migration Path from Current System

### Step 1: Keep Existing UI
- Don't change the Electron UI structure
- Keep existing chat history and settings
- Add new features incrementally

### Step 2: Add LLM Integration First
- Replace simulated responses in renderer.js
- Test with existing chat interface
- Validate streaming works correctly

### Step 3: Add Tools One at a Time
- Start with Read tool (safest)
- Then Bash tool (with approval)
- Then Edit/Write tools
- Test each thoroughly before moving on

### Step 4: Add Agent System
- Implement task management first
- Then agent executor
- Finally orchestrator
- Keep simple request-response as fallback

### Step 5: Add Plugin System
- Build plugin loader
- Create one example plugin
- Test loading/unloading
- Expand plugin library

### Step 6: Add Remaining Features
- Hooks system
- Permission profiles
- Advanced UI features
- Analytics

---

## Dependencies to Add

```json
{
  "dependencies": {
    "marked": "^11.0.0",
    "highlight.js": "^11.9.0",
    "mermaid": "^10.6.1",
    "js-yaml": "^4.1.0",
    "glob": "^10.3.10",
    "turndown": "^7.1.2"
  }
}
```

---

## Documentation Needed

1. **Developer Guide**
   - Architecture overview
   - Tool development tutorial
   - Agent creation guide
   - Plugin development guide

2. **User Manual**
   - Getting started
   - Available tools
   - Permission system
   - Creating custom plugins

3. **API Reference**
   - Tool API
   - Agent API
   - Hook API
   - Plugin API

---

## Testing Strategy

### Unit Tests
- Test each tool independently
- Test provider integrations
- Test permission checks
- Test hook system

### Integration Tests
- Test agent loop with tools
- Test multi-agent orchestration
- Test plugin loading
- Test permission enforcement

### E2E Tests
- Test complete workflows
- Test UI interactions
- Test error handling
- Test edge cases

---

## Success Metrics

### Technical Metrics
- [ ] All 8+ core tools implemented
- [ ] 3+ LLM providers supported
- [ ] Plugin system with 3+ example plugins
- [ ] Multi-agent orchestration working
- [ ] Permission system with 4 profiles
- [ ] 90%+ test coverage

### User Experience Metrics
- [ ] Streaming responses work smoothly
- [ ] Tool approvals are clear and informative
- [ ] Task progress is visible
- [ ] Error messages are helpful
- [ ] Settings are easy to configure

### Performance Metrics
- [ ] Response latency < 500ms (first token)
- [ ] Tool execution < 2s (average)
- [ ] UI remains responsive during agent execution
- [ ] Chat history loads < 200ms

---

## Risk Mitigation

### Technical Risks
1. **LLM API Changes** - Use provider abstraction to isolate changes
2. **Tool Security** - Multi-layer permission system + hooks
3. **Performance Issues** - Async/parallel execution + streaming
4. **Plugin Conflicts** - Namespace isolation + version checks

### User Experience Risks
1. **Complexity** - Progressive disclosure, sensible defaults
2. **Approval Fatigue** - Permission profiles, smart defaults
3. **Error Messages** - Clear, actionable error handling
4. **Learning Curve** - Comprehensive documentation + examples

---

## Conclusion

This plan transforms King Louie from a basic chat application into a sophisticated tool-oriented LLM system comparable to Claude Code. The phased approach allows for incremental development and testing, with clear milestones and deliverables at each stage.

The MVP (Phases 1-3) provides core functionality within 2-3 months, with remaining phases adding polish, security, and extensibility over the following 3-4 months.

Key advantages of this architecture:
- ✅ Extensible through plugins
- ✅ Secure through multi-layer permissions
- ✅ Flexible through agent orchestration
- ✅ Maintainable through clear abstractions
- ✅ User-friendly through progressive disclosure

**Next Steps:**
1. Review and approve this plan
2. Set up development environment
3. Begin Phase 1 implementation
4. Establish regular check-ins for progress review
