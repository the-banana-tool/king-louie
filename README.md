# King Louie

An open-source, cross-platform AI chat desktop application built with Electron. Bring your own API keys and chat with multiple LLM providers through a modern dark-themed interface — or connect King Louie to Telegram, Discord, and Slack as a bot.

![Electron](https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

## Features

- **Multi-Provider LLM Support** — OpenAI, Anthropic, Google Gemini, Groq, Mistral, Ollama (local), and OpenRouter
- **Smart LLM Routing** — Rule-based dynamic model selection routes messages to different providers based on keywords, regex patterns, or slash-command prefixes
- **Agentic Tool Use** — Agents can execute shell commands, read/write/edit files, search the web, automate browsers, and more
- **Multi-Agent Orchestration** — Run agents in parallel, serial, or dependency-based workflows
- **Extensible Skill System** — Install, remove, enable, and pin custom skill plugins
- **Mesh Networking** — Secure peer-to-peer communication between King Louie instances across machines
- **Channel Integrations** — Bridge conversations to Telegram, Discord, and Slack bots
- **Cron Scheduling** — Schedule recurring or one-time agent tasks with cron expressions
- **Semantic Memory** — Embedding-based memory with hot/warm/cold tiering and recall
- **Voice / TTS** — System TTS or ElevenLabs for voice responses
- **Webhooks** — HTTP endpoints for external automation triggers
- **Dark Theme UI** — Two-pane chat interface with syntax highlighting, markdown rendering, and image attachments
- **Cross-Platform Builds** — Windows (NSIS), macOS (DMG), and Linux (AppImage/DEB) via GitHub Actions

## Quick Start

```bash
# Install dependencies
npm install

# Run the app
npm start
```

On first launch, the onboarding wizard walks you through selecting a provider and entering your API key.

## Supported Providers

| Provider | Models | Local |
|----------|--------|-------|
| OpenAI | GPT-4o, GPT-4, etc. | No |
| Anthropic | Claude Sonnet, Opus, etc. | No |
| Google Gemini | Gemini Pro, Flash, etc. | No |
| Groq | Llama, Mixtral, etc. | No |
| Mistral | Mistral models | No |
| Ollama | Any Ollama-hosted model | Yes |
| OpenRouter | Multi-provider router | No |

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

## Built-in Tools

Agents have access to a suite of tools that can be individually approved or auto-approved:

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands (platform-aware) |
| `read` | Read file contents |
| `write` | Write files |
| `edit` | Edit file ranges |
| `grep` | Regex content search |
| `glob` | File pattern matching |
| `git` | Git operations |
| `web_search` | Search the web (Brave, Tavily) |
| `web_fetch` | Fetch and parse web pages |
| `browser` | Headless browser automation via CDP |
| `cron` | Manage scheduled tasks |
| `remote_dispatch` | Dispatch tasks to remote King Louie peers on the mesh network |
| `ask_user` | Request user input during execution |

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

King Louie ships with three built-in agents, each with their own system prompt template and tool allowlist:

- **main-assistant** — General-purpose chat and task execution
- **code-explorer** — Code analysis, search, and explanation
- **code-writer** — Code generation and implementation

Agents run in an agentic loop with configurable max iterations and token tracking. The orchestrator supports parallel, serial, and dependency-based multi-agent execution.

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

## Notifications

Configurable notification routing based on response duration:

- **UI Toast** — In-app notifications for short responses
- **Ntfy** — External push notifications via ntfy.sh for long-running tasks

## Project Structure

```
main.js                  # Electron main process
preload.js               # Secure IPC bridge (context isolation)
renderer.js              # Frontend UI logic
index.html               # App layout
styles.css               # Dark theme styles
src/
  agents/                # Agent definitions and orchestrator
  browser/               # Headless browser automation
  channels/              # Telegram, Discord, Slack bridges
  cron/                  # Scheduled task system
  execution/             # Agent loop, tool executor, sandbox
  gateway/               # WebSocket gateway and session manager
  hooks/                 # Pre/post tool execution hooks
  ipc/                   # IPC handler registration
  media/                 # Image handling and multimodal support
  memory/                # Semantic memory and vector store
  mesh/                  # Peer-to-peer mesh networking
  notifications/         # Notification routing
  providers/             # LLM provider implementations
  skills/                # Skill loader, registry, and pinning
  tasks/                 # Task manager
  tools/                 # Tool registry and built-in tools
  tracking/              # Token usage and cost tracking
  voice/                 # TTS engines
  web-search/            # Search provider integrations
  webhooks/              # Webhook server and handlers
  wizard/                # Onboarding wizard
skills/                  # Installable skill plugins
hooks/                   # Custom hook plugins
templates/               # Agent system prompt templates
tests/                   # Test suite
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
- Webhook signature verification
- Mesh networking: TLS 1.3 encryption, Ed25519 signed messages, certificate pinning, replay protection

## License

MIT — see [LICENSE.txt](LICENSE.txt)
