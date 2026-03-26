const appState = {
  chats: [],
  activeChatId: null,
  contextChatId: null,
  isAgentModeEnabled: false,
  isHistoryCollapsed: false,
  memoryEntries: [],
  pendingImages: [],
  activeResponses: new Set(),
  streamBuffers: new Map(),
  settings: {
    encryptionAvailable: true,
    providers: {},
    activeProvider: 'openai',
    inference: {
      activeTier: 'standard'
    },
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
  }
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
  cronRefreshBtn: document.getElementById('cron-refresh-btn'),
  cronStatus: document.getElementById('cron-status'),
  cronList: document.getElementById('cron-list'),
  cronAddBtn: document.getElementById('cron-add-btn'),
  cronAddStatus: document.getElementById('cron-add-status'),
  cronAddMessageInput: document.getElementById('cron-add-message-input'),
  cronAddTargetInput: document.getElementById('cron-add-target-input'),
  cronAddKindInput: document.getElementById('cron-add-kind-input'),
  cronAddValueInput: document.getElementById('cron-add-value-input'),
  imagePreviewList: document.getElementById('image-preview-list'),
  imageFileInput: document.getElementById('image-file-input'),
  attachImageBtn: document.getElementById('attach-image-btn'),
  chatInfoBtn: document.getElementById('chat-info-btn'),
  chatInfoPopover: document.getElementById('chat-info-popover'),
  chatInfoCloseBtn: document.getElementById('chat-info-close-btn'),
  chatInfoPopoverBody: document.getElementById('chat-info-popover-body'),
  skillSettingsContainer: document.getElementById('skill-settings-container'),
  skillsList: document.getElementById('skills-list'),
  skillsStatus: document.getElementById('skills-status'),
  skillInstallUrl: document.getElementById('skill-install-url'),
  skillInstallBtn: document.getElementById('skill-install-btn'),
  skillInstallStatus: document.getElementById('skill-install-status'),
  settingsNavSelect: document.getElementById('settings-nav-select'),
  inferenceTierSelect: document.getElementById('inference-tier-select'),
  saveInferenceTierBtn: document.getElementById('save-inference-tier-btn'),
  inferenceTierStatus: document.getElementById('inference-tier-status'),
  inferenceTierDetails: document.getElementById('inference-tier-details'),
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
  clearWebsearchBraveBtn: document.getElementById('clear-websearch-brave-btn'),
  saveWebsearchTavilyBtn: document.getElementById('save-websearch-tavily-btn'),
  clearWebsearchTavilyBtn: document.getElementById('clear-websearch-tavily-btn'),
  websearchStatus: document.getElementById('websearch-status'),
  workingDirBtn: document.getElementById('working-dir-btn'),
  exportChatBtn: document.getElementById('export-chat-btn'),
  messageContextMenu: document.getElementById('message-context-menu'),
  inputContextMenu: document.getElementById('input-context-menu'),
  webhookNameInput: document.getElementById('webhook-name-input'),
  webhookTemplateInput: document.getElementById('webhook-template-input'),
  webhookCreateBtn: document.getElementById('webhook-create-btn'),
  webhookStatus: document.getElementById('webhook-status'),
  webhookList: document.getElementById('webhook-list'),
  webhookListStatus: document.getElementById('webhook-list-status'),
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
  appState.activeResponses.clear();
  appState.streamBuffers.clear();
  streamTextOffsets.clear();
  appState.settings = {
    encryptionAvailable: true,
    providers: {},
    activeProvider: 'openai',
    inference: { activeTier: 'standard' },
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

function setResponseActive(active, chatId) {
  const id = chatId || appState.activeChatId;
  if (active) {
    appState.activeResponses.add(id);
  } else {
    appState.activeResponses.delete(id);
  }
  const isActiveChatStreaming = appState.activeResponses.has(appState.activeChatId);
  if (dom.sendBtn) dom.sendBtn.hidden = isActiveChatStreaming;
  if (dom.stopBtn) dom.stopBtn.hidden = !isActiveChatStreaming;
  updateChatStreamingIndicators();
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
    '- `/llm use <provider>` — set active provider',
    '- `/llm model <provider> <model>` — set model for provider',
    '- `/llm telegram add <token>` — save Telegram bot token and start bridge',
    '- `/llm telegram test` — test saved Telegram bot token',
    '- `/llm telegram remove` — clear saved Telegram token and stop bridge',
    '- `/llm telegram status` — show Telegram bridge status',
    '- `/llm voice status` — show current voice configuration status',
    '- `/speak` — read the last assistant response aloud',
    '- `/profile` — show your current profile values',
    '- `/profile set <field> <value>` — update profile field (`name`, `role`, `projectContext`, `goals`, `preferences`)',
    '- `/fast` — switch inference tier to fast',
    '- `/standard` — switch inference tier to standard',
    '- `/smart` — switch inference tier to smart',
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
        ...chat.messages,
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
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: userCommand }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
  }

  const summary = formatProfileSummary(appState.settings.userProfile);
  appendLocalMessage('assistant', summary);
  window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: summary }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
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
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 5;

