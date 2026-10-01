/* ── Structured logging (renderer-side, mirrors src/logging.js API) ── */
function createLogger(subsystem) {
  const tag = `[${subsystem}]`;
  return {
    info:  (message, meta) => { const s = meta ? ` {${Object.entries(meta).map(([k,v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}}` : ''; console.log(tag, message + s); },
    warn:  (message, meta) => { const s = meta ? ` {${Object.entries(meta).map(([k,v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}}` : ''; console.warn(tag, message + s); },
    error: (message, meta) => { const s = meta ? ` {${Object.entries(meta).map(([k,v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}}` : ''; console.error(tag, message + s); },
    debug: (message, meta) => { const s = meta ? ` {${Object.entries(meta).map(([k,v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}}` : ''; console.debug(tag, message + s); },
    subsystem
  };
}

const chatLog = createLogger('chat');
const modelLog = createLogger('model-change');
const skillSettingsLog = createLogger('skill-settings');
const workflowLog = createLogger('workflow');
const settingsLog = createLogger('settings');
const rendererLog = createLogger('renderer');
const wizardLog = createLogger('wizard');
const chatMcpLog = createLogger('chat-mcp');

const appState = {
  chats: [],
  activeChatId: null,
  contextChatId: null,
  isAgentModeEnabled: false,
  isSandboxModeEnabled: true,
  isHistoryCollapsed: false,
  memoryEntries: [],
  pendingImages: [],
  pendingDocuments: [],
  activeResponses: new Set(),
  // Case ids with a turn running now (case:changed, what: 'turn').
  runningCaseTurns: new Set(),
  streamBuffers: new Map(),
  settings: {
    encryptionAvailable: true,
    providers: {},
    templateVariables: {
      name: '',
      role: '',
      preferences: '',
      projectContext: ''
    },
    userProfile: {
      name: '',
      role: '',
      goals: [],
      preferences: {},
      projectContext: ''
    },
    notifications: {
      enabled: true,
      thresholdsMs: {
        toast: 30000,
        external: 120000
      },
      uiToast: {
        enabled: true
      },
      ntfy: {
        enabled: false,
        topic: ''
      },
      telegram: {
        longTaskNotice: true
      }
    },
    voice: {
      enabled: false,
      engine: 'system',
      voiceId: '',
      speed: 1,
      stability: 0.5,
      style: 0.25,
      speakAgentSummary: true,
      speakChatResponses: false,
      telegramVoiceForLongResponses: false,
      telegramMinChars: 500,
      summaryMaxChars: 260,
      hasElevenLabsKey: false
    },
    hooks: {
      enabled: true,
      loaded: []
    }
  },
  canvasVisible: false
};

const dom = {
  userInput: document.getElementById('user-input'),
  inputContainer: document.getElementById('input-container'),
  inputResizeHandle: document.getElementById('input-resize-handle'),
  sendBtn: document.getElementById('send-btn'),
  stopBtn: document.getElementById('stop-btn'),
  chatMessages: document.getElementById('chat-messages'),
  newChatBtn: document.getElementById('new-chat-btn'),
  newChatBtnCompact: document.getElementById('new-chat-btn-compact'),
  chatList: document.getElementById('chat-list'),
  chatHeaderTitle: document.getElementById('chat-header-title'),
  chatHeaderMeta: document.getElementById('chat-header-meta'),
  emptyState: document.getElementById('empty-state'),
  mainContent: document.querySelector('.main-content'),
  container: document.querySelector('.container'),
  sidebar: document.querySelector('.sidebar'),
  sidebarResizeHandle: document.getElementById('sidebar-resize-handle'),
  chatContextMenu: document.getElementById('chat-context-menu'),
  settingsDrawer: document.getElementById('settings-drawer'),
  toggleHistoryBtn: document.getElementById('toggle-history-btn'),
  openSettingsBtn: document.getElementById('open-settings-btn'),
  closeSettingsBtn: document.getElementById('close-settings-btn'),
  floatingSettingsBtn: document.getElementById('floating-settings-btn'),
  composerSettingsBtn: document.getElementById('composer-settings-btn'),
  providerList: document.getElementById('provider-list'),
  modelsCatalogStatus: document.getElementById('models-catalog-status'),
  modelsRefreshCatalogBtn: document.getElementById('models-refresh-catalog-btn'),
  modelsProfileList: document.getElementById('models-profile-list'),
  modelsProfileEditor: document.getElementById('models-profile-editor'),
  modelsNewProfileBtn: document.getElementById('models-new-profile-btn'),
  modelsProfilesStatus: document.getElementById('models-profiles-status'),
  modelsCatalogFetch: document.getElementById('models-catalog-fetch'),
  modelsCatalogRefreshHours: document.getElementById('models-catalog-refresh-hours'),
  modelsCatalogOverrides: document.getElementById('models-catalog-overrides'),
  modelsSaveCatalogBtn: document.getElementById('models-save-catalog-btn'),
  modelsKlStatus: document.getElementById('models-kl-status'),
  modelsKlPicks: document.getElementById('models-kl-picks'),
  modelsKlProposal: document.getElementById('models-kl-proposal'),
  modelsKlAutoAccept: document.getElementById('models-kl-auto-accept'),
  modelsKlPreferLocal: document.getElementById('models-kl-prefer-local'),
  modelsKlBand: document.getElementById('models-kl-band'),
  modelsKlWorkerRatio: document.getElementById('models-kl-worker-ratio'),
  modelsKlUtilityRatio: document.getElementById('models-kl-utility-ratio'),
  modelsKlSaveBtn: document.getElementById('models-kl-save-btn'),
  modelsKlDuplicateBtn: document.getElementById('models-kl-duplicate-btn'),
  modelsCustomRoleList: document.getElementById('models-custom-role-list'),
  modelsCustomRoleId: document.getElementById('models-custom-role-id'),
  modelsCustomRoleDescription: document.getElementById('models-custom-role-description'),
  modelsCustomRoleFallback: document.getElementById('models-custom-role-fallback'),
  modelsCustomRoleTools: document.getElementById('models-custom-role-tools'),
  modelsCustomRoleImages: document.getElementById('models-custom-role-images'),
  modelsCustomRoleMinContext: document.getElementById('models-custom-role-min-context'),
  modelsSaveCustomRoleBtn: document.getElementById('models-save-custom-role-btn'),
  modelsCustomRolesStatus: document.getElementById('models-custom-roles-status'),
  modelsTestAllBtn: document.getElementById('models-test-all-btn'),
  settingsEncryptionAlert: document.getElementById('settings-encryption-alert'),
  agentModeBtn: document.getElementById('agent-mode-btn'),
  slashAutocomplete: document.getElementById('slash-autocomplete'),
  templateNameInput: document.getElementById('template-name-input'),
  templateRoleInput: document.getElementById('template-role-input'),
  templatePreferencesInput: document.getElementById('template-preferences-input'),
  templateProjectContextInput: document.getElementById('template-project-context-input'),
  saveTemplateVariablesBtn: document.getElementById('save-template-variables-btn'),
  templateVariablesStatus: document.getElementById('template-variables-status'),
  profileNameInput: document.getElementById('profile-name-input'),
  profileRoleInput: document.getElementById('profile-role-input'),
  profileGoalsInput: document.getElementById('profile-goals-input'),
  profilePreferencesInput: document.getElementById('profile-preferences-input'),
  profileProjectContextInput: document.getElementById('profile-project-context-input'),
  saveUserProfileBtn: document.getElementById('save-user-profile-btn'),
  userProfileStatus: document.getElementById('user-profile-status'),
  notificationsEnabledInput: document.getElementById('notifications-enabled-input'),
  notificationsUiToastEnabledInput: document.getElementById('notifications-ui-toast-enabled-input'),
  notificationsNtfyEnabledInput: document.getElementById('notifications-ntfy-enabled-input'),
  notificationsTelegramLongTaskInput: document.getElementById('notifications-telegram-long-task-input'),
  notificationsToastThresholdInput: document.getElementById('notifications-toast-threshold-input'),
  notificationsExternalThresholdInput: document.getElementById('notifications-external-threshold-input'),
  notificationsNtfyTopicInput: document.getElementById('notifications-ntfy-topic-input'),
  saveNotificationsBtn: document.getElementById('save-notifications-btn'),
  notificationsStatus: document.getElementById('notifications-status'),
  voiceEnabledInput: document.getElementById('voice-enabled-input'),
  voiceSpeakChatInput: document.getElementById('voice-speak-chat-input'),
  voiceSpeakAgentSummaryInput: document.getElementById('voice-speak-agent-summary-input'),
  voiceTelegramLongInput: document.getElementById('voice-telegram-long-input'),
  voiceEngineInput: document.getElementById('voice-engine-input'),
  voiceIdInput: document.getElementById('voice-id-input'),
  voiceSpeedInput: document.getElementById('voice-speed-input'),
  voiceStabilityInput: document.getElementById('voice-stability-input'),
  voiceStyleInput: document.getElementById('voice-style-input'),
  voiceSummaryMaxInput: document.getElementById('voice-summary-max-input'),
  voiceTelegramMinInput: document.getElementById('voice-telegram-min-input'),
  voiceElevenLabsKeyInput: document.getElementById('voice-elevenlabs-key-input'),
  saveVoiceSettingsBtn: document.getElementById('save-voice-settings-btn'),
  saveVoiceKeyBtn: document.getElementById('save-voice-key-btn'),
  clearVoiceKeyBtn: document.getElementById('clear-voice-key-btn'),
  testVoiceBtn: document.getElementById('test-voice-btn'),
  voiceStatus: document.getElementById('voice-status'),
  hooksGlobalEnabledInput: document.getElementById('hooks-global-enabled-input'),
  reloadHooksBtn: document.getElementById('reload-hooks-btn'),
  hooksStatus: document.getElementById('hooks-status'),
  hooksList: document.getElementById('hooks-list'),
  memoryQueryInput: document.getElementById('memory-query-input'),
  memoryTierFilterInput: document.getElementById('memory-tier-filter-input'),
  memoryCaptureTypeInput: document.getElementById('memory-capture-type-input'),
  memoryCaptureContentInput: document.getElementById('memory-capture-content-input'),
  memoryRefreshBtn: document.getElementById('memory-refresh-btn'),
  memoryCaptureBtn: document.getElementById('memory-capture-btn'),
  memoryClearBtn: document.getElementById('memory-clear-btn'),
  memoryStatus: document.getElementById('memory-status'),
  memoryList: document.getElementById('memory-list'),
  vaultList: document.getElementById('vault-list'),
  vaultAddBtn: document.getElementById('vault-add-btn'),
  vaultRefreshBtn: document.getElementById('vault-refresh-btn'),
  vaultStatus: document.getElementById('vault-status'),
  vaultAddPanel: document.getElementById('vault-add-panel'),
  vaultAddKeyInput: document.getElementById('vault-add-key-input'),
  vaultAddValueInput: document.getElementById('vault-add-value-input'),
  vaultSaveEntryBtn: document.getElementById('vault-save-entry-btn'),
  vaultCancelEntryBtn: document.getElementById('vault-cancel-entry-btn'),
  vaultAddStatus: document.getElementById('vault-add-status'),
  mcpList: document.getElementById('mcp-list'),
  mcpStatus: document.getElementById('mcp-status'),
  mcpAddBtn: document.getElementById('mcp-add-btn'),
  mcpRefreshBtn: document.getElementById('mcp-refresh-btn'),
  mcpReloadAllBtn: document.getElementById('mcp-reload-all-btn'),
  mcpEditPanel: document.getElementById('mcp-edit-panel'),
  mcpEditTitle: document.getElementById('mcp-edit-title'),
  mcpNameInput: document.getElementById('mcp-name-input'),
  mcpCommandInput: document.getElementById('mcp-command-input'),
  mcpArgsInput: document.getElementById('mcp-args-input'),
  mcpCwdInput: document.getElementById('mcp-cwd-input'),
  mcpEnvList: document.getElementById('mcp-env-list'),
  mcpEnvAddBtn: document.getElementById('mcp-env-add-btn'),
  mcpSaveBtn: document.getElementById('mcp-save-btn'),
  mcpCancelBtn: document.getElementById('mcp-cancel-btn'),
  mcpEditStatus: document.getElementById('mcp-edit-status'),
  cronRefreshBtn: document.getElementById('cron-refresh-btn'),
  cronStatus: document.getElementById('cron-status'),
  cronList: document.getElementById('cron-list'),
  cronAddBtn: document.getElementById('cron-add-btn'),
  cronAddStatus: document.getElementById('cron-add-status'),
  cronAddMessageInput: document.getElementById('cron-add-message-input'),
  cronAddTargetInput: document.getElementById('cron-add-target-input'),
  cronAddKindInput: document.getElementById('cron-add-kind-input'),
  cronAddValueInput: document.getElementById('cron-add-value-input'),
  chatPlanBtn: document.getElementById('chat-plan-btn'),
  workflowRefreshBtn: document.getElementById('workflow-refresh-btn'),
  workflowStatus: document.getElementById('workflow-status'),
  workflowList: document.getElementById('workflow-list'),
  workflowGoalInput: document.getElementById('workflow-goal-input'),
  workflowPlanBtn: document.getElementById('workflow-plan-btn'),
  workflowRunBtn: document.getElementById('workflow-run-btn'),
  workflowAddStatus: document.getElementById('workflow-add-status'),
  appsRescanBtn: document.getElementById('apps-rescan-btn'),
  appsStatus: document.getElementById('apps-status'),
  appsList: document.getElementById('apps-list'),
  appAddBtn: document.getElementById('app-add-btn'),
  appAddId: document.getElementById('app-add-id'),
  appAddDescription: document.getElementById('app-add-description'),
  appAddLaunch: document.getElementById('app-add-launch'),
  appAddCategory: document.getElementById('app-add-category'),
  appAddCapabilities: document.getElementById('app-add-capabilities'),
  appAddStatus: document.getElementById('app-add-status'),
  imagePreviewList: document.getElementById('image-preview-list'),
  imageFileInput: document.getElementById('image-file-input'),
  attachImageBtn: document.getElementById('attach-image-btn'),
  chatInfoBtn: document.getElementById('chat-info-btn'),
  chatModelsSwitcher: document.getElementById('chat-models-switcher'),
  chatProfileSelect: document.getElementById('chat-profile-select'),
  chatMainSelect: document.getElementById('chat-main-select'),
  chatMainOverrideMarker: document.getElementById('chat-main-override-marker'),
  chatInfoPopover: document.getElementById('chat-info-popover'),
  chatMcpBtn: document.getElementById('chat-mcp-btn'),
  chatMcpPopover: document.getElementById('chat-mcp-popover'),
  chatMcpCloseBtn: document.getElementById('chat-mcp-close-btn'),
  chatMcpToggles: document.getElementById('chat-mcp-toggles'),
  chatInfoCloseBtn: document.getElementById('chat-info-close-btn'),
  checkpointsBtn: document.getElementById('checkpoints-btn'),
  checkpointsPopover: document.getElementById('checkpoints-popover'),
  checkpointsCloseBtn: document.getElementById('checkpoints-close-btn'),
  checkpointsList: document.getElementById('checkpoints-list'),
  checkpointsEnabled: document.getElementById('checkpoints-enabled'),
  checkpointsStatus: document.getElementById('checkpoints-status'),
  chatInfoPopoverBody: document.getElementById('chat-info-popover-body'),
  skillSettingsContainer: document.getElementById('skill-settings-container'),
  skillsList: document.getElementById('skills-list'),
  skillsStatus: document.getElementById('skills-status'),
  skillInstallUrl: document.getElementById('skill-install-url'),
  skillInstallBtn: document.getElementById('skill-install-btn'),
  skillInstallStatus: document.getElementById('skill-install-status'),
  settingsNavSelect: document.getElementById('settings-nav-select'),
  defaultAgentMode: document.getElementById('default-agent-mode'),
  defaultSandboxMode: document.getElementById('default-sandbox-mode'),
  generalDefaultsStatus: document.getElementById('general-defaults-status'),
  channelTelegramTokenInput: document.getElementById('channel-telegram-token-input'),
  saveTelegramTokenBtn: document.getElementById('save-telegram-token-btn'),
  testTelegramBtn: document.getElementById('test-telegram-btn'),
  clearTelegramTokenBtn: document.getElementById('clear-telegram-token-btn'),
  telegramChannelStatus: document.getElementById('telegram-channel-status'),
  channelDiscordTokenInput: document.getElementById('channel-discord-token-input'),
  channelDiscordEnabledInput: document.getElementById('channel-discord-enabled-input'),
  channelDiscordMentionInput: document.getElementById('channel-discord-mention-input'),
  saveDiscordTokenBtn: document.getElementById('save-discord-token-btn'),
  clearDiscordTokenBtn: document.getElementById('clear-discord-token-btn'),
  discordChannelStatus: document.getElementById('discord-channel-status'),
  channelSlackAppTokenInput: document.getElementById('channel-slack-app-token-input'),
  channelSlackBotTokenInput: document.getElementById('channel-slack-bot-token-input'),
  channelSlackEnabledInput: document.getElementById('channel-slack-enabled-input'),
  channelSlackMentionInput: document.getElementById('channel-slack-mention-input'),
  saveSlackTokensBtn: document.getElementById('save-slack-tokens-btn'),
  clearSlackTokensBtn: document.getElementById('clear-slack-tokens-btn'),
  slackChannelStatus: document.getElementById('slack-channel-status'),
  websearchBraveKeyInput: document.getElementById('websearch-brave-key-input'),
  websearchTavilyKeyInput: document.getElementById('websearch-tavily-key-input'),
  saveWebsearchBraveBtn: document.getElementById('save-websearch-brave-btn'),
  testWebsearchBraveBtn: document.getElementById('test-websearch-brave-btn'),
  clearWebsearchBraveBtn: document.getElementById('clear-websearch-brave-btn'),
  saveWebsearchTavilyBtn: document.getElementById('save-websearch-tavily-btn'),
  testWebsearchTavilyBtn: document.getElementById('test-websearch-tavily-btn'),
  clearWebsearchTavilyBtn: document.getElementById('clear-websearch-tavily-btn'),
  websearchBraveStatus: document.getElementById('websearch-brave-status'),
  websearchTavilyStatus: document.getElementById('websearch-tavily-status'),
  imagegenDefaultSelect: document.getElementById('imagegen-default-select'),
  imagegenDefaultStatus: document.getElementById('imagegen-default-status'),
  imagegenFalKeyInput: document.getElementById('imagegen-fal-key-input'),
  saveImagegenFalBtn: document.getElementById('save-imagegen-fal-btn'),
  testImagegenFalBtn: document.getElementById('test-imagegen-fal-btn'),
  clearImagegenFalBtn: document.getElementById('clear-imagegen-fal-btn'),
  imagegenFalStatus: document.getElementById('imagegen-fal-status'),
  workingDirBtn: document.getElementById('working-dir-btn'),
  workingDirLabel: document.getElementById('working-dir-label'),
  exportChatBtn: document.getElementById('export-chat-btn'),
  messageContextMenu: document.getElementById('message-context-menu'),
  inputContextMenu: document.getElementById('input-context-menu'),
  webhookNameInput: document.getElementById('webhook-name-input'),
  webhookTemplateInput: document.getElementById('webhook-template-input'),
  webhookCreateBtn: document.getElementById('webhook-create-btn'),
  webhookStatus: document.getElementById('webhook-status'),
  webhookList: document.getElementById('webhook-list'),
  webhookListStatus: document.getElementById('webhook-list-status'),
  meshIndicatorBtn: document.getElementById('mesh-indicator-btn'),
  meshPeerCount: document.getElementById('mesh-peer-count'),
  meshPeerId: document.getElementById('mesh-peer-id'),
  meshDisplayNameInput: document.getElementById('mesh-display-name-input'),
  meshCapabilitiesInput: document.getElementById('mesh-capabilities-input'),
  meshSaveIdentityBtn: document.getElementById('mesh-save-identity-btn'),
  meshIdentityStatus: document.getElementById('mesh-identity-status'),
  meshPairingCode: document.getElementById('mesh-pairing-code'),
  meshPairGenerateBtn: document.getElementById('mesh-pair-generate-btn'),
  meshPairAcceptBtn: document.getElementById('mesh-pair-accept-btn'),
  meshPairCodeInput: document.getElementById('mesh-pair-code-input'),
  meshPairAddressInput: document.getElementById('mesh-pair-address-input'),
  meshPairPortInput: document.getElementById('mesh-pair-port-input'),
  meshPairingStatus: document.getElementById('mesh-pairing-status'),
  meshPeerAddressInput: document.getElementById('mesh-peer-address-input'),
  meshPeerPortInput: document.getElementById('mesh-peer-port-input'),
  meshPeerConnectBtn: document.getElementById('mesh-peer-connect-btn'),
  meshConnectStatus: document.getElementById('mesh-connect-status'),
  meshPeersList: document.getElementById('mesh-peers-list'),
  meshPeersStatus: document.getElementById('mesh-peers-status'),
  meshPortInput: document.getElementById('mesh-port-input'),
  meshDiscoveryToggle: document.getElementById('mesh-discovery-toggle'),
  meshSaveTransportBtn: document.getElementById('mesh-save-transport-btn'),
  meshTransportStatus: document.getElementById('mesh-transport-status'),
  meshTasksList: document.getElementById('mesh-tasks-list'),
  meshTasksStatus: document.getElementById('mesh-tasks-status'),
  diagnosticsRunBtn: document.getElementById('diagnostics-run-btn'),
  diagnosticsStatus: document.getElementById('diagnostics-status'),
  diagnosticsResults: document.getElementById('diagnostics-results'),
  wizardOverlay: document.getElementById('wizard-overlay'),
  wizardBody: document.getElementById('wizard-body'),
  wizardStepContent: document.getElementById('wizard-step-content'),
  wizardProgress: document.getElementById('wizard-progress'),
  wizardBackBtn: document.getElementById('wizard-back-btn'),
  wizardNextBtn: document.getElementById('wizard-next-btn'),
  wizardSkipBtn: document.getElementById('wizard-skip-btn'),
  wizardSkipStepBtn: document.getElementById('wizard-skip-step-btn'),
  canvasPanel: document.getElementById('canvas-panel'),
  canvasFrame: document.getElementById('canvas-frame'),
  canvasTitle: document.getElementById('canvas-title'),
  canvasCloseBtn: document.getElementById('canvas-close-btn'),
  canvasResizeHandle: document.getElementById('canvas-resize-handle'),
};

function faIcon(iconClass) {
  const i = document.createElement('i');
  i.className = iconClass;
  return i;
}

const unsubscribeHandlers = [];

function resetAppState() {
  appState.chats = [];
  appState.activeChatId = null;
  appState.contextChatId = null;
  appState.isAgentModeEnabled = false;
  appState.isHistoryCollapsed = false;
  appState.memoryEntries = [];
  appState.pendingImages = [];
  appState.pendingDocuments = [];
  appState.canvasVisible = false;
  appState.activeResponses.clear();
  appState.streamBuffers.clear();
  streamTextOffsets.clear();
  appState.settings = {
    encryptionAvailable: true,
    providers: {},
    templateVariables: { name: '', role: '', preferences: '', projectContext: '' },
    userProfile: { name: '', role: '', goals: [], preferences: {}, projectContext: '' },
    notifications: { enabled: true, thresholdsMs: { toast: 30000, external: 120000 }, uiToast: { enabled: true }, ntfy: { enabled: false, topic: '' }, telegram: { longTaskNotice: true } },
    voice: { enabled: false, engine: 'system', voiceId: '', speed: 1, stability: 0.5, style: 0.25, speakAgentSummary: true, speakChatResponses: false, telegramVoiceForLongResponses: false, telegramMinChars: 500, summaryMaxChars: 260, hasElevenLabsKey: false },
    hooks: { enabled: true, loaded: [] },
    cronJobs: []
  };
}


function unwrapIpcResult(result, fallbackError = 'Request failed') {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
    if (!result.ok) {
      throw new Error(result.error || fallbackError);
    }

    if (Object.prototype.hasOwnProperty.call(result, 'data')) {
      return result.data;
    }
  }

  return result;
}

function renderHistoryToggleButton() {
  if (!dom.toggleHistoryBtn) return;

  const title = appState.isHistoryCollapsed ? 'Expand chat history' : 'Collapse chat history';
  dom.toggleHistoryBtn.innerHTML = '';
  dom.toggleHistoryBtn.appendChild(faIcon(appState.isHistoryCollapsed ? 'fas fa-chevron-right' : 'fas fa-chevron-left'));
  dom.toggleHistoryBtn.title = title;
  dom.toggleHistoryBtn.setAttribute('aria-label', title);
  dom.toggleHistoryBtn.setAttribute('aria-pressed', appState.isHistoryCollapsed ? 'true' : 'false');
}

function setHistoryCollapsed(collapsed) {
  appState.isHistoryCollapsed = Boolean(collapsed);
  if (dom.container && dom.sidebar) {
    dom.container.classList.toggle('history-collapsed', appState.isHistoryCollapsed);
  }
  renderHistoryToggleButton();
}

// Stop replaces Send while the active chat streams a reply or its case runs a
// turn (an owner turn or a wake-up; spec 2026-09-27 §9).
function refreshStopButton() {
  const chat = getActiveChat();
  const busy = appState.activeResponses.has(appState.activeChatId)
    || Boolean(chat?.caseId && appState.runningCaseTurns.has(chat.caseId));
  if (dom.sendBtn) dom.sendBtn.hidden = busy;
  if (dom.stopBtn) dom.stopBtn.hidden = !busy;
}

function setResponseActive(active, chatId) {
  const id = chatId || appState.activeChatId;
  if (active) {
    appState.activeResponses.add(id);
  } else {
    appState.activeResponses.delete(id);
  }
  refreshStopButton();
  updateChatStreamingIndicators();
  applyChatModelsGate();
}

function updateChatStreamingIndicators() {
  if (!dom.chatList) return;
  dom.chatList.querySelectorAll('.chat-item').forEach((item) => {
    const id = item.dataset.chatId;
    item.classList.toggle('streaming', appState.activeResponses.has(id));
  });
}

function renderAgentModeButton() {
  if (!dom.agentModeBtn) return;
  dom.agentModeBtn.textContent = `Agent Mode: ${appState.isAgentModeEnabled ? 'On' : 'Off'}`;
  dom.agentModeBtn.classList.toggle('active', appState.isAgentModeEnabled);
  dom.agentModeBtn.setAttribute('aria-pressed', appState.isAgentModeEnabled ? 'true' : 'false');
}

async function getLocalHelpText() {
  const helpLines = [
    '### Local Commands',
    '',
    '- `/help` — show local command help',
    '- `/cd [path]` — set working directory for this chat (opens folder picker if no path given)',
    '- `/llm help` — show LLM connection command help',
    '- `/llm list` — list configured providers and connection status',
    '- `/llm add <provider> <token>` — add/update provider API token',
    '- `/llm remove <provider>` — remove saved provider token',
    '- `/llm test <provider>` — test provider connection',
    '- `/llm profile [name]` — list model profiles, or make one the default',
    '- `/llm telegram add <token>` — save Telegram bot token and start bridge',
    '- `/llm telegram test` — test saved Telegram bot token',
    '- `/llm telegram remove` — clear saved Telegram token and stop bridge',
    '- `/llm telegram status` — show Telegram bridge status',
    '- `/llm voice status` — show current voice configuration status',
    '- `/speak` — read the last assistant response aloud',
    '- `/profile` — show your current profile values',
    '- `/profile set <field> <value>` — update profile field (`name`, `role`, `projectContext`, `goals`, `preferences`)',
    '- `/pin <skill-id>` — pin a skill to this chat (all messages handled by the skill)',
    '- `/unpin` — unpin current skill, restore normal behavior',
    '- `/pinned` — show which skill (if any) is pinned to this chat',
    '- `/skill customize <skill-id>` — open/create a user customization file for a skill',
    '- `/agent on|off|toggle|status` — control agent mode',
    '- `exit` or `quit` — close the window'
  ];

  // Add skills if available
  try {
    const skills = await window.electron.skill.list();
    if (skills && skills.length > 0) {
      helpLines.push('', '### Skills', '');
      for (const skill of skills) {
        const commands = skill.commands.map(cmd => `/${cmd}`).join(', ');
        helpLines.push(`- ${commands} — ${skill.description}`);
      }
    }
  } catch (error) {
    // Skills not available, ignore
  }

  return helpLines.join('\n');
}

function appendLocalMessage(sender, text, metadata = {}) {
  const now = new Date().toISOString();
  appState.chats = appState.chats.map((chat) => {
    if (chat.id !== appState.activeChatId) return chat;
    return {
      ...chat,
      updatedAt: now,
      messages: [
        ...(Array.isArray(chat.messages) ? chat.messages : []),
        {
          id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          sender,
          text,
          timestamp: now,
          ...(metadata || {})
        }
      ]
    };
  });
  refreshUI();
}

function formatProfileSummary(profile = {}) {
  const goals = Array.isArray(profile?.goals) ? profile.goals.filter(Boolean) : [];
  const preferences =
    profile?.preferences && typeof profile.preferences === 'object'
      ? profile.preferences
      : {};

  return [
    '### User Profile',
    '',
    `- Name: ${profile?.name || '(not set)'}`,
    `- Role: ${profile?.role || '(not set)'}`,
    `- Goals: ${goals.length ? goals.join('; ') : '(none set)'}`,
    `- Preferences: ${Object.keys(preferences).length ? JSON.stringify(preferences) : '(none set)'}`,
    `- Project Context: ${profile?.projectContext || '(not set)'}`,
    '',
    'Use `/profile set <field> <value>` to update inline. Example: `/profile set role Staff Engineer`'
  ].join('\n');
}

async function saveUserProfileWithFeedback(profile, userCommand = null) {
  const result = await window.electron.settings.saveUserProfile({ profile });
  if (!result?.ok) {
    throw new Error(result?.error || 'Unable to save profile.');
  }

  appState.settings.userProfile = {
    ...(result.userProfile || profile)
  };
  renderSettings();

  if (userCommand) {
    appendLocalMessage('user', userCommand);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: userCommand }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
  }

  const summary = formatProfileSummary(appState.settings.userProfile);
  appendLocalMessage('assistant', summary);
  window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: summary }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
}

function parseSlashCommand(message = '') {
  const trimmed = String(message || '').trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const [name, ...rest] = trimmed.split(/\s+/);
  return {
    name: name.toLowerCase(),
    args: rest
  };
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SUPPORTED_DOCUMENT_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel'
]);
const DOCUMENT_EXTENSIONS = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel' };
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_DOCUMENTS_PER_MESSAGE = 5;

function renderPendingImages() {
  if (!dom.imagePreviewList) return;

  dom.imagePreviewList.innerHTML = '';
  const hasImages = Array.isArray(appState.pendingImages) && appState.pendingImages.length > 0;
  const hasDocs = Array.isArray(appState.pendingDocuments) && appState.pendingDocuments.length > 0;
  if (!hasImages && !hasDocs) {
    dom.imagePreviewList.hidden = true;
    return;
  }

  appState.pendingImages.forEach((image, index) => {
    const item = document.createElement('div');
    item.className = 'image-preview-item';

    const img = document.createElement('img');
    img.className = 'image-preview-thumb';
    img.src = image.previewUrl || `data:${image.mimeType};base64,${image.base64}`;
    img.alt = image.name || `Image ${index + 1}`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'image-preview-remove';
    removeBtn.innerHTML = '';
    removeBtn.appendChild(faIcon('fas fa-xmark'));
    removeBtn.title = 'Remove image';
    removeBtn.setAttribute('aria-label', 'Remove image');
    removeBtn.addEventListener('click', () => {
      appState.pendingImages.splice(index, 1);
      renderPendingImages();
    });

    item.appendChild(img);
    item.appendChild(removeBtn);
    dom.imagePreviewList.appendChild(item);
  });

  appState.pendingDocuments.forEach((doc, index) => {
    const item = document.createElement('div');
    item.className = 'image-preview-item doc-preview-item';

    const iconEl = document.createElement('div');
    iconEl.className = 'doc-preview-icon';
    const iconClass = doc.mimeType === 'application/pdf' ? 'fas fa-file-pdf'
      : doc.mimeType.includes('spreadsheet') || doc.mimeType.includes('excel') ? 'fas fa-file-excel'
      : doc.mimeType === 'text/csv' ? 'fas fa-file-csv'
      : 'fas fa-file-lines';
    iconEl.appendChild(faIcon(iconClass));

    const nameEl = document.createElement('span');
    nameEl.className = 'doc-preview-name';
    nameEl.textContent = doc.name || 'Document';
    nameEl.title = doc.name || 'Document';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'image-preview-remove';
    removeBtn.innerHTML = '';
    removeBtn.appendChild(faIcon('fas fa-xmark'));
    removeBtn.title = 'Remove document';
    removeBtn.setAttribute('aria-label', 'Remove document');
    removeBtn.addEventListener('click', () => {
      appState.pendingDocuments.splice(index, 1);
      renderPendingImages();
    });

    item.appendChild(iconEl);
    item.appendChild(nameEl);
    item.appendChild(removeBtn);
    dom.imagePreviewList.appendChild(item);
  });

  dom.imagePreviewList.hidden = false;
}

function clearPendingImages() {
  if (Array.isArray(appState.pendingImages)) {
    appState.pendingImages.forEach((image) => {
      if (image?.previewUrl) {
        URL.revokeObjectURL(image.previewUrl);
      }
    });
  }
  appState.pendingImages = [];
  appState.pendingDocuments = [];
  if (dom.imageFileInput) {
    dom.imageFileInput.value = '';
  }
  renderPendingImages();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const parts = result.split(',');
      resolve(parts[1] || '');
    };
    reader.onerror = () => reject(new Error('Unable to read image file'));
    reader.readAsDataURL(file);
  });
}

function resolveDocumentMimeType(file) {
  if (file.type && SUPPORTED_DOCUMENT_MIME_TYPES.has(file.type)) return file.type;
  const ext = (file.name || '').toLowerCase().match(/\.[^.]+$/)?.[0];
  return ext ? (DOCUMENT_EXTENSIONS[ext] || null) : null;
}

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || '');
    reader.onerror = () => reject(new Error('Unable to read file'));
    reader.readAsText(file);
  });
}

async function addImageFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  for (const file of files) {
    const isImage = SUPPORTED_IMAGE_MIME_TYPES.has(file.type);
    const docMime = !isImage ? resolveDocumentMimeType(file) : null;

    if (isImage) {
      if (appState.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
        showNotice(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
        continue;
      }
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        showNotice(`Image too large: ${file.name} exceeds 5MB.`);
        continue;
      }
      const base64 = await fileToBase64(file);
      appState.pendingImages.push({
        name: file.name,
        mimeType: file.type,
        base64,
        previewUrl: URL.createObjectURL(file)
      });
    } else if (docMime) {
      if (appState.pendingDocuments.length >= MAX_DOCUMENTS_PER_MESSAGE) {
        showNotice(`You can attach up to ${MAX_DOCUMENTS_PER_MESSAGE} documents per message.`);
        continue;
      }
      if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
        showNotice(`Document too large: ${file.name} exceeds 10MB.`);
        continue;
      }
      const isTextBased = docMime.startsWith('text/');
      const base64 = await fileToBase64(file);
      const textContent = isTextBased ? await fileToText(file) : null;
      appState.pendingDocuments.push({
        name: file.name,
        mimeType: docMime,
        base64,
        textContent
      });
    } else {
      showNotice(`Unsupported file type: ${file.name}`);
    }
  }

  renderPendingImages();
}

function renderMessageImages(messageContent, images = []) {
  if (!Array.isArray(images) || images.length === 0) {
    return;
  }

  const gallery = document.createElement('div');
  gallery.className = 'message-image-gallery';

  images.forEach((image, index) => {
    if (!image?.base64 || !image?.mimeType) return;
    const img = document.createElement('img');
    img.className = 'message-image';
    img.src = `data:${image.mimeType};base64,${image.base64}`;
    img.alt = image.name || `Attached image ${index + 1}`;
    gallery.appendChild(img);
  });

  if (gallery.childElementCount > 0) {
    messageContent.appendChild(gallery);
  }
}

function renderMessageDocuments(messageContent, documents = []) {
  if (!Array.isArray(documents) || documents.length === 0) {
    return;
  }

  const gallery = document.createElement('div');
  gallery.className = 'message-image-gallery';

  documents.forEach((doc) => {
    if (!doc?.mimeType) return;
    const item = document.createElement('div');
    item.className = 'image-preview-item doc-preview-item';

    const iconEl = document.createElement('div');
    iconEl.className = 'doc-preview-icon';
    const iconClass = doc.mimeType === 'application/pdf' ? 'fas fa-file-pdf'
      : doc.mimeType.includes('spreadsheet') || doc.mimeType.includes('excel') ? 'fas fa-file-excel'
      : doc.mimeType === 'text/csv' ? 'fas fa-file-csv'
      : 'fas fa-file-lines';
    iconEl.appendChild(faIcon(iconClass));

    const nameEl = document.createElement('span');
    nameEl.className = 'doc-preview-name';
    nameEl.textContent = doc.name || 'Document';
    nameEl.title = doc.name || 'Document';

    item.appendChild(iconEl);
    item.appendChild(nameEl);
    gallery.appendChild(item);
  });

  if (gallery.childElementCount > 0) {
    messageContent.appendChild(gallery);
  }
}

/* ── XML tool-call extraction (non-agent-mode) ─────────────── */

/**
 * Known tool names the LLM might emit as XML tags in non-agent text responses.
 * Case-insensitive lookup map: lowercase tag → canonical tool name.
 */
const XML_TOOL_NAMES = {
  bash: 'Bash', powershell: 'Bash', shell: 'Bash', terminal: 'Bash', cmd: 'Bash',
  read: 'Read', write: 'Write', edit: 'Edit',
  grep: 'Grep', glob: 'Glob', git: 'Git',
  webfetch: 'WebFetch', fetch: 'WebFetch',
  websearch: 'WebSearch', search: 'WebSearch',
  browser: 'Browser', askuser: 'AskUser', cron: 'Cron', skill: 'Skill'
};

/**
 * Regex that matches complete XML tool blocks: <toolName>...content...</toolName>
 * Captures: (1) tag name, (2) inner content.
 * Uses a dynamic alternation built from the known names.
 */
const XML_TOOL_TAG_NAMES = Object.keys(XML_TOOL_NAMES).join('|');
const XML_TOOL_BLOCK_RE = new RegExp(
  `<(${XML_TOOL_TAG_NAMES})>([\\s\\S]*?)<\\/\\1>`,
  'gi'
);

/**
 * Detect whether text still has an unclosed XML tool tag at the end
 * (i.e. the LLM is still streaming content inside a tool block).
 */
const XML_TOOL_OPEN_RE = new RegExp(
  `<(${XML_TOOL_TAG_NAMES})>([\\s\\S]*)$`,
  'i'
);

/**
 * Parse completed XML tool blocks from text.
 * Returns { cleanText, toolBlocks: [{ toolName, content }] }.
 */
function extractXmlToolBlocks(text) {
  const toolBlocks = [];
  const cleanText = text.replace(XML_TOOL_BLOCK_RE, (match, tagName, content) => {
    const canonical = XML_TOOL_NAMES[tagName.toLowerCase()] || tagName;
    toolBlocks.push({ toolName: canonical, content: content.trim() });
    return '';
  });
  return { cleanText: cleanText.trim(), toolBlocks };
}

/**
 * Convert an XML tool block's raw content into structured parameters
 * that getToolSummary() can display meaningfully.
 */
function xmlToolBlockToParams(toolName, content) {
  switch (toolName) {
    case 'Glob':      return { pattern: content };
    case 'Grep':      return { pattern: content };
    case 'Read':      return { file_path: content };
    case 'Write':     return { file_path: content };
    case 'Edit':      return { file_path: content };
    case 'Bash':      return { command: content };
    case 'Git':       return { command: content };
    case 'WebFetch':  return { url: content };
    case 'WebSearch':  return { query: content };
    case 'Browser':   return { action: content };
    default:          return { content };
  }
}

/**
 * Strip any trailing unclosed tool tag from display text so we don't render
 * partial XML while the LLM is still streaming inside a tool block.
 */
function stripTrailingOpenToolTag(text) {
  return text.replace(XML_TOOL_OPEN_RE, '').trim();
}

/* ── Tool event helpers ─────────────────────────────────────── */

const LOW_STAKES_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'sessions_list', 'sessions_history', 'message'
]);

const TOOL_ICONS = {
  Read:             'fas fa-file-lines',
  Write:            'fas fa-file-pen',
  Edit:             'fas fa-pen-to-square',
  'Agent mode':     'fas fa-wand-magic-sparkles',
  Bash:             'fas fa-terminal',
  Git:              'fas fa-code-branch',
  Glob:             'fas fa-folder-open',
  Grep:             'fas fa-magnifying-glass',
  WebFetch:         'fas fa-globe',
  WebSearch:        'fas fa-magnifying-glass',
  Browser:          'fas fa-window-maximize',
  AskUser:          'fas fa-comment-dots',
  Cron:             'fas fa-clock',
  sessions_list:    'fas fa-list',
  sessions_history: 'fas fa-clock-rotate-left',
  sessions_spawn:   'fas fa-play',
  message:          'fas fa-envelope',
  Status:           'fas fa-info-circle',
  'Tier changed':   'fas fa-layer-group',
  'Provider changed': 'fas fa-exchange-alt',
  'Model changed':  'fas fa-exchange-alt',
  'Sandbox mode':   'fas fa-shield-halved',
  ImageGenerate:    'fas fa-image',
};

const TOOL_ICON_DEFAULT = 'fas fa-wrench';

function getToolIcon(toolName) {
  return TOOL_ICONS[toolName] || TOOL_ICON_DEFAULT;
}

function extractPayloadText(payload) {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object') {
    for (const key of ['content', 'stdout', 'output', 'message']) {
      const v = payload[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return JSON.stringify(payload, null, 2);
}

function getToolSummary(toolName, params) {
  if (!params || typeof params !== 'object') return toolName;
  const p = params;

  switch (toolName) {
    case 'Read':      return `Read ${p.file_path || p.path || ''}`.trim();
    case 'Write':     return `Write ${p.file_path || p.path || ''}`.trim();
    case 'Edit':      return `Edit ${p.file_path || p.path || ''}`.trim();
    case 'Bash':      return `Bash: ${(p.command || '').slice(0, 80)}${(p.command || '').length > 80 ? '…' : ''}`;
    case 'Git':       return `Git: ${(p.command || p.subcommand || '').slice(0, 60)}`;
    case 'Glob':      return `Glob ${p.pattern || ''}`.trim();
    case 'Grep':      return `Grep "${(p.pattern || '').slice(0, 40)}"`;
    case 'WebFetch':  return `Fetch ${(p.url || '').slice(0, 50)}`;
    case 'WebSearch':  return `Search "${(p.query || '').slice(0, 50)}"`;
    case 'Browser':   return `Browser: ${p.action || 'navigate'}`;
    case 'Agent mode': {
      const mode = String(p.mode || p.state || '').trim().toLowerCase();
      if (mode === 'on' || mode === 'enabled' || mode === 'agent') return 'Agent mode: on';
      if (mode === 'off' || mode === 'disabled' || mode === 'standard') return 'Agent mode: off';
      return 'Agent mode';
    }
    case 'Sandbox mode': {
      const mode = String(p.mode || p.state || '').trim().toLowerCase();
      if (mode === 'on' || mode === 'enabled') return 'Sandbox mode: on';
      if (mode === 'off' || mode === 'disabled') return 'Sandbox mode: off';
      return 'Sandbox mode';
    }
    case 'Tier changed':     return `Tier: ${p.from || '?'} → ${p.to || '?'}`;
    case 'Provider changed': return `Provider: ${p.from || '?'} → ${p.to || '?'}`;
    case 'Model changed':    return `Model (${p.provider || '?'}): ${p.from || '(default)'} → ${p.to || '(default)'}`;
    case 'Status':           return p.message || 'Status update';
    case 'ImageGenerate':    return `Generate: "${(p.prompt || '').slice(0, 50)}${(p.prompt || '').length > 50 ? '…' : ''}"`;
    default:          return toolName;
  }
}

function getToolResultSummary(toolName, result) {
  if (!result || typeof result !== 'object') return '';
  if (result.success === false) {
    const errMsg = result.error || result.message || 'failed';
    return typeof errMsg === 'string' ? errMsg.slice(0, 60) : 'failed';
  }
  if (toolName === 'Bash') {
    const exit = result.exitCode !== undefined ? result.exitCode : (result.code !== undefined ? result.code : null);
    if (exit !== null) return `exit ${exit}`;
  }
  return '';
}

/**
 * Pending low-stakes tool accumulator.
 * Consecutive low-stakes tool use/result pairs are collected and rendered as a group.
 */
const toolGroupBuffer = {
  items: [],         // { toolName, params, result, variant }
  element: null,     // current group DOM element
  timeout: null
};

/**
 * Tracks how much of each response's clean text has already been "frozen" into
 * a completed message div.  When a tool event fires mid-stream we snapshot the
 * text accumulated so far, and subsequent chunks only display the remainder.
 */
const streamTextOffsets = new Map();

function flushToolGroup() {
  if (toolGroupBuffer.timeout) {
    clearTimeout(toolGroupBuffer.timeout);
    toolGroupBuffer.timeout = null;
  }
  if (toolGroupBuffer.items.length === 0) return;

  const items = [...toolGroupBuffer.items];
  toolGroupBuffer.items = [];
  toolGroupBuffer.element = null;

  renderToolGroup(items);
}

function renderToolGroup(items) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tool-group';

  // Summary text
  const counts = {};
  items.forEach(item => {
    const name = item.toolName;
    counts[name] = (counts[name] || 0) + 1;
  });
  const parts = Object.entries(counts).map(([name, count]) =>
    count > 1 ? `${name} ×${count}` : name
  );
  const summaryText = parts.join(', ');

  const row = document.createElement('div');
  row.className = 'tool-group-row';

  const icon = document.createElement('i');
  icon.className = 'fas fa-layer-group tool-group-icon';
  row.appendChild(icon);

  const summary = document.createElement('span');
  summary.className = 'tool-group-summary';
  summary.textContent = summaryText;
  row.appendChild(summary);

  const chevron = document.createElement('i');
  chevron.className = 'fas fa-chevron-right tool-chevron';
  row.appendChild(chevron);

  wrapper.appendChild(row);

  // Expandable item list
  const itemsDiv = document.createElement('div');
  itemsDiv.className = 'tool-group-items';
  itemsDiv.hidden = true;

  items.forEach(item => {
    const itemRow = document.createElement('div');
    itemRow.className = 'tool-group-item';

    const itemIcon = document.createElement('i');
    itemIcon.className = getToolIcon(item.toolName) + ' tool-icon';
    itemRow.appendChild(itemIcon);

    const label = document.createElement('span');
    label.textContent = getToolSummary(item.toolName, item.params);
    itemRow.appendChild(label);

    itemsDiv.appendChild(itemRow);
  });

  wrapper.appendChild(itemsDiv);

  // Toggle
  row.addEventListener('click', () => {
    const expanded = !itemsDiv.hidden;
    itemsDiv.hidden = expanded;
    row.classList.toggle('expanded', !expanded);
  });

  dom.chatMessages.appendChild(wrapper);

  // Keep the streaming indicator below tool groups
  const streaming = dom.chatMessages.querySelector('.message.streaming');
  if (streaming && streaming.nextElementSibling) {
    dom.chatMessages.appendChild(streaming);
  }

  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function addToolEventCompact(toolName, payload, variant = '', isResult = false) {
  const isLowStakes = LOW_STAKES_TOOLS.has(toolName);

  // Low-stakes tools: buffer into groups
  if (isLowStakes) {
    if (isResult) {
      // Try to update the last buffered item for this tool
      const existing = [...toolGroupBuffer.items].reverse().find(i => i.toolName === toolName && !i.result);
      if (existing) {
        existing.result = payload;
        existing.variant = variant;
      }
    } else {
      toolGroupBuffer.items.push({ toolName, params: payload, result: null, variant: '' });
    }

    // Reset flush timer — flush after a short idle gap
    if (toolGroupBuffer.timeout) clearTimeout(toolGroupBuffer.timeout);
    toolGroupBuffer.timeout = setTimeout(flushToolGroup, 150);
    return;
  }

  // High-stakes tools: flush any pending group first, then render individually
  flushToolGroup();

  const messageDiv = document.createElement('div');
  messageDiv.className = `message assistant tool-event high-stakes ${variant}`.trim();
  if (!isResult) {
    messageDiv.dataset.toolProgressTarget = toolName;
  }

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  const row = document.createElement('div');
  row.className = 'tool-event-row';

  // Icon
  const iconEl = document.createElement('i');
  const iconClass = getToolIcon(toolName);
  const variantClass = variant === 'error' ? 'error' : variant === 'success' ? 'success' : 'info';
  iconEl.className = `${iconClass} tool-icon ${variantClass}`;
  row.appendChild(iconEl);

  // Label
  const label = document.createElement('span');
  label.className = 'tool-label';
  if (isResult) {
    const resultSummary = getToolResultSummary(toolName, payload);
    label.textContent = resultSummary
      ? `${toolName} → ${resultSummary}`
      : `${toolName} ✓`;
  } else {
    label.textContent = getToolSummary(toolName, payload);
  }
  row.appendChild(label);

  // Progress text (updated by chat:toolProgress events)
  if (!isResult) {
    const progressSpan = document.createElement('span');
    progressSpan.className = 'tool-progress-text';
    row.appendChild(progressSpan);
  }

  // Status badge
  if (variant === 'success' || variant === 'error') {
    const badge = document.createElement('span');
    badge.className = `tool-status-badge ${variant}`;
    badge.textContent = variant === 'success' ? 'ok' : 'err';
    row.appendChild(badge);
  }

  // Chevron
  const chevron = document.createElement('i');
  chevron.className = 'fas fa-chevron-right tool-chevron';
  row.appendChild(chevron);

  messageContent.appendChild(row);

  // Expandable payload
  const payloadText = extractPayloadText(payload);
  if (payloadText) {
    const payloadDiv = document.createElement('div');
    payloadDiv.className = 'tool-event-payload';
    payloadDiv.hidden = true;

    // Check for Browser screenshot with savedTo path — show inline image
    if (isResult && toolName === 'Browser' && payload && payload.savedTo) {
      const imgContainer = document.createElement('div');
      imgContainer.style.cssText = 'margin: 8px 0; max-width: 100%; overflow: hidden;';
      const img = document.createElement('img');
      img.src = 'file://' + payload.savedTo.replace(/\\/g, '/');
      img.style.cssText = 'max-width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--border-color); cursor: pointer;';
      img.title = 'Click to open full size';
      img.addEventListener('click', () => {
        window.open(img.src, '_blank');
      });
      imgContainer.appendChild(img);
      payloadDiv.appendChild(imgContainer);

      // Also show the page info text below the image
      if (payload.page) {
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'margin-top: 8px; font-size: 0.9em; color: var(--text-secondary);';
        const pageUrl = payload.page.url || '';
        const pageTitle = payload.page.title || '';
        infoDiv.textContent = `${pageTitle} — ${pageUrl}`;
        payloadDiv.appendChild(infoDiv);
      }
    } else if (isResult && toolName === 'ImageGenerate' && payload && payload.ok && Array.isArray(payload.images)) {
      const grid = document.createElement('div');
      grid.style.cssText = 'display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0;';
      for (const imgInfo of payload.images) {
        const imgContainer = document.createElement('div');
        imgContainer.style.cssText = 'max-width: 100%; overflow: hidden;';
        const img = document.createElement('img');
        img.src = 'file://' + imgInfo.path.replace(/\\/g, '/');
        img.style.cssText = 'max-width: 100%; max-height: 512px; height: auto; border-radius: 6px; border: 1px solid var(--border-color); cursor: pointer;';
        img.title = imgInfo.revisedPrompt || imgInfo.fileName || 'Generated image — click to open';
        img.addEventListener('click', () => { window.open(img.src, '_blank'); });
        imgContainer.appendChild(img);
        grid.appendChild(imgContainer);
      }
      payloadDiv.appendChild(grid);

      const infoDiv = document.createElement('div');
      infoDiv.style.cssText = 'margin-top: 8px; font-size: 0.9em; color: var(--text-secondary);';
      infoDiv.textContent = payload.message || `${payload.count} image(s) generated`;
      payloadDiv.appendChild(infoDiv);
    } else if (isResult && payload?.diff && (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write')) {
      // Render structured diff for file edit/write results
      const diffEl = renderDiffBlock(payload.diff);
      payloadDiv.appendChild(diffEl);
      if (payload.linesAdded || payload.linesRemoved) {
        const statsEl = document.createElement('div');
        statsEl.className = 'diff-stats';
        statsEl.innerHTML = `<span class="diff-stat-added">+${payload.linesAdded || 0}</span> <span class="diff-stat-removed">-${payload.linesRemoved || 0}</span>`;
        payloadDiv.appendChild(statsEl);
      }
    } else if (typeof payload === 'string' || (payload && (payload.content || payload.stdout || payload.output || payload.message))) {
      // Try rendering as markdown, fall back to pre
      const markdownSource = typeof payload === 'string' ? payload : (payload.content || payload.stdout || payload.output || payload.message);
      try {
        payloadDiv.innerHTML = window.electron.markdown.parse(typeof markdownSource === 'string' ? markdownSource : String(markdownSource));
      } catch {
        const pre = document.createElement('pre');
        pre.textContent = payloadText;
        payloadDiv.appendChild(pre);
      }
    } else {
      const pre = document.createElement('pre');
      pre.textContent = payloadText;
      payloadDiv.appendChild(pre);
    }

    messageContent.appendChild(payloadDiv);

    // Auto-expand screenshots and generated images so they are visible immediately
    const isScreenshot = isResult && toolName === 'Browser' && payload && payload.savedTo;
    const isGeneratedImage = isResult && toolName === 'ImageGenerate' && payload && payload.ok && Array.isArray(payload.images);
    if (isScreenshot || isGeneratedImage) {
      payloadDiv.hidden = false;
      row.classList.add('expanded');
    }

    // Toggle expand/collapse
    row.addEventListener('click', () => {
      const expanded = !payloadDiv.hidden;
      payloadDiv.hidden = expanded;
      row.classList.toggle('expanded', !expanded);
    });
  }

  messageDiv.appendChild(messageContent);
  dom.chatMessages.appendChild(messageDiv);

  // Keep the streaming indicator below high-stakes tool events
  const streaming = dom.chatMessages.querySelector('.message.streaming');
  if (streaming && streaming.nextElementSibling) {
    dom.chatMessages.appendChild(streaming);
  }

  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

/** Legacy compat wrapper — still callable by old code paths if needed */
function addToolEventMessage(title, payload, variant = '') {
  // Extract tool name from title like "Using tool: Bash" or "Tool result: Read"
  const match = title.match(/(?:Using tool|Tool result):\s*(.+)/);
  const toolName = match ? match[1].trim() : 'unknown';
  const isResult = title.startsWith('Tool result');
  addToolEventCompact(toolName, payload, variant, isResult);
}

/**
 * Show a non-blocking notice banner (replaces alert()).
 * Auto-dismisses after a few seconds; click to dismiss early.
 */
function showNotice(text) {
  const el = document.createElement('div');
  el.className = 'kl-notice';
  el.textContent = text;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 5000);
}

/**
 * Show a confirm dialog using in-app modal (replaces confirm()).
 * Returns a promise that resolves to true (confirm) or false (cancel).
 */
function showConfirmDialog(message) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'rename-chat-modal';

    const card = document.createElement('div');
    card.className = 'rename-chat-card';

    const heading = document.createElement('h3');
    heading.textContent = 'Confirm';

    const body = document.createElement('p');
    body.textContent = message;
    body.style.color = 'var(--text-secondary)';
    body.style.margin = '0';

    const actions = document.createElement('div');
    actions.className = 'rename-chat-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn-primary';
    confirmBtn.textContent = 'Confirm';

    const close = (value) => { modal.remove(); resolve(value); };

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(false); });
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    card.appendChild(heading);
    card.appendChild(body);
    card.appendChild(actions);
    modal.appendChild(card);
    document.body.appendChild(modal);
    confirmBtn.focus();
  });
}

/**
 * Add a status message to the chat: renders the UI event, persists to backend,
 * and updates local appState so re-renders don't lose it.
 */
function addStatusMessage(text) {
  addToolEventCompact('Status', { message: text }, 'info', false);
  const chatId = appState.activeChatId;
  if (!chatId) return;
  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sender: 'status',
    text,
    timestamp: new Date().toISOString()
  };
  // Update local state so re-renders preserve it
  pushLoadedMessage(appState.chats.find((c) => c.id === chatId), msg);
  window.electron.chat.addMessage({ chatId, sender: 'status', text }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
}

// Suggest a reasonable "allow pattern" seed from a tool call. For Bash,
// we want `git *` when the user runs `git status`, not the literal command.
// For URL / path tools, we suggest the directory / origin prefix.
function suggestAllowPattern(toolName, parameters = {}) {
  if (!parameters || typeof parameters !== 'object') return null;
  if (toolName === 'Bash' && typeof parameters.command === 'string') {
    const first = parameters.command.trim().split(/\s+/)[0];
    if (first) return `${first} *`;
    return null;
  }
  if (toolName === 'WebFetch' && typeof parameters.url === 'string') {
    try {
      const u = new URL(parameters.url);
      return `${u.origin}/*`;
    } catch { return null; }
  }
  if ((toolName === 'Read' || toolName === 'Edit' || toolName === 'Write')
      && typeof parameters.file_path === 'string') {
    const p = parameters.file_path;
    const lastSlash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (lastSlash > 0) return p.slice(0, lastSlash + 1) + '*';
    return null;
  }
  if (toolName === 'WebSearch' && typeof parameters.query === 'string') {
    return '*';
  }
  // Browser rules match the action (src/tools/permission-rules.js).
  if (/^Browser(Page|Extract|Session)?$/.test(toolName) && typeof parameters.action === 'string') {
    return parameters.action;
  }
  return null;
}

function showToolApprovalDialog(approvalId, toolName, parameters) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant prompt-message';

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  const title = document.createElement('p');
  title.innerHTML = `<strong>Tool approval required:</strong> <code>${toolName}</code>`;

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(parameters || {}, null, 2);

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  // "Always allow matching pattern" — the preferred grant path. When
  // checked, the approval response carries a pattern that tool-handlers
  // persists as a permission rule. The user can still tweak the pattern
  // in the text input before approving.
  const patternSeed = suggestAllowPattern(toolName, parameters);
  const patternRow = document.createElement('div');
  patternRow.className = 'prompt-pattern-row';
  const patternLabel = document.createElement('label');
  patternLabel.className = 'prompt-checkbox-label';
  const patternCheckbox = document.createElement('input');
  patternCheckbox.type = 'checkbox';
  const patternText = document.createElement('span');
  patternText.textContent = ' Always allow pattern:';
  patternLabel.appendChild(patternCheckbox);
  patternLabel.appendChild(patternText);
  const patternInput = document.createElement('input');
  patternInput.type = 'text';
  patternInput.className = 'prompt-pattern-input';
  patternInput.placeholder = patternSeed || '*';
  patternInput.value = patternSeed || '';
  patternInput.disabled = !patternSeed;
  if (!patternSeed) {
    patternCheckbox.disabled = true;
    patternLabel.title = 'This tool has no matchable field for pattern rules.';
  }
  patternRow.appendChild(patternLabel);
  patternRow.appendChild(patternInput);

  // Legacy "Always approve entire tool" — kept for users who want the
  // coarse grant, but visually de-emphasized.
  const alwaysApproveLabel = document.createElement('label');
  alwaysApproveLabel.className = 'prompt-checkbox-label prompt-checkbox-muted';
  const alwaysApproveInput = document.createElement('input');
  alwaysApproveInput.type = 'checkbox';
  const alwaysApproveText = document.createElement('span');
  alwaysApproveText.textContent = ` Always approve all ${toolName} calls`;
  alwaysApproveLabel.appendChild(alwaysApproveInput);
  alwaysApproveLabel.appendChild(alwaysApproveText);

  const denyBtn = document.createElement('button');
  denyBtn.type = 'button';
  denyBtn.className = 'btn btn-danger btn-sm';
  denyBtn.appendChild(faIcon('fas fa-ban'));
  denyBtn.appendChild(document.createTextNode(' Deny'));

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'btn btn-primary btn-sm';
  approveBtn.appendChild(faIcon('fas fa-check'));
  approveBtn.appendChild(document.createTextNode(' Approve'));

  // Enable / disable the pattern input based on the checkbox.
  patternCheckbox.addEventListener('change', () => {
    patternInput.disabled = !patternCheckbox.checked;
    if (patternCheckbox.checked && !patternInput.value && patternSeed) {
      patternInput.value = patternSeed;
    }
  });

  let dismissed = false;
  function dismiss(approved) {
    if (dismissed) return;
    dismissed = true;
    const usePattern = approved && patternCheckbox.checked && patternInput.value.trim();
    window.electron.tool.respondToApproval(approvalId, approved, {
      alwaysApprove: approved ? Boolean(alwaysApproveInput.checked) : false,
      alwaysAllowPattern: usePattern ? patternInput.value.trim() : null
    });
    actions.innerHTML = '';
    const result = document.createElement('p');
    result.className = approved ? 'prompt-result-approved' : 'prompt-result-denied';
    if (approved) {
      if (usePattern) {
        result.textContent = `Approved and saved rule: ${toolName} '${patternInput.value.trim()}' → allow`;
      } else if (alwaysApproveInput.checked) {
        result.textContent = `Approved (always for ${toolName})`;
      } else {
        result.textContent = 'Approved';
      }
    } else {
      result.textContent = 'Denied';
    }
    actions.appendChild(result);
  }

  denyBtn.addEventListener('click', () => dismiss(false), { once: true });
  approveBtn.addEventListener('click', () => dismiss(true), { once: true });

  actions.appendChild(patternRow);
  actions.appendChild(alwaysApproveLabel);
  actions.appendChild(denyBtn);
  actions.appendChild(approveBtn);

  messageContent.appendChild(title);
  messageContent.appendChild(pre);
  messageContent.appendChild(actions);
  messageDiv.appendChild(messageContent);
  dom.chatMessages.appendChild(messageDiv);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function showDirectoryAccessDialog(requestId, directory, toolName) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant prompt-message';

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  const desc = document.createElement('p');
  desc.innerHTML = `<strong>Directory access required:</strong> <code>${toolName}</code> needs access to:`;

  const pathEl = document.createElement('pre');
  pathEl.textContent = directory;

  const hint = document.createElement('p');
  hint.className = 'prompt-hint';
  hint.textContent = 'Allow grants access for this session. Always Allow adds the directory to your global allow list.';

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  const denyBtn = document.createElement('button');
  denyBtn.type = 'button';
  denyBtn.className = 'btn btn-danger btn-sm';
  denyBtn.appendChild(faIcon('fas fa-ban'));
  denyBtn.appendChild(document.createTextNode(' Deny'));

  const allowBtn = document.createElement('button');
  allowBtn.type = 'button';
  allowBtn.className = 'btn btn-primary btn-sm';
  allowBtn.appendChild(faIcon('fas fa-folder-open'));
  allowBtn.appendChild(document.createTextNode(' Allow'));

  const alwaysAllowBtn = document.createElement('button');
  alwaysAllowBtn.type = 'button';
  alwaysAllowBtn.className = 'btn btn-primary btn-sm';
  alwaysAllowBtn.appendChild(faIcon('fas fa-shield-halved'));
  alwaysAllowBtn.appendChild(document.createTextNode(' Always Allow'));

  let dismissed = false;
  function dismiss(approved, alwaysAllow = false) {
    if (dismissed) return;
    dismissed = true;
    window.electron.tool.respondToDirectoryAccess(requestId, approved, { alwaysAllow });
    actions.innerHTML = '';
    const result = document.createElement('p');
    result.className = approved ? 'prompt-result-approved' : 'prompt-result-denied';
    result.textContent = alwaysAllow ? 'Access granted (added to allow list)' : approved ? 'Access granted' : 'Access denied';
    actions.appendChild(result);
  }

  denyBtn.addEventListener('click', () => dismiss(false), { once: true });
  allowBtn.addEventListener('click', () => dismiss(true), { once: true });
  alwaysAllowBtn.addEventListener('click', () => dismiss(true, true), { once: true });

  actions.appendChild(denyBtn);
  actions.appendChild(allowBtn);
  actions.appendChild(alwaysAllowBtn);

  messageContent.appendChild(desc);
  messageContent.appendChild(pathEl);
  messageContent.appendChild(hint);
  messageContent.appendChild(actions);
  messageDiv.appendChild(messageContent);
  dom.chatMessages.appendChild(messageDiv);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

// Send message function
function formatTimestamp(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getActiveChat() {
  return appState.chats.find((chat) => chat.id === appState.activeChatId);
}

function mergeChatIntoState(chat) {
  if (!chat?.id) return null;
  const index = appState.chats.findIndex((item) => item.id === chat.id);
  if (index >= 0) {
    appState.chats[index] = { ...appState.chats[index], ...chat };
  } else {
    appState.chats = [chat, ...appState.chats];
  }
  return appState.chats.find((item) => item.id === chat.id) || null;
}

async function ensureChatMessagesLoaded(chatId = appState.activeChatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const existing = appState.chats.find((chat) => chat.id === id);
  if (existing && Array.isArray(existing.messages)) {
    return existing;
  }
  if (!window.electron?.chat?.get) {
    return existing || null;
  }

  const result = unwrapIpcResult(await window.electron.chat.get(id), 'Unable to load chat messages.');
  const chat = result?.chat || result;
  return mergeChatIntoState(chat);
}

// The renderer holds only the active chat's messages (recall spec §4.4);
// every other chat keeps the metadata the sidebar needs. Runs on every
// refresh, so a chat left behind by a switch, or a full chat an IPC reply
// handed back, drops its messages; selecting it again loads them through
// chat:get (ensureChatMessagesLoaded).
function dropInactiveChatMessages(chats, activeChatId) {
  for (const chat of chats) {
    if (!chat || chat.id === activeChatId || !Array.isArray(chat.messages)) continue;
    const messages = chat.messages;
    const visible = messages.filter((m) => m && (m.sender === 'user' || m.sender === 'assistant'));
    const last = visible[visible.length - 1] || messages[messages.length - 1] || null;
    chat.messageCount = messages.length;
    chat.userMessageCount = messages.filter((m) => m?.sender === 'user').length;
    chat.assistantMessageCount = messages.filter((m) => m?.sender === 'assistant').length;
    chat.preview = last?.text || '';
    chat.lastMessageText = last?.text || '';
    chat.lastMessageAt = last?.timestamp || null;
    delete chat.messages;
  }
}

// A message the renderer adds itself (a status line, a workflow goal) joins
// a chat's local list only when that list is loaded: pushing into an
// unloaded chat would make it look loaded with that one message. It is
// persisted through IPC either way.
function pushLoadedMessage(chat, message) {
  if (chat && Array.isArray(chat.messages)) chat.messages.push(message);
}

function historyNoticeText(history) {
  if (!history || typeof history !== 'object') return null;
  if (history.available === false) {
    return `Chats are unavailable: ${history.error || 'the history store did not open'}. See the log.`;
  }
  const failed = Number(history.migrationFailed) || 0;
  if (failed > 0) return `${failed} ${failed === 1 ? 'chat' : 'chats'} could not be migrated; see log`;
  return null;
}

function getChatPreview(chat) {
  const messages = chat.messages || [];
  const lastVisible = messages.findLast((m) => m.sender === 'user' || m.sender === 'assistant');
  if (lastVisible) return lastVisible.text;
  if (typeof chat.preview === 'string' && chat.preview.trim()) return chat.preview;
  if (typeof chat.lastMessageText === 'string' && chat.lastMessageText.trim()) return chat.lastMessageText;
  if (Number(chat.messageCount || 0) > 0) return `${Number(chat.messageCount).toLocaleString()} messages`;
  return 'No messages yet...';
}

function sumChatLlmTotals(chat) {
  if (!Array.isArray(chat?.messages)) {
    return chat?.llmTotals || { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  }

  const totals = chat?.messages?.reduce(
    (acc, msg) => ({
      inputTokens: acc.inputTokens + (Number(msg?.llm?.totals?.inputTokens) || 0),
      outputTokens: acc.outputTokens + (Number(msg?.llm?.totals?.outputTokens) || 0),
      totalTokens: acc.totalTokens + (Number(msg?.llm?.totals?.totalTokens) || 0),
      costUsd: Number((acc.costUsd + (Number(msg?.llm?.totals?.costUsd) || 0)).toFixed(8))
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
  ) || { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

  return totals;
}

function formatUsd(value = 0) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatCompactUsd(value = 0) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized)) {
    return '$0.0000';
  }

  if (normalized >= 0.01) {
    return `$${normalized.toFixed(2)}`;
  }

  if (normalized >= 0.001) {
    return `$${normalized.toFixed(3)}`;
  }

  return `$${normalized.toFixed(4)}`;
}

// A reply's cost by role (models spec 2026-09-27 §10): " · main $0.09 ·
// worker $0.02 · utility $0.01". Core roles first; an unpriced role's cost
// is a lower bound, so it gets a "+".
function formatRoleCosts(byRole) {
  if (!byRole || typeof byRole !== 'object') return '';
  const order = ['main', 'worker', 'utility', 'vision', 'imageGeneration'];
  const roles = Object.keys(byRole);
  const ordered = [...order.filter((r) => roles.includes(r)), ...roles.filter((r) => !order.includes(r)).sort()];
  // A borrowed role names the role whose model it ran on: "worker (main) $0.20".
  const label = (r) => (typeof byRole[r]?.borrowedFrom === 'string' && byRole[r].borrowedFrom ? `${r} (${byRole[r].borrowedFrom})` : r);
  return ordered.map((r) => ` · ${label(r)} ${formatCompactUsd(byRole[r]?.costUsd)}${byRole[r]?.unpriced ? '+' : ''}`).join('');
}

function formatTokenCount(value = 0) {
  return Number(value || 0).toLocaleString();
}

function renderChatList() {
  dom.chatList.innerHTML = '';
  if (appState.historyStatus?.available === false) {
    const note = document.createElement('div');
    note.className = 'chat-list-error';
    note.textContent = historyNoticeText(appState.historyStatus);
    dom.chatList.appendChild(note);
  }

  appState.chats.forEach((chat) => {
    const chatItem = document.createElement('div');
    const classes = ['chat-item'];
    if (chat.id === appState.activeChatId) classes.push('active');
    if (appState.activeResponses.has(chat.id)) classes.push('streaming');
    chatItem.className = classes.join(' ');
    chatItem.dataset.chatId = chat.id;

    const viewBtn = document.createElement('button');
    viewBtn.className = 'chat-view-btn';
    viewBtn.type = 'button';
    viewBtn.title = `View ${chat.title}`;
    viewBtn.setAttribute('aria-label', `View ${chat.title}`);
    viewBtn.dataset.chatId = chat.id;

    const viewBtnDot = document.createElement('span');
    viewBtnDot.className = 'chat-view-btn-dot';
    viewBtn.appendChild(viewBtnDot);

    const details = document.createElement('div');
    details.className = 'chat-item-details';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'chat-item-title';
    titleDiv.textContent = chat.title;

    const previewDiv = document.createElement('div');
    previewDiv.className = 'chat-item-preview';
    previewDiv.textContent = getChatPreview(chat);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'chat-item-meta';
    const totals = chat.llmTotals || sumChatLlmTotals(chat);
    metaDiv.textContent = `Updated ${formatTimestamp(chat.updatedAt)} • ${formatTokenCount(totals.totalTokens)} tokens • ${formatUsd(totals.costUsd)}`;

    details.appendChild(titleDiv);
    details.appendChild(previewDiv);
    details.appendChild(metaDiv);

    const actions = document.createElement('div');
    actions.className = 'chat-item-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn btn-sm chat-action-btn';
    renameBtn.appendChild(faIcon('fas fa-pen'));
    renameBtn.dataset.action = 'rename';
    renameBtn.dataset.chatId = chat.id;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-sm btn-danger chat-action-btn';
    deleteBtn.appendChild(faIcon('fas fa-trash'));
    deleteBtn.dataset.action = 'delete';
    deleteBtn.dataset.chatId = chat.id;

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);

    chatItem.appendChild(viewBtn);
    chatItem.appendChild(details);
    chatItem.appendChild(actions);

    dom.chatList.appendChild(chatItem);
  });
}

async function renderChatCaseSection(chat, container) {
  container.innerHTML = '';
  const listed = await window.electron.cases.list();
  const cases = listed?.ok ? listed.cases : [];

  const error = document.createElement('div');
  error.id = 'chat-case-error';
  error.className = 'chat-case-error';
  const showError = (message) => { error.textContent = message || ''; };
  if (!listed?.ok) showError(`Could not load cases: ${listed?.error || 'unknown error'}`);

  const row = document.createElement('div');
  row.className = 'chat-info-row';
  const label = document.createElement('span');
  label.className = 'chat-info-label';
  label.appendChild(faIcon('fas fa-briefcase'));
  label.appendChild(document.createTextNode('Attached case'));
  const select = document.createElement('select');
  select.className = 'chat-info-select';
  select.id = 'chat-case-select';
  const addOption = (value, text) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  };
  addOption('', 'None');
  cases.forEach((c) => addOption(c.id, `${c.title} (${c.status})`));
  // The chat points at a case the store no longer lists (moved, deleted, or
  // cases.root changed). Show it so the owner can see why and detach.
  const caseMissing = Boolean(listed?.ok && chat.caseId && !cases.some((c) => c.id === chat.caseId));
  if (caseMissing) {
    addOption(chat.caseId, `Missing case (${chat.caseId})`);
    showError(`This chat's case (${chat.caseId}) is no longer in the cases folder. Choose None to detach it, or pick another case.`);
  }
  addOption('__new__', 'New case…');
  select.value = chat.caseId && (caseMissing || cases.some((c) => c.id === chat.caseId)) ? chat.caseId : '';
  // Restored when the New case dialog is cancelled.
  const previousValue = select.value;
  row.append(label, select);

  const orientationBtn = document.createElement('button');
  orientationBtn.type = 'button';
  orientationBtn.id = 'chat-case-orientation-btn';
  orientationBtn.className = 'btn btn-sm chat-case-orientation-btn';
  orientationBtn.textContent = 'Show orientation';
  orientationBtn.hidden = !chat.caseId || caseMissing;
  const orientation = document.createElement('pre');
  orientation.id = 'chat-case-orientation';
  orientation.className = 'chat-case-orientation';
  orientation.hidden = true;

  container.append(row, orientationBtn, orientation, error);

  // Cases stage 6: the playbooks of the attached case. The create-form
  // picker lives in the New case dialog.
  const playbooksSection = document.createElement('div');
  playbooksSection.id = 'case-playbooks-section';
  playbooksSection.className = 'case-playbooks-section';
  container.appendChild(playbooksSection);
  if (chat.caseId && !caseMissing) {
    renderPlaybooksSection(chat, playbooksSection).catch((err) => chatLog.warn(`Playbooks panel failed: ${err.message}`));
  }

  // Cases stage 2: status, budget and questions for the attached case.
  const unattended = document.createElement('div');
  unattended.id = 'case-unattended-section';
  unattended.className = 'case-unattended-section';
  container.appendChild(unattended);
  if (chat.caseId && !caseMissing) {
    renderCaseUnattendedSection(chat, unattended, { compact: false }).catch((err) => chatLog.warn(`Case panel failed: ${err.message}`));
  }
  refreshCaseQuestionsBar();

  // Cases stage 5: detour proposals and related cases.
  const detours = document.createElement('div');
  detours.id = 'case-detours-section';
  detours.className = 'case-detours-section';
  container.appendChild(detours);
  if (chat.caseId && !caseMissing) {
    renderCaseDetoursSection(chat, detours).catch((err) => chatLog.warn(`Detours panel failed: ${err.message}`));
  }

  const adopt = async (updatedChat) => {
    if (!updatedChat) return;
    appState.chats = appState.chats.map((c) => (c.id === updatedChat.id ? updatedChat : c));
    await renderChatCaseSection(updatedChat, container);
  };

  select.addEventListener('change', async () => {
    showError('');
    if (select.value === '__new__') {
      let created = null;
      const extra = document.createElement('div');
      const playbookPicker = buildPlaybookPicker(extra);
      await showTextInputDialog({
        heading: 'New case',
        placeholder: 'Case title',
        confirmLabel: 'Create',
        idPrefix: 'chat-case-new',
        extra,
        onSubmit: async (value) => {
          const title = value.trim();
          if (!title) return 'Give the case a title.';
          let result = await window.electron.cases.create({ title, chatId: chat.id, ...playbookPicker.fields() });
          // Cases stage 5: a similar open case exists; create anyway, or attach to it.
          if (!result?.ok && result?.code === 'SIMILAR_CASES' && Array.isArray(result.similar) && result.similar.length) {
            const match = result.similar[0];
            if (await showConfirmDialog(`A similar case exists: "${match.title}" (${match.status}). Create anyway?`)) {
              result = await window.electron.cases.create({ title, chatId: chat.id, force: true, ...playbookPicker.fields() });
            } else {
              result = await window.electron.cases.attach({ chatId: chat.id, caseId: match.caseId });
            }
          }
          if (!result?.ok) return result?.error || 'Could not create the case.';
          created = result;
          return null;
        }
      });
      if (!created) { select.value = previousValue; return; }
      await adopt(created.chat);
      // Cases stage 6: the case exists; a playbook that failed to attach is
      // reported here (plain text; the owner can add it again from the panel).
      for (const p of Array.isArray(created.playbooks) ? created.playbooks : []) {
        if (p && p.error) showNotice(playbookClip(`Playbook ${p.name || '?'} was not attached: ${p.error}`));
      }
      return;
    }
    const result = await window.electron.cases.attach({ chatId: chat.id, caseId: select.value || null });
    if (!result?.ok) { showError(result?.error || 'Could not attach the case.'); return; }
    await adopt(result.chat);
  });

  orientationBtn.addEventListener('click', async () => {
    showError('');
    const result = await window.electron.cases.orientation({ caseId: chat.caseId });
    if (!result?.ok) {
      showError(result?.error || 'Could not load the orientation.');
      orientation.textContent = '';
      orientation.hidden = true;
      return;
    }
    orientation.textContent = result.text;
    orientation.hidden = false;
  });

  // Cases stage 7: documents and fact proposals for the attached case.
  const sources = document.createElement('div');
  sources.id = 'case-sources-section';
  sources.className = 'case-sources';
  container.appendChild(sources);
  if (chat.caseId && !caseMissing) {
    renderCaseSourcesSection(chat, sources).catch((err) => chatLog.warn(`Sources section failed: ${err.message}`));
  }
}

/* --- Cases stage 7: sources (docs/superpowers/specs/2026-09-23-cases-stage7-ingest.md §3.9) --- */
// Files go to the main process as bytes, one ingestFiles call per file
// (ruling M13: attached, each call is one bridge frame, and each file gets
// its own result or error). Every string that comes from a document, a
// record or a model (names, statements, quotes, notes, reasons) is set with
// textContent: the replies carry untrustedText: true. Accept all verified,
// and any accept that supersedes the owner's own statement, ask first.

const CASE_SOURCES_BUSY = new Set(['extracting', 'proposing', 'checking']);
const CASE_SOURCES_OWNER_ORIGINS = new Set(['owner-drop', 'owner-paste']);
// The ingestFiles handler's per-call limits, checked here before any file is read.
const CASE_SOURCES_MAX_FILES = 10;
const CASE_SOURCES_MAX_BYTES = 100 * 1024 * 1024;
const CASE_SOURCES_POLL_MS = 3000;
// How long the list keeps polling after an add or a read request, while the
// document may not have reached a busy status yet.
const CASE_SOURCES_SETTLE_MS = 15000;
// The handler's caps on edited fields (ruling M10).
const CASE_SOURCES_EDIT_CAP = Object.freeze({ stmt: 500, value: 300 });
const CASE_SOURCES_CONFIRM_LIST = 10;

function caseSourcesBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function caseSourcesEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

// A button that runs its action once at a time; a thrown error is shown
// through onError (a preload argument check throws before any IPC).
function caseSourcesButton(label, onClick, onError) {
  const b = caseSourcesEl('button', 'secondary-button', label);
  b.type = 'button';
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      await onClick();
    } catch (err) {
      if (onError) onError(err); else chatLog.warn(`Sources action failed: ${err.message}`);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

// The files of a drop or paste, and the names of any folders in it (read
// synchronously, while the event's items are still available).
function caseSourcesPicked(dataTransfer) {
  const files = [];
  const folders = [];
  const items = Array.from(dataTransfer?.items || []).filter((item) => item.kind === 'file');
  if (!items.length) return { files: Array.from(dataTransfer?.files || []), folders };
  for (const item of items) {
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    const file = item.getAsFile();
    if (entry && entry.isDirectory) { folders.push(entry.name || file?.name || 'folder'); continue; }
    if (file) files.push(file);
  }
  return { files, folders };
}

// One file, one ingestFiles call → one status line.
async function caseSourcesAddOne(caseId, file, name, source) {
  let base64;
  try {
    base64 = caseSourcesBase64(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return `${name}: could not be read. Folders cannot be added.`;
  }
  let res;
  try {
    res = await window.electron.cases.ingestFiles({ caseId, files: [{ name, mime: file.type || '', base64 }], source });
  } catch (err) {
    return `${name}: ${err.message}`;
  }
  // A call-level refusal, including the desktop bridge's "too large" for one
  // file over its frame limit when attached.
  if (!res?.ok) return `${name}: ${res?.error || 'Could not add the file.'}`;
  const r = Array.isArray(res.results) ? res.results[0] : null;
  if (!r) return `${name}: Could not add the file.`;
  if (r.error) return `${name}: ${r.error}`;
  if (r.duplicate) return `${name}: Already in this case as ${r.ref}`;
  const also = Array.isArray(r.alsoInCases) && r.alsoInCases.length ? `. Also in: ${r.alsoInCases.map((c) => c.title).join(', ')}` : '';
  return `${name}: Added ${r.ref}${also}`;
}

// The owner is editing in this row: an edit form is open or one of its
// inputs has focus.
function caseSourcesEditing(row) {
  if (row.querySelector('.case-proposal-edit:not([hidden])')) return true;
  const active = document.activeElement;
  return Boolean(active && active.tagName === 'INPUT' && row.contains(active));
}

async function renderCaseSourcesSection(chat, container) {
  container.innerHTML = '';
  const caseId = chat.caseId;
  const drop = caseSourcesEl('div', 'case-sources-drop', 'Drop or paste a PDF, image or text file here');
  drop.id = 'case-sources-drop';
  drop.tabIndex = 0;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.accept = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv';
  const addBtn = caseSourcesButton('Add…', () => fileInput.click());
  addBtn.id = 'case-sources-add-btn';
  const status = caseSourcesEl('div', 'case-sources-status');
  status.id = 'case-sources-status';
  const list = caseSourcesEl('div', 'case-sources-list');
  list.id = 'case-sources-list';
  container.append(caseSourcesEl('div', 'chat-info-label', 'Sources'), drop, addBtn, fileInput, status, list);

  const say = (lines) => { status.textContent = lines.filter(Boolean).join('\n'); };
  const fail = (err) => say([err?.message || String(err)]);
  const openDocs = new Set();
  let timer = null;
  let settleUntil = 0;
  let adding = false;

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (container.isConnected) refresh().catch((err) => chatLog.warn(`Sources refresh failed: ${err.message}`));
    }, CASE_SOURCES_POLL_MS);
  };
  const settle = () => { settleUntil = Date.now() + CASE_SOURCES_SETTLE_MS; };

  // A row with an open edit form, or focus in one of its inputs, is kept as
  // it is, so a poll never resets what the owner is typing; rebuild names the
  // row an action just changed, which is always rebuilt.
  async function refresh({ rebuild = null } = {}) {
    if (!container.isConnected && list.childElementCount) return;
    const res = await window.electron.cases.sources({ caseId });
    const kept = new Map();
    for (const row of Array.from(list.children)) {
      const id = row.dataset?.docId;
      if (id && id !== rebuild && caseSourcesEditing(row)) kept.set(id, row);
    }
    list.innerHTML = '';
    if (!res?.ok) { say([res?.error || 'Could not load the sources.']); return; }
    const documents = Array.isArray(res.documents) ? res.documents : [];
    if (!documents.length) list.appendChild(caseSourcesEl('div', 'case-sources-empty', 'No documents yet.'));
    const ctx = { refresh, say, fail, openDocs, settle };
    for (const doc of documents) list.appendChild(kept.get(doc.docId) || renderCaseSourceRow(caseId, doc, ctx));
    if (documents.some((d) => CASE_SOURCES_BUSY.has(d.status)) || Date.now() < settleUntil) schedule();
  }

  async function send(picked, source) {
    if (adding) { say(['Still adding the previous files.']); return; }
    const lines = picked.folders.map((n) => `${n}: folders cannot be added. Drop the files inside it.`);
    const files = picked.files;
    if (files.length > CASE_SOURCES_MAX_FILES) { say([...lines, `At most ${CASE_SOURCES_MAX_FILES} files per drop. Nothing was added.`]); return; }
    if (files.reduce((n, f) => n + (f.size || 0), 0) > CASE_SOURCES_MAX_BYTES) { say([...lines, 'At most 100 MB per drop. Nothing was added.']); return; }
    if (!files.length) { say(lines); return; }
    adding = true;
    try {
      for (const f of files) {
        const name = f.name || (source === 'paste' ? 'pasted' : 'document');
        lines.push(`${name}: adding…`);
        say(lines);
        lines[lines.length - 1] = await caseSourcesAddOne(caseId, f, name, source);
        say(lines);
      }
    } finally {
      adding = false;
    }
    settle();
    await refresh();
  }

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('case-sources-drop-active'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('case-sources-drop-active'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('case-sources-drop-active');
    send(caseSourcesPicked(e.dataTransfer), 'drop').catch(fail);
  });
  drop.addEventListener('paste', (e) => {
    if (!e.clipboardData?.files?.length) return;
    e.preventDefault();
    send(caseSourcesPicked(e.clipboardData), 'paste').catch(fail);
  });
  fileInput.addEventListener('change', () => {
    send({ files: Array.from(fileInput.files || []), folders: [] }, 'drop').catch(fail).finally(() => { fileInput.value = ''; });
  });
  await refresh();
}

function renderCaseSourceRow(caseId, doc, ctx) {
  const row = caseSourcesEl('div', 'case-source');
  row.dataset.docId = doc.docId || '';
  const m = doc.methods || {};
  const mix = [`text ${m.text || 0}`, `ocr ${m.ocr || 0}`, m.pendingOcr ? `pending ${m.pendingOcr}` : '', m.unreadable ? `unreadable ${m.unreadable}` : ''].filter(Boolean).join(' · ');
  const origin = doc.origin === 'tool' ? 'added by King Louie' : CASE_SOURCES_OWNER_ORIGINS.has(doc.origin) ? 'added by you' : 'origin unknown';
  const name = doc.name || 'document';
  row.appendChild(caseSourcesEl('div', 'case-source-title', `${name} — ${doc.pages ?? '?'} page(s) · ${mix} · ${doc.status || 'unknown'} · ${formatUsd(doc.usd)} · ${origin}`));
  if (doc.note) row.appendChild(caseSourcesEl('div', 'case-source-note', doc.note));
  if (!doc.docId) return row;
  const actions = caseSourcesEl('div', 'case-source-actions');
  const remaining = (m.pendingOcr || 0) + (m.unreadable || 0);
  const extract = async () => {
    const res = await window.electron.cases.ingestExtract({ caseId, docId: doc.docId });
    if (!res?.ok) ctx.say([`${name}: ${res?.error || 'Could not start reading.'}`]);
    else ctx.say([`${name}: reading started.`]);
    ctx.settle();
    await ctx.refresh();
  };
  if (!CASE_SOURCES_BUSY.has(doc.status)) {
    if (remaining > 0) {
      actions.appendChild(caseSourcesButton(`Read ${remaining} remaining pages (≈ ${formatUsd(doc.estimateUsd)})`, async () => {
        if (await showConfirmDialog(`Read the ${remaining} remaining pages of ${name} with a vision model, for about ${formatUsd(doc.estimateUsd)}? This read has no page cap and is charged to the case budget.`)) await extract();
      }, ctx.fail));
    } else if (doc.status === 'stored' || doc.status === 'failed') {
      actions.appendChild(caseSourcesButton('Extract', extract, ctx.fail));
    }
  }
  const details = caseSourcesEl('div', 'case-source-proposals');
  details.hidden = !ctx.openDocs.has(doc.docId);
  if ((doc.pending || 0) + (doc.accepted || 0) + (doc.rejected || 0) > 0) {
    actions.appendChild(caseSourcesButton(`Review (${doc.pending || 0} open)`, async () => {
      details.hidden = !details.hidden;
      if (details.hidden) { ctx.openDocs.delete(doc.docId); return; }
      ctx.openDocs.add(doc.docId);
      await renderCaseSourceProposals(caseId, doc, details, ctx);
    }, ctx.fail));
    if (!details.hidden) renderCaseSourceProposals(caseId, doc, details, ctx).catch(ctx.fail);
  } else {
    details.hidden = true;
  }
  row.append(actions, details);
  return row;
}

function caseSourcesBadges(p) {
  const c = p.checks || {};
  const ocr = p.anchor?.ocr === true;
  return [
    ocr ? 'read by OCR' : '',
    ocr ? (c.verify?.sawImage ? 'verify saw the image' : 'verify did not see the image') : '',
    c.valueInQuote === false ? 'value not in quote' : '',
    c.verify?.agrees === false ? `verify disagrees: ${c.verify.note || ''}` : '',
    c.verify && c.verify.agrees === null ? `not verified${c.verify.note ? `: ${c.verify.note}` : ''}` : '',
    ...(Array.isArray(c.conflicts) ? c.conflicts : []).map((x) => `conflicts with ${x.factId}${x.provenance === 'user' ? ' (your statement)' : ''}`),
    c.duplicateOf ? `duplicate of ${c.duplicateOf}` : ''
  ].filter(Boolean);
}

// What accepting p over a conflicting fact x does, for the confirm dialog.
// Every supersede asks; replacing the owner's own statement is worded as such.
function caseSourcesSupersedeMessage(p, x, stmt, edited) {
  const what = edited ? `Save your edit of ${p.id} and accept it` : `Accept ${p.id}`;
  if (x.provenance === 'user') {
    return `${what}, replacing ${x.factId}, which is your own statement? ${x.factId} will no longer be an active fact: it stays in the ledger only as superseded, and a statement read from a document takes its place as a private sourced fact: ${stmt}`;
  }
  return `${what} and supersede ${x.factId}? ${x.factId} stays in the ledger as superseded, and this becomes a private sourced fact in its place: ${stmt}`;
}

function caseSourcesKeepBothMessage(p, conflicts, stmt, edited) {
  const what = edited ? `Save your edit of ${p.id} and accept it` : `Accept ${p.id}`;
  return `${what} and keep ${conflicts.map((x) => x.factId).join(', ')} as well? Both stay active facts although they conflict, and this becomes a private sourced fact alongside: ${stmt}`;
}

// The proposal's edit form: only stmt and value, only when changed, and
// only within the handler's caps. With conflicts, an edit is saved with a
// supersede or keep-both choice, confirmed like the plain ones.
function caseSourcesEditForm(p, conflicts, act, say) {
  const edit = caseSourcesEl('div', 'case-proposal-edit');
  edit.hidden = true;
  const oldValue = p.value === null || p.value === undefined ? '' : String(p.value);
  const stmt = document.createElement('input');
  stmt.className = 'chat-info-input';
  stmt.maxLength = CASE_SOURCES_EDIT_CAP.stmt;
  stmt.value = p.stmt || '';
  const value = document.createElement('input');
  value.className = 'chat-info-input';
  value.maxLength = CASE_SOURCES_EDIT_CAP.value;
  value.value = oldValue;
  // → the changed fields, or null after telling the owner why not.
  const changes = () => {
    const out = {};
    if (stmt.value !== (p.stmt || '')) {
      if (!stmt.value.trim()) { say([`${p.id}: the statement needs text.`]); return null; }
      if (stmt.value.length > CASE_SOURCES_EDIT_CAP.stmt) { say([`${p.id}: the statement is longer than ${CASE_SOURCES_EDIT_CAP.stmt} characters.`]); return null; }
      out.stmt = stmt.value;
    }
    if (value.value !== oldValue) {
      if (value.value.length > CASE_SOURCES_EDIT_CAP.value) { say([`${p.id}: the value is longer than ${CASE_SOURCES_EDIT_CAP.value} characters.`]); return null; }
      out.value = value.value.trim() ? value.value : null;
    }
    if (!Object.keys(out).length) { say([`${p.id}: nothing changed.`]); return null; }
    return out;
  };
  const onError = (err) => say([err.message]);
  edit.append(stmt, value);
  if (!conflicts.length) {
    edit.appendChild(caseSourcesButton('Save edit', async () => {
      const c = changes();
      if (c) await act(p.id, { action: 'edit', edit: c }, 'edited and accepted');
    }, onError));
  }
  for (const x of conflicts) {
    edit.appendChild(caseSourcesButton(`Save edit & supersede ${x.factId}`, async () => {
      const c = changes();
      if (!c || !(await showConfirmDialog(caseSourcesSupersedeMessage(p, x, c.stmt ?? p.stmt ?? '', true)))) return;
      await act(p.id, { action: 'edit', edit: c, supersedes: x.factId }, `edited and accepted, superseding ${x.factId}`);
    }, onError));
  }
  if (conflicts.length && conflicts.every((x) => x.provenance !== 'user')) {
    edit.appendChild(caseSourcesButton('Save edit & keep both', async () => {
      const c = changes();
      if (!c || !(await showConfirmDialog(caseSourcesKeepBothMessage(p, conflicts, c.stmt ?? p.stmt ?? '', true)))) return;
      await act(p.id, { action: 'edit', edit: c, keepBoth: true }, 'edited and accepted alongside the conflicting fact');
    }, onError));
  }
  return edit;
}

async function renderCaseSourceProposals(caseId, doc, container, ctx) {
  container.innerHTML = '';
  const res = await window.electron.cases.ingestRecord({ caseId, docId: doc.docId });
  if (!res?.ok) { container.textContent = res?.error || 'Could not load the proposals.'; return; }
  const rec = res.record || {};
  const proposals = Array.isArray(rec.proposals) ? rec.proposals : [];
  const open = proposals.filter((p) => !p.review);
  const act = async (proposalId, params, done) => {
    const r = await window.electron.cases.reviewProposal({ caseId, docId: doc.docId, proposalId, ...params });
    if (!r?.ok) { ctx.say([`${proposalId}: ${r?.error || 'Review failed.'}`]); return; }
    ctx.say([`${proposalId}: ${done}${r.fact?.id ? ` as ${r.fact.id}` : ''}.`]);
    await ctx.refresh({ rebuild: doc.docId });
  };
  // Accept all verified is for the owner's own files only (the record and
  // the list row must both say so); a file King Louie added is reviewed one
  // proposal at a time.
  const ownerFile = CASE_SOURCES_OWNER_ORIGINS.has(rec.origin?.kind) && CASE_SOURCES_OWNER_ORIGINS.has(doc.origin);
  if (ownerFile && open.length) {
    container.appendChild(caseSourcesButton('Accept all verified', async () => {
      const shown = open.slice(0, CASE_SOURCES_CONFIRM_LIST).map((p) => `${p.id}: ${p.stmt || ''}`);
      const more = open.length > CASE_SOURCES_CONFIRM_LIST ? ` …and ${open.length - CASE_SOURCES_CONFIRM_LIST} more.` : '';
      const message = `Accept all verified proposals of ${rec.name || 'this document'}? Of the ${open.length} open proposals, each one whose quote is on its page, whose value is in the quote, that the verify check agrees with, and that neither conflicts with nor duplicates an active fact becomes a private sourced fact. The others are skipped and stay open for you to review. Open: ${shown.join('; ')}${more}`;
      if (!(await showConfirmDialog(message))) return;
      const r = await window.electron.cases.acceptVerified({ caseId, docId: doc.docId });
      if (!r?.ok) { ctx.say([r?.error || 'Accept all failed.']); return; }
      const accepted = Array.isArray(r.accepted) ? r.accepted : [];
      const skipped = Array.isArray(r.skipped) ? r.skipped : [];
      ctx.say([`Accepted ${accepted.length}${accepted.length ? `: ${accepted.join(', ')}` : ''}.`, ...skipped.map((s) => `${s.pid || 'A proposal'} skipped: ${s.why}`)]);
      await ctx.refresh({ rebuild: doc.docId });
    }, ctx.fail));
  }
  const audit = document.createElement('details');
  audit.appendChild(caseSourcesEl('summary', '', 'Audit'));
  for (const p of proposals) {
    const card = caseSourcesEl('div', 'case-proposal');
    card.dataset.proposalId = p.id;
    card.appendChild(caseSourcesEl('div', 'case-proposal-stmt', `${p.id}: ${p.stmt || ''}`));
    const value = p.value === null || p.value === undefined ? '—' : String(p.value);
    card.appendChild(caseSourcesEl('div', 'case-proposal-meta', `Value ${value}${p.unit ? ` ${p.unit}` : ''} · ${p.category || 'uncategorized'} · will be private · page ${p.anchor?.page ?? '?'}`));
    const quote = caseSourcesEl('div', 'case-proposal-quote');
    quote.appendChild(caseSourcesEl('mark', '', p.anchor?.quote || 'no quote'));
    card.appendChild(quote);
    for (const b of caseSourcesBadges(p)) card.appendChild(caseSourcesEl('span', 'case-proposal-badge', b));
    if (p.review) {
      const rv = p.review;
      card.appendChild(caseSourcesEl('div', 'case-proposal-meta', `${rv.action} by ${rv.by || 'unknown'}${rv.factId ? ` as ${rv.factId}` : ''}${rv.supersedes ? `, superseding ${rv.supersedes}` : ''}${rv.keepBoth ? ', kept both' : ''}${rv.reason ? ` (${rv.reason})` : ''}`));
      audit.appendChild(card);
      continue;
    }
    const actions = caseSourcesEl('div', 'case-source-actions');
    const conflicts = Array.isArray(p.checks?.conflicts) ? p.checks.conflicts : [];
    if (!conflicts.length) actions.appendChild(caseSourcesButton('Accept', () => act(p.id, { action: 'accept' }, 'accepted'), ctx.fail));
    // A conflict is shown, never resolved for the owner: every supersede
    // and every keep-both asks first.
    for (const x of conflicts) {
      actions.appendChild(caseSourcesButton(`Accept & supersede ${x.factId}`, async () => {
        if (!(await showConfirmDialog(caseSourcesSupersedeMessage(p, x, p.stmt || '', false)))) return;
        await act(p.id, { action: 'accept', supersedes: x.factId }, `accepted, superseding ${x.factId}`);
      }, ctx.fail));
    }
    if (conflicts.length && conflicts.every((x) => x.provenance !== 'user')) {
      actions.appendChild(caseSourcesButton('Keep both', async () => {
        if (!(await showConfirmDialog(caseSourcesKeepBothMessage(p, conflicts, p.stmt || '', false)))) return;
        await act(p.id, { action: 'accept', keepBoth: true }, 'accepted alongside the conflicting fact');
      }, ctx.fail));
    }
    const edit = caseSourcesEditForm(p, conflicts, act, ctx.say);
    actions.appendChild(caseSourcesButton('Edit', () => { edit.hidden = !edit.hidden; }));
    actions.appendChild(caseSourcesButton('Reject', () => act(p.id, { action: 'reject' }, 'rejected'), ctx.fail));
    card.append(actions, edit);
    container.appendChild(card);
  }
  const refused = Array.isArray(rec.refused) ? rec.refused : [];
  for (const r of refused) audit.appendChild(caseSourcesEl('div', 'case-proposal-refused', `Refused: ${r.stmt || ''} (${r.reason || 'no reason'})`));
  if (rec.refusedDropped) audit.appendChild(caseSourcesEl('div', 'case-proposal-refused', `${rec.refusedDropped} more refused proposals not shown.`));
  if (audit.childElementCount > 1) container.appendChild(audit);
}

/* --- Cases stage 2: status, budget and questions (docs/superpowers/specs/2026-09-23-cases-stage2-unattended.md §7) --- */

const CASE_STATUS_ACTIONS = [
  { status: 'paused', label: 'Pause', from: ['active'] },
  { status: 'active', label: 'Resume', from: ['paused'] },
  { status: 'done', label: 'Done', from: ['active', 'needs-direction', 'paused'], confirm: 'Mark this case done? It becomes read-only.' },
  { status: 'abandoned', label: 'Abandon', from: ['draft', 'active', 'needs-direction', 'paused'], confirm: 'Abandon this case? It becomes read-only and its wake-ups stop.' }
];
const CASE_BUDGET_CATEGORIES = ['usd', 'deadline', 'turnsPerDay', 'contactsPerDay', 'questionsPerDay'];

function caseButton(text, className = 'secondary-button') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  return button;
}

// F2 re-review: our own explicit refresh (with pendingMessage) is not the
// only render that can happen right after an answer/grant — the runtime's
// own case:changed notification (the same action triggers it) fires the
// onChanged listener below, which re-renders with no pendingMessage of its
// own and would otherwise win the race and wipe the message a second time.
// A short-lived, per-case message survives either render, whichever runs
// last, without the two call sites needing to coordinate.
const CASE_PANEL_MESSAGE_TTL_MS = 4000;
const casePanelMessages = new Map();
function setCasePanelMessage(caseId, message) {
  if (!caseId || !message) return;
  casePanelMessages.set(caseId, { message, expiresAt: Date.now() + CASE_PANEL_MESSAGE_TTL_MS });
}
function peekCasePanelMessage(caseId) {
  const entry = caseId ? casePanelMessages.get(caseId) : null;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { casePanelMessages.delete(caseId); return null; }
  return entry.message;
}

function renderCaseQuestionCard(q, { onDone, showError }) {
  const card = document.createElement('div');
  card.className = `case-question case-question-${q.urgency}`;
  card.dataset.questionId = q.id;
  const head = document.createElement('div');
  head.className = 'case-question-head';
  head.textContent = `${q.caseTitle ? `${q.caseTitle} · ` : ''}${q.kind === 'briefing' ? 'Briefing' : 'Question'} ${q.id}`;
  const text = document.createElement('div');
  text.className = 'case-question-text';
  text.textContent = q.text;
  card.append(head, text);

  // Notes the runtime attached to this question (e.g. why a reply had no
  // effect) — textContent only, never innerHTML (F2 re-review).
  if (Array.isArray(q.notes) && q.notes.length) {
    const notes = document.createElement('div');
    notes.className = 'case-question-notes';
    q.notes.forEach((note) => {
      const line = document.createElement('div');
      line.className = 'case-question-note';
      line.textContent = note?.text || '';
      notes.appendChild(line);
    });
    card.appendChild(notes);
  }

  if (q.kind === 'briefing') {
    const dismiss = caseButton('Dismiss', 'secondary-button case-question-dismiss');
    dismiss.addEventListener('click', async () => {
      const r = await window.electron.cases.acknowledgeBriefing({ caseId: q.caseId, questionId: q.id });
      if (!r?.ok) { showError(r?.error || 'Could not dismiss the briefing.'); return; }
      onDone();
    });
    card.appendChild(dismiss);
    return card;
  }

  const submit = async (answer) => {
    const r = await window.electron.cases.answerQuestion({ caseId: q.caseId, questionId: q.id, ...answer });
    if (!r?.ok) { showError(r?.error || 'Could not send the answer.'); return; }
    // The answer was recorded, but a rejected grant or direction has no
    // further effect (r.effect.applied === false): tell the owner why
    // instead of silently closing the card as if it worked (F2). onDone
    // rebuilds the container (renderCaseUnattendedSection clears it), so
    // the message must be set on the *new* container after that finishes,
    // never on this card's own (about-to-be-discarded) showError — setting
    // it first only for the rebuild to immediately wipe it (F2 re-review).
    const pendingMessage = (r.effect && r.effect.applied === false)
      ? (r.effect.note || r.effect.error || 'The answer had no effect.')
      : null;
    // Also stashed case-scoped (see setCasePanelMessage above): the
    // runtime's own case:changed notification for this same answer can
    // trigger another render with no pendingMessage of its own, shortly
    // after this one, which would otherwise wipe the message again.
    setCasePanelMessage(q.caseId, pendingMessage);
    await onDone(pendingMessage);
  };
  const actions = document.createElement('div');
  actions.className = 'case-question-actions';
  (q.options || []).forEach((option) => {
    const b = caseButton(option.label);
    b.dataset.optionId = option.id;
    b.addEventListener('click', () => submit({ optionId: option.id }));
    actions.appendChild(b);
  });
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-info-input case-question-input';
  input.placeholder = 'Answer…';
  const send = caseButton('Answer', 'secondary-button case-question-answer');
  send.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) { input.focus(); return; }
    submit({ text: value });
  });
  actions.append(input, send);
  card.appendChild(actions);
  return card;
}

function renderCaseBudgetLine(caseId, budget, { showError, refresh }) {
  const row = document.createElement('div');
  row.className = 'chat-info-row case-budget-row';
  const text = document.createElement('span');
  text.id = 'case-budget-text';
  const usd = budget.usd || {};
  const parts = [usd.limit ? `$${Number(usd.spent || 0).toFixed(2)} of $${usd.limit}` : `$${Number(usd.spent || 0).toFixed(2)} (no limit)`];
  if (budget.deadline?.at) parts.push(`deadline ${budget.deadline.at}`);
  if (budget.turnsPerDay?.limit) parts.push(`${budget.turnsPerDay.spent || 0}/${budget.turnsPerDay.limit} turns today`);
  if (budget.questionsPerDay?.limit) parts.push(`${budget.questionsPerDay.spent || 0}/${budget.questionsPerDay.limit} questions today`);
  text.textContent = `Budget: ${parts.join(' · ')}`;
  row.appendChild(text);
  if (Number(usd.unpricedTokens) > 0) {
    const warning = document.createElement('div');
    warning.className = 'case-budget-warning';
    warning.textContent = `${usd.unpricedTokens} tokens on providers with no price table are not counted against the $ budget.`;
    row.appendChild(warning);
  }
  const category = document.createElement('select');
  category.className = 'chat-info-select';
  category.id = 'case-grant-category';
  CASE_BUDGET_CATEGORIES.forEach((c) => {
    const option = document.createElement('option');
    option.value = c;
    option.textContent = c;
    category.appendChild(option);
  });
  const limit = document.createElement('input');
  limit.type = 'text';
  limit.className = 'chat-info-input';
  limit.id = 'case-grant-limit';
  limit.placeholder = 'New limit';
  const grant = caseButton('Grant');
  grant.id = 'case-grant-btn';
  grant.addEventListener('click', async () => {
    const raw = limit.value.trim();
    if (!raw) { limit.focus(); return; }
    const value = category.value === 'deadline' ? raw : Number(raw);
    const r = await window.electron.cases.grantBudget({ caseId, category: category.value, limit: value });
    if (!r?.ok) { showError(r?.error || 'Could not change the budget.'); return; }
    // Same ordering fix as the answer path above: set the message after
    // refresh rebuilds the container, on the new one, not the old
    // (about-to-be-discarded) showError (F2 re-review).
    const pendingMessage = (r.effect && r.effect.applied === false)
      ? (r.effect.note || r.effect.error || 'The grant had no effect.')
      : null;
    setCasePanelMessage(caseId, pendingMessage);
    await refresh(pendingMessage);
  });
  row.append(category, limit, grant);
  return row;
}

// Full mode fills the Chat Info case section; compact mode fills the bar
// above the composer with what needs the owner's attention.
// pendingMessage (F2 re-review): a message from an action that just
// completed (e.g. a rejected budget-grant reply) to show in *this*
// render's error slot — set before the compact-mode hidden check and
// before the full-mode append, so it survives the rebuild that would
// otherwise wipe a message set on the previous (discarded) container.
async function renderCaseUnattendedSection(chat, container, { compact = false, pendingMessage = null } = {}) {
  if (!container) return;
  if (!chat?.caseId || !window.electron?.cases?.questions) {
    container.innerHTML = '';
    if (compact) container.hidden = true;
    return;
  }
  const listed = await window.electron.cases.questions({ caseId: chat.caseId });
  const questions = listed?.ok ? listed.questions : [];
  container.innerHTML = '';
  const error = document.createElement('div');
  error.className = 'chat-case-error case-unattended-error';
  const showError = (message) => { error.textContent = message || ''; };
  if (!listed?.ok) showError(listed?.error || 'Could not load the case questions.');
  else {
    const carried = pendingMessage || peekCasePanelMessage(chat.caseId);
    if (carried) showError(carried);
  }

  if (compact) {
    const shown = questions.filter((q) => (q.kind !== 'briefing' && q.urgency !== 'low') || (q.kind === 'briefing' && q.urgency === 'high'));
    shown.forEach((q) => container.appendChild(renderCaseQuestionCard(q, { onDone: (msg) => refreshCaseQuestionsBar(msg), showError })));
    container.appendChild(error);
    container.hidden = shown.length === 0 && !error.textContent;
    return;
  }

  const refresh = (msg) => Promise.all([
    renderCaseUnattendedSection(chat, container, { compact: false, pendingMessage: msg }).catch((err) => chatLog.warn(`Case panel failed: ${err.message}`)),
    refreshCaseQuestionsBar()
  ]);
  const budget = await window.electron.cases.budget({ caseId: chat.caseId });
  if (budget?.ok) {
    const info = budget.case;
    const statusRow = document.createElement('div');
    statusRow.className = 'chat-info-row case-status-row';
    const statusText = document.createElement('span');
    statusText.id = 'case-status-text';
    const reason = info.statusReason
      ? ` (${info.statusReason.kind}${info.statusReason.note ? `: ${info.statusReason.note}` : ''})`
      : '';
    statusText.textContent = `Status: ${info.status}${reason}`;
    statusRow.appendChild(statusText);
    CASE_STATUS_ACTIONS.filter((a) => a.from.includes(info.status)).forEach((action) => {
      const b = caseButton(action.label);
      b.id = `case-status-${action.status}`;
      b.addEventListener('click', async () => {
        if (action.confirm && !(await showConfirmDialog(action.confirm))) return;
        const r = await window.electron.cases.setStatus({ caseId: chat.caseId, status: action.status });
        if (!r?.ok) { showError(r?.error || 'Could not change the status.'); return; }
        refresh();
      });
      statusRow.appendChild(b);
    });
    container.append(statusRow, renderCaseBudgetLine(chat.caseId, budget.budget, { showError, refresh }));
  } else {
    showError(budget?.error || 'Could not load the case budget.');
  }

  const list = document.createElement('div');
  list.className = 'case-question-list';
  list.id = 'case-question-list';
  if (!questions.length) {
    const none = document.createElement('div');
    none.className = 'case-question-none';
    none.textContent = 'No open questions.';
    list.appendChild(none);
  }
  questions.forEach((q) => list.appendChild(renderCaseQuestionCard(q, { onDone: refresh, showError })));
  container.append(list, error);
}

function ensureCaseQuestionsBar() {
  let bar = document.getElementById('case-questions-bar');
  if (bar) return bar;
  const input = document.getElementById('input-container');
  if (!input || !input.parentNode) return null;
  bar = document.createElement('div');
  bar.id = 'case-questions-bar';
  bar.className = 'case-questions-bar';
  bar.hidden = true;
  input.parentNode.insertBefore(bar, input);
  return bar;
}

function refreshCaseQuestionsBar(pendingMessage) {
  const bar = ensureCaseQuestionsBar();
  if (!bar) return Promise.resolve();
  return renderCaseUnattendedSection(getActiveChat(), bar, { compact: true, pendingMessage })
    .catch((err) => chatLog.warn(`Case questions bar failed: ${err.message}`));
}

if (window.electron?.cases?.onChanged) {
  window.electron.cases.onChanged((payload) => {
    if (payload?.what === 'turn' && payload.caseId) {
      if (payload.running) appState.runningCaseTurns.add(payload.caseId);
      else appState.runningCaseTurns.delete(payload.caseId);
      refreshStopButton();
      return;
    }
    const chat = getActiveChat();
    if (!chat?.caseId || (payload?.caseId && payload.caseId !== chat.caseId)) return;
    refreshCaseQuestionsBar();
    const slot = document.getElementById('case-unattended-section');
    if (slot) renderCaseUnattendedSection(chat, slot, { compact: false }).catch((err) => chatLog.warn(`Case panel failed: ${err.message}`));
    const detourSlot = document.getElementById('case-detours-section');
    if (detourSlot) renderCaseDetoursSection(chat, detourSlot).catch((err) => chatLog.warn(`Detours panel failed: ${err.message}`));
  });
}

/* --- Cases stage 5: detours and related cases (docs/superpowers/specs/2026-09-23-cases-stage5-detours.md §7) --- */

const CASE_DETOUR_OPEN = ['proposed', 'held', 'awaiting-mapping'];

function renderCaseDetourCard(chat, d, { refresh, showError }) {
  const card = document.createElement('div');
  card.id = `case-detour-${d.id}`;
  card.className = `case-detour${d.blocks ? ' case-detour-blocker' : ''}`;
  card.dataset.detourId = d.id;
  const text = document.createElement('div');
  text.className = 'case-detour-text';
  text.textContent = `${d.blocks ? 'Blocker: ' : ''}${d.summary}${d.reason ? ` — ${d.reason}` : ''}`;
  card.appendChild(text);
  if (d.status !== 'proposed') {
    const state = document.createElement('div');
    state.className = 'case-detour-state';
    state.textContent = d.status === 'held'
      ? "Waiting: today's question allowance is spent."
      : 'You answered in words; the case maps it to an option on its next turn. You can also pick one here.';
    card.appendChild(state);
  }
  const actions = document.createElement('div');
  actions.className = 'case-detour-actions';
  for (const o of d.options) {
    const button = caseButton(o.label, o.optionId === 'decline' ? 'secondary-button case-detour-drop' : 'secondary-button');
    button.id = `case-detour-${d.id}-${o.optionId}`;
    button.addEventListener('click', async () => {
      showError('');
      const payload = { caseId: chat.caseId, detourId: d.id, optionId: o.optionId };
      let result = await window.electron.cases.resolveDetour(payload);
      if (!result?.ok && o.optionId === 'new' && result?.code === 'SIMILAR_CASES'
        && await showConfirmDialog(`${result.error} Create the new case anyway?`)) {
        result = await window.electron.cases.resolveDetour({ ...payload, force: true });
      }
      if (!result?.ok) showError(result?.error || 'Could not route the detour.');
      await refresh();
    });
    actions.appendChild(button);
  }
  card.appendChild(actions);
  return card;
}

function relatedCaseLine(r) {
  const li = document.createElement('li');
  li.className = 'case-related-item';
  if (r.gone) {
    li.textContent = `${r.relation}: (case ${r.caseId} no longer exists)`;
  } else {
    const stillBlocks = r.relation === 'blocked-by' && r.status === 'done' ? ' (done — check whether it still blocks)' : '';
    li.textContent = `${r.relation}: ${r.title} (${r.status})${stillBlocks}`;
  }
  return li;
}

async function renderCaseDetoursSection(chat, container) {
  const error = document.createElement('div');
  error.className = 'chat-case-error';
  const showError = (message) => { error.textContent = message || ''; };
  const refresh = async () => {
    await renderCaseDetoursSection(chat, container);
    refreshCaseQuestionsBar();
  };
  const result = await window.electron.cases.detours({ caseId: chat.caseId });
  container.innerHTML = '';
  if (!result?.ok) {
    showError(`Could not load detours: ${result?.error || 'unknown error'}`);
    container.appendChild(error);
    return;
  }
  const open = result.detours.filter((d) => CASE_DETOUR_OPEN.includes(d.status));
  if (!open.length && !result.related.length) return;
  const heading = document.createElement('div');
  heading.className = 'case-detours-heading';
  heading.textContent = 'Detours and related cases';
  container.appendChild(heading);
  if (result.busy) {
    const busy = document.createElement('div');
    busy.className = 'case-detour-state';
    busy.textContent = 'The case is busy with a turn; routing answers are applied when it finishes.';
    container.appendChild(busy);
  }
  for (const d of open) container.appendChild(renderCaseDetourCard(chat, d, { refresh, showError }));
  if (result.related.length) {
    const list = document.createElement('ul');
    list.id = 'case-related-list';
    list.className = 'case-related-list';
    for (const r of result.related) list.appendChild(relatedCaseLine(r));
    container.appendChild(list);
  }
  container.appendChild(error);
}

/* --- Cases stage 6: playbooks (docs/superpowers/specs/2026-09-23-cases-stage6-playbooks.md §3.12) --- */

// Every string from a case or a playbook (and every reply flagged
// untrustedText) can quote package text: it is set with textContent only,
// never innerHTML or markdown, and clipped for display.
const PLAYBOOK_TEXT_MAX = 600;
const PLAYBOOK_PATCH_MAX = 200000;

function playbookClip(value, max = PLAYBOOK_TEXT_MAX) {
  const s = typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function playbookEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = playbookClip(text);
  return el;
}

function playbookButton(id, text, onClick) {
  const b = playbookEl('button', 'secondary-button playbook-button', text);
  b.type = 'button';
  if (id) b.id = id;
  b.addEventListener('click', onClick);
  return b;
}

// The create-form picker: example checkboxes, one free source with an
// optional ref, and the owner's consent to higher budget limits.
function buildPlaybookPicker(container) {
  const wrap = playbookEl('div', 'playbook-picker');
  wrap.id = 'chat-case-playbook-picker';
  const examples = playbookEl('div', 'playbook-example-list');
  const source = playbookEl('input', 'chat-info-input');
  source.type = 'text';
  source.id = 'chat-case-playbook-source';
  source.placeholder = 'Playbook folder or https/ssh git URL (optional)';
  const ref = playbookEl('input', 'chat-info-input');
  ref.type = 'text';
  ref.id = 'chat-case-playbook-ref';
  ref.placeholder = 'Branch or tag (optional)';
  const acceptRow = playbookEl('label', 'playbook-accept');
  const accept = document.createElement('input');
  accept.type = 'checkbox';
  accept.id = 'chat-case-playbook-accept-budget';
  acceptRow.append(accept, document.createTextNode(' Allow these playbooks to raise budget limits'));
  wrap.append(playbookEl('div', 'playbook-label', 'Playbooks'), examples, source, ref, acceptRow);
  container.appendChild(wrap);
  window.electron.cases.listExamplePlaybooks()
    .then((r) => {
      for (const e of (r?.ok ? r.examples : [])) {
        const row = playbookEl('label', 'playbook-example');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = `chat-case-playbook-example-${e.name}`;
        box.value = `example:${e.name}`;
        row.append(box, document.createTextNode(playbookClip(` ${e.title || e.name} (${e.name}@${e.version}, ${e.caseType})`, 300)));
        examples.appendChild(row);
      }
    })
    .catch((err) => chatLog.warn(`Example playbooks failed: ${err.message}`));
  return {
    fields() {
      const playbooks = [...examples.querySelectorAll('input[type="checkbox"]:checked')].map((b) => ({ source: b.value }));
      if (source.value.trim()) playbooks.push({ source: source.value.trim(), ...(ref.value.trim() ? { ref: ref.value.trim() } : {}) });
      return playbooks.length ? { playbooks, acceptBudgetRaises: accept.checked } : {};
    }
  };
}

// message: a status line to keep across the re-render (an action's result).
async function renderPlaybooksSection(chat, container, { message = '' } = {}) {
  container.innerHTML = '';
  const caseId = chat.caseId;
  const refresh = (next = '') => renderPlaybooksSection(chat, container, { message: next }).catch((err) => chatLog.warn(`Playbooks panel failed: ${err.message}`));
  const status = playbookEl('div', 'playbook-status');
  status.id = 'case-playbooks-status';
  const say = (text) => { status.textContent = playbookClip(text || '', 2000); };
  say(message);
  container.appendChild(playbookEl('div', 'playbook-heading', 'Playbooks'));

  const listed = await window.electron.cases.playbooks({ caseId });
  if (!listed?.ok) {
    say(listed?.error || 'Could not load the playbooks.');
    container.appendChild(status);
    return;
  }

  // Each row has a slot for a "Confirm source" action. A recorded local
  // folder that no allowlist entry covers (SOURCE_NEEDS_CONFIRM) is read only
  // after the owner confirms that one playbook, and the re-sent call names
  // it. SOURCE_IS_LINK is an error only: there is nothing to confirm.
  const confirmSlots = new Map();
  const offerConfirm = (name, retry) => {
    const slot = confirmSlots.get(name);
    if (!slot) return;
    slot.replaceChildren(playbookButton(null, 'Confirm source', async () => {
      if (!(await showConfirmDialog(`Read the recorded folder of playbook ${name}? No allowed-folder entry covers it. Confirm only if you trust that folder.`))) return;
      slot.replaceChildren();
      await retry();
    }));
  };

  const runUpdate = async (name, { force = false, confirmSource = false } = {}) => {
    const r = await window.electron.cases.updatePlaybook({ caseId, name, ...(force ? { force: true } : {}), ...(confirmSource ? { confirmSource: true } : {}) });
    if (!r?.ok && !force && Array.isArray(r?.editedFiles) && r.editedFiles.length) {
      if (!(await showConfirmDialog(`${playbookClip(r.error)} Overwrite them?`))) return;
      await runUpdate(name, { force: true, confirmSource });
      return;
    }
    if (!r?.ok) {
      say(r?.error || 'Could not update the playbook.');
      if (r?.code === 'SOURCE_NEEDS_CONFIRM' && !confirmSource) offerConfirm(name, () => runUpdate(name, { force, confirmSource: true }));
      return;
    }
    refresh(r.from === r.to ? `${name} is up to date.` : `${name} updated from ${r.from} to ${r.to}. The next turn re-orients.`);
  };

  const updateLine = (u) => {
    if (u.error) return `${u.name}: ${u.error}`;
    if (u.applyError) return `${u.name}: ${u.upstream} available; applying it failed: ${u.applyError}`;
    if (u.applied) return `${u.name}: updated to ${u.applied}`;
    return `${u.name}: ${u.updateAvailable ? `${u.upstream} available${u.sameMajor ? '' : ' (new major version)'}` : 'up to date'}`;
  };

  // name: a confirmed re-check of that one playbook; null checks them all.
  const runCheck = async (name = null) => {
    const r = await window.electron.cases.checkPlaybookUpdates({ caseId, ...(name ? { name, confirmSource: true } : {}) });
    if (!r?.ok) { say(r?.error || 'Could not check for updates.'); return; }
    const summary = r.updates.map(updateLine).join('; ') || 'No playbooks to check.';
    if (r.updates.some((u) => u.applied)) { refresh(summary); return; }
    say(summary);
    if (!name) {
      for (const u of r.updates) {
        if (u.code === 'SOURCE_NEEDS_CONFIRM') offerConfirm(u.name, () => runCheck(u.name));
      }
    }
  };

  const list = playbookEl('div', 'playbook-list');
  list.id = 'case-playbook-list';
  for (const p of listed.playbooks) {
    const state = /^[a-z-]{1,32}$/.test(p.state || '') ? p.state : 'unknown';
    const row = playbookEl('div', `playbook-row playbook-state-${state}`);
    row.dataset.playbook = p.name;
    row.appendChild(playbookEl('span', 'playbook-name', `${p.name}@${p.version || '?'} (${p.mode}, ${p.state})`));
    for (const w of [...(p.reason ? [p.reason] : []), ...(p.warnings || [])]) row.appendChild(playbookEl('div', 'playbook-warning', w));
    const actions = playbookEl('div', 'playbook-actions');
    if (p.state === 'unregistered') {
      actions.appendChild(playbookButton(null, 'Adopt', async () => {
        const r = await window.electron.cases.addPlaybook({ caseId, adopt: p.name });
        if (!r?.ok) { say(r?.error || 'Could not adopt the playbook.'); return; }
        refresh();
      }));
    } else if (p.mode === 'vendored') {
      actions.appendChild(playbookButton(null, 'Update', () => runUpdate(p.name)));
    }
    if (p.mode === 'vendored') {
      actions.appendChild(playbookButton(null, 'Remove', async () => {
        if (!(await showConfirmDialog(`Remove playbook ${p.name} from this case? Questions it asked and defaults it set stay.`))) return;
        const r = await window.electron.cases.removePlaybook({ caseId, name: p.name });
        if (!r?.ok) { say(r?.error || 'Could not remove the playbook.'); return; }
        refresh();
      }));
    }
    const slot = playbookEl('span', 'playbook-confirm');
    confirmSlots.set(p.name, slot);
    actions.appendChild(slot);
    row.appendChild(actions);
    list.appendChild(row);
  }
  if (!listed.playbooks.length) list.appendChild(playbookEl('div', 'playbook-empty', 'No playbooks attached.'));
  container.appendChild(list);

  if (listed.pendingGating.length) {
    const pending = playbookEl('div', 'playbook-pending', `Waiting for your answers: ${listed.pendingGating.map((g) => g.recordId || g.key).join(', ')}`);
    pending.id = 'case-playbook-pending';
    container.appendChild(pending);
  }

  // One row and one Accept per playbook: accepting applies every raise that
  // playbook offers, so the row and the dialog name each of them.
  const raisesBy = new Map();
  for (const raise of listed.budgetRaises || []) {
    if (!raisesBy.has(raise.playbook)) raisesBy.set(raise.playbook, []);
    raisesBy.get(raise.playbook).push(`${raise.key} ${raise.from} → ${raise.to}`);
  }
  for (const [playbook, changes] of raisesBy) {
    const row = playbookEl('div', 'playbook-raise');
    row.dataset.playbook = playbook;
    row.appendChild(playbookEl('span', null, `${playbook} suggests higher limits: ${changes.join(', ')}. `));
    row.appendChild(playbookButton(null, 'Accept', async () => {
      if (!(await showConfirmDialog(playbookClip(`Raise these limits for this case, as ${playbook} suggests: ${changes.join(', ')}?`, 2000)))) return;
      const r = await window.electron.cases.acceptPlaybookBudget({ caseId, name: playbook });
      if (!r?.ok) { say(r?.error || 'Could not change the budget.'); return; }
      refresh();
    }));
    container.appendChild(row);
  }

  const add = playbookEl('div', 'playbook-add');
  const source = playbookEl('input', 'chat-info-input');
  source.type = 'text';
  source.id = 'case-playbook-add-source';
  source.placeholder = 'example:<name>, a folder, or an https/ssh git URL';
  const ref = playbookEl('input', 'chat-info-input');
  ref.type = 'text';
  ref.id = 'case-playbook-add-ref';
  ref.placeholder = 'Branch or tag (optional)';
  add.append(source, ref, playbookButton('case-playbook-add-btn', 'Add playbook', async () => {
    if (!source.value.trim()) { say('Give a playbook source.'); return; }
    const r = await window.electron.cases.addPlaybook({ caseId, source: source.value.trim(), ...(ref.value.trim() ? { ref: ref.value.trim() } : {}) });
    if (!r?.ok) { say(r?.error || 'Could not add the playbook.'); return; }
    refresh();
  }), playbookButton('case-playbook-check-btn', 'Check for updates', () => runCheck()));
  container.appendChild(add);

  const proposals = await window.electron.cases.playbookProposals({ caseId });
  if (proposals?.ok && proposals.proposals.length) {
    const box = playbookEl('div', 'playbook-proposals');
    box.id = 'case-playbook-proposals';
    box.appendChild(playbookEl('div', 'playbook-heading', 'Proposals'));
    for (const pr of proposals.proposals) {
      const row = playbookEl('div', 'playbook-proposal');
      row.dataset.proposal = pr.id;
      row.appendChild(playbookEl('div', null, `${pr.id}: ${pr.newPlaybook ? 'new playbook' : 'change to'} ${pr.playbook} (${pr.status}${pr.stale ? ', stale' : ''}) — ${pr.rationale}`));
      if (pr.hint) row.appendChild(playbookEl('div', 'playbook-warning', pr.hint));
      const patch = playbookEl('pre', 'playbook-patch');
      patch.hidden = true;
      row.appendChild(playbookButton(null, 'View patch', async () => {
        const r = await window.electron.cases.playbookProposals({ caseId, proposalId: pr.id });
        if (!r?.ok) { say(r?.error || 'Could not read the patch.'); return; }
        patch.textContent = playbookClip(r.patch, PLAYBOOK_PATCH_MAX);
        patch.hidden = !patch.hidden;
      }));
      if (pr.status === 'proposed') {
        const repo = playbookEl('input', 'chat-info-input');
        repo.type = 'text';
        repo.placeholder = "Path to the playbook's own repository";
        row.append(repo, playbookButton(null, 'Apply to repo…', async () => {
          if (!repo.value.trim()) { say('Give the path of the playbook repository.'); return; }
          const r = await window.electron.cases.applyPlaybookProposal({ caseId, proposalId: pr.id, repoPath: repo.value.trim() });
          if (!r?.ok) { say(r?.error || 'Could not apply the proposal.'); return; }
          refresh(`Applied ${pr.id} to ${r.appliedTo}; review and commit it there.`);
        }), playbookButton(null, 'Reject', async () => {
          const r = await window.electron.cases.rejectPlaybookProposal({ caseId, proposalId: pr.id });
          if (!r?.ok) { say(r?.error || 'Could not reject the proposal.'); return; }
          refresh();
        }));
      }
      row.appendChild(patch);
      box.appendChild(row);
    }
    container.appendChild(box);
  }
  container.appendChild(status);
}

function renderChatInfoPopover() {
  if (!dom.chatInfoPopoverBody) return;
  const chat = getActiveChat();
  dom.chatInfoPopoverBody.innerHTML = '';

  if (!chat) {
    dom.chatInfoPopoverBody.textContent = 'No active chat.';
    return;
  }

  const totals = chat.llmTotals || sumChatLlmTotals(chat);
  const loadedMessages = Array.isArray(chat.messages) ? chat.messages : [];
  const messageCount = chat.messageCount || loadedMessages.length || 0;
  const userMessages = loadedMessages.filter((m) => m.sender === 'user').length || chat.userMessageCount || 0;
  const assistantMessages = loadedMessages.filter((m) => m.sender === 'assistant').length || chat.assistantMessageCount || 0;
  const memoryCount = appState.memoryEntries?.length || 0;

  const rows = [
    { section: 'Messages' },
    { icon: 'fas fa-comments', label: 'Total messages', value: String(messageCount) },
    { icon: 'fas fa-user', label: 'User', value: String(userMessages) },
    { icon: 'fas fa-robot', label: 'Assistant', value: String(assistantMessages) },
    { divider: true },
    { section: 'Token Usage' },
    { icon: 'fas fa-arrow-up', label: 'Input tokens', value: formatTokenCount(totals.inputTokens) },
    { icon: 'fas fa-arrow-down', label: 'Output tokens', value: formatTokenCount(totals.outputTokens) },
    { icon: 'fas fa-sigma', label: 'Total tokens', value: formatTokenCount(totals.totalTokens) },
    { icon: 'fas fa-dollar-sign', label: 'Estimated cost', value: formatUsd(totals.costUsd) },
    { divider: true },
    { section: 'Memory' },
    { icon: 'fas fa-brain', label: 'Memory entries', value: String(memoryCount) },
  ];

  const appendRow = (row) => {
    if (row.divider) {
      const hr = document.createElement('hr');
      hr.className = 'chat-info-divider';
      dom.chatInfoPopoverBody.appendChild(hr);
      return;
    }
    if (row.section) {
      const title = document.createElement('div');
      title.className = 'chat-info-section-title';
      title.textContent = row.section;
      dom.chatInfoPopoverBody.appendChild(title);
      return;
    }
    const el = document.createElement('div');
    el.className = 'chat-info-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'chat-info-label';
    if (row.icon) {
      labelEl.appendChild(faIcon(row.icon));
    }
    labelEl.appendChild(document.createTextNode(row.label));

    const valueEl = document.createElement('span');
    valueEl.className = 'chat-info-value';
    valueEl.textContent = row.value;

    el.appendChild(labelEl);
    el.appendChild(valueEl);
    dom.chatInfoPopoverBody.appendChild(el);
  };

  rows.forEach(appendRow);

  /* --- Case section (filled asynchronously into a fixed slot) --- */
  appendRow({ divider: true });
  appendRow({ section: 'Case' });
  const caseSlot = document.createElement('div');
  caseSlot.id = 'chat-case-section';
  dom.chatInfoPopoverBody.appendChild(caseSlot);
  renderChatCaseSection(chat, caseSlot).catch((err) => chatLog.warn(`Case section failed: ${err.message}`));

  /* --- Mode section. The model controls live in the chat header now
     (spec 2026-09-27 §11): a profile picker and the main switcher. --- */
  appendRow({ divider: true });
  appendRow({ section: 'Mode' });

  // Agent mode toggle row
  const agentRow = document.createElement('div');
  agentRow.className = 'chat-info-row';
  const agentLabel = document.createElement('span');
  agentLabel.className = 'chat-info-label';
  agentLabel.appendChild(faIcon('fas fa-wand-magic-sparkles'));
  agentLabel.appendChild(document.createTextNode('Agent mode'));
  const agentToggle = document.createElement('label');
  agentToggle.className = 'chat-info-toggle';
  const agentCheckbox = document.createElement('input');
  agentCheckbox.type = 'checkbox';
  agentCheckbox.checked = appState.isAgentModeEnabled;
  agentCheckbox.addEventListener('change', () => {
    appState.isAgentModeEnabled = agentCheckbox.checked;
    persistAgentMode();
    renderAgentModeButton();
    addStatusMessage(`Agent mode: ${appState.isAgentModeEnabled ? 'on' : 'off'}`);
  });
  const agentSlider = document.createElement('span');
  agentSlider.className = 'chat-info-toggle-slider';
  agentToggle.appendChild(agentCheckbox);
  agentToggle.appendChild(agentSlider);
  agentRow.appendChild(agentLabel);
  agentRow.appendChild(agentToggle);
  dom.chatInfoPopoverBody.appendChild(agentRow);

  // Sandbox mode toggle row
  const sandboxRow = document.createElement('div');
  sandboxRow.className = 'chat-info-row';
  const sandboxLabel = document.createElement('span');
  sandboxLabel.className = 'chat-info-label';
  sandboxLabel.appendChild(faIcon('fas fa-shield-halved'));
  sandboxLabel.appendChild(document.createTextNode('Sandbox mode'));
  const sandboxToggle = document.createElement('label');
  sandboxToggle.className = 'chat-info-toggle';
  const sandboxCheckbox = document.createElement('input');
  sandboxCheckbox.type = 'checkbox';
  sandboxCheckbox.checked = appState.isSandboxModeEnabled;
  sandboxCheckbox.addEventListener('change', () => {
    appState.isSandboxModeEnabled = sandboxCheckbox.checked;
    persistSandboxMode();
    addStatusMessage(`Sandbox mode: ${appState.isSandboxModeEnabled ? 'on' : 'off'}`);
  });
  const sandboxSlider = document.createElement('span');
  sandboxSlider.className = 'chat-info-toggle-slider';
  sandboxToggle.appendChild(sandboxCheckbox);
  sandboxToggle.appendChild(sandboxSlider);
  sandboxRow.appendChild(sandboxLabel);
  sandboxRow.appendChild(sandboxToggle);
  dom.chatInfoPopoverBody.appendChild(sandboxRow);
}

function toggleChatInfoPopover() {
  if (!dom.chatInfoPopover) return;
  const isOpen = !dom.chatInfoPopover.hidden;
  if (isOpen) {
    dom.chatInfoPopover.hidden = true;
  } else {
    renderChatInfoPopover();
    dom.chatInfoPopover.hidden = false;
  }
}

function updateEmptyState() {
  const hasChats = appState.chats.length > 0;
  const hasActiveChat = !!appState.activeChatId;
  const showEmpty = !hasChats || !hasActiveChat;

  dom.emptyState.hidden = !showEmpty;
  dom.chatMessages.hidden = showEmpty;
  dom.mainContent.classList.toggle('start-state', showEmpty);
  dom.container.classList.toggle('start-state', showEmpty);
}

function renderChatMessages() {
  const activeChat = getActiveChat();
  dom.chatMessages.innerHTML = '';
  if (dom.chatInfoPopover) dom.chatInfoPopover.hidden = true;

  // Clear any pending tool group buffer
  toolGroupBuffer.items = [];
  toolGroupBuffer.element = null;
  if (toolGroupBuffer.timeout) {
    clearTimeout(toolGroupBuffer.timeout);
    toolGroupBuffer.timeout = null;
  }

  if (!activeChat) {
    dom.chatHeaderTitle.textContent = 'King Louie Chat';
    dom.chatHeaderMeta.textContent = 'Start a new conversation';
    if (dom.chatModelsSwitcher) dom.chatModelsSwitcher.hidden = true;
    if (dom.workingDirLabel) dom.workingDirLabel.textContent = 'No working directory';
    if (dom.workingDirBtn) dom.workingDirBtn.classList.remove('is-set');
    return;
  }

  if (!Array.isArray(activeChat.messages)) {
    dom.chatHeaderTitle.textContent = activeChat.title || 'King Louie Chat';
    dom.chatHeaderMeta.textContent = 'Loading chat history…';
    const loading = document.createElement('div');
    loading.className = 'status-message';
    loading.textContent = 'Loading chat history…';
    dom.chatMessages.appendChild(loading);
    return;
  }

  dom.chatHeaderTitle.textContent = activeChat.title;
  const chatTotals = activeChat.llmTotals || sumChatLlmTotals(activeChat);
  dom.chatHeaderMeta.textContent = `Updated ${formatTimestamp(activeChat.updatedAt)} • Total ${formatTokenCount(chatTotals.totalTokens)} tokens • ${formatUsd(chatTotals.costUsd)}`;
  if (dom.workingDirBtn) {
    dom.workingDirBtn.title = activeChat.workingDirectory ? `Working directory: ${activeChat.workingDirectory}\nClick to change` : 'Click to set working directory';
    dom.workingDirBtn.classList.toggle('is-set', Boolean(activeChat.workingDirectory));
  }
  if (dom.workingDirLabel) {
    if (activeChat.workingDirectory) {
      // Show just the last 1-2 path segments inline; full path lives in the
      // tooltip. This keeps the header readable even for deep nested projects.
      const parts = activeChat.workingDirectory.split(/[\\/]/).filter(Boolean);
      const shortLabel = parts.length > 2
        ? `…${parts.slice(-2).join('/')}`
        : parts.join('/');
      dom.workingDirLabel.textContent = shortLabel;
    } else {
      dom.workingDirLabel.textContent = 'No working directory';
    }
  }

  let runningTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };

  activeChat.messages.forEach((message) => {
    if (message.sender === 'status') {
      addToolEventCompact('Status', { message: message.text }, 'info', false);
      return;
    }
    if (message.sender === 'toolUse') {
      addToolEventCompact(message.toolName, message.parameters, '', false);
      return;
    }
    if (message.sender === 'toolResult') {
      const isError = message.result?.success === false || message.result?.ok === false;
      addToolEventCompact(message.toolName, message.result, isError ? 'error' : 'success', true);
      return;
    }

    const callTotals = message?.llm?.totals || null;
    if (callTotals) {
      runningTotals = {
        inputTokens: runningTotals.inputTokens + (Number(callTotals.inputTokens) || 0),
        outputTokens: runningTotals.outputTokens + (Number(callTotals.outputTokens) || 0),
        totalTokens: runningTotals.totalTokens + (Number(callTotals.totalTokens) || 0),
        costUsd: Number((runningTotals.costUsd + (Number(callTotals.costUsd) || 0)).toFixed(8))
      };
    }

    // For assistant messages, extract any XML tool blocks and render as pills
    let displayText = message.text;
    if (message.sender === 'assistant' && displayText) {
      const { cleanText, toolBlocks } = extractXmlToolBlocks(displayText);
      for (const block of toolBlocks) {
        addToolEventCompact(block.toolName, xmlToolBlockToParams(block.toolName, block.content), 'success', false);
      }
      displayText = cleanText;
      if (!displayText && !message.stopped) return; // message was entirely tool blocks
    }

    addMessage(message.sender, displayText, {
      llm: message?.llm,
      stopped: message?.stopped,
      runningLlmTotals: callTotals ? { ...runningTotals } : null,
      format: message?.format,
      images: message?.images,
      documents: message?.documents,
      context: message?.context,
      seq: message?.seq,
      chatId: activeChat.id
    });
  });

  // Flush any remaining buffered tool group from the rendering pass
  flushToolGroup();

  renderRetryControl();
  refreshChatModels();
}

function refreshUI() {
  dropInactiveChatMessages(appState.chats, appState.activeChatId);
  renderChatList();
  renderChatMessages();
  updateEmptyState();
}

function setSettingsDrawer(open) {
  dom.settingsDrawer.hidden = !open;
  document.body.style.overflow = open ? 'hidden' : '';
  // The History and recall status poll runs only while its pane is visible.
  if (!open && typeof stopHistoryStatusPoll === 'function') stopHistoryStatusPoll();
}

function switchSettingsTab(tabName) {
  if (!dom.settingsNavSelect) return;
  dom.settingsNavSelect.value = tabName;
  dom.settingsDrawer.querySelectorAll('.settings-tab-content').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.tab === tabName);
  });
  // Refused senders accumulate while the drawer is closed, so re-read them
  // every time the pane is opened rather than only at settings load.
  if (tabName === 'channels' && typeof loadChannelAccess === 'function') {
    loadChannelAccess().catch(() => {});
  }
  if (tabName === 'service' && typeof renderServiceSection === 'function') {
    renderServiceSection().catch((err) => serviceLog.warn('rendering the local service pane failed', { error: err && err.message }));
  }
  // Usability changes with every key test; re-read it whenever the tab opens.
  if (tabName === 'models' && typeof loadModelProfiles === 'function') {
    loadModelProfiles().catch((err) => settingsLog.warn(`loading model profiles failed: ${err.message}`));
    loadKingLouie().catch((err) => settingsLog.warn(`loading the King Louie profile failed: ${err.message}`));
  }
  // History and recall: its status is read while the pane is open.
  if (tabName === 'history' && typeof loadHistorySettings === 'function') {
    loadHistorySettings().catch((err) => settingsLog.warn(`loading history settings failed: ${err.message}`));
  } else if (typeof stopHistoryStatusPoll === 'function') {
    stopHistoryStatusPoll();
  }
}

function sortSettingsNavOptions() {
  if (!dom.settingsNavSelect) return;

  const currentValue = dom.settingsNavSelect.value;
  const options = Array.from(dom.settingsNavSelect.options);
  options.sort((a, b) =>
    String(a.textContent || '').localeCompare(String(b.textContent || ''), undefined, {
      sensitivity: 'base'
    })
  );

  dom.settingsNavSelect.innerHTML = '';
  options.forEach((option) => dom.settingsNavSelect.appendChild(option));

  if (currentValue) {
    dom.settingsNavSelect.value = currentValue;
  }
}

// History and recall (recall spec §14): the embedder choice and its status.
// Everything shown comes from the host and is set with textContent.
let historyStatusTimer = null;

// The local embedder is unpriced and says so; a hosted one shows the tokens
// it has embedded this session (a count only: prices come from the catalog).
function historyEmbedderStatusText(status, progress) {
  const s = status || {};
  const pct = (a, b) => (b > 0 ? Math.min(100, Math.floor((a / b) * 100)) : 0);
  const cost = s.kind === 'local'
    ? ' Runs on this computer, no API cost.'
    : (s.kind === 'openai' || s.kind === 'ollama' ? ` ${Number(s.tokens) || 0} tokens embedded this session.` : '');
  switch (s.state) {
    case 'off': return 'Off: recall uses keyword search only.';
    case 'starting': return `Loading the embedding model…${cost}`;
    case 'downloading': return (s.download && s.download.total > 0
      ? `Downloading the embedding model: ${pct(s.download.loaded, s.download.total)}%`
      : 'Downloading the embedding model…') + cost;
    case 'ready': {
      const embedded = Number(progress?.embedded) || 0;
      const pending = Number(progress?.pending) || 0;
      return (pending > 0
        ? `Ready. Embedding the history: ${pct(embedded, embedded + pending)}% (${pending} chunks to go)`
        : 'Ready. All history is embedded.') + cost;
    }
    case 'unavailable': return `Not available, keyword search only: ${s.error || 'unknown error'}`;
    case 'disabled': return `Stopped for this session, keyword search only: ${s.error || 'the embedding worker kept crashing'}`;
    default: return '';
  }
}

function stopHistoryStatusPoll() {
  if (historyStatusTimer) clearInterval(historyStatusTimer);
  historyStatusTimer = null;
}

async function refreshHistoryEmbedderStatus() {
  const el = document.getElementById('history-embedder-status');
  if (!el || !window.electron?.history?.embedderStatus) return null;
  const out = await window.electron.history.embedderStatus();
  el.textContent = out && out.ok
    ? historyEmbedderStatusText(out.status, out.progress)
    : `Could not read the embedding status: ${(out && out.error) || 'unknown error'}`;
  return out;
}

async function loadHistorySettings() {
  const out = await refreshHistoryEmbedderStatus();
  if (out && out.ok && out.settings) {
    const e = out.settings.embedder;
    document.getElementById('history-embedder-kind').value = e.kind;
    document.getElementById('history-embedder-model').value = e.model;
    document.getElementById('history-ollama-url').value = e.ollama.baseUrl;
    document.getElementById('history-ollama-model').value = e.ollama.model;
    document.getElementById('history-openai-model').value = e.openai.model;
    document.getElementById('history-rerank-search').checked = Boolean(out.settings.rerank.search);
    document.getElementById('history-rerank-turn').checked = Boolean(out.settings.rerank.enabled);
  }
  stopHistoryStatusPoll();
  historyStatusTimer = setInterval(() => { refreshHistoryEmbedderStatus().catch(() => {}); }, 2000);
}

async function saveHistorySettings() {
  const el = document.getElementById('history-embedder-status');
  const val = (id) => document.getElementById(id).value.trim();
  const out = await window.electron.history.saveEmbedder({
    embedder: {
      kind: document.getElementById('history-embedder-kind').value,
      model: val('history-embedder-model'),
      ollama: { baseUrl: val('history-ollama-url'), model: val('history-ollama-model') },
      openai: { model: val('history-openai-model') }
    },
    rerank: {
      search: document.getElementById('history-rerank-search').checked,
      enabled: document.getElementById('history-rerank-turn').checked
    }
  });
  el.textContent = out && out.ok
    ? historyEmbedderStatusText(out.status, out.progress)
    : `Not saved: ${(out && out.error) || 'unknown error'}`;
}

// Retry and Rebuild show the host's refusal (e.g. "Embeddings are off.")
// instead of silently re-reading the status.
async function runHistoryEmbedderAction(call) {
  const out = await call();
  if (out && !out.ok) {
    document.getElementById('history-embedder-status').textContent = out.error || 'unknown error';
    return;
  }
  await refreshHistoryEmbedderStatus();
}

function wireHistorySettings() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', () => {
    fn().catch((err) => settingsLog.warn(`history settings: ${err.message}`));
  });
  on('history-embedder-save-btn', saveHistorySettings);
  on('history-embedder-retry-btn', () => runHistoryEmbedderAction(() => window.electron.history.retryEmbedder()));
  on('history-embedder-rebuild-btn', async () => {
    if (!window.confirm('Delete this model\'s embeddings and embed the whole history again? Recall uses keyword search until it catches up.')) return;
    await runHistoryEmbedderAction(() => window.electron.history.rebuildEmbeddings());
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireHistorySettings);
else wireHistorySettings();

function openSettingsDrawer() {
  setSettingsDrawer(true);
  loadSettings();
  if (dom.settingsNavSelect?.value === 'history') {
    loadHistorySettings().catch((err) => settingsLog.warn(`loading history settings failed: ${err.message}`));
  }
}

function renderProviderCard(providerKey, provider) {
  const card = document.createElement('div');
  card.className = 'provider-card';
  card.dataset.provider = providerKey;

  const header = document.createElement('div');
  header.className = 'provider-header';

  const title = document.createElement('div');
  title.className = 'provider-title';
  title.textContent = provider.label;

  const titleWrap = document.createElement('div');
  titleWrap.className = 'provider-title-wrap';
  titleWrap.appendChild(title);

  const status = document.createElement('span');
  status.className = 'provider-status';
  const statusView = providerStatusText(provider.status);
  if (statusView.cls) status.classList.add(statusView.cls);
  status.textContent = statusView.text;
  if (provider.status?.checkedAt) status.title = `Last tested ${new Date(provider.status.checkedAt).toLocaleString()}`;

  header.appendChild(titleWrap);
  header.appendChild(status);

  const controls = document.createElement('div');
  controls.className = 'provider-controls';

  const label = document.createElement('label');
  label.textContent = provider.hasToken
    ? 'API token saved (replace to update)'
    : 'API token';

  const input = document.createElement('input');
  input.className = 'provider-input';
  input.type = 'password';
  input.placeholder = provider.hasToken ? '""""""""""""' : 'Paste API token';
  input.dataset.provider = providerKey;

  controls.appendChild(label);
  controls.appendChild(input);

  // The Ollama address (models.ollama.baseUrl, spec 2026-09-27 §5.4).
  if (providerKey === 'ollama') {
    const addressLabel = document.createElement('label');
    addressLabel.textContent = 'Ollama address';
    const addressInput = document.createElement('input');
    addressInput.className = 'provider-input';
    addressInput.type = 'text';
    addressInput.dataset.ollamaUrl = 'true';
    addressInput.value = appState.settings.ollamaBaseUrl || '';
    addressInput.placeholder = 'http://127.0.0.1:11434';
    controls.appendChild(addressLabel);
    controls.appendChild(addressInput);
  }

  const actions = document.createElement('div');
  actions.className = 'provider-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.type = 'button';
  saveBtn.appendChild(faIcon('fas fa-floppy-disk'));
  saveBtn.appendChild(document.createTextNode(' Save Token'));
  saveBtn.dataset.action = 'save';
  saveBtn.dataset.provider = providerKey;

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn';
  testBtn.appendChild(faIcon('fas fa-plug'));
  testBtn.appendChild(document.createTextNode(' Test Connection'));
  testBtn.dataset.action = 'test';
  testBtn.dataset.provider = providerKey;

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-danger';
  clearBtn.appendChild(faIcon('fas fa-eraser'));
  clearBtn.appendChild(document.createTextNode(' Clear Token'));
  clearBtn.dataset.action = 'clear';
  clearBtn.dataset.provider = providerKey;

  actions.appendChild(saveBtn);
  actions.appendChild(testBtn);
  actions.appendChild(clearBtn);

  if (providerKey === 'ollama') {
    const addressBtn = document.createElement('button');
    addressBtn.type = 'button';
    addressBtn.className = 'btn';
    addressBtn.appendChild(faIcon('fas fa-location-dot'));
    addressBtn.appendChild(document.createTextNode(' Save address'));
    addressBtn.dataset.action = 'save-ollama-url';
    addressBtn.dataset.provider = providerKey;
    actions.appendChild(addressBtn);
  }

  const message = document.createElement('div');
  message.className = 'provider-message';
  if (provider.status?.message) {
    message.textContent = provider.status.message;
    if (!provider.status.ok) {
      message.classList.add('error');
    }
  } else {
    message.textContent = 'No connection test has been run yet.';
  }

  card.appendChild(header);
  card.appendChild(controls);
  card.appendChild(actions);
  card.appendChild(message);
  return card;
}

function renderSettings() {
  dom.settingsEncryptionAlert.hidden = appState.settings.encryptionAvailable;

  // General defaults
  const defaults = appState.settings.defaults || {};
  if (dom.defaultAgentMode) dom.defaultAgentMode.checked = !!defaults.agentMode;
  if (dom.defaultSandboxMode) dom.defaultSandboxMode.checked = defaults.sandboxMode !== false;
  // `settings:load` returns a curated payload that doesn't carry the
  // checkpoint flag, and the live manager is the real authority anyway
  // (it disables itself if git is missing). Ask it directly.
  refreshCheckpointToggle();

  const templateVariables = appState.settings.templateVariables || {};
  if (dom.templateNameInput) dom.templateNameInput.value = templateVariables.name || '';
  if (dom.templateRoleInput) dom.templateRoleInput.value = templateVariables.role || '';
  if (dom.templatePreferencesInput) dom.templatePreferencesInput.value = templateVariables.preferences || '';
  if (dom.templateProjectContextInput) dom.templateProjectContextInput.value = templateVariables.projectContext || '';

  if (dom.templateVariablesStatus) {
    dom.templateVariablesStatus.textContent = 'Template variables loaded.';
    dom.templateVariablesStatus.classList.remove('error');
  }

  const userProfile = appState.settings.userProfile || {};
  if (dom.profileNameInput) dom.profileNameInput.value = userProfile.name || '';
  if (dom.profileRoleInput) dom.profileRoleInput.value = userProfile.role || '';
  if (dom.profileGoalsInput) {
    const goals = Array.isArray(userProfile.goals) ? userProfile.goals : [];
    dom.profileGoalsInput.value = goals.join('\n');
  }
  if (dom.profilePreferencesInput) {
    dom.profilePreferencesInput.value =
      userProfile.preferences && typeof userProfile.preferences === 'object'
        ? JSON.stringify(userProfile.preferences, null, 2)
        : '';
  }
  if (dom.profileProjectContextInput) {
    dom.profileProjectContextInput.value = userProfile.projectContext || '';
  }

  if (dom.userProfileStatus) {
    dom.userProfileStatus.textContent = 'User profile loaded.';
    dom.userProfileStatus.classList.remove('error');
  }

  const notifications = appState.settings.notifications || {};
  const thresholds = notifications.thresholdsMs || {};
  if (dom.notificationsEnabledInput) dom.notificationsEnabledInput.checked = notifications.enabled !== false;
  if (dom.notificationsUiToastEnabledInput) dom.notificationsUiToastEnabledInput.checked = notifications.uiToast?.enabled !== false;
  if (dom.notificationsNtfyEnabledInput) dom.notificationsNtfyEnabledInput.checked = notifications.ntfy?.enabled === true;
  if (dom.notificationsTelegramLongTaskInput) dom.notificationsTelegramLongTaskInput.checked = notifications.telegram?.longTaskNotice !== false;
  if (dom.notificationsToastThresholdInput) dom.notificationsToastThresholdInput.value = Math.round((Number(thresholds.toast || 30000)) / 1000);
  if (dom.notificationsExternalThresholdInput) dom.notificationsExternalThresholdInput.value = Math.round((Number(thresholds.external || 120000)) / 1000);
  if (dom.notificationsNtfyTopicInput) dom.notificationsNtfyTopicInput.value = String(notifications.ntfy?.topic || '');

  if (dom.notificationsStatus) {
    dom.notificationsStatus.textContent = 'Notification settings loaded.';
    dom.notificationsStatus.classList.remove('error');
  }

  const voice = appState.settings.voice || {};
  if (dom.voiceEnabledInput) dom.voiceEnabledInput.checked = voice.enabled === true;
  if (dom.voiceSpeakChatInput) dom.voiceSpeakChatInput.checked = voice.speakChatResponses === true;
  if (dom.voiceSpeakAgentSummaryInput) dom.voiceSpeakAgentSummaryInput.checked = voice.speakAgentSummary !== false;
  if (dom.voiceTelegramLongInput) dom.voiceTelegramLongInput.checked = voice.telegramVoiceForLongResponses === true;
  if (dom.voiceEngineInput) dom.voiceEngineInput.value = String(voice.engine || 'system');
  if (dom.voiceIdInput) dom.voiceIdInput.value = String(voice.voiceId || '');
  if (dom.voiceSpeedInput) dom.voiceSpeedInput.value = String(Number(voice.speed || 1));
  if (dom.voiceStabilityInput) dom.voiceStabilityInput.value = String(Number(voice.stability || 0.5));
  if (dom.voiceStyleInput) dom.voiceStyleInput.value = String(Number(voice.style || 0.25));
  if (dom.voiceSummaryMaxInput) dom.voiceSummaryMaxInput.value = String(Number(voice.summaryMaxChars || 260));
  if (dom.voiceTelegramMinInput) dom.voiceTelegramMinInput.value = String(Number(voice.telegramMinChars || 500));

  if (dom.voiceStatus) {
    dom.voiceStatus.textContent = voice.hasElevenLabsKey
      ? 'Voice settings loaded. ElevenLabs key is saved.'
      : 'Voice settings loaded. ElevenLabs key is not saved.';
    dom.voiceStatus.classList.remove('error');
  }

  const hooks = appState.settings.hooks || {};
  const loadedHooks = Array.isArray(hooks.loaded) ? hooks.loaded : [];

  if (dom.hooksGlobalEnabledInput) {
    dom.hooksGlobalEnabledInput.checked = hooks.enabled !== false;
  }

  if (dom.hooksStatus) {
    dom.hooksStatus.textContent = `Loaded ${loadedHooks.length} hook(s).`;
    dom.hooksStatus.classList.remove('error');
  }

  if (dom.hooksList) {
    dom.hooksList.innerHTML = '';

    if (!loadedHooks.length) {
      const empty = document.createElement('div');
      empty.className = 'provider-message';
      empty.textContent = 'No hooks discovered in hooks/ directory.';
      dom.hooksList.appendChild(empty);
    } else {
      loadedHooks.forEach((hook) => {
        const card = document.createElement('div');
        card.className = 'provider-card';
        card.dataset.hookName = hook.name;

        const header = document.createElement('div');
        header.className = 'provider-header';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'provider-title-wrap';

        const title = document.createElement('div');
        title.className = 'provider-title';
        title.textContent = hook.name;

        const eventMeta = document.createElement('div');
        eventMeta.className = 'provider-message';
        eventMeta.textContent = `${hook.event} • matcher: ${hook.matcher || '*'}`;

        titleWrap.appendChild(title);
        titleWrap.appendChild(eventMeta);

        const status = document.createElement('span');
        status.className = 'provider-status';
        if (hook.enabled !== false) {
          status.classList.add('ok');
          status.textContent = 'Enabled';
        } else {
          status.classList.add('error');
          status.textContent = 'Disabled';
        }

        header.appendChild(titleWrap);
        header.appendChild(status);

        const description = document.createElement('div');
        description.className = 'provider-message';
        description.textContent = hook.description || hook.handler || 'No description provided.';

        const actions = document.createElement('div');
        actions.className = 'provider-actions';

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.dataset.action = 'toggle-hook';
        toggleBtn.dataset.hookName = hook.name;
        toggleBtn.dataset.nextEnabled = hook.enabled !== false ? 'false' : 'true';
        toggleBtn.appendChild(faIcon(hook.enabled !== false ? 'fas fa-toggle-on' : 'fas fa-toggle-off'));
        toggleBtn.appendChild(document.createTextNode(hook.enabled !== false ? ' Disable Hook' : ' Enable Hook'));
        if (hook.enabled !== false) {
          toggleBtn.className = 'btn btn-danger';
        } else {
          toggleBtn.className = 'btn btn-primary';
        }

        actions.appendChild(toggleBtn);

        card.appendChild(header);
        card.appendChild(description);
        card.appendChild(actions);
        dom.hooksList.appendChild(card);
      });
    }
  }

  if (dom.memoryStatus) {
    dom.memoryStatus.textContent = 'Memory settings ready.';
    dom.memoryStatus.classList.remove('error');
  }

  if (dom.memoryCaptureTypeInput && !dom.memoryCaptureTypeInput.value) {
    dom.memoryCaptureTypeInput.value = 'context';
  }

  dom.providerList.innerHTML = '';
  Object.entries(appState.settings.providers).forEach(([key, provider]) => {
    dom.providerList.appendChild(renderProviderCard(key, provider));
  });

  renderCatalogSettings();
  loadVaultEntries();
  loadMcpServers();

  const telegram = appState.settings.telegram || {};
  if (dom.telegramChannelStatus) {
    if (telegram.bridgeActive) {
      dom.telegramChannelStatus.textContent = 'Bridge active.';
      dom.telegramChannelStatus.classList.remove('error');
    } else if (telegram.hasToken) {
      dom.telegramChannelStatus.textContent = 'Token saved. Bridge not active.';
      dom.telegramChannelStatus.classList.remove('error');
    } else {
      dom.telegramChannelStatus.textContent = 'Not configured.';
      dom.telegramChannelStatus.classList.remove('error');
    }
  }

  const webSearch = appState.settings.webSearch || {};
  if (dom.websearchBraveStatus) {
    dom.websearchBraveStatus.textContent = webSearch.brave?.apiKey
      ? 'Key configured.'
      : 'Not configured.';
  }
  if (dom.websearchTavilyStatus) {
    dom.websearchTavilyStatus.textContent = webSearch.tavily?.apiKey
      ? 'Key configured.'
      : 'Not configured.';
  }

  const imageGen = appState.settings.imageGeneration || {};
  if (dom.imagegenDefaultSelect) {
    dom.imagegenDefaultSelect.value = imageGen.defaultProvider || 'openai';
  }
  if (dom.imagegenFalStatus) {
    dom.imagegenFalStatus.textContent = imageGen.fal?.apiKey
      ? 'Key configured.'
      : 'Not configured.';
  }
}

// ── Vault ──────────────────────────────────────────────────

async function loadVaultEntries() {
  if (!window.electron?.settings?.vaultList || !dom.vaultList) return;
  try {
    if (dom.vaultStatus) {
      dom.vaultStatus.textContent = 'Loading vault...';
      dom.vaultStatus.classList.remove('error');
    }
    const result = await window.electron.settings.vaultList();
    if (!result?.ok) throw new Error(result?.error || 'Failed to list vault entries');
    appState.settings.vaultKeys = Array.isArray(result.keys) ? result.keys : [];
    renderVaultEntries(appState.settings.vaultKeys);
    if (dom.vaultStatus) {
      dom.vaultStatus.textContent = `${result.count} secret(s) stored.`;
    }
  } catch (err) {
    if (dom.vaultStatus) {
      dom.vaultStatus.textContent = `Error: ${err.message}`;
      dom.vaultStatus.classList.add('error');
    }
  }
}

function renderVaultEntries(keys = []) {
  if (!dom.vaultList) return;
  dom.vaultList.innerHTML = '';

  if (keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No secrets stored in the vault.';
    dom.vaultList.appendChild(empty);
    return;
  }

  keys.forEach((key) => {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.vaultKey = key;

    const header = document.createElement('div');
    header.className = 'provider-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'provider-title-wrap';

    const title = document.createElement('div');
    title.className = 'provider-title';
    title.textContent = key;

    const meta = document.createElement('div');
    meta.className = 'provider-message';
    meta.textContent = 'Encrypted • Click "Update" to change the value';

    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    const status = document.createElement('span');
    status.className = 'provider-status ok';
    status.textContent = 'Stored';

    header.appendChild(titleWrap);
    header.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'provider-actions';

    const updateBtn = document.createElement('button');
    updateBtn.type = 'button';
    updateBtn.className = 'btn';
    updateBtn.appendChild(faIcon('fas fa-pen'));
    updateBtn.appendChild(document.createTextNode(' Update'));
    updateBtn.dataset.action = 'update-vault';
    updateBtn.dataset.vaultKey = key;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.appendChild(faIcon('fas fa-trash'));
    deleteBtn.appendChild(document.createTextNode(' Delete'));
    deleteBtn.dataset.action = 'delete-vault';
    deleteBtn.dataset.vaultKey = key;

    actions.appendChild(updateBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(header);
    card.appendChild(actions);
    dom.vaultList.appendChild(card);
  });
}

async function handleVaultDelete(key) {
  if (!confirm(`Delete secret "${key}" from the vault?`)) return;
  try {
    const result = await window.electron.settings.vaultDelete({ key });
    if (!result?.ok) throw new Error(result?.error || 'Delete failed');
    await loadVaultEntries();
  } catch (err) {
    if (dom.vaultStatus) {
      dom.vaultStatus.textContent = `Error: ${err.message}`;
      dom.vaultStatus.classList.add('error');
    }
  }
}

async function handleVaultUpdate(key) {
  const newValue = prompt(`Enter new value for "${key}" (leave blank to keep current):`);
  if (newValue === null) return; // cancelled
  const newKey = prompt(`Rename key? (leave as-is or type new name):`, key);
  if (newKey === null) return;

  try {
    const payload = { oldKey: key, newKey: newKey || key };
    if (newValue) payload.value = newValue;
    const result = await window.electron.settings.vaultUpdate(payload);
    if (!result?.ok) throw new Error(result?.error || 'Update failed');
    await loadVaultEntries();
  } catch (err) {
    if (dom.vaultStatus) {
      dom.vaultStatus.textContent = `Error: ${err.message}`;
      dom.vaultStatus.classList.add('error');
    }
  }
}

async function handleVaultSave() {
  const key = dom.vaultAddKeyInput?.value?.trim();
  const value = dom.vaultAddValueInput?.value;

  if (!key) {
    if (dom.vaultAddStatus) {
      dom.vaultAddStatus.textContent = 'Key name is required.';
      dom.vaultAddStatus.classList.add('error');
    }
    return;
  }
  if (!value) {
    if (dom.vaultAddStatus) {
      dom.vaultAddStatus.textContent = 'Value is required.';
      dom.vaultAddStatus.classList.add('error');
    }
    return;
  }

  try {
    const result = await window.electron.settings.vaultStore({ key, value });
    if (!result?.ok) throw new Error(result?.error || 'Save failed');
    if (dom.vaultAddKeyInput) dom.vaultAddKeyInput.value = '';
    if (dom.vaultAddValueInput) dom.vaultAddValueInput.value = '';
    if (dom.vaultAddPanel) dom.vaultAddPanel.hidden = true;
    if (dom.vaultAddStatus) {
      dom.vaultAddStatus.textContent = '';
      dom.vaultAddStatus.classList.remove('error');
    }
    await loadVaultEntries();
  } catch (err) {
    if (dom.vaultAddStatus) {
      dom.vaultAddStatus.textContent = `Error: ${err.message}`;
      dom.vaultAddStatus.classList.add('error');
    }
  }
}

// ── MCP Servers ────────────────────────────────────────────

let mcpEditingName = null; // null = adding new; string = editing existing

async function loadMcpServers() {
  if (!window.electron?.settings?.mcpList || !dom.mcpList) return;
  try {
    setMcpStatus('Loading MCP servers...');
    const result = await window.electron.settings.mcpList();
    if (!result?.ok) throw new Error(result?.error || 'Failed to list MCP servers');
    renderMcpServers(result.servers || []);
    setMcpStatus(`${result.servers.length} server(s) configured.`);
  } catch (err) {
    setMcpStatus(`Error: ${err.message}`, true);
  }
}

function setMcpStatus(text, isError = false) {
  if (!dom.mcpStatus) return;
  dom.mcpStatus.textContent = text;
  dom.mcpStatus.classList.toggle('error', Boolean(isError));
}

function renderMcpServers(servers = []) {
  if (!dom.mcpList) return;
  dom.mcpList.innerHTML = '';

  if (servers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No MCP servers configured. Click "Add Server" to connect one.';
    dom.mcpList.appendChild(empty);
    return;
  }

  servers.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.mcpName = s.name;

    const header = document.createElement('div');
    header.className = 'provider-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'provider-title-wrap';

    const title = document.createElement('div');
    title.className = 'provider-title';
    title.textContent = s.name;

    const meta = document.createElement('div');
    meta.className = 'provider-message';
    const cmdLine = `${s.command} ${(s.args || []).join(' ')}`.trim();
    const toolsText = s.connected
      ? `Connected • ${(s.tools || []).length} tool(s)`
      : 'Disconnected';
    meta.textContent = `${cmdLine} • ${toolsText}`;

    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    const status = document.createElement('span');
    status.className = `provider-status ${s.connected ? 'ok' : 'error'}`;
    status.textContent = s.connected ? 'Connected' : 'Offline';

    header.appendChild(titleWrap);
    header.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'provider-actions';

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'btn';
    reloadBtn.appendChild(faIcon('fas fa-rotate'));
    reloadBtn.appendChild(document.createTextNode(' Reconnect'));
    reloadBtn.dataset.action = 'reload-mcp';
    reloadBtn.dataset.mcpName = s.name;

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn';
    editBtn.appendChild(faIcon('fas fa-pen'));
    editBtn.appendChild(document.createTextNode(' Edit'));
    editBtn.dataset.action = 'edit-mcp';
    editBtn.dataset.mcpName = s.name;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.appendChild(faIcon('fas fa-trash'));
    deleteBtn.appendChild(document.createTextNode(' Delete'));
    deleteBtn.dataset.action = 'delete-mcp';
    deleteBtn.dataset.mcpName = s.name;

    actions.appendChild(reloadBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(header);
    card.appendChild(actions);
    dom.mcpList.appendChild(card);
  });
}

async function getVaultKeysForAutocomplete() {
  try {
    const result = await window.electron.settings.vaultList();
    return result?.ok ? (result.keys || []) : [];
  } catch {
    return [];
  }
}

async function addMcpEnvRow(key = '', value = '') {
  if (!dom.mcpEnvList) return;

  const vaultKeys = await getVaultKeysForAutocomplete();
  const datalistId = 'mcp-vault-keys-datalist';
  if (!document.getElementById(datalistId)) {
    const dl = document.createElement('datalist');
    dl.id = datalistId;
    vaultKeys.forEach((k) => {
      const opt = document.createElement('option');
      opt.value = `\${vault:${k}}`;
      dl.appendChild(opt);
    });
    document.body.appendChild(dl);
  }

  const row = document.createElement('div');
  row.className = 'mcp-env-row';
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.marginTop = '6px';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.className = 'provider-input';
  keyInput.placeholder = 'ENV_VAR_NAME';
  keyInput.value = key;
  keyInput.style.flex = '1';
  keyInput.dataset.mcpEnv = 'key';

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.className = 'provider-input';
  valueInput.placeholder = 'value or ${vault:key}';
  valueInput.value = value;
  valueInput.style.flex = '2';
  valueInput.dataset.mcpEnv = 'value';
  valueInput.setAttribute('list', datalistId);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-danger';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(keyInput);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);
  dom.mcpEnvList.appendChild(row);
}

function collectMcpEnvFromForm() {
  const env = {};
  if (!dom.mcpEnvList) return env;
  const rows = dom.mcpEnvList.querySelectorAll('.mcp-env-row');
  rows.forEach((row) => {
    const k = row.querySelector('[data-mcp-env="key"]')?.value?.trim();
    const v = row.querySelector('[data-mcp-env="value"]')?.value ?? '';
    if (k) env[k] = v;
  });
  return env;
}

function openMcpEditPanel(server = null) {
  mcpEditingName = server?.name || null;
  if (dom.mcpEditTitle) {
    dom.mcpEditTitle.textContent = server ? `Edit "${server.name}"` : 'Add MCP Server';
  }
  if (dom.mcpNameInput) dom.mcpNameInput.value = server?.name || '';
  if (dom.mcpCommandInput) dom.mcpCommandInput.value = server?.command || '';
  if (dom.mcpArgsInput) dom.mcpArgsInput.value = (server?.args || []).join(', ');
  if (dom.mcpCwdInput) dom.mcpCwdInput.value = server?.cwd || '';
  if (dom.mcpEnvList) dom.mcpEnvList.innerHTML = '';

  const envEntries = Object.entries(server?.env || {});
  if (envEntries.length === 0) {
    addMcpEnvRow();
  } else {
    envEntries.forEach(([k, v]) => addMcpEnvRow(k, v));
  }

  if (dom.mcpEditStatus) { dom.mcpEditStatus.textContent = ''; dom.mcpEditStatus.classList.remove('error'); }
  if (dom.mcpEditPanel) dom.mcpEditPanel.hidden = false;
}

function closeMcpEditPanel() {
  mcpEditingName = null;
  if (dom.mcpEditPanel) dom.mcpEditPanel.hidden = true;
  if (dom.mcpEnvList) dom.mcpEnvList.innerHTML = '';
}

async function handleMcpSave() {
  const name = dom.mcpNameInput?.value?.trim();
  const command = dom.mcpCommandInput?.value?.trim();

  if (!name) return setMcpEditStatus('Name is required.', true);
  if (!command) return setMcpEditStatus('Command is required.', true);

  const argsRaw = dom.mcpArgsInput?.value || '';
  const args = argsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const cwd = dom.mcpCwdInput?.value?.trim() || undefined;
  const env = collectMcpEnvFromForm();

  const payload = {
    name,
    oldName: mcpEditingName,
    server: { command, args, env, cwd }
  };

  try {
    setMcpEditStatus('Saving and connecting...');
    const result = await window.electron.settings.mcpSave(payload);
    if (!result?.ok) throw new Error(result?.error || 'Save failed');
    if (result.connectError) {
      setMcpEditStatus(`Saved, but connection failed: ${result.connectError}`, true);
    } else {
      setMcpEditStatus(result.message || 'Saved.');
      closeMcpEditPanel();
    }
    await loadMcpServers();
  } catch (err) {
    setMcpEditStatus(`Error: ${err.message}`, true);
  }
}

function setMcpEditStatus(text, isError = false) {
  if (!dom.mcpEditStatus) return;
  dom.mcpEditStatus.textContent = text;
  dom.mcpEditStatus.classList.toggle('error', Boolean(isError));
}

async function handleMcpEdit(name) {
  try {
    const result = await window.electron.settings.mcpList();
    if (!result?.ok) throw new Error(result?.error || 'Failed to load');
    const server = (result.servers || []).find((s) => s.name === name);
    if (!server) throw new Error(`Server "${name}" not found.`);
    openMcpEditPanel(server);
  } catch (err) {
    setMcpStatus(`Error: ${err.message}`, true);
  }
}

async function handleMcpDelete(name) {
  if (!confirm(`Delete MCP server "${name}"? This will disconnect it immediately.`)) return;
  try {
    const result = await window.electron.settings.mcpDelete({ name });
    if (!result?.ok) throw new Error(result?.error || 'Delete failed');
    await loadMcpServers();
  } catch (err) {
    setMcpStatus(`Error: ${err.message}`, true);
  }
}

async function handleMcpReload(name) {
  try {
    setMcpStatus(`Reconnecting "${name}"...`);
    const result = await window.electron.settings.mcpReload({ name });
    if (!result?.ok) throw new Error(result?.error || 'Reload failed');
    await loadMcpServers();
    setMcpStatus(result.message || `Reconnected "${name}".`);
  } catch (err) {
    setMcpStatus(`Error: ${err.message}`, true);
  }
}

async function handleMcpReloadAll() {
  try {
    setMcpStatus('Reconnecting all servers...');
    const result = await window.electron.settings.mcpReload();
    if (!result?.ok) throw new Error(result?.error || 'Reload failed');
    await loadMcpServers();
    const ok = (result.results || []).filter((r) => r.status === 'connected').length;
    setMcpStatus(`Reconnected ${ok}/${(result.results || []).length} server(s).`);
  } catch (err) {
    setMcpStatus(`Error: ${err.message}`, true);
  }
}

// ── Skills List ────────────────────────────────────────────

function renderSkillCard(skill) {
  const card = document.createElement('div');
  card.className = 'provider-card';
  card.dataset.skillId = skill.id;

  const header = document.createElement('div');
  header.className = 'provider-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'provider-title-wrap';

  const title = document.createElement('div');
  title.className = 'provider-title';
  title.textContent = skill.name;

  const versionBadge = document.createElement('span');
  versionBadge.className = 'active-provider-badge';
  versionBadge.textContent = `v${skill.version || '?'}`;

  titleWrap.appendChild(title);
  titleWrap.appendChild(versionBadge);

  if (skill._updateInfo?.updateAvailable) {
    const updateBadge = document.createElement('span');
    updateBadge.className = 'active-provider-badge skill-update-badge';
    const remoteVer = skill._updateInfo.remoteVersion;
    updateBadge.textContent = remoteVer ? `v${remoteVer} available` : 'Update available';
    updateBadge.title = skill._updateInfo.behind
      ? `${skill._updateInfo.behind} commit(s) behind`
      : 'New version available';
    titleWrap.appendChild(updateBadge);
  }

  const status = document.createElement('span');
  status.className = 'provider-status';
  if (skill.enabled !== false) {
    status.classList.add('ok');
    status.textContent = 'Enabled';
  } else {
    status.classList.add('error');
    status.textContent = 'Disabled';
  }

  header.appendChild(titleWrap);
  header.appendChild(status);

  const desc = document.createElement('div');
  desc.className = 'provider-message';
  const commands = (skill.commands || []).map((c) => `/${c}`).join(', ');
  desc.textContent = `${skill.description || ''}${commands ? ` — Commands: ${commands}` : ''}`;

  const actions = document.createElement('div');
  actions.className = 'provider-actions';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.dataset.action = 'toggle-skill';
  toggleBtn.dataset.skillId = skill.id;
  if (skill.enabled !== false) {
    toggleBtn.className = 'btn btn-danger';
    toggleBtn.dataset.nextEnabled = 'false';
    toggleBtn.appendChild(faIcon('fas fa-toggle-on'));
    toggleBtn.appendChild(document.createTextNode(' Disable'));
  } else {
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.dataset.nextEnabled = 'true';
    toggleBtn.appendChild(faIcon('fas fa-toggle-off'));
    toggleBtn.appendChild(document.createTextNode(' Enable'));
  }
  actions.appendChild(toggleBtn);

  if (Array.isArray(skill.settingsSchema) && skill.settingsSchema.length > 0) {
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'btn';
    settingsBtn.dataset.action = 'open-skill-settings';
    settingsBtn.dataset.skillId = skill.id;
    settingsBtn.appendChild(faIcon('fas fa-gear'));
    settingsBtn.appendChild(document.createTextNode(' Settings'));
    actions.appendChild(settingsBtn);
  }

  if (skill._updateInfo?.updateAvailable) {
    const updateBtn = document.createElement('button');
    updateBtn.type = 'button';
    updateBtn.className = 'btn btn-primary';
    updateBtn.dataset.action = 'update-skill';
    updateBtn.dataset.skillId = skill.id;
    updateBtn.dataset.skillName = skill.name;
    updateBtn.appendChild(faIcon('fas fa-download'));
    updateBtn.appendChild(document.createTextNode(' Update'));
    actions.appendChild(updateBtn);
  }

  if (skill.skillPath) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-danger';
    removeBtn.dataset.action = 'remove-skill';
    removeBtn.dataset.skillId = skill.id;
    removeBtn.dataset.skillName = skill.name;
    removeBtn.appendChild(faIcon('fas fa-trash'));
    removeBtn.appendChild(document.createTextNode(' Remove'));
    actions.appendChild(removeBtn);
  }

  card.appendChild(header);
  card.appendChild(desc);
  card.appendChild(actions);
  return card;
}

function renderSkillsList(skills) {
  if (!dom.skillsList) return;
  dom.skillsList.innerHTML = '';

  if (!skills || skills.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No skills loaded. Install one from a GitHub URL or local path above.';
    dom.skillsList.appendChild(empty);
    if (dom.skillsStatus) {
      dom.skillsStatus.textContent = '';
    }
    return;
  }

  for (const skill of skills) {
    dom.skillsList.appendChild(renderSkillCard(skill));
  }

  if (dom.skillsStatus) {
    dom.skillsStatus.textContent = `${skills.length} skill(s) loaded.`;
    dom.skillsStatus.classList.remove('error');
  }
}

async function toggleSkillEnabled(skillId, enabled) {
  try {
    const result = await window.electron.skill.setEnabled({ skillId, enabled });
    if (result?.error) throw new Error(result.error);
    await loadSkillSettingsTabs();
  } catch (err) {
    if (dom.skillsStatus) {
      dom.skillsStatus.textContent = `Error: ${err.message}`;
      dom.skillsStatus.classList.add('error');
    }
  }
}

async function installSkill() {
  const url = (dom.skillInstallUrl?.value || '').trim();
  if (!url) {
    if (dom.skillInstallStatus) {
      dom.skillInstallStatus.textContent = 'Please enter a GitHub URL or local directory path.';
      dom.skillInstallStatus.classList.add('error');
    }
    return;
  }

  if (dom.skillInstallStatus) {
    dom.skillInstallStatus.textContent = 'Installing...';
    dom.skillInstallStatus.classList.remove('error');
  }
  if (dom.skillInstallBtn) dom.skillInstallBtn.disabled = true;

  try {
    const result = await window.electron.skill.install({ url });
    if (result?.error) throw new Error(result.error);
    if (dom.skillInstallStatus) {
      dom.skillInstallStatus.textContent = `Installed "${result.name || result.skillId}" successfully.`;
      dom.skillInstallStatus.classList.remove('error');
    }
    if (dom.skillInstallUrl) dom.skillInstallUrl.value = '';
    await loadSkillSettingsTabs();
  } catch (err) {
    if (dom.skillInstallStatus) {
      dom.skillInstallStatus.textContent = `Install failed: ${err.message}`;
      dom.skillInstallStatus.classList.add('error');
    }
  } finally {
    if (dom.skillInstallBtn) dom.skillInstallBtn.disabled = false;
  }
}

async function removeSkill(skillId, skillName) {
  if (!await showConfirmDialog(`Remove skill "${skillName || skillId}"? This will delete its files.`)) {
    return;
  }

  try {
    const result = await window.electron.skill.remove({ skillId });
    if (result?.error) throw new Error(result.error);
    if (dom.skillsStatus) {
      dom.skillsStatus.textContent = `Removed "${skillName || skillId}".`;
      dom.skillsStatus.classList.remove('error');
    }
    await loadSkillSettingsTabs();
  } catch (err) {
    if (dom.skillsStatus) {
      dom.skillsStatus.textContent = `Remove failed: ${err.message}`;
      dom.skillsStatus.classList.add('error');
    }
  }
}

// ── Skill Settings ─────────────────────────────────────────

function renderSkillSettingsField(field, value) {
  const wrapper = document.createElement('div');
  wrapper.className = 'skill-settings-field';

  const label = document.createElement('label');
  label.textContent = field.label;
  wrapper.appendChild(label);

  let input;

  switch (field.type) {
    case 'toggle': {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.dataset.skillKey = field.key;
      input.className = 'skill-settings-toggle';
      break;
    }
    case 'select': {
      input = document.createElement('select');
      input.dataset.skillKey = field.key;
      input.className = 'skill-settings-select';
      for (const opt of (field.options || [])) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (String(opt.value) === String(value)) option.selected = true;
        input.appendChild(option);
      }
      break;
    }
    case 'number': {
      input = document.createElement('input');
      input.type = 'number';
      input.value = value != null ? String(value) : '';
      input.dataset.skillKey = field.key;
      input.className = 'skill-settings-input';
      if (field.placeholder) input.placeholder = field.placeholder;
      break;
    }
    case 'password': {
      input = document.createElement('input');
      input.type = 'password';
      input.value = value != null ? String(value) : '';
      input.dataset.skillKey = field.key;
      input.className = 'skill-settings-input';
      if (field.placeholder) input.placeholder = field.placeholder;
      break;
    }
    default: {
      input = document.createElement('input');
      input.type = 'text';
      input.value = value != null ? String(value) : '';
      input.dataset.skillKey = field.key;
      input.className = 'skill-settings-input';
      if (field.placeholder) input.placeholder = field.placeholder;
      break;
    }
  }

  wrapper.appendChild(input);

  if (field.description) {
    const desc = document.createElement('div');
    desc.className = 'skill-settings-description';
    desc.textContent = field.description;
    wrapper.appendChild(desc);
  }

  return wrapper;
}

function renderSkillSettingsTab(skillData) {
  const pane = document.createElement('div');
  pane.className = 'settings-tab-content';
  pane.dataset.tab = `skill-${skillData.id}`;

  const card = document.createElement('section');
  card.className = 'template-variables-card';

  const heading = document.createElement('h3');
  heading.textContent = `${skillData.name} Settings`;
  card.appendChild(heading);

  if (skillData.description) {
    const desc = document.createElement('p');
    desc.textContent = skillData.description;
    card.appendChild(desc);
  }

  const form = document.createElement('div');
  form.className = 'skill-settings-form';
  form.dataset.skillId = skillData.id;

  for (const field of skillData.settingsSchema) {
    const value = skillData.settings?.[field.key] ?? field.default;
    form.appendChild(renderSkillSettingsField(field, value));
  }

  card.appendChild(form);

  const actions = document.createElement('div');
  actions.className = 'provider-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary';
  saveBtn.appendChild(faIcon('fas fa-floppy-disk'));
  saveBtn.appendChild(document.createTextNode(' Save'));
  saveBtn.dataset.action = 'save-skill-settings';
  saveBtn.dataset.skillId = skillData.id;
  actions.appendChild(saveBtn);

  card.appendChild(actions);

  const status = document.createElement('div');
  status.className = 'provider-message';
  status.id = `skill-settings-status-${skillData.id}`;
  status.textContent = 'Settings loaded.';
  card.appendChild(status);

  pane.appendChild(card);
  return pane;
}

function collectSkillSettingsValues(skillId) {
  const form = document.querySelector(`.skill-settings-form[data-skill-id="${skillId}"]`);
  if (!form) return {};
  const values = {};
  form.querySelectorAll('[data-skill-key]').forEach((el) => {
    const key = el.dataset.skillKey;
    if (el.type === 'checkbox') {
      values[key] = el.checked;
    } else if (el.type === 'number') {
      values[key] = el.value !== '' ? Number(el.value) : null;
    } else {
      values[key] = el.value;
    }
  });
  return values;
}

async function saveSkillSettings(skillId) {
  const statusEl = document.getElementById(`skill-settings-status-${skillId}`);
  try {
    const settings = collectSkillSettingsValues(skillId);
    const result = await window.electron.skill.saveSettings({ skillId, settings });
    if (result?.error) throw new Error(result.error);
    if (statusEl) {
      statusEl.textContent = 'Settings saved.';
      statusEl.classList.remove('error');
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.classList.add('error');
    }
  }
}

async function updateSkill(skillId, skillName) {
  if (dom.skillsStatus) {
    dom.skillsStatus.textContent = `Updating "${skillName || skillId}"...`;
    dom.skillsStatus.classList.remove('error');
  }

  try {
    const result = await window.electron.skill.update({ skillId });
    if (result?.error) throw new Error(result.error);
    if (dom.skillsStatus) {
      dom.skillsStatus.textContent = `Updated "${result.name || skillId}" to v${result.version || '?'}.`;
      dom.skillsStatus.classList.remove('error');
    }
    await loadSkillSettingsTabs();
  } catch (err) {
    if (dom.skillsStatus) {
      dom.skillsStatus.textContent = `Update failed: ${err.message}`;
      dom.skillsStatus.classList.add('error');
    }
  }
}

async function loadSkillSettingsTabs() {
  if (!dom.settingsNavSelect) return;

  try {
    const result = await window.electron.skill.listWithSettings();
    const skills = Array.isArray(result) ? result : (result?.data || []);

    // Check for updates in the background
    window.electron.skill.checkUpdates().then((updateResult) => {
      if (!updateResult?.ok || !updateResult.results) return;
      const updates = updateResult.results;
      let hasAnyUpdate = false;
      for (const skill of skills) {
        if (updates[skill.id]) {
          skill._updateInfo = updates[skill.id];
          if (updates[skill.id].updateAvailable) hasAnyUpdate = true;
        }
      }
      if (hasAnyUpdate) renderSkillsList(skills);
    }).catch(() => {});

    // Render the skills management list
    renderSkillsList(skills);

    // Render per-skill settings tabs
    const skillsWithSettings = (skills || []).filter(
      (s) => Array.isArray(s.settingsSchema) && s.settingsSchema.length > 0
    );

    // Remove previously injected skill options and panes
    dom.settingsNavSelect.querySelectorAll('option[data-skill]').forEach((el) => el.remove());
    if (dom.skillSettingsContainer) dom.skillSettingsContainer.innerHTML = '';

    for (const skill of skillsWithSettings) {
      // Add dropdown option
      const option = document.createElement('option');
      option.value = `skill-${skill.id}`;
      option.textContent = skill.name;
      option.dataset.skill = skill.id;
      dom.settingsNavSelect.appendChild(option);

      // Add tab content pane
      if (dom.skillSettingsContainer) {
        dom.skillSettingsContainer.appendChild(renderSkillSettingsTab(skill));
      }
    }

    sortSettingsNavOptions();
  } catch (err) {
    skillSettingsLog.error(`Failed to load skill settings tabs: ${err.message}`);
  }
}

function formatMemoryEntry(entry = {}) {
  const content = String(entry.content || '').trim();
  return content.length > 240
    ? `${content.slice(0, 240)}...`
    : content;
}

function renderMemoryList(entries = []) {
  if (!dom.memoryList) return;

  dom.memoryList.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No memories found for the current filters.';
    dom.memoryList.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.memoryId = entry.id;

    const header = document.createElement('div');
    header.className = 'provider-header';

    const title = document.createElement('div');
    title.className = 'provider-title';
    title.textContent = `${String(entry.tier || 'hot').toUpperCase()} • ${String(entry.type || 'context')}`;

    const status = document.createElement('span');
    status.className = 'provider-status ok';
    status.textContent = String(entry.source || 'unknown-session');

    header.appendChild(title);
    header.appendChild(status);

    const body = document.createElement('div');
    body.className = 'provider-message';
    body.textContent = formatMemoryEntry(entry);

    const meta = document.createElement('div');
    meta.className = 'provider-message';
    meta.textContent = `Created: ${formatTimestamp(entry.created)} • Last Accessed: ${formatTimestamp(entry.lastAccessed)}`;

    const actions = document.createElement('div');
    actions.className = 'provider-actions';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.dataset.action = 'delete-memory';
    deleteBtn.dataset.memoryId = entry.id;
    deleteBtn.appendChild(faIcon('fas fa-trash'));
    deleteBtn.appendChild(document.createTextNode(' Delete'));

    actions.appendChild(deleteBtn);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(meta);
    card.appendChild(actions);
    dom.memoryList.appendChild(card);
  });
}

function collectMemoryFilters() {
  return {
    query: String(dom.memoryQueryInput?.value || '').trim(),
    tier: String(dom.memoryTierFilterInput?.value || '').trim(),
    limit: 200
  };
}

async function loadMemoryEntries() {
  if (!window.electron?.memory || !dom.memoryList) {
    return;
  }

  const { query, tier, limit } = collectMemoryFilters();
  try {
    if (dom.memoryStatus) {
      dom.memoryStatus.textContent = 'Loading memories...';
      dom.memoryStatus.classList.remove('error');
    }

    const result = await window.electron.memory.list({
      query,
      tier,
      limit
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to load memory entries.');
    }

    appState.memoryEntries = Array.isArray(result.entries) ? result.entries : [];
    renderMemoryList(appState.memoryEntries);
    if (dom.memoryStatus) {
      dom.memoryStatus.textContent = `Loaded ${appState.memoryEntries.length} memory entr${appState.memoryEntries.length === 1 ? 'y' : 'ies'}.`;
      dom.memoryStatus.classList.remove('error');
    }
  } catch (error) {
    if (dom.memoryStatus) {
      dom.memoryStatus.textContent = `Error: ${error.message || 'Unable to load memory entries.'}`;
      dom.memoryStatus.classList.add('error');
    }
  }
}

async function handleCaptureMemory() {
  if (!window.electron?.memory) return;

  const type = String(dom.memoryCaptureTypeInput?.value || 'context').trim() || 'context';
  const content = String(dom.memoryCaptureContentInput?.value || '').trim();
  if (!content) {
    if (dom.memoryStatus) {
      dom.memoryStatus.textContent = 'Capture content is required.';
      dom.memoryStatus.classList.add('error');
    }
    return;
  }

  if (dom.memoryCaptureBtn) dom.memoryCaptureBtn.disabled = true;
  try {
    const result = await window.electron.memory.capture({ type, content });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to capture memory.');
    }

    if (dom.memoryCaptureContentInput) {
      dom.memoryCaptureContentInput.value = '';
    }
    if (dom.memoryStatus) {
      dom.memoryStatus.textContent = 'Memory captured.';
      dom.memoryStatus.classList.remove('error');
    }
    await loadMemoryEntries();
  } catch (error) {
    if (dom.memoryStatus) {
      dom.memoryStatus.textContent = `Error: ${error.message || 'Unable to capture memory.'}`;
      dom.memoryStatus.classList.add('error');
    }
  } finally {
    if (dom.memoryCaptureBtn) dom.memoryCaptureBtn.disabled = false;
  }
}

async function handleDeleteMemory(memoryId) {
  if (!window.electron?.memory || !memoryId) return;

  try {
    const result = await window.electron.memory.delete({ id: memoryId });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to delete memory.');
    }
    await loadMemoryEntries();
  } catch (error) {
    if (dom.memoryStatus) {
      dom.memoryStatus.textContent = `Error: ${error.message || 'Unable to delete memory.'}`;
      dom.memoryStatus.classList.add('error');
    }
  }
}

async function handleClearMemory() {
  if (!window.electron?.memory) return;
  const confirmed = await showConfirmDialog('Clear all memory entries? This cannot be undone.');
  if (!confirmed) return;

  try {
    const result = await window.electron.memory.clear();
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to clear memory entries.');
    }
    await loadMemoryEntries();
  } catch (error) {
    if (dom.memoryStatus) {
      dom.memoryStatus.textContent = `Error: ${error.message || 'Unable to clear memory.'}`;
      dom.memoryStatus.classList.add('error');
    }
  }
}

async function handleToggleHook(hookName, enabled) {
  if (!hookName) return;

  try {
    const result = await window.electron.hooks.setEnabled({
      name: hookName,
      enabled: Boolean(enabled)
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to update hook state.');
    }

    appState.settings.hooks = {
      ...(appState.settings.hooks || {}),
      loaded: Array.isArray(result.hooks) ? result.hooks : (appState.settings.hooks?.loaded || [])
    };

    if (dom.hooksStatus) {
      dom.hooksStatus.textContent = `Hook '${hookName}' ${enabled ? 'enabled' : 'disabled'}.`;
      dom.hooksStatus.classList.remove('error');
    }

    renderSettings();
  } catch (error) {
    if (dom.hooksStatus) {
      dom.hooksStatus.textContent = `Error: ${error.message || 'Unable to update hook.'}`;
      dom.hooksStatus.classList.add('error');
    }
  }
}

async function handleToggleHooksGlobal(enabled) {
  try {
    const result = await window.electron.hooks.setGlobalEnabled({ enabled: Boolean(enabled) });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to update global hook setting.');
    }

    appState.settings.hooks = {
      ...(appState.settings.hooks || {}),
      enabled: Boolean(result.enabled),
      loaded: Array.isArray(result.hooks) ? result.hooks : (appState.settings.hooks?.loaded || [])
    };

    if (dom.hooksStatus) {
      dom.hooksStatus.textContent = `Hooks are now ${result.enabled ? 'enabled' : 'disabled'} globally.`;
      dom.hooksStatus.classList.remove('error');
    }

    renderSettings();
  } catch (error) {
    if (dom.hooksGlobalEnabledInput) {
      dom.hooksGlobalEnabledInput.checked = !Boolean(enabled);
    }

    if (dom.hooksStatus) {
      dom.hooksStatus.textContent = `Error: ${error.message || 'Unable to update hook setting.'}`;
      dom.hooksStatus.classList.add('error');
    }
  }
}

async function handleReloadHooks() {
  if (dom.reloadHooksBtn) dom.reloadHooksBtn.disabled = true;

  if (dom.hooksStatus) {
    dom.hooksStatus.textContent = 'Reloading hooks...';
    dom.hooksStatus.classList.remove('error');
  }

  try {
    const result = await window.electron.hooks.reload();
    appState.settings.hooks = {
      ...(appState.settings.hooks || {}),
      enabled: result?.enabled !== false,
      loaded: Array.isArray(result?.hooks) ? result.hooks : []
    };
    renderSettings();
  } catch (error) {
    if (dom.hooksStatus) {
      dom.hooksStatus.textContent = `Error: ${error.message || 'Unable to reload hooks.'}`;
      dom.hooksStatus.classList.add('error');
    }
  } finally {
    if (dom.reloadHooksBtn) dom.reloadHooksBtn.disabled = false;
  }
}

function collectTemplateVariablesFromForm() {
  return {
    name: String(dom.templateNameInput?.value || '').trim(),
    role: String(dom.templateRoleInput?.value || '').trim(),
    preferences: String(dom.templatePreferencesInput?.value || '').trim(),
    projectContext: String(dom.templateProjectContextInput?.value || '').trim()
  };
}

async function handleSaveTemplateVariables() {
  if (!dom.saveTemplateVariablesBtn) return;

  dom.saveTemplateVariablesBtn.disabled = true;
  if (dom.templateVariablesStatus) {
    dom.templateVariablesStatus.textContent = 'Saving...';
    dom.templateVariablesStatus.classList.remove('error');
  }

  try {
    const templateVariables = collectTemplateVariablesFromForm();
    const result = await window.electron.settings.saveTemplateVariables({ templateVariables });

    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save template variables.');
    }

    appState.settings.templateVariables = {
      ...(result.templateVariables || templateVariables)
    };

    if (dom.templateVariablesStatus) {
      dom.templateVariablesStatus.textContent = 'Template variables saved. New runs use updated values.';
      dom.templateVariablesStatus.classList.remove('error');
    }
  } catch (error) {
    if (dom.templateVariablesStatus) {
      dom.templateVariablesStatus.textContent = `Error: ${error.message || 'Unable to save template variables.'}`;
      dom.templateVariablesStatus.classList.add('error');
    }
  } finally {
    dom.saveTemplateVariablesBtn.disabled = false;
  }
}

function collectUserProfileFromForm() {
  const goals = String(dom.profileGoalsInput?.value || '')
    .split(/\r?\n/)
    .map((goal) => goal.trim())
    .filter(Boolean);

  const rawPreferences = String(dom.profilePreferencesInput?.value || '').trim();
  let preferences = {};
  if (rawPreferences) {
    const parsed = JSON.parse(rawPreferences);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Preferences must be valid JSON object syntax.');
    }
    preferences = parsed;
  }

  return {
    name: String(dom.profileNameInput?.value || '').trim(),
    role: String(dom.profileRoleInput?.value || '').trim(),
    goals,
    preferences,
    projectContext: String(dom.profileProjectContextInput?.value || '').trim()
  };
}

async function handleSaveUserProfile() {
  if (!dom.saveUserProfileBtn) return;

  dom.saveUserProfileBtn.disabled = true;
  if (dom.userProfileStatus) {
    dom.userProfileStatus.textContent = 'Saving...';
    dom.userProfileStatus.classList.remove('error');
  }

  try {
    const profile = collectUserProfileFromForm();
    const result = await window.electron.settings.saveUserProfile({ profile });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save user profile.');
    }

    appState.settings.userProfile = {
      ...(result.userProfile || profile)
    };

    if (dom.userProfileStatus) {
      dom.userProfileStatus.textContent = 'User profile saved. New agent runs include it in context.';
      dom.userProfileStatus.classList.remove('error');
    }
  } catch (error) {
    if (dom.userProfileStatus) {
      dom.userProfileStatus.textContent = `Error: ${error.message || 'Unable to save user profile.'}`;
      dom.userProfileStatus.classList.add('error');
    }
  } finally {
    dom.saveUserProfileBtn.disabled = false;
  }
}

function collectNotificationsFromForm() {
  const toastSeconds = Math.max(0, Number(dom.notificationsToastThresholdInput?.value || 30));
  const externalSeconds = Math.max(toastSeconds, Number(dom.notificationsExternalThresholdInput?.value || 120));

  return {
    enabled: Boolean(dom.notificationsEnabledInput?.checked),
    thresholdsMs: {
      toast: Math.round(toastSeconds * 1000),
      external: Math.round(externalSeconds * 1000)
    },
    uiToast: {
      enabled: Boolean(dom.notificationsUiToastEnabledInput?.checked)
    },
    ntfy: {
      enabled: Boolean(dom.notificationsNtfyEnabledInput?.checked),
      topic: String(dom.notificationsNtfyTopicInput?.value || '').trim()
    },
    telegram: {
      longTaskNotice: Boolean(dom.notificationsTelegramLongTaskInput?.checked)
    }
  };
}

async function handleSaveNotifications() {
  if (!dom.saveNotificationsBtn) return;

  dom.saveNotificationsBtn.disabled = true;
  if (dom.notificationsStatus) {
    dom.notificationsStatus.textContent = 'Saving...';
    dom.notificationsStatus.classList.remove('error');
  }

  try {
    const notifications = collectNotificationsFromForm();
    const result = await window.electron.settings.saveNotifications({ notifications });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save notification settings.');
    }

    appState.settings.notifications = {
      ...(result.notifications || notifications)
    };

    if (dom.notificationsStatus) {
      dom.notificationsStatus.textContent = 'Notification settings saved.';
      dom.notificationsStatus.classList.remove('error');
    }
  } catch (error) {
    if (dom.notificationsStatus) {
      dom.notificationsStatus.textContent = `Error: ${error.message || 'Unable to save notification settings.'}`;
      dom.notificationsStatus.classList.add('error');
    }
  } finally {
    dom.saveNotificationsBtn.disabled = false;
  }
}

function collectVoiceFromForm() {
  const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    enabled: Boolean(dom.voiceEnabledInput?.checked),
    speakChatResponses: Boolean(dom.voiceSpeakChatInput?.checked),
    speakAgentSummary: Boolean(dom.voiceSpeakAgentSummaryInput?.checked),
    telegramVoiceForLongResponses: Boolean(dom.voiceTelegramLongInput?.checked),
    engine: String(dom.voiceEngineInput?.value || 'system').toLowerCase() === 'elevenlabs' ? 'elevenlabs' : 'system',
    voiceId: String(dom.voiceIdInput?.value || '').trim(),
    speed: toNumber(dom.voiceSpeedInput?.value, 1),
    stability: toNumber(dom.voiceStabilityInput?.value, 0.5),
    style: toNumber(dom.voiceStyleInput?.value, 0.25),
    summaryMaxChars: Math.max(80, Math.round(toNumber(dom.voiceSummaryMaxInput?.value, 260))),
    telegramMinChars: Math.max(80, Math.round(toNumber(dom.voiceTelegramMinInput?.value, 500)))
  };
}

async function handleSaveVoiceSettings() {
  if (!dom.saveVoiceSettingsBtn) return;

  dom.saveVoiceSettingsBtn.disabled = true;
  if (dom.voiceStatus) {
    dom.voiceStatus.textContent = 'Saving voice settings...';
    dom.voiceStatus.classList.remove('error');
  }

  try {
    const voice = collectVoiceFromForm();
    const result = await window.electron.settings.saveVoice({ voice });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save voice settings.');
    }

    appState.settings.voice = {
      ...(appState.settings.voice || {}),
      ...(result.voice || voice)
    };

    if (dom.voiceStatus) {
      dom.voiceStatus.textContent = 'Voice settings saved.';
      dom.voiceStatus.classList.remove('error');
    }
  } catch (error) {
    if (dom.voiceStatus) {
      dom.voiceStatus.textContent = `Error: ${error.message || 'Unable to save voice settings.'}`;
      dom.voiceStatus.classList.add('error');
    }
  } finally {
    dom.saveVoiceSettingsBtn.disabled = false;
  }
}

async function handleSaveElevenLabsKey() {
  if (!dom.saveVoiceKeyBtn) return;

  const apiKey = String(dom.voiceElevenLabsKeyInput?.value || '').trim();
  if (!apiKey) {
    if (dom.voiceStatus) {
      dom.voiceStatus.textContent = 'Enter an ElevenLabs API key first.';
      dom.voiceStatus.classList.add('error');
    }
    return;
  }

  dom.saveVoiceKeyBtn.disabled = true;
  try {
    const result = await window.electron.settings.saveElevenLabsKey({ apiKey });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save ElevenLabs key.');
    }

    appState.settings.voice = {
      ...(appState.settings.voice || {}),
      hasElevenLabsKey: Boolean(result.hasElevenLabsKey)
    };

    if (dom.voiceElevenLabsKeyInput) {
      dom.voiceElevenLabsKeyInput.value = '';
    }

    if (dom.voiceStatus) {
      dom.voiceStatus.textContent = 'ElevenLabs API key saved securely.';
      dom.voiceStatus.classList.remove('error');
    }
  } catch (error) {
    if (dom.voiceStatus) {
      dom.voiceStatus.textContent = `Error: ${error.message || 'Unable to save ElevenLabs key.'}`;
      dom.voiceStatus.classList.add('error');
    }
  } finally {
    dom.saveVoiceKeyBtn.disabled = false;
  }
}

async function handleClearElevenLabsKey() {
  if (!dom.clearVoiceKeyBtn) return;
  const confirmed = await showConfirmDialog('Clear the saved ElevenLabs API key?');
  if (!confirmed) return;

  dom.clearVoiceKeyBtn.disabled = true;
  try {
    const result = await window.electron.settings.saveElevenLabsKey({ clear: true });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to clear ElevenLabs key.');
    }

    appState.settings.voice = {
      ...(appState.settings.voice || {}),
      hasElevenLabsKey: Boolean(result.hasElevenLabsKey)
    };

    if (dom.voiceStatus) {
      dom.voiceStatus.textContent = 'ElevenLabs API key removed.';
      dom.voiceStatus.classList.remove('error');
    }
  } catch (error) {
    if (dom.voiceStatus) {
      dom.voiceStatus.textContent = `Error: ${error.message || 'Unable to clear ElevenLabs key.'}`;
      dom.voiceStatus.classList.add('error');
    }
  } finally {
    dom.clearVoiceKeyBtn.disabled = false;
  }
}

async function handleTestVoice() {
  if (!dom.testVoiceBtn) return;

  dom.testVoiceBtn.disabled = true;
  if (dom.voiceStatus) {
    dom.voiceStatus.textContent = 'Testing voice connection...';
    dom.voiceStatus.classList.remove('error');
  }

  try {
    const settings = collectVoiceFromForm();
    const result = await window.electron.settings.testVoice({ settings });
    if (!result?.ok) {
      throw new Error(result?.error || 'Voice connection failed.');
    }

    if (dom.voiceStatus) {
      dom.voiceStatus.textContent = 'Voice connection test successful.';
      dom.voiceStatus.classList.remove('error');
    }
  } catch (error) {
    if (dom.voiceStatus) {
      dom.voiceStatus.textContent = `Error: ${error.message || 'Voice connection failed.'}`;
      dom.voiceStatus.classList.add('error');
    }
  } finally {
    dom.testVoiceBtn.disabled = false;
  }
}

// ─── Workflow Panel ───

async function loadWorkflows() {
  if (!window.electron?.workflow || !dom.workflowList) return;
  try {
    if (dom.workflowStatus) dom.workflowStatus.textContent = 'Loading...';
    const result = await window.electron.workflow.list();
    if (!result?.ok) throw new Error(result?.error || 'Failed to list workflows');
    const workflows = Array.isArray(result.workflows) ? result.workflows : [];
    if (dom.workflowStatus) {
      const running = workflows.filter(w => w.status === 'running').length;
      dom.workflowStatus.textContent = `${workflows.length} workflow(s)${running ? ` • ${running} running` : ''}`;
      dom.workflowStatus.classList.remove('error');
    }
    renderWorkflows(workflows);
  } catch (err) {
    if (dom.workflowStatus) {
      dom.workflowStatus.textContent = `Error: ${err.message}`;
      dom.workflowStatus.classList.add('error');
    }
  }
}

function renderWorkflows(workflows = []) {
  if (!dom.workflowList) return;
  dom.workflowList.innerHTML = '';
  if (workflows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No workflows yet. Enter a goal above to get started.';
    dom.workflowList.appendChild(empty);
    return;
  }
  workflows.forEach(wf => {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.workflowId = wf.id;

    const statusColors = {
      pending: '#888', running: '#4a9eff', paused: '#f0ad4e',
      completed: '#5cb85c', failed: '#d9534f', cancelled: '#888'
    };

    const header = document.createElement('div');
    header.className = 'provider-header';
    header.innerHTML = `
      <strong>${wf.goal || '(no goal)'}</strong>
      <span style="color: ${statusColors[wf.status] || '#888'}; font-size: 0.85em; margin-left: 8px;">
        ● ${wf.status}
      </span>`;

    const body = document.createElement('div');
    body.className = 'provider-message';
    const completed = (wf.tasks || []).filter(t => t.status === 'completed').length;
    const total = (wf.tasks || []).length;
    body.innerHTML = `${wf.summary || ''}<br><small>${completed}/${total} tasks complete • Created ${new Date(wf.createdAt).toLocaleString()}</small>`;

    const actions = document.createElement('div');
    actions.className = 'provider-actions';
    actions.style.marginTop = '8px';

    if (wf.status === 'paused' || wf.status === 'pending') {
      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'btn';
      resumeBtn.textContent = 'Resume';
      resumeBtn.dataset.action = 'resume-workflow';
      resumeBtn.dataset.workflowId = wf.id;
      actions.appendChild(resumeBtn);
    }
    if (wf.status === 'running') {
      const pauseBtn = document.createElement('button');
      pauseBtn.className = 'btn';
      pauseBtn.textContent = 'Pause';
      pauseBtn.dataset.action = 'pause-workflow';
      pauseBtn.dataset.workflowId = wf.id;
      actions.appendChild(pauseBtn);
    }
    if (wf.status !== 'cancelled' && wf.status !== 'completed') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.dataset.action = 'cancel-workflow';
      cancelBtn.dataset.workflowId = wf.id;
      actions.appendChild(cancelBtn);
    }
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.dataset.action = 'delete-workflow';
    deleteBtn.dataset.workflowId = wf.id;
    actions.appendChild(deleteBtn);

    // Task breakdown
    const taskList = document.createElement('div');
    taskList.style.cssText = 'margin-top: 8px; font-size: 0.85em;';
    (wf.tasks || []).forEach(task => {
      const taskEl = document.createElement('div');
      taskEl.style.cssText = 'padding: 2px 0; display: flex; align-items: center; gap: 6px;';
      const icons = { pending: '○', running: '◐', completed: '●', failed: '✗', skipped: '—' };
      const colors = { pending: '#888', running: '#4a9eff', completed: '#5cb85c', failed: '#d9534f', skipped: '#888' };
      taskEl.innerHTML = `<span style="color: ${colors[task.status] || '#888'}">${icons[task.status] || '?'}</span> ${task.title || task.id}`;
      taskList.appendChild(taskEl);
    });

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(taskList);
    card.appendChild(actions);
    dom.workflowList.appendChild(card);
  });
}

async function handlePlanWorkflow() {
  const goal = dom.workflowGoalInput?.value?.trim();
  if (!goal) {
    if (dom.workflowAddStatus) dom.workflowAddStatus.textContent = 'Please enter a goal.';
    return;
  }
  if (dom.workflowPlanBtn) dom.workflowPlanBtn.disabled = true;
  if (dom.workflowAddStatus) dom.workflowAddStatus.textContent = 'Planning...';
  try {
    const result = await window.electron.workflow.plan(goal);
    if (!result?.ok) throw new Error(result?.error || 'Planning failed');
    if (dom.workflowAddStatus) {
      dom.workflowAddStatus.textContent = `Plan ready: ${result.taskGraph.tasks.length} tasks. Use "Plan & Execute" to run it.`;
      dom.workflowAddStatus.classList.remove('error');
    }
  } catch (err) {
    if (dom.workflowAddStatus) {
      dom.workflowAddStatus.textContent = `Error: ${err.message}`;
      dom.workflowAddStatus.classList.add('error');
    }
  } finally {
    if (dom.workflowPlanBtn) dom.workflowPlanBtn.disabled = false;
  }
}

async function handlePlanAndExecuteWorkflow() {
  const goal = dom.workflowGoalInput?.value?.trim();
  if (!goal) {
    if (dom.workflowAddStatus) dom.workflowAddStatus.textContent = 'Please enter a goal.';
    return;
  }
  if (dom.workflowRunBtn) dom.workflowRunBtn.disabled = true;
  if (dom.workflowAddStatus) dom.workflowAddStatus.textContent = 'Planning and launching workflow...';
  try {
    const result = await window.electron.workflow.planAndExecute(goal, {}, true);
    if (!result?.ok) throw new Error(result?.error || 'Workflow launch failed');
    dom.workflowGoalInput.value = '';
    if (dom.workflowAddStatus) {
      dom.workflowAddStatus.textContent = `Workflow ${result.workflow.id} started.`;
      dom.workflowAddStatus.classList.remove('error');
    }
    await loadWorkflows();
  } catch (err) {
    if (dom.workflowAddStatus) {
      dom.workflowAddStatus.textContent = `Error: ${err.message}`;
      dom.workflowAddStatus.classList.add('error');
    }
  } finally {
    if (dom.workflowRunBtn) dom.workflowRunBtn.disabled = false;
  }
}

/**
 * Format a task graph as a readable markdown block and persist it to the
 * chat as an assistant message tagged with workflowScaffolding so it shows
 * up in chat exports but is filtered out of the next planner run.
 *
 * kind: 'proposed' | 'edited'
 */
async function persistProposedPlan(chatId, goal, taskGraph, kind = 'proposed') {
  if (!taskGraph || !Array.isArray(taskGraph.tasks)) return;
  const heading = kind === 'edited'
    ? '**Edited workflow plan (approved by user):**'
    : '**Proposed workflow plan:**';
  const lines = [heading, ''];
  lines.push(`Goal: ${goal}`);
  if (taskGraph.summary) lines.push(`Summary: ${taskGraph.summary}`);
  lines.push(`Tasks: ${taskGraph.tasks.length}`);
  lines.push('');
  taskGraph.tasks.forEach((t, i) => {
    const deps = Array.isArray(t.dependsOn) && t.dependsOn.length ? ` ← [${t.dependsOn.join(', ')}]` : '';
    lines.push(`${i + 1}. **${t.title || t.id}** \`${t.id}\` [${t.agentId || 'main'}]${deps}`);
    if (t.description) {
      lines.push(`   ${String(t.description).replace(/\n/g, '\n   ')}`);
    }
    lines.push('');
  });
  const text = lines.join('\n');

  // Embed the structured task graph in the message metadata so the plan can
  // be recovered from chat history if workflows/{id}.json is lost. The
  // existing `!m.workflowScaffolding` filters elsewhere still match because
  // an object is truthy.
  const scaffolding = { kind, taskGraph };

  try {
    await window.electron.chat.addMessage({
      chatId,
      sender: 'assistant',
      text,
      workflowScaffolding: scaffolding
    });
  } catch (err) {
    workflowLog.warn(`persist proposed plan failed: ${err.message}`);
  }

  const chatObj = appState.chats.find((c) => c.id === chatId);
  pushLoadedMessage(chatObj, {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sender: 'assistant',
    text,
    workflowScaffolding: scaffolding,
    timestamp: new Date().toISOString()
  });
  if (chatObj && chatId === appState.activeChatId) {
    addMessage('assistant', text);
  }
}

/**
 * Append a status message to a specific chat (not necessarily the active one).
 * Updates the chat's message array, persists, and renders inline if that chat
 * is currently active.
 */
function appendStatusToChat(chatId, text) {
  if (!chatId) return;
  const chat = appState.chats.find((c) => c.id === chatId);
  pushLoadedMessage(chat, {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sender: 'status',
    text,
    timestamp: new Date().toISOString()
  });
  if (chatId === appState.activeChatId) {
    addToolEventCompact('Workflow', { message: text }, 'info', false);
  }
  window.electron.chat.addMessage({ chatId, sender: 'status', text })
    .catch((err) => workflowLog.warn(`status persist failed: ${err.message}`));
}

/**
 * Render an in-chat, EDITABLE approval card for a proposed task graph.
 * Each task row has inputs for title, agentId, description, and dependsOn.
 * Users can delete tasks and add new ones. On approve, the task graph is
 * rebuilt from the current DOM state and passed to onApprove(editedGraph).
 */
const AGENT_CHOICES = ['main', 'code-explorer', 'code-writer', 'planner'];

function buildTaskRow(task, taskListEl) {
  const row = document.createElement('div');
  row.className = 'workflow-task-row';
  row.dataset.taskId = task.id || `task-${Math.random().toString(36).slice(2, 8)}`;
  row.style.border = '1px solid rgba(255,255,255,0.12)';
  row.style.borderRadius = '6px';
  row.style.padding = '0.6em 0.75em';
  row.style.marginBottom = '0.5em';
  row.style.background = 'rgba(255,255,255,0.02)';

  const topRow = document.createElement('div');
  topRow.style.display = 'flex';
  topRow.style.gap = '0.5em';
  topRow.style.alignItems = 'center';
  topRow.style.marginBottom = '0.35em';

  const idBadge = document.createElement('code');
  idBadge.textContent = row.dataset.taskId;
  idBadge.style.opacity = '0.6';
  idBadge.style.fontSize = '0.8em';
  idBadge.style.flexShrink = '0';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'workflow-task-title';
  titleInput.value = task.title || '';
  titleInput.placeholder = 'Task title';
  titleInput.style.flex = '1';
  titleInput.style.background = 'rgba(0,0,0,0.2)';
  titleInput.style.border = '1px solid rgba(255,255,255,0.15)';
  titleInput.style.borderRadius = '4px';
  titleInput.style.padding = '0.25em 0.5em';
  titleInput.style.color = 'inherit';
  titleInput.style.fontWeight = '600';

  const agentSelect = document.createElement('select');
  agentSelect.className = 'workflow-task-agent';
  agentSelect.style.background = 'rgba(0,0,0,0.2)';
  agentSelect.style.border = '1px solid rgba(255,255,255,0.15)';
  agentSelect.style.borderRadius = '4px';
  agentSelect.style.padding = '0.25em 0.4em';
  agentSelect.style.color = 'inherit';
  for (const choice of AGENT_CHOICES) {
    const opt = document.createElement('option');
    opt.value = choice;
    opt.textContent = choice;
    if (choice === (task.agentId || 'main')) opt.selected = true;
    agentSelect.appendChild(opt);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-sm';
  deleteBtn.title = 'Delete task';
  deleteBtn.appendChild(faIcon('fas fa-trash'));
  deleteBtn.style.background = 'transparent';
  deleteBtn.style.border = '1px solid rgba(255,255,255,0.15)';
  deleteBtn.addEventListener('click', () => {
    row.remove();
  });

  topRow.appendChild(idBadge);
  topRow.appendChild(titleInput);
  topRow.appendChild(agentSelect);
  topRow.appendChild(deleteBtn);
  row.appendChild(topRow);

  const descInput = document.createElement('textarea');
  descInput.className = 'workflow-task-desc';
  descInput.value = task.description || '';
  descInput.placeholder = 'Task description (what the executing agent should do)';
  descInput.rows = Math.max(2, Math.min(8, (task.description || '').split('\n').length + 1));
  descInput.style.width = '100%';
  descInput.style.background = 'rgba(0,0,0,0.2)';
  descInput.style.border = '1px solid rgba(255,255,255,0.15)';
  descInput.style.borderRadius = '4px';
  descInput.style.padding = '0.3em 0.5em';
  descInput.style.color = 'inherit';
  descInput.style.fontFamily = 'inherit';
  descInput.style.fontSize = '0.9em';
  descInput.style.marginBottom = '0.35em';
  descInput.style.resize = 'vertical';
  row.appendChild(descInput);

  const depsWrap = document.createElement('div');
  depsWrap.style.display = 'flex';
  depsWrap.style.alignItems = 'center';
  depsWrap.style.gap = '0.5em';
  depsWrap.style.fontSize = '0.85em';

  const depsLabel = document.createElement('span');
  depsLabel.textContent = 'Depends on:';
  depsLabel.style.opacity = '0.7';
  depsLabel.style.flexShrink = '0';

  const depsInput = document.createElement('input');
  depsInput.type = 'text';
  depsInput.className = 'workflow-task-deps';
  depsInput.value = Array.isArray(task.dependsOn) ? task.dependsOn.join(', ') : '';
  depsInput.placeholder = 'task-1, task-2 (comma-separated task IDs)';
  depsInput.style.flex = '1';
  depsInput.style.background = 'rgba(0,0,0,0.2)';
  depsInput.style.border = '1px solid rgba(255,255,255,0.15)';
  depsInput.style.borderRadius = '4px';
  depsInput.style.padding = '0.2em 0.4em';
  depsInput.style.color = 'inherit';
  depsInput.style.fontFamily = 'monospace';

  depsWrap.appendChild(depsLabel);
  depsWrap.appendChild(depsInput);
  row.appendChild(depsWrap);

  // Stash the original task so fields we don't edit (priority, tools,
  // preferredModel, estimatedComplexity) survive the round trip.
  row._original = task;

  return row;
}

function rebuildTaskGraphFromDOM(originalGraph, taskListEl) {
  const rows = taskListEl.querySelectorAll('.workflow-task-row');
  const tasks = [];
  for (const row of rows) {
    const id = row.dataset.taskId;
    const title = row.querySelector('.workflow-task-title').value.trim();
    const agentId = row.querySelector('.workflow-task-agent').value;
    const description = row.querySelector('.workflow-task-desc').value.trim();
    const depsRaw = row.querySelector('.workflow-task-deps').value.trim();
    const dependsOn = depsRaw
      ? depsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    const original = row._original || {};
    tasks.push({
      ...original,
      id,
      title: title || id,
      description: description || title || id,
      agentId: agentId || 'main',
      dependsOn
    });
  }
  return {
    ...originalGraph,
    tasks,
    estimatedTotalSteps: tasks.length
  };
}

function showWorkflowApprovalCard(taskGraph, { onApprove, onCancel }) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant prompt-message';

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';
  messageContent.style.maxWidth = '100%';

  const title = document.createElement('p');
  title.innerHTML = `<strong>Proposed workflow — review &amp; edit before running</strong>`;
  messageContent.appendChild(title);

  if (taskGraph.summary) {
    const summary = document.createElement('p');
    summary.textContent = taskGraph.summary;
    summary.style.opacity = '0.85';
    summary.style.fontSize = '0.9em';
    messageContent.appendChild(summary);
  }

  const taskList = document.createElement('div');
  taskList.className = 'workflow-task-list';
  taskList.style.margin = '0.5em 0 0.5em 0';

  for (const t of taskGraph.tasks) {
    taskList.appendChild(buildTaskRow(t, taskList));
  }
  messageContent.appendChild(taskList);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-sm';
  addBtn.appendChild(faIcon('fas fa-plus'));
  addBtn.appendChild(document.createTextNode(' Add task'));
  addBtn.style.background = 'transparent';
  addBtn.style.border = '1px dashed rgba(255,255,255,0.25)';
  addBtn.style.width = '100%';
  addBtn.style.padding = '0.5em';
  addBtn.style.marginBottom = '0.5em';
  addBtn.addEventListener('click', () => {
    const newId = `task-${Math.random().toString(36).slice(2, 8)}`;
    taskList.appendChild(buildTaskRow({
      id: newId,
      title: '',
      description: '',
      agentId: 'main',
      dependsOn: [],
      priority: 999,
      estimatedComplexity: 'medium'
    }, taskList));
  });
  messageContent.appendChild(addBtn);

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-danger btn-sm';
  cancelBtn.appendChild(faIcon('fas fa-ban'));
  cancelBtn.appendChild(document.createTextNode(' Cancel'));

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'btn btn-primary btn-sm';
  approveBtn.appendChild(faIcon('fas fa-play'));
  approveBtn.appendChild(document.createTextNode(' Approve & Run'));

  let decided = false;
  const finish = (approved) => {
    if (decided) return;
    const editedGraph = approved ? rebuildTaskGraphFromDOM(taskGraph, taskList) : null;
    if (approved && editedGraph.tasks.length === 0) {
      // Refuse — keep the card open
      alert('Cannot approve an empty task graph. Add at least one task or cancel.');
      return;
    }
    decided = true;
    // Freeze the editable fields so they look like a snapshot
    taskList.querySelectorAll('input, textarea, select, button').forEach((el) => {
      el.disabled = true;
    });
    addBtn.disabled = true;
    actions.innerHTML = '';
    const result = document.createElement('p');
    result.className = approved ? 'prompt-result-approved' : 'prompt-result-denied';
    result.textContent = approved
      ? `Approved — launching ${editedGraph.tasks.length} task(s)…`
      : 'Cancelled';
    actions.appendChild(result);
    if (approved) onApprove?.(editedGraph); else onCancel?.();
  };

  cancelBtn.addEventListener('click', () => finish(false));
  approveBtn.addEventListener('click', () => finish(true));

  actions.appendChild(cancelBtn);
  actions.appendChild(approveBtn);
  messageContent.appendChild(actions);
  messageDiv.appendChild(messageContent);
  dom.chatMessages.appendChild(messageDiv);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

/**
 * Called from the in-chat "Plan & Execute" button. Flow:
 *   1. Collect goal (textarea, else last user message)
 *   2. Gather chat history + workingDirectory from the active chat
 *   3. Call workflow.plan() — the planner explores the project dir and
 *      returns a task graph
 *   4. Render an approval card inline; on approve, create + run the workflow
 */
async function handleChatPlanAndExecute() {
  const chatId = appState.activeChatId;
  if (!chatId) {
    addStatusMessage('Open a chat first before launching a workflow.');
    return;
  }
  const chat = appState.chats.find((c) => c.id === chatId);
  if (!chat) {
    addStatusMessage('Active chat not found.');
    return;
  }

  // Goal source: textarea ONLY. If empty, prompt explicitly. We deliberately
  // do NOT fall back to the last user message — when users paste large context
  // documents, "last user message" becomes the entire document, which is
  // never a goal. The chat context is still passed to the planner as history
  // regardless, so the goal can be short and focused.
  let goal = (dom.userInput?.value || '').trim();
  if (!goal) {
    const entered = window.prompt(
      'What should the planner do? (short, focused goal — e.g. "take Funnel-OS from 6/9 to 9/9")\n\nThe whole chat will be passed as context automatically.'
    );
    goal = (entered || '').trim();
  }
  if (!goal) {
    addStatusMessage('Plan & Execute cancelled — no goal provided.');
    return;
  }

  // Post the goal as a real user message in the chat BEFORE doing anything
  // else — including the working-directory check. This guarantees the user's
  // typed goal is never lost to a validation branch, and makes clicking the
  // button always feel like "send this as a workflow goal".
  try {
    await window.electron.chat.addMessage({ chatId, sender: 'user', text: goal });
  } catch (err) {
    workflowLog.warn(`goal persist failed: ${err.message}`);
  }
  const goalMsgId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const goalMsg = {
    id: goalMsgId,
    sender: 'user',
    text: goal,
    timestamp: new Date().toISOString()
  };
  pushLoadedMessage(chat, goalMsg);
  if (chatId === appState.activeChatId) {
    addMessage('user', goal);
  }

  // Clear the textarea now that the goal has been captured and displayed.
  if (dom.userInput) dom.userInput.value = '';

  // Working directory is required for a meaningful workflow. If the chat
  // doesn't have one set, abort cleanly with an in-chat notification — do
  // NOT open a popup. The user's goal is already persisted above, so they
  // can click the folder-icon button in the chat header to set a working
  // directory and then click Plan & Execute again.
  const workingDirectory = chat.workingDirectory || null;
  if (!workingDirectory) {
    appendStatusToChat(
      chatId,
      'Plan & Execute needs a working directory for this chat. Click the folder icon in the chat header to set one, then click Plan & Execute again — your goal is saved above.'
    );
    return;
  }

  // Build chat history for the planner — exclude noise that pollutes
  // successive runs in the same chat:
  //   1. status/toolUse/toolResult events (via sender filter)
  //   2. messages tagged with workflowScaffolding (my own diagnostic injects)
  //   3. prior untagged planner diagnostic output (content heuristic — matches
  //      earlier scaffolding injected before the tag existed)
  //   4. the goal message we just posted (don't double-include it)
  const isPriorPlannerDiagnostic = (text) =>
    typeof text === 'string' &&
    text.trim().startsWith('**Planner response (no task graph produced):**');
  const chatMessages = (chat.messages || [])
    .filter((m) => m.sender === 'user' || m.sender === 'assistant')
    .filter((m) => !m.workflowScaffolding)
    .filter((m) => !isPriorPlannerDiagnostic(m.text))
    .filter((m) => m.id !== goalMsgId)
    .map((m) => ({ sender: m.sender, text: m.text || '' }))
    .filter((m) => m.text.trim().length > 0);

  if (dom.chatPlanBtn) dom.chatPlanBtn.disabled = true;
  const contextChars = chatMessages.reduce((n, m) => n + (m.text?.length || 0), 0);
  appendStatusToChat(
    chatId,
    `Planning workflow (${chatMessages.length} context msgs, ~${Math.round(contextChars / 4)} tokens) for goal: ${goal.slice(0, 120)}${goal.length > 120 ? '…' : ''}`
  );
  if (workingDirectory) {
    appendStatusToChat(chatId, `Planner is exploring ${workingDirectory}…`);
  }

  // Insert a streaming placeholder so the user sees the same blinking
  // indicator the normal chat path shows — this reuses the existing
  // .message.streaming CSS (blinking ▊ cursor via ::after).
  const plannerIndicator = document.createElement('div');
  plannerIndicator.className = 'message assistant streaming';
  plannerIndicator.dataset.plannerIndicator = 'true';
  const plannerContent = document.createElement('div');
  plannerContent.className = 'message-content';
  plannerContent.textContent = 'Planner is exploring and drafting a task graph…';
  plannerIndicator.appendChild(plannerContent);
  if (chatId === appState.activeChatId) {
    dom.chatMessages.appendChild(plannerIndicator);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  }
  const removePlannerIndicator = () => {
    if (plannerIndicator.parentNode) plannerIndicator.parentNode.removeChild(plannerIndicator);
  };
  setResponseActive(true, chatId);

  try {
    const result = await window.electron.workflow.plan(goal, {
      chatId,
      workingDirectory,
      chatMessages
    });
    if (!result?.ok) {
      removePlannerIndicator();
      // If the planner returned raw content (a clarifying question, refusal,
      // or malformed JSON), show it as an assistant message so the user can
      // see what the planner actually said instead of a cryptic error.
      // Tag it with workflowScaffolding so the next Plan & Execute run in
      // the same chat does NOT re-feed this output back to the planner.
      if (typeof result?.plannerOutput === 'string' && result.plannerOutput.trim()) {
        appendStatusToChat(chatId, `Planner did not produce a task graph: ${result.error}`);
        const diagnosticText = `**Planner response (no task graph produced):**\n\n${result.plannerOutput}`;
        await window.electron.chat.addMessage({
          chatId,
          sender: 'assistant',
          text: diagnosticText,
          workflowScaffolding: true
        });
        const chatObj = appState.chats.find((c) => c.id === chatId);
        pushLoadedMessage(chatObj, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          sender: 'assistant',
          text: diagnosticText,
          workflowScaffolding: true,
          timestamp: new Date().toISOString()
        });
        if (chatObj && chatId === appState.activeChatId) renderChatMessages();
        return;
      }
      throw new Error(result?.error || 'Planning failed');
    }
    const taskGraph = result.taskGraph;
    if (!taskGraph || !Array.isArray(taskGraph.tasks) || taskGraph.tasks.length === 0) {
      throw new Error('Planner returned an empty task graph');
    }

    removePlannerIndicator();

    // Persist the proposed task graph to the chat so it shows up in exports
    // even if the user later cancels or edits it. Tagged with
    // workflowScaffolding so the next Plan & Execute run in this chat does
    // NOT re-feed it to the planner (prevents pollution from stale proposals).
    await persistProposedPlan(chatId, goal, taskGraph, 'proposed');

    showWorkflowApprovalCard(taskGraph, {
      onApprove: async (editedGraph) => {
        try {
          // If the user edited anything, log the edited version too so the
          // export shows both what the planner proposed AND what actually ran.
          if (JSON.stringify(editedGraph?.tasks) !== JSON.stringify(taskGraph.tasks)) {
            await persistProposedPlan(chatId, goal, editedGraph, 'edited');
          }
          const createRes = await window.electron.workflow.create(editedGraph, { chatId, workingDirectory });
          if (!createRes?.ok) throw new Error(createRes?.error || 'Workflow creation failed');
          const wf = createRes.workflow;
          appendStatusToChat(chatId, `Workflow ${wf.id} created — ${wf.tasks.length} task(s). Starting…`);
          const runRes = await window.electron.workflow.run(wf.id);
          if (!runRes?.ok) throw new Error(runRes?.error || 'Workflow run failed to start');
          await loadWorkflows();
        } catch (err) {
          appendStatusToChat(chatId, `Workflow launch error: ${err.message}`);
        }
      },
      onCancel: () => {
        appendStatusToChat(chatId, 'Workflow plan cancelled (proposed plan is preserved in the chat above).');
      }
    });
  } catch (err) {
    removePlannerIndicator();
    const msg = String(err?.message || err || '').toLowerCase();
    if (msg.includes('overloaded')) {
      appendStatusToChat(chatId, `Planning error: the model provider is overloaded right now. The agent loop already retried a few times with backoff. Wait a minute and click Plan & Execute again — your goal is saved above.`);
    } else if (msg.includes('rate limit') || msg.includes('429')) {
      appendStatusToChat(chatId, `Planning error: rate-limited by the model provider. Wait a moment and click Plan & Execute again.`);
    } else {
      appendStatusToChat(chatId, `Planning error: ${err.message}`);
    }
  } finally {
    removePlannerIndicator();
    setResponseActive(false, chatId);
    if (dom.chatPlanBtn) dom.chatPlanBtn.disabled = false;
  }
}

// ─── System Apps Panel ───

async function loadSystemApps() {
  if (!window.electron?.apps || !dom.appsList) return;
  try {
    if (dom.appsStatus) dom.appsStatus.textContent = 'Loading...';
    const result = await window.electron.apps.list();
    if (!result?.ok) throw new Error(result?.error || 'Failed to list apps');
    const apps = Array.isArray(result.apps) ? result.apps : [];
    if (dom.appsStatus) {
      const custom = apps.filter(a => a.custom).length;
      dom.appsStatus.textContent = `${apps.length} app(s) detected${custom ? ` (${custom} custom)` : ''}.`;
      dom.appsStatus.classList.remove('error');
    }
    renderSystemApps(apps);
  } catch (err) {
    if (dom.appsStatus) {
      dom.appsStatus.textContent = `Error: ${err.message}`;
      dom.appsStatus.classList.add('error');
    }
  }
}

function renderSystemApps(apps = []) {
  if (!dom.appsList) return;
  dom.appsList.innerHTML = '';

  if (apps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No apps detected. Click "Re-scan System" to discover installed applications.';
    dom.appsList.appendChild(empty);
    return;
  }

  // Group by category
  const byCategory = {};
  apps.forEach(app => {
    const cat = app.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(app);
  });

  for (const [category, catApps] of Object.entries(byCategory)) {
    const header = document.createElement('div');
    header.style.cssText = 'font-weight: bold; margin-top: 12px; margin-bottom: 4px; text-transform: capitalize; color: var(--text-secondary);';
    header.textContent = category;
    dom.appsList.appendChild(header);

    catApps.forEach(app => {
      const card = document.createElement('div');
      card.className = 'provider-card';
      card.dataset.appId = app.id;

      const headerEl = document.createElement('div');
      headerEl.className = 'provider-header';
      headerEl.innerHTML = `<strong>${app.id}</strong>${app.custom ? ' <span style="color: #4a9eff; margin-left: 8px;">custom</span>' : ''}`;

      const body = document.createElement('div');
      body.className = 'provider-message';
      body.innerHTML = `${app.description || ''}<br><span style="color: var(--text-secondary);">Launch: <code>${app.launchCmd}</code></span>`;

      if (app.capabilities && app.capabilities.length) {
        const caps = document.createElement('div');
        caps.style.cssText = 'margin-top: 4px; color: var(--text-secondary);';
        caps.textContent = `Capabilities: ${app.capabilities.join(', ')}`;
        body.appendChild(caps);
      }

      card.appendChild(headerEl);
      card.appendChild(body);

      if (app.custom) {
        const actions = document.createElement('div');
        actions.className = 'provider-actions';
        actions.style.marginTop = '6px';
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn btn-danger';
        removeBtn.textContent = 'Remove';
        removeBtn.dataset.action = 'remove-app';
        removeBtn.dataset.appId = app.id;
        actions.appendChild(removeBtn);
        card.appendChild(actions);
      }

      dom.appsList.appendChild(card);
    });
  }
}

async function handleRescanApps() {
  if (dom.appsRescanBtn) dom.appsRescanBtn.disabled = true;
  if (dom.appsStatus) dom.appsStatus.textContent = 'Scanning system for installed apps...';
  try {
    const result = await window.electron.apps.rescan();
    if (!result?.ok) throw new Error(result?.error || 'Rescan failed');
    const apps = Array.isArray(result.apps) ? result.apps : [];
    if (dom.appsStatus) {
      const custom = apps.filter(a => a.custom).length;
      dom.appsStatus.textContent = `Re-scan complete: ${apps.length} app(s) found${custom ? ` (${custom} custom)` : ''}.`;
      dom.appsStatus.classList.remove('error');
    }
    renderSystemApps(apps);
  } catch (err) {
    if (dom.appsStatus) {
      dom.appsStatus.textContent = `Error: ${err.message}`;
      dom.appsStatus.classList.add('error');
    }
  } finally {
    if (dom.appsRescanBtn) dom.appsRescanBtn.disabled = false;
  }
}

async function handleAddCustomApp() {
  const id = dom.appAddId?.value?.trim();
  const description = dom.appAddDescription?.value?.trim();
  const launchCmd = dom.appAddLaunch?.value?.trim();
  const category = dom.appAddCategory?.value || 'custom';
  const capabilitiesRaw = dom.appAddCapabilities?.value?.trim() || '';

  if (!id) {
    if (dom.appAddStatus) { dom.appAddStatus.textContent = 'App ID is required.'; dom.appAddStatus.classList.add('error'); }
    return;
  }
  if (!launchCmd) {
    if (dom.appAddStatus) { dom.appAddStatus.textContent = 'Launch command is required.'; dom.appAddStatus.classList.add('error'); }
    return;
  }

  const capabilities = capabilitiesRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (dom.appAddBtn) dom.appAddBtn.disabled = true;
  try {
    const result = await window.electron.apps.add({
      id,
      description: description || id,
      launchCmd,
      category,
      capabilities
    });
    if (!result?.ok) throw new Error(result?.error || 'Failed to add app');

    // Clear form
    if (dom.appAddId) dom.appAddId.value = '';
    if (dom.appAddDescription) dom.appAddDescription.value = '';
    if (dom.appAddLaunch) dom.appAddLaunch.value = '';
    if (dom.appAddCapabilities) dom.appAddCapabilities.value = '';
    if (dom.appAddStatus) {
      dom.appAddStatus.textContent = `Added "${id}" successfully.`;
      dom.appAddStatus.classList.remove('error');
    }
    await loadSystemApps();
  } catch (err) {
    if (dom.appAddStatus) {
      dom.appAddStatus.textContent = `Error: ${err.message}`;
      dom.appAddStatus.classList.add('error');
    }
  } finally {
    if (dom.appAddBtn) dom.appAddBtn.disabled = false;
  }
}

// ─── End System Apps Panel ───

// ─── End Workflow Panel ───

async function loadCronJobs() {
  if (!window.electron?.cron || !dom.cronList) return;

  try {
    if (dom.cronStatus) dom.cronStatus.textContent = 'Loading scheduler status...';

    const [listResult, statusResult] = await Promise.all([
      window.electron.cron.list(),
      window.electron.cron.status()
    ]);

    if (!listResult?.ok) throw new Error(listResult?.error || 'Failed to list jobs');
    if (!statusResult?.ok) throw new Error(statusResult?.error || 'Failed to get status');

    appState.settings.cronJobs = Array.isArray(listResult.jobs) ? listResult.jobs : [];

    if (dom.cronStatus) {
      const stats = statusResult.status || {};
      dom.cronStatus.textContent = `Scheduler: ${stats.running ? 'Running' : 'Stopped'} • ${stats.activeJobs} active / ${stats.totalJobs} total jobs.`;
      dom.cronStatus.classList.remove('error');
    }

    renderCronJobs(appState.settings.cronJobs);
  } catch (err) {
    if (dom.cronStatus) {
      dom.cronStatus.textContent = `Error: ${err.message}`;
      dom.cronStatus.classList.add('error');
    }
  }
}

function renderCronJobs(jobs = []) {
  if (!dom.cronList) return;
  dom.cronList.innerHTML = '';

  if (jobs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No cron jobs configured.';
    dom.cronList.appendChild(empty);
    return;
  }

  jobs.forEach(job => {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.jobId = job.id;

    const header = document.createElement('div');
    header.className = 'provider-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'provider-title-wrap';

    const title = document.createElement('div');
    title.className = 'provider-title';
    title.textContent = `Job: ${job.id}`;

    const meta = document.createElement('div');
    meta.className = 'provider-message';
    const scheduleDesc = job.schedule?.kind === 'at' ? `At ${job.schedule.at}` :
                         job.schedule?.kind === 'every' ? `Every ${job.schedule.everyMs}ms` :
                         job.schedule?.kind === 'cron' ? `Cron ${job.schedule.expr}` : 'Unknown schedule';
    meta.textContent = `Target: ${job.payload?.sessionTarget || 'local'} • ${scheduleDesc}`;

    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    const status = document.createElement('span');
    status.className = 'provider-status';
    if (job.enabled !== false) {
      status.classList.add('ok');
      status.textContent = 'Enabled';
    } else {
      status.classList.add('error');
      status.textContent = 'Disabled';
    }

    header.appendChild(titleWrap);
    header.appendChild(status);

    const body = document.createElement('div');
    body.className = 'provider-message';
    body.textContent = job.payload?.message || '(no message)';

    const stats = document.createElement('div');
    stats.className = 'provider-message';
    stats.textContent = `Errors: ${job.state?.consecutiveErrors || 0} • Next Run: ${job.nextRunAt ? formatTimestamp(job.nextRunAt) : 'None'}`;

    const actions = document.createElement('div');
    actions.className = 'provider-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.appendChild(faIcon(job.enabled !== false ? 'fas fa-toggle-on' : 'fas fa-toggle-off'));
    toggleBtn.appendChild(document.createTextNode(job.enabled !== false ? ' Disable' : ' Enable'));
    toggleBtn.className = job.enabled !== false ? 'btn btn-danger' : 'btn btn-primary';
    toggleBtn.dataset.action = 'toggle-cron';
    toggleBtn.dataset.jobId = job.id;
    toggleBtn.dataset.nextEnabled = job.enabled !== false ? 'false' : 'true';

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'btn';
    runBtn.appendChild(faIcon('fas fa-play'));
    runBtn.appendChild(document.createTextNode(' Run Now'));
    runBtn.dataset.action = 'run-cron';
    runBtn.dataset.jobId = job.id;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger';
    delBtn.appendChild(faIcon('fas fa-trash'));
    delBtn.appendChild(document.createTextNode(' Delete'));
    delBtn.dataset.action = 'delete-cron';
    delBtn.dataset.jobId = job.id;

    actions.appendChild(toggleBtn);
    actions.appendChild(runBtn);
    actions.appendChild(delBtn);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(stats);
    card.appendChild(actions);

    dom.cronList.appendChild(card);
  });
}

async function handleToggleCronJob(jobId, enabled) {
  try {
    const result = await window.electron.cron.update({ id: jobId, patch: { enabled } });
    if (!result?.ok) throw new Error(result?.error || 'Failed to update job');
    await loadCronJobs();
  } catch (err) {
    if (dom.cronStatus) {
      dom.cronStatus.textContent = `Error: ${err.message}`;
      dom.cronStatus.classList.add('error');
    }
  }
}

async function handleRunCronJob(jobId) {
  try {
    if (dom.cronStatus) dom.cronStatus.textContent = `Running job ${jobId}...`;
    const result = await window.electron.cron.run({ id: jobId });
    if (!result?.ok) throw new Error(result?.result?.error || result?.error || 'Job failed');
    await loadCronJobs();
    if (dom.cronStatus) {
      dom.cronStatus.textContent = `Job ${jobId} ran successfully.`;
      dom.cronStatus.classList.remove('error');
    }
  } catch (err) {
    if (dom.cronStatus) {
      dom.cronStatus.textContent = `Run Error: ${err.message}`;
      dom.cronStatus.classList.add('error');
    }
  }
}

async function handleDeleteCronJob(jobId) {
  if (!await showConfirmDialog(`Delete cron job ${jobId}?`)) return;
  try {
    const result = await window.electron.cron.remove({ id: jobId });
    if (!result?.ok) throw new Error(result?.error || 'Failed to delete job');
    await loadCronJobs();
  } catch (err) {
    if (dom.cronStatus) {
      dom.cronStatus.textContent = `Delete Error: ${err.message}`;
      dom.cronStatus.classList.add('error');
    }
  }
}

async function handleAddCronJob() {
  if (!dom.cronAddBtn) return;
  dom.cronAddBtn.disabled = true;

  try {
    const message = dom.cronAddMessageInput?.value?.trim();
    const sessionTarget = dom.cronAddTargetInput?.value?.trim();
    const kind = dom.cronAddKindInput?.value;
    const value = dom.cronAddValueInput?.value?.trim();

    if (!message || !value) {
      throw new Error('Message and schedule value are required.');
    }

    const schedule = { kind };
    if (kind === 'every') {
      const ms = parseInt(value, 10);
      if (isNaN(ms) || ms < 1000) throw new Error('Interval must be a number >= 1000 (ms).');
      schedule.everyMs = ms;
    } else if (kind === 'cron') {
      schedule.expr = value;
    } else if (kind === 'at') {
      schedule.at = value;
    }

    const payload = {
      schedule,
      payload: {
        sessionTarget: sessionTarget || undefined,
        message
      }
    };

    const result = await window.electron.cron.add(payload);
    if (!result?.ok) throw new Error(result?.error || 'Failed to add job.');

    if (dom.cronAddMessageInput) dom.cronAddMessageInput.value = '';
    if (dom.cronAddTargetInput) dom.cronAddTargetInput.value = '';
    if (dom.cronAddValueInput) dom.cronAddValueInput.value = '';

    if (dom.cronAddStatus) {
      dom.cronAddStatus.textContent = 'Job added successfully.';
      dom.cronAddStatus.classList.remove('error');
    }

    await loadCronJobs();
  } catch (err) {
    if (dom.cronAddStatus) {
      dom.cronAddStatus.textContent = `Error: ${err.message}`;
      dom.cronAddStatus.classList.add('error');
    }
  } finally {
    dom.cronAddBtn.disabled = false;
  }
}

async function loadSettings() {
  try {
    appState.settings = unwrapIpcResult(await window.electron.settings.load(), 'Unable to load settings.');
    if (!appState.settings.providers || Object.keys(appState.settings.providers).length === 0) {
      setProviderListFallback('No providers returned from settings. Please restart the app.');
      return;
    }
    renderSettings();
    await loadSkillSettingsTabs();
    await loadMemoryEntries();
    await loadCronJobs();
    loadPermissionRules().catch(() => {});
    loadWorkflows().catch(() => {});
    loadModelProfiles().catch(() => {});
    loadSystemApps().catch(() => {});
    loadWebhookList().catch(() => {});
    loadMeshStatus().catch(() => {});
    loadChannelAccess().catch(() => {});
    loadModelsCatalogStatus().catch(() => {});
  } catch (error) {
    setProviderListFallback(`Unable to load provider settings: ${error.message || 'Unknown error'}`);
  }
}

function setProviderListFallback(message) {
  dom.providerList.innerHTML = '';
  const fallback = document.createElement('div');
  fallback.className = 'provider-message error';
  fallback.textContent = message;
  dom.providerList.appendChild(fallback);
}

function getTokenInput(providerKey) {
  return dom.providerList.querySelector(`input[data-provider="${providerKey}"]`);
}

function validateToken(providerKey, token) {
  if (!token || token.trim().length < 8) {
    return 'Token is required and must be at least 8 characters.';
  }

  if (providerKey === 'openai' && !token.startsWith('sk-')) {
    return 'OpenAI tokens typically start with "sk-".';
  }

  if (providerKey === 'anthropic' && !token.startsWith('sk-ant-')) {
    return 'Anthropic tokens typically start with "sk-ant-".';
  }

  if (providerKey === 'copilot' && !token.startsWith('ghp_')) {
    return 'GitHub tokens typically start with "ghp_".';
  }

  return null;
}

function setProviderMessage(providerKey, message, isError = false) {
  const card = dom.providerList.querySelector(`.provider-card[data-provider="${providerKey}"]`);
  if (!card) return;
  const messageEl = card.querySelector('.provider-message');
  if (!messageEl) return;
  messageEl.textContent = message;
  messageEl.classList.toggle('error', isError);
}

function updateProviderStatus(providerKey, status) {
  appState.settings.providers[providerKey] = {
    ...appState.settings.providers[providerKey],
    status
  };
  renderSettings();
}

/* --- Models M1: catalog status, Test all, the Ollama address --- */

function providerStatusText(status) {
  if (status?.ok) return { text: 'Connected', cls: 'ok' };
  if (status?.authFailed) return { text: 'Key rejected', cls: 'error' };
  if (status) return { text: 'Error', cls: 'error' };
  return { text: 'Not tested', cls: '' };
}

// A background retest (key saved, 401 during use) updates the badge only, so
// a message the owner is reading on the card stays.
function updateProviderStatusBadge(providerKey) {
  const card = dom.providerList?.querySelector(`.provider-card[data-provider="${providerKey}"]`);
  const badge = card?.querySelector('.provider-status');
  if (!badge) return;
  const status = appState.settings?.providers?.[providerKey]?.status || null;
  const view = providerStatusText(status);
  badge.classList.remove('ok', 'error');
  if (view.cls) badge.classList.add(view.cls);
  badge.textContent = view.text;
  badge.title = status?.checkedAt ? `Last tested ${new Date(status.checkedAt).toLocaleString()}` : '';
}

function formatCatalogStatus(status) {
  if (!status) return 'Catalog status unavailable.';
  const when = status.fetchedAt || status.snapshotDate;
  const date = when ? new Date(when).toLocaleDateString() : 'unknown date';
  const source = { live: 'models.dev, fetched now', cache: 'cached copy of models.dev', snapshot: 'bundled snapshot' }[status.source] || String(status.source);
  const stale = status.stale ? ' This copy is old: press Refresh now, or check the network.' : '';
  return `Source: ${source}, ${date}. ${status.models} models.${stale}`;
}

function showCatalogStatus(status) {
  if (!dom.modelsCatalogStatus) return;
  dom.modelsCatalogStatus.textContent = formatCatalogStatus(status);
  dom.modelsCatalogStatus.classList.toggle('error', Boolean(status?.stale));
}

async function loadModelsCatalogStatus() {
  if (!dom.modelsCatalogStatus || !window.electron?.models) return;
  try {
    const result = unwrapIpcResult(await window.electron.models.status(), 'Unable to read the catalog.');
    showCatalogStatus(result.catalog);
  } catch (err) {
    dom.modelsCatalogStatus.textContent = err.message;
    dom.modelsCatalogStatus.classList.add('error');
  }
}

/* --- Models tab: profiles and the catalog (spec 2026-09-27 §11) --- */

const MODEL_ROLE_LABELS = {
  main: 'Main: answers you in chats and cases',
  worker: 'Worker: agents and delegated work',
  utility: 'Utility: small jobs such as case orientation and classification',
  vision: 'Vision (optional): reading images and scanned pages',
  imageGeneration: 'Image generation (optional)'
};
const MODEL_ROLE_ORDER = ['main', 'worker', 'utility', 'vision', 'imageGeneration'];
const MODEL_ROLE_NEEDS = { vision: { imageInput: true } };
const modelsTabLog = createLogger('models-tab');
let profileDraft = null;

function formatModelPrice(cost) {
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') return 'unpriced';
  return `$${cost.input} in / $${cost.output} out per M`;
}

function formatContext(tokens) {
  if (!Number.isFinite(tokens)) return '';
  return tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M context` : `${Math.round(tokens / 1000)}K context`;
}

function setModelsStatus(text, isError = false) {
  if (!dom.modelsProfilesStatus) return;
  dom.modelsProfilesStatus.textContent = text;
  dom.modelsProfilesStatus.classList.toggle('error', Boolean(isError));
}

async function loadModelProfiles() {
  if (!dom.modelsProfileList || !window.electron?.models?.profiles) return;
  try {
    const result = unwrapIpcResult(await window.electron.models.profiles(), 'Unable to load the model profiles.');
    appState.modelProfiles = { profiles: result.profiles || [], broken: result.broken || [], defaultProfileId: result.defaultProfileId || null, customRoles: result.customRoles || [] };
    renderModelProfileList();
    renderCustomRoles();
  } catch (err) {
    setModelsStatus(err.message, true);
  }
}

function renderModelProfileList() {
  const list = dom.modelsProfileList;
  if (!list) return;
  list.textContent = '';
  const { profiles = [], broken = [], defaultProfileId = null } = appState.modelProfiles || {};
  // A stored profile that fails to parse is kept as stored and shown here
  // as broken, with the reason; every string goes in through textContent.
  for (const entry of broken) {
    const card = document.createElement('div');
    card.className = 'provider-card models-profile-card models-profile-broken';
    const header = document.createElement('div');
    header.className = 'provider-header';
    const title = document.createElement('div');
    title.className = 'provider-title';
    title.textContent = entry.name || entry.id || `Stored profile ${Number(entry.index) + 1}`;
    header.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'models-broken-badge';
    badge.textContent = 'Broken';
    header.appendChild(badge);
    card.appendChild(header);
    const reason = document.createElement('div');
    reason.className = 'provider-message error';
    reason.textContent = `This stored profile cannot be read: ${entry.reason || 'unknown reason'} It is kept as stored and not used.`;
    card.appendChild(reason);
    list.appendChild(card);
  }
  if (!profiles.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No profiles yet. Create one to choose the models King Louie uses.';
    list.appendChild(empty);
    return;
  }
  for (const profile of profiles) {
    const card = document.createElement('div');
    card.className = 'provider-card models-profile-card';
    card.dataset.profileId = profile.id;

    const header = document.createElement('div');
    header.className = 'provider-header';
    const title = document.createElement('div');
    title.className = 'provider-title';
    title.textContent = profile.name;
    header.appendChild(title);
    if (profile.id === defaultProfileId) {
      const badge = document.createElement('span');
      badge.className = 'active-provider-badge';
      badge.textContent = 'Default';
      header.appendChild(badge);
    }
    card.appendChild(header);

    const summary = document.createElement('div');
    summary.className = 'provider-message';
    const mainNames = (profile.roles?.main || []).map((e) => e.name);
    const unusable = Object.values(profile.roles || {}).flat().filter((e) => !e.usable).length;
    summary.textContent = `Main: ${mainNames.length ? mainNames.join(', ') : '(none)'}${unusable ? ` · ${unusable} model${unusable === 1 ? '' : 's'} not usable now` : ''}`;
    card.appendChild(summary);
    if (workerBorrowsFromMain(profile.roles)) card.appendChild(workerBorrowNotice());

    // The migration's notes (spec §13): which old model ids were mapped or kept.
    const notes = profile.migration && Array.isArray(profile.migration.notes) ? profile.migration.notes : [];
    if (notes.length) {
      const ul = document.createElement('ul');
      ul.className = 'models-migration-notes';
      for (const note of notes) {
        const li = document.createElement('li');
        li.textContent = note;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'provider-actions';
    const button = (label, action, cls = 'btn') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.dataset.profileAction = action;
      b.dataset.profileId = profile.id;
      return b;
    };
    // The King Louie profile changes only by accepting a proposal (spec §7).
    if (profile.kind !== 'king-louie') actions.appendChild(button('Edit', 'edit', 'btn btn-primary'));
    actions.appendChild(button('Duplicate', 'duplicate'));
    if (profile.id !== defaultProfileId) actions.appendChild(button('Make default', 'default'));
    if (profiles.length > 1) actions.appendChild(button('Delete', 'delete', 'btn btn-danger'));
    card.appendChild(actions);
    list.appendChild(card);
  }
}

function openProfileEditor(profile) {
  profileDraft = profile
    ? { id: profile.id, name: profile.name, roles: JSON.parse(JSON.stringify(profile.roles || {})) }
    : { id: null, name: '', roles: { main: [], worker: [], utility: [] } };
  renderProfileEditor();
}

function closeProfileEditor() {
  profileDraft = null;
  if (!dom.modelsProfileEditor) return;
  dom.modelsProfileEditor.hidden = true;
  dom.modelsProfileEditor.textContent = '';
}

function renderProfileEditor() {
  const editor = dom.modelsProfileEditor;
  if (!editor || !profileDraft) return;
  editor.hidden = false;
  editor.textContent = '';

  const heading = document.createElement('h4');
  heading.textContent = profileDraft.id ? `Edit ${profileDraft.name}` : 'New profile';
  editor.appendChild(heading);

  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'models-profile-name';
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.id = 'models-profile-name';
  nameInput.className = 'provider-input';
  nameInput.value = profileDraft.name;
  nameInput.addEventListener('input', () => { profileDraft.name = nameInput.value; });
  editor.appendChild(nameLabel);
  editor.appendChild(nameInput);

  // Every defined custom role gets a block (spec §6.2), then any other role
  // the stored profile already lists.
  const customIds = (appState.modelProfiles?.customRoles || []).map((r) => r.id);
  const roles = [...new Set([...MODEL_ROLE_ORDER, ...customIds, ...Object.keys(profileDraft.roles)])];
  for (const role of roles) editor.appendChild(renderRoleBlock(role));

  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-primary';
  save.id = 'models-profile-save-btn';
  save.textContent = 'Save profile';
  save.addEventListener('click', () => saveProfileDraft());
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => closeProfileEditor());
  actions.appendChild(save);
  actions.appendChild(cancel);
  editor.appendChild(actions);
}

function renderRoleBlock(role) {
  const block = document.createElement('div');
  block.className = 'models-role-block';
  block.dataset.role = role;
  const title = document.createElement('div');
  title.className = 'chat-info-section-title';
  title.textContent = MODEL_ROLE_LABELS[role] || customRoleLabel(role);
  block.appendChild(title);
  const entries = profileDraft.roles[role] || [];
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = role === 'main'
      ? 'Empty: chats cannot run until main has a model.'
      : (role === 'worker' || role === 'utility'
        ? 'Empty: borrows from the next stronger role.'
        : (customRoleOf(role) ? `Empty: uses its fallback role, ${customRoleOf(role).fallback}.` : 'Empty.'));
    block.appendChild(empty);
  }
  entries.forEach((entry, index) => block.appendChild(renderRoleEntry(role, entry, index, entries.length)));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn';
  add.textContent = 'Add model';
  add.dataset.addRole = role;
  add.addEventListener('click', () => openModelPicker(role, block));
  block.appendChild(add);
  return block;
}

function renderRoleEntry(role, entry, index, count) {
  const row = document.createElement('div');
  row.className = `models-role-entry${entry.usable === false ? ' is-unusable' : ''}`;
  const label = document.createElement('span');
  label.className = 'models-role-entry-label';
  const facts = [entry.provider, formatModelPrice(entry.cost), formatContext(entry.context)].filter(Boolean).join(' · ');
  label.textContent = `${index + 1}. ${entry.name || entry.model} (${facts})`;
  row.appendChild(label);
  if (entry.usable === false && Array.isArray(entry.reasons) && entry.reasons.length) {
    const why = document.createElement('div');
    why.className = 'provider-message error';
    why.textContent = entry.reasons.join(' ');
    row.appendChild(why);
  }
  if (Array.isArray(entry.efforts) && entry.efforts.length) {
    const effort = document.createElement('select');
    effort.className = 'chat-info-select';
    effort.title = 'Reasoning effort';
    const standard = document.createElement('option');
    standard.value = '';
    standard.textContent = 'Default effort';
    effort.appendChild(standard);
    for (const value of entry.efforts) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      if (entry.effort === value) opt.selected = true;
      effort.appendChild(opt);
    }
    effort.addEventListener('change', () => { entry.effort = effort.value || null; });
    row.appendChild(effort);
  }
  const move = (delta) => {
    const list = profileDraft.roles[role];
    const other = index + delta;
    if (other < 0 || other >= list.length) return;
    [list[index], list[other]] = [list[other], list[index]];
    renderProfileEditor();
  };
  const small = (text, title, fn, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = text;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', fn);
    return b;
  };
  row.appendChild(small('↑', 'Move up', () => move(-1), index === 0));
  row.appendChild(small('↓', 'Move down', () => move(1), index === count - 1));
  row.appendChild(small('Remove', 'Remove from this role', () => { profileDraft.roles[role].splice(index, 1); renderProfileEditor(); }));
  return row;
}

async function openModelPicker(role, block) {
  const open = block.querySelector('.models-picker');
  if (open) { open.remove(); return; }
  const picker = document.createElement('div');
  picker.className = 'models-picker';
  picker.textContent = 'Loading models…';
  block.appendChild(picker);
  try {
    const result = unwrapIpcResult(await window.electron.models.picker({ needs: MODEL_ROLE_NEEDS[role] || customRoleOf(role)?.needs || {} }), 'Unable to list models.');
    picker.textContent = '';
    const taken = new Set((profileDraft.roles[role] || []).map((e) => `${e.provider}:${e.model}`));
    const usable = (result.usable || []).filter((c) => !taken.has(`${c.provider}:${c.model}`));
    if (!usable.length) {
      const none = document.createElement('div');
      none.className = 'provider-message';
      none.textContent = 'No usable model meets this role\'s needs. Add and test a key under API keys.';
      picker.appendChild(none);
    }
    for (const c of usable) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'models-picker-item';
      item.dataset.provider = c.provider;
      item.dataset.model = c.model;
      item.textContent = `${c.name} (${[c.provider, c.local ? 'local' : formatModelPrice(c.cost), formatContext(c.context)].filter(Boolean).join(' · ')})`;
      item.addEventListener('click', () => {
        profileDraft.roles[role] = [...(profileDraft.roles[role] || []), { provider: c.provider, model: c.model, effort: null, name: c.name, usable: true, reasons: [], cost: c.cost, context: c.context, efforts: [] }];
        renderProfileEditor();
      });
      picker.appendChild(item);
    }
    // Unusable models appear greyed out with their reasons (spec §11).
    for (const c of (result.unusable || []).slice(0, 100)) {
      const row = document.createElement('div');
      row.className = 'models-picker-item is-unusable';
      row.textContent = `${c.name} (${c.provider}): ${(c.reasons || []).join(' ')}`;
      picker.appendChild(row);
    }
  } catch (err) {
    picker.textContent = err.message;
  }
}

async function saveProfileDraft() {
  if (!profileDraft) return;
  const roles = {};
  for (const [role, entries] of Object.entries(profileDraft.roles)) {
    // An empty custom role list is the editor's leftover, not a choice: it
    // would only block removing the role later.
    if (!MODEL_ROLE_ORDER.includes(role) && !(entries || []).length) continue;
    roles[role] = (entries || []).map((e) => ({ provider: e.provider, model: e.model, effort: e.effort || null }));
  }
  try {
    const result = unwrapIpcResult(
      await window.electron.models.saveProfile({ ...(profileDraft.id ? { id: profileDraft.id } : {}), name: profileDraft.name, roles }),
      'Unable to save the profile.'
    );
    setModelsStatus(`Saved ${result.profile.name}.`);
    closeProfileEditor();
    await loadModelProfiles();
  } catch (err) {
    setModelsStatus(err.message, true);
  }
}

function renderCatalogSettings() {
  const models = appState.settings?.modelsSettings || {};
  if (dom.modelsCatalogFetch) dom.modelsCatalogFetch.checked = models.catalog?.fetch !== false;
  if (dom.modelsCatalogRefreshHours) dom.modelsCatalogRefreshHours.value = String(models.catalog?.refreshHours ?? 24);
  if (dom.modelsCatalogOverrides) dom.modelsCatalogOverrides.value = JSON.stringify(models.overrides || {}, null, 2);
}

/* --- Models tab: the King Louie profile (spec 2026-09-27 §7, §11) --- */

function roleShortName(role) {
  return (MODEL_ROLE_LABELS[role] || role).split(':')[0];
}

function targetsText(list) {
  return (list || []).map((t) => `${t.name || t.model}${t.effort ? ` (${t.effort} effort)` : ''}`).join(', ') || '(none)';
}

function formatCostEffect(effect) {
  if (!effect || typeof effect.usd !== 'number') return effect?.note || 'No estimate.';
  const sign = effect.usd > 0 ? '+' : (effect.usd < 0 ? '−' : '');
  return `${sign}$${Math.abs(effect.usd).toFixed(2)} a month (${effect.note})`;
}

// An empty worker borrows main's models (spec §6.4), so the explorer and
// every other delegated read costs main's price and saves nothing (final
// review I1). The chat leaves out its delegation guidance then; this says why.
function workerBorrowsFromMain(roles) {
  if (!roles || typeof roles !== 'object') return false;
  const worker = Array.isArray(roles.worker) ? roles.worker : [];
  const main = Array.isArray(roles.main) ? roles.main : [];
  return worker.length === 0 && main.length > 0;
}

function workerBorrowNotice() {
  const notice = document.createElement('div');
  notice.className = 'provider-message models-worker-borrow-notice';
  notice.textContent = "Delegated reading runs on main's model until worker has one.";
  return notice;
}

function setKingLouieStatus(text, isError = false) {
  if (!dom.modelsKlStatus) return;
  dom.modelsKlStatus.textContent = text;
  dom.modelsKlStatus.classList.toggle('error', Boolean(isError));
}

async function loadKingLouie() {
  if (!dom.modelsKlStatus || !window.electron?.models?.kingLouie) return;
  try {
    const result = unwrapIpcResult(await window.electron.models.kingLouie(), 'Unable to read the King Louie profile.');
    renderKingLouie(result.view);
  } catch (err) {
    setKingLouieStatus(err.message, true);
  }
}

// A proposal shown in the tab can go stale between a click and its reply (a
// provider status change, another proposal accepted elsewhere). The host
// refuses with STALE_PROPOSAL rather than silently applying a different set
// of models; that is not a failure, just news — show the newly current
// proposal instead of an error (fix round 1 #2, #5; Task 11 note).
function isStaleProposal(result) {
  return Boolean(result) && result.ok === false && result.code === 'STALE_PROPOSAL';
}

function renderKingLouie(view) {
  if (!view || !dom.modelsKlStatus) return;
  appState.kingLouie = view;
  const s = view.settings || {};
  if (dom.modelsKlAutoAccept) dom.modelsKlAutoAccept.checked = Boolean(s.autoAccept);
  if (dom.modelsKlPreferLocal) dom.modelsKlPreferLocal.checked = Boolean(s.preferLocalUtility);
  if (dom.modelsKlBand) dom.modelsKlBand.value = String(s.bandPoints ?? 3);
  if (dom.modelsKlWorkerRatio) dom.modelsKlWorkerRatio.value = String(s.workerAgenticRatio ?? 0.8);
  if (dom.modelsKlUtilityRatio) dom.modelsKlUtilityRatio.value = String(s.utilityIntelligenceRatio ?? 0.5);

  const p = view.proposal;
  if (view.unavailable) setKingLouieStatus(view.unavailable, true);
  else if (view.upToDate) setKingLouieStatus('The King Louie profile is up to date.');
  else if (p && p.dismissed) setKingLouieStatus('You dismissed the current proposal. It comes back when the proposed models change.');
  else if (p) setKingLouieStatus(view.profile ? 'King Louie proposes changes to its profile.' : 'King Louie has a first proposal. Accept it to create the King Louie profile; your default profile stays as it is.');

  if (dom.modelsKlPicks) {
    dom.modelsKlPicks.textContent = '';
    for (const [role, list] of Object.entries(view.current || {})) {
      if (!Array.isArray(list) || !list.length) continue;
      const line = document.createElement('div');
      line.className = 'provider-message';
      line.textContent = `${roleShortName(role)}: ${targetsText(list)}`;
      dom.modelsKlPicks.appendChild(line);
    }
    // The King Louie profile as it stands, or, before the first Accept, the
    // picks it proposes.
    if (workerBorrowsFromMain(view.current || p?.roles)) dom.modelsKlPicks.appendChild(workerBorrowNotice());
  }

  const box = dom.modelsKlProposal;
  if (!box) return;
  box.textContent = '';
  if (!p || p.dismissed) return;
  for (const change of p.changes || []) {
    const card = document.createElement('div');
    card.className = 'models-kl-change';
    card.dataset.role = change.role;
    const title = document.createElement('div');
    title.className = 'chat-info-section-title';
    title.textContent = roleShortName(change.role);
    card.appendChild(title);
    const from = document.createElement('div');
    from.textContent = `Now: ${targetsText(change.from)}`;
    card.appendChild(from);
    const to = document.createElement('div');
    to.textContent = `Proposed: ${targetsText(change.to)}`;
    card.appendChild(to);
    const reasons = document.createElement('ul');
    for (const reason of change.reasons || []) {
      const li = document.createElement('li');
      li.textContent = reason;
      reasons.appendChild(li);
    }
    card.appendChild(reasons);
    const cost = document.createElement('div');
    cost.className = 'provider-message';
    cost.textContent = `Cost effect: ${formatCostEffect(change.costEffect)}`;
    card.appendChild(cost);
    box.appendChild(card);
  }
  const total = document.createElement('div');
  total.className = 'provider-message';
  total.textContent = `Estimated total: ${formatCostEffect(p.costEffect)}`;
  box.appendChild(total);

  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.className = 'btn btn-primary';
  accept.id = 'models-kl-accept-btn';
  accept.textContent = 'Accept';
  accept.addEventListener('click', async () => {
    try {
      // The id of the proposal actually shown on screen, so a reply that
      // arrives after the picks changed underneath it is refused rather
      // than silently applying a different set of models (Task 10 fix
      // round 1 #2, applied here per the coordinator's note).
      const result = await window.electron.models.acceptProposal(p.id);
      if (isStaleProposal(result)) {
        setKingLouieStatus('The proposal changed since it was shown. Here is the current one.');
        await loadKingLouie();
        return;
      }
      unwrapIpcResult(result, 'Unable to accept the proposal.');
      setKingLouieStatus('Accepted. The King Louie profile uses these models now.');
      await loadKingLouie();
      await loadModelProfiles();
    } catch (err) {
      setKingLouieStatus(err.message, true);
      await loadKingLouie();
    }
  });
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn';
  dismiss.id = 'models-kl-dismiss-btn';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', async () => {
    try {
      const result = await window.electron.models.dismissProposal(p.id);
      if (isStaleProposal(result)) {
        setKingLouieStatus('The proposal changed since it was shown. Here is the current one.');
        await loadKingLouie();
        return;
      }
      unwrapIpcResult(result, 'Unable to dismiss the proposal.');
      await loadKingLouie();
    } catch (err) {
      setKingLouieStatus(err.message, true);
    }
  });
  actions.appendChild(accept);
  actions.appendChild(dismiss);
  box.appendChild(actions);
}

if (dom.modelsKlSaveBtn) {
  dom.modelsKlSaveBtn.addEventListener('click', async () => {
    try {
      const result = unwrapIpcResult(await window.electron.models.saveKingLouieSettings({
        autoAccept: Boolean(dom.modelsKlAutoAccept?.checked),
        preferLocalUtility: Boolean(dom.modelsKlPreferLocal?.checked),
        // Raw field text: the core refuses a blank or non-numeric value
        // (BAD_SETTING) rather than saving it as 0.
        bandPoints: dom.modelsKlBand?.value ?? '',
        workerAgenticRatio: dom.modelsKlWorkerRatio?.value ?? '',
        utilityIntelligenceRatio: dom.modelsKlUtilityRatio?.value ?? ''
      }), 'Unable to save the King Louie settings.');
      renderKingLouie(result.view);
      await loadModelProfiles();
    } catch (err) {
      setKingLouieStatus(err.message, true);
    }
  });
}

if (dom.modelsKlDuplicateBtn) {
  dom.modelsKlDuplicateBtn.addEventListener('click', async () => {
    try {
      // Pass the shown proposal's id too (Task 10 fix round 1 #2): before
      // any Accept, "Duplicate" copies exactly what is on screen, or is
      // refused as stale rather than silently copying whatever the picks
      // have since become. Once a King Louie profile exists, the id is
      // ignored (its own accepted roles are duplicated instead).
      const proposalId = appState.kingLouie?.proposal?.id || undefined;
      const result = await window.electron.models.duplicateKingLouie(proposalId ? { proposalId } : {});
      if (isStaleProposal(result)) {
        setKingLouieStatus('The proposal changed since it was shown. Here is the current one.');
        await loadKingLouie();
        return;
      }
      const data = unwrapIpcResult(result, 'Unable to duplicate the King Louie profile.');
      setKingLouieStatus(`Created ${data.profile.name}. Edit it under Profiles.`);
      await loadModelProfiles();
    } catch (err) {
      setKingLouieStatus(err.message, true);
    }
  });
}

if (window.electron?.models?.onProposalChanged) {
  window.electron.models.onProposalChanged((view) => renderKingLouie(view));
}

/* --- Models tab: custom roles (spec 2026-09-27 §6.2, §11) --- */

function customRoleOf(role) {
  return (appState.modelProfiles?.customRoles || []).find((r) => r.id === role) || null;
}

function customRoleLabel(role) {
  const r = customRoleOf(role);
  return `Custom role: ${role}${r?.description ? ` (${r.description})` : ''}`;
}

function describeCustomRole(r) {
  const needs = [
    r.needs?.toolCall ? 'tool calling' : null,
    r.needs?.imageInput ? 'image input' : null,
    r.needs?.minContext ? formatContext(r.needs.minContext) : null
  ].filter(Boolean);
  return `${r.id}: ${r.description || 'no description'} · falls back to ${r.fallback}${needs.length ? ` · needs ${needs.join(', ')}` : ''}`;
}

function setCustomRolesStatus(text, isError = false) {
  if (!dom.modelsCustomRolesStatus) return;
  dom.modelsCustomRolesStatus.textContent = text;
  dom.modelsCustomRolesStatus.classList.toggle('error', Boolean(isError));
}

function renderCustomRoles() {
  const list = dom.modelsCustomRoleList;
  if (!list) return;
  list.textContent = '';
  const roles = appState.modelProfiles?.customRoles || [];
  if (!roles.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No custom roles.';
    list.appendChild(empty);
    return;
  }
  for (const r of roles) {
    const row = document.createElement('div');
    row.className = 'models-custom-role';
    row.dataset.roleId = r.id;
    const label = document.createElement('span');
    label.textContent = describeCustomRole(r);
    row.appendChild(label);
    for (const [action, text, cls] of [['edit', 'Edit', 'btn'], ['delete', 'Delete', 'btn btn-danger']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.dataset.customRoleAction = action;
      b.dataset.roleId = r.id;
      row.appendChild(b);
    }
    list.appendChild(row);
  }
}

function fillCustomRoleForm(r) {
  if (dom.modelsCustomRoleId) dom.modelsCustomRoleId.value = r?.id || '';
  if (dom.modelsCustomRoleDescription) dom.modelsCustomRoleDescription.value = r?.description || '';
  if (dom.modelsCustomRoleFallback) dom.modelsCustomRoleFallback.value = r?.fallback || 'worker';
  if (dom.modelsCustomRoleTools) dom.modelsCustomRoleTools.checked = Boolean(r?.needs?.toolCall);
  if (dom.modelsCustomRoleImages) dom.modelsCustomRoleImages.checked = Boolean(r?.needs?.imageInput);
  if (dom.modelsCustomRoleMinContext) dom.modelsCustomRoleMinContext.value = r?.needs?.minContext ? String(r.needs.minContext) : '';
}

if (dom.modelsSaveCustomRoleBtn) {
  dom.modelsSaveCustomRoleBtn.addEventListener('click', async () => {
    const minContext = String(dom.modelsCustomRoleMinContext?.value || '').trim();
    try {
      const result = unwrapIpcResult(await window.electron.models.saveCustomRole({
        id: String(dom.modelsCustomRoleId?.value || '').trim(),
        description: String(dom.modelsCustomRoleDescription?.value || '').trim(),
        fallback: dom.modelsCustomRoleFallback?.value || 'worker',
        needs: {
          toolCall: Boolean(dom.modelsCustomRoleTools?.checked),
          imageInput: Boolean(dom.modelsCustomRoleImages?.checked),
          ...(minContext ? { minContext: Number(minContext) } : {})
        }
      }), 'Unable to save the custom role.');
      setCustomRolesStatus(`Saved ${result.role.id}.`);
      fillCustomRoleForm(null);
      await loadModelProfiles();
    } catch (err) {
      setCustomRolesStatus(err.message, true);
    }
  });
}

if (dom.modelsCustomRoleList) {
  dom.modelsCustomRoleList.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-custom-role-action]');
    if (!btn) return;
    const id = btn.dataset.roleId;
    if (btn.dataset.customRoleAction === 'edit') {
      fillCustomRoleForm(customRoleOf(id));
      return;
    }
    // No native dialogs: a second click confirms.
    if (btn.dataset.confirming !== 'true') {
      btn.dataset.confirming = 'true';
      btn.textContent = 'Click again to delete';
      return;
    }
    try {
      unwrapIpcResult(await window.electron.models.removeCustomRole(id), 'Unable to delete the custom role.');
      setCustomRolesStatus(`Deleted ${id}.`);
      await loadModelProfiles();
    } catch (err) {
      setCustomRolesStatus(err.message, true);
      await loadModelProfiles();
    }
  });
}

if (dom.modelsNewProfileBtn) {
  dom.modelsNewProfileBtn.addEventListener('click', () => openProfileEditor(null));
}

if (dom.modelsProfileList) {
  dom.modelsProfileList.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-profile-action]');
    if (!btn) return;
    const id = btn.dataset.profileId;
    const action = btn.dataset.profileAction;
    const profile = (appState.modelProfiles?.profiles || []).find((p) => p.id === id);
    try {
      if (action === 'edit' && profile) openProfileEditor(profile);
      if (action === 'duplicate') {
        const r = unwrapIpcResult(await window.electron.models.duplicateProfile(id), 'Unable to duplicate the profile.');
        setModelsStatus(`Created ${r.profile.name}.`);
        await loadModelProfiles();
      }
      if (action === 'default') {
        unwrapIpcResult(await window.electron.models.setDefaultProfile(id), 'Unable to set the default profile.');
        setModelsStatus(`${profile?.name || 'The profile'} is now the default for new chats.`);
        await loadModelProfiles();
      }
      if (action === 'delete') {
        // No native dialogs: a second click confirms.
        if (btn.dataset.confirming !== 'true') {
          btn.dataset.confirming = 'true';
          btn.textContent = 'Click again to delete';
          return;
        }
        const r = unwrapIpcResult(await window.electron.models.removeProfile(id), 'Unable to delete the profile.');
        const moved = (r.moved?.chats?.length || 0) + (r.moved?.cases?.length || 0);
        setModelsStatus(`Deleted ${profile?.name || 'the profile'}.${moved ? ` ${moved} chat(s) or case(s) now use the default profile.` : ''}`);
        await loadModelProfiles();
      }
    } catch (err) {
      setModelsStatus(err.message, true);
      modelsTabLog.warn(`profile ${action} failed: ${err.message}`);
    }
  });
}

if (dom.modelsSaveCatalogBtn) {
  dom.modelsSaveCatalogBtn.addEventListener('click', async () => {
    let overrides;
    try {
      overrides = JSON.parse(dom.modelsCatalogOverrides?.value || '{}');
    } catch {
      if (dom.modelsCatalogStatus) {
        dom.modelsCatalogStatus.textContent = 'Overrides must be valid JSON.';
        dom.modelsCatalogStatus.classList.add('error');
      }
      return;
    }
    const fetchOn = Boolean(dom.modelsCatalogFetch?.checked);
    const refreshHours = Number(dom.modelsCatalogRefreshHours?.value);
    try {
      const result = unwrapIpcResult(
        await window.electron.models.saveCatalogSettings({ fetch: fetchOn, refreshHours, overrides }),
        'Unable to save the catalog settings.'
      );
      appState.settings.modelsSettings = { catalog: { ...(appState.settings.modelsSettings?.catalog || {}), fetch: fetchOn, refreshHours }, overrides };
      showCatalogStatus(result.catalog);
    } catch (err) {
      if (dom.modelsCatalogStatus) {
        dom.modelsCatalogStatus.textContent = err.message;
        dom.modelsCatalogStatus.classList.add('error');
      }
    }
  });
}

async function handleSaveOllamaUrl() {
  const input = dom.providerList.querySelector('input[data-ollama-url]');
  const value = (input?.value || '').trim();
  setProviderMessage('ollama', 'Saving the address and testing Ollama…');
  try {
    const result = unwrapIpcResult(await window.electron.models.setOllamaBaseUrl(value), 'Unable to save the Ollama address.');
    appState.settings.ollamaBaseUrl = result.baseUrl;
    updateProviderStatus('ollama', result.status);
    setProviderMessage(
      'ollama',
      result.status?.ok ? `Address saved. ${result.status.message}` : `Address saved, but Ollama did not answer: ${result.status?.error || 'unknown error'}`,
      !result.status?.ok
    );
  } catch (err) {
    setProviderMessage('ollama', err.message, true);
  }
}

if (dom.modelsRefreshCatalogBtn) {
  dom.modelsRefreshCatalogBtn.addEventListener('click', async () => {
    dom.modelsRefreshCatalogBtn.disabled = true;
    if (dom.modelsCatalogStatus) dom.modelsCatalogStatus.textContent = 'Refreshing the catalog…';
    try {
      const result = unwrapIpcResult(await window.electron.models.refreshCatalog(), 'Catalog refresh failed.');
      showCatalogStatus(result.catalog);
    } catch (err) {
      if (dom.modelsCatalogStatus) {
        dom.modelsCatalogStatus.textContent = err.message;
        dom.modelsCatalogStatus.classList.add('error');
      }
    } finally {
      dom.modelsRefreshCatalogBtn.disabled = false;
    }
  });
}

if (dom.modelsTestAllBtn) {
  dom.modelsTestAllBtn.addEventListener('click', async () => {
    dom.modelsTestAllBtn.disabled = true;
    try {
      const result = unwrapIpcResult(await window.electron.models.testAll(), 'Test all failed.');
      for (const [provider, status] of Object.entries(result.providers || {})) {
        if (appState.settings?.providers?.[provider]) appState.settings.providers[provider].status = status;
      }
      renderSettings();
    } catch (err) {
      chatLog.warn(`Test all failed: ${err.message}`);
    } finally {
      dom.modelsTestAllBtn.disabled = false;
    }
  });
}

if (window.electron?.models?.onStatusChanged) {
  window.electron.models.onStatusChanged(({ provider, status } = {}) => {
    const entry = appState.settings?.providers?.[provider];
    if (!entry) return;
    entry.status = status || null;
    updateProviderStatusBadge(provider);
    refreshChatModels();
  });
}

if (window.electron?.models?.onCatalogUpdated) {
  window.electron.models.onCatalogUpdated((status) => showCatalogStatus(status));
}

function closeContextMenu() {
  dom.chatContextMenu.hidden = true;
  appState.contextChatId = null;
}

function openContextMenu({ chatId, x, y }) {
  appState.contextChatId = chatId;
  dom.chatContextMenu.hidden = false;

  const menuRect = dom.chatContextMenu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 8;
  const maxY = window.innerHeight - menuRect.height - 8;

  dom.chatContextMenu.style.left = `${Math.min(x, maxX)}px`;
  dom.chatContextMenu.style.top = `${Math.min(y, maxY)}px`;
}

function showRenameDialog(currentTitle) {
  return showTextInputDialog({
    heading: 'Rename chat',
    value: currentTitle,
    placeholder: 'Enter chat name',
    confirmLabel: 'Save'
  });
}

// Modal with one text field. Resolves with the entered text, or null on
// cancel. `extra` is an optional element shown under the field. When
// `onSubmit` is given it runs before closing: return an error string to
// keep the dialog open and show it, or nothing to close.
function showTextInputDialog({ heading: headingText, value = '', placeholder = '', confirmLabel = 'OK', idPrefix = null, extra = null, onSubmit = null }) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'rename-chat-modal';
    if (idPrefix) modal.id = `${idPrefix}-dialog`;

    const card = document.createElement('div');
    card.className = 'rename-chat-card';

    const heading = document.createElement('h3');
    heading.textContent = headingText;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-chat-input';
    if (idPrefix) input.id = `${idPrefix}-input`;
    input.value = value || '';
    input.placeholder = placeholder;

    const error = document.createElement('div');
    error.className = 'rename-chat-error';
    if (idPrefix) error.id = `${idPrefix}-error`;
    error.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'rename-chat-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.appendChild(faIcon('fas fa-xmark'));
    cancelBtn.appendChild(document.createTextNode(' Cancel'));

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary';
    if (idPrefix) saveBtn.id = `${idPrefix}-confirm`;
    saveBtn.appendChild(faIcon('fas fa-check'));
    saveBtn.appendChild(document.createTextNode(` ${confirmLabel}`));

    let busy = false;
    const close = (result = null) => {
      modal.remove();
      resolve(result);
    };
    const submit = async () => {
      if (busy) return;
      if (!onSubmit) { close(input.value); return; }
      busy = true;
      saveBtn.disabled = true;
      const message = await onSubmit(input.value);
      busy = false;
      saveBtn.disabled = false;
      if (message) {
        error.textContent = message;
        error.hidden = false;
        input.focus();
        return;
      }
      close(input.value);
    };

    cancelBtn.addEventListener('click', () => { if (!busy) close(null); });
    saveBtn.addEventListener('click', submit);

    modal.addEventListener('click', (event) => {
      if (event.target === modal && !busy) {
        close(null);
      }
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        close(null);
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    card.appendChild(heading);
    card.appendChild(input);
    if (extra) card.appendChild(extra);
    card.appendChild(error);
    card.appendChild(actions);

    modal.appendChild(card);
    document.body.appendChild(modal);
    input.focus();
    input.select();
  });
}

async function sendMessage() {
  const message = dom.userInput.value.trim();
  const pendingImages = Array.isArray(appState.pendingImages) ? [...appState.pendingImages] : [];
  const pendingDocuments = Array.isArray(appState.pendingDocuments) ? [...appState.pendingDocuments] : [];

  if (message === '' && pendingImages.length === 0 && pendingDocuments.length === 0) {
    return;
  }

  const command = message.toLowerCase();
  if (command === 'exit' || command === 'quit') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';
    await window.electron.app.quitWindow();
    return;
  }

  if (!appState.activeChatId) {
    const newChat = unwrapIpcResult(await window.electron.chat.create('New Chat'), 'Unable to create chat.');
    if (!newChat) {
      return;
    }
    appState.chats = [newChat, ...appState.chats.filter((chat) => chat.id !== newChat.id)];
    appState.activeChatId = newChat.id;
    appState.isAgentModeEnabled = !!newChat.agentMode;
    appState.isSandboxModeEnabled = newChat.sandboxMode !== false;
  }

  const slashCommand = parseSlashCommand(message);
  if (slashCommand?.name === '/help') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    const helpText = await getLocalHelpText();
    appendLocalMessage('user', message);
    appendLocalMessage('assistant', helpText);

    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: helpText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

    return;
  }

  if (slashCommand?.name === '/cd') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

    const dirArg = slashCommand.args.join(' ').trim();
    let responseText;
    if (dirArg) {
      const result = await window.electron.chat.setWorkingDirectory({ chatId: appState.activeChatId, workingDirectory: dirArg });
      const updated = result?.data || result;
      if (updated?.workingDirectory) {
        appState.chats = appState.chats.map((c) => c.id === updated.id ? updated : c);
        responseText = `Working directory set to \`${updated.workingDirectory}\``;
      } else {
        responseText = `Working directory set to \`${dirArg}\``;
        appState.chats = appState.chats.map((c) => c.id === appState.activeChatId ? { ...c, workingDirectory: dirArg } : c);
      }
    } else {
      const data = unwrapIpcResult(
        await window.electron.chat.pickWorkingDirectory(appState.activeChatId),
        'Unable to set working directory.'
      );
      if (data && !data.canceled && data.chat) {
        appState.chats = appState.chats.map((c) => (c.id === data.chat.id ? data.chat : c));
        responseText = `Working directory set to \`${data.chat.workingDirectory}\``;
      } else {
        responseText = 'No directory selected.';
      }
    }

    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    refreshUI();

    return;
  }

  if (slashCommand?.name === '/agent') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    const modeArg = (slashCommand.args[0] || 'toggle').toLowerCase();
    if (modeArg === 'on') {
      appState.isAgentModeEnabled = true;
    } else if (modeArg === 'off') {
      appState.isAgentModeEnabled = false;
    } else if (modeArg === 'toggle') {
      appState.isAgentModeEnabled = !appState.isAgentModeEnabled;
    } else if (modeArg !== 'status') {
      const helpText = 'Usage: `/agent on`, `/agent off`, `/agent toggle`, or `/agent status`.';
      appendLocalMessage('user', message);
      appendLocalMessage('assistant', helpText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: helpText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
      return;
    }

    if (modeArg !== 'status') persistAgentMode();
    renderAgentModeButton();
    const statusText = modeArg === 'status'
      ? `Agent mode is currently **${appState.isAgentModeEnabled ? 'ON' : 'OFF'}**.`
      : `Agent mode is now **${appState.isAgentModeEnabled ? 'ON' : 'OFF'}**.`;

    appendLocalMessage('user', message);
    appendLocalMessage('assistant', statusText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: statusText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

    return;
  }

  if (slashCommand?.name === '/delegate') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

    const taskArg = slashCommand.args[0] || '';
    if (!taskArg) {
      const usage = 'Usage: `/delegate <task-plan-path>` — reads task configs from a JSON file and executes them with dependency ordering.\n\nExample JSON:\n```json\n{ "agentId": "code-writer", "tasks": [\n  { "id": "t26", "subject": "Task 26", "description": "..." },\n  { "id": "t29", "subject": "Task 29", "description": "...", "blockedBy": ["t26"] }\n]}\n```';
      appendLocalMessage('assistant', usage);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: usage }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
      return;
    }

    try {
      appendLocalMessage('assistant', `Loading task plan from \`${taskArg}\`...`);

      // Listen for task progress events during delegation
      const taskUpdatedHandler = (task) => {
        if (task?.status === 'in_progress') {
          appendLocalMessage('assistant', `Started: **${task.subject || task.id}**`);
        } else if (task?.status === 'completed') {
          appendLocalMessage('assistant', `Completed: **${task.subject || task.id}**`);
        }
      };
      const taskUnblockedHandler = (task) => {
        appendLocalMessage('assistant', `Unblocked: **${task.subject || task.id}**`);
      };
      window.electron.task.onUpdated(taskUpdatedHandler);
      window.electron.task.onUnblocked(taskUnblockedHandler);

      const result = await window.electron.agent.executeWithDeps({ planFile: taskArg });

      const completionMsg = `Delegation complete. ${(result?.tasks || []).filter((t) => t.status === 'completed').length}/${(result?.tasks || []).length} tasks finished.`;
      appendLocalMessage('assistant', completionMsg);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: completionMsg }).catch((err2) => chatLog.warn(`addMessage persistence failed: ${err2.message}`));
    } catch (err) {
      const errMsg = `Delegation failed: ${err.message}`;
      appendLocalMessage('assistant', errMsg);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errMsg }).catch((err2) => chatLog.warn(`addMessage persistence failed: ${err2.message}`));
    }

    return;
  }

  if (slashCommand?.name === '/profile') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    const action = (slashCommand.args[0] || '').toLowerCase();
    if (!action) {
      appendLocalMessage('user', message);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

      const summary = formatProfileSummary(appState.settings.userProfile || {});
      appendLocalMessage('assistant', summary);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: summary }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
      return;
    }

    if (action !== 'set') {
      const usage = 'Usage: `/profile` or `/profile set <field> <value>`. Fields: name, role, projectContext, goals, preferences';
      appendLocalMessage('user', message);
      appendLocalMessage('assistant', usage);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: usage }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
      return;
    }

    const fieldRaw = slashCommand.args[1] || '';
    const field = fieldRaw.toLowerCase();
    const rawValue = slashCommand.args.slice(2).join(' ').trim();
    const profile = {
      ...(appState.settings.userProfile || {})
    };

    try {
      if (!field || rawValue.length === 0) {
        throw new Error('Usage: `/profile set <field> <value>`.');
      }

      if (field === 'name') {
        profile.name = rawValue;
      } else if (field === 'role') {
        profile.role = rawValue;
      } else if (field === 'projectcontext' || field === 'project_context') {
        profile.projectContext = rawValue;
      } else if (field === 'goals') {
        profile.goals = rawValue
          .split(';')
          .map((goal) => goal.trim())
          .filter(Boolean);
      } else if (field === 'preferences') {
        const parsed = JSON.parse(rawValue);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('`preferences` must be a valid JSON object.');
        }
        profile.preferences = parsed;
      } else {
        throw new Error('Unknown field. Use name, role, projectContext, goals, or preferences.');
      }

      await saveUserProfileWithFeedback(profile, message);
    } catch (error) {
      appendLocalMessage('user', message);
      const errorText = `❌ ${error.message || 'Unable to update profile.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    }

    return;
  }

  if (slashCommand?.name === '/pin') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';
    const skillId = slashCommand.args[0];
    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    if (!skillId) {
      const errorText = 'Usage: `/pin <skill-id>`. Use `/pin std` to pin the STD skill.';
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
      return;
    }
    const result = await window.electron.skill.pin({ chatId: appState.activeChatId, skillId });
    const responseText = result.ok
      ? `📌 Pinned **${result.name || skillId}** to this chat. All messages will be handled by this skill. Use \`/unpin\` to restore normal behavior.`
      : `❌ ${result.error}`;
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    return;
  }

  if (slashCommand?.name === '/unpin') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';
    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    const result = await window.electron.skill.unpin({ chatId: appState.activeChatId });
    const responseText = result.ok ? '📌 Unpinned. Normal behavior restored.' : `❌ ${result.error}`;
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    return;
  }

  if (slashCommand?.name === '/pinned') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';
    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    const result = await window.electron.skill.getPinned({ chatId: appState.activeChatId });
    const responseText = result.pinned
      ? `📌 Pinned skill: **${result.pinned.name || result.pinned.skillId}** (\`${result.pinned.skillId}\`)`
      : 'No skill is currently pinned to this chat.';
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    return;
  }

  if (slashCommand?.name === '/skill') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

    const action = (slashCommand.args[0] || '').toLowerCase();
    const skillId = (slashCommand.args[1] || '').trim();

    if (action !== 'customize' || !skillId) {
      const usage = 'Usage: `/skill customize <skill-id>`. Example: `/skill customize std`';
      appendLocalMessage('assistant', usage);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: usage }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
      return;
    }

    try {
      const result = await window.electron.skill.customize({ skillId });
      const responseText = result?.ok
        ? `Opened customization file for **${result.skillId}** at:\n\`${result.path}\`${result.created ? '\n\nCreated a new file with starter defaults.' : ''}`
        : `❌ ${result?.error || 'Unable to open customization file.'}`;
      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    } catch (error) {
      const errorText = `❌ ${error.message || 'Unable to open customization file.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    }

    return;
  }

  if (slashCommand?.name === '/llm') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

    try {
      const result = await window.electron.settings.runLlmCommand({ command: message });
      const responseText = result?.ok
        ? (result.output || 'Command completed.')
        : `Error: ${result?.error || 'Unable to run local LLM command.'}`;

      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    } catch (error) {
      const errorText = `Error: ${error.message || 'Unable to run local LLM command.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    }

    return;
  }

  if (slashCommand?.name === '/fixit') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

    appendLocalMessage('assistant', 'Running diagnostics...');

    try {
      const result = await window.electron.diagnostics.run();
      const responseText = result?.ok
        ? '```\n' + (result.formatted || 'No results.') + '\n```'
        : `Error: ${result?.error || 'Diagnostics failed.'}`;

      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    } catch (error) {
      const errorText = `Error: ${error.message || 'Diagnostics failed.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    }

    return;
  }

  if (slashCommand?.name === '/speak') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

    try {
      const summaryMode = ['summary', '--summary', '-s'].some((token) =>
        slashCommand.args.map((arg) => String(arg || '').toLowerCase()).includes(token)
      );
      const result = await window.electron.chat.speakLast({
        chatId: appState.activeChatId,
        summary: summaryMode
      });

      const responseText = result?.ok
        ? `🔊 Speaking the last assistant response${summaryMode ? ' (summary)' : ''}.`
        : `❌ ${result?.error || 'Unable to speak the last response.'}`;
      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    } catch (error) {
      const errorText = `❌ ${error.message || 'Unable to speak the last response.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
    }

    return;
  }

  // Check if this is a skill command (e.g., /std)
  if (slashCommand) {
    const commandName = slashCommand.name.slice(1); // Remove leading /

    try {
      // Check if this command is handled by a skill
      const skillResult = await window.electron.skill.execute({
        command: commandName,
        args: slashCommand.args,
        chatId: appState.activeChatId
      });

      if (skillResult && !skillResult.error?.startsWith('Unknown skill command:')) {
        dom.userInput.value = '';
        dom.userInput.style.height = 'auto';

        appendLocalMessage('user', message);
        window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

        const responseText = skillResult.ok === false
          ? `❌ ${skillResult.error || 'Skill command failed.'}`
          : (skillResult.message || 'Skill command executed.');
        const responseFormat = skillResult.format || 'markdown';
        appendLocalMessage('assistant', responseText, { format: responseFormat });
        window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText, format: responseFormat }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

        return;
      }
    } catch (error) {
      // Skill command failed or doesn't exist - continue to LLM
      rendererLog.info(`Skill command not found, sending to LLM: ${commandName}`);
    }
  }

  const now = new Date().toISOString();
  appState.chats = appState.chats.map((chat) => {
    if (chat.id !== appState.activeChatId) return chat;
    return {
      ...chat,
      updatedAt: now,
      messages: [
        ...chat.messages,
        {
          id: `temp-${Date.now()}`,
          sender: 'user',
          text: message,
          timestamp: now,
          ...(pendingImages.length > 0 ? {
            images: pendingImages.map(({ previewUrl, ...rest }) => rest)
          } : {}),
          ...(pendingDocuments.length > 0 ? {
            documents: pendingDocuments.map(({ textContent, ...rest }) => rest)
          } : {})
        }
      ]
    };
  });
  refreshUI();

  dom.userInput.value = '';
  dom.userInput.style.height = 'auto';
  clearPendingImages();

  try {
    const pinnedInfo = await window.electron.skill.getPinned({ chatId: appState.activeChatId });
    if (pinnedInfo?.pinned) {
      const skillResult = await window.electron.skill.handleMessage({
        chatId: appState.activeChatId,
        message
      });

      if (skillResult && !skillResult.continueWithAgent) {
        if (pendingImages.length > 0 || pendingDocuments.length > 0) {
          throw new Error('Pinned skill handling currently supports text-only input. Unpin skill or send without attachments.');
        }
        const responseText = skillResult.ok
          ? (skillResult.message || 'Done.')
          : `❌ ${skillResult.error || 'Error'}`;
        const responseFormat = skillResult.format || 'markdown';
        window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
        appendLocalMessage('assistant', responseText, { format: responseFormat });
        window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText, format: responseFormat }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
        return;
      }
    }

    const rawResult = await window.electron.chat.sendMessage({
      chatId: appState.activeChatId,
      message,
      images: pendingImages.map(({ previewUrl, ...rest }) => rest),
      documents: pendingDocuments,
      agentMode: appState.isAgentModeEnabled,
      sandboxMode: appState.isSandboxModeEnabled
    });
    const updatedChat = unwrapIpcResult(rawResult, 'Unable to send message.');

    if (updatedChat) {
      appState.chats = appState.chats.map((chat) => (chat.id === updatedChat.id ? updatedChat : chat));
    } else {
      // Backend may have saved the response (e.g. aborted run) but returned
      // undefined — reload chats from storage so we don't lose the message.
      try {
        const data = unwrapIpcResult(await window.electron.chat.load(), 'reload');
        appState.chats = data.chats || [];
      } catch (err) { chatLog.warn(`best-effort reload failed: ${err.message}`); }
    }
    refreshUI();
  } catch (error) {
    // Reload chat state from storage so persisted tool events aren't lost
    try {
      const data = unwrapIpcResult(await window.electron.chat.load(), 'reload');
      appState.chats = data.chats || [];
    } catch { /* best-effort reload */ }

    // onMessageError may have already displayed this error via IPC event.
    // Only add a fallback message if no error element was rendered yet.
    const alreadyShown = dom.chatMessages.querySelector('.message.assistant:last-child .message-content p');
    if (!alreadyShown || !alreadyShown.textContent.startsWith('Error:')) {
      addMessage('assistant', `Error: ${error.message || 'Unable to send message.'}`);
    }
    refreshUI();
  } finally {
    setResponseActive(false, appState.activeChatId);
    flushToolGroup();
  }
}

async function resendUserMessage(messageEl) {
  const chatId = appState.activeChatId;
  if (!chatId) return;
  const chat = appState.chats.find((c) => c.id === chatId);
  if (!chat || !chat.messages.length) return;

  // Find which user message was right-clicked by matching DOM position
  const allMessageEls = Array.from(dom.chatMessages.querySelectorAll('.message'));
  const clickedIndex = allMessageEls.indexOf(messageEl);
  if (clickedIndex === -1) return;

  // Map DOM index back to the corresponding message in appState.
  // The DOM may contain extra elements (tool groups, streaming) so match by
  // walking user+assistant messages in order.
  let domUserIndex = 0;
  for (let i = 0; i < allMessageEls.length; i++) {
    if (allMessageEls[i].classList.contains('user')) {
      if (i === clickedIndex) break;
      domUserIndex++;
    }
  }

  // Find the nth user message in the chat data
  let userCount = 0;
  let msgIndex = -1;
  for (let i = 0; i < chat.messages.length; i++) {
    if (chat.messages[i].sender === 'user') {
      if (userCount === domUserIndex) { msgIndex = i; break; }
      userCount++;
    }
  }
  if (msgIndex === -1) return;
  await resendFromIndex(chatId, msgIndex);
}

// Remove the user message at msgIndex and everything after it with
// chat:truncateFrom, then send it again through the normal flow. `carry`
// is messages to put back right after the truncation, before the re-sent
// message (Retry with…: the status line its main switch wrote).
async function resendFromIndex(chatId, msgIndex, { carry = [] } = {}) {
  const chat = appState.chats.find((c) => c.id === chatId);
  const userMsg = chat?.messages?.[msgIndex];
  if (!userMsg || userMsg.sender !== 'user') return;
  const message = userMsg.text || '';
  const images = userMsg.images || [];
  const documents = userMsg.documents || [];
  if (!message && images.length === 0 && documents.length === 0) return;

  // Truncate from this message onward (removes the user message + its response)
  try {
    const updatedChat = await window.electron.chat.truncateFrom({ chatId, fromIndex: msgIndex });
    if (updatedChat) {
      appState.chats = appState.chats.map((c) => (c.id === updatedChat.id ? updatedChat : c));
      refreshUI();
    }
  } catch (err) {
    addMessage('assistant', `Error: ${err.message || 'Unable to resend.'}`);
    return;
  }

  for (const kept of carry) {
    try {
      const restored = unwrapIpcResult(await window.electron.chat.addMessage({ chatId, sender: kept.sender, text: kept.text || '' }), 'Unable to keep the status message.');
      applyUpdatedChat(restored);
    } catch (err) {
      chatLog.warn(`keeping the ${kept.sender} message failed: ${err.message}`);
    }
  }
  const latest = appState.chats.find((c) => c.id === chatId) || chat;

  // Re-send the message through the normal flow
  // Add user message to local state optimistically
  const now = new Date().toISOString();
  appState.chats = appState.chats.map((c) => {
    if (c.id !== chatId) return c;
    return {
      ...c,
      updatedAt: now,
      messages: [
        ...(c.id === latest.id ? latest.messages : c.messages),
        {
          id: `temp-${Date.now()}`,
          sender: 'user',
          text: message,
          timestamp: now,
          ...(images.length > 0 ? { images } : {}),
          ...(documents.length > 0 ? { documents } : {})
        }
      ]
    };
  });
  refreshUI();

  try {
    setResponseActive(true, chatId);
    const rawResult = await window.electron.chat.sendMessage({
      chatId,
      message,
      images,
      documents,
      agentMode: appState.isAgentModeEnabled,
      sandboxMode: appState.isSandboxModeEnabled
    });
    const updatedChat = unwrapIpcResult(rawResult, 'Unable to send message.');
    if (updatedChat) {
      appState.chats = appState.chats.map((c) => (c.id === updatedChat.id ? updatedChat : c));
    } else {
      try {
        const data = unwrapIpcResult(await window.electron.chat.load(), 'reload');
        appState.chats = data.chats || [];
      } catch (err) { chatLog.warn(`best-effort reload failed: ${err.message}`); }
    }
    refreshUI();
  } catch (error) {
    try {
      const data = unwrapIpcResult(await window.electron.chat.load(), 'reload');
      appState.chats = data.chats || [];
    } catch { /* best-effort reload */ }
    const alreadyShown = dom.chatMessages.querySelector('.message.assistant:last-child .message-content p');
    if (!alreadyShown || !alreadyShown.textContent.startsWith('Error:')) {
      addMessage('assistant', `Error: ${error.message || 'Unable to send message.'}`);
    }
    refreshUI();
  } finally {
    setResponseActive(false, chatId);
    flushToolGroup();
  }
}

async function handleStdCardAction(action, taskId, buttonEl = null) {
  if (action !== 'complete' || !taskId || !appState.activeChatId) {
    return;
  }

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Completing...';
  }

  const commandText = `/std complete ${taskId}`;

  try {
    appendLocalMessage('user', commandText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: commandText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));

    const skillResult = await window.electron.skill.execute({
      command: 'std',
      args: ['complete', String(taskId)],
      chatId: appState.activeChatId
    });

    const responseText = skillResult?.ok === false
      ? `❌ ${skillResult.error || 'Skill command failed.'}`
      : (skillResult?.message || 'Task completed.');
    const responseFormat = skillResult?.format || 'markdown';

    appendLocalMessage('assistant', responseText, { format: responseFormat });
    window.electron.chat
      .addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText, format: responseFormat })
      .catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
  } catch (error) {
    const errorText = `❌ ${error.message || 'Unable to complete task.'}`;
    appendLocalMessage('assistant', errorText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => chatLog.warn(`addMessage persistence failed: ${err.message}`));
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Complete';
    }
  }
}

/**
 * Post-process rendered HTML to add copy buttons to code blocks
 * and render diff blocks with syntax highlighting.
 */
function enhanceRenderedContent(container) {
  // Add copy button to all <pre> elements
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy-btn')) return; // already enhanced
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy-btn';
    copyBtn.type = 'button';
    copyBtn.title = 'Copy code';
    copyBtn.setAttribute('aria-label', 'Copy code');
    copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
    copyBtn.addEventListener('click', () => {
      const code = pre.querySelector('code') || pre;
      navigator.clipboard.writeText(code.textContent).then(() => {
        copyBtn.innerHTML = '<i class="fas fa-check"></i>';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
          copyBtn.classList.remove('copied');
        }, 2000);
      });
    });
    wrapper.appendChild(copyBtn);

    // Detect language badge from hljs class
    const code = pre.querySelector('code');
    if (code) {
      const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
      if (langClass) {
        const langBadge = document.createElement('span');
        langBadge.className = 'code-lang-badge';
        langBadge.textContent = langClass.replace('language-', '');
        wrapper.appendChild(langBadge);
      }
    }
  });
}

/**
 * Render a unified diff string as a colored diff block.
 */
function renderDiffBlock(diffString) {
  const container = document.createElement('div');
  container.className = 'diff-block';
  const lines = diffString.split('\n');
  for (const line of lines) {
    const lineEl = document.createElement('div');
    lineEl.className = 'diff-line';
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineEl.classList.add('diff-added');
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lineEl.classList.add('diff-removed');
    } else if (line.startsWith('@@')) {
      lineEl.classList.add('diff-hunk');
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      lineEl.classList.add('diff-header');
    }
    lineEl.textContent = line;
    container.appendChild(lineEl);
  }
  return container;
}

// Add message to chat display
function renderAssistantMessageContent(messageContent, text, format = 'markdown') {
  const safeFormat = String(format || 'markdown').toLowerCase();

  if (safeFormat === 'html') {
    messageContent.innerHTML = window.electron.markdown.sanitize(String(text || ''));
    return;
  }

  if (safeFormat === 'json' || safeFormat === 'xml' || safeFormat === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = String(text || '');
    messageContent.appendChild(pre);
    return;
  }

  messageContent.innerHTML = window.electron.markdown.parse(text || '');
  enhanceRenderedContent(messageContent);
}

/* --- History H2: the recall line under a reply, and its excerpt drawer --- */
function formatCompactTokens(value = 0) {
  const n = Number(value) || 0;
  const short = (x, unit) => `${x >= 10 ? Math.round(x) : Math.round(x * 10) / 10}${unit}`;
  if (n >= 1e6) return short(n / 1e6, 'M');
  if (n >= 1e3) return short(n / 1e3, 'K');
  return String(Math.round(n));
}

// Which retrieval a reply's recall ran (provenance embedder, vectorsSkipped).
function recallVia(context) {
  if (context?.embedder && context.embedder !== 'none') return 'BM25 + vectors';
  return context?.vectorsSkipped ? `BM25 only: ${context.vectorsSkipped}` : 'BM25';
}

function recallLineText(context) {
  const count = Number(context?.recalledExcerpts) || 0;
  const recalled = Number(context?.estTokens?.recalled) || 0;
  const full = Number(context?.fullHistoryEstTokens) || 0;
  return `recalled ${count} ${count === 1 ? 'excerpt' : 'excerpts'} · about ${formatCompactTokens(recalled)} tokens · from ${formatCompactTokens(full)} tokens of history · ${recallVia(context)}`;
}

function renderRecallLine(messageContent, context, { chatId, seq } = {}) {
  const line = document.createElement('div');
  line.className = 'message-recall-line';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'message-recall-toggle';
  toggle.textContent = recallLineText(context);
  const drawer = document.createElement('div');
  drawer.className = 'recall-drawer';
  drawer.hidden = true;
  const canOpen = (Number(context?.recalledExcerpts) || 0) > 0 && typeof chatId === 'string' && Number.isInteger(seq);
  toggle.disabled = !canOpen;
  let loaded = false;
  toggle.addEventListener('click', async () => {
    if (!canOpen) return;
    drawer.hidden = !drawer.hidden;
    if (drawer.hidden || loaded) return;
    loaded = true;
    drawer.textContent = 'Loading excerpts…';
    try {
      const result = await window.electron.history.excerpts({ chatId, seq });
      drawer.textContent = '';
      if (!result || result.ok === false) {
        drawer.textContent = result?.error || 'Excerpts are not available.';
        loaded = false;
        return;
      }
      for (const excerpt of result.excerpts || []) {
        const item = document.createElement('div');
        item.className = 'recall-excerpt';
        const header = document.createElement('div');
        header.className = 'recall-excerpt-header';
        header.textContent = excerpt.header;
        const body = document.createElement('pre');
        body.className = 'recall-excerpt-text';
        body.textContent = excerpt.text;
        item.append(header, body);
        drawer.appendChild(item);
      }
    } catch (err) {
      drawer.textContent = `Excerpts could not be loaded: ${err.message}`;
      loaded = false;
    }
  });
  line.append(toggle, drawer);
  messageContent.appendChild(line);
}

function addMessage(sender, text, metadata = {}) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${sender}`;
  
  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  if (sender === 'assistant') {
    renderAssistantMessageContent(messageContent, text, metadata?.format || 'markdown');
  } else {
    const messagePara = document.createElement('p');
    messagePara.textContent = text;
    messageContent.appendChild(messagePara);
  }

  renderMessageImages(messageContent, metadata?.images || []);
  renderMessageDocuments(messageContent, metadata?.documents || []);

  // A reply cut off by Stop keeps its text and says so (spec 2026-09-27 §9).
  if (sender === 'assistant' && metadata?.stopped) {
    const marker = document.createElement('div');
    marker.className = 'message-stopped-marker';
    marker.appendChild(faIcon('fas fa-circle-stop'));
    marker.appendChild(document.createTextNode(' Stopped'));
    messageContent.appendChild(marker);
  }

  if (sender === 'assistant' && metadata?.llm?.totals) {
    const callTotals = metadata.llm.totals;
    const runningTotals = metadata.runningLlmTotals;
    const metricsDiv = document.createElement('div');
    metricsDiv.className = 'message-metrics';

    const callSpan = document.createElement('span');
    callSpan.className = 'message-metrics-call';
    callSpan.textContent = `${formatTokenCount(callTotals.totalTokens)} tokens · ${formatCompactUsd(callTotals.costUsd)}${formatRoleCosts(metadata.llm.byRole)}`;

    if (runningTotals) {
      callSpan.textContent += ` · session ${formatTokenCount(runningTotals.totalTokens)} tokens · ${formatCompactUsd(runningTotals.costUsd)}`;
    }
    if (callTotals.partial) callSpan.textContent += ' · partial usage';
    if (callTotals.unpriced) callSpan.textContent += ' · includes unpriced calls';

    metricsDiv.appendChild(callSpan);

    messageContent.appendChild(metricsDiv);
  }

  // Recall provenance (history spec §7): what this reply was shown.
  if (sender === 'assistant' && metadata?.context) {
    renderRecallLine(messageContent, metadata.context, { chatId: metadata.chatId, seq: metadata.seq });
  }

  messageDiv.appendChild(messageContent);
  
  dom.chatMessages.appendChild(messageDiv);

  // Scroll to bottom
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

/* --- The chat's models: profile picker, main switcher, Retry with…
   (spec 2026-09-27 §6.5, §9, §11). Every change is a between-turns choice:
   a running turn keeps the models it launched with. --- */

let chatModelsFetchId = 0;

function applyUpdatedChat(chat) {
  if (!chat || !chat.id) return;
  appState.chats = appState.chats.map((c) => (c.id === chat.id ? chat : c));
  refreshUI();
}

async function refreshChatModels() {
  const chatId = appState.activeChatId;
  if (!dom.chatModelsSwitcher) return;
  if (!chatId || !window.electron?.models?.chatView) {
    dom.chatModelsSwitcher.hidden = true;
    return;
  }
  const fetchId = ++chatModelsFetchId;
  try {
    const result = unwrapIpcResult(await window.electron.models.chatView(chatId), 'Unable to read this chat\'s models.');
    if (fetchId !== chatModelsFetchId || chatId !== appState.activeChatId) return;
    appState.chatModels = result.view;
    renderChatModels(result.view);
  } catch (err) {
    if (fetchId !== chatModelsFetchId) return;
    modelLog.warn(`chat models: ${err.message}`);
    dom.chatModelsSwitcher.hidden = true;
  }
}

function renderChatModels(view) {
  if (!dom.chatModelsSwitcher || !view) return;
  dom.chatModelsSwitcher.hidden = false;

  const profiles = dom.chatProfileSelect;
  profiles.textContent = '';
  const defaultName = (view.profiles.find((p) => p.id === view.defaultProfileId) || {}).name || 'none';
  const standard = document.createElement('option');
  standard.value = '';
  standard.textContent = `Default profile (${defaultName})`;
  profiles.appendChild(standard);
  for (const p of view.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    profiles.appendChild(opt);
  }
  profiles.value = view.chosenProfileId || '';

  const main = dom.chatMainSelect;
  main.textContent = '';
  const current = document.createElement('option');
  if (view.main) {
    current.value = '__current__';
    current.textContent = view.main.usable ? `Main: ${view.main.name}` : `Main: ${view.main.name} (not usable)`;
  } else {
    current.value = '__none__';
    current.textContent = 'Main: none. Add one in Settings → Models';
  }
  main.appendChild(current);
  for (const c of view.choices) {
    if (view.main && c.provider === view.main.provider && c.model === view.main.model) continue;
    const opt = document.createElement('option');
    opt.value = JSON.stringify(choiceTarget(c));
    opt.textContent = c.inMain ? `${c.name} (profile's main)` : `${c.name} (${c.provider})`;
    main.appendChild(opt);
  }
  if (view.overridden) {
    const reset = document.createElement('option');
    reset.value = '__reset__';
    reset.textContent = 'Use the profile\'s main';
    main.appendChild(reset);
  }
  main.value = current.value;
  main.title = view.main && !view.main.usable ? view.main.reasons.join(' ') : 'Main model for this chat';
  dom.chatMainOverrideMarker.hidden = !view.overridden;
  applyChatModelsGate();
}

// Disabled while a turn is running for this chat: picking a model mid-turn
// would call applyUpdatedChat → refreshUI → renderChatMessages, which empties
// dom.chatMessages and wipes the live streaming node (spec 2026-09-27 §6.6:
// a running turn keeps the models it launched with).
function applyChatModelsGate() {
  const busy = appState.activeResponses.has(appState.activeChatId);
  if (dom.chatProfileSelect) dom.chatProfileSelect.disabled = busy;
  if (dom.chatMainSelect) dom.chatMainSelect.disabled = busy;
}

// A header or Retry with… choice as the override it sets: a profile main
// entry keeps its configured effort (final review m4).
function choiceTarget(c) {
  return { provider: c.provider, model: c.model, ...(c.effort ? { effort: c.effort } : {}) };
}

async function switchMainModel(target) {
  const chatId = appState.activeChatId;
  if (!chatId) return false;
  try {
    const result = unwrapIpcResult(await window.electron.models.setMainOverride({ chatId, target }), 'Unable to switch the main model.');
    applyUpdatedChat(result.chat);
    return true;
  } catch (err) {
    addMessage('assistant', `Error: ${err.message}`);
    return false;
  } finally {
    refreshChatModels();
  }
}

// On the last reply (stopped or not): the usable models, the profile's main
// first. Choosing one sets the main override and re-sends (spec §9).
function renderRetryControl() {
  const chat = getActiveChat();
  if (!chat || appState.activeResponses.has(chat.id) || !window.electron?.models?.chatView) return;
  const messages = chat.messages || [];
  const lastUser = messages.findLastIndex((m) => m.sender === 'user');
  const lastReply = messages.findLastIndex((m) => m.sender === 'assistant');
  if (lastUser < 0 || lastReply < lastUser) return;
  const replies = dom.chatMessages.querySelectorAll('.message.assistant');
  const reply = replies[replies.length - 1];
  if (!reply) return;
  const content = reply.querySelector('.message-content') || reply;
  const wrap = document.createElement('div');
  wrap.className = 'message-retry';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm';
  button.id = 'retry-with-btn';
  button.appendChild(faIcon('fas fa-rotate-right'));
  button.appendChild(document.createTextNode(' Retry with…'));
  const select = document.createElement('select');
  select.className = 'chat-info-select';
  select.id = 'retry-with-select';
  select.hidden = true;
  button.addEventListener('click', async () => {
    button.hidden = true;
    select.hidden = false;
    select.textContent = '';
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = 'Retry with…';
    select.appendChild(prompt);
    let view = appState.chatModels;
    try {
      view = unwrapIpcResult(await window.electron.models.chatView(chat.id), 'Unable to list models.').view;
    } catch (err) {
      modelLog.warn(`retry list: ${err.message}`);
    }
    for (const c of view?.choices || []) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(choiceTarget(c));
      opt.textContent = c.inMain ? `${c.name} (profile's main)` : `${c.name} (${c.provider})`;
      select.appendChild(opt);
    }
  });
  select.addEventListener('change', () => {
    if (select.value) retryWith(JSON.parse(select.value));
  });
  wrap.appendChild(button);
  wrap.appendChild(select);
  content.appendChild(wrap);
}

async function retryWith(target) {
  const chatId = appState.activeChatId;
  const chat = getActiveChat();
  if (!chatId || !chat) return;
  const index = chat.messages.findLastIndex((m) => m.sender === 'user');
  if (index < 0) return;
  // Switch first: a failed switch leaves the chat exactly as it was, the
  // user message and its reply both still there (final review m3). Only
  // then truncate and re-send, keeping the switch's status line.
  const before = chat.messages.length;
  if (!(await switchMainModel(target))) return;
  const after = appState.chats.find((c) => c.id === chatId)?.messages || [];
  const carry = after.slice(before).filter((m) => m.sender === 'status');
  await resendFromIndex(chatId, index, { carry });
}

if (dom.chatProfileSelect) {
  dom.chatProfileSelect.addEventListener('change', async () => {
    const chatId = appState.activeChatId;
    if (!chatId) return;
    // A running turn keeps the models it launched with; picking one now
    // would wipe the live streaming node (see applyChatModelsGate above).
    // The select is disabled while busy, but a programmatic change event
    // (tests, a stray dispatch) is still guarded against here.
    if (appState.activeResponses.has(chatId)) {
      if (appState.chatModels) renderChatModels(appState.chatModels);
      return;
    }
    try {
      const result = unwrapIpcResult(
        await window.electron.models.setChatProfile({ chatId, profileId: dom.chatProfileSelect.value || null }),
        'Unable to change the profile.'
      );
      applyUpdatedChat(result.chat);
    } catch (err) {
      addMessage('assistant', `Error: ${err.message}`);
    } finally {
      refreshChatModels();
    }
  });
}

if (dom.chatMainSelect) {
  dom.chatMainSelect.addEventListener('change', async () => {
    const value = dom.chatMainSelect.value;
    if (value === '__current__' || value === '__none__') return;
    const chatId = appState.activeChatId;
    if (chatId && appState.activeResponses.has(chatId)) {
      if (appState.chatModels) renderChatModels(appState.chatModels);
      return;
    }
    await switchMainModel(value === '__reset__' ? null : JSON.parse(value));
  });
}

async function loadChats() {
  const data = unwrapIpcResult(await window.electron.chat.load(), 'Unable to load chats.');
  appState.chats = data.chats || [];
  appState.historyStatus = data.history || null;
  const historyNotice = historyNoticeText(appState.historyStatus);
  if (historyNotice && appState.historyStatus.available !== false && !appState.historyNoticeShown) {
    appState.historyNoticeShown = true;
    showNotice(historyNotice);
  }
  appState.activeChatId = data.activeChatId || appState.chats[0]?.id || null;
  if (appState.activeChatId) {
    await ensureChatMessagesLoaded(appState.activeChatId);
  }
  const activeChat = appState.chats.find((c) => c.id === appState.activeChatId);
  appState.isAgentModeEnabled = !!(activeChat && activeChat.agentMode);
  appState.isSandboxModeEnabled = activeChat ? activeChat.sandboxMode !== false : true;
  refreshUI();
  refreshCaseQuestionsBar();
}

function persistAgentMode() {
  const chatId = appState.activeChatId;
  if (!chatId) return;
  const chat = appState.chats.find((c) => c.id === chatId);
  if (chat) chat.agentMode = appState.isAgentModeEnabled;
  window.electron.chat.setAgentMode(chatId, appState.isAgentModeEnabled).catch((err) => chatLog.warn(`setAgentMode persistence failed: ${err.message}`));
  refreshChatModels(); // agent mode changes what main needs
}

function persistSandboxMode() {
  const chatId = appState.activeChatId;
  if (!chatId) return;
  const chat = appState.chats.find((c) => c.id === chatId);
  if (chat) chat.sandboxMode = appState.isSandboxModeEnabled;
  window.electron.chat.setSandboxMode(chatId, appState.isSandboxModeEnabled).catch((err) => chatLog.warn(`setSandboxMode persistence failed: ${err.message}`));
}

async function handleCreateChat() {
  const newChat = unwrapIpcResult(await window.electron.chat.create('New Chat'), 'Unable to create chat.');
  if (newChat) {
    appState.chats = [newChat, ...appState.chats.filter((chat) => chat.id !== newChat.id)];
    appState.activeChatId = newChat.id;
    appState.isAgentModeEnabled = !!newChat.agentMode;
    appState.isSandboxModeEnabled = newChat.sandboxMode !== false;
    refreshUI();
  }
}

async function handleSelectChat(chatId) {
  appState.streamBuffers.clear();
  streamTextOffsets.clear();
  appState.activeChatId = chatId;
  refreshStopButton();
  let chat = appState.chats.find((c) => c.id === chatId);
  appState.isAgentModeEnabled = !!(chat && chat.agentMode);
  appState.isSandboxModeEnabled = chat ? chat.sandboxMode !== false : true;
  unwrapIpcResult(await window.electron.chat.setActive(chatId), 'Unable to switch active chat.');
  chat = await ensureChatMessagesLoaded(chatId) || chat;
  refreshUI();
  refreshCaseQuestionsBar();

  if (chat?.caseId && window.electron?.cases?.runningTurn) {
    window.electron.cases.runningTurn({ caseId: chat.caseId })
      .then((r) => {
        const state = unwrapIpcResult(r, 'Unable to read the case turn.');
        if (state?.running) appState.runningCaseTurns.add(chat.caseId);
        else appState.runningCaseTurns.delete(chat.caseId);
        refreshStopButton();
      })
      .catch((err) => chatLog.warn(`Case turn state failed: ${err.message}`));
  }

  if (chat?.canvasState?.visible && chat.canvasState.content) {
    showCanvas(chat.canvasState.title, chat.canvasState.content);
  } else {
    hideCanvas();
  }
}

async function handleRenameChat(chatId) {
  const chat = appState.chats.find((item) => item.id === chatId);
  if (!chat) {
    return;
  }
  const title = await showRenameDialog(chat.title);
  if (!title || title.trim() === '' || title.trim() === chat.title) {
    return;
  }
  const updated = await window.electron.chat.rename({ chatId, name: title.trim() });
  const safeUpdated = unwrapIpcResult(updated, 'Unable to rename chat.');
  if (safeUpdated) {
    appState.chats = appState.chats.map((item) => (item.id === safeUpdated.id ? safeUpdated : item));
    refreshUI();
  }
}

async function handleDeleteChat(chatId) {
  const chat = appState.chats.find((item) => item.id === chatId);
  if (!chat) {
    return;
  }
  const confirmed = await showConfirmDialog(`Delete "${chat.title}"? This cannot be undone.`);
  if (!confirmed) {
    return;
  }
  const result = unwrapIpcResult(await window.electron.chat.remove(chatId), 'Unable to delete chat.');
  appState.chats = result.chats || [];
  appState.activeChatId = result.activeChatId || appState.chats[0]?.id || null;
  await ensureChatMessagesLoaded(appState.activeChatId);
  refreshUI();
}

async function handleSaveProvider(providerKey) {
  const input = getTokenInput(providerKey);
  const token = input?.value || '';
  const validationError = validateToken(providerKey, token);
  if (validationError) {
    setProviderMessage(providerKey, validationError, true);
    return;
  }

  const result = await window.electron.settings.saveProvider({
    provider: providerKey,
    token
  });

  if (!result.ok) {
    setProviderMessage(providerKey, result.error || 'Unable to save token.', true);
    return;
  }

  if (input) input.value = '';
  appState.settings.providers[providerKey].hasToken = result.hasToken;
  delete appState.settings.providers[providerKey].status;
  renderSettings();
  setProviderMessage(providerKey, 'Token saved securely.');
}

async function handleClearProvider(providerKey) {
  const confirmed = await showConfirmDialog('Clear the saved token for this provider?');
  if (!confirmed) return;

  const result = await window.electron.settings.saveProvider({
    provider: providerKey,
    clear: true
  });

  if (!result.ok) {
    setProviderMessage(providerKey, result.error || 'Unable to clear token.', true);
    return;
  }

  appState.settings.providers[providerKey].hasToken = false;
  delete appState.settings.providers[providerKey].status;
  renderSettings();
  setProviderMessage(providerKey, 'Token removed.');
}

async function handleTestProvider(providerKey) {
  setProviderMessage(providerKey, 'Testing connection...');
  const result = await window.electron.settings.testProvider({ provider: providerKey });

  if (!result.ok) {
    updateProviderStatus(providerKey, result.status || { ok: false, message: result.error });
    setProviderMessage(providerKey, result.error || 'Connection failed.', true);
    return;
  }

  updateProviderStatus(providerKey, result.status);
  setProviderMessage(providerKey, result.status?.message || 'Connection successful.');
}

// Event Listeners
dom.sendBtn.addEventListener('click', sendMessage);

if (dom.stopBtn) {
  dom.stopBtn.addEventListener('click', async () => {
    if (!appState.activeChatId) return;

    // Force-clean streaming UI immediately — don't wait for backend
    const streamingDivs = dom.chatMessages.querySelectorAll('.message.streaming');
    streamingDivs.forEach((div) => {
      div.classList.remove('streaming');
      const content = div.querySelector('.message-content');
      if (content && !content.textContent.trim()) {
        div.remove();
      }
    });
    appState.streamBuffers.clear();
    streamTextOffsets.clear();
    if (appState.streamRenderedTools) appState.streamRenderedTools.clear();
    setResponseActive(false, appState.activeChatId);

    // Then tell the backend to abort
    try {
      await window.electron.chat.stopResponse(appState.activeChatId);
    } catch (err) {
      chatLog.warn(`stopResponse failed: ${err.message}`);
    }
  });
}

if (dom.attachImageBtn && dom.imageFileInput) {
  dom.attachImageBtn.addEventListener('click', () => {
    dom.imageFileInput.click();
  });

  dom.imageFileInput.addEventListener('change', async (event) => {
    await addImageFiles(event?.target?.files || []);
  });
}

// Slash command autocomplete
const SLASH_COMMANDS = [
  { cmd: '/help', desc: 'Show local command help' },
  { cmd: '/cd', desc: 'Set working directory for this chat' },
  { cmd: '/agent', desc: 'Toggle agent mode (on/off/status)' },
  { cmd: '/delegate', desc: 'Run tasks from a JSON plan file' },
  { cmd: '/profile', desc: 'View or set user profile fields' },
  { cmd: '/pin', desc: 'Pin a skill to current chat' },
  { cmd: '/unpin', desc: 'Unpin a skill from current chat' },
  { cmd: '/pinned', desc: 'List pinned skills' },
  { cmd: '/skill', desc: 'Execute a skill by name' },
  { cmd: '/llm', desc: 'Manage providers, tokens, and models' },
  { cmd: '/speak', desc: 'Speak last assistant message via TTS' },
  { cmd: '/fixit', desc: 'Run system diagnostics' }
];

let slashActiveIndex = -1;

function updateSlashAutocomplete() {
  const el = dom.slashAutocomplete;
  if (!el) return;

  const text = dom.userInput.value;
  if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) {
    el.hidden = true;
    slashActiveIndex = -1;
    return;
  }

  const query = text.toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(query));

  if (!matches.length || (matches.length === 1 && matches[0].cmd === query)) {
    el.hidden = true;
    slashActiveIndex = -1;
    return;
  }

  slashActiveIndex = 0;
  el.innerHTML = matches.map((m, i) =>
    `<div class="slash-autocomplete-item${i === 0 ? ' active' : ''}" data-cmd="${m.cmd}">` +
    `<span class="slash-cmd">${m.cmd}</span>` +
    `<span class="slash-desc">${m.desc}</span></div>`
  ).join('');
  el.hidden = false;

  el.querySelectorAll('.slash-autocomplete-item').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dom.userInput.value = item.dataset.cmd + ' ';
      el.hidden = true;
      slashActiveIndex = -1;
      dom.userInput.focus();
    });
  });
}

function navigateSlashAutocomplete(direction) {
  const el = dom.slashAutocomplete;
  if (!el || el.hidden) return false;
  const items = el.querySelectorAll('.slash-autocomplete-item');
  if (!items.length) return false;

  items[slashActiveIndex]?.classList.remove('active');
  slashActiveIndex = (slashActiveIndex + direction + items.length) % items.length;
  items[slashActiveIndex]?.classList.add('active');
  items[slashActiveIndex]?.scrollIntoView({ block: 'nearest' });
  return true;
}

function acceptSlashAutocomplete() {
  const el = dom.slashAutocomplete;
  if (!el || el.hidden) return false;
  const items = el.querySelectorAll('.slash-autocomplete-item');
  if (slashActiveIndex >= 0 && items[slashActiveIndex]) {
    dom.userInput.value = items[slashActiveIndex].dataset.cmd + ' ';
    el.hidden = true;
    slashActiveIndex = -1;
    return true;
  }
  return false;
}

dom.userInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && navigateSlashAutocomplete(-1)) {
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown' && navigateSlashAutocomplete(1)) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Tab' && acceptSlashAutocomplete()) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && dom.slashAutocomplete && !dom.slashAutocomplete.hidden) {
    dom.slashAutocomplete.hidden = true;
    slashActiveIndex = -1;
    e.preventDefault();
    return;
  }
});

dom.userInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    if (acceptSlashAutocomplete()) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea as user types
dom.userInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 200) + 'px';
  updateSlashAutocomplete();
});

dom.userInput.addEventListener('paste', async (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const imageFiles = items
    .filter((item) => item.type && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (imageFiles.length > 0) {
    event.preventDefault();
    await addImageFiles(imageFiles);
  }
});

dom.userInput.addEventListener('dragover', (event) => {
  event.preventDefault();
});

dom.userInput.addEventListener('drop', async (event) => {
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []).filter((file) => {
    if (file.type?.startsWith('image/')) return true;
    if (resolveDocumentMimeType(file)) return true;
    return false;
  });
  await addImageFiles(files);
});

// New chat button
dom.newChatBtn.addEventListener('click', handleCreateChat);
if (dom.newChatBtnCompact) {
  dom.newChatBtnCompact.addEventListener('click', handleCreateChat);
}

// Chat history item click handler
dom.chatList.addEventListener('click', (e) => {
  if (!dom.chatContextMenu.hidden && !e.target.closest('#chat-context-menu')) {
    closeContextMenu();
  }

  const actionButton = e.target.closest('.chat-action-btn');
  if (actionButton) {
    const { action, chatId } = actionButton.dataset;
    if (action === 'rename') {
      handleRenameChat(chatId);
    }
    if (action === 'delete') {
      handleDeleteChat(chatId);
    }
    return;
  }

  const chatItem = e.target.closest('.chat-item');
  if (chatItem) {
    handleSelectChat(chatItem.dataset.chatId);
  }
});

dom.chatMessages.addEventListener('click', (e) => {
  const actionButton = e.target.closest('[data-std-action]');
  if (!actionButton) return;

  const action = String(actionButton.dataset.stdAction || '').trim().toLowerCase();
  const taskId = String(actionButton.dataset.stdTaskId || '').trim();

  if (!action || !taskId) return;

  e.preventDefault();
  handleStdCardAction(action, taskId, actionButton);
});

dom.chatList.addEventListener('contextmenu', (e) => {
  const chatItem = e.target.closest('.chat-item');
  if (!chatItem) {
    return;
  }
  e.preventDefault();
  openContextMenu({ chatId: chatItem.dataset.chatId, x: e.clientX, y: e.clientY });
});

dom.chatContextMenu.addEventListener('click', (e) => {
  const actionButton = e.target.closest('.context-menu-item');
  if (!actionButton) {
    return;
  }
  if (actionButton.dataset.action === 'delete' && appState.contextChatId) {
    handleDeleteChat(appState.contextChatId);
  }
  closeContextMenu();
});

document.addEventListener('click', (e) => {
  if (!dom.chatContextMenu.hidden && !e.target.closest('#chat-context-menu')) {
    closeContextMenu();
  }
  if (!dom.messageContextMenu.hidden && !e.target.closest('#message-context-menu')) {
    dom.messageContextMenu.hidden = true;
  }
  if (!dom.inputContextMenu.hidden && !e.target.closest('#input-context-menu')) {
    dom.inputContextMenu.hidden = true;
  }
});

// --- Working directory picker ---
if (dom.workingDirBtn) {
  dom.workingDirBtn.addEventListener('click', async () => {
    if (!appState.activeChatId) return;
    try {
      // The IPC handler returns {canceled, chat} at the top level, which
      // wrapHandler wraps as {ok:true, data:{canceled, chat}}. Unwrap it
      // with the shared helper instead of reading result.chat directly.
      const data = unwrapIpcResult(
        await window.electron.chat.pickWorkingDirectory(appState.activeChatId),
        'Unable to set working directory.'
      );
      if (!data || data.canceled || !data.chat) return;
      appState.chats = appState.chats.map((c) => (c.id === data.chat.id ? data.chat : c));
      refreshUI();
    } catch (err) {
      chatLog.warn(`pickWorkingDirectory failed: ${err.message}`);
    }
  });
}

// --- Export chat as JSON ---
// Attachment bytes stay out of the export; name, type, size and a document's
// extracted text (what the model read) stay in.
function omitAttachmentBytes(msg) {
  if (!msg.documents && !msg.images) return msg;
  const strip = ({ base64, previewUrl, ...rest }) => (base64 ? { ...rest, base64Omitted: true } : rest);
  const out = { ...msg };
  if (Array.isArray(msg.documents)) out.documents = msg.documents.map(strip);
  if (Array.isArray(msg.images)) out.images = msg.images.map(strip);
  return out;
}

dom.exportChatBtn.addEventListener('click', () => {
  const chat = appState.chats.find(c => c.id === appState.activeChatId);
  if (!chat) return;

  // Enrich messages: extract XML tool blocks from assistant text into structured toolCalls
  const enrichedMessages = chat.messages.map(omitAttachmentBytes).map((msg) => {
    if (msg.sender !== 'assistant' || !msg.text) return msg;
    const { cleanText, toolBlocks } = extractXmlToolBlocks(msg.text);
    if (toolBlocks.length === 0) return msg;
    return { ...msg, text: cleanText, toolCalls: toolBlocks };
  });

  const exportData = { ...chat, messages: enrichedMessages };
  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(chat.title || 'chat').replace(/[^a-z0-9_-]/gi, '_')}_${chat.id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// --- Message right-click context menu ---
let messageContextTarget = null;
let messageContextCodeBlock = null;

dom.chatMessages.addEventListener('contextmenu', (e) => {
  const messageEl = e.target.closest('.message');
  if (!messageEl) return;
  e.preventDefault();
  messageContextTarget = messageEl;
  messageContextCodeBlock = e.target.closest('pre');

  // Show/hide "Copy code block" option based on whether click was on/inside a code block
  const copyCodeBtn = dom.messageContextMenu.querySelector('[data-action="copy-code"]');
  copyCodeBtn.style.display = messageContextCodeBlock ? '' : 'none';

  // Show "Resend" only for user messages
  const resendBtn = dom.messageContextMenu.querySelector('[data-action="resend"]');
  resendBtn.style.display = messageEl.classList.contains('user') ? '' : 'none';

  dom.messageContextMenu.hidden = false;
  const menuRect = dom.messageContextMenu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 8;
  const maxY = window.innerHeight - menuRect.height - 8;
  dom.messageContextMenu.style.left = `${Math.min(e.clientX, maxX)}px`;
  dom.messageContextMenu.style.top = `${Math.min(e.clientY, maxY)}px`;
});

dom.messageContextMenu.addEventListener('click', (e) => {
  const actionBtn = e.target.closest('.context-menu-item');
  if (!actionBtn || !messageContextTarget) return;
  const action = actionBtn.dataset.action;

  if (action === 'copy') {
    // Copy the selected text if any, otherwise the full message text
    const selection = window.getSelection();
    const selectedText = selection && selection.toString().trim();
    const text = selectedText || messageContextTarget.querySelector('.message-content')?.innerText || '';
    navigator.clipboard.writeText(text);
  } else if (action === 'copy-code' && messageContextCodeBlock) {
    const codeEl = messageContextCodeBlock.querySelector('code') || messageContextCodeBlock;
    navigator.clipboard.writeText(codeEl.innerText);
  } else if (action === 'resend' && messageContextTarget.classList.contains('user')) {
    resendUserMessage(messageContextTarget);
  }

  dom.messageContextMenu.hidden = true;
  messageContextTarget = null;
  messageContextCodeBlock = null;
});

// --- Input panel resize handle ---
{
  let resizing = false;
  let startY = 0;
  let startHeight = 0;
  const MIN_HEIGHT = 100;
  const MAX_HEIGHT = 500;

  dom.inputResizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizing = true;
    startY = e.clientY;
    startHeight = dom.inputContainer.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const delta = startY - e.clientY;
    const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + delta));
    dom.inputContainer.style.height = `${newHeight}px`;
    dom.userInput.style.flex = '1';
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// --- Input textarea right-click context menu ---
dom.userInput.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const hasSelection = dom.userInput.selectionStart !== dom.userInput.selectionEnd;
  dom.inputContextMenu.querySelector('[data-action="cut"]').classList.toggle('disabled', !hasSelection);
  dom.inputContextMenu.querySelector('[data-action="copy"]').classList.toggle('disabled', !hasSelection);

  dom.inputContextMenu.hidden = false;
  const menuRect = dom.inputContextMenu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 8;
  const maxY = window.innerHeight - menuRect.height - 8;
  dom.inputContextMenu.style.left = `${Math.min(e.clientX, maxX)}px`;
  dom.inputContextMenu.style.top = `${Math.min(e.clientY, maxY)}px`;
});

dom.inputContextMenu.addEventListener('click', async (e) => {
  const actionBtn = e.target.closest('.context-menu-item');
  if (!actionBtn) return;
  const action = actionBtn.dataset.action;
  const { selectionStart, selectionEnd } = dom.userInput;

  if (action === 'cut') {
    const selected = dom.userInput.value.substring(selectionStart, selectionEnd);
    if (selected) {
      await navigator.clipboard.writeText(selected);
      dom.userInput.setRangeText('', selectionStart, selectionEnd, 'end');
      dom.userInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (action === 'copy') {
    const selected = dom.userInput.value.substring(selectionStart, selectionEnd);
    if (selected) await navigator.clipboard.writeText(selected);
  } else if (action === 'paste') {
    const text = await navigator.clipboard.readText();
    dom.userInput.setRangeText(text, selectionStart, selectionEnd, 'end');
    dom.userInput.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (action === 'select-all') {
    dom.userInput.select();
  }

  dom.inputContextMenu.hidden = true;
  dom.userInput.focus();
});

if (dom.openSettingsBtn) {
  dom.openSettingsBtn.addEventListener('click', openSettingsDrawer);
}

if (dom.floatingSettingsBtn) {
  dom.floatingSettingsBtn.addEventListener('click', openSettingsDrawer);
}

if (dom.composerSettingsBtn) {
  dom.composerSettingsBtn.addEventListener('click', openSettingsDrawer);
}

if (dom.agentModeBtn) {
  dom.agentModeBtn.addEventListener('click', () => {
    appState.isAgentModeEnabled = !appState.isAgentModeEnabled;
    persistAgentMode();
    renderAgentModeButton();
    addStatusMessage(`Agent mode: ${appState.isAgentModeEnabled ? 'on' : 'off'}`);
  });
}

if (dom.toggleHistoryBtn) {
  dom.toggleHistoryBtn.addEventListener('click', () => {
    setHistoryCollapsed(!appState.isHistoryCollapsed);
  });
}

// --- Sidebar horizontal resize handle ---
{
  let resizing = false;
  let startX = 0;
  let startWidth = 0;
  const MIN_WIDTH = 220;
  const MAX_WIDTH = 520;

  if (dom.sidebarResizeHandle) {
    dom.sidebarResizeHandle.addEventListener('mousedown', (e) => {
      if (appState.isHistoryCollapsed) return;
      e.preventDefault();
      resizing = true;
      startX = e.clientX;
      startWidth = dom.sidebar.offsetWidth;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (!resizing || !dom.sidebar) return;
    const delta = e.clientX - startX;
    const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
    dom.sidebar.style.width = `${newWidth}px`;
    dom.sidebar.style.minWidth = `${newWidth}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

/* --- Canvas panel ------------------------------------------ */
function wrapCanvasContent(content) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  body { margin: 0; padding: 16px; font-family: system-ui, -apple-system, sans-serif; color: #1a1a1a; }
  * { box-sizing: border-box; }
</style>
</head><body>
${content}
<script>
window._klSendAction = function(action, data) {
  window.parent.postMessage({ type: 'kl-canvas-action', action: action, data: data }, '*');
};
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'kl-execute-js') {
    try {
      var result = eval(e.data.code);
      window.parent.postMessage({ type: 'kl-js-result', requestId: e.data.requestId, result: String(result == null ? '' : result) }, '*');
    } catch(err) {
      window.parent.postMessage({ type: 'kl-js-result', requestId: e.data.requestId, error: err.message }, '*');
    }
  }
});
</script>
</body></html>`;
}

function showCanvas(title, content) {
  appState.canvasVisible = true;
  dom.canvasPanel.hidden = false;
  dom.canvasResizeHandle.hidden = false;
  dom.canvasTitle.textContent = title || 'Canvas';
  dom.canvasFrame.srcdoc = wrapCanvasContent(content);
}

function hideCanvas() {
  appState.canvasVisible = false;
  dom.canvasPanel.hidden = true;
  dom.canvasResizeHandle.hidden = true;
  dom.canvasFrame.srcdoc = '';
}

if (dom.canvasCloseBtn) {
  dom.canvasCloseBtn.addEventListener('click', () => {
    hideCanvas();
    if (appState.activeChatId) {
      window.electron.canvas.close(appState.activeChatId).catch(() => {});
    }
  });
}

window.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') return;
  if (event.source !== dom.canvasFrame?.contentWindow) return;

  if (event.data.type === 'kl-canvas-action') {
    window.electron.canvas.sendUserAction({
      chatId: appState.activeChatId,
      action: event.data.action,
      data: event.data.data
    });
  }

  if (event.data.type === 'kl-js-result') {
    window.electron.canvas.sendJsResult({
      requestId: event.data.requestId,
      result: event.data.result,
      error: event.data.error
    });
  }
});

// Canvas resize handle
{
  let resizing = false;
  let startX = 0;
  let startWidth = 0;
  const MIN_WIDTH = 300;

  if (dom.canvasResizeHandle) {
    dom.canvasResizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizing = true;
      startX = e.clientX;
      startWidth = dom.canvasPanel.offsetWidth;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (!resizing || !dom.canvasPanel) return;
    const delta = startX - e.clientX;
    const maxWidth = Math.floor(window.innerWidth * 0.7);
    const newWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + delta));
    dom.canvasPanel.style.width = `${newWidth}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

/* --- Chat info popover ------------------------------------- */
if (dom.chatInfoBtn) {
  dom.chatInfoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleChatInfoPopover();
  });
}

if (dom.chatInfoCloseBtn) {
  dom.chatInfoCloseBtn.addEventListener('click', () => {
    dom.chatInfoPopover.hidden = true;
  });
}

document.addEventListener('click', (e) => {
  if (dom.chatInfoPopover && !dom.chatInfoPopover.hidden &&
      !e.target.closest('.chat-info-popover') && !e.target.closest('#chat-info-btn') &&
      !e.target.closest('.rename-chat-modal')) {
    dom.chatInfoPopover.hidden = true;
  }
  if (dom.chatMcpPopover && !dom.chatMcpPopover.hidden &&
      !e.target.closest('#chat-mcp-popover') && !e.target.closest('#chat-mcp-btn')) {
    dom.chatMcpPopover.hidden = true;
  }
});

/* --- File checkpoints popover ------------------------------- */

async function refreshCheckpointToggle() {
  if (!dom.checkpointsEnabled) return;
  try {
    const status = unwrapIpcResult(
      await window.electron.checkpoints.getStatus(),
      'Could not read checkpoint status.'
    );
    dom.checkpointsEnabled.checked = status.enabled === true;
    dom.checkpointsEnabled.disabled = !status.available;
  } catch {
    dom.checkpointsEnabled.checked = false;
  }
}

function formatCheckpointTime(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const elapsedMin = Math.floor((Date.now() - at.getTime()) / 60000);
  if (elapsedMin < 1) return 'just now';
  if (elapsedMin < 60) return `${elapsedMin}m ago`;
  if (elapsedMin < 24 * 60) return `${Math.floor(elapsedMin / 60)}h ago`;
  return at.toLocaleString();
}

async function renderCheckpointsList() {
  if (!dom.checkpointsList) return;

  const chat = getActiveChat();
  const workingDirectory = chat?.workingDirectory || null;

  dom.checkpointsList.innerHTML = '';

  if (!workingDirectory) {
    dom.checkpointsList.textContent = 'Set a working directory to use checkpoints.';
    return;
  }

  let status;
  try {
    status = unwrapIpcResult(
      await window.electron.checkpoints.getStatus(),
      'Could not read checkpoint status.'
    );
  } catch {
    status = { enabled: false };
  }

  if (!status.enabled) {
    const note = document.createElement('p');
    note.className = 'provider-message';
    note.textContent = 'Checkpoints are off. Turn them on in Settings → General.';
    dom.checkpointsList.appendChild(note);
    return;
  }

  dom.checkpointsList.textContent = 'Loading…';

  let checkpoints = [];
  try {
    const result = unwrapIpcResult(
      await window.electron.checkpoints.list({ workingDirectory, limit: 25 }),
      'Could not list checkpoints.'
    );
    checkpoints = result.checkpoints || [];
  } catch (err) {
    dom.checkpointsList.textContent = err.message || 'Could not list checkpoints.';
    return;
  }

  dom.checkpointsList.innerHTML = '';

  if (checkpoints.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'provider-message';
    empty.textContent = 'No checkpoints yet. One is taken before the first file change of a turn.';
    dom.checkpointsList.appendChild(empty);
    return;
  }

  for (const checkpoint of checkpoints) {
    const row = document.createElement('div');
    row.className = 'checkpoint-row';

    const info = document.createElement('div');
    info.className = 'checkpoint-info';

    const when = document.createElement('div');
    when.className = 'checkpoint-when';
    when.textContent = formatCheckpointTime(checkpoint.createdAt);

    const label = document.createElement('div');
    label.className = 'checkpoint-label';
    label.textContent = checkpoint.message || 'checkpoint';
    label.title = checkpoint.id;

    info.appendChild(when);
    info.appendChild(label);

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn btn-sm';
    restoreBtn.appendChild(faIcon('fas fa-rotate-left'));
    restoreBtn.appendChild(document.createTextNode(' Restore'));

    restoreBtn.addEventListener('click', async () => {
      // Restoring rewrites files on disk, so it always goes through an
      // explicit confirmation naming what will change.
      const confirmed = window.confirm(
        `Restore files in\n${workingDirectory}\n\nto the state at "${checkpoint.message}"?\n\n`
        + 'Changes made after this point will be undone. A safety checkpoint '
        + 'is taken first, so this can itself be undone.'
      );
      if (!confirmed) return;

      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Restoring…';

      try {
        unwrapIpcResult(
          await window.electron.checkpoints.restore({
            workingDirectory,
            checkpointId: checkpoint.id
          }),
          'Restore failed.'
        );
        await renderCheckpointsList();
      } catch (err) {
        restoreBtn.disabled = false;
        restoreBtn.textContent = 'Restore';
        window.alert(err.message || 'Restore failed.');
      }
    });

    row.appendChild(info);
    row.appendChild(restoreBtn);
    dom.checkpointsList.appendChild(row);
  }
}

if (dom.checkpointsBtn) {
  dom.checkpointsBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!dom.checkpointsPopover) return;
    const willOpen = dom.checkpointsPopover.hidden;
    dom.checkpointsPopover.hidden = !willOpen;
    if (willOpen) await renderCheckpointsList();
  });
}

if (dom.checkpointsCloseBtn) {
  dom.checkpointsCloseBtn.addEventListener('click', () => {
    if (dom.checkpointsPopover) dom.checkpointsPopover.hidden = true;
  });
}

document.addEventListener('click', (e) => {
  if (dom.checkpointsPopover && !dom.checkpointsPopover.hidden
      && !e.target.closest('#checkpoints-popover') && !e.target.closest('#checkpoints-btn')) {
    dom.checkpointsPopover.hidden = true;
  }
});

if (dom.checkpointsEnabled) {
  dom.checkpointsEnabled.addEventListener('change', async () => {
    const enabled = Boolean(dom.checkpointsEnabled.checked);
    try {
      unwrapIpcResult(
        await window.electron.checkpoints.setEnabled({ enabled }),
        'Could not change the checkpoint setting.'
      );
      if (dom.checkpointsStatus) {
        dom.checkpointsStatus.textContent = enabled
          ? 'File checkpoints enabled.'
          : 'File checkpoints disabled.';
        dom.checkpointsStatus.classList.remove('error');
      }
    } catch (err) {
      dom.checkpointsEnabled.checked = !enabled;
      if (dom.checkpointsStatus) {
        dom.checkpointsStatus.textContent = err.message || 'Could not change the checkpoint setting.';
        dom.checkpointsStatus.classList.add('error');
      }
    }
  });
}

/* --- Chat MCP popover -------------------------------------- */
if (dom.chatMcpBtn) {
  dom.chatMcpBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!dom.chatMcpPopover) return;
    const willOpen = dom.chatMcpPopover.hidden;
    if (willOpen) await renderChatMcpToggles();
    dom.chatMcpPopover.hidden = !willOpen;
  });
}
if (dom.chatMcpCloseBtn) {
  dom.chatMcpCloseBtn.addEventListener('click', () => {
    if (dom.chatMcpPopover) dom.chatMcpPopover.hidden = true;
  });
}

async function renderChatMcpToggles() {
  if (!dom.chatMcpToggles) return;
  const chat = getActiveChat();
  dom.chatMcpToggles.innerHTML = '';

  if (!chat) {
    dom.chatMcpToggles.textContent = 'No active chat.';
    return;
  }

  let servers = [];
  try {
    const result = await window.electron.settings.mcpList();
    if (result?.ok) servers = result.servers || [];
  } catch (err) {
    dom.chatMcpToggles.textContent = `Error loading servers: ${err.message}`;
    return;
  }

  if (servers.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'provider-message';
    hint.textContent = 'No MCP servers configured. Add them in Settings → MCP Servers.';
    dom.chatMcpToggles.appendChild(hint);
    return;
  }

  const disabled = new Set(Array.isArray(chat.disabledMcpServers) ? chat.disabledMcpServers : []);

  servers.forEach((s) => {
    const row = document.createElement('label');
    row.className = 'inline-toggle';
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    row.style.padding = '6px 0';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !disabled.has(s.name);
    checkbox.dataset.mcpServer = s.name;

    const label = document.createElement('span');
    label.textContent = s.name;

    const meta = document.createElement('span');
    meta.className = 'provider-message';
    meta.style.marginLeft = 'auto';
    meta.textContent = s.connected ? `${(s.tools || []).length} tools` : 'offline';

    checkbox.addEventListener('change', async () => {
      const checked = checkbox.checked;
      if (checked) disabled.delete(s.name); else disabled.add(s.name);
      try {
        const updated = await window.electron.chat.setDisabledMcpServers(chat.id, Array.from(disabled));
        if (updated) {
          const idx = appState.chats.findIndex((c) => c.id === chat.id);
          if (idx >= 0) appState.chats[idx] = updated;
        }
      } catch (err) {
        chatMcpLog.warn(`Failed to update disabled servers: ${err.message}`);
        // Revert on failure
        checkbox.checked = !checked;
        if (checked) disabled.add(s.name); else disabled.delete(s.name);
      }
    });

    row.appendChild(checkbox);
    row.appendChild(label);
    row.appendChild(meta);
    dom.chatMcpToggles.appendChild(row);
  });
}

if (dom.closeSettingsBtn) {
  dom.closeSettingsBtn.addEventListener('click', () => {
    setSettingsDrawer(false);
  });
}

dom.settingsDrawer.addEventListener('click', (e) => {
  if (e.target === dom.settingsDrawer) {
    setSettingsDrawer(false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!dom.settingsDrawer.hidden) {
      setSettingsDrawer(false);
      dom.userInput.focus();
      return;
    }
    // No more modal dialogs to dismiss — prompts are inline in chat
  }
});

/* --- Settings tab switching -------------------------------- */
if (dom.settingsNavSelect) {
  sortSettingsNavOptions();
  dom.settingsNavSelect.addEventListener('change', () => {
    switchSettingsTab(dom.settingsNavSelect.value);
  });
}

/* --- General defaults -------------------------------------- */
async function saveGeneralDefaults() {
  try {
    const defaults = {
      agentMode: dom.defaultAgentMode?.checked || false,
      sandboxMode: dom.defaultSandboxMode?.checked !== false
    };
    const result = unwrapIpcResult(
      await window.electron.settings.saveDefaults({ defaults }),
      'Failed to save defaults.'
    );
    appState.settings.defaults = result.defaults || defaults;
    if (dom.generalDefaultsStatus) {
      dom.generalDefaultsStatus.textContent = 'Defaults saved.';
      dom.generalDefaultsStatus.classList.remove('error');
    }
  } catch (err) {
    if (dom.generalDefaultsStatus) {
      dom.generalDefaultsStatus.textContent = err.message || 'Failed to save defaults.';
      dom.generalDefaultsStatus.classList.add('error');
    }
  }
}
if (dom.defaultAgentMode) dom.defaultAgentMode.addEventListener('change', saveGeneralDefaults);
if (dom.defaultSandboxMode) dom.defaultSandboxMode.addEventListener('change', saveGeneralDefaults);

/* --- Skills list actions ----------------------------------- */
if (dom.skillsList) {
  dom.skillsList.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    const { action, skillId, nextEnabled, skillName } = button.dataset;
    if (action === 'toggle-skill' && skillId) {
      toggleSkillEnabled(skillId, nextEnabled === 'true');
    } else if (action === 'open-skill-settings' && skillId) {
      switchSettingsTab(`skill-${skillId}`);
    } else if (action === 'update-skill' && skillId) {
      updateSkill(skillId, skillName);
    } else if (action === 'remove-skill' && skillId) {
      removeSkill(skillId, skillName);
    }
  });
}

if (dom.skillInstallBtn) {
  dom.skillInstallBtn.addEventListener('click', () => installSkill());
}

if (dom.skillInstallUrl) {
  dom.skillInstallUrl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') installSkill();
  });
}

/* --- Skill settings save ---------------------------------- */
if (dom.skillSettingsContainer) {
  dom.skillSettingsContainer.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-action="save-skill-settings"]');
    if (!button) return;
    const { skillId } = button.dataset;
    if (skillId) saveSkillSettings(skillId);
  });
}

/* --- Channel management: Telegram -------------------------- */
if (dom.saveTelegramTokenBtn) {
  dom.saveTelegramTokenBtn.addEventListener('click', async () => {
    const token = dom.channelTelegramTokenInput?.value?.trim();
    if (!token) return;
    try {
      unwrapIpcResult(
        await window.electron.settings.runLlmCommand({ command: `telegram add ${token}` }),
        'Failed to save Telegram token.'
      );
      dom.channelTelegramTokenInput.value = '';
      if (dom.telegramChannelStatus) {
        dom.telegramChannelStatus.textContent = 'Token saved successfully.';
        dom.telegramChannelStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.telegramChannelStatus) {
        dom.telegramChannelStatus.textContent = err.message || 'Error saving token.';
        dom.telegramChannelStatus.classList.add('error');
      }
    }
  });
}

if (dom.testTelegramBtn) {
  dom.testTelegramBtn.addEventListener('click', async () => {
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.runLlmCommand({ command: 'telegram test' }),
        'Failed to test Telegram.'
      );
      if (dom.telegramChannelStatus) {
        dom.telegramChannelStatus.textContent = result.message || 'Test successful.';
        dom.telegramChannelStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.telegramChannelStatus) {
        dom.telegramChannelStatus.textContent = err.message || 'Test failed.';
        dom.telegramChannelStatus.classList.add('error');
      }
    }
  });
}

if (dom.clearTelegramTokenBtn) {
  dom.clearTelegramTokenBtn.addEventListener('click', async () => {
    try {
      unwrapIpcResult(
        await window.electron.settings.runLlmCommand({ command: 'telegram remove' }),
        'Failed to clear Telegram token.'
      );
      if (dom.telegramChannelStatus) {
        dom.telegramChannelStatus.textContent = 'Token cleared.';
        dom.telegramChannelStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.telegramChannelStatus) {
        dom.telegramChannelStatus.textContent = err.message || 'Error clearing token.';
        dom.telegramChannelStatus.classList.add('error');
      }
    }
  });
}

/* --- Channel access control: allowlist + approval target ----
 *
 * Two security rules from the channel hardening pass need a way in:
 *   1. A channel with an empty allowlist refuses every sender, so the owner
 *      has to be able to add their own id or the bot answers nobody.
 *   2. A tool approval goes only to `approvalChatId` and is denied when that
 *      is unset, so the owner has to be able to name their own chat.
 * Only individual ids can be added or removed here. There is deliberately no
 * "allow everyone" control — an open channel lets any stranger who finds the
 * bot drive the agent.
 */
const CHANNEL_ACCESS_CHANNELS = ['telegram', 'discord'];

function channelAccessEl(channel, suffix) {
  return document.getElementById(`channel-${channel}-${suffix}`);
}

function setChannelAccessStatus(channel, message, isError = false) {
  const el = channelAccessEl(channel, 'access-status');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('error', Boolean(isError));
}

// Ids come from strangers on the internet, so every one of them is written
// with textContent and never interpolated into HTML.
function renderChannelIdRow(label, actionLabel, onAction, actionClass = 'btn') {
  const row = document.createElement('div');
  row.className = 'channel-access-row';

  const text = document.createElement('span');
  text.className = 'channel-access-id';
  text.textContent = label;
  row.appendChild(text);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn-small ${actionClass}`;
  button.textContent = actionLabel;
  button.addEventListener('click', onAction);
  row.appendChild(button);

  return row;
}

// `defaultPolicy` decides what an *empty* list means. AllowlistManager no
// longer returns 'allow' for any channel — a stored allow-all is ignored and
// rewritten to deny — but the pane must never be the thing that claims a
// channel is closed while it is open, so it reads the policy it was given
// rather than assuming.
function renderChannelAccessList(channel, kind, ids, defaultPolicy = 'deny') {
  const container = channelAccessEl(channel, `${kind === 'user' ? 'users' : 'groups'}-list`);
  if (!container) return;
  container.innerHTML = '';
  if (!ids.length) {
    const empty = document.createElement('div');
    empty.className = 'channel-access-empty';
    if (defaultPolicy === 'allow') {
      empty.classList.add('channel-access-warning');
      empty.textContent = 'No ids listed — but this channel is OPEN TO EVERYONE: '
        + 'its stored policy allows every sender. Add an id to close it.';
    } else {
      empty.textContent = 'None — nobody can reach the agent this way.';
    }
    container.appendChild(empty);
    return;
  }
  ids.forEach((id) => {
    container.appendChild(renderChannelIdRow(id, 'Remove', () => {
      removeChannelId(channel, kind, id);
    }, 'btn-danger'));
  });
}

function renderChannelRefusals(channel, refusals) {
  const block = channelAccessEl(channel, 'refused-block');
  const list = channelAccessEl(channel, 'refused-list');
  if (!block || !list) return;
  list.innerHTML = '';
  if (!refusals.length) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  refusals.forEach((entry) => {
    if (entry.senderId) {
      const times = entry.count > 1 ? ` (${entry.count} messages)` : '';
      list.appendChild(renderChannelIdRow(`user ${entry.senderId}${times}`, 'Allow User', () => {
        allowChannelId(channel, 'user', entry.senderId);
      }, 'btn-primary'));
    }
    if (entry.groupId) {
      list.appendChild(renderChannelIdRow(`group ${entry.groupId}`, 'Allow Group', () => {
        allowChannelId(channel, 'group', entry.groupId);
      }, 'btn-primary'));
    }
  });
}

// `note` is prepended to the status line rather than replacing it: the line
// also carries "approvals are denied until you set a target" and, if the
// channel is open to everyone, the warning about that. "Added user X." used to
// clobber both until the pane was reopened.
function applyChannelAccess(access, note = '') {
  const channel = access.channel;
  const defaultPolicy = access.defaultPolicy === 'allow' ? 'allow' : 'deny';
  renderChannelAccessList(channel, 'user', access.users || [], defaultPolicy);
  renderChannelAccessList(channel, 'group', access.groups || [], defaultPolicy);
  renderChannelRefusals(channel, access.recentRefusals || []);

  const approvalInput = channelAccessEl(channel, 'approval-input');
  if (approvalInput && document.activeElement !== approvalInput) {
    approvalInput.value = access.approvalChatId || '';
  }
  const status = channelAccessStatusText(access, defaultPolicy);
  setChannelAccessStatus(channel, note ? `${note} ${status}` : status, defaultPolicy === 'allow');
}

// One line that states both things the owner needs: who can reach the agent,
// and where approvals go. An open channel is said first and in full, because
// it is the dangerous state.
function channelAccessStatusText(access, defaultPolicy) {
  const approvals = access.approvalChatId
    ? `Approvals go to ${access.approvalChatId}.`
    : 'No approval target set — every approval from this channel is denied.';
  if (defaultPolicy === 'allow') {
    return `WARNING: this channel is open to every sender, whatever the lists below show. ${approvals}`;
  }
  return approvals;
}

async function refreshChannelAccess(channel) {
  if (!window.electron?.channels) return;
  try {
    const access = unwrapIpcResult(
      await window.electron.channels.getAccess({ channel }),
      'Failed to load channel access settings.'
    );
    applyChannelAccess(access);
  } catch (err) {
    setChannelAccessStatus(channel, err.message || 'Failed to load channel access settings.', true);
  }
}

function loadChannelAccess() {
  return Promise.all(CHANNEL_ACCESS_CHANNELS.map((channel) => refreshChannelAccess(channel)));
}

async function allowChannelId(channel, kind, id) {
  try {
    const access = unwrapIpcResult(
      await window.electron.channels.allow({ channel, kind, id: String(id) }),
      'Failed to add the id.'
    );
    applyChannelAccess(access, `Added ${kind} ${id}.`);
  } catch (err) {
    setChannelAccessStatus(channel, err.message || 'Failed to add the id.', true);
  }
}

async function removeChannelId(channel, kind, id) {
  try {
    const access = unwrapIpcResult(
      await window.electron.channels.remove({ channel, kind, id: String(id) }),
      'Failed to remove the id.'
    );
    applyChannelAccess(access, `Removed ${kind} ${id}.`);
  } catch (err) {
    setChannelAccessStatus(channel, err.message || 'Failed to remove the id.', true);
  }
}

CHANNEL_ACCESS_CHANNELS.forEach((channel) => {
  ['user', 'group'].forEach((kind) => {
    const addBtn = channelAccessEl(channel, `${kind}-add-btn`);
    const input = channelAccessEl(channel, `${kind}-input`);
    if (!addBtn || !input) return;
    const submit = async () => {
      const id = input.value.trim();
      if (!id) {
        setChannelAccessStatus(channel, 'Enter an id first.', true);
        return;
      }
      await allowChannelId(channel, kind, id);
      input.value = '';
    };
    addBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
    });
  });

  const approvalSaveBtn = channelAccessEl(channel, 'approval-save-btn');
  const approvalInput = channelAccessEl(channel, 'approval-input');
  if (approvalSaveBtn && approvalInput) {
    approvalSaveBtn.addEventListener('click', async () => {
      try {
        unwrapIpcResult(
          await window.electron.channels.setApprovalTarget({
            channel,
            approvalChatId: approvalInput.value.trim()
          }),
          'Failed to save the approval target.'
        );
        await refreshChannelAccess(channel);
      } catch (err) {
        setChannelAccessStatus(channel, err.message || 'Failed to save the approval target.', true);
      }
    });
  }
});

/* --- Provider management: Web Search keys ------------------- */
if (dom.saveWebsearchBraveBtn) {
  dom.saveWebsearchBraveBtn.addEventListener('click', async () => {
    const apiKey = dom.websearchBraveKeyInput?.value?.trim();
    if (!apiKey) return;
    try {
      unwrapIpcResult(
        await window.electron.settings.saveWebSearchKey({ provider: 'brave', apiKey }),
        'Failed to save Brave key.'
      );
      dom.websearchBraveKeyInput.value = '';
      if (dom.websearchBraveStatus) {
        dom.websearchBraveStatus.textContent = 'Key saved.';
        dom.websearchBraveStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchBraveStatus) {
        dom.websearchBraveStatus.textContent = err.message || 'Error saving key.';
        dom.websearchBraveStatus.classList.add('error');
      }
    }
  });
}

if (dom.testWebsearchBraveBtn) {
  dom.testWebsearchBraveBtn.addEventListener('click', async () => {
    dom.testWebsearchBraveBtn.disabled = true;
    if (dom.websearchBraveStatus) {
      dom.websearchBraveStatus.textContent = 'Testing Brave Search...';
      dom.websearchBraveStatus.classList.remove('error');
    }
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.testWebSearchKey({ provider: 'brave' }),
        'Failed to test Brave Search.'
      );
      if (dom.websearchBraveStatus) {
        dom.websearchBraveStatus.textContent = result.message || 'Connection successful.';
        dom.websearchBraveStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchBraveStatus) {
        dom.websearchBraveStatus.textContent = err.message || 'Test failed.';
        dom.websearchBraveStatus.classList.add('error');
      }
    } finally {
      dom.testWebsearchBraveBtn.disabled = false;
    }
  });
}

if (dom.clearWebsearchBraveBtn) {
  dom.clearWebsearchBraveBtn.addEventListener('click', async () => {
    try {
      unwrapIpcResult(
        await window.electron.settings.saveWebSearchKey({ provider: 'brave', clear: true }),
        'Failed to clear Brave key.'
      );
      if (dom.websearchBraveStatus) {
        dom.websearchBraveStatus.textContent = 'Key cleared.';
        dom.websearchBraveStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchBraveStatus) {
        dom.websearchBraveStatus.textContent = err.message || 'Error.';
        dom.websearchBraveStatus.classList.add('error');
      }
    }
  });
}

if (dom.saveWebsearchTavilyBtn) {
  dom.saveWebsearchTavilyBtn.addEventListener('click', async () => {
    const apiKey = dom.websearchTavilyKeyInput?.value?.trim();
    if (!apiKey) return;
    try {
      unwrapIpcResult(
        await window.electron.settings.saveWebSearchKey({ provider: 'tavily', apiKey }),
        'Failed to save Tavily key.'
      );
      dom.websearchTavilyKeyInput.value = '';
      if (dom.websearchTavilyStatus) {
        dom.websearchTavilyStatus.textContent = 'Key saved.';
        dom.websearchTavilyStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchTavilyStatus) {
        dom.websearchTavilyStatus.textContent = err.message || 'Error saving key.';
        dom.websearchTavilyStatus.classList.add('error');
      }
    }
  });
}

if (dom.testWebsearchTavilyBtn) {
  dom.testWebsearchTavilyBtn.addEventListener('click', async () => {
    dom.testWebsearchTavilyBtn.disabled = true;
    if (dom.websearchTavilyStatus) {
      dom.websearchTavilyStatus.textContent = 'Testing Tavily...';
      dom.websearchTavilyStatus.classList.remove('error');
    }
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.testWebSearchKey({ provider: 'tavily' }),
        'Failed to test Tavily.'
      );
      if (dom.websearchTavilyStatus) {
        dom.websearchTavilyStatus.textContent = result.message || 'Connection successful.';
        dom.websearchTavilyStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchTavilyStatus) {
        dom.websearchTavilyStatus.textContent = err.message || 'Test failed.';
        dom.websearchTavilyStatus.classList.add('error');
      }
    } finally {
      dom.testWebsearchTavilyBtn.disabled = false;
    }
  });
}

if (dom.clearWebsearchTavilyBtn) {
  dom.clearWebsearchTavilyBtn.addEventListener('click', async () => {
    try {
      unwrapIpcResult(
        await window.electron.settings.saveWebSearchKey({ provider: 'tavily', clear: true }),
        'Failed to clear Tavily key.'
      );
      if (dom.websearchTavilyStatus) {
        dom.websearchTavilyStatus.textContent = 'Key cleared.';
        dom.websearchTavilyStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchTavilyStatus) {
        dom.websearchTavilyStatus.textContent = err.message || 'Error.';
        dom.websearchTavilyStatus.classList.add('error');
      }
    }
  });
}

// ── Image Generation settings ──

if (dom.imagegenDefaultSelect) {
  dom.imagegenDefaultSelect.addEventListener('change', async () => {
    try {
      unwrapIpcResult(
        await window.electron.settings.setImageGenDefault({ provider: dom.imagegenDefaultSelect.value }),
        'Failed to set default provider.'
      );
      if (dom.imagegenDefaultStatus) {
        dom.imagegenDefaultStatus.textContent = `Default set to ${dom.imagegenDefaultSelect.value}.`;
        dom.imagegenDefaultStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.imagegenDefaultStatus) {
        dom.imagegenDefaultStatus.textContent = err.message || 'Error.';
        dom.imagegenDefaultStatus.classList.add('error');
      }
    }
  });
}

if (dom.saveImagegenFalBtn) {
  dom.saveImagegenFalBtn.addEventListener('click', async () => {
    const apiKey = dom.imagegenFalKeyInput?.value?.trim();
    if (!apiKey) return;
    try {
      unwrapIpcResult(
        await window.electron.settings.saveImageGenKey({ provider: 'fal', apiKey }),
        'Failed to save Fal key.'
      );
      dom.imagegenFalKeyInput.value = '';
      if (dom.imagegenFalStatus) {
        dom.imagegenFalStatus.textContent = 'Key saved.';
        dom.imagegenFalStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.imagegenFalStatus) {
        dom.imagegenFalStatus.textContent = err.message || 'Error saving key.';
        dom.imagegenFalStatus.classList.add('error');
      }
    }
  });
}

if (dom.testImagegenFalBtn) {
  dom.testImagegenFalBtn.addEventListener('click', async () => {
    dom.testImagegenFalBtn.disabled = true;
    if (dom.imagegenFalStatus) {
      dom.imagegenFalStatus.textContent = 'Testing Fal...';
      dom.imagegenFalStatus.classList.remove('error');
    }
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.testImageGenKey({ provider: 'fal' }),
        'Failed to test Fal.'
      );
      if (dom.imagegenFalStatus) {
        dom.imagegenFalStatus.textContent = result.message || 'Connection successful.';
        dom.imagegenFalStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.imagegenFalStatus) {
        dom.imagegenFalStatus.textContent = err.message || 'Test failed.';
        dom.imagegenFalStatus.classList.add('error');
      }
    } finally {
      dom.testImagegenFalBtn.disabled = false;
    }
  });
}

if (dom.clearImagegenFalBtn) {
  dom.clearImagegenFalBtn.addEventListener('click', async () => {
    try {
      unwrapIpcResult(
        await window.electron.settings.saveImageGenKey({ provider: 'fal', clear: true }),
        'Failed to clear Fal key.'
      );
      if (dom.imagegenFalStatus) {
        dom.imagegenFalStatus.textContent = 'Key cleared.';
        dom.imagegenFalStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.imagegenFalStatus) {
        dom.imagegenFalStatus.textContent = err.message || 'Error.';
        dom.imagegenFalStatus.classList.add('error');
      }
    }
  });
}

if (dom.providerList) {
  dom.providerList.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    const { action, provider } = button.dataset;
    if (!provider) return;

    if (action === 'save') {
      handleSaveProvider(provider);
    }
    if (action === 'clear') {
      handleClearProvider(provider);
    }
    if (action === 'test') {
      handleTestProvider(provider);
    }
    if (action === 'save-ollama-url') {
      handleSaveOllamaUrl();
    }
  });
}

if (dom.saveTemplateVariablesBtn) {
  dom.saveTemplateVariablesBtn.addEventListener('click', () => {
    handleSaveTemplateVariables();
  });
}

if (dom.saveUserProfileBtn) {
  dom.saveUserProfileBtn.addEventListener('click', () => {
    handleSaveUserProfile();
  });
}

if (dom.saveNotificationsBtn) {
  dom.saveNotificationsBtn.addEventListener('click', () => {
    handleSaveNotifications();
  });
}

if (dom.saveVoiceSettingsBtn) {
  dom.saveVoiceSettingsBtn.addEventListener('click', () => {
    handleSaveVoiceSettings();
  });
}

if (dom.saveVoiceKeyBtn) {
  dom.saveVoiceKeyBtn.addEventListener('click', () => {
    handleSaveElevenLabsKey();
  });
}

if (dom.clearVoiceKeyBtn) {
  dom.clearVoiceKeyBtn.addEventListener('click', () => {
    handleClearElevenLabsKey();
  });
}

if (dom.testVoiceBtn) {
  dom.testVoiceBtn.addEventListener('click', () => {
    handleTestVoice();
  });
}

if (dom.reloadHooksBtn) {
  dom.reloadHooksBtn.addEventListener('click', () => {
    handleReloadHooks();
  });
}

if (dom.hooksGlobalEnabledInput) {
  dom.hooksGlobalEnabledInput.addEventListener('change', (event) => {
    handleToggleHooksGlobal(Boolean(event?.target?.checked));
  });
}

if (dom.hooksList) {
  dom.hooksList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="toggle-hook"]');
    if (!button) return;

    const hookName = String(button.dataset.hookName || '').trim();
    const enabled = String(button.dataset.nextEnabled || '').toLowerCase() === 'true';
    handleToggleHook(hookName, enabled);
  });
}

if (dom.memoryRefreshBtn) {
  dom.memoryRefreshBtn.addEventListener('click', () => {
    loadMemoryEntries();
  });
}

if (dom.memoryCaptureBtn) {
  dom.memoryCaptureBtn.addEventListener('click', () => {
    handleCaptureMemory();
  });
}

if (dom.memoryClearBtn) {
  dom.memoryClearBtn.addEventListener('click', () => {
    handleClearMemory();
  });
}

if (dom.memoryList) {
  dom.memoryList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="delete-memory"]');
    if (!button) return;
    const memoryId = String(button.dataset.memoryId || '').trim();
    if (!memoryId) return;
    handleDeleteMemory(memoryId);
  });
}

if (dom.memoryQueryInput) {
  dom.memoryQueryInput.addEventListener('input', () => {
    loadMemoryEntries();
  });
}

if (dom.memoryTierFilterInput) {
  dom.memoryTierFilterInput.addEventListener('change', () => {
    loadMemoryEntries();
  });
}

if (dom.cronRefreshBtn) {
  dom.cronRefreshBtn.addEventListener('click', () => loadCronJobs());
}

// ── Vault event listeners ──────────────────────────────────
if (dom.vaultAddBtn) {
  dom.vaultAddBtn.addEventListener('click', () => {
    if (dom.vaultAddPanel) dom.vaultAddPanel.hidden = false;
    if (dom.vaultAddKeyInput) dom.vaultAddKeyInput.focus();
  });
}

if (dom.vaultCancelEntryBtn) {
  dom.vaultCancelEntryBtn.addEventListener('click', () => {
    if (dom.vaultAddPanel) dom.vaultAddPanel.hidden = true;
    if (dom.vaultAddKeyInput) dom.vaultAddKeyInput.value = '';
    if (dom.vaultAddValueInput) dom.vaultAddValueInput.value = '';
    if (dom.vaultAddStatus) { dom.vaultAddStatus.textContent = ''; dom.vaultAddStatus.classList.remove('error'); }
  });
}

if (dom.vaultSaveEntryBtn) {
  dom.vaultSaveEntryBtn.addEventListener('click', () => handleVaultSave());
}

if (dom.vaultRefreshBtn) {
  dom.vaultRefreshBtn.addEventListener('click', () => loadVaultEntries());
}

if (dom.vaultList) {
  dom.vaultList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const key = btn.dataset.vaultKey;
    if (action === 'delete-vault' && key) handleVaultDelete(key);
    if (action === 'update-vault' && key) handleVaultUpdate(key);
  });
}

// ── MCP event listeners ────────────────────────────────────
if (dom.mcpAddBtn) {
  dom.mcpAddBtn.addEventListener('click', () => openMcpEditPanel(null));
}
if (dom.mcpRefreshBtn) {
  dom.mcpRefreshBtn.addEventListener('click', () => loadMcpServers());
}
if (dom.mcpReloadAllBtn) {
  dom.mcpReloadAllBtn.addEventListener('click', () => handleMcpReloadAll());
}
if (dom.mcpSaveBtn) {
  dom.mcpSaveBtn.addEventListener('click', () => handleMcpSave());
}
if (dom.mcpCancelBtn) {
  dom.mcpCancelBtn.addEventListener('click', () => closeMcpEditPanel());
}
if (dom.mcpEnvAddBtn) {
  dom.mcpEnvAddBtn.addEventListener('click', () => addMcpEnvRow());
}
if (dom.mcpList) {
  dom.mcpList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const name = btn.dataset.mcpName;
    if (!name) return;
    if (action === 'delete-mcp') handleMcpDelete(name);
    else if (action === 'edit-mcp') handleMcpEdit(name);
    else if (action === 'reload-mcp') handleMcpReload(name);
  });
}

if (dom.cronAddBtn) {
  dom.cronAddBtn.addEventListener('click', () => handleAddCronJob());
}

if (dom.cronList) {
  dom.cronList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const jobId = btn.dataset.jobId;

    if (action === 'toggle-cron') {
      handleToggleCronJob(jobId, btn.dataset.nextEnabled === 'true');
    } else if (action === 'run-cron') {
      handleRunCronJob(jobId);
    } else if (action === 'delete-cron') {
      handleDeleteCronJob(jobId);
    }
  });
}

// ─── Workflow event listeners ───
if (dom.workflowRefreshBtn) {
  dom.workflowRefreshBtn.addEventListener('click', () => loadWorkflows());
}
if (dom.workflowPlanBtn) {
  dom.workflowPlanBtn.addEventListener('click', () => handlePlanWorkflow());
}
if (dom.workflowRunBtn) {
  dom.workflowRunBtn.addEventListener('click', () => handlePlanAndExecuteWorkflow());
}
if (dom.workflowList) {
  dom.workflowList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const workflowId = btn.dataset.workflowId;
    try {
      if (action === 'resume-workflow') {
        await window.electron.workflow.run(workflowId);
      } else if (action === 'pause-workflow') {
        await window.electron.workflow.pause(workflowId);
      } else if (action === 'cancel-workflow') {
        await window.electron.workflow.cancel(workflowId);
      } else if (action === 'delete-workflow') {
        await window.electron.workflow.delete(workflowId);
      }
      await loadWorkflows();
    } catch (err) {
      if (dom.workflowStatus) {
        dom.workflowStatus.textContent = `Error: ${err.message}`;
        dom.workflowStatus.classList.add('error');
      }
    }
  });
}

if (dom.chatPlanBtn) {
  dom.chatPlanBtn.addEventListener('click', () => handleChatPlanAndExecute());
}

// Workflow event stream → chat (loose-coupled via data.chatId) + settings panel refresh.
// registerOnce() in preload replaces prior listeners per-channel, so we attach a single
// rich callback per event rather than chaining multiple simple ones.
if (window.electron?.workflow) {
  const onEvent = (eventName, formatter) => {
    const fn = window.electron.workflow[eventName];
    if (typeof fn !== 'function') return;
    fn((data) => {
      if (data?.chatId) {
        const text = formatter(data);
        if (text) appendStatusToChat(data.chatId, text);
      }
      loadWorkflows().catch(() => {});
    });
  };

  onEvent('onStarted', (d) => `Workflow ${d.workflowId} started.`);
  onEvent('onTaskStarted', (d) => `→ ${d.title || d.taskId}`);
  onEvent('onTaskCompleted', (d) => `✓ ${d.title || d.taskId}`);
  onEvent('onTaskFailed', (d) => `✗ ${d.title || d.taskId}${d.error ? `: ${d.error}` : ''}`);
  onEvent('onCompleted', (d) => `Workflow ${d.workflowId} completed.`);
  onEvent('onFailed', (d) => `Workflow ${d.workflowId} failed${d.error ? `: ${d.error}` : ''}.`);
  onEvent('onPaused', (d) => `Workflow ${d.workflowId} paused.`);
  onEvent('onCancelled', (d) => `Workflow ${d.workflowId} cancelled.`);
}

// ─── System Apps event listeners ───
if (dom.appsRescanBtn) {
  dom.appsRescanBtn.addEventListener('click', () => handleRescanApps());
}
if (dom.appAddBtn) {
  dom.appAddBtn.addEventListener('click', () => handleAddCustomApp());
}
if (dom.appsList) {
  dom.appsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'remove-app') {
      try {
        await window.electron.apps.remove(btn.dataset.appId);
        await loadSystemApps();
      } catch (err) {
        if (dom.appsStatus) {
          dom.appsStatus.textContent = `Error: ${err.message}`;
          dom.appsStatus.classList.add('error');
        }
      }
    }
  });
}

window.addEventListener('blur', () => {
  if (!dom.chatContextMenu.hidden) {
    closeContextMenu();
  }
});

unsubscribeHandlers.push(window.electron.chat.onMessageStart(({ chatId, responseId }) => {
  setResponseActive(true, chatId);
  appState._streamStartTime = Date.now();
  appState._streamResponseId = responseId;
  appState._streamChatId = chatId;
  appState._streamChunkCount = 0;
  if (chatId !== appState.activeChatId) return;

  // Flush any pending tool group before the assistant message
  flushToolGroup();

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant streaming';
  messageDiv.dataset.responseId = responseId;

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  // Double-click streaming indicator to show debug info
  messageDiv.addEventListener('dblclick', () => {
    const elapsed = ((Date.now() - (appState._streamStartTime || Date.now())) / 1000).toFixed(1);
    const bufferSize = (appState.streamBuffers.get(responseId) || '').length;
    const chunks = appState._streamChunkCount || 0;
    const info = [
      `Response ID: ${responseId}`,
      `Chat ID: ${chatId}`,
      `Elapsed: ${elapsed}s`,
      `Chunks received: ${chunks}`,
      `Buffer size: ${bufferSize} chars`,
      `Active responses: ${[...appState.activeResponses].join(', ') || 'none'}`,
      `Stream buffers: ${appState.streamBuffers.size}`
    ].join('\n');
    const debugDiv = messageContent.querySelector('.stream-debug') || document.createElement('pre');
    debugDiv.className = 'stream-debug';
    debugDiv.textContent = info;
    debugDiv.style.cssText = 'font-size:11px;opacity:0.7;margin-top:8px;white-space:pre-wrap;';
    if (!messageContent.contains(debugDiv)) messageContent.appendChild(debugDiv);
  });

  // Add thinking indicator — replaced when first chunk arrives
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-indicator';
  thinkingEl.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span> Thinking';
  messageContent.appendChild(thinkingEl);

  messageDiv.appendChild(messageContent);
  dom.chatMessages.appendChild(messageDiv);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  appState.streamBuffers.set(responseId, '');
}));

unsubscribeHandlers.push(window.electron.chat.onMessageChunk(({ chatId, responseId, chunk }) => {
  appState._streamChunkCount = (appState._streamChunkCount || 0) + 1;
  if (chatId !== appState.activeChatId) return;

  const existing = appState.streamBuffers.get(responseId) || '';
  const next = existing + (chunk || '');
  appState.streamBuffers.set(responseId, next);

  const streamElement = dom.chatMessages.querySelector(`[data-response-id="${responseId}"] .message-content`);
  if (!streamElement) return;

  // Remove thinking indicator on first real content
  const thinking = streamElement.querySelector('.thinking-indicator');
  if (thinking) thinking.remove();

  // Extract completed XML tool blocks and render them as pills
  const { cleanText, toolBlocks } = extractXmlToolBlocks(next);
  for (const block of toolBlocks) {
    // Only render each tool block once — track which we've already shown
    const rendered = appState.streamRenderedTools = appState.streamRenderedTools || new Map();
    const key = `${responseId}:${block.toolName}:${block.content.slice(0, 80)}`;
    if (!rendered.has(key)) {
      rendered.set(key, true);
      freezeStreamingText(cleanText);
      addToolEventCompact(block.toolName, xmlToolBlockToParams(block.toolName, block.content), 'success', false);
      keepStreamingIndicatorAtBottom();
    }
  }

  // Strip trailing unclosed tags so partial XML isn't shown while streaming
  const offset = streamTextOffsets.get(responseId) || 0;
  const displayText = stripTrailingOpenToolTag(cleanText.substring(offset));
  streamElement.innerHTML = displayText ? window.electron.markdown.parse(displayText) : '';
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}));

unsubscribeHandlers.push(window.electron.chat.onMessageComplete(({ chatId, responseId }) => {
  appState.streamBuffers.delete(responseId);
  streamTextOffsets.delete(responseId);
  if (appState.streamRenderedTools) appState.streamRenderedTools.clear();
  setResponseActive(false, chatId);
  if (chatId !== appState.activeChatId) return;
  const messageDiv = dom.chatMessages.querySelector(`[data-response-id="${responseId}"]`);
  if (messageDiv) {
    messageDiv.classList.remove('streaming');
    // Remove any leftover thinking indicator
    const thinking = messageDiv.querySelector('.thinking-indicator');
    if (thinking) thinking.remove();
    // Enhance code blocks with copy buttons
    const content = messageDiv.querySelector('.message-content');
    if (content) enhanceRenderedContent(content);
    // If the message is now empty after tool extraction, remove it entirely
    if (content && !content.textContent.trim()) {
      messageDiv.remove();
    }
  }
}));

unsubscribeHandlers.push(window.electron.chat.onMessageError(({ chatId, responseId, error, action }) => {
  appState.streamBuffers.delete(responseId);
  streamTextOffsets.delete(responseId);
  if (appState.streamRenderedTools) appState.streamRenderedTools.clear();
  setResponseActive(false, chatId);
  if (chatId !== appState.activeChatId) return;

  // Remove streaming class from the wrapper div
  const wrapper = dom.chatMessages.querySelector(`[data-response-id="${responseId}"]`);
  if (wrapper) wrapper.classList.remove('streaming');

  let messageDiv = wrapper?.querySelector('.message-content');

  // If onMessageStart never fired, there's no element yet — create one so the
  // error is visible instead of silently lost.
  if (!messageDiv) {
    const newWrapper = document.createElement('div');
    newWrapper.className = 'message assistant';
    newWrapper.dataset.responseId = responseId || 'error';
    messageDiv = document.createElement('div');
    messageDiv.className = 'message-content';
    newWrapper.appendChild(messageDiv);
    dom.chatMessages.appendChild(newWrapper);
  }

  const p = document.createElement('p');
  p.textContent = `Error: ${error}`;
  messageDiv.textContent = '';
  messageDiv.appendChild(p);

  // An unusable main override offers the profile's main in one click; no
  // usable main at all offers the Models tab (spec 2026-09-27 §15).
  if (action && (action.kind === 'use-profile-main' || action.kind === 'open-models')) {
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'btn btn-sm message-error-action';
    fix.textContent = action.kind === 'use-profile-main' ? 'Use the profile\'s main' : 'Open Models';
    fix.addEventListener('click', async () => {
      if (action.kind === 'use-profile-main') {
        if (await switchMainModel(null)) fix.disabled = true;
      } else {
        openSettingsDrawer();
        switchSettingsTab('models');
      }
    });
    messageDiv.appendChild(fix);
  }
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;

  // Persist the error so refreshUI / renderChatMessages doesn't wipe it
  const errorText = `Error: ${error}`;
  window.electron.chat.addMessage({ chatId, sender: 'assistant', text: errorText })
    .catch((err) => chatLog.warn(`error message persistence failed: ${err.message}`));
}));

/**
 * Freeze the text accumulated in the streaming div so far into a completed
 * message div.  Call this before inserting a tool-event element so that
 * text and tool calls appear in chronological order.
 *
 * @param {string} [cleanText] – pre-computed clean text (avoids re-extracting)
 */
function freezeStreamingText(cleanText) {
  const streamingDiv = dom.chatMessages.querySelector('.message.streaming');
  if (!streamingDiv) return;
  const responseId = streamingDiv.dataset.responseId;

  // Compute cleanText from buffer if not supplied
  if (cleanText === undefined) {
    const buffer = appState.streamBuffers.get(responseId);
    if (!buffer) return;
    cleanText = extractXmlToolBlocks(buffer).cleanText;
  }

  const offset = streamTextOffsets.get(responseId) || 0;
  const frozenText = stripTrailingOpenToolTag(cleanText.substring(offset));

  if (frozenText.trim()) {
    const frozenDiv = document.createElement('div');
    frozenDiv.className = 'message assistant';
    const frozenContent = document.createElement('div');
    frozenContent.className = 'message-content';
    frozenContent.innerHTML = window.electron.markdown.parse(frozenText);
    frozenDiv.appendChild(frozenContent);
    dom.chatMessages.insertBefore(frozenDiv, streamingDiv);

    // Clear live streaming content — it will be repopulated from the offset
    const streamContent = streamingDiv.querySelector('.message-content');
    if (streamContent) streamContent.innerHTML = '';
  }

  streamTextOffsets.set(responseId, cleanText.length);
}

/** Move the streaming indicator element to the bottom so it renders below tool events. */
function keepStreamingIndicatorAtBottom() {
  const streaming = dom.chatMessages.querySelector('.message.streaming');
  if (streaming && streaming.nextElementSibling) {
    dom.chatMessages.appendChild(streaming);
  }
}

unsubscribeHandlers.push(window.electron.chat.onToolUse(({ chatId, toolName, parameters }) => {
  if (chatId !== appState.activeChatId) return;
  try {
    freezeStreamingText();
    addToolEventCompact(toolName, parameters, '', false);
    keepStreamingIndicatorAtBottom();
  } catch (err) {
    rendererLog.error(`Failed to render tool use for ${toolName}: ${err.message}`);
  }
}));

unsubscribeHandlers.push(window.electron.chat.onToolResult(({ chatId, toolName, result }) => {
  if (chatId !== appState.activeChatId) return;
  const isError = result?.success === false || result?.ok === false;
  try {
    // Seal the progress pill: remove the target so no further progress
    // events update it, and clear the progress text.
    const pill = dom.chatMessages.querySelector(`[data-tool-progress-target="${toolName}"]`);
    if (pill) {
      delete pill.dataset.toolProgressTarget;
      const progressText = pill.querySelector('.tool-progress-text');
      if (progressText) progressText.remove();
    }
    addToolEventCompact(toolName, result, isError ? 'error' : 'success', true);
    keepStreamingIndicatorAtBottom();
  } catch (err) {
    rendererLog.error(`Failed to render tool result for ${toolName}: ${err.message}`);
  }
}));

unsubscribeHandlers.push(window.electron.chat.onToolProgress(({ chatId, toolName, progress }) => {
  if (chatId !== appState.activeChatId) return;
  try {
    const pill = dom.chatMessages.querySelector(`[data-tool-progress-target="${toolName}"]`);
    if (!pill) return;
    const progressText = pill.querySelector('.tool-progress-text');
    if (!progressText) return;
    progressText.textContent = typeof progress?.message === 'string'
      ? progress.message
      : (typeof progress === 'string' ? progress : '');
  } catch {
    // Non-critical — swallow rendering errors in progress updates.
  }
}));

// --- Canvas IPC events ---
unsubscribeHandlers.push(window.electron.canvas.onRender(({ chatId, title, content }) => {
  if (chatId !== appState.activeChatId) return;
  showCanvas(title, content);
}));

unsubscribeHandlers.push(window.electron.canvas.onClose(({ chatId }) => {
  if (chatId !== appState.activeChatId) return;
  hideCanvas();
}));

unsubscribeHandlers.push(window.electron.canvas.onExecuteJs(({ chatId, requestId, code }) => {
  if (chatId !== appState.activeChatId || !dom.canvasFrame?.contentWindow) return;
  dom.canvasFrame.contentWindow.postMessage({ type: 'kl-execute-js', requestId, code }, '*');
}));

unsubscribeHandlers.push(window.electron.tool.onApprovalRequired(({ approvalId, toolName, parameters }) => {
  showToolApprovalDialog(approvalId, toolName, parameters);
}));

unsubscribeHandlers.push(window.electron.tool.onDirectoryAccessRequired(({ requestId, directory, toolName }) => {
  showDirectoryAccessDialog(requestId, directory, toolName);
}));

unsubscribeHandlers.push(window.electron.agent.onAskUser(({ requestId, question }) => {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant prompt-message';

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  const qLabel = document.createElement('p');
  qLabel.innerHTML = `<strong>Agent needs your input:</strong> ${question}`;

  const inputRow = document.createElement('div');
  inputRow.className = 'prompt-input-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'prompt-input';
  input.placeholder = 'Type your response...';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'btn btn-primary btn-sm';
  submitBtn.appendChild(faIcon('fas fa-paper-plane'));
  submitBtn.appendChild(document.createTextNode(' Send'));

  let submitted = false;
  const submit = () => {
    if (submitted || !input.value.trim()) return;
    submitted = true;
    window.electron.agent.sendUserResponse({ requestId, response: input.value });
    inputRow.innerHTML = '';
    const result = document.createElement('p');
    result.className = 'prompt-result-approved';
    result.textContent = `You responded: ${input.value}`;
    inputRow.appendChild(result);
  };

  submitBtn.addEventListener('click', submit, { once: true });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });

  inputRow.appendChild(input);
  inputRow.appendChild(submitBtn);

  messageContent.appendChild(qLabel);
  messageContent.appendChild(inputRow);
  messageDiv.appendChild(messageContent);
  dom.chatMessages.appendChild(messageDiv);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  input.focus();
}));

// Listen for chat updates from Telegram bridge or other sources
unsubscribeHandlers.push(window.electron.chat.onChatUpdated(async () => {
  await loadChats();
}));

window.addEventListener('beforeunload', () => {
  clearPendingImages();
  appState.streamBuffers.clear();
  streamTextOffsets.clear();
  while (unsubscribeHandlers.length > 0) {
    const unsubscribe = unsubscribeHandlers.pop();
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  }
});

/* --- Webhook management ----------------------------------- */
// ── Permissions tab ────────────────────────────────────────────
async function loadPermissionRules() {
  const container = document.getElementById('permission-rules-list');
  const status = document.getElementById('permission-rules-status');
  if (!container) return;

  try {
    const result = await window.electron.tool.listPermissionRules();
    if (!result?.ok) {
      if (status) status.textContent = result?.error || 'Unable to load rules.';
      return;
    }
    const rules = result.rules || [];
    container.innerHTML = '';
    if (rules.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'provider-message';
      empty.textContent = 'No permission rules configured yet. Approve a tool call with a pattern to create one.';
      container.appendChild(empty);
      return;
    }
    for (const rule of rules) {
      const row = document.createElement('div');
      row.className = 'provider-item permission-rule-row';
      const label = document.createElement('span');
      label.className = 'permission-rule-label';
      const actionClass = rule.action === 'deny' ? 'badge-danger' : (rule.action === 'allow' ? 'badge-success' : 'badge-warn');
      label.innerHTML = `<code>${rule.tool || '?'}</code> <code>${rule.pattern || '*'}</code> <span class="badge ${actionClass}">${rule.action || '?'}</span>`;
      if (rule.source) {
        const src = document.createElement('span');
        src.className = 'permission-rule-source';
        src.textContent = rule.source;
        label.appendChild(document.createTextNode(' '));
        label.appendChild(src);
      }
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-danger btn-xs';
      deleteBtn.textContent = 'Remove';
      deleteBtn.addEventListener('click', async () => {
        await window.electron.tool.removePermissionRule(rule.tool, rule.pattern, rule.action);
        loadPermissionRules();
      });
      row.appendChild(label);
      row.appendChild(deleteBtn);
      container.appendChild(row);
    }
    if (status) status.textContent = `${rules.length} rule${rules.length === 1 ? '' : 's'}`;
  } catch (err) {
    if (status) status.textContent = `Error: ${err.message}`;
  }
}

async function loadWebhookList() {
  if (!dom.webhookList) return;
  try {
    const result = await window.electron.webhook.list();
    const webhooks = Array.isArray(result) ? result : (result?.webhooks || []);
    if (!webhooks.length) {
      dom.webhookList.innerHTML = '';
      if (dom.webhookListStatus) dom.webhookListStatus.textContent = 'No webhooks registered.';
      return;
    }
    if (dom.webhookListStatus) dom.webhookListStatus.textContent = '';
    dom.webhookList.innerHTML = '';
    webhooks.forEach(wh => {
      const row = document.createElement('div');
      row.className = 'provider-card';
      row.style.marginBottom = '8px';
      row.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;">
        <div><strong>${wh.name}</strong><br><code style="font-size:0.8rem;color:var(--text-secondary);">${wh.url || wh.id}</code></div>
        <div style="display:flex;gap:4px;">
          <button class="icon-button" data-action="delete-webhook" data-id="${wh.id}" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </div>`;
      dom.webhookList.appendChild(row);
    });
  } catch (err) {
    if (dom.webhookListStatus) dom.webhookListStatus.textContent = `Error: ${err.message}`;
  }
}

if (dom.webhookCreateBtn) {
  dom.webhookCreateBtn.addEventListener('click', async () => {
    const name = dom.webhookNameInput?.value?.trim();
    if (!name) {
      if (dom.webhookStatus) dom.webhookStatus.textContent = 'Name is required.';
      return;
    }
    try {
      const payload = { name, messageTemplate: dom.webhookTemplateInput?.value || undefined };
      const result = await window.electron.webhook.create(payload);
      if (dom.webhookStatus) dom.webhookStatus.textContent = `Created! URL: ${result?.url || result?.id}`;
      if (dom.webhookNameInput) dom.webhookNameInput.value = '';
      if (dom.webhookTemplateInput) dom.webhookTemplateInput.value = '';
      loadWebhookList();
    } catch (err) {
      if (dom.webhookStatus) dom.webhookStatus.textContent = `Error: ${err.message}`;
    }
  });
}

if (dom.webhookList) {
  dom.webhookList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="delete-webhook"]');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      await window.electron.webhook.delete({ id });
      loadWebhookList();
    } catch (err) {
      if (dom.webhookListStatus) dom.webhookListStatus.textContent = `Error: ${err.message}`;
    }
  });
}

/* --- Diagnostics ------------------------------------------- */
if (dom.diagnosticsRunBtn) {
  dom.diagnosticsRunBtn.addEventListener('click', async () => {
    if (dom.diagnosticsStatus) dom.diagnosticsStatus.textContent = 'Running...';
    if (dom.diagnosticsResults) dom.diagnosticsResults.textContent = '';
    try {
      const result = await window.electron.diagnostics.run();
      if (dom.diagnosticsStatus) dom.diagnosticsStatus.textContent = result?.ok ? 'Complete.' : 'Failed.';
      if (dom.diagnosticsResults) dom.diagnosticsResults.textContent = result?.formatted || 'No results.';
    } catch (err) {
      if (dom.diagnosticsStatus) dom.diagnosticsStatus.textContent = `Error: ${err.message}`;
    }
  });
}

/* --- Mesh Network ------------------------------------------ */

async function loadMeshStatus() {
  try {
    const result = await window.electron.mesh.status();
    const status = result?.data || result;

    if (!status || !status.enabled) {
      if (dom.meshPeerId) dom.meshPeerId.textContent = 'Mesh not enabled';
      updateMeshIndicator(0);
      return;
    }

    if (dom.meshPeerId) dom.meshPeerId.textContent = status.peerId;
    if (dom.meshDisplayNameInput && !dom.meshDisplayNameInput.value) {
      dom.meshDisplayNameInput.value = status.displayName || '';
    }
    if (dom.meshCapabilitiesInput && !dom.meshCapabilitiesInput.value) {
      dom.meshCapabilitiesInput.value = (status.capabilities || []).join(', ');
    }

    renderMeshPeers(status.peers || [], status.discoveredPeers || []);
    renderMeshTasks(status.tasks || {});
    updateMeshIndicator((status.peers || []).length);
  } catch (err) {
    if (dom.meshPeersStatus) {
      dom.meshPeersStatus.textContent = `Error loading mesh status: ${err.message}`;
      dom.meshPeersStatus.classList.add('error');
    }
  }
}

function updateMeshIndicator(peerCount) {
  if (!dom.meshIndicatorBtn) return;

  if (peerCount > 0) {
    dom.meshIndicatorBtn.hidden = false;
    dom.meshIndicatorBtn.classList.add('online');
    if (dom.meshPeerCount) dom.meshPeerCount.textContent = String(peerCount);
    dom.meshIndicatorBtn.title = `${peerCount} mesh peer${peerCount !== 1 ? 's' : ''} online`;
  } else {
    dom.meshIndicatorBtn.hidden = true;
    dom.meshIndicatorBtn.classList.remove('online');
  }
}

function renderMeshPeers(connected, discovered) {
  if (!dom.meshPeersList) return;
  dom.meshPeersList.innerHTML = '';

  const allPeers = [
    ...connected.map((p) => ({ ...p, status: 'online' })),
    ...discovered
      .filter((d) => !connected.some((c) => c.peerId === d.peerId))
      .map((p) => ({ ...p, status: 'discovered' }))
  ];

  if (allPeers.length === 0) {
    if (dom.meshPeersStatus) dom.meshPeersStatus.textContent = 'No peers connected';
    return;
  }

  if (dom.meshPeersStatus) dom.meshPeersStatus.textContent = '';

  for (const peer of allPeers) {
    const card = document.createElement('div');
    card.className = 'mesh-peer-card';

    const info = document.createElement('div');
    info.className = 'mesh-peer-info';

    const name = document.createElement('div');
    name.className = 'mesh-peer-name';
    name.textContent = peer.displayName || peer.peerId;
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'mesh-peer-meta';
    meta.innerHTML = `<span class="mesh-peer-id">${peer.peerId}</span>`;
    if (peer.capabilities && peer.capabilities.length > 0) {
      const caps = peer.capabilities.map((c) =>
        `<span class="mesh-capability-tag">${c}</span>`
      ).join('');
      meta.innerHTML += ` ${caps}`;
    }
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'mesh-peer-actions';

    const statusBadge = document.createElement('span');
    statusBadge.className = `mesh-peer-status ${peer.status}`;
    statusBadge.textContent = peer.status === 'online' ? 'Online' :
                              peer.status === 'discovered' ? 'Discovered' : 'Offline';
    actions.appendChild(statusBadge);

    if (peer.status === 'online') {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-danger';
      removeBtn.style.padding = '3px 8px';
      removeBtn.style.fontSize = '11px';
      removeBtn.appendChild(faIcon('fas fa-xmark'));
      removeBtn.addEventListener('click', async () => {
        try {
          await window.electron.mesh.removePeer({ peerId: peer.peerId });
          loadMeshStatus();
        } catch (err) {
          if (dom.meshPeersStatus) {
            dom.meshPeersStatus.textContent = `Error: ${err.message}`;
            dom.meshPeersStatus.classList.add('error');
          }
        }
      });
      actions.appendChild(removeBtn);
    }

    card.appendChild(info);
    card.appendChild(actions);
    dom.meshPeersList.appendChild(card);
  }
}

function renderMeshTasks(tasksInfo) {
  if (!dom.meshTasksList) return;
  dom.meshTasksList.innerHTML = '';

  const allTasks = [
    ...(tasksInfo.tasks?.pending || []).map((t) => ({ ...t, type: 'outbound' })),
    ...(tasksInfo.tasks?.active || []).map((t) => ({ ...t, type: 'inbound' }))
  ];

  if (allTasks.length === 0) {
    if (dom.meshTasksStatus) dom.meshTasksStatus.textContent = 'No remote tasks';
    return;
  }

  if (dom.meshTasksStatus) dom.meshTasksStatus.textContent = '';

  for (const task of allTasks) {
    const card = document.createElement('div');
    card.className = 'mesh-task-card';

    const header = document.createElement('div');
    header.className = 'mesh-task-header';

    const subject = document.createElement('span');
    subject.className = 'mesh-task-subject';
    subject.textContent = task.taskId;
    header.appendChild(subject);

    const badge = document.createElement('span');
    badge.className = 'mesh-remote-badge';
    badge.innerHTML = task.type === 'outbound'
      ? `<i class="fas fa-arrow-up"></i> Sent to ${task.peerId || task.fromPeerId || '?'}`
      : `<i class="fas fa-arrow-down"></i> From ${task.fromPeerId || '?'}`;
    header.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'mesh-task-meta';
    meta.textContent = `Status: ${task.status} | ${new Date(task.dispatchedAt || task.startedAt).toLocaleTimeString()}`;

    card.appendChild(header);
    card.appendChild(meta);
    dom.meshTasksList.appendChild(card);
  }
}

function initMeshHandlers() {
  if (dom.meshSaveIdentityBtn) {
    dom.meshSaveIdentityBtn.addEventListener('click', async () => {
      const displayName = dom.meshDisplayNameInput?.value?.trim() || '';
      const capabilities = (dom.meshCapabilitiesInput?.value || '')
        .split(',').map((s) => s.trim()).filter(Boolean);

      try {
        await window.electron.mesh.saveSettings({ displayName, capabilities });
        if (dom.meshIdentityStatus) {
          dom.meshIdentityStatus.textContent = 'Identity saved.';
          dom.meshIdentityStatus.classList.remove('error');
        }
      } catch (err) {
        if (dom.meshIdentityStatus) {
          dom.meshIdentityStatus.textContent = `Error: ${err.message}`;
          dom.meshIdentityStatus.classList.add('error');
        }
      }
    });
  }

  if (dom.meshPairGenerateBtn) {
    dom.meshPairGenerateBtn.addEventListener('click', async () => {
      try {
        const raw = await window.electron.mesh.startPairing();
        if (raw?.ok === false) throw new Error(raw.error || 'Failed to generate pairing code');
        const result = raw?.data || raw;
        if (dom.meshPairingCode) {
          dom.meshPairingCode.textContent = result.code;
          dom.meshPairingCode.className = 'provider-input mesh-pairing-code';
        }
        if (dom.meshPairingStatus) {
          dom.meshPairingStatus.textContent = 'Share this code with the other machine. Expires in 2 minutes.';
          dom.meshPairingStatus.classList.remove('error');
        }
      } catch (err) {
        if (dom.meshPairingStatus) {
          dom.meshPairingStatus.textContent = `Error: ${err.message}`;
          dom.meshPairingStatus.classList.add('error');
        }
      }
    });
  }

  if (dom.meshPairAcceptBtn) {
    dom.meshPairAcceptBtn.addEventListener('click', async () => {
      const code = dom.meshPairCodeInput?.value?.trim();
      const address = dom.meshPairAddressInput?.value?.trim();
      const port = dom.meshPairPortInput?.value || '18791';

      if (!code || !address) {
        if (dom.meshPairingStatus) {
          dom.meshPairingStatus.textContent = 'Pairing code and peer address are required.';
          dom.meshPairingStatus.classList.add('error');
        }
        return;
      }

      try {
        if (dom.meshPairingStatus) {
          dom.meshPairingStatus.textContent = 'Pairing...';
          dom.meshPairingStatus.classList.remove('error');
        }
        const raw = await window.electron.mesh.acceptPairing({ code, address, port: Number(port) });
        if (raw?.ok === false) throw new Error(raw.error || 'Pairing failed');
        const result = raw?.data || raw;
        if (dom.meshPairingStatus) {
          dom.meshPairingStatus.textContent = `Paired with ${result.displayName || result.peerId}!`;
          dom.meshPairingStatus.classList.remove('error');
        }
        if (dom.meshPairCodeInput) dom.meshPairCodeInput.value = '';
        if (dom.meshPairAddressInput) dom.meshPairAddressInput.value = '';
        loadMeshStatus();
      } catch (err) {
        if (dom.meshPairingStatus) {
          dom.meshPairingStatus.textContent = `Pairing failed: ${err.message}`;
          dom.meshPairingStatus.classList.add('error');
        }
      }
    });
  }

  if (dom.meshPeerConnectBtn) {
    dom.meshPeerConnectBtn.addEventListener('click', async () => {
      const address = dom.meshPeerAddressInput?.value?.trim();
      const port = dom.meshPeerPortInput?.value;

      if (!address) {
        if (dom.meshConnectStatus) {
          dom.meshConnectStatus.textContent = 'Address is required.';
          dom.meshConnectStatus.classList.add('error');
        }
        return;
      }

      try {
        if (dom.meshConnectStatus) {
          dom.meshConnectStatus.textContent = 'Connecting...';
          dom.meshConnectStatus.classList.remove('error');
        }
        const raw = await window.electron.mesh.addPeer({ address, port: Number(port || 18791) });
        if (raw?.ok === false) throw new Error(raw.error || 'Failed to connect');
        const result = raw?.data || raw;
        if (dom.meshConnectStatus) {
          dom.meshConnectStatus.textContent = `Connected to ${result.displayName || result.peerId}`;
        }
        if (dom.meshPeerAddressInput) dom.meshPeerAddressInput.value = '';
        loadMeshStatus();
      } catch (err) {
        if (dom.meshConnectStatus) {
          dom.meshConnectStatus.textContent = `Failed: ${err.message}`;
          dom.meshConnectStatus.classList.add('error');
        }
      }
    });
  }

  if (dom.meshSaveTransportBtn) {
    dom.meshSaveTransportBtn.addEventListener('click', async () => {
      const port = Number(dom.meshPortInput?.value || 18791);
      const discoveryEnabled = dom.meshDiscoveryToggle?.checked !== false;

      try {
        await window.electron.mesh.saveSettings({ port, discoveryEnabled });
        if (dom.meshTransportStatus) {
          dom.meshTransportStatus.textContent = 'Transport settings saved. Restart to apply port changes.';
          dom.meshTransportStatus.classList.remove('error');
        }
      } catch (err) {
        if (dom.meshTransportStatus) {
          dom.meshTransportStatus.textContent = `Error: ${err.message}`;
          dom.meshTransportStatus.classList.add('error');
        }
      }
    });
  }

  // Mesh indicator opens settings to mesh tab
  if (dom.meshIndicatorBtn) {
    dom.meshIndicatorBtn.addEventListener('click', () => {
      if (dom.settingsDrawer) dom.settingsDrawer.hidden = false;
      switchSettingsTab('mesh');
    });
  }

  // Listen for mesh ready (fires after main process finishes initialization)
  if (window.electron.mesh?.onReady) {
    unsubscribeHandlers.push(
      window.electron.mesh.onReady(() => loadMeshStatus())
    );
  }

  // Listen for real-time mesh events
  if (window.electron.mesh?.onPeerConnected) {
    unsubscribeHandlers.push(
      window.electron.mesh.onPeerConnected(() => loadMeshStatus())
    );
  }
  if (window.electron.mesh?.onPeerDisconnected) {
    unsubscribeHandlers.push(
      window.electron.mesh.onPeerDisconnected(() => loadMeshStatus())
    );
  }
  if (window.electron.mesh?.onTaskCompleted) {
    unsubscribeHandlers.push(
      window.electron.mesh.onTaskCompleted(() => loadMeshStatus())
    );
  }
  if (window.electron.mesh?.onTaskFailed) {
    unsubscribeHandlers.push(
      window.electron.mesh.onTaskFailed(() => loadMeshStatus())
    );
  }
}

initMeshHandlers();
/* --- Cases stage 4: questions across cases, presence and the contact policy
   (docs/superpowers/specs/2026-09-23-cases-stage4-channels.md §3.8) --- */
const questionsLog = createLogger('questions');
const QUESTION_URGENCY_RANK = { high: 0, normal: 1, low: 2 };
const CONTACT_LADDER_URGENCIES = ['low', 'normal', 'high'];
let questionsLastInputAt = Date.now();
let questionsLastHeartbeatAt = 0;
let questionsRendering = null;

function questionsEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function questionsButton(text, className = 'btn questions-btn') {
  const b = questionsEl('button', className, text);
  b.type = 'button';
  return b;
}

function formatLadderState(state) {
  if (!state) return '';
  if (state.exhausted) return 'exhausted';
  if (state.expired) return 'expired';
  if (state.nextChannel && state.nextAt) {
    const at = new Date(state.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `next: ${state.nextChannel} at ${at}`;
  }
  const last = (state.attempts || [])[state.attempts.length - 1];
  return last ? `${last.channel} ${last.outcome}` : '';
}

// "present, telegram@30, email@240, email@0+digest" ⇄ ladder steps.
function ladderToText(steps) {
  return (steps || []).map((s) => `${s.channel}${s.afterMin ? `@${s.afterMin}` : ''}${s.digest ? '+digest' : ''}`).join(', ');
}

function textToLadder(text) {
  return String(text || '').split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = /^([a-z-]+)(?:@(\d+))?(\+digest)?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a step (use channel or channel@minutes)`);
    return { channel: m[1], ...(m[2] ? { afterMin: Number(m[2]) } : {}), ...(m[3] ? { digest: true } : {}) };
  });
}

function renderQuestionCard(q, ladderState, { refresh, showError }) {
  const card = questionsEl('div', `questions-card questions-urgency-${q.urgency}`);
  card.dataset.questionId = q.id;
  card.dataset.caseId = q.caseId;
  card.appendChild(questionsEl('div', 'questions-case', q.caseTitle || q.caseId));
  card.appendChild(questionsEl('div', 'questions-text', q.text));
  const answer = async (payload) => {
    try {
      const r = q.kind === 'briefing'
        ? await window.electron.cases.acknowledgeBriefing({ caseId: q.caseId, questionId: q.id })
        : await window.electron.cases.answerQuestion({ caseId: q.caseId, questionId: q.id, ...payload });
      if (!r || r.ok === false) throw new Error(r?.error || 'The answer was not recorded.');
      await refresh();
    } catch (err) {
      showError(err.message);
    }
  };
  const actions = questionsEl('div', 'questions-actions');
  if (q.kind === 'briefing') {
    const ack = questionsButton('Got it');
    ack.classList.add('questions-ack');
    ack.addEventListener('click', () => answer({}));
    actions.appendChild(ack);
  } else {
    for (const option of q.options || []) {
      const b = questionsButton(option.label);
      b.classList.add('questions-option');
      b.dataset.optionId = option.id;
      b.addEventListener('click', () => answer({ optionId: option.id }));
      actions.appendChild(b);
    }
    const input = questionsEl('input', 'questions-input');
    input.type = 'text';
    input.placeholder = 'Answer…';
    const send = questionsButton('Answer');
    send.classList.add('questions-answer');
    send.addEventListener('click', () => {
      const text = input.value.trim();
      if (text) answer({ text });
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send.click(); });
    actions.append(input, send);
  }
  card.appendChild(actions);
  const ladderText = formatLadderState(ladderState);
  if (ladderText) card.appendChild(questionsEl('div', 'questions-ladder', ladderText));
  return card;
}

function renderAwayControls(policy, { save, showError }) {
  const row = questionsEl('div', 'questions-away');
  const awayActive = policy.away && Date.parse(policy.away.until) > Date.now();
  if (awayActive) {
    row.appendChild(questionsEl('span', 'questions-away-note', `Away (${policy.away.mode}) until ${new Date(policy.away.until).toLocaleString()}`));
    const back = questionsButton("I'm back");
    back.id = 'questions-away-clear';
    back.addEventListener('click', () => save({ ...policy, away: null }).catch((err) => showError(err.message)));
    row.appendChild(back);
    return row;
  }
  const mode = questionsEl('select', 'questions-away-mode');
  for (const m of ['email-only', 'in-app-only']) {
    const o = questionsEl('option', '', m);
    o.value = m;
    mode.appendChild(o);
  }
  const until = questionsEl('input', 'questions-away-until');
  until.type = 'datetime-local';
  const go = questionsButton('Away');
  go.id = 'questions-away-set';
  go.addEventListener('click', () => {
    const t = Date.parse(until.value);
    if (!Number.isFinite(t) || t <= Date.now()) {
      showError('Pick a time in the future.');
      return;
    }
    save({ ...policy, away: { mode: mode.value, until: new Date(t).toISOString() } }).catch((err) => showError(err.message));
  });
  row.append(mode, until, go);
  return row;
}

function renderContactPolicyEditor(policy, channels, { save, showError }) {
  const details = questionsEl('details', 'questions-policy');
  details.id = 'contact-policy-editor';
  details.appendChild(questionsEl('summary', '', 'Contact policy'));
  const inputs = {};
  for (const u of CONTACT_LADDER_URGENCIES) {
    const label = questionsEl('label', 'questions-policy-row', `${u} `);
    const input = questionsEl('input', 'questions-policy-ladder');
    input.type = 'text';
    input.id = `contact-ladder-${u}`;
    input.value = ladderToText(policy.ladders[u]);
    label.appendChild(input);
    details.appendChild(label);
    inputs[u] = input;
  }
  const quiet = questionsEl('label', 'questions-policy-row', 'Quiet hours ');
  const qStart = questionsEl('input', 'questions-policy-time');
  qStart.type = 'time';
  qStart.id = 'contact-quiet-start';
  qStart.value = policy.quietHours ? policy.quietHours.start : '';
  const qEnd = questionsEl('input', 'questions-policy-time');
  qEnd.type = 'time';
  qEnd.id = 'contact-quiet-end';
  qEnd.value = policy.quietHours ? policy.quietHours.end : '';
  quiet.append(qStart, document.createTextNode(' – '), qEnd);
  details.appendChild(quiet);
  const breakthrough = questionsEl('div', 'questions-policy-row', 'Break through quiet hours: ');
  const through = {};
  for (const u of CONTACT_LADDER_URGENCIES) {
    const box = questionsEl('input');
    box.type = 'checkbox';
    box.id = `contact-breakthrough-${u}`;
    box.checked = (policy.quietHours?.breakthrough || ['high']).includes(u);
    const l = questionsEl('label', 'questions-policy-check', ` ${u} `);
    l.prepend(box);
    breakthrough.appendChild(l);
    through[u] = box;
  }
  details.appendChild(breakthrough);
  const digest = questionsEl('label', 'questions-policy-row', 'Daily digest ');
  const dChannel = questionsEl('input', 'questions-policy-digest');
  dChannel.type = 'text';
  dChannel.id = 'contact-digest-channel';
  dChannel.placeholder = 'off';
  dChannel.value = policy.digest ? policy.digest.channel : '';
  const dAt = questionsEl('input', 'questions-policy-time');
  dAt.type = 'time';
  dAt.id = 'contact-digest-at';
  dAt.value = policy.digest ? policy.digest.at : '08:00';
  digest.append(dChannel, document.createTextNode(' at '), dAt);
  details.appendChild(digest);
  const status = questionsEl('ul', 'questions-policy-channels');
  for (const [id, s] of Object.entries(channels || {})) {
    const text = s.configured ? `${id}: ready` : `${id}: ${s.enabled ? 'not configured' : 'off'}${s.reason ? ` (${s.reason})` : ''}`;
    status.appendChild(questionsEl('li', s.configured ? 'is-ready' : 'is-off', text));
  }
  details.appendChild(status);
  const saveBtn = questionsButton('Save contact policy');
  saveBtn.id = 'contact-policy-save';
  saveBtn.addEventListener('click', async () => {
    try {
      const next = { ...policy, ladders: {} };
      for (const u of CONTACT_LADDER_URGENCIES) next.ladders[u] = textToLadder(inputs[u].value);
      next.quietHours = qStart.value && qEnd.value
        ? { start: qStart.value, end: qEnd.value, breakthrough: CONTACT_LADDER_URGENCIES.filter((u) => through[u].checked) }
        : null;
      next.digest = dChannel.value.trim() ? { channel: dChannel.value.trim(), at: dAt.value || '08:00' } : null;
      await save(next);
    } catch (err) {
      showError(err.message);
    }
  });
  details.appendChild(saveBtn);
  return details;
}

async function renderQuestionsSection() {
  const section = document.getElementById('questions-section');
  if (!section || !window.electron?.cases?.questions || !window.electron?.contact) return;
  if (questionsRendering) return questionsRendering;
  questionsRendering = (async () => {
    const [q, ladder, presence, policy] = await Promise.all([
      window.electron.cases.questions({}).catch((err) => ({ ok: false, error: err.message })),
      window.electron.contact.ladderState().catch(() => ({ ok: false })),
      window.electron.contact.presenceStatus().catch(() => ({ ok: false })),
      window.electron.contact.getPolicy().catch(() => ({ ok: false }))
    ]);
    const openPolicy = document.getElementById('contact-policy-editor')?.open === true;
    section.replaceChildren();
    const error = questionsEl('div', 'questions-error');
    error.hidden = true;
    const showError = (message) => {
      error.textContent = message;
      error.hidden = false;
    };
    const refresh = () => renderQuestionsSection();
    const save = async (next) => {
      const r = await window.electron.contact.setPolicy(next);
      if (!r || r.ok === false) throw new Error(r?.error || 'The contact policy was not saved.');
      await refresh();
    };

    const header = questionsEl('div', 'questions-header');
    const dot = questionsEl('span', 'questions-presence-dot');
    dot.id = 'questions-presence-dot';
    const here = presence.ok ? presence.presentChannel : null;
    dot.classList.add(here === 'in-app' ? 'is-here' : (here ? 'is-elsewhere' : 'is-away'));
    dot.title = here ? `Reaching you on ${here}` : 'Not present on any channel';
    header.append(dot, questionsEl('span', 'questions-title', 'Questions'));
    section.appendChild(header);
    // Final review M7: when another process holds the contact ladder lease,
    // this one sends nothing; say so where the owner looks.
    if (presence.ok && presence.ladder && presence.ladder.runsHere === false && presence.ladder.holder) {
      const elsewhere = questionsEl('div', 'questions-ladder-elsewhere', presence.ladder.message);
      elsewhere.id = 'questions-ladder-elsewhere';
      section.appendChild(elsewhere);
    }
    if (policy.ok) section.appendChild(renderAwayControls(policy.policy, { save, showError }));

    const list = questionsEl('div', 'questions-list');
    list.id = 'questions-list';
    const states = ladder.ok ? ladder.state : {};
    const questions = (q.ok ? q.questions : [])
      .slice()
      .sort((a, b) => (QUESTION_URGENCY_RANK[a.urgency] ?? 1) - (QUESTION_URGENCY_RANK[b.urgency] ?? 1)
        || String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const question of questions) {
      list.appendChild(renderQuestionCard(question, states[`${question.caseId}/${question.id}`], { refresh, showError }));
    }
    if (!questions.length) list.appendChild(questionsEl('div', 'questions-empty', 'No open questions.'));
    section.appendChild(list);
    if (policy.ok) {
      const editor = renderContactPolicyEditor(policy.policy, policy.channels, { save, showError });
      editor.open = openPolicy;
      section.appendChild(editor);
    }
    section.appendChild(error);
    if (!q.ok && q.error) showError(q.error);
  })().catch((err) => questionsLog.warn(`Questions section failed: ${err.message}`)).finally(() => {
    questionsRendering = null;
  });
  return questionsRendering;
}

function sendPresenceHeartbeat(force = false) {
  if (!window.electron?.contact?.heartbeat) return;
  const now = Date.now();
  if (!force && now - questionsLastHeartbeatAt < 30000) return;
  questionsLastHeartbeatAt = now;
  window.electron.contact.heartbeat({ focused: document.hasFocus(), lastInputAt: new Date(questionsLastInputAt).toISOString() })
    .catch((err) => questionsLog.debug(`heartbeat failed: ${err.message}`));
}

function initQuestionsSection() {
  if (!document.getElementById('questions-section')) return;
  renderQuestionsSection();
  if (window.electron?.cases?.onChanged) window.electron.cases.onChanged(() => renderQuestionsSection());
  setInterval(() => renderQuestionsSection(), 60000);
  window.addEventListener('focus', () => sendPresenceHeartbeat(true));
  window.addEventListener('blur', () => sendPresenceHeartbeat(true));
  for (const name of ['keydown', 'pointerdown']) {
    window.addEventListener(name, () => {
      questionsLastInputAt = Date.now();
      sendPresenceHeartbeat(false);
    }, { capture: true, passive: true });
  }
  setInterval(() => { if (document.hasFocus()) sendPresenceHeartbeat(true); }, 60000);
  sendPresenceHeartbeat(true);
}

initQuestionsSection();

/* --- Onboarding Wizard ------------------------------------- */
const wizardState = { currentStep: 0, steps: [], data: {} };

async function checkFirstRun() {
  try {
    const result = await window.electron.wizard.getStatus();
    if (result?.isFirstRun) {
      startWizard();
    }
  } catch {
    // Wizard unavailable, skip
  }
}

async function startWizard() {
  try {
    const result = await window.electron.wizard.getSteps();
    wizardState.steps = result?.steps || [];
    wizardState.currentStep = 0;
    wizardState.data = {};
    if (wizardState.steps.length > 0 && dom.wizardOverlay) {
      dom.wizardOverlay.hidden = false;
      renderWizardStep();
    }
  } catch {
    // Wizard unavailable
  }
}

function renderWizardStep() {
  const step = wizardState.steps[wizardState.currentStep];
  if (!step || !dom.wizardStepContent) return;

  // Progress bar
  if (dom.wizardProgress) {
    dom.wizardProgress.innerHTML = wizardState.steps.map((s, i) =>
      `<span style="display:inline-block;width:${100/wizardState.steps.length}%;height:4px;background:${i <= wizardState.currentStep ? 'var(--accent)' : 'var(--border)'};"></span>`
    ).join('');
  }

  // Step content
  let html = `<h3>${step.title}</h3><p style="color:var(--text-secondary);margin-bottom:12px;">${step.description}</p>`;

  if (step.id === 'provider') {
    html += `<div class="template-variables-grid">
      <label>Provider</label>
      <select id="wizard-provider" class="provider-input">
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option value="groq">Groq</option>
        <option value="ollama">Ollama</option>
        <option value="mistral">Mistral</option>
        <option value="gemini">Gemini</option>
        <option value="openrouter">OpenRouter</option>
      </select>
      <label>API Key</label>
      <input type="password" id="wizard-apikey" class="provider-input" placeholder="sk-...">
    </div>`;
  } else if (step.id === 'profile') {
    html += `<div class="template-variables-grid">
      <label>Your Name</label>
      <input type="text" id="wizard-name" class="provider-input" placeholder="Your name" value="${wizardState.data.name || ''}">
      <label>Role</label>
      <input type="text" id="wizard-role" class="provider-input" placeholder="e.g. Developer, Designer" value="${wizardState.data.role || ''}">
    </div>`;
  } else if (step.id === 'channels') {
    html += `<div class="template-variables-grid">
      <label>Telegram Bot Token (optional)</label>
      <input type="password" id="wizard-telegram" class="provider-input" placeholder="123456:ABC-...">
    </div>`;
  }

  dom.wizardStepContent.innerHTML = html;

  // Button visibility
  if (dom.wizardBackBtn) dom.wizardBackBtn.hidden = wizardState.currentStep === 0;
  if (dom.wizardSkipStepBtn) dom.wizardSkipStepBtn.hidden = !step.optional;
  if (dom.wizardNextBtn) dom.wizardNextBtn.textContent = wizardState.currentStep === wizardState.steps.length - 1 ? 'Finish' : 'Next';
}

function collectWizardStepData() {
  const step = wizardState.steps[wizardState.currentStep];
  if (!step) return;

  if (step.id === 'provider') {
    wizardState.data.provider = document.getElementById('wizard-provider')?.value || '';
    wizardState.data.apiKey = document.getElementById('wizard-apikey')?.value || '';
  } else if (step.id === 'profile') {
    wizardState.data.name = document.getElementById('wizard-name')?.value || '';
    wizardState.data.role = document.getElementById('wizard-role')?.value || '';
  } else if (step.id === 'channels') {
    wizardState.data.telegramToken = document.getElementById('wizard-telegram')?.value || '';
  }
}

async function closeWizard() {
  try { await window.electron.wizard.complete(); } catch (err) { wizardLog.warn(`complete failed: ${err.message}`); }
  if (dom.wizardOverlay) dom.wizardOverlay.hidden = true;
}

if (dom.wizardNextBtn) {
  dom.wizardNextBtn.addEventListener('click', () => {
    collectWizardStepData();
    if (wizardState.currentStep >= wizardState.steps.length - 1) {
      closeWizard();
      // Apply collected settings
      if (wizardState.data.provider && wizardState.data.apiKey) {
        window.electron.settings.saveProvider({
          provider: wizardState.data.provider,
          token: wizardState.data.apiKey
        }).catch(() => {});
      }
      if (wizardState.data.name) {
        window.electron.settings.saveUserProfile({
          profile: {
            name: wizardState.data.name,
            role: wizardState.data.role || ''
          }
        }).catch(() => {});
      }
    } else {
      wizardState.currentStep++;
      renderWizardStep();
    }
  });
}

if (dom.wizardBackBtn) {
  dom.wizardBackBtn.addEventListener('click', () => {
    collectWizardStepData();
    if (wizardState.currentStep > 0) {
      wizardState.currentStep--;
      renderWizardStep();
    }
  });
}

if (dom.wizardSkipStepBtn) {
  dom.wizardSkipStepBtn.addEventListener('click', () => {
    if (wizardState.currentStep < wizardState.steps.length - 1) {
      wizardState.currentStep++;
      renderWizardStep();
    } else {
      closeWizard();
    }
  });
}

if (dom.wizardSkipBtn) {
  dom.wizardSkipBtn.addEventListener('click', () => closeWizard());
}

// Listen for wizard start from main process (first run detection)
if (window.electron.wizard?.onStart) {
  unsubscribeHandlers.push(window.electron.wizard.onStart(() => startWizard()));
}

// ============================================================
// UX Enhancements — Wave 3
// ============================================================

// --- Chat search & pin ------------------------------------------
(function initChatSearch() {
  const sidebar = document.querySelector('.sidebar');
  const chatList = document.getElementById('chat-list');
  if (!sidebar || !chatList) return;

  // Insert search box after sidebar-header
  const header = sidebar.querySelector('.sidebar-header');
  if (!header) return;

  const searchDiv = document.createElement('div');
  searchDiv.className = 'sidebar-search';
  searchDiv.innerHTML = '<i class="fas fa-search sidebar-search-icon"></i><input type="text" id="chat-search-input" placeholder="Search chats..." aria-label="Search chats">';
  header.after(searchDiv);

  const searchInput = searchDiv.querySelector('input');
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase().trim();
    const items = chatList.querySelectorAll('.chat-item');
    items.forEach((item) => {
      const title = item.querySelector('.chat-item-title')?.textContent?.toLowerCase() || '';
      const preview = item.querySelector('.chat-item-preview')?.textContent?.toLowerCase() || '';
      item.style.display = (title.includes(query) || preview.includes(query)) ? '' : 'none';
    });
  });
})();

// --- Retry button on errors ------------------------------------
(function initRetryOnError() {
  // Watch for error messages and add retry buttons
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Look for error status messages or failed assistant messages
        if (node.classList?.contains('message') && node.classList?.contains('assistant')) {
          const content = node.querySelector('.message-content');
          const text = content?.textContent || '';
          if (text.toLowerCase().includes('error') && !content?.querySelector('.retry-btn')) {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'retry-btn';
            retryBtn.type = 'button';
            retryBtn.innerHTML = '<i class="fas fa-rotate-right"></i> Retry';
            retryBtn.addEventListener('click', () => {
              retryBtn.remove();
              sendMessage();
            });
            content.appendChild(retryBtn);
          }
        }
      }
    }
  });
  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages) observer.observe(chatMessages, { childList: true });
})();

// --- Command palette (Ctrl+K) ----------------------------------
const commandPaletteActions = [
  { name: 'New Chat', icon: 'fas fa-plus', shortcut: 'Ctrl+N', action: () => handleCreateChat() },
  { name: 'Export as JSON', icon: 'fas fa-file-export', shortcut: 'Ctrl+Shift+E', action: () => document.getElementById('export-chat-btn')?.click() },
  { name: 'Export as Markdown', icon: 'fas fa-file-lines', action: () => exportAsMarkdown() },
  { name: 'Settings', icon: 'fas fa-gear', shortcut: 'Ctrl+,', action: () => document.getElementById('open-settings-btn')?.click() },
  { name: 'Toggle Agent Mode', icon: 'fas fa-robot', action: () => document.getElementById('agent-mode-btn')?.click() },
  { name: 'Clear Input', icon: 'fas fa-eraser', shortcut: 'Ctrl+L', action: () => { dom.userInput.value = ''; dom.userInput.style.height = 'auto'; } },
  { name: 'Plan & Execute', icon: 'fas fa-diagram-project', action: () => document.getElementById('chat-plan-btn')?.click() },
  { name: '/help — Show commands', icon: 'fas fa-circle-question', action: () => { dom.userInput.value = '/help'; sendMessage(); } },
  { name: '/cd — Change directory', icon: 'fas fa-folder-open', action: () => { dom.userInput.value = '/cd '; dom.userInput.focus(); } },
];

function showCommandPalette() {
  if (document.querySelector('.command-palette-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'command-palette-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const palette = document.createElement('div');
  palette.className = 'command-palette';

  const input = document.createElement('input');
  input.className = 'command-palette-input';
  input.type = 'text';
  input.placeholder = 'Type a command...';
  palette.appendChild(input);

  const results = document.createElement('div');
  results.className = 'command-palette-results';
  palette.appendChild(results);

  let selectedIndex = 0;

  function renderResults(query) {
    const q = query.toLowerCase().trim();
    const filtered = q
      ? commandPaletteActions.filter(a => a.name.toLowerCase().includes(q))
      : commandPaletteActions;
    results.innerHTML = '';
    selectedIndex = 0;
    filtered.forEach((action, i) => {
      const item = document.createElement('button');
      item.className = 'command-palette-item' + (i === 0 ? ' selected' : '');
      item.type = 'button';
      item.innerHTML = `<i class="${action.icon}"></i> ${action.name}`;
      if (action.shortcut) {
        item.innerHTML += `<span class="shortcut">${action.shortcut}</span>`;
      }
      item.addEventListener('click', () => { overlay.remove(); action.action(); });
      item.addEventListener('mouseenter', () => {
        results.querySelectorAll('.command-palette-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        selectedIndex = i;
      });
      results.appendChild(item);
    });
  }

  input.addEventListener('input', () => renderResults(input.value));
  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('.command-palette-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, items.length - 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); }
    items.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
    if (e.key === 'Enter' && items[selectedIndex]) { overlay.remove(); commandPaletteActions.filter(a => !input.value.trim() || a.name.toLowerCase().includes(input.value.toLowerCase()))[selectedIndex]?.action(); }
    if (e.key === 'Escape') overlay.remove();
  });

  renderResults('');
  overlay.appendChild(palette);
  document.body.appendChild(overlay);
  input.focus();
}

// --- Global keyboard shortcuts ---------------------------------
document.addEventListener('keydown', (e) => {
  const isMod = e.ctrlKey || e.metaKey;

  // Ctrl+K — command palette
  if (isMod && e.key === 'k') { e.preventDefault(); showCommandPalette(); return; }
  // Ctrl+N — new chat
  if (isMod && e.key === 'n' && !e.shiftKey) { e.preventDefault(); handleCreateChat(); return; }
  // Ctrl+L — clear input
  if (isMod && e.key === 'l' && !e.shiftKey) { e.preventDefault(); dom.userInput.value = ''; dom.userInput.style.height = 'auto'; dom.userInput.focus(); return; }
  // Ctrl+, — settings
  if (isMod && e.key === ',') { e.preventDefault(); document.getElementById('open-settings-btn')?.click(); return; }
  // Ctrl+Shift+E — export
  if (isMod && e.shiftKey && e.key === 'E') { e.preventDefault(); document.getElementById('export-chat-btn')?.click(); return; }
});

// --- Markdown export -------------------------------------------
async function exportAsMarkdown() {
  const chat = getActiveChat();
  if (!chat) return;

  const lines = [`# ${chat.title}\n`];
  lines.push(`_Exported ${new Date().toISOString()}_\n`);

  for (const msg of chat.messages) {
    if (msg.sender === 'user') {
      lines.push(`## User\n\n${msg.text}\n`);
    } else if (msg.sender === 'assistant') {
      lines.push(`## Assistant\n\n${msg.text}\n`);
    } else if (msg.sender === 'toolUse') {
      lines.push(`<details><summary>Tool: ${msg.toolName}</summary>\n\n\`\`\`json\n${JSON.stringify(msg.parameters, null, 2)}\n\`\`\`\n</details>\n`);
    } else if (msg.sender === 'toolResult') {
      const status = (msg.result?.success === false || msg.result?.ok === false) ? 'Error' : 'Result';
      const diff = msg.result?.diff;
      if (diff) {
        lines.push(`<details><summary>${msg.toolName} ${status}</summary>\n\n\`\`\`diff\n${diff}\n\`\`\`\n</details>\n`);
      } else {
        lines.push(`<details><summary>${msg.toolName} ${status}</summary>\n\n\`\`\`json\n${JSON.stringify(msg.result, null, 2).substring(0, 2000)}\n\`\`\`\n</details>\n`);
      }
    }
  }

  const content = lines.join('\n');
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${chat.title.replace(/[^a-zA-Z0-9]/g, '_')}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Agent progress status line --------------------------------
(function initAgentProgress() {
  const inputContainer = document.getElementById('input-container');
  if (!inputContainer) return;

  const progressBar = document.createElement('div');
  progressBar.className = 'agent-progress-bar';
  progressBar.id = 'agent-progress-bar';
  progressBar.hidden = true;
  progressBar.innerHTML = '<span class="progress-dot"></span><span id="agent-progress-text">Agent running...</span>';
  inputContainer.parentNode.insertBefore(progressBar, inputContainer);

  let toolCount = 0;
  let startTime = 0;
  let progressInterval = null;

  function updateProgress() {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const text = document.getElementById('agent-progress-text');
    if (text) text.textContent = `Agent running · ${toolCount} tool${toolCount !== 1 ? 's' : ''} · ${elapsed}s`;
  }

  // Hook into existing response events
  if (window.electron?.chat?.onMessageStart) {
    window.electron.chat.onMessageStart(({ chatId }) => {
      if (chatId !== appState.activeChatId) return;
      toolCount = 0;
      startTime = Date.now();
      progressBar.hidden = false;
      updateProgress();
      progressInterval = setInterval(updateProgress, 1000);
    });
  }

  if (window.electron?.chat?.onToolUse) {
    window.electron.chat.onToolUse(({ chatId, toolName }) => {
      if (chatId !== appState.activeChatId) return;
      toolCount++;
      const text = document.getElementById('agent-progress-text');
      if (text) text.textContent = `Agent running · ${toolName} · ${toolCount} tool${toolCount !== 1 ? 's' : ''}`;
    });
  }

  if (window.electron?.chat?.onMessageComplete) {
    window.electron.chat.onMessageComplete(({ chatId }) => {
      if (chatId !== appState.activeChatId) return;
      progressBar.hidden = true;
      if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    });
  }
})();

// --- Welcome card (first-run) ----------------------------------
(function initWelcomeCard() {
  const emptyState = document.getElementById('empty-state');
  if (!emptyState) return;

  // Check if this is a first-run (no chats exist and haven't dismissed)
  const dismissed = localStorage.getItem('kl-welcome-dismissed');
  if (dismissed) return;

  const card = document.createElement('div');
  card.className = 'welcome-card';
  card.innerHTML = `
    <h2>Welcome to King Louie</h2>
    <p>Your AI-powered desktop assistant for coding, automation, and more.</p>
    <ul class="welcome-tips">
      <li><i class="fas fa-key"></i> Set your API key in <strong>Settings</strong> (gear icon or <kbd>Ctrl+,</kbd>)</li>
      <li><i class="fas fa-robot"></i> Enable <strong>Agent Mode</strong> for tool-using AI (file editing, terminal, web search)</li>
      <li><i class="fas fa-keyboard"></i> Press <kbd>Ctrl+K</kbd> to open the <strong>Command Palette</strong></li>
      <li><i class="fas fa-slash"></i> Type <kbd>/help</kbd> to see all available commands</li>
      <li><i class="fas fa-diagram-project"></i> Use <strong>Plan & Execute</strong> for complex multi-step tasks</li>
    </ul>
    <button class="welcome-dismiss" type="button">Got it, don't show again</button>
  `;
  card.querySelector('.welcome-dismiss').addEventListener('click', () => {
    localStorage.setItem('kl-welcome-dismissed', '1');
    card.remove();
  });
  emptyState.appendChild(card);
})();

loadChats();
loadSettings();
renderAgentModeButton();
renderHistoryToggleButton();
checkFirstRun();

// ── Settings > Local service (fleet stage 7) ──────────────────────────────
const serviceLog = createLogger('desktop-service');
const servicePaneState = {
  detachArmed: false, detachArmToken: null, detachArmedAt: null, busy: false, error: null,
  pendingNodeId: null, lastView: null, lastModel: null, lastStatus: null
};
let serviceRenderToken = 0;
let serviceLastConnection = null;

function serviceLinesInto(el, lines) {
  el.innerHTML = '';
  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = line;
    el.appendChild(p);
  }
}

function disableServiceActionButtons() {
  document.querySelectorAll('#service-pane-actions button, #service-pane-import button, #service-pane-status button').forEach((btn) => { btn.disabled = true; });
}

// The one place that actually writes the pane's DOM from a model. Pure with
// respect to the network — it never awaits anything — so `runServiceAction`
// can call it synchronously right after flipping `busy` back to false, and
// the buttons it draws reflect that final state instead of a stale one.
// `serviceRenderToken` only advances when the pane's shape (view + actions)
// actually changed (paneShapeChanged, pane-model.js) — a background repaint
// that only refreshes wording must not by itself un-arm a pending Detach.
// Arming records the token as of its own paint; `decideDetachClick` refuses
// to confirm once a shape-changing paint has happened since.
function paintServicePane(model, status) {
  if (window.electron.desktop.paneShapeChanged(servicePaneState.lastModel, model)) serviceRenderToken += 1;
  servicePaneState.lastModel = model;
  servicePaneState.lastStatus = status;
  if (servicePaneState.lastView && servicePaneState.lastView !== model.view) {
    servicePaneState.error = null;
  }
  servicePaneState.lastView = model.view;
  // The Confirm button must send the nodeId the owner actually saw here,
  // not whatever `found` becomes on a later poll tick — otherwise a service
  // swap between this render and the click could pin a service the owner
  // never compared.
  servicePaneState.pendingNodeId = (status.pendingPair && status.pendingPair.service && status.pendingPair.service.nodeId) || null;

  const statusEl = document.getElementById('service-pane-status');
  const lines = [...model.lines];
  if (servicePaneState.detachArmed && model.detachWarning) lines.push(model.detachWarning);
  serviceLinesInto(statusEl, lines);
  if (servicePaneState.error) {
    const p = document.createElement('p');
    p.className = 'service-pane-error';
    p.textContent = servicePaneState.error;
    statusEl.appendChild(p);
  }
  if (model.serviceCommand) {
    // Persisted server-side (desktop-state's pendingServiceCommand), not
    // renderer state: it must survive a repaint and, in attached mode, a
    // relaunch, and stays until the owner dismisses it or a new pairing
    // starts (fix round 2, Task 16 review).
    const row = document.createElement('div');
    row.className = 'service-pane-command';
    const p = document.createElement('p');
    p.className = 'service-pane-notice';
    p.textContent = model.serviceCommand.line;
    row.appendChild(p);
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.id = 'service-dismiss-command-btn';
    dismissBtn.className = 'btn btn-secondary btn-sm';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.disabled = servicePaneState.busy;
    dismissBtn.addEventListener('click', () => { runServiceAction('dismissServiceCommand').catch((err) => serviceLog.warn('service action failed', { action: 'dismissServiceCommand', error: err && err.message })); });
    row.appendChild(dismissBtn);
    statusEl.appendChild(row);
  }

  const requestBox = document.getElementById('service-pane-request');
  requestBox.hidden = !model.request;
  if (model.request) {
    document.getElementById('service-pair-request').textContent = model.request;
    document.getElementById('service-pair-command').textContent = model.command || '';
    const copyBtn = document.getElementById('service-copy-request-btn');
    copyBtn.onclick = () => navigator.clipboard.writeText(model.request).catch((err) => serviceLog.warn('copying the pairing request failed', { error: err && err.message }));
  }

  const actionsEl = document.getElementById('service-pane-actions');
  actionsEl.innerHTML = '';
  for (const action of model.actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `service-action-${action.id}`;
    btn.className = action.id === 'detach' || action.id === 'unpair' ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
    btn.textContent = action.id === 'detach' && servicePaneState.detachArmed ? 'Detach anyway' : action.label;
    btn.disabled = Boolean(action.disabled) || servicePaneState.busy;
    btn.addEventListener('click', () => { runServiceAction(action.id).catch((err) => serviceLog.warn('service action failed', { action: action.id, error: err && err.message })); });
    actionsEl.appendChild(btn);
  }

  const approvalsEl = document.getElementById('service-pane-approvals');
  approvalsEl.hidden = !model.approvals;
  if (model.approvals) {
    serviceLinesInto(approvalsEl, ['Approvals and relay', ...model.approvals.lines, `Change them on the service: ${model.approvals.commands.join(', ')}`]);
  }
  markUnavailableTabs(status.unavailableTabs || []);
}

// Fetches status + the pane's wording without touching the DOM, so callers
// that need to sequence a state change (clearing `busy`) between the fetch
// and the paint — `runServiceAction`'s finally — can do so without a second
// network round trip.
async function fetchServiceModel() {
  const desktop = window.electron.desktop;
  if (!desktop) return null;
  const status = await desktop.status();
  if (!status || status.ok === false) return { status, model: null };
  return { status, model: desktop.describe(status) };
}

async function renderServiceSection() {
  const statusEl = document.getElementById('service-pane-status');
  if (!statusEl || !window.electron.desktop) return;
  const fetched = await fetchServiceModel();
  if (!fetched || !fetched.status || fetched.status.ok === false) {
    serviceLinesInto(statusEl, [(fetched && fetched.status && fetched.status.error) || 'The local service pane is not available.']);
    return;
  }
  if (!fetched.model) return;
  paintServicePane(fetched.model, fetched.status);
}

function renderImportPlan(result) {
  const box = document.getElementById('service-pane-import');
  if (!box) return;
  box.hidden = false;
  const counts = Object.entries(result.plan.counts || {}).filter(([, n]) => n).map(([a, n]) => `${a}: ${n}`).join(', ');
  const notes = result.plan.items.filter((i) => i.action === 'needs-attention' || i.action === 'needs-desktop').map((i) => `${i.action}: ${i.category} ${i.key}${i.note ? ` — ${i.note}` : ''}`);
  serviceLinesInto(box, [`Dry run — ${counts}`, ...notes, ...(result.attention || []).map((a) => `needs-attention: ${a.key} — ${a.note}`)]);
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.id = 'service-action-importApply';
  apply.className = 'btn btn-primary btn-sm';
  apply.textContent = 'Import';
  apply.addEventListener('click', () => { runServiceAction('importApply').catch((err) => serviceLog.warn('service action failed', { action: 'importApply', error: err && err.message })); });
  box.appendChild(apply);
}

function renderImportReport(report) {
  const box = document.getElementById('service-pane-import');
  if (!box) return;
  box.hidden = false;
  serviceLinesInto(box, ['Import finished', ...window.electron.desktop.describeImport(report)]);
}

// Arms (or re-arms) the Detach warning: paints it synchronously from the
// last known model/status, no network call, so there is no window where a
// click could beat the render. Clearing `busy` before that paint (rather
// than after) is what lets the freshly drawn "Detach anyway" button come
// back enabled.
function armDetachWarning() {
  servicePaneState.detachArmed = true;
  servicePaneState.busy = false;
  if (servicePaneState.lastModel) paintServicePane(servicePaneState.lastModel, servicePaneState.lastStatus);
  servicePaneState.detachArmToken = serviceRenderToken;
  servicePaneState.detachArmedAt = Date.now();
}

async function runServiceAction(id) {
  // A click that arrives while an earlier one is still in flight (including
  // during the final re-render below, which can take a few seconds) must
  // not act — the buttons are also disabled synchronously below, but a
  // click already queued before that disable took effect would otherwise
  // still run.
  if (servicePaneState.busy) return;
  servicePaneState.busy = true;
  disableServiceActionButtons();
  servicePaneState.error = null;

  if (id === 'detach') {
    const decision = window.electron.desktop.decideDetachClick({
      armed: servicePaneState.detachArmed,
      armedAtToken: servicePaneState.detachArmToken,
      currentToken: serviceRenderToken,
      armedAt: servicePaneState.detachArmedAt,
      now: Date.now()
    });
    if (decision.arm) {
      armDetachWarning();
      return;
    }
    servicePaneState.detachArmed = false;
  }

  const desktop = window.electron.desktop;
  try {
    let result = null;
    if (id === 'pair') result = await desktop.pairStart();
    else if (id === 'pairConfirm') result = await desktop.pairConfirm(servicePaneState.pendingNodeId);
    else if (id === 'pairCancel') result = await desktop.pairCancel();
    else if (id === 'attach') result = await desktop.attach();
    else if (id === 'standaloneOnce') result = await desktop.standaloneOnce();
    else if (id === 'retry') result = await desktop.retry();
    else if (id === 'detach') result = await desktop.detach({ confirmed: true });
    else if (id === 'unpair') result = await desktop.unpair();
    else if (id === 'dismissServiceCommand') result = await desktop.dismissServiceCommand();
    else if (id === 'import') {
      result = await desktop.importPlan();
      if (result && result.ok) renderImportPlan(result);
    } else if (id === 'importApply') {
      result = await desktop.importApply();
      if (result && result.ok) renderImportReport(result.report);
    }
    if (result && result.ok === false) servicePaneState.error = result.error || result.code;
  } finally {
    // Fetch first (busy still true, so no other click can act), then flip
    // busy off and paint from that fetch in one synchronous step — the
    // buttons this paints are drawn with the settled, non-busy value.
    const fetched = await fetchServiceModel().catch((err) => {
      serviceLog.warn('re-fetching the local service pane failed', { error: err && err.message });
      return null;
    });
    servicePaneState.busy = false;
    if (fetched && fetched.status && fetched.status.ok !== false && fetched.model) {
      paintServicePane(fetched.model, fetched.status);
    } else if (servicePaneState.lastModel) {
      // The re-fetch failed; repaint the last known model now that `busy`
      // is already false, so the buttons come back enabled instead of
      // staying disabled with no further paint to fix that.
      paintServicePane(servicePaneState.lastModel, servicePaneState.lastStatus);
    } else {
      const statusEl = document.getElementById('service-pane-status');
      if (statusEl) serviceLinesInto(statusEl, [(fetched && fetched.status && fetched.status.error) || 'The local service pane is not available.']);
    }
  }
}

function markUnavailableTabs(tabs = []) {
  const unavailable = new Set(tabs);
  document.querySelectorAll('.settings-tab-content').forEach((pane) => {
    const existing = pane.querySelector(':scope > .service-unavailable-notice');
    if (unavailable.has(pane.dataset.tab)) {
      if (!existing) {
        const note = document.createElement('div');
        note.className = 'settings-alert service-unavailable-notice';
        note.textContent = 'Managed by the local service; not available while attached.';
        pane.prepend(note);
      }
    } else if (existing) {
      existing.remove();
    }
  });
}

function renderAttachedBanner(status) {
  let banner = document.getElementById('attached-service-banner');
  const show = status && status.view === 'attached-disconnected';
  if (!show) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'attached-service-banner';
    banner.className = 'settings-alert attached-service-banner';
    const host = dom.chatMessages && dom.chatMessages.parentElement ? dom.chatMessages.parentElement : document.body;
    host.prepend(banner);
  }
  banner.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = (status.connection && status.connection.error) || 'The local King Louie service is not reachable.';
  banner.appendChild(text);
  const buttons = [
    ['Retry now', () => window.electron.desktop.retry()],
    ['Use standalone this time', () => window.electron.desktop.standaloneOnce()],
    ['Local service settings', () => { document.getElementById('open-settings-btn')?.click(); switchSettingsTab('service'); }]
  ];
  for (const [label, fn] of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = label;
    btn.addEventListener('click', () => { Promise.resolve(fn()).catch((err) => serviceLog.warn('attached banner action failed', { label, error: err && err.message })); });
    banner.appendChild(btn);
  }
}

async function refreshServiceStatus() {
  const status = await window.electron.desktop.status().catch((err) => {
    serviceLog.warn('fetching desktop status failed', { error: err && err.message });
    return null;
  });
  if (!status || status.ok === false) return;
  markUnavailableTabs(status.unavailableTabs || []);
  renderAttachedBanner(status);
  const conn = status.connection ? status.connection.status : null;
  if (conn === 'connected' && serviceLastConnection && serviceLastConnection !== 'connected') loadChats();
  serviceLastConnection = conn;
  if (dom.settingsNavSelect && dom.settingsNavSelect.value === 'service') {
    renderServiceSection().catch((err) => serviceLog.warn('rendering the local service pane failed', { error: err && err.message }));
  }
}

if (window.electron.desktop) {
  unsubscribeHandlers.push(window.electron.desktop.onStatusChanged(() => {
    refreshServiceStatus().catch((err) => serviceLog.warn('refreshing desktop status failed', { error: err && err.message }));
  }));
  unsubscribeHandlers.push(window.electron.desktop.onImportProgress(({ sent, total } = {}) => {
    const box = document.getElementById('service-pane-import');
    if (box) box.dataset.progress = `${sent}/${total}`;
  }));
  refreshServiceStatus().catch((err) => serviceLog.warn('refreshing desktop status failed', { error: err && err.message }));
}
