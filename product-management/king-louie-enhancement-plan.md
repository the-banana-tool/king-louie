# King Louie Enhancement Plan: Tool-Oriented LLM System

## Executive Summary

This document outlines a phased approach to transform King Louie from a basic Electron chat application with simulated responses into a sophisticated tool-oriented LLM system modeled after Claude Code's architecture, enhanced with powerful messaging and remote control capabilities inspired by OpenClaw.

The plan focuses on implementing:
- **Real LLM integration** with streaming support
- **Comprehensive tool support** with 10+ built-in tools
- **Agent orchestration** with multi-agent workflows
- **Gateway architecture** for agent-to-agent communication (OpenClaw-inspired)
- **Multi-channel messaging system** with session management and routing
- **Remote control API** via WebSocket for external integration
- **Advanced tool patterns** including sandboxing, result guards, and type safety
- **Plugin system** for extensibility

**Key OpenClaw-Inspired Features:**
- Gateway server for WebSocket-based agent communication
- Session management with sophisticated routing and bindings
- Message tools for agent-to-agent messaging with timeout support
- Multi-agent coordination with permission controls
- Channel plugin architecture for future expansion
- Remote control API for programmatic access
- Tool policy system with granular permissions
- Sandbox integration for secure tool execution

---

## Implementation Progress (as of 2026-02-05)

### ✅ Phase 1: Core LLM Integration - **COMPLETE**
- Multi-provider architecture (OpenAI, Anthropic) with factory pattern
- Real-time streaming responses with IPC events
- Markdown rendering for formatted messages
- Secure token storage with encryption
- Active provider and model selection in UI

### 🔄 Phase 2: Tool System Foundation - **CORE COMPLETE** (UI Integration Pending)

**Implemented:**
- ✅ Tool definition schema with JSON Schema validation
- ✅ Tool registry for managing tools
- ✅ Four core tools: Bash, Read, Edit, Write
- ✅ Path security validation preventing directory traversal
- ✅ Dangerous pattern detection (e.g., `rm -rf /`)
- ✅ Provider function calling support (OpenAI + Anthropic)
- ✅ Tool executor with approval system and events
- ✅ Agent loop supporting multi-turn tool execution

**Pending Integration:**
- ✅ Main process IPC handlers for tool execution
- ✅ Tool approval dialog in renderer
- ✅ Tool result display in chat interface
- ✅ Agent mode trigger from UI

**Files Created:**
- `src/tools/tool-schema.js` - Tool class with validation
- `src/tools/tool-registry.js` - Registry for managing tools
- `src/tools/utils.js` - Path security helpers
- `src/tools/index.js` - Tool initialization
- `src/tools/builtin/bash-tool.js` - Shell command execution
- `src/tools/builtin/read-tool.js` - File reading with line ranges
- `src/tools/builtin/edit-tool.js` - Exact string replacements
- `src/tools/builtin/write-tool.js` - File creation/overwriting
- `src/execution/tool-executor.js` - Tool execution engine
- `src/execution/agent-loop.js` - Multi-turn agentic loop
- `src/providers/*.js` - Updated with `sendMessageWithTools()`, `parseToolResponse()`, `buildToolMessages()`

### 📋 Phase 3-8: Future Work
Remaining phases (Agent Orchestration, Plugin System, Hook System, Permission System, Advanced Features, Additional Tools) are documented but not yet started.

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
✅ **Real LLM integration** with OpenAI and Anthropic providers
✅ **Streaming responses** with real-time token display
✅ **Markdown rendering** for formatted assistant messages
✅ **Provider abstraction layer** for multi-model support
✅ **Active provider and model selection** in settings UI
✅ **Tool/function calling framework** with schema validation and safety checks
✅ **Core built-in tools** (Bash, Read, Edit, Write) with security controls
✅ **Tool execution engine** with approval system and event emitters
✅ **Agent loop** supporting multi-turn tool execution
✅ **Provider tool support** (OpenAI + Anthropic function calling)

### What's Partially Implemented (Needs UI Integration)
🔄 **Tool approval system** - Core implementation complete, UI integration pending
🔄 **Agent orchestration** - Agent loop complete, needs main process integration
🔄 **Permission system** - Tool-level approval ready, needs UI dialogs

### What's Missing
❌ **Tool UI integration** - Tool results not displayed in chat interface
❌ **Agent mode UI** - No way to trigger agentic workflows from UI
❌ **Plugin/extension system** - Monolithic architecture
❌ **Task management** - Cannot track multi-step operations
❌ **Hook system** - No pre/post execution automation
❌ **Syntax highlighting** - Code blocks in markdown not highlighted
❌ **Token usage tracking** - API usage not monitored
❌ **Additional tools** - Need Glob, Grep, Git, etc.
❌ **Gateway architecture** - No agent-to-agent communication

---

## Architecture Comparison

| Feature | King Louie (Current) | King Louie (Target) | Status |
|---------|---------------------|---------------------|--------|
| LLM Integration | ✅ Multi-model with streaming | Multi-model with streaming | **✅ Complete** |
| Tool System | 🔄 4 core tools (Bash, Read, Edit, Write) | 10+ built-in tools + MCP | **🔄 Core Done, UI Pending** |
| Tool Schema & Validation | ✅ JSON Schema validation with safety checks | Full validation + TypeBox schemas | **✅ Core Complete** |
| Agent Architecture | 🔄 Single agent loop implemented | Multi-agent orchestration | **🔄 Single Agent Done** |
| Function Calling | ✅ OpenAI + Anthropic tool support | Provider abstraction with tool support | **✅ Complete** |
| Tool Execution Engine | ✅ Executor with approval system | Full execution with hooks | **✅ Core Complete** |
| Permission System | 🔄 Tool-level approval ready | 3-layer (manifest/command/hook) | **🔄 Partial** |
| Plugin Support | N/A | Full plugin architecture | **❌ Not Started** |
| Task Management | N/A | Complete lifecycle tracking | **❌ Not Started** |
| Workflow Orchestration | N/A | Serial + parallel execution | **❌ Not Started** |
| Security Hooks | 🔄 Dangerous pattern detection | Pre/post tool validation + result guards | **🔄 Partial** |
| Message Format | ✅ Markdown rendering | Markdown + code blocks + syntax highlighting | **🔄 Partial** |
| Response Mode | ✅ Streaming with IPC events | Streaming with SSE | **✅ Complete** |
| **Messaging System** | **N/A** | **Multi-channel messaging** | **❌ Not Started** |
| **Remote Control** | **N/A** | **WebSocket API** | **❌ Not Started** |
| **Gateway Architecture** | **N/A** | **Agent-to-agent routing** | **❌ Not Started** |

---

## Phased Implementation Plan

---

## **PHASE 1: Core LLM Integration** (Foundation)
**Timeline:** 2-3 weeks
**Priority:** CRITICAL

**Status:** ✅ **COMPLETE** (2026-02-05)

### Summary
Phase 1 successfully replaced simulated responses with real LLM integration. The application now supports:
- Multi-provider architecture (OpenAI, Anthropic) with factory pattern
- Real-time streaming responses with IPC event propagation
- Markdown rendering for formatted messages
- Secure token storage with encryption
- Active provider and model selection in settings UI
- Comprehensive error handling for API failures

**Remaining Optional Items:**
- Token usage tracking (future enhancement)
- Syntax highlighting for code blocks in markdown (future enhancement)
- Anthropic API verification (testing pending)

### Goals
- Replace simulated responses with real LLM API calls
- Implement streaming response handling
- Add markdown rendering for messages
- Create provider abstraction layer

### Implementation Tasks

#### 1.1 Provider Abstraction Layer
**Status:** ✅ **Implemented**
**File:** `src/providers/base-provider.js`

Base class providing:
- API key validation
- Message normalization
- Standard headers configuration
- Abstract methods for `sendMessage()`, `streamMessage()`, `listModels()`, and `getDefaultModel()`

#### 1.2 OpenAI Provider Implementation
**Status:** ✅ **Implemented**
**File:** `src/providers/openai-provider.js`

Extends BaseLLMProvider with:
- Non-streaming and streaming message support via OpenAI Chat Completions API
- Server-sent events (SSE) parsing for streaming responses
- Default model: `gpt-4o-mini`
- Message formatting for OpenAI's format

