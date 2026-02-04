const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const { default: Store } = require('electron-store');

let mainWindow;

const store = new Store({
  name: 'chat-data',
  defaults: {
    chats: [],
    activeChatId: null,
    apiTokens: {},
    apiStatus: {}
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

const providerLabels = {
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  copilot: 'GitHub Copilot'
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  // Open DevTools in development mode
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

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

ipcMain.handle('chat:addMessage', (_event, { chatId, sender, text }) => {
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
          timestamp: now
        }
      ]
    };
  });
  setChats(updated);
  return updated.find((chat) => chat.id === chatId);
});

ipcMain.handle('settings:load', () => {
  const tokens = getApiTokens();
  const status = getApiStatus();

  const providers = Object.keys(providerLabels).reduce((acc, key) => {
    acc[key] = {
      label: providerLabels[key],
      hasToken: Boolean(tokens[key]),
      status: status[key] || null
    };
    return acc;
  }, {});

  return {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    providers
  };
});

ipcMain.handle('settings:saveProvider', (_event, { provider, token, clear }) => {
  if (!providerLabels[provider]) {
    return { ok: false, error: 'Unknown provider.' };
  }

  try {
    const tokens = getApiTokens();
    if (clear) {
      delete tokens[provider];
      setApiTokens(tokens);
      return { ok: true, hasToken: false };
    }

    if (typeof token === 'string' && token.trim() !== '') {
      tokens[provider] = encryptToken(token.trim());
      setApiTokens(tokens);
      return { ok: true, hasToken: true };
    }

    return { ok: true, hasToken: Boolean(tokens[provider]) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('settings:testProvider', async (_event, { provider }) => {
  if (!providerLabels[provider]) {
    return { ok: false, error: 'Unknown provider.' };
  }

  try {
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
  } catch (error) {
    const status = updateStatus(provider, {
      ok: false,
      message: error.message
    });
    return { ok: false, error: error.message, status };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
