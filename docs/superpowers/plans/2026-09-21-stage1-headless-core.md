# Stage 1: Headless Core and Service Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run King Louie as a headless OS service on Windows, macOS and Linux (`king-louie-service`), with the Electron app behaving exactly as before.

**Architecture:** Every Electron dependency inside `src/` is replaced with an injected *port*:
- `prompter`: ask-user and directory-access prompts
- `cipher`: encryption at rest
- `vault`
- `ui.send`: events to the renderer
- `openExternal`

Then `main.js`'s ~2400 lines of wiring move into `createCore(deps)` (`src/core/`), which both hosts call:
- **Electron host:** `main.js` passes Electron-backed ports.
- **Service host:** `bin/king-louie-service.js` passes plain-Node ports: JSON-file store, AES-GCM cipher keyed by an OS-protected master key, and a headless prompter that denies everything.

The loopback gateway and webhook servers get authentication/origin hardening at the same time.

**Tech Stack:** Node ≥ 22 (CommonJS), `node:test`, `node:crypto` (AES-256-GCM), `ws`, PowerShell DPAPI on Windows, systemd, launchd, Windows Task Scheduler. **No new npm dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-21-king-louie-fleet-design.md`. This plan implements §4 (Stage 1). Read §3.1 (trust principles) and §4 before starting.

## Global Constraints

- **Open source hygiene:** no personal machine names, domains, usernames or paths anywhere (code, tests, fixtures, docs). Use placeholders (`gpu-box`, `web-01`, `kl.example.com`, `C:\Users\me\src`). Grep your diff before each commit.
- **Tests:** `node --test`, never Jest. Unit suite: `npm test`. Electron UI suite: `npm run test:e2e` (sequential). A single file: `node --test tests/<file>.test.js`.
- **Logging:** `createLogger` from `src/logging.js`, never bare `console.*`, **except** CLI output in `src/service/cli.js`, which writes to `process.stdout` / `process.stderr` deliberately.
- **No data migration.** The Electron app keeps its existing `electron-store` files (`config.json` for the vault store, `chat-data.json` for chats and settings) byte-for-byte compatible. Ciphertext format for the Electron host stays `base64(safeStorage.encryptString(x))`.
- **Electron import boundary:** after Task 4, nothing under `src/` may `require('electron')`, `require`/`import('electron-store')`, or `require` `main.js`, except files under `src/ipc/`. Task 1's guard test enforces this.
- **No new npm dependencies.**
- **Node version:** 22 (matches the release workflow).
- **Behaviour parity:** after every task, `npm test` passes, and after Tasks 2, 3, 4 and 8, `npm run test:e2e` also passes. From an agent shell, run e2e with `ELECTRON_RUN_AS_NODE` unset (see CLAUDE.md).
- **Commits:** one per task minimum, conventional-commit style (`feat(core): …`, `refactor(tools): …`, `test: …`). End every commit message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Spec deviations decided while planning

Task 11 records these in the spec:

1. **The secrets port is a `cipher` port.** Today every secret is stored as *ciphertext inside a store*, not in an OS secret store. The service host keeps that model:
   - one AES-256-GCM cipher keyed by a 32-byte **master key**;
   - the master key is protected by DPAPI on Windows, a systemd credential on Linux, or otherwise a `0600` key file.
   - macOS Keychain and libsecret are **not** used: a LaunchDaemon or system unit running as a service account has no unlocked login keychain or keyring.
2. **The Windows "service" is a boot-time Scheduled Task** running as `LOCAL SERVICE` (SID `S-1-5-19`), with restart-on-failure. Node can't answer the Service Control Manager without a native wrapper, and adding one breaks the no-new-dependencies rule. A real SCM service can come later.
3. **The webhook server can't require a bearer token,** because external senders (GitHub, etc.) authenticate with per-webhook HMAC signatures. Instead it:
   - drops the wildcard CORS headers;
   - rejects any request carrying an `Origin` header, so browser pages can't drive it;
   - refuses to bind to anything except loopback.

   The gateway *does* require a bearer token, as the spec says.
4. **The gateway token is also written to `<dataDir>/gateway-token` (mode `0600`)** so local tools can read it, the same way Jupyter handles its token.

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `.github/workflows/test.yml` | create | `npm test` on ubuntu, windows, macos |
| `tests/electron-boundary.test.js` | create | Static scan enforcing the Electron import boundary |
| `src/platform/prompter.js` | create | Headless prompter (denies everything) |
| `src/platform/electron-prompter.js` | create | Renderer-backed prompter (logic moved out of `agent-loop.js`); has no `require('electron')` |
| `src/platform/cipher.js` | create | `createAesGcmCipher(key)`, `createSafeStorageCipher(safeStorage)`, `createUnavailableCipher()` |
| `src/platform/vault.js` | create | `createVault({ store, cipher })`: prefixed, encrypted key-value store over any store |
| `src/platform/json-file-store.js` | create | `JsonFileStore`: electron-store-compatible subset, atomic `0600` writes |
| `src/platform/paths.js` | create | Default service data dir per OS; `ensureServicePaths` |
| `src/platform/master-key.js` | create | Resolve or create the 32-byte master key (systemd credential, DPAPI, key file) |
| `src/core/settings.js` | create | `DEFAULT_SETTINGS`, `mergeSettings` (moved verbatim from `main.js`) |
| `src/core/create-core.js` | create | `createCore(deps)`: everything `main.js` did except windows, IPC and protocol |
| `src/core/index.js` | create | Re-exports `createCore`, `DEFAULT_SETTINGS`, `mergeSettings` |
| `src/service/cli.js` | create | Argument parsing and subcommand dispatch |
| `src/service/config.js` | create | Load `<dataDir>/service.json`, apply defaults, validate profile |
| `src/service/ports.js` | create | Build the service host's ports |
| `src/service/run.js` | create | `run` subcommand: pidfile, profile start, graceful shutdown |
| `src/service/pidfile.js` | create | Write, read and check the pidfile |
| `src/service/doctor.js` | create | Permission and environment checks |
| `src/service/installers.js` | create | Render systemd/launchd/Task Scheduler artifacts; plan and execute install steps |
| `bin/king-louie-service.js` | create | `#!/usr/bin/env node` shim that calls `src/service/cli.js` |
| `src/execution/agent-loop.js` | modify | Use `this.prompter` instead of `BrowserWindow` / `require('../../main')` |
| `src/agents/agent-executor.js` | modify | Pass `prompter` through to `AgentLoop` |
| `src/ipc/chat-handlers.js` | modify | Pass `context.prompter` to `AgentLoop` |
| `src/tools/builtin/vault-tool.js`, `browser-tool.js` | modify | Use `context.vault` |
| `src/tools/builtin/web-search-tool.js`, `image-generate-tool.js` | modify | Use `context.getSettings` / `context.getProviderToken` / `context.decryptToken` |
| `src/mesh/index.js` | modify | Use injected `cipher` |
| `src/auth/anthropic-oauth.js` | modify | Use injected `openExternal` |
| `src/channels/channel-plugin.js` | modify | `DesktopChannelPlugin` takes `sendToUi` |
| `src/notifications/channels/ui-toast.js` | modify | Takes an injected `Notification` class |
| `src/gateway/gateway-server.js` | modify | Bearer token, loopback-only, rejects `Origin` |
| `src/webhooks/webhook-server.js` | modify | No CORS, rejects `Origin`, loopback-only |
| `main.js` | modify | Shrinks to Electron glue (≈400 lines) |
| `package.json` | modify | `bin` entry, `engines` |
| `README.md`, `CLAUDE.md`, spec | modify | Service docs, deviations |

---

### Task 1: CI on all three OSes, plus the Electron-boundary guard

**Files:**
- Create: `.github/workflows/test.yml`
- Create: `tests/electron-boundary.test.js`

**Interfaces:**
- Produces: `KNOWN_VIOLATIONS` in `tests/electron-boundary.test.js`. Tasks 2–4 each delete entries from it, and it must be empty after Task 4.

- [ ] **Step 1: Write the guard test**

```js
// tests/electron-boundary.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const ALLOWED_DIRS = [path.join(SRC, 'ipc') + path.sep];

const PATTERNS = [
  { name: 'electron', re: /require\(\s*['"]electron['"]\s*\)/ },
  { name: 'electron-store', re: /(require|import)\(\s*['"]electron-store['"]\s*\)/ },
  { name: 'main.js', re: /require\(\s*['"](\.\.\/)+main['"]\s*\)/ },
];

// Shrinks to [] as Tasks 2–4 land. Format: 'relative/path.js:pattern-name'.
const KNOWN_VIOLATIONS = [
  'auth/anthropic-oauth.js:electron',
  'channels/channel-plugin.js:electron',
  'execution/agent-loop.js:electron',
  'execution/agent-loop.js:main.js',
  'mesh/index.js:electron',
  'notifications/channels/ui-toast.js:electron',
  'tools/builtin/browser-tool.js:electron-store',
  'tools/builtin/image-generate-tool.js:electron',
  'tools/builtin/image-generate-tool.js:electron-store',
  'tools/builtin/vault-tool.js:electron-store',
  'tools/builtin/web-search-tool.js:electron',
  'tools/builtin/web-search-tool.js:electron-store',
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function findViolations() {
  const found = [];
  for (const file of walk(SRC)) {
    if (ALLOWED_DIRS.some((d) => file.startsWith(d))) continue;
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) found.push(`${rel}:${name}`);
    }
  }
  return found.sort();
}

describe('Electron import boundary', () => {
  it('only src/ipc/ may import electron, electron-store or main.js', () => {
    assert.deepStrictEqual(findViolations(), [...KNOWN_VIOLATIONS].sort(),
      'If you removed a violation, delete it from KNOWN_VIOLATIONS. If you added one, inject the dependency instead.');
  });
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/electron-boundary.test.js`
Expected: PASS. If it fails, the list printed under "actual" is the truth. Make `KNOWN_VIOLATIONS` match it **exactly**, and mention any difference from the list above in the commit message.

- [ ] **Step 3: Add the CI workflow**

```yaml
# .github/workflows/test.yml
name: Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  unit:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    env:
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1'
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
```

- [ ] **Step 4: Run the full suite locally**

Run: `npm test`
Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/test.yml tests/electron-boundary.test.js
git commit -m "test: guard the Electron import boundary; run unit tests on all three OSes"
```

---

### Task 2: Prompter port (AskUser and directory access leave `agent-loop.js`)

**Files:**
- Create: `src/platform/prompter.js`
- Create: `src/platform/electron-prompter.js`
- Modify: `src/execution/agent-loop.js`: constructor (~line 16–95), `_requestDirectoryAccess` block (~lines 134–180), AskUser branch (~lines 464–500)
- Modify: `src/agents/agent-executor.js:95-99`
- Modify: `src/ipc/chat-handlers.js:454` (the `new AgentLoop(...)` options)
- Modify: `main.js`: build the Electron prompter; pass it to `registerHandlers` and to `AgentExecutor` in `agentExecutorAdapter`; remove `module.exports` at the bottom
- Modify: `tests/ask-user-tool.test.js`
- Test: `tests/prompter.test.js`

**Interfaces:**
- Produces:
  - `createHeadlessPrompter() → Prompter`
  - `createElectronPrompter({ getWindow, pendingAskUserResolvers, pendingDirectoryAccessResolvers }) → Prompter`
  - `Prompter` = `{ askUser({ question }) → Promise<{ ok: true, response } | { ok: false, error }>, requestDirectoryAccess({ directory, toolName }) → Promise<boolean> }`
  - `HEADLESS_ASK_USER_ERROR` (string constant)
  - `AgentLoop` option `prompter`, defaulting to `createHeadlessPrompter()`
  - `AgentExecutor` constructor option `prompter`, forwarded to `AgentLoop`
  - IPC context key `prompter`

- [ ] **Step 1: Write the failing tests**

```js
// tests/prompter.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createHeadlessPrompter, HEADLESS_ASK_USER_ERROR } = require('../src/platform/prompter');
const { createElectronPrompter } = require('../src/platform/electron-prompter');

describe('headless prompter', () => {
  it('refuses to ask questions', async () => {
    const p = createHeadlessPrompter();
    assert.deepStrictEqual(await p.askUser({ question: 'hi?' }), { ok: false, error: HEADLESS_ASK_USER_ERROR });
  });
  it('denies directory access', async () => {
    assert.strictEqual(await createHeadlessPrompter().requestDirectoryAccess({ directory: '/tmp', toolName: 'Read' }), false);
  });
});

