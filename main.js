const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { default: Store } = require('electron-store');
const ProviderFactory = require('./src/providers/provider-factory');
const InferenceRouter = require('./src/providers/inference-router');
const { initializeTools, toolRegistry } = require('./src/tools');
const ToolExecutor = require('./src/execution/tool-executor');
const AgentLoop = require('./src/execution/agent-loop');
const {
  getRuntimeEnvironment,
  resetRuntimeEnvironmentCache
} = require('./src/execution/runtime-environment');
const { TaskManager } = require('./src/tasks/task-manager');
const AgentExecutor = require('./src/agents/agent-executor');
const AgentOrchestrator = require('./src/agents/orchestrator');
const { getAgent, listAgents } = require('./src/agents');
const GatewayServer = require('./src/gateway/gateway-server');
const SessionManager = require('./src/gateway/session-manager');
const RemoteControl = require('./src/gateway/remote-control');
const TelegramBridge = require('./src/channels/telegram-bridge');
const MessageTool = require('./src/tools/builtin/message-tool');
const {
  SessionsListTool,
  SessionsHistoryTool,
  SessionsSpawnTool
} = require('./src/tools/builtin/sessions-tools');
const { SkillLoader, skillRegistry, PinManager } = require('./src/skills');
const UserProfile = require('./src/telos/user-profile');
const { loadProjectContext } = require('./src/telos/project-context');
const HookRegistry = require('./src/hooks/hook-registry');
const HookExecutor = require('./src/hooks/hook-executor');
const { MemoryStore, MemoryManager } = require('./src/memory');
const {
  NotificationRouter,
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings
} = require('./src/notifications/notification-router');
const { TTSEngine, DEFAULT_VOICE_SETTINGS } = require('./src/voice/tts-engine');
const { registerTaskHandlers } = require('./src/ipc/task-handlers');
const { registerSettingsHandlers } = require('./src/ipc/settings-handlers');

let mainWindow;
let skillLoader;
let pinManager;
const pendingApprovalResolvers = new Map();
let taskManager;
let gatewayServer;
let sessionManager;
let remoteControl;
let telegramBridge;
let userProfile;
let notificationRouter;
let hookRegistry;
let hookExecutor;
let memoryStore;
let memoryManager;
let ttsEngine;
const TELEGRAM_TOKEN_STORE_KEY = '__telegram_bot_token';
const ELEVENLABS_TOKEN_STORE_KEY = '__elevenlabs_api_key';

const DEFAULT_SETTINGS = {
  activeProvider: 'openai',
  templateVariables: {
    name: '',
    role: '',
    preferences: '',
    projectContext: ''
  },
  providerModels: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-sonnet-latest',
    copilot: ''
  },
  inference: {
    activeTier: 'standard',
    tierMap: {
      fast: {
        provider: 'openai',
        model: 'gpt-4o-mini'
      },
      standard: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest'
      },
      smart: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest'
      }
    },
    timeoutsMs: {
      fast: 15000,
      standard: 30000,
      smart: 90000
    }
  },
  notifications: {
    ...DEFAULT_NOTIFICATION_SETTINGS
  },
  voice: {
    ...DEFAULT_VOICE_SETTINGS
  },
  hooks: {
    enabled: true,
    hookStates: {}
  }
};

const mergeSettings = (settings = {}) => {
  const source = settings || {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    templateVariables: {
      ...(DEFAULT_SETTINGS.templateVariables || {}),
      ...(source.templateVariables || {})
    },
    providerModels: {
      ...(DEFAULT_SETTINGS.providerModels || {}),
      ...(source.providerModels || {})
    },
    inference: {
      ...(DEFAULT_SETTINGS.inference || {}),
      ...(source.inference || {}),
      tierMap: {
        ...(DEFAULT_SETTINGS.inference?.tierMap || {}),
        ...(source.inference?.tierMap || {})
      },
      timeoutsMs: {
        ...(DEFAULT_SETTINGS.inference?.timeoutsMs || {}),
        ...(source.inference?.timeoutsMs || {})
      }
    },
    notifications: normalizeNotificationSettings({
      ...(DEFAULT_SETTINGS.notifications || {}),
      ...(source.notifications || {})
    }),
    voice: {
      ...(DEFAULT_SETTINGS.voice || {}),
      ...(source.voice || {})
    },
    hooks: {
      ...(DEFAULT_SETTINGS.hooks || {}),
      ...(source.hooks || {}),
      hookStates: {
        ...(DEFAULT_SETTINGS.hooks?.hookStates || {}),
        ...(source.hooks?.hookStates || {})
      }
    }
  };
};

