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

let chats = [];
let activeChatId = null;
let contextChatId = null;
let settingsState = { encryptionAvailable: true, providers: {}, activeProvider: 'openai' };
const streamBufferById = new Map();
let isAgentModeEnabled = false;
let isHistoryCollapsed = false;

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
    '- `/agent on|off|toggle|status` — control agent mode',
    '- `/pin <skill-id>` — pin a skill to this chat (all messages handled by the skill)',
    '- `/unpin` — unpin current skill, restore normal behavior',
    '- `/pinned` — show which skill (if any) is pinned to this chat',
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

function appendLocalMessage(sender, text) {
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
          timestamp: now
        }
      ]
    };
  });
  refreshUI();
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
    chatHeaderMeta.textContent = 'Start a new conversation';
    return;
  }

  chatHeaderTitle.textContent = activeChat.title;
  const chatTotals = activeChat.llmTotals || sumChatLlmTotals(activeChat);
  chatHeaderMeta.textContent = `Updated ${formatTimestamp(activeChat.updatedAt)} • Total ${formatTokenCount(chatTotals.totalTokens)} tokens • ${formatUsd(chatTotals.costUsd)}`;

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
      runningLlmTotals: callTotals ? { ...runningTotals } : null
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
  providerList.innerHTML = '';
  Object.entries(settingsState.providers).forEach(([key, provider]) => {
    providerList.appendChild(renderProviderCard(key, provider));
  });
}

async function loadSettings() {
  try {
    settingsState = await window.electron.settings.load();
    if (!settingsState.providers || Object.keys(settingsState.providers).length === 0) {
      setProviderListFallback('No providers returned from settings. Please restart the app.');
      return;
    }
    renderSettings();
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

    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch(() => {});
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: helpText }).catch(() => {});

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
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch(() => {});
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: helpText }).catch(() => {});
      return;
    }

    renderAgentModeButton();
    const statusText = modeArg === 'status'
      ? `Agent mode is currently **${isAgentModeEnabled ? 'ON' : 'OFF'}**.`
      : `Agent mode is now **${isAgentModeEnabled ? 'ON' : 'OFF'}**.`;

    appendLocalMessage('user', message);
    appendLocalMessage('assistant', statusText);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch(() => {});
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: statusText }).catch(() => {});

    return;
  }

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

  if (slashCommand?.name === '/llm') {
    userInput.value = '';
    userInput.style.height = 'auto';

    appendLocalMessage('user', message);
    window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch(() => {});

    try {
      const result = await window.electron.settings.runLlmCommand({ command: message });
      const responseText = result?.ok
        ? (result.output || 'Command completed.')
        : `Error: ${result?.error || 'Unable to run local LLM command.'}`;

      appendLocalMessage('assistant', responseText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch(() => {});
    } catch (error) {
      const errorText = `Error: ${error.message || 'Unable to run local LLM command.'}`;
      appendLocalMessage('assistant', errorText);
      window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: errorText }).catch(() => {});
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

      if (skillResult && skillResult.ok !== false) {
        userInput.value = '';
        userInput.style.height = 'auto';

        appendLocalMessage('user', message);
        window.electron.chat.addMessage({ chatId: activeChatId, sender: 'user', text: message }).catch(() => {});

        const responseText = skillResult.message || 'Skill command executed.';
        appendLocalMessage('assistant', responseText);
        window.electron.chat.addMessage({ chatId: activeChatId, sender: 'assistant', text: responseText }).catch(() => {});

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

  try {
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

// Add message to chat display
function addMessage(sender, text, metadata = {}) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${sender}`;
  
  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  if (sender === 'assistant') {
    messageContent.innerHTML = window.electron.markdown.parse(text || '');
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
renderAgentModeButton();
renderHistoryToggleButton();