#### 1.3 Anthropic Provider Implementation
**Status:** ✅ **Implemented**
**File:** `src/providers/anthropic-provider.js`

Extends BaseLLMProvider with:
- Non-streaming and streaming message support via Anthropic Messages API
- SSE parsing for streaming responses
- Default model: `claude-3-5-sonnet-latest`
- Custom headers with `x-api-key` and `anthropic-version`

#### 1.4 Provider Factory
**Status:** ✅ **Implemented**
**File:** `src/providers/provider-factory.js`

Factory pattern for instantiating providers:
- `createProvider(providerType, apiKey)` returns appropriate provider instance
- Supports: `openai`, `anthropic`, `copilot` (copilot not fully implemented)

#### 1.5 Update Main Process Handler
**Status:** ✅ **Implemented**
**File:** `main.js`

IPC handler `chat:sendMessage` now:
- Retrieves active provider and model from settings
- Decrypts API token using safeStorage
- Creates provider instance via ProviderFactory
- Streams responses with IPC events: `chat:messageStart`, `chat:messageChunk`, `chat:messageComplete`, `chat:messageError`
- Saves complete message to chat history

#### 1.6 Add Markdown Rendering
**Status:** ✅ **Implemented**
**Files:** `renderer.js`, `preload.js`, `package.json`

- Installed `marked` library (v15.0.7)
- Assistant messages rendered as markdown via `window.electron.markdown.parse()`
- Streaming chunks accumulated and re-rendered as markdown in real-time
- Fallback to plain text with HTML escaping if marked fails
- User messages displayed as plain text

#### 1.7 Update Preload Script
**Status:** ✅ **Implemented**
**File:** `preload.js`

Exposed to renderer via contextBridge:
- `chat.onMessageStart`, `chat.onMessageChunk`, `chat.onMessageComplete`, `chat.onMessageError` event listeners
- `markdown.parse()` function for safe markdown rendering
- All existing chat and settings IPC handlers

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

**Status:** ✅ **CORE COMPLETE** (2026-02-05) - Integration with UI pending

### Summary
Phase 2 successfully implemented the tool system foundation with:
- Complete tool definition schema with validation and safety checks
- Tool registry for managing and executing tools
- Four core built-in tools (Bash, Read, Edit, Write) with security controls
- Provider updates for function calling (OpenAI + Anthropic)
- Tool executor with approval system and event emitters
- Agent loop supporting multi-turn tool execution

**Remaining Integration Work:**
- UI integration for tool approval dialogs (not yet wired to renderer)
- Tool execution display in chat interface
- IPC handlers in main.js for tool operations

### Goals
- Implement function calling support ✅
- Create tool definition framework ✅
- Build core built-in tools (Bash, Read, Edit, Write) ✅
- Add tool execution engine with safety controls ✅

### Implementation Tasks

#### 2.1 Tool Definition Schema
**Status:** ✅ **Implemented**
**File:** `src/tools/tool-schema.js`

Complete implementation with validation, safety checks, and LLM integration:

```javascript
class Tool {
  constructor(config = {}) {
    if (!config.name) throw new Error('Tool name is required');
    if (typeof config.execute !== 'function')
      throw new Error(`Tool execute handler is required for ${config.name}`);

    this.name = config.name;
    this.description = config.description || '';
    this.parameters = config.parameters || { type: 'object', properties: {} };
    this.execute = config.execute;
    this.requiresApproval = Boolean(config.requiresApproval);
    this.dangerousPatterns = Array.isArray(config.dangerousPatterns)
      ? config.dangerousPatterns
      : [];
  }

  toFunctionDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters
    };
  }

  validateParameters(params = {}) {
    const schema = this.parameters || {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    // Check required fields
    for (const field of required) {
      if (!(field in params)) {
        throw new Error(`Missing required parameter: ${field}`);
      }
    }

    // Type validation with enum and numeric constraints
    const properties = schema.properties || {};
    for (const [key, descriptor] of Object.entries(properties)) {
      if (!(key in params) || params[key] === undefined || params[key] === null)
        continue;

      const value = params[key];
      if (!descriptor.type) continue;

      const typeOk =
        (descriptor.type === 'string' && typeof value === 'string') ||
        (descriptor.type === 'number' && typeof value === 'number') ||
        (descriptor.type === 'boolean' && typeof value === 'boolean') ||
        (descriptor.type === 'array' && Array.isArray(value)) ||
        (descriptor.type === 'object' && typeof value === 'object' && !Array.isArray(value));

      if (!typeOk) {
        throw new Error(`Invalid type for parameter '${key}'. Expected ${descriptor.type}.`);
      }

      if (Array.isArray(descriptor.enum) && !descriptor.enum.includes(value)) {
        throw new Error(`Invalid value for parameter '${key}'. Expected one of: ${descriptor.enum.join(', ')}`);
      }

      if (descriptor.type === 'number') {
        if (typeof descriptor.minimum === 'number' && value < descriptor.minimum) {
          throw new Error(`Parameter '${key}' must be >= ${descriptor.minimum}`);
        }
        if (typeof descriptor.maximum === 'number' && value > descriptor.maximum) {
          throw new Error(`Parameter '${key}' must be <= ${descriptor.maximum}`);
        }
      }
    }
  }

  isDangerous(params = {}) {
    const value = JSON.stringify(params);
    return this.dangerousPatterns.some((pattern) => pattern.test(value));
  }
}

module.exports = { Tool };
```

#### 2.2 Tool Registry
**Status:** ✅ **Implemented**
**File:** `src/tools/tool-registry.js`

Implemented with full validation and safety checks:

```javascript
const { Tool } = require('./tool-schema');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!(tool instanceof Tool)) {
      throw new Error('Must register Tool instance');
    }
    this.tools.set(tool.name, tool);
    return tool;
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return Array.from(this.tools.values());
  }

  getFunctionDefinitions() {
    return this.list().map((tool) => tool.toFunctionDefinition());
  }

  async execute(name, parameters, options = {}) {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    tool.validateParameters(parameters || {});

    if (tool.isDangerous(parameters || {}) && !options.bypassSafety) {
      throw new Error(`Dangerous operation detected: ${name}`);
    }

    return tool.execute(parameters || {}, options);
  }
}

const registry = new ToolRegistry();

module.exports = {
  ToolRegistry,
  registry
};
```

#### 2.3 Core Built-in Tools
**Status:** ✅ **Implemented** (4/4 tools complete)

All core tools implemented with security controls, validation, and proper error handling:

**File:** `src/tools/builtin/bash-tool.js`

```javascript
const { exec } = require('child_process');
const { promisify } = require('util');
const { Tool } = require('../tool-schema');

const execAsync = promisify(exec);

const BashTool = new Tool({
  name: 'Bash',
  description: 'Execute shell commands for local development tasks.',
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
        minimum: 1,
        maximum: 600000
      }
    },
    required: ['command']
  },
  requiresApproval: true,
  dangerousPatterns: [
    /rm\s+-rf\s+\//i,
    /mkfs\./i,
    /dd\s+if=/i,
    /:(){\s*:|:&};:/,
    /del\s+\/s\s+\/q/i,
    /rmdir\s+\/s\s+\/q/i,
    /format\s+[a-z]:/i
  ],

  async execute(params, options = {}) {
    const { command, timeout = 120000 } = params;

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: Math.min(timeout, 600000),
        maxBuffer: 10 * 1024 * 1024,
        cwd: options.workingDirectory || process.cwd(),
        shell: true
      });

      return {
        success: true,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: 0
      };
    } catch (error) {
      return {
        success: false,
        stdout: (error.stdout || '').trim(),
        stderr: (error.stderr || error.message || '').trim(),
        exitCode: typeof error.code === 'number' ? error.code : 1
      };
    }
  }
});

module.exports = BashTool;
```

**File:** `src/tools/builtin/read-tool.js`

