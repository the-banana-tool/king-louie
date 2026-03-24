# King Louie — Consolidated Implementation Plan

> **Purpose:** Single-file handoff for LLMs working in series. Each task is self-contained, in dependency order, with explicit instructions and test cases.
>
> **Codebase context:** Electron app (main process + renderer + preload). Node.js/CommonJS. No TypeScript. Uses `electron-store`, `marked`, `dompurify`. Tests run via `npm test` (Node `--test` runner). IPC handlers live in `src/ipc/` modules using `wrapHandler()`. Tools registered in `src/tools/builtin/`. Providers in `src/providers/`. Skills in `src/skills/` + `skills/` directory.
>
> **What's already done:** LLM integration (OpenAI, Anthropic), 6 built-in tools (Bash, Read, Edit, Write, Message, Sessions), 3-agent orchestration, gateway/WebSocket, session management, task management, hook system, skill system with pinning, IPC extraction into `src/ipc/` modules with `wrapHandler`, XSS hardening, memory leak fixes, preload input validation + rate limiting, runtime cache.
>
> **Progress as of 2026-03-23:** 9 of 29 tasks completed (Tasks 1–9 and 16). Task 4 bug (missing factory registration) fixed. Task 17 completed. Task 20 completed. 19 tasks not started. See status markers on each task heading below.
>
> **Next up (all unblocked):** Tasks 10–15 (new tools, independent of each other).

---

## Task 1: Consolidate Global Renderer State ✅ COMPLETED

> **Completed:** `appState` object (lines 1-65) and `dom` object (lines 67-142) exist in `renderer.js`. All mutable state consolidated. 70+ DOM refs cached.

**Source:** architecture-updates.md item 5
**Dependencies:** None
**Files to modify:** `renderer.js`
**Estimated scope:** ~200 mechanical find-and-replace operations in one file

### Context

`renderer.js` has 82+ global variables (75 DOM refs + 7 mutable state vars + `settingsState` object) declared at the top level. Mutations are scattered throughout 2600+ lines making state changes hard to trace. This task consolidates them into two objects: `appState` (mutable state) and `dom` (DOM references).

### Instructions

**Step 1:** Read `renderer.js` lines 1-140 to identify all current global variable declarations. **(Done)**

**Step 2:** Create an `appState` object immediately after all `const` DOM references. Move these mutable variables into it: **(Done)**

```javascript
const appState = {
  chats: [],
  activeChatId: null,
  contextChatId: null,
  isAgentModeEnabled: false,
  isHistoryCollapsed: false,
  memoryEntries: [],
  streamBuffers: new Map(),   // was streamBufferById
  settings: { ... }           // was settingsState — keep same nested shape
};
```

**Step 3:** Create a `dom` object for all DOM element references. Currently these are ~75 `const` declarations using `document.getElementById(...)`. Group them: **(Done)**

```javascript
const dom = {
  userInput: document.getElementById('user-input'),
  sendBtn: document.getElementById('send-btn'),
  chatMessages: document.getElementById('chat-messages'),
  // ... all 75 element references
};
```

**Step 4:** Find-and-replace all bare references throughout `renderer.js`:
- `chats` → `appState.chats` (but NOT inside object keys or string literals)
- `activeChatId` → `appState.activeChatId`
- `contextChatId` → `appState.contextChatId`
- `settingsState` → `appState.settings`
- `streamBufferById` → `appState.streamBuffers`
- `isAgentModeEnabled` → `appState.isAgentModeEnabled`
- `isHistoryCollapsed` → `appState.isHistoryCollapsed`
- `memoryEntries` → `appState.memoryEntries`
- Each DOM ref (e.g., `userInput` → `dom.userInput`, `sendBtn` → `dom.sendBtn`, etc.)

**Be careful with:**
- Function parameters named the same as globals (e.g., a function that takes `chats` as a parameter should NOT be renamed)
- Object property access on other objects (e.g., `someObj.chats` should NOT become `someObj.appState.chats`)
- String literals containing variable names
- Destructured assignments

**Step 5:** Add a `resetAppState()` function:

```javascript
function resetAppState() {
  appState.chats = [];
  appState.activeChatId = null;
  appState.contextChatId = null;
  appState.isAgentModeEnabled = false;
  appState.isHistoryCollapsed = false;
  appState.memoryEntries = [];
  appState.streamBuffers.clear();
  // Reset settings to defaults
}
```

**Step 6:** Remove the old bare variable declarations (the `let chats = []`, `let activeChatId = null`, etc.).

### Test Cases

**T1.1 — Syntax check:**
```bash
node --check renderer.js
```
Expected: No syntax errors.

**T1.2 — No bare global state variables remain:**
```bash
# From repo root, grep for the old variable declarations
grep -n "^let chats " renderer.js
grep -n "^let activeChatId " renderer.js
grep -n "^let contextChatId " renderer.js
grep -n "^let settingsState " renderer.js
grep -n "^let streamBufferById " renderer.js
grep -n "^let isAgentModeEnabled " renderer.js
grep -n "^let isHistoryCollapsed " renderer.js
grep -n "^let memoryEntries " renderer.js
```
Expected: All return zero results.

**T1.3 — `appState` and `dom` objects exist:**
```bash
grep -n "const appState" renderer.js
grep -n "const dom" renderer.js
```
Expected: Exactly one match each.

**T1.4 — All references use new prefix:**
```bash
# Spot check: activeChatId should only appear as appState.activeChatId (or in comments/strings)
grep -n "activeChatId" renderer.js | grep -v "appState\." | grep -v "//" | grep -v "'"
```
Expected: Zero results (or only inside the appState object definition itself).

**T1.5 — `npm test` passes:**
```bash
npm test
```
Expected: All existing tests pass. No regressions.

**T1.6 — Manual smoke test:**
- Launch the app (`npm start`)
- Create a new chat
- Send a message and receive a response
- Switch between chats
- Open settings and change a provider
- Toggle agent mode
- Collapse/expand history sidebar

All should work identically to before.

### Acceptance Criteria
- All mutable state accessed through `appState` object
- All DOM refs accessed through `dom` object
- No bare global `let` variables for state remain
- `resetAppState()` function exists
- No functional regressions

---

## Task 2: Additional Preload Validation Coverage ✅ COMPLETED

> **Completed:** All chat/memory/agent/hooks/skills/settings/tool handlers validated in `preload.js` (347 lines). `throttleInvoke` rate limiting in place. Test file `tests/preload-validation.test.js` exists with full coverage.

**Source:** architecture-updates.md item 6 (remaining)
**Dependencies:** None (can run in parallel with Task 1)
**Files to modify:** `preload.js`

### Context

Preload currently validates 4 sensitive handlers (`settings.saveProvider`, `settings.runLlmCommand`, `skill.execute`, `tool.execute`). The remaining 39 invoke methods lack input validation. This task adds validation to the highest-risk remaining handlers.

### Instructions

**Step 1:** Read `preload.js` to understand the current validation pattern. You'll find a `validatePayload` or similar helper, and existing validations on the 4 handlers listed above.

**Step 2:** Add input validation to these additional handlers (prioritized by risk):

**Chat namespace (high risk — handles user content):**
- `chat.sendMessage({ chatId, message })` — validate `chatId` is string, `message` is string and non-empty
- `chat.addMessage({ chatId, sender, text })` — validate `chatId` is string, `sender` is one of `['user', 'assistant', 'system', 'tool']`, `text` is string
- `chat.rename({ chatId, name })` — validate both are strings, `name` is non-empty and ≤ 200 chars
- `chat.delete({ chatId })` — validate `chatId` is string

**Memory namespace (stores persistent data):**
- `memory.capture({ type, content })` — validate `type` is string, `content` is string and non-empty
- `memory.delete({ id })` — validate `id` is string

**Agent namespace (executes code):**
- `agent.execute({ agentId, message })` — validate `agentId` is string, `message` is string

**Hooks namespace:**
- `hooks.setEnabled({ hookId, enabled })` — validate `hookId` is string, `enabled` is boolean

**Step 3:** For each validation, throw an error with a descriptive message before the `ipcRenderer.invoke()` call:

```javascript
sendMessage: (payload) => {
  if (!payload || typeof payload.chatId !== 'string') throw new Error('Invalid chatId: expected string');
  if (typeof payload.message !== 'string' || !payload.message.trim()) throw new Error('Invalid message: expected non-empty string');
  return ipcRenderer.invoke('chat:sendMessage', payload);
},
```

### Test Cases

**T2.1 — Syntax check:**
```bash
node --check preload.js
```

**T2.2 — Create `tests/preload-validation.test.js`:**

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert');

// Mock ipcRenderer
const mockIpcRenderer = {
  invoke: async () => ({ ok: true }),
  on: () => {},
  send: () => {},
  removeListener: () => {}
};

// Test that validation rejects bad inputs
// Note: You may need to extract the validation functions or test via the preload module
// depending on how preload.js is structured. If preload uses contextBridge directly,
// create a test helper that imports the validation logic separately.

describe('Preload input validation', () => {
  it('rejects chat.sendMessage with missing chatId', () => {
    // Test that calling with { message: 'hi' } (no chatId) throws
  });

  it('rejects chat.sendMessage with empty message', () => {
    // Test that calling with { chatId: 'abc', message: '' } throws
  });

  it('rejects chat.addMessage with invalid sender', () => {
    // Test that calling with { chatId: 'abc', sender: 'hacker', text: 'hi' } throws
  });

  it('rejects chat.rename with name > 200 chars', () => {
    // Test that calling with { chatId: 'abc', name: 'x'.repeat(201) } throws
  });

  it('rejects memory.capture with empty content', () => {
    // Test that calling with { type: 'note', content: '' } throws
  });

  it('rejects agent.execute with non-string agentId', () => {
    // Test that calling with { agentId: 123, message: 'hi' } throws
  });

  it('rejects hooks.setEnabled with non-boolean enabled', () => {
    // Test that calling with { hookId: 'x', enabled: 'true' } throws
  });

  it('allows valid chat.sendMessage payload', () => {
    // Test that { chatId: 'abc', message: 'hello' } does NOT throw
  });

  it('allows valid memory.capture payload', () => {
    // Test that { type: 'note', content: 'remember this' } does NOT throw
  });
});
```

**T2.3 — `npm test` passes** (after adding new test file to the test script in `package.json`).

**T2.4 — Manual smoke test:**
- Send a message in the UI (should work normally)
- Create/rename/delete a chat (should work normally)
- Capture a memory (should work normally)

### Acceptance Criteria
- All high-risk preload handlers validate input types before IPC forwarding
- Invalid payloads rejected with descriptive errors before reaching main process
- Automated test coverage for validation logic
- No functional regressions

---

## Task 3: Provider Abstraction Refactor ✅ COMPLETED

> **Completed:** `ProviderFactory` has static `_registry` Map, `registerProvider()`, `listRegistered()`, `create()`. `BaseLLMProvider.discoverModels()` implemented. OpenAI + Anthropic registered at load time. Test file `tests/provider-factory.test.js` exists.

**Source:** openclaw.md §2.1
**Dependencies:** None
**Files to modify:** `src/providers/provider-factory.js`, `src/providers/base-provider.js`

### Context

Currently `ProviderFactory` has hardcoded OpenAI and Anthropic. This task makes it support dynamic registration so new providers can be added without modifying the factory.

### Instructions

**Step 1:** Read `src/providers/provider-factory.js` and `src/providers/base-provider.js`.

**Step 2:** Add a static provider registry to `ProviderFactory`:

```javascript
class ProviderFactory {
  static _registry = new Map();

  static registerProvider(providerType, ProviderClass) {
    if (typeof providerType !== 'string' || !providerType) {
      throw new Error('providerType must be a non-empty string');
    }
    if (typeof ProviderClass !== 'function') {
      throw new Error('ProviderClass must be a constructor');
    }
    ProviderFactory._registry.set(providerType.toLowerCase(), ProviderClass);
  }

  static listRegistered() {
    return Array.from(ProviderFactory._registry.keys());
  }

  static create(providerType, config) {
    const key = (providerType || '').toLowerCase();
    const ProviderClass = ProviderFactory._registry.get(key);
    if (!ProviderClass) {
      const available = ProviderFactory.listRegistered().join(', ');
      throw new Error(`Unknown provider: "${providerType}". Available: ${available}`);
    }
    return new ProviderClass(config);
  }
}
```

**Step 3:** Register existing providers at module load time:

```javascript
// At the bottom of provider-factory.js (or in a separate init file)
const OpenAIProvider = require('./openai-provider');
const AnthropicProvider = require('./anthropic-provider');

ProviderFactory.registerProvider('openai', OpenAIProvider);
ProviderFactory.registerProvider('anthropic', AnthropicProvider);
```

**Step 4:** Add optional `discoverModels()` to `BaseLLMProvider`:

```javascript
class BaseLLMProvider {
  // ... existing methods ...

  /**
   * Discover available models from the provider's API.
   * Override in subclasses that support model discovery.
   * @returns {Promise<Array<{id: string, name: string, capabilities: string[]}>>}
   */
  async discoverModels() {
    // Default: return static model list from getModels()
    return this.getModels().map(m => ({
      id: typeof m === 'string' ? m : m.id,
      name: typeof m === 'string' ? m : (m.name || m.id),
      capabilities: ['chat', 'streaming']
    }));
  }
}
```

**Step 5:** Update any call sites in `main.js` or IPC handlers that create providers to use the new `ProviderFactory.create()` method. Make sure the old usage pattern still works.

### Test Cases

**T3.1 — Create `tests/provider-factory.test.js`:**

```javascript
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('ProviderFactory', () => {
  // Import fresh each time to avoid registry pollution between tests
  let ProviderFactory;

  beforeEach(() => {
    // Clear module cache to get a fresh registry
    delete require.cache[require.resolve('../src/providers/provider-factory')];
    ProviderFactory = require('../src/providers/provider-factory');
  });

  it('registers and creates a provider', () => {
    class MockProvider {
      constructor(apiKey) { this.apiKey = apiKey; }
    }
    ProviderFactory.registerProvider('mock', MockProvider);
    const instance = ProviderFactory.create('mock', 'test-key');
    assert.ok(instance instanceof MockProvider);
    assert.strictEqual(instance.apiKey, 'test-key');
  });

  it('lists registered providers', () => {
    class A {}
    class B {}
    ProviderFactory.registerProvider('alpha', A);
    ProviderFactory.registerProvider('beta', B);
    const list = ProviderFactory.listRegistered();
    assert.ok(list.includes('alpha'));
    assert.ok(list.includes('beta'));
  });

  it('throws on unknown provider with helpful message', () => {
    assert.throws(
      () => ProviderFactory.create('nonexistent', 'test-key'),
      /Unknown provider.*nonexistent/
    );
  });

  it('is case-insensitive for provider type', () => {
    class MockProvider {}
    ProviderFactory.registerProvider('MyProvider', MockProvider);
    const instance = ProviderFactory.create('myprovider', 'test-key');
    assert.ok(instance instanceof MockProvider);
  });

  it('rejects invalid providerType', () => {
    assert.throws(
      () => ProviderFactory.registerProvider('', class {}),
      /non-empty string/
    );
    assert.throws(
      () => ProviderFactory.registerProvider(null, class {}),
      /non-empty string/
    );
  });

  it('rejects non-constructor ProviderClass', () => {
    assert.throws(
      () => ProviderFactory.registerProvider('test', 'not-a-class'),
      /constructor/
    );
  });

  it('includes openai and anthropic by default', () => {
    const list = ProviderFactory.listRegistered();
    assert.ok(list.includes('openai'));
    assert.ok(list.includes('anthropic'));
  });

  it('create() produces working OpenAI provider', () => {
    const provider = ProviderFactory.create('openai', 'sk-test12345');
    assert.ok(provider);
    assert.ok(typeof provider.getModels === 'function');
  });
});
```

**T3.2 — `discoverModels()` test:**

```javascript
describe('BaseLLMProvider.discoverModels', () => {
  it('returns model list with capabilities by default', async () => {
    const BaseLLMProvider = require('../src/providers/base-provider');
    class TestProvider extends BaseLLMProvider {
      getModels() { return ['model-a', 'model-b']; }
    }
    const provider = new TestProvider('test-key123');
    const models = await provider.discoverModels();
    assert.strictEqual(models.length, 2);
    assert.strictEqual(models[0].id, 'model-a');
    assert.ok(models[0].capabilities.includes('chat'));
  });
});
```

**T3.3 — Existing functionality preserved:**
```bash
npm test
```

**T3.4 — `node --check` on all modified files.**

### Acceptance Criteria
- New providers can be added by calling `ProviderFactory.registerProvider(type, Class)`
- `listRegistered()` returns all available provider types
- `create()` returns helpful error for unknown providers
- Existing OpenAI and Anthropic providers work unchanged
- `discoverModels()` available on base class

---

## Task 4: Groq Provider ✅ COMPLETED

> **Completed:** `GroqProvider` in `src/providers/groq-provider.js`, settings integrated in `main.js` (providerLabels, providerDefaults, providerTokenHints, providerModels, tierMap.fast), test endpoint in `settings-handlers.js`, tests in `tests/groq-provider.test.js` added to `package.json`.
>
> **BUG — factory registration missing:** `provider-factory.js` line 3 imports `GroqProvider` but lines 37-38 only register `openai` and `anthropic`. Missing: `ProviderFactory.registerProvider('groq', GroqProvider);` after line 38. The test `'is registered in ProviderFactory'` (`groq-provider.test.js:95`) will fail until this is fixed.
>
> **Architecture note for Tasks 5-8:** GroqProvider is a near-identical copy of OpenAIProvider (~280 lines each). The only differences are `this.baseUrl`, `getName()`/`getLabel()`/`getProviderName()`, `getModels()`, and `getDefaultModel()`. All of `formatMessages`, `sendMessage`, `sendMessageWithTools`, `parseToolResponse`, `buildToolMessages`, `streamMessage`, `listModels`, `extractError`, and `prependSystemPrompt` are duplicated verbatim. For Tasks 5-8:
> - **Option (a):** Copy the same pattern (fast, more duplication) — recommended for now
> - **Option (b):** Extract a shared `OpenAICompatibleProvider` base class and have all OpenAI-compatible providers extend it (cleaner, but scope creep)
>
> **Actual patterns to follow (verified against code):**
> - **Constructor:** Takes `apiKey` string directly (not config object). `BaseLLMProvider` validates min 8 chars.
> - **Settings in `main.js`:** Add to `providerLabels` (~line 325), `providerDefaults` (~line 332), `providerTokenHints` (~line 339), `DEFAULT_SETTINGS.providerModels` (~line 70).
> - **Test endpoint in `settings-handlers.js`:** Add `else if (provider === '...')` branch (~line 223) hitting the provider's models endpoint.
> - **Factory registration in `provider-factory.js`:** Import at top, add `ProviderFactory.registerProvider('name', Class);` after existing registrations (~line 38).
> - **Test script in `package.json`:** Append `&& node --test tests/<name>.test.js` to the `"test"` script (line 8).

**Source:** openclaw.md §2.2
**Dependencies:** Task 3 (provider abstraction)
**Files created:** `src/providers/groq-provider.js`, `tests/groq-provider.test.js`
**Files modified:** `src/providers/provider-factory.js`, `main.js`, `src/ipc/settings-handlers.js`, `package.json`

### Instructions

**Step 1:** Read `src/providers/openai-provider.js` as a reference — Groq uses an OpenAI-compatible API.

**Step 2:** Create `src/providers/groq-provider.js`:

```javascript
const BaseLLMProvider = require('./base-provider');