describe('electron prompter', () => {
  function fakeWindow() {
    const sent = [];
    return { sent, webContents: { send: (ch, payload) => sent.push({ ch, payload }) }, isDestroyed: () => false };
  }

  it('sends agent:askUser and resolves with the renderer answer', async () => {
    const win = fakeWindow();
    const askMap = new Map();
    const p = createElectronPrompter({ getWindow: () => win, pendingAskUserResolvers: askMap, pendingDirectoryAccessResolvers: new Map() });
    const pending = p.askUser({ question: 'Proceed?' });
    assert.strictEqual(win.sent[0].ch, 'agent:askUser');
    const { requestId, question } = win.sent[0].payload;
    assert.strictEqual(question, 'Proceed?');
    askMap.get(requestId).resolve('yes');
    assert.deepStrictEqual(await pending, { ok: true, response: 'yes' });
  });

  it('returns an error when no window exists', async () => {
    const p = createElectronPrompter({ getWindow: () => null, pendingAskUserResolvers: new Map(), pendingDirectoryAccessResolvers: new Map() });
    assert.deepStrictEqual(await p.askUser({ question: 'q' }), { ok: false, error: 'No UI available to ask user.' });
    assert.strictEqual(await p.requestDirectoryAccess({ directory: '/x', toolName: 'Read' }), false);
  });

  it('sends tool:directoryAccessRequired and resolves with the decision', async () => {
    const win = fakeWindow();
    const dirMap = new Map();
    const p = createElectronPrompter({ getWindow: () => win, pendingAskUserResolvers: new Map(), pendingDirectoryAccessResolvers: dirMap });
    const pending = p.requestDirectoryAccess({ directory: '/data', toolName: 'Read' });
    const { requestId, directory, toolName } = win.sent[0].payload;
    assert.strictEqual(win.sent[0].ch, 'tool:directoryAccessRequired');
    assert.strictEqual(directory, '/data');
    assert.strictEqual(toolName, 'Read');
    dirMap.get(requestId).resolve(true);
    assert.strictEqual(await pending, true);
  });
});
```

Change the last assertion in `tests/ask-user-tool.test.js` (line 55), and add a second test after the existing one:

```js
    const { HEADLESS_ASK_USER_ERROR } = require('../src/platform/prompter');
    assert.strictEqual(result.tools[0].result.error, HEADLESS_ASK_USER_ERROR);
  });

  it('routes AskUser through an injected prompter', async () => {
    const mockProvider = {
      sendMessageWithTools: async () => ({ type: 'tool_use', toolName: 'AskUser', parameters: { question: 'Color?' } })
    };
    const mockExecutor = { execute: async () => ({ ok: true }) };
    const asked = [];
    const prompter = {
      askUser: async ({ question }) => { asked.push(question); return { ok: true, response: 'blue' }; },
      requestDirectoryAccess: async () => false
    };
    const loop = new AgentLoop(mockProvider, mockExecutor, { maxIterations: 1, prompter });
    const result = await loop.run([], [askUserTool.toFunctionDefinition()]);
    assert.deepStrictEqual(asked, ['Color?']);
    assert.deepStrictEqual(result.tools[0].result, { ok: true, response: 'blue' });
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/prompter.test.js tests/ask-user-tool.test.js`
Expected: FAIL with `Cannot find module '../src/platform/prompter'`

- [ ] **Step 3: Implement the prompters**

```js
// src/platform/prompter.js
// A prompter answers the agent loop's interactive questions (AskUser,
// directory access). Hosts inject one; with no interactive user, everything
// is denied.
const HEADLESS_ASK_USER_ERROR = 'No interactive user is available to answer questions (headless mode).';

function createHeadlessPrompter() {
  return {
    async askUser() {
      return { ok: false, error: HEADLESS_ASK_USER_ERROR };
    },
    async requestDirectoryAccess() {
      return false;
    }
  };
}

module.exports = { createHeadlessPrompter, HEADLESS_ASK_USER_ERROR };
```

```js
// src/platform/electron-prompter.js
// Renderer-backed prompter. The window and resolver maps are injected by
// main.js, so this module never requires electron.
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000;
const DIRECTORY_ACCESS_TIMEOUT_MS = 2 * 60 * 1000;

const newRequestId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function createElectronPrompter({ getWindow, pendingAskUserResolvers, pendingDirectoryAccessResolvers }) {
  const liveWindow = () => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    return win && !(typeof win.isDestroyed === 'function' && win.isDestroyed()) ? win : null;
  };

  return {
    askUser({ question }) {
      const win = liveWindow();
      if (!win) return Promise.resolve({ ok: false, error: 'No UI available to ask user.' });
      return new Promise((resolve) => {
        const requestId = newRequestId('ask');
        const timeoutId = setTimeout(() => {
          pendingAskUserResolvers.delete(requestId);
          resolve({ ok: false, error: 'User did not respond within 5 minutes.' });
        }, ASK_USER_TIMEOUT_MS);
        timeoutId.unref?.();
        pendingAskUserResolvers.set(requestId, {
          resolve: (userResponse) => {
            clearTimeout(timeoutId);
            resolve({ ok: true, response: userResponse });
          }
        });
        win.webContents.send('agent:askUser', { requestId, question });
      });
    },

    requestDirectoryAccess({ directory, toolName }) {
      const win = liveWindow();
      if (!win) return Promise.resolve(false);
      return new Promise((resolve) => {
        const requestId = newRequestId('diraccess');
        const timeoutId = setTimeout(() => {
          pendingDirectoryAccessResolvers.delete(requestId);
          resolve(false);
        }, DIRECTORY_ACCESS_TIMEOUT_MS);
        timeoutId.unref?.();
        pendingDirectoryAccessResolvers.set(requestId, {
          directory,
          resolve: (approved) => {
            clearTimeout(timeoutId);
            resolve(approved === true);
          }
        });
        win.webContents.send('tool:directoryAccessRequired', { requestId, directory, toolName });
      });
    }
  };
}

module.exports = { createElectronPrompter };
```

- [ ] **Step 4: Rewire `AgentLoop`**

In `src/execution/agent-loop.js`:
1. Add `const { createHeadlessPrompter } = require('../platform/prompter');` next to the other requires.
2. In the constructor, add `this.prompter = options.prompter || createHeadlessPrompter();`.
3. In the directory-access block (the `grantedPromise = new Promise((resolve) => { ... })` at ~lines 136–172), replace the whole `new Promise(...)` with:
   ```js
   grantedPromise = this.prompter
     .requestDirectoryAccess({ directory: dirToAllow, toolName })
     .catch(() => false);
   ```
   Keep the dedup map, the `.finally` cleanup, and everything after `const granted = await grantedPromise;` unchanged.
4. In the AskUser branch (~lines 466–500), replace the `toolResult = await new Promise(...)` block with:
   ```js
   toolResult = await this.prompter
     .askUser({ question })
     .catch((err) => ({ ok: false, error: err.message || String(err) }));
   ```
5. Confirm no `require('electron')` or `require('../../main')` remain in the file.

In `src/agents/agent-executor.js`:
- Store `this.prompter = options.prompter || null` in the constructor. Look at the constructor signature first; options is its third argument, as in `new AgentExecutor(provider, toolExecutor, { usageTracker })` in `main.js`.
- Add `prompter: this.prompter || undefined,` to the `new AgentLoop(...)` options at line 95.

In `src/ipc/chat-handlers.js`, add `prompter: context.prompter,` to the `new AgentLoop(provider, executor, {...})` options at line 454. Check how that file reads context values; it destructures `context` near the top of the handler registration, so follow that pattern.

In `main.js`:
- Add `const { createElectronPrompter } = require('./src/platform/electron-prompter');`.
- After the `pendingDirectoryAccessResolvers` declaration (~line 100), add:
  ```js
  const electronPrompter = createElectronPrompter({
    getWindow: () => mainWindow,
    pendingAskUserResolvers,
    pendingDirectoryAccessResolvers
  });
  ```
- In `agentExecutorAdapter.execute`, change `new AgentExecutor(runtime.provider, runtime.toolExecutor, { usageTracker })` to `{ usageTracker, prompter: electronPrompter }`.
- Add `prompter: electronPrompter,` to the `registerHandlers(ipcMain, {...})` object in the `// Tool` group.
- Delete the last two lines of `main.js` (the comment and `module.exports = { pendingAskUserResolvers, pendingDirectoryAccessResolvers };`).

In `tests/electron-boundary.test.js`, remove `'execution/agent-loop.js:electron'` and `'execution/agent-loop.js:main.js'` from `KNOWN_VIOLATIONS`.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/prompter.test.js tests/ask-user-tool.test.js tests/agent-loop.test.js tests/agent-executor.test.js tests/electron-boundary.test.js`
Expected: PASS

- [ ] **Step 6: Full suite and UI parity**

Run: `npm test`, then `npm run test:e2e` (with `ELECTRON_RUN_AS_NODE` unset)
Expected: `# fail 0` for both.

- [ ] **Step 7: Commit**

```bash
git add src/platform/prompter.js src/platform/electron-prompter.js src/execution/agent-loop.js src/agents/agent-executor.js src/ipc/chat-handlers.js main.js tests/prompter.test.js tests/ask-user-tool.test.js tests/electron-boundary.test.js
git commit -m "refactor(agent-loop): inject a prompter instead of reaching into Electron"
```

---

### Task 3: Cipher and vault ports; tools stop opening their own stores

**Files:**
- Create: `src/platform/cipher.js`, `src/platform/vault.js`
- Modify: `src/tools/builtin/vault-tool.js`, `src/tools/builtin/browser-tool.js` (`save_credentials`, `set_http_auth`, `fill_credentials`), `src/tools/builtin/web-search-tool.js`, `src/tools/builtin/image-generate-tool.js`
- Modify: `main.js`: `encryptToken`/`decryptToken` use the cipher; `extraToolOptions` gains `vault`, `getSettings`, `getProviderToken`
- Test: `tests/cipher.test.js`, `tests/vault.test.js`; extend `tests/web-search-tool.test.js`

**Interfaces:**
- Produces:
  - `Cipher` = `{ isEncryptionAvailable() → boolean, encryptString(plain: string) → string, decryptString(token: string) → string }`
  - `createAesGcmCipher(masterKey: Buffer /* 32 bytes */) → Cipher`, with token format `klc1:<iv b64>:<tag b64>:<ciphertext b64>`
  - `createSafeStorageCipher(safeStorage) → Cipher`, with token format `base64(safeStorage.encryptString(plain))` (unchanged on disk)
  - `createUnavailableCipher() → Cipher`; `isEncryptionAvailable()` is false and encrypt/decrypt throw `'Secure storage is not available on this system.'`
  - `VAULT_PREFIX = '__vault_'`
  - `createVault({ store, cipher }) → { set(key, value), get(key) → string|null, has(key) → boolean, delete(key) → boolean, list() → string[] }`
  - Tool execution context keys: `vault`, `getSettings()`, `getProviderToken(provider)`, `decryptToken(token)`. `encryptToken` stays for existing callers.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cipher.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createAesGcmCipher, createSafeStorageCipher, createUnavailableCipher } = require('../src/platform/cipher');

describe('AES-GCM cipher', () => {
  const key = crypto.randomBytes(32);

  it('round-trips and never repeats ciphertext', () => {
    const c = createAesGcmCipher(key);
    const a = c.encryptString('sk-secret');
    const b = c.encryptString('sk-secret');
    assert.notStrictEqual(a, b);
    assert.match(a, /^klc1:/);
    assert.strictEqual(c.decryptString(a), 'sk-secret');
    assert.strictEqual(c.isEncryptionAvailable(), true);
  });

  it('rejects tampering and wrong keys', () => {
    const c = createAesGcmCipher(key);
    const token = c.encryptString('x');
    const parts = token.split(':');
    const ct = Buffer.from(parts[3], 'base64'); ct[0] ^= 1; parts[3] = ct.toString('base64');
    assert.throws(() => c.decryptString(parts.join(':')));
    assert.throws(() => createAesGcmCipher(crypto.randomBytes(32)).decryptString(token));
  });

  it('rejects malformed input and bad keys', () => {
    assert.throws(() => createAesGcmCipher(Buffer.alloc(16)), /32-byte/);
    assert.throws(() => createAesGcmCipher(key).decryptString('nope'), /Unrecognized ciphertext/);
  });
});