function renderPendingImages() {
  if (!dom.imagePreviewList) return;

  dom.imagePreviewList.innerHTML = '';
  if (!Array.isArray(appState.pendingImages) || appState.pendingImages.length === 0) {
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

async function addImageFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  const remainingSlots = MAX_IMAGES_PER_MESSAGE - appState.pendingImages.length;
  if (remainingSlots <= 0) {
    alert(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
    return;
  }

  const candidates = files.slice(0, remainingSlots);
  for (const file of candidates) {
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) {
      alert(`Unsupported image format: ${file.type}`);
      continue;
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      alert(`Image too large: ${file.name} exceeds 5MB.`);
      continue;
    }

    const base64 = await fileToBase64(file);
    appState.pendingImages.push({
      name: file.name,
      mimeType: file.type,
      base64,
      previewUrl: URL.createObjectURL(file)
    });
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

    // Try rendering as markdown, fall back to pre
    if (typeof payload === 'string' || (payload && (payload.content || payload.stdout || payload.output || payload.message))) {
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

function showToolApprovalDialog(approvalId, toolName, parameters) {
  const modal = document.createElement('div');
  modal.className = 'tool-approval-modal';

  const card = document.createElement('div');
  card.className = 'tool-approval-card';

  const title = document.createElement('h3');
  title.textContent = 'Tool Execution Approval Required';

  const toolLabel = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = 'Tool:';
  toolLabel.textContent = '';
  toolLabel.appendChild(strong);
  toolLabel.appendChild(document.createTextNode(` ${toolName}`));

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(parameters || {}, null, 2);

  const actions = document.createElement('div');
  actions.className = 'tool-approval-actions';

  const alwaysApproveLabel = document.createElement('label');
  alwaysApproveLabel.className = 'tool-approval-always';

  const alwaysApproveInput = document.createElement('input');
  alwaysApproveInput.type = 'checkbox';
  alwaysApproveInput.className = 'tool-approval-always-checkbox';

  const alwaysApproveText = document.createElement('span');
  alwaysApproveText.textContent = `Always approve ${toolName}`;

  alwaysApproveLabel.appendChild(alwaysApproveInput);
  alwaysApproveLabel.appendChild(alwaysApproveText);

  const denyBtn = document.createElement('button');
  denyBtn.type = 'button';
  denyBtn.className = 'btn btn-danger';
  denyBtn.appendChild(faIcon('fas fa-ban'));
  denyBtn.appendChild(document.createTextNode(' Deny'));

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'btn btn-primary';
  approveBtn.appendChild(faIcon('fas fa-check'));
  approveBtn.appendChild(document.createTextNode(' Approve'));

  function dismiss(approved) {
    if (modal._dismissed) return;
    modal._dismissed = true;
    if (approved) {
      window.electron.tool.respondToApproval(approvalId, true, {
        alwaysApprove: Boolean(alwaysApproveInput.checked)
      });
    } else {
      window.electron.tool.respondToApproval(approvalId, false, { alwaysApprove: false });
    }
    modal.remove();
    dom.userInput.focus();
  }

  denyBtn.addEventListener('click', () => dismiss(false), { once: true });
  approveBtn.addEventListener('click', () => dismiss(true), { once: true });

  // Allow dismissing via backdrop click or Escape key
  modal.addEventListener('click', (event) => {
    if (event.target === modal) dismiss(false);
  });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss(false);
  });

  actions.appendChild(alwaysApproveLabel);
  actions.appendChild(denyBtn);
  actions.appendChild(approveBtn);

  card.appendChild(title);
  card.appendChild(toolLabel);
  card.appendChild(pre);
  card.appendChild(actions);

  modal.appendChild(card);
  document.body.appendChild(modal);
  approveBtn.focus();
}

function showDirectoryAccessDialog(requestId, directory, toolName) {
  const modal = document.createElement('div');
  modal.className = 'tool-approval-modal';

  const card = document.createElement('div');
  card.className = 'tool-approval-card';

  const title = document.createElement('h3');
  title.textContent = 'Directory Access Required';

  const desc = document.createElement('p');
  desc.textContent = `The tool "${toolName}" needs access to a directory outside the current working directory:`;

  const pathEl = document.createElement('pre');
  pathEl.textContent = directory;
  pathEl.style.userSelect = 'all';

  const hint = document.createElement('p');
  hint.style.fontSize = '12px';
  hint.style.opacity = '0.7';
  hint.textContent = 'Allowing will grant access for this session only.';

  const actions = document.createElement('div');
  actions.className = 'tool-approval-actions';

  const denyBtn = document.createElement('button');
  denyBtn.type = 'button';
  denyBtn.className = 'btn btn-danger';
  denyBtn.appendChild(faIcon('fas fa-ban'));
  denyBtn.appendChild(document.createTextNode(' Deny'));

  const allowBtn = document.createElement('button');
  allowBtn.type = 'button';
  allowBtn.className = 'btn btn-primary';
  allowBtn.appendChild(faIcon('fas fa-folder-open'));
  allowBtn.appendChild(document.createTextNode(' Allow'));

  function dismiss(approved) {
    if (modal._dismissed) return;
    modal._dismissed = true;
    window.electron.tool.respondToDirectoryAccess(requestId, approved);
    modal.remove();
    dom.userInput.focus();
  }

  denyBtn.addEventListener('click', () => dismiss(false), { once: true });
  allowBtn.addEventListener('click', () => dismiss(true), { once: true });

  modal.addEventListener('click', (event) => {
    if (event.target === modal) dismiss(false);
  });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss(false);
  });

  actions.appendChild(denyBtn);
  actions.appendChild(allowBtn);

  card.appendChild(title);
  card.appendChild(desc);
  card.appendChild(pathEl);
  card.appendChild(hint);
  card.appendChild(actions);

  modal.appendChild(card);
  document.body.appendChild(modal);
  allowBtn.focus();
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

function getChatPreview(chat) {
  const messages = chat.messages || [];
  const lastVisible = messages.findLast((m) => m.sender === 'user' || m.sender === 'assistant');
  return lastVisible ? lastVisible.text : 'No messages yet...';
}

function sumChatLlmTotals(chat) {
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

function formatTokenCount(value = 0) {
  return Number(value || 0).toLocaleString();
}

function getActiveInferenceTier() {
  return String(appState.settings?.inference?.activeTier || 'standard').toLowerCase();
}

function formatInferenceTierLabel(tier) {
  const normalized = String(tier || 'standard').toLowerCase();
  if (normalized === 'fast') return 'Fast';
  if (normalized === 'smart') return 'Smart';
  return 'Standard';
}

function renderChatList() {
  dom.chatList.innerHTML = '';

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

function renderChatInfoPopover() {
  if (!dom.chatInfoPopoverBody) return;
  const chat = getActiveChat();
  dom.chatInfoPopoverBody.innerHTML = '';

  if (!chat) {
    dom.chatInfoPopoverBody.textContent = 'No active chat.';
    return;
  }

  const totals = chat.llmTotals || sumChatLlmTotals(chat);
  const messageCount = chat.messages?.length || 0;
  const userMessages = chat.messages?.filter((m) => m.sender === 'user').length || 0;
  const assistantMessages = chat.messages?.filter((m) => m.sender === 'assistant').length || 0;
  const tier = formatInferenceTierLabel(getActiveInferenceTier());
  const tierMap = appState.settings?.inference?.tierMap || {};
  const activeTierKey = getActiveInferenceTier();
  const tierInfo = tierMap[activeTierKey] || {};
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

  /* --- Inference controls section --- */
  appendRow({ divider: true });
  appendRow({ section: 'Inference' });

  // Tier selector row
  const tierRow = document.createElement('div');
  tierRow.className = 'chat-info-row';
  const tierLabel = document.createElement('span');
  tierLabel.className = 'chat-info-label';
  tierLabel.appendChild(faIcon('fas fa-bolt'));
  tierLabel.appendChild(document.createTextNode('Tier'));
  const tierSelect = document.createElement('select');
  tierSelect.className = 'chat-info-select';
  ['fast', 'standard', 'smart'].forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = formatInferenceTierLabel(t);
    if (t === activeTierKey) opt.selected = true;
    tierSelect.appendChild(opt);
  });
  tierSelect.addEventListener('change', async () => {
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.setInferenceTier({ tier: tierSelect.value }),
        'Failed to set inference tier.'
      );
      appState.settings.inference = result.inference || appState.settings.inference;
      // Update the provider/model dropdowns for the new tier
      const newInfo = (appState.settings.inference.tierMap || {})[tierSelect.value] || {};
      if (providerSelect) providerSelect.value = newInfo.provider || 'openai';
      if (populateModels) populateModels(newInfo.provider || 'openai', newInfo.model || '');
      if (typeof renderInferenceTierDetails === 'function') renderInferenceTierDetails();
    } catch (err) { /* silently fail */ }
  });
  tierRow.appendChild(tierLabel);
  tierRow.appendChild(tierSelect);
  dom.chatInfoPopoverBody.appendChild(tierRow);

  // Provider row (dropdown)
  const providerRow = document.createElement('div');
  providerRow.className = 'chat-info-row';
  const providerLabel = document.createElement('span');
  providerLabel.className = 'chat-info-label';
  providerLabel.appendChild(faIcon('fas fa-plug'));
  providerLabel.appendChild(document.createTextNode('Provider'));
  const providerSelect = document.createElement('select');
  providerSelect.className = 'chat-info-select';
  const providerDisplayNames = {
    openai: 'OpenAI', anthropic: 'Anthropic', groq: 'Groq',
    mistral: 'Mistral', ollama: 'Ollama', gemini: 'Gemini', openrouter: 'OpenRouter'
  };
  Object.keys(providerDisplayNames).forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = providerDisplayNames[p];
    if (p === (tierInfo.provider || '')) opt.selected = true;
    providerSelect.appendChild(opt);
  });
  providerRow.appendChild(providerLabel);
  providerRow.appendChild(providerSelect);
  dom.chatInfoPopoverBody.appendChild(providerRow);

  // Model row (dropdown)
  const modelRow = document.createElement('div');
  modelRow.className = 'chat-info-row';
  const modelLabel = document.createElement('span');
  modelLabel.className = 'chat-info-label';
  modelLabel.appendChild(faIcon('fas fa-microchip'));
  modelLabel.appendChild(document.createTextNode('Model'));
  const modelSelect = document.createElement('select');
  modelSelect.className = 'chat-info-select';
  // Seed with current model so there's no flash of empty
  if (tierInfo.model) {
    const opt = document.createElement('option');
    opt.value = tierInfo.model;
    opt.textContent = tierInfo.model;
    opt.selected = true;
    modelSelect.appendChild(opt);
  }
  modelRow.appendChild(modelLabel);
  modelRow.appendChild(modelSelect);
  dom.chatInfoPopoverBody.appendChild(modelRow);

  // Helper to populate model dropdown from API (with static fallback)
  let modelFetchId = 0;
  const populateModels = async (provider, selectedModel) => {
    const fetchId = ++modelFetchId;
    modelSelect.disabled = true;
    modelSelect.innerHTML = '';
    const loadingOpt = document.createElement('option');
    loadingOpt.textContent = 'Loading…';
    loadingOpt.disabled = true;
    loadingOpt.selected = true;
    modelSelect.appendChild(loadingOpt);

    try {
      const result = unwrapIpcResult(
        await window.electron.settings.listModels({ provider }),
        'Failed to list models.'
      );
      if (fetchId !== modelFetchId) return; // stale response
      modelSelect.innerHTML = '';
      const models = result.models || [];
      let hasSelected = false;
      models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === selectedModel) { opt.selected = true; hasSelected = true; }
        modelSelect.appendChild(opt);
      });
      // If current model not in list, keep it at the top
      if (selectedModel && !hasSelected) {
        const opt = document.createElement('option');
        opt.value = selectedModel;
        opt.textContent = selectedModel + ' (current)';
        opt.selected = true;
        modelSelect.insertBefore(opt, modelSelect.firstChild);
      }
    } catch {
      if (fetchId !== modelFetchId) return;
      modelSelect.innerHTML = '';
      if (selectedModel) {
        const opt = document.createElement('option');
        opt.value = selectedModel;
        opt.textContent = selectedModel;
        modelSelect.appendChild(opt);
      }
    } finally {
      if (fetchId === modelFetchId) modelSelect.disabled = false;
    }
  };

  // Provider change → fetch models + persist
  providerSelect.addEventListener('change', async () => {
    const newProvider = providerSelect.value;
    const activeTier = tierSelect.value;
    await populateModels(newProvider, '');
    const newModel = modelSelect.value || '';
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.setTierProviderModel({
          tier: activeTier, provider: newProvider, model: newModel
        }),
        'Failed to update provider.'
      );
      appState.settings.inference = result.inference || appState.settings.inference;
      if (typeof renderInferenceTierDetails === 'function') renderInferenceTierDetails();
    } catch { /* silently fail */ }
  });

  // Model change → persist
  modelSelect.addEventListener('change', async () => {
    const activeTier = tierSelect.value;
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.setTierProviderModel({
          tier: activeTier, model: modelSelect.value
        }),
        'Failed to update model.'
      );
      appState.settings.inference = result.inference || appState.settings.inference;
      if (typeof renderInferenceTierDetails === 'function') renderInferenceTierDetails();
    } catch { /* silently fail */ }
  });

  // Load models for current provider
  populateModels(tierInfo.provider || 'openai', tierInfo.model || '');

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
    addToolEventCompact(
      'Agent mode',
      { mode: appState.isAgentModeEnabled ? 'on' : 'off' },
      appState.isAgentModeEnabled ? 'success' : '',
      false
    );
  });
  const agentSlider = document.createElement('span');
  agentSlider.className = 'chat-info-toggle-slider';
  agentToggle.appendChild(agentCheckbox);
  agentToggle.appendChild(agentSlider);
  agentRow.appendChild(agentLabel);
  agentRow.appendChild(agentToggle);
  dom.chatInfoPopoverBody.appendChild(agentRow);
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
    dom.chatHeaderMeta.textContent = `Start a new conversation • Tier: ${formatInferenceTierLabel(getActiveInferenceTier())}`;
    return;
  }

  dom.chatHeaderTitle.textContent = activeChat.title;
  const chatTotals = activeChat.llmTotals || sumChatLlmTotals(activeChat);
  const dirLabel = activeChat.workingDirectory ? ` • ${activeChat.workingDirectory}` : '';
  dom.chatHeaderMeta.textContent = `Updated ${formatTimestamp(activeChat.updatedAt)} • Total ${formatTokenCount(chatTotals.totalTokens)} tokens • ${formatUsd(chatTotals.costUsd)} • Tier: ${formatInferenceTierLabel(getActiveInferenceTier())}${dirLabel}`;
  if (dom.workingDirBtn) {
    dom.workingDirBtn.title = activeChat.workingDirectory ? `Working directory: ${activeChat.workingDirectory}` : 'Set working directory';
  }

  let runningTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };

  activeChat.messages.forEach((message) => {
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
        addToolEventCompact(block.toolName, { content: block.content }, 'success', false);
      }
      displayText = cleanText;
      if (!displayText) return; // message was entirely tool blocks
    }

    addMessage(message.sender, displayText, {
      llm: message?.llm,
      runningLlmTotals: callTotals ? { ...runningTotals } : null,
      format: message?.format,
      images: message?.images
    });
  });

  // Flush any remaining buffered tool group from the rendering pass
  flushToolGroup();
}

