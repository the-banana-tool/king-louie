# King Louie Enhancement Plan: Tool-Oriented LLM System

## Executive Summary

King Louie is a sophisticated Electron-based agentic AI orchestration system that has successfully implemented the majority of its planned architecture. The application features multi-provider LLM support, comprehensive tool execution with approval systems, multi-agent orchestration, task management, and WebSocket-based remote control capabilities.

**Current Status:** Phase 1-3 Complete, Gateway & Remote Control Complete

**Key Implemented Features:**
- ✅ Real LLM integration with streaming (OpenAI, Anthropic)
- ✅ Tool system with 6 built-in tools (Bash, Read, Edit, Write, Message, Sessions)
- ✅ Multi-agent orchestration (3 specialized agents with parallel/serial/dependency execution)
- ✅ Gateway architecture with WebSocket server (port 18789)
- ✅ Remote control API with 8 method categories
- ✅ Session management with message history and routing
- ✅ Task management with dependency tracking
- ✅ Token tracking and cost calculation
- ✅ Tool approval system with UI integration

**Remaining Work:**
- ❌ Plugin system for extensibility
- ❌ Hook system for pre/post tool execution
- 🔄 Additional tools (Glob, Grep, Git, etc.)
- 🔄 Enhanced permission system
- 🔄 Advanced UI features (syntax highlighting, etc.)

---

## Implementation Progress (as of 2026-02-05)

### ✅ Phase 1: Core LLM Integration - **COMPLETE**

**Status:** Production-ready

**Implemented Features:**
- Multi-provider architecture (OpenAI, Anthropic) with factory pattern
- Real-time streaming responses with IPC event propagation
- Markdown rendering for formatted messages
- Secure token storage with Electron's safeStorage encryption
- Active provider and model selection in settings UI
- Per-message and per-conversation token tracking with USD cost calculation
- Comprehensive error handling for API failures

**Files:**
- `src/providers/base-provider.js` - Base provider class
- `src/providers/openai-provider.js` - OpenAI implementation (gpt-4o-mini, gpt-4o, gpt-4.1)
- `src/providers/anthropic-provider.js` - Anthropic implementation (claude-3-5-sonnet, claude-3-5-haiku)
- `src/providers/provider-factory.js` - Provider factory
- Integration in `main.js` (IPC handlers), `renderer.js` (UI), `preload.js` (API bridge)

### ✅ Phase 2: Tool System Foundation - **COMPLETE**

**Status:** Production-ready with full UI integration

**Implemented Features:**
- Tool definition schema with JSON Schema validation
- Tool registry for managing and executing tools
- Six built-in tools: Bash, Read, Edit, Write, Message, Sessions
- Path security validation preventing directory traversal
- Dangerous pattern detection (e.g., `rm -rf /`)
- Provider function calling support (OpenAI + Anthropic)
- Tool executor with approval system and event emitters
- Agent loop supporting multi-turn tool execution (max 10 iterations)
- Tool approval UI with modal dialogs and "always approve" option
- Tool execution display in chat interface with event messages
- Runtime environment detection for platform-specific commands

**Files:**
- `src/tools/tool-schema.js` - Tool class with validation
- `src/tools/tool-registry.js` - Registry for managing tools
- `src/tools/utils.js` - Path security and safety helpers
- `src/tools/index.js` - Tool initialization
- `src/tools/builtin/bash-tool.js` - Shell command execution
- `src/tools/builtin/read-tool.js` - File reading with line ranges
- `src/tools/builtin/edit-tool.js` - Exact string replacements
- `src/tools/builtin/write-tool.js` - File creation/overwriting
- `src/tools/builtin/message-tool.js` - Inter-session messaging
- `src/tools/builtin/sessions-tools.js` - Session management (list, history, spawn)
- `src/execution/tool-executor.js` - Tool execution engine
- `src/execution/agent-loop.js` - Multi-turn agentic loop
- `src/execution/runtime-environment.js` - Platform detection
- Full integration in `main.js`, `renderer.js`, `preload.js`

### ✅ Phase 3: Agent Orchestration - **COMPLETE**

**Status:** Production-ready

**Implemented Features:**
- Three specialized built-in agents:
  - **Main Assistant** (`main`) - General purpose, all tools allowed
  - **Code Explorer** (`code-explorer`) - Codebase analysis, Read/Bash only
  - **Code Writer** (`code-writer`) - Code modification, Bash/Read/Edit/Write
- Agent execution engine (AgentExecutor) with tool filtering
- Multi-agent orchestration modes:
  - Parallel execution (run all agents simultaneously)
  - Serial execution (chain agents with message passing)
  - Dependency-based execution (task-manager DAG resolution)