```javascript
const fs = require('fs').promises;
const path = require('path');
const { Tool } = require('../tool-schema');
const { isPathWithin } = require('../utils');

const ReadTool = new Tool({
  name: 'Read',
  description: 'Read file contents with optional line ranges.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file to read'
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-indexed)',
        minimum: 1
      },
      limit: {
        type: 'number',
        description: 'Number of lines to read',
        minimum: 1
      }
    },
    required: ['file_path']
  },

  async execute(params, options = {}) {
    const { file_path, offset, limit } = params;
    const workingDirectory = options.workingDirectory || process.cwd();
    const resolvedPath = path.isAbsolute(file_path)
      ? path.resolve(file_path)
      : path.resolve(workingDirectory, file_path);

    if (!isPathWithin(workingDirectory, resolvedPath)) {
      throw new Error('Access denied: Path outside working directory');
    }

    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');

      const startLine = offset ? Math.max(offset - 1, 0) : 0;
      const endLine = limit ? Math.min(startLine + limit, lines.length) : lines.length;

      const selectedLines = lines.slice(startLine, endLine);
      const formatted = selectedLines
        .map((line, idx) => `${startLine + idx + 1}\t${line}`)
        .join('\n');

      return {
        success: true,
        content: formatted,
        totalLines: lines.length,
        readLines: selectedLines.length,
        filePath: resolvedPath
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
const fs = require('fs').promises;
const path = require('path');
const { Tool } = require('../tool-schema');
const { isPathWithin } = require('../utils');

const EditTool = new Tool({
  name: 'Edit',
  description: 'Perform exact string replacements in files.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file to edit'
      },
      old_string: {
        type: 'string',
        description: 'The exact text to replace (must be unique unless replace_all=true)'
      },
      new_string: {
        type: 'string',
        description: 'The replacement text'
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences if true'
      }
    },
    required: ['file_path', 'old_string', 'new_string']
  },
  requiresApproval: true,

  async execute(params, options = {}) {
    const { file_path, old_string, new_string, replace_all = false } = params;
    const workingDirectory = options.workingDirectory || process.cwd();
    const resolvedPath = path.isAbsolute(file_path)
      ? path.resolve(file_path)
      : path.resolve(workingDirectory, file_path);

    if (!isPathWithin(workingDirectory, resolvedPath)) {
      throw new Error('Access denied: Path outside working directory');
    }

    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const occurrences = content.split(old_string).length - 1;

      if (occurrences === 0) {
        throw new Error('old_string not found in file');
      }

      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `old_string appears ${occurrences} times. Use replace_all=true or provide more context.`
        );
      }

      const updated = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string);

      await fs.writeFile(resolvedPath, updated, 'utf-8');

      return {
        success: true,
        replacements: replace_all ? occurrences : 1,
        filePath: resolvedPath
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
const fs = require('fs').promises;
const path = require('path');
const { Tool } = require('../tool-schema');
const { isPathWithin } = require('../utils');

const WriteTool = new Tool({
  name: 'Write',
  description: 'Create or overwrite a file with provided content.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file to write'
      },
      content: {
        type: 'string',
        description: 'The content to write'
      }
    },
    required: ['file_path', 'content']
  },
  requiresApproval: true,

  async execute(params, options = {}) {
    const { file_path, content } = params;
    const workingDirectory = options.workingDirectory || process.cwd();
    const resolvedPath = path.isAbsolute(file_path)
      ? path.resolve(file_path)
      : path.resolve(workingDirectory, file_path);

    if (!isPathWithin(workingDirectory, resolvedPath)) {
      throw new Error('Access denied: Path outside working directory');
    }

    try {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, 'utf-8');

      return {
        success: true,
        message: `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes`,
        filePath: resolvedPath
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

**File:** `src/tools/utils.js`

Helper utilities for path security validation:

```javascript
const path = require('path');

function isPathWithin(parentDir, childPath) {
  const relative = path.relative(parentDir, childPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

module.exports = { isPathWithin };
```

#### 2.4 Tool Initialization
**Status:** ✅ **Implemented**
**File:** `src/tools/index.js`

```javascript
const { registry: toolRegistry } = require('./tool-registry');

const BashTool = require('./builtin/bash-tool');
const ReadTool = require('./builtin/read-tool');
const EditTool = require('./builtin/edit-tool');
const WriteTool = require('./builtin/write-tool');

let initialized = false;

function initializeTools() {
  if (initialized) return;

  toolRegistry.register(BashTool);
  toolRegistry.register(ReadTool);
  toolRegistry.register(EditTool);
  toolRegistry.register(WriteTool);

  initialized = true;
}

module.exports = {
  toolRegistry,
  initializeTools
};
```

#### 2.5 Update Provider Classes for Function Calling
**Status:** ✅ **Implemented**

Both OpenAI and Anthropic providers now support tool calling with proper format conversion:

**File:** `src/providers/openai-provider.js` (key methods)

```javascript
class OpenAIProvider extends BaseLLMProvider {
  // Send message with tool definitions
  async sendMessageWithTools(messages, tools = [], options = {}) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(messages),
        tools: tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        tool_choice: 'auto',
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    return this.parseToolResponse(data);
  }

  // Parse tool use from response
  parseToolResponse(response) {
    const message = response?.choices?.[0]?.message;
    if (!message) {
      return {
        type: 'text',
        content: ''
      };
    }

    const toolCall = message.tool_calls?.find((call) => call.type === 'function');
    if (toolCall?.function?.name) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        parsedArgs = {};
      }

      return {
        type: 'tool_use',
        toolName: toolCall.function.name,
        toolUseId: toolCall.id,
        parameters: parsedArgs,
        messageContent: message.content || ''
      };
    }

    return {
      type: 'text',
      content: message.content || ''
    };
  }

  // Build proper message format for tool results
  buildToolMessages(response, toolResult, toolCallId) {
    return [
      {
        role: 'assistant',
        content: response.messageContent || '',
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: {
              name: response.toolName,
              arguments: JSON.stringify(response.parameters || {})
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: toolCallId,
        content: JSON.stringify(toolResult)
      }
    ];
  }
}
```

**File:** `src/providers/anthropic-provider.js` (key methods)

```javascript
class AnthropicProvider extends BaseLLMProvider {
  // Send message with tool definitions
  async sendMessageWithTools(messages, tools = [], options = {}) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(messages),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters
        })),
        max_tokens: options.max_tokens || 4096,
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    return this.parseToolResponse(data);
  }

  // Parse tool use from response
  parseToolResponse(response) {
    const content = Array.isArray(response?.content) ? response.content : [];
    const toolUse = content.find((block) => block.type === 'tool_use');
    const textBlocks = content.filter((block) => block.type === 'text');

    if (toolUse) {
      return {
        type: 'tool_use',
        toolName: toolUse.name,
        toolUseId: toolUse.id,
        parameters: toolUse.input || {},
        messageContent: textBlocks.map((block) => block.text).join('\n')
      };
    }

    return {
      type: 'text',
      content: textBlocks.map((block) => block.text).join('\n')
    };
  }

  // Build proper message format for tool results
  buildToolMessages(response, toolResult, toolCallId) {
    const assistantContent = [];

    if (response.messageContent) {
      assistantContent.push({ type: 'text', text: response.messageContent });
    }

    assistantContent.push({
      type: 'tool_use',
      id: toolCallId,
      name: response.toolName,
      input: response.parameters || {}
    });

    return [
      {
        role: 'assistant',
        content: assistantContent
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: JSON.stringify(toolResult)
          }
        ]
      }
    ];
  }
}
```

#### 2.6 Tool Execution Engine
**Status:** ✅ **Implemented**
**File:** `src/execution/tool-executor.js`

Complete implementation with validation, safety checks, and approval system:

```javascript
const { EventEmitter } = require('events');
const { toolRegistry } = require('../tools');

class ToolExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.requireApproval = options.requireApproval !== false;
  }

  async execute(toolName, parameters = {}, options = {}) {
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    this.emit('preExecute', { toolName, parameters });

    tool.validateParameters(parameters);

    if (tool.isDangerous(parameters) && !options.bypassSafety) {
      throw new Error(`Dangerous operation detected: ${toolName}`);
    }

    if (tool.requiresApproval && this.requireApproval) {
      const approved = await this.requestApproval(toolName, parameters);
      if (!approved) {
        const denied = { success: false, error: 'User denied permission' };
        this.emit('postExecute', { toolName, parameters, result: denied });
        return denied;
      }
    }

    try {
      const result = await tool.execute(parameters, {
        ...options,
        workingDirectory: options.workingDirectory || this.workingDirectory
      });

      this.emit('postExecute', { toolName, parameters, result });
      return result;
    } catch (error) {
      this.emit('error', { toolName, parameters, error });
      return { success: false, error: error.message };
    }
  }

  async requestApproval(toolName, parameters) {
    return new Promise((resolve) => {
      this.emit('approvalRequired', { toolName, parameters, resolve });
    });
  }
}