const store = new Store({
  name: 'chat-data',
  defaults: {
    chats: [],
    activeChatId: null,
    apiTokens: {},
    apiStatus: {},
    settings: {
      ...DEFAULT_SETTINGS
    },
    toolApprovals: {
      alwaysApproveTools: {}
    }
  }
});

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

const getProjectContextPayload = (workingDirectory = process.cwd()) => {
  return loadProjectContext({ workingDirectory });
};

const formatProjectContextSection = (workingDirectory = process.cwd()) => {
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

const buildMemoryContextSection = (query = '', options = {}) => {
  if (!memoryManager) {
    return '';
  }

  try {
    return memoryManager.buildPromptContext(query, {
      limit: options.limit || 6
    });
  } catch (error) {
    console.warn('[memory] Failed building memory context:', error.message);
    return '';
  }
};

const buildTemplateContextFromSettings = () => {
  const templateVariables = getTemplateVariables();
  const profileContext = userProfile ? userProfile.toTemplateContext(getUserProfile()) : {};
  const projectContext = getProjectContextPayload(process.cwd());
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

const providerLabels = {
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  copilot: 'GitHub Copilot'
};

const providerDefaults = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
  copilot: ''
};

const providerTokenHints = {
  openai: 'sk-',
  anthropic: 'sk-ant-',
  copilot: 'ghp_'
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
    console.warn(`[hooks] ${eventName} hook execution failed:`, error.message);
    return null;
  }
};

const encryptToken = (token) => {
  if (!token) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  return safeStorage.encryptString(token).toString('base64');
};

const decryptToken = (encrypted) => {
  if (!encrypted) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  const buffer = Buffer.from(encrypted, 'base64');
  return safeStorage.decryptString(buffer);
};

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

