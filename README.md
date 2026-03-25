# King Louie

An open-source, cross-platform AI chat desktop application built with Electron. Bring your own API keys and chat with multiple LLM providers through a modern dark-themed interface — or connect King Louie to Telegram, Discord, and Slack as a bot.

![Electron](https://img.shields.io/badge/Electron-40-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

## Features

- **Multi-Provider LLM Support** — OpenAI, Anthropic, Google Gemini, Groq, Mistral, Ollama (local), and OpenRouter
- **Agentic Tool Use** — Agents can execute shell commands, read/write/edit files, search the web, automate browsers, and more
- **Multi-Agent Orchestration** — Run agents in parallel, serial, or dependency-based workflows
- **Extensible Skill System** — Install, remove, enable, and pin custom skill plugins
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
| `ask_user` | Request user input during execution |

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

## License

MIT — see [LICENSE.txt](LICENSE.txt)