module.exports = ToolExecutor;
```

#### 2.7 Update Main Process for Tool Execution
**Status:** ⏳ **TODO** - Not yet integrated

Proposed implementation for `main.js`:

```javascript
const { initializeTools, toolRegistry } = require('./src/tools');
const ToolExecutor = require('./src/execution/tool-executor');
const AgentLoop = require('./src/execution/agent-loop');

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

// Agent-based chat with tool support
ipcMain.handle('chat:sendMessageWithTools', async (event, { messages }) => {
  const provider = createProvider(/* ... */);
  const executor = new ToolExecutor({
    workingDirectory: process.cwd(),
    requireApproval: true
  });

  const loop = new AgentLoop(provider, executor);
  const tools = toolRegistry.getFunctionDefinitions();

  const result = await loop.run(messages, tools);
  return result;
});
```

#### 2.8 Update Preload Script
**Status:** ⏳ **TODO** - Not yet integrated

Proposed additions to `preload.js`:

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
**Status:** ⏳ **TODO** - Not yet integrated

Proposed additions to `renderer.js`:

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
**Status:** ✅ **Implemented**
**File:** `src/execution/agent-loop.js`

Complete multi-turn agent loop with provider-specific message formatting:

```javascript
class AgentLoop {
  constructor(provider, executor, options = {}) {
    this.provider = provider;
    this.executor = executor;
    this.maxIterations = options.maxIterations || 10;
  }

  async run(messages, tools, options = {}) {
    let iterations = 0;
    const conversationHistory = [...messages];
    const executedTools = [];

    while (iterations < this.maxIterations) {
      iterations += 1;

      const response = await this.provider.sendMessageWithTools(
        conversationHistory,
        tools,
        options
      );

      if (response.type === 'text') {
        return {
          type: 'complete',
          content: response.content,
          iterations,
          tools: executedTools
        };
      }

      if (response.type === 'tool_use') {
        const toolCallId =
          response.toolUseId ||
          `toolcall-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const toolResult = await this.executor.execute(
          response.toolName,
          response.parameters,
          options
        );

        executedTools.push({
          name: response.toolName,
          parameters: response.parameters,
          result: toolResult
        });

        if (typeof this.provider.buildToolMessages === 'function') {
          const providerMessages = this.provider.buildToolMessages(
            response,
            toolResult,
            toolCallId
          );
          conversationHistory.push(...providerMessages);
        } else {
          conversationHistory.push({
            role: 'assistant',
            content: response.messageContent || '',
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: {
                  name: response.toolName,
                  arguments: JSON.stringify(response.parameters || {})
                }
              }
            ]
          });

          conversationHistory.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify(toolResult)
          });
        }

        continue;
      }

      return {
        type: 'error',
        content: 'Unsupported response type from provider',
        iterations,
        tools: executedTools
      };
    }

    return {
      type: 'max_iterations',
      content: 'Maximum tool iterations reached before final answer.',
      iterations,
      tools: executedTools
    };
  }
}

module.exports = AgentLoop;
```

### Deliverables
- [x] Tool definition schema and registry
- [x] Core tools: Bash, Read, Edit, Write
- [x] Provider updates for function calling (OpenAI + Anthropic)
- [x] Tool execution engine with safety checks
- [x] Agent loop supporting tool calls
- [x] Dangerous command detection
- [ ] Permission system (approval dialogs) - Implementation complete, UI integration pending
- [ ] Tool result display in UI - Pending
- [ ] Main process IPC integration - Pending

### Testing Checklist
**Core Implementation:**
- [x] Tool schema validates parameters correctly
- [x] Tool registry registers and retrieves tools
- [x] Dangerous patterns detected in Bash tool
- [x] Path security checks prevent directory traversal
- [x] Provider function calling formats match API specs
- [x] Agent loop handles multi-turn tool execution
- [x] Tool executor emits proper events

**Integration Testing (TODO):**
- [ ] Bash tool executes commands via UI
- [ ] Read tool can read files with line ranges via UI
- [ ] Edit tool performs string replacements via UI
- [ ] Write tool creates/overwrites files via UI
- [ ] Approval dialog appears for dangerous operations
- [ ] Tool results display in chat interface
- [ ] Multi-turn agentic workflows complete successfully
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

#### 3.6 Agent-to-Agent Communication & Remote Control (OpenClaw-Style Messaging)

**Inspiration:** OpenClaw's powerful messaging and remote control system

This section adds advanced messaging capabilities inspired by OpenClaw's architecture, enabling agent-to-agent communication, remote control, multi-channel messaging support, and session management.

##### 3.6.1 Gateway Architecture for Message Routing

**File:** `src/gateway/gateway-server.js`

Create a central gateway server for managing agent communication:

```javascript
const { EventEmitter } = require('events');
const WebSocket = require('ws');

class GatewayServer extends EventEmitter {
  constructor(config = {}) {
    super();
    this.port = config.port || 18789;
    this.host = config.host || '127.0.0.1';
    this.agents = new Map(); // agentId -> agent session
    this.connections = new Map(); // connectionId -> websocket
    this.messageHandlers = new Map();
    this.sessionStore = new Map(); // sessionKey -> conversation history
  }

  async start() {
    this.wss = new WebSocket.Server({
      host: this.host,
      port: this.port
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    console.log(`Gateway server started on ${this.host}:${this.port}`);
  }

  handleConnection(ws, req) {
    const connectionId = Date.now().toString();
    this.connections.set(connectionId, ws);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        await this.routeMessage(connectionId, message);
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
      }
    });

    ws.on('close', () => {
      this.connections.delete(connectionId);
    });
  }

  async routeMessage(connectionId, message) {
    const handler = this.messageHandlers.get(message.method);
    if (!handler) {
      throw new Error(`Unknown method: ${message.method}`);
    }

    const result = await handler(message.params, connectionId);

    const ws = this.connections.get(connectionId);
    if (ws) {
      ws.send(JSON.stringify({
        type: 'response',
        id: message.id,
        result
      }));
    }
  }

  registerMethod(method, handler) {
    this.messageHandlers.set(method, handler);
  }

  // Send message to specific agent session
  async sendToAgent(agentId, sessionKey, message) {
    const session = this.sessionStore.get(sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${sessionKey}`);
    }

    // Emit event for agent to process
    this.emit('agent:message', {
      agentId,
      sessionKey,
      message
    });
  }

  // Broadcast to all connected clients
  broadcast(event, data) {
    const message = JSON.stringify({ type: 'event', event, data });
    this.connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
}

module.exports = GatewayServer;
```

##### 3.6.2 Session Management & Routing

**File:** `src/gateway/session-manager.js`

```javascript
class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionKey -> session data
    this.bindings = new Map(); // agent bindings for routing
  }

  // Create or get session key for agent
  buildSessionKey(agentId, channel = 'desktop', peer = null) {
    if (!peer) {
      // Main session for agent
      return `agent:${agentId}:main`;
    }

    // Peer-specific session
    return `agent:${agentId}:${channel}:${peer}`;
  }

  // Get or create session
  getOrCreateSession(sessionKey, agentId) {
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, {
        key: sessionKey,
        agentId,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {}
      });
    }
    return this.sessions.get(sessionKey);
  }

  // Add message to session history
  addMessage(sessionKey, message) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${sessionKey}`);
    }

    session.messages.push({
      ...message,
      timestamp: Date.now()
    });
    session.updatedAt = Date.now();
  }

  // Get session history
  getHistory(sessionKey, limit = 50) {
    const session = this.sessions.get(sessionKey);
    if (!session) return [];

    const messages = session.messages;
    return messages.slice(-limit);
  }

  // List all sessions
  listSessions(filter = {}) {
    const sessions = Array.from(this.sessions.values());

    if (filter.agentId) {
      return sessions.filter(s => s.agentId === filter.agentId);
    }

    return sessions;
  }

  // Resolve session by label or key
  resolveSession(labelOrKey, agentId) {
    // Try exact key match first
    if (this.sessions.has(labelOrKey)) {
      return this.sessions.get(labelOrKey);
    }

    // Search by label in metadata
    for (const session of this.sessions.values()) {
      if (session.metadata.label === labelOrKey) {
        if (!agentId || session.agentId === agentId) {
          return session;
        }
      }
    }

    return null;
  }

  // Add agent binding for routing
  addBinding(binding) {
    const key = `${binding.channel || '*'}:${binding.accountId || '*'}`;
    this.bindings.set(key, binding);
  }

  // Resolve which agent should handle a message
  resolveAgentRoute(channel, accountId, peerId) {
    // Most specific match wins
    const keys = [
      `${channel}:${accountId}:${peerId}`,
      `${channel}:${accountId}`,
      `${channel}:*`,
      `*:*`
    ];

    for (const key of keys) {
      const binding = this.bindings.get(key);
      if (binding) {
        return binding.agentId;
      }
    }

    return 'main'; // Default agent
  }
}

module.exports = SessionManager;
```