const buildRuntimeSystemPrompt = (runtimeEnvironment = {}) => {
  const platform = runtimeEnvironment.platform || process.platform;
  const shell = runtimeEnvironment.shell || 'unknown';
  const available = Array.isArray(runtimeEnvironment.available)
    ? runtimeEnvironment.available
    : [];
  const unavailable = Array.isArray(runtimeEnvironment.unavailable)
    ? runtimeEnvironment.unavailable
    : [];

  return [
    'Environment context (auto-detected):',
    `- Platform: ${platform}`,
    `- Shell: ${shell}`,
    `- Available CLI tools: ${available.length ? available.join(', ') : 'unknown'}`,
    `- Known missing CLI tools: ${unavailable.length ? unavailable.join(', ') : 'none detected'}`,
    'Use this context when proposing commands and selecting tools. Avoid commands for unavailable tools.'
  ].join('\n');
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

const getDecryptedProviderToken = (provider) => {
  const tokens = getApiTokens();
  const encryptedToken = tokens[provider];
  if (!encryptedToken) {
    throw new Error(`No token saved for ${providerLabels[provider] || provider}.`);
  }
  return decryptToken(encryptedToken);
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

  const customizationDir = path.join(app.getPath('userData'), 'skill-customizations', normalizedSkillId);
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

const stopTelegramBridge = async () => {
  if (!telegramBridge) return;

  await telegramBridge.stop();
  telegramBridge = null;
};

const startTelegramBridge = async (token) => {
  if (!token || !gatewayServer || !sessionManager) return;

  await stopTelegramBridge();

  telegramBridge = new TelegramBridge({
    token,
    gatewayServer,
    sessionManager,
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
      if (mainWindow) {
        mainWindow.webContents.send('chat:updated', { chats });
      }

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
      if (mainWindow) {
        mainWindow.webContents.send('chat:updated', { chats });
      }
    }
  });

  await telegramBridge.start();
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
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
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
        '- `/llm voice add <elevenlabs_api_key>` — save ElevenLabs API key',
        '- `/llm voice test` — test ElevenLabs API key',
        '- `/llm voice remove` — clear saved ElevenLabs API key',
        '- `/llm voice status` — show voice/TTS status',
        '',
        'Providers: `openai`, `anthropic`, `copilot`'
      ].join('\n')
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

      if (!safeStorage.isEncryptionAvailable()) {
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
      const activeMarker = snapshot.activeProvider === key ? ' (active)' : '';
      const status = provider.status?.ok
        ? `connected (${provider.status.message || 'ok'})`
        : provider.status
          ? `error (${provider.status.message || 'failed'})`
          : 'not tested';
      return `- **${provider.label}** \`${key}\`${activeMarker}: token=${provider.hasToken ? 'saved' : 'missing'}, model=\`${provider.model || '(default)'}\`, status=${status}`;
    });

    return {
      ok: true,
      output: ['### LLM Providers & Connections', '', ...rows].join('\n')
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

    if (!safeStorage.isEncryptionAvailable()) {
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
  approvalRequester = null
) => {
  const resolvedRuntimeEnvironment = runtimeEnvironment || await getRuntimeEnvironment({
    workingDirectory: process.cwd()
  });

  const executor = new ToolExecutor({
    workingDirectory: process.cwd(),
    requireApproval: true,
    runtimeEnvironment: resolvedRuntimeEnvironment,
    approvalRequester,
    shouldAutoApprove: async (toolName) => isToolAlwaysApproved(toolName),
    hookExecutor: getHookSettings().enabled ? hookExecutor : null
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
  createProvider: (providerType, token) => ProviderFactory.createProvider(providerType, token)
});

const resolveInference = (selection = {}) => {
  if (typeof selection === 'string') {
    return inferenceRouter.resolve({ provider: selection });
  }

  return inferenceRouter.resolve(selection || {});
};

const createAgentRuntime = async (providerType, event = null, approvalRequester = null) => {
  const resolution = resolveInference(providerType);
  if (!['openai', 'anthropic'].includes(resolution.providerType)) {
    throw new Error('Active provider does not support agent orchestration yet.');
  }
  const runtimeEnvironment = await getRuntimeEnvironment({
    workingDirectory: process.cwd()
  });
  const toolExecutor = await createToolExecutorWithApprovals(
    event,
    runtimeEnvironment,
    approvalRequester
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
  pinManager = new PinManager({
    storageFile: path.join(app.getPath('userData'), 'skill-pins.json')
  });
  await pinManager.load();
  userProfile = new UserProfile({
    getStoredProfile: () => store.get('userProfile', UserProfile.getDefaultProfile()),
    setStoredProfile: (profile) => store.set('userProfile', profile)
  });
  notificationRouter = new NotificationRouter({
    getSettings: () => getSettings().notifications
  });
  hookRegistry = new HookRegistry({
    hooksDirectory: path.join(process.cwd(), 'hooks')
  });
  hookExecutor = new HookExecutor({
    registry: hookRegistry,
    workingDirectory: process.cwd()
  });
  const memoryStorageFile = path.join(app.getPath('userData'), 'memory', 'memory-store.json');
  memoryStore = new MemoryStore({ storageFile: memoryStorageFile });
  memoryManager = new MemoryManager({
    store: memoryStore,
    currentSessionId: `main-${Date.now()}`
  });
  ttsEngine = new TTSEngine({
    getSettings: getVoiceSettings,
    getElevenLabsApiKey: getDecryptedElevenLabsToken,
    audioOutputDirectory: path.join(app.getPath('userData'), 'voice', 'out')
  });
  process.env.KING_LOUIE_MEMORY_STORE = memoryStorageFile;

  reloadHooksFromSettings();

  gatewayServer = new GatewayServer({
    host: '127.0.0.1',
    port: 18789
  });

  toolRegistry.register(new MessageTool(gatewayServer, sessionManager));
  toolRegistry.register(new SessionsListTool(sessionManager));
  toolRegistry.register(new SessionsHistoryTool(sessionManager));
  toolRegistry.register(new SessionsSpawnTool(sessionManager));

  const agentExecutorAdapter = {
    execute: async (agent, message, options = {}) => {
      const settings = getSettings();
      const requestedTier = options.tier || agent?.inferenceTier || settings?.inference?.activeTier;
      const runtime = await createAgentRuntime(
        { tier: requestedTier },
        null,
        options.approvalRequester || null
      );
      const executor = new AgentExecutor(runtime.provider, runtime.toolExecutor);

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
          buildMemoryContextSection(message),
          formatUserContextSection(),
          formatProjectContextSection(runtime.runtimeEnvironment?.workingDirectory || process.cwd())
        ].join('\n\n')
      });
    }
  };

  remoteControl = new RemoteControl(
    gatewayServer,
    sessionManager,
    agentExecutorAdapter,
    { getAgent }
  );

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

  await gatewayServer.start();

  // Initialize and load skills
  skillLoader = new SkillLoader({
    skillsDirectory: path.join(__dirname, 'skills'),
    context: {
      workingDirectory: process.cwd(),
      userDataPath: app.getPath('userData'),
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
          console.warn('[skills] LLM provider not available:', error.message);
          return null;
        }
      }
    }
  });

  const skillsLoaded = await skillLoader.loadAll();
  console.log(`[main] Loaded ${skillsLoaded} skill(s)`);

  const telegramToken = String(getDecryptedTelegramToken() || '').trim();
  if (telegramToken) {
    await startTelegramBridge(telegramToken);
  }

  await runHookEvent('SessionStart', {
    source: 'main',
    startedAt: new Date().toISOString(),
    workingDirectory: process.cwd()
  });

  if (memoryManager) {
    memoryManager.runAging();
  }
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'icons', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.removeMenu();

  mainWindow.loadFile('index.html');

  // Open DevTools in development mode
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

