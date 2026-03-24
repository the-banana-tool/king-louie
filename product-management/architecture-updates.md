# Architecture Refactors

Remaining issues from the 2026-03-23 comprehensive code review. The 12 quick/security fixes have already been committed. These 7 items require structural changes across `main.js`, `renderer.js`, and `preload.js`.

---

## Progress Update (2026-03-23)

### ✅ Completed in commit `96e5a82`

- **XSS / sanitization hardening (subset of item 1):**
  - Installed `dompurify` and wired sanitization into `preload.js` markdown parsing.
  - Sanitized renderer `html` format path (`renderAssistantMessageContent`).
  - Removed dynamic `innerHTML` tool label interpolation.
  - Replaced dynamic error `innerHTML` interpolation with safe DOM node creation.
  - Replaced streaming placeholder HTML injection (`'<p>...</p>'`) with safe DOM node creation.

- **IPC reliability groundwork (subset of item 3):**
  - Added `src/ipc/wrap-handler.js` utility.
  - Added test coverage in `tests/ipc-wrap-handler.test.js`.
  - Updated key renderer IPC call sites to handle `{ ok, error }` shape via `unwrapIpcResult` for:
    - `loadChats()`
    - `handleCreateChat()`
    - `loadSettings()`
    - chat activate/rename/delete flow

- **Memory/leak hardening (subset of item 4):**
  - Tool approval modal listeners now use `{ once: true }`.
  - Stream buffer cleanup now happens defensively (including chat switch and beforeunload).
  - Listener lifecycle cleanup added on `beforeunload`.

- **Preload hardening (item 6 core pieces):**
  - Input validation added for sensitive operations:
    - `settings.saveProvider`
    - `settings.runLlmCommand`
    - `skill.execute`
    - `tool.execute`
  - Listener registration now supports unsubscribe and deduplication.
  - Basic rate limiting added for:
    - `settings.testProvider`
    - `settings.testVoice`
    - `tool.execute`

- **Testing:**
  - `npm test` updated to include IPC wrap-handler tests.
  - Test suite passes.

### 🚧 Still Outstanding

- **Item 2:** Full IPC extraction from `main.js` into `src/ipc/*` modules + central register/constants.
- **Item 3:** Apply `wrapHandler` to all 51 handlers for fully standardized IPC result shape.
- **Item 5:** Global renderer state consolidation into `appState` / `dom` objects.
- **Item 6 (remaining):** Additional validation coverage/access controls beyond current sensitive paths.

### ✅ Completed in this commit

- **Item 7.1 (optional): Runtime cache reset wiring on provider changes**
  - Added `src/ipc/settings-provider.js` with `applyActiveProviderUpdate(...)` to centralize provider-switch behavior.
  - `settings:setActiveProvider` now calls this helper and invokes `resetRuntimeEnvironmentCache()` after updating settings.
  - Added test coverage in `tests/settings-provider.test.js` for:
    - unknown provider rejection
    - successful provider update + cache reset invocation
    - successful update when reset callback is absent
  - Included the new test file in `npm test`.

- **Item 2.1 / 2.3 / 3.2 (incremental): Task IPC handler extraction + wrapHandler standardization**
  - Added `src/ipc/task-handlers.js` and moved task handlers (`task:create`, `task:list`, `task:update`) out of `main.js`.
  - Task handlers now register via `registerTaskHandlers(ipcMain, { getTaskManager })` and consume dependencies through context.
  - Applied `wrapHandler(...)` to all extracted task handlers so they now consistently return `{ ok: true, data }` or `{ ok: false, error }`.
  - Added automated coverage in `tests/task-handlers.test.js` (registration, success wrapping, error wrapping, and update path behavior).
  - Included the new task handler test in `npm test`.

---

## 1. XSS via innerHTML in renderer.js

**Priority:** High | **Complexity:** Medium

`renderer.js` uses `innerHTML` to render LLM output and user content in 6 dangerous locations. The markdown parser (`marked` v15) is the only defense, and it's not a sanitizer.

### Tasks

- [ ] **1.1** Install DOMPurify — `npm install dompurify` and add to preload.js markdown namespace:
  ```js
  // preload.js — update the parse method
  const DOMPurify = require('dompurify');
  parse: (text) => DOMPurify.sanitize(safeMarkdownParse(text))
  ```

- [ ] **1.2** Fix line 2076 (CRITICAL) — `messageContent.innerHTML = String(text || '')` when `format === 'html'`. This injects raw HTML with zero sanitization. Wrap with DOMPurify:
  ```js
  messageContent.innerHTML = DOMPurify.sanitize(String(text || ''));
  ```
  Or better: remove the `html` format path entirely if nothing actually uses it.