- Task management system with:
  - Task creation with custom metadata
  - Status tracking (pending, in_progress, completed, deleted)
  - Dependency tracking (blocks/blockedBy arrays)
  - Automatic unblocking when dependencies complete
  - Event emission (taskCreated, taskUpdated, taskUnblocked)
- Agent registry for lookup and filtering

**Files:**
- `src/agents/agent-schema.js` - Agent definition class
- `src/agents/agent-executor.js` - Single agent execution engine
- `src/agents/orchestrator.js` - Multi-agent orchestration
- `src/agents/builtin/main-assistant.js` - General purpose agent
- `src/agents/builtin/code-explorer.js` - Codebase analysis agent
- `src/agents/builtin/code-writer.js` - Code modification agent
- `src/agents/index.js` - Agent registry
- `src/tasks/task-manager.js` - Task management with dependencies
- IPC handlers in `main.js` for agent/task operations

### ✅ Gateway Architecture & Remote Control - **COMPLETE**

**Status:** Production-ready

**Implemented Features:**
- WebSocket gateway server on `127.0.0.1:18789`
- Message routing to registered handlers
- Event broadcasting to all connected clients
- Connection lifecycle management
- Remote control API with 8 method categories:
  - `agent.execute` - Execute single agent
  - `agent.wait` - Wait for agent completion
  - `agent.abort` - Abort agent execution
  - `sessions.list` - List active sessions
  - `sessions.resolve` - Resolve session by key/label
  - `chat.history` - Get session message history
  - `system.health` - Health check
  - `system.status` - System status
- Session management:
  - Session creation and lifecycle
  - Message history per session
  - Session keying: `agent:${agentId}:${channel}:${peer}`
  - Session bindings for routing
  - Per-session metadata

**Files:**
- `src/gateway/gateway-server.js` - WebSocket server
- `src/gateway/remote-control.js` - Remote API methods
- `src/gateway/session-manager.js` - Session lifecycle management
- Initialization in `main.js` (lines 570-575)

---

## Current Architecture Status

| Component | Status | Notes |
|-----------|--------|-------|
| **LLM Integration** | ✅ Production | Multi-provider (OpenAI, Anthropic), streaming, token tracking |
| **Tool System** | ✅ Production | 6 tools with full UI integration and approval system |
| **Agent Orchestration** | ✅ Production | 3 agents, parallel/serial/dependency execution |
| **Task Management** | ✅ Production | Full dependency tracking with events |
| **Gateway Server** | ✅ Production | WebSocket on port 18789, remote API ready |
| **Session Management** | ✅ Production | Full lifecycle with message history |
| **Remote Control API** | ✅ Production | 8 methods for external system integration |
| **UI Integration** | ✅ Production | Full IPC bridge with tool approval dialogs |
| **Security** | ✅ Production | Credential encryption, path validation, dangerous pattern detection |
| **Cost Tracking** | ✅ Production | Per-message and per-conversation USD cost |
| **Plugin System** | ❌ Not Started | Planned for Phase 4 |
| **Hook System** | ❌ Not Started | Planned for Phase 5 |
| **Enhanced Permissions** | 🔄 Partial | Tool approval exists, need manifest/command layers |
| **Additional Tools** | 🔄 Partial | Have 6 tools, need Glob, Grep, Git, etc. |
| **Syntax Highlighting** | ❌ Not Started | Code blocks need syntax highlighting |

---

## Remaining Implementation Phases

### Phase 4: Plugin System (Not Started)

**Goals:**
- Create plugin manifest schema
- Implement plugin loader and validator
- Add plugin permission system
- Enable third-party tool registration
- Create example plugin template

**Estimated Effort:** 2-3 weeks

**Priority:** Medium

### Phase 5: Hook System (Not Started)

**Goals:**
- Implement pre/post tool execution hooks
- Add result guard system for validation
- Create hook configuration system
- Enable user-defined automation workflows

**Estimated Effort:** 1-2 weeks

**Priority:** Medium

### Phase 6: Enhanced Permission System (Partially Complete)

**Current State:** Tool-level approval system exists with UI dialogs and whitelist

**Remaining Work:**
- Manifest-level permissions (plugin capabilities)
- Command-level permissions (bash command patterns)
- Permission persistence and management UI

**Estimated Effort:** 1-2 weeks

**Priority:** Low-Medium

### Phase 7: Additional Tools (Partially Complete)

**Current Tools (6):**
1. Bash - Shell command execution
2. Read - File reading with line ranges
3. Edit - Exact string replacements
4. Write - File creation/overwriting
5. Message - Inter-session messaging
6. Sessions - Session management (list, history, spawn)