describe('safeStorage cipher', () => {
  it('keeps the existing base64 on-disk format', () => {
    const fake = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc(${s})`),
      decryptString: (b) => b.toString().replace(/^enc\((.*)\)$/, '$1')
    };
    const c = createSafeStorageCipher(fake);
    const token = c.encryptString('abc');
    assert.strictEqual(token, Buffer.from('enc(abc)').toString('base64'));
    assert.strictEqual(c.decryptString(token), 'abc');
  });
});

describe('unavailable cipher', () => {
  it('throws the legacy message', () => {
    const c = createUnavailableCipher();
    assert.strictEqual(c.isEncryptionAvailable(), false);
    assert.throws(() => c.encryptString('x'), /Secure storage is not available on this system\./);
  });
});
```

```js
// tests/vault.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createVault, VAULT_PREFIX } = require('../src/platform/vault');
const { createAesGcmCipher } = require('../src/platform/cipher');

function memoryStore() {
  const data = {};
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    has: (k) => k in data,
    delete: (k) => { delete data[k]; },
    get store() { return { ...data }; },
    _data: data
  };
}

describe('vault', () => {
  it('stores ciphertext under the legacy prefix and lists bare keys', () => {
    const store = memoryStore();
    store.set('unrelated', 1);
    const vault = createVault({ store, cipher: createAesGcmCipher(crypto.randomBytes(32)) });
    vault.set('api_key', 'hunter2');
    assert.ok(store._data[`${VAULT_PREFIX}api_key`].startsWith('klc1:'));
    assert.strictEqual(vault.get('api_key'), 'hunter2');
    assert.deepStrictEqual(vault.list(), ['api_key']);
    assert.strictEqual(vault.has('api_key'), true);
    assert.strictEqual(vault.delete('api_key'), true);
    assert.strictEqual(vault.delete('api_key'), false);
    assert.strictEqual(vault.get('api_key'), null);
  });
});
```

Add a test to `tests/web-search-tool.test.js`:

```js
describe('WebSearch tool context', () => {
  it('reads settings and decrypts keys through the injected context', async () => {
    let decrypted = null;
    const context = {
      getSettings: () => ({ webSearch: { brave: { apiKey: 'enc-brave' } } }),
      decryptToken: (t) => { decrypted = t; return 'brave-key'; }
    };
    // The search itself fails without network; we only care that the right key path was taken.
    await WebSearchTool.execute({ query: 'x', maxResults: 1 }, context);
    assert.strictEqual(decrypted, 'enc-brave');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/cipher.test.js tests/vault.test.js tests/web-search-tool.test.js`
Expected: FAIL (module not found; `decrypted` is null)

- [ ] **Step 3: Implement the cipher and vault**

```js
// src/platform/cipher.js
const crypto = require('crypto');

const UNAVAILABLE = 'Secure storage is not available on this system.';
const AES_PREFIX = 'klc1';

function createAesGcmCipher(masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error('masterKey must be a 32-byte Buffer');
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [AES_PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
    },
    decryptString(token) {
      const parts = String(token || '').split(':');
      if (parts.length !== 4 || parts[0] !== AES_PREFIX) throw new Error('Unrecognized ciphertext format.');
      const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, 'base64')));
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    }
  };
}

function createSafeStorageCipher(safeStorage) {
  return {
    isEncryptionAvailable: () => Boolean(safeStorage && safeStorage.isEncryptionAvailable()),
    encryptString(plain) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(UNAVAILABLE);
      return safeStorage.encryptString(String(plain)).toString('base64');
    },
    decryptString(token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(UNAVAILABLE);
      return safeStorage.decryptString(Buffer.from(token, 'base64'));
    }
  };
}

function createUnavailableCipher() {
  const fail = () => { throw new Error(UNAVAILABLE); };
  return { isEncryptionAvailable: () => false, encryptString: fail, decryptString: fail };
}

module.exports = { createAesGcmCipher, createSafeStorageCipher, createUnavailableCipher };
```

```js
// src/platform/vault.js
// Named secrets stored as ciphertext in an ordinary key-value store.
// The prefix matches what the Vault tool has always written, so existing
// Electron vaults keep working.
const VAULT_PREFIX = '__vault_';

function createVault({ store, cipher }) {
  const storeKey = (key) => `${VAULT_PREFIX}${key}`;
  return {
    set(key, value) {
      store.set(storeKey(key), cipher.encryptString(value));
    },
    get(key) {
      const encrypted = store.get(storeKey(key));
      return encrypted ? cipher.decryptString(encrypted) : null;
    },
    has(key) {
      return store.has(storeKey(key));
    },
    delete(key) {
      if (!store.has(storeKey(key))) return false;
      store.delete(storeKey(key));
      return true;
    },
    list() {
      return Object.keys(store.store || {})
        .filter((k) => k.startsWith(VAULT_PREFIX))
        .map((k) => k.slice(VAULT_PREFIX.length));
    }
  };
}

module.exports = { createVault, VAULT_PREFIX };
```

- [ ] **Step 4: Rewire the tools**

`src/tools/builtin/vault-tool.js`:
- Delete `getStore()` and the `VAULT_STORE_PREFIX` constant.
- In `execute`, take `const { vault } = context || {};`. If `!vault`, return `{ ok: false, error: 'Vault is not available in this environment.' }`.
- `store`: `vault.set(key, value)`
- `retrieve`: `const v = vault.get(key); if (!v) return { ok:false, error:\`No secret found for key "${key}".\` }; return { ok:true, key, value:v };`
- `list`: `const keys = vault.list(); return { ok:true, keys, count: keys.length };`
- `delete`: `if (!vault.delete(key)) return { ok:false, error:\`No secret found for key "${key}".\` }; return { ok:true, message:\`Secret "${key}" deleted.\` };`
- Change the description sentence "Secrets are encrypted at rest via Electron safeStorage." to "Secrets are encrypted at rest."

`src/tools/builtin/browser-tool.js`: in `save_credentials`, `set_http_auth` and `fill_credentials`:
- Replace each `encryptToken`/`decryptToken` + `new Store()` pair with `const { vault } = ctx || {}; if (!vault) return { ok: false, error: 'Vault unavailable in this environment.' };`.
- `save_credentials`: `vault.set(vaultKeyFor(profile, host), JSON.stringify({ username, password }))`
- Readers: `const raw = vault.get(vaultKeyFor(profile, host)); if (!raw) return <existing "No credentials" error>; creds = JSON.parse(raw);`

`src/tools/builtin/web-search-tool.js`:
- Remove `require('electron')` and the `electron-store` import.
- `settings = typeof context?.getSettings === 'function' ? (context.getSettings() || {}) : {};`
- Make `decryptKey(encrypted, context)` use `context?.decryptToken` when it's a function, wrapped in try, falling back to returning `encrypted`. That keeps the old fallback, and matches how settings keys may be stored in plain text in tests.

`src/tools/builtin/image-generate-tool.js`:
- Same `decryptKey(encrypted, context)` change.
- `resolveProvider(settings, providerOverride, context)`: the OpenAI key comes from `context?.getProviderToken?.('openai')` inside try/catch. It is already decrypted, so don't call `decryptKey` on it.
- `execute` reads `settings` from `context.getSettings()` exactly as the web search tool does.
- Remove both `electron-store` imports and the `electron` require.

`main.js`:
- Add `const { createSafeStorageCipher } = require('./src/platform/cipher');` and `const { createVault } = require('./src/platform/vault');`.
- After `vaultStore` is created, add `const cipher = createSafeStorageCipher(safeStorage);` and `const vault = createVault({ store: vaultStore, cipher });`.
- Replace the bodies of `encryptToken`/`decryptToken` (lines 832–847) with:
  ```js
  const encryptToken = (token) => (token ? cipher.encryptString(token) : null);
  const decryptToken = (encrypted) => (encrypted ? cipher.decryptString(encrypted) : null);
  ```
- In `extraToolOptions` (≈ line 2108), add `vault,`, `getSettings,` and `getProviderToken: getDecryptedProviderToken,`.

In `tests/electron-boundary.test.js`, remove the `browser-tool`, `image-generate-tool`, `vault-tool` and `web-search-tool` entries.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/cipher.test.js tests/vault.test.js tests/web-search-tool.test.js tests/browser-tool.test.js tests/electron-boundary.test.js`
Expected: PASS

- [ ] **Step 6: Full suite and UI parity**

Run: `npm test` then `npm run test:e2e`
Expected: `# fail 0` for both. Then, by hand: `ELECTRON_RUN_AS_NODE= npm start` with your normal profile. Open Settings and confirm the providers show saved keys, and that a chat using the Vault tool (`list`) still sees existing secrets. This checks the on-disk format hasn't changed.

- [ ] **Step 7: Commit**

```bash
git add src/platform/cipher.js src/platform/vault.js src/tools/builtin/*.js main.js tests/cipher.test.js tests/vault.test.js tests/web-search-tool.test.js tests/electron-boundary.test.js
git commit -m "refactor(tools): cipher and vault ports; tools stop opening electron-store"
```

---

### Task 4: Remaining leaf injections (mesh, OAuth, desktop channel, toast)

**Files:**
- Modify: `src/mesh/index.js:52-61`, `src/auth/anthropic-oauth.js:3,12,106`, `src/channels/channel-plugin.js:97-130`, `src/notifications/channels/ui-toast.js`, `main.js` (constructors at 849, 2294, 2542)
- Test: `tests/leaf-injection.test.js`

**Interfaces:**
- Produces:
  - `initializeMesh({ ..., cipher })`. If `cipher?.isEncryptionAvailable()`, it stores `cipher.encryptString(privateKeyHex)` under `mesh.encryptedPrivateKey`. The cipher's output is already a string (see Task 3), so no extra base64.
  - `new AnthropicOAuth({ clientId, encryptToken, decryptToken, store, openExternal })`. `openExternal(url)` defaults to logging the URL at `info`.
  - `new DesktopChannelPlugin({ sendToUi })`, where `sendToUi(channel, payload)`.
  - `new UiToastChannel({ Notification })`. Without `Notification`, `send` returns `{ ok: false, skipped: true, reason: 'Desktop notifications are not available in this host.' }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/leaf-injection.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const UiToastChannel = require('../src/notifications/channels/ui-toast');
const { DesktopChannelPlugin } = require('../src/channels/channel-plugin');
const AnthropicOAuth = require('../src/auth/anthropic-oauth');

describe('UiToastChannel', () => {
  it('skips cleanly without an injected Notification', async () => {
    const r = await new UiToastChannel().send({ title: 't', body: 'b' });
    assert.deepStrictEqual(r, { ok: false, skipped: true, reason: 'Desktop notifications are not available in this host.' });
  });
  it('shows via the injected Notification class', async () => {
    const shown = [];
    class FakeNotification { constructor(o) { this.o = o; } static isSupported() { return true; } show() { shown.push(this.o); } }
    const r = await new UiToastChannel({ Notification: FakeNotification }).send({ title: 't', body: 'b' });
    assert.deepStrictEqual(r, { ok: true, channel: 'ui-toast' });
    assert.strictEqual(shown[0].title, 't');
  });
});

describe('DesktopChannelPlugin', () => {
  it('sends through the injected sendToUi', async () => {
    const sent = [];
    const plugin = new DesktopChannelPlugin({ sendToUi: (ch, p) => sent.push({ ch, p }) });
    assert.deepStrictEqual(await plugin.send('me', 'hello'), { status: 'sent' });
    assert.strictEqual(sent[0].ch, 'channel:message');
    assert.strictEqual(sent[0].p.message, 'hello');
  });
});

describe('AnthropicOAuth', () => {
  it('accepts an injected openExternal', () => {
    const opened = [];
    const oauth = new AnthropicOAuth({ clientId: 'c', encryptToken: (x) => x, decryptToken: (x) => x, store: { get: () => null, set() {}, delete() {} }, openExternal: (u) => opened.push(u) });
    assert.strictEqual(typeof oauth.openExternal, 'function');
    oauth.openExternal('https://example.com');
    assert.deepStrictEqual(opened, ['https://example.com']);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/leaf-injection.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

`src/notifications/channels/ui-toast.js`: replace the file with:

```js
class UiToastChannel {
  constructor({ Notification } = {}) {
    this.Notification = Notification || null;
  }

  async send(payload = {}) {
    const title = String(payload.title || 'King Louie');
    const body = String(payload.body || 'Task completed.');
    const Notification = this.Notification;

    if (!Notification) {
      return { ok: false, skipped: true, reason: 'Desktop notifications are not available in this host.' };
    }
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
      return { ok: false, skipped: true, reason: 'Desktop notifications are not supported on this system.' };
    }

    new Notification({ title, body, silent: false }).show();
    return { ok: true, channel: 'ui-toast' };
  }
}

module.exports = UiToastChannel;
```

`src/channels/channel-plugin.js`:
- `DesktopChannelPlugin` gets `constructor({ sendToUi } = {}) { super({...same...}); this.sendToUi = typeof sendToUi === 'function' ? sendToUi : null; }`.
- In `send`, replace the `BrowserWindow` lookup with `if (this.sendToUi) this.sendToUi('channel:message', { channel: 'desktop', target, message, media: options.media, buttons: options.buttons });`.

`src/auth/anthropic-oauth.js`:
- Delete line 3 (`require('electron')`).
- Add `createLogger` if it isn't already imported.
- The constructor accepts `openExternal` and stores `this.openExternal = typeof openExternal === 'function' ? openExternal : (url) => log.info(\`Open this URL to continue sign-in: ${url}\`);`.
- Line 106 becomes `this.openExternal(authUrl);`.

`src/mesh/index.js`:
- Add `cipher` to the destructured config.
- Replace lines 52–61 with:
  ```js
  if (cipher && cipher.isEncryptionAvailable()) {
    try {
      store.set('mesh.encryptedPrivateKey', cipher.encryptString(identity.privateKey.toString('hex')));
    } catch (err) {
      log.warn(`could not encrypt mesh private key: ${err.message}`);
    }
  }
  ```
  `createSafeStorageCipher` returns the same base64 string the old code wrote.

`main.js`:
- `const { app, BrowserWindow, ipcMain, safeStorage, shell, protocol, net, Notification } = require('electron');`
- `new AnthropicOAuth({ ..., openExternal: (url) => shell.openExternal(url) })`
- `new NotificationRouter({ getSettings: ..., uiToastChannel: new UiToastChannel({ Notification }) })`, with `const UiToastChannel = require('./src/notifications/channels/ui-toast');`
- `initializeMesh({ ..., cipher })`

In `tests/electron-boundary.test.js`, `KNOWN_VIOLATIONS` becomes `[]`. Keep the constant with an empty array and a comment: "Must stay empty. Inject the dependency instead."

- [ ] **Step 4: Run the tests**

Run: `node --test tests/leaf-injection.test.js tests/electron-boundary.test.js tests/channel-plugin.test.js tests/mesh-identity.test.js`
Expected: PASS

- [ ] **Step 5: Full suite and UI parity**

Run: `npm test` then `npm run test:e2e`. Expected `# fail 0`. `tests/e2e/settings-notifications.test.js` covers the toast path.

- [ ] **Step 6: Commit**

```bash
git add src/mesh/index.js src/auth/anthropic-oauth.js src/channels/channel-plugin.js src/notifications/channels/ui-toast.js main.js tests/leaf-injection.test.js tests/electron-boundary.test.js
git commit -m "refactor: inject cipher, openExternal, sendToUi and Notification; src/ is Electron-free"
```

---

### Task 5: Gateway authentication and webhook hardening

**Files:**
- Modify: `src/gateway/gateway-server.js`, `src/webhooks/webhook-server.js`
- Modify: `main.js` (gateway construction, ≈ line 2437)
- Test: `tests/gateway-server.test.js`, `tests/webhook-server.test.js`

**Interfaces:**
- Produces:
  - `new GatewayServer({ host, port, authToken })`. `start()` throws `'GatewayServer requires an authToken'` if `authToken` is missing, and throws `'GatewayServer only binds to loopback'` if `host` isn't `127.0.0.1`, `::1` or `localhost`.
  - Upgrade requests must send `Authorization: Bearer <authToken>` and no `Origin` header. Otherwise they get HTTP 401 (bad or missing token) or 403 (Origin present).
  - `WebhookServer` sends no CORS headers, answers `OPTIONS` with 405, and answers any request with an `Origin` header with 403.
  - `ensureGatewayToken({ store, cipher, dataDir }) → string` in `src/gateway/gateway-token.js`:
    - Reads `gateway.authToken` (ciphertext) from `store`; if missing, generates 32 random bytes as hex and stores it encrypted.
    - Writes it to `<dataDir>/gateway-token` with mode `0o600`.
    - Returns the plaintext.

- [ ] **Step 1: Write the failing tests**

```js
// tests/gateway-server.test.js
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const GatewayServer = require('../src/gateway/gateway-server');

let server;
afterEach(async () => { if (server) await server.stop(); server = null; });

function connect(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.once('open', () => { ws.close(); resolve('open'); });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.once('error', () => resolve('error'));
  });
}

describe('GatewayServer auth', () => {
  it('refuses to start without a token or on a non-loopback host', async () => {
    await assert.rejects(new GatewayServer({ port: 0 }).start(), /requires an authToken/);
    await assert.rejects(new GatewayServer({ port: 0, host: '0.0.0.0', authToken: 't' }).start(), /only binds to loopback/);
  });

  it('accepts the right bearer token and rejects everything else', async () => {
    server = new GatewayServer({ port: 0, authToken: 'secret-token' });
    await server.start();
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer secret-token' }), 'open');
    assert.strictEqual(await connect(server.port, {}), 401);
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer wrong' }), 401);
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer secret-token', Origin: 'https://evil.example' }), 403);
  });
});
```

```js
// tests/webhook-server.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebhookServer = require('../src/webhooks/webhook-server');

function request(port, { method = 'GET', path = '/health', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('WebhookServer hardening', () => {
  const server = new WebhookServer({ port: 0 }, { handle: async () => ({ ok: true }) });
  before(() => server.start());
  after(() => server.stop());

  it('serves health without CORS headers', async () => {
    const r = await request(server.port);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
  });
  it('rejects browser-originated requests', async () => {
    assert.strictEqual((await request(server.port, { headers: { Origin: 'https://evil.example' } })).status, 403);
  });
  it('rejects preflight', async () => {
    assert.strictEqual((await request(server.port, { method: 'OPTIONS' })).status, 405);
  });
});
```

Add `tests/gateway-token.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ensureGatewayToken } = require('../src/gateway/gateway-token');
const { createAesGcmCipher } = require('../src/platform/cipher');

describe('ensureGatewayToken', () => {
  it('creates once, stores ciphertext, writes a private token file', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gw-'));
    const data = {};
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v; } };
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    const t1 = ensureGatewayToken({ store, cipher, dataDir });
    const t2 = ensureGatewayToken({ store, cipher, dataDir });
    assert.match(t1, /^[0-9a-f]{64}$/);
    assert.strictEqual(t1, t2);
    assert.ok(data['gateway.authToken'].startsWith('klc1:'));
    const file = path.join(dataDir, 'gateway-token');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), t1);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o077, 0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/gateway-server.test.js tests/webhook-server.test.js tests/gateway-token.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

`src/gateway/gateway-server.js`:
- Add `const crypto = require('crypto');` and `const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);`.
- In the constructor, add `this.authToken = config.authToken || null;`.
- At the top of `start()`, before creating the server:
  ```js
  if (!this.authToken) throw new Error('GatewayServer requires an authToken');
  if (!LOOPBACK.has(this.host)) throw new Error('GatewayServer only binds to loopback');
  const expected = crypto.createHash('sha256').update(this.authToken).digest();
  ```
- Construct the server with `verifyClient`:
  ```js
  this.wss = new WebSocket.Server({
    host: this.host,
    port: this.port,
    verifyClient: ({ req }, done) => {
      if (req.headers.origin) return done(false, 403, 'Forbidden');
      const header = String(req.headers.authorization || '');
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(presented).digest(), expected);
      return ok ? done(true) : done(false, 401, 'Unauthorized');
    }
  });
  ```

`src/gateway/gateway-token.js`:

```js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_KEY = 'gateway.authToken';

function ensureGatewayToken({ store, cipher, dataDir }) {
  let token = null;
  const stored = store.get(STORE_KEY);
  if (stored) {
    try { token = cipher.decryptString(stored); } catch { token = null; }
  }
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    store.set(STORE_KEY, cipher.encryptString(token));
  }
  const file = path.join(dataDir, 'gateway-token');
  fs.writeFileSync(file, token, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return token;
}

module.exports = { ensureGatewayToken, STORE_KEY };
```

`src/webhooks/webhook-server.js`, in `handleHttpRequest`:
- Delete the three `Access-Control-*` `setHeader` lines and the OPTIONS block.
- Insert at the top:
  ```js
  if (req.headers.origin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Browser-originated requests are not accepted' }));
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(405);
    res.end();
    return;
  }
  ```

`main.js`, where `gatewayServer` is constructed:
- Add `authToken: ensureGatewayToken({ store, cipher, dataDir: app.getPath('userData') })`.
- Add `const { ensureGatewayToken } = require('./src/gateway/gateway-token');` at the top.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/gateway-server.test.js tests/webhook-server.test.js tests/gateway-token.test.js tests/webhook-handler.test.js tests/mesh-remote-control.test.js`
Expected: PASS

- [ ] **Step 5: Full suite and UI parity**

Run: `npm test` then `npm run test:e2e`, expecting `# fail 0`. `tests/e2e/settings-webhooks.test.js` exercises the webhook UI. If that e2e test fetches the webhook URL from renderer code, which sends an `Origin` header, it will now get a 403. That case is exactly what this task blocks. Change the test to send its request from Node (the e2e helper process), not the page, and say so in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/gateway-server.js src/gateway/gateway-token.js src/webhooks/webhook-server.js main.js tests/gateway-server.test.js tests/webhook-server.test.js tests/gateway-token.test.js
git commit -m "fix(security): require a bearer token on the gateway; block browser-originated gateway/webhook requests"
```

---

### Task 6: Service-host platform ports (JSON store, paths, master key)

**Files:**
- Create: `src/platform/json-file-store.js`, `src/platform/paths.js`, `src/platform/master-key.js`
- Test: `tests/json-file-store.test.js`, `tests/service-paths.test.js`, `tests/master-key.test.js`

**Interfaces:**
- Produces:
  - `new JsonFileStore({ dir, name = 'config', defaults = {} })` with:
    - `.get(key, defaultValue)`, where a dot path is read as nested (electron-store semantics)
    - `.set(key, value)` or `.set(object)`
    - `.has(key)`, `.delete(key)`, `.clear()`
    - `.store` (a deep copy), `.path`
    - The file is `<dir>/<name>.json`, written atomically (temp + rename) with mode `0o600`.
  - `defaultServiceDataDir({ platform = process.platform, env = process.env }) → string`
  - `ensureServicePaths(dataDir) → { dataDir, logsDir, cacheDir }`: creates them with mode `0o700`.
  - `resolveMasterKey({ platform, dataDir, env, dpapi }) → { key: Buffer(32), source: 'systemd-credential' | 'dpapi' | 'key-file' }`
  - `createPowerShellDpapi() → { protect(buf) → Buffer, unprotect(buf) → Buffer }` (win32 only; CurrentUser scope)
  - `MASTER_KEY_CREDENTIAL = 'kl-master-key'`

- [ ] **Step 1: Write the failing tests**

```js
// tests/json-file-store.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-store-'));

describe('JsonFileStore', () => {
  it('supports electron-store get/set semantics including dot paths and defaults', () => {
    const dir = tmp();
    const s = new JsonFileStore({ dir, name: 'chat-data', defaults: { chats: [], settings: { a: 1 } } });
    assert.deepStrictEqual(s.get('chats'), []);
    assert.strictEqual(s.get('missing', 'fallback'), 'fallback');
    s.set('mesh.identity', { id: 'x' });
    assert.deepStrictEqual(s.get('mesh.identity'), { id: 'x' });
    assert.deepStrictEqual(s.get('mesh'), { identity: { id: 'x' } });
    s.set({ activeChatId: 'c1' });
    assert.strictEqual(s.get('activeChatId'), 'c1');
    assert.strictEqual(s.has('mesh.identity'), true);
    s.delete('mesh.identity');
    assert.strictEqual(s.has('mesh.identity'), false);
    assert.strictEqual(s.path, path.join(dir, 'chat-data.json'));
  });

  it('persists across instances and writes privately', () => {
    const dir = tmp();
    new JsonFileStore({ dir }).set('k', 'v');
    assert.strictEqual(new JsonFileStore({ dir }).get('k'), 'v');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.join(dir, 'config.json')).mode & 0o077, 0);
    }
  });

  it('returns copies, not live references', () => {
    const s = new JsonFileStore({ dir: tmp() });
    s.set('obj', { n: 1 });
    s.get('obj').n = 2;
    assert.strictEqual(s.get('obj').n, 1);
  });
});
```

```js
// tests/service-paths.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultServiceDataDir, ensureServicePaths } = require('../src/platform/paths');

