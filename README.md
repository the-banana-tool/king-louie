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
- **Channel Integrations** — Bridge conversations to Telegram and Discord bots, behind a deny-by-default sender allowlist (Slack is connected but its inbound path is not wired to the agent yet)
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
set it). Setting the variable to an empty string is not enough — Electron
treats a present-but-empty value the same as `1`. It has to be removed from
the environment entirely:

```bash
unset ELECTRON_RUN_AS_NODE && npm start      # bash / zsh
$env:ELECTRON_RUN_AS_NODE=$null; npm start   # PowerShell
```

The same applies when driving the app with Playwright's `_electron.launch` —
delete the key from the env you pass to the child, or it will fail with
"Process failed to launch!".

## Running as a Service

King Louie can also run headless, with no Electron and no UI — driven instead
by chat channels (Telegram, Discord, Slack), cron, and, from later stages, a
multi-machine fleet. This is a separate entry point (`bin/king-louie-service.js`)
from the desktop app; the two can run side by side on one machine without
sharing data.

### Install

Always try `--dry-run` first — it prints every step the installer would take
without touching the system.

```bash
# Linux (systemd), from a root shell
sudo node bin/king-louie-service.js install --profile agent

# macOS (LaunchDaemon) — create a dedicated standard (non-root) account first,
# then install under it
sudo node bin/king-louie-service.js install --user <account>

# Windows, from an elevated (Run as administrator) shell — a boot-time
# Scheduled Task
node bin\king-louie-service.js install
```

`install` (and `uninstall`) require an elevated/root shell on every platform —
they write a systemd unit, a LaunchDaemon, or a Scheduled Task, none of which a
standard user can register.

Reinstalling is safe: it skips creating the service account if one already
exists, and it never overwrites an existing master key — a second `install`
run reuses the key the first one generated. It also picks up the new service
definition: on Linux the unit is restarted after `enable --now`, and on macOS
any previously loaded LaunchDaemon is booted out before it is loaded again.

**Linux and macOS:** before anything is created, the installer checks that
every ancestor of the data directory is a real, root-owned directory, that the
data directory's immediate parent is neither group- nor world-writable, and
that the data directory itself is not a symlink. A missing parent (the default
macOS `…/KingLouie`) is created root-owned `0755`, so the service account
cannot later replace the data directory with a link. `--data-dir /tmp/…` and
any other path under a world-writable parent is refused: `install -d -o
<account>` chowns by name and would follow such a link, handing its target to
the service account on the next reinstall. No install step creates or chowns
anything *inside* the data directory — the service creates `logs/` and
`cache/` itself, under its own account.

**Windows only:** the installer creates the data directory itself with a
locked-down ACL (Full Control limited to `LOCAL SERVICE`, `SYSTEM` and
Administrators, with inheritance disabled). If its parent
(`%ProgramData%\KingLouie` for the default data dir) doesn't exist, it is
created Administrators-owned with its own protected ACL (Full Control to
`SYSTEM` and Administrators, read-only to `LOCAL SERVICE`). If either directory
already exists, the installer only *verifies* it — a hand-created directory, or
one with looser permissions, is refused rather than silently relocked. Fix or
remove it manually before retrying.

**Linux only:** `/etc/king-louie` is created root-owned with mode `0755`
(later stages keep read-only configuration there); only
`/etc/king-louie/credentials`, which holds the master key, is `0700`.