ipcMain.handle('app:quitWindow', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  return { ok: true };
});

ipcMain.handle('chat:load', () => {
  return {
    chats: getChats(),
    activeChatId: getActiveChatId()
  };
});

ipcMain.handle('chat:create', (_event, title = 'New Chat') => {
  const now = new Date().toISOString();
  const newChat = {
    id: createId(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: createId(),
        sender: 'assistant',
        text: 'New chat started! How can I help you today?',
        timestamp: now
      }
    ]
  };
  const chats = [newChat, ...getChats()];
  setChats(chats);
  setActiveChatId(newChat.id);
  return newChat;
});

ipcMain.handle('chat:setActive', (_event, chatId) => {
  setActiveChatId(chatId);
  return { activeChatId: chatId };
});

ipcMain.handle('chat:rename', (_event, { id, title }) => {
  const chats = getChats();
  const updated = chats.map((chat) =>
    chat.id === id
      ? { ...chat, title, updatedAt: new Date().toISOString() }
      : chat
  );
  setChats(updated);
  return updated.find((chat) => chat.id === id);
});

ipcMain.handle('chat:delete', (_event, chatId) => {
  const chats = getChats().filter((chat) => chat.id !== chatId);
  setChats(chats);
  const activeChatId = getActiveChatId();
  if (activeChatId === chatId) {
    const nextChatId = chats[0]?.id || null;
    setActiveChatId(nextChatId);
  }
  return { chats, activeChatId: getActiveChatId() };
});

ipcMain.handle('chat:addMessage', (_event, payload = {}) => {
  const { chatId, sender, text, ...metadata } = payload;
  return appendMessageToChat(chatId, sender, text, metadata);
});

ipcMain.handle('chat:speakLast', async (_event, { chatId, summary = false } = {}) => {
  const chat = getChats().find((item) => item.id === chatId);
  if (!chat) {
    return { ok: false, error: 'Chat not found.' };
  }

  const lastAssistant = getLastAssistantMessage(chatId);
  if (!lastAssistant?.text) {
    return { ok: false, error: 'No assistant message found to speak.' };
  }

  if (!ttsEngine) {
    return { ok: false, error: 'TTS engine is not initialized.' };
  }

  const voiceSettings = getVoiceSettings();
  if (!voiceSettings.enabled) {
    return { ok: false, error: 'Voice output is disabled. Enable it in settings first.' };
  }

  try {
    const result = summary
      ? await ttsEngine.speakSummary(lastAssistant.text, voiceSettings)
      : await ttsEngine.speak(lastAssistant.text, voiceSettings);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message || 'Unable to speak message.' };
  }
});