describe('service paths', () => {
  it('uses OS-appropriate system locations', () => {
    assert.strictEqual(defaultServiceDataDir({ platform: 'linux', env: {} }), '/var/lib/king-louie');
    assert.strictEqual(defaultServiceDataDir({ platform: 'darwin', env: {} }), '/Library/Application Support/KingLouie');
    assert.strictEqual(defaultServiceDataDir({ platform: 'win32', env: { ProgramData: 'D:\\PD' } }), path.win32.join('D:\\PD', 'KingLouie'));
    assert.strictEqual(defaultServiceDataDir({ platform: 'win32', env: {} }), path.win32.join('C:\\ProgramData', 'KingLouie'));
  });

  it('creates private data, logs and cache dirs', () => {
    const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-paths-')), 'data');
    const p = ensureServicePaths(base);
    for (const d of [p.dataDir, p.logsDir, p.cacheDir]) assert.ok(fs.statSync(d).isDirectory());
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(p.dataDir).mode & 0o077, 0);
  });
});
```

```js
// tests/master-key.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveMasterKey, MASTER_KEY_CREDENTIAL } = require('../src/platform/master-key');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mk-'));

describe('resolveMasterKey', () => {
  it('prefers a systemd credential', () => {
    const credDir = tmp();
    const hex = 'ab'.repeat(32);
    fs.writeFileSync(path.join(credDir, MASTER_KEY_CREDENTIAL), hex);
    const r = resolveMasterKey({ platform: 'linux', dataDir: tmp(), env: { CREDENTIALS_DIRECTORY: credDir } });
    assert.strictEqual(r.source, 'systemd-credential');
    assert.strictEqual(r.key.toString('hex'), hex);
  });

  it('creates then reuses a private key file on posix', { skip: process.platform === 'win32' }, () => {
    const dataDir = tmp();
    const a = resolveMasterKey({ platform: process.platform, dataDir, env: {} });
    const b = resolveMasterKey({ platform: process.platform, dataDir, env: {} });
    assert.strictEqual(a.source, 'key-file');
    assert.ok(a.key.equals(b.key));
    assert.strictEqual(fs.statSync(path.join(dataDir, 'master.key')).mode & 0o077, 0);
  });

  it('refuses a key file readable by others', { skip: process.platform === 'win32' }, () => {
    const dataDir = tmp();
    fs.writeFileSync(path.join(dataDir, 'master.key'), 'cd'.repeat(32), { mode: 0o644 });
    fs.chmodSync(path.join(dataDir, 'master.key'), 0o644);
    assert.throws(() => resolveMasterKey({ platform: process.platform, dataDir, env: {} }), /permissions/);
  });

  it('wraps the key with DPAPI on Windows (fake DPAPI)', () => {
    const dataDir = tmp();
    const dpapi = { protect: (b) => Buffer.concat([Buffer.from('P:'), b]), unprotect: (b) => b.subarray(2) };
    const a = resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi });
    const b = resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi });
    assert.strictEqual(a.source, 'dpapi');
    assert.ok(a.key.equals(b.key));
    assert.ok(fs.readFileSync(path.join(dataDir, 'master.key.dpapi')).subarray(0, 2).equals(Buffer.from('P:')));
  });

  it('round-trips real DPAPI', { skip: process.platform !== 'win32' }, () => {
    const { createPowerShellDpapi } = require('../src/platform/master-key');
    const dpapi = createPowerShellDpapi();
    const secret = Buffer.from('0123456789abcdef');
    assert.ok(dpapi.unprotect(dpapi.protect(secret)).equals(secret));
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/json-file-store.test.js tests/service-paths.test.js tests/master-key.test.js`
Expected: FAIL (modules not found)

- [ ] **Step 3: Implement**

```js
// src/platform/json-file-store.js
// A small, dependency-free subset of electron-store's API for the headless
// service: dot-path get/set, top-level defaults, atomic private writes.
const fs = require('fs');
const path = require('path');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class JsonFileStore {
  constructor({ dir, name = 'config', defaults = {} }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = path.join(dir, `${name}.json`);
    this._defaults = clone(defaults) || {};
    this._data = null;
  }

  _load() {
    if (this._data) return this._data;
    let onDisk = {};
    try {
      onDisk = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${this.path}: ${err.message}`);
    }
    this._data = { ...clone(this._defaults), ...onDisk };
    return this._data;
  }

  _save() {
    const tmp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.path);
    if (process.platform !== 'win32') fs.chmodSync(this.path, 0o600);
  }

  get(key, defaultValue) {
    let node = this._load();
    for (const part of String(key).split('.')) {
      if (node === null || typeof node !== 'object' || !(part in node)) return defaultValue;
      node = node[part];
    }
    return node === undefined ? defaultValue : clone(node);
  }

  set(key, value) {
    const data = this._load();
    if (key && typeof key === 'object') {
      Object.assign(data, clone(key));
    } else {
      const parts = String(key).split('.');
      let node = data;
      for (const part of parts.slice(0, -1)) {
        if (node[part] === null || typeof node[part] !== 'object') node[part] = {};
        node = node[part];
      }
      node[parts[parts.length - 1]] = clone(value);
    }
    this._save();
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    const parts = String(key).split('.');
    let node = this._load();
    for (const part of parts.slice(0, -1)) {
      if (node === null || typeof node !== 'object') return;
      node = node[part];
    }
    if (node && typeof node === 'object') {
      delete node[parts[parts.length - 1]];
      this._save();
    }
  }

  clear() {
    this._data = clone(this._defaults) || {};
    this._save();
  }

  get store() {
    return clone(this._load());
  }
}

module.exports = { JsonFileStore };
```

```js
// src/platform/paths.js
const fs = require('fs');
const path = require('path');

function defaultServiceDataDir({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return path.win32.join(env.ProgramData || 'C:\\ProgramData', 'KingLouie');
  if (platform === 'darwin') return '/Library/Application Support/KingLouie';
  return '/var/lib/king-louie';
}

function ensureServicePaths(dataDir) {
  const paths = {
    dataDir,
    logsDir: path.join(dataDir, 'logs'),
    cacheDir: path.join(dataDir, 'cache')
  };
  for (const dir of Object.values(paths)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  }
  return paths;
}

module.exports = { defaultServiceDataDir, ensureServicePaths };
```

```js
// src/platform/master-key.js
// The service host encrypts secrets with one AES-256-GCM master key. The key
// itself is protected by the OS: a systemd credential (Linux), DPAPI in the
// service account's scope (Windows), or a 0600 file owned by the service
// account (macOS / Linux without systemd credentials).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MASTER_KEY_CREDENTIAL = 'kl-master-key';
const KEY_BYTES = 32;

function parseHexKey(text, origin) {
  const hex = String(text).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${origin} is not a 64-character hex key`);
  return Buffer.from(hex, 'hex');
}

function fromSystemdCredential(env) {
  if (!env.CREDENTIALS_DIRECTORY) return null;
  const file = path.join(env.CREDENTIALS_DIRECTORY, MASTER_KEY_CREDENTIAL);
  if (!fs.existsSync(file)) return null;
  return parseHexKey(fs.readFileSync(file, 'utf8'), `systemd credential ${MASTER_KEY_CREDENTIAL}`);
}

function fromDpapiFile(dataDir, dpapi) {
  const file = path.join(dataDir, 'master.key.dpapi');
  if (fs.existsSync(file)) return dpapi.unprotect(fs.readFileSync(file));
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, dpapi.protect(key), { flag: 'wx' });
  return key;
}

function fromKeyFile(dataDir) {
  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) throw new Error(`${file} has permissions ${mode.toString(8)}; it must be 600`);
    return parseHexKey(fs.readFileSync(file, 'utf8'), file);
  }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return key;
}

