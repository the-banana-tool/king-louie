# Skill Pinning Feature — Implementation Plan

## Overview

When a skill is "pinned" to a chat, all free-form messages in that chat route directly to the skill's `handleMessage()` method instead of the AI agent. The skill can optionally opt back into AI processing per-message via a `continueWithAgent` flag. Pin state persists to disk and survives restarts.

### Example Usage
- User types `/pin std` in a chat called "to-do"
- From that point forward, typing `buy groceries` routes to the STD skill's NLP parser — no `/std` prefix needed, no AI round-trip
- `/unpin` restores normal behavior
- `/pinned` shows what skill (if any) is currently pinned

---

## Design Decisions

| Question | Decision |
|---|---|
| How is pinning triggered? | `/pin <skill-id>` command; `/unpin` to remove |
| How are free-form messages handled? | New `handleMessage(text, context)` method on the Skill interface |
| Where is pin state stored? | Persistent JSON file per session key (`skill-pins.json` in `userDataPath`), survives restarts |
| What happens to other `/commands` while pinned? | They still route normally — only unrecognized / free-form text goes to the pinned skill |
| How does a skill declare it supports pinning? | `pinnable: true` in `getMetadata()` |
| Is the AI agent still involved when pinned? | Skill decides per-message via `continueWithAgent` flag on the response (default: false) |
| UX feedback | Confirmation message on `/pin` and `/unpin`; `/pinned` command shows current status |

---

## Files to Create / Modify

### 1. `src/skills/pin-manager.js` — NEW

Create a `PinManager` class responsible for all pin state persistence.

```javascript
class PinManager {
  constructor(options = {}) {
    // storageFile: path to skill-pins.json (pass app.getPath('userData') + '/skill-pins.json')
  }

  async load()                          // Load pins from JSON file on startup
  async pin(sessionKey, skillId)        // Pin a skill to a session; persists immediately
  async unpin(sessionKey)               // Remove pin for a session; persists immediately
  getPinned(sessionKey)                 // Returns skillId string or null (sync)
  listAll()                             // Returns array of { sessionKey, skillId } (sync)
}
```

- Storage format: `{ "agent:main:telegram:123456": "std", "agent:main:ui:abc123": "std" }`
- New pin replaces existing pin (one pin per chat)
- If skill is unloaded while pinned, `getPinned()` still returns the skillId — callers must handle null from `skillRegistry.getSkill()`

---

### 2. `src/skills/skill-interface.js` — MODIFY

Add to the `SkillMetadata` JSDoc:
```javascript
// @property {boolean} [pinnable] - If true, skill can be pinned to a chat.
//   Pinned skill must implement handleMessage().
```

Add `MessageResult` typedef:
```javascript
/**
 * @typedef {Object} MessageResult
 * @property {boolean} ok
 * @property {string} [message]
 * @property {string} [error]
 * @property {any} [data]
 * @property {boolean} [continueWithAgent] - If true, also run the AI agent after this response.
 *                                            Defaults to false (skill handles it completely).
 */
```

Add optional method to `Skill` base class:
```javascript
/**
 * Handle a free-form message when this skill is pinned to a chat.
 * Only called when the skill is pinned AND the user sends non-command text.
 *
 * @param {string} text - Raw user message
 * @param {CommandContext} context
 * @returns {Promise<MessageResult|null>} - null means "not handled, fall through to agent"
 */
async handleMessage(text, context) {
  return null; // Default: not handled
}
```

---

### 3. `src/skills/index.js` — MODIFY

Export `PinManager`:
```javascript
const PinManager = require('./pin-manager');
module.exports = { Skill, SkillRegistry, SkillLoader, skillRegistry, PinManager };
```

---

### 4. `src/skills/skill-registry.js` — MODIFY

