# OpenClaw Feature Parity: Implementation Tasks

> Features identified from [OpenClaw](../../../openclaw) that are missing or significantly less extensive in King Louie. Tasks are grouped by feature area, ordered by priority (high impact first). Each task includes acceptance criteria and integration notes referencing King Louie's existing architecture.

---

## Table of Contents

1. [Web Search & Fetch Tool](#1-web-search--fetch-tool)
2. [Additional LLM Providers](#2-additional-llm-providers)
3. [Additional Messaging Channels](#3-additional-messaging-channels)
4. [Cron / Scheduling System](#4-cron--scheduling-system)
5. [Browser Control (CDP)](#5-browser-control-cdp)
6. [Media Handling](#6-media-handling)
7. [Semantic Memory Search](#7-semantic-memory-search)
8. [Canvas / A2UI Visual Workspace](#8-canvas--a2ui-visual-workspace)
9. [Docker Sandboxing](#9-docker-sandboxing)
10. [Group Chat & Mention Gating](#10-group-chat--mention-gating)
11. [Voice / Talk Mode](#11-voice--talk-mode)
12. [Webhook Ingress](#12-webhook-ingress)
13. [Usage Tracking & Cost Display](#13-usage-tracking--cost-display)
14. [Onboarding Wizard](#14-onboarding-wizard)
15. [Diagnostics (Doctor Command)](#15-diagnostics-doctor-command)

---

## 1. Web Search & Fetch Tool

**Priority:** HIGH — Agents currently cannot access the web at all, severely limiting their usefulness.

### 1.1 Web Fetch Tool

**Description:** A new built-in tool that fetches a URL and returns its content as markdown or plain text, suitable for agent consumption.

**New files:**
- `src/tools/builtin/web-fetch-tool.js`
- `src/tools/builtin/web-fetch-utils.js`

**Tool Schema:**
```javascript
new Tool({
  name: 'WebFetch',
  description: 'Fetch a URL and extract its content as readable text or markdown',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
      extractMode: { type: 'string', enum: ['markdown', 'text'], default: 'markdown' },
      maxChars: { type: 'number', minimum: 100, default: 50000 }
    },
    required: ['url']
  },
  requiresApproval: false
})
```

**Implementation details:**
- Use `@mozilla/readability` + `linkedom` for HTML → readable content extraction
- Markdown mode: Convert extracted HTML to markdown (use `turndown` or regex-based converter)
- Text mode: Strip all markup, normalize whitespace
- Enforce `maxChars` truncation on output
- Add a response size limit (default 2 MB raw, configurable)
- Add an in-memory cache with 15-minute TTL to avoid repeated fetches of the same URL

**SSRF Protection:**
- Block private/reserved IP ranges by default (10.x, 172.16-31.x, 192.168.x, 127.x, ::1, link-local)
- Resolve DNS before connecting and validate the resolved IP
- Block `file://`, `ftp://`, and other non-HTTP schemes
- Add a config flag `dangerouslyAllowPrivateNetwork: false` (default) for local dev override

**Settings integration:**
```javascript
// electron-store key
webFetch: {
  enabled: true,
  maxCharsCap: 50000,
  maxResponseBytes: 2097152,  // 2 MB
  cacheTtlMs: 900000,         // 15 min
  allowPrivateNetwork: false
}
```

**Register in:** `src/tools/builtin/` index, add to tool registry during init in `main.js`.

**Acceptance criteria:**
- [ ] Agent can fetch any public URL and receive markdown content
- [ ] Private IPs are blocked by default
- [ ] Responses are cached for 15 minutes
- [ ] Content is truncated to `maxChars`
- [ ] Settings UI toggle to enable/disable
- [ ] Works from both UI and Telegram channels

---

### 1.2 Web Search Tool

**Description:** A new built-in tool that performs web searches and returns structured results.

**New files:**
- `src/tools/builtin/web-search-tool.js`
- `src/web-search/search-provider.js`
- `src/web-search/providers/brave-search.js`
- `src/web-search/providers/duckduckgo.js`
- `src/web-search/providers/tavily.js`

**Tool Schema:**
```javascript
new Tool({
  name: 'WebSearch',
  description: 'Search the web and return relevant results',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', minimum: 1, maximum: 20, default: 5 },
      provider: { type: 'string', enum: ['brave', 'duckduckgo', 'tavily'], description: 'Search provider (auto-detected if omitted)' }
    },
    required: ['query']
  },
  requiresApproval: false
})
```

**Search Provider Interface:**
```javascript
class SearchProvider {
  constructor(config) {}
  getName() {}                        // e.g., 'brave'
  isConfigured() {}                   // Has API key or is keyless
  async search(query, maxResults) {}  // Returns [{title, url, snippet}]
}
```

**Provider implementations:**
- **Brave Search** — `GET https://api.search.brave.com/res/v1/web/search` with `X-Subscription-Token` header. Requires API key.
- **DuckDuckGo** — Keyless HTML scraping via `https://html.duckduckgo.com/html/?q=...`. No API key needed. Good default fallback.
- **Tavily** — `POST https://api.tavily.com/search` with API key. Returns rich snippets.

**Auto-detection logic:** Use whichever provider has a configured API key. Fall back to DuckDuckGo (keyless).

**Settings:**
```javascript
webSearch: {
  enabled: true,
  defaultProvider: 'auto',
  brave: { apiKey: '' },
  tavily: { apiKey: '' }
}
```

**Acceptance criteria:**
- [ ] Agent can search the web and receive structured results
- [ ] At least one provider works without API keys (DuckDuckGo)
- [ ] API keys configurable in settings UI
- [ ] Provider auto-detection works
- [ ] Results include title, URL, and snippet

---

## 2. Additional LLM Providers

**Priority:** HIGH — Users need local/cheap model options. Currently limited to OpenAI and Anthropic only.

### 2.1 Provider Abstraction Refactor

**Description:** Extend `BaseLLMProvider` and `ProviderFactory` to support dynamic provider registration and auto-discovery.

**Modified files:**
- `src/providers/provider-factory.js` — Add provider catalog with dynamic registration
- `src/providers/base-provider.js` — Add optional `discoverModels()` method

**New provider pattern:**
```javascript
// ProviderFactory additions
ProviderFactory.registerProvider(providerType, ProviderClass)
ProviderFactory.listRegistered()  // Returns all registered provider types
ProviderFactory.discoverModels(providerType, config)  // Auto-discover available models
```

**Acceptance criteria:**
- [ ] New providers can be added by implementing `BaseLLMProvider` and calling `registerProvider()`
- [ ] `listModels()` works for all providers
- [ ] Provider factory returns helpful error if API key is missing

---

### 2.2 Groq Provider

**New file:** `src/providers/groq-provider.js`

**Details:**
- API: `POST https://api.groq.com/openai/v1/chat/completions` (OpenAI-compatible)
- Auth: `Authorization: Bearer {GROQ_API_KEY}`
- Models: `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `mixtral-8x7b-32768`, `gemma2-9b-it`
- Supports tool calling (same schema as OpenAI)
- Streaming supported

**Settings:** Add `groq` to `providerModels` store. API key in settings UI.

**Acceptance criteria:**
- [ ] Can send messages through Groq API
- [ ] Tool calling works
- [ ] Streaming works
- [ ] Model selection in settings UI

---

### 2.3 Ollama Provider (Local Models)

**New file:** `src/providers/ollama-provider.js`

**Details:**
- API: `POST http://localhost:11434/api/chat` (Ollama native) or `POST http://localhost:11434/v1/chat/completions` (OpenAI-compatible endpoint)
- No API key required
- Auto-discovery: `GET http://localhost:11434/api/tags` returns available models
- Supports tool calling on compatible models (Llama 3.1+, Mistral, etc.)
- Streaming via NDJSON (native) or SSE (OpenAI-compatible)

**Settings:**
```javascript
ollama: {
  baseUrl: 'http://localhost:11434',
  model: ''  // Auto-populated from discovery
}
```

**Special handling:**
- `discoverModels()` implementation that calls `/api/tags`
- Settings UI should show a "Refresh Models" button
- No encryption needed for API key (there is none)

**Acceptance criteria:**
- [ ] Auto-discovers locally available Ollama models
- [ ] Chat works with local models
- [ ] Tool calling works on supported models
- [ ] Graceful error when Ollama is not running
- [ ] Base URL configurable for remote Ollama instances

---

### 2.4 Mistral Provider

**New file:** `src/providers/mistral-provider.js`

**Details:**
- API: `POST https://api.mistral.ai/v1/chat/completions` (OpenAI-compatible)
- Auth: `Authorization: Bearer {MISTRAL_API_KEY}`
- Models: `mistral-large-latest`, `mistral-small-latest`, `codestral-latest`, `open-mistral-nemo`
- Tool calling supported (OpenAI-compatible schema)

**Acceptance criteria:**
- [ ] Chat and tool calling work via Mistral API
- [ ] Model selection in settings
- [ ] Streaming supported

---

### 2.5 Google Gemini Provider

**New file:** `src/providers/gemini-provider.js`

**Details:**
- API: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Auth: `?key={GEMINI_API_KEY}` query param or `Authorization: Bearer` for OAuth
- Models: `gemini-2.0-flash`, `gemini-2.0-pro`, `gemini-1.5-flash`, `gemini-1.5-pro`
- Tool calling: Uses `functionDeclarations` format (different from OpenAI — needs adapter)
- Streaming: SSE via `:streamGenerateContent?alt=sse`

**Special handling:**
- Message format adapter: Convert `{role, content}` to Gemini's `{role, parts: [{text}]}` format
- Tool schema adapter: Convert OpenAI function definitions to Gemini `functionDeclarations`
- Response adapter: Convert `functionCall` responses back to King Louie's tool-use format

**Acceptance criteria:**
- [ ] Chat works with Gemini models
- [ ] Tool calling works (with format adaptation)
- [ ] Streaming supported
- [ ] Vision/image input works (Gemini is natively multimodal)

---

### 2.6 OpenRouter Meta-Provider

**New file:** `src/providers/openrouter-provider.js`

**Details:**
- API: `POST https://openrouter.ai/api/v1/chat/completions` (OpenAI-compatible)
- Auth: `Authorization: Bearer {OPENROUTER_API_KEY}`
- Gives access to 100+ models from all providers through a single API key
- Model discovery: `GET https://openrouter.ai/api/v1/models`
- Headers: `HTTP-Referer`, `X-Title` (optional, for rankings)

**Acceptance criteria:**
- [ ] Works as an OpenAI-compatible provider
- [ ] Model discovery lists available models
- [ ] Single API key unlocks many model options

---

### 2.7 Inference Router Updates

**Modified file:** `src/providers/inference-router.js`

**Changes:**
- Update tier map to support new providers
- Add model capability detection (vision, tool-calling, streaming)
- Add fallback chain: if primary provider fails, try secondary

```javascript
inference: {
  tierMap: {
    fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    standard: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    smart: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' }
  },
  fallbacks: {
    groq: { provider: 'openai', model: 'gpt-4o-mini' }  // If groq fails, use openai
  }
}
```

**Acceptance criteria:**
- [ ] All new providers selectable per tier
- [ ] Fallback routing works when a provider errors
- [ ] Settings UI updated with new provider options

---

## 3. Additional Messaging Channels

**Priority:** HIGH — Currently only Electron UI and Telegram. OpenClaw supports 24+ channels.

### 3.1 Channel Plugin Interface Refactor

**Description:** Formalize the channel plugin contract so new channels can be added with a consistent interface.

**Modified files:**
- `src/channels/channel-plugin.js` — Expand the base interface

**Expanded interface:**
```javascript
class ChannelPlugin {
  constructor(config) {
    this.id = config.id            // 'discord', 'slack', etc.
    this.label = config.label      // 'Discord'
    this.capabilities = config.capabilities || ['send', 'receive']
  }

  // Required
  async initialize(gateway) {}     // Start listener, connect to service
  async shutdown() {}              // Graceful cleanup
  normalizeTarget(rawTarget) {}    // Validate destination
  async send(target, message, options) {}  // Send message

  // Optional
  async onMessage(handler) {}      // Register inbound message handler
  async listTargets() {}           // List available channels/groups
  getStatus() {}                   // { connected: bool, latency: number }

  // Group features (optional)
  supportsGroups() { return false }
  async listGroups() {}
  getMentionPattern() {}           // Regex for detecting bot mentions
}
```

**Message normalization format (inbound):**
```javascript
{
  channel: 'discord',
  sender: { id: '12345', name: 'User', isGroup: false },
  group: { id: '67890', name: 'General' },  // null for DMs
  text: 'Hello bot',
  mentions: ['bot-id'],
  attachments: [{ type: 'image', url: '...' }],
  threadId: null,
  raw: {}  // Original platform message
}
```

**Registration in main.js:**
```javascript
channelRegistry.register(new DiscordChannel(config))
channelRegistry.register(new SlackChannel(config))
// ... etc.
// On inbound message, route through existing session + agent pipeline
```

**Acceptance criteria:**
- [ ] Base interface documented and enforced
- [ ] Telegram adapter migrated to new interface
- [ ] Channel registry supports dynamic registration
- [ ] Inbound messages normalized to common format before hitting agent loop

---

### 3.2 Discord Channel

**New files:**
- `src/channels/discord-adapter.js`
- `src/channels/discord-bridge.js`

**Dependencies:** `discord.js` (v14+)

**Implementation details:**
- Connect via Bot token (`DISCORD_BOT_TOKEN`)
- Handle `messageCreate` events → normalize → route to session manager
- Session key: `agent:main:discord:{userId}` (DMs) or `agent:main:discord:group:{guildId}:{channelId}` (servers)
- Send responses back via `channel.send()` with message splitting for >2000 chars
- Support slash commands registration for `/ask`, `/status`, `/reset`
- Handle embeds for rich formatting (code blocks, images)
- Thread support: map Discord threads to King Louie session threads
- Mention detection: respond only when @mentioned in group channels (configurable)

**Settings:**
```javascript
discord: {
  enabled: false,
  botToken: '',  // Encrypted via safeStorage
  requireMention: true,  // In group channels
  allowedGuilds: [],     // Empty = all guilds
  allowedChannels: []    // Empty = all channels
}
```

**Acceptance criteria:**
- [ ] Bot connects and receives DMs
- [ ] Bot responds in guild channels when mentioned
- [ ] Long messages split at 2000-char boundaries
- [ ] Slash command registration works
- [ ] Thread support works
- [ ] Settings UI for token + guild/channel allowlists

---

### 3.3 Slack Channel

**New files:**
- `src/channels/slack-adapter.js`
- `src/channels/slack-bridge.js`

**Dependencies:** `@slack/bolt` (Slack Bolt framework)

**Implementation details:**
- Socket Mode connection (no public URL needed) via `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN`
- Handle `message` events → normalize → route to session manager
- Session key: `agent:main:slack:{userId}` (DMs) or `agent:main:slack:group:{channelId}`
- Respond via `say()` or `client.chat.postMessage()`
- Support Block Kit for rich responses (code blocks, buttons for tool approval)
- Mention detection via `app_mention` event
- Thread support: reply in thread when message is in a thread

**Settings:**
```javascript
slack: {
  enabled: false,
  appToken: '',   // xapp-... (encrypted)
  botToken: '',   // xoxb-... (encrypted)
  requireMention: true,
  allowedChannels: []
}
```

**Acceptance criteria:**
- [ ] Bot connects via Socket Mode (no public URL)
- [ ] DM and channel support
- [ ] Mention-based activation in channels
- [ ] Thread replies work
- [ ] Messages formatted with Block Kit
- [ ] Settings UI for tokens and channel allowlists

---

### 3.4 WhatsApp Channel

**New files:**
- `src/channels/whatsapp-adapter.js`
- `src/channels/whatsapp-bridge.js`

**Dependencies:** `@whiskeysockets/baileys` (WhatsApp Web multi-device)

**Implementation details:**
- QR code pairing flow (display in settings UI or terminal)
- Session persistence via `authState` store (save creds to electron-store or file)
- Handle incoming messages → normalize → route
- Session key: `agent:main:whatsapp:{jid}`
- Send via `sock.sendMessage(jid, { text: content })`
- Media support: receive images, send images
- Group support: respond only when mentioned

**Settings:**
```javascript
whatsapp: {
  enabled: false,
  paired: false,
  requireMention: true,
  allowedGroups: []
}
```

**Acceptance criteria:**
- [ ] QR code pairing flow works
- [ ] Session persists across restarts
- [ ] DM and group message support
- [ ] Media receive/send
- [ ] Settings UI for pairing status and group allowlists

---

### 3.5 Signal Channel

**New files:**
- `src/channels/signal-adapter.js`
- `src/channels/signal-bridge.js`

**Dependencies:** `signal-cli` (external process, must be installed separately)

**Implementation details:**
- Interface with `signal-cli` via JSON-RPC or DBus
- Requires phone number registration via `signal-cli register`
- Handle incoming messages via `signal-cli receive --json`
- Send via `signal-cli send -m "message" {recipient}`
- Session key: `agent:main:signal:{phoneNumber}`

**Settings:**
```javascript
signal: {
  enabled: false,
  signalCliPath: '',  // Path to signal-cli binary
  phoneNumber: ''
}
```

**Acceptance criteria:**
- [ ] Send and receive messages via signal-cli
- [ ] Group support
- [ ] Settings UI for signal-cli path and phone number

---

### 3.6 IRC Channel

**New files:**
- `src/channels/irc-adapter.js`
- `src/channels/irc-bridge.js`

**Dependencies:** `irc-framework`

**Implementation details:**
- Connect to IRC server with nick, channels
- Handle `message` events → normalize → route
- Session key: `agent:main:irc:{nick}` (DMs) or `agent:main:irc:group:{channel}`
- Mention detection via nick prefix in channel messages
- Long message splitting at ~450 chars (IRC limit)

**Settings:**
```javascript
irc: {
  enabled: false,
  server: '',
  port: 6697,
  useTls: true,
  nick: 'king-louie',
  channels: [],
  password: ''
}
```

**Acceptance criteria:**
- [ ] Connects to IRC server and joins channels
- [ ] DM and channel support
- [ ] Nick-based mention detection
- [ ] Message splitting for long responses

---

### 3.7 Microsoft Teams Channel

**New files:**
- `src/channels/teams-adapter.js`
- `src/channels/teams-bridge.js`

**Dependencies:** `botbuilder` (Microsoft Bot Framework SDK)

**Implementation details:**
- Register as a Teams bot via Azure Bot Service
- Handle `onMessage` activity → normalize → route
- Session key: `agent:main:teams:{conversationId}`
- Adaptive Cards for rich formatting
- Mention detection in group chats

**Settings:**
```javascript
teams: {
  enabled: false,
  appId: '',
  appPassword: ''  // encrypted
}
```

**Acceptance criteria:**
- [ ] Bot responds in Teams DMs and channels
- [ ] Adaptive Card formatting
- [ ] Mention-based activation in group chats

---

## 4. Cron / Scheduling System

**Priority:** HIGH — Enables autonomous recurring tasks, a major differentiator.

### 4.1 Cron Scheduler Core

**New files:**
- `src/cron/cron-scheduler.js`
- `src/cron/cron-store.js`
- `src/cron/cron-executor.js`

**Job Schema:**
```javascript
{
  id: 'uuid',
  createdAt: 'ISO8601',
  updatedAt: 'ISO8601',
  enabled: true,

  // Schedule — one of:
  schedule: {
    kind: 'at',    // One-shot: run at specific time
    at: 'ISO8601'
  }
  // OR
  schedule: {
    kind: 'every', // Interval: run every N ms
    everyMs: 300000,
    anchorMs: null  // Optional anchor point
  }
  // OR
  schedule: {
    kind: 'cron',  // Cron expression
    expr: '0 9 * * 1-5',  // Weekdays at 9am
    tz: 'America/New_York'
  },

  // What to do
  payload: {
    kind: 'agentTurn',
    message: 'Check the deploy status and report',
    sessionTarget: 'main',  // 'main' | 'isolated' | specific session key
    model: null,             // Override model
    tier: null               // Override inference tier
  },

  // Where to deliver result
  delivery: {
    mode: 'announce',        // 'none' | 'announce' | 'webhook'
    channel: 'telegram',     // Channel to deliver to
    to: '12345'              // Target in that channel
  },

  // Runtime state (managed by scheduler, not user)
  state: {
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastRunStatus: null,     // 'ok' | 'error' | 'skipped'
    lastError: null,
    lastDurationMs: null,
    consecutiveErrors: 0
  }
}
```

**CronStore (file-based persistence):**
```javascript
class CronStore {
  constructor(filePath)        // ~/.king-louie/cron/jobs.json
  load()                       // Read from disk
  save()                       // Atomic write (temp + rename)
  list()                       // All jobs
  get(id)
  add(job)
  update(id, patch)
  remove(id)
}
```

**CronScheduler:**
```javascript
class CronScheduler {
  constructor(store, executor)
  start()                      // Start the scheduler loop
  stop()                       // Graceful shutdown
  tick()                       // Check and run due jobs (called every 30s)
  getNextRun(job)              // Calculate next run time from schedule
  addJob(jobConfig)
  updateJob(id, patch)
  removeJob(id)
  runNow(id)                   // Force immediate execution
  listJobs()
}
```

**CronExecutor:**
```javascript
class CronExecutor {
  constructor(agentExecutor, sessionManager, gateway)
  async execute(job) {
    // 1. Determine session (main or create isolated)
    // 2. Run agent turn with job.payload.message
    // 3. Capture result
    // 4. Deliver if job.delivery configured
    // 5. Update job.state
  }
}
```

**Dependencies:** `cron-parser` (for cron expression parsing)

**Settings:**
```javascript
cron: {
  enabled: true,
  tickIntervalMs: 30000,
  maxConcurrentJobs: 3,
  jobTimeoutMs: 300000  // 5 min default
}
```

**Acceptance criteria:**
- [ ] One-shot, interval, and cron expression schedules work
- [ ] Jobs persist across app restarts
- [ ] Jobs execute in main or isolated sessions
- [ ] Results can be delivered to any registered channel
- [ ] Consecutive error tracking and alerting
- [ ] Jobs can be created, updated, listed, removed via IPC

---

### 4.2 Cron Tool (Agent-Facing)

**New file:** `src/tools/builtin/cron-tool.js`

**Tool Schema:**
```javascript
new Tool({
  name: 'Cron',
  description: 'Manage scheduled jobs: list, add, update, remove, or run',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'run', 'status'] },
      jobId: { type: 'string' },
      job: { type: 'object' },   // For 'add'
      patch: { type: 'object' }  // For 'update'
    },
    required: ['action']
  },
  requiresApproval: true  // Creating scheduled jobs should require approval
})
```

**Acceptance criteria:**
- [ ] Agent can create, list, and manage cron jobs via tool calling
- [ ] User approval required for job creation
- [ ] Agent can check job status and recent run history

---

### 4.3 Cron UI

**Modified files:**
- `renderer.js` — Add cron management panel
- `index.html` — Add cron section to settings drawer
- `styles.css` — Style the cron panel

**UI requirements:**
- List all scheduled jobs with status indicators
- Create new job form (message, schedule type, cron expression / interval / datetime)
- Edit existing jobs inline
- Enable/disable toggle per job
- Delete with confirmation
- "Run Now" button
- Show last run status, next run time, consecutive errors

**IPC handlers in main.js:**
```
cron:list → [jobs]
cron:add({job}) → job
cron:update({id, patch}) → job
cron:remove({id}) → boolean
cron:run({id}) → result
cron:status → { enabled, jobCount, nextRunAt }
```

**Acceptance criteria:**
- [ ] Full CRUD for cron jobs in settings UI
- [ ] Visual cron expression builder or helper text
- [ ] Status indicators (green/red/yellow) for job health
- [ ] Run history visible per job

---

## 5. Browser Control (CDP)

**Priority:** MEDIUM — Enables web automation workflows. Significant effort.

### 5.1 Browser Service

**New files:**
- `src/browser/browser-service.js`
- `src/browser/cdp-client.js`

**Capabilities:**
- Launch Chrome/Edge/Brave with a dedicated profile (isolated from user's browser)
- Connect via Chrome DevTools Protocol (CDP) over WebSocket
- Manage tabs: list, open, close, focus
- Navigate to URLs
- Take screenshots (full page and viewport)
- Save pages as PDF
- Execute JavaScript in page context
- Capture console output

**CDP Client:**
```javascript
class CdpClient {
  constructor(wsUrl)
  async connect()
  async disconnect()
  async navigate(url)
  async screenshot({ fullPage, format, quality })  // Returns Buffer
  async pdf(options)
  async evaluate(expression)
  async getConsole(limit)
  async click(selector)
  async type(selector, text)
  async waitForSelector(selector, timeoutMs)
}
```

**Browser Discovery:**
- Auto-detect installed browsers (Chrome, Edge, Brave, Chromium)
- Platform-specific paths (Windows registry, macOS /Applications, Linux which)
- Launch with `--remote-debugging-port=0` to get random port
- Parse `DevTools listening on ws://...` from stderr

**Profile isolation:**
- User data dir: `~/.king-louie/browser-profile/`
- Separate from user's default profile
- Persists cookies, localStorage across sessions

**Settings:**
```javascript
browser: {
  enabled: false,
  browserPath: '',    // Auto-detect if empty
  headless: false,    // Headless mode
  viewport: { width: 1280, height: 720 }
}
```

**Acceptance criteria:**
- [ ] Auto-detects and launches browser
- [ ] CDP connection established
- [ ] Tab management works
- [ ] Screenshots capture correctly
- [ ] JavaScript evaluation works
- [ ] Browser profile is isolated from user's default

---

### 5.2 Browser Tool (Agent-Facing)

**New file:** `src/tools/builtin/browser-tool.js`

**Tool Schema:**
```javascript
new Tool({
  name: 'Browser',
  description: 'Control a web browser: navigate, screenshot, interact with pages',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status', 'tabs', 'open_tab', 'close_tab',
               'navigate', 'screenshot', 'pdf', 'evaluate', 'click', 'type',
               'wait_for', 'console']
      },
      url: { type: 'string' },
      targetId: { type: 'string' },
      selector: { type: 'string' },
      text: { type: 'string' },
      expression: { type: 'string' },
      fullPage: { type: 'boolean', default: false },
      timeoutMs: { type: 'number', default: 5000 }
    },
    required: ['action']
  },
  requiresApproval: true  // Browser access should require approval
})
```

**SSRF protection:**
- Same private IP blocking as WebFetch
- Configurable allowlist for internal URLs

**Acceptance criteria:**
- [ ] Agent can open browser, navigate to URLs, take screenshots
- [ ] Agent can interact with pages (click, type, evaluate JS)
- [ ] Screenshots returned as viewable content to agent
- [ ] SSRF protection blocks private network access by default
- [ ] User approval required for browser actions

---

## 6. Media Handling

**Priority:** MEDIUM — Enables rich interactions (images, audio, voice).

### 6.1 Image Input Support

**New files:**
- `src/media/image-handler.js`

**Modified files:**
- `src/execution/agent-loop.js` — Support image content blocks in messages
- `src/providers/openai-provider.js` — Multi-modal message format
- `src/providers/anthropic-provider.js` — Multi-modal message format
- `renderer.js` — Image paste/drop/attach UI

**Implementation:**
- Accept images via: clipboard paste, drag-and-drop, file picker, URL
- Convert to base64 or upload URL for provider consumption
- Format for provider:
  - OpenAI: `{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }`
  - Anthropic: `{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }`
- Support formats: PNG, JPEG, GIF, WebP
- Max image size: 5 MB (configurable)
- Max images per message: 5 (configurable)
- Thumbnail generation for chat display

**Acceptance criteria:**
- [ ] Users can paste/drop/attach images in chat
- [ ] Images sent to vision-capable models
- [ ] Works with OpenAI and Anthropic (and Gemini when added)
- [ ] Images display in chat history
- [ ] Size limits enforced

---

### 6.2 Audio Transcription

**New files:**
- `src/media/transcription-service.js`

**Implementation:**
- Use OpenAI Whisper API: `POST https://api.openai.com/v1/audio/transcriptions`
- Accept audio files: MP3, WAV, M4A, WEBM, OGG
- Max audio size: 25 MB
- Return transcribed text to agent or user

**Integration points:**
- Telegram voice messages: auto-transcribe and process as text
- UI: drag-and-drop audio files
- Agent tool: `Transcribe` tool for agent-initiated transcription

**Acceptance criteria:**
- [ ] Audio files transcribed via Whisper API
- [ ] Telegram voice messages auto-transcribed
- [ ] Transcription results fed into agent loop

---

### 6.3 Text-to-Speech (TTS)

**New files:**
- `src/media/tts-service.js`
- `src/media/tts-providers/openai-tts.js`
- `src/media/tts-providers/elevenlabs-tts.js`

**TTS Provider Interface:**
```javascript
class TtsProvider {
  getName() {}
  async synthesize(text, options) {}  // Returns audio Buffer
  listVoices() {}
}
```

**OpenAI TTS:**
- API: `POST https://api.openai.com/v1/audio/speech`
- Models: `tts-1` (fast), `tts-1-hd` (quality)
- Voices: alloy, echo, fable, onyx, nova, shimmer
- Output: MP3 or Opus

**ElevenLabs TTS:**
- API: `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}`
- Higher quality, more voice options
- Output: MP3 or Opus

**Settings:**
```javascript
tts: {
  enabled: false,
  provider: 'openai',
  autoMode: 'off',  // 'off' | 'always' | 'tagged'
  openai: { model: 'tts-1', voice: 'nova', speed: 1.0 },
  elevenlabs: { apiKey: '', voiceId: '', modelId: 'eleven_multilingual_v2' },
  maxTextLength: 1500
}
```

**Integration:**
- Telegram: Send as voice message (Opus format)
- UI: Play audio inline with controls
- Agent: `/speak` command to force TTS output
- Auto-mode: Automatically generate TTS for responses (when enabled)

**Acceptance criteria:**
- [ ] Text-to-speech works with at least OpenAI provider
- [ ] Audio playable in UI and sendable via Telegram
- [ ] Voice selection in settings
- [ ] Auto-mode configurable (off/always/tagged)
- [ ] Long text truncated or summarized before TTS

---

## 7. Semantic Memory Search

**Priority:** MEDIUM — Current keyword+recency search misses conceptually related entries.

### 7.1 Embedding-Based Memory Retrieval

**New files:**
- `src/memory/embedding-provider.js`
- `src/memory/vector-store.js`
- `src/memory/memory-retrieval-semantic.js`

**Embedding Provider Interface:**
```javascript
class EmbeddingProvider {
  async embed(texts)          // Returns float[][] (one vector per text)
  getDimensions()             // Vector size (e.g., 1536 for text-embedding-3-small)
  getModelName()
}
```

**Implementations:**
- **OpenAI:** `POST https://api.openai.com/v1/embeddings` with model `text-embedding-3-small` (1536 dims, cheap)
- **Ollama (local):** `POST http://localhost:11434/api/embeddings` with `nomic-embed-text` or `mxbai-embed-large`

**Vector Store (simple, file-based):**
```javascript
class VectorStore {
  constructor(filePath)        // ~/.king-louie/memory/vectors.json
  async add(id, vector)
  async remove(id)
  async search(queryVector, topK)  // Cosine similarity, returns [{id, score}]
  async rebuild(entries)       // Re-embed all entries
}
```

**Hybrid Retrieval (upgrade to memory-retrieval.js):**
```javascript
async recall(query, options) {
  // 1. Keyword search (existing) → scored results
  // 2. Semantic search (new) → scored results
  // 3. Merge: hybridScore = (keywordScore * 0.4) + (semanticScore * 0.4) + (recencyScore * 0.2)
  // 4. Deduplicate and return top-K
}
```

**Embedding lifecycle:**
- On `memory:capture` → compute embedding → store in vector store
- On `memory:delete` → remove from vector store
- Background re-embed on startup if model changes
- Lazy embedding: don't block capture, embed async

**Settings:**
```javascript
memory: {
  semanticSearch: {
    enabled: false,  // Opt-in (requires embedding API)
    provider: 'openai',  // or 'ollama'
    model: 'text-embedding-3-small',
    hybridWeight: 0.4  // Weight for semantic vs keyword
  }
}
```

**Acceptance criteria:**
- [ ] Embeddings computed for new memory entries
- [ ] Semantic search finds conceptually related entries even without keyword overlap
- [ ] Hybrid scoring combines keyword, semantic, and recency
- [ ] Works with OpenAI embeddings out of the box
- [ ] Optional local embeddings via Ollama
- [ ] Graceful fallback to keyword-only if embedding provider unavailable

---

## 8. Canvas / A2UI Visual Workspace

**Priority:** LOW — Cool feature but high effort and niche use case.

### 8.1 Canvas Host

**New files:**
- `src/canvas/canvas-host.js`
- `src/canvas/canvas-window.js`

**Description:** A secondary Electron `BrowserWindow` that the agent can control programmatically — rendering HTML/CSS/JS, charts, diagrams, or interactive UIs.

**Implementation:**
- New `BrowserWindow` spawned on demand
- Agent pushes content via IPC: `canvas:push({ html, css, js })` or `canvas:navigate(url)`
- Agent can take snapshots: `canvas:snapshot()` → returns screenshot
- Agent can evaluate JS: `canvas:eval(expression)` → returns result
- Canvas resets: `canvas:reset()` → blank slate

**Canvas Tool:**
```javascript
new Tool({
  name: 'Canvas',
  description: 'Display visual content in a separate workspace window',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['present', 'hide', 'navigate', 'push', 'eval', 'snapshot', 'reset'] },
      html: { type: 'string' },
      css: { type: 'string' },
      js: { type: 'string' },
      url: { type: 'string' },
      expression: { type: 'string' }
    },
    required: ['action']
  },
  requiresApproval: false
})
```

**Use cases:**
- Render charts/graphs from data
- Display interactive dashboards
- Preview HTML/CSS the agent wrote
- Show maps, diagrams, or visualizations

**Acceptance criteria:**
- [ ] Canvas window opens on demand
- [ ] Agent can push HTML/CSS/JS content
- [ ] Agent can take screenshots of canvas
- [ ] Agent can navigate to URLs
- [ ] Canvas persists until explicitly closed
- [ ] Works alongside main chat window

---

## 9. Docker Sandboxing

**Priority:** MEDIUM — Important for security when running agent-generated code.

### 9.1 Sandbox Executor

**New files:**
- `src/execution/sandbox-executor.js`
- `src/execution/sandbox-config.js`

**Description:** Optionally run agent tool executions (especially Bash) inside a Docker container for isolation.

**Implementation:**
- Detect Docker availability: `docker info` on startup
- Build/pull a sandbox image: minimal image with common tools (Node, Python, git, etc.)
- Run commands via: `docker exec -i {containerId} {command}`
- Mount working directory as a bind mount: `{workDir}:/workspace:rw`
- Container lifecycle: create on first sandboxed execution, reuse for session, destroy on session end
- Hot container cache: keep warm containers for 5 minutes after last use

**Security:**
- Block host path mounts to system directories (`/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/boot`, `/var/run/docker.sock`)
- Default seccomp profile (never allow `unconfined`)
- Read-only bind mounts where possible
- Network isolation options: `--network=none` for full isolation or `--network=bridge` for web access

**Sandbox Config:**
```javascript
{
  enabled: false,
  image: 'king-louie-sandbox:latest',
  mounts: [
    { source: '{workDir}', target: '/workspace', mode: 'rw' }
  ],
  network: 'bridge',  // 'none' | 'bridge'
  memoryLimit: '512m',
  cpuLimit: '1.0',
  timeoutMs: 60000
}
```

**Integration with Bash tool:**
- When sandbox enabled, `BashTool.execute()` routes through `SandboxExecutor` instead of direct `child_process`
- Non-main sessions (group chats, cron jobs) always sandboxed when Docker available
- Main session: configurable (default: not sandboxed for convenience)

**Settings:**
```javascript
sandbox: {
  enabled: false,
  forceForGroups: true,    // Always sandbox group chat sessions
  forceForCron: true,      // Always sandbox cron job sessions
  dockerImage: 'king-louie-sandbox:latest',
  networkMode: 'bridge',
  memoryLimit: '512m'
}
```

**Acceptance criteria:**
- [ ] Docker availability detected on startup
- [ ] Bash commands can run inside container
- [ ] Working directory mounted correctly
- [ ] Container reused within session
- [ ] System paths blocked from mounting
- [ ] Network isolation configurable
- [ ] Graceful fallback to direct execution if Docker unavailable
- [ ] Settings UI toggle

---

## 10. Group Chat & Mention Gating

**Priority:** MEDIUM — Required for channels that support groups (Discord, Slack, WhatsApp, Telegram groups).

### 10.1 Mention Detection & Gating

**New files:**
- `src/channels/mention-gating.js`
- `src/channels/allowlist-manager.js`

**Mention Gating Logic:**
```javascript
function shouldRespond({ isGroup, requireMention, wasMentioned, isCommand, isReply }) {
  // DMs: always respond
  if (!isGroup) return true
  // Commands (e.g., /ask): always respond
  if (isCommand) return true
  // Reply to bot's message: always respond
  if (isReply) return true
  // Group + mention required + not mentioned: skip
  if (requireMention && !wasMentioned) return false
  // Otherwise: respond
  return true
}
```

**Mention detection per channel:**
- Telegram: Check `message.entities` for `mention` type matching bot username
- Discord: Check `message.mentions.has(client.user)`
- Slack: Check for `<@BOT_USER_ID>` in message text
- WhatsApp: Check for `@botNumber` in message text
- Generic: Regex match for configured bot name/handle

**Allowlist Manager:**
```javascript
class AllowlistManager {
  constructor(store)
  isAllowed(channel, senderId, groupId) → boolean
  addUser(channel, userId)
  removeUser(channel, userId)
  addGroup(channel, groupId)
  removeGroup(channel, groupId)
  getPolicy(channel) → { default: 'allow'|'deny', users: [], groups: [] }
  setPolicy(channel, policy)
}
```

**Settings (per-channel):**
```javascript
// Each channel config gets:
{
  requireMention: true,
  allowlist: {
    default: 'allow',  // or 'deny'
    users: ['id1', 'id2'],
    groups: ['group1']
  }
}
```

**Acceptance criteria:**
- [ ] Bot only responds when mentioned in group chats (when configured)
- [ ] Slash commands bypass mention requirement
- [ ] Allowlist/denylist per channel
- [ ] Per-channel mention gating settings in UI
- [ ] Works across all channel implementations

---

### 10.2 DM Pairing (Optional Safety Feature)

**Description:** Unknown senders in DMs must complete a pairing flow before the bot responds.

**Implementation:**
- First DM from unknown sender → bot sends pairing code
- User must confirm in a trusted channel (e.g., UI or Telegram owner chat)
- Once paired, sender ID stored in allowlist
- Opt-in feature (disabled by default)

**Acceptance criteria:**
- [ ] Unknown DM senders receive pairing prompt
- [ ] Pairing confirmation flow works
- [ ] Paired senders stored persistently
- [ ] Feature is opt-in with settings toggle

---

## 11. Voice / Talk Mode

**Priority:** LOW — Requires media handling (§6) as a prerequisite.

### 11.1 Push-to-Talk Mode

**New files:**
- `src/voice/voice-controller.js`
- `src/voice/audio-recorder.js`

**Implementation:**
- Keyboard shortcut (configurable, e.g., `Ctrl+Shift+Space`) to start/stop recording
- Capture microphone audio via Web Audio API in renderer process
- Send audio to transcription service (§6.2)
- Feed transcribed text into agent loop
- Optionally speak response via TTS (§6.3)

**UI:**
- Recording indicator in chat input area
- Waveform visualization during recording
- PTT button in toolbar

**Acceptance criteria:**
- [ ] Hold-to-talk keyboard shortcut works
- [ ] Audio captured and transcribed
- [ ] Transcribed text sent as user message
- [ ] Response optionally spoken via TTS
- [ ] Visual recording indicator

---

### 11.2 Voice Wake (Stretch Goal)

**Description:** Always-listening wake word detection (e.g., "Hey Louie").

**Implementation considerations:**
- Use a local wake word model (e.g., `porcupine` by Picovoice, or `vosk`)
- Runs in background, minimal CPU usage
- On detection: activate PTT mode automatically
- Privacy: all processing local, no audio sent until wake word detected

**Acceptance criteria:**
- [ ] Wake word detection runs locally
- [ ] Activates recording on detection
- [ ] Configurable wake word
- [ ] CPU usage under 5% when idle
- [ ] Can be fully disabled

---

## 12. Webhook Ingress

**Priority:** MEDIUM — Enables event-driven automation from external services.

### 12.1 Webhook Server

**New files:**
- `src/webhooks/webhook-server.js`
- `src/webhooks/webhook-registry.js`
- `src/webhooks/webhook-handler.js`

**Description:** HTTP endpoint on the gateway that accepts webhook payloads and routes them to agent sessions.

**Implementation:**
- Extend the existing gateway HTTP server (port 18789) with webhook routes
- Route pattern: `POST /webhooks/{webhookId}`
- Each webhook has an ID, secret token, and routing config

**Webhook Schema:**
```javascript
{
  id: 'uuid',
  name: 'GitHub Push',
  secret: 'random-token',          // For HMAC verification
  enabled: true,
  route: {
    sessionTarget: 'main',         // or 'isolated'
    messageTemplate: 'Webhook received from {{source}}: {{body}}',
    delivery: { channel: 'telegram', to: '12345' }
  },
  rateLimit: {
    maxPerMinute: 10,
    maxConcurrent: 2
  },
  filters: {
    headers: { 'X-GitHub-Event': 'push' },  // Only process matching headers
    bodyJsonPath: null                        // Optional JSON path filter
  }
}
```

**Security:**
- HMAC signature verification (GitHub, Slack, Stripe compatible)
- Rate limiting per webhook
- Max body size: 1 MB
- IP allowlist (optional)
- Require authentication token in URL or header

**Registry:**
```javascript
class WebhookRegistry {
  constructor(store)       // Persistent storage
  register(webhook)
  unregister(id)
  get(id)
  list()
  validate(id, request)   // Verify signature + rate limit
}
```

**Handler:**
```javascript
class WebhookHandler {
  async handle(webhookId, request) {
    // 1. Look up webhook config
    // 2. Validate signature
    // 3. Check rate limits
    // 4. Format message from template + payload
    // 5. Route to agent session
    // 6. Optionally deliver result to channel
  }
}
```

**Settings:**
```javascript
webhooks: {
  enabled: false,
  maxBodyBytes: 1048576,
  registeredWebhooks: []
}
```

**Acceptance criteria:**
- [ ] Webhooks receivable on gateway HTTP server
- [ ] HMAC signature verification
- [ ] Rate limiting per webhook
- [ ] Payloads routed to agent sessions
- [ ] Results optionally delivered to channels
- [ ] CRUD management via IPC + UI

---

### 12.2 Webhook UI

**Modified files:** `renderer.js`, `index.html`, `styles.css`

**UI requirements:**
- Webhook management panel in settings
- Create webhook: name, secret (auto-generated), route config, filters
- Display webhook URL for copying
- Enable/disable toggle
- Delete with confirmation
- Show recent invocation log (last 20 events)

**Acceptance criteria:**
- [ ] Full CRUD for webhooks in settings UI
- [ ] Webhook URL copyable
- [ ] Recent invocation history visible
- [ ] Test webhook button

---

## 13. Usage Tracking & Cost Display

**Priority:** MEDIUM — Users need visibility into API costs.

### 13.1 Enhanced Usage Tracking

**New files:**
- `src/tracking/usage-tracker.js`
- `src/tracking/pricing-tables.js`

**Modified files:**
- `src/execution/agent-loop.js` — Emit usage events
- `renderer.js` — Display usage footer

**Pricing Tables:**
```javascript
// Per-provider, per-model pricing ($ per million tokens)
const PRICING = {
  openai: {
    'gpt-4o': { input: 2.50, output: 10.00, cacheRead: 1.25 },
    'gpt-4o-mini': { input: 0.15, output: 0.60, cacheRead: 0.075 },
    // ...
  },
  anthropic: {
    'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30 },
    'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, cacheRead: 0.08 },
    // ...
  },
  groq: { /* free tier, then per-token */ },
  // ... etc
}
```

**Usage Tracker:**
```javascript
class UsageTracker {
  constructor(store)

  record(event) {
    // event: { provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, durationMs }
  }

  getSessionUsage()          // Current session totals
  getDailyUsage(date)        // By date
  getMonthlyUsage(month)     // By month
  getByProvider(provider)    // Per-provider breakdown
  getTotalCost(period)       // Calculated from pricing tables
  reset()
}
```

**Display Modes:**
- `off` — No usage shown
- `tokens` — Show token counts only (e.g., "↑1.2k ↓800")
- `full` — Show tokens + estimated cost (e.g., "↑1.2k ↓800 · $0.003")

**UI integration:**
- Footer below each agent response showing usage for that turn
- Session summary in settings/status panel
- Per-provider breakdown chart (optional)

**Settings:**
```javascript
usage: {
  displayMode: 'tokens',  // 'off' | 'tokens' | 'full'
  trackHistory: true,
  pricingOverrides: {}     // User can override pricing for custom endpoints
}
```

**Acceptance criteria:**
- [ ] Token usage tracked per response
- [ ] Cost estimated from pricing tables
- [ ] Display mode configurable (off/tokens/full)
- [ ] Session and daily/monthly aggregations
- [ ] Per-provider breakdown available
- [ ] Pricing tables updatable

---

## 14. Onboarding Wizard

**Priority:** LOW — Improves first-run experience.

### 14.1 First-Run Setup Flow

**New files:**
- `src/wizard/onboarding-wizard.js`
- `src/wizard/wizard-steps.js`

**Modified files:**
- `main.js` — Detect first run, launch wizard
- `renderer.js` — Wizard UI
- `index.html` — Wizard modal/overlay

**Wizard Steps:**
1. **Welcome** — Brief intro to King Louie
2. **Provider Setup** — Select primary provider, enter API key, test connection
3. **User Profile** — Name, role, goals (populates telos)
4. **Channel Setup** (optional) — Enable Telegram, Discord, etc. with guided token entry
5. **First Chat** — Pre-populated example conversation to demonstrate capabilities
6. **Finish** — Summary of configured features, links to docs

**Detection:**
```javascript
// In main.js on app ready
const isFirstRun = !store.get('onboardingComplete', false)
if (isFirstRun) {
  mainWindow.webContents.send('wizard:start')
}
// On wizard complete:
store.set('onboardingComplete', true)
```

**Acceptance criteria:**
- [ ] Wizard appears on first launch
- [ ] Guides user through provider setup with connection test
- [ ] User profile populated
- [ ] Optional channel configuration
- [ ] Can be skipped
- [ ] Can be re-run from settings (`/onboard` command)
- [ ] Does not appear on subsequent launches

---

## 15. Diagnostics (Doctor Command)

**Priority:** LOW — Useful for troubleshooting.

### 15.1 Doctor Command

**New files:**
- `src/diagnostics/doctor.js`

**Description:** A diagnostic command (`/doctor`) that checks the health of all subsystems and reports issues.

**Checks:**
```javascript
const CHECKS = [
  {
    name: 'Provider Connectivity',
    check: async () => {
      // Test active provider API key
      // Try listing models
      // Return { ok, message, fix }
    }
  },
  {
    name: 'Channel Status',
    check: async () => {
      // For each enabled channel, check connection status
      // Telegram: test getMe()
      // Discord: test client.isReady()
      // etc.
    }
  },
  {
    name: 'Memory System',
    check: async () => {
      // Test memory store read/write
      // Check embedding provider if semantic search enabled
      // Report entry count and disk usage
    }
  },
  {
    name: 'Hook System',
    check: async () => {
      // Validate all hook.json files
      // Check handler files exist
      // Report enabled/disabled counts
    }
  },
  {
    name: 'Skill System',
    check: async () => {
      // Validate all loaded skills
      // Check for broken symlinks
      // Report loaded/errored counts
    }
  },
  {
    name: 'Gateway',
    check: async () => {
      // Check WebSocket server is listening
      // Report connection count
    }
  },
  {
    name: 'Docker (Sandbox)',
    check: async () => {
      // Test docker info
      // Check sandbox image availability
    }
  },
  {
    name: 'Cron Scheduler',
    check: async () => {
      // Check scheduler is running
      // Validate job configs
      // Report next scheduled run
    }
  },
  {
    name: 'Browser Service',
    check: async () => {
      // Detect browser availability
      // Check CDP connectivity if running
    }
  },
  {
    name: 'Disk Usage',
    check: async () => {
      // Report sizes: memory store, chat history, cron store, logs
    }
  }
]
```

**Output format:**
```
King Louie Diagnostics
======================
[PASS] Provider Connectivity — Anthropic claude-3-5-sonnet connected
[PASS] Channel Status — Telegram connected (bot: @mybot)
[WARN] Memory System — 847 entries, 12 MB. Semantic search disabled.
[PASS] Hook System — 3 hooks loaded, 0 errors
[PASS] Skill System — 2 skills loaded (std, hello-world)
[PASS] Gateway — Listening on :18789, 0 connections
[SKIP] Docker — Not configured
[SKIP] Cron — Not configured
[SKIP] Browser — Not configured
[INFO] Disk Usage — Memory: 12 MB, Chats: 8 MB, Logs: 2 MB
```

**Invocation:**
- Slash command: `/doctor`
- Settings UI: "Run Diagnostics" button
- IPC: `diagnostics:run → { checks: [{ name, status, message, fix }] }`

**Acceptance criteria:**
- [ ] All subsystems checked
- [ ] Clear PASS/WARN/FAIL/SKIP indicators
- [ ] Actionable fix suggestions for failures
- [ ] Available via `/doctor` command and settings UI
- [ ] Runs in under 10 seconds

---

## Implementation Dependencies

The following dependency graph shows which features should be built first:

```
Independent (can start immediately):
├── §1.1 Web Fetch Tool
├── §1.2 Web Search Tool
├── §2.2-2.6 New Providers (each independent)
├── §4 Cron System
├── §10 Group Chat & Mention Gating
├── §13 Usage Tracking
├── §14 Onboarding Wizard

Depends on §3.1 Channel Plugin Refactor:
├── §3.2 Discord
├── §3.3 Slack
├── §3.4 WhatsApp
├── §3.5 Signal
├── §3.6 IRC
├── §3.7 Teams
└── §10 Group Chat (uses channel interface)

Depends on §2 (provider for API access):
├── §6.1 Image Input (needs multimodal provider)
├── §6.2 Audio Transcription (needs OpenAI Whisper)
├── §6.3 TTS (needs OpenAI/ElevenLabs)
├── §7 Semantic Memory (needs embedding provider)

Depends on §6 Media Handling:
└── §11 Voice / Talk Mode

Depends on multiple features:
└── §15 Doctor (checks all subsystems, build last)
```

---

## Estimated Complexity

| Feature | New Files | Modified Files | Complexity | Dependencies |
|---------|-----------|---------------|------------|-------------|
| §1.1 Web Fetch | 2 | 2 | Low | npm: @mozilla/readability, linkedom |
| §1.2 Web Search | 4 | 2 | Low | npm: (none for DDG) |
| §2.1 Provider Refactor | 0 | 2 | Low | — |
| §2.2 Groq | 1 | 1 | Low | — |
| §2.3 Ollama | 1 | 1 | Medium | Ollama installed |
| §2.4 Mistral | 1 | 1 | Low | — |
| §2.5 Gemini | 1 | 1 | Medium | Format adapters |
| §2.6 OpenRouter | 1 | 1 | Low | — |
| §2.7 Inference Router | 0 | 1 | Low | §2.2-2.6 |
| §3.1 Channel Refactor | 0 | 2 | Medium | — |
| §3.2 Discord | 2 | 2 | Medium | npm: discord.js |
| §3.3 Slack | 2 | 2 | Medium | npm: @slack/bolt |
| §3.4 WhatsApp | 2 | 2 | High | npm: @whiskeysockets/baileys |
| §3.5 Signal | 2 | 2 | Medium | signal-cli binary |
| §3.6 IRC | 2 | 2 | Low | npm: irc-framework |
| §3.7 Teams | 2 | 2 | Medium | npm: botbuilder |
| §4.1 Cron Core | 3 | 1 | Medium | npm: cron-parser |
| §4.2 Cron Tool | 1 | 1 | Low | §4.1 |
| §4.3 Cron UI | 0 | 3 | Medium | §4.1 |
| §5.1 Browser Service | 2 | 0 | High | Chrome/Edge installed |
| §5.2 Browser Tool | 1 | 1 | Medium | §5.1 |
| §6.1 Image Input | 1 | 4 | Medium | — |
| §6.2 Transcription | 1 | 2 | Low | OpenAI API key |
| §6.3 TTS | 3 | 2 | Medium | — |
| §7 Semantic Memory | 3 | 1 | Medium | §2 (embedding API) |
| §8 Canvas | 2 | 2 | High | — |
| §9 Docker Sandbox | 2 | 1 | High | Docker installed |
| §10.1 Mention Gating | 2 | 3 | Low | §3.1 |
| §10.2 DM Pairing | 0 | 2 | Low | §10.1 |
| §11.1 PTT | 2 | 2 | Medium | §6.2, §6.3 |
| §11.2 Voice Wake | 1 | 1 | High | npm: @picovoice/porcupine-node |
| §12.1 Webhook Server | 3 | 1 | Medium | — |
| §12.2 Webhook UI | 0 | 3 | Medium | §12.1 |
| §13 Usage Tracking | 2 | 2 | Low | — |
| §14 Onboarding | 2 | 3 | Medium | — |
| §15 Doctor | 1 | 1 | Low | All features |