**Needed Tools:**
- Glob - Fast file pattern matching
- Grep - Content search with regex
- Git - Version control operations
- WebFetch - Web content retrieval
- Task - Create and manage subtasks
- AskUser - Interactive user questions

**Estimated Effort:** 2-3 weeks for 6 additional tools

**Priority:** High

### Phase 8: Advanced Features & Polish

**Goals:**
- Syntax highlighting for code blocks in markdown
- Enhanced error messages with stack traces
- Conversation export/import
- Agent performance metrics dashboard
- Tool usage analytics
- Custom theme support

**Estimated Effort:** 2-3 weeks

**Priority:** Low-Medium

---

## Implementation Priorities (Updated)

### Immediate Priorities (Next 2 Weeks)
1. **Additional Core Tools** - Add Glob, Grep, Git tools for file operations
2. **Syntax Highlighting** - Implement code block syntax highlighting in markdown
3. **Testing & Documentation** - Comprehensive testing of existing systems

### Short-Term Priorities (Next 1-2 Months)
1. **Plugin System** - Enable extensibility for third-party tools
2. **Hook System** - Add pre/post tool execution automation
3. **Enhanced Permissions** - Complete the 3-layer permission model

### Long-Term Priorities (Next 3-6 Months)
1. **Advanced UI Features** - Performance metrics, analytics dashboards
2. **MCP Integration** - Model Context Protocol support
3. **Multi-user Support** - Team collaboration features

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                        Electron App                          │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Renderer   │  │   Preload    │  │     Main     │      │
│  │   (UI/Chat)  │◄─┤  (IPC Bridge)├─►│   Process    │      │
│  └──────────────┘  └──────────────┘  └──────┬───────┘      │
│                                              │               │
├──────────────────────────────────────────────┼───────────────┤
│                  Core Systems                │               │
│                                              │               │
│  ┌──────────────────────────────────────────▼───────────┐  │
│  │            Provider Factory                            │  │
│  │  ┌───────────────┐    ┌────────────────┐             │  │
│  │  │ OpenAI Provider│    │Anthropic Provider│            │  │
│  │  └───────────────┘    └────────────────┘             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │            Tool System                                │  │
│  │  ┌──────────────┐  ┌──────────────┐                 │  │
│  │  │Tool Registry │  │Tool Executor │                  │  │
│  │  │ (6 tools)    │◄─┤ + Approval   │                  │  │
│  │  └──────────────┘  └──────────────┘                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │            Agent System                               │  │
│  │  ┌──────────────┐  ┌──────────────┐                 │  │
│  │  │Agent Registry│  │Agent Executor│                  │  │
│  │  │ (3 agents)   │◄─┤  + Loop      │                  │  │
│  │  └──────────────┘  └──────────────┘                 │  │
│  │                                                       │  │
│  │  ┌────────────────────────────────┐                 │  │
│  │  │   Orchestrator                  │                 │  │
│  │  │  - Parallel execution           │                 │  │
│  │  │  - Serial execution             │                 │  │
│  │  │  - Dependency-based execution   │                 │  │
│  │  └────────────────────────────────┘                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │            Task Management                            │  │
│  │  ┌────────────────────────────────┐                 │  │
│  │  │ Task Manager                    │                 │  │
│  │  │  - Dependency tracking          │                 │  │
│  │  │  - Auto-unblocking              │                 │  │
│  │  │  - Event emission               │                 │  │
│  │  └────────────────────────────────┘                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │       Gateway & Remote Control                        │  │
│  │  ┌────────────────┐  ┌────────────────┐             │  │
│  │  │Gateway Server  │  │Session Manager │             │  │
│  │  │ (WebSocket)    │◄─┤ + History      │             │  │
│  │  │  Port: 18789   │  └────────────────┘             │  │
│  │  └────────┬───────┘                                  │  │
│  │           │                                           │  │
│  │           ▼                                           │  │
│  │  ┌────────────────────────────────┐                 │  │
│  │  │   Remote Control API            │                 │  │
│  │  │    - Agent execution            │                 │  │
│  │  │    - Session management         │                 │  │
│  │  │    - System status              │                 │  │
│  │  └────────────────────────────────┘                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘

