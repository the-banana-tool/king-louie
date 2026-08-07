<p align="center">
  <img src="banana.png" alt="King Louie" width="200" />
</p>

<h1 align="center">King Louie</h1>

<p align="center">
  An open-source, cross-platform AI chat desktop app.<br>
  Bring your own API keys. Chat with any LLM. Run agents. Connect bots to Telegram, Discord, and Slack.
</p>

<p align="center">
  <a href="https://github.com/the-banana-tool/king-louie/releases/latest"><img src="https://img.shields.io/github/v/release/the-banana-tool/king-louie?label=Latest%20Release&style=for-the-badge" alt="Latest Release" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform" />
</p>

---

## Download

> **Just pick your platform and run the installer. That's it.**

| Platform | Link | What to do |
|----------|------|------------|
| **Windows** | [**Download .exe installer**](https://github.com/the-banana-tool/king-louie/releases/latest/download/King-Louie-Setup.exe) | Run the `.exe` → click "Install" → done |
| **macOS** | [**Download .dmg**](https://github.com/the-banana-tool/king-louie/releases/latest/download/King-Louie-arm64.dmg) | Open the `.dmg` → drag to Applications → done |
| **Linux** | [**Download .AppImage**](https://github.com/the-banana-tool/king-louie/releases/latest/download/King-Louie.AppImage) | `chmod +x` the file → double-click → done |

> **Don't see your platform?** Check the [all downloads page](https://github.com/the-banana-tool/king-louie/releases/latest) for `.deb`, other architectures, and older versions.

On first launch, the onboarding wizard walks you through selecting a provider and entering your API key.

---

## Features

### LLM & Providers
- **Multi-Provider LLM Support** — OpenAI, Anthropic, Google Gemini, Groq, Mistral, Ollama (local), OpenRouter, x.AI, DeepSeek, Qwen, Together, Fireworks, and Cohere
- **Smart LLM Routing** — Rule-based dynamic model selection routes messages to different providers based on keywords, regex patterns, or slash-command prefixes
- **LLM-Powered Model Router** — AI-driven model selection that automatically picks the best provider/model per task based on message content, cost, speed, and quality preferences
- **Prompt Caching** — Anthropic `cache_control` blocks on system prompts reduce input token costs by 50–90% on multi-turn conversations, with cache-aware cost tracking
- **Extended Thinking** — Claude 3.7+ models can use extended thinking with configurable budget tokens for deeper reasoning on complex tasks

### Agents & Tools
- **Agentic Tool Use** — Agents can execute shell commands, read/write/edit files, search the web, automate browsers, and more
- **Agent Streaming** — Real-time token-by-token streaming during agent loop iterations instead of waiting for the full response
- **Workflow Engine** — Durable, multi-step workflow execution with pause/resume, parallel task execution, dependency ordering, and persistent state across sessions
- **Planner Agent** — Decomposes high-level goals ("build a REST API with auth and tests") into structured task graphs that the workflow engine executes automatically
- **Dynamic Sub-Agents** — Agents can spawn specialized sub-agents mid-execution to handle subtasks with different models, tools, or system prompts
- **Background Tasks** — Spawn agent tasks that run asynchronously in the background while the main conversation continues, with output logging and status checking
- **Worktree Isolation** — Background tasks can run in isolated git worktrees to prevent file conflicts with the main workspace
- **Advisor Mode** — Optional second-model code review that automatically reviews agent-generated code changes for bugs, security issues, and performance problems
- **Multi-Agent Orchestration** — Run agents in parallel, serial, or dependency-based workflows

### Tools
- **20+ Built-in Tools** — Bash, Read, Write, Edit, MultiEdit, Glob, Grep, Git, WebSearch, WebFetch, Browser, ToolSearch, BackgroundTask, TaskStatus, SpawnAgent, and more
- **MultiEdit** — Batch edit multiple files in a single tool call with cascading failure isolation and per-file content caching
- **Deferred Tool Loading** — Core tools load inline; others are deferred behind a ToolSearch meta-tool that supports keyword search and exact selection — stabilizes prompts for caching
- **MCP Support** — Model Context Protocol client with stdio transport connects to any MCP server, automatically registering its tools into the tool registry
- **Git Safety Guards** — Blocks `--amend`, `--force`, `--no-verify`, interactive flags, `git add .`, and sensitive file patterns (.env, credentials, keys)
- **Structured Diffs** — Edit and Write tools generate unified diffs with line stats, displayed as colored diff blocks in the UI
- **Git Context Injection** — Current branch, working tree status, and recent commits are automatically injected into the system prompt

### Context & Performance
- **API-Native Context Compaction** — Clears old tool result content when approaching token limits (Anthropic provider), with embedding-based fallback for other providers
- **Semantic Context Assembly** — Dynamic per-turn tool and prompt section selection via embeddings, cutting token overhead by 30–60%
- **Result Persistence** — Oversized tool results are persisted to disk with a preview marker; the model can Read the full file if needed

### Integrations & Infrastructure
- **System App Discovery** — Auto-detects installed desktop applications (Excel, Photoshop, VS Code, etc.) so agents use local software instead of generating content via LLM
- **Extensible Skill System** — Install, remove, enable, and pin custom skill plugins
- **Mesh Networking** — Secure peer-to-peer communication between King Louie instances across machines
- **Channel Integrations** — Bridge conversations to Telegram, Discord, and Slack bots
- **Cron Scheduling** — Schedule recurring or one-time agent tasks with cron expressions
- **Semantic Memory** — Embedding-based memory with hot/warm/cold tiering and recall
- **Voice / TTS** — System TTS or ElevenLabs for voice responses
- **Webhooks** — HTTP endpoints for external automation triggers

### User Experience
- **Command Palette** — `Ctrl+K` opens a searchable command palette for quick access to all actions, commands, and settings
- **Keyboard Shortcuts** — `Ctrl+N` (new chat), `Ctrl+L` (clear input), `Ctrl+,` (settings), `Ctrl+Shift+E` (export)
- **Chat Search** — Real-time search box in the sidebar filters chats by title and preview text
- **Thinking Indicator** — Animated "Thinking..." appears while waiting for the LLM to respond, replaced when streaming begins
- **Agent Progress Bar** — Shows iteration count, current tool, and elapsed time during agent execution
- **Copy Code Button** — One-click copy button on code blocks with language badge and "Copied!" feedback
- **Diff Display** — Edit/Write tool results render as syntax-highlighted colored diffs instead of raw JSON
- **Retry on Error** — Failed messages show a "Retry" button to resend without retyping
- **Markdown Export** — Export conversations as readable Markdown with collapsible tool results
- **Welcome Card** — First-run quick-start tips for new users (API key setup, agent mode, commands)
- **Dark Theme UI** — Two-pane chat interface with syntax highlighting, markdown rendering, and image attachments
- **Cross-Platform Builds** — Windows (NSIS), macOS (DMG), and Linux (AppImage/DEB) via GitHub Actions

## Demo

[![Watch the demo](https://img.youtube.com/vi/Da4a_OJWFeM/maxresdefault.jpg)](https://youtu.be/Da4a_OJWFeM)

## Building from Source

```bash
npm install
npm start
```

### Troubleshooting: `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`

If `npm start` fails immediately with this error from `main.js`, something in
your environment has set `ELECTRON_RUN_AS_NODE=1`. That variable tells the
Electron binary to behave as plain Node, so there is no `app`, no `protocol`,
and no browser process — the main process crashes on the first Electron API it
touches.

It is most often inherited from another Electron-based program that spawned
your shell (VS Code's integrated terminal and Electron-based CLI agents both
set it). Unset it for the launch:

```bash
ELECTRON_RUN_AS_NODE= npm start          # bash / zsh
$env:ELECTRON_RUN_AS_NODE=$null; npm start   # PowerShell
```

The same applies when driving the app with Playwright's `_electron.launch` —
delete the key from the env you pass to the child, or it will fail with
"Process failed to launch!".

## Supported Providers

| Provider | Models | Local |
|----------|--------|-------|
| OpenAI | GPT-4o, GPT-5, o1, o3-mini, etc. | No |
| Anthropic | Claude Sonnet 4, Opus, Haiku, etc. | No |
| Google Gemini | Gemini 2.0 Flash, 2.5 Pro, etc. | No |
| Groq | Llama, Mixtral (ultra-fast inference) | No |
| Mistral | Mistral Large, etc. | No |
| Ollama | Any Ollama-hosted model | Yes |
| OpenRouter | Multi-provider router | No |
| x.AI | Grok 3, Grok 3 Mini | No |
| DeepSeek | DeepSeek Chat | No |
| Qwen | Qwen Plus | No |
| Together AI | Llama, open-source models | No |
| Fireworks AI | Llama, fast inference | No |
| Cohere | Command R+ | No |

Configure providers and API keys in **Settings**.

## Smart LLM Routing

King Louie can automatically route messages to different LLM providers based on configurable rules. Instead of manually switching providers, define rules once and let the router pick the best model for each task.

### How It Works

1. Go to **Settings > Smart Routing**
2. Toggle **Enable smart routing** on
3. Add rules — each rule has a **condition** (what to match) and a **target** (which provider/model to use)
4. Rules are evaluated in priority order; the first match wins
5. If no rule matches, the standard inference tier is used as a fallback

### Condition Types

| Type | Description | Example |
|------|-------------|---------|
| **Keyword** | Case-insensitive substring match (comma-separated, OR logic) | `documentation, write docs` |
| **Regex** | Regular expression test against the message | `\b(refactor\|redesign)\b` |
| **Prefix** | Slash-command at the start of the message (prefix is stripped before sending to the LLM) | `/code` |

### Example Rules

| Rule Name | Condition | Target |
|-----------|-----------|--------|
| Design with Claude | Keywords: `design, architect, plan feature` | Anthropic / claude-sonnet-4 |
| Docs with GPT | Keywords: `documentation, write docs, readme` | OpenAI / gpt-4o-mini |
| Code prefix | Prefix: `/code` | OpenAI / gpt-4o |
| Agent-only coding | Keywords: `implement, build` (agent mode only) | Anthropic / claude-sonnet-4 |

With these rules, typing "design a new auth system" automatically routes to Claude, while "write docs for the API" goes to GPT-4o-mini. Typing `/code implement a parser` routes to GPT-4o with the `/code` prefix stripped from the prompt.

### Rule Options

- **Priority** — Reorder rules with up/down arrows; lower position = higher priority
- **Enabled** — Toggle individual rules on/off without deleting them
- **Agent mode only** — Rule only applies when agent mode is active

## LLM-Powered Model Router

Beyond rule-based routing, King Louie can use AI to automatically select the best model for each task.

### How It Works

1. Go to **Settings > Workflows**
2. Enable **LLM-Powered Routing**
3. Configure your preferences:
   - **Cost Sensitivity** — Low (prefer quality), Medium, or High (prefer cheap)
   - **Speed Priority** — Low, Medium, or High (prefer fast)
   - **Quality Priority** — Low, Medium, or High
4. A fast, cheap classifier model analyzes each message and picks the best provider/model from your configured providers

The router maintains a cache of recent classifications to avoid redundant API calls. It falls back to rule-based routing or tier defaults if classification fails.

### When to Use Each

| Approach | Best For |
|----------|----------|
| **Tier-based** | Simple setups — one model for everything |
| **Rule-based** (Smart Routing) | Predictable patterns — always route `/code` to GPT-4o |
| **LLM-powered** | Dynamic workloads — let AI decide based on task content |

All three can coexist: LLM routing is tried first, then rule-based, then tier defaults.

## Workflow Engine

King Louie includes a durable workflow engine for executing complex, multi-step goals. Instead of manually breaking work into prompts, describe the outcome you want and let the system figure out the steps.

### How It Works

1. Go to **Settings > Workflows**
2. Enter a goal (e.g., "Build a REST API for user authentication with tests and documentation")
3. Click **Plan & Execute**

The system:
1. Runs the **Planner Agent** to decompose the goal into a structured task graph
2. Creates a **durable workflow** with dependency ordering and parallel groups
3. Executes tasks through the appropriate agents (code-writer, code-explorer, main)
4. Streams progress events to the UI in real-time

### Workflow Lifecycle

| Status | Meaning |
|--------|---------|
| `pending` | Created but not started |
| `running` | Tasks are being executed |
| `paused` | Execution suspended — can be resumed |
| `completed` | All tasks finished successfully |
| `failed` | A critical task failed |
| `cancelled` | Manually cancelled by user |

Workflows persist to disk and survive app restarts. A workflow that was `running` when the app closed will resume as `paused` on next launch.

### Task Graph

The planner outputs a JSON task graph with:
- **Tasks** — Each with a title, description, assigned agent, and priority
- **Dependencies** — Tasks only run after their dependencies complete
- **Parallel groups** — Independent tasks execute concurrently
- **Model preferences** — Tasks can suggest specific models (e.g., Gemini for research, Opus for deep reasoning)

### Workflow Controls

From the Workflows panel, you can:
- **Resume** a paused workflow
- **Pause** a running workflow
- **Cancel** a workflow entirely
- **Delete** a workflow and its saved state
- **Plan Only** — Generate the task graph without executing it

## Dynamic Sub-Agents

Agents can spawn specialized sub-agents mid-execution using the `SpawnAgent` tool. This enables recursive problem-solving — when an agent hits a subtask that needs different capabilities, it creates a new agent for it.

### Example

```
User: "Refactor the auth module and update the docs"

Main Agent:
  → SpawnAgent(agentId: "code-writer", task: "Refactor auth module to use JWT")
  → SpawnAgent(agentId: "code-writer", task: "Update API documentation to reflect auth changes")
```

### SpawnAgent Parameters

| Parameter | Description |
|-----------|-------------|
| `task` | The instruction for the sub-agent (required) |
| `agentId` | Which agent to use: `main`, `code-explorer`, `code-writer`, `planner` |
| `model` | Override the model (e.g., `gpt-4o`, `claude-sonnet-4-20250514`) |
| `provider` | Override the provider (e.g., `openai`, `anthropic`, `gemini`) |
| `maxIterations` | Max tool iterations (default: 10) |
| `systemPromptAppend` | Additional instructions for the sub-agent |
| `tools` | Restrict to specific tools (e.g., `["Read", "Grep"]`) |

Sub-agents run in their own conversation context and return results inline to the parent agent.

## System App Discovery

King Louie auto-detects installed desktop applications on your system and makes them available to agents. When a task can be done with local software (creating a spreadsheet, editing an image), agents will use the installed app instead of trying to generate content through the LLM.

### Auto-Detected Apps

The discovery engine checks platform-specific locations:

| Platform | Detection Method |
|----------|-----------------|
| **Windows** | PATH, Registry (COM), Start Menu, Program Files |
| **macOS** | `/Applications`, Spotlight (`mdfind`), PATH |
| **Linux** | `.desktop` files, PATH |

Categories include office (Excel, Word, LibreOffice), development (VS Code, Cursor), browsers, graphics (Photoshop, GIMP, Figma), media (OBS, VLC, FFmpeg), communication (Slack, Discord, Teams, Zoom), and more.

### Managing Apps

Go to **Settings > System Apps** to:
- **View** all discovered apps grouped by category with their launch commands
- **Re-scan** to refresh after installing new software
- **Add custom apps** for software in non-standard locations
- **Remove** custom app entries

Custom apps persist across restarts and are merged with auto-detected apps in the agent system prompt.

### How Agents Use It

The discovered app list is injected into every agent's system prompt. When you ask "create a spreadsheet of Q1 sales data", the agent will:

1. Generate the `.xlsx` file content using a library
2. Launch Excel (or whatever spreadsheet app is installed) to open it

Instead of trying to render a table in chat or generating a CSV via the LLM.

## Built-in Tools

Agents have access to a suite of tools that can be individually approved or auto-approved:

| Tool | Description |
|------|-------------|
| `Bash` | Execute shell commands (platform-aware) |
| `Read` | Read file contents |
| `Write` | Create or overwrite files (generates diff for overwrites) |
| `Edit` | Exact string replacement in files (generates unified diff) |
| `MultiEdit` | Batch edit multiple files in a single call with cascading failure isolation |
| `Grep` | Regex content search across files |
| `Glob` | File pattern matching |
| `Git` | Git operations with safety guards (blocks --amend, --force, --no-verify, sensitive files) |
| `WebSearch` | Search the web (Brave, Tavily) |
| `WebFetch` | Fetch and parse web pages |
| `Browser` | Headless browser automation via CDP |
| `ToolSearch` | Search and load deferred tool schemas on demand (keyword, exact, or prefix match) |
| `SpawnAgent` | Dynamically spawn sub-agents with different models, tools, or specializations |
| `BackgroundTask` | Spawn agent tasks that run asynchronously with optional worktree isolation |
| `TaskStatus` | Check status, read output, list, or stop background tasks |
| `Cron` | Manage scheduled tasks |
| `RemoteDispatch` | Dispatch tasks to remote King Louie peers on the mesh network |
| `AskUser` | Request user input during execution |
| `Skill` | Invoke installed skill plugins |
| `RequestTools` | Legacy escape hatch for requesting additional tools mid-conversation |

### Browser Tool — Using Your Chrome Profile

By default, the browser tool launches with an isolated temporary profile (no saved logins or cookies). To browse authenticated sites like Reddit, GitHub, or Gmail, you can start the browser with your existing Chrome profile:

```
User: "Check my Reddit for new comments on my posts"
Agent: [starts browser with your Chrome profile, navigates to reddit.com — already logged in]
```

The `start` action accepts three optional parameters:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `userDataPath` | Path to your Chrome User Data directory | `C:\Users\you\AppData\Local\Google\Chrome\User Data` |
| `profileDirectory` | Which profile folder to use | `Default`, `Profile 1`, `Profile 2` |
| `headless` | Show the browser window (default: `true`) | `false` to see the browser |

**Finding your profile path:**

1. Open Chrome with the profile you want to use
2. Navigate to `chrome://version`
3. Look at the **Profile Path** — it will be something like:
   ```
   C:\Users\you\AppData\Local\Google\Chrome\User Data\Profile 1
   ```
   - The **User Data** directory is the `userDataPath`
   - The last segment (`Profile 1`) is the `profileDirectory`

**Important:** Chrome locks its profile directory while running. You must **close Chrome completely** before King Louie can launch with that profile. If Chrome is open, the browser will fail to start or start without your session data.

**Typical paths by platform:**

| Platform | User Data Path |
|----------|---------------|
| Windows | `C:\Users\<you>\AppData\Local\Google\Chrome\User Data` |
| macOS | `~/Library/Application Support/Google/Chrome` |
| Linux | `~/.config/google-chrome` |

## Agent System

King Louie ships with four built-in agents, each with their own system prompt template and tool allowlist:

- **main-assistant** — General-purpose chat and task execution
- **code-explorer** — Code analysis, search, and explanation
- **code-writer** — Code generation and implementation
- **planner** — Decomposes high-level goals into structured task graphs for the workflow engine

Agents run in an agentic loop with configurable max iterations and token tracking. The orchestrator supports parallel, serial, and dependency-based multi-agent execution. Agents can also spawn sub-agents dynamically using the `SpawnAgent` tool.

## Skills

Skills are plugins that extend King Louie with custom commands, tools, and behaviors. They live in the `skills/` directory and can be managed through the UI.

Each skill can:
- Register slash commands
- Provide custom tools to agents
- Maintain persistent state
- Be pinned to a chat session to handle free-form messages
- Expose configurable settings
- Declare system dependencies with platform-specific install instructions

### System Dependencies

Skills can declare external CLI tools they require (e.g., `gh`, `docker`, `git`) in their metadata via `systemDependencies`. When a skill is loaded:

1. The loader checks each declared dependency against the host system
2. The skill still loads even if dependencies are missing (so it appears in the UI)
3. Commands are blocked at execution time with a user-friendly error that includes install instructions for the current platform
4. The UI can re-check dependencies on demand after the user installs a tool (`skill:checkDeps`)

Example dependency declaration:

```js
getMetadata() {
  return {
    id: 'my-skill',
    // ...
    systemDependencies: [
      {
        command: 'docker',
        name: 'Docker',
        required: true,
        installUrl: 'https://docs.docker.com/get-docker/',
        install: {
          win: 'winget install --id Docker.DockerDesktop',
          mac: 'brew install --cask docker',
          linux: 'sudo apt install docker.io'
        }
      }
    ]
  };
}
```

Dependencies can be `required: true` (blocks commands when missing) or `required: false` (warns but allows execution).

### Building a Skill

A skill is a Node.js module that extends the `Skill` base class from `king-louie/skill-interface`:

```js
const { Skill } = require('king-louie/skill-interface');

class MySkill extends Skill {
  getMetadata() {
    return {
      id: 'my-skill',
      name: 'My Skill',
      version: '1.0.0',
      description: 'What it does',
      author: 'you',
      commands: ['my'],
      systemDependencies: []  // external CLI tools needed
    };
  }

  async initialize(context) { /* setup */ }
  async handleCommand(command, args, context) { /* handle /my <args> */ }
}

module.exports = MySkill;
```

**Required methods:** `getMetadata()`, `initialize()`, `handleCommand()`

**Optional methods:** `resolveCode()`, `resolveCli()`, `resolvePrompt()`, `handleMessage()`, `getSettingsSchema()`, `getHelp()`, `cleanup()`

### Installing Skills

```bash
# From a GitHub repo
# Settings > Skills > Install, then paste the URL

# From a local directory (symlinked)
# Settings > Skills > Install, then paste the path
```

Skills are auto-discovered from the `skills/` directory on startup. User-installed skills go to `%APPDATA%/King Louie/skills/` (Windows) or `~/.config/King Louie/skills/` (Linux/macOS).

## Channel Integrations

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Add the token in Settings or via `/llm telegram add <token>`
3. The bridge starts automatically

### Discord

1. Create a Discord application and bot
2. Add the bot token in Settings
3. Configure mention gating and channel allowlists

### Slack

1. Create a Slack app with Socket Mode enabled
2. Add the bot and app-level tokens in Settings

### Common Commands (all channels)

- `/help` — Available agents and commands
- `/status` — Gateway and session status
- `/clear` — Clear session history
- `/agent <name>` — Switch agent
- `/pin <skill-id>` — Pin a skill to the chat
- `/unpin` — Remove pinned skill

Tool approvals are handled inline with approve/deny buttons.

## Mesh Networking

King Louie instances can securely communicate with each other over an encrypted peer-to-peer mesh network. This lets you dispatch tasks from one machine to another — for example, sending a GPU-heavy build from your laptop to your desktop, or coordinating a swarm of instances across a cluster.

### How It Works

Each King Louie instance generates a unique cryptographic identity (Ed25519 keypair + self-signed TLS certificate) on first launch. Instances establish trust through a pairing code exchange, then communicate over TLS-encrypted WebSocket connections with mutual authentication.

### Setting Up Two Machines

**Step 1: Open Settings > Mesh Network on both machines**

Give each machine a descriptive name and capability tags:

- Desktop: Display Name = `Desktop GPU Rig`, Capabilities = `gpu, build-server`
- Laptop: Display Name = `Work Laptop`, Capabilities = `portable`

Click **Save Identity** on each.

**Step 2: Pair the machines**

On your **desktop**, click **Generate Code**. You'll get a 6-word code like:

```
bamboo crystal dolphin garden silver thunder
```

On your **laptop**, click **Enter Code** and type in the code, the desktop's IP address (e.g., `192.168.1.50`), and port (`18791`).

The machines exchange public keys and TLS certificate fingerprints. Once paired, they'll auto-connect whenever both are online.

**Step 3: Dispatch tasks**

In any chat on your laptop, ask the agent to run something remotely:

> "Build the release binary on my desktop"

The agent uses the `RemoteDispatch` tool to send the task to the desktop's King Louie, which executes it and returns the result.

### LAN Auto-Discovery

If `bonjour-service` is installed (`npm install bonjour-service`), King Louie automatically discovers other instances on the same local network via mDNS. Discovered peers appear in the Mesh Network settings panel. You still need to pair before they can communicate — discovery just makes finding each other easier.

### Manual Peer Connection

For machines on different networks (VPN, Tailscale, WireGuard), add peers manually:

1. Go to **Settings > Mesh Network > Add Peer Manually**
2. Enter the remote machine's IP address and mesh port (default: `18791`)
3. Click **Connect**

The machines must already be paired (via pairing code) for the connection to succeed.

### Swarm Mode

For distributed workloads like model training, King Louie supports swarm coordination:

1. A coordinator instance decomposes work into sub-tasks with dependencies
2. Sub-tasks are proposed to capable peers based on their capability tags
3. Peers accept or reject based on current load
4. The coordinator dispatches tasks as dependencies resolve, collecting results

The orchestrator's existing dependency graph (`executeWithDependencies`) handles task ordering — tasks with `metadata.targetPeer` are dispatched remotely instead of locally.

### Agent Usage Examples

The `RemoteDispatch` tool is available to agents in any chat:

```
User: "List my connected peers"
Agent: [calls RemoteDispatch with action: "peers"]
→ 1 peer connected: Desktop GPU Rig (kl-a1b2c3d4e5f6) — capabilities: gpu, build-server

User: "Run cargo build --release on the desktop"
Agent: [calls RemoteDispatch with action: "dispatch", peer: "Desktop GPU Rig", message: "Run cargo build --release in /projects/myapp"]
→ Task dispatched to Desktop GPU Rig, completed in 45s

User: "Train the model across all GPU machines"
Agent: [decomposes into sub-tasks, dispatches to capable peers via swarm]
→ Swarm completed: 3 sub-tasks across 2 peers
```

### Security

All mesh communication is secured with multiple layers:

| Layer | Protection |
|-------|-----------|
| TLS 1.3 | Encrypts all traffic — prevents eavesdropping |
| Certificate pinning | Each peer's TLS cert fingerprint is pinned at pairing time — prevents MITM |
| Ed25519 mutual auth | Challenge-response on every connection — proves identity |
| Signed envelopes | Every message is cryptographically signed — prevents tampering |
| Nonce + expiry | Messages expire after 5 minutes, nonces tracked — prevents replay |
| Trusted peers only | Connections from unknown peers rejected at TLS handshake |

Private keys are encrypted at rest via Electron's `safeStorage` API.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Mesh Port | `18791` | WebSocket server port (binds to `0.0.0.0`) |
| LAN Discovery | Enabled | mDNS broadcast/browse for local peers |
| TLS | Enabled | Self-signed cert encryption (disable only for debugging) |
| Task Timeout | 5 minutes | Max time to wait for a remote task result |

### Network Requirements

- **Same LAN**: Works out of the box. mDNS handles discovery, direct connection over local IP.
- **VPN / Tailscale / WireGuard**: Add peers manually by VPN IP address. mDNS may not cross subnets.
- **Different NATs**: Requires port forwarding or a VPN. A relay server is planned for future releases.

## Cron Scheduling

Schedule agent tasks to run automatically:

- **`at`** — One-time execution at a specific time
- **`every`** — Recurring interval
- **`cron`** — Standard cron expressions

Configurable concurrency limits and tick intervals. Manage via the cron tool or UI.

## Memory System

King Louie includes an embedding-based semantic memory system:

- **Capture** — Save successes, failures, preferences, and context
- **Recall** — Vector similarity search across memory
- **Tiering** — Automatic hot (≤7 days), warm (8–90 days), and cold (>90 days) classification
- **Session-scoped** — Memory can be scoped to specific sessions

## Webhooks

Register HTTP webhooks for external automation:

- `POST /webhooks/{webhookId}` — Trigger a webhook
- `GET /health` — Health check
- Signature verification via `X-Hub-Signature-256`
- CORS support

The webhook server runs on the gateway port + 1.

## Voice / TTS

Optional text-to-speech for responses:

- **System TTS** — Native platform speech (Windows SAPI, macOS AVFoundation, Linux espeak)
- **ElevenLabs** — High-quality cloud voices with configurable voice ID, speed, and style

Supports automatic voice responses for long messages in Telegram.

## Hooks

Hooks run custom logic before or after tool execution:

- **security-validator** — Blocks dangerous shell commands before execution
- **log-tool-usage** — Logs all tool executions
- **memory-failure-capture** — Captures failures into memory

Add custom hooks in the `hooks/` directory with a `hook.json` manifest and `index.js` handler.

## MCP (Model Context Protocol)

King Louie includes an MCP client that connects to any MCP-compatible server over stdio, giving agents access to databases, APIs, and specialized tools without custom code.

### Configuration

Add MCP servers in your settings:

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "mydb.db"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

### How It Works

1. On startup, King Louie spawns each configured MCP server as a child process
2. Connects via the MCP JSON-RPC 2.0 protocol (Content-Length framing over stdin/stdout)
3. Lists the server's tools and registers them in the tool registry as `mcp__<server>__<tool>`
4. Tools become available to agents via ToolSearch (deferred loading)
5. When an agent calls an MCP tool, King Louie proxies the request to the server and returns the result

### Supported Transports

Currently stdio only. SSE and WebSocket transports are planned.

## Advisor Mode

An optional second-model review pass that catches bugs before they land.

### Setup

In Settings, configure the advisor:

```json
{
  "advisor": {
    "enabled": true,
    "model": "claude-sonnet-4-20250514"
  }
}
```

### How It Works

1. After the agent loop completes, the advisor reviews all code changes (Edit, Write, MultiEdit diffs)
2. A focused review prompt checks for bugs, security issues, and performance problems
3. Returns a verdict: **LGTM** or **ISSUES FOUND** with specific feedback
4. The review is appended to the chat so you can see it inline

The advisor uses the same provider as the main agent but can target a different model. Its cost is tracked separately.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open command palette |
| `Ctrl+N` | New chat |
| `Ctrl+L` | Clear input |
| `Ctrl+,` | Open settings |
| `Ctrl+Shift+E` | Export chat |
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `Escape` | Close palette/settings/modals |

The command palette (`Ctrl+K`) provides fuzzy search across all commands and actions.

## Notifications

Configurable notification routing based on response duration:

- **UI Toast** — In-app notifications for short responses
- **Ntfy** — External push notifications via ntfy.sh for long-running tasks

## Project Structure

```
main.js                  # Electron main process
preload.js               # Secure IPC bridge (context isolation)
renderer.js              # Frontend UI logic (command palette, search, streaming, diffs)
index.html               # App layout
styles.css               # Dark theme styles + UX enhancement CSS
src/
  agents/                # Agent definitions and orchestrator
  browser/               # Headless browser automation
  channels/              # Telegram, Discord, Slack bridges
  context/               # Context assembly, compaction, and system prompt sections
    context-assembler.js # Deferred/semantic tool loading and prompt assembly
    api-compaction.js    # API-native context compaction (clears old tool results)
    system-sections.js   # System prompt sections (environment, git context, CLI tools)
  cron/                  # Scheduled task system
  execution/             # Agent loop, tool executor, sandbox, app discovery
    agent-loop.js        # Core agent-tool loop with streaming and compaction
    advisor.js           # Optional second-model code review
    worktree.js          # Git worktree isolation for concurrent agents
  gateway/               # WebSocket gateway and session manager
  hooks/                 # Pre/post tool execution hooks
  ipc/                   # IPC handler registration
  mcp/                   # Model Context Protocol client
    mcp-client.js        # JSON-RPC 2.0 over stdio with Content-Length framing
    mcp-manager.js       # Multi-server lifecycle and tool registration
  media/                 # Image handling and multimodal support
  memory/                # Semantic memory and vector store
  mesh/                  # Peer-to-peer mesh networking
  notifications/         # Notification routing
  providers/             # LLM provider implementations (prompt caching, extended thinking)
  skills/                # Skill loader, registry, and pinning
  tasks/                 # Task manager and background task system
  tools/                 # Tool registry and 20+ built-in tools
    builtin/             # Bash, Read, Edit, MultiEdit, Write, Git, ToolSearch, etc.
    builtin/diff-utils.js# Unified diff generation for Edit/Write results
  tracking/              # Token usage and cost tracking
  voice/                 # TTS engines
  web-search/            # Search provider integrations
  webhooks/              # Webhook server and handlers
  workflows/             # Durable workflow engine and planner executor
  wizard/                # Onboarding wizard
skills/                  # Installable skill plugins
hooks/                   # Custom hook plugins
templates/               # Agent system prompt templates
tests/                   # Test suite (90+ test files)
build/                   # Build configuration and signing
```

## Development

```bash
# Run tests
npm test

# Build for current platform
npm run build

# Platform-specific builds
npm run build:win
npm run build:mac
npm run build:linux
```

## Security

- Context isolation enabled — renderer has no direct Node.js access
- All IPC calls validated through the preload bridge
- HTML sanitized with DOMPurify
- Tool execution requires approval (configurable auto-approve lists)
- Pre-execution security hooks block dangerous commands
- **Git safety guards** — Blocks `--amend` (always creates new commits), `--force`, `--no-verify`, interactive flags, `git add ./-A` (must stage specific files), and sensitive file patterns (.env, .pem, credentials.json, etc.)
- **Worktree isolation** — Background agents can run in isolated git worktrees to prevent file conflicts
- **Pattern-based permission rules** — First-match-wins rules with allow/ask/deny actions and denial tracking
- Webhook signature verification
- Mesh networking: TLS 1.3 encryption, Ed25519 signed messages, certificate pinning, replay protection

## License

MIT — see [LICENSE.txt](LICENSE.txt)