function refreshUI() {
  renderChatList();
  renderChatMessages();
  updateEmptyState();
}

function setSettingsDrawer(open) {
  dom.settingsDrawer.hidden = !open;
  document.body.style.overflow = open ? 'hidden' : '';
}

function switchSettingsTab(tabName) {
  if (!dom.settingsNavSelect) return;
  dom.settingsNavSelect.value = tabName;
  dom.settingsDrawer.querySelectorAll('.settings-tab-content').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.tab === tabName);
  });
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

function renderInferenceTierDetails() {
  if (!dom.inferenceTierDetails) return;
  const inference = appState.settings.inference || {};
  const tierMap = inference.tierMap || {};
  const timeouts = inference.timeoutsMs || {};
  const activeTier = String(inference.activeTier || 'standard').toLowerCase();

  dom.inferenceTierDetails.innerHTML = '';
  ['fast', 'standard', 'smart'].forEach((tier) => {
    const info = tierMap[tier] || {};
    const row = document.createElement('div');
    row.className = 'inference-tier-row' + (tier === activeTier ? ' active-tier' : '');

    const label = document.createElement('span');
    label.className = 'inference-tier-label';
    label.textContent = tier;

    const meta = document.createElement('span');
    meta.className = 'inference-tier-meta';
    const timeoutSec = Math.round((timeouts[tier] || 30000) / 1000);
    meta.textContent = `${info.provider || '?'} / ${info.model || '?'} • ${timeoutSec}s timeout`;

    row.appendChild(label);
    row.appendChild(meta);
    dom.inferenceTierDetails.appendChild(row);
  });

  if (dom.inferenceTierSelect) {
    dom.inferenceTierSelect.value = activeTier;
  }
}