- [ ] **1.3** Fix lines 325, 2087, 2570 — Three sites that render parsed markdown via `window.electron.markdown.parse()`. If task 1.1 wraps DOMPurify in the preload parse method, these are automatically covered. Verify each one uses the preload parse path (not a local call).
  - Line 325: `payloadDiv.innerHTML = window.electron.markdown.parse(markdownCandidate)` — tool payload rendering
  - Line 2087: `messageContent.innerHTML = window.electron.markdown.parse(text || '')` — standard message rendering
  - Line 2570: `streamElement.innerHTML = window.electron.markdown.parse(next)` — streaming chunk rendering

- [ ] **1.4** Fix line 351 — `toolLabel.innerHTML = '<strong>Tool:</strong> ${toolName}'` — template literal with IPC-sourced `toolName`. Replace with:
  ```js
  const strong = document.createElement('strong');
  strong.textContent = 'Tool:';
  toolLabel.textContent = '';
  toolLabel.appendChild(strong);
  toolLabel.appendChild(document.createTextNode(` ${toolName}`));
  ```

- [ ] **1.5** Fix line 2587 — `messageDiv.innerHTML = '<p>Error: ${error}</p>'` — error message interpolation. Replace with:
  ```js
  const p = document.createElement('p');
  p.textContent = `Error: ${error}`;
  messageDiv.textContent = '';
  messageDiv.appendChild(p);
  ```

- [ ] **1.6** Verify the 7 `innerHTML = ''` sites (lines 462, 539, 805, 886, 902, 1499, 2552) are safe — these clear containers and are fine as-is, but confirm none were changed since the audit.

### Acceptance Criteria
- No `innerHTML` assignment with dynamic content anywhere in renderer.js without DOMPurify sanitization
- `npm test` passes
- Manual smoke test: paste `<img src=x onerror=alert(1)>` as a chat message and confirm it renders as text, not as an image tag

---

## 2. Extract IPC Handlers from main.js

**Priority:** High | **Complexity:** Medium

`main.js` has 51 IPC handlers spanning lines 1667-2621 (~950 lines) with no modular organization. They should be extracted into handler modules grouped by domain.

### Handler Inventory (51 total)

| Module | Handlers | Lines |
|--------|----------|-------|
| Chat (9) | `app:quitWindow`, `chat:load`, `chat:create`, `chat:setActive`, `chat:rename`, `chat:delete`, `chat:addMessage`, `chat:speakLast`, `chat:sendMessage` | 1667-1891 |
| Tool (3) | `tool:execute`, `tool:list`, `tool:approvalResponse` | 1893-2017 |
| Hooks (4) | `hooks:list`, `hooks:reload`, `hooks:setEnabled`, `hooks:setGlobalEnabled` | 1899-1935 |
| Memory (5) | `memory:capture`, `memory:recall`, `memory:list`, `memory:delete`, `memory:clear` | 1937-2001 |
| Settings (13) | `settings:load`, `settings:saveTemplateVariables`, `settings:saveUserProfile`, `settings:saveVoice`, `settings:saveElevenLabsKey`, `settings:testVoice`, `settings:setActiveProvider`, `settings:setProviderModel`, `settings:saveProvider`, `settings:testProvider`, `settings:runLlmCommand`, `settings:setInferenceTier`, `settings:saveNotifications` | 2019-2441 |
| Task (3) | `task:create`, `task:list`, `task:update` | 2260-2282 |
| Agent (4) | `agent:list`, `agent:execute`, `agent:executeParallel`, `agent:executeSerial` | 2284-2423 |
| Gateway (3) | `gateway:status`, `sessions:list`, `sessions:history` | 2443-2467 |
| Skill (8) | `skill:list`, `skill:customize`, `skill:execute`, `skill:pin`, `skill:unpin`, `skill:getPinned`, `skill:listPinnable`, `skill:handleMessage` | 2469-2621 |

### Tasks

- [ ] **2.1** Create `src/ipc/` directory with one file per module:
  - `src/ipc/chat-handlers.js`
  - `src/ipc/tool-handlers.js`
  - `src/ipc/hooks-handlers.js`
  - `src/ipc/memory-handlers.js`
  - `src/ipc/settings-handlers.js`
  - `src/ipc/task-handlers.js`
  - `src/ipc/agent-handlers.js`
  - `src/ipc/gateway-handlers.js`
  - `src/ipc/skill-handlers.js`