External Clients ◄─── WebSocket (port 18789) ──► Gateway
```

---

## Key Technical Decisions

### Provider Architecture
- **Decision:** Factory pattern with abstract base class
- **Rationale:** Enables easy addition of new LLM providers (Cohere, Mistral, etc.)
- **Status:** Implemented for OpenAI and Anthropic

### Tool Execution Model
- **Decision:** Approval-based with whitelist persistence
- **Rationale:** Security-first approach while enabling automation
- **Status:** Fully implemented with UI integration

### Agent Orchestration
- **Decision:** Three specialized agents vs. one general agent
- **Rationale:** Enables focused capabilities and tool filtering
- **Status:** Implemented with main-assistant, code-explorer, code-writer

### Session Management
- **Decision:** Session keying format: `agent:${agentId}:${channel}:${peer}`
- **Rationale:** Hierarchical organization for routing and isolation
- **Status:** Implemented with full lifecycle management

### Gateway Architecture
- **Decision:** WebSocket on fixed port (18789) with message-based RPC
- **Rationale:** Enables external system integration and remote control
- **Status:** Fully operational with 8 API methods

---

## Testing Strategy

### Current Testing Needs

**Unit Tests (High Priority):**
- Tool validation and execution
- Agent filtering and orchestration
- Task dependency resolution
- Session routing and lifecycle
- Provider message formatting

**Integration Tests (Medium Priority):**
- End-to-end agent execution with tools
- Multi-agent orchestration workflows
- Gateway message routing
- Task unblocking cascade

**UI Tests (Medium Priority):**
- Tool approval dialogs
- Chat message streaming
- Settings persistence
- Provider switching

**Security Tests (High Priority):**
- Path traversal prevention
- Dangerous command detection
- Token encryption/decryption
- WebSocket authentication (when implemented)

---

## Success Metrics

### Completed Metrics ✅
- [x] LLM integration with 2+ providers (OpenAI, Anthropic)
- [x] Core tool system with 4+ tools (have 6)
- [x] Multi-agent orchestration (3 agents with 3 execution modes)
- [x] Tool approval system with UI
- [x] Task management with dependencies
- [x] Gateway architecture with remote control API
- [x] Token tracking and cost calculation

### In-Progress Metrics 🔄
- [ ] 10+ built-in tools (currently 6/10)
- [ ] Plugin system for extensibility
- [ ] Hook system for automation

### Future Metrics 📋
- [ ] Syntax highlighting for code blocks
- [ ] Comprehensive test coverage (>80%)
- [ ] Performance metrics dashboard
- [ ] Multi-user support

---

## Dependencies

### Current Dependencies (package.json)
```json
{
  "electron": "^34.0.0",
  "electron-store": "^10.0.0",
  "marked": "^16.0.1"
}
```

### Recommended Additions for Remaining Phases

**Phase 4 (Plugin System):**
- `ajv` - JSON schema validation for plugin manifests
- `semver` - Plugin version management

**Phase 7 (Additional Tools):**
- `micromatch` or `minimatch` - Glob pattern matching for Glob tool
- `@sindresorhus/is` - Type checking utilities

**Phase 8 (Advanced Features):**
- `highlight.js` or `prism` - Syntax highlighting for code blocks
- `chart.js` - Performance metrics visualization

---

## Risk Mitigation

### Identified Risks

**1. Tool Security**
- **Risk:** Malicious tool parameters could harm system
- **Mitigation:** ✅ Implemented - Path validation, dangerous pattern detection, approval system
- **Status:** Low risk

**2. API Cost Management**
- **Risk:** Uncontrolled LLM usage could incur high costs
- **Mitigation:** ✅ Implemented - Per-message token tracking and USD cost display
- **Status:** Low risk

**3. Agent Loop Runaway**
- **Risk:** Agent could loop indefinitely
- **Mitigation:** ✅ Implemented - Max 10 iterations per agent execution
- **Status:** Low risk

**4. Session Memory Leaks**
- **Risk:** Long-running sessions could accumulate unbounded message history
- **Mitigation:** ⚠️ Not yet implemented - Need session cleanup/archival
- **Status:** Medium risk

**5. WebSocket Security**
- **Risk:** Unauthorized access to remote control API
- **Mitigation:** ❌ Not implemented - Currently localhost-only, need authentication
- **Status:** Medium risk (mitigated by localhost binding)

---

## Conclusion

King Louie has successfully completed the first three major phases of its development roadmap and implemented a sophisticated agentic AI orchestration system. The application now features:

- **Production-ready core**: LLM integration, tool system, agent orchestration
- **Advanced capabilities**: Multi-agent workflows, task management, remote control API
- **Security-first design**: Tool approval, path validation, credential encryption
- **Extensible architecture**: Ready for plugin system and additional tools

**Next Steps:**
1. Add 4-6 more essential tools (Glob, Grep, Git, WebFetch, Task, AskUser)
2. Implement syntax highlighting for improved code display
3. Develop plugin system for third-party extensibility
4. Comprehensive testing and documentation

The project has exceeded its initial Phase 2 goals and is positioned for continued growth with a solid architectural foundation.