Add one method:
```javascript
/**
 * List all skills that support pinning (pinnable: true in metadata)
 * @returns {Array<{id, name, description, commands, version}>}
 */
getPinnableSkills() {
  return Array.from(this.skills.values())
    .filter(skill => skill.getMetadata().pinnable === true)
    .map(skill => { /* same shape as listSkills() */ });
}
```

---

### 5. `src/channels/telegram-bridge.js` — MODIFY

**Constructor:** Accept `pinManager` in options, store as `this.pinManager`.

**In `handleCommand(chatId, text)`**, add handling *before* the existing skill-registry lookup:

```javascript
if (command === '/pin') {
  const skillId = arg;
  const skill = skillRegistry.getSkill(skillId);
  if (!skill) { send "Unknown skill: {skillId}"; return; }
  if (!skill.getMetadata().pinnable) { send "Skill '{skillId}' does not support pinning."; return; }
  const state = this.getOrCreateChatState(chatId);
  await this.pinManager.pin(state.sessionKey, skillId);
  send "📌 Pinned {skill.name} to this chat. All messages will be handled by {skill.name}. Use /unpin to restore normal behavior.";
  return;
}

if (command === '/unpin') {
  const state = this.getOrCreateChatState(chatId);
  const pinnedId = this.pinManager.getPinned(state.sessionKey);
  await this.pinManager.unpin(state.sessionKey);
  const label = pinnedId ? skillRegistry.getSkill(pinnedId)?.getMetadata().name || pinnedId : null;
  send label ? "📌 Unpinned {label}. Normal behavior restored." : "No skill is currently pinned.";
  return;
}

if (command === '/pinned') {
  const state = this.getOrCreateChatState(chatId);
  const pinnedId = this.pinManager.getPinned(state.sessionKey);
  if (!pinnedId) { send "No skill is currently pinned to this chat."; return; }
  const skill = skillRegistry.getSkill(pinnedId);
  const name = skill?.getMetadata().name || pinnedId;
  send "📌 Pinned skill: {name} ({pinnedId})";
  return;
}
```

**In `handleMessage(message)`**, after the `/` check and before `routeAgentMessage()`:

```javascript
// Check if chat has a pinned skill
const state = this.getOrCreateChatState(chatId);
const pinnedSkillId = this.pinManager?.getPinned(state.sessionKey);
if (pinnedSkillId) {
  const skill = skillRegistry.getSkill(pinnedSkillId);
  if (skill && typeof skill.handleMessage === 'function') {
    const session = this.sessionManager.getOrCreateSession(state.sessionKey, state.agentId, { ... });
    const result = await skill.handleMessage(text, { chatId, channel: 'telegram', userId: chatId, session });
    if (result !== null) {
      if (result.ok) {
        await this.sendMessage(chatId, result.message || 'Done.');
      } else {
        await this.sendMessage(chatId, `❌ ${result.error || 'Error'}`);
      }
      if (!result.continueWithAgent) return; // Skip AI
    }
  }
}

await this.routeAgentMessage(chatId, text);
```

---

### 6. `main.js` — MODIFY

**Import PinManager:**
```javascript
const { SkillLoader, skillRegistry, PinManager } = require('./src/skills');
```

**Add module-level variable:**
```javascript
let pinManager;
```

**In `initializeAgentInfrastructure()`**, after `sessionManager` is created:
```javascript
pinManager = new PinManager({
  storageFile: path.join(app.getPath('userData'), 'skill-pins.json')
});
await pinManager.load();
```

**In `startTelegramBridge(token)`**, pass `pinManager`:
```javascript
telegramBridge = new TelegramBridge({
  // ...existing options...
  pinManager
});
```

**Add IPC handlers** (alongside existing `skill:list` and `skill:execute`):