function createPowerShellDpapi() {
  const run = (method, input) => {
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
      `$out = [System.Security.Cryptography.ProtectedData]::${method}($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
      '[Console]::Out.Write([Convert]::ToBase64String($out))'
    ].join('; ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: input.toString('base64'),
      windowsHide: true
    });
    return Buffer.from(out.toString().trim(), 'base64');
  };
  return { protect: (buf) => run('Protect', buf), unprotect: (buf) => run('Unprotect', buf) };
}

function resolveMasterKey({ platform = process.platform, dataDir, env = process.env, dpapi } = {}) {
  const fromCred = fromSystemdCredential(env);
  if (fromCred) return { key: fromCred, source: 'systemd-credential' };
  if (platform === 'win32') {
    return { key: fromDpapiFile(dataDir, dpapi || createPowerShellDpapi()), source: 'dpapi' };
  }
  return { key: fromKeyFile(dataDir), source: 'key-file' };
}

module.exports = { resolveMasterKey, createPowerShellDpapi, MASTER_KEY_CREDENTIAL };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/json-file-store.test.js tests/service-paths.test.js tests/master-key.test.js`
Expected: PASS. On Windows the real-DPAPI test runs; elsewhere it's skipped.

- [ ] **Step 5: Commit**

```bash
git add src/platform/json-file-store.js src/platform/paths.js src/platform/master-key.js tests/json-file-store.test.js tests/service-paths.test.js tests/master-key.test.js
git commit -m "feat(platform): JSON file store, service paths and OS-protected master key"
```

---

### Task 7: Move the settings defaults into `src/core/settings.js`

**Files:**
- Create: `src/core/settings.js`
- Modify: `main.js`: delete lines 141–338 (`DEFAULT_SETTINGS`, `mergeSettings`) and import them instead
- Test: `tests/core-settings.test.js`

**Interfaces:**
- Produces: `DEFAULT_SETTINGS` (object) and `mergeSettings(settings) → settings` in `src/core/settings.js`, byte-for-byte the same logic as `main.js:141-338`. It requires `DEFAULT_NOTIFICATION_SETTINGS` and `normalizeNotificationSettings` from `../notifications/notification-router`, and `DEFAULT_VOICE_SETTINGS` from `../voice/tts-engine`, exactly as `main.js` does.

- [ ] **Step 1: Write the failing test**

```js
// tests/core-settings.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DEFAULT_SETTINGS, mergeSettings } = require('../src/core/settings');

describe('core settings', () => {
  it('fills nested defaults without dropping user values', () => {
    const merged = mergeSettings({ activeProvider: 'anthropic', providerModels: { openai: 'custom' }, checkpoints: { enabled: true } });
    assert.strictEqual(merged.activeProvider, 'anthropic');
    assert.strictEqual(merged.providerModels.openai, 'custom');
    assert.strictEqual(merged.providerModels.anthropic, DEFAULT_SETTINGS.providerModels.anthropic);
    assert.strictEqual(merged.checkpoints.enabled, true);
    assert.strictEqual(merged.checkpoints.maxAgeDays, 14);
    assert.deepStrictEqual(merged.allowedDirectories, []);
  });

  it('treats null as empty', () => {
    assert.strictEqual(mergeSettings(null).activeProvider, DEFAULT_SETTINGS.activeProvider);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/core-settings.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Move the code**

Create `src/core/settings.js` with:
- the two requires above;
- `main.js` lines 141–338 copied **verbatim**;
- `module.exports = { DEFAULT_SETTINGS, mergeSettings };`.

In `main.js`, delete lines 141–338 and add `const { DEFAULT_SETTINGS, mergeSettings } = require('./src/core/settings');` after the other requires. If `DEFAULT_NOTIFICATION_SETTINGS`, `normalizeNotificationSettings` and `DEFAULT_VOICE_SETTINGS` are still used elsewhere in `main.js`, leave their imports there. Check with grep.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/core-settings.test.js tests/settings-provider.test.js tests/settings-handlers.test.js` then `npm test`
Expected: PASS / `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/core/settings.js main.js tests/core-settings.test.js
git commit -m "refactor(core): move settings defaults and merge out of main.js"
```

---

### Task 8: `createCore(deps)`: extract the wiring from `main.js`

This is the big mechanical move. **Move code; don't rewrite it.** Every substitution is listed below, and anything not listed stays byte-identical.

**Files:**
- Create: `src/core/create-core.js`, `src/core/index.js`
- Modify: `main.js` (shrinks to Electron glue)
- Test: `tests/core-create.test.js`

**Interfaces:**
- Consumes:
  - `createHeadlessPrompter` (Task 2)
  - `createVault` and the `Cipher` shape (Task 3)
  - `ensureGatewayToken` (Task 5)
  - `JsonFileStore` (Task 6, test only)
  - `DEFAULT_SETTINGS` and `mergeSettings` (Task 7)
- Produces: `createCore(deps) → core`. The call is **synchronous** and does no I/O beyond what the stores do lazily. `deps` is:
  ```js
  {
    paths: { dataDir },                 // required
    store,                              // electron-store-like, the 'chat-data' store
    vaultStore,                         // electron-store-like, the default store
    cipher,                             // Cipher
    prompter,                           // Prompter
    ui: { send(channel, payload) {}, reportError(message, stack) {} },   // optional, no-ops by default
    openExternal: (url) => {},          // optional
    uiToastChannel,                     // optional, passed to NotificationRouter
    builtinSkillsDir,                   // absolute path to the repo's skills/ dir
    features: {                         // all default true, preserving Electron behaviour
      gateway: true, webhooks: true, mesh: true, channels: true, appDiscovery: true
    }
  }
  ```
  `core` has:
  - `core.context`: the plain object `main.js` passed to `registerHandlers`, **minus** the Electron-only keys `safeStorage`, `getMainWindow`, `getShell`, `pendingAskUserResolvers`, `pendingDirectoryAccessResolvers` and `prompter`. `main.js` adds those back.
  - `core.pendingApprovalResolvers`, `core.pendingCanvasJsResolvers`: the Maps previously at `main.js:98,101`.
  - `core.start() → Promise<void>`: `initializeTools()` plus the old `initializeAgentInfrastructure()` plus the taskManager and mesh event forwarding that followed it in `app.whenReady` (lines 2923–2939 and 2951–2983 before Task 7's line shift). All forwarding goes through `ui.send`.
  - `core.shutdown() → Promise<void>`: the body of the old `window-all-closed` handler **except** `app.quit()`. It awaits each stop with `Promise.allSettled` instead of fire-and-forget, and logs each rejection with the same message it had before.
  - `core.getMeshContext()`, `core.getSettings()`, `core.saveProviderToken(provider, token)`, `core.vault`.

- [ ] **Step 1: Write the failing test**

```js
// tests/core-create.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

function makeDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-core-'));
  const sent = [];
  return {
    sent,
    deps: {
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: (ch, p) => sent.push({ ch, p }) },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    }
  };
}

describe('createCore', () => {
  it('constructs synchronously and exposes settings and token helpers before start()', () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    assert.strictEqual(typeof core.getSettings().activeProvider, 'string');
    core.saveProviderToken('openai', 'sk-test');
    assert.ok(deps.store.get('apiTokens').openai.startsWith('klc1:'));
    core.vault.set('k', 'v');
    assert.strictEqual(core.vault.get('k'), 'v');
    assert.strictEqual(typeof core.context.getChats, 'function');
    assert.strictEqual(core.context.safeStorage, undefined);
  });

  it('starts headless with every optional feature off, then shuts down cleanly', async () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    await core.start();
    assert.ok(core.context.toolRegistry.getFunctionDefinitions().length > 10);
    assert.strictEqual(core.getMeshContext(), null);
    await core.shutdown();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/core-create.test.js`
Expected: FAIL (`Cannot find module '../src/core'`)

- [ ] **Step 3: Create the skeleton**

```js
// src/core/index.js
const { createCore } = require('./create-core');
const { DEFAULT_SETTINGS, mergeSettings } = require('./settings');
module.exports = { createCore, DEFAULT_SETTINGS, mergeSettings };
```

`src/core/create-core.js` starts like this. Every module the moved code uses gets required at the top with a path relative to `src/core/`; for example, `./src/tools` becomes `../tools`.

```js
const fs = require('fs');
const os = require('os');
const path = require('path');
// …every require that main.js lines 12–84 need, except 'electron' and 'electron-store',
//   rewritten from './src/x' to '../x' …
const { DEFAULT_SETTINGS, mergeSettings } = require('./settings');
const { createVault } = require('../platform/vault');
const { ensureGatewayToken } = require('../gateway/gateway-token');
const { createHeadlessPrompter } = require('../platform/prompter');

const DEFAULT_FEATURES = { gateway: true, webhooks: true, mesh: true, channels: true, appDiscovery: true };

function createCore(deps = {}) {
  const { paths, store, vaultStore, cipher } = deps;
  if (!paths?.dataDir || !store || !vaultStore || !cipher) {
    throw new Error('createCore requires paths.dataDir, store, vaultStore and cipher');
  }
  const prompter = deps.prompter || createHeadlessPrompter();
  const ui = { send() {}, reportError() {}, ...(deps.ui || {}) };
  const features = { ...DEFAULT_FEATURES, ...(deps.features || {}) };
  const vault = createVault({ store: vaultStore, cipher });
  const userDataPath = paths.dataDir;

  // ── moved from main.js (see Task 8, Step 4) ──

  return { /* see Step 5 */ };
}

module.exports = { createCore };
```

- [ ] **Step 4: Move the code into the `createCore` closure**

Cut these regions from `main.js`, in order, and paste them inside `createCore` where the `// ── moved` comment is. The line numbers are from *before* Task 7 deleted lines 141–338; use the named declarations to find the current positions.

| Region (by declaration) | Notes |
|---|---|
| `const log = createLogger('main')` through the `let discoveredApps = [];` block and the `*_TOKEN_STORE_KEY` constants (old 86–139) | **Keep `let mainWindow;` in `main.js`.** Move the `pending*Resolvers` Maps, except `pendingAskUserResolvers` and `pendingDirectoryAccessResolvers`, which stay in `main.js` with the Electron prompter |
| `const createId` through `const removePermissionRule` (old 358–555) | |
| `providerLabels` through `runHookEvent` (old 557–830) | |
| `encryptToken`, `decryptToken`, `anthropicOAuth` … through `runLlmCommand` (old 832–2077) | |
| `createToolExecutorWithApprovals` through `initializeAgentInfrastructure` (old 2079–2703) | |

**Not moved** (stays in `main.js`): `createWindow`, the `registerHandlers(...)` call, `ipcMain.on('canvas:executeJsResult', …)`, `app.whenReady` and `app.on(...)`, `protocol` registration.

Apply **only** these substitutions inside the moved code:

1. `app.getPath('userData')` → `userDataPath`, everywhere.
2. `new Store()` / `new Store({ name: 'chat-data', … })` (the `vaultStore` and `store` declarations): **delete** these declarations, since `store` and `vaultStore` come from `deps`. Move the `defaults` object that was passed to the `chat-data` store into a `CHAT_DATA_DEFAULTS` export of `src/core/settings.js`. `main.js` now builds `new Store({ name: 'chat-data', defaults: CHAT_DATA_DEFAULTS })`.
3. `encryptToken`/`decryptToken`: use the Task 3 bodies (`cipher.encryptString` / `cipher.decryptString`).
4. `safeStorage.isEncryptionAvailable()` (old lines 1512, 1918, 2000) → `cipher.isEncryptionAvailable()`.
5. `new AnthropicOAuth({... openExternal: (url) => shell.openExternal(url) })` → `openExternal: deps.openExternal`.
6. Every `if (mainWindow) { mainWindow.webContents.send(X, Y); }` or `if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.send(X, Y); }` → `ui.send(X, Y);`. That covers the bridges' `chat:updated`, `backgroundTask:completed` and the workflow event loop.
7. The mesh-failure `mainWindow.webContents.executeJavaScript(...)` block → `ui.reportError(err.message, err.stack);`.
8. `new NotificationRouter({ getSettings: … })` → add `uiToastChannel: deps.uiToastChannel`.
9. `path.join(__dirname, 'skills')` → `deps.builtinSkillsDir`.
10. `new AgentExecutor(runtime.provider, runtime.toolExecutor, { usageTracker, prompter: electronPrompter })` → `prompter` (the closure variable).
11. `initializeMesh({ … })` stays as is (the `cipher` is already in scope), but is wrapped in `if (features.mesh) { … } else { meshContext = null; }`.
12. `discoverAllApps({ force: true }).then(…)` is wrapped in `if (features.appDiscovery) { … }`.
13. The `gatewayServer = new GatewayServer(...)` construction always happens, because tools and remote control reference it. Only `gatewayServer.start()` inside the `Promise.all([...])` becomes `features.gateway ? gatewayServer.start() : Promise.resolve()`. `authToken` is computed with `ensureGatewayToken({ store, cipher, dataDir: userDataPath })` only when `features.gateway` is on; otherwise pass `authToken: 'disabled'`.
14. `webhookServer.start().catch(...)` is wrapped in `if (features.webhooks) { … }`.
15. `deferChannels();` → `if (features.channels) deferChannels();`.
16. `const openaiApiKey = getDecryptedProviderToken('openai');` in `initializeAgentInfrastructure` becomes:
    ```js
    let openaiApiKey = '';
    try { openaiApiKey = getDecryptedProviderToken('openai'); } catch { openaiApiKey = ''; }
    ```
    Without an OpenAI token the old line throws "No token saved for OpenAI.", and the headless test starts with no tokens.
17. The Maps `pendingApprovalResolvers` and `pendingCanvasJsResolvers` stay inside the closure and are returned (Step 5).

Then add `start` and `shutdown` inside the closure:

```js
  const start = async () => {
    initializeTools();
    await initializeAgentInfrastructure();
    const TASK_EVENTS = { taskCreated: 'task:created', taskUpdated: 'task:updated', taskUnblocked: 'task:unblocked' };
    for (const [evt, channel] of Object.entries(TASK_EVENTS)) {
      taskManager.on(evt, (task) => ui.send(channel, task));
    }
    if (meshContext) {
      meshContext.transport.on('peerConnected', (peer) => ui.send('mesh:peerConnected', {
        peerId: peer.peerId, displayName: peer.displayName, capabilities: peer.capabilities
      }));
      meshContext.transport.on('peerDisconnected', (info) => ui.send('mesh:peerDisconnected', {
        peerId: info.peerId, reason: info.reason
      }));
      meshContext.remoteControl.on('taskCompleted', (info) => ui.send('mesh:taskCompleted', info));
      meshContext.remoteControl.on('taskFailed', (info) => ui.send('mesh:taskFailed', info));
    }
  };

  const shutdown = async () => {
    await runHookEvent('SessionEnd', { source: 'main', endedAt: new Date().toISOString(), workingDirectory: process.cwd() })
      .catch((err) => log.warn(`SessionEnd hook failed: ${err.message}`));
    const stops = [
      ['MCP shutdown', mcpManager && (() => mcpManager.disconnectAll())],
      ['Channel shutdown', channelRegistry && (() => channelRegistry.shutdownAll())],
      ['Webhook server stop', webhookServer && (() => webhookServer.stop())],
      ['Mesh shutdown', meshContext && (() => meshContext.shutdown())],
      ['Gateway server stop', gatewayServer && (() => gatewayServer.stop())]
    ].filter(([, fn]) => fn);
    const results = await Promise.allSettled(stops.map(([, fn]) => fn()));
    results.forEach((r, i) => { if (r.status === 'rejected') log.warn(`${stops[i][0]} failed: ${r.reason?.message}`); });
    if (usageTracker) usageTracker.reset();
    if (cronScheduler) cronScheduler.stop();
  };
```

- [ ] **Step 5: Return the core object**

At the end of the closure, return `context`: the object literal that was the second argument of `registerHandlers(ipcMain, {...})` in `main.js`, **copied here and with these keys removed**:
- `safeStorage`
- `getMainWindow`
- `getShell`
- `pendingAskUserResolvers`
- `pendingDirectoryAccessResolvers`
- `prompter`

Add `vault` to it. Then:

```js
  return {
    context,
    pendingApprovalResolvers,
    pendingCanvasJsResolvers,
    start,
    shutdown,
    vault,
    getSettings,
    saveProviderToken,
    getMeshContext: () => meshContext
  };
```

- [ ] **Step 6: Rewrite `main.js` as Electron glue**

`main.js` now contains only:

```js
const { app, BrowserWindow, ipcMain, safeStorage, shell, protocol, net, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SCREENSHOT_DIR = path.join(os.tmpdir(), 'king-louie-screenshots');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kl-screenshot', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const { default: Store } = require('electron-store');
const { registerHandlers } = require('./src/ipc/register');
const { createCore } = require('./src/core');
const { CHAT_DATA_DEFAULTS } = require('./src/core/settings');
const { createSafeStorageCipher } = require('./src/platform/cipher');
const { createElectronPrompter } = require('./src/platform/electron-prompter');
const UiToastChannel = require('./src/notifications/channels/ui-toast');
const { createLogger } = require('./src/logging');

const log = createLogger('main');

let mainWindow;
const pendingAskUserResolvers = new Map();
const pendingDirectoryAccessResolvers = new Map();
const electronPrompter = createElectronPrompter({
  getWindow: () => mainWindow,
  pendingAskUserResolvers,
  pendingDirectoryAccessResolvers
});

const sendToWindow = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

const core = createCore({
  paths: { dataDir: app.getPath('userData') },
  store: new Store({ name: 'chat-data', defaults: CHAT_DATA_DEFAULTS }),
  vaultStore: new Store(),
  cipher: createSafeStorageCipher(safeStorage),
  prompter: electronPrompter,
  ui: {
    send: sendToWindow,
    reportError: (message, stack) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(
          `console.error('[main→renderer] Mesh initialization failed:', ${JSON.stringify(message)}, ${JSON.stringify(stack)})`
        ).catch(() => {});
      }
    }
  },
  openExternal: (url) => shell.openExternal(url),
  uiToastChannel: new UiToastChannel({ Notification }),
  builtinSkillsDir: path.join(__dirname, 'skills')
});

function createWindow() { /* unchanged body from old main.js */ }

registerHandlers(ipcMain, {
  ...core.context,
  safeStorage,
  getMainWindow: () => mainWindow,
  getShell: () => shell,
  pendingAskUserResolvers,
  pendingDirectoryAccessResolvers,
  prompter: electronPrompter
});

ipcMain.on('canvas:executeJsResult', (_event, { requestId, result, error }) => {
  const pending = core.pendingCanvasJsResolvers.get(requestId);
  /* …unchanged body… */
});

app.whenReady().then(async () => {
  protocol.handle('kl-screenshot', /* …unchanged… */);
  if (process.env.KL_TEST_BRIDGE_PORT) {
    require(process.env.KL_TEST_BRIDGE_SCRIPT || path.join(__dirname, 'tests', 'e2e', '_bridge.js'));
  }
  createWindow();
  await core.start();
  const meshContext = core.getMeshContext();
  if (meshContext && mainWindow && !mainWindow.isDestroyed()) {
    const sendReady = () => mainWindow.webContents.send('mesh:ready');
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', sendReady);
    else sendReady();
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    core.shutdown().finally(() => app.quit());
  }
});
```

**Check the context carefully.** Some keys in the old `registerHandlers` object were values captured at call time, not getters. For example, `webhookRegistry` and `webhookServer` were `undefined` at that moment, and `meshContext: null`. They are now `undefined` in the same way through `core.context`, so there's no behaviour change. Do **not** "fix" them in this task.

**Check the e2e bridge.** `tests/e2e/_bridge.js` may `require('../../main')` or read globals. Grep it. If it reaches into `main.js` internals that moved, expose exactly those through `core` and `module.exports = { core }` in `main.js`. The boundary test still passes, because it only scans `src/`.

- [ ] **Step 7: Run the tests**

Run: `node --test tests/core-create.test.js tests/electron-boundary.test.js`, then `npm test`
Expected: PASS / `# fail 0`

- [ ] **Step 8: UI parity (required)**

Run: `npm run test:e2e` with `ELECTRON_RUN_AS_NODE` unset.
Expected: `# fail 0`.

Then do a manual smoke test with a throwaway profile, following CLAUDE.md's Playwright notes (`--user-data-dir=<tmp>`). Launch, skip the wizard, send a chat with a configured provider, open Settings, and open Scheduler. Then launch once with your real profile and confirm that chats, provider keys and vault entries are all still there.

- [ ] **Step 9: Commit**

```bash
git add src/core/create-core.js src/core/index.js src/core/settings.js main.js tests/core-create.test.js
git commit -m "refactor(core): extract createCore(deps); main.js becomes Electron glue"
```

---

### Task 9: `king-louie-service`: CLI, config, profiles and graceful shutdown

**Files:**
- Create: `bin/king-louie-service.js`, `src/service/cli.js`, `src/service/config.js`, `src/service/ports.js`, `src/service/run.js`, `src/service/pidfile.js`, `src/service/doctor.js`
- Modify: `package.json` (`bin`, `engines`)
- Test: `tests/service-config.test.js`, `tests/service-cli.test.js`, `tests/service-smoke.test.js`, `tests/service-profile-graph.test.js`

**Interfaces:**
- Consumes:
  - `createCore` (Task 8)
  - `JsonFileStore`, `ensureServicePaths`, `defaultServiceDataDir`, `resolveMasterKey` (Task 6)
  - `createAesGcmCipher` (Task 3)
  - `createHeadlessPrompter` (Task 2)
  - `CHAT_DATA_DEFAULTS` (Task 8)
- Produces:
  - `loadServiceConfig(dataDir, overrides) → { profile: 'agent'|'runbook', features: {gateway, webhooks, mesh, channels, appDiscovery} }`. The file is `<dataDir>/service.json`. Defaults are `profile: 'agent'` and every feature `false` except `channels: true`. Anything that listens on a socket is off by default.
  - `buildServicePorts({ dataDir }) → { paths, store, vaultStore, cipher, prompter, masterKeySource }`
  - `runService({ dataDir, profile, signal }) → Promise<void>`:
    - Writes a pidfile.
    - Prints one line, `{"event":"ready","profile":…,"dataDir":…,"pid":…}`, to stdout.
    - Resolves after a clean shutdown triggered by SIGTERM, SIGINT, an IPC message `{ type: 'shutdown' }`, or the `signal` AbortSignal.
  - `main(argv, io) → Promise<exitCode>` in `src/service/cli.js`, with subcommands:
    - `run [--data-dir D] [--profile P]`
    - `status [--data-dir D]`
    - `doctor [--data-dir D]`
    - `token set <provider> [--data-dir D]` (reads the value from stdin)
    - `vault set <key> [--data-dir D]` (reads the value from stdin)
    - `install …` and `uninstall …` (Task 10)
    - `help`
  - `writePidfile(dataDir)`, `readPidfile(dataDir) → number|null`, `isRunning(pid) → boolean`, `removePidfile(dataDir)`
  - `runDoctor({ dataDir, platform }) → Array<{ check, ok, detail }>`

- [ ] **Step 1: Write the failing tests**

```js
// tests/service-config.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceConfig } = require('../src/service/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-cfg-'));

describe('loadServiceConfig', () => {
  it('defaults to agent profile with listeners off', () => {
    assert.deepStrictEqual(loadServiceConfig(tmp()), {
      profile: 'agent',
      features: { gateway: false, webhooks: false, mesh: false, channels: true, appDiscovery: false }
    });
  });
  it('reads service.json and lets CLI overrides win', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ profile: 'agent', features: { gateway: true } }));
    const cfg = loadServiceConfig(dir, { profile: 'runbook' });
    assert.strictEqual(cfg.profile, 'runbook');
    assert.strictEqual(cfg.features.gateway, true);
  });
  it('rejects unknown profiles', () => {
    assert.throws(() => loadServiceConfig(tmp(), { profile: 'frontdoor' }), /Unknown profile "frontdoor"/);
  });
});
```

```js
// tests/service-cli.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { main } = require('../src/service/cli');

function io(stdinText = '') {
  const out = []; const err = [];
  return {
    out, err,
    stdin: Readable.from([stdinText]),
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) }
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-cli-'));

describe('service CLI', () => {
  it('prints help and returns 0', async () => {
    const t = io();
    assert.strictEqual(await main(['help'], t), 0);
    assert.match(t.out.join(''), /king-louie-service run/);
  });
  it('returns 2 for unknown commands', async () => {
    const t = io();
    assert.strictEqual(await main(['frobnicate'], t), 2);
    assert.match(t.err.join(''), /Unknown command/);
  });
  it('stores a provider token from stdin, encrypted', async () => {
    const dir = tmp();
    const t = io('sk-from-stdin\n');
    assert.strictEqual(await main(['token', 'set', 'openai', '--data-dir', dir], t), 0);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8')).apiTokens.openai;
    assert.match(saved, /^klc1:/);
    assert.ok(!t.out.join('').includes('sk-from-stdin'));
  });
  it('reports status for a data dir with no running service', async () => {
    const t = io();
    assert.strictEqual(await main(['status', '--data-dir', tmp()], t), 3);
    assert.match(t.out.join(''), /not running/);
  });
});
```

```js
// tests/service-smoke.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'king-louie-service.js');

function startService(profile) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-smoke-'));
  const child = fork(BIN, ['run', '--data-dir', dataDir, '--profile', profile], {
    silent: true,
    env: { ...process.env, KL_TEST_MODE: '1', KING_LOUIE_LOG_LEVEL: 'warn' }
  });
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.includes('"event":"ready"'));
      if (line) resolve(JSON.parse(line));
    });
    child.once('exit', (code) => reject(new Error(`exited early with ${code}`)));
  });
  return { child, dataDir, ready };
}

for (const profile of ['agent', 'runbook']) {
  describe(`service smoke (${profile})`, { timeout: 60000 }, () => {
    it('starts, writes a pidfile, and stops cleanly on a shutdown message', async () => {
      const { child, dataDir, ready } = startService(profile);
      const info = await ready;
      assert.strictEqual(info.profile, profile);
      assert.strictEqual(Number(fs.readFileSync(path.join(dataDir, 'service.pid'), 'utf8')), child.pid);
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.send({ type: 'shutdown' });
      assert.strictEqual(await exited, 0);
      assert.strictEqual(fs.existsSync(path.join(dataDir, 'service.pid')), false);
    });
  });
}
```

```js
// tests/service-profile-graph.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FORBIDDEN = ['src/providers/', 'src/execution/agent-loop', 'src/tools/', 'src/browser/', 'src/channels/', 'src/mcp/', 'src/core/create-core'];

describe('runbook profile module graph', () => {
  it('never loads the agent stack', () => {
    const script = `
      const { loadProfile } = require('./src/service/run');
      loadProfile('runbook');
      process.stdout.write(JSON.stringify(Object.keys(require.cache)));
    `;
    const loaded = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT }).toString())
      .map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
    const bad = loaded.filter((p) => FORBIDDEN.some((f) => p.startsWith(f)));
    assert.deepStrictEqual(bad, []);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/service-config.test.js tests/service-cli.test.js tests/service-smoke.test.js tests/service-profile-graph.test.js`
Expected: FAIL (modules not found)

- [ ] **Step 3: Implement config, pidfile and ports**

```js
// src/service/config.js
const fs = require('fs');
const path = require('path');

const PROFILES = new Set(['agent', 'runbook']);
const DEFAULT_FEATURES = { gateway: false, webhooks: false, mesh: false, channels: true, appDiscovery: false };

function loadServiceConfig(dataDir, overrides = {}) {
  let fileCfg = {};
  const file = path.join(dataDir, 'service.json');
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid ${file}: ${err.message}`);
    }
  }
  const profile = overrides.profile || fileCfg.profile || 'agent';
  if (!PROFILES.has(profile)) throw new Error(`Unknown profile "${profile}". Expected one of: ${[...PROFILES].join(', ')}`);
  return {
    profile,
    features: { ...DEFAULT_FEATURES, ...(fileCfg.features || {}), ...(overrides.features || {}) }
  };
}