On every platform, if `node` or the entry script (`bin/king-louie-service.js`)
lives under a home directory (`/home`, `/root`, `/Users`, or `C:\Users\`), the
installer prints a warning: the service account (or anyone with access to it)
could then rewrite the binary it runs. Move the install to a system path.

### Configure

- **`<configDir>/service.json` sets `features` and `ports`.** The config
  directory is owned by root/Administrators and is only *readable* by the
  service account — the data directory is not, so nothing that decides
  whether a network listener exists is read from there:

  | Platform | `configDir` |
  |----------|-------------|
  | Linux | `/etc/king-louie` |
  | macOS | `/Library/Application Support/KingLouie/config` |
  | Windows | `%ProgramData%\KingLouie\config` |

  The Linux and macOS installers create it. On Windows, create it from the
  elevated shell after `install` (`mkdir %ProgramData%\KingLouie\config`);
  it inherits the parent's protected ACL, which grants `LOCAL SERVICE` read
  and execute only. If the file is missing, every feature stays off.

  The table shows the *default* data directory's config directory. An
  instance installed with a `--data-dir` of its own gets a config directory
  of its own, `config` beside that data directory — including on Linux,
  where every instance used to read the same `/etc/king-louie` and so
  inherited the first instance's `ports`. Two services on one machine can
  therefore carry different ports; the installer creates each one
  root-owned, and a config file the service account owns or could write is
  still refused.

  Every feature (`gateway`, `webhooks`, `mesh`, `channels`, `appDiscovery`) is
  **off by default**, and each one that is on is logged at startup naming the
  file that enabled it. `mesh` cannot be enabled in service mode yet: it is
  forced off (with a warning in the log) whatever the config says. On Linux
  and macOS the service refuses to read a `service.json` that is group- or
  world-writable, or one owned by the account the service runs as.

  `ports` defaults to `{ "gateway": 18793, "webhook": 18794 }` — clear of
  the desktop app's 18789/18790 *and* of the mesh port 18791, which the
  desktop app binds on `0.0.0.0` by default. A listener that is enabled but
  cannot bind its port is fatal: the service refuses to start rather than run
  without the listener you asked for.

- `profile` (`agent` or `runbook`) comes from `<configDir>/service.json` or
  the unit's `--profile`, never from `<dataDir>/service.json`: which profile
  runs decides whether the agent stack loads at all. `features`, `ports` and
  `profile` in the service-writable `<dataDir>/service.json` are all
  **ignored**, with a warning naming the file.
- `king-louie-service token set anthropic < keyfile` — stores a provider API
  key (read from stdin, never a CLI argument, so it doesn't end up in shell
  history or `ps`). The provider must be one king-louie knows (`openai`,
  `anthropic`, `groq`, …); an unknown name is rejected.
- `king-louie-service vault set <key> < valuefile` — stores an arbitrary
  secret in the vault the same way.
- `king-louie-service channel list|allow|remove|approval <channel> …` —
  manages who may drive the agent through Telegram or Discord, and where that
  channel's approvals go. A channel with an empty allowlist refuses everyone,
  so this is required before a channel does anything at all. See
  [Channel Integrations](#channel-integrations).

`token set`, `vault set` and the mutating `channel` subcommands against an
installed service:

- **Stop the service first.** They refuse (exit 1) while the service is
  running on that data dir, because the running service would overwrite the
  change with its own in-memory copy. `channel list` is read-only and stays
  available.
- Run them as root (Linux, macOS) or from an elevated shell (Windows). On
  Linux, root reads the same `<configDir>/credentials/kl-master-key` the
  unit hands the service; on Windows the key is DPAPI-protected in the
  machine scope — unwrappable by anything on the box, so what keeps it
  private is only the data dir's ACL, which grants `LOCAL SERVICE`,
  `SYSTEM` and Administrators (see the known gap below). On Linux and macOS, files the CLI creates in the data
  dir are handed back to the data dir's owner.
- Every data dir holds a `key-check` file written on first use. If a command
  resolves a different master key than the one the data dir was encrypted
  with (for example, run under the wrong account), it stops with an error
  naming the key source instead of writing secrets the service can't read.

The CLI's flag parsing is strict: an unknown `--flag`, a flag given with no
value, and an empty `--data-dir` all exit with status 2 rather than silently
falling back to a default. Both `--flag value` and `--flag=value` are
accepted.

### Default Data Directory

| Platform | Default `--data-dir` |
|----------|----------------------|
| Windows | `%ProgramData%\KingLouie\data` |
| macOS | `/Library/Application Support/KingLouie/data` |
| Linux | `/var/lib/king-louie` |

The service's *working directory* is `<dataDir>/workspace`, not the data
directory itself: the data directory holds the master key, the gateway
token and the encrypted stores, and the agent's read tools (`Read`,
`Grep`, `Glob`) are not approval-gated, so anything reachable from the
working directory is reachable from a chat message. The secret files are
additionally denied outright, whatever the working directory is. The
service process chdirs into that workspace at startup, so anything it
spawns without an explicit working directory — a stdio MCP server, for
instance — starts there too rather than in the data directory.

### Operate

- `king-louie-service status [--data-dir DIR]` — reports whether the service
  is running, by checking that the process named in `<dataDir>/service.pid`
  is alive.
- `king-louie-service doctor [--data-dir DIR]` — checks Node version, data
  directory permissions, and (on Windows) that the DPAPI-wrapped master key
  is present.
- Logs: on every platform the service appends its log to
  `<dataDir>/logs/service.log` (mode `0600` on Linux and macOS). Also
  `journalctl -u king-louie` on Linux and `/var/log/king-louie/service.out.log`
  / `service.err.log` on macOS (the LaunchDaemon's stdout/stderr, in a
  root-owned directory: launchd opens those paths itself and follows symlinks,
  so they must not sit anywhere the service account can write). On Windows,
  `service.log` is the only log: Task Scheduler's History tab records only
  that the task started and stopped, not its output.
- Stopping on Windows: `schtasks /End /TN KingLouie` (and `uninstall`, which
  runs it) terminates the process immediately — in stage 1 there is no
  graceful shutdown on Windows, so in-flight work is cut off. Linux and macOS
  send SIGTERM and the service shuts down cleanly.

### Security Notes

- **Master key location, per OS:** a systemd credential (`kl-master-key`,
  Linux with systemd; root outside the unit reads the same file from
  `/etc/king-louie/credentials`); Windows DPAPI in the `LocalMachine` scope
  in `master.key.dpapi`, kept private *only* by the data directory's ACL
  (`LocalMachine` scope means any code on the machine can unwrap it — see
  the known gap below); otherwise a `0600` key file at
  `<configDir>/credentials/kl-master-key` (macOS, and Linux without systemd
  credentials). That file is **outside** the data directory on purpose: a
  backup, a snapshot or a `tar` of the data directory would otherwise carry
  both the ciphertext and the key that opens it. The directory is root-owned
  and not writable by the service account, so the key can be read by the
  service but not replaced by it. A key already at the old location
  (`<dataDir>/master.key`) keeps working and the service logs where to move
  it; if there is no config directory at all, the key still lands in the data
  directory, with a warning saying so.
- The gateway (when enabled) requires a bearer token, kept encrypted in the
  store. A cleartext copy is written atomically to `<dataDir>/gateway-token`
  so local clients and CLI tooling can read it — but **only while the listener
  is actually bound**: the file is written after the bind succeeds and removed
  again when the gateway stops, so a failed start never leaves a valid
  credential on disk for a port nothing is listening on. On Linux and macOS it
  is mode `0600`; on Windows the mode bits are meaningless and its only
  protection is the data directory's ACL (`LOCAL SERVICE`, `SYSTEM` and
  Administrators). If secure storage is unavailable on that host, the token
  falls back to **session-only**: it still works for the current run but is
  regenerated (and every existing client rejected) on the next restart,
  rather than silently persisting in the clear.
- The service denies every action that requires interactive approval —
  stage 1 has no remote approver (phone approvals arrive in a later stage),
  so anything gated on approval simply fails. That includes requests from
  chat channels: if you turn `channels` on, a channel is never asked to
  approve (no Approve button is sent) and approval-gated tools are still
  denied. Setting a channel's approval target does not change that in service
  mode — it only matters in the desktop app.
- Chat channels are closed by default: a channel whose allowlist is empty
  refuses every sender, so turning `channels` on does not by itself let
  anyone in. `king-louie-service channel allow …` opens it one id at a time.
- On Windows the service runs as `LOCAL SERVICE`. It is low-privilege and has
  no access to any user's profile folders — but it is a **shared, built-in
  account**, not a dedicated identity for King Louie. Every other service on
  the machine that runs as `LOCAL SERVICE` (a third-party updater, an OEM
  agent, anything an attacker gets code execution inside) has the same SID, so
  the data directory's ACL grants it the same access: it can read the
  cleartext `<dataDir>\gateway-token` and drive the gateway, and it can read
  `master.key.dpapi` and run `ProtectedData.Unprotect` on it — the blob is
  `LocalMachine`-scoped with null entropy, so nothing beyond that ACL keeps
  it private — and from there decrypt every provider API key and vault
  entry. Treat "anything on this machine running as `LOCAL SERVICE`" as
  inside King Louie's trust boundary on Windows.

#### Known gap — Windows service identity

The shared-account problem above is a known gap, deferred to a dedicated
Windows-hardening stage rather than patched around. The fix is a dedicated
identity end to end:

1. The installer creates a low-privilege local account for the service (or
   uses a virtual service account, `NT SERVICE\KingLouie`, which Windows
   gives its own per-service SID).
2. The Scheduled Task's `<UserId>` becomes that SID instead of `S-1-5-19`.
3. `master.key.dpapi` is protected in the `CurrentUser` scope of that account
   (or `LocalMachine` with a per-install entropy blob) rather than plain
   `LocalMachine` + null entropy.
4. The data directory's SDDL names that SID alone in place of
   `(A;OICI;FA;;;LS)`, so no other service on the box can read the data dir.

Linux and macOS already have this: the installer creates a dedicated
`king-louie` / `--user <account>` service account, and nothing else on the
machine runs as it.

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

A chat bot's handle is not a secret. Anyone who finds it can message it, so
King Louie treats a channel as a **front door that starts locked**: a channel
nobody has configured refuses every sender, including you. Set up the token
first, then allowlist yourself.

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Add the token in Settings or via `/llm telegram add <token>`
3. The bridge starts automatically
4. Message the bot. It replies once with your user id and ignores you.
5. Add that id under **Settings > Channels > Telegram Access** — it is waiting
   there under "Recently refused" with an **Allow User** button.

### Discord

1. Create a Discord application and bot
2. Add the bot token in Settings
3. Allowlist yourself under **Settings > Channels > Discord Access**, the same
   way (Developer Mode → Copy User ID, or use the id the bot replies with)
4. Mention gating (**Require @mention**) is a separate, narrower control: it
   decides when an *already allowed* sender's message is answered in a group.

### Slack

1. Create a Slack app with Socket Mode enabled
2. Add the bot and app-level tokens in Settings

Slack has **no allowlist and no approval routing** — its inbound path is not
wired up to the agent yet, so nothing a Slack user sends reaches a tool. Do
not treat it as gated; treat it as not finished.

### Who may message the bot

| Where | How |
|-------|-----|
| Desktop | **Settings > Channels > _channel_ Access** — allowed users, allowed groups/channels, add and remove, plus a one-click **Allow** for whoever was just refused |
| Service | `king-louie-service channel list telegram`<br>`king-louie-service channel allow telegram 123456789`<br>`king-louie-service channel allow discord <channel-id> --group`<br>`king-louie-service channel remove telegram 123456789` |

The allowlist holds **user ids** and **group/channel ids**: a message is
accepted if its sender is allowed, *or* if it arrives in an allowed group.
Allowing a group therefore trusts everyone in it. There is no "allow
everyone" switch in either surface, and none on disk either: a stored
`default: "allow"` — which every build before this one wrote for any policy
that did not say otherwise — is ignored and rewritten to `deny` the first
time it is read, with a warning naming the channel. The explicit ids are
kept.

An unrecognised sender who addressed the bot gets **one** reply telling them
their id, and is ignored after that, so the refusal is discoverable without
handing a stranger a message pump. In a group, someone who never addressed
the bot gets no reply at all — the notice names their id and the group id,
and that is not published into a room on a bystander's behalf. The owner
still learns the id: the desktop pane lists whoever was just refused, and on
a headless install the same ids are in `<dataDir>/logs/service.log` (the
first message from each unknown sender logs at `warn`).

### Tool approvals from a channel

An approval prompt is **never sent back to the chat that asked for the tool** —
that would let a sender approve their own `Bash` calls. It goes only to an
owner chat you name explicitly:

| Where | How |
|-------|-----|
| Desktop | **Settings > Channels > _channel_ Access > Approvals** |
| Service | `king-louie-service channel approval telegram <your-chat-id>`<br>`king-louie-service channel approval telegram --clear` |

**Until you set it, every approval-gated tool call from that channel is
denied** — no Approve button is sent anywhere. The target must not be the chat
the request came from; if it is, the approval is denied rather than
self-served. Only the configured approver's button press counts; a press from
the requesting chat is refused.

In **service mode this is moot**: stage 1 has no remote approver at all and
denies everything that needs approval, whatever `approvalChatId` says.

### Common Commands (all channels)

- `/help` — Available agents and commands
- `/status` — Gateway and session status
- `/clear` — Clear session history
- `/agent <name>` — Switch agent
- `/pin <skill-id>` — Pin a skill to the chat
- `/unpin` — Remove pinned skill

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

A peer's Ed25519 private key and its TLS private key are **encrypted at rest**
under the host's cipher — Electron `safeStorage` in the desktop app, the
service's master key headless — and only the public halves (peer id, public
key, certificate, fingerprint) are stored in the clear. An identity created by
an older build, which wrote both private keys in plaintext, is re-encrypted in
place the first time it is loaded; the peer id and certificate fingerprint do
not change, so existing pairings survive. On a host with no secure storage at
all the keys fall back to plaintext with a warning in the log — a cipher that
is available but fails is an error, never a silent fallback.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Mesh Port | `18791` | WebSocket server port (binds to `0.0.0.0`) |
| LAN Discovery | Enabled | mDNS broadcast/browse for local peers |
| TLS | Enabled | Self-signed cert encryption (disable only for debugging) |
| Task Timeout | 5 minutes | Max time to wait for a remote task result |

Ports used across the project, so nothing collides on a machine running both
hosts:

| Port | Used by | Binds |
|------|---------|-------|
| `18789` / `18790` | desktop app gateway / webhooks | `127.0.0.1` |
| `18791` | mesh (desktop app; off in service mode) | `0.0.0.0` |
| `18793` / `18794` | service-mode gateway / webhooks (default) | `127.0.0.1` |

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
- **No browser may reach it.** A request carrying an `Origin` header, or any
  `Sec-Fetch-*` fetch metadata, is refused with `403` — including a `no-cors`
  `GET /health`, which sends no `Origin` and would otherwise tell any page you
  visit that something is listening on that port.

The webhook server runs on the gateway port + 1 unless a port is set
explicitly — in service mode that is `ports.webhook` in the admin-owned
`<configDir>/service.json`, defaulting to `18794`.

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
- Tool execution requires approval. Your own permission rules decide what runs
  unattended; an explicit `ask` or `deny` rule beats every auto-approve list,
  including agent mode's and an agent definition's own
- The host's own secrets (`master.key`, `master.key.dpapi`, `key-check`,
  `gateway-token`, and the store/vault JSON) are out of bounds for every
  path-gated tool — `Read`, `Grep` and `Glob` refuse them whatever the
  working directory and allowed directories say
- Chat channels deny unknown senders, and a channel's approval prompt goes
  only to an owner chat you configured — never back to the requester
- Pre-execution security hooks block dangerous commands
- **Git safety guards** — Blocks `--amend` (always creates new commits), `--force`, `--no-verify`, interactive flags, `git add ./-A` (must stage specific files), and sensitive file patterns (.env, .pem, credentials.json, etc.)
- **Worktree isolation** — Background agents can run in isolated git worktrees to prevent file conflicts
- **Pattern-based permission rules** — First-match-wins rules with allow/ask/deny actions and denial tracking
- Webhook signature verification
- Mesh networking: TLS 1.3 encryption, Ed25519 signed messages, certificate pinning, replay protection

## Breaking Changes

Changes on this branch that will alter behaviour on an existing install.

### Chat channels refuse unknown senders

A Telegram or Discord channel whose allowlist is empty now **denies every
sender**, where it used to allow everyone by default. Any stranger who found
the bot's handle could previously drive the agent. That includes a channel
carrying a stored `default: "allow"` from an earlier build: it is ignored and
rewritten to `deny`, so a channel that looked closed in the settings pane
while being open to everyone is now closed in fact.

*If you were using a channel, it stops answering until you allowlist yourself*
— Settings > Channels > _channel_ Access on the desktop, or
`king-louie-service channel allow …` headless. The bot replies once to an
unrecognised sender with the id to add.

### Channel tool approvals need an owner target

An approval prompt used to be sent to the chat that asked for the tool, which
meant an attacker approved their own `Bash` calls. It now goes only to
`channels.<channel>.approvalChatId`, and **every channel approval is denied
until that is set** (and denied if it names the requesting chat). Set it in
the same two places as the allowlist.

### Desktop agent mode prompts again

Agent mode hard-coded `Bash, Read, Edit, Write, Glob, Grep, Git` as
auto-approved, which silently overrode the user's own `ask` rules for exactly
the seven most dangerous tools. It no longer sets an auto-approve list at all:
what runs unattended is decided by your permission rules and the persisted
"always approve" list. **Expect approval prompts in agent mode where there
were none.** Add `allow` rules for what you want unattended.

### Service `features` and `ports` moved out of `<dataDir>/service.json`

`features` and `ports` are now read **only** from `<configDir>/service.json`,
which is root/Administrators-owned and read-only to the service account
(`/etc/king-louie`, `/Library/Application Support/KingLouie/config`,
`%ProgramData%\KingLouie\config`). The data dir is writable by the service
account, so one `write_file` from a prompt injection could otherwise re-enable
a network listener at the next restart.

*`features`/`ports` left in `<dataDir>/service.json` are ignored, with a
warning naming the file.* `profile` still comes from there. If the admin file
is missing, every feature stays off.

### Default service ports moved 18791/18792 → 18793/18794

The old service defaults collided with the documented mesh port `18791`, which
the desktop app binds on `0.0.0.0`. Update anything pointing at the old ports,
or set `ports` in `<configDir>/service.json`.

Relatedly, a listener the operator explicitly enabled that **cannot bind is
now fatal** — the service refuses to start rather than running without it.

### node.yaml rejects unknown keys

`node.yaml` used to ignore any key it did not know. A misspelled
`always_confirm` or `allowed_roots` therefore fell back silently to the
defaults, which can be looser than what you wrote. That applies to the copy in
`<configDir>` and to the one in a stdio MCP instance's config dir. **A node whose `node.yaml` carries a stray or
misspelled key now refuses to start** (`mcp` exits at startup, and the service
refuses to start). The error names the key and the keys allowed at that level:

```
Invalid /etc/king-louie/node.yaml: unknown key "policy.allowed_root" (known: allowed_roots, remote_sessions, max_concurrent_jobs)
```

`king-louie-service doctor` shows the same message on its
`node config / runbooks health` row. Fix it by removing or correcting the key.

### Unknown `features` and `ports` keys in `service.json` are errors

`<configDir>/service.json` used to accept any feature name and ignore the
ones it did not know, so `"webhook": true` (for `webhooks`) quietly left the
listener off. An unknown key under `features` or `ports` now stops the service
from starting, with the same wording as `node.yaml`:

    Invalid /etc/king-louie/service.json: unknown key "features.webhook" (known: gateway, webhooks, mesh, channels, appDiscovery)

The service-writable `<dataDir>/service.json` is unchanged: its `features` and
`ports` are still ignored with a warning.

### `<dataDir>/gateway-token` exists only while the gateway is up

The cleartext bearer-token file is written after the listener binds and
removed when it stops. Tooling that reads it at an arbitrary time, or that
assumed it persists across a stopped service, needs to handle its absence.

### Mesh identities are re-encrypted on first load

Ed25519 and TLS private keys were written in plaintext despite the README
saying otherwise. They are now encrypted at rest and an existing identity is
upgraded in place on first load. The peer id and TLS fingerprint are
unchanged, so **pairings survive** — but the on-disk record is no longer
readable by an older build.

## License

MIT — see [LICENSE.txt](LICENSE.txt)