```javascript
// skill:pin — pin a skill to the UI chat's session
ipcMain.handle('skill:pin', async (_event, { chatId, skillId }) => {
  const skill = skillRegistry.getSkill(skillId);
  if (!skill) return { ok: false, error: `Unknown skill: ${skillId}` };
  if (!skill.getMetadata().pinnable) return { ok: false, error: `Skill '${skillId}' does not support pinning.` };
  const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
  await pinManager.pin(sessionKey, skillId);
  return { ok: true, skillId, name: skill.getMetadata().name };
});

// skill:unpin — remove pin for a UI chat
ipcMain.handle('skill:unpin', async (_event, { chatId }) => {
  const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
  const previousId = pinManager.getPinned(sessionKey);
  await pinManager.unpin(sessionKey);
  return { ok: true, previousSkillId: previousId || null };
});

// skill:getPinned — get the currently pinned skill for a UI chat
ipcMain.handle('skill:getPinned', async (_event, { chatId }) => {
  const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
  const skillId = pinManager.getPinned(sessionKey);
  if (!skillId) return { ok: true, pinned: null };
  const skill = skillRegistry.getSkill(skillId);
  return { ok: true, pinned: skill ? { skillId, ...skill.getMetadata() } : { skillId } };
});

// skill:listPinnable — list all skills that support pinning
ipcMain.handle('skill:listPinnable', async () => {
  return skillRegistry.getPinnableSkills();
});

// skill:handleMessage — route a free-form message to the pinned skill (UI channel)
ipcMain.handle('skill:handleMessage', async (_event, { chatId, message }) => {
  const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
  const skillId = pinManager.getPinned(sessionKey);
  if (!skillId) return { ok: false, error: 'No skill pinned', continueWithAgent: true };

  const skill = skillRegistry.getSkill(skillId);
  if (!skill || typeof skill.handleMessage !== 'function') {
    return { ok: false, error: 'Pinned skill cannot handle messages', continueWithAgent: true };
  }

  const session = sessionManager.getOrCreateSession(sessionKey, 'main', {
    channel: 'ui', peer: chatId, label: `ui:${chatId}`
  });

  try {
    const result = await skill.handleMessage(message, { chatId, channel: 'ui', userId: chatId, session });
    return result || { ok: false, continueWithAgent: true };
  } catch (error) {
    return { ok: false, error: error.message, continueWithAgent: true };
  }
});
```

---

### 7. `preload.js` — MODIFY

Extend the `skill` object in `contextBridge.exposeInMainWorld`:

```javascript
skill: {
  list:          () => ipcRenderer.invoke('skill:list'),
  execute:       (payload) => ipcRenderer.invoke('skill:execute', payload),
  pin:           (payload) => ipcRenderer.invoke('skill:pin', payload),
  unpin:         (payload) => ipcRenderer.invoke('skill:unpin', payload),
  getPinned:     (payload) => ipcRenderer.invoke('skill:getPinned', payload),
  listPinnable:  () => ipcRenderer.invoke('skill:listPinnable'),
  handleMessage: (payload) => ipcRenderer.invoke('skill:handleMessage', payload),
},
```

---

### 8. `renderer.js` — MODIFY

**In `sendMessage()`**, add three new slash command handlers *before* the generic skill-execute block (around line 798):

```javascript
if (slashCommand?.name === '/pin') {
  userInput.value = '';
  userInput.style.height = 'auto';
  const skillId = slashCommand.args[0];
  appendLocalMessage('user', message);
  window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch(() => {});
  if (!skillId) {
    const errorText = 'Usage: `/pin <skill-id>`. Use `/pin std` to pin the STD skill.';
    appendLocalMessage('assistant', errorText);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: errorText }).catch(() => {});
    return;
  }
  const result = await window.electron.skill.pin({ chatId: activeChatId, skillId });
  const responseText = result.ok
    ? `📌 Pinned **${result.name || skillId}** to this chat. All messages will be handled by this skill. Use \`/unpin\` to restore normal behavior.`
    : `❌ ${result.error}`;
  appendLocalMessage('assistant', responseText);
  window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch(() => {});
  return;
}