- [ ] **2.2** Create `src/ipc/register.js` — a central registration function:
  ```js
  function registerHandlers(ipcMain, context) {
    // context = { store, chatState, toolExecutor, hookExecutor, memoryManager, ... }
    registerChatHandlers(ipcMain, context);
    registerToolHandlers(ipcMain, context);
    // ...
  }
  ```

- [ ] **2.3** Each handler module exports a `register(ipcMain, context)` function. Each handler receives shared dependencies via the `context` object rather than closing over main.js variables. Example:
  ```js
  // src/ipc/memory-handlers.js
  function register(ipcMain, { memoryManager }) {
    ipcMain.handle('memory:capture', async (_event, payload) => {
      try {
        const entry = memoryManager.capture(payload.type, payload.content, { ... });
        return { ok: true, entry };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
    // ...
  }
  ```

- [ ] **2.4** Move all 51 handlers out of `main.js` into their respective module files. Replace the 950 lines in main.js with:
  ```js
  const { registerHandlers } = require('./src/ipc/register');
  registerHandlers(ipcMain, { store, ... });
  ```

- [ ] **2.5** Create `src/ipc/constants.js` with all IPC channel name constants to eliminate magic strings:
  ```js
  module.exports = {
    CHAT_LOAD: 'chat:load',
    CHAT_CREATE: 'chat:create',
    // ... all 51 channel names
  };
  ```

- [ ] **2.6** Verify all handlers still work — `node --check main.js`, `npm test`, and manual smoke test of: create chat, send message, change settings, execute tool, run skill.

### Acceptance Criteria
- `main.js` handler section replaced with a single `registerHandlers()` call
- Each handler module is self-contained with its own dependencies
- All 51 handlers have consistent return shape: `{ ok: boolean, data?, error? }`
- No functional regressions

---

## 3. Add Error Handling to IPC Handlers

**Priority:** High | **Complexity:** Low

18 of 51 handlers (35%) have no try-catch. Unhandled exceptions crash the renderer process. This should be done as part of task 2 (extraction), but is listed separately so it can be done independently if needed.

### Unprotected Handlers (18)

**Chat (7 unguarded / 9 total):**
- `app:quitWindow` (line 1667)
- `chat:load` (line 1674)
- `chat:create` (line 1681)
- `chat:setActive` (line 1703)
- `chat:rename` (line 1708)
- `chat:delete` (line 1719)
- `chat:addMessage` (line 1730)

**Settings (4 unguarded / 13 total):**
- `settings:load` (line 2019)
- `settings:saveTemplateVariables` (line 2058)
- `settings:setActiveProvider` (line 2128)
- `settings:setProviderModel` (line 2143)

**Task (3/3):** `task:create` (2260), `task:list` (2268), `task:update` (2276)

**Skill (3/8):** `skill:pin` (2533), `skill:unpin` (2551), `skill:getPinned` (2561)

**Other (1):** `tool:list` (2002)

### Tasks

- [ ] **3.1** Create a `wrapHandler` utility in `src/ipc/wrap-handler.js`:
  ```js
  function wrapHandler(name, fn) {
    return async (event, ...args) => {
      try {
        return await fn(event, ...args);
      } catch (error) {
        console.error(`[ipc] ${name} failed:`, error.message);
        return { ok: false, error: error.message };
      }
    };
  }
  ```

- [ ] **3.2** Apply `wrapHandler` to all 51 handlers (not just the 18 missing ones — standardize everything). During extraction (task 2), use it by default:
  ```js
  ipcMain.handle('chat:load', wrapHandler('chat:load', async (_event) => {
    // handler logic
  }));
  ```

- [ ] **3.3** Update renderer.js call sites to check the `{ ok, error }` response shape where they currently assume success. Priority sites:
  - `loadChats()` — check `result.ok` before destructuring
  - `handleCreateChat()` — check result before setting active
  - Settings loaders — check before populating forms

### Acceptance Criteria
- Every IPC handler is wrapped in try-catch (directly or via `wrapHandler`)
- Every handler returns `{ ok: true, ... }` or `{ ok: false, error: string }`
- No unhandled promise rejections from IPC in the console

---

## 4. Fix Memory Leaks in renderer.js

**Priority:** Medium | **Complexity:** Medium

The renderer accumulates event listeners and Map entries without cleanup, causing memory usage to grow over long sessions.

### Leak Sources

**A. Tool Approval Dialog (lines 382, 387)** — Each call to `showToolApprovalDialog()` creates a modal with `addEventListener` on deny/approve buttons. When `modal.remove()` is called, the listeners are orphaned. Over many tool approvals, listeners accumulate.