class GroqProvider extends BaseLLMProvider {
  constructor(config) {
    super(config);
    this.apiKey = config.apiKey || '';
    this.baseUrl = 'https://api.groq.com/openai/v1';
  }

  getName() { return 'groq'; }
  getLabel() { return 'Groq'; }

  getModels() {
    return [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 32768 },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', contextWindow: 8192 },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', contextWindow: 32768 },
      { id: 'gemma2-9b-it', name: 'Gemma 2 9B', contextWindow: 8192 }
    ];
  }

  // Implement sendMessage() and sendMessageStream() using the OpenAI-compatible API
  // Use fetch() to POST to this.baseUrl + '/chat/completions'
  // Auth header: Authorization: Bearer {this.apiKey}
  // Request/response format is identical to OpenAI including tool_calls
}
```

**Step 3:** Register in provider-factory.js:
```javascript
const GroqProvider = require('./groq-provider');
ProviderFactory.registerProvider('groq', GroqProvider);
```

**Step 4:** Add Groq to the settings store schema so API keys can be saved/loaded. Follow the same pattern as OpenAI/Anthropic in the settings handlers. The API key should be encrypted via `safeStorage`.

**Step 5:** Update `src/providers/inference-router.js` to include Groq in the tier map as a `fast` tier option.

### Test Cases

**T4.1 — Create `tests/groq-provider.test.js`:**

```javascript
const { describe, it, mock } = require('node:test');
const assert = require('node:assert');

describe('GroqProvider', () => {
  let GroqProvider;

  before(() => {
    GroqProvider = require('../src/providers/groq-provider');
  });

  it('instantiates with config', () => {
    const provider = new GroqProvider({ apiKey: 'gsk-test' });
    assert.strictEqual(provider.getName(), 'groq');
    assert.strictEqual(provider.getLabel(), 'Groq');
  });

  it('returns model list', () => {
    const provider = new GroqProvider({ apiKey: 'gsk-test' });
    const models = provider.getModels();
    assert.ok(models.length >= 3);
    assert.ok(models.some(m => m.id === 'llama-3.3-70b-versatile'));
  });

  it('uses correct base URL', () => {
    const provider = new GroqProvider({ apiKey: 'gsk-test' });
    assert.strictEqual(provider.baseUrl, 'https://api.groq.com/openai/v1');
  });

  it('formats messages in OpenAI-compatible format', () => {
    const provider = new GroqProvider({ apiKey: 'gsk-test' });
    // Test that formatMessages() produces { role, content } objects
    // matching OpenAI's schema
    const messages = [{ role: 'user', content: 'Hello' }];
    const formatted = provider.formatMessages ? provider.formatMessages(messages) : messages;
    assert.strictEqual(formatted[0].role, 'user');
  });

  it('includes tools in request when provided', () => {
    const provider = new GroqProvider({ apiKey: 'gsk-test' });
    // Test that buildRequestBody() includes tools array when tools are passed
  });

  it('handles API error gracefully', async () => {
    const provider = new GroqProvider({ apiKey: 'invalid' });
    // Mock fetch to return 401
    // Assert that sendMessage throws with descriptive error
  });

  it('is registered in ProviderFactory', () => {
    const ProviderFactory = require('../src/providers/provider-factory');
    assert.ok(ProviderFactory.listRegistered().includes('groq'));
    const provider = ProviderFactory.create('groq', { apiKey: 'test' });
    assert.strictEqual(provider.getName(), 'groq');
  });
});
```

**T4.2 — `npm test` passes.**

**T4.3 — Integration test (manual):**
- Set a Groq API key in settings
- Select Groq as active provider
- Send a message — should get a response
- Verify streaming works
- Verify tool calling works (send a message that triggers a tool)

### Acceptance Criteria
- Can send messages through Groq API
- Tool calling works
- Streaming works
- Model selection available
- Registered in ProviderFactory

---

## Task 5: Ollama Provider (Local Models) ✅ COMPLETED

> **Completed:** `OllamaProvider` in `src/providers/ollama-provider.js`. Overrides `validateApiKey()` (no-op) and `getHeaders()` (no Authorization). Uses OpenAI-compatible endpoint at `localhost:11434/v1`. `discoverModels()` hits `/api/tags`. Registered in factory, settings integrated in `main.js`, test endpoint in `settings-handlers.js`. 10 tests passing.

**Source:** openclaw.md §2.3
**Dependencies:** Task 3
**Files to create:** `src/providers/ollama-provider.js`
**Files to modify:** `src/providers/provider-factory.js`, `main.js` (settings), `src/ipc/settings-handlers.js`

> **Clarifications:**
> - **Copy `groq-provider.js` as template** (~280 lines), then change: `this.baseUrl` → `http://localhost:11434/v1`, `getName()` → `'ollama'`, `getLabel()` → `'Ollama (Local)'`, `getModels()` → empty (models come from `discoverModels()`), `getDefaultModel()` → `''`.
> - **No API key:** Ollama has no key. `BaseLLMProvider.validateApiKey()` throws if key < 8 chars, so **override `validateApiKey()` to be a no-op** in OllamaProvider. Do NOT add to `providerTokenHints`. Still add to `providerLabels` and `providerDefaults` in `main.js`.
> - **Settings integration:** Add `ollama: ''` to `DEFAULT_SETTINGS.providerModels`. Test endpoint branch: hit `http://localhost:11434/api/tags` with no auth.
> - **Override `getHeaders()`** to omit `Authorization` header (just `Content-Type: application/json`).
> - **Test script:** Add `&& node --test tests/ollama-provider.test.js` to `package.json`.

### Instructions

**Step 1:** Create `src/providers/ollama-provider.js`:

- Base URL: `http://localhost:11434` (configurable)
- Use OpenAI-compatible endpoint: `POST {baseUrl}/v1/chat/completions`
- No API key required
- Implement `discoverModels()` via `GET {baseUrl}/api/tags` — returns `{ models: [{ name, ... }] }`
- Handle connection refused gracefully (Ollama not running)
- Streaming via SSE (same as OpenAI-compatible endpoint)
- Tool calling supported on compatible models (Llama 3.1+, Mistral)

```javascript
async discoverModels() {
  try {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json();
    return (data.models || []).map(m => ({
      id: m.name,
      name: m.name,
      capabilities: ['chat', 'streaming']
    }));
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      throw new Error('Ollama is not running. Start it with: ollama serve');
    }
    throw err;
  }
}
```

**Step 2:** Register in provider-factory.js.

**Step 3:** Add settings support:
```javascript
ollama: {
  baseUrl: 'http://localhost:11434',
  model: ''  // Auto-populated from discovery
}
```
No API key encryption needed.

### Test Cases

**T5.1 — Create `tests/ollama-provider.test.js`:**

```javascript
describe('OllamaProvider', () => {
  it('instantiates with default baseUrl', () => {
    const provider = new OllamaProvider({});
    assert.strictEqual(provider.baseUrl, 'http://localhost:11434');
  });

  it('accepts custom baseUrl', () => {
    const provider = new OllamaProvider({ baseUrl: 'http://remote:11434' });
    assert.strictEqual(provider.baseUrl, 'http://remote:11434');
  });

  it('getName returns ollama', () => {
    const provider = new OllamaProvider({});
    assert.strictEqual(provider.getName(), 'ollama');
  });

  it('does not require API key', () => {
    const provider = new OllamaProvider({});
    // Should not throw when apiKey is missing
    assert.ok(provider);
  });

  it('discoverModels handles connection refused', async () => {
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:99999' });
    await assert.rejects(
      () => provider.discoverModels(),
      /not running|ECONNREFUSED|fetch failed/i
    );
  });

  it('formats messages for OpenAI-compatible endpoint', () => {
    const provider = new OllamaProvider({});
    // Verify message format matches OpenAI schema
  });

  it('is registered in ProviderFactory', () => {
    const ProviderFactory = require('../src/providers/provider-factory');
    assert.ok(ProviderFactory.listRegistered().includes('ollama'));
  });
});
```

**T5.2 — `npm test` passes.**

### Acceptance Criteria
- Auto-discovers locally available Ollama models
- Chat works with local models
- Tool calling works on supported models
- Graceful error when Ollama is not running
- Base URL configurable

---

## Task 6: Mistral Provider ✅ COMPLETED

> **Completed:** `MistralProvider` in `src/providers/mistral-provider.js`. OpenAI-compatible pattern (copied from Groq). Models: mistral-large-latest, mistral-small-latest, codestral-latest, open-mistral-nemo. Pricing table included. Registered in factory, settings integrated, test endpoint added. Also fixed Task 4 Groq registration bug. 8 tests passing.

**Source:** openclaw.md §2.4
**Dependencies:** Task 3
**Files to create:** `src/providers/mistral-provider.js`
**Files to modify:** `src/providers/provider-factory.js`, `main.js` (settings), `src/ipc/settings-handlers.js`

> **Clarifications:**
> - **Copy `groq-provider.js` as template** (~280 lines), then change: `this.baseUrl` → `https://api.mistral.ai/v1`, `getName()` → `'mistral'`, `getLabel()` → `'Mistral AI'`, `getProviderName()` → `'mistral'`, `getModels()` → Mistral model list, `getDefaultModel()` → `'mistral-large-latest'`.
> - **Settings in `main.js`:** Add `mistral: 'Mistral AI'` to `providerLabels`, `mistral: 'mistral-large-latest'` to `providerDefaults`, `mistral: ''` to `providerTokenHints` (no standard prefix). Add `mistral: 'mistral-large-latest'` to `DEFAULT_SETTINGS.providerModels`.
> - **Test endpoint in `settings-handlers.js`:** Hit `https://api.mistral.ai/v1/models` with `Authorization: Bearer {token}`.
> - **Factory registration:** Import + `ProviderFactory.registerProvider('mistral', MistralProvider);` in `provider-factory.js`.
> - **Test script:** Add `&& node --test tests/mistral-provider.test.js` to `package.json`.
> - **Also fix Task 4 bug** while you're in `provider-factory.js`: add missing `ProviderFactory.registerProvider('groq', GroqProvider);`.

### Instructions

Identical pattern to Groq (OpenAI-compatible API):
- API: `POST https://api.mistral.ai/v1/chat/completions`
- Auth: `Authorization: Bearer {MISTRAL_API_KEY}`
- Models: `mistral-large-latest`, `mistral-small-latest`, `codestral-latest`, `open-mistral-nemo`
- Tool calling: OpenAI-compatible schema
- Streaming: SSE

Follow the exact same structure as `groq-provider.js` but with Mistral's base URL and model list.

### Test Cases

**T6.1 — Create `tests/mistral-provider.test.js`:**

```javascript
describe('MistralProvider', () => {
  it('instantiates with config', () => {
    const provider = new MistralProvider({ apiKey: 'test' });
    assert.strictEqual(provider.getName(), 'mistral');
    assert.strictEqual(provider.baseUrl, 'https://api.mistral.ai/v1');
  });

  it('returns model list with codestral', () => {
    const provider = new MistralProvider({ apiKey: 'test' });
    const models = provider.getModels();
    assert.ok(models.some(m => m.id === 'codestral-latest'));
    assert.ok(models.some(m => m.id === 'mistral-large-latest'));
  });

  it('is registered in ProviderFactory', () => {
    const ProviderFactory = require('../src/providers/provider-factory');
    assert.ok(ProviderFactory.listRegistered().includes('mistral'));
  });

  it('formats auth header correctly', () => {
    const provider = new MistralProvider({ apiKey: 'my-key' });
    // Verify the provider uses Bearer token auth
  });
});
```

**T6.2 — `npm test` passes.**

### Acceptance Criteria
- Chat and tool calling work via Mistral API
- Model selection in settings
- Streaming supported
- Registered in ProviderFactory

---

## Task 7: Google Gemini Provider ✅ COMPLETED

> **Completed:** `GeminiProvider` in `src/providers/gemini-provider.js`. Custom implementation (NOT OpenAI-compatible): `formatMessages()` converts to Gemini parts format with role mapping (assistant→model), extracts system instructions separately. `formatTools()` converts to functionDeclarations. `parseToolCalls()` converts functionCall responses back to standard tool_use shape. Auth via `?key=` query param. Streaming via SSE with `usageMetadata` parsing. Registered in factory, settings integrated, test endpoint added. 15 tests passing.

**Source:** openclaw.md §2.5
**Dependencies:** Task 3
**Files to create:** `src/providers/gemini-provider.js`
**Files to modify:** `src/providers/provider-factory.js`, `main.js` (settings), `src/ipc/settings-handlers.js`

> **Clarifications:**
> - **DO NOT copy `groq-provider.js` verbatim.** Gemini is NOT OpenAI-compatible. Start from `base-provider.js` and implement from scratch. You WILL need custom `formatMessages()`, `sendMessage()`, `sendMessageWithTools()`, `streamMessage()`, and tool-related methods.
> - **Auth:** Gemini uses `?key={apiKey}` query param, NOT `Authorization` header. Override `getHeaders()` to omit the Bearer token. Append key to URL instead.
> - **Constructor:** Still takes `apiKey` string via `BaseLLMProvider(apiKey)`. The `validateApiKey()` base method (min 8 chars) should work fine for Gemini keys.
> - **Settings in `main.js`:** Add `gemini: 'Google Gemini'` to `providerLabels`, `gemini: 'gemini-2.0-flash'` to `providerDefaults`, `gemini: 'AI'` to `providerTokenHints`. Add `gemini: 'gemini-2.0-flash'` to `DEFAULT_SETTINGS.providerModels`.
> - **Test endpoint in `settings-handlers.js`:** Hit `https://generativelanguage.googleapis.com/v1beta/models?key={token}` (no auth header).
> - **Format adapters:** Must implement: `formatMessages()` (role mapping: `assistant`→`model`, content→`parts: [{text}]`), `formatTools()` (→`functionDeclarations`), `parseToolCalls()` (`functionCall`→tool_calls conversion). The response shape is completely different from OpenAI.
> - **Return shape must match other providers:** `sendMessageWithTools()` must return `{ type: 'tool_use'|'text', toolName, toolUseId, parameters, messageContent, llmMetrics }` — same shape as `GroqProvider.parseToolResponse()`.
> - **Factory + test script:** Same pattern as other providers.

### Instructions

Gemini uses a **different API format** from OpenAI — this requires format adapters.

**Step 1:** Create `src/providers/gemini-provider.js`:

- API: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Auth: `?key={GEMINI_API_KEY}` query param
- Models: `gemini-2.0-flash`, `gemini-2.0-pro`, `gemini-1.5-flash`, `gemini-1.5-pro`
- Streaming: `POST .../{model}:streamGenerateContent?alt=sse&key={apiKey}`

**Step 2:** Implement message format adapter:
```javascript
// Convert King Louie's { role, content } to Gemini's { role, parts: [{ text }] }
formatMessages(messages) {
  return messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : msg.role,
    parts: [{ text: msg.content }]
  }));
}
```

**Step 3:** Implement tool schema adapter:
```javascript
// Convert OpenAI function definitions to Gemini functionDeclarations
formatTools(tools) {
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters  // JSON Schema, mostly compatible
    }))
  }];
}
```

**Step 4:** Implement response adapter:
```javascript
// Convert Gemini's functionCall responses back to King Louie's tool-use format
parseToolCalls(candidate) {
  const parts = candidate.content?.parts || [];
  return parts
    .filter(p => p.functionCall)
    .map(p => ({
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: p.functionCall.name,
      arguments: p.functionCall.args
    }));
}
```

### Test Cases

**T7.1 — Create `tests/gemini-provider.test.js`:**

```javascript
describe('GeminiProvider', () => {
  it('instantiates with API key', () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    assert.strictEqual(provider.getName(), 'gemini');
  });

  it('returns model list', () => {
    const provider = new GeminiProvider({ apiKey: 'test' });
    const models = provider.getModels();
    assert.ok(models.some(m => m.id === 'gemini-2.0-flash'));
  });

  it('formats messages to Gemini format', () => {
    const provider = new GeminiProvider({ apiKey: 'test' });
    const formatted = provider.formatMessages([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ]);
    assert.strictEqual(formatted[0].role, 'user');
    assert.deepStrictEqual(formatted[0].parts, [{ text: 'Hello' }]);
    assert.strictEqual(formatted[1].role, 'model'); // assistant -> model
  });

  it('formats tools to functionDeclarations', () => {
    const provider = new GeminiProvider({ apiKey: 'test' });
    const tools = [{ name: 'Bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }];
    const formatted = provider.formatTools(tools);
    assert.ok(Array.isArray(formatted));
    assert.ok(formatted[0].functionDeclarations);
    assert.strictEqual(formatted[0].functionDeclarations[0].name, 'Bash');
  });

  it('parses tool call responses', () => {
    const provider = new GeminiProvider({ apiKey: 'test' });
    const candidate = {
      content: {
        parts: [
          { functionCall: { name: 'Bash', args: { command: 'ls' } } }
        ]
      }
    };
    const calls = provider.parseToolCalls(candidate);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'Bash');
    assert.deepStrictEqual(calls[0].arguments, { command: 'ls' });
    assert.ok(calls[0].id); // has generated ID
  });

  it('constructs correct streaming URL', () => {
    const provider = new GeminiProvider({ apiKey: 'my-key' });
    const url = provider.getStreamUrl('gemini-2.0-flash');
    assert.ok(url.includes('streamGenerateContent'));
    assert.ok(url.includes('alt=sse'));
    assert.ok(url.includes('key=my-key'));
  });

  it('is registered in ProviderFactory', () => {
    const ProviderFactory = require('../src/providers/provider-factory');
    assert.ok(ProviderFactory.listRegistered().includes('gemini'));
  });
});
```

**T7.2 — `npm test` passes.**

### Acceptance Criteria
- Chat works with Gemini models
- Tool calling works (with format adaptation)
- Streaming supported
- Message format correctly adapted (role mapping, parts structure)

---

## Task 8: OpenRouter Meta-Provider ✅ COMPLETED

> **Completed:** `OpenRouterProvider` in `src/providers/openrouter-provider.js`. OpenAI-compatible pattern with extra `HTTP-Referer` and `X-Title` headers. Default models span multiple upstream providers. `discoverModels()` fetches from `/models` endpoint. Registered in factory, settings integrated, test endpoint added. 8 tests passing.

**Source:** openclaw.md §2.6
**Dependencies:** Task 3
**Files to create:** `src/providers/openrouter-provider.js`
**Files to modify:** `src/providers/provider-factory.js`, `main.js` (settings), `src/ipc/settings-handlers.js`

> **Clarifications:**
> - **Copy `groq-provider.js` as template**, then change: `this.baseUrl` → `https://openrouter.ai/api/v1`, `getName()` → `'openrouter'`, `getLabel()` → `'OpenRouter'`, `getProviderName()` → `'openrouter'`, `getDefaultModel()` → `'openai/gpt-4o-mini'`.
> - **Override `getHeaders()`** to add extra headers: `'HTTP-Referer': 'king-louie'` and `'X-Title': 'King Louie'` alongside the Bearer token.
> - **Settings in `main.js`:** Add `openrouter: 'OpenRouter'` to `providerLabels`, `openrouter: 'openai/gpt-4o-mini'` to `providerDefaults`, `openrouter: 'sk-or-'` to `providerTokenHints`. Add `openrouter: 'openai/gpt-4o-mini'` to `DEFAULT_SETTINGS.providerModels`.
> - **Test endpoint in `settings-handlers.js`:** Hit `https://openrouter.ai/api/v1/models` with Bearer auth + the extra headers.
> - **Factory + test script:** Same pattern as other providers.

### Instructions

OpenRouter is OpenAI-compatible. Same pattern as Groq/Mistral but with model discovery.

- API: `POST https://openrouter.ai/api/v1/chat/completions`
- Auth: `Authorization: Bearer {OPENROUTER_API_KEY}`
- Model discovery: `GET https://openrouter.ai/api/v1/models` — returns list of 100+ models
- Extra headers: `HTTP-Referer: king-louie`, `X-Title: King Louie`

Implement `discoverModels()` that fetches from the models endpoint and returns available models.

### Test Cases

**T8.1 — Create `tests/openrouter-provider.test.js`:**

```javascript
describe('OpenRouterProvider', () => {
  it('instantiates with config', () => {
    const provider = new OpenRouterProvider({ apiKey: 'or-test' });
    assert.strictEqual(provider.getName(), 'openrouter');
    assert.strictEqual(provider.baseUrl, 'https://openrouter.ai/api/v1');
  });

  it('includes required headers', () => {
    const provider = new OpenRouterProvider({ apiKey: 'test' });
    const headers = provider.getHeaders();
    assert.ok(headers['HTTP-Referer']);
    assert.ok(headers['X-Title']);
    assert.ok(headers['Authorization'].includes('Bearer'));
  });

  it('returns a default model list', () => {
    const provider = new OpenRouterProvider({ apiKey: 'test' });
    const models = provider.getModels();
    assert.ok(models.length > 0);
  });

  it('is registered in ProviderFactory', () => {
    const ProviderFactory = require('../src/providers/provider-factory');
    assert.ok(ProviderFactory.listRegistered().includes('openrouter'));
  });
});
```

**T8.2 — `npm test` passes.**

### Acceptance Criteria
- Works as an OpenAI-compatible provider
- Model discovery available
- Required OpenRouter headers included
- Single API key unlocks many model options

---

## Task 9: Inference Router Updates ✅ COMPLETED

> **Completed:** Updated `InferenceRouter` with `getCapabilities()`, `getTierConfig()`, `execute()`, and `routeWithFallback()` to support fallbacks. Added `tests/inference-router.test.js` and wired it into `package.json`. All 5 tests passing.

**Source:** openclaw.md §2.7
**Dependencies:** Tasks 4-8 (new providers)
**Files to modify:** `src/providers/inference-router.js`, `main.js` (DEFAULT_SETTINGS)

> **Clarifications:**
> - **Tier map lives in `main.js`:** `DEFAULT_SETTINGS.inference.tierMap` defines the fast/standard/smart mappings. `InferenceRouter.resolve()` reads from `settings.inference.tierMap`. If Task 4 already updated the fast tier to Groq, this task just needs to add fallback chains and capability detection to `inference-router.js` itself.
> - **Timeouts:** `DEFAULT_SETTINGS.inference.timeoutsMs` has per-tier timeouts (fast: 15000, standard: 30000, smart: 90000). No changes needed unless a provider needs a different timeout.
> - **Test script:** Add `&& node tests/inference-router.test.js` to `package.json`.

### Instructions

**Step 1:** Read `src/providers/inference-router.js` to understand the current tier map structure.

**Step 2:** Update the tier map to support new providers:

```javascript
tierMap: {
  fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  standard: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
  smart: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' }
}
```

**Step 3:** Add model capability detection:

```javascript
getCapabilities(provider, model) {
  // Return { vision: bool, toolCalling: bool, streaming: bool }
  // Based on known model capabilities
}
```

**Step 4:** Add fallback chain support:

```javascript
fallbacks: {
  groq: { provider: 'openai', model: 'gpt-4o-mini' },
  ollama: { provider: 'groq', model: 'llama-3.3-70b-versatile' }
}

async routeWithFallback(tier, messages, options) {
  const primary = this.getTierConfig(tier);
  try {
    return await this.execute(primary, messages, options);
  } catch (err) {
    const fallback = this.fallbacks[primary.provider];
    if (fallback) {
      console.warn(`[inference-router] ${primary.provider} failed, falling back to ${fallback.provider}`);
      return await this.execute(fallback, messages, options);
    }
    throw err;
  }
}
```

### Test Cases

**T9.1 — Create `tests/inference-router.test.js`:**

```javascript
describe('InferenceRouter', () => {
  it('resolves fast tier to groq', () => {
    const router = new InferenceRouter(config);
    const resolved = router.getTierConfig('fast');
    assert.strictEqual(resolved.provider, 'groq');
  });

  it('falls back when primary provider fails', async () => {
    // Mock groq to throw, verify openai is tried
  });

  it('throws when no fallback available', async () => {
    // Mock a provider with no fallback configured, verify error propagates
  });

  it('returns capabilities for known models', () => {
    const router = new InferenceRouter(config);
    const caps = router.getCapabilities('openai', 'gpt-4o');
    assert.strictEqual(caps.vision, true);
    assert.strictEqual(caps.toolCalling, true);
  });

  it('all new providers are valid tier options', () => {
    const router = new InferenceRouter(config);
    // Verify groq, ollama, mistral, gemini, openrouter can be set as tier providers
  });
});
```

**T9.2 — `npm test` passes.**

### Acceptance Criteria
- All new providers selectable per tier
- Fallback routing works when a provider errors
- Model capability detection available

---

## Task 10: Web Fetch Tool ✅ COMPLETED

> **Completed:** Web Fetch Tool (`src/tools/builtin/web-fetch-tool.js` and `src/tools/builtin/web-fetch-utils.js`) implemented with SSRF protection, content extraction (markdown/text), size limits, truncation, and 15-minute caching. Registered in `src/tools/index.js` and tested thoroughly in `tests/web-fetch-tool.test.js`.

**Source:** openclaw.md §1.1
**Dependencies:** None
**Files to create:** `src/tools/builtin/web-fetch-tool.js`, `src/tools/builtin/web-fetch-utils.js`
**Files to modify:** `src/tools/index.js` (register tool)
**npm install:** `@mozilla/readability`, `linkedom`, `turndown`

> **Clarifications:**
> - **Tool registration pattern:** In `src/tools/index.js`, import the tool and call `toolRegistry.register(WebFetchTool)` inside `initializeTools()`. Follow the exact pattern of BashTool/ReadTool/EditTool/WriteTool already there.
> - **Test script:** Add `&& node tests/web-fetch-tool.test.js` to `package.json`.
> - **Tool schema:** Tool class is in `src/tools/tool-schema.js`. Tools have `name`, `description`, `parameters` (JSON Schema), `requiresApproval`, and `execute(params, context)`.
> - **Approval system:** `src/execution/tool-executor.js` handles approval. Set `requiresApproval: false` for WebFetch since it only reads public URLs.

### Instructions

**Step 1:** Create `src/tools/builtin/web-fetch-utils.js`:

```javascript
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const TurndownService = require('turndown');

// SSRF protection: block private/reserved IP ranges
const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/
];

function isPrivateIp(ip) {
  return PRIVATE_IP_RANGES.some(regex => regex.test(ip));
}

async function validateUrl(urlString, allowPrivateNetwork = false) {
  const url = new URL(urlString);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Blocked protocol: ${url.protocol}. Only HTTP(S) allowed.`);
  }
  if (!allowPrivateNetwork) {
    // Resolve DNS and check IP
    const { promises: dns } = require('dns');
    const addresses = await dns.resolve4(url.hostname).catch(() => []);
    const addresses6 = await dns.resolve6(url.hostname).catch(() => []);
    for (const ip of [...addresses, ...addresses6]) {
      if (isPrivateIp(ip)) {
        throw new Error(`Blocked: ${url.hostname} resolves to private IP ${ip}`);
      }
    }
  }
  return url;
}

function htmlToMarkdown(html) {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return turndown.turndown(html);
}

