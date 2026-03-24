const appState = {
  chats: [],
  activeChatId: null,
  contextChatId: null,
  isAgentModeEnabled: false,
  isHistoryCollapsed: false,
  memoryEntries: [],
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
  sendBtn: document.getElementById('send-btn'),
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
};

const unsubscribeHandlers = [];

function resetAppState() {
  appState.chats = [];
  appState.activeChatId = null;
  appState.contextChatId = null;
  appState.isAgentModeEnabled = false;
  appState.isHistoryCollapsed = false;
  appState.memoryEntries = [];
  appState.streamBuffers.clear();
  appState.settings = {
    encryptionAvailable: true,
    providers: {},
    activeProvider: 'openai',
    inference: { activeTier: 'standard' },
    templateVariables: { name: '', role: '', preferences: '', projectContext: '' },
    userProfile: { name: '', role: '', goals: [], preferences: {}, projectContext: '' },
    notifications: { enabled: true, thresholdsMs: { toast: 30000, external: 120000 }, uiToast: { enabled: true }, ntfy: { enabled: false, topic: '' }, telegram: { longTaskNotice: true } },
    voice: { enabled: false, engine: 'system', voiceId: '', speed: 1, stability: 0.5, style: 0.25, speakAgentSummary: true, speakChatResponses: false, telegramVoiceForLongResponses: false, telegramMinChars: 500, summaryMaxChars: 260, hasElevenLabsKey: false },
    hooks: { enabled: true, loaded: [] }
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
  dom.toggleHistoryBtn.textContent = appState.isHistoryCollapsed ? '▶' : '◀';
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
  dom.chatMessages.appendChild(messageDiv);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
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
  denyBtn.className = 'danger';
  denyBtn.textContent = 'Deny';

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'primary';
  approveBtn.textContent = 'Approve';

  denyBtn.addEventListener('click', () => {
    window.electron.tool.respondToApproval(approvalId, false, { alwaysApprove: false });
    modal.remove();
  }, { once: true });

  approveBtn.addEventListener('click', () => {
    window.electron.tool.respondToApproval(approvalId, true, {
      alwaysApprove: Boolean(alwaysApproveInput.checked)
    });
    modal.remove();
  }, { once: true });

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
  return appState.chats.find((chat) => chat.id === appState.activeChatId);
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
    chatItem.className = `chat-item ${chat.id === appState.activeChatId ? 'active' : ''}`;
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

    dom.chatList.appendChild(chatItem);
  });
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

  if (!activeChat) {
    dom.chatHeaderTitle.textContent = 'King Louie Chat';
    dom.chatHeaderMeta.textContent = `Start a new conversation • Tier: ${formatInferenceTierLabel(getActiveInferenceTier())}`;
    return;
  }

  dom.chatHeaderTitle.textContent = activeChat.title;
  const chatTotals = activeChat.llmTotals || sumChatLlmTotals(activeChat);
  dom.chatHeaderMeta.textContent = `Updated ${formatTimestamp(activeChat.updatedAt)} • Total ${formatTokenCount(chatTotals.totalTokens)} tokens • ${formatUsd(chatTotals.costUsd)} • Tier: ${formatInferenceTierLabel(getActiveInferenceTier())}`;

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
  dom.settingsDrawer.hidden = !open;
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
  activeBtn.textContent = appState.settings.activeProvider === providerKey ? 'Active Provider' : 'Set Active';
  activeBtn.disabled = appState.settings.activeProvider === providerKey;
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
    deleteBtn.className = 'danger';
    deleteBtn.dataset.action = 'delete-memory';
    deleteBtn.dataset.memoryId = entry.id;
    deleteBtn.textContent = 'Delete';

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