module.exports = { loadServiceConfig, PROFILES };
```

```js
// src/service/pidfile.js
const fs = require('fs');
const path = require('path');

const pidPath = (dataDir) => path.join(dataDir, 'service.pid');

function writePidfile(dataDir) {
  fs.writeFileSync(pidPath(dataDir), String(process.pid), { mode: 0o600 });
}

function readPidfile(dataDir) {
  try {
    const pid = Number(fs.readFileSync(pidPath(dataDir), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function removePidfile(dataDir) {
  try { fs.unlinkSync(pidPath(dataDir)); } catch { /* already gone */ }
}

module.exports = { writePidfile, readPidfile, isRunning, removePidfile };
```

```js
// src/service/ports.js
// Plain-Node implementations of the ports createCore() needs.
const { JsonFileStore } = require('../platform/json-file-store');
const { ensureServicePaths } = require('../platform/paths');
const { resolveMasterKey } = require('../platform/master-key');
const { createAesGcmCipher } = require('../platform/cipher');
const { createHeadlessPrompter } = require('../platform/prompter');

function buildServicePorts({ dataDir, chatDataDefaults = {} }) {
  const paths = ensureServicePaths(dataDir);
  const { key, source } = resolveMasterKey({ dataDir: paths.dataDir });
  return {
    paths,
    store: new JsonFileStore({ dir: paths.dataDir, name: 'chat-data', defaults: chatDataDefaults }),
    vaultStore: new JsonFileStore({ dir: paths.dataDir, name: 'config' }),
    cipher: createAesGcmCipher(key),
    prompter: createHeadlessPrompter(),
    masterKeySource: source
  };
}

module.exports = { buildServicePorts };
```

`chatDataDefaults` is passed in by the caller, so `ports.js` never requires `src/core/*`. That's what lets the runbook profile's module graph stay small.

- [ ] **Step 4: Implement run, with profile loading**

```js
// src/service/run.js
const { createLogger } = require('../logging');
const { writePidfile, removePidfile } = require('./pidfile');
const { loadServiceConfig } = require('./config');

const log = createLogger('service');

// Each profile is required lazily so the runbook profile never loads the agent stack.
function loadProfile(profile) {
  if (profile === 'agent') {
    return {
      async start({ dataDir, features }) {
        const { createCore } = require('../core');
        const { CHAT_DATA_DEFAULTS } = require('../core/settings');
        const { buildServicePorts } = require('./ports');
        const ports = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
        const core = createCore({ ...ports, features, builtinSkillsDir: require('path').join(__dirname, '..', '..', 'skills') });
        await core.start();
        return { stop: () => core.shutdown(), masterKeySource: ports.masterKeySource };
      }
    };
  }
  if (profile === 'runbook') {
    return {
      async start({ dataDir }) {
        const { buildServicePorts } = require('./ports');
        const ports = buildServicePorts({ dataDir });
        // Stage 2 adds the runbook engine here. Stage 1 only proves the
        // profile boots with its own identity-free, agent-free module graph.
        return { stop: async () => {}, masterKeySource: ports.masterKeySource };
      }
    };
  }
  throw new Error(`Unknown profile "${profile}"`);
}

async function runService({ dataDir, profile: profileOverride, signal, stdout = process.stdout }) {
  const { profile, features } = loadServiceConfig(dataDir, { profile: profileOverride });
  const running = await loadProfile(profile).start({ dataDir, features });
  writePidfile(dataDir);
  stdout.write(`${JSON.stringify({ event: 'ready', profile, dataDir, pid: process.pid, masterKeySource: running.masterKeySource })}\n`);

  await new Promise((resolve) => {
    const onShutdown = () => resolve();
    process.once('SIGTERM', onShutdown);
    process.once('SIGINT', onShutdown);
    process.on('message', (m) => { if (m && m.type === 'shutdown') onShutdown(); });
    if (signal) signal.addEventListener('abort', onShutdown, { once: true });
  });

  log.info('shutting down');
  try {
    await running.stop();
  } finally {
    removePidfile(dataDir);
  }
}

module.exports = { runService, loadProfile };
```

`ensureServicePaths` inside `buildServicePorts` creates `dataDir` before `writePidfile` runs, because `start()` runs first.

- [ ] **Step 5: Implement doctor**

```js
// src/service/doctor.js
const fs = require('fs');
const path = require('path');

function posixPrivate(file) {
  const mode = fs.statSync(file).mode & 0o777;
  return { ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` };
}

function runDoctor({ dataDir, platform = process.platform }) {
  const results = [];
  const major = Number(process.versions.node.split('.')[0]);
  results.push({ check: 'node >= 22', ok: major >= 22, detail: process.versions.node });

  const exists = fs.existsSync(dataDir);
  results.push({ check: 'data dir exists', ok: exists, detail: dataDir });
  if (!exists) return results;

  if (platform !== 'win32') {
    results.push({ check: 'data dir is private', ...posixPrivate(dataDir) });
    for (const name of ['master.key', 'gateway-token', 'chat-data.json', 'config.json']) {
      const file = path.join(dataDir, name);
      if (fs.existsSync(file)) results.push({ check: `${name} is private`, ...posixPrivate(file) });
    }
    if (typeof process.getuid === 'function') {
      results.push({ check: 'not running as root', ok: process.getuid() !== 0, detail: `uid ${process.getuid()}` });
    }
  } else {
    results.push({ check: 'DPAPI-wrapped master key present', ok: fs.existsSync(path.join(dataDir, 'master.key.dpapi')), detail: 'created on first run' });
  }
  return results;
}

module.exports = { runDoctor };
```

- [ ] **Step 6: Implement the CLI and the bin shim**

```js
// src/service/cli.js
// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
const { defaultServiceDataDir } = require('../platform/paths');

const HELP = `Usage:
  king-louie-service run [--data-dir DIR] [--profile agent|runbook]
  king-louie-service status [--data-dir DIR]
  king-louie-service doctor [--data-dir DIR]
  king-louie-service token set <provider> [--data-dir DIR]     (value read from stdin)
  king-louie-service vault set <key> [--data-dir DIR]          (value read from stdin)
  king-louie-service install [--profile P] [--user NAME] [--data-dir DIR] [--dry-run]
  king-louie-service uninstall [--dry-run]
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--')) {
      const name = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[name] = argv[i + 1];
      i += 1;
    } else positional.push(a);
  }
  return { positional, flags };
}

async function readStdin(stdin) {
  let text = '';
  for await (const chunk of stdin) text += chunk;
  return text.replace(/\r?\n$/, '');
}

async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const { positional, flags } = parseArgs(argv);
  const [command, sub, arg] = positional;
  const dataDir = flags.dataDir || defaultServiceDataDir();

  try {
    switch (command) {
      case undefined:
      case 'help':
        io.stdout.write(HELP);
        return 0;

      case 'run': {
        const { runService } = require('./run');
        await runService({ dataDir, profile: flags.profile, stdout: io.stdout });
        return 0;
      }

      case 'status': {
        const { readPidfile, isRunning } = require('./pidfile');
        const pid = readPidfile(dataDir);
        if (pid && isRunning(pid)) {
          io.stdout.write(`running (pid ${pid}) — data dir ${dataDir}\n`);
          return 0;
        }
        io.stdout.write(`not running — data dir ${dataDir}\n`);
        return 3;
      }

      case 'doctor': {
        const { runDoctor } = require('./doctor');
        const results = runDoctor({ dataDir });
        for (const r of results) io.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.check}  (${r.detail})\n`);
        return results.every((r) => r.ok) ? 0 : 1;
      }

      case 'token':
      case 'vault': {
        if (sub !== 'set' || !arg) {
          io.stderr.write(`Usage: king-louie-service ${command} set <${command === 'token' ? 'provider' : 'key'}>\n`);
          return 2;
        }
        const value = await readStdin(io.stdin);
        if (!value) { io.stderr.write('No value on stdin.\n'); return 2; }
        const { createCore } = require('../core');
        const { CHAT_DATA_DEFAULTS } = require('../core/settings');
        const { buildServicePorts } = require('./ports');
        const core = createCore(buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS }));
        if (command === 'token') core.saveProviderToken(arg, value);
        else core.vault.set(arg, value);
        io.stdout.write(`${command === 'token' ? 'Token' : 'Secret'} "${arg}" saved (encrypted).\n`);
        return 0;
      }

      case 'install':
      case 'uninstall': {
        const { runInstallCommand } = require('./installers');
        return await runInstallCommand(command, { ...flags, dataDir }, io);
      }

      default:
        io.stderr.write(`Unknown command "${command}".\n${HELP}`);
        return 2;
    }
  } catch (err) {
    io.stderr.write(`Error: ${err.message}\n`);
    return 1;
  }
}

module.exports = { main, parseArgs };
```

```js
#!/usr/bin/env node
// bin/king-louie-service.js
const { main } = require('../src/service/cli');

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; if (process.connected) process.disconnect(); },
  (err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; }
);
```

Until Task 10 exists, `install`/`uninstall` fail at `require('./installers')`. That's expected, and the tests here don't call them.

`package.json`: add `"bin": { "king-louie-service": "bin/king-louie-service.js" }` and `"engines": { "node": ">=22" }`.

**Exit behaviour.** The agent profile may leave handles open, such as timers in the cron scheduler or the MCP manager. If the smoke test doesn't exit within its timeout after `shutdown`:
1. Find the handle with `process._getActiveHandles()` in a debug run.
2. Fix it by stopping or unref'ing it in `core.shutdown()`.
3. **Don't** add `process.exit()` to hide it.

- [ ] **Step 7: Run the tests**

Run: `node --test tests/service-config.test.js tests/service-cli.test.js tests/service-smoke.test.js tests/service-profile-graph.test.js`
Expected: PASS

- [ ] **Step 8: Try it by hand**

```bash
node bin/king-louie-service.js run --data-dir "$TMP/kl-svc" --profile agent
# expect one {"event":"ready",...} line; Ctrl+C exits 0 and removes service.pid
node bin/king-louie-service.js doctor --data-dir "$TMP/kl-svc"
```

- [ ] **Step 9: Commit**

```bash
git add bin/king-louie-service.js src/service/*.js package.json tests/service-*.test.js
git commit -m "feat(service): king-louie-service run/status/doctor/token/vault with agent and runbook profiles"
```

---

### Task 10: OS installers (systemd, launchd, Windows Task Scheduler)

**Files:**
- Create: `src/service/installers.js`
- Test: `tests/service-installers.test.js`

**Interfaces:**
- Consumes: `defaultServiceDataDir` (Task 6), and the CLI flags parsed in Task 9 (`profile`, `user`, `dataDir`, `dryRun`)
- Produces:
  - `renderSystemdUnit({ nodePath, entryPath, dataDir, user, profile }) → string`
  - `renderLaunchdPlist({ nodePath, entryPath, dataDir, user, logsDir }) → string`
  - `renderWindowsTaskXml({ nodePath, entryPath, dataDir }) → string`
  - `planInstall({ platform, nodePath, entryPath, dataDir, user, profile }) → Step[]`
  - `planUninstall({ platform }) → Step[]`
  - `Step` = `{ description: string, run?: string[] /* argv */, mkdir?: string, writeFile?: { path, content, mode } }`. Exactly one of `run`, `mkdir` and `writeFile` is set.
  - `executeSteps(steps, { dryRun, io }) → Promise<void>`
  - `runInstallCommand(command, flags, io) → Promise<exitCode>`

- [ ] **Step 1: Write the failing tests**

```js
// tests/service-installers.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  renderSystemdUnit, renderLaunchdPlist, renderWindowsTaskXml, planInstall, planUninstall, executeSteps
} = require('../src/service/installers');

const base = { nodePath: '/usr/bin/node', entryPath: '/opt/king-louie/bin/king-louie-service.js', dataDir: '/var/lib/king-louie', user: 'king-louie' };

describe('systemd unit', () => {
  it('runs as the service user with hardening and the master-key credential', () => {
    const unit = renderSystemdUnit({ ...base, profile: 'runbook' });
    assert.match(unit, /^User=king-louie$/m);
    assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/king-louie\/bin\/king-louie-service\.js run --data-dir \/var\/lib\/king-louie --profile runbook$/m);
    assert.match(unit, /^LoadCredential=kl-master-key:\/etc\/king-louie\/credentials\/kl-master-key$/m);
    for (const d of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'PrivateTmp=yes', 'ReadWritePaths=/var/lib/king-louie', 'ProtectHome=yes']) {
      assert.ok(unit.includes(d), `missing ${d}`);
    }
  });
  it('lets the agent profile read home directories', () => {
    assert.match(renderSystemdUnit({ ...base, profile: 'agent' }), /^ProtectHome=read-only$/m);
  });
});

