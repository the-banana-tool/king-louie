const fs = require('fs');
const path = require('path');
const AnthropicOAuth = require('../auth/anthropic-oauth');
const ProviderFactory = require('../providers/provider-factory');
const InferenceRouter = require('../providers/inference-router');
const { initializeTools, toolRegistry } = require('../tools');
const { registerSecretDataDir } = require('../tools/utils');
const { adminCredentialPath } = require('../platform/paths');
const ToolExecutor = require('../execution/tool-executor');
const DenialTracker = require('../tools/denial-tracker');
const AgentLoop = require('../execution/agent-loop');
const {
  getRuntimeEnvironment,
  resetRuntimeEnvironmentCache
} = require('../execution/runtime-environment');
const {
  discoverAllApps,
  buildAppContextSection,
  setCustomAppsStore,
  getCachedDiscoveredApps,
  addCustomApp,
  removeCustomApp,
  resetDiscoveryCache
} = require('../execution/app-discovery');
const { TaskManager } = require('../tasks/task-manager');
const AgentExecutor = require('../agents/agent-executor');
const AgentOrchestrator = require('../agents/orchestrator');
const { getAgent, listAgents } = require('../agents');
const GatewayServer = require('../gateway/gateway-server');
const SessionManager = require('../gateway/session-manager');
const RemoteControl = require('../gateway/remote-control');
const { ChannelRegistry } = require('../channels/channel-plugin');
const AllowlistManager = require('../channels/allowlist-manager');
const TelegramBridge = require('../channels/telegram-bridge');
const DiscordChannel = require('../channels/discord-bridge');
const SlackChannel = require('../channels/slack-bridge');
const MessageTool = require('../tools/builtin/message-tool');
const {
  SessionsListTool,
  SessionsHistoryTool,
  SessionsSpawnTool
} = require('../tools/builtin/sessions-tools');
const { SkillLoader, skillRegistry, PinManager } = require('../skills');
const UserProfile = require('../telos/user-profile');
const { loadProjectContext } = require('../telos/project-context');
const HookRegistry = require('../hooks/hook-registry');
const HookExecutor = require('../hooks/hook-executor');
const CronStore = require('../cron/cron-store');
const CronExecutor = require('../cron/cron-executor');
const CronScheduler = require('../cron/cron-scheduler');
const { MemoryStore, MemoryManager } = require('../memory');
const { CheckpointManager } = require('../checkpoints');
const { CaseRuntime, resolveCasesRoot } = require('../cases');
const ContextAssembler = require('../context/context-assembler');
const ConversationCompactor = require('../context/conversation-compactor');
const { buildSystemSections } = require('../context/system-sections');
const UsageTracker = require('../tracking/usage-tracker');
const {
  NotificationRouter,
  normalizeNotificationSettings
} = require('../notifications/notification-router');
const { TTSEngine, DEFAULT_VOICE_SETTINGS } = require('../voice/tts-engine');
const WebhookRegistry = require('../webhooks/webhook-registry');
const WebhookHandler = require('../webhooks/webhook-handler');
const WebhookServer = require('../webhooks/webhook-server');
const { initializeMesh } = require('../mesh');
const LLMRouter = require('../providers/llm-router');
const { WorkflowEngine } = require('../workflows/workflow-engine');
const PlannerExecutor = require('../workflows/planner-executor');
const { MCPManager, createVaultEnvResolver } = require('../mcp');
const { BackgroundTaskManager } = require('../tasks/background-task-manager');
const { createLogger } = require('../logging');
const { DEFAULT_SETTINGS, mergeSettings } = require('./settings');
const { createVault } = require('../platform/vault');
const { ensureGatewayToken } = require('../gateway/gateway-token');
const { createHeadlessPrompter } = require('../platform/prompter');
const { withTimeout } = require('./with-timeout');

const DEFAULT_FEATURES = { gateway: true, webhooks: true, mesh: true, channels: true, appDiscovery: true };
// Every provider king-louie can hold a token for (keys) and its display name.
const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  copilot: 'GitHub Copilot',
  groq: 'Groq',
  mistral: 'Mistral AI',
  ollama: 'Ollama (Local)',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  xai: 'xAI (Grok)',
  deepseek: 'DeepSeek',
  qwen: 'Qwen (Alibaba)',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  cohere: 'Cohere'
};