async function loadSettings() {
  try {
    appState.settings = unwrapIpcResult(await window.electron.settings.load(), 'Unable to load settings.');
    if (!appState.settings.providers || Object.keys(appState.settings.providers).length === 0) {
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
  const message = dom.userInput.value.trim();

  if (message === '') {
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
          timestamp: now
        }
      ]
    };
  });
  refreshUI();

  dom.userInput.value = '';
  dom.userInput.style.height = 'auto';

  try {
    const pinnedInfo = await window.electron.skill.getPinned({ chatId: appState.activeChatId });
    if (pinnedInfo?.pinned) {
      const skillResult = await window.electron.skill.handleMessage({
        chatId: appState.activeChatId,
        message
      });

      if (skillResult && !skillResult.continueWithAgent) {
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

    const updatedChat = await window.electron.chat.sendMessage({
      chatId: appState.activeChatId,
      message,
      agentMode: appState.isAgentModeEnabled
    });

    if (updatedChat) {
      appState.chats = appState.chats.map((chat) => (chat.id === updatedChat.id ? updatedChat : chat));
      refreshUI();
    }
  } catch (error) {
    addMessage('assistant', `Error: ${error.message || 'Unable to send message.'}`);
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
  refreshUI();
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
  appState.activeChatId = chatId;
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
  const updated = await window.electron.chat.rename({ id: chatId, title: title.trim() });
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
  const input = dom.providerList.querySelector(`input[data-model-provider="${providerKey}"]`);
  const model = input?.value?.trim() || '';
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

dom.userInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea as user types
dom.userInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 200) + 'px';
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
    renderAgentModeButton();
    addToolEventMessage(
      `Agent mode ${appState.isAgentModeEnabled ? 'enabled' : 'disabled'}`,
      {
        mode: appState.isAgentModeEnabled ? 'agent' : 'standard'
      },
      appState.isAgentModeEnabled ? 'success' : ''
    );
  });
}

if (dom.toggleHistoryBtn) {
  dom.toggleHistoryBtn.addEventListener('click', () => {
    setHistoryCollapsed(!appState.isHistoryCollapsed);
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
  if (e.key === 'Escape' && !dom.settingsDrawer.hidden) {
    setSettingsDrawer(false);
  }
});

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
    if (action === 'save-model') {
      handleSaveProviderModel(provider);
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

window.addEventListener('blur', () => {
  if (!dom.chatContextMenu.hidden) {
    closeContextMenu();
  }
});

unsubscribeHandlers.push(window.electron.chat.onMessageStart(({ chatId, responseId }) => {
  if (chatId !== appState.activeChatId) return;

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant streaming';
  messageDiv.dataset.responseId = responseId;

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';
  const pending = document.createElement('p');
  pending.textContent = '...';
  messageContent.textContent = '';
  messageContent.appendChild(pending);

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

  streamElement.innerHTML = window.electron.markdown.parse(next);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}));

unsubscribeHandlers.push(window.electron.chat.onMessageComplete(({ chatId, responseId }) => {
  appState.streamBuffers.delete(responseId);
  if (chatId !== appState.activeChatId) return;
  const messageDiv = dom.chatMessages.querySelector(`[data-response-id="${responseId}"]`);
  if (messageDiv) {
    messageDiv.classList.remove('streaming');
  }
}));

unsubscribeHandlers.push(window.electron.chat.onMessageError(({ chatId, responseId, error }) => {
  appState.streamBuffers.delete(responseId);
  if (chatId !== appState.activeChatId) return;
  const messageDiv = dom.chatMessages.querySelector(`[data-response-id="${responseId}"] .message-content`);
  if (messageDiv) {
    const p = document.createElement('p');
    p.textContent = `Error: ${error}`;
    messageDiv.textContent = '';
    messageDiv.appendChild(p);
  }
}));

unsubscribeHandlers.push(window.electron.chat.onToolUse(({ chatId, toolName, parameters }) => {
  if (chatId !== appState.activeChatId) return;
  addToolEventMessage(`Using tool: ${toolName}`, parameters);
}));

unsubscribeHandlers.push(window.electron.chat.onToolResult(({ chatId, toolName, result }) => {
  if (chatId !== appState.activeChatId) return;
  addToolEventMessage(`Tool result: ${toolName}`, result, result?.success === false ? 'error' : 'success');
}));

unsubscribeHandlers.push(window.electron.tool.onApprovalRequired(({ approvalId, toolName, parameters }) => {
  showToolApprovalDialog(approvalId, toolName, parameters);
}));

// Listen for chat updates from Telegram bridge or other sources
unsubscribeHandlers.push(window.electron.chat.onChatUpdated(async () => {
  await loadChats();
}));

window.addEventListener('beforeunload', () => {
  appState.streamBuffers.clear();
  while (unsubscribeHandlers.length > 0) {
    const unsubscribe = unsubscribeHandlers.pop();
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  }
});

loadChats();
loadSettings();
renderAgentModeButton();
renderHistoryToggleButton();