describe('launchd plist', () => {
  it('is a daemon running as the given user', () => {
    const plist = renderLaunchdPlist({ ...base, dataDir: '/Library/Application Support/KingLouie', logsDir: '/Library/Application Support/KingLouie/logs', user: '_kinglouie' });
    assert.match(plist, /<key>Label<\/key>\s*<string>com.kinglouie.service<\/string>/);
    assert.match(plist, /<key>UserName<\/key>\s*<string>_kinglouie<\/string>/);
    assert.match(plist, /<string>\/Library\/Application Support\/KingLouie<\/string>/);
  });
  it('escapes XML in paths', () => {
    assert.match(renderLaunchdPlist({ ...base, dataDir: '/a&b', logsDir: '/a&b/logs' }), /\/a&amp;b/);
  });
});

describe('Windows task', () => {
  it('starts at boot as LOCAL SERVICE with restart on failure', () => {
    const xml = renderWindowsTaskXml({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie' });
    assert.match(xml, /<BootTrigger>/);
    assert.match(xml, /<UserId>S-1-5-19<\/UserId>/);
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(xml, /<RestartOnFailure>/);
    assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(xml, /<Arguments>"C:\\kl\\bin\\king-louie-service\.js" run --data-dir "C:\\ProgramData\\KingLouie"<\/Arguments>/);
  });
});

describe('install plans', () => {
  it('linux: creates the user, the credential and the unit, then enables it', () => {
    const steps = planInstall({ platform: 'linux', ...base, profile: 'runbook' });
    const text = steps.map((s) => s.description).join('\n');
    assert.match(text, /service user/);
    assert.match(text, /master key credential/);
    const unit = steps.find((s) => s.writeFile?.path === '/etc/systemd/system/king-louie.service');
    assert.ok(unit);
    assert.ok(steps.some((s) => s.run && s.run.join(' ') === 'systemctl enable --now king-louie.service'));
    const cred = steps.find((s) => s.writeFile?.path === '/etc/king-louie/credentials/kl-master-key');
    assert.strictEqual(cred.writeFile.mode, 0o600);
    assert.match(cred.writeFile.content, /^[0-9a-f]{64}$/);
  });
  it('windows: locks down the data dir ACL and registers the task', () => {
    const steps = planInstall({ platform: 'win32', nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie' });
    assert.strictEqual(steps[0].mkdir, 'C:\\ProgramData\\KingLouie');
    assert.ok(steps.some((s) => s.run?.[0] === 'icacls' && s.run.includes('/inheritance:r')));
    assert.ok(steps.some((s) => s.run?.[0] === 'schtasks' && s.run.includes('/Create')));
  });
  it('darwin: requires --user', () => {
    assert.throws(() => planInstall({ platform: 'darwin', ...base, user: undefined }), /--user is required on macOS/);
  });
  it('uninstall plans exist for every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32']) assert.ok(planUninstall({ platform }).length > 0);
  });
});

describe('executeSteps', () => {
  it('dry-run prints and performs nothing', async () => {
    const out = [];
    await executeSteps([{ description: 'do a thing', run: ['definitely-not-a-command'] }], { dryRun: true, io: { stdout: { write: (s) => out.push(s) } } });
    assert.match(out.join(''), /\[dry-run\] do a thing: definitely-not-a-command/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/service-installers.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

```js
// src/service/installers.js
// Renders OS service definitions and turns them into explicit, printable
// install steps. `--dry-run` prints the steps without touching the system.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { defaultServiceDataDir } = require('../platform/paths');

const UNIT_PATH = '/etc/systemd/system/king-louie.service';
const CRED_PATH = '/etc/king-louie/credentials/kl-master-key';
const PLIST_PATH = '/Library/LaunchDaemons/com.kinglouie.service.plist';
const TASK_NAME = 'KingLouie';

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderSystemdUnit({ nodePath, entryPath, dataDir, user, profile = 'agent' }) {
  return [
    '[Unit]',
    'Description=King Louie service',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`,
    `Group=${user}`,
    `ExecStart=${nodePath} ${entryPath} run --data-dir ${dataDir} --profile ${profile}`,
    'Restart=on-failure',
    'RestartSec=5',
    `LoadCredential=kl-master-key:${CRED_PATH}`,
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    `ProtectHome=${profile === 'runbook' ? 'yes' : 'read-only'}`,
    'PrivateTmp=yes',
    `ReadWritePaths=${dataDir}`,
    'Environment=NODE_ENV=production',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  ].join('\n');
}

function renderLaunchdPlist({ nodePath, entryPath, dataDir, user, logsDir }) {
  const args = [nodePath, entryPath, 'run', '--data-dir', dataDir].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.kinglouie.service</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>UserName</key>
  <string>${xmlEscape(user)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.posix.join(logsDir, 'service.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.posix.join(logsDir, 'service.err.log'))}</string>
</dict>
</plist>
`;
}

function renderWindowsTaskXml({ nodePath, entryPath, dataDir }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>King Louie service</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-19</UserId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodePath)}</Command>
      <Arguments>${xmlEscape(`"${entryPath}" run --data-dir "${dataDir}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function planInstall({ platform = process.platform, nodePath = process.execPath, entryPath, dataDir, user, profile = 'agent' }) {
  dataDir = dataDir || defaultServiceDataDir({ platform });
  if (platform === 'linux') {
    const svcUser = user || 'king-louie';
    return [
      { description: 'create the service user', run: ['useradd', '--system', '--home-dir', dataDir, '--shell', '/usr/sbin/nologin', svcUser] },
      { description: 'create the data dir', run: ['install', '-d', '-m', '0700', '-o', svcUser, '-g', svcUser, dataDir] },
      { description: 'write the master key credential (root-only)', writeFile: { path: CRED_PATH, content: crypto.randomBytes(32).toString('hex'), mode: 0o600 } },
      { description: 'write the systemd unit', writeFile: { path: UNIT_PATH, content: renderSystemdUnit({ nodePath, entryPath, dataDir, user: svcUser, profile }), mode: 0o644 } },
      { description: 'reload systemd', run: ['systemctl', 'daemon-reload'] },
      { description: 'enable and start', run: ['systemctl', 'enable', '--now', 'king-louie.service'] }
    ];
  }
  if (platform === 'darwin') {
    if (!user) throw new Error('--user is required on macOS (create a dedicated account first; see README)');
    const logsDir = path.posix.join(dataDir, 'logs');
    return [
      { description: 'create the data dir', run: ['install', '-d', '-m', '0700', '-o', user, dataDir] },
      { description: 'create the logs dir', run: ['install', '-d', '-m', '0700', '-o', user, logsDir] },
      { description: 'write the LaunchDaemon', writeFile: { path: PLIST_PATH, content: renderLaunchdPlist({ nodePath, entryPath, dataDir, user, logsDir }), mode: 0o644 } },
      { description: 'load the LaunchDaemon', run: ['launchctl', 'bootstrap', 'system', PLIST_PATH] }
    ];
  }
  if (platform === 'win32') {
    const xmlPath = path.win32.join(dataDir, 'king-louie-task.xml');
    return [
      { description: 'create the data dir', mkdir: dataDir },
      { description: 'restrict the data dir to LOCAL SERVICE, SYSTEM and Administrators', run: ['icacls', dataDir, '/inheritance:r', '/grant:r', '*S-1-5-19:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'] },
      { description: 'write the task definition', writeFile: { path: xmlPath, content: renderWindowsTaskXml({ nodePath, entryPath, dataDir }), mode: 0o644 } },
      { description: 'register the boot task', run: ['schtasks', '/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'] },
      { description: 'start it now', run: ['schtasks', '/Run', '/TN', TASK_NAME] }
    ];
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

function planUninstall({ platform = process.platform }) {
  if (platform === 'linux') {
    return [
      { description: 'stop and disable', run: ['systemctl', 'disable', '--now', 'king-louie.service'] },
      { description: 'remove the unit', run: ['rm', '-f', UNIT_PATH] },
      { description: 'reload systemd', run: ['systemctl', 'daemon-reload'] }
    ];
  }
  if (platform === 'darwin') {
    return [
      { description: 'unload the LaunchDaemon', run: ['launchctl', 'bootout', 'system', PLIST_PATH] },
      { description: 'remove the plist', run: ['rm', '-f', PLIST_PATH] }
    ];
  }
  if (platform === 'win32') {
    return [
      { description: 'stop the task', run: ['schtasks', '/End', '/TN', TASK_NAME] },
      { description: 'delete the task', run: ['schtasks', '/Delete', '/TN', TASK_NAME, '/F'] }
    ];
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

async function executeSteps(steps, { dryRun = false, io = { stdout: process.stdout } } = {}) {
  for (const step of steps) {
    const what = step.run ? step.run.join(' ') : step.mkdir ? `mkdir ${step.mkdir}` : `write ${step.writeFile.path}`;
    if (dryRun) {
      io.stdout.write(`[dry-run] ${step.description}: ${what}\n`);
      continue;
    }
    io.stdout.write(`${step.description}…\n`);
    if (step.run) {
      execFileSync(step.run[0], step.run.slice(1), { stdio: 'inherit', windowsHide: true });
    } else if (step.mkdir) {
      fs.mkdirSync(step.mkdir, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(step.writeFile.path), { recursive: true, mode: 0o700 });
      fs.writeFileSync(step.writeFile.path, step.writeFile.content, { mode: step.writeFile.mode });
    }
  }
}

async function runInstallCommand(command, flags, io) {
  const entryPath = path.resolve(__dirname, '..', '..', 'bin', 'king-louie-service.js');
  const steps = command === 'install'
    ? planInstall({ entryPath, dataDir: flags.dataDir, user: flags.user, profile: flags.profile })
    : planUninstall({});
  await executeSteps(steps, { dryRun: Boolean(flags.dryRun), io });
  return 0;
}

module.exports = {
  renderSystemdUnit, renderLaunchdPlist, renderWindowsTaskXml,
  planInstall, planUninstall, executeSteps, runInstallCommand
};
```

Windows creates its data dir with a `mkdir` step (`Step.mkdir`), not through `cmd`, because `mkdir` can't be expressed safely as a single argv. It runs before `icacls` restricts the ACL.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/service-installers.test.js tests/service-cli.test.js`
Expected: PASS

- [ ] **Step 5: Manual dry run on your current OS**

Run: `node bin/king-louie-service.js install --dry-run --profile agent --data-dir "$TMP/kl-install"` (on macOS add `--user "$USER"`)
Expected: a readable list of `[dry-run] …` steps and no system changes.

- [ ] **Step 6: Commit**

```bash
git add src/service/installers.js tests/service-installers.test.js
git commit -m "feat(service): systemd, launchd and Windows boot-task installers with --dry-run"
```

---

### Task 11: Documentation and spec deviations

**Files:**
- Modify: `README.md`: add a "Running as a service" section
- Modify: `CLAUDE.md`: add a short "Service mode" note
- Modify: `docs/superpowers/specs/2026-09-21-king-louie-fleet-design.md` §4.2–§4.4

- [ ] **Step 1: README section.** Cover all of the following, with no personal names or paths:
  - **What it is:** a headless King Louie with no UI, driven by channels (Telegram, Discord, Slack), cron and, from later stages, the fleet.
  - **Install:**
    - Linux: `sudo node bin/king-louie-service.js install --profile agent`
    - macOS: create a dedicated standard account first, then `sudo … install --user <account>`
    - Windows, from an elevated shell: `node bin\king-louie-service.js install`
    - Always try `--dry-run` first.
  - **Configure:**
    - `<dataDir>/service.json` with `profile` and `features`; every listener is off by default.
    - `king-louie-service token set anthropic < keyfile`
    - `king-louie-service vault set <key>`
  - **Default data dir per OS.**
  - **Operate:** `status`, `doctor`, logs (journalctl / `logs/` / Event Viewer → Task Scheduler history).
  - **Security notes:**
    - where the master key lives per OS;
    - the gateway requires the token in `<dataDir>/gateway-token`;
    - the service denies every approval-requiring action, because stage 1 has no remote approver;
    - on Windows the service runs as `LOCAL SERVICE` and can't reach user profile folders.

- [ ] **Step 2: CLAUDE.md.** Add under "Running the app":

```markdown
## Service mode

`node bin/king-louie-service.js run --data-dir <tmp> --profile agent` runs King Louie
headless (no Electron — `ELECTRON_RUN_AS_NODE` is irrelevant here). Everything under
`src/` must stay Electron-free except `src/ipc/`; `tests/electron-boundary.test.js`
enforces it. Host-specific behaviour is injected into `createCore(deps)` (`src/core/`).
```

- [ ] **Step 3: Spec updates.** In §4.2, replace the `secrets` row with a `cipher` row, and describe the master-key sources as in this plan's "Spec deviations" section:
  - the systemd credential;
  - DPAPI (CurrentUser scope of the service account);
  - a `0600` key file;
  - no Keychain or libsecret, and why.

  In §4.3, describe the Windows host as a boot-time Scheduled Task running as `LOCAL SERVICE`, with a note that a real SCM service is deferred. In §4.4, state that the webhook server blocks `Origin` and has no CORS instead of using a bearer token, and that the gateway token file lives at `<dataDir>/gateway-token`.

- [ ] **Step 4: Final verification.** Run `npm test` and `npm run test:e2e`; both must show `# fail 0`. Then:
  - grep the branch diff for personal labels: `git diff main --stat` and `git diff main | grep -iE '<your-name>|<your-domain>|<your-machine>'`, with your actual strings substituted;
  - confirm the CI workflow is green on all three OSes.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/specs/2026-09-21-king-louie-fleet-design.md
git commit -m "docs: service mode, and record stage-1 spec deviations"
```

---

## Out of scope for Stage 1 (tracked for later stages)

- **Mesh private key in plaintext.** `src/mesh/index.js` stores `mesh.identity` in plaintext, and `MeshIdentity.serialize()` likely includes the private key. The mesh also listens on `0.0.0.0` by default. The service host keeps `features.mesh` **off** by default, so neither is exposed in stage 1. Fixing them belongs to stage 2 (identity) and stage 4 (mesh hardening).
- **Splitting `create-core.js`** into smaller modules (providers, channels, agent runtime) once it's out of `main.js`.
- **Remote-origin policy** (`always_confirm`, `allowed_roots`) is stage 2; phone approvals are stage 3.