##### 3.6.3 Message Tool for Agent-to-Agent Communication

**File:** `src/tools/builtin/message-tool.js`

```javascript
const Tool = require('../tool-schema');

class MessageTool extends Tool {
  constructor(gatewayServer, sessionManager) {
    super({
      name: 'message',
      description: `Send messages to other agents or sessions. Actions: send, reply, broadcast.

Examples:
- Send to agent: { action: "send", target: "agent:worker:main", message: "Process this data" }
- Reply: { action: "reply", target: "session:abc123", message: "Task completed" }
- Broadcast: { action: "broadcast", message: "System update" }`,

      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['send', 'reply', 'broadcast'],
            description: 'Message action to perform'
          },
          target: {
            type: 'string',
            description: 'Target agent session key (e.g., agent:worker:main) or session label'
          },
          message: {
            type: 'string',
            description: 'Message content to send'
          },
          timeoutSeconds: {
            type: 'number',
            description: 'Optional timeout for waiting for response (default: 30)',
            default: 30
          },
          media: {
            type: 'string',
            description: 'Optional media URL or local path'
          },
          metadata: {
            type: 'object',
            description: 'Optional metadata to include with message'
          }
        },
        required: ['action', 'message']
      },

      requiresApproval: false
    });

    this.gateway = gatewayServer;
    this.sessionManager = sessionManager;
  }

  async execute(params, context) {
    const { action, target, message, timeoutSeconds = 30, media, metadata } = params;

    switch (action) {
      case 'send':
        return await this.handleSend(target, message, timeoutSeconds, media, metadata, context);

      case 'reply':
        return await this.handleReply(target, message, media, context);

      case 'broadcast':
        return await this.handleBroadcast(message, media);

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async handleSend(target, message, timeoutSeconds, media, metadata, context) {
    // Resolve target session
    const session = this.sessionManager.resolveSession(target);
    if (!session) {
      return {
        status: 'error',
        error: `Session not found: ${target}`
      };
    }

    // Add message to session history
    this.sessionManager.addMessage(session.key, {
      role: 'user',
      content: message,
      from: context.sessionKey || 'unknown',
      media,
      metadata
    });

    // Send to agent via gateway
    const runId = `msg_${Date.now()}`;
    await this.gateway.sendToAgent(session.agentId, session.key, {
      runId,
      message,
      media,
      metadata,
      from: context.sessionKey
    });

    // Wait for response if timeout > 0
    if (timeoutSeconds > 0) {
      try {
        const response = await this.waitForResponse(session.key, runId, timeoutSeconds * 1000);
        return {
          status: 'ok',
          runId,
          reply: response.content,
          sessionKey: session.key
        };
      } catch (error) {
        return {
          status: 'timeout',
          runId,
          error: 'Response timeout',
          sessionKey: session.key
        };
      }
    }

    return {
      status: 'accepted',
      runId,
      sessionKey: session.key
    };
  }

  async handleReply(target, message, media, context) {
    // Similar to send but for replying in existing conversation
    return await this.handleSend(target, message, 0, media, null, context);
  }

  async handleBroadcast(message, media) {
    // Broadcast to all agents
    this.gateway.broadcast('agent:broadcast', {
      message,
      media,
      timestamp: Date.now()
    });

    return {
      status: 'ok',
      action: 'broadcast',
      message: 'Broadcast sent to all agents'
    };
  }

  async waitForResponse(sessionKey, runId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.gateway.removeListener('agent:response', handler);
        reject(new Error('Timeout waiting for response'));
      }, timeoutMs);

      const handler = (data) => {
        if (data.sessionKey === sessionKey && data.runId === runId) {
          clearTimeout(timeout);
          this.gateway.removeListener('agent:response', handler);
          resolve(data);
        }
      };

      this.gateway.on('agent:response', handler);
    });
  }
}

module.exports = MessageTool;
```

##### 3.6.4 Sessions Management Tools

**File:** `src/tools/builtin/sessions-tools.js`

```javascript
const Tool = require('../tool-schema');

class SessionsListTool extends Tool {
  constructor(sessionManager) {
    super({
      name: 'sessions_list',
      description: 'List all active agent sessions',
      parameters: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Optional: filter by agent ID'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of sessions to return',
            default: 50
          }
        }
      }
    });
    this.sessionManager = sessionManager;
  }

  async execute(params) {
    const sessions = this.sessionManager.listSessions(params);
    return {
      sessions: sessions.slice(0, params.limit || 50).map(s => ({
        key: s.key,
        agentId: s.agentId,
        label: s.metadata.label,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      }))
    };
  }
}

class SessionsHistoryTool extends Tool {
  constructor(sessionManager) {
    super({
      name: 'sessions_history',
      description: 'Get conversation history from a session',
      parameters: {
        type: 'object',
        properties: {
          sessionKey: {
            type: 'string',
            description: 'Session key or label'
          },
          limit: {
            type: 'number',
            description: 'Number of messages to retrieve',
            default: 50
          }
        },
        required: ['sessionKey']
      }
    });
    this.sessionManager = sessionManager;
  }

  async execute(params) {
    const session = this.sessionManager.resolveSession(params.sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionKey}`);
    }

    const messages = this.sessionManager.getHistory(session.key, params.limit);
    return {
      sessionKey: session.key,
      agentId: session.agentId,
      messages
    };
  }
}

class SessionsSpawnTool extends Tool {
  constructor(sessionManager, agentExecutor) {
    super({
      name: 'sessions_spawn',
      description: 'Spawn a new agent session for isolated work',
      parameters: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Agent to spawn'
          },
          label: {
            type: 'string',
            description: 'Label for the session'
          },
          message: {
            type: 'string',
            description: 'Initial message for the spawned agent'
          }
        },
        required: ['agentId', 'message']
      }
    });
    this.sessionManager = sessionManager;
    this.agentExecutor = agentExecutor;
  }

  async execute(params, context) {
    const sessionKey = this.sessionManager.buildSessionKey(
      params.agentId,
      'spawned',
      `spawn_${Date.now()}`
    );

    const session = this.sessionManager.getOrCreateSession(sessionKey, params.agentId);

    if (params.label) {
      session.metadata.label = params.label;
      session.metadata.spawnedBy = context.sessionKey;
    }

    // Send initial message
    this.sessionManager.addMessage(sessionKey, {
      role: 'user',
      content: params.message,
      from: context.sessionKey || 'system'
    });

    return {
      status: 'spawned',
      sessionKey,
      agentId: params.agentId,
      label: params.label
    };
  }
}

module.exports = {
  SessionsListTool,
  SessionsHistoryTool,
  SessionsSpawnTool
};
```

##### 3.6.5 Multi-Channel Support Architecture

**File:** `src/channels/channel-plugin.js`

```javascript
class ChannelPlugin {
  constructor(config) {
    this.id = config.id;
    this.label = config.label;
    this.capabilities = config.capabilities || {};
  }

  // Normalize target for this channel
  normalizeTarget(rawTarget) {
    throw new Error('Must implement normalizeTarget');
  }