if (slashCommand?.name === '/unpin') {
  userInput.value = '';
  userInput.style.height = 'auto';
  appendLocalMessage('user', message);
  window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch(() => {});
  const result = await window.electron.skill.unpin({ chatId: activeChatId });
  const responseText = result.ok ? '📌 Unpinned. Normal behavior restored.' : `❌ ${result.error}`;
  appendLocalMessage('assistant', responseText);
  window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch(() => {});
  return;
}

if (slashCommand?.name === '/pinned') {
  userInput.value = '';
  userInput.style.height = 'auto';
  appendLocalMessage('user', message);
  window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch(() => {});
  const result = await window.electron.skill.getPinned({ chatId: activeChatId });
  const responseText = result.pinned
    ? `📌 Pinned skill: **${result.pinned.name || result.pinned.skillId}** (\`${result.pinned.skillId}\`)`
    : 'No skill is currently pinned to this chat.';
  appendLocalMessage('assistant', responseText);
  window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch(() => {});
  return;
}
```

**Before `chat.sendMessage`** (for non-command messages, around line 851), add a pinned-skill check:

```javascript
// If a skill is pinned, route the message to it before (or instead of) the AI
const pinnedInfo = await window.electron.skill.getPinned({ chatId: activeChatId });
if (pinnedInfo?.pinned) {
  const skillResult = await window.electron.skill.handleMessage({ chatId: activeChatId, message });
  if (skillResult && !skillResult.continueWithAgent) {
    const responseText = skillResult.ok
      ? (skillResult.message || 'Done.')
      : `❌ ${skillResult.error || 'Error'}`;
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch(() => {});
    return;
  }
  // continueWithAgent: true — fall through to AI below
}

const updatedChat = await window.electron.chat.sendMessage({ ... });
```

**Update `/help` text** to include the three new commands:
```
- `/pin <skill-id>` — pin a skill to this chat (all messages handled by the skill)
- `/unpin` — unpin current skill, restore normal behavior
- `/pinned` — show which skill (if any) is pinned to this chat
```

---

### 9. `skills/std/index.js` — MODIFY

**In `getMetadata()`**, add:
```javascript
pinnable: true
```

**Add `handleMessage()` method:**
```javascript
async handleMessage(text, context) {
  if (!this.commandRouter) {
    return { ok: false, error: 'STD skill not initialized', continueWithAgent: false };
  }

  // Split raw text into args and route through the existing command router.
  // The router already handles natural language via NLP parser when no subcommand matches.
  const args = String(text || '').trim().split(/\s+/).filter(Boolean);
  const result = await this.commandRouter.route(args, context);

  return { ...result, continueWithAgent: false };
}
```

---

## Architecture Diagram

```
User message in a pinned chat
        │
        ▼
  Starts with /? ──yes──► Normal command routing (skill:execute / TelegramBridge handleCommand)
        │                   /pin, /unpin, /pinned handled as system commands
        │ no
        ▼
  Pinned skill exists?
        │ yes
        ▼
  skill.handleMessage(text, context)
        │
        ├─ result.continueWithAgent = false ──► Send result to user. DONE.
        │
        └─ result.continueWithAgent = true  ──► Also send to AI agent
                                                 (merge skill response + AI response)
        │ no pinned skill
        ▼
  Normal AI agent execution
```

---

## Open Questions / Future Work

- **UI indicator**: Consider showing a "pinned" badge on the chat tab when a skill is pinned, so users always know what mode they're in
- **Skill unload race condition**: If a skill is unloaded while pinned, the pin record stays in `skill-pins.json`. The callers already handle `null` from `skillRegistry.getSkill()` gracefully (fall through to AI), but a warning message might be useful
- **Multiple pinned skills**: Currently one skill per chat. Future: could support a skill stack
- **Remote-control channel**: The WebSocket `RemoteControl` (used by external clients) does not have pin support in this plan — add later if needed