function htmlToText(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractReadableContent(html, url) {
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();
  return article ? { title: article.title, content: article.content } : null;
}

module.exports = { validateUrl, isPrivateIp, htmlToMarkdown, htmlToText, extractReadableContent };
```

**Step 2:** Create `src/tools/builtin/web-fetch-tool.js`:

```javascript
const Tool = require('../tool-schema');
const { validateUrl, extractReadableContent, htmlToMarkdown, htmlToText } = require('./web-fetch-utils');

const webFetchTool = new Tool({
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
  requiresApproval: false,
  execute: async (params) => {
    const { url: urlString, extractMode = 'markdown', maxChars = 50000 } = params;

    // Validate URL and check SSRF
    await validateUrl(urlString);

    // Fetch with timeout and size limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(urlString, {
        signal: controller.signal,
        headers: { 'User-Agent': 'King-Louie/1.0' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();

      // Size limit (2MB raw)
      if (raw.length > 2097152) {
        throw new Error('Response exceeds 2MB limit');
      }

      let output;
      if (contentType.includes('text/html')) {
        const article = extractReadableContent(raw, urlString);
        const content = article ? article.content : raw;
        output = extractMode === 'markdown' ? htmlToMarkdown(content) : htmlToText(content);
        if (article?.title) output = `# ${article.title}\n\n${output}`;
      } else {
        output = raw;
      }

      // Truncate to maxChars
      if (output.length > maxChars) {
        output = output.slice(0, maxChars) + '\n\n[Content truncated]';
      }

      return { ok: true, content: output };
    } finally {
      clearTimeout(timeout);
    }
  }
});

module.exports = webFetchTool;
```

**Step 3:** Register in `src/tools/index.js` alongside existing tools.

**Step 4:** Add an in-memory cache with 15-minute TTL (simple Map with timestamps).

### Test Cases

**T10.1 — Create `tests/web-fetch-tool.test.js`:**

```javascript
describe('WebFetch SSRF Protection', () => {
  it('blocks file:// protocol', async () => {
    await assert.rejects(
      () => validateUrl('file:///etc/passwd'),
      /Blocked protocol/
    );
  });

  it('blocks ftp:// protocol', async () => {
    await assert.rejects(
      () => validateUrl('ftp://evil.com/file'),
      /Blocked protocol/
    );
  });

  it('identifies private IPs', () => {
    assert.ok(isPrivateIp('127.0.0.1'));
    assert.ok(isPrivateIp('10.0.0.1'));
    assert.ok(isPrivateIp('192.168.1.1'));
    assert.ok(isPrivateIp('172.16.0.1'));
    assert.ok(!isPrivateIp('8.8.8.8'));
    assert.ok(!isPrivateIp('1.1.1.1'));
  });

  it('allows http:// URLs', async () => {
    // Should not throw for valid public URLs (just validates, doesn't fetch)
    await assert.doesNotReject(
      () => validateUrl('https://example.com', true)
    );
  });
});

describe('WebFetch Content Extraction', () => {
  it('converts HTML to markdown', () => {
    const html = '<h1>Title</h1><p>Hello <strong>world</strong></p>';
    const md = htmlToMarkdown(html);
    assert.ok(md.includes('# Title'));
    assert.ok(md.includes('**world**'));
  });

  it('converts HTML to plain text', () => {
    const html = '<h1>Title</h1><p>Hello <strong>world</strong></p>';
    const text = htmlToText(html);
    assert.ok(!text.includes('<'));
    assert.ok(text.includes('Title'));
    assert.ok(text.includes('world'));
  });

  it('truncates content to maxChars', async () => {
    // Create a tool execution with maxChars: 100 and a long response
    // Verify output is truncated with [Content truncated] marker
  });
});

describe('WebFetch Cache', () => {
  it('returns cached result for same URL within TTL', async () => {
    // Fetch same URL twice, verify second call doesn't make HTTP request
  });

  it('cache expires after TTL', async () => {
    // Set short TTL, wait, verify fresh fetch
  });
});
```

**T10.2 — `npm test` passes.**

**T10.3 — `node --check` on all new files.**

### Acceptance Criteria
- Agent can fetch any public URL and receive markdown content
- Private IPs blocked by default
- Responses cached for 15 minutes
- Content truncated to `maxChars`
- Non-HTTP schemes blocked

---

## Task 11: Web Search Tool ✅ COMPLETED

> **Completed:** Created `SearchProvider` base class and implementations for `DuckDuckGoSearch`, `BraveSearch`, and `TavilySearch`. Created `WebSearchTool` which auto-detects the configured provider from the app settings, falling back to DuckDuckGo. Integrated settings handling in `main.js` and `src/ipc/settings-handlers.js` with `safeStorage` encryption for Brave and Tavily API keys. Added test coverage in `tests/web-search-tool.test.js`.

**Source:** openclaw.md §1.2
**Dependencies:** None (independent of Task 10)
**Files to create:** `src/tools/builtin/web-search-tool.js`, `src/web-search/search-provider.js`, `src/web-search/providers/brave-search.js`, `src/web-search/providers/duckduckgo.js`, `src/web-search/providers/tavily.js`
**Files to modify:** `src/tools/index.js`

> **Clarifications:**
> - **Tool registration:** Same pattern as Task 10 — `toolRegistry.register(WebSearchTool)` in `src/tools/index.js`.
> - **Settings for API keys:** Search provider API keys (Brave, Tavily) need storage. Add a `webSearch` section to `DEFAULT_SETTINGS` in `main.js` and encrypt keys via `safeStorage` same as LLM provider keys.
> - **Test script:** Add `&& node tests/web-search-tool.test.js` to `package.json`.

### Instructions

**Step 1:** Create `src/web-search/search-provider.js` (base class):

```javascript
class SearchProvider {
  constructor(apiKey) { this.apiKey = apiKey; }
  getName() { throw new Error('Not implemented'); }
  isConfigured() { return false; }
  async search(query, maxResults) { throw new Error('Not implemented'); }
  // Returns: [{ title: string, url: string, snippet: string }]
}
module.exports = SearchProvider;
```

**Step 2:** Implement DuckDuckGo provider (keyless, default fallback):
- `GET https://html.duckduckgo.com/html/?q={query}`
- Parse HTML response to extract results
- No API key needed

**Step 3:** Implement Brave Search provider:
- `GET https://api.search.brave.com/res/v1/web/search?q={query}&count={maxResults}`
- Header: `X-Subscription-Token: {apiKey}`
- Parse JSON response

**Step 4:** Implement Tavily provider:
- `POST https://api.tavily.com/search`
- Body: `{ query, max_results, api_key }`
- Returns rich snippets

**Step 5:** Create the WebSearch tool with auto-detection logic:

```javascript
// Auto-detect: use whichever provider has a configured API key
// Fall back to DuckDuckGo (keyless) if none configured
function getDefaultProvider(settings) {
  if (settings?.webSearch?.brave?.apiKey) return 'brave';
  if (settings?.webSearch?.tavily?.apiKey) return 'tavily';
  return 'duckduckgo';
}
```

**Step 6:** Register in `src/tools/index.js`.

### Test Cases

**T11.1 — Create `tests/web-search-tool.test.js`:**

```javascript
describe('SearchProvider base class', () => {
  it('throws on unimplemented methods', async () => {
    const provider = new SearchProvider({});
    assert.throws(() => provider.getName());
    await assert.rejects(() => provider.search('test', 5));
  });
});

describe('DuckDuckGo provider', () => {
  it('is configured without API key', () => {
    const ddg = new DuckDuckGoSearch({});
    assert.strictEqual(ddg.isConfigured(), true);
  });

  it('returns results with title, url, snippet', async () => {
    // Mock fetch to return sample HTML
    // Verify parsed results have expected shape
  });

  it('getName returns duckduckgo', () => {
    const ddg = new DuckDuckGoSearch({});
    assert.strictEqual(ddg.getName(), 'duckduckgo');
  });
});

describe('BraveSearch provider', () => {
  it('requires API key', () => {
    const brave = new BraveSearch({});
    assert.strictEqual(brave.isConfigured(), false);
    const configured = new BraveSearch({ apiKey: 'test' });
    assert.strictEqual(configured.isConfigured(), true);
  });

  it('includes correct auth header', () => {
    const brave = new BraveSearch({ apiKey: 'my-key' });
    // Verify X-Subscription-Token header
  });
});

describe('TavilySearch provider', () => {
  it('requires API key', () => {
    const tavily = new TavilySearch({});
    assert.strictEqual(tavily.isConfigured(), false);
  });
});

describe('WebSearch Tool', () => {
  it('auto-detects provider based on configured keys', () => {
    assert.strictEqual(getDefaultProvider({}), 'duckduckgo');
    assert.strictEqual(getDefaultProvider({ webSearch: { brave: { apiKey: 'x' } } }), 'brave');
  });

  it('returns structured results', async () => {
    // Mock provider, verify tool returns [{ title, url, snippet }]
  });

  it('respects maxResults parameter', async () => {
    // Verify results array length <= maxResults
  });
});
```

**T11.2 — `npm test` passes.**

### Acceptance Criteria
- Agent can search the web and receive structured results
- DuckDuckGo works without API keys
- API keys configurable for Brave and Tavily
- Provider auto-detection works
- Results include title, URL, and snippet

---

## Task 12: Glob Tool ✅ COMPLETED

> **Completed:** `GlobTool` created in `src/tools/builtin/glob-tool.js` using `fast-glob`. It supports sorting files by modification time, excludes `node_modules` and `.git` by default, and respects the `maxResults` constraint. It is registered in `src/tools/index.js` and tested via `tests/glob-tool.test.js`.

**Source:** king-louie-enhancement-plan.md Phase 7
**Dependencies:** None
**Files to create:** `src/tools/builtin/glob-tool.js`
**Files to modify:** `src/tools/index.js`
**npm install:** `fast-glob`

> **Clarifications:**
> - **Tool registration:** `toolRegistry.register(GlobTool)` in `src/tools/index.js`.
> - **Test script:** Add `&& node tests/glob-tool.test.js` to `package.json`.

### Instructions

Create a Glob tool for fast file pattern matching:

```javascript
const Tool = require('../tool-schema');
const fg = require('fast-glob');
const path = require('path');

const globTool = new Tool({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns file paths sorted by modification time.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts")' },
      cwd: { type: 'string', description: 'Directory to search in. Defaults to working directory.' },
      maxResults: { type: 'number', default: 100, description: 'Maximum number of results' }
    },
    required: ['pattern']
  },
  requiresApproval: false,
  execute: async (params, context) => {
    const { pattern, cwd, maxResults = 100 } = params;
    const baseDir = cwd || context?.workingDirectory || process.cwd();

    // Security: validate the resolved cwd is within allowed paths
    const resolvedBase = path.resolve(baseDir);

    const files = await fg(pattern, {
      cwd: resolvedBase,
      stats: true,
      absolute: false,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**']
    });

    // Sort by modification time (newest first)
    files.sort((a, b) => (b.stats?.mtimeMs || 0) - (a.stats?.mtimeMs || 0));

    const results = files.slice(0, maxResults).map(f => ({
      path: f.path || f,
      modified: f.stats?.mtime?.toISOString() || null
    }));

    return { ok: true, files: results, total: files.length, truncated: files.length > maxResults };
  }
});

module.exports = globTool;
```

Register in `src/tools/index.js`.

### Test Cases

**T12.1 — Create `tests/glob-tool.test.js`:**

```javascript
describe('Glob Tool', () => {
  it('finds JavaScript files', async () => {
    const result = await globTool.execute({ pattern: '**/*.js', cwd: path.join(__dirname, '..') });
    assert.ok(result.ok);
    assert.ok(result.files.length > 0);
    assert.ok(result.files[0].path.endsWith('.js'));
  });

  it('respects maxResults', async () => {
    const result = await globTool.execute({ pattern: '**/*', cwd: path.join(__dirname, '..'), maxResults: 3 });
    assert.ok(result.files.length <= 3);
    if (result.total > 3) assert.ok(result.truncated);
  });

  it('excludes node_modules by default', async () => {
    const result = await globTool.execute({ pattern: '**/*.js', cwd: path.join(__dirname, '..') });
    assert.ok(!result.files.some(f => f.path.includes('node_modules')));
  });

  it('excludes .git by default', async () => {
    const result = await globTool.execute({ pattern: '**/*', cwd: path.join(__dirname, '..') });
    assert.ok(!result.files.some(f => f.path.includes('.git')));
  });

  it('returns empty array for no matches', async () => {
    const result = await globTool.execute({ pattern: '**/*.nonexistent_extension_xyz' });
    assert.ok(result.ok);
    assert.strictEqual(result.files.length, 0);
  });

  it('sorts by modification time (newest first)', async () => {
    const result = await globTool.execute({ pattern: '**/*.js', cwd: path.join(__dirname, '..'), maxResults: 10 });
    if (result.files.length >= 2) {
      const times = result.files.map(f => new Date(f.modified).getTime());
      for (let i = 1; i < times.length; i++) {
        assert.ok(times[i - 1] >= times[i], 'Results should be sorted newest first');
      }
    }
  });

  it('handles invalid pattern gracefully', async () => {
    // fast-glob should handle this or we catch the error
    const result = await globTool.execute({ pattern: '[invalid' });
    // Should either return empty or return error, not crash
  });
});
```

**T12.2 — `npm test` passes.**

### Acceptance Criteria
- Finds files matching glob patterns
- Results sorted by modification time
- Excludes node_modules and .git
- Respects maxResults limit
- Registered as a built-in tool

---

## Task 13: Grep Tool ✅ COMPLETED

> **Completed:** Created `src/tools/builtin/grep-tool.js` using `fast-glob` to search file contents with regex. Supports binary file skipping, case-insensitive search, maximum results limits, and context lines. Registered in `src/tools/index.js` and added tests in `tests/grep-tool.test.js` which pass correctly.

**Source:** king-louie-enhancement-plan.md Phase 7
**Dependencies:** None
**Files to create:** `src/tools/builtin/grep-tool.js`
**Files to modify:** `src/tools/index.js`

> **Clarifications:**
> - **Depends on fast-glob:** Task 12 installs `fast-glob`. If doing Task 13 before Task 12, install it yourself.
> - **Tool registration:** `toolRegistry.register(GrepTool)` in `src/tools/index.js`.
> - **Test script:** Add `&& node tests/grep-tool.test.js` to `package.json`.

### Instructions

Create a Grep tool for content search with regex support:

```javascript
const Tool = require('../tool-schema');
const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

const grepTool = new Tool({
  name: 'Grep',
  description: 'Search file contents using regex. Returns matching lines with file path and line numbers.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression pattern to search for' },
      path: { type: 'string', description: 'File or directory to search. Defaults to working directory.' },
      glob: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.js", "**/*.ts")' },
      caseSensitive: { type: 'boolean', default: true },
      maxResults: { type: 'number', default: 50 },
      contextLines: { type: 'number', default: 0, description: 'Number of lines of context around matches' }
    },
    required: ['pattern']
  },
  requiresApproval: false,
  execute: async (params, context) => {
    const {
      pattern,
      path: searchPath,
      glob: fileGlob,
      caseSensitive = true,
      maxResults = 50,
      contextLines = 0
    } = params;

    const baseDir = searchPath || context?.workingDirectory || process.cwd();
    const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');

    // If searchPath is a file, search just that file
    // If directory, find files matching glob (default **/*) then search each
    // Return: [{ file, line, lineNumber, context? }]
    // Limit to maxResults total matches
    // Skip binary files (check first 512 bytes for null bytes)
    // Skip node_modules, .git
  }
});

module.exports = grepTool;
```

Register in `src/tools/index.js`.

### Test Cases

**T13.1 — Create `tests/grep-tool.test.js`:**

```javascript
describe('Grep Tool', () => {
  it('finds pattern in files', async () => {
    const result = await grepTool.execute({
      pattern: 'require\\(',
      path: path.join(__dirname, '..', 'src'),
      glob: '**/*.js'
    });
    assert.ok(result.ok);
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches[0].file);
    assert.ok(result.matches[0].lineNumber);
    assert.ok(result.matches[0].line);
  });

  it('supports case-insensitive search', async () => {
    const result = await grepTool.execute({
      pattern: 'MODULE',
      path: path.join(__dirname, '..', 'src'),
      caseSensitive: false
    });
    assert.ok(result.ok);
    // Should find 'module' even though pattern is 'MODULE'
  });

  it('respects maxResults', async () => {
    const result = await grepTool.execute({
      pattern: 'const',
      path: path.join(__dirname, '..'),
      maxResults: 5
    });
    assert.ok(result.matches.length <= 5);
  });

  it('returns context lines when requested', async () => {
    const result = await grepTool.execute({
      pattern: 'module\\.exports',
      path: path.join(__dirname, '..', 'src'),
      contextLines: 2,
      maxResults: 3
    });
    // Verify context is present
  });

  it('searches single file', async () => {
    const result = await grepTool.execute({
      pattern: 'require',
      path: path.join(__dirname, '..', 'package.json')
    });
    assert.ok(result.ok);
  });

  it('skips binary files', async () => {
    // Should not crash or return garbage from binary files
  });

  it('handles invalid regex gracefully', async () => {
    const result = await grepTool.execute({ pattern: '[invalid' });
    assert.ok(!result.ok || result.error);
  });

  it('excludes node_modules and .git', async () => {
    const result = await grepTool.execute({
      pattern: 'the',
      path: path.join(__dirname, '..')
    });
    assert.ok(!result.matches.some(m => m.file.includes('node_modules')));
    assert.ok(!result.matches.some(m => m.file.includes('.git')));
  });
});
```

**T13.2 — `npm test` passes.**

### Acceptance Criteria
- Searches file contents with regex
- Supports case-insensitive search
- Returns file path, line number, matching line
- Context lines supported
- Skips binary files, node_modules, .git
- Registered as a built-in tool

---

## Task 14: Git Tool ✅ COMPLETED

> **Completed:** Created `GitTool` in `src/tools/builtin/git-tool.js` to execute Git commands using `execFileAsync`. Implemented an allowlist for commands and blocked destructive flags (`--force`, `-f`, `--hard`, `--delete`, `-D`). Configured the tool to require approval. Registered in `src/tools/index.js`. Added tests in `tests/git-tool.test.js` and ensured all tests pass correctly.

**Source:** king-louie-enhancement-plan.md Phase 7
**Dependencies:** None
**Files to create:** `src/tools/builtin/git-tool.js`
**Files to modify:** `src/tools/index.js`

> **Clarifications:**
> - **Tool registration:** `toolRegistry.register(GitTool)` in `src/tools/index.js`.
> - **Approval:** `requiresApproval: true` — git write operations (add, commit, push) are destructive. The approval system in `src/execution/tool-executor.js` handles this.
> - **Test script:** Add `&& node tests/git-tool.test.js` to `package.json`.

### Instructions

Create a Git tool that wraps common git operations:

```javascript
const Tool = require('../tool-schema');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ALLOWED_COMMANDS = [
  'status', 'log', 'diff', 'branch', 'show', 'blame', 'stash',
  'add', 'commit', 'checkout', 'merge', 'pull', 'push', 'fetch',
  'tag', 'remote', 'rev-parse', 'ls-files'
];

// Block destructive commands that could cause data loss
const BLOCKED_ARGS = ['--force', '-f', '--hard', '--delete', '-D'];

const gitTool = new Tool({
  name: 'Git',
  description: 'Execute git commands for version control operations',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Git subcommand (e.g., "status", "log", "diff")' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the git command' },
      cwd: { type: 'string', description: 'Working directory. Defaults to project root.' }
    },
    required: ['command']
  },
  requiresApproval: true,  // Git operations should require approval
  execute: async (params, context) => {
    const { command, args = [], cwd } = params;

    if (!ALLOWED_COMMANDS.includes(command)) {
      return { ok: false, error: `Git command "${command}" is not allowed. Allowed: ${ALLOWED_COMMANDS.join(', ')}` };
    }

    // Check for blocked destructive args
    for (const arg of args) {
      if (BLOCKED_ARGS.includes(arg)) {
        return { ok: false, error: `Argument "${arg}" is blocked for safety. Use the Bash tool for destructive operations.` };
      }
    }

    const workDir = cwd || context?.workingDirectory || process.cwd();
    try {
      const { stdout, stderr } = await execFileAsync('git', [command, ...args], {
        cwd: workDir,
        timeout: 30000,
        maxBuffer: 1024 * 1024  // 1MB
      });
      return { ok: true, output: stdout, stderr: stderr || undefined };
    } catch (err) {
      return { ok: false, error: err.message, stderr: err.stderr };
    }
  }
});

module.exports = gitTool;
```

Register in `src/tools/index.js`.

### Test Cases

**T14.1 — Create `tests/git-tool.test.js`:**

```javascript
describe('Git Tool', () => {
  it('runs git status', async () => {
    const result = await gitTool.execute({ command: 'status' });
    assert.ok(result.ok);
    assert.ok(typeof result.output === 'string');
  });

  it('runs git log with args', async () => {
    const result = await gitTool.execute({ command: 'log', args: ['--oneline', '-5'] });
    assert.ok(result.ok);
  });

  it('runs git diff', async () => {
    const result = await gitTool.execute({ command: 'diff' });
    assert.ok(result.ok);
  });

  it('blocks disallowed commands', async () => {
    const result = await gitTool.execute({ command: 'rebase' });
    assert.ok(!result.ok);
    assert.ok(result.error.includes('not allowed'));
  });

  it('blocks --force flag', async () => {
    const result = await gitTool.execute({ command: 'push', args: ['--force'] });
    assert.ok(!result.ok);
    assert.ok(result.error.includes('blocked'));
  });

  it('blocks --hard flag', async () => {
    const result = await gitTool.execute({ command: 'checkout', args: ['--hard'] });
    assert.ok(!result.ok);
    assert.ok(result.error.includes('blocked'));
  });

  it('blocks -D flag', async () => {
    const result = await gitTool.execute({ command: 'branch', args: ['-D', 'some-branch'] });
    assert.ok(!result.ok);
    assert.ok(result.error.includes('blocked'));
  });

  it('handles non-git directory gracefully', async () => {
    const result = await gitTool.execute({ command: 'status', cwd: '/tmp' });
    // Should return error about not being a git repo
    assert.ok(!result.ok || result.stderr);
  });

  it('requires approval', () => {
    assert.strictEqual(gitTool.requiresApproval, true);
  });
});
```

**T14.2 — `npm test` passes.**

### Acceptance Criteria
- Common git operations work (status, log, diff, add, commit, etc.)
- Destructive flags (--force, --hard, -D) blocked
- Unrecognized subcommands blocked
- Requires tool approval
- Error messages are descriptive

---

## Task 15: AskUser Tool ✅ COMPLETED

> **Completed:** Implemented `AskUserTool` to pause the agent loop and prompt the user for input. Created `src/tools/builtin/ask-user-tool.js` (no execution logic inside, `requiresApproval` set to false). Modified `src/execution/agent-loop.js` to intercept AskUser, set a 5-minute timeout, and route via IPC to the renderer. Added IPC events `agent:askUser` and `agent:userResponse` to `src/ipc/constants.js`, updated `agent-handlers.js` to resolve pending requests, updated `preload.js` to expose these events, and modified `renderer.js` to render the prompt UI modal and return the user's response. Added and passed tests in `tests/ask-user-tool.test.js`.

**Source:** king-louie-enhancement-plan.md Phase 7
**Dependencies:** None
**Files to create:** `src/tools/builtin/ask-user-tool.js`
**Files to modify:** `src/tools/index.js`, `preload.js`, `renderer.js`

> **Clarifications:**
> - **Special tool:** Unlike other tools, AskUser pauses the agent loop and waits for user input. The execution flow is: tool-executor emits event → main process sends IPC to renderer → renderer shows prompt → user responds → IPC back to main → tool resolves.
> - **IPC channels:** Add `agent:askUser` and `agent:userResponse` to `src/ipc/constants.js`. Add corresponding handlers in `src/ipc/agent-handlers.js`.
> - **Preload validation:** Add validation for `agent:userResponse` in `preload.js` — validate `requestId` is string, `response` is string.
> - **Tool registration:** `toolRegistry.register(AskUserTool)` in `src/tools/index.js`.
> - **Test script:** Add `&& node tests/ask-user-tool.test.js` to `package.json`.

### Instructions

Create an AskUser tool that allows the agent to ask the user a question and wait for their response:

```javascript
const Tool = require('../tool-schema');

const askUserTool = new Tool({
  name: 'AskUser',
  description: 'Ask the user a question and wait for their response. Use when you need clarification or input.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' }
    },
    required: ['question']
  },
  requiresApproval: false,
  // This tool works differently — it emits the question to the UI and waits for a response
  // The execution is handled specially in the agent loop
});
```

The AskUser tool requires special handling in the agent loop (`src/execution/agent-loop.js`). When the agent calls AskUser:
1. The question is sent to the renderer as a message
2. The agent loop pauses waiting for user input
3. When the user responds, the response is fed back as the tool result
4. The agent loop continues

This requires an IPC event pattern:
- Main → Renderer: `agent:askUser` with `{ requestId, question }`
- Renderer → Main: `agent:userResponse` with `{ requestId, response }`

### Test Cases

**T15.1 — Create `tests/ask-user-tool.test.js`:**

```javascript
describe('AskUser Tool', () => {
  it('has correct schema', () => {
    assert.strictEqual(askUserTool.name, 'AskUser');
    assert.ok(askUserTool.parameters.properties.question);
    assert.ok(askUserTool.parameters.required.includes('question'));
  });

  it('does not require approval', () => {
    assert.strictEqual(askUserTool.requiresApproval, false);
  });

  it('rejects empty question', async () => {
    // Validate that empty question is rejected
  });

  it('resolves when user responds', async () => {
    // Mock the IPC event pattern
    // Verify the tool returns the user's response
  });

  it('times out after configurable period', async () => {
    // Verify timeout behavior (e.g., 5 minutes default)
  });
});
```

**T15.2 — `npm test` passes.**

### Acceptance Criteria
- Agent can ask user a question mid-execution
- User sees the question in the chat UI
- User's response is returned as the tool result
- Agent loop pauses/resumes correctly
- Timeout after 5 minutes if no response

---

## Task 16: Usage Tracking & Cost Display ✅ COMPLETED

> **Completed:** Added `src/tracking/pricing-tables.js` and `src/tracking/usage-tracker.js` with session + daily usage aggregation, provider breakdowns, and pricing-based cost estimation (with explicit `costUsd` fallback). Integrated usage capture into both tool-loop (`src/execution/agent-loop.js`) and streaming chat path (`src/ipc/chat-handlers.js`), wired tracker lifecycle in `main.js`, added usage IPC surface (`src/ipc/usage-handlers.js`, `src/ipc/constants.js`, `src/ipc/register.js`, `preload.js`), updated assistant message token/cost display in `renderer.js`, and added comprehensive coverage in `tests/usage-tracker.test.js`. Also wired test script inclusion in `package.json` and verified Task 16 tests pass via `node --test tests/usage-tracker.test.js`.

**Source:** openclaw.md §13
**Dependencies:** None
**Files to create:** `src/tracking/usage-tracker.js`, `src/tracking/pricing-tables.js`
**Files to modify:** `src/execution/agent-loop.js`, `renderer.js`

> **Clarifications:**
> - **Agent loop integration:** `src/execution/agent-loop.js` is where LLM responses come back. After each response, call `usageTracker.record()` with the provider, model, and token counts from the response.
> - **IPC for UI:** Add `usage:getSession` and `usage:getDaily` handlers to a new `src/ipc/usage-handlers.js` (follow `wrapHandler` pattern from existing IPC modules). Register in `src/ipc/register.js`.
> - **Renderer display:** Add a small token/cost badge below each assistant message in `renderer.js`. Keep it subtle — e.g., `"142 tokens · $0.002"`.
> - **Test script:** Add `&& node tests/usage-tracker.test.js` to `package.json`.

### Instructions

**Step 1:** Create `src/tracking/pricing-tables.js`:

```javascript
// Per-provider, per-model pricing ($ per million tokens)
const PRICING = {
  openai: {
    'gpt-4o': { input: 2.50, output: 10.00, cacheRead: 1.25 },
    'gpt-4o-mini': { input: 0.15, output: 0.60, cacheRead: 0.075 },
    'gpt-4.1': { input: 2.00, output: 8.00 },
  },
  anthropic: {
    'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30 },
    'claude-3-5-sonnet-latest': { input: 3.00, output: 15.00, cacheRead: 0.30 },
    'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, cacheRead: 0.08 },
  },
  groq: {
    'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
    'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  },
  mistral: {
    'mistral-large-latest': { input: 2.00, output: 6.00 },
    'mistral-small-latest': { input: 0.20, output: 0.60 },
    'codestral-latest': { input: 0.30, output: 0.90 },
  },
  gemini: {
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
    'gemini-2.0-pro': { input: 1.25, output: 5.00 },
  }
};

function getCost(provider, model, inputTokens, outputTokens, cacheReadTokens = 0) {
  const pricing = PRICING[provider]?.[model];
  if (!pricing) return null;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheCost = pricing.cacheRead ? (cacheReadTokens / 1_000_000) * pricing.cacheRead : 0;
  return inputCost + outputCost + cacheCost;
}

module.exports = { PRICING, getCost };
```

**Step 2:** Create `src/tracking/usage-tracker.js`:

```javascript
class UsageTracker {
  constructor(store) {
    this.store = store;  // electron-store instance
    this.sessionUsage = { inputTokens: 0, outputTokens: 0, totalCost: 0, turns: 0 };
  }

  record(event) {
    // event: { provider, model, inputTokens, outputTokens, cacheReadTokens, durationMs }
    const cost = getCost(event.provider, event.model, event.inputTokens, event.outputTokens, event.cacheReadTokens);
    this.sessionUsage.inputTokens += event.inputTokens;
    this.sessionUsage.outputTokens += event.outputTokens;
    this.sessionUsage.totalCost += cost || 0;
    this.sessionUsage.turns++;

    // Persist daily aggregation
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = `usage.daily.${today}`;
    const daily = this.store.get(dailyKey, { inputTokens: 0, outputTokens: 0, totalCost: 0, turns: 0 });
    daily.inputTokens += event.inputTokens;
    daily.outputTokens += event.outputTokens;
    daily.totalCost += cost || 0;
    daily.turns++;
    this.store.set(dailyKey, daily);

    return { cost, inputTokens: event.inputTokens, outputTokens: event.outputTokens };
  }

  getSessionUsage() { return { ...this.sessionUsage }; }
  getDailyUsage(date) { return this.store.get(`usage.daily.${date}`, null); }
  reset() { this.sessionUsage = { inputTokens: 0, outputTokens: 0, totalCost: 0, turns: 0 }; }
}

module.exports = UsageTracker;
```

**Step 3:** Integrate into `agent-loop.js` — after each LLM response, call `usageTracker.record()`.

**Step 4:** Add IPC handlers for usage data retrieval.

**Step 5:** Display usage in renderer — add a footer below each agent response showing token usage and cost.

### Test Cases

**T16.1 — Create `tests/usage-tracker.test.js`:**

```javascript
describe('UsageTracker', () => {
  let tracker, mockStore;

  beforeEach(() => {
    mockStore = { data: {}, get(k, d) { return this.data[k] || d; }, set(k, v) { this.data[k] = v; } };
    tracker = new UsageTracker(mockStore);
  });

  it('records usage and calculates cost', () => {
    const result = tracker.record({
      provider: 'openai', model: 'gpt-4o-mini',
      inputTokens: 1000, outputTokens: 500
    });
    assert.ok(result.cost > 0);
    assert.strictEqual(result.inputTokens, 1000);
  });

  it('accumulates session usage', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 2000, outputTokens: 1000 });
    const session = tracker.getSessionUsage();
    assert.strictEqual(session.inputTokens, 3000);
    assert.strictEqual(session.outputTokens, 1500);
    assert.strictEqual(session.turns, 2);
  });

  it('persists daily usage', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    const today = new Date().toISOString().slice(0, 10);
    const daily = tracker.getDailyUsage(today);
    assert.ok(daily);
    assert.strictEqual(daily.inputTokens, 1000);
  });

  it('returns null cost for unknown model', () => {
    const result = tracker.record({
      provider: 'unknown', model: 'unknown-model',
      inputTokens: 1000, outputTokens: 500
    });
    assert.strictEqual(result.cost, null);
  });

  it('resets session usage', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    tracker.reset();
    const session = tracker.getSessionUsage();
    assert.strictEqual(session.inputTokens, 0);
    assert.strictEqual(session.turns, 0);
  });
});

describe('PricingTables', () => {
  it('calculates correct cost for gpt-4o-mini', () => {
    const cost = getCost('openai', 'gpt-4o-mini', 1_000_000, 1_000_000);
    assert.strictEqual(cost, 0.15 + 0.60);  // $0.75 per million in + out
  });

  it('includes cache read cost when applicable', () => {
    const costWithCache = getCost('anthropic', 'claude-3-5-sonnet-latest', 1000, 500, 2000);
    const costWithoutCache = getCost('anthropic', 'claude-3-5-sonnet-latest', 1000, 500, 0);
    assert.ok(costWithCache > costWithoutCache);
  });

  it('returns null for unknown provider/model', () => {
    const cost = getCost('nonexistent', 'model', 1000, 500);
    assert.strictEqual(cost, null);
  });
});
```

**T16.2 — `npm test` passes.**

### Acceptance Criteria
- Token usage tracked per response
- Cost estimated from pricing tables
- Session and daily aggregations
- Per-provider breakdown available
- Pricing tables updatable

---

## Task 17: Channel Plugin Interface Refactor ✅ COMPLETED

> **What's done:** `ChannelPlugin` base class exists in `src/channels/channel-plugin.js` with `normalizeTarget()` and required method stubs. `telegram-bridge.js` and `telegram-adapter.js` exist.
> **What's remaining:** `ChannelRegistry` class (Steps 3, 6), standardized inbound message format (Step 4), refactoring telegram-bridge to use full interface (Step 5), wiring into `main.js`.

**Source:** openclaw.md §3.1
**Dependencies:** None
**Files to modify:** `src/channels/channel-plugin.js`, `src/channels/telegram-bridge.js`

### Instructions

**Step 1:** Read `src/channels/channel-plugin.js` and `src/channels/telegram-bridge.js` to understand the current interface.

**Step 2:** Expand the `ChannelPlugin` base class:

```javascript
class ChannelPlugin {
  constructor(config) {
    this.id = config.id;
    this.label = config.label;
    this.capabilities = config.capabilities || ['send', 'receive'];
  }

  // Required methods
  async initialize(gateway) { throw new Error('Not implemented'); }
  async shutdown() { throw new Error('Not implemented'); }
  normalizeTarget(rawTarget) { throw new Error('Not implemented'); }
  async send(target, message, options) { throw new Error('Not implemented'); }

  // Optional methods
  async onMessage(handler) {}
  async listTargets() { return []; }
  getStatus() { return { connected: false }; }

  // Group features (optional)
  supportsGroups() { return false; }
  async listGroups() { return []; }
  getMentionPattern() { return null; }
}
```

**Step 3:** Create a `ChannelRegistry` class (in a new file or in channel-plugin.js):

```javascript
class ChannelRegistry {
  constructor() { this.channels = new Map(); }

  register(channelPlugin) {
    this.channels.set(channelPlugin.id, channelPlugin);
  }

  get(id) { return this.channels.get(id); }
  list() { return Array.from(this.channels.values()); }

  async initializeAll(gateway) {
    for (const channel of this.channels.values()) {
      try { await channel.initialize(gateway); }
      catch (err) { console.error(`[channel:${channel.id}] init failed:`, err.message); }
    }
  }

  async shutdownAll() {
    for (const channel of this.channels.values()) {
      try { await channel.shutdown(); }
      catch (err) { console.error(`[channel:${channel.id}] shutdown failed:`, err.message); }
    }
  }
}
```

**Step 4:** Add a standardized inbound message format:

```javascript
// All channels normalize inbound messages to this shape
{
  channel: 'telegram',           // channel ID
  sender: { id: '123', name: 'User', isGroup: false },
  group: null,                    // { id, name } for group messages
  text: 'Hello bot',
  mentions: [],
  attachments: [],
  threadId: null,
  raw: {}                         // Original platform message
}
```

**Step 5:** Refactor `telegram-bridge.js` to extend the new `ChannelPlugin` interface, implementing all required methods. Don't break existing functionality.

**Step 6:** Wire `ChannelRegistry` into `main.js` — register the Telegram adapter and use `initializeAll()` / `shutdownAll()`.

### Test Cases

**T17.1 — Create `tests/channel-plugin.test.js`:**

```javascript
describe('ChannelPlugin base class', () => {
  it('stores id, label, capabilities', () => {
    const plugin = new ChannelPlugin({ id: 'test', label: 'Test', capabilities: ['send'] });
    assert.strictEqual(plugin.id, 'test');
    assert.strictEqual(plugin.label, 'Test');
    assert.deepStrictEqual(plugin.capabilities, ['send']);
  });

  it('throws on unimplemented required methods', async () => {
    const plugin = new ChannelPlugin({ id: 'test', label: 'Test' });
    await assert.rejects(() => plugin.initialize({}));
    await assert.rejects(() => plugin.shutdown());
    assert.throws(() => plugin.normalizeTarget('x'));
    await assert.rejects(() => plugin.send('x', 'msg'));
  });

  it('has default implementations for optional methods', async () => {
    const plugin = new ChannelPlugin({ id: 'test', label: 'Test' });
    const targets = await plugin.listTargets();
    assert.deepStrictEqual(targets, []);
    assert.strictEqual(plugin.supportsGroups(), false);
    assert.strictEqual(plugin.getMentionPattern(), null);
  });
});

describe('ChannelRegistry', () => {
  it('registers and retrieves channels', () => {
    const registry = new ChannelRegistry();
    const plugin = new ChannelPlugin({ id: 'test', label: 'Test' });
    registry.register(plugin);
    assert.strictEqual(registry.get('test'), plugin);
  });

  it('lists all registered channels', () => {
    const registry = new ChannelRegistry();
    registry.register(new ChannelPlugin({ id: 'a', label: 'A' }));
    registry.register(new ChannelPlugin({ id: 'b', label: 'B' }));
    assert.strictEqual(registry.list().length, 2);
  });

  it('initializeAll handles individual failures gracefully', async () => {
    const registry = new ChannelRegistry();
    let initialized = false;
    class GoodPlugin extends ChannelPlugin {
      async initialize() { initialized = true; }
      async shutdown() {}
      normalizeTarget(t) { return t; }
      async send() {}
    }
    class BadPlugin extends ChannelPlugin {
      async initialize() { throw new Error('fail'); }
      async shutdown() {}
      normalizeTarget(t) { return t; }
      async send() {}
    }
    registry.register(new BadPlugin({ id: 'bad', label: 'Bad' }));
    registry.register(new GoodPlugin({ id: 'good', label: 'Good' }));
    await registry.initializeAll({});
    assert.ok(initialized, 'Good plugin should still initialize even if bad one fails');
  });
});
```

**T17.2 — `npm test` passes.**

**T17.3 — Manual smoke test:** Telegram bridge still works after refactor.

### Acceptance Criteria
- Base interface defined with required/optional methods
- ChannelRegistry supports dynamic registration
- Telegram adapter refactored to new interface
- Inbound messages normalized to common format
- No Telegram regressions

---

## Task 18: Cron / Scheduling System ✅ COMPLETED

> **Completed:** Created `CronStore` for JSON file persistence (`{userData}/cron/jobs.json`) and `CronScheduler` supporting `at`, `every`, and `cron` intervals using `cron-parser`. Built `CronExecutor` to run agents in isolated sessions and optionally output to channels. Created `CronTool` and registered it for agent access. Handlers exposed via IPC and settings UI added in `renderer.js`. Test coverage included and passing in `tests/cron-store.test.js` and `tests/cron-scheduler.test.js`.


**Source:** openclaw.md §4.1, §4.2, §4.3
**Dependencies:** Task 17 (channel registry for delivery)
**Files to create:** `src/cron/cron-scheduler.js`, `src/cron/cron-store.js`, `src/cron/cron-executor.js`, `src/tools/builtin/cron-tool.js`
**Files to modify:** `main.js`, `preload.js`, `renderer.js`, `index.html`, `styles.css`
**npm install:** `cron-parser`

### Instructions

**Step 1:** ✅ COMPLETED Create `src/cron/cron-store.js` — file-based persistence for cron jobs:
- Storage file: `{userData}/cron/jobs.json`
- Atomic writes (write to temp file, rename)
- CRUD methods: `list()`, `get(id)`, `add(job)`, `update(id, patch)`, `remove(id)`
- Load on startup

**Step 2:** ✅ COMPLETED Create `src/cron/cron-executor.js`:
- Accepts `agentExecutor`, `sessionManager`, `gateway` as dependencies
- `execute(job)` method:
  1. Creates or reuses a session based on `job.payload.sessionTarget`
  2. Runs an agent turn with `job.payload.message`
  3. Captures the result
  4. Delivers to configured channel if `job.delivery` specified
  5. Updates `job.state` with last run info

**Step 3:** ✅ COMPLETED Create `src/cron/cron-scheduler.js`:
- Runs a tick loop every 30 seconds (configurable)
- On each tick: check all enabled jobs, execute any that are due
- Calculate next run time from schedule (`at`, `every`, `cron` kinds)
- Max concurrent jobs limit
- Job timeout support
- `start()`, `stop()`, `addJob()`, `updateJob()`, `removeJob()`, `runNow(id)`, `listJobs()`

**Step 4:** Create `src/tools/builtin/cron-tool.js` — agent-facing tool:
- Actions: `list`, `add`, `update`, `remove`, `run`, `status`
- Requires approval for job creation
- Register in `src/tools/index.js`

**Step 5:** Add IPC handlers (in a new `src/ipc/cron-handlers.js`):
- `cron:list`, `cron:add`, `cron:update`, `cron:remove`, `cron:run`, `cron:status`
- Register with `wrapHandler`

**Step 6:** Wire into `main.js`:
- Initialize `CronStore` and `CronScheduler` in `initializeAgentInfrastructure()`
- Start scheduler after agent infrastructure is ready
- Stop scheduler on app quit

**Step 7:** Add basic UI in settings drawer for managing cron jobs (list, create, enable/disable, delete, run now).

### Test Cases

**T18.1 — Create `tests/cron-store.test.js`:**

```javascript
describe('CronStore', () => {
  let store, tempFile;

  beforeEach(() => {
    tempFile = path.join(os.tmpdir(), `cron-test-${Date.now()}.json`);
    store = new CronStore(tempFile);
  });

  afterEach(() => { try { fs.unlinkSync(tempFile); } catch {} });

  it('loads from empty/missing file', async () => {
    await store.load();
    assert.deepStrictEqual(store.list(), []);
  });

  it('adds and retrieves a job', async () => {
    await store.load();
    const job = await store.add({
      schedule: { kind: 'every', everyMs: 60000 },
      payload: { kind: 'agentTurn', message: 'test' }
    });
    assert.ok(job.id);
    assert.strictEqual(store.get(job.id).payload.message, 'test');
  });

  it('persists to disk', async () => {
    await store.load();
    await store.add({ schedule: { kind: 'every', everyMs: 60000 }, payload: { message: 'test' } });

    // Load fresh instance from same file
    const store2 = new CronStore(tempFile);
    await store2.load();
    assert.strictEqual(store2.list().length, 1);
  });

  it('updates a job', async () => {
    await store.load();
    const job = await store.add({ schedule: { kind: 'every', everyMs: 60000 }, payload: { message: 'old' } });
    await store.update(job.id, { enabled: false });
    assert.strictEqual(store.get(job.id).enabled, false);
  });

  it('removes a job', async () => {
    await store.load();
    const job = await store.add({ schedule: { kind: 'every', everyMs: 60000 }, payload: { message: 'test' } });
    await store.remove(job.id);
    assert.strictEqual(store.get(job.id), undefined);
  });
});
```

**T18.2 — Create `tests/cron-scheduler.test.js`:**

```javascript
describe('CronScheduler', () => {
  it('calculates next run for interval schedule', () => {
    const scheduler = new CronScheduler(mockStore, mockExecutor);
    const job = { schedule: { kind: 'every', everyMs: 60000 }, state: { lastRunAtMs: Date.now() - 60001 } };
    assert.ok(scheduler.isDue(job));
  });

  it('calculates next run for cron expression', () => {
    const scheduler = new CronScheduler(mockStore, mockExecutor);
    const nextRun = scheduler.getNextRun({
      schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' }
    });
    assert.ok(nextRun > Date.now());
  });

  it('calculates next run for one-shot schedule', () => {
    const futureTime = new Date(Date.now() + 3600000).toISOString();
    const scheduler = new CronScheduler(mockStore, mockExecutor);
    const job = { schedule: { kind: 'at', at: futureTime } };
    assert.ok(!scheduler.isDue(job));
  });

  it('executes due jobs on tick', async () => {
    let executed = false;
    const executor = { execute: async () => { executed = true; } };
    const scheduler = new CronScheduler(mockStore, executor);
    // Add a due job and tick
    await scheduler.tick();
    // Verify execution
  });

  it('respects maxConcurrentJobs', async () => {
    // Add 5 due jobs with maxConcurrent=2
    // Verify only 2 execute per tick
  });

  it('tracks consecutive errors', async () => {
    // Mock executor to throw, verify job.state.consecutiveErrors increments
  });

  it('runNow executes immediately regardless of schedule', async () => {
    let executed = false;
    const executor = { execute: async () => { executed = true; return { ok: true }; } };
    // Verify runNow triggers execution
  });
});
```

**T18.3 — `npm test` passes (add all new test files to npm test script).**

### Acceptance Criteria
- One-shot, interval, and cron expression schedules work
- Jobs persist across app restarts
- Jobs execute in main or isolated sessions
- Results can be delivered to any registered channel
- Consecutive error tracking
- CRUD via IPC + basic UI
- Cron tool available to agents

---

## Task 19: Discord Channel ✅ COMPLETED

> **Completed:** Created `DiscordChannel` extending `ChannelPlugin` inside `src/channels/discord-bridge.js`. Added `splitMessage` logic handling the 2000 character limits, formatters in `src/channels/discord-adapter.js`. The channel accepts DMs and Guild channel messages, correctly generates separate session keys for group channels and DMs, routes messages through the `mention-gating.js` rule set, handles slash commands, implements pinned skills, routes remaining questions to the gateway, and responds to Interaction callback queries for Tool Approvals. Modified `main.js` to start/stop the bridge and integrated Discord configurations in settings. Added robust test cases in `tests/discord-channel.test.js` covering `normalizeTarget`, `buildSessionKey`, mention regex pattern, and Discord limits/split operations. All tests passed perfectly.

**Source:** openclaw.md §3.2
**Dependencies:** Task 17 completed (needs `ChannelRegistry` from Step 3, normalized message format from Step 4)
**Files to create:** `src/channels/discord-adapter.js`, `src/channels/discord-bridge.js`
**npm install:** `discord.js`

### Instructions

Implement Discord channel following the `ChannelPlugin` interface from Task 17.

Key requirements:
- Connect via Bot token
- Handle `messageCreate` events → normalize → route to session manager
- Session key: `agent:main:discord:{userId}` (DMs) or `agent:main:discord:group:{guildId}:{channelId}`
- Message splitting for >2000 chars
- Mention detection for group channels
- Slash command registration (`/ask`, `/status`, `/reset`)
- Pin support (following telegram-bridge pattern)
- Settings: `discord.enabled`, `discord.botToken` (encrypted), `discord.requireMention`, `discord.allowedGuilds`, `discord.allowedChannels`

### Test Cases

**T19.1 — Create `tests/discord-channel.test.js`:**

```javascript
describe('DiscordChannel', () => {
  it('extends ChannelPlugin', () => {
    const channel = new DiscordChannel(config);
    assert.ok(channel instanceof ChannelPlugin);
    assert.strictEqual(channel.id, 'discord');
  });

  it('normalizes DM target', () => {
    const channel = new DiscordChannel(config);
    const target = channel.normalizeTarget({ userId: '123' });
    assert.ok(target);
  });

  it('builds correct session key for DMs', () => {
    const key = DiscordChannel.buildSessionKey('123', null);
    assert.strictEqual(key, 'agent:main:discord:123');
  });

  it('builds correct session key for guild channels', () => {
    const key = DiscordChannel.buildSessionKey('123', { guildId: 'g1', channelId: 'c1' });
    assert.ok(key.includes('group'));
    assert.ok(key.includes('g1'));
  });

  it('splits long messages at 2000-char boundary', () => {
    const channel = new DiscordChannel(config);
    const longMsg = 'x'.repeat(5000);
    const parts = channel.splitMessage(longMsg);
    assert.ok(parts.length >= 3);
    parts.forEach(p => assert.ok(p.length <= 2000));
  });

  it('supportsGroups returns true', () => {
    const channel = new DiscordChannel(config);
    assert.ok(channel.supportsGroups());
  });

  it('getMentionPattern returns regex', () => {
    const channel = new DiscordChannel(config);
    const pattern = channel.getMentionPattern();
    assert.ok(pattern instanceof RegExp || pattern === null);
  });

  it('respects requireMention setting in groups', () => {
    // Test that group messages without mention are ignored when requireMention=true
  });

  it('always responds to DMs', () => {
    // Test that DMs are always processed regardless of requireMention
  });
});
```

**T19.2 — `npm test` passes.**

### Acceptance Criteria
- Bot connects and receives DMs
- Bot responds in guild channels when mentioned
- Long messages split at 2000-char boundaries
- Session management works
- Settings UI for token + allowlists

---

## Task 20: Slack Channel ✅ COMPLETED

> **Completed:** Slack Channel (`src/channels/slack-bridge.js`) via Socket Mode using `@slack/bolt`. Implemented mention gating in channels, Block Kit formatting for code blocks, and DMs/thread replies. `SlackChannel` is integrated into `main.js` which handles the API app token (`xapp-`) and bot token (`xoxb-`), with settings logic mirroring the Telegram bridge. Added full test coverage in `tests/slack-channel.test.js`, running as part of the `npm test` script. All tests pass correctly.

**Source:** openclaw.md §3.3
**Dependencies:** Task 17 completed (needs `ChannelRegistry`, normalized message format)
**Files to create:** `src/channels/slack-adapter.js`, `src/channels/slack-bridge.js`
**npm install:** `@slack/bolt`

### Instructions

Implement Slack channel following `ChannelPlugin` interface.

Key requirements:
- Socket Mode connection (no public URL needed)
- Handle `message` and `app_mention` events
- Session key: `agent:main:slack:{userId}` (DMs) or `agent:main:slack:group:{channelId}`
- Reply in thread when message is in a thread
- Block Kit for rich formatting
- Settings: `slack.enabled`, `slack.appToken`, `slack.botToken` (both encrypted), `slack.requireMention`, `slack.allowedChannels`

### Test Cases

**T20.1 — Create `tests/slack-channel.test.js`:**

```javascript
describe('SlackChannel', () => {
  it('extends ChannelPlugin', () => {
    const channel = new SlackChannel(config);
    assert.strictEqual(channel.id, 'slack');
  });

  it('builds correct session key for DMs', () => {
    const key = SlackChannel.buildSessionKey('U123', null);
    assert.strictEqual(key, 'agent:main:slack:U123');
  });

  it('builds correct session key for channels', () => {
    const key = SlackChannel.buildSessionKey('U123', { channelId: 'C456' });
    assert.ok(key.includes('group'));
  });

  it('detects mention in message text', () => {
    const channel = new SlackChannel({ ...config, botUserId: 'U_BOT' });
    assert.ok(channel.hasMention('<@U_BOT> hello'));
    assert.ok(!channel.hasMention('hello'));
  });

  it('formats code blocks with Block Kit', () => {
    const channel = new SlackChannel(config);
    const blocks = channel.formatResponse('Here is code:\n```js\nconsole.log("hi")\n```');
    assert.ok(Array.isArray(blocks));
  });

  it('respects requireMention in channels', () => {
    // Test mention gating logic
  });

  it('handles thread replies', () => {
    // Test that reply_in_thread flag is set when incoming message has thread_ts
  });
});
```

**T20.2 — `npm test` passes.**

### Acceptance Criteria
- Bot connects via Socket Mode
- DM and channel support
- Mention-based activation in channels
- Thread replies work
- Messages formatted with Block Kit

---

## Task 21: Group Chat & Mention Gating ✅ COMPLETED

**Source:** openclaw.md §10.1
**Dependencies:** Tasks 17, 19, 20 (needs channel adapters to exist)
**Files to create:** `src/channels/mention-gating.js`, `src/channels/allowlist-manager.js`
**Files to modify:** Channel adapters

### Instructions

**Step 1:** Create `src/channels/mention-gating.js`:

```javascript
function shouldRespond({ isGroup, requireMention, wasMentioned, isCommand, isReply }) {
  if (!isGroup) return true;
  if (isCommand) return true;
  if (isReply) return true;
  if (requireMention && !wasMentioned) return false;
  return true;
}
module.exports = { shouldRespond };
```

**Step 2:** Create `src/channels/allowlist-manager.js`:

```javascript
class AllowlistManager {
  constructor(store) { this.store = store; }
  isAllowed(channel, senderId, groupId) { /* check policy */ }
  addUser(channel, userId) { /* add to allowlist */ }
  removeUser(channel, userId) { /* remove from allowlist */ }
  addGroup(channel, groupId) { /* add group */ }
  removeGroup(channel, groupId) { /* remove group */ }
  getPolicy(channel) { /* return { default, users, groups } */ }
  setPolicy(channel, policy) { /* persist policy */ }
}
module.exports = AllowlistManager;
```

**Step 3:** Integrate into all channel adapters — call `shouldRespond()` before processing inbound messages.

### Test Cases

**T21.1 — Create `tests/mention-gating.test.js`:**

```javascript
describe('shouldRespond', () => {
  it('always responds to DMs', () => {
    assert.ok(shouldRespond({ isGroup: false, requireMention: true, wasMentioned: false, isCommand: false, isReply: false }));
  });

  it('always responds to commands in groups', () => {
    assert.ok(shouldRespond({ isGroup: true, requireMention: true, wasMentioned: false, isCommand: true, isReply: false }));
  });

  it('always responds to replies in groups', () => {
    assert.ok(shouldRespond({ isGroup: true, requireMention: true, wasMentioned: false, isCommand: false, isReply: true }));
  });

  it('responds when mentioned in group', () => {
    assert.ok(shouldRespond({ isGroup: true, requireMention: true, wasMentioned: true, isCommand: false, isReply: false }));
  });

  it('skips non-mentioned messages in group when required', () => {
    assert.ok(!shouldRespond({ isGroup: true, requireMention: true, wasMentioned: false, isCommand: false, isReply: false }));
  });

  it('responds to all group messages when mention not required', () => {
    assert.ok(shouldRespond({ isGroup: true, requireMention: false, wasMentioned: false, isCommand: false, isReply: false }));
  });
});

describe('AllowlistManager', () => {
  it('allows all by default (default: allow)', () => {
    const mgr = new AllowlistManager(mockStore);
    assert.ok(mgr.isAllowed('telegram', 'any-user', null));
  });

  it('blocks when default is deny and user not in allowlist', () => {
    const mgr = new AllowlistManager(mockStore);
    mgr.setPolicy('telegram', { default: 'deny', users: ['allowed-user'], groups: [] });
    assert.ok(!mgr.isAllowed('telegram', 'blocked-user', null));
    assert.ok(mgr.isAllowed('telegram', 'allowed-user', null));
  });

  it('add and remove user from allowlist', () => {
    const mgr = new AllowlistManager(mockStore);
    mgr.setPolicy('telegram', { default: 'deny', users: [], groups: [] });
    mgr.addUser('telegram', 'user1');
    assert.ok(mgr.isAllowed('telegram', 'user1', null));
    mgr.removeUser('telegram', 'user1');
    assert.ok(!mgr.isAllowed('telegram', 'user1', null));
  });

  it('persists policies', () => {
    const mgr = new AllowlistManager(mockStore);
    mgr.setPolicy('discord', { default: 'deny', users: ['u1'], groups: ['g1'] });
    const policy = mgr.getPolicy('discord');
    assert.strictEqual(policy.default, 'deny');
    assert.ok(policy.users.includes('u1'));
  });
});
```

**T21.2 — `npm test` passes.**

### Acceptance Criteria
- Bot only responds when mentioned in group chats (when configured)
- Slash commands bypass mention requirement
- Allowlist/denylist per channel
- Works across all channel implementations

---

## Task 22: Media Handling — Image Input

**Source:** openclaw.md §6.1
**Dependencies:** Providers that support vision (OpenAI gpt-4o, Anthropic Claude, Gemini)
**Files to create:** `src/media/image-handler.js`
**Files to modify:** `src/execution/agent-loop.js`, `src/providers/openai-provider.js`, `src/providers/anthropic-provider.js`, `renderer.js`

### Instructions

**Step 1:** Create `src/media/image-handler.js`:

```javascript
class ImageHandler {
  static SUPPORTED_FORMATS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  static MAX_SIZE_BYTES = 5 * 1024 * 1024;  // 5MB
  static MAX_IMAGES_PER_MESSAGE = 5;

  static async processImage(input) {
    // input: { type: 'file', path } | { type: 'base64', data, mimeType } | { type: 'url', url }
    // Returns: { base64: string, mimeType: string, width?: number, height?: number }
  }

  static formatForProvider(provider, imageData) {
    if (provider === 'openai') {
      return { type: 'image_url', image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } };
    }
    if (provider === 'anthropic') {
      return { type: 'image', source: { type: 'base64', media_type: imageData.mimeType, data: imageData.base64 } };
    }
    if (provider === 'gemini') {
      return { inlineData: { mimeType: imageData.mimeType, data: imageData.base64 } };
    }
    throw new Error(`Provider ${provider} does not support images`);
  }

  static validateImage(buffer, mimeType) {
    if (!this.SUPPORTED_FORMATS.includes(mimeType)) {
      throw new Error(`Unsupported image format: ${mimeType}. Supported: ${this.SUPPORTED_FORMATS.join(', ')}`);
    }
    if (buffer.length > this.MAX_SIZE_BYTES) {
      throw new Error(`Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Max: 5MB`);
    }
  }
}
```

**Step 2:** Update provider message formatting to support multi-modal content blocks (array of text + image parts).

**Step 3:** Add image paste/drop/attach support in `renderer.js`:
- Listen for `paste` event on the input area
- Listen for `drop` event for drag-and-drop
- Add a file picker button (paper clip icon)
- Display image thumbnails in the input area before sending
- Send images as part of the message payload

### Test Cases

**T22.1 — Create `tests/image-handler.test.js`:**

```javascript
describe('ImageHandler', () => {
  it('validates supported formats', () => {
    assert.doesNotThrow(() => ImageHandler.validateImage(Buffer.alloc(100), 'image/png'));
    assert.doesNotThrow(() => ImageHandler.validateImage(Buffer.alloc(100), 'image/jpeg'));
    assert.throws(() => ImageHandler.validateImage(Buffer.alloc(100), 'image/bmp'), /Unsupported/);
    assert.throws(() => ImageHandler.validateImage(Buffer.alloc(100), 'application/pdf'), /Unsupported/);
  });

  it('rejects oversized images', () => {
    const bigBuffer = Buffer.alloc(6 * 1024 * 1024);  // 6MB
    assert.throws(() => ImageHandler.validateImage(bigBuffer, 'image/png'), /too large/);
  });

  it('formats for OpenAI', () => {
    const formatted = ImageHandler.formatForProvider('openai', { base64: 'abc123', mimeType: 'image/png' });
    assert.strictEqual(formatted.type, 'image_url');
    assert.ok(formatted.image_url.url.startsWith('data:image/png;base64,'));
  });

  it('formats for Anthropic', () => {
    const formatted = ImageHandler.formatForProvider('anthropic', { base64: 'abc123', mimeType: 'image/jpeg' });
    assert.strictEqual(formatted.type, 'image');
    assert.strictEqual(formatted.source.type, 'base64');
    assert.strictEqual(formatted.source.media_type, 'image/jpeg');
  });

  it('formats for Gemini', () => {
    const formatted = ImageHandler.formatForProvider('gemini', { base64: 'abc123', mimeType: 'image/png' });
    assert.ok(formatted.inlineData);
    assert.strictEqual(formatted.inlineData.mimeType, 'image/png');
  });

  it('throws for unsupported provider', () => {
    assert.throws(() => ImageHandler.formatForProvider('groq', { base64: 'x', mimeType: 'image/png' }), /does not support/);
  });
});
```

**T22.2 — `npm test` passes.**

### Acceptance Criteria
- Users can paste/drop/attach images in chat
- Images sent to vision-capable models
- Works with OpenAI, Anthropic, and Gemini
- Size limits enforced
- Images display in chat history

---

## Task 23: Semantic Memory Search ✅ COMPLETED

> **Completed:** Added `EmbeddingProvider` and `OpenAIEmbeddingProvider` classes in `src/memory/embedding-provider.js` with embedding fetching support. Created `VectorStore` class in `src/memory/vector-store.js` that implements disk persistence and cosine similarity calculations. Refactored `src/memory/memory-retrieval.js` to async computation and implementing hybrid retrieval merging semantic and keyword search. Upgraded `src/memory/memory-manager.js` to asynchronously generate and store embeddings upon memory capture, and updated its `recall()` usage inside IPCs and `main.js`. Test cases in `tests/vector-store.test.js` and `tests/semantic-retrieval.test.js` are fully passing and hooked into the npm test suite.

**Source:** openclaw.md §7
**Dependencies:** Provider with embedding support
**Files to create:** `src/memory/embedding-provider.js`, `src/memory/vector-store.js`, `src/memory/memory-retrieval-semantic.js`
**Files to modify:** Memory retrieval module

### Instructions

**Step 1:** Create `src/memory/embedding-provider.js`:

```javascript
class EmbeddingProvider {
  async embed(texts) { throw new Error('Not implemented'); }
  getDimensions() { throw new Error('Not implemented'); }
}

class OpenAIEmbeddingProvider extends EmbeddingProvider {
  constructor(config) { super(); this.apiKey = config.apiKey; this.model = config.model || 'text-embedding-3-small'; }
  getDimensions() { return 1536; }
  async embed(texts) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, model: this.model })
    });
    const data = await res.json();
    return data.data.map(d => d.embedding);
  }
}
```

**Step 2:** Create `src/memory/vector-store.js` — simple file-based vector store:
- Store vectors as JSON: `{ id: float[] }`
- Cosine similarity search
- `add(id, vector)`, `remove(id)`, `search(queryVector, topK)`

**Step 3:** Create hybrid retrieval that merges keyword + semantic + recency scores:

```javascript
async recall(query, options) {
  const keywordResults = await this.keywordSearch(query, options);
  const semanticResults = await this.semanticSearch(query, options);
  // Merge: hybridScore = (keywordScore * 0.4) + (semanticScore * 0.4) + (recencyScore * 0.2)
  // Deduplicate and return top-K
}
```

**Step 4:** Wire embedding into memory capture — compute embedding async on `memory:capture`.

### Test Cases

**T23.1 — Create `tests/vector-store.test.js`:**

```javascript
describe('VectorStore', () => {
  it('adds and retrieves vectors', async () => {
    const store = new VectorStore(tempPath);
    await store.add('entry1', [1, 0, 0]);
    await store.add('entry2', [0, 1, 0]);
    await store.add('entry3', [0.9, 0.1, 0]);

    const results = await store.search([1, 0, 0], 2);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].id, 'entry1');  // Highest cosine similarity
    assert.strictEqual(results[1].id, 'entry3');
  });

  it('removes vectors', async () => {
    const store = new VectorStore(tempPath);
    await store.add('entry1', [1, 0, 0]);
    await store.remove('entry1');
    const results = await store.search([1, 0, 0], 5);
    assert.strictEqual(results.length, 0);
  });

  it('calculates cosine similarity correctly', () => {
    const sim = VectorStore.cosineSimilarity([1, 0], [1, 0]);
    assert.ok(Math.abs(sim - 1.0) < 0.001);

    const orthogonal = VectorStore.cosineSimilarity([1, 0], [0, 1]);
    assert.ok(Math.abs(orthogonal) < 0.001);
  });

  it('persists to disk', async () => {
    const store = new VectorStore(tempPath);
    await store.add('entry1', [1, 0, 0]);
    await store.save();

    const store2 = new VectorStore(tempPath);
    await store2.load();
    const results = await store2.search([1, 0, 0], 1);
    assert.strictEqual(results[0].id, 'entry1');
  });
});
```

**T23.2 — Create `tests/semantic-retrieval.test.js`:**

```javascript
describe('Hybrid Retrieval', () => {
  it('merges keyword and semantic results', async () => {
    // Mock both search methods, verify merge logic
  });

  it('deduplicates results', async () => {
    // Same entry found by both keyword and semantic search
    // Verify it appears only once with combined score
  });

  it('falls back to keyword-only when embedding unavailable', async () => {
    // Mock embedding provider to throw
    // Verify keyword results still returned
  });

  it('weights scores correctly (0.4/0.4/0.2)', async () => {
    // Verify the hybrid scoring formula
  });
});
```

**T23.3 — `npm test` passes.**

### Acceptance Criteria
- Embeddings computed for new memory entries
- Semantic search finds conceptually related entries
- Hybrid scoring combines keyword, semantic, and recency
- Graceful fallback to keyword-only if embedding unavailable

---

## Task 24: Browser Control (CDP) ✅ COMPLETED

> **Completed:** BrowserService with auto-detect and launch capability, CdpClient with WebSocket communication, Browser tool with all specified actions + SSRF protection, and associated test coverage in `tests/browser-service.test.js`.

**Source:** openclaw.md §5.1, §5.2
**Dependencies:** None
**Files to create:** `src/browser/browser-service.js`, `src/browser/cdp-client.js`, `src/tools/builtin/browser-tool.js`
**Files to modify:** `src/tools/index.js`

### Instructions

**Step 1:** Create `src/browser/cdp-client.js`:
- CDP WebSocket connection
- Methods: `connect()`, `disconnect()`, `navigate(url)`, `screenshot()`, `pdf()`, `evaluate(expression)`, `click(selector)`, `type(selector, text)`, `waitForSelector(selector, timeout)`

**Step 2:** Create `src/browser/browser-service.js`:
- Auto-detect installed browsers (Chrome, Edge, Brave)
- Platform-specific paths for browser discovery
- Launch with `--remote-debugging-port=0`
- Parse `DevTools listening on ws://...` from stderr
- Profile isolation: `{userData}/browser-profile/`
- Tab management

**Step 3:** Create `src/tools/builtin/browser-tool.js`:
- Actions: `start`, `stop`, `status`, `tabs`, `open_tab`, `close_tab`, `navigate`, `screenshot`, `pdf`, `evaluate`, `click`, `type`, `wait_for`, `console`
- Requires approval
- SSRF protection (same as WebFetch)

### Test Cases

**T24.1 — Create `tests/browser-service.test.js`:**

```javascript
describe('BrowserService', () => {
  it('detects browser paths on current platform', () => {
    const service = new BrowserService();
    const paths = service.detectBrowserPaths();
    // Should return array of possible paths (may be empty if no browser installed)
    assert.ok(Array.isArray(paths));
  });

  it('generates correct launch arguments', () => {
    const service = new BrowserService({ headless: true, viewport: { width: 1280, height: 720 } });
    const args = service.getLaunchArgs();
    assert.ok(args.includes('--headless'));
    assert.ok(args.some(a => a.includes('1280')));
    assert.ok(args.includes('--remote-debugging-port=0'));
  });

  it('uses isolated profile directory', () => {
    const service = new BrowserService({ userDataPath: '/tmp/test' });
    const args = service.getLaunchArgs();
    assert.ok(args.some(a => a.includes('browser-profile')));
  });
});

describe('CdpClient', () => {
  it('parses WebSocket URL from browser stderr', () => {
    const url = CdpClient.parseWsUrl('DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc');
    assert.strictEqual(url, 'ws://127.0.0.1:9222/devtools/browser/abc');
  });

  it('handles connection failure gracefully', async () => {
    const client = new CdpClient('ws://localhost:99999');
    await assert.rejects(() => client.connect(), /connect|ECONNREFUSED/i);
  });
});

describe('Browser Tool', () => {
  it('requires approval', () => {
    assert.strictEqual(browserTool.requiresApproval, true);
  });

  it('validates action parameter', async () => {
    const result = await browserTool.execute({ action: 'invalid_action' });
    assert.ok(!result.ok);
  });

  it('blocks private network URLs', async () => {
    const result = await browserTool.execute({ action: 'navigate', url: 'http://192.168.1.1' });
    assert.ok(!result.ok);
    assert.ok(result.error.includes('private') || result.error.includes('blocked'));
  });
});
```

**T24.2 — `npm test` passes.**

### Acceptance Criteria
- Auto-detects and launches browser
- CDP connection established
- Tab management works
- Screenshots capture correctly
- JavaScript evaluation works
- Browser profile isolated
- SSRF protection blocks private network access

---

## Task 25: Docker Sandboxing ✅ COMPLETED

> **Completed:** Created `src/execution/sandbox-config.js` and `src/execution/sandbox-executor.js` to implement `SandboxExecutor`. The executor detects Docker availability and dynamically routes commands into an ephemeral container via `docker exec`. Mount path validation enforces blocking of system directories. Adapted `BashTool` (`src/tools/builtin/bash-tool.js`) to consume `SandboxExecutor` logic seamlessly with backwards-compatible defaults. Added coverage tests in `tests/sandbox-executor.test.js`.

**Source:** openclaw.md §9
**Dependencies:** None
**Files to create:** `src/execution/sandbox-executor.js`, `src/execution/sandbox-config.js`
**Files to modify:** `src/tools/builtin/bash-tool.js`

### Instructions

**Step 1:** Create `src/execution/sandbox-config.js` — configuration and defaults.

**Step 2:** Create `src/execution/sandbox-executor.js`:
- Detect Docker: `docker info` on startup
- Container lifecycle: create on first use, reuse within session, destroy on cleanup
- Run commands via: `docker exec -i {containerId} {command}`
- Mount working directory: `{workDir}:/workspace:rw`
- Block system path mounts: `/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/boot`, `/var/run/docker.sock`
- Default seccomp profile (never allow `unconfined`)
- Network isolation options
- Hot container cache (5-minute TTL)

**Step 3:** Integrate with Bash tool:
- When sandbox enabled, route through `SandboxExecutor`
- Configurable per session type (main, group, cron)
- Graceful fallback if Docker unavailable

### Test Cases

**T25.1 — Create `tests/sandbox-executor.test.js`:**

```javascript
describe('SandboxExecutor', () => {
  it('detects Docker availability', async () => {
    const executor = new SandboxExecutor();
    const available = await executor.isDockerAvailable();
    assert.strictEqual(typeof available, 'boolean');
  });

  it('blocks system path mounts', () => {
    const executor = new SandboxExecutor();
    assert.throws(() => executor.validateMount('/etc', '/workspace'));
    assert.throws(() => executor.validateMount('/proc', '/workspace'));
    assert.throws(() => executor.validateMount('/var/run/docker.sock', '/workspace'));
    assert.doesNotThrow(() => executor.validateMount('/home/user/project', '/workspace'));
  });

  it('generates correct docker exec command', () => {
    const executor = new SandboxExecutor({ image: 'sandbox:latest' });
    const cmd = executor.buildExecCommand('container123', 'ls -la');
    assert.ok(cmd.includes('docker'));
    assert.ok(cmd.includes('exec'));
    assert.ok(cmd.includes('container123'));
  });

  it('applies memory limit', () => {
    const executor = new SandboxExecutor({ memoryLimit: '256m' });
    const args = executor.getContainerArgs();
    assert.ok(args.includes('--memory=256m') || args.some(a => a.includes('256m')));
  });

  it('supports network isolation modes', () => {
    const executor = new SandboxExecutor({ networkMode: 'none' });
    const args = executor.getContainerArgs();
    assert.ok(args.some(a => a.includes('none')));
  });

  it('falls back to direct execution when Docker unavailable', async () => {
    const executor = new SandboxExecutor();
    // Mock Docker unavailable
    // Verify command still executes via child_process
  });
});
```

**T25.2 — `npm test` passes.**

### Acceptance Criteria
- Docker availability detected on startup
- Bash commands can run inside container
- Working directory mounted correctly
- System paths blocked from mounting
- Network isolation configurable
- Graceful fallback to direct execution

---

## Task 26: Webhook Ingress

**Source:** openclaw.md §12.1, §12.2
**Dependencies:** None (extends existing gateway)
**Files to create:** `src/webhooks/webhook-server.js`, `src/webhooks/webhook-registry.js`, `src/webhooks/webhook-handler.js`
**Files to modify:** Gateway server, `main.js`, `renderer.js`

### Instructions

**Step 1:** Create webhook registry with CRUD and persistence.

**Step 2:** Create webhook handler with:
- HMAC signature verification (GitHub, Slack, Stripe compatible)
- Rate limiting per webhook
- Max body size (1MB)
- Message templating from payload
- Routing to agent sessions

**Step 3:** Add HTTP routes to gateway server:
- `POST /webhooks/{webhookId}` — receive webhook payload
- Validate signature, check rate limit, route to agent

**Step 4:** Add IPC handlers and basic UI for webhook management.

### Test Cases

**T26.1 — Create `tests/webhook-handler.test.js`:**

```javascript
describe('WebhookRegistry', () => {
  it('registers and retrieves webhooks', () => {
    const registry = new WebhookRegistry(mockStore);
    const webhook = registry.register({ name: 'GitHub Push', route: { sessionTarget: 'main' } });
    assert.ok(webhook.id);
    assert.ok(webhook.secret);
    assert.strictEqual(registry.get(webhook.id).name, 'GitHub Push');
  });

  it('auto-generates secret on registration', () => {
    const registry = new WebhookRegistry(mockStore);
    const webhook = registry.register({ name: 'Test' });
    assert.ok(webhook.secret.length >= 32);
  });

  it('unregisters webhooks', () => {
    const registry = new WebhookRegistry(mockStore);
    const webhook = registry.register({ name: 'Test' });
    registry.unregister(webhook.id);
    assert.strictEqual(registry.get(webhook.id), undefined);
  });
});

describe('WebhookHandler', () => {
  it('validates HMAC signature (GitHub format)', () => {
    const handler = new WebhookHandler(registry);
    const body = '{"test": true}';
    const secret = 'mysecret';
    const crypto = require('crypto');
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.ok(handler.verifySignature(body, signature, secret));
  });

  it('rejects invalid signature', () => {
    const handler = new WebhookHandler(registry);
    assert.ok(!handler.verifySignature('body', 'sha256=invalid', 'secret'));
  });

  it('enforces rate limits', async () => {
    const handler = new WebhookHandler(registry);
    const webhook = { id: 'test', rateLimit: { maxPerMinute: 2 } };
    assert.ok(handler.checkRateLimit(webhook));
    assert.ok(handler.checkRateLimit(webhook));
    assert.ok(!handler.checkRateLimit(webhook));  // 3rd call within minute rejected
  });

  it('rejects oversized bodies', async () => {
    const handler = new WebhookHandler(registry);
    const bigBody = 'x'.repeat(2 * 1024 * 1024);
    await assert.rejects(() => handler.handle('test', { body: bigBody }), /size/i);
  });

  it('templates message from payload', () => {
    const handler = new WebhookHandler(registry);
    const template = 'Push to {{repository.name}} by {{pusher.name}}';
    const payload = { repository: { name: 'king-louie' }, pusher: { name: 'dev' } };
    const msg = handler.templateMessage(template, payload);
    assert.strictEqual(msg, 'Push to king-louie by dev');
  });
});
```

**T26.2 — `npm test` passes.**

### Acceptance Criteria
- Webhooks receivable on gateway HTTP server
- HMAC signature verification works
- Rate limiting per webhook
- Payloads routed to agent sessions
- CRUD management via IPC + UI

---

## Task 27: Syntax Highlighting

**Source:** king-louie-enhancement-plan.md Phase 8
**Dependencies:** None
**Files to modify:** `preload.js`, `renderer.js`, `styles.css`
**npm install:** `highlight.js`

> **Clarifications:**
> - **Renderer is monolithic:** `renderer.js` is 2,677 lines. The markdown rendering likely uses `marked` and `DOMPurify`. Find the existing `marked` configuration and add `highlight.js` integration there.
> - **CSP:** highlight.js uses inline styles by default. If Content-Security-Policy blocks inline styles, load the highlight.js CSS theme as a stylesheet in `index.html` instead.

### Instructions

**Step 1:** Install highlight.js: `npm install highlight.js`

**Step 2:** In `preload.js`, update the markdown parsing to include syntax highlighting:

```javascript
const hljs = require('highlight.js');
const { marked } = require('marked');

marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  }
});
```

Or if using a newer marked version, use a custom renderer:

```javascript
const renderer = new marked.Renderer();
renderer.code = function(code, language) {
  const validLang = language && hljs.getLanguage(language) ? language : null;
  const highlighted = validLang
    ? hljs.highlight(code, { language: validLang }).value
    : hljs.highlightAuto(code).value;
  return `<pre><code class="hljs language-${validLang || 'auto'}">${highlighted}</code></pre>`;
};
```

**Step 3:** Add highlight.js CSS theme to `styles.css`. Use a dark theme that matches the app's color scheme (e.g., `github-dark`, `atom-one-dark`, or `monokai`). Import the CSS from `highlight.js/styles/{theme}.css`.

**Step 4:** Ensure DOMPurify allows the `class` attribute on `code` and `span` elements (highlight.js uses `<span class="hljs-keyword">` etc.).

### Test Cases

**T27.1 — Verify syntax highlighting integration:**

```javascript
describe('Syntax Highlighting', () => {
  it('highlights JavaScript code blocks', () => {
    const result = markdownParse('```js\nconst x = 1;\n```');
    assert.ok(result.includes('hljs'));
    assert.ok(result.includes('hljs-keyword') || result.includes('hljs-variable'));
  });

  it('highlights Python code blocks', () => {
    const result = markdownParse('```python\ndef hello():\n    print("hi")\n```');
    assert.ok(result.includes('hljs'));
  });

  it('auto-detects language when not specified', () => {
    const result = markdownParse('```\nfunction hello() { return true; }\n```');
    assert.ok(result.includes('hljs'));
  });

  it('does not break inline code', () => {
    const result = markdownParse('Use `const x = 1` in your code');
    assert.ok(result.includes('<code>'));
    assert.ok(result.includes('const x = 1'));
  });

  it('DOMPurify preserves hljs classes', () => {
    const html = '<pre><code class="hljs language-js"><span class="hljs-keyword">const</span></code></pre>';
    const sanitized = DOMPurify.sanitize(html);
    assert.ok(sanitized.includes('hljs-keyword'));
  });

  it('handles unknown language gracefully', () => {
    const result = markdownParse('```nonexistent\nsome code\n```');
    // Should still render, just without specific highlighting
    assert.ok(result.includes('<code'));
  });
});
```

**T27.2 — `npm test` passes.**

**T27.3 — Manual smoke test:**
- Send a message containing a JavaScript code block
- Verify syntax highlighting renders with colors
- Send a message with Python, HTML, CSS code blocks
- Verify inline code (`backticks`) still renders correctly
- Verify the color theme looks good against the app background

### Acceptance Criteria
- Code blocks have syntax highlighting with colors
- Language auto-detection works
- Multiple languages supported
- Inline code unaffected
- DOMPurify doesn't strip highlight classes
- Theme matches app aesthetics

---

## Task 28: Onboarding Wizard

**Source:** openclaw.md §14
**Dependencies:** Provider system, settings system
**Files to create:** `src/wizard/onboarding-wizard.js`
**Files to modify:** `main.js`, `renderer.js`, `index.html`, `styles.css`

### Instructions

**Step 1:** Create wizard step definitions:
1. Welcome — Brief intro
2. Provider Setup — Select provider, enter API key, test connection
3. User Profile — Name, role (populates telos)
4. Channel Setup (optional) — Enable Telegram with token entry
5. Finish — Summary

**Step 2:** Add first-run detection in `main.js`:
```javascript
const isFirstRun = !store.get('onboardingComplete', false);
if (isFirstRun) {
  mainWindow.webContents.send('wizard:start');
}
```

**Step 3:** Build wizard UI in renderer.js:
- Modal overlay with step navigation
- Back/Next/Skip buttons
- Provider connection test button
- Progress indicator
- Can be re-run from settings

**Step 4:** Add IPC handler: `onboarding:complete` — sets `onboardingComplete` flag.

### Test Cases

**T28.1 — Create `tests/onboarding.test.js`:**

```javascript
describe('Onboarding', () => {
  it('detects first run correctly', () => {
    const store = { get: () => false };
    assert.ok(isFirstRun(store));
  });

  it('does not trigger on subsequent runs', () => {
    const store = { get: () => true };
    assert.ok(!isFirstRun(store));
  });

  it('marks onboarding as complete', () => {
    let stored = {};
    const store = { get: (k, d) => stored[k] || d, set: (k, v) => { stored[k] = v; } };
    completeOnboarding(store);
    assert.ok(store.get('onboardingComplete', false));
  });

  it('wizard steps are in correct order', () => {
    const steps = getWizardSteps();
    assert.strictEqual(steps[0].id, 'welcome');
    assert.strictEqual(steps[1].id, 'provider');
    assert.strictEqual(steps[steps.length - 1].id, 'finish');
  });

  it('provider step validates API key presence', () => {
    const step = getWizardSteps().find(s => s.id === 'provider');
    assert.ok(!step.validate({ provider: 'openai', apiKey: '' }));
    assert.ok(step.validate({ provider: 'openai', apiKey: 'sk-test' }));
  });

  it('allows skipping optional steps', () => {
    const steps = getWizardSteps();
    const channelStep = steps.find(s => s.id === 'channels');
    assert.ok(channelStep.optional);
  });
});
```

**T28.2 — `npm test` passes.**

### Acceptance Criteria
- Wizard appears on first launch
- Guides user through provider setup with connection test
- Can be skipped
- Can be re-run from settings
- Does not appear on subsequent launches

---

## Task 29: Diagnostics (Doctor Command)

**Source:** openclaw.md §15
**Dependencies:** All previous features (checks their health)
**Files to create:** `src/diagnostics/doctor.js`
**Files to modify:** `main.js` (IPC handler), `renderer.js` (command + settings button)

### Instructions

This should be the **last task** as it checks all other subsystems.

**Step 1:** Create `src/diagnostics/doctor.js`:

```javascript
class Doctor {
  constructor(context) {
    // context: { providerFactory, channelRegistry, memoryManager, hookRegistry,
    //            skillRegistry, gateway, cronScheduler, browserService, sandboxExecutor, store }
    this.context = context;
  }

  async runAll() {
    const results = [];
    for (const check of this.getChecks()) {
      try {
        const result = await check.run(this.context);
        results.push({ name: check.name, ...result });
      } catch (err) {
        results.push({ name: check.name, status: 'FAIL', message: err.message });
      }
    }
    return results;
  }

  getChecks() {
    return [
      { name: 'Provider Connectivity', run: checkProvider },
      { name: 'Channel Status', run: checkChannels },
      { name: 'Memory System', run: checkMemory },
      { name: 'Hook System', run: checkHooks },
      { name: 'Skill System', run: checkSkills },
      { name: 'Gateway', run: checkGateway },
      { name: 'Docker (Sandbox)', run: checkDocker },
      { name: 'Cron Scheduler', run: checkCron },
      { name: 'Browser Service', run: checkBrowser },
      { name: 'Disk Usage', run: checkDisk }
    ];
  }

  formatResults(results) {
    const lines = ['King Louie Diagnostics', '======================'];
    for (const r of results) {
      const icon = { PASS: '[PASS]', WARN: '[WARN]', FAIL: '[FAIL]', SKIP: '[SKIP]', INFO: '[INFO]' }[r.status] || '[????]';
      lines.push(`${icon} ${r.name} — ${r.message}`);
      if (r.fix) lines.push(`      Fix: ${r.fix}`);
    }
    return lines.join('\n');
  }
}
```

**Step 2:** Implement each check function. Each returns `{ status: 'PASS'|'WARN'|'FAIL'|'SKIP', message: string, fix?: string }`.

**Step 3:** Add `/doctor` command handling in renderer.js.

**Step 4:** Add IPC handler: `diagnostics:run`.

**Step 5:** Add "Run Diagnostics" button in settings UI.

### Test Cases

**T29.1 — Create `tests/doctor.test.js`:**

```javascript
describe('Doctor', () => {
  it('runs all checks and returns results', async () => {
    const doctor = new Doctor(mockContext);
    const results = await doctor.runAll();
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
    results.forEach(r => {
      assert.ok(r.name);
      assert.ok(['PASS', 'WARN', 'FAIL', 'SKIP', 'INFO'].includes(r.status));
      assert.ok(r.message);
    });
  });

  it('handles check failures gracefully', async () => {
    const doctor = new Doctor({});  // Empty context, checks should handle missing deps
    const results = await doctor.runAll();
    // Should not throw, should return FAIL/SKIP status for each
    assert.ok(results.every(r => r.status));
  });

  it('formats results as readable text', () => {
    const doctor = new Doctor({});
    const text = doctor.formatResults([
      { name: 'Test', status: 'PASS', message: 'OK' },
      { name: 'Broken', status: 'FAIL', message: 'Error', fix: 'Do this' }
    ]);
    assert.ok(text.includes('[PASS]'));
    assert.ok(text.includes('[FAIL]'));
    assert.ok(text.includes('Fix:'));
  });

  it('completes in under 10 seconds', async () => {
    const doctor = new Doctor(mockContext);
    const start = Date.now();
    await doctor.runAll();
    assert.ok(Date.now() - start < 10000);
  });
});
```

**T29.2 — `npm test` passes.**

**T29.3 — Manual test:** Run `/doctor` in the app, verify output shows status of all subsystems.

### Acceptance Criteria
- All subsystems checked
- Clear PASS/WARN/FAIL/SKIP indicators
- Actionable fix suggestions for failures
- Available via `/doctor` command and settings UI
- Runs in under 10 seconds

---

## Implementation Order Summary

```
Phase 1 — Architecture Cleanup (no dependencies):
  Task 1:  Global state consolidation (renderer.js)
  Task 2:  Additional preload validation (Completed)

Phase 2 — Provider Expansion:
  Task 3:  Provider abstraction refactor (prerequisite for 4-8) - COMPLETE
  Task 4:  Groq provider
  Task 5:  Ollama provider
  Task 6:  Mistral provider
  Task 7:  Gemini provider
  Task 8:  OpenRouter provider
  Task 9:  Inference router updates (needs 4-8)

Phase 3 — Core Tools:
  Task 10: Web Fetch tool
  Task 11: Web Search tool
  Task 12: Glob tool
  Task 13: Grep tool
  Task 14: Git tool
  Task 15: AskUser tool

Phase 4 — Platform Features:
  Task 16: Usage tracking & cost display
  Task 17: Channel plugin interface refactor (prerequisite for 19-21)
  Task 18: Cron / scheduling system

Phase 5 — Channels:
  Task 19: Discord channel (needs 17)
  Task 20: Slack channel (needs 17)
  Task 21: Group chat & mention gating (needs 17)

Phase 6 — Advanced Features:
  Task 22: Media handling — image input
  Task 23: Semantic memory search
  Task 24: Browser control (CDP)
  Task 25: Docker sandboxing
  Task 26: Webhook ingress
  Task 27: Syntax highlighting

Phase 7 — Polish:
  Task 28: Onboarding wizard
  Task 29: Diagnostics (doctor command) — LAST
```

Tasks within the same phase that share no dependencies can be executed in parallel. Tasks in later phases depend on earlier phases being complete.