  // Send message through this channel
  async send(target, message, options = {}) {
    throw new Error('Must implement send');
  }

  // List available actions for this channel
  listActions() {
    return ['send', 'reply'];
  }
}

// Example: Desktop channel plugin
class DesktopChannelPlugin extends ChannelPlugin {
  constructor() {
    super({
      id: 'desktop',
      label: 'Desktop App',
      capabilities: {
        chatTypes: ['direct', 'group'],
        media: true,
        buttons: true
      }
    });
  }

  normalizeTarget(rawTarget) {
    return rawTarget.trim();
  }

  async send(target, message, options = {}) {
    // Send via IPC to Electron renderer
    const { BrowserWindow } = require('electron');
    const mainWindow = BrowserWindow.getAllWindows()[0];

    if (mainWindow) {
      mainWindow.webContents.send('channel:message', {
        channel: 'desktop',
        target,
        message,
        media: options.media,
        buttons: options.buttons
      });
    }

    return { status: 'sent' };
  }
}

module.exports = { ChannelPlugin, DesktopChannelPlugin };
```

##### 3.6.6 Remote Control API

**File:** `src/gateway/remote-control.js`

```javascript
class RemoteControl {
  constructor(gatewayServer, sessionManager, agentExecutor) {
    this.gateway = gatewayServer;
    this.sessionManager = sessionManager;
    this.agentExecutor = agentExecutor;

    // Register remote control methods
    this.registerMethods();
  }

  registerMethods() {
    // Agent control
    this.gateway.registerMethod('agent.execute', this.executeAgent.bind(this));
    this.gateway.registerMethod('agent.wait', this.waitForAgent.bind(this));
    this.gateway.registerMethod('agent.abort', this.abortAgent.bind(this));

    // Session control
    this.gateway.registerMethod('sessions.list', this.listSessions.bind(this));
    this.gateway.registerMethod('sessions.resolve', this.resolveSession.bind(this));
    this.gateway.registerMethod('chat.history', this.getChatHistory.bind(this));

    // System control
    this.gateway.registerMethod('system.health', this.getHealth.bind(this));
    this.gateway.registerMethod('system.status', this.getStatus.bind(this));
  }

  async executeAgent(params, connectionId) {
    const { message, sessionKey, channel, deliver = false } = params;

    // Resolve or create session
    const session = this.sessionManager.getOrCreateSession(
      sessionKey || `agent:main:main`,
      'main'
    );

    // Add user message
    this.sessionManager.addMessage(session.key, {
      role: 'user',
      content: message
    });

    // Execute agent
    const runId = `run_${Date.now()}`;
    const result = await this.agentExecutor.execute(
      session.agentId,
      message,
      {
        sessionKey: session.key,
        runId
      }
    );

    // Add assistant response
    this.sessionManager.addMessage(session.key, {
      role: 'assistant',
      content: result.content
    });

    return {
      runId,
      status: 'completed',
      reply: result.content
    };
  }

  async waitForAgent(params) {
    const { runId, timeoutMs = 30000 } = params;

    // Wait for agent completion
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Agent timeout'));
      }, timeoutMs);

      this.gateway.once(`agent:complete:${runId}`, (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });
  }

  async abortAgent(params) {
    const { runId } = params;
    this.gateway.emit(`agent:abort:${runId}`);
    return { status: 'aborted' };
  }

  async listSessions(params) {
    const sessions = this.sessionManager.listSessions(params);
    return { sessions };
  }

  async resolveSession(params) {
    const session = this.sessionManager.resolveSession(
      params.sessionKey || params.label,
      params.agentId
    );

    if (!session) {
      throw new Error('Session not found');
    }

    return { key: session.key, agentId: session.agentId };
  }

  async getChatHistory(params) {
    const { sessionKey, limit = 50 } = params;
    const messages = this.sessionManager.getHistory(sessionKey, limit);
    return { messages };
  }

  async getHealth() {
    return {
      status: 'healthy',
      timestamp: Date.now(),
      agents: this.sessionManager.listSessions().length
    };
  }

  async getStatus() {
    return {
      gateway: {
        uptime: process.uptime(),
        connections: this.gateway.connections.size
      },
      sessions: {
        total: this.sessionManager.sessions.size,
        active: this.sessionManager.listSessions().filter(s =>
          Date.now() - s.updatedAt < 300000 // Active in last 5 minutes
        ).length
      }
    };
  }
}

module.exports = RemoteControl;
```

##### 3.6.7 Integration with Main Process

**File:** `main.js` (additions for gateway integration)

```javascript
const GatewayServer = require('./src/gateway/gateway-server');
const SessionManager = require('./src/gateway/session-manager');
const RemoteControl = require('./src/gateway/remote-control');
const MessageTool = require('./src/tools/builtin/message-tool');
const { SessionsListTool, SessionsHistoryTool, SessionsSpawnTool } = require('./src/tools/builtin/sessions-tools');

// Global gateway instance
let gatewayServer;
let sessionManager;
let remoteControl;

app.whenReady().then(async () => {
  // ... existing initialization ...

  // Initialize gateway for agent communication
  sessionManager = new SessionManager();
  gatewayServer = new GatewayServer({
    port: 18789,
    host: '127.0.0.1'
  });

  // Initialize remote control API
  remoteControl = new RemoteControl(
    gatewayServer,
    sessionManager,
    agentExecutor
  );

  // Register messaging tools
  toolRegistry.register(new MessageTool(gatewayServer, sessionManager));
  toolRegistry.register(new SessionsListTool(sessionManager));
  toolRegistry.register(new SessionsHistoryTool(sessionManager));
  toolRegistry.register(new SessionsSpawnTool(sessionManager, agentExecutor));

  // Start gateway server
  await gatewayServer.start();
  console.log('Gateway server started for agent communication');

  // Handle agent messages
  gatewayServer.on('agent:message', async ({ agentId, sessionKey, message }) => {
    // Execute agent with message
    const result = await agentExecutor.execute(agentId, message.message, {
      sessionKey,
      runId: message.runId
    });

    // Emit response
    gatewayServer.emit('agent:response', {
      sessionKey,
      runId: message.runId,
      content: result.content
    });

    // Also send to main window
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('agent:response', {
        agentId,
        sessionKey,
        message: result.content
      });
    }
  });
});
```

##### 3.6.8 Configuration Schema for Multi-Agent Routing

**File:** `config/agent-config.json`

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "name": "Main Assistant",
        "workspace": "~/.king-louie/workspace-main",
        "model": "sonnet",
        "default": true
      },
      {
        "id": "worker",
        "name": "Background Worker",
        "workspace": "~/.king-louie/workspace-worker",
        "model": "haiku",
        "tools": ["Bash", "Read", "Write", "sessions_send"]
      },
      {
        "id": "researcher",
        "name": "Research Agent",
        "workspace": "~/.king-louie/workspace-research",
        "model": "opus",
        "tools": ["WebSearch", "WebFetch", "Read", "sessions_send"]
      }
    ]
  },
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "desktop",
        "accountId": "default"
      }
    },
    {
      "agentId": "worker",
      "match": {
        "channel": "desktop",
        "peer": {
          "kind": "group",
          "id": "background-tasks"
        }
      }
    }
  ],
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allow": ["main", "worker", "researcher"]
    }
  },
  "gateway": {
    "port": 18789,
    "host": "127.0.0.1",
    "auth": {
      "enabled": false
    }
  }
}
```

**Key Features Added:**

1. **Gateway Architecture**: Central server for managing agent communication with WebSocket support
2. **Session Management**: Sophisticated session routing with agent bindings and peer-based routing
3. **Message Tool**: Send messages between agents with timeout support and delivery confirmation
4. **Sessions Tools**: List, spawn, and manage agent sessions programmatically
5. **Multi-Channel Support**: Plugin architecture for different communication channels
6. **Remote Control API**: Full remote control capabilities via WebSocket protocol
7. **Agent-to-Agent Messaging**: Controlled messaging between agents with permission system
8. **Configuration-Based Routing**: Declarative routing rules for directing messages to appropriate agents

This brings King Louie's capabilities close to OpenClaw's sophisticated messaging and remote control system!