ipcMain.handle('chat:sendMessage', async (event, { chatId, message, agentMode = false }) => {
  await runHookEvent('UserPromptSubmit', {
    source: 'ui',
    chatId,
    prompt: String(message || ''),
    timestamp: new Date().toISOString(),
    workingDirectory: process.cwd()
  });

  const userMessage = appendMessageToChat(chatId, 'user', message);
  if (!userMessage) {
    throw new Error('Chat not found');
  }

  const inference = resolveInference();
  if (!['openai', 'anthropic'].includes(inference.providerType)) {
    throw new Error('Active provider does not support chat completions yet.');
  }
  const provider = inference.provider;
  const chat = getChats().find((item) => item.id === chatId);
  if (!chat) {
    throw new Error('Chat not found');
  }

  const responseId = createId();
  const runId = createId();
  const options = {
    model: inference.model,
    timeoutMs: inference.timeoutMs,
    tier: inference.tier,
    runId
  };

  event.sender.send('chat:messageStart', { chatId, responseId });

  try {
    const runtimeEnvironment = await getRuntimeEnvironment({
      workingDirectory: process.cwd()
    });

    options.runtimeEnvironment = runtimeEnvironment;
    options.systemPrompt = [
      buildRuntimeSystemPrompt(runtimeEnvironment),
      buildMemoryContextSection(message, { limit: 4 })
    ].filter(Boolean).join('\n\n');

    const executor = new ToolExecutor({
      workingDirectory: process.cwd(),
      requireApproval: true,
      runtimeEnvironment,
      shouldAutoApprove: async (toolName) => isToolAlwaysApproved(toolName),
      hookExecutor: getHookSettings().enabled ? hookExecutor : null
    });

    executor.on('preExecute', ({ toolName, parameters }) => {
      event.sender.send('chat:toolUse', { chatId, runId, toolName, parameters });
    });

    executor.on('postExecute', ({ toolName, result }) => {
      event.sender.send('chat:toolResult', { chatId, runId, toolName, result });
    });

    executor.on('approvalRequired', ({ toolName, parameters, resolve }) => {
      const approvalId = createId();
      pendingApprovalResolvers.set(approvalId, { resolve, toolName });
      event.sender.send('tool:approvalRequired', { approvalId, toolName, parameters });
    });

    let fullResponse = '';
    let llmSummary = {
      calls: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
    };
    const toolDefinitions = toolRegistry.getFunctionDefinitions();
    await withNotificationTiming('Chat response', async () => {
      const canUseAgentMode = agentMode && toolDefinitions.length > 0 && typeof provider.sendMessageWithTools === 'function';
      if (canUseAgentMode) {
        const loop = new AgentLoop(provider, executor, { maxIterations: 10 });
        const result = await loop.run(chat.messages, toolDefinitions, options);
        fullResponse = result.content || '(No response)';
        llmSummary = {
          calls: result?.llm?.calls || [],
          totals: result?.llm?.totals || llmSummary.totals
        };
        event.sender.send('chat:messageChunk', { chatId, responseId, chunk: fullResponse });
      } else {
        const streamResult = await provider.streamMessage(chat.messages, options, (chunk) => {
          fullResponse += chunk;
          event.sender.send('chat:messageChunk', { chatId, responseId, chunk });
        });

        const singleCall = streamResult?.llmMetrics || null;
        const calls = singleCall ? [singleCall] : [];
        llmSummary = {
          calls,
          totals: sumLlmCalls(calls)
        };
      }
    });

    const updatedChat = appendMessageToChat(chatId, 'assistant', fullResponse || '(No response)', {
      llm: llmSummary
    });
    event.sender.send('chat:messageComplete', {
      chatId,
      responseId,
      message: fullResponse || '(No response)',
      llm: llmSummary
    });

    const voiceSettings = getVoiceSettings();
    if (voiceSettings.enabled && voiceSettings.speakChatResponses) {
      speakSummaryText(fullResponse || '(No response)', voiceSettings).catch((error) => {
        console.warn('[voice] Failed to speak chat response:', error.message);
      });
    }

    return updatedChat;
  } catch (error) {
    event.sender.send('chat:messageError', {
      chatId,
      responseId,
      error: error.message
    });
    throw error;
  }
});

ipcMain.handle('tool:execute', async (event, { toolName, parameters }) => {
  const executor = await createToolExecutorWithApprovals(event);

  return executor.execute(toolName, parameters);
});

ipcMain.handle('hooks:list', async () => {
  return {
    enabled: getHookSettings().enabled,
    hooks: listHookDefinitions()
  };
});

ipcMain.handle('hooks:reload', async () => {
  return {
    enabled: getHookSettings().enabled,
    hooks: reloadHooksFromSettings()
  };
});

ipcMain.handle('hooks:setEnabled', async (_event, { name, enabled }) => {
  const hook = setHookEnabled(name, enabled);
  return {
    ok: true,
    hook,
    hooks: listHookDefinitions()
  };
});

ipcMain.handle('hooks:setGlobalEnabled', async (_event, { enabled }) => {
  const settings = getHookSettings();
  const normalized = Boolean(enabled);
  setHookSettings({
    ...settings,
    enabled: normalized
  });

  return {
    ok: true,
    enabled: normalized,
    hooks: listHookDefinitions()
  };
});