// The Electron app's ports. The webhook listener defaults to gateway + 1.
const DEFAULT_GATEWAY_PORT = 18789;

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
  // Where the agent works: the root for the tool executor, the hooks
  // directory, project context and the SessionStart/SessionEnd hook payloads.
  // The Electron host leaves this unset and gets process.cwd() as before; the
  // service passes <dataDir>/workspace explicitly. createCore never chdirs the
  // process — whether to do that is the host's decision (src/service/run.js
  // does, for the consumers of process.cwd() createCore does not own).
  const hostWorkingDirectory = deps.workingDirectory || process.cwd();
  // The ungated read tools (Read, Grep, Glob) never ask for approval, so the
  // only thing between a remote origin and this directory's master key,
  // gateway token and encrypted stores is a deny-list. Tell it where they are.
  registerSecretDataDir(paths.dataDir);
  // The master key is not always inside the data dir: systemd hands it to the
  // service in $CREDENTIALS_DIRECTORY, and on macOS (and Linux without
  // systemd) it lives in the admin config dir. Unreachable while
  // allowedDirectories is empty and the workspace is under the data dir — but
  // an operator who widens allowedDirectories must not thereby expose the raw
  // hex key.
  const credentialDirs = [deps.credentialsDir, process.env.CREDENTIALS_DIRECTORY];
  try {
    credentialDirs.push(path.dirname(adminCredentialPath({ dataDir: paths.dataDir })));
  } catch {
    // A data dir we cannot derive an admin location from is simply not added.
  }
  for (const dir of credentialDirs) {
    if (dir) registerSecretDataDir(dir);
  }
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 5000;
  // 'allow' (default, the Electron app's behaviour): an approval requester
  // attached by a remote origin (a chat channel's Approve button, a gateway
  // client, a child agent of one) may approve unsafe tools. 'deny': every such
  // requester is ignored, so approval-requiring tools are denied unless a
  // local UI listener (Electron IPC) or an auto-approve rule allows them.
  const ports = { gateway: DEFAULT_GATEWAY_PORT, ...(deps.ports || {}) };
  const remoteApprovals = deps.remoteApprovals ?? 'allow';
  if (remoteApprovals !== 'allow' && remoteApprovals !== 'deny') {
    throw new Error(`createCore: remoteApprovals must be 'allow' or 'deny', got ${JSON.stringify(remoteApprovals)}`);
  }

  // ── moved from main.js ──
  const log = createLogger('main');
  const memoryLog = createLogger('memory');
  const hooksLog = createLogger('hooks');
  const systemPromptLog = createLogger('system-prompt');
  const contextAssemblerLog = createLogger('context-assembler');
  const mcpLog = createLogger('mcp');
  const skillsLog = createLogger('skills');

  let meshContext;
  let skillLoader;
  let pinManager;
  const pendingApprovalResolvers = new Map();
  const pendingCanvasJsResolvers = new Map();
  let taskManager;
  let gatewayServer;
  let sessionManager;
  let remoteControl;
  let channelRegistry;
  let telegramBridge;
  let discordBridge;
  let slackChannel;
  let allowlistManager;
  let userProfile;
  let notificationRouter;
  let hookRegistry;
  let hookExecutor;
  let memoryStore;
  let memoryManager;
  let checkpointManager;
  let contextAssembler;
  let conversationCompactor;
  let ttsEngine;
  let usageTracker;
  let cronStore;
  let cronExecutor;
  let cronScheduler;
  let mcpManager;
  let backgroundTaskManager;
  let webhookRegistry;
  let webhookHandler;
  let webhookServer;
  // Resolves once the webhook listener's bind has settled, one way or the
  // other. `WebhookServer.start()` assigns `this.httpServer` synchronously and
  // only nulls it when the bind rejects, so between the fire-and-forget call
  // below and that rejection "has a handle" reads as "bound" to anyone
  // checking — which is how service mode could report itself ready with
  // `features.webhooks` on and no webhook listener (src/service/run.js).
  let webhookListenerSettled = Promise.resolve();
  let workflowEngine;
  let plannerExecutor;
  let llmRouter;
  let agentExecutorAdapter;
  let discoveredApps = [];
  const TELEGRAM_TOKEN_STORE_KEY = '__telegram_bot_token';
  const DISCORD_TOKEN_STORE_KEY = '__discord_bot_token';
  const SLACK_APP_TOKEN_STORE_KEY = '__slack_app_token';
  const SLACK_BOT_TOKEN_STORE_KEY = '__slack_bot_token';
  const ELEVENLABS_TOKEN_STORE_KEY = '__elevenlabs_api_key';

  const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const getChats = () => store.get('chats', []);
  const setChats = (chats) => store.set('chats', chats);
  const getActiveChatId = () => store.get('activeChatId', null);
  const setActiveChatId = (chatId) => store.set('activeChatId', chatId);
  const getApiTokens = () => store.get('apiTokens', {});
  const setApiTokens = (tokens) => store.set('apiTokens', tokens);
  const getApiStatus = () => store.get('apiStatus', {});
  const setApiStatus = (status) => store.set('apiStatus', status);
  const getSettings = () => mergeSettings(store.get('settings', DEFAULT_SETTINGS));
  const setSettings = (settings) => store.set('settings', mergeSettings(settings));
  const normalizeTemplateVariables = (templateVariables = {}) => ({
    name: String(templateVariables?.name || '').trim(),
    role: String(templateVariables?.role || '').trim(),
    preferences: String(templateVariables?.preferences || '').trim(),
    projectContext: String(templateVariables?.projectContext || '').trim()
  });

  const getTemplateVariables = () => {
    const settings = getSettings();
    return normalizeTemplateVariables(settings.templateVariables || {});
  };

  const setTemplateVariables = (templateVariables = {}) => {
    const settings = getSettings();
    const updated = {
      ...settings,
      templateVariables: normalizeTemplateVariables(templateVariables)
    };
    setSettings(updated);
    return updated.templateVariables;
  };

  const normalizeUserProfileInput = (profile = {}) => ({
    ...(profile || {}),
    goals: Array.isArray(profile?.goals)
      ? profile.goals
      : String(profile?.goals || '')
          .split(/\r?\n|;/)
          .map((goal) => String(goal || '').trim())
          .filter(Boolean)
  });

  const getUserProfile = () => {
    if (!userProfile) {
      return UserProfile.getDefaultProfile();
    }

    return userProfile.getProfile();
  };

  const updateUserProfile = (profile = {}) => {
    if (!userProfile) {
      throw new Error('User profile manager is not initialized.');
    }

    return userProfile.updateProfile(normalizeUserProfileInput(profile));
  };

  const formatUserContextSection = (profile = getUserProfile()) => {
    const normalized = (profile && typeof profile === 'object') ? profile : {};
    const goals = Array.isArray(normalized.goals) ? normalized.goals.filter(Boolean) : [];
    const preferences =
      normalized.preferences && typeof normalized.preferences === 'object'
        ? normalized.preferences
        : {};

    const preferenceEntries = Object.entries(preferences)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .filter(Boolean);

    return [
      'User Context:',
      `- Name: ${normalized.name || '(not set)'}`,
      `- Role: ${normalized.role || '(not set)'}`,
      `- Goals: ${goals.length ? goals.join('; ') : '(none set)'}`,
      `- Preferences: ${preferenceEntries.length ? preferenceEntries.join('; ') : '(none set)'}`,
      `- Project Context: ${normalized.projectContext || '(not set)'}`
    ].join('\n');
  };

  const getProjectContextPayload = (workingDirectory = hostWorkingDirectory) => {
    return loadProjectContext({ workingDirectory });
  };

  const formatProjectContextSection = (workingDirectory = hostWorkingDirectory) => {
    const projectContext = getProjectContextPayload(workingDirectory);
    if (!projectContext?.content) {
      return '';
    }

    return [
      'Project TELOS Context:',
      `- Source: ${projectContext.path}`,
      '',
      projectContext.content
    ].join('\n');
  };

  const buildMemoryContextSection = async (query = '', options = {}) => {
    if (!memoryManager) {
      return '';
    }

    try {
      return await memoryManager.buildPromptContext(query, {
        limit: options.limit || 6
      });
    } catch (error) {
      memoryLog.warn(`Failed building memory context: ${error.message}`);
      return '';
    }
  };

  const buildTemplateContextFromSettings = () => {
    const templateVariables = getTemplateVariables();
    const profileContext = userProfile ? userProfile.toTemplateContext(getUserProfile()) : {};
    const projectContext = getProjectContextPayload(hostWorkingDirectory);
    return {
      ...profileContext,
      user: {
        ...(profileContext.user || {}),
        name: templateVariables.name,
        role: templateVariables.role,
        preferences: templateVariables.preferences
      },
      project: {
        ...(profileContext.project || {}),
        context: templateVariables.projectContext,
        telosContext: projectContext.content || '',
        telosContextPath: projectContext.path || ''
      }
    };
  };
  const getToolApprovals = () => store.get('toolApprovals', { alwaysApproveTools: {} });
  const setToolApprovals = (toolApprovals) => store.set('toolApprovals', toolApprovals);

  const isToolAlwaysApproved = (toolName) => {
    const approvals = getToolApprovals();
    return Boolean(approvals?.alwaysApproveTools?.[toolName]);
  };

  const setToolAlwaysApprove = (toolName, approved = true) => {
    const approvals = getToolApprovals();
    const updated = {
      ...approvals,
      alwaysApproveTools: {
        ...(approvals?.alwaysApproveTools || {}),
        [toolName]: Boolean(approved)
      }
    };

    setToolApprovals(updated);
  };

  // Persisted pattern-based permission rules. Shape:
  //   [{ tool, pattern, action: 'allow'|'ask'|'deny', source, createdAt }]
  // ToolExecutor reads these at approval time via getPermissionRules() and
  // short-circuits the per-tool flag when a rule matches.
  const getPermissionRules = () => {
    const approvals = getToolApprovals();
    return Array.isArray(approvals?.permissionRules) ? approvals.permissionRules : [];
  };

  const setPermissionRules = (rules) => {
    const approvals = getToolApprovals();
    setToolApprovals({
      ...approvals,
      permissionRules: Array.isArray(rules) ? rules : []
    });
  };

  const addPermissionRule = (rule) => {
    if (!rule || !rule.tool || !rule.action) return;
    const existing = getPermissionRules();
    // De-duplicate: same tool + pattern + action replaces the old entry
    // (useful when user upgrades "ask" to "allow").
    const filtered = existing.filter((r) =>
      !(r.tool === rule.tool && (r.pattern || '*') === (rule.pattern || '*') && r.action === rule.action)
    );
    filtered.push({
      tool: rule.tool,
      pattern: rule.pattern || '*',
      action: rule.action,
      source: rule.source || 'user',
      createdAt: new Date().toISOString()
    });
    setPermissionRules(filtered);
  };

  const removePermissionRule = (tool, pattern, action) => {
    const existing = getPermissionRules();
    const filtered = existing.filter((r) =>
      !(r.tool === tool && (r.pattern || '*') === (pattern || '*') && r.action === action)
    );
    setPermissionRules(filtered);
  };

  const providerLabels = PROVIDER_LABELS;

  const providerDefaults = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-20250514',
    copilot: '',
    groq: 'llama-3.3-70b-versatile',
    mistral: 'mistral-large-latest',
    ollama: '',
    gemini: 'gemini-2.0-flash',
    openrouter: 'openai/gpt-4o-mini',
    xai: 'grok-3-mini',
    deepseek: 'deepseek-chat',
    qwen: 'qwen-plus',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    cohere: 'command-r-plus'
  };

  const providerTokenHints = {
    openai: 'sk-',
    anthropic: 'sk-ant-',
    copilot: 'ghp_',
    groq: 'gsk_',
    mistral: '',
    gemini: '',
    openrouter: 'sk-or-',
    xai: 'xai-',
    deepseek: 'sk-',
    qwen: 'sk-',
    together: '',
    fireworks: '',
    cohere: ''
  };

  const normalizeProvider = (value = '') => String(value || '').trim().toLowerCase();

  const isSupportedProvider = (provider) => Boolean(providerLabels[provider]);

  const validateProviderToken = (provider, token) => {
    if (!token || token.trim().length < 8) {
      return 'Token is required and must be at least 8 characters.';
    }

    const expectedPrefix = providerTokenHints[provider];
    if (expectedPrefix && !token.startsWith(expectedPrefix)) {
      return `${providerLabels[provider]} tokens typically start with "${expectedPrefix}".`;
    }

    return null;
  };

  const getProviderModel = (provider) => {
    const settings = getSettings();
    return settings.providerModels?.[provider] || providerDefaults[provider] || '';
  };

  const setProviderModel = (provider, model) => {
    const settings = getSettings();
    const updated = {
      ...settings,
      providerModels: {
        ...(settings.providerModels || {}),
        [provider]: (model || '').trim()
      }
    };
    setSettings(updated);
    return updated.providerModels[provider];
  };

  const setActiveProvider = (provider) => {
    const settings = getSettings();
    const updated = {
      ...settings,
      activeProvider: provider
    };
    setSettings(updated);
    resetRuntimeEnvironmentCache();
    return updated.activeProvider;
  };

  const setActiveInferenceTier = (tier) => {
    const normalizedTier = String(tier || '').toLowerCase();
    if (!['fast', 'standard', 'smart'].includes(normalizedTier)) {
      throw new Error('Inference tier must be one of: fast, standard, smart.');
    }

    const settings = getSettings();
    const updated = {
      ...settings,
      inference: {
        ...(settings.inference || {}),
        activeTier: normalizedTier
      }
    };

    setSettings(updated);
    return updated.inference;
  };

  const setNotificationSettings = (notifications = {}) => {
    const settings = getSettings();
    const updated = {
      ...settings,
      notifications: normalizeNotificationSettings({
        ...(settings.notifications || {}),
        ...(notifications || {})
      })
    };

    setSettings(updated);
    return updated.notifications;
  };

  const normalizeVoiceSettings = (voice = {}) => {
    const source = voice && typeof voice === 'object' ? voice : {};
    const toNumberOr = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const sanitized = {
      ...DEFAULT_VOICE_SETTINGS,
      ...source,
      enabled: source.enabled === true,
      engine: String(source.engine || DEFAULT_VOICE_SETTINGS.engine).trim().toLowerCase() === 'elevenlabs'
        ? 'elevenlabs'
        : 'system',
      voiceId: String(source.voiceId || '').trim(),
      speed: Math.max(0.5, Math.min(2, toNumberOr(source.speed, DEFAULT_VOICE_SETTINGS.speed))),
      stability: Math.max(0, Math.min(1, toNumberOr(source.stability, DEFAULT_VOICE_SETTINGS.stability))),
      style: Math.max(0, Math.min(1, toNumberOr(source.style, DEFAULT_VOICE_SETTINGS.style))),
      speakAgentSummary: source.speakAgentSummary !== false,
      speakChatResponses: source.speakChatResponses === true,
      telegramVoiceForLongResponses: source.telegramVoiceForLongResponses === true,
      telegramMinChars: Math.max(80, Math.round(toNumberOr(source.telegramMinChars, DEFAULT_VOICE_SETTINGS.telegramMinChars))),
      summaryMaxChars: Math.max(80, Math.round(toNumberOr(source.summaryMaxChars, DEFAULT_VOICE_SETTINGS.summaryMaxChars)))
    };

    return sanitized;
  };

  const getVoiceSettings = () => {
    const settings = getSettings();
    return normalizeVoiceSettings(settings.voice || {});
  };

  const setVoiceSettings = (voice = {}) => {
    const settings = getSettings();
    const updated = {
      ...settings,
      voice: normalizeVoiceSettings({
        ...(settings.voice || {}),
        ...(voice || {})
      })
    };

    setSettings(updated);
    return updated.voice;
  };

  const getHookSettings = () => {
    const settings = getSettings();
    return {
      enabled: settings?.hooks?.enabled !== false,
      hookStates: {
        ...(settings?.hooks?.hookStates || {})
      }
    };
  };

  const setHookSettings = (hooks = {}) => {
    const settings = getSettings();
    const updated = {
      ...settings,
      hooks: {
        ...(settings.hooks || {}),
        ...(hooks || {}),
        hookStates: {
          ...(settings?.hooks?.hookStates || {}),
          ...(hooks?.hookStates || {})
        }
      }
    };

    setSettings(updated);
    return updated.hooks;
  };

  const listHookDefinitions = () => {
    if (!hookRegistry) {
      return [];
    }

    return hookRegistry.list().map((hook) => ({
      name: hook.name,
      event: hook.event,
      matcher: hook.matcher,
      enabled: hook.enabled !== false,
      description: hook.description || '',
      handler: hook.handler,
      directory: hook.directory || ''
    }));
  };

  const reloadHooksFromSettings = () => {
    if (!hookRegistry) {
      return [];
    }

    const hookSettings = getHookSettings();
    hookRegistry.setEnabledOverrides(hookSettings.hookStates || {});
    hookRegistry.loadAll();
    return listHookDefinitions();
  };

  const setHookEnabled = (name, enabled) => {
    if (!hookRegistry) {
      throw new Error('Hook registry is not initialized.');
    }

    const hookName = String(name || '').trim();
    if (!hookName) {
      throw new Error('Hook name is required.');
    }

    const hook = hookRegistry.setEnabled(hookName, enabled);
    if (!hook) {
      throw new Error(`Hook not found: ${hookName}`);
    }

    const settings = getHookSettings();
    setHookSettings({
      hookStates: {
        ...(settings.hookStates || {}),
        [hookName]: Boolean(enabled)
      }
    });

    return {
      name: hook.name,
      event: hook.event,
      enabled: hook.enabled !== false
    };
  };

  const runHookEvent = async (eventName, context = {}) => {
    const hookSettings = getHookSettings();
    if (!hookExecutor || hookSettings.enabled === false) {
      return null;
    }

    try {
      return await hookExecutor.run(eventName, context);
    } catch (error) {
      hooksLog.warn(`${eventName} hook execution failed: ${error.message}`);
      return null;
    }
  };

  const encryptToken = (token) => (token ? cipher.encryptString(token) : null);
  const decryptToken = (encrypted) => (encrypted ? cipher.decryptString(encrypted) : null);

  const anthropicOAuth = new AnthropicOAuth({
    clientId: store.get('anthropicOAuthClientId', ''),
    encryptToken,
    decryptToken,
    store,
    openExternal: deps.openExternal
  });

  const updateStatus = (provider, status) => {
    const current = getApiStatus();
    const updated = {
      ...current,
      [provider]: {
        ...status,
        checkedAt: new Date().toISOString()
      }
    };
    setApiStatus(updated);
    return updated[provider];
  };

  const sumLlmCalls = (calls = []) =>
    (calls || []).reduce(
      (acc, call) => ({
        inputTokens: acc.inputTokens + (Number(call?.inputTokens) || 0),
        outputTokens: acc.outputTokens + (Number(call?.outputTokens) || 0),
        totalTokens: acc.totalTokens + (Number(call?.totalTokens) || 0),
        costUsd: Number((acc.costUsd + (Number(call?.costUsd) || 0)).toFixed(8))
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
    );

  const createUsageRecordFromMetrics = (metrics = {}, durationMs = 0) => ({
    provider: metrics.provider,
    model: metrics.model,
    inputTokens: Number(metrics.inputTokens) || 0,
    outputTokens: Number(metrics.outputTokens) || 0,
    totalTokens: Number(metrics.totalTokens) || 0,
    costUsd: Number.isFinite(Number(metrics.costUsd)) ? Number(metrics.costUsd) : null,
    durationMs: Number(durationMs) || 0
  });

  const buildRuntimeSystemPrompt = (runtimeEnvironment = {}) => {
    const platform = runtimeEnvironment.platform || process.platform;
    const shell = runtimeEnvironment.shell || 'unknown';
    const available = Array.isArray(runtimeEnvironment.available)
      ? runtimeEnvironment.available
      : [];
    const unavailable = Array.isArray(runtimeEnvironment.unavailable)
      ? runtimeEnvironment.unavailable
      : [];

    const workingDirectory = runtimeEnvironment.workingDirectory || hostWorkingDirectory;

    const sections = [
      'Environment context (auto-detected):',
      `- Platform: ${platform}`,
      `- Shell: ${shell}`,
      `- Working directory: ${workingDirectory}`,
      `- Available CLI tools: ${available.length ? available.join(', ') : 'unknown'}`,
      `- Known missing CLI tools: ${unavailable.length ? unavailable.join(', ') : 'none detected'}`,
      '',
      'Important:',
      '- Each Bash command runs in a fresh shell — environment variables, virtual environment activation, and cd do not persist between calls. Use absolute paths or explicit venv paths (e.g. venv/Scripts/python on Windows, venv/bin/python on Unix) instead of relying on activate.',
      '- You have browser tools (BrowserSession + BrowserPage + BrowserExtract) that drive a real Playwright-controlled browser. Load only what you need: BrowserSession for start/stop/profiles/credentials/login/tabs, BrowserPage for navigate/click/type/wait/screenshot, BrowserExtract for reading content/iframes/network interception. The legacy "Browser" tool still works but has a much larger schema — prefer the split tools. Use them when the user asks to open or view something in a browser.',
      '- The browser is a singleton — only one instance runs at a time across all three tools. Before calling BrowserSession.start or profile_create, call BrowserSession.status (or profile_current) to see if a session already exists. Reuse it instead of creating a duplicate profile or hitting "Browser already running".',
      '- BackgroundTask spawns an agent in a separate tool runtime — it cannot share the foreground browser instance. Before spawning a new bg task, call TaskStatus action="list" to see what is already running; resume via TaskStatus instead of re-spawning. Avoid handing long-running browser sessions to BackgroundTask; drive them inline.',
      '- For mechanical multi-step work (paced web automation, scraping, repeated form fills), drive it inline in the foreground — each LLM round-trip costs real wall time, so plan a batch of actions and execute them with minimal back-and-forth.',
      '',
      'Use this context when proposing commands and selecting tools. Avoid commands for unavailable tools.'
    ];

    // Include discovered local applications
    if (discoveredApps.length > 0) {
      const appSection = buildAppContextSection(discoveredApps);
      if (appSection) {
        sections.push('');
        sections.push(appSection);
      }
    }

    // Include installed skills so the LLM knows they exist
    try {
      const skills = typeof skillRegistry.listSkills === 'function'
        ? skillRegistry.listSkills()
        : [];
      if (skills.length > 0) {
        sections.push('');
        sections.push('Installed skills (use the Skill tool to invoke these):');
        for (const s of skills) {
          const cmds = Array.isArray(s.commands) && s.commands.length ? ` (commands: ${s.commands.join(', ')})` : '';
          sections.push(`- ${s.id}: ${s.description || s.name || s.id}${cmds}`);
        }
        sections.push('When the user explicitly asks you to use a specific skill, prefer the Skill tool over built-in tools like Git or Bash.');
      }
    } catch (err) { systemPromptLog.debug(`skills unavailable: ${err.message}`); }

    return sections.join('\n');
  };

  const getChatLlmTotals = (chat) => {
    const messages = chat?.messages || [];
    const totals = messages.reduce(
      (acc, message) => ({
        inputTokens: acc.inputTokens + (Number(message?.llm?.totals?.inputTokens) || 0),
        outputTokens: acc.outputTokens + (Number(message?.llm?.totals?.outputTokens) || 0),
        totalTokens: acc.totalTokens + (Number(message?.llm?.totals?.totalTokens) || 0),
        costUsd: Number((acc.costUsd + (Number(message?.llm?.totals?.costUsd) || 0)).toFixed(8))
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
    );

    return totals;
  };

  const appendMessageToChat = (chatId, sender, text, metadata = {}) => {
    const now = new Date().toISOString();
    const chats = getChats();
    const updated = chats.map((chat) => {
      if (chat.id !== chatId) {
        return chat;
      }

      return {
        ...chat,
        updatedAt: now,
        messages: [
          ...chat.messages,
          {
            id: createId(),
            sender,
            text,
            timestamp: now,
            ...(metadata || {})
          }
        ],
        llmTotals: getChatLlmTotals({
          ...chat,
          messages: [
            ...chat.messages,
            {
              sender,
              text,
              ...(metadata || {})
            }
          ]
        })
      };
    });

    setChats(updated);
    return updated.find((chat) => chat.id === chatId) || null;
  };

  let _cachedOAuthAccessToken = null;
  let _cachedOAuthExpiresAt = 0;

  const TOKENLESS_PROVIDERS = new Set(['ollama']);

  const getDecryptedProviderToken = (provider) => {
    // For Anthropic, check if OAuth is connected first
    if (provider === 'anthropic' && anthropicOAuth.isConnected()) {
      // Return cached token if still valid (with 60s buffer)
      if (_cachedOAuthAccessToken && Date.now() < _cachedOAuthExpiresAt - 60_000) {
        return _cachedOAuthAccessToken;
      }
      // Signal that OAuth is active but token needs refresh
      return '__anthropic_oauth__';
    }

    const tokens = getApiTokens();
    const encryptedToken = tokens[provider];
    if (!encryptedToken) {
      if (TOKENLESS_PROVIDERS.has(provider)) {
        return 'not-required';
      }
      throw new Error(`No token saved for ${providerLabels[provider] || provider}.`);
    }
    return decryptToken(encryptedToken);
  };

  const refreshAnthropicOAuthToken = async () => {
    try {
      const result = await anthropicOAuth.getValidAccessToken();
      _cachedOAuthAccessToken = result;
      const status = anthropicOAuth.getStatus();
      _cachedOAuthExpiresAt = status.expiresAt || (Date.now() + 3600_000);
      return result;
    } catch (err) {
      _cachedOAuthAccessToken = null;
      _cachedOAuthExpiresAt = 0;
      throw err;
    }
  };

  const saveProviderToken = (provider, token) => {
    const tokens = getApiTokens();
    tokens[provider] = encryptToken(token.trim());
    setApiTokens(tokens);
    return true;
  };

  const clearProviderToken = (provider) => {
    const tokens = getApiTokens();
    delete tokens[provider];
    setApiTokens(tokens);
    return false;
  };

  const normalizeSkillIdForCustomization = (rawSkillId = '') => {
    return String(rawSkillId || '').trim().toLowerCase();
  };

  const ensureSkillCustomizationFile = (skillId) => {
    const normalizedSkillId = normalizeSkillIdForCustomization(skillId);
    if (!normalizedSkillId) {
      throw new Error('Skill ID is required. Usage: /skill customize <skill-id>');
    }

    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(normalizedSkillId)) {
      throw new Error('Skill ID contains invalid characters.');
    }

    const skill = skillRegistry.getSkill(normalizedSkillId);
    if (!skill) {
      throw new Error(`Unknown skill: ${normalizedSkillId}`);
    }

    const customizationDir = path.join(userDataPath, 'skill-customizations', normalizedSkillId);
    fs.mkdirSync(customizationDir, { recursive: true });

    const customizationFilePath = path.join(customizationDir, 'customization.json');
    const existed = fs.existsSync(customizationFilePath);

    if (!existed) {
      const metadata = skill.getMetadata();
      const template = {
        metadata: {
          description: metadata?.description || '',
          commands: Array.isArray(metadata?.commands) ? metadata.commands : [],
          resolvers: Array.isArray(metadata?.resolvers) ? metadata.resolvers : ['skill']
        },
        settings: {}
      };

      fs.writeFileSync(customizationFilePath, `${JSON.stringify(template, null, 2)}\n`, 'utf-8');
    }

    return {
      skillId: normalizedSkillId,
      path: customizationFilePath,
      created: !existed
    };
  };

  const hasStoredTelegramToken = () => {
    const tokens = getApiTokens();
    return Boolean(tokens[TELEGRAM_TOKEN_STORE_KEY]);
  };

  const saveTelegramToken = (token) => {
    const tokens = getApiTokens();
    tokens[TELEGRAM_TOKEN_STORE_KEY] = encryptToken(token.trim());
    setApiTokens(tokens);
  };

  const clearTelegramToken = () => {
    const tokens = getApiTokens();
    delete tokens[TELEGRAM_TOKEN_STORE_KEY];
    setApiTokens(tokens);
  };

  const getDecryptedTelegramToken = () => {
    const tokens = getApiTokens();
    const encryptedToken = tokens[TELEGRAM_TOKEN_STORE_KEY];
    if (!encryptedToken) return null;
    return decryptToken(encryptedToken);
  };

  const hasStoredDiscordToken = () => {
    const tokens = getApiTokens();
    return Boolean(tokens[DISCORD_TOKEN_STORE_KEY]);
  };

  const saveDiscordToken = (token) => {
    const tokens = getApiTokens();
    tokens[DISCORD_TOKEN_STORE_KEY] = encryptToken(token.trim());
    setApiTokens(tokens);
  };

  const clearDiscordToken = () => {
    const tokens = getApiTokens();
    delete tokens[DISCORD_TOKEN_STORE_KEY];
    setApiTokens(tokens);
  };

  const getDecryptedDiscordToken = () => {
    const tokens = getApiTokens();
    const encryptedToken = tokens[DISCORD_TOKEN_STORE_KEY];
    if (!encryptedToken) return null;
    return decryptToken(encryptedToken);
  };

  const hasStoredSlackAppToken = () => {
    const tokens = getApiTokens();
    return Boolean(tokens[SLACK_APP_TOKEN_STORE_KEY]);
  };

  const saveSlackAppToken = (token) => {
    const tokens = getApiTokens();
    tokens[SLACK_APP_TOKEN_STORE_KEY] = encryptToken(token.trim());
    setApiTokens(tokens);
  };

  const clearSlackAppToken = () => {
    const tokens = getApiTokens();
    delete tokens[SLACK_APP_TOKEN_STORE_KEY];
    setApiTokens(tokens);
  };

  const getDecryptedSlackAppToken = () => {
    const tokens = getApiTokens();
    const encryptedToken = tokens[SLACK_APP_TOKEN_STORE_KEY];
    if (!encryptedToken) return null;
    return decryptToken(encryptedToken);
  };

  const hasStoredSlackBotToken = () => {
    const tokens = getApiTokens();
    return Boolean(tokens[SLACK_BOT_TOKEN_STORE_KEY]);
  };

  const saveSlackBotToken = (token) => {
    const tokens = getApiTokens();
    tokens[SLACK_BOT_TOKEN_STORE_KEY] = encryptToken(token.trim());
    setApiTokens(tokens);
  };

  const clearSlackBotToken = () => {
    const tokens = getApiTokens();
    delete tokens[SLACK_BOT_TOKEN_STORE_KEY];
    setApiTokens(tokens);
  };

  const getDecryptedSlackBotToken = () => {
    const tokens = getApiTokens();
    const encryptedToken = tokens[SLACK_BOT_TOKEN_STORE_KEY];
    if (!encryptedToken) return null;
    return decryptToken(encryptedToken);
  };

  const hasStoredElevenLabsToken = () => {
    const tokens = getApiTokens();
    return Boolean(tokens[ELEVENLABS_TOKEN_STORE_KEY]);
  };

  const saveElevenLabsToken = (token) => {
    const tokens = getApiTokens();
    tokens[ELEVENLABS_TOKEN_STORE_KEY] = encryptToken(token.trim());
    setApiTokens(tokens);
  };

  const clearElevenLabsToken = () => {
    const tokens = getApiTokens();
    delete tokens[ELEVENLABS_TOKEN_STORE_KEY];
    setApiTokens(tokens);
  };

  const getDecryptedElevenLabsToken = () => {
    const tokens = getApiTokens();
    const encryptedToken = tokens[ELEVENLABS_TOKEN_STORE_KEY];
    if (!encryptedToken) return null;
    return decryptToken(encryptedToken);
  };

  const buildAgentVoiceOptions = (agent = null) => {
    const globalVoice = getVoiceSettings();
    const agentVoice = agent?.voice || {};

    return {
      ...globalVoice,
      ...agentVoice,
      enabled:
        (agentVoice && Object.prototype.hasOwnProperty.call(agentVoice, 'enabled'))
          ? agentVoice.enabled === true
          : globalVoice.enabled === true,
      engine: agentVoice.engine || globalVoice.engine,
      voiceId: agentVoice.voiceId || globalVoice.voiceId,
      speed:
        typeof agentVoice.speed === 'number' && Number.isFinite(agentVoice.speed)
          ? agentVoice.speed
          : globalVoice.speed,
      stability:
        typeof agentVoice.stability === 'number' && Number.isFinite(agentVoice.stability)
          ? agentVoice.stability
          : globalVoice.stability,
      style:
        typeof agentVoice.style === 'number' && Number.isFinite(agentVoice.style)
          ? agentVoice.style
          : globalVoice.style,
      summaryMaxChars:
        typeof agentVoice.summaryMaxChars === 'number' && Number.isFinite(agentVoice.summaryMaxChars)
          ? agentVoice.summaryMaxChars
          : globalVoice.summaryMaxChars
    };
  };

  const speakSummaryText = async (text, voiceOptions = {}) => {
    if (!ttsEngine) {
      return { ok: false, skipped: true, reason: 'TTS engine not initialized.' };
    }

    try {
      return await ttsEngine.speakSummary(text, voiceOptions);
    } catch (error) {
      return { ok: false, skipped: true, reason: error.message };
    }
  };

  const buildAgentCompletionSummary = (agent, content = '') => {
    const safeContent = String(content || '').trim();
    const snippet = safeContent.length > 320 ? `${safeContent.slice(0, 317)}...` : safeContent;
    return `${agent?.name || 'Agent'} completed. ${snippet || 'No response content.'}`;
  };

  const getLastAssistantMessage = (chatId) => {
    const chat = getChats().find((item) => item.id === chatId);
    if (!chat) {
      return null;
    }

    const messages = Array.isArray(chat.messages) ? [...chat.messages] : [];
    return messages.reverse().find((message) => message?.sender === 'assistant') || null;
  };

  const validateTelegramToken = (token = '') => {
    const trimmed = String(token || '').trim();
    if (!trimmed) {
      return 'Telegram bot token is required.';
    }

    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
      return 'Telegram token format looks invalid. Expected like <digits>:<secret>.';
    }

    return null;
  };

  const stopDiscordBridge = async () => {
    if (!discordBridge) return;

    await discordBridge.stop();
    if (channelRegistry) {
      channelRegistry.unregister('discord');
    }
    discordBridge = null;
  };

  const startDiscordBridge = async (token) => {
    if (!token || !gatewayServer || !sessionManager) return;

    await stopDiscordBridge();

    discordBridge = new DiscordChannel({
      token,
      gatewayServer,
      sessionManager,
      allowlistManager,
      getChannelSettings: () => getSettings().channels?.discord || {},
      getAgent,
      listAgents,
      pinManager,
      getNotificationSettings: () => getSettings().notifications,
      getVoiceSettings,
      getTtsEngine: () => ttsEngine,
      createLocalChat: (title) => {
        const now = new Date().toISOString();
        const newChat = {
          id: createId(),
          title,
          createdAt: now,
          updatedAt: now,
          messages: []
        };
        const chats = [newChat, ...getChats()];
        setChats(chats);

        ui.send('chat:updated', { chats });

        return newChat.id;
      },
      addMessageToLocalChat: (chatId, sender, text) => {
        const chats = getChats();
        const chat = chats.find((c) => c.id === chatId);
        if (!chat) return;

        const now = new Date().toISOString();
        chat.messages.push({
          id: createId(),
          sender,
          text,
          timestamp: now
        });
        chat.updatedAt = now;

        setChats(chats);

        ui.send('chat:updated', { chats });
      }
    });

    if (channelRegistry) {
      channelRegistry.register(discordBridge);
      await channelRegistry.initializeAll(gatewayServer);
    } else {
      await discordBridge.start();
    }
  };

  const stopTelegramBridge = async () => {
    if (!telegramBridge) return;

    await telegramBridge.stop();
    if (channelRegistry) {
      channelRegistry.unregister('telegram');
    }
    telegramBridge = null;
  };

  const startTelegramBridge = async (token) => {
    if (!token || !gatewayServer || !sessionManager) return;

    await stopTelegramBridge();

    telegramBridge = new TelegramBridge({
      token,
      gatewayServer,
      sessionManager,
      allowlistManager,
      getChannelSettings: () => getSettings().channels?.telegram || {},
      getAgent,
      listAgents,
      pinManager,
      getNotificationSettings: () => getSettings().notifications,
      getVoiceSettings,
      getTtsEngine: () => ttsEngine,
      // Callbacks for local chat management
      createLocalChat: (title) => {
        const now = new Date().toISOString();
        const newChat = {
          id: createId(),
          title,
          createdAt: now,
          updatedAt: now,
          messages: []
        };
        const chats = [newChat, ...getChats()];
        setChats(chats);

        // Notify renderer if window exists
        ui.send('chat:updated', { chats });

        return newChat.id;
      },
      addMessageToLocalChat: (chatId, sender, text) => {
        const chats = getChats();
        const chat = chats.find((c) => c.id === chatId);
        if (!chat) return;

        const now = new Date().toISOString();
        chat.messages.push({
          id: createId(),
          sender,
          text,
          timestamp: now
        });
        chat.updatedAt = now;

        setChats(chats);

        // Notify renderer if window exists
        ui.send('chat:updated', { chats });
      }
    });

    if (channelRegistry) {
      channelRegistry.register(telegramBridge);
      await channelRegistry.initializeAll(gatewayServer);
    } else {
      await telegramBridge.start();
    }
  };

  const stopSlackChannel = async () => {
    if (!slackChannel) return;

    await slackChannel.shutdown();
    if (channelRegistry) {
      channelRegistry.unregister('slack');
    }
    slackChannel = null;
  };

  const startSlackChannel = async (appToken, botToken) => {
    if (!appToken || !botToken || !gatewayServer || !sessionManager) return;

    await stopSlackChannel();

    slackChannel = new SlackChannel({
      enabled: true,
      appToken,
      botToken,
      requireMention: getSettings().channels?.slack?.requireMention !== false,
      allowedChannels: getSettings().channels?.slack?.allowedChannels || []
    });

    if (channelRegistry) {
      channelRegistry.register(slackChannel);
      await channelRegistry.initializeAll(gatewayServer);
    } else {
      slackChannel.gateway = gatewayServer;
      await slackChannel.initialize(gatewayServer);
    }
  };

  const testTelegramConnection = async (token) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telegram API request failed: ${response.status} ${response.statusText} ${text}`);
    }

    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.description || 'Telegram API returned an unknown error.');
    }

    return payload.result;
  };

  const getProviderSnapshot = () => {
    const tokens = getApiTokens();
    const status = getApiStatus();
    const settings = getSettings();

    const providers = Object.keys(providerLabels).reduce((acc, key) => {
      acc[key] = {
        label: providerLabels[key],
        hasToken: Boolean(tokens[key]),
        status: status[key] || null,
        model: settings.providerModels?.[key] || providerDefaults[key] || ''
      };
      return acc;
    }, {});

    return {
      encryptionAvailable: cipher.isEncryptionAvailable(),
      providers,
      activeProvider: settings.activeProvider || 'openai',
      inference: settings.inference
    };
  };

  const testProviderConnection = async (provider) => {
    const tokens = getApiTokens();
    if (!tokens[provider]) {
      return { ok: false, error: 'No token saved for this provider.' };
    }

    const token = decryptToken(tokens[provider]);

    let response;
    if (provider === 'openai') {
      response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${token}` }
      });
    } else if (provider === 'anthropic') {
      response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': token,
          'anthropic-version': '2023-06-01'
        }
      });
    } else if (provider === 'copilot') {
      response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'king-louie-app'
        }
      });
    }

    if (!response) {
      return { ok: false, error: 'Unable to reach provider.' };
    }

    if (!response.ok) {
      const errorText = await response.text();
      const status = updateStatus(provider, {
        ok: false,
        message: `${response.status} ${response.statusText}`
      });
      return {
        ok: false,
        error: `${response.status} ${response.statusText}`,
        details: errorText,
        status
      };
    }

    const status = updateStatus(provider, {
      ok: true,
      message: 'Connection successful'
    });
    return { ok: true, status };
  };

  const tokenizeCommand = (input = '') => {
    const regex = /"([^"\\]*(\\.[^"\\]*)*)"|'([^'\\]*(\\.[^'\\]*)*)'|`([^`\\]*(\\.[^`\\]*)*)`|(\S+)/g;
    const tokens = [];
    let match;

    while ((match = regex.exec(input)) !== null) {
      const token = match[1] ?? match[3] ?? match[5] ?? match[7] ?? '';
      tokens.push(token.replace(/\\(["'`\\])/g, '$1'));
    }

    return tokens;
  };

  const runLlmCommand = async (command = '') => {
    const trimmed = String(command || '').trim();
    const parts = tokenizeCommand(trimmed);
    const [namespace, actionRaw, ...rest] = parts;
    const action = (actionRaw || '').toLowerCase();

    if (namespace !== '/llm') {
      return {
        ok: false,
        error: 'Unknown local command. Use `/llm help` for usage.'
      };
    }

    if (!action || action === 'help') {
      return {
        ok: true,
        output: [
          '### Local LLM Connection Tool',
          '',
          '- `/llm list` — list configured providers and connection status',
          '- `/llm add <provider> <token>` — add/update provider API token',
          '- `/llm remove <provider>` — remove saved provider token',
          '- `/llm test <provider>` — test provider connection',
          '- `/llm use <provider>` — set active provider',
          '- `/llm model <provider> <model>` — set model for provider',
          '- `/llm telegram add <token>` — save Telegram bot token and start bridge',
          '- `/llm telegram test` — test saved Telegram token',
          '- `/llm telegram remove` — clear Telegram token and stop bridge',
          '- `/llm telegram status` — show Telegram bridge status',
          '- `/llm slack add <app_token> <bot_token>` — save Slack tokens and start bridge',
          '- `/llm slack test` — test saved Slack tokens',
          '- `/llm slack remove` — clear Slack tokens and stop bridge',
          '- `/llm slack status` — show Slack bridge status',
          '- `/llm voice add <elevenlabs_api_key>` — save ElevenLabs API key',
          '- `/llm voice test` — test ElevenLabs API key',
          '- `/llm voice remove` — clear saved ElevenLabs API key',
          '- `/llm voice status` — show voice/TTS status',
          '',
          'Providers: `openai`, `anthropic`, `copilot`'
        ].join('\n')
      };
    }

    if (action === 'discord') {
      const subAction = (rest[0] || 'status').toLowerCase();
      const token = rest.slice(1).join(' ').trim();

      if (subAction === 'status') {
        const status = getApiStatus()?.discord || null;
        return {
          ok: true,
          output: [
            '### Discord Bridge',
            `- Token: ${hasStoredDiscordToken() ? 'saved' : 'missing'}`,
            `- Bridge: ${discordBridge ? 'running' : 'stopped'}`,
            `- Status: ${status?.message || 'not tested'}`
          ].join('\n')
        };
      }

      if (subAction === 'add' || subAction === 'save') {
        if (!token) return { ok: false, error: 'Token is required' };

        try {
          saveDiscordToken(token);
          await startDiscordBridge(token);
          updateStatus('discord', {
            ok: true,
            message: `Connected successfully`
          });

          return {
            ok: true,
            output: `Discord bridge connected.`
          };
        } catch (error) {
          updateStatus('discord', {
            ok: false,
            message: error.message
          });
          return { ok: false, error: error.message };
        }
      }

      if (subAction === 'remove' || subAction === 'clear') {
        await stopDiscordBridge();
        clearDiscordToken();
        updateStatus('discord', {
          ok: true,
          message: 'Discord token removed and bridge stopped.'
        });
        return {
          ok: true,
          output: 'Discord token removed and bridge stopped.'
        };
      }

      return {
        ok: false,
        error: 'Unknown discord action. Use add, remove, or status.'
      };
    }

    if (action === 'telegram') {
      const subAction = (rest[0] || 'status').toLowerCase();
      const token = rest.slice(1).join(' ').trim();

      if (subAction === 'status') {
        const status = getApiStatus()?.telegram || null;
        return {
          ok: true,
          output: [
            '### Telegram Bridge',
            `- Token: ${hasStoredTelegramToken() ? 'saved' : 'missing'}`,
            `- Bridge: ${telegramBridge ? 'running' : 'stopped'}`,
            `- Status: ${status?.message || 'not tested'}`
          ].join('\n')
        };
      }

      if (subAction === 'add' || subAction === 'save') {
        const validationError = validateTelegramToken(token);
        if (validationError) {
          return { ok: false, error: validationError };
        }

        try {
          const bot = await testTelegramConnection(token);
          saveTelegramToken(token);
          await startTelegramBridge(token);
          updateStatus('telegram', {
            ok: true,
            message: `Connected as @${bot?.username || 'telegram-bot'}`
          });

          return {
            ok: true,
            output: `Telegram bridge connected as @${bot?.username || 'telegram-bot'}.`
          };
        } catch (error) {
          updateStatus('telegram', {
            ok: false,
            message: error.message
          });
          return { ok: false, error: error.message };
        }
      }

      if (subAction === 'test') {
        const candidateToken = String(getDecryptedTelegramToken() || '').trim();
        if (!candidateToken) {
          return { ok: false, error: 'No Telegram token saved. Use `/llm telegram add <token>`.' };
        }

        try {
          const bot = await testTelegramConnection(candidateToken);
          updateStatus('telegram', {
            ok: true,
            message: `Connected as @${bot?.username || 'telegram-bot'}`
          });
          return {
            ok: true,
            output: `Telegram connection successful (@${bot?.username || 'telegram-bot'}).`
          };
        } catch (error) {
          updateStatus('telegram', {
            ok: false,
            message: error.message
          });
          return { ok: false, error: error.message };
        }
      }

      if (subAction === 'remove' || subAction === 'clear') {
        await stopTelegramBridge();
        clearTelegramToken();
        updateStatus('telegram', {
          ok: true,
          message: 'Telegram token removed and bridge stopped.'
        });
        return {
          ok: true,
          output: 'Telegram token removed and bridge stopped.'
        };
      }

      return {
        ok: false,
        error: 'Unknown telegram action. Use add, test, remove, or status.'
      };
    }

    if (action === 'slack') {
      const subAction = (rest[0] || 'status').toLowerCase();

      if (subAction === 'status') {
        const status = getApiStatus()?.slack || null;
        return {
          ok: true,
          output: [
            '### Slack Bridge',
            `- App Token: ${hasStoredSlackAppToken() ? 'saved' : 'missing'}`,
            `- Bot Token: ${hasStoredSlackBotToken() ? 'saved' : 'missing'}`,
            `- Bridge: ${slackChannel ? 'running' : 'stopped'}`,
            `- Status: ${status?.message || 'not tested'}`
          ].join('\n')
        };
      }

      if (subAction === 'add' || subAction === 'save') {
        const appToken = rest[1] || '';
        const botToken = rest[2] || '';

        if (!appToken.startsWith('xapp-') || !botToken.startsWith('xoxb-')) {
          return { ok: false, error: 'Invalid Slack tokens. Usage: /llm slack add xapp-... xoxb-...' };
        }

        try {
          saveSlackAppToken(appToken);
          saveSlackBotToken(botToken);

          // Update settings to enable
          const settings = getSettings();
          setSettings({
            ...settings,
            channels: {
              ...settings.channels,
              slack: { ...settings.channels?.slack, enabled: true }
            }
          });

          await startSlackChannel(appToken, botToken);

          // If we get here it started successfully
          updateStatus('slack', {
            ok: true,
            message: 'Connected to Slack Socket Mode'
          });

          return {
            ok: true,
            output: 'Slack bridge connected.'
          };
        } catch (error) {
          updateStatus('slack', {
            ok: false,
            message: error.message
          });
          return { ok: false, error: error.message };
        }
      }

      if (subAction === 'test') {
        const appToken = getDecryptedSlackAppToken();
        const botToken = getDecryptedSlackBotToken();

        if (!appToken || !botToken) {
          return { ok: false, error: 'Missing Slack tokens. Use `/llm slack add <app_token> <bot_token>`.' };
        }

        try {
          await startSlackChannel(appToken, botToken);
          updateStatus('slack', {
            ok: true,
            message: 'Connected to Slack Socket Mode'
          });
          return {
            ok: true,
            output: 'Slack connection successful.'
          };
        } catch (error) {
          updateStatus('slack', {
            ok: false,
            message: error.message
          });
          return { ok: false, error: error.message };
        }
      }

      if (subAction === 'remove' || subAction === 'clear') {
        await stopSlackChannel();
        clearSlackAppToken();
        clearSlackBotToken();

        const settings = getSettings();
        setSettings({
          ...settings,
          channels: {
            ...settings.channels,
            slack: { ...settings.channels?.slack, enabled: false }
          }
        });

        updateStatus('slack', {
          ok: true,
          message: 'Slack tokens removed and bridge stopped.'
        });
        return {
          ok: true,
          output: 'Slack tokens removed and bridge stopped.'
        };
      }

      return {
        ok: false,
        error: 'Unknown slack action. Use add, test, remove, or status.'
      };
    }

    if (action === 'voice') {
      const subAction = (rest[0] || 'status').toLowerCase();
      const token = rest.slice(1).join(' ').trim();

      if (subAction === 'status') {
        const voice = getVoiceSettings();
        return {
          ok: true,
          output: [
            '### Voice / TTS',
            `- Enabled: ${voice.enabled ? 'yes' : 'no'}`,
            `- Engine: ${voice.engine}`,
            `- ElevenLabs key: ${hasStoredElevenLabsToken() ? 'saved' : 'missing'}`,
            `- Voice ID: ${voice.voiceId || '(not set)'}`
          ].join('\n')
        };
      }

      if (subAction === 'add' || subAction === 'save') {
        if (!token) {
          return { ok: false, error: 'Usage: /llm voice add <elevenlabs_api_key>' };
        }

        if (!cipher.isEncryptionAvailable()) {
          return { ok: false, error: 'Secure storage is not available on this system.' };
        }

        saveElevenLabsToken(token);
        return {
          ok: true,
          output: 'ElevenLabs API key saved securely.'
        };
      }

      if (subAction === 'remove' || subAction === 'clear') {
        clearElevenLabsToken();
        return {
          ok: true,
          output: 'ElevenLabs API key removed.'
        };
      }

      if (subAction === 'test') {
        try {
          if (!ttsEngine) {
            throw new Error('TTS engine is not initialized.');
          }

          await ttsEngine.testConnection({ engine: 'elevenlabs' });
          return {
            ok: true,
            output: 'ElevenLabs connection successful.'
          };
        } catch (error) {
          return {
            ok: false,
            error: error.message || 'ElevenLabs connection failed.'
          };
        }
      }

      return {
        ok: false,
        error: 'Unknown voice action. Use add, test, remove, or status.'
      };
    }

    if (action === 'list') {
      const snapshot = getProviderSnapshot();
      const rows = Object.entries(snapshot.providers).map(([key, provider]) => {
        const active = snapshot.activeProvider === key;
        const status = provider.status?.ok
          ? 'connected'
          : provider.status
            ? 'error'
            : 'not tested';
        const parts = [
          `**${provider.label}**` + (active ? ' (active)' : ''),
          `key: \`${key}\``,
          `token: ${provider.hasToken ? 'saved' : 'missing'}`,
          `model: \`${provider.model || '(default)'}\``,
          `status: ${status}`
        ];
        return `- ${parts.join(' | ')}`;
      });

      return {
        ok: true,
        output: ['### LLM Providers', '', ...rows].join('\n')
      };
    }

    if (['add', 'save'].includes(action)) {
      const provider = normalizeProvider(rest[0]);
      const token = rest[1] || '';

      if (!isSupportedProvider(provider)) {
        return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
      }

      const validationError = validateProviderToken(provider, token);
      if (validationError) {
        return { ok: false, error: validationError };
      }

      if (!cipher.isEncryptionAvailable()) {
        return { ok: false, error: 'Secure storage is not available on this system. Tokens cannot be saved.' };
      }

      saveProviderToken(provider, token);
      return {
        ok: true,
        output: `${providerLabels[provider]} token saved securely.`
      };
    }

    if (['remove', 'clear'].includes(action)) {
      const provider = normalizeProvider(rest[0]);
      if (!isSupportedProvider(provider)) {
        return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
      }

      clearProviderToken(provider);
      return {
        ok: true,
        output: `${providerLabels[provider]} token removed.`
      };
    }

    if (action === 'test') {
      const provider = normalizeProvider(rest[0]);
      if (!isSupportedProvider(provider)) {
        return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
      }

      const result = await testProviderConnection(provider);
      if (!result.ok) {
        return {
          ok: false,
          error: `Connection failed for ${providerLabels[provider]}: ${result.error}`,
          details: result.details,
          status: result.status
        };
      }

      return {
        ok: true,
        output: `${providerLabels[provider]} connection successful.`
      };
    }

    if (['use', 'active'].includes(action)) {
      const provider = normalizeProvider(rest[0]);
      if (!isSupportedProvider(provider)) {
        return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
      }

      setActiveProvider(provider);
      return {
        ok: true,
        output: `Active provider set to ${providerLabels[provider]}.`
      };
    }

    if (action === 'model') {
      const provider = normalizeProvider(rest[0]);
      const model = rest.slice(1).join(' ').trim();
      if (!isSupportedProvider(provider)) {
        return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
      }

      setProviderModel(provider, model);
      return {
        ok: true,
        output: `${providerLabels[provider]} model set to ${model || '(default)'}.`
      };
    }

    return {
      ok: false,
      error: `Unknown action \`${action}\`. Use \`/llm help\` for usage.`
    };
  };

  const createToolExecutorWithApprovals = async (
    event,
    runtimeEnvironment = null,
    approvalRequester = null,
    executorOptions = {}
  ) => {
    const workingDirectory = executorOptions.workingDirectory || hostWorkingDirectory;
    const resolvedRuntimeEnvironment = runtimeEnvironment || await getRuntimeEnvironment({
      workingDirectory
    });

    // Every approval requester — gateway/channel approvalHandler, cron,
    // webhook, mesh, and meta-tools re-threading a parent's requester — reaches
    // a ToolExecutor through here, so this is the single place that enforces
    // remoteApprovals: 'deny'.
    const effectiveApprovalRequester = remoteApprovals === 'deny' ? null : approvalRequester;
    if (approvalRequester && !effectiveApprovalRequester) {
      log.debug('remoteApprovals is "deny": ignoring a remote approval requester');
    }
    const executor = new ToolExecutor({
      workingDirectory,
      allowedDirectories: executorOptions.allowedDirectories || [],
      requireApproval: true,
      runtimeEnvironment: resolvedRuntimeEnvironment,
      approvalRequester: effectiveApprovalRequester,
      // Nulling the requester only denies at the gate; this also closes the
      // paths that grant approval before the gate is reached (the persisted
      // "always approve" list below, an agent config's autoApproveTools, and
      // `allow` permission rules).
      denyAutoApproval: remoteApprovals === 'deny',
      shouldAutoApprove: async (toolName) => isToolAlwaysApproved(toolName),
      // Live callback — picks up rules added mid-session when the user
      // clicks "Always allow 'git *'" in an approval dialog.
      getPermissionRules,
      // Session-scoped denial counter so "rm *" denied three times stops
      // re-prompting and returns an auto-deny to the model.
      denialTracker: new DenialTracker(),
      // Snapshots the working directory before the turn's first mutating
      // tool, so the user can undo a turn's file changes.
      checkpointManager,
      hookExecutor: getHookSettings().enabled ? hookExecutor : null,
      useSandbox: executorOptions.useSandbox !== false,
      extraToolOptions: {
        get agentExecutorAdapter() { return agentExecutorAdapter; },
        get backgroundTaskManager() { return backgroundTaskManager; },
        // Case mode: the chat send path passes { ...caseTurn (caseId, dir,
        // turnId, title, orientation), runtime, ownerMessages }. The case
        // tools read it, and ToolExecutor's ledger write guard uses dir.
        get caseContext() { return executorOptions.caseContext || null; },
        getAgent,
        listAgents,
        toolRegistry,
        inferenceRouter,
        encryptToken,
        decryptToken,
        vault,
        getSettings,
        getProviderToken: getDecryptedProviderToken,
        userDataPath: userDataPath,
        canvasAction: async ({ action, content, title }) => {
          const cid = executorOptions.chatId;
          const sender = event?.sender;
          if (!cid) throw new Error('No chatId available for canvas action');

          if (action === 'render' || action === 'update') {
            const chats = getChats();
            const canvasState = { title: title || 'Canvas', content, visible: true, lastUpdatedAt: new Date().toISOString() };
            setChats(chats.map(c => c.id !== cid ? c : { ...c, canvasState, updatedAt: new Date().toISOString() }));
            if (sender && !sender.isDestroyed()) {
              sender.send('canvas:render', { chatId: cid, title: canvasState.title, content });
            }
            return { action };
          }

          if (action === 'close') {
            const chats = getChats();
            setChats(chats.map(c => c.id !== cid ? c : { ...c, canvasState: null, updatedAt: new Date().toISOString() }));
            if (sender && !sender.isDestroyed()) {
              sender.send('canvas:close', { chatId: cid });
            }
            return { action };
          }

          if (action === 'execute_js') {
            if (!sender || sender.isDestroyed()) throw new Error('No renderer available for JS execution');
            const requestId = createId();
            return new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                pendingCanvasJsResolvers.delete(requestId);
                reject(new Error('Canvas JS execution timed out (10s)'));
              }, 10000);
              pendingCanvasJsResolvers.set(requestId, { resolve, reject, timeout });
              sender.send('canvas:executeJs', { chatId: cid, requestId, code: content });
            });
          }

          throw new Error(`Unknown canvas action: ${action}`);
        }
      }
    });

    if (event?.sender) {
      executor.on('approvalRequired', ({ toolName, parameters, resolve }) => {
        const approvalId = createId();
        pendingApprovalResolvers.set(approvalId, { resolve, toolName });
        event.sender.send('tool:approvalRequired', {
          approvalId,
          toolName,
          parameters
        });
      });
    }

    return executor;
  };

  const inferenceRouter = new InferenceRouter({
    getSettings,
    getProviderModel,
    getProviderToken: getDecryptedProviderToken,
    createProvider: (providerType, token) => {
      if (providerType === 'anthropic' && token === '__anthropic_oauth__') {
        // OAuth mode — token will be refreshed async before first API call
        return ProviderFactory.createProvider(providerType, 'oauth-placeholder', { authMode: 'oauth' });
      }
      return ProviderFactory.createProvider(providerType, token);
    }
  });

  // Wrap resolveInference to handle async OAuth token refresh
  const _originalResolve = inferenceRouter.resolve.bind(inferenceRouter);
  const _originalResolveWithSmart = inferenceRouter.resolveWithSmartRouting.bind(inferenceRouter);

  const ensureOAuthToken = async (result) => {
    if (result.providerType === 'anthropic' && result.provider?.authMode === 'oauth') {
      const accessToken = await refreshAnthropicOAuthToken();
      result.provider.apiKey = accessToken;
    }
    return result;
  };

  const resolveInference = async (selection = {}) => {
    let result;
    if (typeof selection === 'string') {
      result = inferenceRouter.resolve({ provider: selection });
    } else if (selection && selection.message) {
      result = inferenceRouter.resolveWithSmartRouting(
        selection,
        selection.message,
        { agentMode: !!selection.agentMode }
      );
    } else {
      result = inferenceRouter.resolve(selection || {});
    }

    return ensureOAuthToken(result);
  };

  const createAgentRuntime = async (
    providerType,
    event = null,
    approvalRequester = null,
    runtimeOptions = {}
  ) => {
    const resolution = await resolveInference(providerType);
    const capabilities = inferenceRouter.getCapabilities(resolution.providerType, resolution.model);
    if (!capabilities.toolCalling) {
      throw new Error(`Provider ${resolution.providerType} (${resolution.model}) does not support tool calling required for agent mode.`);
    }
    const workingDirectory = runtimeOptions.workingDirectory || hostWorkingDirectory;
    const runtimeEnvironment = await getRuntimeEnvironment({
      workingDirectory
    });
    // Pull the persisted allowlist so "Always Allow" decisions made in earlier
    // workflow/chat runs carry forward. Without this, each Plan & Execute
    // starts from an empty allowlist and re-prompts for the same directories.
    const settings = getSettings();
    const allowedDirectories = Array.isArray(settings.allowedDirectories)
      ? settings.allowedDirectories
      : [];
    const toolExecutor = await createToolExecutorWithApprovals(
      event,
      runtimeEnvironment,
      approvalRequester,
      { workingDirectory, allowedDirectories }
    );

    return {
      ...resolution,
      runtimeEnvironment,
      toolExecutor,
      toolDefinitions: toolRegistry.getFunctionDefinitions()
    };
  };

  const withNotificationTiming = async (label, fn) => {
    const startedAt = Date.now();
    try {
      const result = await fn();
      if (notificationRouter) {
        await notificationRouter.route({
          title: 'King Louie task completed',
          body: `${label} completed in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
          durationMs: Date.now() - startedAt,
          label,
          status: 'success'
        });
      }
      return result;
    } catch (error) {
      if (notificationRouter) {
        await notificationRouter.route({
          title: 'King Louie task failed',
          body: `${label} failed after ${Math.round((Date.now() - startedAt) / 1000)}s: ${error.message}`,
          durationMs: Date.now() - startedAt,
          label,
          status: 'error'
        });
      }
      throw error;
    }
  };

  const initializeAgentInfrastructure = async () => {
    taskManager = new TaskManager();
    sessionManager = new SessionManager();
    channelRegistry = new ChannelRegistry();
    allowlistManager = new AllowlistManager(store);
    pinManager = new PinManager({
      storageFile: path.join(userDataPath, 'skill-pins.json')
    });
    userProfile = new UserProfile({
      getStoredProfile: () => store.get('userProfile', UserProfile.getDefaultProfile()),
      setStoredProfile: (profile) => store.set('userProfile', profile)
    });
    notificationRouter = new NotificationRouter({
      getSettings: () => getSettings().notifications,
      uiToastChannel: deps.uiToastChannel
    });

    hookRegistry = new HookRegistry({
      hooksDirectory: path.join(hostWorkingDirectory, 'hooks')
    });
    hookExecutor = new HookExecutor({
      registry: hookRegistry,
      workingDirectory: hostWorkingDirectory
    });
    // Checkpoints: transparent snapshots taken before the first file-mutating
    // tool of each turn. Not a tool — the model never sees this.
    const checkpointSettings = getSettings().checkpoints || {};
    checkpointManager = new CheckpointManager({
      rootDir: path.join(userDataPath, 'checkpoints'),
      enabled: checkpointSettings.enabled === true,
      maxAgeDays: checkpointSettings.maxAgeDays
    });

    const memoryStorageFile = path.join(userDataPath, 'memory', 'memory-store.json');
    memoryStore = new MemoryStore({ storageFile: memoryStorageFile });
    memoryManager = new MemoryManager({
      store: memoryStore,
      currentSessionId: `main-${Date.now()}`
    });

    // Initialize ContextAssembler for dynamic per-turn context retrieval
    const contextVectorStorePath = path.join(userDataPath, 'memory', 'context-vectors.json');
    let openaiApiKey = '';
    try { openaiApiKey = getDecryptedProviderToken('openai'); } catch { openaiApiKey = ''; }
    contextAssembler = new ContextAssembler({
      vectorStorePath: contextVectorStorePath,
      openaiApiKey: openaiApiKey || ''
    });

    // ConversationCompactor: semantic retrieval over conversation history.
    // Reuses the same embedding provider as the context assembler. The cache
    // file persists embeddings keyed by chunk-content hash, so the same text
    // is never embedded twice — survives restarts and is shared across chats.
    conversationCompactor = new ConversationCompactor({
      embeddingProvider: contextAssembler.embeddingProvider,
      cacheFilePath: path.join(userDataPath, 'memory', 'embedding-cache.jsonl')
    });

    // Background task manager for async agent tasks
    backgroundTaskManager = new BackgroundTaskManager({
      outputDir: path.join(userDataPath, 'background-tasks')
    });

    backgroundTaskManager.on('taskCompleted', (task) => {
      ui.send('backgroundTask:completed', {
        id: task.id,
        state: task.state,
        description: task.description,
        error: task.error
      });
    });

    usageTracker = new UsageTracker(store);
    ttsEngine = new TTSEngine({
      getSettings: getVoiceSettings,
      getElevenLabsApiKey: getDecryptedElevenLabsToken,
      audioOutputDirectory: path.join(userDataPath, 'voice', 'out')
    });
    process.env.KING_LOUIE_MEMORY_STORE = memoryStorageFile;

    const cronJobsFile = path.join(userDataPath, 'cron', 'jobs.json');
    cronStore = new CronStore(cronJobsFile);

    // Load persistent stores and hooks in parallel
    await Promise.all([
      pinManager.load(),
      cronStore.load(),
    ]);

    reloadHooksFromSettings();

    // Set up custom apps store — load cached results immediately, then refresh in background
    setCustomAppsStore(store);
    discoveredApps = getCachedDiscoveredApps();
    if (discoveredApps.length > 0) {
      log.info(`Loaded ${discoveredApps.length} cached app(s)`);
    }
    if (features.appDiscovery) {
      discoverAllApps({ force: true }).then((apps) => {
        discoveredApps = apps;
        log.info(`Refreshed app discovery: ${apps.length} app(s)`);
      }).catch((err) => {
        log.warn(`App discovery failed: ${err.message}`);
      });
    }

    // Index tools and system prompt sections in the ContextAssembler (background, non-blocking)
    if (contextAssembler) {
      (async () => {
        try {
          const toolDefs = toolRegistry.getFunctionDefinitions();
          const runtimeEnv = await getRuntimeEnvironment({ workingDirectory: hostWorkingDirectory });
          const skills = typeof skillRegistry?.listSkills === 'function' ? skillRegistry.listSkills() : [];
          const sections = buildSystemSections(runtimeEnv, {
            discoveredApps,
            buildAppContextSection,
            skills
          });
          await contextAssembler.index(toolDefs, sections);
          contextAssemblerLog.info(`Indexed ${toolDefs.length} tools and ${sections.length} system sections`);
        } catch (err) {
          contextAssemblerLog.warn(`Indexing failed (will use full context fallback): ${err.message}`);
        }
      })();
    }

    // Initialize MCP servers from settings (background, non-blocking).
    // MCP tools are registered into the toolRegistry and become available
    // to agents via ToolSearch (deferred loading).
    const vaultEnvResolver = createVaultEnvResolver({
      vaultStore,
      decryptToken,
      onMissing: (key) => mcpLog.warn(`Vault key not found: "${key}" — env value left unresolved`)
    });
    mcpManager = new MCPManager({ toolRegistry, envResolver: vaultEnvResolver });
    const mcpServers = getSettings().mcpServers || {};
    if (Object.keys(mcpServers).length > 0) {
      mcpManager.connectAll(mcpServers).then((results) => {
        const connected = results.filter(r => r.status === 'connected');
        const failed = results.filter(r => r.status === 'failed');
        if (connected.length > 0) {
          mcpLog.info(`Connected to ${connected.length} server(s): ${connected.map(r => `${r.name} (${r.tools} tools)`).join(', ')}`);
        }
        if (failed.length > 0) {
          mcpLog.warn(`Failed to connect: ${failed.map(r => `${r.name}: ${r.error}`).join(', ')}`);
        }

        // Re-index context assembler after MCP tools are registered
        if (contextAssembler) {
          const toolDefs = toolRegistry.getFunctionDefinitions();
          contextAssembler.index(toolDefs).catch(() => {});
        }
      }).catch((err) => {
        mcpLog.warn(`MCP initialization failed: ${err.message}`);
      });
    }

    gatewayServer = new GatewayServer({
      host: '127.0.0.1',
      port: process.env.KL_TEST_MODE ? 0 : ports.gateway,
      // Only minted when the listener is on; start() is never called otherwise.
      authToken: features.gateway ? ensureGatewayToken({ store, cipher }) : null,
      // The plaintext token file is written by start(), after the bind
      // succeeds, and removed by stop() — never for a port nothing serves.
      tokenFileDir: features.gateway ? userDataPath : null
    });

    toolRegistry.register(new MessageTool(gatewayServer, sessionManager));
    toolRegistry.register(new SessionsListTool(sessionManager));
    toolRegistry.register(new SessionsHistoryTool(sessionManager));
    toolRegistry.register(new SessionsSpawnTool(sessionManager));

    agentExecutorAdapter = {
      execute: async (agent, message, options = {}) => {
        const settings = getSettings();
        const requestedTier = options.tier || agent?.inferenceTier || settings?.inference?.activeTier;
        const runtime = await createAgentRuntime(
          { tier: requestedTier },
          null,
          options.approvalRequester || null,
          { workingDirectory: options.workingDirectory }
        );
        const executor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
          usageTracker,
          prompter
        });

        return executor.execute(agent, message, {
          ...options,
          tier: runtime.tier,
          model: options.model || runtime.model || agent.model,
          timeoutMs: options.timeoutMs || runtime.timeoutMs,
          tools: runtime.toolDefinitions,
          userProfile: getUserProfile(),
          templateContext: {
            ...buildTemplateContextFromSettings(),
            ...(options.templateContext || {})
          },
          systemPrompt: [
            buildRuntimeSystemPrompt(runtime.runtimeEnvironment),
            await buildMemoryContextSection(message),
            formatUserContextSection(),
            formatProjectContextSection(runtime.runtimeEnvironment?.workingDirectory || hostWorkingDirectory)
          ].join('\n\n'),
          onUsageRecorded: options.onUsageRecorded
        });
      }
    };

    // Initialize LLM-powered router and attach to inference router
    llmRouter = new LLMRouter({
      getSettings,
      getProviderToken: getDecryptedProviderToken,
      createProvider: (providerType, token) => ProviderFactory.createProvider(providerType, token)
    });
    inferenceRouter.setLLMRouter(llmRouter);

    // Initialize workflow engine for durable multi-session workflows
    workflowEngine = new WorkflowEngine({
      storageDir: path.join(userDataPath, 'workflows'),
      agentExecutorAdapter,
      getAgent,
      maxConcurrentTasks: 3,
      getConversationCompactor: () => conversationCompactor,
      getParentChatMessages: (chatId) => {
        const chat = getChats().find((c) => c.id === chatId);
        if (!chat || !Array.isArray(chat.messages)) return [];
        return chat.messages.filter((m) => m.sender === 'user' || m.sender === 'assistant');
      }
    });
    await workflowEngine.initialize();

    // Forward workflow events to the renderer
    for (const event of ['workflow:created', 'workflow:started', 'workflow:completed', 'workflow:failed',
      'workflow:paused', 'workflow:cancelled', 'workflow:task:started', 'workflow:task:completed', 'workflow:task:failed']) {
      workflowEngine.on(event, (data) => {
        ui.send(event, data);
      });
    }

    // Initialize planner executor (ties planner agent → workflow engine)
    plannerExecutor = new PlannerExecutor({
      agentExecutorAdapter,
      workflowEngine,
      getAgent,
      getConversationCompactor: () => conversationCompactor
    });

    remoteControl = new RemoteControl(
      gatewayServer,
      sessionManager,
      agentExecutorAdapter,
      { getAgent }
    );

    cronExecutor = new CronExecutor(agentExecutorAdapter, sessionManager, gatewayServer);
    cronScheduler = new CronScheduler(cronStore, cronExecutor);
    cronScheduler.start();

    webhookRegistry = new WebhookRegistry(store);
    webhookHandler = new WebhookHandler(webhookRegistry, sessionManager, agentExecutorAdapter);
    webhookServer = new WebhookServer(gatewayServer, webhookHandler, { port: ports.webhook });
    if (features.webhooks) {
      // Still not awaited here — a slow bind must not hold up start() for the
      // Electron host — but the promise is kept so a host that needs to know
      // can wait for it (core.whenListenersSettled).
      webhookListenerSettled = webhookServer.start()
        .catch(err => log.warn(`Webhook server start failed: ${err.message}`));
    }

    // Initialize mesh networking (peer-to-peer communication between king-louie instances)
    if (features.mesh) {
      try {
        meshContext = await initializeMesh({
          store,
          sessionManager,
          agentExecutor: agentExecutorAdapter,
          taskManager,
          channelRegistry,
          getAgent,
          settings: getSettings(),
          cipher
        });
      } catch (err) {
        log.warn(`Mesh initialization failed: ${err.message}`);
        log.warn(`Mesh initialization stack: ${err.stack}`);
        ui.reportError(err.message, err.stack);
      }
    } else {
      meshContext = null;
    }

    gatewayServer.on('agent:message', async ({ agentId, sessionKey, message }) => {
      const startedAt = Number(message?.startedAt) || Date.now();
      try {
        const agent = getAgent(agentId);
        if (!agent) {
          throw new Error(`Agent not found: ${agentId}`);
        }

        const result = await agentExecutorAdapter.execute(agent, message.message, {
          sessionKey,
          runId: message.runId,
          approvalRequester:
            typeof message.approvalHandler === 'function'
              ? async (toolName, parameters) => message.approvalHandler({ toolName, parameters })
              : null
        });

        sessionManager.addMessage(sessionKey, {
          role: 'assistant',
          content: result.content || '',
          from: agentId
        });

        const durationMs = Math.max(0, Date.now() - startedAt);
        if (notificationRouter) {
          await notificationRouter.route({
            title: 'King Louie task completed',
            body: `Gateway agent ${agentId} completed in ${Math.round(durationMs / 1000)}s.`,
            durationMs,
            label: `Gateway agent ${agentId}`,
            status: 'success'
          });
        }

        gatewayServer.emit('agent:response', {
          sessionKey,
          runId: message.runId,
          content: result.content || '',
          durationMs
        });
      } catch (error) {
        const durationMs = Math.max(0, Date.now() - startedAt);
        if (notificationRouter) {
          await notificationRouter.route({
            title: 'King Louie task failed',
            body: `Gateway agent ${agentId} failed after ${Math.round(durationMs / 1000)}s: ${error.message}`,
            durationMs,
            label: `Gateway agent ${agentId}`,
            status: 'error'
          });
        }

        gatewayServer.emit('agent:response', {
          sessionKey,
          runId: message.runId,
          error: error.message,
          durationMs
        });
      }
    });

    // Initialize skills while gateway server starts in parallel
    const userSkillsDir = path.join(userDataPath, 'skills');
    if (!fs.existsSync(userSkillsDir)) {
      fs.mkdirSync(userSkillsDir, { recursive: true });
    }

    skillLoader = new SkillLoader({
      skillsDirectory: userSkillsDir,
      builtinSkillsDirectory: deps.builtinSkillsDir,
      context: {
        workingDirectory: hostWorkingDirectory,
        userDataPath: userDataPath,
        toolRegistry,
        sessionManager,
        sendMessage: (chatId, message) => {
          if (telegramBridge) {
            return telegramBridge.sendMessage(chatId, message);
          }
          // Could also send to UI here if needed
          return Promise.resolve();
        },
        // Provide LLM provider for skills that need AI capabilities
        get llmProvider() {
          try {
            const settings = getSettings();
            const providerType = settings.activeProvider || 'openai';
            if (!['openai', 'anthropic'].includes(providerType)) {
              return null;
            }
            const token = getDecryptedProviderToken(providerType);
            return ProviderFactory.createProvider(providerType, token);
          } catch (error) {
            skillsLog.warn(`LLM provider not available: ${error.message}`);
            return null;
          }
        }
      }
    });

    const [, skillsLoaded] = await Promise.all([
      // A listener that can't bind (e.g. the port is taken by another host)
      // disables that listener only; it never aborts start().
      features.gateway
        ? gatewayServer.start().catch((err) => log.warn(`Gateway server start failed: ${err.message}`))
        : Promise.resolve(),
      skillLoader.loadAll(),
    ]);
    log.info(`Loaded ${skillsLoaded} skill(s)`);

    // Defer channel connections — don't block startup for network calls
    const deferChannels = async () => {
      try {
        const telegramToken = String(getDecryptedTelegramToken() || '').trim();
        if (telegramToken) {
          await startTelegramBridge(telegramToken);
        }

        const discordToken = String(getDecryptedDiscordToken() || '').trim();
        if (discordToken) {
          await startDiscordBridge(discordToken);
        }

        const slackAppToken = getDecryptedSlackAppToken();
        const slackBotToken = getDecryptedSlackBotToken();
        const settings = getSettings();
        if (slackAppToken && slackBotToken && settings.channels?.slack?.enabled) {
          await startSlackChannel(slackAppToken, slackBotToken);
        }
      } catch (err) {
        log.warn(`Deferred channel startup error: ${err.message}`);
      }
    };

    // Fire-and-forget: channels, hooks, and memory aging
    if (features.channels) deferChannels();

    runHookEvent('SessionStart', {
      source: 'main',
      startedAt: new Date().toISOString(),
      workingDirectory: hostWorkingDirectory
    }).catch(err => log.warn(`SessionStart hook failed: ${err.message}`));

    if (memoryManager) {
      memoryManager.runAging();
    }
  };

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
    // Stop cron first so no job fires while the slower stops below drain.
    if (cronScheduler) cronScheduler.stop();
    const warnTimeout = (label, ms) => log.warn(`${label} timed out after ${ms}ms; continuing shutdown`);
    await withTimeout(
      runHookEvent('SessionEnd', { source: 'main', endedAt: new Date().toISOString(), workingDirectory: hostWorkingDirectory }),
      shutdownTimeoutMs, 'SessionEnd hook', warnTimeout
    ).catch((err) => log.warn(`SessionEnd hook failed: ${err.message}`));
    const stops = [
      ['MCP shutdown', mcpManager && (() => mcpManager.disconnectAll())],
      ['Channel shutdown', channelRegistry && (() => channelRegistry.shutdownAll())],
      ['Webhook server stop', webhookServer && (() => webhookServer.stop())],
      ['Mesh shutdown', meshContext && (() => meshContext.shutdown())],
      ['Gateway server stop', gatewayServer && (() => gatewayServer.stop())]
    ].filter(([, fn]) => fn);
    const results = await Promise.allSettled(
      stops.map(([label, fn]) => withTimeout(fn(), shutdownTimeoutMs, label, warnTimeout))
    );
    results.forEach((r, i) => { if (r.status === 'rejected') log.warn(`${stops[i][0]} failed: ${r.reason?.message}`); });
    if (usageTracker) usageTracker.reset();
  };

  // Constructing the runtime touches nothing on disk; the root directory is
  // created with the first case.
  const caseRuntime = new CaseRuntime({
    root: resolveCasesRoot({ settings: getSettings(), env: process.env, dataDir: userDataPath })
  });

  const context = {
    // Chat
    createId,
    getChats,
    setChats,
    getActiveChatId,
    setActiveChatId,
    appendMessageToChat,
    getLastAssistantMessage,
    getVoiceSettings,
    runHookEvent,
    resolveInference,
    getRuntimeEnvironment,
    createToolExecutorWithApprovals,
    AgentLoop,
    toolRegistry,
    withNotificationTiming,
    buildRuntimeSystemPrompt,
    buildMemoryContextSection,
    getContextAssembler: () => contextAssembler,
    getConversationCompactor: () => conversationCompactor,
    getCheckpointManager: () => checkpointManager,
    getToolResultsDir: () => path.join(userDataPath, 'tool-results'),
    speakSummaryText,
    getTtsEngine: () => ttsEngine,
    getUsageTracker: () => usageTracker,
    createUsageRecordFromMetrics,
    getSettings,
    getCaseRuntime: () => caseRuntime,

    // Tool
    pendingApprovalResolvers,
    setToolAlwaysApprove,
    getPermissionRules,
    addPermissionRule,
    removePermissionRule,

    // Hooks
    getHookSettings,
    listHookDefinitions,
    reloadHooksFromSettings,
    setHookEnabled,
    setHookSettings,

    // Memory
    getMemoryManager: () => memoryManager,

    // Settings
    getApiTokens,
    getApiStatus,
    getSettings,
    providerLabels,
    providerDefaults,
    hasStoredElevenLabsToken,
    hasStoredTelegramToken,
    hasStoredSlackAppToken,
    hasStoredSlackBotToken,
    getTelegramBridge: () => telegramBridge,
    getSlackChannel: () => slackChannel,
    normalizeTemplateVariables,
    getUserProfile,
    setTemplateVariables,
    updateUserProfile,
    setVoiceSettings,
    clearElevenLabsToken,
    saveElevenLabsToken,
    normalizeVoiceSettings,
    setSettings,
    resetRuntimeEnvironmentCache,
    setApiTokens,
    encryptToken,
    decryptToken,
    updateStatus,
    runLlmCommand,
    anthropicOAuth,
    setActiveInferenceTier,
    setNotificationSettings,

    // MCP
    getMcpManager: () => mcpManager,
    vaultStore,

    // Task
    getTaskManager: () => taskManager,

    // Agent
    getAgent,
    listAgents,
    createAgentRuntime,
    AgentExecutor,
    AgentOrchestrator,
    buildAgentVoiceOptions,
    buildAgentCompletionSummary,
    buildTemplateContextFromSettings,
    formatUserContextSection,
    formatProjectContextSection,

    // Gateway
    getRemoteControl: () => remoteControl,
    getSessionManager: () => sessionManager,

    // Cron
    getCronScheduler: () => cronScheduler,

    // System Apps
    getDiscoveredApps: () => discoveredApps,
    rescanApps: async () => {
      resetDiscoveryCache();
      discoveredApps = await discoverAllApps({ force: true });
      return discoveredApps;
    },
    addCustomApp,
    removeCustomApp,

    // Workflow / Planner
    getWorkflowEngine: () => workflowEngine,
    getPlannerExecutor: () => plannerExecutor,
    getLLMRouter: () => llmRouter,

    // Webhook
    webhookRegistry,
    webhookServer,
    getWebhookRegistry: () => webhookRegistry,
    getWebhookServer: () => webhookServer,
    // Resolves when every listener start() this core kicked off has settled.
    // A host that refuses to run without an enabled listener has to wait for
    // this before deciding; see assertEnabledListenersBound.
    whenListenersSettled: () => webhookListenerSettled,

    // Wizard / Diagnostics
    getStore: () => store,
    getProviderFactory: () => {
      try { return ProviderFactory; } catch { return null; }
    },
    getChannelRegistry: () => channelRegistry,
    // The same instance the bridges check, so the settings pane sees the
    // senders they just refused (src/ipc/channel-handlers.js).
    getAllowlistManager: () => allowlistManager,
    getHookRegistry: () => hookRegistry,
    getGatewayServer: () => gatewayServer,
    getMeshContext: () => meshContext,
    meshContext: null, // will be set after initialization
    getBrowserService: () => null,
    getSandboxExecutor: () => null,

    // Skill
    skillRegistry,
    ensureSkillCustomizationFile,
    getSkillLoader: () => skillLoader,
    getPinManager: () => pinManager,

    // Vault
    vault
  };

  return {
    context,
    pendingApprovalResolvers,
    pendingCanvasJsResolvers,
    start,
    shutdown,
    vault,
    getSettings,
    saveProviderToken,
    getMeshContext: () => meshContext,
    // Service mode decides whether an enabled listener actually came up
    // through these (assertEnabledListenersBound in src/service/run.js). They
    // existed only on `context`, so that check threw
    // "core.getGatewayServer is not a function" the moment `features.gateway`
    // or `features.webhooks` was on — the service refused to start with a
    // listener enabled, and the guard itself never ran.
    getGatewayServer: () => gatewayServer,
    getWebhookServer: () => webhookServer,
    whenListenersSettled: () => webhookListenerSettled
  };
}

module.exports = { createCore, PROVIDER_LABELS };
