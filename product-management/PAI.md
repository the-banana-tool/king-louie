# PAI-Inspired Features for King Louie

Ideas sourced from [Personal_AI_Infrastructure](https://github.com/danielmiessler/PAI) code review. Each task is self-contained and can be picked up independently.

---

## 1. Hook System (Pre/Post Tool Lifecycle)

**Priority:** High | **Complexity:** Medium

King Louie's `ToolExecutor` already emits events. This task adds a user-configurable hook system on top of that.

### Tasks

- [ ] **1.1** Create `src/hooks/hook-schema.js` - Hook definition class with fields: `name`, `event` (PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit), `matcher` (tool name or glob pattern), `handler` (path to JS/TS file or inline shell command)
- [ ] **1.2** Create `src/hooks/hook-registry.js` - Registry that loads hook definitions from a `hooks/` directory (same discovery pattern as skills)
- [ ] **1.3** Create `src/hooks/hook-executor.js` - Runs matching hooks for a given event, passes context (tool name, params, result), respects hook return values (allow/deny/modify for PreToolUse)
- [ ] **1.4** Wire hook executor into `ToolExecutor` - Call PreToolUse hooks before execution (can block), PostToolUse hooks after execution (informational)
- [ ] **1.5** Wire SessionStart/SessionEnd hooks into `main.js` app lifecycle
- [ ] **1.6** Wire UserPromptSubmit hook into the renderer's send flow via IPC
- [ ] **1.7** Create `hooks/` directory with a `README.md` explaining hook authoring
- [ ] **1.8** Create example hook: `hooks/log-tool-usage/` - Logs every tool execution to a file with timestamp, tool name, params, and result status
- [ ] **1.9** Add hook management to settings UI - List loaded hooks, enable/disable toggle

---

## 2. Tiered Memory System (Hot/Warm/Cold)

**Priority:** High | **Complexity:** Medium

Agents currently forget everything between sessions. Add persistent learning that captures what worked and what didn't.

### Tasks

- [ ] **2.1** Design memory schema - Define structure for memory entries: `{ id, type (success|failure|preference|context), content, source (session_id), created, lastAccessed, tier (hot|warm|cold) }`
- [ ] **2.2** Create `src/memory/memory-store.js` - CRUD operations for memory entries, backed by a JSON file in the app's user data directory
- [ ] **2.3** Create `src/memory/memory-manager.js` - Higher-level API: `capture(type, content)`, `recall(query, options)`, `promote(id)`, `demote(id)`
- [ ] **2.4** Implement tier aging - Hot (current session + 7 days), Warm (7-90 days), Cold (90+ days). Run aging on SessionStart
- [ ] **2.5** Implement phase-based capture - Add `captureSuccess(what, why)`, `captureFailure(what, why, fix)`, `capturePreference(key, value)` convenience methods
- [ ] **2.6** Create `src/memory/memory-retrieval.js` - Retrieve relevant memories for a given prompt/context using keyword matching and recency scoring
- [ ] **2.7** Inject recalled memories into agent system prompts - When building messages for the LLM, prepend relevant memories as context
- [ ] **2.8** Add IPC handlers in `main.js` for memory operations (memory:capture, memory:recall, memory:list, memory:clear)
- [ ] **2.9** Add memory panel to UI - Sidebar tab or drawer showing recent memories with search, tier filter, and delete
- [ ] **2.10** Create a PostToolUse hook that auto-captures tool failures as memory entries

---

## 3. Multi-Tier Inference (Model Routing)

**Priority:** High | **Complexity:** Low

Route to different models based on task complexity. King Louie already has multi-provider support so this is mostly orchestration logic.

### Tasks

- [x] **3.1** Define inference tiers in config - `fast` (cheapest/fastest model), `standard` (default), `smart` (most capable). Map each tier to a provider + model pair
- [x] **3.2** Create `src/providers/inference-router.js` - Accepts a tier parameter, resolves to the correct provider instance and model
- [x] **3.3** Add tier selection to agent schema - Each agent can specify a default tier, overridable per-execution
- [x] **3.4** Add `/fast`, `/standard`, `/smart` slash commands to renderer - Let users switch tiers mid-conversation
- [x] **3.5** Add tier indicator to the UI status bar - Show which tier is active for the current chat
- [x] **3.6** Add per-tier timeout configuration - Fast: 15s, Standard: 30s, Smart: 90s (configurable in settings)

### Progress Notes

- ✅ Completed 2026-03-23: initial Multi-Tier Inference implementation (3.1–3.6)
- Added `src/providers/inference-router.js` and wired tier resolution into chat + agent execution paths
- Added agent-level `inferenceTier` defaults (`code-explorer=fast`, `main=standard`, `code-writer=smart`)
- Added renderer slash commands (`/fast`, `/standard`, `/smart`) and persisted tier switching via IPC
- Added active tier display in chat header metadata and backend timeout defaults per tier

---

## 4. Dynamic System Prompt (Template System)

**Priority:** Medium | **Complexity:** Low

Replace static agent system prompts with a template system that resolves variables from settings + user profile at runtime.

### Tasks

- [x] **4.1** Create `src/templates/template-engine.js` - Simple `{{variable}}` substitution engine that resolves from a context object
- [x] **4.2** Create `templates/` directory with default agent prompt templates (`main-assistant.md.template`, `code-explorer.md.template`, `code-writer.md.template`)
- [x] **4.3** Modify `AgentExecutor` to resolve templates at execution time instead of using static `systemPrompt` strings
- [x] **4.4** Add user-editable variables in settings - Name, role, preferences, project context
- [x] **4.5** Support template includes - `{{> partial_name}}` syntax for shared prompt fragments
- [x] **4.6** Add a rebuild trigger - Re-resolve templates when settings change (no restart needed)

### Progress Notes

- ✅ Completed 2026-03-23: Dynamic System Prompt foundations (4.1, 4.2, 4.3, 4.5)
- Added `src/templates/template-engine.js` with variable interpolation, nested path resolution, and partial include support (`{{> partial_name}}`) including include-cycle protection
- Added `templates/` prompt templates for built-in agents plus shared partials under `templates/partials/`
- Updated agent schema + built-in agent configs to support `systemPromptTemplate`, and wired `AgentExecutor` to render templates at runtime with fallback to static prompts
- Verified via node-based checks for template rendering and executor integration
- ✅ Completed 2026-03-23: settings-driven prompt variables + live re-resolution (4.4, 4.6)
- Added template variable storage in settings (`name`, `role`, `preferences`, `projectContext`) with new IPC endpoint `settings:saveTemplateVariables`
- Added settings UI form to edit and persist prompt variables, exposed through preload bridge and renderer handlers
- Injected settings-derived `templateContext` into agent execution paths (single, parallel, serial, and remote adapter), so updated values apply on next run without restart
- Extended shared prompt partial (`templates/partials/operating-principles.md.template`) to include user/project context fields
- Verified syntax with `node --check` for `main.js`, `renderer.js`, and `preload.js`

---

## 5. TELOS-Style User Context

**Priority:** Medium | **Complexity:** Low

A lightweight user profile that agents reference to personalize responses. Not the full 10-file PAI TELOS, just the essentials.

### Tasks

- [x] **5.1** Create `src/telos/user-profile.js` - Manages a user profile with fields: `name`, `role`, `goals[]`, `preferences{}`, `projectContext`
- [x] **5.2** Store profile in electron-store under `userProfile` key
- [x] **5.3** Create profile setup UI - First-run wizard or settings tab with text fields for each profile property
- [x] **5.4** Inject user profile into agent system prompts - Append a "User Context" section with relevant profile info
- [x] **5.5** Add `/profile` slash command to view/edit profile inline in chat
- [x] **5.6** Add project-level TELOS - Per-directory `.king-louie/context.md` file that agents auto-load when working in that directory

### Progress Notes

- ✅ Completed 2026-03-23: initial TELOS user profile manager (5.1)
- Added `src/telos/user-profile.js` with normalized profile schema support (`name`, `role`, `goals[]`, `preferences{}`, `projectContext`)
- Added profile read/update helpers plus template-context projection for prompt injection (`toTemplateContext`)
- ✅ Completed 2026-03-23: profile persistence + UI + prompt injection + slash command (5.2–5.5)
- Stored user profile in `electron-store` under `userProfile`, with new IPC save endpoint (`settings:saveUserProfile`) and preload bridge wiring
- Added TELOS profile section in settings UI (name, role, goals, preferences JSON, project context) with save/status handling
- Injected `User Context` into agent execution system prompts (single, parallel, serial, and remote adapter paths)
- Added `/profile` and `/profile set <field> <value>` commands in renderer for inline view/edit (`name`, `role`, `projectContext`, `goals`, `preferences`)
- ✅ Completed 2026-03-23: project-level TELOS context auto-loading (5.6)
- Added `src/telos/project-context.js` to discover and load nearest `.king-louie/context.md` while traversing parent directories
- Injected loaded project context into runtime system prompts (`agent:execute`, parallel/serial orchestration, and remote adapter execution path)
- Extended template context payload with `project.telosContext` and `project.telosContextPath`, and surfaced both in shared operating-principles partial

---

## 6. Skill Priority Hierarchy (CODE > CLI > PROMPT > SKILL)

**Priority:** Medium | **Complexity:** Medium

Skills should try deterministic approaches before falling back to LLM. This makes skills faster, cheaper, and more reliable.

### Tasks

- [x] **6.1** Extend `skill-interface.js` with a `resolvers[]` array - Ordered list of resolution strategies: `code`, `cli`, `prompt`, `skill`
- [x] **6.2** Create `src/skills/resolution-chain.js` - Executes resolvers in order, returns first successful result
- [x] **6.3** Modify `skill-registry.js` to use resolution chain when handling commands
- [x] **6.4** Update hello-world skill as example with a `code` resolver that handles greetings without LLM
- [x] **6.5** Add resolver metadata to skill `getMetadata()` output so UI can show which resolution method was used
- [x] **6.6** Add a `--force-prompt` flag that skips code/CLI resolvers and goes straight to LLM (for debugging or when deterministic result is wrong)

### Progress Notes

- ✅ Completed 2026-03-23: skill priority hierarchy + resolution chain (6.1–6.6)
- Extended skill metadata docs to include optional ordered `resolvers` and added optional resolver methods (`resolveCode`, `resolveCli`, `resolvePrompt`) to the base skill interface
- Added `src/skills/resolution-chain.js` to execute `code -> cli -> prompt -> skill` style resolver stacks and annotate each result with resolution metadata
- Updated `src/skills/skill-registry.js` to run commands through resolver chains, persist last-used resolution method per skill, and expose resolver metadata in `listSkills()`
- Updated `skills/hello-world` to declare `resolvers: ['code', 'skill']` and implement deterministic `resolveCode` handling for `/hello` and `/greet`
- Added `--force-prompt` support in both desktop and Telegram skill execution paths, routing via registry options to skip deterministic resolvers
- Verified behavior with node checks and a scripted resolver-chain smoke test showing normal `code` resolution and forced prompt fallback path

---

## 7. Notification Routing (Duration-Aware)

**Priority:** Low | **Complexity:** Low

Escalate notifications based on task duration. Short tasks = no notification. Long tasks = push notification via configurable channel.

### Tasks

- [ ] **7.1** Create `src/notifications/notification-router.js` - Routes notifications based on duration thresholds: <30s (none), 30s-2min (UI toast), 2min+ (external push)
- [ ] **7.2** Create `src/notifications/channels/ui-toast.js` - Electron notification API for desktop toasts
- [ ] **7.3** Create `src/notifications/channels/ntfy-channel.js` - Push via ntfy.sh (simple HTTP POST, no auth required for public topics)
- [ ] **7.4** Add notification settings to UI - Enable/disable, ntfy topic, duration thresholds
- [ ] **7.5** Wire into agent execution - Start timer on agent.execute, route notification on completion
- [ ] **7.6** Wire into Telegram bridge - Send completion message to Telegram chat for long-running tasks

---

## 8. Skill Customization Merging (Base + User Override)

**Priority:** Low | **Complexity:** Low

Allow users to override skill configs without modifying base skill files. Upgrade-safe customization.

### Tasks

- [x] **8.1** Create `skill-customizations/` directory in app user data path
- [x] **8.2** Modify `skill-loader.js` to check for user overrides in `skill-customizations/{skill-name}/` after loading base skill
- [x] **8.3** Implement deep merge strategy - User config overrides base config, arrays are replaced not merged
- [x] **8.4** Add `/skill customize <name>` command that opens/creates the customization file for a skill
- [x] **8.5** Document customization pattern in `skills/README.md`

### Progress Notes

- ✅ Completed 2026-03-23: skill customization merging + command + docs (8.1–8.5)
- Added upgrade-safe customization loading in `src/skills/skill-loader.js` with user-data directory support (`skill-customizations/<skill-id>/customization.json`)
- Implemented deep merge behavior for customization data with array replacement semantics (arrays replace, objects merge recursively)
- Added `/skill customize <skill-id>` command flow in desktop chat (`renderer.js` + `preload.js` + new `skill:customize` IPC in `main.js`) to create/open customization files quickly
- Added customization docs to `skills/README.md`, including file shape and merge rules
- Verified with syntax checks (`node --check` on touched JS files) and a node-based smoke test validating metadata override + array replacement behavior

---

## 9. Security Validation Hook

**Priority:** Medium | **Complexity:** Low

PAI has a SecurityValidator hook that validates tool calls against a deny list before execution. This is a concrete hook implementation that provides immediate value.

### Tasks

- [ ] **9.1** Create `hooks/security-validator/` - PreToolUse hook that checks Bash commands against a configurable deny list
- [ ] **9.2** Define default deny list - `rm -rf /`, `mkfs`, `dd if=`, `:(){ :|:& };:`, `chmod -R 777 /`, `> /dev/sda`, etc. (extend existing dangerous patterns in `src/tools/utils.js`)
- [ ] **9.3** Add path-based restrictions - Configurable list of protected paths that tools cannot write to
- [ ] **9.4** Add confirmation escalation - Instead of hard deny, some patterns trigger a "are you sure?" confirmation with explanation of risk
- [ ] **9.5** Log all security blocks to a `security.log` file for audit

---

## 10. Voice/TTS Integration

**Priority:** Low | **Complexity:** Medium

Add optional voice output for agent responses and task completion announcements.

### Tasks

- [ ] **10.1** Create `src/voice/tts-engine.js` - Abstract TTS interface with `speak(text, options)` method
- [ ] **10.2** Create `src/voice/engines/elevenlabs.js` - ElevenLabs API integration with voice selection and prosody settings (stability, speed, style)
- [ ] **10.3** Create `src/voice/engines/system-tts.js` - Fallback using OS native TTS (Windows SAPI, macOS say, Linux espeak)
- [ ] **10.4** Add voice settings to UI - Enable/disable, engine selection, API key (for ElevenLabs), voice selection, speed/stability sliders
- [ ] **10.5** Add per-agent voice config to agent schema - Each agent can have distinct voice settings
- [ ] **10.6** Wire into agent completion - Optionally speak a summary of what the agent did
- [ ] **10.7** Wire into Telegram bridge - Send voice messages instead of/in addition to text for long responses
- [ ] **10.8** Add `/speak` slash command to read the last response aloud

---

## Dependency Graph

```
Independent (can start immediately):
  3. Multi-Tier Inference
  4. Dynamic System Prompt
  5. TELOS User Context
  7. Notification Routing
  8. Skill Customization Merging
  10. Voice/TTS

Depends on Hook System (1):
  9. Security Validation Hook

Depends on nothing but benefits from Hook System:
  2. Tiered Memory (can use hooks for auto-capture, but core works standalone)

Depends on Skill Interface changes:
  6. Skill Priority Hierarchy
```

## Suggested Execution Order

1. **Multi-Tier Inference** (3) - Low effort, high impact, no dependencies
2. **Hook System** (1) - Unlocks 9 and enhances 2
3. **Tiered Memory** (2) - Core differentiator
4. **Dynamic System Prompt** (4) - Pairs with TELOS
5. **TELOS User Context** (5) - Uses templates from 4
6. **Security Validation Hook** (9) - Uses hook system from 1
7. **Skill Priority Hierarchy** (6) - Enhances existing skills
8. **Notification Routing** (7) - Nice-to-have
9. **Skill Customization Merging** (8) - Nice-to-have
10. **Voice/TTS** (10) - Nice-to-have