function openSettingsDrawer() {
  setSettingsDrawer(true);
  loadSettings();
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

  if (appState.settings.activeProvider === providerKey) {
    const activeBadge = document.createElement('span');
    activeBadge.className = 'active-provider-badge';
    activeBadge.textContent = 'Active';
    titleWrap.appendChild(activeBadge);
  }

  const status = document.createElement('span');
  status.className = 'provider-status';
  if (provider.status?.ok) {
    status.classList.add('ok');
    status.textContent = 'Connected';
  } else if (provider.status) {
    status.classList.add('error');
    status.textContent = 'Error';
  } else {
    status.textContent = 'Not tested';
  }

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

  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'Model';

  const modelSelect = document.createElement('select');
  modelSelect.className = 'provider-input';
  modelSelect.dataset.modelProvider = providerKey;
  // Seed with current model
  if (provider.model) {
    const opt = document.createElement('option');
    opt.value = provider.model;
    opt.textContent = provider.model;
    opt.selected = true;
    modelSelect.appendChild(opt);
  }

  // Fetch models from API asynchronously
  (async () => {
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.listModels({ provider: providerKey }),
        'Failed to list models.'
      );
      const models = result.models || [];
      const currentModel = provider.model || '';
      modelSelect.innerHTML = '';
      let hasSelected = false;
      models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === currentModel) { opt.selected = true; hasSelected = true; }
        modelSelect.appendChild(opt);
      });
      if (currentModel && !hasSelected) {
        const opt = document.createElement('option');
        opt.value = currentModel;
        opt.textContent = currentModel + ' (current)';
        opt.selected = true;
        modelSelect.insertBefore(opt, modelSelect.firstChild);
      }
    } catch { /* keep the seeded option */ }
  })();

  // Auto-save on change
  modelSelect.addEventListener('change', async () => {
    const model = modelSelect.value;
    const result = await window.electron.settings.setProviderModel({
      provider: providerKey, model
    });
    if (!result.ok) {
      setProviderMessage(providerKey, result.error || 'Unable to save model.', true);
      return;
    }
    appState.settings.providers[providerKey].model = result.model;
    setProviderMessage(providerKey, `Model saved: ${result.model || '(default)'}`);
  });

  controls.appendChild(modelLabel);
  controls.appendChild(modelSelect);

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

  const activeBtn = document.createElement('button');
  activeBtn.type = 'button';
  activeBtn.className = 'btn';
  activeBtn.textContent = appState.settings.activeProvider === providerKey ? 'Active Provider' : 'Set Active';
  activeBtn.disabled = appState.settings.activeProvider === providerKey;
  activeBtn.dataset.action = 'set-active';
  activeBtn.dataset.provider = providerKey;

  actions.appendChild(saveBtn);
  actions.appendChild(activeBtn);
  actions.appendChild(testBtn);
  actions.appendChild(clearBtn);

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

  renderInferenceTierDetails();

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
  if (dom.websearchStatus) {
    const hasBrave = Boolean(webSearch.brave?.apiKey);
    const hasTavily = Boolean(webSearch.tavily?.apiKey);
    const parts = [];
    if (hasBrave) parts.push('Brave');
    if (hasTavily) parts.push('Tavily');
    dom.websearchStatus.textContent = parts.length
      ? `Configured: ${parts.join(', ')}`
      : 'No web search keys configured.';
    dom.websearchStatus.classList.remove('error');
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
  if (!confirm(`Remove skill "${skillName || skillId}"? This will delete its files.`)) {
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

async function loadSkillSettingsTabs() {
  if (!dom.settingsNavSelect) return;

  try {
    const result = await window.electron.skill.listWithSettings();
    const skills = Array.isArray(result) ? result : (result?.data || []);

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
    console.error('[skill-settings] Failed to load skill settings tabs:', err);
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
  const confirmed = confirm('Clear all memory entries? This cannot be undone.');
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
  const confirmed = confirm('Clear the saved ElevenLabs API key?');
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
  if (!confirm(`Delete cron job ${jobId}?`)) return;
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
    loadWebhookList().catch(() => {});
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
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'rename-chat-modal';

    const card = document.createElement('div');
    card.className = 'rename-chat-card';

    const heading = document.createElement('h3');
    heading.textContent = 'Rename chat';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-chat-input';
    input.value = currentTitle || '';
    input.placeholder = 'Enter chat name';

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
    saveBtn.appendChild(faIcon('fas fa-check'));
    saveBtn.appendChild(document.createTextNode(' Save'));

    const close = (value = null) => {
      modal.remove();
      resolve(value);
    };

    cancelBtn.addEventListener('click', () => close(null));
    saveBtn.addEventListener('click', () => close(input.value));

    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        close(null);
      }
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        close(input.value);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    card.appendChild(heading);
    card.appendChild(input);
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

  if (message === '' && pendingImages.length === 0) {
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
    const newChat = await window.electron.chat.create('New Chat');
    if (!newChat) {
      return;
    }
    appState.chats = [newChat, ...appState.chats.filter((chat) => chat.id !== newChat.id)];
    appState.activeChatId = newChat.id;
  }

  const slashCommand = parseSlashCommand(message);
  if (slashCommand?.name === '/help') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    const helpText = await getLocalHelpText();
    appendLocalMessage('user', message);
    appendLocalMessage('assistant', helpText);

    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: helpText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    return;
  }

  if (slashCommand?.name === '/cd') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

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
      const result = await window.electron.chat.pickWorkingDirectory(appState.activeChatId);
      if (result && !result.canceled && result.chat) {
        appState.chats = appState.chats.map((c) => c.id === result.chat.id ? result.chat : c);
        responseText = `Working directory set to \`${result.chat.workingDirectory}\``;
      } else {
        responseText = 'No directory selected.';
      }
    }

    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
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
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: helpText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      return;
    }

    if (modeArg !== 'status') persistAgentMode();
    renderAgentModeButton();
    const statusText = modeArg === 'status'
      ? `Agent mode is currently **${appState.isAgentModeEnabled ? 'ON' : 'OFF'}**.`
      : `Agent mode is now **${appState.isAgentModeEnabled ? 'ON' : 'OFF'}**.`;

    appendLocalMessage('user', message);
    appendLocalMessage('assistant', statusText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: statusText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    return;
  }

  if (slashCommand?.name === '/delegate') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    const taskArg = slashCommand.args[0] || '';
    if (!taskArg) {
      const usage = 'Usage: `/delegate <task-plan-path>` — reads task configs from a JSON file and executes them with dependency ordering.\n\nExample JSON:\n```json\n{ "agentId": "code-writer", "tasks": [\n  { "id": "t26", "subject": "Task 26", "description": "..." },\n  { "id": "t29", "subject": "Task 29", "description": "...", "blockedBy": ["t26"] }\n]}\n```';
      appendLocalMessage('assistant', usage);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: usage }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
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
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: completionMsg }).catch((err2) => console.warn('[chat] addMessage persistence failed:', err2.message));
    } catch (err) {
      const errMsg = `Delegation failed: ${err.message}`;
      appendLocalMessage('assistant', errMsg);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errMsg }).catch((err2) => console.warn('[chat] addMessage persistence failed:', err2.message));
    }

    return;
  }

  if (slashCommand?.name === '/profile') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    const action = (slashCommand.args[0] || '').toLowerCase();
    if (!action) {
      appendLocalMessage('user', message);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

      const summary = formatProfileSummary(appState.settings.userProfile || {});
      appendLocalMessage('assistant', summary);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: summary }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      return;
    }

    if (action !== 'set') {
      const usage = 'Usage: `/profile` or `/profile set <field> <value>`. Fields: name, role, projectContext, goals, preferences';
      appendLocalMessage('user', message);
      appendLocalMessage('assistant', usage);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: usage }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
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
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    }

    return;
  }

  if (['/fast', '/standard', '/smart'].includes(slashCommand?.name)) {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    const tier = slashCommand.name.slice(1);
    try {
      const result = await window.electron.settings.setInferenceTier({ tier });
      const responseText = result?.ok
        ? `Inference tier is now **${formatInferenceTierLabel(tier)}**.`
        : `❌ ${result?.error || 'Unable to update inference tier.'}`;

      if (result?.ok && result?.inference) {
        appState.settings.inference = result.inference;
        refreshUI();
      }

      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    } catch (error) {
      const errorText = `❌ ${error.message || 'Unable to update inference tier.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    }

    return;
  }

  if (slashCommand?.name === '/pin') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';
    const skillId = slashCommand.args[0];
    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    if (!skillId) {
      const errorText = 'Usage: `/pin <skill-id>`. Use `/pin std` to pin the STD skill.';
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      return;
    }
    const result = await window.electron.skill.pin({ chatId: appState.activeChatId, skillId });
    const responseText = result.ok
      ? `📌 Pinned **${result.name || skillId}** to this chat. All messages will be handled by this skill. Use \`/unpin\` to restore normal behavior.`
      : `❌ ${result.error}`;
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    return;
  }

  if (slashCommand?.name === '/unpin') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';
    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    const result = await window.electron.skill.unpin({ chatId: appState.activeChatId });
    const responseText = result.ok ? '📌 Unpinned. Normal behavior restored.' : `❌ ${result.error}`;
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    return;
  }

  if (slashCommand?.name === '/pinned') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';
    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    const result = await window.electron.skill.getPinned({ chatId: appState.activeChatId });
    const responseText = result.pinned
      ? `📌 Pinned skill: **${result.pinned.name || result.pinned.skillId}** (\`${result.pinned.skillId}\`)`
      : 'No skill is currently pinned to this chat.';
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    return;
  }

  if (slashCommand?.name === '/skill') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    const action = (slashCommand.args[0] || '').toLowerCase();
    const skillId = (slashCommand.args[1] || '').trim();

    if (action !== 'customize' || !skillId) {
      const usage = 'Usage: `/skill customize <skill-id>`. Example: `/skill customize std`';
      appendLocalMessage('assistant', usage);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: usage }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      return;
    }

    try {
      const result = await window.electron.skill.customize({ skillId });
      const responseText = result?.ok
        ? `Opened customization file for **${result.skillId}** at:\n\`${result.path}\`${result.created ? '\n\nCreated a new file with starter defaults.' : ''}`
        : `❌ ${result?.error || 'Unable to open customization file.'}`;
      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    } catch (error) {
      const errorText = `❌ ${error.message || 'Unable to open customization file.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    }

    return;
  }

  if (slashCommand?.name === '/llm') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    try {
      const result = await window.electron.settings.runLlmCommand({ command: message });
      const responseText = result?.ok
        ? (result.output || 'Command completed.')
        : `Error: ${result?.error || 'Unable to run local LLM command.'}`;

      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    } catch (error) {
      const errorText = `Error: ${error.message || 'Unable to run local LLM command.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    }

    return;
  }

  if (slashCommand?.name === '/fixit') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    appendLocalMessage('assistant', 'Running diagnostics...');

    try {
      const result = await window.electron.diagnostics.run();
      const responseText = result?.ok
        ? '```\n' + (result.formatted || 'No results.') + '\n```'
        : `Error: ${result?.error || 'Diagnostics failed.'}`;

      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    } catch (error) {
      const errorText = `Error: ${error.message || 'Diagnostics failed.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    }

    return;
  }

  if (slashCommand?.name === '/speak') {
    dom.userInput.value = '';
    dom.userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

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
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    } catch (error) {
      const errorText = `❌ ${error.message || 'Unable to speak the last response.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
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
        window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

        const responseText = skillResult.ok === false
          ? `❌ ${skillResult.error || 'Skill command failed.'}`
          : (skillResult.message || 'Skill command executed.');
        const responseFormat = skillResult.format || 'markdown';
        appendLocalMessage('assistant', responseText, { format: responseFormat });
        window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText, format: responseFormat }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

        return;
      }
    } catch (error) {
      // Skill command failed or doesn't exist - continue to LLM
      console.log('[renderer] Skill command not found, sending to LLM:', commandName);
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
        if (pendingImages.length > 0) {
          throw new Error('Pinned skill handling currently supports text-only input. Unpin skill or send without images.');
        }
        const responseText = skillResult.ok
          ? (skillResult.message || 'Done.')
          : `❌ ${skillResult.error || 'Error'}`;
        const responseFormat = skillResult.format || 'markdown';
        window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
        appendLocalMessage('assistant', responseText, { format: responseFormat });
        window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: responseText, format: responseFormat }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
        return;
      }
    }

    const rawResult = await window.electron.chat.sendMessage({
      chatId: appState.activeChatId,
      message,
      images: pendingImages.map(({ previewUrl, ...rest }) => rest),
      agentMode: appState.isAgentModeEnabled
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
      } catch { /* best-effort reload */ }
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
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'user', text: commandText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

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
      .catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
  } catch (error) {
    const errorText = `❌ ${error.message || 'Unable to complete task.'}`;
    appendLocalMessage('assistant', errorText);
    window.electron.chat.addMessage({ chatId: appState.activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Complete';
    }
  }
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

  if (sender === 'assistant' && metadata?.llm?.totals) {
    const callTotals = metadata.llm.totals;
    const runningTotals = metadata.runningLlmTotals;
    const metricsDiv = document.createElement('div');
    metricsDiv.className = 'message-metrics';

    const callSpan = document.createElement('span');
    callSpan.className = 'message-metrics-call';
    callSpan.textContent = `${formatTokenCount(callTotals.totalTokens)} tokens · ${formatCompactUsd(callTotals.costUsd)}`;

    if (runningTotals) {
      callSpan.textContent += ` · session ${formatTokenCount(runningTotals.totalTokens)} tokens · ${formatCompactUsd(runningTotals.costUsd)}`;
    }
  
    metricsDiv.appendChild(callSpan);

    messageContent.appendChild(metricsDiv);
  }

  messageDiv.appendChild(messageContent);
  
  dom.chatMessages.appendChild(messageDiv);
  
  // Scroll to bottom
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

async function loadChats() {
  const data = unwrapIpcResult(await window.electron.chat.load(), 'Unable to load chats.');
  appState.chats = data.chats || [];
  appState.activeChatId = data.activeChatId || appState.chats[0]?.id || null;
  const activeChat = appState.chats.find((c) => c.id === appState.activeChatId);
  appState.isAgentModeEnabled = !!(activeChat && activeChat.agentMode);
  refreshUI();
}

function persistAgentMode() {
  const chatId = appState.activeChatId;
  if (!chatId) return;
  const chat = appState.chats.find((c) => c.id === chatId);
  if (chat) chat.agentMode = appState.isAgentModeEnabled;
  window.electron.chat.setAgentMode(chatId, appState.isAgentModeEnabled).catch((err) => console.warn('[chat] setAgentMode persistence failed:', err.message));
}

async function handleCreateChat() {
  const newChat = unwrapIpcResult(await window.electron.chat.create('New Chat'), 'Unable to create chat.');
  if (newChat) {
    appState.chats = [newChat, ...appState.chats.filter((chat) => chat.id !== newChat.id)];
    appState.activeChatId = newChat.id;
    refreshUI();
  }
}

async function handleSelectChat(chatId) {
  appState.streamBuffers.clear();
  streamTextOffsets.clear();
  appState.activeChatId = chatId;
  const isStreaming = appState.activeResponses.has(chatId);
  if (dom.sendBtn) dom.sendBtn.hidden = isStreaming;
  if (dom.stopBtn) dom.stopBtn.hidden = !isStreaming;
  const chat = appState.chats.find((c) => c.id === chatId);
  appState.isAgentModeEnabled = !!(chat && chat.agentMode);
  unwrapIpcResult(await window.electron.chat.setActive(chatId), 'Unable to switch active chat.');
  refreshUI();
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
  const confirmed = confirm(`Delete "${chat.title}"? This cannot be undone.`);
  if (!confirmed) {
    return;
  }
  const result = unwrapIpcResult(await window.electron.chat.remove(chatId), 'Unable to delete chat.');
  appState.chats = result.chats || [];
  appState.activeChatId = result.activeChatId || appState.chats[0]?.id || null;
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

  setProviderMessage(providerKey, 'Token saved securely.');
  if (input) input.value = '';
  appState.settings.providers[providerKey].hasToken = result.hasToken;
  renderSettings();
}

async function handleClearProvider(providerKey) {
  const confirmed = confirm('Clear the saved token for this provider?');
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
  setProviderMessage(providerKey, 'Token removed.');
  renderSettings();
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

async function handleSaveProviderModel(providerKey) {
  const el = dom.providerList.querySelector(`[data-model-provider="${providerKey}"]`);
  const model = (el?.value || '').trim();
  const result = await window.electron.settings.setProviderModel({
    provider: providerKey,
    model
  });

  if (!result.ok) {
    setProviderMessage(providerKey, result.error || 'Unable to save model.', true);
    return;
  }

  appState.settings.providers[providerKey].model = result.model;
  setProviderMessage(providerKey, `Model saved: ${result.model || '(default)'}`);
  renderSettings();
}

async function handleSetActiveProvider(providerKey) {
  const result = await window.electron.settings.setActiveProvider({ provider: providerKey });
  if (!result.ok) {
    setProviderMessage(providerKey, result.error || 'Unable to set active provider.', true);
    return;
  }

  appState.settings.activeProvider = result.activeProvider;
  renderSettings();
}

// Event Listeners
dom.sendBtn.addEventListener('click', sendMessage);

if (dom.stopBtn) {
  dom.stopBtn.addEventListener('click', async () => {
    if (!appState.activeChatId) return;
    await window.electron.chat.stopResponse(appState.activeChatId);
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
  const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type?.startsWith('image/'));
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
    const result = await window.electron.chat.pickWorkingDirectory(appState.activeChatId);
    if (result && !result.canceled && result.chat) {
      appState.chats = appState.chats.map((c) => c.id === result.chat.id ? result.chat : c);
      refreshUI();
    }
  });
}

// --- Export chat as JSON ---
dom.exportChatBtn.addEventListener('click', () => {
  const chat = appState.chats.find(c => c.id === appState.activeChatId);
  if (!chat) return;

  // Enrich messages: extract XML tool blocks from assistant text into structured toolCalls
  const enrichedMessages = chat.messages.map((msg) => {
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
    addToolEventCompact(
      'Agent mode',
      {
        mode: appState.isAgentModeEnabled ? 'on' : 'off'
      },
      appState.isAgentModeEnabled ? 'success' : '',
      false
    );
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
      !e.target.closest('.chat-info-popover') && !e.target.closest('#chat-info-btn')) {
    dom.chatInfoPopover.hidden = true;
  }
});

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
    // Dismiss any lingering tool approval modals
    const approvalModal = document.querySelector('.tool-approval-modal');
    if (approvalModal && !approvalModal._dismissed) {
      approvalModal._dismissed = true;
      approvalModal.remove();
      dom.userInput.focus();
    }
  }
});

