// DOM Elements
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const chatMessages = document.getElementById('chat-messages');
const newChatBtn = document.getElementById('new-chat-btn');
const newChatBtnCompact = document.getElementById('new-chat-btn-compact');
const chatList = document.getElementById('chat-list');
const chatHeaderTitle = document.getElementById('chat-header-title');
const chatHeaderMeta = document.getElementById('chat-header-meta');
const emptyState = document.getElementById('empty-state');
const mainContent = document.querySelector('.main-content');
const container = document.querySelector('.container');
const sidebar = document.querySelector('.sidebar');
const chatContextMenu = document.getElementById('chat-context-menu');
const settingsDrawer = document.getElementById('settings-drawer');
const toggleHistoryBtn = document.getElementById('toggle-history-btn');
const openSettingsBtn = document.getElementById('open-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const floatingSettingsBtn = document.getElementById('floating-settings-btn');
const composerSettingsBtn = document.getElementById('composer-settings-btn');
const providerList = document.getElementById('provider-list');
const settingsEncryptionAlert = document.getElementById('settings-encryption-alert');
const agentModeBtn = document.getElementById('agent-mode-btn');
const templateNameInput = document.getElementById('template-name-input');
const templateRoleInput = document.getElementById('template-role-input');
const templatePreferencesInput = document.getElementById('template-preferences-input');
const templateProjectContextInput = document.getElementById('template-project-context-input');
const saveTemplateVariablesBtn = document.getElementById('save-template-variables-btn');
const templateVariablesStatus = document.getElementById('template-variables-status');
const profileNameInput = document.getElementById('profile-name-input');
const profileRoleInput = document.getElementById('profile-role-input');
const profileGoalsInput = document.getElementById('profile-goals-input');
const profilePreferencesInput = document.getElementById('profile-preferences-input');
const profileProjectContextInput = document.getElementById('profile-project-context-input');
const saveUserProfileBtn = document.getElementById('save-user-profile-btn');
const userProfileStatus = document.getElementById('user-profile-status');
const notificationsEnabledInput = document.getElementById('notifications-enabled-input');
const notificationsUiToastEnabledInput = document.getElementById('notifications-ui-toast-enabled-input');
const notificationsNtfyEnabledInput = document.getElementById('notifications-ntfy-enabled-input');
const notificationsTelegramLongTaskInput = document.getElementById('notifications-telegram-long-task-input');
const notificationsToastThresholdInput = document.getElementById('notifications-toast-threshold-input');
const notificationsExternalThresholdInput = document.getElementById('notifications-external-threshold-input');
const notificationsNtfyTopicInput = document.getElementById('notifications-ntfy-topic-input');
const saveNotificationsBtn = document.getElementById('save-notifications-btn');
const notificationsStatus = document.getElementById('notifications-status');
const voiceEnabledInput = document.getElementById('voice-enabled-input');
const voiceSpeakChatInput = document.getElementById('voice-speak-chat-input');
const voiceSpeakAgentSummaryInput = document.getElementById('voice-speak-agent-summary-input');
const voiceTelegramLongInput = document.getElementById('voice-telegram-long-input');
const voiceEngineInput = document.getElementById('voice-engine-input');
const voiceIdInput = document.getElementById('voice-id-input');
const voiceSpeedInput = document.getElementById('voice-speed-input');
const voiceStabilityInput = document.getElementById('voice-stability-input');
const voiceStyleInput = document.getElementById('voice-style-input');
const voiceSummaryMaxInput = document.getElementById('voice-summary-max-input');
const voiceTelegramMinInput = document.getElementById('voice-telegram-min-input');
const voiceElevenLabsKeyInput = document.getElementById('voice-elevenlabs-key-input');
const saveVoiceSettingsBtn = document.getElementById('save-voice-settings-btn');
const saveVoiceKeyBtn = document.getElementById('save-voice-key-btn');
const clearVoiceKeyBtn = document.getElementById('clear-voice-key-btn');
const testVoiceBtn = document.getElementById('test-voice-btn');
const voiceStatus = document.getElementById('voice-status');
const hooksGlobalEnabledInput = document.getElementById('hooks-global-enabled-input');
const reloadHooksBtn = document.getElementById('reload-hooks-btn');
const hooksStatus = document.getElementById('hooks-status');
const hooksList = document.getElementById('hooks-list');
const memoryQueryInput = document.getElementById('memory-query-input');
const memoryTierFilterInput = document.getElementById('memory-tier-filter-input');
const memoryCaptureTypeInput = document.getElementById('memory-capture-type-input');
const memoryCaptureContentInput = document.getElementById('memory-capture-content-input');
const memoryRefreshBtn = document.getElementById('memory-refresh-btn');
const memoryCaptureBtn = document.getElementById('memory-capture-btn');
const memoryClearBtn = document.getElementById('memory-clear-btn');
const memoryStatus = document.getElementById('memory-status');
const memoryList = document.getElementById('memory-list');

let chats = [];
let activeChatId = null;
let contextChatId = null;
let settingsState = {
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
};
const streamBufferById = new Map();
let isAgentModeEnabled = false;
let isHistoryCollapsed = false;
let memoryEntries = [];

function renderHistoryToggleButton() {
  if (!toggleHistoryBtn) return;

  const title = isHistoryCollapsed ? 'Expand chat history' : 'Collapse chat history';
  toggleHistoryBtn.textContent = isHistoryCollapsed ? '▶' : '◀';
  toggleHistoryBtn.title = title;
  toggleHistoryBtn.setAttribute('aria-label', title);
  toggleHistoryBtn.setAttribute('aria-pressed', isHistoryCollapsed ? 'true' : 'false');
}

function setHistoryCollapsed(collapsed) {
  isHistoryCollapsed = Boolean(collapsed);
  if (container && sidebar) {
    container.classList.toggle('history-collapsed', isHistoryCollapsed);
  }
  renderHistoryToggleButton();
}

function renderAgentModeButton() {
  if (!agentModeBtn) return;
  agentModeBtn.textContent = `Agent Mode: ${isAgentModeEnabled ? 'On' : 'Off'}`;
  agentModeBtn.classList.toggle('active', isAgentModeEnabled);
  agentModeBtn.setAttribute('aria-pressed', isAgentModeEnabled ? 'true' : 'false');
}

async function getLocalHelpText() {
  const helpLines = [
    '### Local Commands',
    '',
    '- `/help` — show local command help',
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
  chats = chats.map((chat) => {
    if (chat.id !== activeChatId) return chat;
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

  settingsState.userProfile = {
    ...(result.userProfile || profile)
  };
  renderSettings();

  if (userCommand) {
    appendLocalMessage('user', userCommand);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: userCommand }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
  }

  const summary = formatProfileSummary(settingsState.userProfile);
  appendLocalMessage('assistant', summary);
  window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: summary }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
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

function addToolEventMessage(title, payload, variant = '') {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message assistant tool-event ${variant}`.trim();

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  const heading = document.createElement('p');
  heading.className = 'tool-event-title';
  heading.textContent = title;

  messageContent.appendChild(heading);

  if (payload !== undefined) {
    const markdownCandidate = (() => {
      if (typeof payload === 'string') {
        return payload;
      }

      if (payload && typeof payload === 'object') {
        const keysToCheck = ['content', 'stdout', 'output', 'message'];
        for (const key of keysToCheck) {
          const value = payload[key];
          if (typeof value === 'string' && value.trim() !== '') {
            return value;
          }
        }
      }

      return null;
    })();

    if (typeof markdownCandidate === 'string') {
      const payloadDiv = document.createElement('div');
      payloadDiv.className = 'tool-event-payload';
      payloadDiv.innerHTML = window.electron.markdown.parse(markdownCandidate);
      messageContent.appendChild(payloadDiv);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'tool-event-payload';
      pre.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      messageContent.appendChild(pre);
    }
  }

  messageDiv.appendChild(messageContent);
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showToolApprovalDialog(approvalId, toolName, parameters) {
  const modal = document.createElement('div');
  modal.className = 'tool-approval-modal';

  const card = document.createElement('div');
  card.className = 'tool-approval-card';

  const title = document.createElement('h3');
  title.textContent = 'Tool Execution Approval Required';

  const toolLabel = document.createElement('p');
  toolLabel.innerHTML = `<strong>Tool:</strong> ${toolName}`;

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
  denyBtn.className = 'danger';
  denyBtn.textContent = 'Deny';

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'primary';
  approveBtn.textContent = 'Approve';

  denyBtn.addEventListener('click', () => {
    window.electron.tool.respondToApproval(approvalId, false, { alwaysApprove: false });
    modal.remove();
  });

  approveBtn.addEventListener('click', () => {
    window.electron.tool.respondToApproval(approvalId, true, {
      alwaysApprove: Boolean(alwaysApproveInput.checked)
    });
    modal.remove();
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
  return chats.find((chat) => chat.id === activeChatId);
}

function getChatPreview(chat) {
  const lastMessage = chat.messages?.[chat.messages.length - 1];
  return lastMessage ? lastMessage.text : 'No messages yet...';
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

function formatTokenCount(value = 0) {
  return Number(value || 0).toLocaleString();
}

function getActiveInferenceTier() {
  return String(settingsState?.inference?.activeTier || 'standard').toLowerCase();
}

function formatInferenceTierLabel(tier) {
  const normalized = String(tier || 'standard').toLowerCase();
  if (normalized === 'fast') return 'Fast';
  if (normalized === 'smart') return 'Smart';
  return 'Standard';
}

function renderChatList() {
  chatList.innerHTML = '';

  chats.forEach((chat) => {
    const chatItem = document.createElement('div');
    chatItem.className = `chat-item ${chat.id === activeChatId ? 'active' : ''}`;
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
    renameBtn.className = 'chat-action-btn';
    renameBtn.textContent = 'Rename';
    renameBtn.dataset.action = 'rename';
    renameBtn.dataset.chatId = chat.id;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'chat-action-btn danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.dataset.action = 'delete';
    deleteBtn.dataset.chatId = chat.id;

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);

    chatItem.appendChild(viewBtn);
    chatItem.appendChild(details);
    chatItem.appendChild(actions);

    chatList.appendChild(chatItem);
  });
}

function updateEmptyState() {
  const hasChats = chats.length > 0;
  const hasActiveChat = !!activeChatId;
  const showEmpty = !hasChats || !hasActiveChat;

  emptyState.hidden = !showEmpty;
  chatMessages.hidden = showEmpty;
  mainContent.classList.toggle('start-state', showEmpty);
  container.classList.toggle('start-state', showEmpty);
}

function renderChatMessages() {
  const activeChat = getActiveChat();
  chatMessages.innerHTML = '';

  if (!activeChat) {
    chatHeaderTitle.textContent = 'King Louie Chat';
    chatHeaderMeta.textContent = `Start a new conversation • Tier: ${formatInferenceTierLabel(getActiveInferenceTier())}`;
    return;
  }

  chatHeaderTitle.textContent = activeChat.title;
  const chatTotals = activeChat.llmTotals || sumChatLlmTotals(activeChat);
  chatHeaderMeta.textContent = `Updated ${formatTimestamp(activeChat.updatedAt)} • Total ${formatTokenCount(chatTotals.totalTokens)} tokens • ${formatUsd(chatTotals.costUsd)} • Tier: ${formatInferenceTierLabel(getActiveInferenceTier())}`;

  let runningTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };

  activeChat.messages.forEach((message) => {
    const callTotals = message?.llm?.totals || null;
    if (callTotals) {
      runningTotals = {
        inputTokens: runningTotals.inputTokens + (Number(callTotals.inputTokens) || 0),
        outputTokens: runningTotals.outputTokens + (Number(callTotals.outputTokens) || 0),
        totalTokens: runningTotals.totalTokens + (Number(callTotals.totalTokens) || 0),
        costUsd: Number((runningTotals.costUsd + (Number(callTotals.costUsd) || 0)).toFixed(8))
      };
    }

    addMessage(message.sender, message.text, {
      llm: message?.llm,
      runningLlmTotals: callTotals ? { ...runningTotals } : null,
      format: message?.format
    });
  });
}

function refreshUI() {
  renderChatList();
  renderChatMessages();
  updateEmptyState();
}

function setSettingsDrawer(open) {
  settingsDrawer.hidden = !open;
  document.body.style.overflow = open ? 'hidden' : '';
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

  if (settingsState.activeProvider === providerKey) {
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

  const modelInput = document.createElement('input');
  modelInput.className = 'provider-input';
  modelInput.type = 'text';
  modelInput.placeholder = 'Model name';
  modelInput.value = provider.model || '';
  modelInput.dataset.modelProvider = providerKey;

  controls.appendChild(modelLabel);
  controls.appendChild(modelInput);

  const actions = document.createElement('div');
  actions.className = 'provider-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary';
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save Token';
  saveBtn.dataset.action = 'save';
  saveBtn.dataset.provider = providerKey;

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.textContent = 'Test Connection';
  testBtn.dataset.action = 'test';
  testBtn.dataset.provider = providerKey;

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'danger';
  clearBtn.textContent = 'Clear Token';
  clearBtn.dataset.action = 'clear';
  clearBtn.dataset.provider = providerKey;

  const modelBtn = document.createElement('button');
  modelBtn.type = 'button';
  modelBtn.textContent = 'Save Model';
  modelBtn.dataset.action = 'save-model';
  modelBtn.dataset.provider = providerKey;

  const activeBtn = document.createElement('button');
  activeBtn.type = 'button';
  activeBtn.textContent = settingsState.activeProvider === providerKey ? 'Active Provider' : 'Set Active';
  activeBtn.disabled = settingsState.activeProvider === providerKey;
  activeBtn.dataset.action = 'set-active';
  activeBtn.dataset.provider = providerKey;

  actions.appendChild(saveBtn);
  actions.appendChild(modelBtn);
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
  settingsEncryptionAlert.hidden = settingsState.encryptionAvailable;

  const templateVariables = settingsState.templateVariables || {};
  if (templateNameInput) templateNameInput.value = templateVariables.name || '';
  if (templateRoleInput) templateRoleInput.value = templateVariables.role || '';
  if (templatePreferencesInput) templatePreferencesInput.value = templateVariables.preferences || '';
  if (templateProjectContextInput) templateProjectContextInput.value = templateVariables.projectContext || '';

  if (templateVariablesStatus) {
    templateVariablesStatus.textContent = 'Template variables loaded.';
    templateVariablesStatus.classList.remove('error');
  }

  const userProfile = settingsState.userProfile || {};
  if (profileNameInput) profileNameInput.value = userProfile.name || '';
  if (profileRoleInput) profileRoleInput.value = userProfile.role || '';
  if (profileGoalsInput) {
    const goals = Array.isArray(userProfile.goals) ? userProfile.goals : [];
    profileGoalsInput.value = goals.join('\n');
  }
  if (profilePreferencesInput) {
    profilePreferencesInput.value =
      userProfile.preferences && typeof userProfile.preferences === 'object'
        ? JSON.stringify(userProfile.preferences, null, 2)
        : '';
  }
  if (profileProjectContextInput) {
    profileProjectContextInput.value = userProfile.projectContext || '';
  }

  if (userProfileStatus) {
    userProfileStatus.textContent = 'User profile loaded.';
    userProfileStatus.classList.remove('error');
  }

  const notifications = settingsState.notifications || {};
  const thresholds = notifications.thresholdsMs || {};
  if (notificationsEnabledInput) notificationsEnabledInput.checked = notifications.enabled !== false;
  if (notificationsUiToastEnabledInput) notificationsUiToastEnabledInput.checked = notifications.uiToast?.enabled !== false;
  if (notificationsNtfyEnabledInput) notificationsNtfyEnabledInput.checked = notifications.ntfy?.enabled === true;
  if (notificationsTelegramLongTaskInput) notificationsTelegramLongTaskInput.checked = notifications.telegram?.longTaskNotice !== false;
  if (notificationsToastThresholdInput) notificationsToastThresholdInput.value = Math.round((Number(thresholds.toast || 30000)) / 1000);
  if (notificationsExternalThresholdInput) notificationsExternalThresholdInput.value = Math.round((Number(thresholds.external || 120000)) / 1000);
  if (notificationsNtfyTopicInput) notificationsNtfyTopicInput.value = String(notifications.ntfy?.topic || '');

  if (notificationsStatus) {
    notificationsStatus.textContent = 'Notification settings loaded.';
    notificationsStatus.classList.remove('error');
  }

  const voice = settingsState.voice || {};
  if (voiceEnabledInput) voiceEnabledInput.checked = voice.enabled === true;
  if (voiceSpeakChatInput) voiceSpeakChatInput.checked = voice.speakChatResponses === true;
  if (voiceSpeakAgentSummaryInput) voiceSpeakAgentSummaryInput.checked = voice.speakAgentSummary !== false;
  if (voiceTelegramLongInput) voiceTelegramLongInput.checked = voice.telegramVoiceForLongResponses === true;
  if (voiceEngineInput) voiceEngineInput.value = String(voice.engine || 'system');
  if (voiceIdInput) voiceIdInput.value = String(voice.voiceId || '');
  if (voiceSpeedInput) voiceSpeedInput.value = String(Number(voice.speed || 1));
  if (voiceStabilityInput) voiceStabilityInput.value = String(Number(voice.stability || 0.5));
  if (voiceStyleInput) voiceStyleInput.value = String(Number(voice.style || 0.25));
  if (voiceSummaryMaxInput) voiceSummaryMaxInput.value = String(Number(voice.summaryMaxChars || 260));
  if (voiceTelegramMinInput) voiceTelegramMinInput.value = String(Number(voice.telegramMinChars || 500));

  if (voiceStatus) {
    voiceStatus.textContent = voice.hasElevenLabsKey
      ? 'Voice settings loaded. ElevenLabs key is saved.'
      : 'Voice settings loaded. ElevenLabs key is not saved.';
    voiceStatus.classList.remove('error');
  }

  const hooks = settingsState.hooks || {};
  const loadedHooks = Array.isArray(hooks.loaded) ? hooks.loaded : [];

  if (hooksGlobalEnabledInput) {
    hooksGlobalEnabledInput.checked = hooks.enabled !== false;
  }

  if (hooksStatus) {
    hooksStatus.textContent = `Loaded ${loadedHooks.length} hook(s).`;
    hooksStatus.classList.remove('error');
  }

  if (hooksList) {
    hooksList.innerHTML = '';

    if (!loadedHooks.length) {
      const empty = document.createElement('div');
      empty.className = 'provider-message';
      empty.textContent = 'No hooks discovered in hooks/ directory.';
      hooksList.appendChild(empty);
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
        toggleBtn.textContent = hook.enabled !== false ? 'Disable Hook' : 'Enable Hook';
        if (hook.enabled !== false) {
          toggleBtn.className = 'danger';
        } else {
          toggleBtn.className = 'primary';
        }

        actions.appendChild(toggleBtn);

        card.appendChild(header);
        card.appendChild(description);
        card.appendChild(actions);
        hooksList.appendChild(card);
      });
    }
  }

  if (memoryStatus) {
    memoryStatus.textContent = 'Memory settings ready.';
    memoryStatus.classList.remove('error');
  }

  if (memoryCaptureTypeInput && !memoryCaptureTypeInput.value) {
    memoryCaptureTypeInput.value = 'context';
  }

  providerList.innerHTML = '';
  Object.entries(settingsState.providers).forEach(([key, provider]) => {
    providerList.appendChild(renderProviderCard(key, provider));
  });
}

function formatMemoryEntry(entry = {}) {
  const content = String(entry.content || '').trim();
  return content.length > 240
    ? `${content.slice(0, 240)}...`
    : content;
}

function renderMemoryList(entries = []) {
  if (!memoryList) return;

  memoryList.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No memories found for the current filters.';
    memoryList.appendChild(empty);
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
    deleteBtn.className = 'danger';
    deleteBtn.dataset.action = 'delete-memory';
    deleteBtn.dataset.memoryId = entry.id;
    deleteBtn.textContent = 'Delete';

    actions.appendChild(deleteBtn);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(meta);
    card.appendChild(actions);
    memoryList.appendChild(card);
  });
}

function collectMemoryFilters() {
  return {
    query: String(memoryQueryInput?.value || '').trim(),
    tier: String(memoryTierFilterInput?.value || '').trim(),
    limit: 200
  };
}

async function loadMemoryEntries() {
  if (!window.electron?.memory || !memoryList) {
    return;
  }

  const { query, tier, limit } = collectMemoryFilters();
  try {
    if (memoryStatus) {
      memoryStatus.textContent = 'Loading memories...';
      memoryStatus.classList.remove('error');
    }

    const result = await window.electron.memory.list({
      query,
      tier,
      limit
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to load memory entries.');
    }

    memoryEntries = Array.isArray(result.entries) ? result.entries : [];
    renderMemoryList(memoryEntries);
    if (memoryStatus) {
      memoryStatus.textContent = `Loaded ${memoryEntries.length} memory entr${memoryEntries.length === 1 ? 'y' : 'ies'}.`;
      memoryStatus.classList.remove('error');
    }
  } catch (error) {
    if (memoryStatus) {
      memoryStatus.textContent = `Error: ${error.message || 'Unable to load memory entries.'}`;
      memoryStatus.classList.add('error');
    }
  }
}

async function handleCaptureMemory() {
  if (!window.electron?.memory) return;

  const type = String(memoryCaptureTypeInput?.value || 'context').trim() || 'context';
  const content = String(memoryCaptureContentInput?.value || '').trim();
  if (!content) {
    if (memoryStatus) {
      memoryStatus.textContent = 'Capture content is required.';
      memoryStatus.classList.add('error');
    }
    return;
  }

  if (memoryCaptureBtn) memoryCaptureBtn.disabled = true;
  try {
    const result = await window.electron.memory.capture({ type, content });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to capture memory.');
    }

    if (memoryCaptureContentInput) {
      memoryCaptureContentInput.value = '';
    }
    if (memoryStatus) {
      memoryStatus.textContent = 'Memory captured.';
      memoryStatus.classList.remove('error');
    }
    await loadMemoryEntries();
  } catch (error) {
    if (memoryStatus) {
      memoryStatus.textContent = `Error: ${error.message || 'Unable to capture memory.'}`;
      memoryStatus.classList.add('error');
    }
  } finally {
    if (memoryCaptureBtn) memoryCaptureBtn.disabled = false;
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
    if (memoryStatus) {
      memoryStatus.textContent = `Error: ${error.message || 'Unable to delete memory.'}`;
      memoryStatus.classList.add('error');
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
    if (memoryStatus) {
      memoryStatus.textContent = `Error: ${error.message || 'Unable to clear memory.'}`;
      memoryStatus.classList.add('error');
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

    settingsState.hooks = {
      ...(settingsState.hooks || {}),
      loaded: Array.isArray(result.hooks) ? result.hooks : (settingsState.hooks?.loaded || [])
    };

    if (hooksStatus) {
      hooksStatus.textContent = `Hook '${hookName}' ${enabled ? 'enabled' : 'disabled'}.`;
      hooksStatus.classList.remove('error');
    }

    renderSettings();
  } catch (error) {
    if (hooksStatus) {
      hooksStatus.textContent = `Error: ${error.message || 'Unable to update hook.'}`;
      hooksStatus.classList.add('error');
    }
  }
}

async function handleToggleHooksGlobal(enabled) {
  try {
    const result = await window.electron.hooks.setGlobalEnabled({ enabled: Boolean(enabled) });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to update global hook setting.');
    }

    settingsState.hooks = {
      ...(settingsState.hooks || {}),
      enabled: Boolean(result.enabled),
      loaded: Array.isArray(result.hooks) ? result.hooks : (settingsState.hooks?.loaded || [])
    };

    if (hooksStatus) {
      hooksStatus.textContent = `Hooks are now ${result.enabled ? 'enabled' : 'disabled'} globally.`;
      hooksStatus.classList.remove('error');
    }

    renderSettings();
  } catch (error) {
    if (hooksGlobalEnabledInput) {
      hooksGlobalEnabledInput.checked = !Boolean(enabled);
    }

    if (hooksStatus) {
      hooksStatus.textContent = `Error: ${error.message || 'Unable to update hook setting.'}`;
      hooksStatus.classList.add('error');
    }
  }
}

async function handleReloadHooks() {
  if (reloadHooksBtn) reloadHooksBtn.disabled = true;

  if (hooksStatus) {
    hooksStatus.textContent = 'Reloading hooks...';
    hooksStatus.classList.remove('error');
  }

  try {
    const result = await window.electron.hooks.reload();
    settingsState.hooks = {
      ...(settingsState.hooks || {}),
      enabled: result?.enabled !== false,
      loaded: Array.isArray(result?.hooks) ? result.hooks : []
    };
    renderSettings();
  } catch (error) {
    if (hooksStatus) {
      hooksStatus.textContent = `Error: ${error.message || 'Unable to reload hooks.'}`;
      hooksStatus.classList.add('error');
    }
  } finally {
    if (reloadHooksBtn) reloadHooksBtn.disabled = false;
  }
}

function collectTemplateVariablesFromForm() {
  return {
    name: String(templateNameInput?.value || '').trim(),
    role: String(templateRoleInput?.value || '').trim(),
    preferences: String(templatePreferencesInput?.value || '').trim(),
    projectContext: String(templateProjectContextInput?.value || '').trim()
  };
}

async function handleSaveTemplateVariables() {
  if (!saveTemplateVariablesBtn) return;

  saveTemplateVariablesBtn.disabled = true;
  if (templateVariablesStatus) {
    templateVariablesStatus.textContent = 'Saving...';
    templateVariablesStatus.classList.remove('error');
  }

  try {
    const templateVariables = collectTemplateVariablesFromForm();
    const result = await window.electron.settings.saveTemplateVariables({ templateVariables });

    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save template variables.');
    }

    settingsState.templateVariables = {
      ...(result.templateVariables || templateVariables)
    };

    if (templateVariablesStatus) {
      templateVariablesStatus.textContent = 'Template variables saved. New runs use updated values.';
      templateVariablesStatus.classList.remove('error');
    }
  } catch (error) {
    if (templateVariablesStatus) {
      templateVariablesStatus.textContent = `Error: ${error.message || 'Unable to save template variables.'}`;
      templateVariablesStatus.classList.add('error');
    }
  } finally {
    saveTemplateVariablesBtn.disabled = false;
  }
}

function collectUserProfileFromForm() {
  const goals = String(profileGoalsInput?.value || '')
    .split(/\r?\n/)
    .map((goal) => goal.trim())
    .filter(Boolean);

  const rawPreferences = String(profilePreferencesInput?.value || '').trim();
  let preferences = {};
  if (rawPreferences) {
    const parsed = JSON.parse(rawPreferences);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Preferences must be valid JSON object syntax.');
    }
    preferences = parsed;
  }

  return {
    name: String(profileNameInput?.value || '').trim(),
    role: String(profileRoleInput?.value || '').trim(),
    goals,
    preferences,
    projectContext: String(profileProjectContextInput?.value || '').trim()
  };
}

async function handleSaveUserProfile() {
  if (!saveUserProfileBtn) return;

  saveUserProfileBtn.disabled = true;
  if (userProfileStatus) {
    userProfileStatus.textContent = 'Saving...';
    userProfileStatus.classList.remove('error');
  }

  try {
    const profile = collectUserProfileFromForm();
    const result = await window.electron.settings.saveUserProfile({ profile });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save user profile.');
    }

    settingsState.userProfile = {
      ...(result.userProfile || profile)
    };

    if (userProfileStatus) {
      userProfileStatus.textContent = 'User profile saved. New agent runs include it in context.';
      userProfileStatus.classList.remove('error');
    }
  } catch (error) {
    if (userProfileStatus) {
      userProfileStatus.textContent = `Error: ${error.message || 'Unable to save user profile.'}`;
      userProfileStatus.classList.add('error');
    }
  } finally {
    saveUserProfileBtn.disabled = false;
  }
}

function collectNotificationsFromForm() {
  const toastSeconds = Math.max(0, Number(notificationsToastThresholdInput?.value || 30));
  const externalSeconds = Math.max(toastSeconds, Number(notificationsExternalThresholdInput?.value || 120));

  return {
    enabled: Boolean(notificationsEnabledInput?.checked),
    thresholdsMs: {
      toast: Math.round(toastSeconds * 1000),
      external: Math.round(externalSeconds * 1000)
    },
    uiToast: {
      enabled: Boolean(notificationsUiToastEnabledInput?.checked)
    },
    ntfy: {
      enabled: Boolean(notificationsNtfyEnabledInput?.checked),
      topic: String(notificationsNtfyTopicInput?.value || '').trim()
    },
    telegram: {
      longTaskNotice: Boolean(notificationsTelegramLongTaskInput?.checked)
    }
  };
}

async function handleSaveNotifications() {
  if (!saveNotificationsBtn) return;

  saveNotificationsBtn.disabled = true;
  if (notificationsStatus) {
    notificationsStatus.textContent = 'Saving...';
    notificationsStatus.classList.remove('error');
  }

  try {
    const notifications = collectNotificationsFromForm();
    const result = await window.electron.settings.saveNotifications({ notifications });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save notification settings.');
    }

    settingsState.notifications = {
      ...(result.notifications || notifications)
    };

    if (notificationsStatus) {
      notificationsStatus.textContent = 'Notification settings saved.';
      notificationsStatus.classList.remove('error');
    }
  } catch (error) {
    if (notificationsStatus) {
      notificationsStatus.textContent = `Error: ${error.message || 'Unable to save notification settings.'}`;
      notificationsStatus.classList.add('error');
    }
  } finally {
    saveNotificationsBtn.disabled = false;
  }
}

function collectVoiceFromForm() {
  const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    enabled: Boolean(voiceEnabledInput?.checked),
    speakChatResponses: Boolean(voiceSpeakChatInput?.checked),
    speakAgentSummary: Boolean(voiceSpeakAgentSummaryInput?.checked),
    telegramVoiceForLongResponses: Boolean(voiceTelegramLongInput?.checked),
    engine: String(voiceEngineInput?.value || 'system').toLowerCase() === 'elevenlabs' ? 'elevenlabs' : 'system',
    voiceId: String(voiceIdInput?.value || '').trim(),
    speed: toNumber(voiceSpeedInput?.value, 1),
    stability: toNumber(voiceStabilityInput?.value, 0.5),
    style: toNumber(voiceStyleInput?.value, 0.25),
    summaryMaxChars: Math.max(80, Math.round(toNumber(voiceSummaryMaxInput?.value, 260))),
    telegramMinChars: Math.max(80, Math.round(toNumber(voiceTelegramMinInput?.value, 500)))
  };
}

async function handleSaveVoiceSettings() {
  if (!saveVoiceSettingsBtn) return;

  saveVoiceSettingsBtn.disabled = true;
  if (voiceStatus) {
    voiceStatus.textContent = 'Saving voice settings...';
    voiceStatus.classList.remove('error');
  }

  try {
    const voice = collectVoiceFromForm();
    const result = await window.electron.settings.saveVoice({ voice });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save voice settings.');
    }

    settingsState.voice = {
      ...(settingsState.voice || {}),
      ...(result.voice || voice)
    };

    if (voiceStatus) {
      voiceStatus.textContent = 'Voice settings saved.';
      voiceStatus.classList.remove('error');
    }
  } catch (error) {
    if (voiceStatus) {
      voiceStatus.textContent = `Error: ${error.message || 'Unable to save voice settings.'}`;
      voiceStatus.classList.add('error');
    }
  } finally {
    saveVoiceSettingsBtn.disabled = false;
  }
}

async function handleSaveElevenLabsKey() {
  if (!saveVoiceKeyBtn) return;

  const apiKey = String(voiceElevenLabsKeyInput?.value || '').trim();
  if (!apiKey) {
    if (voiceStatus) {
      voiceStatus.textContent = 'Enter an ElevenLabs API key first.';
      voiceStatus.classList.add('error');
    }
    return;
  }

  saveVoiceKeyBtn.disabled = true;
  try {
    const result = await window.electron.settings.saveElevenLabsKey({ apiKey });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to save ElevenLabs key.');
    }

    settingsState.voice = {
      ...(settingsState.voice || {}),
      hasElevenLabsKey: Boolean(result.hasElevenLabsKey)
    };

    if (voiceElevenLabsKeyInput) {
      voiceElevenLabsKeyInput.value = '';
    }

    if (voiceStatus) {
      voiceStatus.textContent = 'ElevenLabs API key saved securely.';
      voiceStatus.classList.remove('error');
    }
  } catch (error) {
    if (voiceStatus) {
      voiceStatus.textContent = `Error: ${error.message || 'Unable to save ElevenLabs key.'}`;
      voiceStatus.classList.add('error');
    }
  } finally {
    saveVoiceKeyBtn.disabled = false;
  }
}

async function handleClearElevenLabsKey() {
  if (!clearVoiceKeyBtn) return;
  const confirmed = confirm('Clear the saved ElevenLabs API key?');
  if (!confirmed) return;

  clearVoiceKeyBtn.disabled = true;
  try {
    const result = await window.electron.settings.saveElevenLabsKey({ clear: true });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unable to clear ElevenLabs key.');
    }

    settingsState.voice = {
      ...(settingsState.voice || {}),
      hasElevenLabsKey: Boolean(result.hasElevenLabsKey)
    };

    if (voiceStatus) {
      voiceStatus.textContent = 'ElevenLabs API key removed.';
      voiceStatus.classList.remove('error');
    }
  } catch (error) {
    if (voiceStatus) {
      voiceStatus.textContent = `Error: ${error.message || 'Unable to clear ElevenLabs key.'}`;
      voiceStatus.classList.add('error');
    }
  } finally {
    clearVoiceKeyBtn.disabled = false;
  }
}

async function handleTestVoice() {
  if (!testVoiceBtn) return;

  testVoiceBtn.disabled = true;
  if (voiceStatus) {
    voiceStatus.textContent = 'Testing voice connection...';
    voiceStatus.classList.remove('error');
  }

  try {
    const settings = collectVoiceFromForm();
    const result = await window.electron.settings.testVoice({ settings });
    if (!result?.ok) {
      throw new Error(result?.error || 'Voice connection failed.');
    }

    if (voiceStatus) {
      voiceStatus.textContent = 'Voice connection test successful.';
      voiceStatus.classList.remove('error');
    }
  } catch (error) {
    if (voiceStatus) {
      voiceStatus.textContent = `Error: ${error.message || 'Voice connection failed.'}`;
      voiceStatus.classList.add('error');
    }
  } finally {
    testVoiceBtn.disabled = false;
  }
}

async function loadSettings() {
  try {
    settingsState = await window.electron.settings.load();
    if (!settingsState.providers || Object.keys(settingsState.providers).length === 0) {
      setProviderListFallback('No providers returned from settings. Please restart the app.');
      return;
    }
    renderSettings();
    await loadMemoryEntries();
  } catch (error) {
    setProviderListFallback(`Unable to load provider settings: ${error.message || 'Unknown error'}`);
  }
}

function setProviderListFallback(message) {
  providerList.innerHTML = '';
  const fallback = document.createElement('div');
  fallback.className = 'provider-message error';
  fallback.textContent = message;
  providerList.appendChild(fallback);
}

function getTokenInput(providerKey) {
  return providerList.querySelector(`input[data-provider="${providerKey}"]`);
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
  const card = providerList.querySelector(`.provider-card[data-provider="${providerKey}"]`);
  if (!card) return;
  const messageEl = card.querySelector('.provider-message');
  if (!messageEl) return;
  messageEl.textContent = message;
  messageEl.classList.toggle('error', isError);
}

function updateProviderStatus(providerKey, status) {
  settingsState.providers[providerKey] = {
    ...settingsState.providers[providerKey],
    status
  };
  renderSettings();
}

function closeContextMenu() {
  chatContextMenu.hidden = true;
  contextChatId = null;
}

function openContextMenu({ chatId, x, y }) {
  contextChatId = chatId;
  chatContextMenu.hidden = false;

  const menuRect = chatContextMenu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 8;
  const maxY = window.innerHeight - menuRect.height - 8;

  chatContextMenu.style.left = `${Math.min(x, maxX)}px`;
  chatContextMenu.style.top = `${Math.min(y, maxY)}px`;
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
    cancelBtn.textContent = 'Cancel';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save';

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
  const message = userInput.value.trim();

  if (message === '') {
    return;
  }

  const command = message.toLowerCase();
  if (command === 'exit' || command === 'quit') {
    userInput.value = '';
    userInput.style.height = 'auto';
    await window.electron.app.quitWindow();
    return;
  }

  if (!activeChatId) {
    const newChat = await window.electron.chat.create('New Chat');
    if (!newChat) {
      return;
    }
    chats = [newChat, ...chats.filter((chat) => chat.id !== newChat.id)];
    activeChatId = newChat.id;
  }

  const slashCommand = parseSlashCommand(message);
  if (slashCommand?.name === '/help') {
    userInput.value = '';
    userInput.style.height = 'auto';

    const helpText = await getLocalHelpText();
    appendLocalMessage('user', message);
    appendLocalMessage('assistant', helpText);

    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: helpText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    return;
  }

  if (slashCommand?.name === '/agent') {
    userInput.value = '';
    userInput.style.height = 'auto';

    const modeArg = (slashCommand.args[0] || 'toggle').toLowerCase();
    if (modeArg === 'on') {
      isAgentModeEnabled = true;
    } else if (modeArg === 'off') {
      isAgentModeEnabled = false;
    } else if (modeArg === 'toggle') {
      isAgentModeEnabled = !isAgentModeEnabled;
    } else if (modeArg !== 'status') {
      const helpText = 'Usage: `/agent on`, `/agent off`, `/agent toggle`, or `/agent status`.';
      appendLocalMessage('user', message);
      appendLocalMessage('assistant', helpText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: helpText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      return;
    }

    renderAgentModeButton();
    const statusText = modeArg === 'status'
      ? `Agent mode is currently **${isAgentModeEnabled ? 'ON' : 'OFF'}**.`
      : `Agent mode is now **${isAgentModeEnabled ? 'ON' : 'OFF'}**.`;

    appendLocalMessage('user', message);
    appendLocalMessage('assistant', statusText);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: statusText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    return;
  }

  if (slashCommand?.name === '/profile') {
    userInput.value = '';
    userInput.style.height = 'auto';

    const action = (slashCommand.args[0] || '').toLowerCase();
    if (!action) {
      appendLocalMessage('user', message);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

      const summary = formatProfileSummary(settingsState.userProfile || {});
      appendLocalMessage('assistant', summary);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: summary }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      return;
    }

    if (action !== 'set') {
      const usage = 'Usage: `/profile` or `/profile set <field> <value>`. Fields: name, role, projectContext, goals, preferences';
      appendLocalMessage('user', message);
      appendLocalMessage('assistant', usage);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: usage }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      return;
    }

    const fieldRaw = slashCommand.args[1] || '';
    const field = fieldRaw.toLowerCase();
    const rawValue = slashCommand.args.slice(2).join(' ').trim();
    const profile = {
      ...(settingsState.userProfile || {})
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
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    }

    return;
  }

  if (['/fast', '/standard', '/smart'].includes(slashCommand?.name)) {
    userInput.value = '';
    userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    const tier = slashCommand.name.slice(1);
    try {
      const result = await window.electron.settings.setInferenceTier({ tier });
      const responseText = result?.ok
        ? `Inference tier is now **${formatInferenceTierLabel(tier)}**.`
        : `❌ ${result?.error || 'Unable to update inference tier.'}`;

      if (result?.ok && result?.inference) {
        settingsState.inference = result.inference;
        refreshUI();
      }

      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    } catch (error) {
      const errorText = `❌ ${error.message || 'Unable to update inference tier.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    }

    return;
  }

  if (slashCommand?.name === '/pin') {
    userInput.value = '';
    userInput.style.height = 'auto';
    const skillId = slashCommand.args[0];
    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    if (!skillId) {
      const errorText = 'Usage: `/pin <skill-id>`. Use `/pin std` to pin the STD skill.';
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      return;
    }
    const result = await window.electron.skill.pin({ chatId: activeChatId, skillId });
    const responseText = result.ok
      ? `📌 Pinned **${result.name || skillId}** to this chat. All messages will be handled by this skill. Use \`/unpin\` to restore normal behavior.`
      : `❌ ${result.error}`;
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    return;
  }

  if (slashCommand?.name === '/unpin') {
    userInput.value = '';
    userInput.style.height = 'auto';
    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    const result = await window.electron.skill.unpin({ chatId: activeChatId });
    const responseText = result.ok ? '📌 Unpinned. Normal behavior restored.' : `❌ ${result.error}`;
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    return;
  }

  if (slashCommand?.name === '/pinned') {
    userInput.value = '';
    userInput.style.height = 'auto';
    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    const result = await window.electron.skill.getPinned({ chatId: activeChatId });
    const responseText = result.pinned
      ? `📌 Pinned skill: **${result.pinned.name || result.pinned.skillId}** (\`${result.pinned.skillId}\`)`
      : 'No skill is currently pinned to this chat.';
    appendLocalMessage('assistant', responseText);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    return;
  }

  if (slashCommand?.name === '/skill') {
    userInput.value = '';
    userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    const action = (slashCommand.args[0] || '').toLowerCase();
    const skillId = (slashCommand.args[1] || '').trim();

    if (action !== 'customize' || !skillId) {
      const usage = 'Usage: `/skill customize <skill-id>`. Example: `/skill customize std`';
      appendLocalMessage('assistant', usage);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: usage }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
      return;
    }

    try {
      const result = await window.electron.skill.customize({ skillId });
      const responseText = result?.ok
        ? `Opened customization file for **${result.skillId}** at:\n\`${result.path}\`${result.created ? '\n\nCreated a new file with starter defaults.' : ''}`
        : `❌ ${result?.error || 'Unable to open customization file.'}`;
      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    } catch (error) {
      const errorText = `❌ ${error.message || 'Unable to open customization file.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    }

    return;
  }

  if (slashCommand?.name === '/llm') {
    userInput.value = '';
    userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    try {
      const result = await window.electron.settings.runLlmCommand({ command: message });
      const responseText = result?.ok
        ? (result.output || 'Command completed.')
        : `Error: ${result?.error || 'Unable to run local LLM command.'}`;

      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    } catch (error) {
      const errorText = `Error: ${error.message || 'Unable to run local LLM command.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    }

    return;
  }

  if (slashCommand?.name === '/speak') {
    userInput.value = '';
    userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    try {
      const summaryMode = ['summary', '--summary', '-s'].some((token) =>
        slashCommand.args.map((arg) => String(arg || '').toLowerCase()).includes(token)
      );
      const result = await window.electron.chat.speakLast({
        chatId: activeChatId,
        summary: summaryMode
      });

      const responseText = result?.ok
        ? `🔊 Speaking the last assistant response${summaryMode ? ' (summary)' : ''}.`
        : `❌ ${result?.error || 'Unable to speak the last response.'}`;
      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
    } catch (error) {
      const errorText = `❌ ${error.message || 'Unable to speak the last response.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
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
        chatId: activeChatId
      });

      if (skillResult && !skillResult.error?.startsWith('Unknown skill command:')) {
        userInput.value = '';
        userInput.style.height = 'auto';

        appendLocalMessage('user', message);
        window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

        const responseText = skillResult.ok === false
          ? `❌ ${skillResult.error || 'Skill command failed.'}`
          : (skillResult.message || 'Skill command executed.');
        const responseFormat = skillResult.format || 'markdown';
        appendLocalMessage('assistant', responseText, { format: responseFormat });
        window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText, format: responseFormat }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

        return;
      }
    } catch (error) {
      // Skill command failed or doesn't exist - continue to LLM
      console.log('[renderer] Skill command not found, sending to LLM:', commandName);
    }
  }

  const now = new Date().toISOString();
  chats = chats.map((chat) => {
    if (chat.id !== activeChatId) return chat;
    return {
      ...chat,
      updatedAt: now,
      messages: [
        ...chat.messages,
        {
          id: `temp-${Date.now()}`,
          sender: 'user',
          text: message,
          timestamp: now
        }
      ]
    };
  });
  refreshUI();

  userInput.value = '';
  userInput.style.height = 'auto';

  try {
    const pinnedInfo = await window.electron.skill.getPinned({ chatId: activeChatId });
    if (pinnedInfo?.pinned) {
      const skillResult = await window.electron.skill.handleMessage({
        chatId: activeChatId,
        message
      });

      if (skillResult && !skillResult.continueWithAgent) {
        const responseText = skillResult.ok
          ? (skillResult.message || 'Done.')
          : `❌ ${skillResult.error || 'Error'}`;
        const responseFormat = skillResult.format || 'markdown';
        window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
        appendLocalMessage('assistant', responseText, { format: responseFormat });
        window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText, format: responseFormat }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
        return;
      }
    }

    const updatedChat = await window.electron.chat.sendMessage({
      chatId: activeChatId,
      message,
      agentMode: isAgentModeEnabled
    });

    if (updatedChat) {
      chats = chats.map((chat) => (chat.id === updatedChat.id ? updatedChat : chat));
      refreshUI();
    }
  } catch (error) {
    addMessage('assistant', `Error: ${error.message || 'Unable to send message.'}`);
  }
}

async function handleStdCardAction(action, taskId, buttonEl = null) {
  if (action !== 'complete' || !taskId || !activeChatId) {
    return;
  }

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Completing...';
  }

  const commandText = `/std complete ${taskId}`;

  try {
    appendLocalMessage('user', commandText);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: commandText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));

    const skillResult = await window.electron.skill.execute({
      command: 'std',
      args: ['complete', String(taskId)],
      chatId: activeChatId
    });

    const responseText = skillResult?.ok === false
      ? `❌ ${skillResult.error || 'Skill command failed.'}`
      : (skillResult?.message || 'Task completed.');
    const responseFormat = skillResult?.format || 'markdown';

    appendLocalMessage('assistant', responseText, { format: responseFormat });
    window.electron.chat
      .addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText, format: responseFormat })
      .catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
  } catch (error) {
    const errorText = `❌ ${error.message || 'Unable to complete task.'}`;
    appendLocalMessage('assistant', errorText);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: errorText }).catch((err) => console.warn('[chat] addMessage persistence failed:', err.message));
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
    messageContent.innerHTML = String(text || '');
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

  if (sender === 'assistant' && metadata?.llm?.totals) {
    const callTotals = metadata.llm.totals;
    const runningTotals = metadata.runningLlmTotals;
    const metricsDiv = document.createElement('div');
    metricsDiv.className = 'message-metrics';

    const callSpan = document.createElement('span');
    callSpan.className = 'message-metrics-call';
    callSpan.textContent = `Call: in ${formatTokenCount(callTotals.inputTokens)} - out ${formatTokenCount(callTotals.outputTokens)} - total ${formatTokenCount(callTotals.totalTokens)} • ${formatUsd(callTotals.costUsd)}`;

    if (runningTotals) {
      callSpan.textContent += ` Running: ${formatTokenCount(runningTotals.totalTokens)} tokens - ${formatUsd(runningTotals.costUsd)}`;
    }
  
    metricsDiv.appendChild(callSpan);

    messageContent.appendChild(metricsDiv);
  }

  messageDiv.appendChild(messageContent);
  
  chatMessages.appendChild(messageDiv);
  
  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function loadChats() {
  const data = await window.electron.chat.load();
  chats = data.chats || [];
  activeChatId = data.activeChatId || chats[0]?.id || null;
  refreshUI();
}

async function handleCreateChat() {
  const newChat = await window.electron.chat.create('New Chat');
  if (newChat) {
    chats = [newChat, ...chats.filter((chat) => chat.id !== newChat.id)];
    activeChatId = newChat.id;
    refreshUI();
  }
}

async function handleSelectChat(chatId) {
  activeChatId = chatId;
  await window.electron.chat.setActive(chatId);
  refreshUI();
}

async function handleRenameChat(chatId) {
  const chat = chats.find((item) => item.id === chatId);
  if (!chat) {
    return;
  }
  const title = await showRenameDialog(chat.title);
  if (!title || title.trim() === '' || title.trim() === chat.title) {
    return;
  }
  const updated = await window.electron.chat.rename({ id: chatId, title: title.trim() });
  if (updated) {
    chats = chats.map((item) => (item.id === updated.id ? updated : item));
    refreshUI();
  }
}

async function handleDeleteChat(chatId) {
  const chat = chats.find((item) => item.id === chatId);
  if (!chat) {
    return;
  }
  const confirmed = confirm(`Delete "${chat.title}"? This cannot be undone.`);
  if (!confirmed) {
    return;
  }
  const result = await window.electron.chat.remove(chatId);
  chats = result.chats || [];
  activeChatId = result.activeChatId || chats[0]?.id || null;
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
  settingsState.providers[providerKey].hasToken = result.hasToken;
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

  settingsState.providers[providerKey].hasToken = false;
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
  const input = providerList.querySelector(`input[data-model-provider="${providerKey}"]`);
  const model = input?.value?.trim() || '';
  const result = await window.electron.settings.setProviderModel({
    provider: providerKey,
    model
  });

  if (!result.ok) {
    setProviderMessage(providerKey, result.error || 'Unable to save model.', true);
    return;
  }

  settingsState.providers[providerKey].model = result.model;
  setProviderMessage(providerKey, `Model saved: ${result.model || '(default)'}`);
  renderSettings();
}

async function handleSetActiveProvider(providerKey) {
  const result = await window.electron.settings.setActiveProvider({ provider: providerKey });
  if (!result.ok) {
    setProviderMessage(providerKey, result.error || 'Unable to set active provider.', true);
    return;
  }

  settingsState.activeProvider = result.activeProvider;
  renderSettings();
}

// Event Listeners
sendBtn.addEventListener('click', sendMessage);

userInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea as user types
userInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 200) + 'px';
});

// New chat button
newChatBtn.addEventListener('click', handleCreateChat);
if (newChatBtnCompact) {
  newChatBtnCompact.addEventListener('click', handleCreateChat);
}

// Chat history item click handler
chatList.addEventListener('click', (e) => {
  if (!chatContextMenu.hidden && !e.target.closest('#chat-context-menu')) {
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

chatMessages.addEventListener('click', (e) => {
  const actionButton = e.target.closest('[data-std-action]');
  if (!actionButton) return;

  const action = String(actionButton.dataset.stdAction || '').trim().toLowerCase();
  const taskId = String(actionButton.dataset.stdTaskId || '').trim();

  if (!action || !taskId) return;

  e.preventDefault();
  handleStdCardAction(action, taskId, actionButton);
});

chatList.addEventListener('contextmenu', (e) => {
  const chatItem = e.target.closest('.chat-item');
  if (!chatItem) {
    return;
  }
  e.preventDefault();
  openContextMenu({ chatId: chatItem.dataset.chatId, x: e.clientX, y: e.clientY });
});

chatContextMenu.addEventListener('click', (e) => {
  const actionButton = e.target.closest('.context-menu-item');
  if (!actionButton) {
    return;
  }
  if (actionButton.dataset.action === 'delete' && contextChatId) {
    handleDeleteChat(contextChatId);
  }
  closeContextMenu();
});

document.addEventListener('click', (e) => {
  if (!chatContextMenu.hidden && !e.target.closest('#chat-context-menu')) {
    closeContextMenu();
  }
});

if (openSettingsBtn) {
  openSettingsBtn.addEventListener('click', openSettingsDrawer);
}

if (floatingSettingsBtn) {
  floatingSettingsBtn.addEventListener('click', openSettingsDrawer);
}

if (composerSettingsBtn) {
  composerSettingsBtn.addEventListener('click', openSettingsDrawer);
}

if (agentModeBtn) {
  agentModeBtn.addEventListener('click', () => {
    isAgentModeEnabled = !isAgentModeEnabled;
    renderAgentModeButton();
    addToolEventMessage(
      `Agent mode ${isAgentModeEnabled ? 'enabled' : 'disabled'}`,
      {
        mode: isAgentModeEnabled ? 'agent' : 'standard'
      },
      isAgentModeEnabled ? 'success' : ''
    );
  });
}

if (toggleHistoryBtn) {
  toggleHistoryBtn.addEventListener('click', () => {
    setHistoryCollapsed(!isHistoryCollapsed);
  });
}

if (closeSettingsBtn) {
  closeSettingsBtn.addEventListener('click', () => {
    setSettingsDrawer(false);
  });
}

settingsDrawer.addEventListener('click', (e) => {
  if (e.target === settingsDrawer) {
    setSettingsDrawer(false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsDrawer.hidden) {
    setSettingsDrawer(false);
  }
});

if (providerList) {
  providerList.addEventListener('click', (e) => {
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
    if (action === 'save-model') {
      handleSaveProviderModel(provider);
    }
    if (action === 'set-active') {
      handleSetActiveProvider(provider);
    }
  });
}

if (saveTemplateVariablesBtn) {
  saveTemplateVariablesBtn.addEventListener('click', () => {
    handleSaveTemplateVariables();
  });
}

if (saveUserProfileBtn) {
  saveUserProfileBtn.addEventListener('click', () => {
    handleSaveUserProfile();
  });
}

if (saveNotificationsBtn) {
  saveNotificationsBtn.addEventListener('click', () => {
    handleSaveNotifications();
  });
}

if (saveVoiceSettingsBtn) {
  saveVoiceSettingsBtn.addEventListener('click', () => {
    handleSaveVoiceSettings();
  });
}

if (saveVoiceKeyBtn) {
  saveVoiceKeyBtn.addEventListener('click', () => {
    handleSaveElevenLabsKey();
  });
}

if (clearVoiceKeyBtn) {
  clearVoiceKeyBtn.addEventListener('click', () => {
    handleClearElevenLabsKey();
  });
}

if (testVoiceBtn) {
  testVoiceBtn.addEventListener('click', () => {
    handleTestVoice();
  });
}

if (reloadHooksBtn) {
  reloadHooksBtn.addEventListener('click', () => {
    handleReloadHooks();
  });
}

if (hooksGlobalEnabledInput) {
  hooksGlobalEnabledInput.addEventListener('change', (event) => {
    handleToggleHooksGlobal(Boolean(event?.target?.checked));
  });
}

if (hooksList) {
  hooksList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="toggle-hook"]');
    if (!button) return;

    const hookName = String(button.dataset.hookName || '').trim();
    const enabled = String(button.dataset.nextEnabled || '').toLowerCase() === 'true';
    handleToggleHook(hookName, enabled);
  });
}

if (memoryRefreshBtn) {
  memoryRefreshBtn.addEventListener('click', () => {
    loadMemoryEntries();
  });
}

if (memoryCaptureBtn) {
  memoryCaptureBtn.addEventListener('click', () => {
    handleCaptureMemory();
  });
}

if (memoryClearBtn) {
  memoryClearBtn.addEventListener('click', () => {
    handleClearMemory();
  });
}

if (memoryList) {
  memoryList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="delete-memory"]');
    if (!button) return;
    const memoryId = String(button.dataset.memoryId || '').trim();
    if (!memoryId) return;
    handleDeleteMemory(memoryId);
  });
}

if (memoryQueryInput) {
  memoryQueryInput.addEventListener('input', () => {
    loadMemoryEntries();
  });
}

if (memoryTierFilterInput) {
  memoryTierFilterInput.addEventListener('change', () => {
    loadMemoryEntries();
  });
}

window.addEventListener('blur', () => {
  if (!chatContextMenu.hidden) {
    closeContextMenu();
  }
});

window.electron.chat.onMessageStart(({ chatId, responseId }) => {
  if (chatId !== activeChatId) return;

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant streaming';
  messageDiv.dataset.responseId = responseId;

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';
  messageContent.innerHTML = '<p>...</p>';

  messageDiv.appendChild(messageContent);
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  streamBufferById.set(responseId, '');
});

window.electron.chat.onMessageChunk(({ chatId, responseId, chunk }) => {
  if (chatId !== activeChatId) return;

  const existing = streamBufferById.get(responseId) || '';
  const next = existing + (chunk || '');
  streamBufferById.set(responseId, next);

  const streamElement = chatMessages.querySelector(`[data-response-id="${responseId}"] .message-content`);
  if (!streamElement) return;

  streamElement.innerHTML = window.electron.markdown.parse(next);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

window.electron.chat.onMessageComplete(({ chatId, responseId }) => {
  if (chatId !== activeChatId) return;
  const messageDiv = chatMessages.querySelector(`[data-response-id="${responseId}"]`);
  if (messageDiv) {
    messageDiv.classList.remove('streaming');
  }
  streamBufferById.delete(responseId);
});

window.electron.chat.onMessageError(({ chatId, responseId, error }) => {
  if (chatId !== activeChatId) return;
  const messageDiv = chatMessages.querySelector(`[data-response-id="${responseId}"] .message-content`);
  if (messageDiv) {
    messageDiv.innerHTML = `<p>Error: ${error}</p>`;
  }
  streamBufferById.delete(responseId);
});

window.electron.chat.onToolUse(({ chatId, toolName, parameters }) => {
  if (chatId !== activeChatId) return;
  addToolEventMessage(`Using tool: ${toolName}`, parameters);
});

window.electron.chat.onToolResult(({ chatId, toolName, result }) => {
  if (chatId !== activeChatId) return;
  addToolEventMessage(`Tool result: ${toolName}`, result, result?.success === false ? 'error' : 'success');
});

window.electron.tool.onApprovalRequired(({ approvalId, toolName, parameters }) => {
  showToolApprovalDialog(approvalId, toolName, parameters);
});

// Listen for chat updates from Telegram bridge or other sources
window.electron.chat.onChatUpdated(async () => {
  await loadChats();
});

loadChats();
loadSettings();
renderAgentModeButton();
renderHistoryToggleButton();
