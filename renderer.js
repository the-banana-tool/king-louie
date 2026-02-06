// DOM Elements
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const chatMessages = document.getElementById('chat-messages');
const newChatBtn = document.getElementById('new-chat-btn');
const chatList = document.getElementById('chat-list');
const chatHeaderTitle = document.getElementById('chat-header-title');
const chatHeaderMeta = document.getElementById('chat-header-meta');
const emptyState = document.getElementById('empty-state');
const mainContent = document.querySelector('.main-content');
const container = document.querySelector('.container');
const chatContextMenu = document.getElementById('chat-context-menu');
const settingsDrawer = document.getElementById('settings-drawer');
const openSettingsBtn = document.getElementById('open-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const floatingSettingsBtn = document.getElementById('floating-settings-btn');
const composerSettingsBtn = document.getElementById('composer-settings-btn');
const providerList = document.getElementById('provider-list');
const settingsEncryptionAlert = document.getElementById('settings-encryption-alert');

let chats = [];
let activeChatId = null;
let contextChatId = null;
let settingsState = { encryptionAvailable: true, providers: {}, activeProvider: 'openai' };
const streamBufferById = new Map();

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

function renderChatList() {
  chatList.innerHTML = '';

  chats.forEach((chat) => {
    const chatItem = document.createElement('div');
    chatItem.className = `chat-item ${chat.id === activeChatId ? 'active' : ''}`;
    chatItem.dataset.chatId = chat.id;

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
    metaDiv.textContent = `Updated ${formatTimestamp(chat.updatedAt)}`;

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
  chatHeaderMeta.textContent = `Updated ${formatTimestamp(activeChat.updatedAt)}`;

  activeChat.messages.forEach((message) => {
    addMessage(message.sender, message.text);
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

async function sendMessage() {
  const message = userInput.value.trim();

  if (message === '') {
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
    const updatedChat = await window.electron.chat.sendMessage({
      chatId: activeChatId,
      message
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
function addMessage(sender, text) {
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
  const title = prompt('Rename chat', chat.title);
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

loadChats();