/* --- Settings tab switching -------------------------------- */
if (dom.settingsNavSelect) {
  sortSettingsNavOptions();
  dom.settingsNavSelect.addEventListener('change', () => {
    switchSettingsTab(dom.settingsNavSelect.value);
  });
}

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

/* --- Inference tier ---------------------------------------- */
if (dom.saveInferenceTierBtn) {
  dom.saveInferenceTierBtn.addEventListener('click', async () => {
    const tier = dom.inferenceTierSelect?.value;
    if (!tier) return;
    try {
      const result = unwrapIpcResult(
        await window.electron.settings.setInferenceTier({ tier }),
        'Failed to set inference tier.'
      );
      appState.settings.inference = result.inference || appState.settings.inference;
      renderInferenceTierDetails();
      if (dom.inferenceTierStatus) {
        dom.inferenceTierStatus.textContent = `Switched to "${tier}" tier.`;
        dom.inferenceTierStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.inferenceTierStatus) {
        dom.inferenceTierStatus.textContent = err.message || 'Error setting tier.';
        dom.inferenceTierStatus.classList.add('error');
      }
    }
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

/* --- Channel management: Web Search keys ------------------- */
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
      if (dom.websearchStatus) {
        dom.websearchStatus.textContent = 'Brave key saved.';
        dom.websearchStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchStatus) {
        dom.websearchStatus.textContent = err.message || 'Error saving Brave key.';
        dom.websearchStatus.classList.add('error');
      }
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
      if (dom.websearchStatus) {
        dom.websearchStatus.textContent = 'Brave key cleared.';
        dom.websearchStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchStatus) {
        dom.websearchStatus.textContent = err.message || 'Error.';
        dom.websearchStatus.classList.add('error');
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
      if (dom.websearchStatus) {
        dom.websearchStatus.textContent = 'Tavily key saved.';
        dom.websearchStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchStatus) {
        dom.websearchStatus.textContent = err.message || 'Error saving Tavily key.';
        dom.websearchStatus.classList.add('error');
      }
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
      if (dom.websearchStatus) {
        dom.websearchStatus.textContent = 'Tavily key cleared.';
        dom.websearchStatus.classList.remove('error');
      }
    } catch (err) {
      if (dom.websearchStatus) {
        dom.websearchStatus.textContent = err.message || 'Error.';
        dom.websearchStatus.classList.add('error');
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
    if (action === 'set-active') {
      handleSetActiveProvider(provider);
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

window.addEventListener('blur', () => {
  if (!dom.chatContextMenu.hidden) {
    closeContextMenu();
  }
});

unsubscribeHandlers.push(window.electron.chat.onMessageStart(({ chatId, responseId }) => {
  setResponseActive(true, chatId);
  if (chatId !== appState.activeChatId) return;

  // Flush any pending tool group before the assistant message
  flushToolGroup();

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant streaming';
  messageDiv.dataset.responseId = responseId;

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  messageDiv.appendChild(messageContent);
  dom.chatMessages.appendChild(messageDiv);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  appState.streamBuffers.set(responseId, '');
}));

unsubscribeHandlers.push(window.electron.chat.onMessageChunk(({ chatId, responseId, chunk }) => {
  if (chatId !== appState.activeChatId) return;

  const existing = appState.streamBuffers.get(responseId) || '';
  const next = existing + (chunk || '');
  appState.streamBuffers.set(responseId, next);

  const streamElement = dom.chatMessages.querySelector(`[data-response-id="${responseId}"] .message-content`);
  if (!streamElement) return;

  // Extract completed XML tool blocks and render them as pills
  const { cleanText, toolBlocks } = extractXmlToolBlocks(next);
  for (const block of toolBlocks) {
    // Only render each tool block once — track which we've already shown
    const rendered = appState.streamRenderedTools = appState.streamRenderedTools || new Map();
    const key = `${responseId}:${block.toolName}:${block.content.slice(0, 80)}`;
    if (!rendered.has(key)) {
      rendered.set(key, true);
      freezeStreamingText(cleanText);
      addToolEventCompact(block.toolName, { content: block.content }, 'success', false);
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
    // If the message is now empty after tool extraction, remove it entirely
    const content = messageDiv.querySelector('.message-content');
    if (content && !content.textContent.trim()) {
      messageDiv.remove();
    }
  }
}));

unsubscribeHandlers.push(window.electron.chat.onMessageError(({ chatId, responseId, error }) => {
  appState.streamBuffers.delete(responseId);
  streamTextOffsets.delete(responseId);
  setResponseActive(false, chatId);
  if (chatId !== appState.activeChatId) return;

  let messageDiv = dom.chatMessages.querySelector(`[data-response-id="${responseId}"] .message-content`);

  // If onMessageStart never fired, there's no element yet — create one so the
  // error is visible instead of silently lost.
  if (!messageDiv) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message assistant';
    wrapper.dataset.responseId = responseId || 'error';
    messageDiv = document.createElement('div');
    messageDiv.className = 'message-content';
    wrapper.appendChild(messageDiv);
    dom.chatMessages.appendChild(wrapper);
  }

  const p = document.createElement('p');
  p.textContent = `Error: ${error}`;
  messageDiv.textContent = '';
  messageDiv.appendChild(p);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
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
    console.error('[renderer] Failed to render tool use for', toolName, err);
  }
}));

unsubscribeHandlers.push(window.electron.chat.onToolResult(({ chatId, toolName, result }) => {
  if (chatId !== appState.activeChatId) return;
  const isError = result?.success === false || result?.ok === false;
  try {
    addToolEventCompact(toolName, result, isError ? 'error' : 'success', true);
    keepStreamingIndicatorAtBottom();
  } catch (err) {
    console.error('[renderer] Failed to render tool result for', toolName, err);
  }
}));

unsubscribeHandlers.push(window.electron.tool.onApprovalRequired(({ approvalId, toolName, parameters }) => {
  showToolApprovalDialog(approvalId, toolName, parameters);
}));

unsubscribeHandlers.push(window.electron.tool.onDirectoryAccessRequired(({ requestId, directory, toolName }) => {
  showDirectoryAccessDialog(requestId, directory, toolName);
}));

unsubscribeHandlers.push(window.electron.agent.onAskUser(({ requestId, question }) => {
  const modal = document.createElement('div');
  modal.className = 'tool-approval-modal'; // reusing styles

  const card = document.createElement('div');
  card.className = 'tool-approval-card';

  const title = document.createElement('h3');
  title.textContent = 'Agent requires your input';

  const qLabel = document.createElement('p');
  qLabel.textContent = question;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-chat-input'; // reusing styles
  input.placeholder = 'Enter your response...';

  const actions = document.createElement('div');
  actions.className = 'tool-approval-actions';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'btn btn-primary';
  submitBtn.appendChild(faIcon('fas fa-paper-plane'));
  submitBtn.appendChild(document.createTextNode(' Submit'));

  const close = (responseStr) => {
    window.electron.agent.sendUserResponse({ requestId, response: responseStr });
    modal.remove();
  };

  submitBtn.addEventListener('click', () => close(input.value), { once: true });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      close(input.value);
    }
  });

  actions.appendChild(submitBtn);

  card.appendChild(title);
  card.appendChild(qLabel);
  card.appendChild(input);
  card.appendChild(actions);

  modal.appendChild(card);
  document.body.appendChild(modal);
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
  try { await window.electron.wizard.complete(); } catch { /* ok */ }
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
          name: wizardState.data.name,
          role: wizardState.data.role || ''
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

loadChats();
loadSettings();
renderAgentModeButton();
renderHistoryToggleButton();
checkFirstRun();
