const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const { default: Store } = require('electron-store');
const ProviderFactory = require('./src/providers/provider-factory');
const { initializeTools, toolRegistry } = require('./src/tools');
const ToolExecutor = require('./src/execution/tool-executor');
const AgentLoop = require('./src/execution/agent-loop');

let mainWindow;
const pendingApprovalResolvers = new Map();

const store = new Store({
  name: 'chat-data',
  defaults: {
    chats: [],
    activeChatId: null,
    apiTokens: {},
    apiStatus: {},
    settings: {
      activeProvider: 'openai',
      providerModels: {
        openai: 'gpt-4o-mini',
        anthropic: 'claude-3-5-sonnet-latest',
        copilot: ''
      }
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
const getSettings = () => store.get('settings', {
  activeProvider: 'openai',
  providerModels: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-sonnet-latest',
    copilot: ''
  }
});
const setSettings = (settings) => store.set('settings', settings);

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

const getProviderModel = (provider) => {
  const settings = getSettings();
  return settings.providerModels?.[provider] || providerDefaults[provider] || '';
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

ipcMain.handle('chat:addMessage', (_event, { chatId, sender, text }) => {
  return appendMessageToChat(chatId, sender, text);
});

ipcMain.handle('chat:sendMessage', async (event, { chatId, message, agentMode = false }) => {
  const userMessage = appendMessageToChat(chatId, 'user', message);
  if (!userMessage) {
    throw new Error('Chat not found');
  }

  const settings = getSettings();
  const providerType = settings.activeProvider || 'openai';
  if (!['openai', 'anthropic'].includes(providerType)) {
    throw new Error('Active provider does not support chat completions yet.');
  }

  const token = getDecryptedProviderToken(providerType);
  const provider = ProviderFactory.createProvider(providerType, token);
  const chat = getChats().find((item) => item.id === chatId);
  if (!chat) {
    throw new Error('Chat not found');
  }

  const responseId = createId();
  const runId = createId();
  const options = {
    model: getProviderModel(providerType),
    runId
  };

  event.sender.send('chat:messageStart', { chatId, responseId });

  try {
    const executor = new ToolExecutor({
      workingDirectory: process.cwd(),
      requireApproval: true
    });

    executor.on('preExecute', ({ toolName, parameters }) => {
      event.sender.send('chat:toolUse', { chatId, runId, toolName, parameters });
    });

    executor.on('postExecute', ({ toolName, result }) => {
      event.sender.send('chat:toolResult', { chatId, runId, toolName, result });
    });

    executor.on('approvalRequired', ({ toolName, parameters, resolve }) => {
      const approvalId = createId();
      pendingApprovalResolvers.set(approvalId, resolve);
      event.sender.send('tool:approvalRequired', { approvalId, toolName, parameters });
    });

    let fullResponse = '';
    let llmSummary = {
      calls: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
    };
    const toolDefinitions = toolRegistry.getFunctionDefinitions();
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

    const updatedChat = appendMessageToChat(chatId, 'assistant', fullResponse || '(No response)', {
      llm: llmSummary
    });
    event.sender.send('chat:messageComplete', {
      chatId,
      responseId,
      message: fullResponse || '(No response)',
      llm: llmSummary
    });

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
  const executor = new ToolExecutor({
    workingDirectory: process.cwd(),
    requireApproval: true
  });

  executor.on('approvalRequired', ({ toolName: requestedToolName, parameters: requestedParameters, resolve }) => {
    const approvalId = createId();
    pendingApprovalResolvers.set(approvalId, resolve);
    event.sender.send('tool:approvalRequired', {
      approvalId,
      toolName: requestedToolName,
      parameters: requestedParameters
    });
  });

  return executor.execute(toolName, parameters);
});

ipcMain.handle('tool:list', async () => {
  return toolRegistry.getFunctionDefinitions();
});

ipcMain.on('tool:approvalResponse', (_event, { approvalId, approved }) => {
  const resolve = pendingApprovalResolvers.get(approvalId);
  if (!resolve) return;

  pendingApprovalResolvers.delete(approvalId);
  resolve(Boolean(approved));
});

ipcMain.handle('settings:load', () => {
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
    activeProvider: settings.activeProvider || 'openai'
  };
});

ipcMain.handle('settings:setActiveProvider', (_event, { provider }) => {
  if (!providerLabels[provider]) {
    return { ok: false, error: 'Unknown provider.' };
  }

  const settings = getSettings();
  const updated = {
    ...settings,
    activeProvider: provider
  };
  setSettings(updated);

  return { ok: true, activeProvider: provider };
});

ipcMain.handle('settings:setProviderModel', (_event, { provider, model }) => {
  if (!providerLabels[provider]) {
    return { ok: false, error: 'Unknown provider.' };
  }

  const settings = getSettings();
  const updated = {
    ...settings,
    providerModels: {
      ...(settings.providerModels || {}),
      [provider]: (model || '').trim()
    }
  };
  setSettings(updated);

  return { ok: true, model: updated.providerModels[provider] };
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
  initializeTools();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