**B. streamBufferById Map (line 136)** — Entries are added on `onMessageStart` and deleted on `onMessageComplete`/`onMessageError`. But if the user switches chats mid-stream, the completion event is received but the entry may not be cleaned up if the chat ID check on line 2557 skips it.

**C. No window unload cleanup** — No `beforeunload` or `unload` handler exists to clean up IPC listeners or pending state.

### Tasks

- [ ] **4.1** Fix tool approval dialog leak — Use `{ once: true }` on the button listeners, or use named functions with explicit `removeEventListener` before `modal.remove()`:
  ```js
  // In showToolApprovalDialog()
  function handleDeny() {
    modal.remove();
    resolve(false);
  }
  function handleApprove() {
    modal.remove();
    resolve(true);
  }
  denyBtn.addEventListener('click', handleDeny, { once: true });
  approveBtn.addEventListener('click', handleApprove, { once: true });
  ```

- [ ] **4.2** Add periodic cleanup for streamBufferById — After `onMessageComplete` and `onMessageError`, verify the Map doesn't have stale entries. Add a sweep on chat switch:
  ```js
  // When switching chats (inside setActive handler):
  streamBufferById.clear(); // or selectively delete entries not for the new chat
  ```

- [ ] **4.3** Add `beforeunload` handler to renderer.js:
  ```js
  window.addEventListener('beforeunload', () => {
    streamBufferById.clear();
    // Any other cleanup needed
  });
  ```

- [ ] **4.4** Audit all 7 IPC `on*` listeners (lines 2543-2609) — These are registered once at startup via preload which is correct. Confirm none are re-registered on reload or re-render. If `loadChats()` or `renderChatList()` re-registers them, deduplicate.

### Acceptance Criteria
- Opening and closing 50 tool approval dialogs does not increase listener count
- Switching chats mid-stream does not leave orphaned streamBuffer entries
- DevTools Memory snapshot shows stable heap after repeated chat operations

---

## 5. Consolidate Global State in renderer.js

**Priority:** Medium | **Complexity:** Medium

renderer.js has 82+ global variables (75 DOM refs + 7 mutable state vars + settingsState object) declared at the top level. Mutations are scattered throughout 2600+ lines making state changes hard to trace.

### Current State Variables (lines 77-139)

| Variable | Type | Purpose |
|----------|------|---------|
| `chats` | `Array` | All loaded chats |
| `activeChatId` | `string|null` | Currently selected chat |
| `contextChatId` | `string|null` | Right-click context menu target |
| `settingsState` | `Object` | Nested config (providers, voice, hooks, notifications, profile, templates, inference) |
| `streamBufferById` | `Map` | Response ID -> buffered markdown for streaming |
| `isAgentModeEnabled` | `boolean` | Agent mode toggle |
| `isHistoryCollapsed` | `boolean` | Sidebar visibility |
| `memoryEntries` | `Array` | Cached memory query results |

### Tasks

- [ ] **5.1** Create an `AppState` object to consolidate mutable state:
  ```js
  const appState = {
    chats: [],
    activeChatId: null,
    contextChatId: null,
    isAgentModeEnabled: false,
    isHistoryCollapsed: false,
    memoryEntries: [],
    streamBuffers: new Map(),
    settings: { /* current settingsState shape */ }
  };
  ```

- [ ] **5.2** Create a `DOMRefs` object for DOM element references:
  ```js
  const dom = {
    userInput: document.getElementById('user-input'),
    sendBtn: document.getElementById('send-btn'),
    chatMessages: document.getElementById('chat-messages'),
    // ... all 75 element references
  };
  ```

- [ ] **5.3** Replace all bare global references with `appState.X` and `dom.X` throughout renderer.js. This is a mechanical find-and-replace for each variable:
  - `chats` -> `appState.chats`
  - `activeChatId` -> `appState.activeChatId`
  - `settingsState` -> `appState.settings`
  - `streamBufferById` -> `appState.streamBuffers`
  - `userInput` -> `dom.userInput`
  - etc.

- [ ] **5.4** Add a `resetAppState()` function for use during testing or full resets:
  ```js
  function resetAppState() {
    appState.chats = [];
    appState.activeChatId = null;
    appState.streamBuffers.clear();
    appState.memoryEntries = [];
    // ...
  }
  ```

### Acceptance Criteria
- All mutable state accessed through `appState` or `dom` objects
- No bare global `let` variables for state (DOM refs can stay `const`)
- Grep for the old variable names confirms they're only used as `appState.X` or `dom.X`
- No functional regressions

---

## 6. Harden Preload Surface Area