#### 3.7 IPC Handlers for Agent System
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
- [ ] **Gateway server for agent communication (WebSocket-based)**
- [ ] **Session management system with routing**
- [ ] **Message tool for agent-to-agent communication**
- [ ] **Sessions management tools (list, history, spawn)**
- [ ] **Multi-channel plugin architecture**
- [ ] **Remote control API for external access**
- [ ] **Agent binding configuration system**
- [ ] Task UI in sidebar
- [ ] Agent execution progress indicators
- [ ] Task dependency visualization
- [ ] **Agent communication visualizer in UI**

### Testing Checklist
- [ ] Tasks can be created with dependencies
- [ ] Task status updates correctly (pending → in_progress → completed)
- [ ] Blocked tasks don't execute until dependencies complete
- [ ] Agents execute with filtered tool permissions
- [ ] Parallel agent execution works correctly
- [ ] Serial agent execution passes outputs correctly
- [ ] Task list UI updates in real-time
- [ ] Agent results display properly
- [ ] **Gateway server starts and accepts WebSocket connections**
- [ ] **Message tool can send messages between agents**
- [ ] **Session routing works correctly based on bindings**
- [ ] **Sessions can be spawned and managed**
- [ ] **Agent-to-agent communication respects permissions**
- [ ] **Remote control API methods work via WebSocket**
- [ ] **Multiple agents can communicate simultaneously**
- [ ] **Session history persists correctly**

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

#### 8.5 Advanced Tool Patterns from OpenClaw

**Inspiration:** OpenClaw's innovative tool architecture and execution patterns

These patterns enhance tool execution, validation, and user experience:

##### 8.5.1 TypeBox Schema System for Type Safety

**File:** `src/tools/schema/typebox-helpers.js`

OpenClaw uses TypeBox for runtime type validation and schema generation. This provides:
- Compile-time type checking with TypeScript
- Runtime validation
- Automatic JSON Schema generation
- Better error messages

```javascript
const { Type } = require('@sinclair/typebox');

// Helper for string enums (more reliable than Type.Union)
function stringEnum(values, options = {}) {
  return Type.Unsafe({
    type: 'string',
    enum: values,
    ...options
  });
}

// Helper for optional string enums
function optionalStringEnum(values, options = {}) {
  return Type.Optional(stringEnum(values, options));
}

// Example: Tool with TypeBox schema
const ExampleToolSchema = Type.Object({
  action: stringEnum(['create', 'update', 'delete'], {
    description: 'Action to perform'
  }),
  target: Type.String({ description: 'Target identifier' }),
  options: Type.Optional(Type.Object({
    force: Type.Boolean(),
    quiet: Type.Boolean()
  }))
});

module.exports = { stringEnum, optionalStringEnum };
```

##### 8.5.2 Tool Policy System

**File:** `src/tools/tool-policy.js`

Implement granular tool policies inspired by OpenClaw:

```javascript
class ToolPolicy {
  constructor(config = {}) {
    this.allowList = new Set(config.allow || []);
    this.denyList = new Set(config.deny || []);
    this.elevatedList = new Set(config.elevated || []);
  }

  // Check if tool is allowed
  isAllowed(toolName, params = {}) {
    // Check deny list first (highest priority)
    if (this.isDenied(toolName, params)) {
      return { allowed: false, reason: 'Tool is denied by policy' };
    }

    // Check if tool requires elevation
    if (this.requiresElevation(toolName, params)) {
      return {
        allowed: true,
        requiresElevation: true,
        reason: 'Tool requires elevated permissions'
      };
    }

    // Check allow list
    if (this.allowList.has('*') || this.allowList.has(toolName)) {
      return { allowed: true };
    }

    return { allowed: false, reason: 'Tool not in allow list' };
  }

  isDenied(toolName, params) {
    // Simple deny check
    if (this.denyList.has(toolName)) return true;

    // Pattern-based deny (e.g., "Bash:rm -rf*")
    for (const pattern of this.denyList) {
      if (pattern.includes(':')) {
        const [tool, cmdPattern] = pattern.split(':', 2);
        if (tool === toolName && params.command) {
          const regex = new RegExp(cmdPattern.replace('*', '.*'));
          if (regex.test(params.command)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  requiresElevation(toolName, params) {
    // Check if tool requires elevated permissions
    return this.elevatedList.has(toolName);
  }
}

module.exports = ToolPolicy;
```

##### 8.5.3 Tool Result Guards

**File:** `src/tools/result-guards.js`

Protect sensitive data in tool outputs:

```javascript
class ToolResultGuard {
  constructor() {
    this.sensitivePatterns = [
      /\bAK[A-Z0-9]{18}\b/g,  // AWS Access Key
      /\bSK[A-Z0-9]{32}\b/g,  // AWS Secret Key
      /sk-[a-zA-Z0-9]{48}/g,  // OpenAI API Key
      /ghp_[a-zA-Z0-9]{36}/g, // GitHub Personal Access Token
      /xox[baprs]-[a-zA-Z0-9-]+/g, // Slack tokens
      /-----BEGIN (?:RSA |DSA )?PRIVATE KEY-----/g, // Private keys
      /\b[0-9]{4}[-\s]?[0-9]{4}[-\s]?[0-9]{4}[-\s]?[0-9]{4}\b/g // Credit cards
    ];
  }

  // Scan and redact sensitive data
  guard(result) {
    if (typeof result === 'string') {
      return this.redactString(result);
    }

    if (typeof result === 'object' && result !== null) {
      return this.redactObject(result);
    }

    return result;
  }

  redactString(text) {
    let redacted = text;

    for (const pattern of this.sensitivePatterns) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }

    return redacted;
  }

  redactObject(obj) {
    if (Array.isArray(obj)) {
      return obj.map(item => this.guard(item));
    }

    const redacted = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip redaction for certain keys if needed
      redacted[key] = this.guard(value);
    }

    return redacted;
  }
}

module.exports = ToolResultGuard;
```

##### 8.5.4 Sandbox Integration for Tools

**File:** `src/tools/sandbox/sandbox-integration.js`

Inspired by OpenClaw's Docker sandbox integration:

```javascript
const Docker = require('dockerode');

class ToolSandbox {
  constructor(config = {}) {
    this.docker = new Docker();
    this.mode = config.mode || 'off'; // off, all, dangerous
    this.scope = config.scope || 'shared'; // shared, agent, session
    this.containers = new Map();
  }

  // Check if tool should run in sandbox
  shouldSandbox(toolName, params) {
    if (this.mode === 'off') return false;
    if (this.mode === 'all') return true;

    // Dangerous mode - only sandbox risky tools
    const dangerousTools = ['Bash', 'Write', 'Edit', 'apply_patch'];
    return dangerousTools.includes(toolName);
  }

  // Execute tool in sandbox
  async executeSandboxed(toolName, params, options = {}) {
    const container = await this.getOrCreateContainer(options.agentId);

    // Map paths if needed
    const sandboxParams = this.mapPaths(params, options.workspaceRoot);

    // Execute in container
    const exec = await container.exec({
      Cmd: ['node', '-e', `
        const tool = require('./tools/${toolName}');
        const result = await tool.execute(${JSON.stringify(sandboxParams)});
        console.log(JSON.stringify(result));
      `],
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start();
    const output = await this.collectStream(stream);

    return JSON.parse(output);
  }

  async getOrCreateContainer(agentId) {
    const key = this.scope === 'agent' ? agentId : 'shared';

    if (this.containers.has(key)) {
      return this.containers.get(key);
    }

    // Create new container
    const container = await this.docker.createContainer({
      Image: 'node:22-alpine',
      Cmd: ['tail', '-f', '/dev/null'], // Keep alive
      WorkingDir: '/workspace',
      HostConfig: {
        Binds: [`${process.cwd()}:/workspace`],
        Memory: 512 * 1024 * 1024, // 512MB
        NetworkMode: 'none' // No network access
      }
    });

    await container.start();
    this.containers.set(key, container);

    return container;
  }

  mapPaths(params, workspaceRoot) {
    // Map host paths to container paths
    const mapped = { ...params };

    if (params.file_path) {
      mapped.file_path = params.file_path.replace(workspaceRoot, '/workspace');
    }

    return mapped;
  }

  async collectStream(stream) {
    return new Promise((resolve, reject) => {
      let output = '';
      stream.on('data', chunk => output += chunk.toString());
      stream.on('end', () => resolve(output));
      stream.on('error', reject);
    });
  }

  async cleanup() {
    for (const container of this.containers.values()) {
      await container.stop();
      await container.remove();
    }
    this.containers.clear();
  }
}

module.exports = ToolSandbox;
```