ipcMain.handle('memory:capture', async (_event, { type, content, source, metadata } = {}) => {
  if (!memoryManager) {
    return { ok: false, error: 'Memory manager is not initialized.' };
  }

  try {
    const entry = memoryManager.capture(type, content, { source, metadata });
    return { ok: true, entry };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('memory:recall', async (_event, { query = '', options = {} } = {}) => {
  if (!memoryManager) {
    return { ok: false, error: 'Memory manager is not initialized.', entries: [] };
  }

  try {
    const entries = memoryManager.recall(query, options || {});
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, error: error.message, entries: [] };
  }
});

ipcMain.handle('memory:list', async (_event, options = {}) => {
  if (!memoryManager) {
    return { ok: false, error: 'Memory manager is not initialized.', entries: [] };
  }

  try {
    const entries = memoryManager.list(options || {});
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, error: error.message, entries: [] };
  }
});

ipcMain.handle('memory:delete', async (_event, { id } = {}) => {
  if (!memoryManager) {
    return { ok: false, error: 'Memory manager is not initialized.' };
  }

  try {
    const deleted = memoryManager.delete(id);
    return { ok: true, deleted };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('memory:clear', async () => {
  if (!memoryManager) {
    return { ok: false, error: 'Memory manager is not initialized.' };
  }

  try {
    memoryManager.clear();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('tool:list', async () => {
  return toolRegistry.getFunctionDefinitions();
});

ipcMain.on('tool:approvalResponse', (_event, { approvalId, approved, alwaysApprove }) => {
  const pendingApproval = pendingApprovalResolvers.get(approvalId);
  if (!pendingApproval) return;

  pendingApprovalResolvers.delete(approvalId);

  if (Boolean(approved) && Boolean(alwaysApprove) && pendingApproval.toolName) {
    setToolAlwaysApprove(pendingApproval.toolName, true);
  }

  pendingApproval.resolve(Boolean(approved));
});

registerSettingsHandlers(ipcMain, {
  safeStorage,
  getApiTokens,
  getApiStatus,
  getSettings,
  providerLabels,
  providerDefaults,
  hasStoredElevenLabsToken,
  hasStoredTelegramToken,
  get telegramBridge() {
    return telegramBridge;
  },
  listHookDefinitions,
  normalizeTemplateVariables,
  getUserProfile,
  getVoiceSettings,
  setTemplateVariables,
  updateUserProfile,
  setVoiceSettings,
  clearElevenLabsToken,
  saveElevenLabsToken,
  get ttsEngine() {
    return ttsEngine;
  },
  normalizeVoiceSettings,
  setSettings,
  resetRuntimeEnvironmentCache,
  setApiTokens,
  encryptToken,
  decryptToken,
  updateStatus,
  runLlmCommand,
  setActiveInferenceTier,
  setNotificationSettings
});

registerTaskHandlers(ipcMain, {
  getTaskManager: () => taskManager
});

ipcMain.handle('agent:list', async () => {
  return listAgents().map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    inferenceTier: agent.inferenceTier,
    allowedTools: agent.allowedTools
  }));
});

ipcMain.handle('agent:execute', async (event, { agentId, message, tier }) => {
  const settings = getSettings();
  const agent = getAgent(agentId);

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const runtime = await createAgentRuntime(
    { tier: tier || agent.inferenceTier || settings?.inference?.activeTier },
    event
  );

  const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor);
  return withNotificationTiming(`Agent ${agent.id}`, async () => {
    const result = await agentExecutor.execute(agent, message, {
      tier: runtime.tier,
      model: runtime.model || agent.model,
      timeoutMs: runtime.timeoutMs,
      tools: runtime.toolDefinitions,
      userProfile: getUserProfile(),
      templateContext: buildTemplateContextFromSettings(),
      systemPrompt: [
        buildRuntimeSystemPrompt(runtime.runtimeEnvironment),
        buildMemoryContextSection(message),
        formatUserContextSection(),
        formatProjectContextSection(runtime.runtimeEnvironment?.workingDirectory || process.cwd())
      ].join('\n\n')
    });

    const voiceOptions = buildAgentVoiceOptions(agent);
    let voiceResult = null;
    if (voiceOptions.enabled && voiceOptions.speakAgentSummary !== false) {
      voiceResult = await speakSummaryText(
        buildAgentCompletionSummary(agent, result?.content || ''),
        voiceOptions
      );
    }

    return {
      ...result,
      voice: voiceResult
    };
  });
});

ipcMain.handle('agent:executeParallel', async (event, { agentIds = [], message }) => {
  const settings = getSettings();
  const runtime = await createAgentRuntime({ tier: settings?.inference?.activeTier }, event);

  const agents = agentIds
    .map((agentId) => getAgent(agentId))
    .filter(Boolean);

  const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor);
  const orchestrator = new AgentOrchestrator(agentExecutor);
  return withNotificationTiming('Parallel agent run', async () => {
    const results = await orchestrator.executeParallel(agents, message, {
      tier: runtime.tier,
      model: runtime.model,
      timeoutMs: runtime.timeoutMs,
      tools: runtime.toolDefinitions,
      userProfile: getUserProfile(),
      templateContext: buildTemplateContextFromSettings(),
      systemPrompt: [
        buildRuntimeSystemPrompt(runtime.runtimeEnvironment),
        buildMemoryContextSection(message),
        formatUserContextSection(),
        formatProjectContextSection(runtime.runtimeEnvironment?.workingDirectory || process.cwd())
      ].join('\n\n')
    });

    await Promise.all(
      (results || []).map(async (result, index) => {
        const agent = agents[index];
        if (!agent) return;
        const voiceOptions = buildAgentVoiceOptions(agent);
        if (!voiceOptions.enabled || voiceOptions.speakAgentSummary === false) {
          return;
        }

        await speakSummaryText(buildAgentCompletionSummary(agent, result?.content || ''), voiceOptions);
      })
    );

    return results;
  });
});

ipcMain.handle('agent:executeSerial', async (event, { agentIds = [], message }) => {
  const settings = getSettings();
  const runtime = await createAgentRuntime({ tier: settings?.inference?.activeTier }, event);

  const agents = agentIds
    .map((agentId) => getAgent(agentId))
    .filter(Boolean);

  const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor);
  const orchestrator = new AgentOrchestrator(agentExecutor);
  return withNotificationTiming('Serial agent run', async () => {
    const results = await orchestrator.executeSerial(agents, message, {
      tier: runtime.tier,
      model: runtime.model,
      timeoutMs: runtime.timeoutMs,
      tools: runtime.toolDefinitions,
      userProfile: getUserProfile(),
      templateContext: buildTemplateContextFromSettings(),
      systemPrompt: [
        buildRuntimeSystemPrompt(runtime.runtimeEnvironment),
        buildMemoryContextSection(message),
        formatUserContextSection(),
        formatProjectContextSection(runtime.runtimeEnvironment?.workingDirectory || process.cwd())
      ].join('\n\n')
    });

    for (let index = 0; index < (results || []).length; index += 1) {
      const agent = agents[index];
      if (!agent) continue;
      const voiceOptions = buildAgentVoiceOptions(agent);
      if (!voiceOptions.enabled || voiceOptions.speakAgentSummary === false) {
        continue;
      }

      await speakSummaryText(buildAgentCompletionSummary(agent, results[index]?.content || ''), voiceOptions);
    }

    return results;
  });
});

ipcMain.handle('gateway:status', async () => {
  if (!remoteControl) {
    return {
      status: 'uninitialized'
    };
  }

  return remoteControl.getStatus();
});

ipcMain.handle('sessions:list', async (_event, filter = {}) => {
  if (!sessionManager) {
    throw new Error('Session manager is not initialized');
  }

  return sessionManager.listSessions(filter);
});

ipcMain.handle('sessions:history', async (_event, { sessionKey, limit = 50 }) => {
  if (!sessionManager) {
    throw new Error('Session manager is not initialized');
  }

  return sessionManager.getHistory(sessionKey, limit);
});

ipcMain.handle('skill:list', async () => {
  return skillRegistry.listSkills();
});

ipcMain.handle('skill:customize', async (_event, { skillId } = {}) => {
  try {
    const customization = ensureSkillCustomizationFile(skillId);
    const openError = await shell.openPath(customization.path);
    if (openError) {
      return {
        ok: false,
        error: openError,
        ...customization
      };
    }

    return {
      ok: true,
      ...customization
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
});

ipcMain.handle('skill:execute', async (_event, { command, args = [], chatId }) => {
  try {
    const parsedArgs = Array.isArray(args) ? [...args] : [];
    const forcePrompt = parsedArgs.includes('--force-prompt');
    const sanitizedArgs = parsedArgs.filter((arg) => arg !== '--force-prompt');

    // Create a session for this chat if needed
    const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
    const session = sessionManager.getOrCreateSession(sessionKey, 'main', {
      channel: 'ui',
      peer: chatId,
      label: `ui:${chatId}`
    });

    const result = await skillRegistry.executeCommand(
      command,
      sanitizedArgs,
      {
        chatId,
        channel: 'ui',
        userId: chatId,
        session
      },
      { forcePrompt }
    );

    return result;
  } catch (error) {
    console.error('[main] Skill execution error:', error);
    return {
      ok: false,
      error: error.message || 'Unknown error executing skill command'
    };
  }
});

ipcMain.handle('skill:pin', async (_event, { chatId, skillId }) => {
  if (!pinManager) {
    return { ok: false, error: 'Pin manager is not initialized.' };
  }

  const skill = skillRegistry.getSkill(skillId);
  if (!skill) {
    return { ok: false, error: `Unknown skill: ${skillId}` };
  }

  if (!skill.getMetadata().pinnable) {
    return { ok: false, error: `Skill '${skillId}' does not support pinning.` };
  }
  const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
  await pinManager.pin(sessionKey, skillId);
  return { ok: true, skillId, name: skill.getMetadata().name };
});

ipcMain.handle('skill:unpin', async (_event, { chatId }) => {
  if (!pinManager) {
    return { ok: false, error: 'Pin manager is not initialized.' };
  }
  const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
  const previousId = pinManager.getPinned(sessionKey);
  await pinManager.unpin(sessionKey);
  return { ok: true, previousSkillId: previousId || null };
});

ipcMain.handle('skill:getPinned', async (_event, { chatId }) => {
  if (!pinManager) {
    return { ok: false, error: 'Pin manager is not initialized.' };
  }

  const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
  const skillId = pinManager.getPinned(sessionKey);
  if (!skillId) {
    return { ok: true, pinned: null };
  }

  const skill = skillRegistry.getSkill(skillId);
  if (!skill) {
    return { ok: true, pinned: { skillId } };
  }

  return {
    ok: true,
    pinned: {
      skillId,
      ...skill.getMetadata()
    }
  };
});
ipcMain.handle('skill:listPinnable', async () => {
  return skillRegistry.getPinnableSkills();
});

ipcMain.handle('skill:handleMessage', async (_event, { chatId, message }) => {
  if (!pinManager) {
    return { ok: false, error: 'Pin manager is not initialized.', continueWithAgent: true };
  }

  const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
  const skillId = pinManager.getPinned(sessionKey);
  if (!skillId) {
    return { ok: false, error: 'No skill pinned', continueWithAgent: true };
  }

  const skill = skillRegistry.getSkill(skillId);
  if (!skill || typeof skill.handleMessage !== 'function') {
    return { ok: false, error: 'Pinned skill cannot handle messages', continueWithAgent: true };
  }

  const session = sessionManager.getOrCreateSession(sessionKey, 'main', {
    channel: 'ui',
    peer: chatId,
    label: `ui:${chatId}`
  });

  try {
    const result = await skill.handleMessage(message, {
      chatId,
      channel: 'ui',
      userId: chatId,
      session
    });
    return result || { ok: false, continueWithAgent: true };
  } catch (error) {
    return { ok: false, error: error.message, continueWithAgent: true };
  }
});

app.whenReady().then(async () => {
  initializeTools();
  await initializeAgentInfrastructure();

  taskManager.on('taskCreated', (task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task:created', task);
    }
  });

  taskManager.on('taskUpdated', (task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task:updated', task);
    }
  });

  taskManager.on('taskUnblocked', (task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task:unblocked', task);
    }
  });

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    runHookEvent('SessionEnd', {
      source: 'main',
      endedAt: new Date().toISOString(),
      workingDirectory: process.cwd()
    }).catch((err) => console.warn('[main] SessionEnd hook failed:', err.message));

    if (telegramBridge) {
      telegramBridge.stop().catch((err) => console.warn('[main] Telegram bridge stop failed:', err.message));
    }
    if (gatewayServer) {
      gatewayServer.stop().catch((err) => console.warn('[main] Gateway server stop failed:', err.message));
    }
    app.quit();
  }
});