**Priority:** Low | **Complexity:** Medium

The preload exposes 64 methods (43 invocations + 10 listener registrations + 11 utilities) across 9 namespaces with no input validation, rate limiting, or access control.

### Current Namespace Inventory

| Namespace | Methods | Invoke | Listen | Notes |
|-----------|---------|--------|--------|-------|
| `chat` | 15 | 8 | 7 | Core flow, highest risk |
| `settings` | 13 | 13 | 0 | Handles API keys |
| `skill` | 8 | 8 | 0 | Runs arbitrary commands |
| `task` | 6 | 3 | 3 | Task orchestration |
| `memory` | 5 | 5 | 0 | Knowledge store |
| `agent` | 4 | 4 | 0 | Agent execution |
| `tool` | 4 | 2 | 1+1 send | Tool execution + approval |
| `hooks` | 4 | 4 | 0 | Extension system |
| `orchestration` | 3 | 3 | 0 | Gateway/sessions |
| `app` | 1 | 1 | 0 | Window management |
| `markdown` | 1 | 0 | 0 | Local utility (no IPC) |

### Tasks

- [ ] **6.1** Add input validation in preload — Before forwarding to IPC, validate argument types and shapes. Create a `validatePayload` helper:
  ```js
  function validatePayload(payload, schema) {
    // schema = { chatId: 'string', text: 'string' }
    for (const [key, expectedType] of Object.entries(schema)) {
      if (typeof payload[key] !== expectedType) {
        throw new Error(`Invalid ${key}: expected ${expectedType}`);
      }
    }
  }
  ```
  Apply to sensitive handlers:
  - `settings.saveProvider` — validate `provider` is one of known names, `token` is string
  - `settings.runLlmCommand` — validate `command` is string, not empty
  - `skill.execute` — validate `command` is string
  - `tool.execute` — validate `toolName` is string, `parameters` is object

- [ ] **6.2** Add listener cleanup support — Expose `removeListener` methods so renderer can unsubscribe:
  ```js
  onMessageStart: (callback) => {
    ipcRenderer.on('chat:messageStart', callback);
    return () => ipcRenderer.removeListener('chat:messageStart', callback);
  },
  ```

- [ ] **6.3** Deduplicate listener guards — Add a guard to prevent double-registration:
  ```js
  const registeredListeners = new Set();
  function registerOnce(channel, callback) {
    if (registeredListeners.has(channel)) return () => {};
    registeredListeners.add(channel);
    ipcRenderer.on(channel, callback);
    return () => { ipcRenderer.removeListener(channel, callback); registeredListeners.delete(channel); };
  }
  ```

- [ ] **6.4** Add basic rate limiting for sensitive operations — Throttle `settings.testProvider`, `settings.testVoice`, `tool.execute` to 1 call per second:
  ```js
  function throttle(fn, delayMs = 1000) {
    let lastCall = 0;
    return (...args) => {
      const now = Date.now();
      if (now - lastCall < delayMs) return Promise.reject(new Error('Too many requests'));
      lastCall = now;
      return fn(...args);
    };
  }
  ```

### Acceptance Criteria
- Invalid payloads are rejected before reaching main process
- Listeners can be unregistered
- Rapid-fire calls to test/execute endpoints are throttled
- No functional regressions

---

## 7. Runtime Environment Cache (Already Fixed — Verify)

The `getRuntimeEnvironment()` cache was fixed in commit `3070275` with a 5-minute TTL and `resetRuntimeEnvironmentCache()` export. No further work needed unless the cache reset needs to be wired into specific lifecycle events.

### Optional Follow-Up

- [x] **7.1** Wire `resetRuntimeEnvironmentCache()` into `settings:setActiveProvider` handler so environment is re-detected when the user changes providers or working directory.

---

## Dependency Graph

```
Independent (no ordering constraints):
  1. XSS / DOMPurify
  4. Memory Leaks
  5. Global State Consolidation
  7. Runtime Cache Wiring (optional)

Sequential:
  2. Extract IPC Handlers  -->  3. Add Error Handling (do together)
  5. Global State  -->  6. Preload Hardening (easier after state cleanup)
```

## Suggested Execution Order

1. **XSS / DOMPurify** (1) — Highest security impact, isolated change
2. **Extract IPC + Error Handling** (2 + 3) — Do together during extraction
3. **Memory Leaks** (4) — Moderate effort, high impact for long sessions
4. **Global State** (5) — Mechanical refactor, reduces complexity
5. **Preload Hardening** (6) — Polish, lower priority
6. **Runtime Cache Wiring** (7) — Optional follow-up