##### 8.5.5 Tool Execution Context

**File:** `src/tools/execution-context.js`

Provide rich context to tools during execution:

```javascript
class ToolExecutionContext {
  constructor(config) {
    this.sessionKey = config.sessionKey;
    this.agentId = config.agentId;
    this.workspaceRoot = config.workspaceRoot;
    this.sandboxRoot = config.sandboxRoot;
    this.currentChannelProvider = config.currentChannelProvider;
    this.currentChannelId = config.currentChannelId;
    this.permissions = config.permissions;
    this.metadata = config.metadata || {};
  }

  // Check if agent has permission
  hasPermission(permission) {
    return this.permissions?.includes(permission) || false;
  }

  // Get workspace-relative path
  getWorkspacePath(relativePath) {
    return path.join(this.workspaceRoot, relativePath);
  }

  // Get sandbox-relative path
  getSandboxPath(relativePath) {
    if (!this.sandboxRoot) return null;
    return path.join(this.sandboxRoot, relativePath);
  }

  // Create child context for spawned agents
  createChildContext(overrides = {}) {
    return new ToolExecutionContext({
      ...this,
      ...overrides,
      metadata: {
        ...this.metadata,
        parentSessionKey: this.sessionKey
      }
    });
  }
}

module.exports = ToolExecutionContext;
```

##### 8.5.6 Tool Summary System

**File:** `src/tools/tool-summaries.js`

Generate concise summaries of tool execution for better conversation flow:

```javascript
class ToolSummaryGenerator {
  constructor() {
    this.summarizers = new Map();
    this.registerDefaultSummarizers();
  }

  registerDefaultSummarizers() {
    // Bash tool summary
    this.register('Bash', (params, result) => {
      if (result.success) {
        const outputPreview = result.output.slice(0, 100);
        return `Executed: ${params.command}\n${outputPreview}${result.output.length > 100 ? '...' : ''}`;
      }
      return `Command failed: ${result.error}`;
    });

    // Read tool summary
    this.register('Read', (params, result) => {
      if (result.success) {
        const lines = result.content.split('\n').length;
        return `Read ${lines} lines from ${params.file_path}`;
      }
      return `Failed to read ${params.file_path}: ${result.error}`;
    });

    // Write tool summary
    this.register('Write', (params, result) => {
      if (result.success) {
        const lines = params.content.split('\n').length;
        return `Wrote ${lines} lines to ${params.file_path}`;
      }
      return `Failed to write to ${params.file_path}: ${result.error}`;
    });

    // Message tool summary
    this.register('message', (params, result) => {
      if (result.status === 'ok') {
        return `Message sent to ${result.sessionKey}: ${params.message.slice(0, 50)}...`;
      }
      return `Failed to send message: ${result.error}`;
    });
  }

  register(toolName, summarizer) {
    this.summarizers.set(toolName, summarizer);
  }

  summarize(toolName, params, result) {
    const summarizer = this.summarizers.get(toolName);

    if (!summarizer) {
      // Default summary
      return `Tool ${toolName} executed: ${result.success ? 'success' : 'failed'}`;
    }

    return summarizer(params, result);
  }
}

module.exports = ToolSummaryGenerator;
```

**Key Benefits:**

1. **Type Safety with TypeBox**: Runtime validation and compile-time checking
2. **Granular Tool Policies**: Fine-grained control over tool access
3. **Result Guards**: Automatic redaction of sensitive data
4. **Sandbox Integration**: Isolated execution for dangerous operations
5. **Rich Execution Context**: Tools have access to session, agent, and workspace info
6. **Tool Summaries**: Concise summaries improve conversation flow

These patterns make King Louie's tool system more robust, secure, and user-friendly!

### Deliverables
- [ ] Glob tool for file pattern matching
- [ ] Grep tool for content search
- [ ] WebFetch tool for URL content retrieval
- [ ] WebSearch tool for web searches
- [ ] **TypeBox schema system for type safety**
- [ ] **Tool policy system with granular controls**
- [ ] **Tool result guards for sensitive data**
- [ ] **Sandbox integration for tool execution**
- [ ] **Tool execution context system**
- [ ] **Tool summary generator**
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
- [ ] **TypeBox schemas validate parameters correctly**
- [ ] **Tool policies deny/allow tools appropriately**
- [ ] **Result guards redact sensitive data**
- [ ] **Sandbox executes tools in isolated containers**
- [ ] **Execution context provides correct paths**
- [ ] **Tool summaries generate concise descriptions**
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

This plan transforms King Louie from a basic chat application into a sophisticated tool-oriented LLM system that combines the best of Claude Code's architecture with OpenClaw's innovative messaging and remote control capabilities. The phased approach allows for incremental development and testing, with clear milestones and deliverables at each stage.

The MVP (Phases 1-3) provides core functionality within 2-3 months, with remaining phases adding polish, security, and extensibility over the following 3-4 months.

### OpenClaw Integration Summary

The following powerful features from OpenClaw have been integrated into the enhancement plan:

**Phase 3 Additions (Agent Orchestration & Messaging):**
- **Gateway Server**: WebSocket-based communication hub for agent coordination
- **Session Management**: Sophisticated routing with agent bindings and peer-based routing
- **Message Tool**: Agent-to-agent communication with timeout support and delivery confirmation
- **Sessions Tools**: List, spawn, and manage agent sessions programmatically
- **Multi-Channel Support**: Plugin architecture for different communication channels
- **Remote Control API**: Full remote control capabilities via WebSocket protocol
- **Agent Bindings**: Configuration-based routing for directing messages to appropriate agents

**Phase 8 Additions (Advanced Tool Patterns):**
- **TypeBox Schema System**: Runtime type validation and compile-time checking
- **Tool Policy System**: Granular permission controls with pattern matching
- **Tool Result Guards**: Automatic redaction of sensitive data (API keys, credentials)
- **Sandbox Integration**: Docker-based isolated execution for dangerous operations
- **Execution Context**: Rich context providing session, agent, and workspace information
- **Tool Summaries**: Concise summaries that improve conversation flow

**Key Benefits of OpenClaw Integration:**
1. **Remote Control**: Programmatic access via WebSocket API for external integration
2. **Multi-Agent Communication**: Agents can collaborate, delegate, and coordinate work
3. **Advanced Security**: Sandbox execution and result guards protect sensitive data
4. **Type Safety**: TypeBox schemas prevent runtime errors and provide better tooling
5. **Extensibility**: Channel plugin architecture enables future expansion to other platforms
6. **Session Management**: Sophisticated routing enables complex multi-agent workflows

Key advantages of this enhanced architecture:
- ✅ Extensible through plugins and channel adapters
- ✅ Secure through multi-layer permissions, sandboxing, and result guards
- ✅ Flexible through agent orchestration and inter-agent messaging
- ✅ Maintainable through clear abstractions and type safety
- ✅ User-friendly through progressive disclosure
- ✅ **Remotely controllable through WebSocket gateway**
- ✅ **Collaborative through agent-to-agent communication**
- ✅ **Enterprise-ready through advanced session management**

**Success Criteria**: King Louie will successfully rival Claude Code and incorporate OpenClaw's best features when it can:
- Execute complex multi-step tasks autonomously
- Use 10+ tools effectively with runtime type safety
- Orchestrate multiple specialized agents with inter-agent messaging
- Route messages intelligently based on configured bindings
- Execute tools in isolated sandboxes when needed
- Handle errors gracefully with user approval
- Support plugins and channel extensions
- Provide remote control via WebSocket API
- Provide a polished, responsive user interface

**Next Steps:**
1. Review and approve this enhanced plan
2. Set up development environment (including Docker for sandbox support)
3. Begin Phase 1 implementation (Core LLM Integration)
4. Parallel track: Research OpenClaw's gateway implementation for Phase 3
5. Establish regular check-ins for progress review
